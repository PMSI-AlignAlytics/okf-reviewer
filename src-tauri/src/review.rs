//! The one direct write in the review MVP.
//!
//! A review is deliberately narrower than a general staged-write
//! machinery: it may set `status: stable` and append one human `verified`
//! entry. It refuses ambiguous YAML, preserves the frontmatter fence and the
//! bytes after it, detects concurrent edits, validates the candidate, and
//! replaces the source through a same-directory temporary file.

use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const MAX_CONCEPT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPreflightInput {
    pub bundle_root: String,
    pub concept_id: String,
    pub reviewer_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewConceptInput {
    pub bundle_root: String,
    pub concept_id: String,
    pub reviewer_id: String,
    pub expected_fingerprint: String,
    pub reviewed_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewProblemCode {
    AccessDenied,
    InvalidPath,
    MissingConcept,
    TooLarge,
    InvalidUtf8,
    MissingFrontmatter,
    MalformedFrontmatter,
    MissingType,
    InvalidStatus,
    MalformedVerified,
    InvalidReviewer,
    InvalidTimestamp,
    Deprecated,
    Conflict,
    WriteFailed,
    CandidateInvalid,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewProblem {
    pub code: ReviewProblemCode,
    pub message: String,
}

impl ReviewProblem {
    pub fn new(code: ReviewProblemCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn access(message: impl Into<String>) -> Self {
        Self::new(ReviewProblemCode::AccessDenied, message)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPreflight {
    pub available: bool,
    pub reason_code: Option<ReviewProblemCode>,
    pub message: String,
    pub concept_id: String,
    pub relative_path: String,
    pub fingerprint: String,
    pub current_status: Option<String>,
    pub status_explicit: Option<bool>,
    pub review_state: Option<String>,
    pub reviewer_has_reviewed: bool,
    pub action_label: Option<String>,
    pub resulting_status: Option<String>,
    pub reviewed_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewConceptResult {
    pub concept_id: String,
    pub relative_path: String,
    pub fingerprint: String,
    pub status: String,
    pub status_explicit: bool,
    pub actor: String,
    pub reviewed_at: String,
    pub verification_count: usize,
    pub message: String,
}

struct FrontmatterEnvelope<'a> {
    yaml: &'a str,
    prefix: &'a str,
    suffix: &'a str,
    newline: &'static str,
}

struct ValidConcept {
    mapping: Mapping,
    status: String,
    status_explicit: bool,
    human_actors: Vec<String>,
    verification_count: usize,
}

struct PreparedConcept {
    path: PathBuf,
    relative_path: String,
    bytes: Vec<u8>,
    text: String,
}

/// Inspect one concept without changing it. Structural problems are returned as
/// an unavailable result so the reader can explain why its action is disabled.
pub fn preflight(
    bundle_root: &Path,
    concept_id: &str,
    reviewer_id: Option<&str>,
) -> Result<ReviewPreflight, ReviewProblem> {
    let prepared = prepare_concept(bundle_root, concept_id)?;
    let fingerprint = fingerprint(&prepared.bytes);
    let reviewed_at = now_rfc3339()?;
    let parsed = parse_valid_concept(&prepared.text);
    let valid = match parsed {
        Ok(valid) => valid,
        Err(problem) => {
            return Ok(ReviewPreflight {
                available: false,
                reason_code: Some(problem.code),
                message: problem.message,
                concept_id: concept_id.to_string(),
                relative_path: prepared.relative_path,
                fingerprint,
                current_status: None,
                status_explicit: None,
                review_state: None,
                reviewer_has_reviewed: false,
                action_label: None,
                resulting_status: None,
                reviewed_at,
            });
        }
    };

    let actor = match reviewer_id {
        Some(id) => match human_actor(id) {
            Ok(actor) => Some(actor),
            Err(problem) => {
                return Ok(unavailable(
                    concept_id,
                    prepared.relative_path,
                    fingerprint,
                    reviewed_at,
                    &valid,
                    problem,
                ));
            }
        },
        None => None,
    };
    let reviewer_has_reviewed = actor
        .as_ref()
        .is_some_and(|actor| valid.human_actors.iter().any(|existing| existing == actor));

    if valid.status == "deprecated" {
        return Ok(unavailable(
            concept_id,
            prepared.relative_path,
            fingerprint,
            reviewed_at,
            &valid,
            ReviewProblem::new(
                ReviewProblemCode::Deprecated,
                "Deprecated concepts are historical. Review is unavailable by default.",
            ),
        ));
    }

    let action_label = if reviewer_has_reviewed {
        "Review again"
    } else if valid.status != "stable" {
        "Mark reviewed and stable"
    } else if valid.human_actors.is_empty() {
        "Mark as reviewed"
    } else {
        "Add my review"
    };

    let current_review_state = review_state(&valid);

    Ok(ReviewPreflight {
        available: true,
        reason_code: None,
        message: if valid.status_explicit {
            "This app will append a human verification record.".to_string()
        } else {
            "Status is implicitly stable. This review will author status: stable and append a human verification record.".to_string()
        },
        concept_id: concept_id.to_string(),
        relative_path: prepared.relative_path,
        fingerprint,
        current_status: Some(valid.status),
        status_explicit: Some(valid.status_explicit),
        review_state: Some(current_review_state),
        reviewer_has_reviewed,
        action_label: Some(action_label.to_string()),
        resulting_status: Some("stable".to_string()),
        reviewed_at,
    })
}

/// Apply a confirmed review. Expected failures are typed so the interface can
/// distinguish a conflict from malformed data or an I/O failure.
pub fn apply(
    bundle_root: &Path,
    input: &ReviewConceptInput,
) -> Result<ReviewConceptResult, ReviewProblem> {
    apply_with_failure(bundle_root, input, false)
}

fn apply_with_failure(
    bundle_root: &Path,
    input: &ReviewConceptInput,
    fail_before_replace: bool,
) -> Result<ReviewConceptResult, ReviewProblem> {
    let actor = human_actor(&input.reviewer_id)?;
    validate_timestamp(&input.reviewed_at)?;
    let prepared = prepare_concept(bundle_root, &input.concept_id)?;
    if fingerprint(&prepared.bytes) != input.expected_fingerprint {
        return Err(ReviewProblem::new(
            ReviewProblemCode::Conflict,
            "The concept changed after confirmation opened. Reload it and review the new version.",
        ));
    }

    let envelope = split_frontmatter(&prepared.text)?;
    let valid = validate_mapping(parse_mapping(envelope.yaml)?)?;
    if valid.status == "deprecated" {
        return Err(ReviewProblem::new(
            ReviewProblemCode::Deprecated,
            "Deprecated concepts are historical. Review is unavailable by default.",
        ));
    }

    let mut updated = valid.mapping.clone();
    updated.insert(yaml_key("status"), Value::String("stable".to_string()));
    let (_, body) = okf_core::frontmatter::split(&prepared.text);
    let content_hash = okf_core::content_sha256(body);
    append_verification(&mut updated, &actor, &input.reviewed_at, &content_hash)?;

    let serialized = serialize_mapping(&updated, envelope.newline)?;
    let mut candidate =
        String::with_capacity(envelope.prefix.len() + serialized.len() + envelope.suffix.len());
    candidate.push_str(envelope.prefix);
    candidate.push_str(&serialized);
    candidate.push_str(envelope.suffix);
    validate_candidate(&candidate, &updated, envelope.suffix)?;

    let temporary = temporary_path(&prepared.path);
    let result = (|| -> Result<(), ReviewProblem> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| {
                ReviewProblem::new(
                    ReviewProblemCode::WriteFailed,
                    "The review transaction file could not be created.",
                )
            })?;
        output.write_all(candidate.as_bytes()).map_err(|_| {
            ReviewProblem::new(
                ReviewProblemCode::WriteFailed,
                "The review transaction file could not be written.",
            )
        })?;
        output.sync_all().map_err(|_| {
            ReviewProblem::new(
                ReviewProblemCode::WriteFailed,
                "The review transaction file could not be synced.",
            )
        })?;
        let permissions = fs::metadata(&prepared.path)
            .map_err(|_| {
                ReviewProblem::new(
                    ReviewProblemCode::WriteFailed,
                    "The concept permissions could not be inspected.",
                )
            })?
            .permissions();
        fs::set_permissions(&temporary, permissions).map_err(|_| {
            ReviewProblem::new(
                ReviewProblemCode::WriteFailed,
                "The concept permissions could not be preserved.",
            )
        })?;
        drop(output);

        let staged = fs::read_to_string(&temporary).map_err(|_| {
            ReviewProblem::new(
                ReviewProblemCode::CandidateInvalid,
                "The completed review transaction could not be read back.",
            )
        })?;
        validate_candidate(&staged, &updated, envelope.suffix)?;

        let latest = fs::read(&prepared.path).map_err(|_| {
            ReviewProblem::new(
                ReviewProblemCode::Conflict,
                "The concept became unavailable before replacement.",
            )
        })?;
        if fingerprint(&latest) != input.expected_fingerprint {
            return Err(ReviewProblem::new(
                ReviewProblemCode::Conflict,
                "The concept changed while the review was being saved. The external edit was kept.",
            ));
        }
        if fail_before_replace {
            return Err(ReviewProblem::new(
                ReviewProblemCode::WriteFailed,
                "The injected replacement failure left the original unchanged.",
            ));
        }
        replace_file(&temporary, &prepared.path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;

    let verification_count = updated
        .get(yaml_key("verified"))
        .and_then(Value::as_sequence)
        .map_or(0, Vec::len);
    Ok(ReviewConceptResult {
        concept_id: input.concept_id.clone(),
        relative_path: prepared.relative_path,
        fingerprint: fingerprint(candidate.as_bytes()),
        status: "stable".to_string(),
        status_explicit: true,
        actor,
        reviewed_at: input.reviewed_at.clone(),
        verification_count,
        message: "Human review recorded. YAML presentation may be normalized; the Markdown body and unrelated values were preserved.".to_string(),
    })
}

fn unavailable(
    concept_id: &str,
    relative_path: String,
    fingerprint: String,
    reviewed_at: String,
    valid: &ValidConcept,
    problem: ReviewProblem,
) -> ReviewPreflight {
    ReviewPreflight {
        available: false,
        reason_code: Some(problem.code),
        message: problem.message,
        concept_id: concept_id.to_string(),
        relative_path,
        fingerprint,
        current_status: Some(valid.status.clone()),
        status_explicit: Some(valid.status_explicit),
        review_state: Some(review_state(valid)),
        reviewer_has_reviewed: false,
        action_label: None,
        resulting_status: None,
        reviewed_at,
    }
}

fn prepare_concept(bundle_root: &Path, concept_id: &str) -> Result<PreparedConcept, ReviewProblem> {
    let relative = concept_relative_path(concept_id)?;
    let requested = bundle_root.join(&relative);
    let metadata = fs::symlink_metadata(&requested).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::MissingConcept,
            "The concept file is no longer available.",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ReviewProblem::new(
            ReviewProblemCode::InvalidPath,
            "Review is limited to regular Markdown files inside the bundle.",
        ));
    }
    if metadata.len() > MAX_CONCEPT_BYTES {
        return Err(ReviewProblem::new(
            ReviewProblemCode::TooLarge,
            "The concept exceeds the 16 MB review limit.",
        ));
    }
    let canonical = dunce::canonicalize(&requested).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::MissingConcept,
            "The concept file is no longer available.",
        )
    })?;
    if !canonical.starts_with(bundle_root) {
        return Err(ReviewProblem::new(
            ReviewProblemCode::InvalidPath,
            "The concept path escapes the authorized bundle.",
        ));
    }
    let bytes = fs::read(&canonical).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::MissingConcept,
            "The concept file could not be read.",
        )
    })?;
    let text = String::from_utf8(bytes.clone()).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::InvalidUtf8,
            "Review requires a UTF-8 Markdown concept.",
        )
    })?;
    Ok(PreparedConcept {
        path: canonical,
        relative_path: relative.to_string_lossy().replace('\\', "/"),
        bytes,
        text,
    })
}

