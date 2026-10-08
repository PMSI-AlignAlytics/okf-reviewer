//! Local Markdown references use the existing native folder grant. They do not
//! add concepts, graph edges, or review targets to the active OKF bundle.

use crate::bundle_grant::BundleGrantState;
use okf_core::{links, Bundle, IssueLevel};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentLinkState {
    Available,
    OutsideScope,
}

#[derive(Debug, Serialize)]
pub struct DocumentLink {
    href: String,
    state: DocumentLinkState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderBundle {
    #[serde(flatten)]
    pub bundle: Bundle,
    document_links: BTreeMap<String, Vec<DocumentLink>>,
}

enum Resolution {
    Available(PathBuf),
    OutsideScope,
    Missing,
}

fn resolve(root: &Path, scope: &Path, from_id: &str, href: &str) -> Option<Resolution> {
    let path = links::local_markdown_path(href)?;
    let requested = if let Some(path) = path.strip_prefix('/') {
        root.join(path)
    } else {
        let dir = from_id.rsplit_once('/').map_or("", |(dir, _)| dir);
        root.join(dir).join(path)
    };
    let mut normalized = PathBuf::new();
    for component in requested.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Some(Resolution::OutsideScope);
                }
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    // Check the lexical scope before probing a path outside the opened folder.
    if !normalized.starts_with(scope) {
        return Some(Resolution::OutsideScope);
    }
    let Ok(canonical) = dunce::canonicalize(&normalized) else {
        return Some(Resolution::Missing);
    };
    if !canonical.starts_with(scope) {
        return Some(Resolution::OutsideScope);
    }
    if !canonical.is_file()
        || !canonical
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return Some(Resolution::Missing);
    }
    Some(Resolution::Available(canonical))
}

pub fn read_bundle(root: &Path, scope: &Path) -> ReaderBundle {
    let mut bundle = okf_core::read_bundle(root);
    let concept_ids: HashSet<_> = bundle
        .concepts
        .iter()
        .map(|concept| concept.id.as_str())
        .collect();
    let mut document_links = BTreeMap::new();
    for (from_id, body) in bundle
        .concepts
        .iter()
        .map(|concept| (concept.id.clone(), &concept.body))
        .chain(bundle.indexes.iter().map(|node| {
            let id = if node.dir.is_empty() {
                "index".to_string()
            } else {
                format!("{}/index", node.dir)
            };
            (id, &node.intro)
        }))
    {
        let mut seen = HashSet::new();
        let resolved: Vec<_> = links::targets(body)
            .into_iter()
            .filter_map(|href| {
                if !seen.insert(href.clone()) {
                    return None;
                }
                let path = links::local_markdown_path(&href)?;
                if links::resolve(&path, &from_id)
                    .is_some_and(|id| concept_ids.contains(id.as_str()))
                {
                    return None;
                }
                let state = match resolve(root, scope, &from_id, &href)? {
                    Resolution::Available(_) => DocumentLinkState::Available,
                    Resolution::OutsideScope => DocumentLinkState::OutsideScope,
                    Resolution::Missing => return None,
                };
                Some(DocumentLink { href, state })
            })
            .collect();
        if !resolved.is_empty() {
            document_links.insert(from_id, resolved);
        }
    }

    let mut cleared_warnings = HashSet::new();
    for concept in &mut bundle.concepts {
        if let Some(resolved) = document_links.get(&concept.id) {
            concept.broken_links.retain(|href| {
                if resolved.iter().any(|link| link.href == *href) {
                    cleared_warnings.insert(format!(
                        "{}.md: link target not found -> {}",
                        concept.id, href
                    ));
                    false
                } else {
                    true
                }
            });
        }
    }
    bundle.issues.retain(|issue| {
        issue.level != IssueLevel::Warning || !cleared_warnings.contains(&issue.message)
    });
    ReaderBundle {
        bundle,
        document_links,
    }
}

