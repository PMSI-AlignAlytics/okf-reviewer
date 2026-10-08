//! Provider-neutral quiz generation transports.
//!
//! Scope, identity, validation, storage, and scoring remain application-owned.
//! CLI processes run from the trusted repository so they can inspect Git. The
//! application still owns the frozen OKF evidence, output schema, validation,
//! storage, and scoring boundary.

use crate::quiz::{
    self, QuizObservedSource, QuizObservedState, QuizValidation, QuizValidationInput,
};
use crate::quiz_runtime::{
    api_key, CodexReasoningEffort, FrozenQuizRun, QuizGenerationFailureKind, QuizProviderKind,
    QuizProviderProfile, QuizRuntimeState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::task::JoinHandle;
use uuid::Uuid;

const MAX_RAW_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_DIAGNOSTIC_BYTES: usize = 16 * 1024;
const GENERATION_TIMEOUT: Duration = Duration::from_secs(300);
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(15);
const PROVIDER_LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const LIVE_TEST_TIMEOUT: Duration = Duration::from_secs(120);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const AUTHENTICATION_REQUIRED_MESSAGE: &str = "Provider authentication is required.";
const CODEX_MODEL_CATALOG_INCOMPATIBLE_MESSAGE: &str =
    "This Codex CLI cannot read the current Codex model catalog. Update or reinstall Codex CLI, or choose a compatible Codex executable in Generator settings, then retry.";
const CODEX_AUTH_CREDENTIALS_OVERRIDE: &str = "cli_auth_credentials_store=\"auto\"";

#[derive(Default)]
struct BoundedCapture {
    bytes: Vec<u8>,
    truncated: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateQuizInput {
    pub request_id: String,
    pub profile_id: String,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizPromptPreview {
    pub provider_kind: QuizProviderKind,
    pub prompt: Option<String>,
    pub system_prompt: Option<String>,
    pub user_prompt: Option<String>,
    pub working_directory: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderPreflightInput {
    pub profile_id: String,
    pub model: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderLoginMode {
    Browser,
    DeviceCode,
    Terminal,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderLoginInput {
    pub profile_id: String,
    pub mode: ProviderLoginMode,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLoginResult {
    pub authenticated: bool,
    pub cancelled: bool,
    pub message: String,
}

#[derive(Debug, PartialEq, Eq)]
struct CliLoginOutcome {
    succeeded: bool,
    cancelled: bool,
    diagnostic: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuizGenerationState {
    Generating,
    Validating,
    Ready,
    AuthenticationRequired,
    InsufficientEvidence,
    InvalidOutput,
    ProviderError,
    Cancelled,
    Stale,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthenticationGuidance {
    pub resolved_display_path: String,
    pub login_command: String,
    pub device_code_login_command: Option<String>,
    pub status_command: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizGenerationProgress {
    pub request_id: String,
    pub state: QuizGenerationState,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuizGenerationOutcome {
    pub request_id: String,
    pub state: QuizGenerationState,
    pub quiz_id: Option<String>,
    pub failure_id: Option<String>,
    pub warnings: Vec<String>,
    pub issues: Vec<crate::quiz::QuizValidationIssue>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreflight {
    pub profile: QuizProviderProfile,
    pub available: bool,
    pub authentication_required: bool,
    pub message: String,
    pub structured_output: bool,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub authentication_guidance: Option<ProviderAuthenticationGuidance>,
    pub tested_at: String,
    pub live: bool,
}

#[derive(Clone, Debug)]
struct Executable {
    program: PathBuf,
    prefix: Vec<OsString>,
}

#[derive(Debug)]
enum GenerationFailure {
    AuthenticationRequired(String),
    Other(String),
}

impl From<String> for GenerationFailure {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

struct TemporaryWorkspace {
    path: PathBuf,
}

impl TemporaryWorkspace {
    fn create_empty(cache_root: &Path, prefix: &str) -> Result<Self, String> {
        fs::create_dir_all(cache_root)
            .map_err(|_| "OKF Reviewer could not create the quiz generation cache.".to_string())?;
        let canonical_cache = dunce::canonicalize(cache_root)
            .map_err(|_| "OKF Reviewer could not inspect the quiz generation cache.".to_string())?;
        let path = canonical_cache.join(format!("{prefix}-{}", Uuid::new_v4()));
        fs::create_dir(&path).map_err(|_| {
            "OKF Reviewer could not create an isolated provider workspace.".to_string()
        })?;
        Ok(Self { path })
    }

    fn create(cache_root: &Path, run: &FrozenQuizRun) -> Result<Self, String> {
        let workspace = Self::create_empty(cache_root, "run")?;
        workspace.write_bounded(
            "provider-output.schema.json",
            quiz::provider_schema_contents().as_bytes(),
        )?;
        let _ = run;
        Ok(workspace)
    }

    fn write_bounded(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("A quiz generation workspace resource is oversized.".to_string());
        }
        let relative = Path::new(name);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err("A quiz generation workspace path is unsafe.".to_string());
        }
        let path = self.path.join(relative);
        let parent = path
            .parent()
            .ok_or_else(|| "A quiz generation workspace path is unsafe.".to_string())?;
        fs::create_dir_all(parent).map_err(|_| {
            "OKF Reviewer could not create the isolated quiz workspace.".to_string()
        })?;
        File::create(path)
            .and_then(|mut file| file.write_all(bytes).and_then(|_| file.sync_all()))
            .map_err(|_| "OKF Reviewer could not write the isolated quiz workspace.".to_string())
    }
}

impl Drop for TemporaryWorkspace {
    fn drop(&mut self) {
        if let Some(cache) = self
            .path
            .parent()
            .and_then(|path| dunce::canonicalize(path).ok())
        {
            if let Ok(workspace) = dunce::canonicalize(&self.path) {
                if workspace.starts_with(&cache) && workspace != cache {
                    let _ = fs::remove_dir_all(workspace);
                }
            }
        }
    }
}

pub async fn preflight(profile: QuizProviderProfile, model: Option<String>) -> ProviderPreflight {
    match profile.kind {
        QuizProviderKind::CodexCli => cli_preflight(profile, model, CliKind::Codex).await,
        QuizProviderKind::ClaudeCli => cli_preflight(profile, model, CliKind::Claude).await,
        QuizProviderKind::ModelApi => api_preflight(profile),
    }
}

pub async fn live_test(
    profile: QuizProviderProfile,
    model: Option<String>,
    cache_root: &Path,
) -> ProviderPreflight {
    let checked = preflight(profile.clone(), model.clone()).await;
    if !checked.available || profile.kind == QuizProviderKind::ModelApi {
        return ProviderPreflight {
            live: true,
            ..checked
        };
    }
    let kind = match profile.kind {
        QuizProviderKind::CodexCli => CliKind::Codex,
        QuizProviderKind::ClaudeCli => CliKind::Claude,
        QuizProviderKind::ModelApi => unreachable!(),
    };
    let executable = match resolve_cli(kind, profile.executable_path.as_deref()) {
        Ok(executable) => executable,
        Err(message) => {
            return ProviderPreflight {
                profile,
                available: false,
                authentication_required: false,
                message,
                structured_output: false,
                executable: checked.executable,
                version: checked.version,
                authentication_guidance: checked.authentication_guidance,
                tested_at: now_timestamp(),
                live: true,
            }
        }
    };
    match run_cli_live_test(
        &executable,
        kind,
        cache_root,
        model.as_deref().or(profile.model.as_deref()),
        profile.reasoning_effort,
    )
    .await
    {
        Ok(()) => ProviderPreflight {
            profile,
            available: true,
            authentication_required: false,
            message: "The configured CLI completed a live structured-output test without receiving bundle content."
                .to_string(),
            structured_output: true,
            executable: checked.executable,
            version: checked.version,
            authentication_guidance: checked.authentication_guidance,
            tested_at: now_timestamp(),
            live: true,
        },
        Err(message) => ProviderPreflight {
            profile,
            available: false,
            authentication_required: message.to_ascii_lowercase().contains("auth"),
            message,
            structured_output: false,
            executable: checked.executable,
            version: checked.version,
            authentication_guidance: checked.authentication_guidance,
            tested_at: now_timestamp(),
            live: true,
        },
    }
}

pub async fn generate(
    app: &AppHandle,
    runtime: &QuizRuntimeState,
    input: GenerateQuizInput,
) -> QuizGenerationOutcome {
    let request_id = input.request_id.clone();
    let frozen = runtime.frozen_packet(&request_id).ok();
    let provider = runtime.provider_profile(&input.profile_id);
    let effective_model = input
        .model
        .clone()
        .or_else(|| provider.as_ref().and_then(|profile| profile.model.clone()));
    let mut outcome = match generate_inner(app, runtime, input).await {
        Ok(outcome) => outcome,
        Err(error) => {
            runtime.finish_generation(&request_id);
            let (state, message) = match error {
                GenerationFailure::AuthenticationRequired(message) => {
                    (QuizGenerationState::AuthenticationRequired, message)
                }
                GenerationFailure::Other(message) => (QuizGenerationState::ProviderError, message),
            };
            emit_progress(app, &request_id, state, &message);
            QuizGenerationOutcome {
                request_id,
                state,
                quiz_id: None,
                failure_id: None,
                warnings: Vec::new(),
                issues: Vec::new(),
                message: bounded_diagnostic(&message),
            }
        }
    };
    let failure_kind = failure_kind_for_state(outcome.state);
    if let (Some(kind), Some(run), Some(profile)) = (failure_kind, frozen, provider) {
        let mut diagnostic_parts = vec![outcome.message.clone()];
        diagnostic_parts.extend(outcome.warnings.iter().cloned());
        diagnostic_parts.extend(outcome.issues.iter().map(|issue| issue.message.clone()));
        let diagnostic = diagnostic_parts
            .into_iter()
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        match runtime.save_generation_failure(&run, &profile, effective_model, kind, &diagnostic) {
            Ok(failure_id) => outcome.failure_id = Some(failure_id),
            Err(error) => {
                outcome.message = format!(
                    "{} Retry details could not be saved: {}",
                    outcome.message,
                    bounded_diagnostic(&error)
                );
            }
        }
    }
    outcome
}

pub fn prompt_preview(
    runtime: &QuizRuntimeState,
    input: &GenerateQuizInput,
) -> Result<QuizPromptPreview, String> {
    validate_model(input.model.as_deref())?;
    let profile = runtime
        .provider_profile(&input.profile_id)
        .ok_or_else(|| "The selected quiz provider profile no longer exists.".to_string())?;
    let run = runtime.frozen_packet(&input.request_id)?;
    if run.packet.generation.mode == crate::quiz_runtime::QuizGenerationMode::Automatic
        && profile.kind == QuizProviderKind::ModelApi
    {
        return Err("Automatic quiz generation requires Codex CLI or Claude Code.".to_string());
    }
    let working_directory = match profile.kind {
        QuizProviderKind::CodexCli | QuizProviderKind::ClaudeCli => {
            Some(cli_working_directory(&run)?.to_string_lossy().into_owned())
        }
        QuizProviderKind::ModelApi => None,
    };
    match profile.kind {
        QuizProviderKind::CodexCli | QuizProviderKind::ClaudeCli => Ok(QuizPromptPreview {
            provider_kind: profile.kind,
            prompt: Some(provider_prompt(&run)?),
            system_prompt: None,
            user_prompt: None,
            working_directory,
        }),
        QuizProviderKind::ModelApi => Ok(QuizPromptPreview {
            provider_kind: profile.kind,
            prompt: None,
            system_prompt: Some(quiz::skill_contents().to_string()),
            user_prompt: Some(api_user_prompt(&run)?),
            working_directory: None,
        }),
    }
}

fn failure_kind_for_state(state: QuizGenerationState) -> Option<QuizGenerationFailureKind> {
    match state {
        QuizGenerationState::ProviderError => Some(QuizGenerationFailureKind::ProviderError),
        QuizGenerationState::InvalidOutput => Some(QuizGenerationFailureKind::InvalidOutput),
        QuizGenerationState::InsufficientEvidence => {
            Some(QuizGenerationFailureKind::InsufficientEvidence)
        }
        QuizGenerationState::Stale => Some(QuizGenerationFailureKind::Stale),
        QuizGenerationState::Generating
        | QuizGenerationState::Validating
        | QuizGenerationState::Ready
        | QuizGenerationState::AuthenticationRequired
        | QuizGenerationState::Cancelled => None,
    }
}

async fn generate_inner(
    app: &AppHandle,
    runtime: &QuizRuntimeState,
    input: GenerateQuizInput,
) -> Result<QuizGenerationOutcome, GenerationFailure> {
    let profile = runtime
        .provider_profile(&input.profile_id)
        .ok_or_else(|| "The selected quiz provider profile no longer exists.".to_string())?;
    validate_model(input.model.as_deref())?;
    let run = runtime.frozen_packet(&input.request_id)?;
    if run.packet.generation.mode == crate::quiz_runtime::QuizGenerationMode::Automatic
        && profile.kind == QuizProviderKind::ModelApi
    {
        return Err(
            "Automatic quiz generation requires Codex CLI or Claude Code. Enable the manual override to use a model API profile."
                .to_string()
                .into(),
        );
    }
    let cancellation = runtime.begin_generation(&input.request_id)?;
    let _completion = GenerationCompletion {
        runtime,
        request_id: input.request_id.clone(),
    };

    if let Some(message) = crate::quiz_runtime::frozen_run_stale_reason(&run)? {
        runtime.remove_frozen_packet(&input.request_id);
        return Ok(QuizGenerationOutcome {
            request_id: input.request_id,
            state: QuizGenerationState::Stale,
            quiz_id: None,
            failure_id: None,
            warnings: Vec::new(),
            issues: Vec::new(),
            message,
        });
    }

    emit_progress(
        app,
        &input.request_id,
        QuizGenerationState::Generating,
        "Generating from the frozen quiz target and bundle context…",
    );
    let raw_result = match profile.kind {
        QuizProviderKind::CodexCli => {
            generate_cli(
                &run,
                runtime.cache_root(),
                input.model.as_deref().or(profile.model.as_deref()),
                &cancellation,
                CliKind::Codex,
                &profile,
            )
            .await
        }
        QuizProviderKind::ClaudeCli => {
            generate_cli(
                &run,
                runtime.cache_root(),
                input.model.as_deref().or(profile.model.as_deref()),
                &cancellation,
                CliKind::Claude,
                &profile,
            )
            .await
        }
        QuizProviderKind::ModelApi => generate_api(
            &run,
            &profile,
            input.model.as_deref().or(profile.model.as_deref()),
            &cancellation,
        )
        .await
        .map_err(GenerationFailure::Other),
    };
    let raw_output = match raw_result {
        Ok(raw_output) => raw_output,
        Err(_) if cancellation.load(Ordering::Acquire) => {
            runtime.remove_frozen_packet(&input.request_id);
            return Ok(cancelled_outcome(input.request_id));
        }
        Err(error) => return Err(error),
    };
    if cancellation.load(Ordering::Acquire) {
        runtime.remove_frozen_packet(&input.request_id);
        return Ok(cancelled_outcome(input.request_id));
    }
    if let Some(message) = crate::quiz_runtime::frozen_run_stale_reason(&run)? {
        runtime.remove_frozen_packet(&input.request_id);
        return Ok(QuizGenerationOutcome {
            request_id: input.request_id,
            state: QuizGenerationState::Stale,
            quiz_id: None,
            failure_id: None,
            warnings: Vec::new(),
            issues: Vec::new(),
            message,
        });
    }

    emit_progress(
        app,
        &input.request_id,
        QuizGenerationState::Validating,
        "Validating the generated quiz against its evidence…",
    );
    let validation = quiz::validate_output(&QuizValidationInput {
        request: run.packet.request.clone(),
        current_state: observed_state(&run),
        raw_output: Some(raw_output),
    });
    let outcome = match validation {
        QuizValidation::Ready { quiz } => {
            let warnings = quiz.warnings.clone();
            let quiz_id = runtime.save_generated_quiz(
                &run,
                *quiz,
                &profile,
                input.model.or_else(|| profile.model.clone()),
            )?;
            QuizGenerationOutcome {
                request_id: input.request_id,
                state: QuizGenerationState::Ready,
                quiz_id: Some(quiz_id),
                failure_id: None,
                warnings,
                issues: Vec::new(),
                message: "Quiz generated and validated.".to_string(),
            }
        }
        QuizValidation::InsufficientEvidence { result } => {
            runtime.remove_frozen_packet(&input.request_id);
            QuizGenerationOutcome {
                request_id: input.request_id,
                state: QuizGenerationState::InsufficientEvidence,
                quiz_id: None,
                failure_id: None,
                warnings: result.warnings,
                issues: Vec::new(),
                message: "The selected evidence could not support an adequate quiz.".to_string(),
            }
        }
        QuizValidation::Stale { issues } => {
            runtime.remove_frozen_packet(&input.request_id);
            QuizGenerationOutcome {
                request_id: input.request_id,
                state: QuizGenerationState::Stale,
                quiz_id: None,
                failure_id: None,
                warnings: Vec::new(),
                issues,
                message: "The selected knowledge changed before validation completed.".to_string(),
            }
        }
        QuizValidation::Invalid { issues } => {
            runtime.remove_frozen_packet(&input.request_id);
            QuizGenerationOutcome {
                request_id: input.request_id,
                state: QuizGenerationState::InvalidOutput,
                quiz_id: None,
                failure_id: None,
                warnings: Vec::new(),
                issues,
                message: "The provider output did not pass trusted validation.".to_string(),
            }
        }
        QuizValidation::NoOutput => {
            runtime.remove_frozen_packet(&input.request_id);
            QuizGenerationOutcome {
                request_id: input.request_id,
                state: QuizGenerationState::InvalidOutput,
                quiz_id: None,
                failure_id: None,
                warnings: Vec::new(),
                issues: Vec::new(),
                message: "The provider returned no quiz output.".to_string(),
            }
        }
    };
    emit_progress(app, &outcome.request_id, outcome.state, &outcome.message);
    Ok(outcome)
}

struct GenerationCompletion<'a> {
    runtime: &'a QuizRuntimeState,
    request_id: String,
}

impl Drop for GenerationCompletion<'_> {
    fn drop(&mut self) {
        self.runtime.finish_generation(&self.request_id);
    }
}

#[derive(Clone, Copy)]
enum CliKind {
    Codex,
    Claude,
}

#[derive(Debug)]
struct AuthenticationFailure {
    message: String,
    authentication_required: bool,
}

async fn cli_preflight(
    profile: QuizProviderProfile,
    _model: Option<String>,
    kind: CliKind,
) -> ProviderPreflight {
    let tested_at = now_timestamp();
    let executable = match resolve_cli(kind, profile.executable_path.as_deref()) {
        Ok(executable) => executable,
        Err(message) => {
            return ProviderPreflight {
                profile,
                available: false,
                authentication_required: false,
                message,
                structured_output: false,
                executable: None,
                version: None,
                authentication_guidance: None,
                tested_at,
                live: false,
            };
        }
    };
    let executable_path = executable.program.to_string_lossy().into_owned();
    let authentication_guidance = provider_authentication_guidance(kind, &executable);
    let version = match run_cli_capture(&executable, kind, &["--version"]).await {
        Ok((true, output)) if !output.trim().is_empty() => {
            output.lines().next().map(str::to_string)
        }
        Ok((true, _)) => {
            return ProviderPreflight {
                profile,
                available: false,
                authentication_required: false,
                message: format!(
                    "The provider CLI at '{executable_path}' started but returned no version."
                ),
                structured_output: false,
                executable: Some(executable_path),
                version: None,
                authentication_guidance,
                tested_at,
                live: false,
            }
        }
        Ok((false, output)) => {
            let diagnostic = bounded_diagnostic(&output);
            let detail = if diagnostic.is_empty() {
                "It exited unsuccessfully without a diagnostic.".to_string()
            } else {
                format!("It reported: {diagnostic}")
            };
            return ProviderPreflight {
                profile,
                available: false,
                authentication_required: false,
                message: format!(
                    "The provider CLI at '{executable_path}' failed its version check. {detail}"
                ),
                structured_output: false,
                executable: Some(executable_path),
                version: None,
                authentication_guidance,
                tested_at,
                live: false,
            };
        }
        Err(message) => {
            return ProviderPreflight {
                profile,
                available: false,
                authentication_required: false,
                message,
                structured_output: false,
                executable: Some(executable_path),
                version: None,
                authentication_guidance,
                tested_at,
                live: false,
            };
        }
    };
    let contract = if matches!(kind, CliKind::Codex) {
        run_help(&executable, kind)
            .await
            .is_ok_and(|help| help_contract(kind, &help))
    } else {
        true
    };
    if !contract {
        return ProviderPreflight {
            profile,
            available: false,
            authentication_required: false,
            message: "The installed Codex CLI does not expose the required non-persistent structured-output options."
                .to_string(),
            structured_output: false,
            executable: Some(executable_path),
            version,
            authentication_guidance,
            tested_at,
            live: false,
        };
    }
    match ensure_cli_authenticated(&executable, kind).await {
        Ok(()) => ProviderPreflight {
            profile,
            available: true,
            authentication_required: false,
            message: match kind {
                CliKind::Codex => {
                    "Codex CLI is installed, authenticated, and supports structured output."
                }
                CliKind::Claude => {
                    "Claude Code CLI is installed and authenticated for structured output."
                }
            }
            .to_string(),
            structured_output: true,
            executable: Some(executable_path),
            version,
            authentication_guidance,
            tested_at,
            live: false,
        },
        Err(failure) => ProviderPreflight {
            profile,
            available: false,
            authentication_required: failure.authentication_required,
            message: failure.message,
            structured_output: true,
            executable: Some(executable_path),
            version,
            authentication_guidance,
            tested_at,
            live: false,
        },
    }
}

fn provider_login_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn active_provider_login() -> &'static Mutex<Option<Arc<AtomicBool>>> {
    static ACTIVE: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

pub fn cancel_login() -> bool {
    let cancellation = active_provider_login()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    if let Some(cancellation) = cancellation {
        cancellation.store(true, Ordering::Release);
        true
    } else {
        false
    }
}

pub async fn login(
    profile: QuizProviderProfile,
    mode: ProviderLoginMode,
) -> Result<ProviderLoginResult, String> {
    let kind = match profile.kind {
        QuizProviderKind::CodexCli => {
            return Err(
                "Sign in to the Codex CLI from a terminal, then check again in OKF Reviewer."
                    .to_string(),
            )
        }
        QuizProviderKind::ClaudeCli => CliKind::Claude,
        QuizProviderKind::ModelApi => {
            return Err(
                "Interactive sign-in is available only for Codex and Claude Code CLI profiles."
                    .to_string(),
            )
        }
    };
    validate_login_mode(kind, mode)?;
    let executable = resolve_cli(kind, profile.executable_path.as_deref())?;
    let _guard = provider_login_lock().lock().await;
    let cancellation = Arc::new(AtomicBool::new(false));
    *active_provider_login()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(cancellation.clone());
    let result = async {
        if cli_authenticated(&executable, kind).await? {
            return Ok(ProviderLoginResult {
                authenticated: true,
                cancelled: false,
                message: format!("{} is already signed in.", cli_name(kind)),
            });
        }
        if cancellation.load(Ordering::Acquire) {
            return Ok(cancelled_login_result(kind));
        }
        let login = run_cli_login(&executable, kind, mode, &cancellation).await?;
        if login.cancelled {
            return Ok(cancelled_login_result(kind));
        }
        if !login.succeeded {
            return Ok(ProviderLoginResult {
                authenticated: false,
                cancelled: false,
                message: login_failure_message(&login.diagnostic),
            });
        }
        let authenticated = cli_authenticated(&executable, kind).await?;
        Ok(ProviderLoginResult {
            authenticated,
            cancelled: false,
            message: if authenticated {
                format!("{} sign-in completed.", cli_name(kind))
            } else {
                format!(
                    "{} sign-in finished, but no authenticated session was found.",
                    cli_name(kind)
                )
            },
        })
    }
    .await;
    *active_provider_login()
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
    result
}

fn cancelled_login_result(kind: CliKind) -> ProviderLoginResult {
    ProviderLoginResult {
        authenticated: false,
        cancelled: true,
        message: format!("{} sign-in was cancelled.", cli_name(kind)),
    }
}

fn cli_name(kind: CliKind) -> &'static str {
    match kind {
        CliKind::Codex => "Codex",
        CliKind::Claude => "Claude Code",
    }
}

fn cli_auth_context_args(kind: CliKind) -> &'static [&'static str] {
    match kind {
        CliKind::Codex => &["--config", CODEX_AUTH_CREDENTIALS_OVERRIDE],
        CliKind::Claude => &[],
    }
}

fn apply_cli_auth_context(command: &mut Command, kind: CliKind) {
    command.args(cli_auth_context_args(kind));
}

fn cli_command(executable: &Executable, kind: CliKind) -> Command {
    let mut command = Command::new(&executable.program);
    command.args(&executable.prefix);
    apply_cli_auth_context(&mut command, kind);
    filtered_environment(&mut command, kind);
    command
}

fn provider_authentication_guidance(
    kind: CliKind,
    executable: &Executable,
) -> Option<ProviderAuthenticationGuidance> {
    matches!(kind, CliKind::Codex).then(|| ProviderAuthenticationGuidance {
        resolved_display_path: executable
            .prefix
            .first()
            .map(OsString::as_os_str)
            .unwrap_or_else(|| executable.program.as_os_str())
            .to_string_lossy()
            .into_owned(),
        login_command: display_cli_command(executable, kind, &["login"]),
        device_code_login_command: Some(display_cli_command(
            executable,
            kind,
            &["login", "--device-auth"],
        )),
        status_command: display_cli_command(executable, kind, &["login", "status"]),
    })
}

fn display_cli_command(executable: &Executable, kind: CliKind, args: &[&str]) -> String {
    let mut tokens = Vec::with_capacity(
        1 + executable.prefix.len() + cli_auth_context_args(kind).len() + args.len(),
    );
    tokens.push(executable.program.as_os_str());
    tokens.extend(executable.prefix.iter().map(OsString::as_os_str));
    tokens.extend(cli_auth_context_args(kind).iter().map(OsStr::new));
    tokens.extend(args.iter().map(OsStr::new));
    let command = tokens
        .into_iter()
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    if cfg!(windows) {
        format!("& {command}")
    } else {
        command
    }
}

fn shell_quote(value: &OsStr) -> String {
    let value = value.to_string_lossy();
    if cfg!(windows) {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn validate_login_mode(kind: CliKind, mode: ProviderLoginMode) -> Result<(), String> {
    match (kind, mode) {
        (CliKind::Claude, ProviderLoginMode::Browser | ProviderLoginMode::Terminal) => Ok(()),
        (CliKind::Codex, _) => Err(
            "Sign in to the Codex CLI from a terminal, then check again in OKF Reviewer."
                .to_string(),
        ),
        (CliKind::Claude, ProviderLoginMode::DeviceCode) => Err(
            "Claude Code does not expose device-code sign-in; use its command window.".to_string(),
        ),
    }
}

fn login_failure_message(diagnostic: &str) -> String {
    let guidance =
        "Claude Code sign-in did not complete. Try again in the command window.".to_string();
    let diagnostic = bounded_diagnostic(diagnostic);
    if diagnostic.is_empty() {
        guidance
    } else {
        format!("{guidance} The CLI reported: {diagnostic}")
    }
}

async fn cli_authenticated(executable: &Executable, kind: CliKind) -> Result<bool, String> {
    let auth_args: &[&str] = match kind {
        CliKind::Codex => &["login", "status"],
        CliKind::Claude => &["auth", "status"],
    };
    run_cli_capture(executable, kind, auth_args)
        .await
        .map(|result| result.0)
}

async fn ensure_cli_authenticated(
    executable: &Executable,
    kind: CliKind,
) -> Result<(), AuthenticationFailure> {
    let authenticated = cli_authenticated(executable, kind)
        .await
        .map_err(|message| AuthenticationFailure {
            message,
            authentication_required: false,
        })?;
    if authenticated {
        return Ok(());
    }
    Err(AuthenticationFailure {
        message: AUTHENTICATION_REQUIRED_MESSAGE.to_string(),
        authentication_required: true,
    })
}

fn api_preflight(profile: QuizProviderProfile) -> ProviderPreflight {
    let credential = api_key(&profile.id);
    let available = credential.is_ok()
        && profile
            .endpoint
            .as_deref()
            .is_some_and(|endpoint| !endpoint.is_empty())
        && profile
            .model
            .as_deref()
            .is_some_and(|model| !model.is_empty());
    ProviderPreflight {
        profile,
        available,
        authentication_required: credential.is_err(),
        message: if available {
            "The model API profile is configured. Connectivity will be checked during generation."
                .to_string()
        } else {
            "This model API profile needs an endpoint, model, and stored credential.".to_string()
        },
        structured_output: true,
        executable: None,
        version: None,
        authentication_guidance: None,
        tested_at: now_timestamp(),
        live: false,
    }
}

async fn generate_cli(
    run: &FrozenQuizRun,
    cache_root: &Path,
    model: Option<&str>,
    cancellation: &Arc<AtomicBool>,
    kind: CliKind,
    profile: &QuizProviderProfile,
) -> Result<String, GenerationFailure> {
    let executable = resolve_cli(kind, profile.executable_path.as_deref())?;
    let version = run_cli_capture(&executable, kind, &["--version"]).await?;
    if !version.0 {
        return Err(GenerationFailure::Other(
            "The provider CLI could not report its version.".to_string(),
        ));
    }
    if matches!(kind, CliKind::Codex) {
        let help = run_help(&executable, kind).await?;
        if !help_contract(kind, &help) {
            return Err(GenerationFailure::Other(
                "The installed Codex CLI lacks the required non-persistent quiz generation contract."
                    .to_string(),
            ));
        }
    }
    ensure_cli_authenticated(&executable, kind)
        .await
        .map_err(|failure| {
            if failure.authentication_required {
                GenerationFailure::AuthenticationRequired(failure.message)
            } else {
                GenerationFailure::Other(failure.message)
            }
        })?;
    generate_cli_with_executable(
        run,
        cache_root,
        model,
        profile.reasoning_effort,
        cancellation,
        kind,
        &executable,
    )
    .await
    .map_err(classify_generation_failure)
}

async fn generate_cli_with_executable(
    run: &FrozenQuizRun,
    cache_root: &Path,
    model: Option<&str>,
    reasoning_effort: Option<CodexReasoningEffort>,
    cancellation: &Arc<AtomicBool>,
    kind: CliKind,
    executable: &Executable,
) -> Result<String, String> {
    let workspace = TemporaryWorkspace::create(cache_root, run)?;
    let output_path = workspace.path.join("quiz-output.json");
    let prompt = provider_prompt(run)?;
    let working_directory = cli_working_directory(run)?;
    let mut command = cli_command(executable, kind);
    match kind {
        CliKind::Codex => {
            command.args([
                OsStr::new("exec"),
                OsStr::new("--ephemeral"),
                OsStr::new("--output-schema"),
            ]);
            command.arg(workspace.path.join("provider-output.schema.json"));
            command.arg("--output-last-message").arg(&output_path);
            command.arg("--color").arg("never");
            command.arg("-C").arg(working_directory);
            if let Some(model) = model {
                command.arg("--model").arg(model);
            }
            apply_codex_reasoning_effort(&mut command, reasoning_effort);
            command.arg("-");
        }
        CliKind::Claude => {
            command.args([
                OsStr::new("-p"),
                OsStr::new("--no-session-persistence"),
                OsStr::new("--output-format"),
                OsStr::new("json"),
                OsStr::new("--max-turns"),
                OsStr::new("1"),
                OsStr::new("--json-schema"),
            ]);
            command.arg(quiz::provider_schema_contents());
            if let Some(model) = model {
                command.arg("--model").arg(model);
            }
        }
    }
    command
        .current_dir(working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_background_process(&mut command);
    let mut child = command.spawn().map_err(|_| {
        "The quiz harness could not start in the selected repository working directory.".to_string()
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The provider process did not expose bounded output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "The provider process did not expose bounded diagnostics.".to_string())?;
    let stdout_limit = match kind {
        CliKind::Codex => MAX_DIAGNOSTIC_BYTES,
        CliKind::Claude => MAX_RAW_OUTPUT_BYTES,
    };
    let stdout_capture = spawn_bounded_capture(stdout, stdout_limit);
    let stderr_capture = spawn_bounded_capture(stderr, MAX_DIAGNOSTIC_BYTES);
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "The provider process did not accept quiz instructions.".to_string())?;
    use tokio::io::AsyncWriteExt;
    if stdin.write_all(prompt.as_bytes()).await.is_err() {
        drop(stdin);
        terminate_process_tree(&mut child).await;
        finish_captures(stdout_capture, stderr_capture).await;
        return Err(
            "OKF Reviewer could not send the frozen quiz task to the provider.".to_string(),
        );
    }
    drop(stdin);
    let started = Instant::now();
    let status = loop {
        if final_output_exceeded(&output_path) {
            terminate_process_tree(&mut child).await;
            finish_captures(stdout_capture, stderr_capture).await;
            return Err(final_output_too_large());
        }
        if cancellation.load(Ordering::Acquire) {
            terminate_process_tree(&mut child).await;
            finish_captures(stdout_capture, stderr_capture).await;
            return Err("Quiz generation was cancelled.".to_string());
        }
        if started.elapsed() >= GENERATION_TIMEOUT {
            terminate_process_tree(&mut child).await;
            finish_captures(stdout_capture, stderr_capture).await;
            return Err("The quiz provider timed out.".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => {
                terminate_process_tree(&mut child).await;
                finish_captures(stdout_capture, stderr_capture).await;
                return Err("OKF Reviewer could not monitor the provider process.".to_string());
            }
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    };
    let (stdout, stderr) = finish_captures(stdout_capture, stderr_capture).await;
    if final_output_exceeded(&output_path) {
        return Err(final_output_too_large());
    }
    if !status.success() {
        let diagnostic = capture_diagnostic(&stderr, &stdout);
        return Err(classify_provider_error(&diagnostic));
    }
    let raw = match kind {
        CliKind::Codex => read_bounded_file(&output_path, MAX_RAW_OUTPUT_BYTES)?,
        CliKind::Claude => {
            if stdout.truncated {
                return Err(final_output_too_large());
            }
            let wrapper = String::from_utf8(stdout.bytes)
                .map_err(|_| "The provider output was not valid UTF-8.".to_string())?;
            normalize_claude_output(&wrapper)?
        }
    };
    Ok(raw)
}

async fn run_cli_live_test(
    executable: &Executable,
    kind: CliKind,
    cache_root: &Path,
    model: Option<&str>,
    reasoning_effort: Option<CodexReasoningEffort>,
) -> Result<(), String> {
    validate_model(model)?;
    let workspace = TemporaryWorkspace::create_empty(cache_root, "setup-test")?;
    workspace.write_bounded(
        "setup-test.schema.json",
        quiz::provider_schema_contents().as_bytes(),
    )?;
    let output_path = workspace.path.join("setup-test-output.json");
    let mut command = cli_command(executable, kind);
    match kind {
        CliKind::Codex => {
            command.args([
                OsStr::new("exec"),
                OsStr::new("--skip-git-repo-check"),
                OsStr::new("--ephemeral"),
                OsStr::new("--ignore-user-config"),
                OsStr::new("--ignore-rules"),
                OsStr::new("--sandbox"),
                OsStr::new("read-only"),
                OsStr::new("--output-schema"),
            ]);
            command.arg(workspace.path.join("setup-test.schema.json"));
            command.arg("--output-last-message").arg(&output_path);
            command.arg("--color").arg("never");
            command.arg("-C").arg(&workspace.path);
            if let Some(model) = model {
                command.arg("--model").arg(model);
            }
            apply_codex_reasoning_effort(&mut command, reasoning_effort);
            command.arg("-");
        }
        CliKind::Claude => {
            command.args([
                OsStr::new("--bare"),
                OsStr::new("-p"),
                OsStr::new("--no-session-persistence"),
                OsStr::new("--output-format"),
                OsStr::new("json"),
                OsStr::new("--max-turns"),
                OsStr::new("1"),
                OsStr::new("--tools"),
                OsStr::new(""),
                OsStr::new("--disable-slash-commands"),
                OsStr::new("--setting-sources"),
                OsStr::new(""),
                OsStr::new("--strict-mcp-config"),
                OsStr::new("--mcp-config"),
                OsStr::new("{\"mcpServers\":{}}"),
                OsStr::new("--json-schema"),
                OsStr::new(quiz::provider_schema_contents()),
            ]);
            if let Some(model) = model {
                command.arg("--model").arg(model);
            }
        }
    }
    command
        .current_dir(&workspace.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_background_process(&mut command);
    let mut child = command.spawn().map_err(|_| cli_missing_message(kind))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The provider CLI did not expose live-test output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "The provider CLI did not expose live-test diagnostics.".to_string())?;
    let stdout_limit = match kind {
        CliKind::Codex => MAX_DIAGNOSTIC_BYTES,
        CliKind::Claude => MAX_RAW_OUTPUT_BYTES,
    };
    let stdout_capture = spawn_bounded_capture(stdout, stdout_limit);
    let stderr_capture = spawn_bounded_capture(stderr, MAX_DIAGNOSTIC_BYTES);
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "The provider CLI did not accept setup-test input.".to_string())?;
    use tokio::io::AsyncWriteExt;
    if stdin
        .write_all(
            br#"Return exactly this JSON object and no other text:
{"schemaVersion":1,"requestId":"setup-test","bundleFingerprint":"setup-test","scopeFingerprint":"setup-test","status":"insufficient-evidence","title":"Provider setup test","questions":[],"warnings":["No bundle evidence was supplied to this setup test."]}
This setup test contains no bundle content."#,
        )
        .await
        .is_err()
    {
        drop(stdin);
        terminate_process_tree(&mut child).await;
        finish_captures(stdout_capture, stderr_capture).await;
        return Err("The provider CLI did not accept setup-test input.".to_string());
    }
    drop(stdin);
    let status = match tokio::time::timeout(LIVE_TEST_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            finish_captures(stdout_capture, stderr_capture).await;
            return Err("The live provider setup test could not complete.".to_string());
        }
        Err(_) => {
            terminate_process_tree(&mut child).await;
            finish_captures(stdout_capture, stderr_capture).await;
            return Err("The live provider setup test timed out.".to_string());
        }
    };
    let (stdout, stderr) = finish_captures(stdout_capture, stderr_capture).await;
    if !status.success() {
        let diagnostic = capture_diagnostic(&stderr, &stdout);
        return Err(classify_provider_error(&diagnostic));
    }
    let raw = match kind {
        CliKind::Codex => {
            if final_output_exceeded(&output_path) {
                return Err(final_output_too_large());
            }
            read_bounded_file(&output_path, MAX_RAW_OUTPUT_BYTES)?
        }
        CliKind::Claude => {
            if stdout.truncated {
                return Err(final_output_too_large());
            }
            let wrapper = String::from_utf8(stdout.bytes)
                .map_err(|_| "The provider output was not valid UTF-8.".to_string())?;
            normalize_claude_output(&wrapper)?
        }
    };
    let value: Value = serde_json::from_str(&raw)
        .map_err(|_| "The live provider test did not return structured JSON.".to_string())?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || value.get("requestId").and_then(Value::as_str) != Some("setup-test")
        || value.get("status").and_then(Value::as_str) != Some("insufficient-evidence")
        || value
            .get("questions")
            .and_then(Value::as_array)
            .is_none_or(|questions| !questions.is_empty())
    {
        return Err("The live provider test returned an unexpected structured result.".to_string());
    }
    Ok(())
}

fn apply_codex_reasoning_effort(
    command: &mut Command,
    reasoning_effort: Option<CodexReasoningEffort>,
) {
    if let Some(reasoning_effort) = reasoning_effort {
        command.arg("-c").arg(format!(
            "model_reasoning_effort=\"{}\"",
            reasoning_effort.as_str()
        ));
    }
}

fn spawn_bounded_capture<R>(mut reader: R, maximum: usize) -> JoinHandle<BoundedCapture>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut capture = BoundedCapture {
            bytes: Vec::with_capacity(maximum.min(16 * 1024)),
            truncated: false,
        };
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            let read = match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let retained = read.min(maximum.saturating_sub(capture.bytes.len()));
            capture.bytes.extend_from_slice(&buffer[..retained]);
            capture.truncated |= retained < read;
        }
        capture
    })
}

async fn finish_captures(
    stdout: JoinHandle<BoundedCapture>,
    stderr: JoinHandle<BoundedCapture>,
) -> (BoundedCapture, BoundedCapture) {
    let (stdout, stderr) = tokio::join!(stdout, stderr);
    (stdout.unwrap_or_default(), stderr.unwrap_or_default())
}

fn capture_diagnostic(stderr: &BoundedCapture, stdout: &BoundedCapture) -> String {
    let capture = if stderr.bytes.is_empty() {
        stdout
    } else {
        stderr
    };
    if capture.bytes.is_empty() {
        "No bounded provider diagnostic was available.".to_string()
    } else {
        String::from_utf8_lossy(&capture.bytes).into_owned()
    }
}

fn final_output_exceeded(output: &Path) -> bool {
    fs::metadata(output)
        .map(|metadata| metadata.len() > MAX_RAW_OUTPUT_BYTES as u64)
        .unwrap_or(false)
}

fn final_output_too_large() -> String {
    "The quiz provider's final structured output exceeded the 256 KiB limit.".to_string()
}

async fn terminate_process_tree(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    if let Some(process_id) = child.id() {
        use std::os::windows::process::CommandExt;
        let mut taskkill = Command::new("taskkill.exe");
        taskkill
            .args(["/PID", &process_id.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        taskkill.as_std_mut().creation_flags(0x0800_0000);
        let _ = tokio::time::timeout(Duration::from_secs(5), taskkill.status()).await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn generate_api(
    run: &FrozenQuizRun,
    profile: &QuizProviderProfile,
    model: Option<&str>,
    cancellation: &Arc<AtomicBool>,
) -> Result<String, String> {
    let endpoint = profile
        .endpoint
        .as_deref()
        .ok_or_else(|| "The model API profile has no endpoint.".to_string())?;
    let model = model.ok_or_else(|| "The model API profile has no model.".to_string())?;
    let key = api_key(&profile.id)?;
    generate_api_with_key(run, endpoint, model, key.as_str(), cancellation).await
}

async fn generate_api_with_key(
    run: &FrozenQuizRun,
    endpoint: &str,
    model: &str,
    key: &str,
    cancellation: &Arc<AtomicBool>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(GENERATION_TIMEOUT)
        .build()
        .map_err(|_| "OKF Reviewer could not initialize the model API transport.".to_string())?;
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": quiz::skill_contents()},
            {
                "role": "user",
                "content": api_user_prompt(run)?
            }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "okf_quiz_v1",
                "strict": true,
                "schema": serde_json::from_str::<Value>(quiz::provider_schema_contents())
                    .map_err(|_| "The packaged quiz schema is invalid.")?
            }
        }
    });
    let request = client
        .post(endpoint)
        .bearer_auth(key)
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&body)
        .send();
    tokio::pin!(request);
    let response = loop {
        tokio::select! {
            response = &mut request => {
                break response.map_err(|error| {
                    if error.is_timeout() {
                        "The model API timed out.".to_string()
                    } else {
                        "The model API was unavailable.".to_string()
                    }
                })?;
            }
            _ = tokio::time::sleep(POLL_INTERVAL) => {
                if cancellation.load(Ordering::Acquire) {
                    return Err("Quiz generation was cancelled.".to_string());
                }
            }
        }
    };
    let status = response.status();
    let bytes = read_bounded_response(response).await?;
    if !status.is_success() {
        let diagnostic = String::from_utf8_lossy(&bytes);
        return Err(classify_provider_error(&diagnostic));
    }
    normalize_api_output(&bytes)
}

async fn read_bounded_response(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RAW_OUTPUT_BYTES as u64)
    {
        return Err("The model API response exceeded the 256 KiB limit.".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "OKF Reviewer could not read the model API response.".to_string())?
    {
        if bytes.len() + chunk.len() > MAX_RAW_OUTPUT_BYTES {
            return Err("The model API response exceeded the 256 KiB limit.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn normalize_api_output(bytes: &[u8]) -> Result<String, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| "The model API returned malformed JSON.".to_string())?;
    if let Some(value) = value.get("output_parsed") {
        return serde_json::to_string(value)
            .map_err(|_| "The model API structured output could not be encoded.".to_string());
    }
    if let Some(value) = value
        .pointer("/choices/0/message/parsed")
        .or_else(|| value.pointer("/choices/0/message/structured_output"))
    {
        return serde_json::to_string(value)
            .map_err(|_| "The model API structured output could not be encoded.".to_string());
    }
    if let Some(content) = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        return Ok(strip_json_fence(content).to_string());
    }
    Err("The model API response did not contain structured quiz output.".to_string())
}

fn normalize_claude_output(output: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(output)
        .map_err(|_| "Claude Code returned malformed JSON metadata.".to_string())?;
    if value.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(classify_provider_error(
            value
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("Claude Code failed."),
        ));
    }
    if let Some(structured) = value.get("structured_output") {
        return serde_json::to_string(structured)
            .map_err(|_| "Claude Code structured output could not be encoded.".to_string());
    }
    if let Some(result) = value.get("result").and_then(Value::as_str) {
        return Ok(strip_json_fence(result).to_string());
    }
    Err("Claude Code did not return a quiz result.".to_string())
}

fn strip_json_fence(value: &str) -> &str {
    let trimmed = value.trim();
    trimmed
        .strip_prefix("```json")
        .and_then(|value| value.strip_suffix("```"))
        .or_else(|| {
            trimmed
                .strip_prefix("```")
                .and_then(|value| value.strip_suffix("```"))
        })
        .map(str::trim)
        .unwrap_or(trimmed)
}

fn resolve_cli(kind: CliKind, configured_path: Option<&str>) -> Result<Executable, String> {
    if let Some(path) = configured_path {
        let path = PathBuf::from(path);
        if path.is_absolute() && path.is_file() {
            return Ok(Executable {
                program: path,
                prefix: Vec::new(),
            });
        }
        return Err("The configured provider CLI executable is unavailable.".to_string());
    }
    let override_name = match kind {
        CliKind::Codex => "OKF_REVIEW_CODEX_BIN",
        CliKind::Claude => "OKF_REVIEW_CLAUDE_BIN",
    };
    if let Some(path) = std::env::var_os(override_name).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(Executable {
                program: path,
                prefix: Vec::new(),
            });
        }
    }
    let name = match kind {
        CliKind::Codex => "codex",
        CliKind::Claude => "claude",
    };
    let path_programs = find_all_on_path(name);
    #[cfg(windows)]
    {
        // The Codex desktop package can add its protected WindowsApps resource
        // directory ahead of an npm installation on PATH. npm also adds
        // `.cmd` shims that create transient consoles when a GUI application
        // launches them. Prefer a standalone native executable, then npm's
        // native payload/direct Node entry point, and use PATH shims or the
        // packaged candidate only as fallbacks.
        let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
        if let Some(executable) = resolve_windows_cli(kind, &path_programs, app_data.as_deref()) {
            return Ok(executable);
        }
    }
    #[cfg(not(windows))]
    if let Some(program) = path_programs.into_iter().next() {
        return Ok(Executable {
            program,
            prefix: Vec::new(),
        });
    }
    Err(cli_missing_message(kind))
}

#[cfg(windows)]
fn is_windows_apps_path(path: &Path) -> bool {
    path.to_string_lossy()
        .to_ascii_lowercase()
        .contains("\\windowsapps\\")
}

#[cfg(windows)]
fn is_windows_native_executable(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

#[cfg(windows)]
fn resolve_windows_cli(
    kind: CliKind,
    path_programs: &[PathBuf],
    app_data: Option<&Path>,
) -> Option<Executable> {
    if let Some(program) = path_programs
        .iter()
        .find(|program| !is_windows_apps_path(program) && is_windows_native_executable(program))
    {
        return Some(Executable {
            program: program.clone(),
            prefix: Vec::new(),
        });
    }
    if let Some(executable) = app_data.and_then(|app_data| resolve_windows_npm_cli(kind, app_data))
    {
        return Some(executable);
    }
    path_programs.first().map(|program| Executable {
        program: program.clone(),
        prefix: Vec::new(),
    })
}

#[cfg(windows)]
fn resolve_windows_npm_cli(kind: CliKind, app_data: &Path) -> Option<Executable> {
    match kind {
        CliKind::Codex => {
            let vendor_root = app_data
                .join("npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64")
                .join("vendor/x86_64-pc-windows-msvc");
            let vendor = [
                vendor_root.join("bin/codex.exe"),
                vendor_root.join("codex/codex.exe"),
            ]
            .into_iter()
            .find(|candidate| candidate.is_file());
            if let Some(vendor) = vendor {
                Some(Executable {
                    program: vendor,
                    prefix: Vec::new(),
                })
            } else {
                let node = find_on_path("node").or_else(|| {
                    let bundled = app_data.join("npm").join("node.exe");
                    bundled.is_file().then_some(bundled)
                })?;
                let script = app_data.join("npm/node_modules/@openai/codex/bin/codex.js");
                script.is_file().then_some(Executable {
                    program: node,
                    prefix: vec![script.into_os_string()],
                })
            }
        }
        CliKind::Claude => {
            let node = find_on_path("node").or_else(|| {
                let bundled = app_data.join("npm").join("node.exe");
                bundled.is_file().then_some(bundled)
            })?;
            let script = app_data.join("npm/node_modules/@anthropic-ai/claude-code/cli.js");
            script.is_file().then_some(Executable {
                program: node,
                prefix: vec![script.into_os_string()],
            })
        }
    }
}

#[cfg(any(windows, test))]
fn find_on_path(name: &str) -> Option<PathBuf> {
    find_all_on_path(name).into_iter().next()
}

fn find_all_on_path(name: &str) -> Vec<PathBuf> {
    let Some(path) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    find_all_in_directories(name, std::env::split_paths(&path))
}

#[cfg(all(windows, test))]
fn find_in_directories(
    name: &str,
    directories: impl IntoIterator<Item = PathBuf>,
) -> Option<PathBuf> {
    find_all_in_directories(name, directories)
        .into_iter()
        .next()
}

fn find_all_in_directories(
    name: &str,
    directories: impl IntoIterator<Item = PathBuf>,
) -> Vec<PathBuf> {
    let candidate_names = if cfg!(windows) && Path::new(name).extension().is_none() {
        // A Windows PATH directory can contain both a native `codex.exe` and
        // extensionless binaries for other platforms. Prefer Windows-native
        // launchers before considering the extensionless fallback.
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    directories
        .into_iter()
        .flat_map(|directory| {
            candidate_names
                .iter()
                .map(move |candidate_name| directory.join(candidate_name))
        })
        .filter(|candidate| candidate.is_file())
        .collect()
}

async fn run_help(executable: &Executable, kind: CliKind) -> Result<String, String> {
    let mut command = cli_command(executable, kind);
    if matches!(kind, CliKind::Codex) {
        command.arg("exec");
    }
    command
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_background_process(&mut command);
    let output = tokio::time::timeout(PREFLIGHT_TIMEOUT, command.output())
        .await
        .map_err(|_| "The provider CLI help check timed out.".to_string())?
        .map_err(|error| cli_start_error(&executable.program, &error))?;
    let mut combined = output.stdout;
    combined.extend_from_slice(&output.stderr);
    if combined.len() > MAX_DIAGNOSTIC_BYTES {
        combined.truncate(MAX_DIAGNOSTIC_BYTES);
    }
    Ok(String::from_utf8_lossy(&combined).into_owned())
}

async fn run_cli_capture(
    executable: &Executable,
    kind: CliKind,
    args: &[&str],
) -> Result<(bool, String), String> {
    run_cli_capture_with_timeout(
        executable,
        kind,
        args,
        PREFLIGHT_TIMEOUT,
        "The provider CLI setup check timed out.",
    )
    .await
}

async fn run_cli_capture_with_timeout(
    executable: &Executable,
    kind: CliKind,
    args: &[&str],
    timeout: Duration,
    timeout_message: &str,
) -> Result<(bool, String), String> {
    let mut command = cli_command(executable, kind);
    command.args(args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_background_process(&mut command);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| timeout_message.to_string())?
        .map_err(|error| cli_start_error(&executable.program, &error))?;
    let mut combined = output.stdout;
    combined.extend_from_slice(&output.stderr);
    if combined.len() > MAX_DIAGNOSTIC_BYTES {
        combined.truncate(MAX_DIAGNOSTIC_BYTES);
    }
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&combined).trim().to_string(),
    ))
}

fn login_args(kind: CliKind, mode: ProviderLoginMode) -> Result<Vec<&'static str>, String> {
    validate_login_mode(kind, mode)?;
    Ok(match (kind, mode) {
        (CliKind::Claude, ProviderLoginMode::Browser | ProviderLoginMode::Terminal) => {
            vec!["auth", "login"]
        }
        (CliKind::Codex, _) | (CliKind::Claude, ProviderLoginMode::DeviceCode) => {
            unreachable!("login mode was validated")
        }
    })
}

async fn run_cli_login(
    executable: &Executable,
    kind: CliKind,
    mode: ProviderLoginMode,
    cancellation: &Arc<AtomicBool>,
) -> Result<CliLoginOutcome, String> {
    let mut command = cli_command(executable, kind);
    command.args(login_args(kind, mode)?);
    if mode != ProviderLoginMode::Browser {
        command
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
            command.creation_flags(CREATE_NEW_CONSOLE);
        }
    } else {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        configure_background_process(&mut command);
    }
    command.kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| cli_start_error(&executable.program, &error))?;
    let diagnostic_reader = child.stderr.take().map(spawn_bounded_diagnostic_reader);
    let started = Instant::now();
    loop {
        if cancellation.load(Ordering::Acquire) {
            terminate_process_tree(&mut child).await;
            let _ = finish_diagnostic_reader(diagnostic_reader).await;
            return Ok(CliLoginOutcome {
                succeeded: false,
                cancelled: true,
                diagnostic: String::new(),
            });
        }
        if started.elapsed() >= PROVIDER_LOGIN_TIMEOUT {
            terminate_process_tree(&mut child).await;
            let diagnostic = finish_diagnostic_reader(diagnostic_reader).await;
            let detail = if diagnostic.is_empty() {
                String::new()
            } else {
                format!(" The CLI reported: {diagnostic}")
            };
            return Err(match kind {
                CliKind::Codex => format!("Codex sign-in did not finish within five minutes. Try again or use device-code sign-in.{detail}"),
                CliKind::Claude => format!("Claude Code sign-in did not finish within five minutes. Try again in the command window.{detail}"),
            });
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|_| format!("OKF Reviewer could not monitor {} sign-in.", cli_name(kind)))?
        {
            return Ok(CliLoginOutcome {
                succeeded: status.success(),
                cancelled: false,
                diagnostic: finish_diagnostic_reader(diagnostic_reader).await,
            });
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn spawn_bounded_diagnostic_reader<R>(mut reader: R) -> JoinHandle<Vec<u8>>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut retained = Vec::new();
        let mut buffer = [0_u8; 4 * 1024];
        loop {
            let read = match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let remaining = MAX_DIAGNOSTIC_BYTES.saturating_sub(retained.len());
            retained.extend_from_slice(&buffer[..read.min(remaining)]);
        }
        retained
    })
}

