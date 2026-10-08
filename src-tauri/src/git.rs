//! Fixed, read-only Git inspection shared by explorer status and quiz scopes.

use okf_core::Bundle;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};

const MAX_GIT_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLineChange {
    pub start: usize,
    pub end: usize,
    pub previous_text: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleGitStatus {
    pub available: bool,
    pub head_revision: Option<String>,
    pub comparison_mode: GitComparisonMode,
    pub current_branch: Option<String>,
    pub default_branch: Option<String>,
    pub base_revision: Option<String>,
    pub modified_concept_ids: Vec<String>,
    pub deleted_paths: Vec<String>,
    pub line_changes_by_concept: BTreeMap<String, Vec<GitLineChange>>,
    pub trust_required: bool,
    pub repository_root: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GitComparisonMode {
    Unavailable,
    FeatureBranch,
    WorkingTree,
}

impl BundleGitStatus {
    pub fn unavailable() -> Self {
        Self {
            available: false,
            head_revision: None,
            comparison_mode: GitComparisonMode::Unavailable,
            current_branch: None,
            default_branch: None,
            base_revision: None,
            modified_concept_ids: Vec::new(),
            deleted_paths: Vec::new(),
            line_changes_by_concept: BTreeMap::new(),
            trust_required: false,
            repository_root: None,
            message: None,
        }
    }

    pub fn unavailable_with_message(message: impl Into<String>) -> Self {
        Self {
            message: Some(message.into()),
            ..Self::unavailable()
        }
    }

    pub fn trust_required(repository: &Path) -> Self {
        Self {
            available: false,
            head_revision: None,
            comparison_mode: GitComparisonMode::Unavailable,
            current_branch: None,
            default_branch: None,
            base_revision: None,
            modified_concept_ids: Vec::new(),
            deleted_paths: Vec::new(),
            line_changes_by_concept: BTreeMap::new(),
            trust_required: true,
            repository_root: Some(repository.to_string_lossy().into_owned()),
            message: Some(
                "Confirm this enclosing repository to enable read-only Git inspection.".to_string(),
            ),
        }
    }
}

pub fn discover_repository(root: &Path) -> Result<Option<PathBuf>, String> {
    let output = output(root, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = bounded_output(&output.stdout, "Git repository path")?;
    let candidate = PathBuf::from(text.trim());
    if candidate.as_os_str().is_empty() {
        return Ok(None);
    }
    dunce::canonicalize(candidate)
        .map(Some)
        .map_err(|_| "Git reported a repository root that is unavailable.".to_string())
}

/// Find the nearest enclosing repository marker without asking Git to trust it.
/// A regular `.git` file is accepted for linked worktrees; symlink markers are
/// rejected so the candidate cannot redirect outside the displayed ancestor.
pub fn repository_candidate(root: &Path) -> Result<Option<PathBuf>, String> {
    let root = dunce::canonicalize(root)
        .map_err(|_| "The active bundle is no longer available.".to_string())?;
    for ancestor in root.ancestors() {
        let marker = ancestor.join(".git");
        let Ok(metadata) = std::fs::symlink_metadata(&marker) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            return Err("The enclosing Git repository uses an unsafe .git symlink.".to_string());
        }
        if metadata.is_dir() || metadata.is_file() {
            return Ok(Some(ancestor.to_path_buf()));
        }
    }
    Ok(None)
}

pub fn discover_repository_with_safe_directory(
    root: &Path,
    safe_repository: &Path,
) -> Result<Option<PathBuf>, String> {
    let output =
        output_with_safe_directory(root, safe_repository, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = bounded_output(&output.stdout, "Git repository path")?;
    let candidate = PathBuf::from(text.trim());
    if candidate.as_os_str().is_empty() {
        return Ok(None);
    }
    dunce::canonicalize(candidate)
        .map(Some)
        .map_err(|_| "Git reported a repository root that is unavailable.".to_string())
}

pub fn head_revision(repository: &Path) -> Result<String, String> {
    let revision = text_with_safe_directory(repository, repository, &["rev-parse", "HEAD"])?;
    let revision = revision.trim();
    if revision.is_empty() {
        return Err("The Git repository has no current commit.".to_string());
    }
    Ok(revision.to_string())
}

pub fn bundle_status(
    root: &Path,
    repository: &Path,
    bundle: &Bundle,
) -> Result<BundleGitStatus, String> {
    let head_revision = head_revision(repository)?;
    let comparison = comparison_base(repository, &head_revision)?;
    let known = bundle
        .concepts
        .iter()
        .map(|concept| concept.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut tracked_modified = BTreeSet::new();

    let tracked = output_with_safe_directory(
        root,
        repository,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--relative",
            "--name-only",
            "-z",
            "--no-renames",
            "--diff-filter=ACMRTUXB",
            &comparison.base_revision,
            "--",
            ".",
        ],
    )?;
    if !tracked.status.success() {
        return Err("Git could not inspect tracked bundle changes.".to_string());
    }
    collect_concept_ids(&tracked.stdout, &known, &mut tracked_modified)?;

    let deleted = output_with_safe_directory(
        root,
        repository,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--relative",
            "--name-only",
            "-z",
            "--no-renames",
            "--diff-filter=D",
            &comparison.base_revision,
            "--",
            ".",
        ],
    )?;
    if !deleted.status.success() {
        return Err("Git could not inspect deleted bundle documents.".to_string());
    }
    let deleted_paths = collect_deleted_paths(&deleted.stdout)?;

    let untracked = output_with_safe_directory(
        root,
        repository,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
        ],
    )?;
    if !untracked.status.success() {
        return Err("Git could not inspect untracked bundle documents.".to_string());
    }
    let mut untracked_modified = BTreeSet::new();
    collect_concept_ids(&untracked.stdout, &known, &mut untracked_modified)?;

    let modified = tracked_modified
        .union(&untracked_modified)
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut line_changes_by_concept = BTreeMap::new();
    for concept_id in &modified {
        let path = format!("{concept_id}.md");
        let document_changes = if untracked_modified.contains(concept_id) {
            None
        } else {
            Some(changed_document_line_changes(
                root,
                repository,
                &comparison.base_revision,
                &path,
            )?)
        };
        let base_text = match document_changes.as_deref() {
            Some(changes)
                if changes
                    .iter()
                    .any(|change| !change.previous_lines.is_empty()) =>
            {
                Some(base_document(
                    root,
                    repository,
                    &comparison.base_revision,
                    &path,
                )?)
            }
            _ => None,
        };
        let changes = body_line_changes(
            root,
            &path,
            document_changes.as_deref(),
            base_text.as_deref(),
        )?;
        if !changes.is_empty() {
            line_changes_by_concept.insert(concept_id.clone(), changes);
        }
    }

    Ok(BundleGitStatus {
        available: true,
        head_revision: Some(head_revision),
        comparison_mode: comparison.mode,
        current_branch: comparison.current_branch,
        default_branch: comparison.default_branch,
        base_revision: Some(comparison.base_revision),
        modified_concept_ids: modified.into_iter().collect(),
        deleted_paths,
        line_changes_by_concept,
        trust_required: false,
        repository_root: Some(repository.to_string_lossy().into_owned()),
        message: None,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct GitDocumentChange {
    old_start: usize,
    old_count: usize,
    new_start: usize,
    new_count: usize,
    previous_lines: Vec<(usize, String)>,
}

/// Current-document hunks introduced relative to the selected comparison base.
/// The current coordinates identify what the reader colours; removed old-side
/// source is retained so replacements can reveal the exact previous text.
fn changed_document_line_changes(
    root: &Path,
    repository: &Path,
    base: &str,
    path: &str,
) -> Result<Vec<GitDocumentChange>, String> {
    let output = output_with_safe_directory(
        root,
        repository,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--relative",
            "--unified=0",
            "--no-renames",
            base,
            "--",
            path,
        ],
    )?;
    if !output.status.success() {
        return Err("Git could not inspect changed bundle lines.".to_string());
    }
    let text = bounded_output(&output.stdout, "Git changed lines")?;
    Ok(parse_document_changes(&text))
}

fn base_document(root: &Path, repository: &Path, base: &str, path: &str) -> Result<String, String> {
    let relative_root = root
        .strip_prefix(repository)
        .map_err(|_| "The bundle is outside the confirmed Git repository.".to_string())?;
    let document_path = relative_root.join(path);
    let document_path = document_path
        .to_str()
        .ok_or_else(|| "The bundle document path is not valid UTF-8.".to_string())?
        .replace('\\', "/");
    validate_relative_path(&document_path)?;
    text_with_safe_directory(
        repository,
        repository,
        &["show", &format!("{base}:{document_path}")],
    )
}

#[derive(Debug, PartialEq, Eq)]
struct ComparisonBase {
    mode: GitComparisonMode,
    current_branch: Option<String>,
    default_branch: Option<String>,
    base_revision: String,
}

fn comparison_base(repository: &Path, head_revision: &str) -> Result<ComparisonBase, String> {
    let current_branch = optional_text_with_safe_directory(
        repository,
        repository,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )?;
    let default_ref = default_branch_ref(repository)?;
    let default_branch = default_ref.as_deref().map(display_branch_name);
    let on_default = match (current_branch.as_deref(), default_branch.as_deref()) {
        (Some(current), Some(default)) => current == default,
        _ => false,
    };
    if let Some(default_ref) = default_ref.filter(|_| current_branch.is_some() && !on_default) {
        let merge_base = optional_text_with_safe_directory(
            repository,
            repository,
            &["merge-base", "HEAD", &default_ref],
        )?;
        if let Some(base_revision) = merge_base.filter(|value| !value.is_empty()) {
            return Ok(ComparisonBase {
                mode: GitComparisonMode::FeatureBranch,
                current_branch,
                default_branch,
                base_revision,
            });
        }
    }
    Ok(ComparisonBase {
        mode: GitComparisonMode::WorkingTree,
        current_branch,
        default_branch,
        base_revision: head_revision.to_string(),
    })
}

fn default_branch_ref(repository: &Path) -> Result<Option<String>, String> {
    if let Some(symbolic) = optional_text_with_safe_directory(
        repository,
        repository,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    )? {
        if revision_exists(repository, &symbolic)? {
            return Ok(Some(symbolic));
        }
    }
    for candidate in [
        "refs/remotes/origin/main",
        "refs/heads/main",
        "refs/remotes/origin/master",
        "refs/heads/master",
    ] {
        if revision_exists(repository, candidate)? {
            return Ok(Some(candidate.to_string()));
        }
    }
    Ok(None)
}

fn display_branch_name(reference: &str) -> String {
    reference
        .strip_prefix("refs/remotes/origin/")
        .or_else(|| reference.strip_prefix("refs/heads/"))
        .unwrap_or(reference)
        .to_string()
}

fn revision_exists(repository: &Path, revision: &str) -> Result<bool, String> {
    Ok(output_with_safe_directory(
        repository,
        repository,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{revision}^{{commit}}"),
        ],
    )?
    .status
    .success())
}

fn optional_text_with_safe_directory(
    directory: &Path,
    repository: &Path,
    args: &[&str],
) -> Result<Option<String>, String> {
    let output = output_with_safe_directory(directory, repository, args)?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = bounded_output(&output.stdout, "Git output")?
        .trim()
        .to_string();
    Ok((!value.is_empty()).then_some(value))
}

fn collect_deleted_paths(bytes: &[u8]) -> Result<Vec<String>, String> {
    let text = bounded_output(bytes, "Git deleted paths")?;
    let mut paths = BTreeSet::new();
    for raw in text.split('\0').filter(|path| !path.is_empty()) {
        let path = raw.replace('\\', "/");
        validate_relative_path(&path)?;
        if concept_id(&path).is_some() {
            paths.insert(path);
        }
    }
    Ok(paths.into_iter().collect())
}

fn body_line_bounds(text: &str) -> Option<(usize, usize)> {
    let (_, body) = okf_core::frontmatter::split(text);
    let body_offset = body.as_ptr() as usize - text.as_ptr() as usize;
    let prefix_lines = text[..body_offset]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count();
    let body_line_count = body.lines().count();
    (body_line_count > 0).then(|| (prefix_lines + 1, prefix_lines + body_line_count))
}

/// Convert full-document Git hunks to body-relative current-side changes.
/// `None` means the document is untracked, so every body line is newly added.
/// Old and current frontmatter are measured independently so neither can leak
/// into the reader annotation or its previous-text popup.
fn body_line_changes(
    root: &Path,
    path: &str,
    document_changes: Option<&[GitDocumentChange]>,
    base_text: Option<&str>,
) -> Result<Vec<GitLineChange>, String> {
    let text = std::fs::read_to_string(root.join(path))
        .map_err(|_| "A modified bundle document is no longer readable.".to_string())?;
    let Some((body_document_start, body_document_end)) = body_line_bounds(&text) else {
        return Ok(Vec::new());
    };
    let body_line_count = body_document_end - body_document_start + 1;
    let Some(document_changes) = document_changes else {
        return Ok(vec![GitLineChange {
            start: 1,
            end: body_line_count,
            previous_text: None,
        }]);
    };

    let old_body_bounds = base_text.and_then(body_line_bounds);
    let changes = document_changes.iter().filter_map(|change| {
        if change.new_count == 0 {
            return None;
        }
        let current_start = change.new_start.max(body_document_start);
        let current_end = change
            .new_start
            .saturating_add(change.new_count - 1)
            .min(body_document_end);
        if current_start > current_end {
            return None;
        }
        let previous_text = old_body_bounds.and_then(|(old_start, old_end)| {
            let lines = change
                .previous_lines
                .iter()
                .filter(|(line, _)| *line >= old_start && *line <= old_end)
                .map(|(_, text)| text.as_str())
                .collect::<Vec<_>>();
            (!lines.is_empty()).then(|| lines.join("\n"))
        });
        Some(GitLineChange {
            start: current_start - body_document_start + 1,
            end: current_end - body_document_start + 1,
            previous_text,
        })
    });
    Ok(changes.collect())
}

fn parse_hunk_range(value: &str) -> Option<(usize, usize)> {
    let mut fields = value.splitn(2, ',');
    let start = fields.next()?.parse::<usize>().ok()?;
    let count = fields
        .next()
        .map(|value| value.parse::<usize>().ok())
        .unwrap_or(Some(1))?;
    Some((start, count))
}

fn parse_hunk_header(line: &str) -> Option<(usize, usize, usize, usize)> {
    let header = line.strip_prefix("@@ -")?;
    let (old, rest) = header.split_once(" +")?;
    let (current, _) = rest.split_once(" @@")?;
    let (old_start, old_count) = parse_hunk_range(old)?;
    let (new_start, new_count) = parse_hunk_range(current)?;
    Some((old_start, old_count, new_start, new_count))
}

fn parse_document_changes(diff: &str) -> Vec<GitDocumentChange> {
    let mut changes = Vec::new();
    let mut current: Option<GitDocumentChange> = None;
    let mut old_line = 0;

    for line in diff.lines() {
        if let Some((old_start, old_count, new_start, new_count)) = parse_hunk_header(line) {
            if let Some(change) = current.take() {
                changes.push(change);
            }
            old_line = old_start;
            current = Some(GitDocumentChange {
                old_start,
                old_count,
                new_start,
                new_count,
                previous_lines: Vec::new(),
            });
            continue;
        }
        let Some(change) = current.as_mut() else {
            continue;
        };
        if let Some(previous) = line.strip_prefix('-') {
            change.previous_lines.push((old_line, previous.to_string()));
            old_line = old_line.saturating_add(1);
        } else if line.starts_with(' ') {
            old_line = old_line.saturating_add(1);
        }
    }
    if let Some(change) = current {
        changes.push(change);
    }
    changes
}

/// Added plus deleted lines for tracked paths relative to `base`.
pub fn changed_line_counts(
    root: &Path,
    repository: &Path,
    base: &str,
) -> Result<BTreeMap<String, usize>, String> {
    let output = output_with_safe_directory(
        root,
        repository,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--relative",
            "--numstat",
            "-z",
            "--no-renames",
            base,
            "--",
            ".",
        ],
    )?;
    if !output.status.success() {
        return Err("Git could not measure bundle changes.".to_string());
    }
    let text = bounded_output(&output.stdout, "Git line counts")?;
    let mut counts = BTreeMap::new();
    for record in text.split('\0').filter(|record| !record.is_empty()) {
        let mut fields = record.splitn(3, '\t');
        let added = fields.next().and_then(|value| value.parse::<usize>().ok());
        let deleted = fields.next().and_then(|value| value.parse::<usize>().ok());
        let path = fields.next();
        let (Some(added), Some(deleted), Some(path)) = (added, deleted, path) else {
            continue;
        };
        if validate_relative_path(path).is_ok() {
            counts.insert(path.replace('\\', "/"), added.saturating_add(deleted));
        }
    }
    Ok(counts)
}

pub fn output(directory: &Path, args: &[&str]) -> Result<Output, String> {
    output_inner(directory, None, args)
}

pub fn output_with_safe_directory(
    directory: &Path,
    safe_repository: &Path,
    args: &[&str],
) -> Result<Output, String> {
    output_inner(directory, Some(safe_repository), args)
}

fn output_inner(
    directory: &Path,
    safe_repository: Option<&Path>,
    args: &[&str],
) -> Result<Output, String> {
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .current_dir(directory)
        .args(["-c", "core.fsmonitor=false"])
        .args(["-c", "log.showSignature=false"])
        .args(["-c", "core.hooksPath="])
        .args(["-c", "protocol.ext.allow=never"])
        .args(["--no-optional-locks", "--no-pager"]);
    if let Some(repository) = safe_repository {
        let repository = safe_directory_value(repository)?;
        command.args(["-c", &format!("safe.directory={repository}")]);
    }
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("LC_ALL", "C")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_COUNT")
        .output()
        .map_err(|_| "OKF Reviewer could not start Git.".to_string())
}

fn safe_directory_value(repository: &Path) -> Result<String, String> {
    let value = repository
        .to_str()
        .ok_or_else(|| "The Git repository path is not valid UTF-8.".to_string())?;
    #[cfg(windows)]
    return Ok(value.replace('\\', "/"));
    #[cfg(not(windows))]
    Ok(value.to_string())
}

pub fn text_with_safe_directory(
    directory: &Path,
    safe_repository: &Path,
    args: &[&str],
) -> Result<String, String> {
    let output = output_with_safe_directory(directory, safe_repository, args)?;
    if !output.status.success() {
        return Err("Git could not read the requested bundle revision.".to_string());
    }
    bounded_output(&output.stdout, "Git output")
}

pub fn bounded_output(bytes: &[u8], label: &str) -> Result<String, String> {
    if bytes.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(format!("{label} exceeded the 1 MiB limit."));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| format!("{label} was not valid UTF-8."))
}