fn concept_relative_path(concept_id: &str) -> Result<PathBuf, ReviewProblem> {
    let id = concept_id.trim();
    if id.is_empty() || id.contains('\\') || id.ends_with(".md") {
        return Err(ReviewProblem::new(
            ReviewProblemCode::InvalidPath,
            "The concept identifier is invalid.",
        ));
    }
    let path = Path::new(id);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ReviewProblem::new(
            ReviewProblemCode::InvalidPath,
            "The concept identifier escapes the bundle.",
        ));
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(file_name.as_str(), "index" | "log") {
        return Err(ReviewProblem::new(
            ReviewProblemCode::InvalidPath,
            "Bundle indexes and logs are not reviewable concepts.",
        ));
    }
    Ok(PathBuf::from(format!("{id}.md")))
}

fn parse_valid_concept(text: &str) -> Result<ValidConcept, ReviewProblem> {
    let envelope = split_frontmatter(text)?;
    validate_mapping(parse_mapping(envelope.yaml)?)
}

fn split_frontmatter(text: &str) -> Result<FrontmatterEnvelope<'_>, ReviewProblem> {
    let bom_len = usize::from(text.starts_with('\u{feff}')) * '\u{feff}'.len_utf8();
    let after_bom = &text[bom_len..];
    let (yaml_start, newline) = if after_bom.starts_with("---\r\n") {
        (bom_len + 5, "\r\n")
    } else if after_bom.starts_with("---\n") {
        (bom_len + 4, "\n")
    } else {
        return Err(ReviewProblem::new(
            ReviewProblemCode::MissingFrontmatter,
            "Review requires a leading YAML frontmatter block.",
        ));
    };

    let mut cursor = yaml_start;
    while cursor <= text.len() {
        let line_end = text[cursor..]
            .find('\n')
            .map(|offset| cursor + offset + 1)
            .unwrap_or(text.len());
        let line = text[cursor..line_end]
            .trim_end_matches('\n')
            .trim_end_matches('\r');
        if line == "---" {
            let yaml_end = if cursor > yaml_start && text.as_bytes()[cursor - 1] == b'\n' {
                let before_newline = cursor - 1;
                if before_newline > yaml_start && text.as_bytes()[before_newline - 1] == b'\r' {
                    before_newline - 1
                } else {
                    before_newline
                }
            } else {
                cursor
            };
            return Ok(FrontmatterEnvelope {
                yaml: &text[yaml_start..yaml_end],
                prefix: &text[..yaml_start],
                suffix: &text[cursor..],
                newline,
            });
        }
        if line_end == text.len() {
            break;
        }
        cursor = line_end;
    }
    Err(ReviewProblem::new(
        ReviewProblemCode::MissingFrontmatter,
        "The YAML frontmatter has no closing fence.",
    ))
}