async fn finish_diagnostic_reader(reader: Option<JoinHandle<Vec<u8>>>) -> String {
    let bytes = match reader {
        Some(reader) => reader.await.unwrap_or_default(),
        None => Vec::new(),
    };
    bounded_diagnostic(&String::from_utf8_lossy(&bytes))
}

fn configure_background_process(_command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        _command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn cli_start_error(program: &Path, error: &std::io::Error) -> String {
    let path = program.to_string_lossy();
    let diagnostic = bounded_diagnostic(&error.to_string());
    if cfg!(windows)
        && path.to_ascii_lowercase().contains("\\windowsapps\\")
        && error.kind() == std::io::ErrorKind::PermissionDenied
    {
        return format!(
            "Windows denied permission to start the Codex desktop package binary at '{path}'. Install the standalone Codex CLI or select its runnable executable in Quiz generators."
        );
    }
    format!("The provider CLI at '{path}' could not be started: {diagnostic}")
}

fn help_contract(kind: CliKind, help: &str) -> bool {
    match kind {
        CliKind::Codex => [
            "exec",
            "--ephemeral",
            "--output-schema",
            "--output-last-message",
        ]
        .iter()
        .all(|flag| help.contains(flag)),
        // Claude's documented CLI reference is authoritative because `claude
        // --help` intentionally does not enumerate every supported flag.
        CliKind::Claude => true,
    }
}

fn filtered_environment(command: &mut Command, kind: CliKind) {
    let allowed = [
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "CODEX_HOME",
        "CODEX_CA_CERTIFICATE",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_GIT_BASH_PATH",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
    ];
    let values = allowed
        .iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (*name, value)))
        .collect::<Vec<_>>();
    command.env_clear();
    command.envs(values);
    command.env("DISABLE_AUTOUPDATER", "1");
    if matches!(kind, CliKind::Claude) {
        command.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    }
}