/// Re-read the authored destination and recheck the grant at activation time.
/// The frontend never supplies an absolute path or an arbitrary open command.
pub fn declared_document_path(
    grants: &BundleGrantState,
    requested_root: &Path,
    from_id: &str,
    href: &str,
) -> Result<PathBuf, String> {
    let root = grants.authorize_bundle(requested_root)?;
    let scope = grants.document_scope_for_bundle(&root)?;
    let bundle = okf_core::read_bundle(&root);
    let body = bundle
        .concepts
        .iter()
        .find(|concept| concept.id == from_id)
        .map(|concept| &concept.body)
        .or_else(|| {
            bundle
                .indexes
                .iter()
                .find(|node| {
                    if node.dir.is_empty() {
                        from_id == "index"
                    } else {
                        from_id == format!("{}/index", node.dir)
                    }
                })
                .map(|node| &node.intro)
        })
        .ok_or_else(|| {
            "The link's source document is no longer available. Reload the bundle.".to_string()
        })?;
    if !links::targets(body).iter().any(|target| target == href) {
        return Err("This document no longer declares that link. Reload the bundle.".to_string());
    }
    match resolve(&root, &scope, from_id, href) {
        Some(Resolution::Available(path)) => Ok(path),
        Some(Resolution::OutsideScope) => Err(
            "This link is outside the opened folder. Open the containing folder in OKF Reviewer."
                .to_string(),
        ),
        _ => Err(
            "The linked Markdown document is no longer available. Reload the bundle.".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const HANDOFF: &str = "../../docs/migration/native_dbt_workflow_handoff.md";
    const REPORT: &str = "../../docs/migration/validation_native_20261006.md#results";
    const MISSING: &str = "../../docs/migration/missing.md";

    struct Fixture {
        base: PathBuf,
        repository: PathBuf,
        root: PathBuf,
        grants: BundleGrantState,
    }

    impl Fixture {
        fn new() -> Self {
            let base =
                std::env::temp_dir().join(format!("okf-document-links-{}", uuid::Uuid::new_v4()));
            let repository = base.join("repository");
            let root = repository.join("knowledge/okf");
            fs::create_dir_all(root.join("requirements")).unwrap();
            fs::create_dir_all(repository.join("docs/migration")).unwrap();
            fs::write(root.join("index.md"), format!("---\nokf_version: '0.2'\n---\n# Project\n\nSee [handoff]({HANDOFF}).\n\n- [Context](project.md) - Context\n")).unwrap();
            fs::write(
                root.join("requirements/index.md"),
                "# Requirements\n\n- [Workflow](workflow.md) - Workflow\n",
            )
            .unwrap();
            fs::write(
                root.join("requirements/workflow.md"),
                "---\ntype: Requirement\n---\n# Workflow\n",
            )
            .unwrap();
            fs::write(root.join("project.md"), format!("---\ntype: Project\nstatus: draft\nproducer_extension: keep-me\n---\n# Project context\n\n[handoff]({HANDOFF}) [report]({REPORT}) [missing]({MISSING}) [workflow](requirements/workflow.md) [index](requirements/index.md) [missing concept](requirements/missing.md)\n")).unwrap();
            fs::write(
                repository.join("docs/migration/native_dbt_workflow_handoff.md"),
                "# Native handoff\n",
            )
            .unwrap();
            fs::write(
                repository.join("docs/migration/validation_native_20261006.md"),
                "# Validation\n",
            )
            .unwrap();
            let grants = BundleGrantState::load_from(base.join("grants.json"));
            Self {
                base,
                repository: dunce::canonicalize(repository).unwrap(),
                root: dunce::canonicalize(root).unwrap(),
                grants,
            }
        }

        fn grant(&self, folder: &Path) {
            self.grants.grant(folder).unwrap();
            self.grants
                .register_bundle_roots(folder, [self.root.clone()])
                .unwrap();
        }

        fn project<'a>(&self, reader: &'a ReaderBundle) -> &'a okf_core::Concept {
            reader
                .bundle
                .concepts
                .iter()
                .find(|concept| concept.id == "project")
                .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn existing_repository_documents_and_indexes_are_not_broken_concepts() {
        let fixture = Fixture::new();
        let before = fs::read(fixture.root.join("project.md")).unwrap();
        let reader = read_bundle(&fixture.root, &fixture.repository);
        let project = fixture.project(&reader);

        assert_eq!(project.links, ["requirements/workflow"]);
        assert_eq!(project.broken_links, [MISSING, "requirements/missing.md"]);
        assert_eq!(project.extra["producer_extension"], "keep-me");
        assert_eq!(project.status, okf_core::ConceptStatus::Draft);
        assert_eq!(
            reader.bundle.concepts.len(),
            2,
            "external documents never become review targets"
        );
        assert_eq!(reader.document_links["project"].len(), 3);
        assert!(reader.document_links["project"]
            .iter()
            .all(|link| link.state == DocumentLinkState::Available));
        assert_eq!(reader.document_links["index"][0].href, HANDOFF);
        let link_warnings: Vec<_> = reader
            .bundle
            .issues
            .iter()
            .filter(|issue| issue.message.contains("link target not found"))
            .collect();
        assert_eq!(link_warnings.len(), 2);
        let report = okf_core::compatibility::analyze(&reader.bundle);
        assert_eq!(
            report
                .findings
                .iter()
                .filter(|finding| finding.message.contains("link target not found"))
                .count(),
            2
        );
        assert!(link_warnings
            .iter()
            .all(|issue| issue.message.ends_with(MISSING)
                || issue.message.ends_with("requirements/missing.md")));
        assert_eq!(fs::read(fixture.root.join("project.md")).unwrap(), before);

        let json = serde_json::to_value(reader).unwrap();
        assert_eq!(json["documentLinks"]["project"][0]["state"], "available");
        assert!(
            json.get("concepts").is_some(),
            "bundle fields stay flattened"
        );
    }

    #[test]
    fn a_bundle_only_grant_distinguishes_unchecked_paths_from_missing_files() {
        let fixture = Fixture::new();
        fixture.grant(&fixture.root);
        let scope = fixture
            .grants
            .document_scope_for_bundle(&fixture.root)
            .unwrap();
        assert_eq!(scope, fixture.root);
        let reader = read_bundle(&fixture.root, &scope);
        assert_eq!(
            fixture.project(&reader).broken_links,
            ["requirements/missing.md"]
        );
        for href in [HANDOFF, REPORT, MISSING] {
            let link = reader.document_links["project"]
                .iter()
                .find(|link| link.href == href)
                .unwrap();
            assert_eq!(link.state, DocumentLinkState::OutsideScope);
        }
        assert!(
            declared_document_path(&fixture.grants, &fixture.root, "project", HANDOFF)
                .unwrap_err()
                .contains("outside the opened folder")
        );
        let json = serde_json::to_value(reader).unwrap();
        assert_eq!(
            json["documentLinks"]["project"][0]["state"],
            "outside-scope"
        );
    }

    #[test]
    fn native_opening_requires_a_current_authored_link_and_grant() {
        let fixture = Fixture::new();
        fixture.grant(&fixture.repository);
        let target = fixture
            .repository
            .join("docs/migration/native_dbt_workflow_handoff.md");
        assert_eq!(
            declared_document_path(&fixture.grants, &fixture.root, "project", HANDOFF).unwrap(),
            target
        );
        assert_eq!(
            declared_document_path(&fixture.grants, &fixture.root, "index", HANDOFF).unwrap(),
            target
        );
        assert!(declared_document_path(
            &fixture.grants,
            &fixture.root,
            "requirements/workflow",
            HANDOFF
        )
        .is_err());
        assert!(declared_document_path(
            &fixture.grants,
            &fixture.root,
            "project",
            "../../README.md"
        )
        .is_err());
        assert!(
            declared_document_path(&fixture.grants, &fixture.repository, "project", HANDOFF)
                .is_err()
        );

        fs::remove_file(target).unwrap();
        assert!(
            declared_document_path(&fixture.grants, &fixture.root, "project", HANDOFF).is_err()
        );
        fixture
            .grants
            .revoke(fixture.repository.to_str().unwrap())
            .unwrap();
        assert!(declared_document_path(&fixture.grants, &fixture.root, "project", REPORT).is_err());
    }

    #[test]
    fn edited_source_links_cannot_be_opened_from_a_stale_reader() {
        let fixture = Fixture::new();
        fixture.grant(&fixture.repository);
        fs::write(
            fixture.root.join("project.md"),
            "---\ntype: Project\n---\n# Changed context\n",
        )
        .unwrap();
        assert!(
            declared_document_path(&fixture.grants, &fixture.root, "project", HANDOFF)
                .unwrap_err()
                .contains("no longer declares")
        );
    }

    #[test]
    fn nested_sources_and_encoded_paths_resolve_from_the_declaring_directory() {
        let fixture = Fixture::new();
        fixture.grant(&fixture.repository);
        let target = fixture.repository.join("docs/migration/café report.MD");
        fs::write(&target, "# Report\n").unwrap();
        let href = "../../../docs/migration/caf%C3%A9%20report.MD?view=1#results";
        fs::write(
            fixture.root.join("requirements/workflow.md"),
            format!("---\ntype: Requirement\n---\n[report]({href})\n"),
        )
        .unwrap();
        assert_eq!(
            declared_document_path(
                &fixture.grants,
                &fixture.root,
                "requirements/workflow",
                href
            )
            .unwrap(),
            target
        );
        assert_eq!(
            read_bundle(&fixture.root, &fixture.repository).document_links["requirements/workflow"]
                [0]
            .state,
            DocumentLinkState::Available
        );
    }

    #[test]
    fn only_existing_native_folder_grants_expand_the_document_scope() {
        let fixture = Fixture::new();
        fixture.grant(&fixture.root);
        let unrelated = fixture.base.join("unrelated");
        fs::create_dir(&unrelated).unwrap();
        fixture.grants.grant(&unrelated).unwrap();
        assert_eq!(
            fixture
                .grants
                .document_scope_for_bundle(&fixture.root)
                .unwrap(),
            fixture.root
        );
        fixture.grant(&fixture.repository);
        assert_eq!(
            fixture
                .grants
                .document_scope_for_bundle(&fixture.root)
                .unwrap(),
            fixture.repository
        );
        fixture
            .grants
            .revoke(fixture.repository.to_str().unwrap())
            .unwrap();
        assert_eq!(
            fixture
                .grants
                .document_scope_for_bundle(&fixture.root)
                .unwrap(),
            fixture.root
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_the_granted_folder_or_open_a_non_markdown_file() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        fixture.grant(&fixture.repository);
        let target = fixture
            .repository
            .join("docs/migration/native_dbt_workflow_handoff.md");
        let outside = fixture.base.join("private.md");
        fs::write(&outside, "private").unwrap();
        fs::remove_file(&target).unwrap();
        symlink(outside, &target).unwrap();
        let reader = read_bundle(&fixture.root, &fixture.repository);
        assert_eq!(
            reader.document_links["project"][0].state,
            DocumentLinkState::OutsideScope
        );
        assert!(
            declared_document_path(&fixture.grants, &fixture.root, "project", HANDOFF).is_err()
        );

        fs::remove_file(&target).unwrap();
        let script = fixture.repository.join("script.sh");
        fs::write(&script, "exit 1").unwrap();
        symlink(script, target).unwrap();
        assert!(
            declared_document_path(&fixture.grants, &fixture.root, "project", HANDOFF).is_err()
        );
    }

    #[test]
    fn document_classification_preserves_unrelated_validation_errors() {
        let fixture = Fixture::new();
        let source = fs::read_to_string(fixture.root.join("project.md"))
            .unwrap()
            .replace("type: Project\n", "");
        fs::write(fixture.root.join("project.md"), source).unwrap();
        let reader = read_bundle(&fixture.root, &fixture.repository);
        assert!(reader
            .bundle
            .issues
            .iter()
            .any(|issue| issue.level == IssueLevel::Error
                && issue.message.contains("no 'type' field")));
        assert_eq!(fixture.project(&reader).broken_links.len(), 2);
    }
}