fn parse_mapping(yaml: &str) -> Result<Mapping, ReviewProblem> {
    let value: Value = serde_yaml_ng::from_str(yaml).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::MalformedFrontmatter,
            "The YAML frontmatter is malformed or contains duplicate keys.",
        )
    })?;
    value.as_mapping().cloned().ok_or_else(|| {
        ReviewProblem::new(
            ReviewProblemCode::MalformedFrontmatter,
            "Concept frontmatter must be a YAML mapping.",
        )
    })
}

fn validate_mapping(mapping: Mapping) -> Result<ValidConcept, ReviewProblem> {
    let concept_type = mapping
        .get(yaml_key("type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ReviewProblem::new(
                ReviewProblemCode::MissingType,
                "Review requires a non-empty string type.",
            )
        })?;
    let _ = concept_type;

    let status_value = mapping.get(yaml_key("status"));
    let status_explicit = status_value.is_some();
    let status = match status_value {
        None => "stable".to_string(),
        Some(Value::String(value))
            if matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "draft" | "stable" | "experimental" | "deprecated"
            ) =>
        {
            value.trim().to_ascii_lowercase()
        }
        _ => {
            return Err(ReviewProblem::new(
                ReviewProblemCode::InvalidStatus,
                "Status must be draft, stable, experimental, or deprecated.",
            ));
        }
    };

    let mut human_actors = Vec::new();
    let verification_count = match mapping.get(yaml_key("verified")) {
        None => 0,
        Some(Value::Mapping(entry)) => {
            validate_verification(entry, &mut human_actors)?;
            1
        }
        Some(Value::Sequence(entries)) => {
            for entry in entries {
                let entry = entry.as_mapping().ok_or_else(|| {
                    ReviewProblem::new(
                        ReviewProblemCode::MalformedVerified,
                        "Every verified entry must be a { by, at } mapping.",
                    )
                })?;
                validate_verification(entry, &mut human_actors)?;
            }
            entries.len()
        }
        Some(_) => {
            return Err(ReviewProblem::new(
                ReviewProblemCode::MalformedVerified,
                "Verified must be a { by, at } mapping or a list of mappings.",
            ));
        }
    };

    Ok(ValidConcept {
        mapping,
        status,
        status_explicit,
        human_actors,
        verification_count,
    })
}

