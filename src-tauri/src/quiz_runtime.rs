//! Trusted quiz scope, persistence, attempts, scoring, and stale detection.
//!
//! Provider transport lives in `quiz_provider`; this module owns everything a
//! provider must not own: evidence selection, identity, storage, answer reveal,
//! scoring, and source-bound staleness.

use crate::git;
use crate::quiz::{
    evidence_content_hash, QuizArtifact, QuizCriticality, QuizEvidenceSource, QuizEvidenceVersion,
    QuizGenerationRequest, QuizQuestionCategory, QuizScopeMode, QUIZ_SCHEMA_VERSION,
};
use okf_core::Bundle;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Output;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use time::format_description::well_known::Rfc3339;
use time::{Duration as TimeDuration, OffsetDateTime};
use uuid::Uuid;

const STORE_SCHEMA_VERSION: u32 = 2;
const LEGACY_STORE_SCHEMA_VERSION: u32 = 1;
const STORE_FILE: &str = "quiz-store-v1.json";
const GENERATOR_SETTINGS_FILE: &str = "quiz-generators-v1.json";
const GENERATOR_SETTINGS_SCHEMA_VERSION: u32 = 2;
const LEGACY_GENERATOR_SETTINGS_SCHEMA_VERSION: u32 = 1;
const DEFAULT_CODEX_MODEL: &str = "gpt-5.6-sol";
const GENERATOR_SETTINGS_MAX_BYTES: u64 = 256 * 1024;
const STORE_MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_QUIZZES: usize = 100;
const MAX_GENERATION_FAILURES: usize = 100;
const MAX_ATTEMPTS_PER_QUIZ: usize = 20;
const QUIZ_RETENTION_DAYS: i64 = 30;
const MAX_SELECTED_CONCEPTS: usize = 32;
const MAX_EVIDENCE_SOURCES: usize = 64;
const MAX_SOURCE_BYTES: usize = 256 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES: usize = 1024 * 1024;
const MAX_BUNDLE_CONTEXT_FILES: usize = 512;
const MAX_TOTAL_BUNDLE_CONTEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOPIC_CHARS: usize = 512;
const MAX_TOPIC_CANDIDATES: usize = 50;
const MAX_FROZEN_PACKETS: usize = 16;
const MAX_QUIZ_QUESTIONS: usize = 20;
type PreparedScope = (
    Vec<QuizEvidenceSource>,
    Vec<QuizScopeSourcePreview>,
    String,
    Vec<String>,
    String,
);