fn now_timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string())
}

fn invocation_instructions() -> &'static str {
    "Use only the application-owned instructions, frozen evidence packet, and schema supplied below. Do not use tools, external knowledge, repository discovery, web research, or files. Return exactly one JSON object matching the schema, with no Markdown fence or commentary."
}

fn provider_prompt(run: &FrozenQuizRun) -> Result<String, String> {
    let packet = serde_json::to_string_pretty(&run.packet)
        .map_err(|_| "OKF Reviewer could not encode the frozen quiz packet.".to_string())?;
    let bundle_context = serde_json::to_string_pretty(&run.bundle_context)
        .map_err(|_| "OKF Reviewer could not encode the frozen bundle context.".to_string())?;
    Ok(format!(
        "You are generating an application-owned OKF knowledge quiz. Work read-only: do not modify files, settings, the index, branches, or repository state. You may inspect Git history, diffs, status, and repository files to judge the selected scope's size and impact. Do not use the web. Do not reproduce Git diff text in your output. Every answer, explanation, and evidence quote must remain supported by the declared frozen OKF evidence. Return exactly one JSON object matching the schema, with no Markdown fence or commentary.\n\nAPPLICATION-OWNED QUIZ SKILL:\n{skill}\n\nFROZEN EVIDENCE PACKET AND REPOSITORY CONTEXT:\n{packet}\n\nFROZEN BUNDLE CONTEXT:\n{bundle_context}\n\nCANONICAL OUTPUT SCHEMA:\n{schema}",
        skill = quiz::skill_contents(),
        schema = quiz::schema_contents(),
    ))
}