fn validate_verification(
    entry: &Mapping,
    human_actors: &mut Vec<String>,
) -> Result<(), ReviewProblem> {
    let by = entry
        .get(yaml_key("by"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ReviewProblem::new(
                ReviewProblemCode::MalformedVerified,
                "Every verified entry needs a non-empty string by value.",
            )
        })?;
    let at = entry
        .get(yaml_key("at"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ReviewProblem::new(
                ReviewProblemCode::MalformedVerified,
                "Every verified entry needs an RFC 3339 at timestamp.",
            )
        })?;
    validate_timestamp(at).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::MalformedVerified,
            "Every verified entry needs an RFC 3339 at timestamp.",
        )
    })?;
    if by.starts_with("human:") {
        human_actors.push(by.to_string());
    }
    Ok(())
}

fn append_verification(
    mapping: &mut Mapping,
    actor: &str,
    reviewed_at: &str,
    content_hash: &str,
) -> Result<(), ReviewProblem> {
    let mut entry = Mapping::new();
    entry.insert(yaml_key("by"), Value::String(actor.to_string()));
    entry.insert(yaml_key("at"), Value::String(reviewed_at.to_string()));
    // Binds the review to the body it approved, so later edits are detected
    // even when generated.at is not updated.
    entry.insert(
        yaml_key("content_sha256"),
        Value::String(content_hash.to_string()),
    );
    let entry = Value::Mapping(entry);
    let key = yaml_key("verified");
    match mapping.remove(&key) {
        None => {
            mapping.insert(key, Value::Sequence(vec![entry]));
        }
        Some(Value::Mapping(existing)) => {
            mapping.insert(key, Value::Sequence(vec![Value::Mapping(existing), entry]));
        }
        Some(Value::Sequence(mut existing)) => {
            existing.push(entry);
            mapping.insert(key, Value::Sequence(existing));
        }
        Some(_) => {
            return Err(ReviewProblem::new(
                ReviewProblemCode::MalformedVerified,
                "Verified changed to an unsupported shape.",
            ));
        }
    }
    Ok(())
}

