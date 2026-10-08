//! Application-owned contract and trusted validation for evidence-bound quizzes.
//!
//! Provider transport is deliberately absent. A future adapter may carry the
//! request and raw response, but only this module may promote provider output to
//! a playable quiz.

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::OnceLock;

pub const QUIZ_TASK_ID: &str = "okf-quiz";
pub const QUIZ_SCHEMA_VERSION: u32 = 1;

const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_EVIDENCE_SOURCES: usize = 64;
const MAX_SOURCE_MARKDOWN_BYTES: usize = 256 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES: usize = 1024 * 1024;
const MAX_REQUEST_ID_CHARS: usize = 128;
const MAX_FINGERPRINT_CHARS: usize = 128;
const MAX_SOURCE_ID_CHARS: usize = 128;
const MAX_CONCEPT_ID_CHARS: usize = 512;
const MAX_PATH_CHARS: usize = 1024;
const MAX_TITLE_CHARS: usize = 256;
const MAX_TYPE_CHARS: usize = 128;
const MAX_TOPIC_CHARS: usize = 512;
const MAX_REVISION_ID_CHARS: usize = 256;
const MAX_QUESTIONS: usize = 20;
const MAX_VALIDATION_ISSUES: usize = 32;
const MAX_DIAGNOSTIC_CHARS: usize = 512;

const PACK_MANIFEST: &str = include_str!("../../.codex/skills/okf-quiz/pack.json");
const TASK_DEFINITION: &str = include_str!("../../.codex/skills/okf-quiz/task.json");
const QUIZ_SKILL: &str = include_str!("../../.codex/skills/okf-quiz/SKILL.md");
const OKF_CONSUMER_SKILL: &str = include_str!("../../.codex/skills/okf-consumer/SKILL.md");
const OKF_CONSUMER_VERSIONS: &str =
    include_str!("../../.codex/skills/okf-consumer/references/versions.md");
const QUIZ_SCHEMA: &str =
    include_str!("../../.codex/skills/okf-quiz/schemas/okf-quiz-v1.schema.json");
const VALID_EXAMPLE: &str = include_str!("../../.codex/skills/okf-quiz/examples/valid-quiz.json");
const INSUFFICIENT_EXAMPLE: &str =
    include_str!("../../.codex/skills/okf-quiz/examples/insufficient-evidence.json");
const INVALID_AMBIGUOUS_EXAMPLE: &str =
    include_str!("../../.codex/skills/okf-quiz/examples/invalid-ambiguous-question.json");

pub fn skill_contents() -> &'static str {
    QUIZ_SKILL
}

pub fn schema_contents() -> &'static str {
    QUIZ_SCHEMA
}

/// Returns the structured-output subset sent to model providers.
///
/// The canonical schema intentionally keeps conditional and uniqueness rules
/// that the trusted validator enforces. OpenAI Structured Outputs rejects
/// those JSON Schema keywords, so provider transport uses this compatible
/// projection and the canonical validator remains the final authority.
pub fn provider_schema_contents() -> &'static str {
    static PROVIDER_SCHEMA: OnceLock<String> = OnceLock::new();
    PROVIDER_SCHEMA.get_or_init(|| {
        let mut schema: Value = serde_json::from_str(QUIZ_SCHEMA)
            .expect("the application-packaged quiz schema must be valid JSON");
        remove_provider_unsupported_schema_keywords(&mut schema);
        serde_json::to_string_pretty(&schema)
            .expect("the provider quiz schema projection must serialize")
    })
}