fn api_user_prompt(run: &FrozenQuizRun) -> Result<String, String> {
    let packet = serde_json::to_string_pretty(&run.packet)
        .map_err(|_| "OKF Reviewer could not encode the frozen quiz packet.".to_string())?;
    Ok(format!(
        "{}\n\nFrozen packet:\n{}",
        invocation_instructions(),
        packet,
    ))
}

fn cli_working_directory(run: &FrozenQuizRun) -> Result<&Path, String> {
    let directory = if run.packet.generation.mode
        == crate::quiz_runtime::QuizGenerationMode::Automatic
    {
        run.repository_root.as_deref().ok_or_else(|| {
            "Automatic quiz generation requires an accessible trusted Git repository.".to_string()
        })?
    } else {
        run.repository_root.as_deref().unwrap_or(&run.bundle_root)
    };
    if !directory.is_dir() {
        return Err("The quiz harness cannot access its repository working directory.".to_string());
    }
    Ok(directory)
}

fn observed_state(run: &FrozenQuizRun) -> QuizObservedState {
    QuizObservedState {
        bundle_fingerprint: run.packet.request.bundle_fingerprint.clone(),
        scope_fingerprint: run.packet.request.scope_fingerprint.clone(),
        sources: run
            .packet
            .request
            .evidence_sources
            .iter()
            .map(|source| QuizObservedSource {
                source_id: source.source_id.clone(),
                content_hash: source.content_hash.clone(),
            })
            .collect(),
    }
}