fn serialize_mapping(mapping: &Mapping, newline: &str) -> Result<String, ReviewProblem> {
    let mut yaml = serde_yaml_ng::to_string(&Value::Mapping(mapping.clone())).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::CandidateInvalid,
            "The updated YAML frontmatter could not be serialized.",
        )
    })?;
    if let Some(without_marker) = yaml.strip_prefix("---\n") {
        yaml = without_marker.to_string();
    }
    yaml = yaml.trim_end_matches(['\r', '\n']).to_string();
    if newline == "\r\n" {
        yaml = yaml.replace('\n', "\r\n");
    }
    yaml.push_str(newline);
    Ok(yaml)
}

fn validate_candidate(
    candidate: &str,
    expected_mapping: &Mapping,
    expected_suffix: &str,
) -> Result<(), ReviewProblem> {
    let envelope = split_frontmatter(candidate).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::CandidateInvalid,
            "The updated concept lost its frontmatter boundary.",
        )
    })?;
    let mapping = parse_mapping(envelope.yaml).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::CandidateInvalid,
            "The updated concept did not parse as YAML.",
        )
    })?;
    validate_mapping(mapping.clone()).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::CandidateInvalid,
            "The updated concept failed review validation.",
        )
    })?;
    if &mapping != expected_mapping {
        return Err(ReviewProblem::new(
            ReviewProblemCode::CandidateInvalid,
            "The updated concept did not preserve its promised frontmatter values.",
        ));
    }
    if envelope.suffix != expected_suffix {
        return Err(ReviewProblem::new(
            ReviewProblemCode::CandidateInvalid,
            "The updated concept did not preserve its Markdown body bytes.",
        ));
    }
    Ok(())
}