struct ReviewedSinceCandidate {
    concept_id: String,
    path: String,
    title: String,
    concept_type: String,
    markdown: Option<String>,
    bytes: usize,
    changed_lines: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizProviderKind {
    CodexCli,
    ClaudeCli,
    ModelApi,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CodexReasoningEffort {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

impl CodexReasoningEffort {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizLength {
    Short,
    Medium,
    Long,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizGenerationMode {
    Automatic,
    #[default]
    Manual,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizGenerationConfig {
    #[serde(default)]
    pub mode: QuizGenerationMode,
    pub length: Option<QuizLength>,
    pub difficulty: Option<crate::quiz::QuizDifficulty>,
    pub max_questions: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizProviderProfile {
    pub id: String,
    pub kind: QuizProviderKind,
    pub label: String,
    pub model: Option<String>,
    pub endpoint: Option<String>,
    #[serde(default)]
    pub executable_path: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<CodexReasoningEffort>,
    pub sends_content_off_device: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliGeneratorSettings {
    pub enabled: bool,
    pub executable_path: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<CodexReasoningEffort>,
    pub last_diagnostic: Option<CliDiagnostic>,
}

impl Default for CliGeneratorSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            executable_path: None,
            model: None,
            reasoning_effort: None,
            last_diagnostic: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliDiagnostic {
    pub tested_at: String,
    pub available: bool,
    pub authentication_required: bool,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub message: String,
    pub live: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuizGeneratorSettings {
    pub schema_version: u32,
    pub revision: String,
    pub default_profile_id: Option<String>,
    pub codex_cli: CliGeneratorSettings,
    pub claude_cli: CliGeneratorSettings,
    pub api_profiles: Vec<QuizProviderProfile>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for QuizGeneratorSettings {
    fn default() -> Self {
        let codex_cli = CliGeneratorSettings {
            model: Some(DEFAULT_CODEX_MODEL.to_string()),
            reasoning_effort: Some(CodexReasoningEffort::High),
            ..CliGeneratorSettings::default()
        };
        Self {
            schema_version: GENERATOR_SETTINGS_SCHEMA_VERSION,
            revision: format!("settings-{}", Uuid::new_v4()),
            default_profile_id: Some("codex-cli".to_string()),
            codex_cli,
            claude_cli: CliGeneratorSettings::default(),
            api_profiles: Vec::new(),
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveQuizGeneratorSettingsInput {
    pub expected_revision: String,
    pub default_profile_id: Option<String>,
    pub codex_cli: CliGeneratorSettings,
    pub claude_cli: CliGeneratorSettings,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveApiProfileInput {
    pub id: Option<String>,
    pub label: String,
    pub endpoint: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareQuizScopeInput {
    pub bundle_root: String,
    pub scope_mode: QuizScopeMode,
    pub concept_ids: Vec<String>,
    pub topic: Option<String>,
    pub base_revision_id: Option<String>,
    pub head_revision_id: Option<String>,
    pub generation: QuizGenerationConfig,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuizScopeSourcePreview {
    pub source_id: String,
    pub concept_id: String,
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub concept_type: String,
    pub version: QuizEvidenceVersion,
    pub content_hash: String,
    pub bytes: usize,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuizScopePreview {
    pub request_id: String,
    pub bundle_name: String,
    pub bundle_fingerprint: String,
    pub scope_fingerprint: String,
    pub scope_mode: QuizScopeMode,
    pub scope_description: String,
    pub sources: Vec<QuizScopeSourcePreview>,
    pub omitted_documents: Vec<String>,
    pub total_evidence_bytes: usize,
    pub bundle_context_documents: usize,
    pub bundle_context_bytes: usize,
    pub bundle_revision: String,
    pub repository_root: Option<String>,
    pub generation: QuizGenerationConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuizRepositoryContext {
    pub working_directory: String,
    pub comparison_mode: crate::git::GitComparisonMode,
    pub current_branch: Option<String>,
    pub default_branch: Option<String>,
    pub base_revision: Option<String>,
    pub head_revision: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TopicCandidate {
    pub concept_id: String,
    pub title: String,
    pub path: String,
    #[serde(rename = "type")]
    pub concept_type: String,
    pub tags: Vec<String>,
    pub content_hash: String,
    pub bytes: usize,
    pub score: u32,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitQuizAvailability {
    pub available: bool,
    pub repository_root: Option<String>,
    pub head_revision: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRevision {
    pub id: String,
    pub short_id: String,
    pub subject: String,
    pub timestamp: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizSummary {
    pub quiz_id: String,
    pub title: String,
    pub scope_mode: QuizScopeMode,
    pub scope_description: String,
    pub provider_kind: QuizProviderKind,
    pub provider_profile: String,
    pub model: Option<String>,
    pub generated_at: String,
    pub question_count: usize,
    pub attempt_count: usize,
    pub latest_score: Option<u32>,
    pub latest_total: Option<u32>,
    pub stale: bool,
    pub stale_reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizGenerationFailureKind {
    ProviderError,
    InvalidOutput,
    InsufficientEvidence,
    Stale,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuizGenerationFailureSummary {
    pub failure_id: String,
    pub scope_mode: QuizScopeMode,
    pub scope_description: String,
    pub provider_kind: QuizProviderKind,
    pub provider_profile: String,
    pub model: Option<String>,
    pub failed_at: String,
    pub failure_kind: QuizGenerationFailureKind,
    pub message: String,
    pub retry_count: u32,
    pub generation: QuizGenerationConfig,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizAttemptSummary {
    pub attempt_id: String,
    pub quiz_id: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub answered: usize,
    pub excluded: usize,
    pub total: usize,
    pub correct: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicQuizQuestion {
    pub attempt_id: String,
    pub quiz_id: String,
    pub question_id: String,
    pub index: usize,
    pub total: usize,
    pub category: QuizQuestionCategory,
    pub criticality: QuizCriticality,
    pub prompt: String,
    pub choices: Vec<crate::quiz::QuizChoice>,
    pub already_answered: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitQuizAnswerInput {
    pub bundle_root: String,
    pub attempt_id: String,
    pub question_id: String,
    pub selected_choice_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkQuizQuestionNotImportantInput {
    pub bundle_root: String,
    pub attempt_id: String,
    pub question_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedQuizEvidence {
    pub source_id: String,
    pub concept_id: String,
    pub title: String,
    pub path: String,
    pub version: QuizEvidenceVersion,
    pub heading: String,
    pub quote: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizAnswerReveal {
    pub attempt_id: String,
    pub question_id: String,
    pub selected_choice_id: String,
    pub correct: bool,
    pub correct_choice_id: String,
    pub explanation: String,
    pub evidence: Vec<ResolvedQuizEvidence>,
    pub completed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizCategoryResult {
    pub category: QuizQuestionCategory,
    pub correct: u32,
    pub total: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizIncorrectAnswer {
    pub question_id: String,
    pub prompt: String,
    pub selected_choice_id: String,
    pub correct_choice_id: String,
    pub explanation: String,
    pub evidence: Vec<ResolvedQuizEvidence>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizExcludedQuestion {
    pub question_id: String,
    pub prompt: String,
    pub category: QuizQuestionCategory,
    pub criticality: QuizCriticality,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizResults {
    pub attempt_id: String,
    pub quiz_id: String,
    pub title: String,
    pub correct: u32,
    pub total: u32,
    pub critical_correct: u32,
    pub critical_total: u32,
    pub critical_gap: bool,
    pub stale: bool,
    pub stale_reason: Option<String>,
    pub completed_at: Option<String>,
    pub by_category: Vec<QuizCategoryResult>,
    pub incorrect_answers: Vec<QuizIncorrectAnswer>,
    pub excluded_questions: Vec<QuizExcludedQuestion>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizAttemptView {
    pub summary: QuizAttemptSummary,
    pub next_question: Option<PublicQuizQuestion>,
    pub stale: bool,
    pub stale_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenQuizPacket {
    pub request: QuizGenerationRequest,
    pub generation: QuizGenerationConfig,
    pub scope_description: String,
    pub bundle_name: String,
    pub bundle_revision: String,
    pub omitted_documents: Vec<String>,
    pub repository_context: Option<QuizRepositoryContext>,
}

#[derive(Clone, Debug)]
pub(crate) struct FrozenQuizRun {
    pub bundle_root: PathBuf,
    pub repository_root: Option<PathBuf>,
    pub packet: FrozenQuizPacket,
    pub bundle_context: Vec<FrozenBundleFile>,
    pub retry_input: PrepareQuizScopeInput,
    pub retry_failure_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrozenBundleFile {
    pub path: String,
    pub contents: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredQuizDefinition {
    pub quiz_id: String,
    pub bundle_root: String,
    pub bundle_name: String,
    pub scope_description: String,
    pub provider_kind: QuizProviderKind,
    pub provider_profile: String,
    pub model: Option<String>,
    pub generated_at: String,
    #[serde(default)]
    pub generation: Option<QuizGenerationConfig>,
    pub request: QuizGenerationRequest,
    pub artifact: QuizArtifact,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredQuizGenerationFailure {
    failure_id: String,
    bundle_root: String,
    scope_description: String,
    provider_kind: QuizProviderKind,
    provider_profile: String,
    model: Option<String>,
    failed_at: String,
    failure_kind: QuizGenerationFailureKind,
    message: String,
    retry_count: u32,
    retry_input: PrepareQuizScopeInput,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredAnswer {
    selected_choice_id: String,
    correct: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredAttempt {
    attempt_id: String,
    quiz_id: String,
    started_at: String,
    completed_at: Option<String>,
    answers: BTreeMap<String, StoredAnswer>,
    #[serde(default)]
    not_important_question_ids: BTreeSet<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuizStore {
    schema_version: u32,
    definitions: Vec<StoredQuizDefinition>,
    attempts: Vec<StoredAttempt>,
    #[serde(default)]
    generation_failures: Vec<StoredQuizGenerationFailure>,
    #[serde(default)]
    api_profiles: Vec<QuizProviderProfile>,
}

impl Default for QuizStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_SCHEMA_VERSION,
            definitions: Vec::new(),
            attempts: Vec::new(),
            generation_failures: Vec::new(),
            api_profiles: Vec::new(),
        }
    }
}

struct RuntimeInner {
    store: QuizStore,
    generators: QuizGeneratorSettings,
    frozen: BTreeMap<String, FrozenQuizRun>,
    cancellations: BTreeMap<String, Arc<AtomicBool>>,
}

pub struct QuizRuntimeState {
    store_path: PathBuf,
    generator_settings_path: PathBuf,
    cache_root: PathBuf,
    inner: Mutex<RuntimeInner>,
}

impl QuizRuntimeState {
    pub fn ensure_idle_for_update(&self) -> Result<(), String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Quiz storage is unavailable.")?;
        if inner.cancellations.is_empty() {
            Ok(())
        } else {
            Err("Finish or cancel quiz generation before updating the app.".into())
        }
    }

    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("OKF Reviewer could not locate quiz storage: {error}"))?;
        let cache_root = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("OKF Reviewer could not locate quiz cache: {error}"))?
            .join("quiz-generation");
        let app_config = app.path().app_config_dir().map_err(|error| {
            format!("OKF Reviewer could not locate user configuration: {error}")
        })?;
        Self::load_from_paths(
            app_data.join("quizzes").join(STORE_FILE),
            cache_root,
            app_config.join(GENERATOR_SETTINGS_FILE),
        )
    }

    #[cfg(test)]
    fn load_from(store_path: PathBuf, cache_root: PathBuf) -> Result<Self, String> {
        let generator_settings_path = store_path.with_file_name(GENERATOR_SETTINGS_FILE);
        Self::load_from_paths(store_path, cache_root, generator_settings_path)
    }

    fn load_from_paths(
        store_path: PathBuf,
        cache_root: PathBuf,
        generator_settings_path: PathBuf,
    ) -> Result<Self, String> {
        let mut store = load_store(&store_path)?;
        let (mut generators, mut generators_changed) =
            load_generator_settings_for_startup(&generator_settings_path)?;
        let migrated_api_profiles = !store.api_profiles.is_empty();
        if migrated_api_profiles {
            for profile in store.api_profiles.drain(..) {
                if !generators
                    .api_profiles
                    .iter()
                    .any(|candidate| candidate.id == profile.id)
                {
                    generators.api_profiles.push(profile);
                }
            }
            generators_changed = true;
        }
        if generators_changed {
            generators.revision = format!("settings-{}", Uuid::new_v4());
            persist_generator_settings(&generator_settings_path, &generators)?;
        }
        if migrated_api_profiles {
            persist_store(&store_path, &store)?;
        }
        cleanup_abandoned_workspaces(&cache_root)?;
        Ok(Self {
            store_path,
            generator_settings_path,
            cache_root,
            inner: Mutex::new(RuntimeInner {
                store,
                generators,
                frozen: BTreeMap::new(),
                cancellations: BTreeMap::new(),
            }),
        })
    }

    pub fn prepare_scope(
        &self,
        root: &Path,
        repository_root: Option<&Path>,
        input: &PrepareQuizScopeInput,
    ) -> Result<QuizScopePreview, String> {
        validate_requested_configuration(input)?;
        if input.generation.mode == QuizGenerationMode::Automatic && repository_root.is_none() {
            return Err("Automatic quiz generation requires a trusted Git repository.".to_string());
        }
        let bundle = okf_core::read_bundle(root);
        if bundle.concepts.is_empty() {
            return Err("The active bundle has no concepts to quiz.".to_string());
        }
        let bundle_fingerprint = okf_core::health::bundle_fingerprint(&bundle);
        let request_id = format!("quiz-request-{}", Uuid::new_v4());
        let (sources, source_previews, description, omitted, revision) = match input.scope_mode {
            QuizScopeMode::CurrentDocument
            | QuizScopeMode::SelectedDocuments
            | QuizScopeMode::Topic => prepare_concept_scope(root, &bundle, input)?,
            QuizScopeMode::BundleDiff => {
                let repository = repository_root.ok_or_else(|| {
                    "Bundle-diff scope is unavailable without an authorized Git repository."
                        .to_string()
                })?;
                prepare_diff_scope(root, repository, &bundle, input)?
            }
            QuizScopeMode::ReviewedSinceCommit => {
                let repository = repository_root.ok_or_else(|| {
                    "Reviewed-since-commit scope is unavailable without an authorized Git repository."
                        .to_string()
                })?;
                prepare_reviewed_since_commit_scope(root, repository, &bundle, input)?
            }
        };
        let captured_head_revision = match input.scope_mode {
            QuizScopeMode::BundleDiff => Some(
                input
                    .head_revision_id
                    .clone()
                    .unwrap_or_else(|| "WORKTREE".to_string()),
            ),
            QuizScopeMode::ReviewedSinceCommit => Some("WORKTREE".to_string()),
            _ => None,
        };
        let scope_fingerprint = scope_fingerprint(
            input.scope_mode,
            &sources,
            input.topic.as_deref(),
            input.base_revision_id.as_deref(),
            captured_head_revision.as_deref(),
        );
        let total_evidence_bytes = sources.iter().map(|source| source.markdown.len()).sum();
        let omitted_context = omitted.iter().map(String::as_str).collect::<BTreeSet<_>>();
        let bundle_context = prepare_bundle_context(root, &bundle, &omitted_context)?;
        let bundle_context_documents = bundle_context.len();
        let bundle_context_bytes = bundle_context.iter().map(|file| file.contents.len()).sum();
        let repository_context = match repository_root {
            Some(repository) => match git::bundle_status(root, repository, &bundle) {
                Ok(status) => Some(QuizRepositoryContext {
                    working_directory: repository.to_string_lossy().into_owned(),
                    comparison_mode: status.comparison_mode,
                    current_branch: status.current_branch,
                    default_branch: status.default_branch,
                    base_revision: status.base_revision,
                    head_revision: status.head_revision,
                }),
                Err(error) if input.generation.mode == QuizGenerationMode::Automatic => {
                    return Err(format!(
                        "Automatic quiz generation could not inspect the trusted Git repository: {error}"
                    ));
                }
                Err(_) => None,
            },
            None => None,
        };
        let (question_count_policy, requested_question_count, requested_difficulty) =
            match input.generation.mode {
                QuizGenerationMode::Automatic => (
                    crate::quiz::QuizQuestionCountPolicy::Automatic,
                    input.generation.max_questions,
                    None,
                ),
                QuizGenerationMode::Manual => (
                    crate::quiz::QuizQuestionCountPolicy::Exact,
                    proportional_question_count(
                        total_evidence_bytes,
                        input
                            .generation
                            .length
                            .expect("manual configuration validated"),
                        input.generation.max_questions,
                    ),
                    input.generation.difficulty,
                ),
            };
        let request = QuizGenerationRequest {
            request_id: request_id.clone(),
            bundle_fingerprint: bundle_fingerprint.clone(),
            scope_fingerprint: scope_fingerprint.clone(),
            scope_mode: input.scope_mode,
            question_count_policy,
            requested_question_count,
            requested_difficulty,
            scope_source_ids: sources
                .iter()
                .map(|source| source.source_id.clone())
                .collect(),
            evidence_sources: sources,
            topic: input.topic.clone(),
            base_revision_id: input.base_revision_id.clone(),
            head_revision_id: captured_head_revision,
        };
        let packet = FrozenQuizPacket {
            request,
            generation: input.generation,
            scope_description: description.clone(),
            bundle_name: bundle.name.clone(),
            bundle_revision: revision.clone(),
            omitted_documents: omitted.clone(),
            repository_context,
        };
        let mut retry_input = input.clone();
        retry_input.bundle_root = root.to_string_lossy().into_owned();
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        while inner.frozen.len() >= MAX_FROZEN_PACKETS {
            let Some(oldest) = inner.frozen.keys().next().cloned() else {
                break;
            };
            inner.frozen.remove(&oldest);
        }
        inner.frozen.insert(
            request_id.clone(),
            FrozenQuizRun {
                bundle_root: root.to_path_buf(),
                repository_root: repository_root.map(Path::to_path_buf),
                packet,
                bundle_context,
                retry_input,
                retry_failure_id: None,
            },
        );
        Ok(QuizScopePreview {
            request_id,
            bundle_name: bundle.name,
            bundle_fingerprint,
            scope_fingerprint,
            scope_mode: input.scope_mode,
            scope_description: description,
            sources: source_previews,
            omitted_documents: omitted,
            total_evidence_bytes,
            bundle_context_documents,
            bundle_context_bytes,
            bundle_revision: revision,
            repository_root: repository_root.map(|path| path.to_string_lossy().into_owned()),
            generation: input.generation,
        })
    }

    pub(crate) fn frozen_packet(&self, request_id: &str) -> Result<FrozenQuizRun, String> {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .frozen
            .get(request_id)
            .cloned()
            .ok_or_else(|| "That frozen quiz request is unavailable or expired.".to_string())
    }

    pub(crate) fn remove_frozen_packet(&self, request_id: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .frozen
            .remove(request_id);
    }

    pub(crate) fn cache_root(&self) -> &Path {
        &self.cache_root
    }

    pub(crate) fn begin_generation(&self, request_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if inner.cancellations.contains_key(request_id) {
            return Err("That quiz request is already generating.".to_string());
        }
        let cancellation = Arc::new(AtomicBool::new(false));
        inner
            .cancellations
            .insert(request_id.to_string(), cancellation.clone());
        Ok(cancellation)
    }

    pub(crate) fn finish_generation(&self, request_id: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .cancellations
            .remove(request_id);
    }

    pub fn cancel_generation(&self, request_id: &str) -> bool {
        let cancellation = self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .cancellations
            .get(request_id)
            .cloned();
        if let Some(cancellation) = cancellation {
            cancellation.store(true, Ordering::Release);
            true
        } else {
            false
        }
    }

    pub(crate) fn save_generated_quiz(
        &self,
        run: &FrozenQuizRun,
        artifact: QuizArtifact,
        provider: &QuizProviderProfile,
        model: Option<String>,
    ) -> Result<String, String> {
        let quiz_id = format!("quiz-{}", Uuid::new_v4());
        let definition = StoredQuizDefinition {
            quiz_id: quiz_id.clone(),
            bundle_root: run.bundle_root.to_string_lossy().into_owned(),
            bundle_name: run.packet.bundle_name.clone(),
            scope_description: run.packet.scope_description.clone(),
            provider_kind: provider.kind,
            provider_profile: provider.id.clone(),
            model: model.or_else(|| provider.model.clone()),
            generated_at: now_rfc3339()?,
            generation: Some(run.packet.generation),
            request: run.packet.request.clone(),
            artifact,
        };
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        inner.store.definitions.push(definition);
        if let Some(failure_id) = run.retry_failure_id.as_deref() {
            inner
                .store
                .generation_failures
                .retain(|failure| failure.failure_id != failure_id);
        }
        enforce_retention(&mut inner.store);
        persist_store(&self.store_path, &inner.store)?;
        inner.frozen.remove(&run.packet.request.request_id);
        Ok(quiz_id)
    }

    pub(crate) fn save_generation_failure(
        &self,
        run: &FrozenQuizRun,
        provider: &QuizProviderProfile,
        model: Option<String>,
        failure_kind: QuizGenerationFailureKind,
        message: &str,
    ) -> Result<String, String> {
        let failed_at = now_rfc3339()?;
        let message = bounded_text(message, 1_000);
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let failure_id = if let Some(failure_id) = run.retry_failure_id.as_deref() {
            let failure = inner
                .store
                .generation_failures
                .iter_mut()
                .find(|failure| failure.failure_id == failure_id)
                .ok_or_else(|| "That failed quiz generation no longer exists.".to_string())?;
            failure.scope_description = run.packet.scope_description.clone();
            failure.provider_kind = provider.kind;
            failure.provider_profile = provider.id.clone();
            failure.model = model.or_else(|| provider.model.clone());
            failure.failed_at = failed_at;
            failure.failure_kind = failure_kind;
            failure.message = message;
            failure.retry_count = failure.retry_count.saturating_add(1);
            failure.retry_input = run.retry_input.clone();
            failure_id.to_string()
        } else {
            let failure_id = format!("quiz-failure-{}", Uuid::new_v4());
            inner
                .store
                .generation_failures
                .push(StoredQuizGenerationFailure {
                    failure_id: failure_id.clone(),
                    bundle_root: run.bundle_root.to_string_lossy().into_owned(),
                    scope_description: run.packet.scope_description.clone(),
                    provider_kind: provider.kind,
                    provider_profile: provider.id.clone(),
                    model: model.or_else(|| provider.model.clone()),
                    failed_at,
                    failure_kind,
                    message,
                    retry_count: 0,
                    retry_input: run.retry_input.clone(),
                });
            failure_id
        };
        enforce_retention(&mut inner.store);
        persist_store(&self.store_path, &inner.store)?;
        inner.frozen.remove(&run.packet.request.request_id);
        Ok(failure_id)
    }

    pub fn provider_profiles(&self) -> Vec<QuizProviderProfile> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let mut profiles = builtin_profiles(&inner.generators);
        profiles.extend(inner.generators.api_profiles.clone());
        profiles
    }

    pub fn generator_settings(&self) -> QuizGeneratorSettings {
        self.inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .generators
            .clone()
    }

    pub fn save_generator_settings(
        &self,
        input: SaveQuizGeneratorSettingsInput,
    ) -> Result<QuizGeneratorSettings, String> {
        validate_cli_generator_settings("Codex CLI", &input.codex_cli)?;
        validate_cli_generator_settings("Claude Code CLI", &input.claude_cli)?;
        if input.claude_cli.reasoning_effort.is_some() {
            return Err("Reasoning effort is supported only for Codex CLI generators.".to_string());
        }
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        ensure_generator_revision(&self.generator_settings_path, &inner.generators.revision)?;
        if input.expected_revision != inner.generators.revision {
            return Err(
                "Generator settings changed outside this window. Reload Settings and try again."
                    .to_string(),
            );
        }
        let available_ids = builtin_profiles_from_parts(&input.codex_cli, &input.claude_cli)
            .into_iter()
            .map(|profile| profile.id)
            .chain(
                inner
                    .generators
                    .api_profiles
                    .iter()
                    .map(|profile| profile.id.clone()),
            )
            .collect::<BTreeSet<_>>();
        if input
            .default_profile_id
            .as_ref()
            .is_some_and(|id| !available_ids.contains(id))
        {
            return Err("Choose an enabled generator as the default.".to_string());
        }
        let mut codex_cli = input.codex_cli;
        codex_cli.last_diagnostic = inner.generators.codex_cli.last_diagnostic.clone();
        let mut claude_cli = input.claude_cli;
        claude_cli.last_diagnostic = inner.generators.claude_cli.last_diagnostic.clone();
        inner.generators.default_profile_id = input.default_profile_id;
        inner.generators.codex_cli = codex_cli;
        inner.generators.claude_cli = claude_cli;
        inner.generators.revision = format!("settings-{}", Uuid::new_v4());
        persist_generator_settings(&self.generator_settings_path, &inner.generators)?;
        Ok(inner.generators.clone())
    }

    pub fn record_cli_diagnostic(
        &self,
        kind: QuizProviderKind,
        diagnostic: CliDiagnostic,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        ensure_generator_revision(&self.generator_settings_path, &inner.generators.revision)?;
        match kind {
            QuizProviderKind::CodexCli => {
                inner.generators.codex_cli.last_diagnostic = Some(diagnostic)
            }
            QuizProviderKind::ClaudeCli => {
                inner.generators.claude_cli.last_diagnostic = Some(diagnostic)
            }
            QuizProviderKind::ModelApi => return Ok(()),
        }
        inner.generators.revision = format!("settings-{}", Uuid::new_v4());
        persist_generator_settings(&self.generator_settings_path, &inner.generators)
    }

    pub fn regeneration_input(
        &self,
        root: &Path,
        quiz_id: &str,
    ) -> Result<PrepareQuizScopeInput, String> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let definition = definition_for_bundle(&inner.store, root, quiz_id)?;
        let mut seen = BTreeSet::new();
        let concept_ids = definition
            .request
            .evidence_sources
            .iter()
            .filter(|source| seen.insert(source.concept_id.as_str()))
            .map(|source| source.concept_id.clone())
            .collect();
        Ok(PrepareQuizScopeInput {
            bundle_root: root.to_string_lossy().into_owned(),
            scope_mode: definition.request.scope_mode,
            concept_ids,
            topic: definition.request.topic.clone(),
            base_revision_id: definition.request.base_revision_id.clone(),
            head_revision_id: definition
                .request
                .head_revision_id
                .as_deref()
                .filter(|revision| *revision != "WORKTREE")
                .map(str::to_string),
            generation: definition.generation.unwrap_or_else(|| {
                legacy_generation_config(
                    definition.request.requested_question_count,
                    definition.request.requested_difficulty,
                )
            }),
        })
    }

    pub fn generation_failure_retry_input(
        &self,
        root: &Path,
        failure_id: &str,
    ) -> Result<PrepareQuizScopeInput, String> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let failure = generation_failure_for_bundle(&inner.store, root, failure_id)?;
        Ok(failure.retry_input.clone())
    }

    pub fn mark_generation_failure_retry(
        &self,
        request_id: &str,
        failure_id: &str,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if !inner
            .store
            .generation_failures
            .iter()
            .any(|failure| failure.failure_id == failure_id)
        {
            return Err("That failed quiz generation no longer exists.".to_string());
        }
        let run = inner
            .frozen
            .get_mut(request_id)
            .ok_or_else(|| "That frozen quiz request is unavailable or expired.".to_string())?;
        run.retry_failure_id = Some(failure_id.to_string());
        Ok(())
    }

    pub fn provider_profile(&self, profile_id: &str) -> Option<QuizProviderProfile> {
        self.provider_profiles()
            .into_iter()
            .find(|profile| profile.id == profile_id)
    }

    pub fn save_api_profile(
        &self,
        input: SaveApiProfileInput,
    ) -> Result<QuizProviderProfile, String> {
        validate_profile_text("profile label", &input.label, 120)?;
        validate_profile_text("model", &input.model, 200)?;
        let endpoint = validate_api_endpoint(&input.endpoint)?;
        let sends_content_off_device = !api_endpoint_is_loopback(&endpoint);
        let id = input
            .id
            .unwrap_or_else(|| format!("api-{}", Uuid::new_v4()));
        validate_identifier(&id, "profile ID")?;
        if matches!(id.as_str(), "codex-cli" | "claude-cli") {
            return Err("Built-in CLI profiles cannot be replaced.".to_string());
        }
        if let Some(secret) = input.api_key.as_deref() {
            if secret.trim().is_empty() || secret.len() > 16 * 1024 {
                return Err("API keys must be non-empty and bounded.".to_string());
            }
            store_api_key(&id, secret)?;
        }
        let profile = QuizProviderProfile {
            id: id.clone(),
            kind: QuizProviderKind::ModelApi,
            label: input.label.trim().to_string(),
            model: Some(input.model.trim().to_string()),
            endpoint: Some(endpoint),
            executable_path: None,
            reasoning_effort: None,
            sends_content_off_device,
        };
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        ensure_generator_revision(&self.generator_settings_path, &inner.generators.revision)?;
        if let Some(existing) = inner
            .generators
            .api_profiles
            .iter_mut()
            .find(|candidate| candidate.id == id)
        {
            *existing = profile.clone();
        } else {
            if inner.generators.api_profiles.len() >= 20 {
                return Err("OKF Reviewer supports at most 20 model API profiles.".to_string());
            }
            inner.generators.api_profiles.push(profile.clone());
        }
        inner.generators.revision = format!("settings-{}", Uuid::new_v4());
        persist_generator_settings(&self.generator_settings_path, &inner.generators)?;
        Ok(profile)
    }

    pub fn delete_api_profile(&self, profile_id: &str) -> Result<(), String> {
        validate_identifier(profile_id, "profile ID")?;
        if matches!(profile_id, "codex-cli" | "claude-cli") {
            return Err("Built-in CLI profiles cannot be deleted.".to_string());
        }
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        ensure_generator_revision(&self.generator_settings_path, &inner.generators.revision)?;
        inner
            .generators
            .api_profiles
            .retain(|profile| profile.id != profile_id);
        if inner.generators.default_profile_id.as_deref() == Some(profile_id) {
            inner.generators.default_profile_id = builtin_profiles(&inner.generators)
                .first()
                .map(|profile| profile.id.clone());
        }
        inner.generators.revision = format!("settings-{}", Uuid::new_v4());
        persist_generator_settings(&self.generator_settings_path, &inner.generators)?;
        delete_api_key(profile_id)
    }

    pub fn list_quizzes(&self, root: &Path) -> Result<Vec<QuizSummary>, String> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let mut summaries = inner
            .store
            .definitions
            .iter()
            .filter(|definition| same_path(&definition.bundle_root, root))
            .map(|definition| quiz_summary(definition, &inner.store.attempts, root))
            .collect::<Result<Vec<_>, _>>()?;
        summaries.sort_by(|left, right| right.generated_at.cmp(&left.generated_at));
        Ok(summaries)
    }

    pub fn list_generation_failures(&self, root: &Path) -> Vec<QuizGenerationFailureSummary> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let mut failures = inner
            .store
            .generation_failures
            .iter()
            .filter(|failure| same_path(&failure.bundle_root, root))
            .map(generation_failure_summary)
            .collect::<Vec<_>>();
        failures.sort_by(|left, right| right.failed_at.cmp(&left.failed_at));
        failures
    }

    pub fn list_attempts(
        &self,
        root: &Path,
        quiz_id: &str,
    ) -> Result<Vec<QuizAttemptSummary>, String> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let definition = definition_for_bundle(&inner.store, root, quiz_id)?;
        let mut attempts = inner
            .store
            .attempts
            .iter()
            .filter(|attempt| attempt.quiz_id == definition.quiz_id)
            .map(|attempt| attempt_summary(attempt, definition))
            .collect::<Vec<_>>();
        attempts.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        Ok(attempts)
    }

    pub fn start_attempt(&self, root: &Path, quiz_id: &str) -> Result<QuizAttemptView, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if enforce_retention_at(&mut inner.store, OffsetDateTime::now_utc()) {
            persist_store(&self.store_path, &inner.store)?;
        }
        let definition = definition_for_bundle(&inner.store, root, quiz_id)?.clone();
        let stale_reason = stale_reason(&definition, root)?;
        let attempt_id = format!("attempt-{}", Uuid::new_v4());
        let attempt = StoredAttempt {
            attempt_id: attempt_id.clone(),
            quiz_id: quiz_id.to_string(),
            started_at: now_rfc3339()?,
            completed_at: None,
            answers: BTreeMap::new(),
            not_important_question_ids: BTreeSet::new(),
        };
        inner.store.attempts.push(attempt);
        enforce_retention(&mut inner.store);
        persist_store(&self.store_path, &inner.store)?;
        let attempt = inner
            .store
            .attempts
            .iter()
            .find(|candidate| candidate.attempt_id == attempt_id)
            .expect("new attempt remains after retention");
        Ok(QuizAttemptView {
            summary: attempt_summary(attempt, &definition),
            next_question: public_question(&definition, attempt),
            stale: stale_reason.is_some(),
            stale_reason,
        })
    }

    pub fn resume_attempt(&self, root: &Path, attempt_id: &str) -> Result<QuizAttemptView, String> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let attempt = inner
            .store
            .attempts
            .iter()
            .find(|attempt| attempt.attempt_id == attempt_id)
            .ok_or_else(|| "That quiz attempt does not exist.".to_string())?;
        let definition = definition_for_bundle(&inner.store, root, &attempt.quiz_id)?;
        let stale_reason = stale_reason(definition, root)?;
        Ok(QuizAttemptView {
            summary: attempt_summary(attempt, definition),
            next_question: public_question(definition, attempt),
            stale: stale_reason.is_some(),
            stale_reason,
        })
    }

    pub fn submit_answer(
        &self,
        root: &Path,
        input: &SubmitQuizAnswerInput,
    ) -> Result<QuizAnswerReveal, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let attempt_index = inner
            .store
            .attempts
            .iter()
            .position(|attempt| attempt.attempt_id == input.attempt_id)
            .ok_or_else(|| "That quiz attempt does not exist.".to_string())?;
        let quiz_id = inner.store.attempts[attempt_index].quiz_id.clone();
        let definition = definition_for_bundle(&inner.store, root, &quiz_id)?.clone();
        let attempt = &mut inner.store.attempts[attempt_index];
        if attempt.completed_at.is_some() {
            return Err("That quiz attempt is already complete.".to_string());
        }
        if attempt.answers.contains_key(&input.question_id) {
            return Err("That question has already been submitted.".to_string());
        }
        let expected = definition
            .artifact
            .questions
            .get(attempt.answers.len() + attempt.not_important_question_ids.len())
            .ok_or_else(|| "That attempt has no remaining question.".to_string())?;
        if expected.id != input.question_id {
            return Err("Answers must be submitted in quiz order.".to_string());
        }
        if !expected
            .choices
            .iter()
            .any(|choice| choice.id == input.selected_choice_id)
        {
            return Err("The selected choice is not part of this question.".to_string());
        }
        let correct = input.selected_choice_id == expected.correct_choice_id;
        attempt.answers.insert(
            expected.id.clone(),
            StoredAnswer {
                selected_choice_id: input.selected_choice_id.clone(),
                correct,
            },
        );
        let completed = attempt.answers.len() + attempt.not_important_question_ids.len()
            == definition.artifact.questions.len();
        if completed {
            attempt.completed_at = Some(now_rfc3339()?);
        }
        let reveal = QuizAnswerReveal {
            attempt_id: attempt.attempt_id.clone(),
            question_id: expected.id.clone(),
            selected_choice_id: input.selected_choice_id.clone(),
            correct,
            correct_choice_id: expected.correct_choice_id.clone(),
            explanation: expected.explanation.clone(),
            evidence: resolve_evidence(&definition, expected)?,
            completed,
        };
        persist_store(&self.store_path, &inner.store)?;
        Ok(reveal)
    }

    pub fn mark_question_not_important(
        &self,
        root: &Path,
        input: &MarkQuizQuestionNotImportantInput,
    ) -> Result<QuizAttemptView, String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let attempt_index = inner
            .store
            .attempts
            .iter()
            .position(|attempt| attempt.attempt_id == input.attempt_id)
            .ok_or_else(|| "That quiz attempt does not exist.".to_string())?;
        let quiz_id = inner.store.attempts[attempt_index].quiz_id.clone();
        let definition = definition_for_bundle(&inner.store, root, &quiz_id)?.clone();
        let stale_reason = stale_reason(&definition, root)?;
        let attempt = &mut inner.store.attempts[attempt_index];
        if attempt.completed_at.is_some() {
            return Err("That quiz attempt is already complete.".to_string());
        }
        let index = attempt.answers.len() + attempt.not_important_question_ids.len();
        let expected = definition
            .artifact
            .questions
            .get(index)
            .ok_or_else(|| "That attempt has no remaining question.".to_string())?;
        if expected.id != input.question_id {
            return Err("Questions must be handled in quiz order.".to_string());
        }
        attempt
            .not_important_question_ids
            .insert(expected.id.clone());
        if attempt.answers.len() + attempt.not_important_question_ids.len()
            == definition.artifact.questions.len()
        {
            attempt.completed_at = Some(now_rfc3339()?);
        }
        persist_store(&self.store_path, &inner.store)?;
        let attempt = &inner.store.attempts[attempt_index];
        Ok(QuizAttemptView {
            summary: attempt_summary(attempt, &definition),
            next_question: public_question(&definition, attempt),
            stale: stale_reason.is_some(),
            stale_reason,
        })
    }

    pub fn results(&self, root: &Path, attempt_id: &str) -> Result<QuizResults, String> {
        let inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let attempt = inner
            .store
            .attempts
            .iter()
            .find(|attempt| attempt.attempt_id == attempt_id)
            .ok_or_else(|| "That quiz attempt does not exist.".to_string())?;
        let definition = definition_for_bundle(&inner.store, root, &attempt.quiz_id)?;
        build_results(definition, attempt, root)
    }

    pub fn delete_quiz(&self, root: &Path, quiz_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let _ = definition_for_bundle(&inner.store, root, quiz_id)?;
        inner
            .store
            .definitions
            .retain(|definition| definition.quiz_id != quiz_id);
        inner
            .store
            .attempts
            .retain(|attempt| attempt.quiz_id != quiz_id);
        persist_store(&self.store_path, &inner.store)
    }

    pub fn delete_generation_failure(&self, root: &Path, failure_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let _ = generation_failure_for_bundle(&inner.store, root, failure_id)?;
        inner
            .store
            .generation_failures
            .retain(|failure| failure.failure_id != failure_id);
        persist_store(&self.store_path, &inner.store)
    }

    pub fn delete_attempt(&self, root: &Path, attempt_id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let attempt = inner
            .store
            .attempts
            .iter()
            .find(|attempt| attempt.attempt_id == attempt_id)
            .ok_or_else(|| "That quiz attempt does not exist.".to_string())?;
        let _ = definition_for_bundle(&inner.store, root, &attempt.quiz_id)?;
        inner
            .store
            .attempts
            .retain(|candidate| candidate.attempt_id != attempt_id);
        persist_store(&self.store_path, &inner.store)
    }

    pub fn delete_bundle_history(&self, root: &Path) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        let quiz_ids = inner
            .store
            .definitions
            .iter()
            .filter(|definition| same_path(&definition.bundle_root, root))
            .map(|definition| definition.quiz_id.clone())
            .collect::<BTreeSet<_>>();
        inner
            .store
            .definitions
            .retain(|definition| !quiz_ids.contains(&definition.quiz_id));
        inner
            .store
            .attempts
            .retain(|attempt| !quiz_ids.contains(&attempt.quiz_id));
        inner
            .store
            .generation_failures
            .retain(|failure| !same_path(&failure.bundle_root, root));
        persist_store(&self.store_path, &inner.store)
    }
}

pub fn topic_candidates(root: &Path, topic: &str) -> Result<Vec<TopicCandidate>, String> {
    let topic = normalized_topic(topic)?;
    let bundle = okf_core::read_bundle(root);
    let terms = topic.split_whitespace().collect::<Vec<_>>();
    let mut candidates = Vec::new();
    for concept in &bundle.concepts {
        let path = format!("{}.md", concept.id);
        let markdown = read_concept_markdown(root, &concept.id)?;
        let fields = [
            ("title", concept.title.as_str(), 12u32),
            ("description", concept.description.as_str(), 8),
            ("type", concept.concept_type.as_str(), 7),
            ("tags", &concept.tags.join(" "), 6),
            ("headings", &headings(&concept.body), 5),
            ("body", concept.body.as_str(), 1),
        ];
        let mut score = 0u32;
        let mut reasons = Vec::new();
        for (label, value, weight) in fields {
            let normalized = normalize_search(value);
            let hits = terms
                .iter()
                .filter(|term| normalized.contains(**term))
                .count() as u32;
            if hits > 0 {
                score = score.saturating_add(hits.saturating_mul(weight));
                reasons.push(label);
            }
        }
        if score == 0 {
            continue;
        }
        candidates.push(TopicCandidate {
            concept_id: concept.id.clone(),
            title: concept.title.clone(),
            path,
            concept_type: concept.concept_type.clone(),
            tags: concept.tags.clone(),
            content_hash: evidence_content_hash(&markdown),
            bytes: markdown.len(),
            score,
            reason: format!("Matched {}", reasons.join(", ")),
        });
    }
    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.title.cmp(&right.title))
            .then_with(|| left.concept_id.cmp(&right.concept_id))
    });
    candidates.truncate(MAX_TOPIC_CANDIDATES);
    Ok(candidates)
}

#[cfg(test)]
fn git_availability(root: &Path) -> GitQuizAvailability {
    match discover_git_repository(root) {
        Ok(Some(repository)) => git_availability_for_repository(&repository),
        Ok(None) => GitQuizAvailability {
            available: false,
            repository_root: None,
            head_revision: None,
            message: "The active bundle is not inside a Git repository.".to_string(),
        },
        Err(message) => GitQuizAvailability {
            available: false,
            repository_root: None,
            head_revision: None,
            message,
        },
    }
}

pub fn git_availability_for_repository(repository: &Path) -> GitQuizAvailability {
    match git::head_revision(repository) {
        Ok(head) => GitQuizAvailability {
            available: true,
            repository_root: Some(repository.to_string_lossy().into_owned()),
            head_revision: Some(head),
            message: "Git-backed quiz scopes are available.".to_string(),
        },
        Err(_) => GitQuizAvailability {
            available: false,
            repository_root: Some(repository.to_string_lossy().into_owned()),
            head_revision: None,
            message: "The Git repository does not have a current HEAD commit.".to_string(),
        },
    }
}

pub fn discover_git_repository(root: &Path) -> Result<Option<PathBuf>, String> {
    git::discover_repository(root)
}

pub fn git_revisions(repository: &Path) -> Result<Vec<GitRevision>, String> {
    let text = git_text(
        repository,
        &[
            "log",
            "-50",
            "--format=%H%x1f%h%x1f%ct%x1f%s%x1e",
            "--no-decorate",
        ],
    )?;
    text.split('\u{1e}')
        .filter(|record| !record.trim().is_empty())
        .map(|record| {
            let fields = record
                .trim_start_matches(['\r', '\n'])
                .split('\u{1f}')
                .collect::<Vec<_>>();
            if fields.len() != 4 {
                return Err("Git returned an incomplete revision record.".to_string());
            }
            validate_revision(fields[0])?;
            Ok(GitRevision {
                id: fields[0].to_string(),
                short_id: fields[1].to_string(),
                timestamp: fields[2]
                    .parse()
                    .map_err(|_| "Git returned an invalid revision timestamp.".to_string())?,
                subject: bounded_text(fields[3], 256),
            })
        })
        .collect()
}

pub(crate) fn api_key(profile_id: &str) -> Result<zeroize::Zeroizing<String>, String> {
    keyring::Entry::new(
        "app.okfviewer.desktop",
        &format!("quiz-provider:{profile_id}"),
    )
    .map_err(|_| "OKF Reviewer could not open the operating-system credential store.".to_string())?
    .get_password()
    .map(zeroize::Zeroizing::new)
    .map_err(|_| "Authentication is required for this model API profile.".to_string())
}

fn store_api_key(profile_id: &str, secret: &str) -> Result<(), String> {
    keyring::Entry::new(
        "app.okfviewer.desktop",
        &format!("quiz-provider:{profile_id}"),
    )
    .map_err(|_| "OKF Reviewer could not open the operating-system credential store.".to_string())?
    .set_password(secret)
    .map_err(|_| "OKF Reviewer could not save the API key in the credential store.".to_string())
}

fn delete_api_key(profile_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(
        "app.okfviewer.desktop",
        &format!("quiz-provider:{profile_id}"),
    )
    .map_err(|_| {
        "OKF Reviewer could not open the operating-system credential store.".to_string()
    })?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => {
            Err("OKF Reviewer could not remove the API key from the credential store.".to_string())
        }
    }
}

fn builtin_profiles(settings: &QuizGeneratorSettings) -> Vec<QuizProviderProfile> {
    builtin_profiles_from_parts(&settings.codex_cli, &settings.claude_cli)
}

fn builtin_profiles_from_parts(
    codex: &CliGeneratorSettings,
    claude: &CliGeneratorSettings,
) -> Vec<QuizProviderProfile> {
    let mut profiles = Vec::new();
    if codex.enabled {
        profiles.push(QuizProviderProfile {
            id: "codex-cli".to_string(),
            kind: QuizProviderKind::CodexCli,
            label: "Codex CLI".to_string(),
            model: codex.model.clone(),
            endpoint: None,
            executable_path: codex.executable_path.clone(),
            reasoning_effort: codex.reasoning_effort,
            sends_content_off_device: true,
        });
    }
    if claude.enabled {
        profiles.push(QuizProviderProfile {
            id: "claude-cli".to_string(),
            kind: QuizProviderKind::ClaudeCli,
            label: "Claude Code CLI".to_string(),
            model: claude.model.clone(),
            endpoint: None,
            executable_path: claude.executable_path.clone(),
            reasoning_effort: None,
            sends_content_off_device: true,
        });
    }
    profiles
}

fn prepare_concept_scope(
    root: &Path,
    bundle: &Bundle,
    input: &PrepareQuizScopeInput,
) -> Result<PreparedScope, String> {
    if input.base_revision_id.is_some() || input.head_revision_id.is_some() {
        return Err("Revision IDs are accepted only for bundle-diff scope.".to_string());
    }
    let selected = match input.scope_mode {
        QuizScopeMode::CurrentDocument => {
            if input.concept_ids.len() != 1 {
                return Err("Current-document scope requires the open concept.".to_string());
            }
            input.concept_ids.clone()
        }
        QuizScopeMode::SelectedDocuments => input.concept_ids.clone(),
        QuizScopeMode::Topic => {
            let _ = normalized_topic(
                input
                    .topic
                    .as_deref()
                    .ok_or_else(|| "Topic scope requires a topic.".to_string())?,
            )?;
            input.concept_ids.clone()
        }
        QuizScopeMode::BundleDiff | QuizScopeMode::ReviewedSinceCommit => {
            unreachable!("Git scopes are handled separately")
        }
    };
    if selected.is_empty() || selected.len() > MAX_SELECTED_CONCEPTS {
        return Err(format!(
            "Choose between 1 and {MAX_SELECTED_CONCEPTS} bundle concepts."
        ));
    }
    let mut seen = BTreeSet::new();
    let mut sources = Vec::new();
    let mut previews = Vec::new();
    let mut total_bytes = 0usize;
    for (index, concept_id) in selected.iter().enumerate() {
        validate_concept_id(concept_id)?;
        if !seen.insert(concept_id.as_str()) {
            return Err("The reviewed concept selection contains a duplicate.".to_string());
        }
        let concept = bundle
            .concepts
            .iter()
            .find(|concept| concept.id == *concept_id)
            .ok_or_else(|| format!("Concept {concept_id} is no longer in the active bundle."))?;
        let markdown = read_concept_markdown(root, concept_id)?;
        enforce_source_size(&markdown, &mut total_bytes)?;
        let source_id = format!("source-{}", index + 1);
        let path = format!("{concept_id}.md");
        let content_hash = evidence_content_hash(&markdown);
        let reason = match input.scope_mode {
            QuizScopeMode::CurrentDocument => "Current document".to_string(),
            QuizScopeMode::SelectedDocuments => "Selected by the user".to_string(),
            QuizScopeMode::Topic => "Reviewed topic evidence".to_string(),
            QuizScopeMode::BundleDiff | QuizScopeMode::ReviewedSinceCommit => unreachable!(),
        };
        sources.push(QuizEvidenceSource {
            source_id: source_id.clone(),
            concept_id: concept.id.clone(),
            path: path.clone(),
            title: concept.title.clone(),
            concept_type: concept.concept_type.clone(),
            version: QuizEvidenceVersion::Current,
            content_hash: content_hash.clone(),
            markdown,
        });
        previews.push(QuizScopeSourcePreview {
            source_id,
            concept_id: concept.id.clone(),
            path,
            title: concept.title.clone(),
            concept_type: concept.concept_type.clone(),
            version: QuizEvidenceVersion::Current,
            content_hash,
            bytes: sources.last().expect("source").markdown.len(),
            reason,
        });
    }
    let description = match input.scope_mode {
        QuizScopeMode::CurrentDocument => format!("Current document: {}", previews[0].title),
        QuizScopeMode::SelectedDocuments => {
            format!("{} selected documents", previews.len())
        }
        QuizScopeMode::Topic => format!(
            "Topic “{}” across {} reviewed documents",
            input.topic.as_deref().unwrap_or_default().trim(),
            previews.len()
        ),
        QuizScopeMode::BundleDiff | QuizScopeMode::ReviewedSinceCommit => unreachable!(),
    };
    Ok((
        sources,
        previews,
        description,
        Vec::new(),
        "Working tree".to_string(),
    ))
}

fn prepare_diff_scope(
    root: &Path,
    repository: &Path,
    bundle: &Bundle,
    input: &PrepareQuizScopeInput,
) -> Result<PreparedScope, String> {
    let base = input
        .base_revision_id
        .as_deref()
        .ok_or_else(|| "Bundle-diff scope requires a base commit.".to_string())?;
    validate_revision(base)?;
    verify_commit(repository, base)?;
    if let Some(head) = input.head_revision_id.as_deref() {
        validate_revision(head)?;
        verify_commit(repository, head)?;
    }
    let bundle_relative = root
        .strip_prefix(repository)
        .map_err(|_| "The active bundle is outside the authorized repository.".to_string())?;
    validate_repository_relative_path(bundle_relative)?;
    let base_files = git_concept_files(repository, base, bundle_relative)?;
    if base_files.is_empty() {
        return Err("The OKF bundle did not exist at the selected base revision.".to_string());
    }
    let current_files = if let Some(head) = input.head_revision_id.as_deref() {
        git_concept_files(repository, head, bundle_relative)?
    } else {
        bundle
            .concepts
            .iter()
            .map(|concept| format!("{}.md", concept.id))
            .collect()
    };
    let all = base_files
        .union(&current_files)
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut changed = Vec::new();
    for relative in all {
        let base_text = git_optional_file(repository, base, bundle_relative, &relative)?;
        let current_text = if let Some(head) = input.head_revision_id.as_deref() {
            git_optional_file(repository, head, bundle_relative, &relative)?
        } else {
            read_optional_bundle_file(root, &relative)?
        };
        if semantic_markdown(&base_text) == semantic_markdown(&current_text) {
            continue;
        }
        changed.push((relative, base_text, current_text));
    }
    if changed.is_empty() {
        return Err("No semantic OKF concept changes were found in that comparison.".to_string());
    }
    if changed.len() > MAX_SELECTED_CONCEPTS {
        return Err(format!(
            "That comparison changes {} concepts; narrow it to at most {MAX_SELECTED_CONCEPTS}.",
            changed.len()
        ));
    }
    let mut sources = Vec::new();
    let mut previews = Vec::new();
    let mut total_bytes = 0usize;
    for (index, (path, base_text, current_text)) in changed.into_iter().enumerate() {
        let concept_id = path.trim_end_matches(".md").replace('\\', "/");
        validate_concept_id(&concept_id)?;
        let title = bundle
            .concepts
            .iter()
            .find(|concept| concept.id == concept_id)
            .map(|concept| concept.title.clone())
            .or_else(|| base_text.as_deref().and_then(first_heading))
            .unwrap_or_else(|| humanize_id(&concept_id));
        let concept_type = bundle
            .concepts
            .iter()
            .find(|concept| concept.id == concept_id)
            .map(|concept| concept.concept_type.clone())
            .or_else(|| base_text.as_deref().and_then(concept_type_from_markdown))
            .unwrap_or_else(|| "Concept".to_string());
        for (suffix, version, markdown, reason) in [
            (
                "base",
                QuizEvidenceVersion::Base,
                base_text.unwrap_or_else(|| {
                    format!("# {title}\n\n[Concept absent at base revision.]\n")
                }),
                "Base revision evidence",
            ),
            (
                "current",
                QuizEvidenceVersion::Current,
                current_text.unwrap_or_else(|| {
                    format!("# {title}\n\n[Concept deleted from current revision.]\n")
                }),
                "Head or working-tree evidence",
            ),
        ] {
            enforce_source_size(&markdown, &mut total_bytes)?;
            let source_id = format!("source-{}-{suffix}", index + 1);
            let content_hash = evidence_content_hash(&markdown);
            sources.push(QuizEvidenceSource {
                source_id: source_id.clone(),
                concept_id: concept_id.clone(),
                path: path.clone(),
                title: title.clone(),
                concept_type: concept_type.clone(),
                version,
                content_hash: content_hash.clone(),
                markdown,
            });
            previews.push(QuizScopeSourcePreview {
                source_id,
                concept_id: concept_id.clone(),
                path: path.clone(),
                title: title.clone(),
                concept_type: concept_type.clone(),
                version,
                content_hash,
                bytes: sources.last().expect("source").markdown.len(),
                reason: reason.to_string(),
            });
        }
    }
    if sources.len() > MAX_EVIDENCE_SOURCES {
        return Err("The diff evidence exceeds the 64-source limit.".to_string());
    }
    let head = input
        .head_revision_id
        .clone()
        .unwrap_or_else(|| "WORKTREE".to_string());
    Ok((
        sources,
        previews,
        format!(
            "Bundle changes from {} to {}",
            short_revision(base),
            short_revision(&head)
        ),
        Vec::new(),
        format!("{}..{}", short_revision(base), short_revision(&head)),
    ))
}

fn prepare_reviewed_since_commit_scope(
    root: &Path,
    repository: &Path,
    bundle: &Bundle,
    input: &PrepareQuizScopeInput,
) -> Result<PreparedScope, String> {
    if !input.concept_ids.is_empty() || input.topic.is_some() || input.head_revision_id.is_some() {
        return Err(
            "Reviewed-since-commit scope is selected automatically from the current worktree."
                .to_string(),
        );
    }
    let base = input.base_revision_id.as_deref().ok_or_else(|| {
        "Reviewed-since-commit scope requires the displayed HEAD commit.".to_string()
    })?;
    validate_revision(base)?;
    verify_commit(repository, base).map_err(|_| {
        "The captured base commit is no longer available. Refresh the Git scope before retrying."
            .to_string()
    })?;
    let current_head = git::head_revision(repository)?;
    if current_head != base {
        return Err(
            "HEAD changed after Git availability was checked. Refresh the quiz scope before generating."
                .to_string(),
        );
    }
    let bundle_relative = root
        .strip_prefix(repository)
        .map_err(|_| "The active bundle is outside the authorized repository.".to_string())?;
    validate_repository_relative_path(bundle_relative)?;
    let changed_lines = git::changed_line_counts(root, repository, base)?;
    let mut candidates = Vec::new();

    for concept in &bundle.concepts {
        validate_concept_id(&concept.id)?;
        let path = format!("{}.md", concept.id);
        let base_markdown = git_optional_review_document(repository, base, bundle_relative, &path)?;
        let base_reviews = human_review_counts_from_markdown(base_markdown.as_deref());
        let current_reviews = human_review_counts(&concept.verified);
        let has_new_review = current_reviews
            .iter()
            .any(|(event, count)| *count > base_reviews.get(event).copied().unwrap_or(0));
        if !has_new_review {
            continue;
        }

        let requested = root.join(&path);
        let metadata = fs::symlink_metadata(&requested)
            .map_err(|_| format!("Concept {} is no longer available.", concept.id))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Quiz evidence must be a regular Markdown file.".to_string());
        }
        let bytes = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
        let markdown = if bytes <= MAX_SOURCE_BYTES {
            Some(read_concept_markdown(root, &concept.id)?)
        } else {
            None
        };
        let score = changed_lines.get(&path).copied().unwrap_or_else(|| {
            markdown
                .as_deref()
                .map(|contents| contents.lines().count())
                .unwrap_or(0)
        });
        candidates.push(ReviewedSinceCandidate {
            concept_id: concept.id.clone(),
            path,
            title: concept.title.clone(),
            concept_type: concept.concept_type.clone(),
            markdown,
            bytes,
            changed_lines: score,
        });
    }

    if candidates.is_empty() {
        return Err(
            "No current documents contain a new human verification event since HEAD. Review a document, then refresh this scope."
                .to_string(),
        );
    }
    candidates.sort_by(|left, right| {
        right
            .changed_lines
            .cmp(&left.changed_lines)
            .then_with(|| left.path.cmp(&right.path))
    });

    let mut sources = Vec::new();
    let mut previews = Vec::new();
    let mut omitted = Vec::new();
    let mut total_bytes = 0usize;
    let base_short = short_revision(base);
    for candidate in candidates {
        let fits = sources.len() < MAX_SELECTED_CONCEPTS
            && candidate.markdown.is_some()
            && total_bytes.saturating_add(candidate.bytes) <= MAX_TOTAL_EVIDENCE_BYTES;
        if !fits {
            omitted.push(candidate.path);
            continue;
        }
        let markdown = candidate.markdown.expect("checked reviewed evidence");
        total_bytes = total_bytes.saturating_add(candidate.bytes);
        let source_id = format!("source-{}", sources.len() + 1);
        let content_hash = evidence_content_hash(&markdown);
        let reason = format!(
            "New human review since {base_short}; {} changed line{}",
            candidate.changed_lines,
            if candidate.changed_lines == 1 {
                ""
            } else {
                "s"
            }
        );
        sources.push(QuizEvidenceSource {
            source_id: source_id.clone(),
            concept_id: candidate.concept_id.clone(),
            path: candidate.path.clone(),
            title: candidate.title.clone(),
            concept_type: candidate.concept_type.clone(),
            version: QuizEvidenceVersion::Current,
            content_hash: content_hash.clone(),
            markdown,
        });
        previews.push(QuizScopeSourcePreview {
            source_id,
            concept_id: candidate.concept_id,
            path: candidate.path,
            title: candidate.title,
            concept_type: candidate.concept_type,
            version: QuizEvidenceVersion::Current,
            content_hash,
            bytes: candidate.bytes,
            reason,
        });
    }
    if sources.is_empty() {
        return Err(
            "Documents have new human reviews, but none fit the 256 KiB-per-document and 1 MiB total evidence limits."
                .to_string(),
        );
    }
    let selected_count = sources.len();

    Ok((
        sources,
        previews,
        format!(
            "{} document{} reviewed since {}",
            selected_count,
            if selected_count == 1 { "" } else { "s" },
            base_short
        ),
        omitted,
        format!("{base_short}..WORKTREE"),
    ))
}

fn human_review_counts(
    reviews: &[okf_core::model::Attribution],
) -> BTreeMap<(String, Option<String>), usize> {
    let mut counts = BTreeMap::new();
    for review in reviews
        .iter()
        .filter(|review| review.is_human() && review.at.is_some())
    {
        *counts
            .entry((review.by.clone(), review.at.clone()))
            .or_insert(0) += 1;
    }
    counts
}

fn human_review_counts_from_markdown(
    markdown: Option<&str>,
) -> BTreeMap<(String, Option<String>), usize> {
    let Some(markdown) = markdown else {
        return BTreeMap::new();
    };
    let (Some(raw), _) = okf_core::frontmatter::split(markdown) else {
        return BTreeMap::new();
    };
    let parsed = okf_core::frontmatter::parse(raw);
    let reviews = parsed
        .entries("verified")
        .into_iter()
        .filter_map(okf_core::frontmatter::ParsedFrontmatter::attribution)
        .collect::<Vec<_>>();
    human_review_counts(&reviews)
}

fn git_optional_review_document(
    repository: &Path,
    revision: &str,
    bundle_relative: &Path,
    concept_path: &str,
) -> Result<Option<String>, String> {
    validate_repository_relative_text(concept_path)?;
    let bundle = slash_path(bundle_relative)?;
    let repository_path = if bundle.is_empty() {
        concept_path.to_string()
    } else {
        format!("{bundle}/{concept_path}")
    };
    let output = git_output(
        repository,
        &["show", &format!("{revision}:{repository_path}")],
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    bounded_output(&output.stdout, "Git concept review metadata").map(Some)
}

fn validate_requested_configuration(input: &PrepareQuizScopeInput) -> Result<(), String> {
    if !(1..=MAX_QUIZ_QUESTIONS).contains(&input.generation.max_questions) {
        return Err(format!(
            "Maximum questions must be between 1 and {MAX_QUIZ_QUESTIONS}."
        ));
    }
    match input.generation.mode {
        QuizGenerationMode::Automatic => {
            if input.generation.length.is_some() || input.generation.difficulty.is_some() {
                return Err(
                    "Automatic quiz generation cannot include manual length or difficulty."
                        .to_string(),
                );
            }
        }
        QuizGenerationMode::Manual => {
            if input.generation.length.is_none() || input.generation.difficulty.is_none() {
                return Err(
                    "Manual quiz generation requires both length and difficulty.".to_string(),
                );
            }
        }
    }
    if input.scope_mode != QuizScopeMode::Topic && input.topic.is_some() {
        return Err("A topic is accepted only for topic scope.".to_string());
    }
    Ok(())
}

fn proportional_question_count(
    evidence_bytes: usize,
    length: QuizLength,
    max_questions: usize,
) -> usize {
    let bytes_per_question = match length {
        QuizLength::Short => 3 * 1024,
        QuizLength::Medium => 2 * 1024,
        QuizLength::Long => 1536,
    };
    let proportional = evidence_bytes.saturating_add(bytes_per_question - 1) / bytes_per_question;
    proportional
        .max(1)
        .min(max_questions)
        .min(MAX_QUIZ_QUESTIONS)
}

fn legacy_generation_config(
    requested_question_count: usize,
    difficulty: impl Into<Option<crate::quiz::QuizDifficulty>>,
) -> QuizGenerationConfig {
    let difficulty = difficulty
        .into()
        .unwrap_or(crate::quiz::QuizDifficulty::Applied);
    let length = match requested_question_count {
        0..=5 => QuizLength::Short,
        6..=10 => QuizLength::Medium,
        _ => QuizLength::Long,
    };
    QuizGenerationConfig {
        mode: QuizGenerationMode::Manual,
        length: Some(length),
        difficulty: Some(difficulty),
        max_questions: requested_question_count.clamp(1, MAX_QUIZ_QUESTIONS),
    }
}

fn scope_fingerprint(
    mode: QuizScopeMode,
    sources: &[QuizEvidenceSource],
    topic: Option<&str>,
    base: Option<&str>,
    head: Option<&str>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(format!("{mode:?}\0"));
    digest.update(topic.unwrap_or_default().as_bytes());
    digest.update([0]);
    digest.update(base.unwrap_or_default().as_bytes());
    digest.update([0]);
    digest.update(head.unwrap_or("WORKTREE").as_bytes());
    let mut identities = sources
        .iter()
        .map(|source| {
            format!(
                "{}\0{}\0{:?}\0{}",
                source.source_id, source.concept_id, source.version, source.content_hash
            )
        })
        .collect::<Vec<_>>();
    identities.sort();
    for identity in identities {
        digest.update(identity.as_bytes());
        digest.update([0]);
    }
    format!("sha256-{:x}", digest.finalize())
}

fn prepare_bundle_context(
    root: &Path,
    bundle: &Bundle,
    excluded: &BTreeSet<&str>,
) -> Result<Vec<FrozenBundleFile>, String> {
    let mut paths = BTreeSet::new();
    for concept in &bundle.concepts {
        validate_concept_id(&concept.id)?;
        let path = format!("{}.md", concept.id);
        if !excluded.contains(path.as_str()) {
            paths.insert(path);
        }
    }
    for index in bundle.indexes.iter().filter(|index| !index.synthesized) {
        let path = if index.dir.is_empty() {
            "index.md".to_string()
        } else {
            format!("{}/index.md", index.dir)
        };
        validate_bundle_context_path(&path)?;
        paths.insert(path);
    }
    for reserved in ["index.md", "log.md"] {
        if root.join(reserved).exists() {
            paths.insert(reserved.to_string());
        }
    }
    if paths.len() > MAX_BUNDLE_CONTEXT_FILES {
        return Err(format!(
            "The selected OKF bundle exceeds the {MAX_BUNDLE_CONTEXT_FILES}-document quiz context limit."
        ));
    }

    let canonical_root = dunce::canonicalize(root).map_err(|_| {
        "OKF Reviewer could not inspect the selected bundle for quiz context.".to_string()
    })?;
    let mut total_bytes = 0usize;
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        let contents = read_bundle_context_file(&canonical_root, &path)?;
        total_bytes = total_bytes.saturating_add(contents.len());
        if total_bytes > MAX_TOTAL_BUNDLE_CONTEXT_BYTES {
            return Err(
                "The selected OKF bundle exceeds the 4 MiB quiz context limit.".to_string(),
            );
        }
        files.push(FrozenBundleFile { path, contents });
    }
    Ok(files)
}

fn validate_bundle_context_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || !path.to_ascii_lowercase().ends_with(".md")
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("An OKF bundle context path is unsafe.".to_string());
    }
    Ok(())
}

fn read_bundle_context_file(root: &Path, relative: &str) -> Result<String, String> {
    validate_bundle_context_path(relative)?;
    let requested = root.join(relative);
    let metadata = fs::symlink_metadata(&requested)
        .map_err(|_| format!("Bundle context document {relative} is no longer available."))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Quiz bundle context must contain only regular Markdown files.".to_string());
    }
    if metadata.len() > MAX_SOURCE_BYTES as u64 {
        return Err(format!(
            "Bundle context document {relative} exceeds the 256 KiB source limit."
        ));
    }
    let canonical = dunce::canonicalize(&requested)
        .map_err(|_| format!("Bundle context document {relative} is no longer available."))?;
    if !canonical.starts_with(root) {
        return Err("A quiz bundle context path escaped the selected bundle.".to_string());
    }
    fs::read_to_string(canonical)
        .map_err(|_| format!("Bundle context document {relative} is not valid UTF-8 Markdown."))
}

fn read_concept_markdown(root: &Path, concept_id: &str) -> Result<String, String> {
    validate_concept_id(concept_id)?;
    let requested = root.join(format!("{concept_id}.md"));
    let metadata = fs::symlink_metadata(&requested)
        .map_err(|_| format!("Concept {concept_id} is no longer available."))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Quiz evidence must be a regular Markdown file.".to_string());
    }
    if metadata.len() > MAX_SOURCE_BYTES as u64 {
        return Err(format!(
            "Concept {concept_id} exceeds the 256 KiB source limit."
        ));
    }
    let canonical = dunce::canonicalize(&requested)
        .map_err(|_| format!("Concept {concept_id} is no longer available."))?;
    if !canonical.starts_with(root) {
        return Err("A quiz evidence path escaped the active bundle.".to_string());
    }
    fs::read_to_string(canonical)
        .map_err(|_| format!("Concept {concept_id} is not valid UTF-8 Markdown."))
}

fn read_optional_bundle_file(root: &Path, relative: &str) -> Result<Option<String>, String> {
    let id = relative.trim_end_matches(".md");
    let path = root.join(relative);
    if !path.exists() {
        return Ok(None);
    }
    read_concept_markdown(root, id).map(Some)
}

fn validate_concept_id(concept_id: &str) -> Result<(), String> {
    if concept_id.is_empty()
        || concept_id.len() > 512
        || concept_id.contains('\\')
        || concept_id.ends_with(".md")
        || concept_id.chars().any(char::is_control)
        || Path::new(concept_id)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || matches!(
            Path::new(concept_id)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase()
                .as_str(),
            "index" | "log"
        )
    {
        return Err("Quiz concept IDs must be safe bundle-relative identifiers.".to_string());
    }
    Ok(())
}

fn enforce_source_size(markdown: &str, total: &mut usize) -> Result<(), String> {
    if markdown.is_empty() || markdown.len() > MAX_SOURCE_BYTES {
        return Err("A selected concept is empty or exceeds 256 KiB.".to_string());
    }
    *total = total.saturating_add(markdown.len());
    if *total > MAX_TOTAL_EVIDENCE_BYTES {
        return Err(
            "The reviewed evidence exceeds the 1 MiB context limit. Remove documents and try again."
                .to_string(),
        );
    }
    Ok(())
}

fn normalized_topic(topic: &str) -> Result<String, String> {
    let normalized = normalize_search(topic);
    if normalized.is_empty() || normalized.chars().count() > MAX_TOPIC_CHARS {
        return Err("Topic must be non-empty and at most 512 characters.".to_string());
    }
    Ok(normalized)
}

fn normalize_search(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character.to_lowercase().collect::<String>()
            } else {
                " ".to_string()
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn headings(body: &str) -> String {
    body.lines()
        .filter_map(|line| line.trim_start().strip_prefix('#'))
        .map(|heading| heading.trim_start_matches('#').trim())
        .filter(|heading| !heading.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn validate_revision(revision: &str) -> Result<(), String> {
    if !(7..=64).contains(&revision.len()) || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(
            "Git revisions must be full or abbreviated hexadecimal commit IDs.".to_string(),
        );
    }
    Ok(())
}

fn verify_commit(repository: &Path, revision: &str) -> Result<(), String> {
    let output = git_output(
        repository,
        &["cat-file", "-e", &format!("{revision}^{{commit}}")],
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err("The requested Git commit is unavailable.".to_string())
    }
}

fn git_concept_files(
    repository: &Path,
    revision: &str,
    bundle_relative: &Path,
) -> Result<BTreeSet<String>, String> {
    let bundle_argument = slash_path(bundle_relative)?;
    let text = git_text(
        repository,
        &[
            "ls-tree",
            "-r",
            "--name-only",
            revision,
            "--",
            &bundle_argument,
        ],
    )?;
    let prefix = if bundle_argument.is_empty() {
        String::new()
    } else {
        format!("{bundle_argument}/")
    };
    let mut files = BTreeSet::new();
    for repository_path in text.lines().filter(|line| !line.trim().is_empty()) {
        let relative = repository_path
            .strip_prefix(&prefix)
            .ok_or_else(|| "Git returned a path outside the active bundle.".to_string())?;
        if is_concept_markdown(relative) {
            validate_repository_relative_text(relative)?;
            files.insert(relative.to_string());
        }
    }
    Ok(files)
}

fn git_optional_file(
    repository: &Path,
    revision: &str,
    bundle_relative: &Path,
    concept_path: &str,
) -> Result<Option<String>, String> {
    validate_repository_relative_text(concept_path)?;
    let bundle = slash_path(bundle_relative)?;
    let repository_path = if bundle.is_empty() {
        concept_path.to_string()
    } else {
        format!("{bundle}/{concept_path}")
    };
    let output = git_output(
        repository,
        &["show", &format!("{revision}:{repository_path}")],
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    let text = bounded_output(&output.stdout, "Git concept content")?;
    if text.len() > MAX_SOURCE_BYTES {
        return Err("A Git concept version exceeds the 256 KiB source limit.".to_string());
    }
    Ok(Some(text))
}

fn git_output(directory: &Path, args: &[&str]) -> Result<Output, String> {
    git::output_with_safe_directory(directory, directory, args)
}

fn git_text(directory: &Path, args: &[&str]) -> Result<String, String> {
    git::text_with_safe_directory(directory, directory, args)
}

fn bounded_output(bytes: &[u8], label: &str) -> Result<String, String> {
    git::bounded_output(bytes, label)
}

fn validate_repository_relative_path(path: &Path) -> Result<(), String> {
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("The bundle path must stay inside the authorized repository.".to_string());
    }
    Ok(())
}

fn validate_repository_relative_text(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || Path::new(path).is_absolute()
        || Path::new(path).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            ) || matches!(component, Component::Normal(value) if value.eq_ignore_ascii_case(".git"))
        })
    {
        return Err("Git paths must remain bounded and inside the bundle.".to_string());
    }
    Ok(())
}

fn slash_path(path: &Path) -> Result<String, String> {
    validate_repository_relative_path(path)?;
    path.to_str()
        .map(|path| path.replace('\\', "/"))
        .ok_or_else(|| "The bundle path is not valid UTF-8.".to_string())
}

fn is_concept_markdown(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".md")
        && !matches!(
            Path::new(&lower)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default(),
            "index.md" | "log.md"
        )
}

fn semantic_markdown(value: &Option<String>) -> Option<String> {
    value.as_ref().map(|text| {
        text.replace("\r\n", "\n")
            .replace('\r', "\n")
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string()
    })
}

fn first_heading(markdown: &str) -> Option<String> {
    markdown
        .lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .filter(|heading| !heading.is_empty())
        .map(ToString::to_string)
}

fn concept_type_from_markdown(markdown: &str) -> Option<String> {
    let normalized = markdown.replace("\r\n", "\n");
    if !normalized.starts_with("---\n") {
        return None;
    }
    let end = normalized[4..].find("\n---\n")? + 4;
    let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(&normalized[4..end]).ok()?;
    value
        .get("type")
        .and_then(serde_yaml_ng::Value::as_str)
        .map(ToString::to_string)
}

fn humanize_id(id: &str) -> String {
    id.rsplit('/')
        .next()
        .unwrap_or(id)
        .replace(['-', '_'], " ")
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn short_revision(revision: &str) -> String {
    if revision == "WORKTREE" {
        revision.to_string()
    } else {
        revision.chars().take(8).collect()
    }
}

fn validate_api_endpoint(endpoint: &str) -> Result<String, String> {
    if endpoint.len() > 2048 {
        return Err("Model API endpoints must be at most 2,048 characters.".to_string());
    }
    let url = url::Url::parse(endpoint.trim())
        .map_err(|_| "Model API endpoint is not a valid URL.".to_string())?;
    let loopback = api_endpoint_is_loopback(url.as_str());
    if !matches!(url.scheme(), "https" | "http")
        || (url.scheme() != "https" && !loopback)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.fragment().is_some()
    {
        return Err(
            "Model API endpoints require a credential-free HTTPS URL, except for literal loopback HTTP endpoints."
                .to_string(),
        );
    }
    Ok(url.to_string())
}

fn api_endpoint_is_loopback(endpoint: &str) -> bool {
    let Ok(url) = url::Url::parse(endpoint) else {
        return false;
    };
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn validate_profile_text(name: &str, value: &str, maximum: usize) -> Result<(), String> {
    if value.trim().is_empty()
        || value.chars().count() > maximum
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "{name} must be non-empty and at most {maximum} characters."
        ));
    }
    Ok(())
}

fn validate_cli_generator_settings(
    label: &str,
    settings: &CliGeneratorSettings,
) -> Result<(), String> {
    if let Some(model) = settings.model.as_deref() {
        validate_profile_text(&format!("{label} model"), model, 200)?;
        if model.chars().any(|character| {
            !(character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':' | '/'))
        }) {
            return Err(format!("{label} model identifier is invalid."));
        }
    }
    if let Some(path) = settings.executable_path.as_deref() {
        if path.trim().is_empty() || path.chars().any(char::is_control) {
            return Err(format!("{label} executable path is invalid."));
        }
        let candidate = Path::new(path);
        if !candidate.is_absolute() {
            return Err(format!("{label} executable path must be absolute."));
        }
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic()
                || (index > 0 && (byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')))
        })
    {
        return Err(format!("{label} is invalid."));
    }
    Ok(())
}

fn now_rfc3339() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| "OKF Reviewer could not format the current time.".to_string())
}

fn same_path(stored: &str, root: &Path) -> bool {
    dunce::simplified(Path::new(stored)) == dunce::simplified(root)
}

fn definition_for_bundle<'a>(
    store: &'a QuizStore,
    root: &Path,
    quiz_id: &str,
) -> Result<&'a StoredQuizDefinition, String> {
    store
        .definitions
        .iter()
        .find(|definition| {
            definition.quiz_id == quiz_id && same_path(&definition.bundle_root, root)
        })
        .ok_or_else(|| "That quiz does not belong to the active bundle.".to_string())
}

fn generation_failure_for_bundle<'a>(
    store: &'a QuizStore,
    root: &Path,
    failure_id: &str,
) -> Result<&'a StoredQuizGenerationFailure, String> {
    store
        .generation_failures
        .iter()
        .find(|failure| failure.failure_id == failure_id && same_path(&failure.bundle_root, root))
        .ok_or_else(|| {
            "That failed quiz generation does not belong to the active bundle.".to_string()
        })
}

fn generation_failure_summary(
    failure: &StoredQuizGenerationFailure,
) -> QuizGenerationFailureSummary {
    QuizGenerationFailureSummary {
        failure_id: failure.failure_id.clone(),
        scope_mode: failure.retry_input.scope_mode,
        scope_description: failure.scope_description.clone(),
        provider_kind: failure.provider_kind,
        provider_profile: failure.provider_profile.clone(),
        model: failure.model.clone(),
        failed_at: failure.failed_at.clone(),
        failure_kind: failure.failure_kind,
        message: failure.message.clone(),
        retry_count: failure.retry_count,
        generation: failure.retry_input.generation,
    }
}

fn quiz_summary(
    definition: &StoredQuizDefinition,
    attempts: &[StoredAttempt],
    root: &Path,
) -> Result<QuizSummary, String> {
    let relevant = attempts
        .iter()
        .filter(|attempt| attempt.quiz_id == definition.quiz_id)
        .collect::<Vec<_>>();
    let latest = relevant.iter().max_by_key(|attempt| &attempt.started_at);
    let latest_score = latest.map(|attempt| {
        attempt
            .answers
            .values()
            .filter(|answer| answer.correct)
            .count() as u32
    });
    let latest_total = latest.map(|attempt| attempt.answers.len() as u32);
    let stale_reason = stale_reason(definition, root)?;
    Ok(QuizSummary {
        quiz_id: definition.quiz_id.clone(),
        title: definition.artifact.title.clone(),
        scope_mode: definition.request.scope_mode,
        scope_description: definition.scope_description.clone(),
        provider_kind: definition.provider_kind,
        provider_profile: definition.provider_profile.clone(),
        model: definition.model.clone(),
        generated_at: definition.generated_at.clone(),
        question_count: definition.artifact.questions.len(),
        attempt_count: relevant.len(),
        latest_score,
        latest_total,
        stale: stale_reason.is_some(),
        stale_reason,
    })
}

fn stale_reason(definition: &StoredQuizDefinition, root: &Path) -> Result<Option<String>, String> {
    if definition.artifact.schema_version != QUIZ_SCHEMA_VERSION {
        return Ok(Some(
            "This quiz uses an unsupported schema version.".to_string(),
        ));
    }
    for source in &definition.request.evidence_sources {
        if source_changed(root, &definition.request, source)? {
            return Ok(Some(format!(
                "{} changed after this quiz was generated.",
                source.title
            )));
        }
    }
    Ok(None)
}

pub(crate) fn frozen_run_stale_reason(run: &FrozenQuizRun) -> Result<Option<String>, String> {
    for source in &run.packet.request.evidence_sources {
        if source_changed(&run.bundle_root, &run.packet.request, source)? {
            return Ok(Some(format!(
                "{} changed after the evidence packet was frozen.",
                source.title
            )));
        }
    }
    Ok(None)
}

fn source_changed(
    root: &Path,
    request: &QuizGenerationRequest,
    source: &QuizEvidenceSource,
) -> Result<bool, String> {
    if request.scope_mode != QuizScopeMode::BundleDiff {
        if source.version != QuizEvidenceVersion::Current {
            return Ok(true);
        }
        return Ok(read_optional_bundle_file(root, &source.path)?
            .map(|markdown| evidence_content_hash(&markdown) != source.content_hash)
            .unwrap_or(true));
    }

    let revision = match source.version {
        QuizEvidenceVersion::Base => request.base_revision_id.as_deref(),
        QuizEvidenceVersion::Current => request.head_revision_id.as_deref(),
    }
    .ok_or_else(|| "The historical Git scope can no longer be reproduced.".to_string())?;

    let content = if revision == "WORKTREE" {
        read_optional_bundle_file(root, &source.path)?
    } else {
        let repository = discover_git_repository(root)?
            .or_else(|| git::repository_candidate(root).ok().flatten())
            .ok_or_else(|| "The historical Git scope can no longer be reproduced.".to_string())?;
        verify_commit(&repository, revision)
            .map_err(|_| "The historical Git scope can no longer be reproduced.".to_string())?;
        let bundle_relative = root
            .strip_prefix(&repository)
            .map_err(|_| "The active bundle is outside its Git repository.".to_string())?;
        git_optional_file(&repository, revision, bundle_relative, &source.path)?
    };
    let absent_marker = match source.version {
        QuizEvidenceVersion::Base => "[Concept absent at base revision.]",
        QuizEvidenceVersion::Current => "[Concept deleted from current revision.]",
    };
    match content {
        Some(markdown) => Ok(evidence_content_hash(&markdown) != source.content_hash),
        None => Ok(!source.markdown.contains(absent_marker)),
    }
}

fn attempt_summary(
    attempt: &StoredAttempt,
    definition: &StoredQuizDefinition,
) -> QuizAttemptSummary {
    QuizAttemptSummary {
        attempt_id: attempt.attempt_id.clone(),
        quiz_id: attempt.quiz_id.clone(),
        started_at: attempt.started_at.clone(),
        completed_at: attempt.completed_at.clone(),
        answered: attempt.answers.len(),
        excluded: attempt.not_important_question_ids.len(),
        total: definition.artifact.questions.len(),
        correct: attempt
            .answers
            .values()
            .filter(|answer| answer.correct)
            .count(),
    }
}

fn public_question(
    definition: &StoredQuizDefinition,
    attempt: &StoredAttempt,
) -> Option<PublicQuizQuestion> {
    let index = attempt.answers.len() + attempt.not_important_question_ids.len();
    let question = definition.artifact.questions.get(index)?;
    Some(PublicQuizQuestion {
        attempt_id: attempt.attempt_id.clone(),
        quiz_id: definition.quiz_id.clone(),
        question_id: question.id.clone(),
        index,
        total: definition.artifact.questions.len(),
        category: question.category,
        criticality: question.criticality,
        prompt: question.prompt.clone(),
        choices: question.choices.clone(),
        already_answered: false,
    })
}

fn resolve_evidence(
    definition: &StoredQuizDefinition,
    question: &crate::quiz::QuizQuestion,
) -> Result<Vec<ResolvedQuizEvidence>, String> {
    question
        .evidence
        .iter()
        .map(|evidence| {
            let source = definition
                .request
                .evidence_sources
                .iter()
                .find(|source| source.source_id == evidence.source_id)
                .ok_or_else(|| "Stored quiz evidence is no longer resolvable.".to_string())?;
            Ok(ResolvedQuizEvidence {
                source_id: source.source_id.clone(),
                concept_id: source.concept_id.clone(),
                title: source.title.clone(),
                path: source.path.clone(),
                version: source.version,
                heading: evidence.heading.clone(),
                quote: evidence.quote.clone(),
            })
        })
        .collect()
}

fn build_results(
    definition: &StoredQuizDefinition,
    attempt: &StoredAttempt,
    root: &Path,
) -> Result<QuizResults, String> {
    let mut categories = BTreeMap::<String, (QuizQuestionCategory, u32, u32)>::new();
    let mut critical_correct = 0u32;
    let mut critical_total = 0u32;
    let mut incorrect = Vec::new();
    let mut excluded = Vec::new();
    for question in &definition.artifact.questions {
        if attempt.not_important_question_ids.contains(&question.id) {
            excluded.push(QuizExcludedQuestion {
                question_id: question.id.clone(),
                prompt: question.prompt.clone(),
                category: question.category,
                criticality: question.criticality,
            });
            continue;
        }
        let key = format!("{:?}", question.category);
        let entry = categories.entry(key).or_insert((question.category, 0, 0));
        entry.2 += 1;
        let answer = attempt.answers.get(&question.id);
        if question.criticality == QuizCriticality::Critical {
            critical_total += 1;
        }
        if answer.is_some_and(|answer| answer.correct) {
            entry.1 += 1;
            if question.criticality == QuizCriticality::Critical {
                critical_correct += 1;
            }
        } else if let Some(answer) = answer {
            incorrect.push(QuizIncorrectAnswer {
                question_id: question.id.clone(),
                prompt: question.prompt.clone(),
                selected_choice_id: answer.selected_choice_id.clone(),
                correct_choice_id: question.correct_choice_id.clone(),
                explanation: question.explanation.clone(),
                evidence: resolve_evidence(definition, question)?,
            });
        }
    }
    let correct = attempt
        .answers
        .values()
        .filter(|answer| answer.correct)
        .count() as u32;
    let stale_reason = stale_reason(definition, root)?;
    Ok(QuizResults {
        attempt_id: attempt.attempt_id.clone(),
        quiz_id: definition.quiz_id.clone(),
        title: definition.artifact.title.clone(),
        correct,
        total: attempt.answers.len() as u32,
        critical_correct,
        critical_total,
        critical_gap: critical_correct < critical_total,
        stale: stale_reason.is_some(),
        stale_reason,
        completed_at: attempt.completed_at.clone(),
        by_category: categories
            .into_values()
            .map(|(category, correct, total)| QuizCategoryResult {
                category,
                correct,
                total,
            })
            .collect(),
        incorrect_answers: incorrect,
        excluded_questions: excluded,
    })
}

fn enforce_retention(store: &mut QuizStore) {
    let _ = enforce_retention_at(store, OffsetDateTime::now_utc());
}

fn enforce_retention_at(store: &mut QuizStore, now: OffsetDateTime) -> bool {
    let before = (
        store.definitions.len(),
        store.attempts.len(),
        store.generation_failures.len(),
    );
    let cutoff = now - TimeDuration::days(QUIZ_RETENTION_DAYS);
    store
        .definitions
        .retain(|definition| !timestamp_is_before(&definition.generated_at, cutoff));
    store
        .generation_failures
        .retain(|failure| !timestamp_is_before(&failure.failed_at, cutoff));
    let retained_quiz_ids = store
        .definitions
        .iter()
        .map(|definition| definition.quiz_id.as_str())
        .collect::<BTreeSet<_>>();
    store
        .attempts
        .retain(|attempt| retained_quiz_ids.contains(attempt.quiz_id.as_str()));

    while store.generation_failures.len() > MAX_GENERATION_FAILURES {
        if let Some(oldest) = store
            .generation_failures
            .iter()
            .enumerate()
            .min_by_key(|(_, failure)| &failure.failed_at)
            .map(|(index, _)| index)
        {
            store.generation_failures.remove(oldest);
        } else {
            break;
        }
    }
    while store.definitions.len() > MAX_QUIZZES {
        if let Some(oldest) = store
            .definitions
            .iter()
            .enumerate()
            .min_by_key(|(_, definition)| &definition.generated_at)
            .map(|(index, definition)| (index, definition.quiz_id.clone()))
        {
            store.definitions.remove(oldest.0);
            store.attempts.retain(|attempt| attempt.quiz_id != oldest.1);
        } else {
            break;
        }
    }
    let quiz_ids = store
        .definitions
        .iter()
        .map(|definition| definition.quiz_id.clone())
        .collect::<Vec<_>>();
    for quiz_id in quiz_ids {
        let mut indexes = store
            .attempts
            .iter()
            .enumerate()
            .filter(|(_, attempt)| attempt.quiz_id == quiz_id)
            .map(|(index, attempt)| (index, attempt.started_at.clone()))
            .collect::<Vec<_>>();
        indexes.sort_by(|left, right| right.1.cmp(&left.1));
        for (index, _) in indexes.into_iter().skip(MAX_ATTEMPTS_PER_QUIZ).rev() {
            store.attempts.remove(index);
        }
    }
    before
        != (
            store.definitions.len(),
            store.attempts.len(),
            store.generation_failures.len(),
        )
}

fn timestamp_is_before(value: &str, cutoff: OffsetDateTime) -> bool {
    OffsetDateTime::parse(value, &Rfc3339).is_ok_and(|timestamp| timestamp < cutoff)
}

fn load_store(path: &Path) -> Result<QuizStore, String> {
    load_store_at(path, OffsetDateTime::now_utc())
}

fn load_store_at(path: &Path, now: OffsetDateTime) -> Result<QuizStore, String> {
    if !path.exists() {
        return Ok(QuizStore::default());
    }
    let metadata = fs::metadata(path)
        .map_err(|_| "OKF Reviewer could not inspect stored quiz history.".to_string())?;
    if metadata.len() > STORE_MAX_BYTES {
        quarantine_store(path)?;
        return Ok(QuizStore::default());
    }
    let bytes = fs::read(path)
        .map_err(|_| "OKF Reviewer could not read stored quiz history.".to_string())?;
    let mut store: QuizStore = match serde_json::from_slice(&bytes) {
        Ok(store) => store,
        Err(_) => {
            quarantine_store(path)?;
            return Ok(QuizStore::default());
        }
    };
    let migrated = match store.schema_version {
        STORE_SCHEMA_VERSION => false,
        LEGACY_STORE_SCHEMA_VERSION => {
            store.schema_version = STORE_SCHEMA_VERSION;
            true
        }
        _ => {
            quarantine_store(path)?;
            return Ok(QuizStore::default());
        }
    };
    if validate_store(&store).is_err() {
        quarantine_store(path)?;
        return Ok(QuizStore::default());
    }
    let retention_changed = enforce_retention_at(&mut store, now);
    if migrated || retention_changed {
        persist_store(path, &store)?;
    }
    Ok(store)
}

fn load_generator_settings(path: &Path) -> Result<QuizGeneratorSettings, String> {
    if !path.exists() {
        return Ok(QuizGeneratorSettings::default());
    }
    let settings = read_generator_settings(path)?;
    validate_generator_settings(&settings)?;
    Ok(settings)
}

fn load_generator_settings_for_startup(
    path: &Path,
) -> Result<(QuizGeneratorSettings, bool), String> {
    if !path.exists() {
        return Ok((QuizGeneratorSettings::default(), false));
    }
    let mut settings = read_generator_settings(path)?;
    let migrated = match settings.schema_version {
        GENERATOR_SETTINGS_SCHEMA_VERSION => false,
        LEGACY_GENERATOR_SETTINGS_SCHEMA_VERSION => {
            settings.schema_version = GENERATOR_SETTINGS_SCHEMA_VERSION;
            if settings.codex_cli.model.as_deref().is_none()
                || settings.codex_cli.model.as_deref() == Some("5.6")
            {
                settings.codex_cli.model = Some(DEFAULT_CODEX_MODEL.to_string());
            }
            if settings.codex_cli.reasoning_effort.is_none() {
                settings.codex_cli.reasoning_effort = Some(CodexReasoningEffort::High);
            }
            true
        }
        _ => {
            return Err("Generator settings use an unsupported schema.".to_string());
        }
    };
    validate_generator_settings(&settings)?;
    Ok((settings, migrated))
}

fn read_generator_settings(path: &Path) -> Result<QuizGeneratorSettings, String> {
    let metadata = fs::metadata(path)
        .map_err(|_| "OKF Reviewer could not inspect generator settings.".to_string())?;
    if metadata.len() > GENERATOR_SETTINGS_MAX_BYTES {
        return Err("Generator settings exceed their storage limit.".to_string());
    }
    let bytes = fs::read(path)
        .map_err(|_| "OKF Reviewer could not read generator settings.".to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "Generator settings are malformed and were not changed.".to_string())
}

fn validate_generator_settings(settings: &QuizGeneratorSettings) -> Result<(), String> {
    if settings.schema_version != GENERATOR_SETTINGS_SCHEMA_VERSION
        || settings.api_profiles.len() > 20
    {
        return Err("Generator settings use an unsupported or oversized schema.".to_string());
    }
    validate_identifier(&settings.revision, "generator settings revision")?;
    validate_cli_generator_settings("Codex CLI", &settings.codex_cli)?;
    validate_cli_generator_settings("Claude Code CLI", &settings.claude_cli)?;
    if settings.claude_cli.reasoning_effort.is_some() {
        return Err(
            "Stored Claude Code settings contain unsupported reasoning effort.".to_string(),
        );
    }
    let mut ids = BTreeSet::new();
    for profile in &settings.api_profiles {
        validate_identifier(&profile.id, "profile ID")?;
        if !ids.insert(profile.id.as_str())
            || profile.kind != QuizProviderKind::ModelApi
            || profile.executable_path.is_some()
            || profile.reasoning_effort.is_some()
            || profile
                .endpoint
                .as_deref()
                .map(validate_api_endpoint)
                .transpose()?
                .is_none()
        {
            return Err("Stored model API profile is invalid.".to_string());
        }
    }
    if settings.default_profile_id.as_ref().is_some_and(|id| {
        !builtin_profiles(settings)
            .iter()
            .any(|profile| &profile.id == id)
            && !settings
                .api_profiles
                .iter()
                .any(|profile| &profile.id == id)
    }) {
        return Err("The default generator profile is unavailable.".to_string());
    }
    Ok(())
}

fn ensure_generator_revision(path: &Path, expected: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let current = load_generator_settings(path)?;
    if current.revision != expected {
        return Err(
            "Generator settings changed outside this window. Reload Settings and try again."
                .to_string(),
        );
    }
    Ok(())
}

fn persist_generator_settings(path: &Path, settings: &QuizGeneratorSettings) -> Result<(), String> {
    validate_generator_settings(settings)?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|_| "OKF Reviewer could not encode generator settings.".to_string())?;
    if bytes.len() as u64 > GENERATOR_SETTINGS_MAX_BYTES {
        return Err("Generator settings exceed their storage limit.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Generator settings have no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "OKF Reviewer could not create user configuration storage.".to_string())?;
    let temporary = parent.join(format!(".quiz-generators-{}.tmp", Uuid::new_v4()));
    let mut file = File::create(&temporary)
        .map_err(|_| "OKF Reviewer could not create temporary generator settings.".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "OKF Reviewer could not flush generator settings.".to_string())?;
    drop(file);
    replace_store_file(&temporary, path)?;
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn validate_store(store: &QuizStore) -> Result<(), String> {
    if store.schema_version != STORE_SCHEMA_VERSION
        || store.definitions.len() > MAX_QUIZZES
        || store.generation_failures.len() > MAX_GENERATION_FAILURES
        || store.api_profiles.len() > 20
    {
        return Err("Stored quiz history uses an unsupported or oversized schema.".to_string());
    }
    let mut quiz_ids = BTreeSet::new();
    let mut attempt_ids = BTreeSet::new();
    for definition in &store.definitions {
        validate_identifier(&definition.quiz_id, "quiz ID")?;
        if !quiz_ids.insert(definition.quiz_id.as_str())
            || OffsetDateTime::parse(&definition.generated_at, &Rfc3339).is_err()
            || definition.artifact.schema_version != QUIZ_SCHEMA_VERSION
            || definition.artifact.status != crate::quiz::QuizArtifactStatus::Ready
            || definition.artifact.request_id != definition.request.request_id
            || definition.artifact.bundle_fingerprint != definition.request.bundle_fingerprint
            || definition.artifact.scope_fingerprint != definition.request.scope_fingerprint
        {
            return Err("Stored quiz definition is inconsistent.".to_string());
        }
        let raw_output = serde_json::to_string(&definition.artifact)
            .map_err(|_| "Stored quiz definition could not be re-encoded.".to_string())?;
        let current_state = crate::quiz::QuizObservedState {
            bundle_fingerprint: definition.request.bundle_fingerprint.clone(),
            scope_fingerprint: definition.request.scope_fingerprint.clone(),
            sources: definition
                .request
                .evidence_sources
                .iter()
                .map(|source| crate::quiz::QuizObservedSource {
                    source_id: source.source_id.clone(),
                    content_hash: source.content_hash.clone(),
                })
                .collect(),
        };
        if !matches!(
            crate::quiz::validate_output(&crate::quiz::QuizValidationInput {
                request: definition.request.clone(),
                current_state,
                raw_output: Some(raw_output),
            }),
            crate::quiz::QuizValidation::Ready { .. }
        ) {
            return Err("Stored quiz definition failed trusted validation.".to_string());
        }
    }
    for attempt in &store.attempts {
        validate_identifier(&attempt.attempt_id, "attempt ID")?;
        if !attempt_ids.insert(attempt.attempt_id.as_str())
            || !quiz_ids.contains(attempt.quiz_id.as_str())
            || OffsetDateTime::parse(&attempt.started_at, &Rfc3339).is_err()
            || attempt
                .completed_at
                .as_deref()
                .is_some_and(|completed_at| OffsetDateTime::parse(completed_at, &Rfc3339).is_err())
        {
            return Err("Stored quiz attempt is inconsistent.".to_string());
        }
        let definition = store
            .definitions
            .iter()
            .find(|definition| definition.quiz_id == attempt.quiz_id)
            .expect("quiz ID checked");
        let handled_count = attempt.answers.len() + attempt.not_important_question_ids.len();
        let handled_question_ids = attempt
            .answers
            .keys()
            .chain(attempt.not_important_question_ids.iter())
            .collect::<BTreeSet<_>>();
        if handled_count > definition.artifact.questions.len()
            || handled_question_ids.len() != handled_count
            || definition
                .artifact
                .questions
                .iter()
                .enumerate()
                .any(|(index, question)| {
                    handled_question_ids.contains(&question.id) != (index < handled_count)
                })
            || attempt.answers.iter().any(|(question_id, answer)| {
                definition
                    .artifact
                    .questions
                    .iter()
                    .find(|question| question.id == *question_id)
                    .is_none_or(|question| {
                        !question
                            .choices
                            .iter()
                            .any(|choice| choice.id == answer.selected_choice_id)
                            || answer.correct
                                != (answer.selected_choice_id == question.correct_choice_id)
                    })
            })
        {
            return Err("Stored quiz answer is inconsistent.".to_string());
        }
    }
    let mut failure_ids = BTreeSet::new();
    for failure in &store.generation_failures {
        validate_identifier(&failure.failure_id, "generation failure ID")?;
        validate_identifier(&failure.provider_profile, "provider profile ID")?;
        validate_requested_configuration(&failure.retry_input)?;
        validate_profile_text("failure message", &failure.message, 1_000)?;
        if !failure_ids.insert(failure.failure_id.as_str())
            || !same_path(
                &failure.bundle_root,
                Path::new(&failure.retry_input.bundle_root),
            )
            || failure.scope_description.trim().is_empty()
            || failure.scope_description.len() > 1_000
            || OffsetDateTime::parse(&failure.failed_at, &Rfc3339).is_err()
        {
            return Err("Stored quiz generation failure is inconsistent.".to_string());
        }
    }
    for profile in &store.api_profiles {
        validate_identifier(&profile.id, "profile ID")?;
        if profile.kind != QuizProviderKind::ModelApi
            || profile
                .endpoint
                .as_deref()
                .map(validate_api_endpoint)
                .transpose()?
                .is_none()
        {
            return Err("Stored model API profile is invalid.".to_string());
        }
    }
    Ok(())
}

fn persist_store(path: &Path, store: &QuizStore) -> Result<(), String> {
    validate_store(store)?;
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|_| "OKF Reviewer could not encode quiz history.".to_string())?;
    if bytes.len() as u64 > STORE_MAX_BYTES {
        return Err("Quiz history exceeds the 20 MiB storage limit.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Quiz storage has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "OKF Reviewer could not create quiz storage.".to_string())?;
    let temporary = parent.join(format!(".quiz-store-{}.tmp", Uuid::new_v4()));
    let mut file = File::create(&temporary)
        .map_err(|_| "OKF Reviewer could not create temporary quiz storage.".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "OKF Reviewer could not flush temporary quiz storage.".to_string())?;
    drop(file);
    replace_store_file(&temporary, path)?;
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

fn quarantine_store(path: &Path) -> Result<(), String> {
    let quarantine = path.with_extension(format!("corrupt-{}.json", Uuid::new_v4()));
    fs::rename(path, quarantine)
        .map_err(|_| "Stored quiz history is corrupt and could not be quarantined.".to_string())
}

fn cleanup_abandoned_workspaces(cache_root: &Path) -> Result<(), String> {
    if !cache_root.exists() {
        return Ok(());
    }
    let canonical = dunce::canonicalize(cache_root)
        .map_err(|_| "OKF Reviewer could not inspect quiz generation cache.".to_string())?;
    for entry in fs::read_dir(&canonical)
        .map_err(|_| "OKF Reviewer could not inspect quiz generation cache.".to_string())?
        .flatten()
    {
        let path = entry.path();
        if path.is_dir() && path.starts_with(&canonical) {
            fs::remove_dir_all(path).map_err(|_| {
                "OKF Reviewer could not clean an abandoned quiz generation workspace.".to_string()
            })?;
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_store_file(temporary: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temporary, target)
        .map_err(|_| "OKF Reviewer could not atomically replace quiz history.".to_string())
}

#[cfg(windows)]
fn replace_store_file(temporary: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    if !target.exists() {
        return fs::rename(temporary, target)
            .map_err(|_| "OKF Reviewer could not install quiz history.".to_string());
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }
    let target_wide = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both buffers are NUL-terminated for the duration of the call.
    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            temporary_wide.as_ptr(),
            ptr::null(),
            0x0000_0001,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if replaced == 0 {
        let _ = fs::remove_file(temporary);
        Err("OKF Reviewer could not atomically replace quiz history.".to_string())
    } else {
        Ok(())
    }
}

fn bounded_text(value: &str, maximum: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(maximum)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiz::{
        QuizArtifactStatus, QuizChoice, QuizEvidenceReference, QuizQuestion, QuizQuestionCategory,
    };
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn git(directory: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(directory)
            .args(args)
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    struct Fixture {
        root: PathBuf,
        runtime: QuizRuntimeState,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "okf-review-quiz-runtime-{name}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(root.join("docs/features")).expect("fixture dirs");
            fs::write(
                root.join("docs/index.md"),
                "---\nokf_version: \"0.2\"\n---\n# Fixture\n\n* [One](features/one.md)\n* [Two](features/two.md)\n",
            )
            .expect("index");
            fs::write(
                root.join("docs/features/one.md"),
                "---\ntype: Feature\ntitle: One\ndescription: Software architecture boundary.\ntags: [architecture]\n---\n# One\n\nThe service uses a frozen packet.\n",
            )
            .expect("one");
            fs::write(
                root.join("docs/features/two.md"),
                "---\ntype: Decision\ntitle: Two\ndescription: Storage decision.\ntags: [storage]\n---\n# Two\n\nQuiz history stays in application data.\n",
            )
            .expect("two");
            let runtime =
                QuizRuntimeState::load_from(root.join("state/quiz.json"), root.join("cache"))
                    .expect("runtime");
            Self { root, runtime }
        }

        fn docs(&self) -> PathBuf {
            dunce::canonicalize(self.root.join("docs")).expect("docs")
        }

        fn prepare(&self, ids: Vec<String>) -> QuizScopePreview {
            self.runtime
                .prepare_scope(
                    &self.docs(),
                    None,
                    &PrepareQuizScopeInput {
                        bundle_root: self.docs().display().to_string(),
                        scope_mode: QuizScopeMode::SelectedDocuments,
                        concept_ids: ids,
                        topic: None,
                        base_revision_id: None,
                        head_revision_id: None,
                        generation: QuizGenerationConfig {
                            mode: QuizGenerationMode::Manual,
                            length: Some(QuizLength::Medium),
                            difficulty: Some(crate::quiz::QuizDifficulty::Applied),
                            max_questions: 20,
                        },
                    },
                )
                .expect("prepare")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn artifact(run: &FrozenQuizRun) -> QuizArtifact {
        let source = &run.packet.request.evidence_sources[0];
        QuizArtifact {
            schema_version: 1,
            request_id: run.packet.request.request_id.clone(),
            bundle_fingerprint: run.packet.request.bundle_fingerprint.clone(),
            scope_fingerprint: run.packet.request.scope_fingerprint.clone(),
            status: QuizArtifactStatus::Ready,
            title: "Fixture quiz".to_string(),
            questions: vec![QuizQuestion {
                id: "Q1".to_string(),
                category: QuizQuestionCategory::Architecture,
                criticality: QuizCriticality::Critical,
                learning_objective: "Apply the boundary.".to_string(),
                prompt: "What boundary applies?".to_string(),
                choices: vec![
                    QuizChoice {
                        id: "A".to_string(),
                        text: "Frozen packet".to_string(),
                    },
                    QuizChoice {
                        id: "B".to_string(),
                        text: "Repository search".to_string(),
                    },
                    QuizChoice {
                        id: "C".to_string(),
                        text: "Web research".to_string(),
                    },
                ],
                correct_choice_id: "A".to_string(),
                explanation: "The source requires a frozen packet.".to_string(),
                evidence: vec![QuizEvidenceReference {
                    source_id: source.source_id.clone(),
                    heading: "One".to_string(),
                    quote: "The service uses a frozen packet.".to_string(),
                }],
            }],
            warnings: Vec::new(),
        }
    }

    #[test]
    fn automatic_generation_requires_a_repository_context() {
        let fixture = Fixture::new("automatic-repository");
        let error = fixture
            .runtime
            .prepare_scope(
                &fixture.docs(),
                None,
                &PrepareQuizScopeInput {
                    bundle_root: fixture.docs().display().to_string(),
                    scope_mode: QuizScopeMode::CurrentDocument,
                    concept_ids: vec!["features/one".to_string()],
                    topic: None,
                    base_revision_id: None,
                    head_revision_id: None,
                    generation: QuizGenerationConfig {
                        mode: QuizGenerationMode::Automatic,
                        length: None,
                        difficulty: None,
                        max_questions: 20,
                    },
                },
            )
            .expect_err("automatic generation without Git must fail");
        assert!(error.contains("trusted Git repository"));
    }

    #[test]
    fn current_selected_and_topic_scopes_are_frozen_and_bounded() {
        let fixture = Fixture::new("scopes");
        let selected =
            fixture.prepare(vec!["features/one".to_string(), "features/two".to_string()]);
        assert_eq!(selected.sources.len(), 2);
        assert_eq!(
            selected.total_evidence_bytes,
            selected.sources.iter().map(|s| s.bytes).sum::<usize>()
        );
        assert_eq!(selected.bundle_context_documents, 3);
        assert!(selected.bundle_context_bytes > selected.total_evidence_bytes);
        let selected_again =
            fixture.prepare(vec!["features/one".to_string(), "features/two".to_string()]);
        assert_ne!(selected.request_id, selected_again.request_id);
        assert_eq!(
            selected.bundle_fingerprint,
            selected_again.bundle_fingerprint
        );
        assert_eq!(selected.scope_fingerprint, selected_again.scope_fingerprint);
        assert!(selected.sources.iter().all(|source| {
            source.path.ends_with(".md")
                && !source.path.contains("..")
                && source.content_hash.starts_with("sha256-")
        }));
        let current = fixture
            .runtime
            .prepare_scope(
                &fixture.docs(),
                None,
                &PrepareQuizScopeInput {
                    bundle_root: fixture.docs().display().to_string(),
                    scope_mode: QuizScopeMode::CurrentDocument,
                    concept_ids: vec!["features/one".to_string()],
                    topic: None,
                    base_revision_id: None,
                    head_revision_id: None,
                    generation: QuizGenerationConfig {
                        mode: QuizGenerationMode::Manual,
                        length: Some(QuizLength::Medium),
                        difficulty: Some(crate::quiz::QuizDifficulty::Foundational),
                        max_questions: 20,
                    },
                },
            )
            .expect("current document");
        assert_eq!(current.sources.len(), 1);
        let frozen = fixture
            .runtime
            .frozen_packet(&selected.request_id)
            .expect("frozen");
        assert_eq!(
            frozen
                .bundle_context
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["features/one.md", "features/two.md", "index.md"]
        );
        let candidates =
            topic_candidates(&fixture.docs(), "software architecture").expect("topic candidates");
        assert_eq!(candidates[0].concept_id, "features/one");
        assert!(
            candidates[0].reason.contains("title") || candidates[0].reason.contains("description")
        );
        fs::write(
            fixture.docs().join("features/one.md"),
            "---\ntype: Feature\n---\n# Changed\n",
        )
        .expect("change after freeze");
        assert!(frozen.packet.request.evidence_sources[0]
            .markdown
            .contains("frozen packet"));
        assert!(frozen.bundle_context[0].contents.contains("frozen packet"));

        fs::write(
            fixture.docs().join("features/one.md"),
            format!(
                "---\ntype: Feature\ntitle: Oversized\n---\n# Oversized\n\n{}",
                "e".repeat(MAX_SOURCE_BYTES + 1)
            ),
        )
        .expect("oversized source");
        assert!(fixture
            .runtime
            .prepare_scope(
                &fixture.docs(),
                None,
                &PrepareQuizScopeInput {
                    bundle_root: fixture.docs().display().to_string(),
                    scope_mode: QuizScopeMode::SelectedDocuments,
                    concept_ids: vec!["features/one".to_string()],
                    topic: None,
                    base_revision_id: None,
                    head_revision_id: None,
                    generation: QuizGenerationConfig {
                        mode: QuizGenerationMode::Manual,
                        length: Some(QuizLength::Medium),
                        difficulty: Some(crate::quiz::QuizDifficulty::Applied),
                        max_questions: 20,
                    },
                },
            )
            .is_err());
    }

    #[test]
    fn freezes_v01_and_candidate_bundle_context_without_rewriting_it() {
        let fixture = Fixture::new("context-compatibility");
        fs::write(
            fixture.docs().join("index.md"),
            "---\nokf_version: \"0.1\"\nproducer_extension:\n  retained: true\n---\n# Legacy fixture\n\n* [One](features/one.md)\n",
        )
        .expect("v0.1 index");
        fs::write(
            fixture.docs().join("features/index.md"),
            "# Features\n\n* [One](one.md)\n* [Two](two.md)\n",
        )
        .expect("nested index");
        fs::write(
            fixture.docs().join("log.md"),
            "# Log\n\n## 2025-01-01\n\nLegacy bundle created.\n",
        )
        .expect("bundle log");
        let legacy = fixture.prepare(vec!["features/one".to_string()]);
        assert_eq!(legacy.bundle_context_documents, 5);
        let legacy_run = fixture
            .runtime
            .frozen_packet(&legacy.request_id)
            .expect("legacy frozen run");
        let root_index = legacy_run
            .bundle_context
            .iter()
            .find(|file| file.path == "index.md")
            .expect("root index");
        assert!(root_index.contents.contains("okf_version: \"0.1\""));
        assert!(root_index.contents.contains("producer_extension"));
        assert!(legacy_run
            .bundle_context
            .iter()
            .any(|file| file.path == "features/index.md"));
        assert!(legacy_run
            .bundle_context
            .iter()
            .any(|file| file.path == "log.md"));

        fs::remove_file(fixture.docs().join("index.md")).expect("candidate bundle");
        let candidate = fixture.prepare(vec!["features/one".to_string()]);
        assert_eq!(candidate.bundle_context_documents, 4);
        let candidate_run = fixture
            .runtime
            .frozen_packet(&candidate.request_id)
            .expect("candidate frozen run");
        assert!(candidate_run
            .bundle_context
            .iter()
            .all(|file| file.path != "index.md"));
    }

    #[test]
    fn persists_attempts_without_revealing_answers_before_submission() {
        let fixture = Fixture::new("attempt");
        let preview = fixture.prepare(vec!["features/one".to_string()]);
        let run = fixture
            .runtime
            .frozen_packet(&preview.request_id)
            .expect("run");
        let quiz_id = fixture
            .runtime
            .save_generated_quiz(
                &run,
                artifact(&run),
                &builtin_profiles(&QuizGeneratorSettings::default())[0],
                Some("fixture".to_string()),
            )
            .expect("save quiz");
        let view = fixture
            .runtime
            .start_attempt(&fixture.docs(), &quiz_id)
            .expect("attempt");
        let question = view.next_question.expect("question");
        assert_eq!(question.choices.len(), 3);
        let serialized = serde_json::to_string(&question).expect("public question");
        assert!(!serialized.contains("correctChoiceId"));
        assert!(!serialized.contains("explanation"));
        assert!(!serialized.contains("frozen packet."));

        let reveal = fixture
            .runtime
            .submit_answer(
                &fixture.docs(),
                &SubmitQuizAnswerInput {
                    bundle_root: fixture.docs().display().to_string(),
                    attempt_id: view.summary.attempt_id.clone(),
                    question_id: question.question_id,
                    selected_choice_id: "B".to_string(),
                },
            )
            .expect("submit");
        assert!(!reveal.correct);
        assert_eq!(reveal.correct_choice_id, "A");
        assert!(reveal.completed);
        let results = fixture
            .runtime
            .results(&fixture.docs(), &view.summary.attempt_id)
            .expect("results");
        assert_eq!(results.correct, 0);
        assert!(results.critical_gap);

        let reloaded = QuizRuntimeState::load_from(
            fixture.runtime.store_path.clone(),
            fixture.root.join("reloaded-cache"),
        )
        .expect("reload persisted quiz history");
        assert_eq!(
            reloaded
                .list_quizzes(&fixture.docs())
                .expect("quizzes")
                .len(),
            1
        );
        assert_eq!(
            reloaded
                .results(&fixture.docs(), &view.summary.attempt_id)
                .expect("persisted results")
                .correct,
            0
        );
        reloaded
            .delete_attempt(&fixture.docs(), &view.summary.attempt_id)
            .expect("delete attempt");
        assert!(reloaded
            .list_attempts(&fixture.docs(), &quiz_id)
            .expect("attempts")
            .is_empty());
        reloaded
            .delete_quiz(&fixture.docs(), &quiz_id)
            .expect("delete quiz");
        assert!(reloaded
            .list_quizzes(&fixture.docs())
            .expect("quizzes")
            .is_empty());
    }

    #[test]
    fn not_important_questions_are_persisted_excluded_from_scoring_and_reset_on_retake() {
        let fixture = Fixture::new("not-important");
        let preview = fixture.prepare(vec!["features/one".to_string()]);
        let mut run = fixture
            .runtime
            .frozen_packet(&preview.request_id)
            .expect("run");
        run.packet.request.requested_question_count = 2;
        let mut quiz = artifact(&run);
        let mut second = quiz.questions[0].clone();
        second.id = "Q2".to_string();
        second.prompt = "Which alternative is outside the frozen boundary?".to_string();
        second.criticality = QuizCriticality::Important;
        quiz.questions.push(second);
        let quiz_id = fixture
            .runtime
            .save_generated_quiz(
                &run,
                quiz,
                &builtin_profiles(&QuizGeneratorSettings::default())[0],
                None,
            )
            .expect("save quiz");
        let first_attempt = fixture
            .runtime
            .start_attempt(&fixture.docs(), &quiz_id)
            .expect("attempt");
        let first_question = first_attempt.next_question.expect("first question");
        let advanced = fixture
            .runtime
            .mark_question_not_important(
                &fixture.docs(),
                &MarkQuizQuestionNotImportantInput {
                    bundle_root: fixture.docs().display().to_string(),
                    attempt_id: first_attempt.summary.attempt_id.clone(),
                    question_id: first_question.question_id,
                },
            )
            .expect("exclude question");
        assert_eq!(advanced.summary.excluded, 1);
        assert_eq!(
            advanced
                .next_question
                .as_ref()
                .map(|question| question.question_id.as_str()),
            Some("Q2")
        );
        let reveal = fixture
            .runtime
            .submit_answer(
                &fixture.docs(),
                &SubmitQuizAnswerInput {
                    bundle_root: fixture.docs().display().to_string(),
                    attempt_id: first_attempt.summary.attempt_id.clone(),
                    question_id: "Q2".to_string(),
                    selected_choice_id: "B".to_string(),
                },
            )
            .expect("answer remaining question");
        assert!(reveal.completed);
        let results = fixture
            .runtime
            .results(&fixture.docs(), &first_attempt.summary.attempt_id)
            .expect("results");
        assert_eq!(results.total, 1);
        assert_eq!(results.critical_total, 0);
        assert_eq!(results.excluded_questions.len(), 1);
        assert_eq!(results.excluded_questions[0].question_id, "Q1");
        let reloaded = QuizRuntimeState::load_from(
            fixture.runtime.store_path.clone(),
            fixture.root.join("not-important-reloaded-cache"),
        )
        .expect("reload exclusions");
        assert_eq!(
            reloaded
                .results(&fixture.docs(), &first_attempt.summary.attempt_id)
                .expect("persisted exclusion results")
                .excluded_questions
                .len(),
            1
        );

        let retake = fixture
            .runtime
            .start_attempt(&fixture.docs(), &quiz_id)
            .expect("retake");
        assert_eq!(retake.summary.excluded, 0);
        assert_eq!(
            retake
                .next_question
                .as_ref()
                .map(|question| question.question_id.as_str()),
            Some("Q1")
        );
        let retake_advanced = fixture
            .runtime
            .mark_question_not_important(
                &fixture.docs(),
                &MarkQuizQuestionNotImportantInput {
                    bundle_root: fixture.docs().display().to_string(),
                    attempt_id: retake.summary.attempt_id.clone(),
                    question_id: "Q1".to_string(),
                },
            )
            .expect("exclude first retake question");
        assert_eq!(
            retake_advanced
                .next_question
                .as_ref()
                .map(|question| question.question_id.as_str()),
            Some("Q2")
        );
        let completed = fixture
            .runtime
            .mark_question_not_important(
                &fixture.docs(),
                &MarkQuizQuestionNotImportantInput {
                    bundle_root: fixture.docs().display().to_string(),
                    attempt_id: retake.summary.attempt_id.clone(),
                    question_id: "Q2".to_string(),
                },
            )
            .expect("exclude all retake questions");
        assert!(completed.summary.completed_at.is_some());
        assert!(completed.next_question.is_none());
        let all_excluded = fixture
            .runtime
            .results(&fixture.docs(), &retake.summary.attempt_id)
            .expect("all-excluded results");
        assert_eq!(all_excluded.total, 0);
        assert_eq!(all_excluded.correct, 0);
        assert_eq!(all_excluded.critical_total, 0);
        assert!(!all_excluded.critical_gap);
        assert!(all_excluded.by_category.is_empty());
        assert_eq!(all_excluded.excluded_questions.len(), 2);
    }

    #[test]
    fn failed_generation_persists_retry_input_and_is_replaced_by_success() {
        let fixture = Fixture::new("generation-failure");
        let preview = fixture.prepare(vec!["features/one".to_string()]);
        let run = fixture
            .runtime
            .frozen_packet(&preview.request_id)
            .expect("initial frozen run");
        let provider = builtin_profiles(&QuizGeneratorSettings::default())[0].clone();
        let failure_id = fixture
            .runtime
            .save_generation_failure(
                &run,
                &provider,
                Some("fixture-model".to_string()),
                QuizGenerationFailureKind::ProviderError,
                "Provider authentication is required.\nsecret diagnostic",
            )
            .expect("persist failure");

        let failures = fixture.runtime.list_generation_failures(&fixture.docs());
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].failure_id, failure_id);
        assert_eq!(failures[0].retry_count, 0);
        assert_eq!(failures[0].generation, run.retry_input.generation);
        assert!(!failures[0].message.contains('\n'));

        let reloaded = QuizRuntimeState::load_from(
            fixture.runtime.store_path.clone(),
            fixture.root.join("reloaded-failure-cache"),
        )
        .expect("reload persisted failure");
        let retry_input = reloaded
            .generation_failure_retry_input(&fixture.docs(), &failure_id)
            .expect("saved retry input");
        assert_eq!(retry_input, run.retry_input);

        let retry_preview = fixture
            .runtime
            .prepare_scope(&fixture.docs(), None, &retry_input)
            .expect("prepare retry");
        fixture
            .runtime
            .mark_generation_failure_retry(&retry_preview.request_id, &failure_id)
            .expect("link retry");
        let retry_run = fixture
            .runtime
            .frozen_packet(&retry_preview.request_id)
            .expect("retry frozen run");
        let repeated_failure_id = fixture
            .runtime
            .save_generation_failure(
                &retry_run,
                &provider,
                Some("fixture-model".to_string()),
                QuizGenerationFailureKind::InvalidOutput,
                "The retry returned invalid output.",
            )
            .expect("update failed retry");
        assert_eq!(repeated_failure_id, failure_id);
        let failures = fixture.runtime.list_generation_failures(&fixture.docs());
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].retry_count, 1);
        assert_eq!(
            failures[0].failure_kind,
            QuizGenerationFailureKind::InvalidOutput
        );

        let success_input = fixture
            .runtime
            .generation_failure_retry_input(&fixture.docs(), &failure_id)
            .expect("updated retry input");
        let success_preview = fixture
            .runtime
            .prepare_scope(&fixture.docs(), None, &success_input)
            .expect("prepare successful retry");
        fixture
            .runtime
            .mark_generation_failure_retry(&success_preview.request_id, &failure_id)
            .expect("link successful retry");
        let success_run = fixture
            .runtime
            .frozen_packet(&success_preview.request_id)
            .expect("successful frozen run");
        fixture
            .runtime
            .save_generated_quiz(
                &success_run,
                artifact(&success_run),
                &provider,
                Some("fixture-model".to_string()),
            )
            .expect("successful retry");

        assert!(fixture
            .runtime
            .list_generation_failures(&fixture.docs())
            .is_empty());
        assert_eq!(
            fixture
                .runtime
                .list_quizzes(&fixture.docs())
                .expect("successful quiz")
                .len(),
            1
        );
    }

    #[test]
    fn unrelated_bundle_changes_do_not_mark_a_quiz_stale() {
        let fixture = Fixture::new("stale");
        let preview = fixture.prepare(vec!["features/one".to_string()]);
        let run = fixture
            .runtime
            .frozen_packet(&preview.request_id)
            .expect("run");
        fixture
            .runtime
            .save_generated_quiz(
                &run,
                artifact(&run),
                &builtin_profiles(&QuizGeneratorSettings::default())[0],
                None,
            )
            .expect("save");
        fs::write(
            fixture.docs().join("features/two.md"),
            "---\ntype: Decision\n---\n# Changed unrelated concept\n",
        )
        .expect("change unrelated");
        assert!(
            !fixture
                .runtime
                .list_quizzes(&fixture.docs())
                .expect("summaries")[0]
                .stale
        );
        fs::write(
            fixture.docs().join("features/one.md"),
            "---\ntype: Feature\n---\n# Changed selected concept\n",
        )
        .expect("change selected");
        assert!(
            fixture
                .runtime
                .list_quizzes(&fixture.docs())
                .expect("summaries")[0]
                .stale
        );
    }

    #[test]
    fn corrupt_store_is_quarantined() {
        let fixture = Fixture::new("corrupt");
        let store = fixture.root.join("corrupt/store.json");
        fs::create_dir_all(store.parent().expect("parent")).expect("directory");
        fs::write(&store, "{not-json").expect("corrupt");
        let runtime = QuizRuntimeState::load_from(store.clone(), fixture.root.join("other-cache"))
            .expect("load quarantines");
        assert!(runtime.provider_profiles().len() >= 2);
        assert!(!store.exists());
        assert!(fs::read_dir(store.parent().expect("parent"))
            .expect("read")
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains("corrupt-")));

        let unsupported = fixture.root.join("unsupported/store.json");
        fs::create_dir_all(unsupported.parent().expect("parent")).expect("directory");
        fs::write(
            &unsupported,
            r#"{"schemaVersion":999,"definitions":[],"attempts":[],"apiProfiles":[]}"#,
        )
        .expect("unsupported store");
        QuizRuntimeState::load_from(unsupported.clone(), fixture.root.join("third-cache"))
            .expect("unsupported schema is quarantined");
        assert!(!unsupported.exists());
    }

    #[test]
    fn legacy_quiz_store_migrates_to_failure_aware_schema() {
        let fixture = Fixture::new("store-migration");
        let store = fixture.root.join("legacy/store.json");
        fs::create_dir_all(store.parent().expect("parent")).expect("directory");
        fs::write(
            &store,
            r#"{"schemaVersion":1,"definitions":[],"attempts":[],"apiProfiles":[]}"#,
        )
        .expect("legacy store");

        let runtime = QuizRuntimeState::load_from(store.clone(), fixture.root.join("legacy-cache"))
            .expect("migrate legacy store");
        assert!(runtime.list_generation_failures(&fixture.docs()).is_empty());
        let migrated: serde_json::Value =
            serde_json::from_slice(&fs::read(store).expect("persisted migration"))
                .expect("migrated JSON");
        assert_eq!(migrated["schemaVersion"], STORE_SCHEMA_VERSION);
        assert_eq!(migrated["generationFailures"], serde_json::json!([]));
    }

    #[test]
    fn legacy_attempts_without_exclusions_default_to_empty() {
        let attempt: StoredAttempt = serde_json::from_value(serde_json::json!({
            "attemptId": "attempt-legacy",
            "quizId": "quiz-legacy",
            "startedAt": "2026-07-30T00:00:00Z",
            "completedAt": null,
            "answers": {}
        }))
        .expect("legacy attempt");
        assert!(attempt.not_important_question_ids.is_empty());
    }

    #[test]
    fn retention_caps_quizzes_and_attempts() {
        let fixture = Fixture::new("retention");
        let preview = fixture.prepare(vec!["features/one".to_string()]);
        let run = fixture
            .runtime
            .frozen_packet(&preview.request_id)
            .expect("run");
        fixture
            .runtime
            .save_generated_quiz(
                &run,
                artifact(&run),
                &builtin_profiles(&QuizGeneratorSettings::default())[0],
                None,
            )
            .expect("seed quiz");
        let seed = fixture
            .runtime
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .store
            .definitions[0]
            .clone();
        let mut store = QuizStore::default();
        for index in 0..=MAX_QUIZZES {
            let mut definition = seed.clone();
            definition.quiz_id = format!("quiz-{index:03}");
            definition.generated_at = format!("2026-07-30T00:{:02}:00Z", index % 60);
            store.definitions.push(definition);
        }
        for index in 0..=MAX_ATTEMPTS_PER_QUIZ {
            store.attempts.push(StoredAttempt {
                attempt_id: format!("attempt-{index:03}"),
                quiz_id: "quiz-100".to_string(),
                started_at: format!("2026-07-30T01:{index:02}:00Z"),
                completed_at: None,
                answers: BTreeMap::new(),
                not_important_question_ids: BTreeSet::new(),
            });
        }
        let now = OffsetDateTime::parse("2026-08-05T12:00:00Z", &Rfc3339).expect("fixed time");
        enforce_retention_at(&mut store, now);
        assert_eq!(store.definitions.len(), MAX_QUIZZES);
        assert!(!store
            .definitions
            .iter()
            .any(|definition| definition.quiz_id == "quiz-000"));
        assert_eq!(
            store
                .attempts
                .iter()
                .filter(|attempt| attempt.quiz_id == "quiz-100")
                .count(),
            MAX_ATTEMPTS_PER_QUIZ
        );
        assert!(!store
            .attempts
            .iter()
            .any(|attempt| attempt.attempt_id == "attempt-000"));
    }

    #[test]
    fn retention_keeps_thirty_days_and_removes_expired_quizzes_attempts_and_failures() {
        let fixture = Fixture::new("retention-days");
        let preview = fixture.prepare(vec!["features/one".to_string()]);
        let run = fixture
            .runtime
            .frozen_packet(&preview.request_id)
            .expect("run");
        fixture
            .runtime
            .save_generated_quiz(
                &run,
                artifact(&run),
                &builtin_profiles(&QuizGeneratorSettings::default())[0],
                None,
            )
            .expect("seed quiz");
        let seed = fixture
            .runtime
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .store
            .definitions[0]
            .clone();
        let now = OffsetDateTime::parse("2026-08-05T12:00:00Z", &Rfc3339).expect("fixed time");
        let retained_at = (now - TimeDuration::days(QUIZ_RETENTION_DAYS))
            .format(&Rfc3339)
            .expect("retained timestamp");
        let expired_at = (now - TimeDuration::days(QUIZ_RETENTION_DAYS) - TimeDuration::seconds(1))
            .format(&Rfc3339)
            .expect("expired timestamp");
        let mut retained = seed.clone();
        retained.quiz_id = "quiz-retained".to_string();
        retained.generated_at = retained_at.clone();
        let mut expired = seed;
        expired.quiz_id = "quiz-expired".to_string();
        expired.generated_at = expired_at.clone();
        let failure = |failure_id: &str, failed_at: String| StoredQuizGenerationFailure {
            failure_id: failure_id.to_string(),
            bundle_root: fixture.docs().to_string_lossy().into_owned(),
            scope_description: run.packet.scope_description.clone(),
            provider_kind: QuizProviderKind::CodexCli,
            provider_profile: "codex-cli".to_string(),
            model: None,
            failed_at,
            failure_kind: QuizGenerationFailureKind::ProviderError,
            message: "Provider unavailable.".to_string(),
            retry_count: 0,
            retry_input: run.retry_input.clone(),
        };
        let store = QuizStore {
            definitions: vec![retained, expired],
            attempts: vec![
                StoredAttempt {
                    attempt_id: "attempt-retained".to_string(),
                    quiz_id: "quiz-retained".to_string(),
                    started_at: retained_at.clone(),
                    completed_at: None,
                    answers: BTreeMap::new(),
                    not_important_question_ids: BTreeSet::new(),
                },
                StoredAttempt {
                    attempt_id: "attempt-expired".to_string(),
                    quiz_id: "quiz-expired".to_string(),
                    started_at: expired_at.clone(),
                    completed_at: None,
                    answers: BTreeMap::new(),
                    not_important_question_ids: BTreeSet::new(),
                },
            ],
            generation_failures: vec![
                failure("quiz-failure-retained", retained_at),
                failure("quiz-failure-expired", expired_at),
            ],
            ..QuizStore::default()
        };

        let store_path = fixture.root.join("retention/quiz-store.json");
        persist_store(&store_path, &store).expect("persist retention fixture");
        let store = load_store_at(&store_path, now).expect("prune persisted store on startup");
        assert_eq!(
            store
                .definitions
                .iter()
                .map(|definition| definition.quiz_id.as_str())
                .collect::<Vec<_>>(),
            ["quiz-retained"]
        );
        assert_eq!(store.attempts[0].attempt_id, "attempt-retained");
        assert_eq!(store.generation_failures.len(), 1);
        assert_eq!(
            store.generation_failures[0].failure_id,
            "quiz-failure-retained"
        );
        let mut persisted: QuizStore =
            serde_json::from_slice(&fs::read(store_path).expect("read pruned store"))
                .expect("decode pruned store");
        assert_eq!(persisted.definitions.len(), 1);
        assert_eq!(persisted.attempts.len(), 1);
        assert_eq!(persisted.generation_failures.len(), 1);
        persisted.definitions[0].generated_at = "not-a-timestamp".to_string();
        assert!(validate_store(&persisted).is_err());
    }

    #[test]
    fn bundle_diff_is_bundle_only_and_handles_added_deleted_and_modified_concepts() {
        let fixture = Fixture::new("diff");
        assert!(!git_availability(&fixture.docs()).available);
        git(&fixture.root, &["init", "--quiet"]);
        git(
            &fixture.root,
            &["config", "user.email", "fixture@example.com"],
        );
        git(&fixture.root, &["config", "user.name", "Fixture"]);
        git(&fixture.root, &["config", "commit.gpgsign", "false"]);
        fs::write(fixture.root.join("outside.txt"), "outside base\n").expect("outside base");
        git(&fixture.root, &["add", "."]);
        git(&fixture.root, &["commit", "--quiet", "-m", "base"]);
        let base = git(&fixture.root, &["rev-parse", "HEAD"]);

        fs::write(fixture.root.join("outside.txt"), "outside changed\n").expect("outside changed");
        fs::write(
            fixture.docs().join("features/one.md"),
            "---\ntype: Feature\ntitle: One\ndescription: Software architecture boundary.\ntags: [architecture]\n---\n# One\n\nThe service now validates every frozen packet.\n",
        )
        .expect("modified");
        fs::remove_file(fixture.docs().join("features/two.md")).expect("deleted");
        fs::write(
            fixture.docs().join("features/three.md"),
            "---\ntype: Decision\ntitle: Three\n---\n# Three\n\nThe provider cannot change scope.\n",
        )
        .expect("added");
        fs::write(
            fixture.docs().join("index.md"),
            "---\nokf_version: \"0.2\"\n---\n# Fixture\n\n* [One](features/one.md)\n* [Three](features/three.md)\n",
        )
        .expect("index");

        let repository = dunce::canonicalize(&fixture.root).expect("repository");
        let preview = fixture
            .runtime
            .prepare_scope(
                &fixture.docs(),
                Some(&repository),
                &PrepareQuizScopeInput {
                    bundle_root: fixture.docs().display().to_string(),
                    scope_mode: QuizScopeMode::BundleDiff,
                    concept_ids: Vec::new(),
                    topic: None,
                    base_revision_id: Some(base.clone()),
                    head_revision_id: None,
                    generation: QuizGenerationConfig {
                        mode: QuizGenerationMode::Manual,
                        length: Some(QuizLength::Medium),
                        difficulty: Some(crate::quiz::QuizDifficulty::Challenging),
                        max_questions: 20,
                    },
                },
            )
            .expect("diff");
        let paths = preview
            .sources
            .iter()
            .map(|source| source.path.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            paths,
            BTreeSet::from(["features/one.md", "features/three.md", "features/two.md",])
        );
        assert_eq!(preview.sources.len(), 6);
        assert!(preview
            .sources
            .iter()
            .all(|source| !source.path.contains("outside")));
        let run = fixture
            .runtime
            .frozen_packet(&preview.request_id)
            .expect("frozen diff");
        assert!(frozen_run_stale_reason(&run).expect("fresh").is_none());

        assert_eq!(
            semantic_markdown(&Some("# One  \r\n\r\nBody\t\r\n".to_string())),
            semantic_markdown(&Some("# One\n\nBody\n".to_string()))
        );
        let missing = fixture.runtime.prepare_scope(
            &fixture.docs(),
            Some(&repository),
            &PrepareQuizScopeInput {
                bundle_root: fixture.docs().display().to_string(),
                scope_mode: QuizScopeMode::BundleDiff,
                concept_ids: Vec::new(),
                topic: None,
                base_revision_id: Some("deadbeef".to_string()),
                head_revision_id: None,
                generation: QuizGenerationConfig {
                    mode: QuizGenerationMode::Manual,
                    length: Some(QuizLength::Medium),
                    difficulty: Some(crate::quiz::QuizDifficulty::Applied),
                    max_questions: 20,
                },
            },
        );
        assert!(missing.is_err());
    }

    #[test]
    fn reviewed_since_commit_requires_exact_new_human_events_and_freezes_current_sources() {
        let fixture = Fixture::new("reviewed-since");
        fs::write(
            fixture.docs().join("features/one.md"),
            "---\ntype: Feature\ntitle: One\nverified:\n  - { by: human:alex, at: 2026-08-01T10:00:00Z }\n---\n# One\n\nBase content.\n",
        )
        .expect("pre-reviewed base");
        fs::write(
            fixture.docs().join("features/removed.md"),
            "---\ntype: Feature\ntitle: Removed\nverified:\n  - { by: human:alex, at: 2026-08-02T10:00:00Z }\n---\n# Removed\n\nBase content.\n",
        )
        .expect("removed review base");
        git(&fixture.root, &["init", "--quiet"]);
        git(
            &fixture.root,
            &["config", "user.email", "fixture@example.com"],
        );
        git(&fixture.root, &["config", "user.name", "Fixture"]);
        git(&fixture.root, &["config", "commit.gpgsign", "false"]);
        git(&fixture.root, &["add", "."]);
        git(&fixture.root, &["commit", "--quiet", "-m", "base"]);
        let base = git(&fixture.root, &["rev-parse", "HEAD"]);

        fs::write(
            fixture.docs().join("features/one.md"),
            "---\ntype: Feature\ntitle: One\nverified:\n  - { by: human:alex, at: 2026-08-01T10:00:00Z }\n---\n# One\n\nUnrelated content edit.\n",
        )
        .expect("unrelated edit");
        fs::write(
            fixture.docs().join("features/two.md"),
            "---\ntype: Decision\ntitle: Two\nverified:\n  - { by: human:sam, at: 2026-08-27T09:00:00Z }\n---\n# Two\n\nNewly reviewed current content.\n",
        )
        .expect("new human review");
        fs::write(
            fixture.docs().join("features/removed.md"),
            "---\ntype: Feature\ntitle: Removed\n---\n# Removed\n\nReview removed.\n",
        )
        .expect("removed review");
        fs::write(
            fixture.docs().join("features/machine.md"),
            "---\ntype: Feature\ntitle: Machine\nverified:\n  - { by: process:nightly, at: 2026-08-27T09:00:00Z }\n---\n# Machine\n\nMachine only.\n",
        )
        .expect("machine verification");
        fs::write(
            fixture.docs().join("features/missing-at.md"),
            "---\ntype: Feature\ntitle: Missing timestamp\nverified:\n  - { by: human:incomplete }\n---\n# Missing timestamp\n\nIncomplete verification.\n",
        )
        .expect("incomplete human verification");
        fs::write(
            fixture.docs().join("features/new reviewed.md"),
            "---\ntype: Feature\ntitle: New reviewed\nverified:\n  - { by: human:zoë, at: 2026-08-27T10:00:00Z }\n---\n# New reviewed\n\nUntracked reviewed content.\n",
        )
        .expect("untracked human review");

        let repository = dunce::canonicalize(&fixture.root).expect("repository");
        let input = PrepareQuizScopeInput {
            bundle_root: fixture.docs().display().to_string(),
            scope_mode: QuizScopeMode::ReviewedSinceCommit,
            concept_ids: Vec::new(),
            topic: None,
            base_revision_id: Some(base.clone()),
            head_revision_id: None,
            generation: QuizGenerationConfig {
                mode: QuizGenerationMode::Manual,
                length: Some(QuizLength::Medium),
                difficulty: Some(crate::quiz::QuizDifficulty::Applied),
                max_questions: 20,
            },
        };
        let preview = fixture
            .runtime
            .prepare_scope(&fixture.docs(), Some(&repository), &input)
            .expect("reviewed since commit");
        assert_eq!(
            preview
                .sources
                .iter()
                .map(|source| source.path.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["features/new reviewed.md", "features/two.md"])
        );
        assert!(preview
            .sources
            .iter()
            .all(|source| source.version == QuizEvidenceVersion::Current));
        assert!(preview
            .sources
            .iter()
            .all(|source| source.reason.contains("New human review since")));
        let run = fixture
            .runtime
            .frozen_packet(&preview.request_id)
            .expect("frozen reviewed scope");
        assert_eq!(
            run.packet.request.base_revision_id.as_deref(),
            Some(base.as_str())
        );
        assert_eq!(
            run.packet.request.head_revision_id.as_deref(),
            Some("WORKTREE")
        );

        git(&fixture.root, &["add", "."]);
        git(&fixture.root, &["commit", "--quiet", "-m", "reviewed"]);
        let raced = fixture
            .runtime
            .prepare_scope(&fixture.docs(), Some(&repository), &input)
            .expect_err("changed HEAD must require refresh");
        assert!(raced.contains("HEAD changed"));
    }

    #[test]
    fn reviewed_since_commit_ranking_has_deterministic_limit_omissions() {
        let fixture = Fixture::new("reviewed-ranking");
        git(&fixture.root, &["init", "--quiet"]);
        git(
            &fixture.root,
            &["config", "user.email", "fixture@example.com"],
        );
        git(&fixture.root, &["config", "user.name", "Fixture"]);
        git(&fixture.root, &["config", "commit.gpgsign", "false"]);
        git(&fixture.root, &["add", "."]);
        git(&fixture.root, &["commit", "--quiet", "-m", "base"]);
        let base = git(&fixture.root, &["rev-parse", "HEAD"]);
        fs::create_dir_all(fixture.docs().join("rank")).expect("rank directory");
        for index in 0..34 {
            fs::write(
                fixture.docs().join(format!("rank/{index:02}.md")),
                format!(
                    "---\ntype: Note\ntitle: Ranked {index:02}\nverified:\n  - {{ by: human:reviewer, at: 2026-08-27T10:{index:02}:00Z }}\n---\n# Ranked {index:02}\n\nSame score.\n"
                ),
            )
            .expect("ranked document");
        }
        let repository = dunce::canonicalize(&fixture.root).expect("repository");
        let preview = fixture
            .runtime
            .prepare_scope(
                &fixture.docs(),
                Some(&repository),
                &PrepareQuizScopeInput {
                    bundle_root: fixture.docs().display().to_string(),
                    scope_mode: QuizScopeMode::ReviewedSinceCommit,
                    concept_ids: Vec::new(),
                    topic: None,
                    base_revision_id: Some(base),
                    head_revision_id: None,
                    generation: QuizGenerationConfig {
                        mode: QuizGenerationMode::Manual,
                        length: Some(QuizLength::Short),
                        difficulty: Some(crate::quiz::QuizDifficulty::Foundational),
                        max_questions: 20,
                    },
                },
            )
            .expect("ranked reviewed scope");
        assert_eq!(preview.sources.len(), 32);
        assert_eq!(
            preview.omitted_documents,
            vec!["rank/32.md".to_string(), "rank/33.md".to_string()]
        );
        assert_eq!(preview.sources[0].path, "rank/00.md");
        assert_eq!(preview.sources[31].path, "rank/31.md");
    }

    #[test]
    fn reviewed_since_commit_omits_per_file_and_aggregate_overflow() {
        let fixture = Fixture::new("reviewed-size-limits");
        git(&fixture.root, &["init", "--quiet"]);
        git(
            &fixture.root,
            &["config", "user.email", "fixture@example.com"],
        );
        git(&fixture.root, &["config", "user.name", "Fixture"]);
        git(&fixture.root, &["config", "commit.gpgsign", "false"]);
        git(&fixture.root, &["add", "."]);
        git(&fixture.root, &["commit", "--quiet", "-m", "base"]);
        let base = git(&fixture.root, &["rev-parse", "HEAD"]);
        fs::create_dir_all(fixture.docs().join("rank")).expect("rank directory");
        let large_body = "line\n".repeat(46_000);
        for index in 0..5 {
            fs::write(
                fixture.docs().join(format!("rank/big-{index:02}.md")),
                format!(
                    "---\ntype: Note\ntitle: Big {index:02}\nverified:\n  - {{ by: human:reviewer, at: 2026-08-27T11:{index:02}:00Z }}\n---\n# Big {index:02}\n\n{large_body}"
                ),
            )
            .expect("large reviewed document");
        }
        fs::write(
            fixture.docs().join("rank/oversize.md"),
            format!(
                "---\ntype: Note\ntitle: Oversize\nverified:\n  - {{ by: human:reviewer, at: 2026-08-27T12:00:00Z }}\n---\n# Oversize\n\n{}",
                "line\n".repeat(53_000)
            ),
        )
        .expect("oversized reviewed document");
        let repository = dunce::canonicalize(&fixture.root).expect("repository");
        let preview = fixture
            .runtime
            .prepare_scope(
                &fixture.docs(),
                Some(&repository),
                &PrepareQuizScopeInput {
                    bundle_root: fixture.docs().display().to_string(),
                    scope_mode: QuizScopeMode::ReviewedSinceCommit,
                    concept_ids: Vec::new(),
                    topic: None,
                    base_revision_id: Some(base),
                    head_revision_id: None,
                    generation: QuizGenerationConfig {
                        mode: QuizGenerationMode::Manual,
                        length: Some(QuizLength::Short),
                        difficulty: Some(crate::quiz::QuizDifficulty::Foundational),
                        max_questions: 20,
                    },
                },
            )
            .expect("size-limited reviewed scope");
        assert_eq!(preview.sources.len(), 4);
        assert_eq!(
            preview.omitted_documents,
            vec!["rank/big-04.md".to_string(), "rank/oversize.md".to_string()]
        );
        assert!(preview.total_evidence_bytes <= MAX_TOTAL_EVIDENCE_BYTES);
        assert!(preview
            .sources
            .iter()
            .all(|source| source.bytes <= MAX_SOURCE_BYTES));
    }

    #[test]
    fn proportional_question_counts_follow_length_and_cap() {
        assert_eq!(proportional_question_count(0, QuizLength::Short, 20), 1);
        assert_eq!(
            proportional_question_count(3 * 1024, QuizLength::Short, 20),
            1
        );
        assert_eq!(
            proportional_question_count(3 * 1024 + 1, QuizLength::Short, 20),
            2
        );

        let bytes = 6 * 1024;
        assert_eq!(proportional_question_count(bytes, QuizLength::Short, 20), 2);
        assert_eq!(
            proportional_question_count(bytes, QuizLength::Medium, 20),
            3
        );
        assert_eq!(proportional_question_count(bytes, QuizLength::Long, 20), 4);
        assert_eq!(
            proportional_question_count(1024 * 1024, QuizLength::Long, 7),
            7
        );
        assert_eq!(
            proportional_question_count(1024 * 1024, QuizLength::Long, 20),
            20
        );
    }

    #[test]
    fn legacy_exact_counts_map_to_quiz_specific_configuration() {
        let foundational = crate::quiz::QuizDifficulty::Foundational;
        assert_eq!(
            legacy_generation_config(5, foundational),
            QuizGenerationConfig {
                mode: QuizGenerationMode::Manual,
                length: Some(QuizLength::Short),
                difficulty: Some(foundational),
                max_questions: 5,
            }
        );
        assert_eq!(
            legacy_generation_config(10, foundational).length,
            Some(QuizLength::Medium)
        );
        assert_eq!(
            legacy_generation_config(15, foundational).length,
            Some(QuizLength::Long)
        );
    }

    #[test]
    fn legacy_generator_settings_gain_explicit_codex_defaults() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "okf-review-generator-v2-migration-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("migration directory");
        let store_path = root.join("quiz-store-v1.json");
        let settings_path = root.join(GENERATOR_SETTINGS_FILE);
        let mut value =
            serde_json::to_value(QuizGeneratorSettings::default()).expect("settings value");
        let object = value.as_object_mut().expect("settings object");
        object.insert(
            "schemaVersion".to_string(),
            serde_json::json!(LEGACY_GENERATOR_SETTINGS_SCHEMA_VERSION),
        );
        object.insert(
            "futureSetting".to_string(),
            serde_json::json!({"preserve": true}),
        );
        let codex = object
            .get_mut("codexCli")
            .and_then(serde_json::Value::as_object_mut)
            .expect("Codex settings");
        codex.insert("model".to_string(), serde_json::json!("5.6"));
        codex.remove("reasoningEffort");
        fs::write(
            &settings_path,
            serde_json::to_vec_pretty(&value).expect("legacy settings JSON"),
        )
        .expect("legacy settings");

        let runtime = QuizRuntimeState::load_from(store_path, root.join("cache"))
            .expect("settings migration");
        let migrated = runtime.generator_settings();
        assert_eq!(migrated.schema_version, GENERATOR_SETTINGS_SCHEMA_VERSION);
        assert_eq!(
            migrated.codex_cli.model.as_deref(),
            Some(DEFAULT_CODEX_MODEL)
        );
        assert_eq!(
            migrated.codex_cli.reasoning_effort,
            Some(CodexReasoningEffort::High)
        );
        assert_eq!(migrated.extra["futureSetting"]["preserve"], true);
        assert_eq!(
            load_generator_settings(&settings_path)
                .expect("persisted migration")
                .schema_version,
            GENERATOR_SETTINGS_SCHEMA_VERSION
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_api_profiles_migrate_to_user_generator_settings() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "okf-review-generator-migration-{}-{nonce}",
            std::process::id()
        ));
        let store_path = root.join("quiz-store-v1.json");
        let cache = root.join("cache");
        let mut store = QuizStore::default();
        store.api_profiles.push(QuizProviderProfile {
            id: "api-legacy".to_string(),
            kind: QuizProviderKind::ModelApi,
            label: "Legacy API".to_string(),
            model: Some("fixture-model".to_string()),
            endpoint: Some("https://example.invalid/v1/chat/completions".to_string()),
            executable_path: None,
            reasoning_effort: None,
            sends_content_off_device: true,
        });
        persist_store(&store_path, &store).expect("legacy store");
        let settings_path = store_path.with_file_name(GENERATOR_SETTINGS_FILE);
        let mut settings_value =
            serde_json::to_value(QuizGeneratorSettings::default()).expect("settings value");
        settings_value
            .as_object_mut()
            .expect("settings object")
            .insert(
                "futureSetting".to_string(),
                serde_json::json!({"preserve": true}),
            );
        fs::write(
            &settings_path,
            serde_json::to_vec_pretty(&settings_value).expect("settings JSON"),
        )
        .expect("future settings");

        let runtime = QuizRuntimeState::load_from(store_path.clone(), cache).expect("migration");
        assert!(runtime
            .provider_profiles()
            .iter()
            .any(|profile| profile.id == "api-legacy"));
        assert!(load_store(&store_path)
            .expect("migrated store")
            .api_profiles
            .is_empty());
        let settings = load_generator_settings(&settings_path).expect("generator settings");
        assert_eq!(settings.api_profiles.len(), 1);
        assert_eq!(settings.extra["futureSetting"]["preserve"], true);

        let mut external = settings.clone();
        external.revision = "settings-external-change".to_string();
        persist_generator_settings(&settings_path, &external).expect("external update");
        let error = runtime
            .save_generator_settings(SaveQuizGeneratorSettingsInput {
                expected_revision: settings.revision,
                default_profile_id: settings.default_profile_id,
                codex_cli: settings.codex_cli,
                claude_cli: settings.claude_cli,
            })
            .expect_err("concurrent update");
        assert!(error.contains("changed outside"));
        let _ = fs::remove_dir_all(root);
    }
}