fn validate_model(model: Option<&str>) -> Result<(), String> {
    if let Some(model) = model {
        if model.is_empty()
            || model.len() > 200
            || model.chars().any(|character| {
                character.is_control()
                    || !(character.is_ascii_alphanumeric()
                        || matches!(character, '-' | '_' | '.' | ':' | '/'))
            })
        {
            return Err("The selected model identifier is invalid.".to_string());
        }
    }
    Ok(())
}

fn read_bounded_file(path: &Path, maximum: usize) -> Result<String, String> {
    let file =
        File::open(path).map_err(|_| "The provider did not return quiz output.".to_string())?;
    if file
        .metadata()
        .map_err(|_| "OKF Reviewer could not inspect provider output.".to_string())?
        .len()
        > maximum as u64
    {
        return Err("The provider output exceeded its size limit.".to_string());
    }
    let mut bytes = Vec::new();
    file.take((maximum + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "OKF Reviewer could not read provider output.".to_string())?;
    if bytes.len() > maximum {
        return Err("The provider output exceeded its size limit.".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "The provider output was not valid UTF-8.".to_string())
}

fn classify_provider_error(diagnostic: &str) -> String {
    let lower = diagnostic.to_ascii_lowercase();
    let codex_model_catalog_incompatible = lower.contains("unknown variant")
        && lower.contains("expected one of")
        && lower.contains("xhigh")
        && (lower.contains("codex_models_manager")
            || lower.contains("failed to load models cache")
            || lower.contains("failed to decode models response")
            || lower.contains("failed to refresh available models"));

    if codex_model_catalog_incompatible {
        CODEX_MODEL_CATALOG_INCOMPATIBLE_MESSAGE.to_string()
    } else if lower.contains("auth")
        || lower.contains("login")
        || lower.contains("api key")
        || lower.contains("unauthorized")
        || lower.contains("401")
    {
        AUTHENTICATION_REQUIRED_MESSAGE.to_string()
    } else if lower.contains("model")
        && (lower.contains("unsupported") || lower.contains("not found"))
    {
        "The selected model is not supported by this provider.".to_string()
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "The quiz provider timed out.".to_string()
    } else if lower.contains("schema")
        && (lower.contains("unsupported")
            || lower.contains("invalid")
            || lower.contains("response_format"))
    {
        "The provider rejected the structured quiz schema.".to_string()
    } else {
        format!(
            "The quiz provider failed: {}",
            bounded_diagnostic(diagnostic)
        )
    }
}

fn classify_generation_failure(message: String) -> GenerationFailure {
    if message == AUTHENTICATION_REQUIRED_MESSAGE {
        GenerationFailure::AuthenticationRequired(message)
    } else {
        GenerationFailure::Other(message)
    }
}

fn bounded_diagnostic(diagnostic: &str) -> String {
    diagnostic
        .chars()
        .filter(|character| !character.is_control() || *character == ' ')
        .take(1_000)
        .collect::<String>()
        .trim()
        .to_string()
}

fn cli_missing_message(kind: CliKind) -> String {
    match kind {
        CliKind::Codex => "Codex CLI is not installed or could not be resolved.",
        CliKind::Claude => "Claude Code CLI is not installed or could not be resolved.",
    }
    .to_string()
}

fn cancelled_outcome(request_id: String) -> QuizGenerationOutcome {
    QuizGenerationOutcome {
        request_id,
        state: QuizGenerationState::Cancelled,
        quiz_id: None,
        failure_id: None,
        warnings: Vec::new(),
        issues: Vec::new(),
        message: "Quiz generation was cancelled.".to_string(),
    }
}

fn emit_progress(app: &AppHandle, request_id: &str, state: QuizGenerationState, message: &str) {
    let _ = app.emit(
        "quiz-generation-progress",
        QuizGenerationProgress {
            request_id: request_id.to_string(),
            state,
            message: message.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quiz::{
        QuizDifficulty, QuizEvidenceSource, QuizEvidenceVersion, QuizGenerationRequest,
        QuizScopeMode,
    };
    use crate::quiz_runtime::{
        FrozenBundleFile, FrozenQuizPacket, PrepareQuizScopeInput, QuizGenerationConfig, QuizLength,
    };
    use std::net::TcpListener;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn frozen_run(root: &Path) -> FrozenQuizRun {
        let markdown = "# Boundary\n\nOnly frozen evidence is accepted.\n".to_string();
        let request = QuizGenerationRequest {
            request_id: "quiz-request-fixture".to_string(),
            bundle_fingerprint: "bundle-fixture".to_string(),
            scope_fingerprint: "scope-fixture".to_string(),
            scope_mode: QuizScopeMode::CurrentDocument,
            question_count_policy: crate::quiz::QuizQuestionCountPolicy::Exact,
            requested_question_count: 1,
            requested_difficulty: Some(QuizDifficulty::Applied),
            evidence_sources: vec![QuizEvidenceSource {
                source_id: "source-1".to_string(),
                concept_id: "features/boundary".to_string(),
                path: "features/boundary.md".to_string(),
                title: "Boundary".to_string(),
                concept_type: "Feature".to_string(),
                version: QuizEvidenceVersion::Current,
                content_hash: quiz::evidence_content_hash(&markdown),
                markdown,
            }],
            scope_source_ids: vec!["source-1".to_string()],
            topic: None,
            base_revision_id: None,
            head_revision_id: None,
        };
        FrozenQuizRun {
            bundle_root: root.to_path_buf(),
            repository_root: Some(root.to_path_buf()),
            retry_input: PrepareQuizScopeInput {
                bundle_root: root.to_string_lossy().to_string(),
                scope_mode: QuizScopeMode::CurrentDocument,
                concept_ids: vec!["features/boundary".to_string()],
                topic: None,
                base_revision_id: None,
                head_revision_id: None,
                generation: QuizGenerationConfig {
                    mode: crate::quiz_runtime::QuizGenerationMode::Manual,
                    length: Some(QuizLength::Medium),
                    difficulty: Some(QuizDifficulty::Applied),
                    max_questions: 20,
                },
            },
            retry_failure_id: None,
            packet: FrozenQuizPacket {
                request,
                generation: QuizGenerationConfig {
                    mode: crate::quiz_runtime::QuizGenerationMode::Manual,
                    length: Some(QuizLength::Medium),
                    difficulty: Some(QuizDifficulty::Applied),
                    max_questions: 20,
                },
                scope_description: "Current document: Boundary".to_string(),
                bundle_name: "Fixture".to_string(),
                bundle_revision: "Working tree".to_string(),
                omitted_documents: Vec::new(),
                repository_context: Some(crate::quiz_runtime::QuizRepositoryContext {
                    working_directory: root.to_string_lossy().into_owned(),
                    comparison_mode: crate::git::GitComparisonMode::FeatureBranch,
                    current_branch: Some("feature/fixture".to_string()),
                    default_branch: Some("main".to_string()),
                    base_revision: Some("base-revision-fixture".to_string()),
                    head_revision: Some("head-revision-fixture".to_string()),
                }),
            },
            bundle_context: vec![FrozenBundleFile {
                path: "features/boundary.md".to_string(),
                contents: "# Boundary\n\nOnly frozen evidence is accepted.\n".to_string(),
            }],
        }
    }

    fn fake_provider_output(run: &FrozenQuizRun) -> String {
        json!({
            "schemaVersion": 1,
            "requestId": run.packet.request.request_id,
            "bundleFingerprint": run.packet.request.bundle_fingerprint,
            "scopeFingerprint": run.packet.request.scope_fingerprint,
            "status": "ready",
            "title": "Fixture quiz",
            "questions": [{
                "id": "Q1",
                "category": "architecture",
                "criticality": "critical",
                "learningObjective": "Apply the frozen evidence boundary.",
                "prompt": "Which evidence boundary is required?",
                "choices": [
                    {"id": "A", "text": "Only frozen evidence is accepted."},
                    {"id": "B", "text": "The provider searches the repository."},
                    {"id": "C", "text": "The provider adds general knowledge."}
                ],
                "correctChoiceId": "A",
                "explanation": "The bundle explicitly limits generation to frozen evidence.",
                "evidence": [{
                    "sourceId": "source-1",
                    "heading": "Boundary",
                    "quote": "Only frozen evidence is accepted."
                }]
            }],
            "warnings": []
        })
        .to_string()
    }

    #[test]
    fn cli_prompt_contains_the_exact_frozen_contract_without_diff_text() {
        let run = frozen_run(Path::new("C:/fixture"));
        let prompt = provider_prompt(&run).expect("prompt");
        for expected in [
            "APPLICATION-OWNED QUIZ SKILL",
            "FROZEN EVIDENCE PACKET",
            "FROZEN BUNDLE CONTEXT",
            "Only frozen evidence is accepted.",
            "inspect Git",
            "feature/fixture",
            "base-revision-fixture",
        ] {
            assert!(prompt.contains(expected));
        }
        assert!(!prompt.contains("diff --git a/"));
    }

    fn fake_cli(cache: &Path) -> Executable {
        fs::create_dir_all(cache).expect("fake CLI directory");
        let node = find_on_path(if cfg!(windows) { "node.exe" } else { "node" })
            .expect("Node.js is required by the repository test gate");
        let script = cache.join("fake-provider.cjs");
        fs::write(
            &script,
            r#"
const fs = require("fs");
const args = process.argv.slice(2);
const transcriptArg = args.find(arg => arg.startsWith("--fixture-transcript-bytes="));
const outputArg = args.find(arg => arg.startsWith("--fixture-output-bytes="));
const codexTranscriptBytes = Number(transcriptArg?.split("=")[1] ?? 0);
const codexOutputBytes = Number(outputArg?.split("=")[1] ?? 0);
if (args.includes("--help")) {
  process.stdout.write("exec --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --sandbox --output-schema --output-last-message --print --output-format --max-turns --model --tools --bare --no-session-persistence --disable-slash-commands --setting-sources --strict-mcp-config --mcp-config --json-schema");
  process.exit(0);
}
if (args.includes("--bare") && !args.includes("--no-session-persistence")) {
  process.stderr.write("Claude fixture requires session persistence to be disabled");
  process.exit(2);
}
if (args.includes("exec") && !args.includes('model_reasoning_effort="high"')) {
  process.stderr.write("Codex fixture requires explicit high reasoning effort");
  process.exit(2);
}
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  const setupTest = args.some(arg => String(arg).includes("setup-test.schema.json"))
    || prompt.includes("This setup test contains no bundle content.");
  if (setupTest) {
    if (fs.existsSync("quiz-request.json") || prompt.includes("FROZEN EVIDENCE PACKET")) {
      process.stderr.write("setup test received bundle evidence");
      process.exit(3);
    }
    const setupResult = {
      schemaVersion: 1,
      requestId: "setup-test",
      bundleFingerprint: "setup-test",
      scopeFingerprint: "setup-test",
      status: "insufficient-evidence",
      title: "Provider setup test",
      questions: [],
      warnings: ["No bundle evidence was supplied to this setup test."]
    };
    const setupOutputIndex = args.indexOf("--output-last-message");
    if (setupOutputIndex >= 0) {
      fs.writeFileSync(args[setupOutputIndex + 1], JSON.stringify(setupResult));
    } else {
      process.stdout.write(JSON.stringify({type: "result", subtype: "success", is_error: false, structured_output: setupResult}));
    }
    return;
  }
  const path = require("path");
  if (path.resolve(process.cwd()) !== path.resolve(__dirname)) {
    process.stderr.write("Quiz fixture did not run from the repository root");
    process.exit(6);
  }
  if (args.includes("exec")) {
    if (!prompt.includes("APPLICATION-OWNED QUIZ SKILL") || !prompt.includes("Work read-only")) {
      process.stderr.write("Codex fixture did not receive the application-owned prompt");
      process.exit(4);
    }
    if (prompt.includes("diff --git a/")) {
      process.stderr.write("Codex fixture received forbidden diff text");
      process.exit(5);
    }
    if (codexTranscriptBytes > 0) {
      fs.writeSync(1, Buffer.alloc(codexTranscriptBytes, "o"));
      fs.writeSync(2, Buffer.alloc(codexTranscriptBytes, "e"));
    }
  }
  const artifact = {
    schemaVersion: 1,
    requestId: "quiz-request-fixture",
    bundleFingerprint: "bundle-fixture",
    scopeFingerprint: "scope-fixture",
    status: "ready",
    title: "Fixture CLI quiz",
    questions: [{
      id: "Q1",
      category: "architecture",
      criticality: "critical",
      learningObjective: "Apply the frozen boundary.",
      prompt: "Which evidence boundary is required?",
      choices: [
        {id: "A", text: "Only frozen evidence is accepted."},
        {id: "B", text: "Search the repository."},
        {id: "C", text: "Use general knowledge."}
      ],
      correctChoiceId: "A",
      explanation: "The bundle requires frozen evidence.",
      evidence: [{sourceId: "source-1", heading: "Boundary", quote: "Only frozen evidence is accepted."}]
    }],
    warnings: []
  };
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex >= 0) {
    const output = codexOutputBytes > 0
      ? Buffer.alloc(codexOutputBytes, "x")
      : JSON.stringify(artifact);
    fs.writeFileSync(args[outputIndex + 1], output);
  } else {
    process.stdout.write(JSON.stringify({type: "result", subtype: "success", is_error: false, structured_output: artifact}));
  }
});
"#,
        )
        .expect("fake CLI script");
        Executable {
            program: node,
            prefix: vec![script.into_os_string()],
        }
    }

    fn fake_cli_with_behavior(
        cache: &Path,
        codex_transcript_bytes: usize,
        oversized_codex_output: bool,
    ) -> Executable {
        let mut executable = fake_cli(cache);
        executable
            .prefix
            .push(format!("--fixture-transcript-bytes={codex_transcript_bytes}").into());
        if oversized_codex_output {
            executable
                .prefix
                .push(format!("--fixture-output-bytes={}", MAX_RAW_OUTPUT_BYTES + 1).into());
        }
        executable
    }

    fn fake_claude_login_cli(cache: &Path) -> Executable {
        fs::create_dir_all(cache).expect("fake Claude login CLI directory");
        let node = find_on_path(if cfg!(windows) { "node.exe" } else { "node" })
            .expect("Node.js is required by the repository test gate");
        let script = cache.join("fake-claude-login.cjs");
        fs::write(
            &script,
            r#"
const fs = require("fs");
const args = process.argv.slice(2);
const marker = __filename + ".authenticated";
if (args[0] === "auth" && args[1] === "status" && args.length === 2) {
  process.exit(fs.existsSync(marker) ? 0 : 1);
}
if (args[0] === "auth" && args[1] === "login" && args.length === 2) {
  fs.writeFileSync(marker, "authenticated");
  process.exit(0);
}
process.exit(2);
"#,
        )
        .expect("fake Claude login CLI script");
        Executable {
            program: node,
            prefix: vec![script.into_os_string()],
        }
    }

    #[test]
    fn provider_help_contracts_are_explicit() {
        let codex = "exec --ephemeral --output-schema --output-last-message";
        assert!(help_contract(CliKind::Codex, codex));
        assert!(!help_contract(CliKind::Codex, "exec --output-schema"));
        let claude = "--print --output-format --max-turns --model --tools --bare --disable-slash-commands --setting-sources --strict-mcp-config --mcp-config --json-schema";
        assert!(help_contract(CliKind::Claude, claude));
        assert!(help_contract(CliKind::Claude, "--print --output-format"));
    }

    #[test]
    fn provider_login_commands_are_explicit_and_provider_specific() {
        assert!(login_args(CliKind::Codex, ProviderLoginMode::DeviceCode).is_err());
        assert_eq!(
            login_args(CliKind::Claude, ProviderLoginMode::Terminal).expect("Claude login"),
            ["auth", "login"]
        );
        assert!(login_args(CliKind::Claude, ProviderLoginMode::DeviceCode).is_err());
    }

    #[test]
    fn codex_authentication_guidance_uses_the_generation_context() {
        let executable = Executable {
            program: PathBuf::from("C:/Program Files/OpenAI's Codex/codex.exe"),
            prefix: Vec::new(),
        };
        let guidance =
            provider_authentication_guidance(CliKind::Codex, &executable).expect("Codex guidance");

        assert_eq!(
            guidance.resolved_display_path,
            "C:/Program Files/OpenAI's Codex/codex.exe"
        );
        for command in [
            &guidance.login_command,
            guidance
                .device_code_login_command
                .as_ref()
                .expect("device-code command"),
            &guidance.status_command,
        ] {
            assert!(command.contains(CODEX_AUTH_CREDENTIALS_OVERRIDE));
            assert!(command.contains("OpenAI"));
        }
        assert!(guidance.login_command.ends_with("'login'"));
        assert!(guidance
            .device_code_login_command
            .expect("device-code command")
            .ends_with("'login' '--device-auth'"));
        assert!(guidance.status_command.ends_with("'login' 'status'"));
        if cfg!(windows) {
            assert!(guidance.login_command.starts_with("& "));
            assert!(guidance.login_command.contains("OpenAI''s Codex"));
        }
    }

    #[tokio::test]
    async fn claude_authentication_accepts_an_explicit_login_and_reuses_it() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let cache = std::env::temp_dir().join(format!(
            "okf-review-provider-claude-login-{}-{nonce}",
            std::process::id()
        ));
        let executable = fake_claude_login_cli(&cache);
        let cancellation = Arc::new(AtomicBool::new(false));

        assert_eq!(
            run_cli_login(
                &executable,
                CliKind::Claude,
                ProviderLoginMode::Browser,
                &cancellation,
            )
            .await
            .expect("explicit Claude login"),
            CliLoginOutcome {
                succeeded: true,
                cancelled: false,
                diagnostic: String::new(),
            }
        );
        ensure_cli_authenticated(&executable, CliKind::Claude)
            .await
            .expect("cached Claude login");
        let _ = fs::remove_dir_all(cache);
    }

    #[test]
    fn provider_outputs_normalize_to_one_raw_contract() {
        let quiz = r#"{"schemaVersion":1}"#;
        let claude = json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "structured_output": {"schemaVersion": 1}
        });
        assert_eq!(
            normalize_claude_output(&claude.to_string()).expect("claude"),
            quiz
        );
        let api = json!({
            "choices": [{"message": {"content": "```json\n{\"schemaVersion\":1}\n```"}}]
        });
        assert_eq!(
            normalize_api_output(api.to_string().as_bytes()).expect("api"),
            quiz
        );
    }

    #[test]
    fn diagnostics_are_bounded_and_credentials_are_not_part_of_results() {
        let diagnostic = format!("{}\nsecret", "x".repeat(2_000));
        let bounded = bounded_diagnostic(&diagnostic);
        assert_eq!(bounded.len(), 1_000);
        assert!(!bounded.contains('\n'));

        let schema_error = r#"invalid_request_error: invalid_json_schema for response_format 'codex_output_schema': schema must have a 'type' key"#;
        assert_eq!(
            classify_provider_error(schema_error),
            "The provider rejected the structured quiz schema."
        );
        let incompatible_catalog = r#"ERROR codex_models_manager::cache: failed to load models cache: unknown variant `max`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`"#;
        assert_eq!(
            classify_provider_error(incompatible_catalog),
            CODEX_MODEL_CATALOG_INCOMPATIBLE_MESSAGE
        );
        assert!(matches!(
            classify_generation_failure(AUTHENTICATION_REQUIRED_MESSAGE.to_string()),
            GenerationFailure::AuthenticationRequired(_)
        ));
        assert_eq!(
            failure_kind_for_state(QuizGenerationState::AuthenticationRequired),
            None
        );
        assert_eq!(
            failure_kind_for_state(QuizGenerationState::ProviderError),
            Some(QuizGenerationFailureKind::ProviderError)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_resolution_prefers_native_launchers() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "okf-review-cli-resolution-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("resolution fixture directory");
        fs::write(directory.join("codex"), b"non-Windows fixture").expect("extensionless fixture");
        fs::write(directory.join("codex.exe"), b"Windows fixture").expect("native fixture");

        let resolved =
            find_in_directories("codex", [directory.clone()]).expect("native Codex candidate");
        assert_eq!(resolved, directory.join("codex.exe"));

        fs::remove_dir_all(directory).expect("resolution fixture cleanup");
    }

    #[cfg(windows)]
    #[test]
    fn windows_resolution_avoids_an_npm_cmd_shim_when_native_codex_exists() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "okf-review-native-codex-resolution-{}-{nonce}",
            std::process::id()
        ));
        let app_data = root.join("app-data");
        let native = app_data
            .join("npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64")
            .join("vendor/x86_64-pc-windows-msvc/codex/codex.exe");
        fs::create_dir_all(native.parent().expect("native parent"))
            .expect("native fixture directory");
        fs::write(&native, b"native Codex fixture").expect("native Codex fixture");
        let shim = root.join("codex.cmd");
        fs::write(&shim, b"@echo off").expect("Codex shim fixture");

        let resolved = resolve_windows_cli(CliKind::Codex, &[shim], Some(&app_data))
            .expect("resolved native Codex payload");
        assert_eq!(resolved.program, native);
        assert!(resolved.prefix.is_empty());

        fs::remove_dir_all(root).expect("resolution fixture cleanup");
    }

    #[cfg(windows)]
    #[test]
    fn windows_resolution_scans_past_shims_for_a_standalone_native_cli() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "okf-review-multiple-codex-resolution-{}-{nonce}",
            std::process::id()
        ));
        let shim = root.join("first/codex.cmd");
        let native = root.join("second/codex.exe");
        fs::create_dir_all(shim.parent().expect("shim parent")).expect("shim directory");
        fs::create_dir_all(native.parent().expect("native parent")).expect("native directory");
        fs::write(&shim, b"@echo off").expect("Codex shim fixture");
        fs::write(&native, b"native Codex fixture").expect("native Codex fixture");

        let candidates = find_all_in_directories(
            "codex",
            [
                shim.parent().expect("shim parent").to_path_buf(),
                native.parent().expect("native parent").to_path_buf(),
            ],
        );
        let resolved = resolve_windows_cli(CliKind::Codex, &candidates, None)
            .expect("standalone native Codex CLI");

        assert_eq!(resolved.program, native);
        fs::remove_dir_all(root).expect("resolution fixture cleanup");
    }

    #[test]
    fn fake_provider_uses_the_common_validator_contract() {
        let run = frozen_run(Path::new("C:/fixture"));
        let validation = quiz::validate_output(&QuizValidationInput {
            request: run.packet.request.clone(),
            current_state: observed_state(&run),
            raw_output: Some(fake_provider_output(&run)),
        });
        assert!(matches!(validation, QuizValidation::Ready { .. }));
    }

    #[test]
    fn temporary_workspace_contains_only_the_output_schema_and_is_cleaned() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let cache = std::env::temp_dir().join(format!(
            "okf-review-provider-workspace-{}-{nonce}",
            std::process::id()
        ));
        let run = frozen_run(&cache);
        let path = {
            let workspace = TemporaryWorkspace::create(&cache, &run).expect("workspace");
            let mut names = fs::read_dir(&workspace.path)
                .expect("workspace files")
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            names.sort();
            assert_eq!(names, vec!["provider-output.schema.json"]);
            workspace.path.clone()
        };
        assert!(!path.exists());
        let _ = fs::remove_dir_all(cache);
    }

    #[tokio::test]
    async fn codex_and_claude_fixtures_share_output_validation_and_cleanup() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let cache = std::env::temp_dir().join(format!(
            "okf-review-provider-adapters-{}-{nonce}",
            std::process::id()
        ));
        let run = frozen_run(&cache);
        let executable = fake_cli(&cache);
        for kind in [CliKind::Codex, CliKind::Claude] {
            let cancellation = Arc::new(AtomicBool::new(false));
            let reasoning_effort =
                matches!(kind, CliKind::Codex).then_some(CodexReasoningEffort::High);
            let raw = generate_cli_with_executable(
                &run,
                &cache,
                None,
                reasoning_effort,
                &cancellation,
                kind,
                &executable,
            )
            .await
            .expect("fixture generation");
            let validation = quiz::validate_output(&QuizValidationInput {
                request: run.packet.request.clone(),
                current_state: observed_state(&run),
                raw_output: Some(raw),
            });
            assert!(matches!(validation, QuizValidation::Ready { .. }));
            assert!(
                fs::read_dir(&cache)
                    .expect("cache")
                    .flatten()
                    .all(|entry| !entry.file_name().to_string_lossy().starts_with("run-")),
                "temporary provider workspace should be removed"
            );
        }
        let cancelled = Arc::new(AtomicBool::new(true));
        let error = generate_cli_with_executable(
            &run,
            &cache,
            None,
            Some(CodexReasoningEffort::High),
            &cancelled,
            CliKind::Codex,
            &executable,
        )
        .await
        .expect_err("cancelled fixture");
        assert!(error.contains("cancelled"));
        assert!(fs::read_dir(&cache)
            .expect("cache")
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().starts_with("run-")));
        let _ = fs::remove_dir_all(cache);
    }

    #[tokio::test]
    async fn codex_transcript_does_not_count_as_structured_quiz_output() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let cache = std::env::temp_dir().join(format!(
            "okf-review-provider-large-transcript-{}-{nonce}",
            std::process::id()
        ));
        let run = frozen_run(&cache);
        let executable = fake_cli_with_behavior(&cache, MAX_RAW_OUTPUT_BYTES + 4 * 1024, false);

        let raw = generate_cli_with_executable(
            &run,
            &cache,
            None,
            Some(CodexReasoningEffort::High),
            &Arc::new(AtomicBool::new(false)),
            CliKind::Codex,
            &executable,
        )
        .await
        .expect("a verbose Codex transcript must not reject a bounded final result");

        let validation = quiz::validate_output(&QuizValidationInput {
            request: run.packet.request.clone(),
            current_state: observed_state(&run),
            raw_output: Some(raw),
        });
        assert!(matches!(validation, QuizValidation::Ready { .. }));
        assert!(fs::read_dir(&cache)
            .expect("cache")
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().starts_with("run-")));
        let _ = fs::remove_dir_all(cache);
    }

    #[tokio::test]
    async fn codex_final_structured_output_remains_bounded() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let cache = std::env::temp_dir().join(format!(
            "okf-review-provider-large-result-{}-{nonce}",
            std::process::id()
        ));
        let run = frozen_run(&cache);
        let executable = fake_cli_with_behavior(&cache, 0, true);

        let error = generate_cli_with_executable(
            &run,
            &cache,
            None,
            Some(CodexReasoningEffort::High),
            &Arc::new(AtomicBool::new(false)),
            CliKind::Codex,
            &executable,
        )
        .await
        .expect_err("an oversized final quiz must remain rejected");

        assert_eq!(
            error,
            "The quiz provider's final structured output exceeded the 256 KiB limit."
        );
        assert!(fs::read_dir(&cache)
            .expect("cache")
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().starts_with("run-")));
        let _ = fs::remove_dir_all(cache);
    }

    #[tokio::test]
    #[ignore = "requires a signed-in live Codex CLI"]
    async fn live_codex_skill_workspace_probe() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let cache = std::env::temp_dir().join(format!(
            "okf-review-live-codex-skill-probe-{}-{nonce}",
            std::process::id()
        ));
        let run = frozen_run(&cache);
        let executable = resolve_cli(CliKind::Codex, None).expect("Codex CLI");
        ensure_cli_authenticated(&executable, CliKind::Codex)
            .await
            .expect("Codex authentication");
        let raw = generate_cli_with_executable(
            &run,
            &cache,
            Some("gpt-5.6-sol"),
            Some(CodexReasoningEffort::High),
            &Arc::new(AtomicBool::new(false)),
            CliKind::Codex,
            &executable,
        )
        .await
        .expect("live Codex quiz generation");
        let validation = quiz::validate_output(&QuizValidationInput {
            request: run.packet.request.clone(),
            current_state: observed_state(&run),
            raw_output: Some(raw),
        });
        assert!(matches!(
            validation,
            QuizValidation::Ready { .. } | QuizValidation::InsufficientEvidence { .. }
        ));
        let _ = fs::remove_dir_all(cache);
    }

    #[tokio::test]
    async fn live_cli_setup_tests_use_structured_output_without_bundle_evidence() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let cache = std::env::temp_dir().join(format!(
            "okf-review-provider-live-test-{}-{nonce}",
            std::process::id()
        ));
        let executable = fake_cli(&cache);
        for kind in [CliKind::Codex, CliKind::Claude] {
            let reasoning_effort =
                matches!(kind, CliKind::Codex).then_some(CodexReasoningEffort::High);
            run_cli_live_test(
                &executable,
                kind,
                &cache,
                Some("fixture-model"),
                reasoning_effort,
            )
            .await
            .expect("live setup test");
        }
        assert!(fs::read_dir(&cache)
            .expect("cache")
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with("setup-test-")));
        let _ = fs::remove_dir_all(cache);
    }

    #[tokio::test]
    async fn model_api_fixture_sends_one_tool_free_request_and_uses_common_validation() {
        let run = frozen_run(Path::new("C:/fixture"));
        let provider_output = fake_provider_output(&run);
        let response_body = json!({
            "choices": [{"message": {"content": provider_output}}]
        })
        .to_string();
        let listener = TcpListener::bind("127.0.0.1:0").expect("fixture listener");
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("fixture request");
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .expect("read timeout");
            let mut request = Vec::new();
            let mut chunk = [0u8; 8192];
            let (body_start, body_length) = loop {
                let read = stream.read(&mut chunk).expect("read request");
                assert!(read > 0, "request ended before its body was complete");
                request.extend_from_slice(&chunk[..read]);
                let Some(header_end) = request.windows(4).position(|value| value == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .expect("content length");
                if request.len() >= header_end + 4 + content_length {
                    break (header_end + 4, content_length);
                }
            };
            let body: Value =
                serde_json::from_slice(&request[body_start..body_start + body_length])
                    .expect("request JSON");
            assert_eq!(body["model"], "fixture-model");
            assert!(body.get("tools").is_none());
            assert_eq!(body["response_format"]["type"], "json_schema");
            assert!(body["response_format"]["json_schema"]["strict"]
                .as_bool()
                .unwrap_or(false));
            let provider_schema = &body["response_format"]["json_schema"]["schema"];
            let encoded_schema = serde_json::to_string(provider_schema).expect("schema JSON");
            assert!(!encoded_schema.contains("\"allOf\""));
            assert!(!encoded_schema.contains("\"uniqueItems\""));
            assert_eq!(provider_schema["type"], "object");
            let headers = String::from_utf8_lossy(&request[..body_start]);
            assert!(headers.contains("authorization: Bearer fixture-secret"));

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream.write_all(response.as_bytes()).expect("response");
        });

        let raw = generate_api_with_key(
            &run,
            &endpoint,
            "fixture-model",
            "fixture-secret",
            &Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("API generation");
        server.join().expect("fixture server");
        let validation = quiz::validate_output(&QuizValidationInput {
            request: run.packet.request.clone(),
            current_state: observed_state(&run),
            raw_output: Some(raw),
        });
        assert!(matches!(validation, QuizValidation::Ready { .. }));
    }
}