fn human_actor(id: &str) -> Result<String, ReviewProblem> {
    let id = id.trim().strip_prefix("human:").unwrap_or(id.trim());
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '@'))
    {
        return Err(ReviewProblem::new(
            ReviewProblemCode::InvalidReviewer,
            "Reviewer ID must use 1 to 128 letters, numbers, dots, dashes, underscores, or @.",
        ));
    }
    Ok(format!("human:{id}"))
}

fn validate_timestamp(timestamp: &str) -> Result<(), ReviewProblem> {
    OffsetDateTime::parse(timestamp.trim(), &Rfc3339)
        .map(|_| ())
        .map_err(|_| {
            ReviewProblem::new(
                ReviewProblemCode::InvalidTimestamp,
                "The review timestamp must be RFC 3339.",
            )
        })
}

fn now_rfc3339() -> Result<String, ReviewProblem> {
    OffsetDateTime::now_utc().format(&Rfc3339).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::InvalidTimestamp,
            "The review timestamp could not be prepared.",
        )
    })
}

fn review_state(valid: &ValidConcept) -> String {
    if !valid.human_actors.is_empty() {
        "human-reviewed".to_string()
    } else if valid.verification_count > 0 {
        "machine-confirmed".to_string()
    } else {
        "unverified".to_string()
    }
}

fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn temporary_path(target: &Path) -> PathBuf {
    static TRANSACTION_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("concept.md");
    let id = TRANSACTION_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    target.with_file_name(format!(
        ".{file_name}.okf-review-{}-{id}.tmp",
        std::process::id(),
    ))
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, target: &Path) -> Result<(), ReviewProblem> {
    fs::rename(temporary, target).map_err(|_| {
        ReviewProblem::new(
            ReviewProblemCode::WriteFailed,
            "The completed review could not replace the concept.",
        )
    })?;
    if let Some(parent) = target.parent() {
        if let Ok(directory) = fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(temporary: &Path, target: &Path) -> Result<(), ReviewProblem> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "Kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut core::ffi::c_void,
            reserved: *mut core::ffi::c_void,
        ) -> i32;
    }

    let mut replaced = target.as_os_str().encode_wide().collect::<Vec<_>>();
    replaced.push(0);
    let mut replacement = temporary.as_os_str().encode_wide().collect::<Vec<_>>();
    replacement.push(0);
    // ReplaceFileW is the Windows atomic replacement primitive for an existing
    // file. The paths are NUL-terminated above and stay alive for the call.
    let succeeded = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            ptr::null(),
            0x0000_0001,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if succeeded == 0 {
        let error = std::io::Error::last_os_error();
        Err(ReviewProblem::new(
            ReviewProblemCode::WriteFailed,
            format!("The completed review could not atomically replace the concept: {error}"),
        ))
    } else {
        Ok(())
    }
}