fn remove_provider_unsupported_schema_keywords(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for keyword in [
                "$schema",
                "$id",
                "allOf",
                "not",
                "dependentRequired",
                "dependentSchemas",
                "if",
                "then",
                "else",
                "uniqueItems",
            ] {
                object.remove(keyword);
            }
            for child in object.values_mut() {
                remove_provider_unsupported_schema_keywords(child);
            }
        }
        Value::Array(values) => {
            for child in values {
                remove_provider_unsupported_schema_keywords(child);
            }
        }
        _ => {}
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizNetworkPolicy {
    ProviderTransportOnly,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizTaskDefinition {
    pub schema_version: u32,
    pub id: String,
    pub title: String,
    pub capability_id: String,
    pub skill_resource_id: String,
    pub artifact_schema_id: String,
    pub read_only: bool,
    pub provider_independent: bool,
    pub uses_frozen_evidence_packet: bool,
    pub allows_bundle_changes: bool,
    pub allows_settings_mutation: bool,
    pub allowed_tools: Vec<String>,
    pub network_policy: QuizNetworkPolicy,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuizCapabilityResource {
    pub id: String,
    pub path: String,
    pub media_type: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuizCapabilityRegistration {
    pub schema_version: u32,
    pub pack_id: String,
    pub pack_version: String,
    pub name: String,
    pub publisher: String,
    pub provenance: String,
    pub manifest_sha256: String,
    pub task: QuizTaskDefinition,
    pub resources: Vec<QuizCapabilityResource>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityPackManifest {
    schema_version: u32,
    id: String,
    version: String,
    name: String,
    description: String,
    publisher: String,
    provenance: String,
    compatibility: CapabilityCompatibility,
    task: PackTaskResource,
    resources: Vec<PackResource>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityCompatibility {
    task_schema_version: u32,
    artifact_schema_version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackTaskResource {
    path: String,
    media_type: String,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackResource {
    id: String,
    path: String,
    media_type: String,
    sha256: String,
}

pub fn capability_registration() -> Result<QuizCapabilityRegistration, String> {
    let pack: CapabilityPackManifest = serde_json::from_str(PACK_MANIFEST)
        .map_err(|error| format!("Quiz capability pack JSON is invalid: {error}"))?;
    let task: QuizTaskDefinition = serde_json::from_str(TASK_DEFINITION)
        .map_err(|error| format!("Quiz task JSON is invalid: {error}"))?;
    validate_capability_pack(&pack, &task)?;
    Ok(QuizCapabilityRegistration {
        schema_version: pack.schema_version,
        pack_id: pack.id,
        pack_version: pack.version,
        name: pack.name,
        publisher: pack.publisher,
        provenance: pack.provenance,
        manifest_sha256: resource_sha256(PACK_MANIFEST),
        task,
        resources: pack
            .resources
            .into_iter()
            .map(|resource| QuizCapabilityResource {
                id: resource.id,
                path: resource.path,
                media_type: resource.media_type,
                sha256: resource.sha256,
            })
            .collect(),
    })
}

fn validate_capability_pack(
    pack: &CapabilityPackManifest,
    task: &QuizTaskDefinition,
) -> Result<(), String> {
    // The v1 pack publisher is a fixed compatibility identifier, independent
    // of the application's current display name.
    if pack.schema_version != 1
        || pack.id != QUIZ_TASK_ID
        || pack.version != "1.0.0"
        || pack.name.trim().is_empty()
        || pack.description.trim().is_empty()
        || pack.publisher != "OKF Review"
        || pack.provenance != "built-in"
        || pack.compatibility.task_schema_version != 1
        || pack.compatibility.artifact_schema_version != QUIZ_SCHEMA_VERSION
    {
        return Err("Quiz capability pack metadata is incompatible.".to_string());
    }
    if pack.task.path != "task.json"
        || pack.task.media_type != "application/json"
        || pack.task.sha256 != resource_sha256(TASK_DEFINITION)
    {
        return Err("Quiz capability pack task resource changed.".to_string());
    }
    validate_task_definition(task)?;

    let expected = BTreeMap::from([
        (
            "okf-consumer-instructions",
            (
                "../okf-consumer/SKILL.md",
                "text/markdown",
                OKF_CONSUMER_SKILL,
            ),
        ),
        (
            "okf-consumer-versions",
            (
                "../okf-consumer/references/versions.md",
                "text/markdown",
                OKF_CONSUMER_VERSIONS,
            ),
        ),
        (
            "okf-quiz-example-insufficient-evidence",
            (
                "examples/insufficient-evidence.json",
                "application/json",
                INSUFFICIENT_EXAMPLE,
            ),
        ),
        (
            "okf-quiz-example-invalid-ambiguous-question",
            (
                "examples/invalid-ambiguous-question.json",
                "application/json",
                INVALID_AMBIGUOUS_EXAMPLE,
            ),
        ),
        (
            "okf-quiz-example-valid",
            (
                "examples/valid-quiz.json",
                "application/json",
                VALID_EXAMPLE,
            ),
        ),
        (
            "okf-quiz-instructions",
            ("SKILL.md", "text/markdown", QUIZ_SKILL),
        ),
        (
            "okf-quiz-v1",
            (
                "schemas/okf-quiz-v1.schema.json",
                "application/schema+json",
                QUIZ_SCHEMA,
            ),
        ),
    ]);
    if pack.resources.len() != expected.len() {
        return Err("Quiz capability pack has an unexpected resource set.".to_string());
    }
    let mut seen = BTreeSet::new();
    for resource in &pack.resources {
        if !seen.insert(resource.id.as_str()) {
            return Err(format!(
                "Quiz capability resource {} is duplicated.",
                resource.id
            ));
        }
        let Some((path, media_type, contents)) = expected.get(resource.id.as_str()) else {
            return Err(format!(
                "Quiz capability resource {} is unknown.",
                resource.id
            ));
        };
        if resource.path != *path
            || resource.media_type != *media_type
            || resource.sha256 != resource_sha256(contents)
        {
            return Err(format!("Quiz capability resource {} changed.", resource.id));
        }
    }
    Ok(())
}

fn validate_task_definition(task: &QuizTaskDefinition) -> Result<(), String> {
    if task.schema_version != 1
        || task.id != QUIZ_TASK_ID
        || task.capability_id != QUIZ_TASK_ID
        || task.skill_resource_id != "okf-quiz-instructions"
        || task.artifact_schema_id != "okf-quiz-v1"
        || !task.read_only
        || !task.provider_independent
        || !task.uses_frozen_evidence_packet
        || task.allows_bundle_changes
        || task.allows_settings_mutation
        || task.allowed_tools != ["repository-read", "git-read"]
        || task.network_policy != QuizNetworkPolicy::ProviderTransportOnly
    {
        return Err("Quiz task definition violates its read-only contract.".to_string());
    }
    Ok(())
}

fn resource_sha256(contents: &str) -> String {
    let normalized = normalize_line_endings(contents);
    format!("{:x}", Sha256::digest(normalized.as_bytes()))
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizScopeMode {
    CurrentDocument,
    SelectedDocuments,
    Topic,
    BundleDiff,
    ReviewedSinceCommit,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizDifficulty {
    Foundational,
    Applied,
    Challenging,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizQuestionCountPolicy {
    Automatic,
    #[default]
    Exact,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum QuizEvidenceVersion {
    Current,
    Base,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizEvidenceSource {
    pub source_id: String,
    pub concept_id: String,
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub concept_type: String,
    pub version: QuizEvidenceVersion,
    pub content_hash: String,
    pub markdown: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizGenerationRequest {
    pub request_id: String,
    pub bundle_fingerprint: String,
    pub scope_fingerprint: String,
    pub scope_mode: QuizScopeMode,
    #[serde(default)]
    pub question_count_policy: QuizQuestionCountPolicy,
    pub requested_question_count: usize,
    pub requested_difficulty: Option<QuizDifficulty>,
    pub evidence_sources: Vec<QuizEvidenceSource>,
    pub scope_source_ids: Vec<String>,
    pub topic: Option<String>,
    pub base_revision_id: Option<String>,
    pub head_revision_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizArtifactStatus {
    Ready,
    InsufficientEvidence,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizQuestionCategory {
    Decision,
    Assumption,
    Constraint,
    Architecture,
    Behaviour,
    FailureMode,
    Change,
    Fact,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizCriticality {
    Critical,
    Important,
    Supporting,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizChoice {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizEvidenceReference {
    pub source_id: String,
    pub heading: String,
    pub quote: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizQuestion {
    pub id: String,
    pub category: QuizQuestionCategory,
    pub criticality: QuizCriticality,
    pub learning_objective: String,
    pub prompt: String,
    pub choices: Vec<QuizChoice>,
    pub correct_choice_id: String,
    pub explanation: String,
    pub evidence: Vec<QuizEvidenceReference>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizArtifact {
    pub schema_version: u32,
    pub request_id: String,
    pub bundle_fingerprint: String,
    pub scope_fingerprint: String,
    pub status: QuizArtifactStatus,
    pub title: String,
    pub questions: Vec<QuizQuestion>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizValidationInput {
    pub request: QuizGenerationRequest,
    pub current_state: QuizObservedState,
    pub raw_output: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizObservedSource {
    pub source_id: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizObservedState {
    pub bundle_fingerprint: String,
    pub scope_fingerprint: String,
    pub sources: Vec<QuizObservedSource>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizValidationIssueCode {
    InvalidRequest,
    OutputTooLarge,
    MalformedJson,
    DuplicateJsonKey,
    SchemaViolation,
    WrongRequestId,
    WrongBundleFingerprint,
    WrongScopeFingerprint,
    DuplicateQuestionId,
    DuplicateChoiceId,
    MissingCorrectChoice,
    DuplicateQuestionPrompt,
    DuplicateChoiceText,
    UnknownEvidenceSource,
    EvidenceOutsideScope,
    EvidenceQuoteNotFound,
    CriticalEvidenceMissing,
    ExcessiveQuestionCount,
    UnexpectedQuestionCount,
    StaleBundleFingerprint,
    StaleScopeFingerprint,
    StaleContentHash,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuizValidationIssue {
    pub code: QuizValidationIssueCode,
    pub message: String,
    pub question_id: Option<String>,
    pub source_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum QuizValidation {
    NoOutput,
    Invalid { issues: Vec<QuizValidationIssue> },
    Ready { quiz: Box<QuizArtifact> },
    InsufficientEvidence { result: Box<QuizArtifact> },
    Stale { issues: Vec<QuizValidationIssue> },
}

pub fn validate_output(input: &QuizValidationInput) -> QuizValidation {
    let Some(untrimmed_output) = input.raw_output.as_deref() else {
        return QuizValidation::NoOutput;
    };
    if untrimmed_output.len() > MAX_OUTPUT_BYTES {
        return invalid_issue(
            QuizValidationIssueCode::OutputTooLarge,
            "Quiz output exceeds the 256 KiB validation limit.",
        );
    }
    let raw_output = untrimmed_output.trim();
    if raw_output.is_empty() {
        return QuizValidation::NoOutput;
    }

    let validated_request = match validate_request(&input.request) {
        Ok(request) => request,
        Err(RequestValidation::Invalid(message)) => {
            return invalid_issue(QuizValidationIssueCode::InvalidRequest, &message);
        }
        Err(RequestValidation::Stale(message, source_id)) => {
            return QuizValidation::Stale {
                issues: vec![issue(
                    QuizValidationIssueCode::StaleContentHash,
                    &message,
                    None,
                    source_id,
                )],
            };
        }
    };
    if let Some(stale) = validate_current_state(&input.request, &input.current_state) {
        return stale;
    }

    let value = match serde_json::from_str::<UniqueJsonValue>(raw_output) {
        Ok(value) => value.0,
        Err(error) => {
            let message = error.to_string();
            let code = if message.contains("duplicate object key") {
                QuizValidationIssueCode::DuplicateJsonKey
            } else {
                QuizValidationIssueCode::MalformedJson
            };
            return invalid_issue(
                code,
                &format!("Quiz output is not one unambiguous JSON object: {message}"),
            );
        }
    };
    if !value.is_object() {
        return invalid_issue(
            QuizValidationIssueCode::SchemaViolation,
            "Quiz output must be a JSON object.",
        );
    }

    let schema_issues = validate_json_schema(&value);
    if !schema_issues.is_empty() {
        return QuizValidation::Invalid {
            issues: schema_issues,
        };
    }
    let artifact: QuizArtifact = match serde_json::from_value(value) {
        Ok(artifact) => artifact,
        Err(error) => {
            return invalid_issue(
                QuizValidationIssueCode::SchemaViolation,
                &format!("Quiz output does not match the typed contract: {error}"),
            );
        }
    };

    let mut issues = Vec::new();
    if artifact.request_id != input.request.request_id {
        issues.push(issue(
            QuizValidationIssueCode::WrongRequestId,
            "Quiz requestId does not match the generation request.",
            None,
            None,
        ));
    }
    if artifact.bundle_fingerprint != input.request.bundle_fingerprint {
        issues.push(issue(
            QuizValidationIssueCode::WrongBundleFingerprint,
            "Quiz bundleFingerprint does not match the generation request.",
            None,
            None,
        ));
    }
    if artifact.scope_fingerprint != input.request.scope_fingerprint {
        issues.push(issue(
            QuizValidationIssueCode::WrongScopeFingerprint,
            "Quiz scopeFingerprint does not match the generation request.",
            None,
            None,
        ));
    }
    if artifact.questions.len() > input.request.requested_question_count {
        issues.push(issue(
            QuizValidationIssueCode::ExcessiveQuestionCount,
            "Quiz contains more questions than the request allowed.",
            None,
            None,
        ));
    }
    if artifact.status == QuizArtifactStatus::Ready
        && input.request.question_count_policy == QuizQuestionCountPolicy::Exact
        && artifact.questions.len() != input.request.requested_question_count
    {
        issues.push(issue(
            QuizValidationIssueCode::UnexpectedQuestionCount,
            "Quiz does not contain the exact number of questions requested.",
            None,
            None,
        ));
    }
    validate_questions(&artifact, &validated_request, &mut issues);
    if !issues.is_empty() {
        issues.truncate(MAX_VALIDATION_ISSUES);
        return QuizValidation::Invalid { issues };
    }

    match artifact.status {
        QuizArtifactStatus::Ready => QuizValidation::Ready {
            quiz: Box::new(artifact),
        },
        QuizArtifactStatus::InsufficientEvidence => QuizValidation::InsufficientEvidence {
            result: Box::new(artifact),
        },
    }
}

fn validate_current_state(
    request: &QuizGenerationRequest,
    current: &QuizObservedState,
) -> Option<QuizValidation> {
    if current.bundle_fingerprint != request.bundle_fingerprint {
        return Some(QuizValidation::Stale {
            issues: vec![issue(
                QuizValidationIssueCode::StaleBundleFingerprint,
                "The bundle fingerprint changed after quiz generation started.",
                None,
                None,
            )],
        });
    }
    if current.scope_fingerprint != request.scope_fingerprint {
        return Some(QuizValidation::Stale {
            issues: vec![issue(
                QuizValidationIssueCode::StaleScopeFingerprint,
                "The accepted scope fingerprint changed after quiz generation started.",
                None,
                None,
            )],
        });
    }
    let mut observed = BTreeMap::new();
    for source in &current.sources {
        if !valid_sha256(&source.content_hash)
            || observed
                .insert(source.source_id.as_str(), source.content_hash.as_str())
                .is_some()
        {
            return Some(QuizValidation::Stale {
                issues: vec![issue(
                    QuizValidationIssueCode::StaleContentHash,
                    "Current source identity is missing, duplicated, or invalid.",
                    None,
                    Some(source.source_id.clone()),
                )],
            });
        }
    }
    for source in &request.evidence_sources {
        if observed.get(source.source_id.as_str()).copied() != Some(source.content_hash.as_str()) {
            return Some(QuizValidation::Stale {
                issues: vec![issue(
                    QuizValidationIssueCode::StaleContentHash,
                    "A source content hash changed after quiz generation started.",
                    None,
                    Some(source.source_id.clone()),
                )],
            });
        }
    }
    if observed.len() != request.evidence_sources.len() {
        return Some(QuizValidation::Stale {
            issues: vec![issue(
                QuizValidationIssueCode::StaleContentHash,
                "The current source set no longer matches the frozen evidence packet.",
                None,
                None,
            )],
        });
    }
    None
}

pub fn evidence_content_hash(markdown: &str) -> String {
    format!("sha256-{:x}", Sha256::digest(markdown.as_bytes()))
}

struct ValidatedRequest<'a> {
    sources: BTreeMap<&'a str, &'a QuizEvidenceSource>,
    scope_source_ids: BTreeSet<&'a str>,
}

enum RequestValidation {
    Invalid(String),
    Stale(String, Option<String>),
}

fn validate_request(
    request: &QuizGenerationRequest,
) -> Result<ValidatedRequest<'_>, RequestValidation> {
    validate_bounded_text("requestId", &request.request_id, MAX_REQUEST_ID_CHARS)?;
    validate_bounded_text(
        "bundleFingerprint",
        &request.bundle_fingerprint,
        MAX_FINGERPRINT_CHARS,
    )?;
    validate_bounded_text(
        "scopeFingerprint",
        &request.scope_fingerprint,
        MAX_FINGERPRINT_CHARS,
    )?;
    if !(1..=MAX_QUESTIONS).contains(&request.requested_question_count) {
        return Err(RequestValidation::Invalid(
            "requestedQuestionCount must be between 1 and 20.".to_string(),
        ));
    }
    if request.evidence_sources.is_empty() || request.evidence_sources.len() > MAX_EVIDENCE_SOURCES
    {
        return Err(RequestValidation::Invalid(
            "evidenceSources must contain between 1 and 64 sources.".to_string(),
        ));
    }
    if request.scope_source_ids.is_empty() || request.scope_source_ids.len() > MAX_EVIDENCE_SOURCES
    {
        return Err(RequestValidation::Invalid(
            "scopeSourceIds must contain between 1 and 64 source IDs.".to_string(),
        ));
    }
    validate_scope_fields(request)?;

    let mut sources = BTreeMap::new();
    let mut total_bytes = 0usize;
    for source in &request.evidence_sources {
        validate_ascii_identifier("sourceId", &source.source_id, MAX_SOURCE_ID_CHARS)?;
        validate_bounded_text("conceptId", &source.concept_id, MAX_CONCEPT_ID_CHARS)?;
        validate_bundle_path(&source.path)?;
        validate_bounded_text("evidence title", &source.title, MAX_TITLE_CHARS)?;
        validate_bounded_text("evidence type", &source.concept_type, MAX_TYPE_CHARS)?;
        if source.markdown.is_empty()
            || source.markdown.len() > MAX_SOURCE_MARKDOWN_BYTES
            || source.markdown.chars().any(|character| character == '\0')
        {
            return Err(RequestValidation::Invalid(format!(
                "Evidence source {} has invalid or oversized Markdown.",
                source.source_id
            )));
        }
        total_bytes = total_bytes.saturating_add(source.markdown.len());
        if total_bytes > MAX_TOTAL_EVIDENCE_BYTES {
            return Err(RequestValidation::Invalid(
                "The frozen evidence packet exceeds 1 MiB.".to_string(),
            ));
        }
        if !valid_sha256(&source.content_hash) {
            return Err(RequestValidation::Invalid(format!(
                "Evidence source {} has an invalid contentHash.",
                source.source_id
            )));
        }
        let observed_hash = evidence_content_hash(&source.markdown);
        if source.content_hash != observed_hash {
            return Err(RequestValidation::Stale(
                format!(
                    "Evidence source {} no longer matches its generation-request contentHash.",
                    source.source_id
                ),
                Some(source.source_id.clone()),
            ));
        }
        if sources.insert(source.source_id.as_str(), source).is_some() {
            return Err(RequestValidation::Invalid(format!(
                "Evidence source ID {} is duplicated.",
                source.source_id
            )));
        }
    }

    let mut scope_source_ids = BTreeSet::new();
    for source_id in &request.scope_source_ids {
        validate_ascii_identifier("scope source ID", source_id, MAX_SOURCE_ID_CHARS)?;
        if !scope_source_ids.insert(source_id.as_str()) {
            return Err(RequestValidation::Invalid(format!(
                "Scope source ID {source_id} is duplicated."
            )));
        }
        if !sources.contains_key(source_id.as_str()) {
            return Err(RequestValidation::Invalid(format!(
                "Scope source ID {source_id} is absent from evidenceSources."
            )));
        }
    }
    let accepted_versions = scope_source_ids
        .iter()
        .filter_map(|source_id| sources.get(source_id).map(|source| source.version))
        .collect::<BTreeSet<_>>();
    if request.scope_mode == QuizScopeMode::BundleDiff {
        if !accepted_versions.contains(&QuizEvidenceVersion::Base)
            || !accepted_versions.contains(&QuizEvidenceVersion::Current)
        {
            return Err(RequestValidation::Invalid(
                "bundle-diff scope requires accepted base and current evidence.".to_string(),
            ));
        }
    } else if accepted_versions.contains(&QuizEvidenceVersion::Base) {
        return Err(RequestValidation::Invalid(
            "Base evidence is allowed only for bundle-diff scope.".to_string(),
        ));
    }
    Ok(ValidatedRequest {
        sources,
        scope_source_ids,
    })
}

fn validate_scope_fields(request: &QuizGenerationRequest) -> Result<(), RequestValidation> {
    if let Some(topic) = &request.topic {
        validate_bounded_text("topic", topic, MAX_TOPIC_CHARS)?;
    }
    for (name, revision) in [
        ("baseRevisionId", request.base_revision_id.as_deref()),
        ("headRevisionId", request.head_revision_id.as_deref()),
    ] {
        if let Some(revision) = revision {
            validate_bounded_text(name, revision, MAX_REVISION_ID_CHARS)?;
        }
    }
    match request.scope_mode {
        QuizScopeMode::CurrentDocument => {
            if request.scope_source_ids.len() != 1 {
                return Err(RequestValidation::Invalid(
                    "current-document scope requires exactly one scope source.".to_string(),
                ));
            }
            if request.base_revision_id.is_some() || request.head_revision_id.is_some() {
                return Err(RequestValidation::Invalid(
                    "Revision IDs are allowed only for bundle-diff scope.".to_string(),
                ));
            }
        }
        QuizScopeMode::Topic => {
            if request.topic.is_none() {
                return Err(RequestValidation::Invalid(
                    "topic scope requires a topic.".to_string(),
                ));
            }
            if request.base_revision_id.is_some() || request.head_revision_id.is_some() {
                return Err(RequestValidation::Invalid(
                    "Revision IDs are allowed only for bundle-diff scope.".to_string(),
                ));
            }
        }
        QuizScopeMode::BundleDiff => {
            if request.base_revision_id.is_none() || request.head_revision_id.is_none() {
                return Err(RequestValidation::Invalid(
                    "bundle-diff scope requires base and head revision IDs.".to_string(),
                ));
            }
        }
        QuizScopeMode::ReviewedSinceCommit => {
            if request.topic.is_some()
                || request.base_revision_id.is_none()
                || request.head_revision_id.as_deref() != Some("WORKTREE")
            {
                return Err(RequestValidation::Invalid(
                    "reviewed-since-commit scope requires a base commit and WORKTREE revision ID."
                        .to_string(),
                ));
            }
        }
        QuizScopeMode::SelectedDocuments => {
            if request.base_revision_id.is_some() || request.head_revision_id.is_some() {
                return Err(RequestValidation::Invalid(
                    "Revision IDs are allowed only for bundle-diff scope.".to_string(),
                ));
            }
        }
    }
    Ok(())
}

impl From<String> for RequestValidation {
    fn from(message: String) -> Self {
        Self::Invalid(message)
    }
}

fn validate_bounded_text(name: &str, value: &str, maximum: usize) -> Result<(), RequestValidation> {
    if value.trim().is_empty()
        || value.chars().count() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(RequestValidation::Invalid(format!(
            "{name} must be non-empty, control-free, and at most {maximum} characters."
        )));
    }
    Ok(())
}

fn validate_ascii_identifier(
    name: &str,
    value: &str,
    maximum: usize,
) -> Result<(), RequestValidation> {
    if value.is_empty()
        || value.len() > maximum
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic()
                || (index > 0 && (byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')))
        })
    {
        return Err(RequestValidation::Invalid(format!(
            "{name} is not a valid bounded identifier."
        )));
    }
    Ok(())
}

fn validate_bundle_path(path: &str) -> Result<(), RequestValidation> {
    if path.trim().is_empty()
        || path.chars().count() > MAX_PATH_CHARS
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || !path.ends_with(".md")
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
        || path.chars().any(char::is_control)
    {
        return Err(RequestValidation::Invalid(
            "Evidence paths must be safe bundle-relative Markdown paths.".to_string(),
        ));
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256-")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_questions(
    artifact: &QuizArtifact,
    request: &ValidatedRequest<'_>,
    issues: &mut Vec<QuizValidationIssue>,
) {
    let mut question_ids = BTreeSet::new();
    let mut prompts = BTreeSet::new();
    for question in &artifact.questions {
        if !question_ids.insert(question.id.as_str()) {
            issues.push(issue(
                QuizValidationIssueCode::DuplicateQuestionId,
                "Question IDs must be unique.",
                Some(question.id.clone()),
                None,
            ));
        }
        if !prompts.insert(normalize_comparison(&question.prompt)) {
            issues.push(issue(
                QuizValidationIssueCode::DuplicateQuestionPrompt,
                "Question prompts must be unique after case and whitespace normalization.",
                Some(question.id.clone()),
                None,
            ));
        }

        let mut choice_ids = BTreeSet::new();
        let mut choice_text = BTreeSet::new();
        for choice in &question.choices {
            if !choice_ids.insert(choice.id.as_str()) {
                issues.push(issue(
                    QuizValidationIssueCode::DuplicateChoiceId,
                    "Choice IDs must be unique within a question.",
                    Some(question.id.clone()),
                    None,
                ));
            }
            if !choice_text.insert(normalize_comparison(&choice.text)) {
                issues.push(issue(
                    QuizValidationIssueCode::DuplicateChoiceText,
                    "Choice text must be unique after case and whitespace normalization.",
                    Some(question.id.clone()),
                    None,
                ));
            }
        }
        if question
            .choices
            .iter()
            .filter(|choice| choice.id == question.correct_choice_id)
            .count()
            != 1
        {
            issues.push(issue(
                QuizValidationIssueCode::MissingCorrectChoice,
                "correctChoiceId must identify exactly one existing choice.",
                Some(question.id.clone()),
                None,
            ));
        }

        let mut direct_evidence = false;
        for evidence in &question.evidence {
            let Some(source) = request.sources.get(evidence.source_id.as_str()) else {
                issues.push(issue(
                    QuizValidationIssueCode::UnknownEvidenceSource,
                    "Evidence references an unknown frozen source.",
                    Some(question.id.clone()),
                    Some(evidence.source_id.clone()),
                ));
                continue;
            };
            if !request
                .scope_source_ids
                .contains(evidence.source_id.as_str())
            {
                issues.push(issue(
                    QuizValidationIssueCode::EvidenceOutsideScope,
                    "Evidence references a source outside the accepted scope.",
                    Some(question.id.clone()),
                    Some(evidence.source_id.clone()),
                ));
                continue;
            }
            let normalized_source = normalize_line_endings(&source.markdown);
            let normalized_quote = normalize_line_endings(&evidence.quote);
            if !normalized_source.contains(normalized_quote.as_ref()) {
                issues.push(issue(
                    QuizValidationIssueCode::EvidenceQuoteNotFound,
                    "Evidence quote does not occur in its declared source after line-ending normalization.",
                    Some(question.id.clone()),
                    Some(evidence.source_id.clone()),
                ));
                continue;
            }
            direct_evidence = true;
        }
        if question.criticality == QuizCriticality::Critical && !direct_evidence {
            issues.push(issue(
                QuizValidationIssueCode::CriticalEvidenceMissing,
                "Critical questions require direct evidence from the accepted bundle scope.",
                Some(question.id.clone()),
                None,
            ));
        }
    }
}

fn normalize_comparison(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn normalize_line_endings(value: &str) -> std::borrow::Cow<'_, str> {
    if !value.contains('\r') {
        return std::borrow::Cow::Borrowed(value);
    }
    std::borrow::Cow::Owned(value.replace("\r\n", "\n").replace('\r', "\n"))
}

fn invalid_issue(code: QuizValidationIssueCode, message: &str) -> QuizValidation {
    QuizValidation::Invalid {
        issues: vec![issue(code, message, None, None)],
    }
}

fn issue(
    code: QuizValidationIssueCode,
    message: &str,
    question_id: Option<String>,
    source_id: Option<String>,
) -> QuizValidationIssue {
    QuizValidationIssue {
        code,
        message: bounded_diagnostic(message),
        question_id,
        source_id,
    }
}

fn bounded_diagnostic(message: &str) -> String {
    message
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_DIAGNOSTIC_CHARS)
        .collect()
}

fn schema_value() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(QUIZ_SCHEMA)
            .expect("the application-packaged quiz schema must be valid JSON")
    })
}

fn schema_validator() -> &'static jsonschema::Validator {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    VALIDATOR.get_or_init(|| {
        jsonschema::draft202012::new(schema_value())
            .expect("the application-packaged quiz schema must compile")
    })
}

fn validate_json_schema(value: &Value) -> Vec<QuizValidationIssue> {
    schema_validator()
        .iter_errors(value)
        .take(MAX_VALIDATION_ISSUES)
        .map(|error| {
            issue(
                QuizValidationIssueCode::SchemaViolation,
                &format!(
                    "Quiz schema violation at {}: {error}",
                    error.instance_path()
                ),
                None,
                None,
            )
        })
        .collect()
}

struct UniqueJsonValue(Value);

impl<'de> Deserialize<'de> for UniqueJsonValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(UniqueJsonVisitor).map(Self)
    }
}

struct UniqueJsonVisitor;

impl<'de> Visitor<'de> for UniqueJsonVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object keys")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("JSON number is not finite"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(Value::String(value.to_string()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(Value::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        UniqueJsonValue::deserialize(deserializer).map(|value| value.0)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<UniqueJsonValue>()? {
            values.push(value.0);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        while let Some(key) = object.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom(format!("duplicate object key `{key}`")));
            }
            let value = object.next_value::<UniqueJsonValue>()?;
            values.insert(key, value.0);
        }
        Ok(Value::Object(values))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SOURCE_MARKDOWN: &str = "# Evidence boundary\n\nProviders receive a frozen evidence packet rather than unrestricted access to the project repository.\n\n## Formatting\n\nEvidence can preserve **trusted** [scope](docs/scope.md) and `exact code` punctuation.\n\n## Lines\n\nFirst line.\nSecond line.\n\n## International\n\nUnicode evidence: naïve façade — 東京.\n";

    fn request() -> QuizGenerationRequest {
        let sources = vec![
            QuizEvidenceSource {
                source_id: "source-1".to_string(),
                concept_id: "architecture/quiz-generation".to_string(),
                path: "architecture/quiz-generation.md".to_string(),
                title: "Quiz Generation".to_string(),
                concept_type: "Architecture Decision".to_string(),
                version: QuizEvidenceVersion::Current,
                content_hash: evidence_content_hash(SOURCE_MARKDOWN),
                markdown: SOURCE_MARKDOWN.to_string(),
            },
            QuizEvidenceSource {
                source_id: "source-2".to_string(),
                concept_id: "features/unselected".to_string(),
                path: "features/unselected.md".to_string(),
                title: "Unselected evidence".to_string(),
                concept_type: "Feature".to_string(),
                version: QuizEvidenceVersion::Current,
                content_hash: evidence_content_hash("# Outside\nNot selected.\n"),
                markdown: "# Outside\nNot selected.\n".to_string(),
            },
        ];
        QuizGenerationRequest {
            request_id: "request-example-001".to_string(),
            bundle_fingerprint: "bundle-fingerprint-001".to_string(),
            scope_fingerprint: "scope-fingerprint-001".to_string(),
            scope_mode: QuizScopeMode::SelectedDocuments,
            question_count_policy: QuizQuestionCountPolicy::Exact,
            requested_question_count: 1,
            requested_difficulty: Some(QuizDifficulty::Challenging),
            evidence_sources: sources,
            scope_source_ids: vec!["source-1".to_string()],
            topic: None,
            base_revision_id: None,
            head_revision_id: None,
        }
    }

    fn validate(request: QuizGenerationRequest, raw_output: impl Into<String>) -> QuizValidation {
        let current_state = observed_state(&request);
        validate_output(&QuizValidationInput {
            request,
            current_state,
            raw_output: Some(raw_output.into()),
        })
    }

    fn observed_state(request: &QuizGenerationRequest) -> QuizObservedState {
        QuizObservedState {
            bundle_fingerprint: request.bundle_fingerprint.clone(),
            scope_fingerprint: request.scope_fingerprint.clone(),
            sources: request
                .evidence_sources
                .iter()
                .map(|source| QuizObservedSource {
                    source_id: source.source_id.clone(),
                    content_hash: source.content_hash.clone(),
                })
                .collect(),
        }
    }

    fn valid_value() -> Value {
        serde_json::from_str(VALID_EXAMPLE).expect("valid example JSON")
    }

    fn assert_invalid(result: QuizValidation, expected: QuizValidationIssueCode) {
        let QuizValidation::Invalid { issues } = result else {
            panic!("expected invalid quiz, got {result:?}");
        };
        assert!(
            issues.iter().any(|issue| issue.code == expected),
            "expected {expected:?}, got {issues:?}"
        );
    }

    fn assert_schema_invalid(value: Value) {
        assert_invalid(
            validate(
                request(),
                serde_json::to_string(&value).expect("fixture JSON"),
            ),
            QuizValidationIssueCode::SchemaViolation,
        );
    }

    #[test]
    fn registers_one_read_only_provider_neutral_task_and_digest_bound_resources() {
        let registration = capability_registration().expect("capability pack");
        assert_eq!(registration.pack_id, QUIZ_TASK_ID);
        assert_eq!(registration.task.id, QUIZ_TASK_ID);
        assert!(registration.task.read_only);
        assert!(registration.task.provider_independent);
        assert!(registration.task.uses_frozen_evidence_packet);
        assert!(!registration.task.allows_bundle_changes);
        assert!(!registration.task.allows_settings_mutation);
        assert_eq!(
            registration.task.allowed_tools,
            ["repository-read", "git-read"]
        );
        assert_eq!(
            registration.task.network_policy,
            QuizNetworkPolicy::ProviderTransportOnly
        );
        assert_eq!(registration.resources.len(), 7);
        assert!(registration
            .resources
            .iter()
            .all(|resource| resource.sha256.len() == 64));
    }

    #[test]
    fn reviewed_since_commit_requires_current_evidence_and_captured_revisions() {
        let mut reviewed = request();
        reviewed.scope_mode = QuizScopeMode::ReviewedSinceCommit;
        reviewed.base_revision_id = Some("0123456789abcdef".to_string());
        reviewed.head_revision_id = Some("WORKTREE".to_string());
        assert!(validate_request(&reviewed).is_ok());

        reviewed.head_revision_id = None;
        assert!(validate_request(&reviewed).is_err());
        reviewed.head_revision_id = Some("WORKTREE".to_string());
        reviewed.evidence_sources[0].version = QuizEvidenceVersion::Base;
        assert!(validate_request(&reviewed).is_err());
    }

    #[test]
    fn quiz_skill_requires_unbiased_correct_choice_positions() {
        assert!(QUIZ_SKILL
            .contains("Randomize the correct choice's placement independently for each question."));
        assert!(QUIZ_SKILL.contains("set `correctChoiceId`"));
        assert!(QUIZ_SKILL.contains("reshuffle if every correct answer occupies the same position"));
    }

    #[test]
    fn canonical_schema_is_draft_2020_12_and_matches_rust_enums() {
        jsonschema::draft202012::meta::validate(schema_value()).expect("valid canonical schema");
        let schema_statuses = schema_value()["properties"]["status"]["enum"]
            .as_array()
            .expect("status enum");
        let rust_statuses = [
            QuizArtifactStatus::Ready,
            QuizArtifactStatus::InsufficientEvidence,
        ]
        .map(|status| serde_json::to_value(status).expect("serialize status"));
        assert_eq!(schema_statuses, rust_statuses.as_slice());

        let schema_categories = schema_value()["$defs"]["question"]["properties"]["category"]
            ["enum"]
            .as_array()
            .expect("category enum");
        let rust_categories = [
            QuizQuestionCategory::Decision,
            QuizQuestionCategory::Assumption,
            QuizQuestionCategory::Constraint,
            QuizQuestionCategory::Architecture,
            QuizQuestionCategory::Behaviour,
            QuizQuestionCategory::FailureMode,
            QuizQuestionCategory::Change,
            QuizQuestionCategory::Fact,
        ]
        .map(|category| serde_json::to_value(category).expect("serialize category"));
        assert_eq!(schema_categories, rust_categories.as_slice());

        let schema_criticalities = schema_value()["$defs"]["question"]["properties"]["criticality"]
            ["enum"]
            .as_array()
            .expect("criticality enum");
        let rust_criticalities = [
            QuizCriticality::Critical,
            QuizCriticality::Important,
            QuizCriticality::Supporting,
        ]
        .map(|criticality| serde_json::to_value(criticality).expect("serialize criticality"));
        assert_eq!(schema_criticalities, rust_criticalities.as_slice());
    }

    #[test]
    fn provider_schema_preserves_shape_without_unsupported_keywords() {
        let provider_schema: Value =
            serde_json::from_str(provider_schema_contents()).expect("provider schema JSON");
        let encoded = serde_json::to_string(&provider_schema).expect("provider schema encoding");
        for keyword in [
            "\"$schema\"",
            "\"$id\"",
            "\"allOf\"",
            "\"uniqueItems\"",
            "\"if\"",
            "\"then\"",
            "\"else\"",
        ] {
            assert!(
                !encoded.contains(keyword),
                "provider schema retained {keyword}"
            );
        }
        assert_eq!(provider_schema["type"], "object");
        assert_eq!(
            provider_schema["properties"]["schemaVersion"]["type"], "integer",
            "constant fields need an explicit type for Codex structured output"
        );
        assert_eq!(
            provider_schema["properties"]["status"]["type"], "string",
            "enum fields need an explicit type for Codex structured output"
        );
        assert_eq!(
            provider_schema["$defs"]["question"]["properties"]["category"]["type"],
            "string"
        );
        assert_eq!(
            provider_schema["$defs"]["question"]["properties"]["criticality"]["type"],
            "string"
        );
        assert_eq!(
            provider_schema["required"],
            schema_value()["required"],
            "provider transport must require the same artifact fields"
        );
        assert_eq!(
            provider_schema["properties"]["status"],
            schema_value()["properties"]["status"]
        );
        assert_eq!(
            provider_schema["$defs"]["question"]["required"],
            schema_value()["$defs"]["question"]["required"]
        );
    }

    #[test]
    fn accepts_valid_and_insufficient_evidence_fixtures() {
        let QuizValidation::Ready { quiz } = validate(request(), VALID_EXAMPLE) else {
            panic!("valid fixture should be playable");
        };
        assert_eq!(quiz.questions.len(), 1);
        assert_eq!(quiz.questions[0].correct_choice_id, "C");

        let QuizValidation::InsufficientEvidence { result } =
            validate(request(), INSUFFICIENT_EXAMPLE)
        else {
            panic!("insufficient fixture should be accepted but non-playable");
        };
        assert!(result.questions.is_empty());
        assert!(!result.warnings.is_empty());

        assert_invalid(
            validate(request(), INVALID_AMBIGUOUS_EXAMPLE),
            QuizValidationIssueCode::DuplicateChoiceText,
        );
    }

    #[test]
    fn automatic_count_accepts_a_bounded_provider_choice_but_manual_is_exact() {
        let mut automatic = request();
        automatic.question_count_policy = QuizQuestionCountPolicy::Automatic;
        automatic.requested_question_count = MAX_QUESTIONS;
        automatic.requested_difficulty = None;
        assert!(matches!(
            validate(automatic.clone(), VALID_EXAMPLE),
            QuizValidation::Ready { .. }
        ));

        let mut upper_bound = valid_value();
        let template = upper_bound["questions"][0].clone();
        let questions = upper_bound["questions"].as_array_mut().expect("questions");
        for index in 2..=MAX_QUESTIONS {
            let mut question = template.clone();
            question["id"] = json!(format!("Q{index}"));
            question["prompt"] = json!(format!("Unique bounded prompt {index}?"));
            questions.push(question);
        }
        assert!(matches!(
            validate(
                automatic,
                serde_json::to_string(&upper_bound).expect("fixture JSON")
            ),
            QuizValidation::Ready { .. }
        ));

        let mut manual = request();
        manual.requested_question_count = 2;
        assert_invalid(
            validate(manual, VALID_EXAMPLE),
            QuizValidationIssueCode::UnexpectedQuestionCount,
        );
    }

    #[test]
    fn distinguishes_no_output_malformed_json_and_oversized_output() {
        assert_eq!(
            validate_output(&QuizValidationInput {
                request: request(),
                current_state: observed_state(&request()),
                raw_output: None,
            }),
            QuizValidation::NoOutput
        );
        assert_invalid(
            validate(request(), "{not-json"),
            QuizValidationIssueCode::MalformedJson,
        );
        assert_invalid(
            validate(request(), "x".repeat(MAX_OUTPUT_BYTES + 1)),
            QuizValidationIssueCode::OutputTooLarge,
        );
    }

    #[test]
    fn rejects_unknown_fields_and_wrong_schema_version() {
        let mut unknown = valid_value();
        unknown["provider"] = json!("should-not-cross");
        assert_schema_invalid(unknown);

        let mut wrong_version = valid_value();
        wrong_version["schemaVersion"] = json!(2);
        assert_schema_invalid(wrong_version);
    }

    #[test]
    fn rejects_wrong_request_bundle_and_scope_identity() {
        for (field, code) in [
            ("requestId", QuizValidationIssueCode::WrongRequestId),
            (
                "bundleFingerprint",
                QuizValidationIssueCode::WrongBundleFingerprint,
            ),
            (
                "scopeFingerprint",
                QuizValidationIssueCode::WrongScopeFingerprint,
            ),
        ] {
            let mut value = valid_value();
            value[field] = json!("wrong");
            assert_invalid(
                validate(
                    request(),
                    serde_json::to_string(&value).expect("fixture JSON"),
                ),
                code,
            );
        }
    }

    #[test]
    fn rejects_duplicate_question_and_choice_ids() {
        let mut duplicate_questions = valid_value();
        let mut second = duplicate_questions["questions"][0].clone();
        second["prompt"] = json!("A distinct prompt with a repeated ID?");
        duplicate_questions["questions"]
            .as_array_mut()
            .expect("questions")
            .push(second);
        let mut two_question_request = request();
        two_question_request.requested_question_count = 2;
        assert_invalid(
            validate(
                two_question_request,
                serde_json::to_string(&duplicate_questions).expect("fixture JSON"),
            ),
            QuizValidationIssueCode::DuplicateQuestionId,
        );

        let mut duplicate_choices = valid_value();
        duplicate_choices["questions"][0]["choices"][1]["id"] = json!("A");
        assert_invalid(
            validate(
                request(),
                serde_json::to_string(&duplicate_choices).expect("fixture JSON"),
            ),
            QuizValidationIssueCode::DuplicateChoiceId,
        );
    }

    #[test]
    fn rejects_missing_and_multiple_apparent_correct_choice_declarations() {
        let mut missing = valid_value();
        missing["questions"][0]["correctChoiceId"] = json!("Z");
        assert_invalid(
            validate(
                request(),
                serde_json::to_string(&missing).expect("fixture JSON"),
            ),
            QuizValidationIssueCode::MissingCorrectChoice,
        );

        let duplicate_key = VALID_EXAMPLE.replacen(
            "\"correctChoiceId\": \"C\",",
            "\"correctChoiceId\": \"A\",\n      \"correctChoiceId\": \"C\",",
            1,
        );
        assert_invalid(
            validate(request(), duplicate_key),
            QuizValidationIssueCode::DuplicateJsonKey,
        );
    }

    #[test]
    fn rejects_too_few_and_too_many_choices() {
        let mut too_few = valid_value();
        too_few["questions"][0]["choices"]
            .as_array_mut()
            .expect("choices")
            .truncate(2);
        assert_schema_invalid(too_few);

        let mut too_many = valid_value();
        let choices = too_many["questions"][0]["choices"]
            .as_array_mut()
            .expect("choices");
        choices.push(json!({"id": "E", "text": "Fifth near miss."}));
        choices.push(json!({"id": "F", "text": "Sixth near miss."}));
        assert_schema_invalid(too_many);
    }

    #[test]
    fn rejects_unknown_out_of_scope_and_missing_quote_evidence() {
        let mut unknown = valid_value();
        unknown["questions"][0]["evidence"][0]["sourceId"] = json!("source-missing");
        assert_invalid(
            validate(
                request(),
                serde_json::to_string(&unknown).expect("fixture JSON"),
            ),
            QuizValidationIssueCode::UnknownEvidenceSource,
        );

        let mut outside = valid_value();
        outside["questions"][0]["evidence"][0]["sourceId"] = json!("source-2");
        outside["questions"][0]["evidence"][0]["quote"] = json!("Not selected.");
        assert_invalid(
            validate(
                request(),
                serde_json::to_string(&outside).expect("fixture JSON"),
            ),
            QuizValidationIssueCode::EvidenceOutsideScope,
        );

        let mut absent_quote = valid_value();
        absent_quote["questions"][0]["evidence"][0]["quote"] =
            json!("This sentence was never supplied.");
        assert_invalid(
            validate(
                request(),
                serde_json::to_string(&absent_quote).expect("fixture JSON"),
            ),
            QuizValidationIssueCode::EvidenceQuoteNotFound,
        );
    }

    #[test]
    fn returns_stale_when_request_content_hash_no_longer_matches() {
        let mut stale_request = request();
        stale_request.evidence_sources[0].content_hash = format!("sha256-{}", "0".repeat(64));
        let QuizValidation::Stale { issues } = validate(stale_request, VALID_EXAMPLE) else {
            panic!("changed source content must be stale");
        };
        assert_eq!(issues[0].code, QuizValidationIssueCode::StaleContentHash);
        assert_eq!(issues[0].source_id.as_deref(), Some("source-1"));
    }

    #[test]
    fn returns_stale_when_current_bundle_scope_or_source_identity_changes() {
        let request = request();
        for (mut current, code) in [
            (
                QuizObservedState {
                    bundle_fingerprint: "changed-bundle".to_string(),
                    ..observed_state(&request)
                },
                QuizValidationIssueCode::StaleBundleFingerprint,
            ),
            (
                QuizObservedState {
                    scope_fingerprint: "changed-scope".to_string(),
                    ..observed_state(&request)
                },
                QuizValidationIssueCode::StaleScopeFingerprint,
            ),
            (
                observed_state(&request),
                QuizValidationIssueCode::StaleContentHash,
            ),
        ] {
            if code == QuizValidationIssueCode::StaleContentHash {
                current.sources[0].content_hash = format!("sha256-{}", "f".repeat(64));
            }
            let QuizValidation::Stale { issues } = validate_output(&QuizValidationInput {
                request: request.clone(),
                current_state: current,
                raw_output: Some(VALID_EXAMPLE.to_string()),
            }) else {
                panic!("current identity change must be stale");
            };
            assert_eq!(issues[0].code, code);
        }
    }

    #[test]
    fn rejects_duplicate_prompts_and_duplicate_normalized_answer_text() {
        let mut duplicate_questions = valid_value();
        let mut second = duplicate_questions["questions"][0].clone();
        second["id"] = json!("Q2");
        second["prompt"] =
            json!("  A PROVIDER asks to inspect other repository files because one answer is unclear. What should the quiz task do? ");
        duplicate_questions["questions"]
            .as_array_mut()
            .expect("questions")
            .push(second);
        let mut two_question_request = request();
        two_question_request.requested_question_count = 2;
        assert_invalid(
            validate(
                two_question_request,
                serde_json::to_string(&duplicate_questions).expect("fixture JSON"),
            ),
            QuizValidationIssueCode::DuplicateQuestionPrompt,
        );

        let mut duplicate_choices = valid_value();
        duplicate_choices["questions"][0]["choices"][1]["text"] =
            json!("  grant REPOSITORY access for the duration of this question. ");
        assert_invalid(
            validate(
                request(),
                serde_json::to_string(&duplicate_choices).expect("fixture JSON"),
            ),
            QuizValidationIssueCode::DuplicateChoiceText,
        );
    }

    #[test]
    fn rejects_critical_question_without_evidence() {
        let mut value = valid_value();
        value["questions"][0]["evidence"] = json!([]);
        assert_schema_invalid(value);
    }

    #[test]
    fn rejects_oversized_prompt_explanation_and_question_count() {
        let mut prompt = valid_value();
        prompt["questions"][0]["prompt"] = json!("p".repeat(2001));
        assert_schema_invalid(prompt);

        let mut explanation = valid_value();
        explanation["questions"][0]["explanation"] = json!("e".repeat(4001));
        assert_schema_invalid(explanation);

        let mut excessive = valid_value();
        let template = excessive["questions"][0].clone();
        let questions = excessive["questions"].as_array_mut().expect("questions");
        for index in 2..=21 {
            let mut question = template.clone();
            question["id"] = json!(format!("Q{index}"));
            question["prompt"] = json!(format!("Unique prompt {index}?"));
            questions.push(question);
        }
        assert_schema_invalid(excessive);
    }

    #[test]
    fn accepts_non_ascii_and_markdown_punctuation_in_exact_quotes() {
        let mut unicode = valid_value();
        unicode["title"] = json!("Confiance — 東京");
        unicode["questions"][0]["prompt"] = json!("Que signifie « naïve façade — 東京 » ?");
        unicode["questions"][0]["evidence"][0]["heading"] = json!("International — 国際");
        unicode["questions"][0]["evidence"][0]["quote"] =
            json!("Unicode evidence: naïve façade — 東京.");
        assert!(matches!(
            validate(
                request(),
                serde_json::to_string(&unicode).expect("fixture JSON")
            ),
            QuizValidation::Ready { .. }
        ));

        let mut markdown = valid_value();
        markdown["questions"][0]["evidence"][0]["quote"] = json!(
            "Evidence can preserve **trusted** [scope](docs/scope.md) and `exact code` punctuation."
        );
        assert!(matches!(
            validate(
                request(),
                serde_json::to_string(&markdown).expect("fixture JSON")
            ),
            QuizValidation::Ready { .. }
        ));
    }

    #[test]
    fn normalizes_only_line_endings_for_evidence_quotes() {
        let mut line_request = request();
        line_request.evidence_sources[0].markdown =
            "# Lines\r\n\r\nFirst line.\r\nSecond line.\r\n".to_string();
        line_request.evidence_sources[0].content_hash =
            evidence_content_hash(&line_request.evidence_sources[0].markdown);

        let mut value = valid_value();
        value["questions"][0]["evidence"][0]["quote"] = json!("First line.\nSecond line.");
        assert!(matches!(
            validate(
                line_request,
                serde_json::to_string(&value).expect("fixture JSON")
            ),
            QuizValidation::Ready { .. }
        ));
    }

    #[test]
    fn ready_and_insufficient_status_rules_are_closed_in_the_schema() {
        let mut ready_without_questions = valid_value();
        ready_without_questions["questions"] = json!([]);
        assert_schema_invalid(ready_without_questions);

        let mut insufficient_with_question: Value =
            serde_json::from_str(INSUFFICIENT_EXAMPLE).expect("insufficient fixture");
        insufficient_with_question["questions"] = valid_value()["questions"].clone();
        assert_schema_invalid(insufficient_with_question);

        let mut insufficient_without_warning: Value =
            serde_json::from_str(INSUFFICIENT_EXAMPLE).expect("insufficient fixture");
        insufficient_without_warning["warnings"] = json!([]);
        assert_schema_invalid(insufficient_without_warning);
    }
}