fn collect_concept_ids(
    bytes: &[u8],
    known: &BTreeSet<&str>,
    out: &mut BTreeSet<String>,
) -> Result<(), String> {
    let text = bounded_output(bytes, "Git bundle paths")?;
    for raw in text.split('\0').filter(|path| !path.is_empty()) {
        let path = raw.replace('\\', "/");
        validate_relative_path(&path)?;
        let Some(id) = concept_id(&path) else {
            continue;
        };
        if known.contains(id.as_str()) {
            out.insert(id);
        }
    }
    Ok(())
}

fn concept_id(path: &str) -> Option<String> {
    let lower = path.to_ascii_lowercase();
    if !lower.ends_with(".md") {
        return None;
    }
    let name = Path::new(&lower).file_name()?.to_str()?;
    if matches!(name, "index.md" | "log.md") {
        return None;
    }
    Some(path[..path.len() - 3].to_string())
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 4096
        || path.chars().any(char::is_control)
        || Path::new(path).is_absolute() || Path::new(path).components().any(|component| {
        !matches!(component, Component::Normal(_))
            || matches!(component, Component::Normal(value) if value.eq_ignore_ascii_case(".git"))
    }) {
        return Err("Git returned an unsafe bundle-relative path.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn run_git(directory: &Path, args: &[&str]) -> String {
        let result = Command::new("git")
            .current_dir(directory)
            .args(args)
            .output()
            .expect("start git fixture");
        assert!(
            result.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8_lossy(&result.stdout).trim().to_string()
    }

    fn concept(title: &str) -> String {
        format!("---\ntype: Note\ntitle: {title}\n---\n# {title}\n\nBody.\n")
    }

    #[test]
    fn bundle_status_covers_tracked_untracked_and_safe_bundle_paths() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let repository = std::env::temp_dir().join(format!(
            "okf-review-git-status-{}-{nonce}",
            std::process::id()
        ));
        let docs = repository.join("bundle");
        fs::create_dir_all(docs.join("nested")).expect("fixture directories");
        fs::write(docs.join("index.md"), "# Fixture\n").expect("index");
        fs::write(docs.join(".gitignore"), "ignored.md\n").expect("ignore");
        for name in [
            "unstaged.md",
            "staged.md",
            "old.md",
            "deleted.md",
            "space name.md",
            "東京.md",
        ] {
            fs::write(docs.join(name), concept(name)).expect("concept");
        }
        fs::write(repository.join("outside.md"), concept("Outside")).expect("outside");
        run_git(&repository, &["init", "--quiet"]);
        run_git(
            &repository,
            &["config", "user.email", "fixture@example.com"],
        );
        run_git(&repository, &["config", "user.name", "Fixture"]);
        run_git(&repository, &["config", "commit.gpgsign", "false"]);
        run_git(&repository, &["add", "."]);
        run_git(&repository, &["commit", "--quiet", "-m", "base"]);

        fs::write(docs.join("unstaged.md"), concept("Unstaged change")).expect("unstaged");
        fs::write(docs.join("staged.md"), concept("Staged change")).expect("staged");
        run_git(&repository, &["add", "bundle/staged.md"]);
        fs::rename(docs.join("old.md"), docs.join("renamed ü.md")).expect("rename");
        fs::remove_file(docs.join("deleted.md")).expect("delete");
        fs::write(docs.join("space name.md"), concept("Space change")).expect("space");
        fs::write(docs.join("東京.md"), concept("Unicode change")).expect("unicode");
        fs::write(docs.join("untracked.md"), concept("Untracked")).expect("untracked");
        fs::write(docs.join("ignored.md"), concept("Ignored")).expect("ignored");
        fs::write(docs.join("nested/index.md"), concept("Reserved")).expect("reserved");
        fs::write(docs.join("notes.txt"), "not a concept").expect("nonconcept");
        fs::write(repository.join("outside.md"), concept("Outside change"))
            .expect("outside change");

        let bundle = okf_core::read_bundle(&docs);
        let status = bundle_status(&docs, &repository, &bundle).expect("bundle status");
        assert!(status.available);
        assert_eq!(
            status.head_revision,
            Some(run_git(&repository, &["rev-parse", "HEAD"]))
        );
        assert_eq!(
            status.modified_concept_ids,
            vec![
                "renamed ü".to_string(),
                "space name".to_string(),
                "staged".to_string(),
                "unstaged".to_string(),
                "untracked".to_string(),
                "東京".to_string(),
            ]
        );
        assert!(!status.modified_concept_ids.iter().any(|id| {
            matches!(
                id.as_str(),
                "deleted" | "ignored" | "nested/index" | "outside"
            )
        }));
        assert_eq!(
            status.line_changes_by_concept.get("unstaged"),
            Some(&vec![GitLineChange {
                start: 1,
                end: 1,
                previous_text: Some("# unstaged.md".to_string()),
            }])
        );
        assert_eq!(
            status.line_changes_by_concept.get("untracked"),
            Some(&vec![GitLineChange {
                start: 1,
                end: 3,
                previous_text: None,
            }])
        );
        assert_eq!(
            status.deleted_paths,
            vec!["deleted.md".to_string(), "old.md".to_string()]
        );

        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn feature_branch_status_uses_default_branch_merge_base_and_reports_deletions() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let repository = std::env::temp_dir().join(format!(
            "okf-review-feature-status-{}-{nonce}",
            std::process::id()
        ));
        let docs = repository.join("bundle");
        fs::create_dir_all(&docs).expect("fixture directory");
        fs::write(docs.join("index.md"), "# Fixture\n").expect("index");
        fs::write(docs.join("feature.md"), concept("Base feature")).expect("feature");
        fs::write(docs.join("deleted.md"), concept("Deleted")).expect("deleted");
        run_git(&repository, &["init", "--quiet", "--initial-branch=main"]);
        run_git(
            &repository,
            &["config", "user.email", "fixture@example.com"],
        );
        run_git(&repository, &["config", "user.name", "Fixture"]);
        run_git(&repository, &["config", "commit.gpgsign", "false"]);
        run_git(&repository, &["add", "."]);
        run_git(&repository, &["commit", "--quiet", "-m", "base"]);
        let base = run_git(&repository, &["rev-parse", "HEAD"]);
        run_git(
            &repository,
            &["checkout", "--quiet", "-b", "feature/review"],
        );
        fs::write(docs.join("feature.md"), concept("Committed feature change"))
            .expect("feature change");
        run_git(&repository, &["add", "bundle/feature.md"]);
        run_git(&repository, &["commit", "--quiet", "-m", "feature"]);
        fs::remove_file(docs.join("deleted.md")).expect("delete");
        fs::write(docs.join("untracked.md"), concept("Untracked")).expect("untracked");

        let bundle = okf_core::read_bundle(&docs);
        let status = bundle_status(&docs, &repository, &bundle).expect("feature status");
        assert_eq!(status.comparison_mode, GitComparisonMode::FeatureBranch);
        assert_eq!(status.current_branch.as_deref(), Some("feature/review"));
        assert_eq!(status.default_branch.as_deref(), Some("main"));
        assert_eq!(status.base_revision.as_deref(), Some(base.as_str()));
        assert_eq!(
            status.modified_concept_ids,
            vec!["feature".to_string(), "untracked".to_string()]
        );
        assert_eq!(
            status.line_changes_by_concept.get("feature"),
            Some(&vec![GitLineChange {
                start: 1,
                end: 1,
                previous_text: Some("# Base feature".to_string()),
            }]),
            "feature branches compare against the default-branch merge base",
        );
        assert_eq!(status.deleted_paths, vec!["deleted.md".to_string()]);

        run_git(&repository, &["checkout", "--quiet", "--detach"]);
        let detached = bundle_status(&docs, &repository, &bundle).expect("detached status");
        assert_eq!(detached.comparison_mode, GitComparisonMode::WorkingTree);
        assert_eq!(detached.current_branch, None);
        assert_eq!(
            detached.base_revision, detached.head_revision,
            "detached HEAD falls back to HEAD-versus-working-tree"
        );

        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn default_branch_discovery_prefers_origin_head() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let repository = std::env::temp_dir().join(format!(
            "okf-review-default-branch-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&repository).expect("fixture directory");
        fs::write(repository.join("README.md"), "fixture\n").expect("fixture file");
        run_git(&repository, &["init", "--quiet", "--initial-branch=main"]);
        run_git(
            &repository,
            &["config", "user.email", "fixture@example.com"],
        );
        run_git(&repository, &["config", "user.name", "Fixture"]);
        run_git(&repository, &["config", "commit.gpgsign", "false"]);
        run_git(&repository, &["add", "."]);
        run_git(&repository, &["commit", "--quiet", "-m", "base"]);
        run_git(
            &repository,
            &["update-ref", "refs/remotes/origin/trunk", "HEAD"],
        );
        run_git(
            &repository,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/trunk",
            ],
        );

        assert_eq!(
            default_branch_ref(&repository).expect("default branch"),
            Some("refs/remotes/origin/trunk".to_string())
        );

        let _ = fs::remove_dir_all(repository);
    }

    #[test]
    fn parses_additions_replacements_deletions_and_missing_final_newlines() {
        let diff = concat!(
            "@@ -2 +2,2 @@\n",
            "-old\n",
            "+new\n",
            "+also new\n",
            "@@ -10,3 +11,0 @@\n",
            "-deleted one\n",
            "-deleted two\n",
            "-deleted three\n",
            "@@ -20 +19 @@\n",
            "-before\n",
            "\\ No newline at end of file\n",
            "+after",
        );
        assert_eq!(
            parse_document_changes(diff),
            vec![
                GitDocumentChange {
                    old_start: 2,
                    old_count: 1,
                    new_start: 2,
                    new_count: 2,
                    previous_lines: vec![(2, "old".to_string())],
                },
                GitDocumentChange {
                    old_start: 10,
                    old_count: 3,
                    new_start: 11,
                    new_count: 0,
                    previous_lines: vec![
                        (10, "deleted one".to_string()),
                        (11, "deleted two".to_string()),
                        (12, "deleted three".to_string()),
                    ],
                },
                GitDocumentChange {
                    old_start: 20,
                    old_count: 1,
                    new_start: 19,
                    new_count: 1,
                    previous_lines: vec![(20, "before".to_string())],
                },
            ]
        );
    }

    #[test]
    fn maps_old_and_current_documents_to_their_own_body_lines() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "okf-review-git-body-ranges-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("fixture directory");
        fs::write(
            root.join("concept.md"),
            "---\ntype: Note\ntitle: Current\n---\n# Current\n\nChanged body.\n",
        )
        .expect("fixture concept");

        let base = "---\ntype: Note\nowner: Team\ntitle: Previous\n---\n# Previous\n\nOld body.\n";
        let changes = body_line_changes(
            &root,
            "concept.md",
            Some(&[
                GitDocumentChange {
                    old_start: 4,
                    old_count: 1,
                    new_start: 3,
                    new_count: 1,
                    previous_lines: vec![(4, "title: Previous".to_string())],
                },
                GitDocumentChange {
                    old_start: 6,
                    old_count: 1,
                    new_start: 5,
                    new_count: 1,
                    previous_lines: vec![(6, "# Previous".to_string())],
                },
                GitDocumentChange {
                    old_start: 8,
                    old_count: 1,
                    new_start: 7,
                    new_count: 1,
                    previous_lines: vec![(8, "Old body.".to_string())],
                },
                GitDocumentChange {
                    old_start: 9,
                    old_count: 1,
                    new_start: 8,
                    new_count: 0,
                    previous_lines: vec![(9, "Deleted only.".to_string())],
                },
            ]),
            Some(base),
        )
        .expect("body changes");
        assert_eq!(
            changes,
            vec![
                GitLineChange {
                    start: 1,
                    end: 1,
                    previous_text: Some("# Previous".to_string()),
                },
                GitLineChange {
                    start: 3,
                    end: 3,
                    previous_text: Some("Old body.".to_string()),
                },
            ]
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn repository_candidate_finds_the_nearest_nested_bundle_repository() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let repository = std::env::temp_dir().join(format!(
            "okf-review-git-candidate-{}-{nonce}",
            std::process::id()
        ));
        let bundle = repository.join("one").join("two");
        fs::create_dir_all(&bundle).expect("bundle fixture");
        fs::create_dir(repository.join(".git")).expect("repository marker");
        assert_eq!(
            repository_candidate(&bundle).expect("candidate"),
            Some(dunce::canonicalize(&repository).expect("canonical repository"))
        );
        let _ = fs::remove_dir_all(repository);
    }

    #[cfg(windows)]
    #[test]
    fn safe_directory_uses_the_path_form_git_accepts_on_windows() {
        assert_eq!(
            safe_directory_value(Path::new(r"C:\Fixtures\Knowledge Repo")).expect("safe directory"),
            "C:/Fixtures/Knowledge Repo"
        );
    }
}
