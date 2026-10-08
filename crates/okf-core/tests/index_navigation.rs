//! Exercise actual bundle parsing, not a duplicate navigation regex.
use okf_core::{
    model::{Bundle, EntryKind},
    read_bundle,
};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "okf-index-navigation-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn write(&self, relative: &str, text: &str) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn reachable(bundle: &Bundle) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut concepts = BTreeSet::new();
    let mut pending = vec![String::new()];
    while let Some(dir) = pending.pop() {
        if !seen.insert(dir.clone()) {
            continue;
        }
        let node = bundle
            .indexes
            .iter()
            .find(|n| n.dir == dir)
            .expect("linked directory has an index node");
        for entry in node.sections.iter().flat_map(|s| &s.entries) {
            match entry.kind {
                EntryKind::Directory => pending.push(entry.target.clone()),
                EntryKind::Concept => {
                    assert!(
                        bundle.concepts.iter().any(|c| c.id == entry.target),
                        "unresolved navigation leaf: {}",
                        entry.target
                    );
                    concepts.insert(entry.target.clone());
                }
            }
        }
    }
    concepts
}

#[test]
fn standard_and_legacy_colon_indexes_reach_the_same_documents_without_writes() {
    for separator in [" - ", ": "] {
        let fixture = Fixture::new();
        let root = format!("---\nokf_version: \"0.2\"\n---\n# Analytics\n\n- [Delivery](delivery/index.md){separator}Workflow\n");
        let child =
            format!("# Delivery\n\n- [Workflow](workflow.md){separator}Accountable delivery\n");
        fixture.write("index.md", &root);
        fixture.write("delivery/index.md", &child);
        fixture.write(
            "delivery/workflow.md",
            "---\ntype: Playbook\ntitle: Workflow\nstatus: draft\n---\n# Workflow\n",
        );
        let bundle = read_bundle(&fixture.0);
        assert_eq!(
            reachable(&bundle),
            BTreeSet::from(["delivery/workflow".to_string()])
        );
        let warnings: Vec<_> = bundle
            .issues
            .iter()
            .filter(|i| i.message.contains("index separator"))
            .collect();
        assert_eq!(warnings.len(), if separator == ": " { 2 } else { 0 });
        if separator == ": " {
            assert!(warnings
                .iter()
                .any(|i| i.message.starts_with("index.md:6:")));
            assert!(warnings
                .iter()
                .any(|i| i.message.starts_with("delivery/index.md:3:")));
            let report = okf_core::compatibility::analyze(&bundle);
            let finding = report
                .findings
                .iter()
                .find(|f| f.rule_id == "okf.portability.index-navigation")
                .unwrap();
            assert_eq!(
                finding.category,
                okf_core::compatibility::CompatibilityCategory::Index
            );
            assert_eq!(
                finding.basis,
                okf_core::compatibility::CompatibilityBasis::Portability
            );
            assert!(finding.repair.is_none());
        }
        assert_eq!(
            fs::read_to_string(fixture.0.join("index.md")).unwrap(),
            root
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("delivery/index.md")).unwrap(),
            child
        );
        assert_eq!(
            bundle.concepts[0].status,
            okf_core::model::ConceptStatus::Draft
        );
        assert!(bundle.concepts[0].verified.is_empty());
    }
}

#[test]
fn unknown_entries_warn_and_stay_as_prose_without_hiding_valid_siblings() {
    let fixture = Fixture::new();
    fixture.write(
        "index.md",
        "# Root\n\n- [Good](good.md) - Visible\n- [Bad](bad.md) unsupported separator\n",
    );
    fixture.write("good.md", "---\ntype: Note\n---\nGood\n");
    fixture.write("bad.md", "---\ntype: Note\n---\nBad\n");
    let bundle = read_bundle(&fixture.0);
    let node = bundle.indexes.iter().find(|n| n.dir.is_empty()).unwrap();
    assert!(node.intro.contains("[Bad](bad.md) unsupported separator"));
    // The malformed entry remains prose with its warning; the document itself
    // is still reachable through the filesystem fallback, without a repair.
    assert_eq!(node.sections[0].entries.len(), 1);
    assert_eq!(node.sections[0].entries[0].target, "good");
    assert_eq!(node.sections[1].entries[0].target, "bad");
    assert!(node.sections[1].entries[0].description.is_empty());
    assert_eq!(
        reachable(&bundle),
        BTreeSet::from(["bad".to_string(), "good".to_string()])
    );
    assert!(bundle
        .issues
        .iter()
        .any(|i| i.message.starts_with("index.md:4: unrecognized")));
    assert_eq!(bundle.concepts.len(), 2);
}

#[test]
fn fenced_examples_do_not_become_navigation_or_warnings() {
    let fixture = Fixture::new();
    fixture.write("index.md", "# Root\n\n````md\n- [Example](fake.md): Example\n```\n````\n~~~md\n- [Other](fake.md) unsupported\n~~~\n- [Real](real.md) - Real\n");
    fixture.write("real.md", "---\ntype: Note\n---\nReal\n");
    let bundle = read_bundle(&fixture.0);
    assert_eq!(reachable(&bundle), BTreeSet::from(["real".to_string()]));
    assert!(bundle.issues.is_empty());
    assert!(bundle.indexes[0]
        .intro
        .contains("[Example](fake.md): Example"));
}

#[test]
fn ordinary_task_lists_do_not_trigger_navigation_warnings() {
    let fixture = Fixture::new();
    fixture.write(
        "index.md",
        "# Root\n\n- [ ] Review the documents\n- [x] Open the bundle\n",
    );
    assert!(read_bundle(&fixture.0).issues.is_empty());
}

#[test]
#[ignore = "Set OKF_STARTER_BUNDLE to a real starter bundle for release pairing"]
fn actual_starter_bundle_is_fully_navigable() {
    let root = std::env::var("OKF_STARTER_BUNDLE").expect("set OKF_STARTER_BUNDLE");
    let bundle = read_bundle(Path::new(&root));
    assert_eq!(bundle.concepts.len(), 8);
    assert_eq!(
        reachable(&bundle),
        bundle.concepts.iter().map(|c| c.id.clone()).collect()
    );
    assert!(
        !bundle
            .issues
            .iter()
            .any(|i| i.message.contains("index separator")
                || i.message.contains("unrecognized index"))
    );
}