fn yaml_key(key: &str) -> Value {
    Value::String(key.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        apply, apply_with_failure, concept_relative_path, preflight, ReviewConceptInput,
        ReviewProblemCode,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            static FIXTURE_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let id = FIXTURE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("okf-review-{name}-{}-{id}", std::process::id(),));
            fs::create_dir_all(&root).expect("fixture root");
            fs::write(
                root.join("index.md"),
                "---\nokf_version: \"0.2\"\n---\n# Test\n",
            )
            .expect("fixture index");
            Self(dunce::canonicalize(root).expect("canonical fixture"))
        }

        fn write(&self, id: &str, content: &[u8]) {
            let path = self.0.join(format!("{id}.md"));
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("fixture directory");
            }
            fs::write(path, content).expect("fixture concept");
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn confirmed(fixture: &Fixture, id: &str, reviewer_id: &str) -> ReviewConceptInput {
        let preflight =
            preflight(fixture.path(), id, Some(reviewer_id)).expect("preflight succeeds");
        assert!(preflight.available, "{}", preflight.message);
        ReviewConceptInput {
            bundle_root: fixture.path().display().to_string(),
            concept_id: id.to_string(),
            reviewer_id: reviewer_id.to_string(),
            expected_fingerprint: preflight.fingerprint,
            reviewed_at: "2026-07-30T09:10:11Z".to_string(),
        }
    }

    #[test]
    fn distinguishes_implicit_stable_and_marks_it_explicit() {
        let fixture = Fixture::new("implicit-stable");
        fixture.write(
            "note",
            b"---\ntype: Note\ntitle: One\n---\n# Body\nExact bytes.\n",
        );
        let preflight = preflight(fixture.path(), "note", Some("sam")).expect("preflight succeeds");
        assert_eq!(preflight.current_status.as_deref(), Some("stable"));
        assert_eq!(preflight.status_explicit, Some(false));
        assert_eq!(preflight.action_label.as_deref(), Some("Mark as reviewed"));

        let result =
            apply(fixture.path(), &confirmed(&fixture, "note", "sam")).expect("review succeeds");
        assert!(result.status_explicit);
        let output = fs::read_to_string(fixture.path().join("note.md")).expect("output");
        assert!(output.contains("status: stable"));
        assert!(output.ends_with("---\n# Body\nExact bytes.\n"));

        let reloaded = okf_core::read_bundle(fixture.path());
        let concept = reloaded
            .concepts
            .iter()
            .find(|concept| concept.id == "note")
            .expect("reviewed concept reloads");
        assert_eq!(concept.verified.len(), 1);
        assert_eq!(concept.verified[0].by, "human:sam");
        assert_eq!(
            concept.verified[0].content_sha256.as_deref(),
            Some(concept.content_sha256.as_str()),
            "the review must record the hash of the body it approved"
        );
        assert_eq!(
            concept.content_sha256,
            okf_core::content_sha256("# Body\nExact bytes.\n")
        );
    }

    #[test]
    fn converts_a_bare_verification_to_an_append_only_list() {
        let fixture = Fixture::new("bare-verified");
        fixture.write(
            "note",
            b"---\ntype: Note\nstatus: draft\nverified:\n  by: tool/1\n  at: 2026-07-01T00:00:00Z\ngenerated:\n  by: generator/2\n  at: 2026-06-30T00:00:00Z\nextension:\n  nested: value\n---\nBody without a final newline",
        );
        let input = confirmed(&fixture, "note", "a.person@example.com");
        let result = apply(fixture.path(), &input).expect("review succeeds");
        assert_eq!(result.verification_count, 2);
        let output = fs::read_to_string(fixture.path().join("note.md")).expect("output");
        let value: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(output.split("---").nth(1).expect("frontmatter content"))
                .expect("output yaml");
        assert_eq!(
            value["generated"]["by"].as_str(),
            Some("generator/2"),
            "generated must not become verified"
        );
        assert_eq!(value["extension"]["nested"].as_str(), Some("value"));
        assert!(output.ends_with("---\nBody without a final newline"));
    }

    #[test]
    fn preserves_bom_crlf_and_every_byte_after_the_frontmatter() {
        let fixture = Fixture::new("crlf");
        let source = b"\xef\xbb\xbf---\r\ntype: Note\r\ntags: [one, two]\r\n---\r\n# Body\r\n\r\n```yaml\r\n---\r\n```\r\n";
        fixture.write("nested/note", source);
        let suffix = &source[source
            .windows(5)
            .enumerate()
            .filter(|(_, part)| *part == b"---\r\n")
            .nth(1)
            .expect("closing fence")
            .0..];
        apply(
            fixture.path(),
            &confirmed(&fixture, "nested/note", "reviewer"),
        )
        .expect("review succeeds");
        let output = fs::read(fixture.path().join("nested/note.md")).expect("output");
        assert!(output.starts_with(b"\xef\xbb\xbf---\r\n"));
        assert!(output.ends_with(suffix));
    }

    #[test]
    fn labels_machine_and_human_review_states_separately() {
        let fixture = Fixture::new("labels");
        fixture.write(
            "machine",
            b"---\ntype: Note\nverified:\n  by: tool/1\n  at: 2026-07-01T00:00:00Z\n---\n",
        );
        fixture.write(
            "human",
            b"---\ntype: Note\nverified:\n  by: human:alex\n  at: 2026-07-01T00:00:00Z\n---\n",
        );
        let machine = preflight(fixture.path(), "machine", Some("alex")).expect("machine");
        let human = preflight(fixture.path(), "human", Some("alex")).expect("human");
        assert_eq!(machine.review_state.as_deref(), Some("machine-confirmed"));
        assert_eq!(machine.action_label.as_deref(), Some("Mark as reviewed"));
        assert_eq!(human.review_state.as_deref(), Some("human-reviewed"));
        assert_eq!(human.action_label.as_deref(), Some("Review again"));
    }

    #[test]
    fn deprecated_and_malformed_verification_are_unavailable() {
        let fixture = Fixture::new("unavailable");
        fixture.write(
            "deprecated",
            b"---\ntype: Note\nstatus: deprecated\n---\nHistorical\n",
        );
        fixture.write(
            "malformed",
            b"---\ntype: Note\nverified: somebody\n---\nBody\n",
        );
        fixture.write(
            "duplicate",
            b"---\ntype: Note\nverified: []\nverified: []\n---\nBody\n",
        );
        let deprecated =
            preflight(fixture.path(), "deprecated", Some("sam")).expect("deprecated result");
        let malformed =
            preflight(fixture.path(), "malformed", Some("sam")).expect("malformed result");
        let duplicate =
            preflight(fixture.path(), "duplicate", Some("sam")).expect("duplicate result");
        assert!(!deprecated.available);
        assert_eq!(deprecated.reason_code, Some(ReviewProblemCode::Deprecated));
        assert!(!malformed.available);
        assert_eq!(
            malformed.reason_code,
            Some(ReviewProblemCode::MalformedVerified)
        );
        assert!(!duplicate.available);
        assert_eq!(
            duplicate.reason_code,
            Some(ReviewProblemCode::MalformedFrontmatter)
        );
    }

    #[test]
    fn conflict_keeps_the_external_edit() {
        let fixture = Fixture::new("conflict");
        fixture.write("note", b"---\ntype: Note\n---\nOriginal\n");
        let input = confirmed(&fixture, "note", "sam");
        fs::write(
            fixture.path().join("note.md"),
            "---\ntype: Note\n---\nExternal edit\n",
        )
        .expect("external edit");
        let error = apply(fixture.path(), &input).expect_err("conflict");
        assert_eq!(error.code, ReviewProblemCode::Conflict);
        assert!(fs::read_to_string(fixture.path().join("note.md"))
            .expect("kept edit")
            .ends_with("External edit\n"));
    }

    #[test]
    fn replacement_failure_keeps_original_and_cleans_temporary_file() {
        let fixture = Fixture::new("replacement-failure");
        let original = b"---\ntype: Note\n---\nOriginal\n";
        fixture.write("note", original);
        let input = confirmed(&fixture, "note", "sam");
        let error = apply_with_failure(fixture.path(), &input, true).expect_err("injected failure");
        assert_eq!(error.code, ReviewProblemCode::WriteFailed);
        assert_eq!(
            fs::read(fixture.path().join("note.md")).expect("original"),
            original
        );
        assert!(fs::read_dir(fixture.path())
            .expect("directory")
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().contains(".okf-review-")));
    }

    #[test]
    fn invalid_identifiers_and_reviewers_are_refused() {
        assert!(concept_relative_path("../outside").is_err());
        assert!(concept_relative_path("index").is_err());
        let fixture = Fixture::new("invalid-reviewer");
        fixture.write("note", b"---\ntype: Note\n---\n");
        let result =
            preflight(fixture.path(), "note", Some("bad id!")).expect("unavailable result");
        assert!(!result.available);
        assert_eq!(result.reason_code, Some(ReviewProblemCode::InvalidReviewer));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_even_when_it_points_inside_the_bundle() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new("symlink");
        fixture.write("real", b"---\ntype: Note\n---\n");
        symlink(
            fixture.path().join("real.md"),
            fixture.path().join("link.md"),
        )
        .expect("symlink");
        let error = preflight(fixture.path(), "link", Some("sam")).expect_err("symlink refused");
        assert_eq!(error.code, ReviewProblemCode::InvalidPath);
    }
}
