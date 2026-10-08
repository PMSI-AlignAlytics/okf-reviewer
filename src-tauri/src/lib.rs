//! Trusted desktop boundary for local OKF bundle reads and explicit human review.

mod app_updates;
mod bundle_grant;
mod document_links;
mod git;
mod quiz;
mod quiz_provider;
mod quiz_runtime;
mod repository_trust;
mod review;
mod watch;

use okf_core::BundleRoot;
use std::path::Path;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use watch::WatchState;

#[tauri::command]
async fn pick_bundle_folder(
    app: AppHandle,
    grants: State<'_, bundle_grant::BundleGrantState>,
) -> Result<Option<String>, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Open a folder of OKF bundles")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let folder = selected
        .into_path()
        .map_err(|_| "The selected bundle folder is not available on this platform.".to_string())?;
    grants.grant(&folder).map(Some)
}

#[tauri::command]
fn revoke_bundle_grant(
    grants: State<'_, bundle_grant::BundleGrantState>,
    folder: String,
) -> Result<bool, String> {
    grants.revoke(&folder)
}

#[tauri::command]
fn scan_bundles(
    grants: State<'_, bundle_grant::BundleGrantState>,
    folder: String,
    max_depth: usize,
) -> Result<Vec<BundleRoot>, String> {
    let folder = grants.authorize_folder(Path::new(&folder))?;
    let roots = okf_core::scan_bundles_with_depth(&folder, max_depth);
    grants.register_bundle_roots(
        &folder,
        roots.iter().map(|root| Path::new(&root.root).to_path_buf()),
    )?;
    Ok(roots)
}

#[tauri::command]
fn read_bundle(
    grants: State<'_, bundle_grant::BundleGrantState>,
    root: String,
) -> Result<document_links::ReaderBundle, String> {
    let root = grants.authorize_bundle(Path::new(&root))?;
    let scope = grants.document_scope_for_bundle(&root)?;
    Ok(document_links::read_bundle(&root, &scope))
}

#[tauri::command]
fn open_linked_document(
    app: AppHandle,
    grants: State<'_, bundle_grant::BundleGrantState>,
    root: String,
    from_id: String,
    href: String,
) -> Result<(), String> {
    let path =
        document_links::declared_document_path(grants.inner(), Path::new(&root), &from_id, &href)?;
    let path = path
        .to_str()
        .ok_or_else(|| "The document path is not valid UTF-8.".to_string())?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|error| format!("Could not open the linked document: {error}"))
}

#[tauri::command]
fn read_bundle_git_status(
    grants: State<'_, bundle_grant::BundleGrantState>,
    trusts: State<'_, repository_trust::RepositoryTrustState>,
    root: String,
) -> git::BundleGitStatus {
    let Ok(root) = grants.authorize_bundle(Path::new(&root)) else {
        return git::BundleGitStatus::unavailable();
    };
    match resolve_git_repository(grants.inner(), trusts.inner(), &root) {
        GitRepositoryAccess::Available(repository) => {
            git::bundle_status(&root, &repository, &okf_core::read_bundle(&root))
                .unwrap_or_else(git::BundleGitStatus::unavailable_with_message)
        }
        GitRepositoryAccess::TrustRequired(repository) => {
            git::BundleGitStatus::trust_required(&repository)
        }
        GitRepositoryAccess::Unavailable(message) => {
            git::BundleGitStatus::unavailable_with_message(message)
        }
    }
}

enum GitRepositoryAccess {
    Available(std::path::PathBuf),
    TrustRequired(std::path::PathBuf),
    Unavailable(String),
}

fn resolve_git_repository(
    grants: &bundle_grant::BundleGrantState,
    trusts: &repository_trust::RepositoryTrustState,
    root: &Path,
) -> GitRepositoryAccess {
    let plain_repository = match git::discover_repository(root) {
        Ok(repository) => repository,
        Err(message) => return GitRepositoryAccess::Unavailable(message),
    };
    let repository = match plain_repository.as_ref() {
        Some(repository) => repository.clone(),
        None => match git::repository_candidate(root) {
            Ok(Some(repository)) => repository,
            Ok(None) => {
                return GitRepositoryAccess::Unavailable(
                    "The active bundle is not inside a Git repository.".to_string(),
                )
            }
            Err(message) => return GitRepositoryAccess::Unavailable(message),
        },
    };
    let Ok((_, repository)) = grants.validate_enclosing_repository(root, &repository) else {
        return GitRepositoryAccess::Unavailable(
            "The enclosing Git repository could not be authorized for this bundle.".to_string(),
        );
    };

    if plain_repository.is_some()
        && grants
            .authorize_repository_for_bundle(root, &repository)
            .is_ok()
    {
        return GitRepositoryAccess::Available(repository);
    }
    if !trusts.is_trusted(&repository) {
        return GitRepositoryAccess::TrustRequired(repository);
    }
    match git::discover_repository_with_safe_directory(root, &repository) {
        Ok(Some(discovered)) if discovered == repository => {
            GitRepositoryAccess::Available(repository)
        }
        Ok(_) => GitRepositoryAccess::Unavailable(
            "Git did not confirm the trusted repository root.".to_string(),
        ),
        Err(message) => GitRepositoryAccess::Unavailable(message),
    }
}

fn require_git_repository(
    grants: &bundle_grant::BundleGrantState,
    trusts: &repository_trust::RepositoryTrustState,
    root: &Path,
) -> Result<std::path::PathBuf, String> {
    match resolve_git_repository(grants, trusts, root) {
        GitRepositoryAccess::Available(repository) => Ok(repository),
        GitRepositoryAccess::TrustRequired(repository) => Err(format!(
            "Enable read-only Git inspection for {} before using this scope.",
            repository.display()
        )),
        GitRepositoryAccess::Unavailable(message) => Err(message),
    }
}

#[tauri::command]
fn trust_bundle_repository(
    grants: State<'_, bundle_grant::BundleGrantState>,
    trusts: State<'_, repository_trust::RepositoryTrustState>,
    root: String,
    repository_root: String,
) -> Result<git::BundleGitStatus, String> {
    let root = grants.authorize_bundle(Path::new(&root))?;
    let requested = dunce::canonicalize(Path::new(&repository_root))
        .map_err(|_| "The Git repository is no longer available.".to_string())?;
    let candidate = git::repository_candidate(&root)?
        .ok_or_else(|| "The active bundle is not inside a Git repository.".to_string())?;
    if requested != candidate {
        return Err(
            "The enclosing Git repository changed. Reload the bundle and try again.".to_string(),
        );
    }
    let (_, repository) = grants.validate_enclosing_repository(&root, &requested)?;
    let discovered = git::discover_repository_with_safe_directory(&root, &repository)?
        .ok_or_else(|| "Git did not confirm the selected repository root.".to_string())?;
    if discovered != repository {
        return Err("Git reported a different repository root. No trust was saved.".to_string());
    }
    trusts.trust(&repository)?;
    Ok(
        git::bundle_status(&root, &repository, &okf_core::read_bundle(&root))
            .unwrap_or_else(git::BundleGitStatus::unavailable_with_message),
    )
}

#[tauri::command]
fn review_concept_preflight(
    grants: State<'_, bundle_grant::BundleGrantState>,
    input: review::ReviewPreflightInput,
) -> Result<review::ReviewPreflight, review::ReviewProblem> {
    let root = grants
        .authorize_bundle(Path::new(&input.bundle_root))
        .map_err(review::ReviewProblem::access)?;
    review::preflight(&root, &input.concept_id, input.reviewer_id.as_deref())
}

#[tauri::command]
fn review_concept(
    grants: State<'_, bundle_grant::BundleGrantState>,
    input: review::ReviewConceptInput,
) -> Result<review::ReviewConceptResult, review::ReviewProblem> {
    let root = grants
        .authorize_bundle(Path::new(&input.bundle_root))
        .map_err(review::ReviewProblem::access)?;
    review::apply(&root, &input)
}

#[tauri::command]
fn okf_quiz_capability_registration() -> Result<quiz::QuizCapabilityRegistration, String> {
    quiz::capability_registration()
}

#[tauri::command]
fn validate_okf_quiz(input: quiz::QuizValidationInput) -> quiz::QuizValidation {
    quiz::validate_output(&input)
}

#[tauri::command]
fn quiz_provider_profiles(
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
) -> Vec<quiz_runtime::QuizProviderProfile> {
    runtime.provider_profiles()
}

#[tauri::command]
fn quiz_generator_settings(
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
) -> quiz_runtime::QuizGeneratorSettings {
    runtime.generator_settings()
}

#[tauri::command]
fn save_quiz_generator_settings(
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    input: quiz_runtime::SaveQuizGeneratorSettingsInput,
) -> Result<quiz_runtime::QuizGeneratorSettings, String> {
    runtime.save_generator_settings(input)
}

#[tauri::command]
fn save_quiz_api_profile(
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    input: quiz_runtime::SaveApiProfileInput,
) -> Result<quiz_runtime::QuizProviderProfile, String> {
    runtime.save_api_profile(input)
}

#[tauri::command]
fn delete_quiz_api_profile(
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    profile_id: String,
) -> Result<(), String> {
    runtime.delete_api_profile(&profile_id)
}

#[tauri::command]
async fn quiz_provider_preflight(
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    input: quiz_provider::ProviderPreflightInput,
) -> Result<quiz_provider::ProviderPreflight, String> {
    let profile = runtime
        .provider_profile(&input.profile_id)
        .ok_or_else(|| "The selected quiz provider profile no longer exists.".to_string())?;
    let kind = profile.kind;
    let result = quiz_provider::preflight(profile, input.model).await;
    runtime.record_cli_diagnostic(
        kind,
        quiz_runtime::CliDiagnostic {
            tested_at: result.tested_at.clone(),
            available: result.available,
            authentication_required: result.authentication_required,
            executable: result.executable.clone(),
            version: result.version.clone(),
            message: result.message.clone(),
            live: false,
        },
    )?;
    Ok(result)
}

#[tauri::command]
async fn quiz_provider_login(
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    input: quiz_provider::ProviderLoginInput,
) -> Result<quiz_provider::ProviderLoginResult, String> {
    let profile = runtime
        .provider_profile(&input.profile_id)
        .ok_or_else(|| "The selected quiz provider profile no longer exists.".to_string())?;
    quiz_provider::login(profile, input.mode).await
}

#[tauri::command]
fn cancel_quiz_provider_login() -> bool {
    quiz_provider::cancel_login()
}

#[tauri::command]
async fn quiz_provider_live_test(
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    input: quiz_provider::ProviderPreflightInput,
) -> Result<quiz_provider::ProviderPreflight, String> {
    let profile = runtime
        .provider_profile(&input.profile_id)
        .ok_or_else(|| "The selected quiz provider profile no longer exists.".to_string())?;
    if profile.kind == quiz_runtime::QuizProviderKind::ModelApi {
        return Err("Live setup tests are available for CLI generators only.".to_string());
    }
    let kind = profile.kind;
    let result = quiz_provider::live_test(profile, input.model, runtime.cache_root()).await;
    runtime.record_cli_diagnostic(
        kind,
        quiz_runtime::CliDiagnostic {
            tested_at: result.tested_at.clone(),
            available: result.available,
            authentication_required: result.authentication_required,
            executable: result.executable.clone(),
            version: result.version.clone(),
            message: result.message.clone(),
            live: true,
        },
    )?;
    Ok(result)
}

#[tauri::command]
fn quiz_topic_candidates(
    grants: State<'_, bundle_grant::BundleGrantState>,
    bundle_root: String,
    topic: String,
) -> Result<Vec<quiz_runtime::TopicCandidate>, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    quiz_runtime::topic_candidates(&root, &topic)
}

#[tauri::command]
fn quiz_git_availability(
    grants: State<'_, bundle_grant::BundleGrantState>,
    trusts: State<'_, repository_trust::RepositoryTrustState>,
    bundle_root: String,
) -> Result<quiz_runtime::GitQuizAvailability, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    Ok(match resolve_git_repository(grants.inner(), trusts.inner(), &root) {
        GitRepositoryAccess::Available(repository) => {
            quiz_runtime::git_availability_for_repository(&repository)
        }
        GitRepositoryAccess::TrustRequired(repository) => quiz_runtime::GitQuizAvailability {
            available: false,
            repository_root: Some(repository.to_string_lossy().into_owned()),
            head_revision: None,
            message: "Enable read-only Git inspection in the confirmation dialog to use Git-backed quiz scopes."
                .to_string(),
        },
        GitRepositoryAccess::Unavailable(message) => quiz_runtime::GitQuizAvailability {
            available: false,
            repository_root: None,
            head_revision: None,
            message,
        },
    })
}

#[tauri::command]
fn quiz_git_revisions(
    grants: State<'_, bundle_grant::BundleGrantState>,
    trusts: State<'_, repository_trust::RepositoryTrustState>,
    bundle_root: String,
) -> Result<Vec<quiz_runtime::GitRevision>, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    let repository = require_git_repository(grants.inner(), trusts.inner(), &root)?;
    quiz_runtime::git_revisions(&repository)
}

fn quiz_scope_uses_git(scope: quiz::QuizScopeMode) -> bool {
    matches!(
        scope,
        quiz::QuizScopeMode::BundleDiff | quiz::QuizScopeMode::ReviewedSinceCommit
    )
}

fn quiz_repository_for_generation(
    grants: &bundle_grant::BundleGrantState,
    trusts: &repository_trust::RepositoryTrustState,
    root: &Path,
    required: bool,
) -> Result<Option<std::path::PathBuf>, String> {
    if required {
        return require_git_repository(grants, trusts, root).map(Some);
    }
    Ok(match resolve_git_repository(grants, trusts, root) {
        GitRepositoryAccess::Available(repository) => Some(repository),
        GitRepositoryAccess::TrustRequired(_) | GitRepositoryAccess::Unavailable(_) => None,
    })
}

#[tauri::command]
fn prepare_quiz_scope(
    grants: State<'_, bundle_grant::BundleGrantState>,
    trusts: State<'_, repository_trust::RepositoryTrustState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    input: quiz_runtime::PrepareQuizScopeInput,
) -> Result<quiz_runtime::QuizScopePreview, String> {
    let root = grants.authorize_bundle(Path::new(&input.bundle_root))?;
    let repository = quiz_repository_for_generation(
        grants.inner(),
        trusts.inner(),
        &root,
        quiz_scope_uses_git(input.scope_mode)
            || input.generation.mode == quiz_runtime::QuizGenerationMode::Automatic,
    )?;
    runtime.prepare_scope(&root, repository.as_deref(), &input)
}

#[tauri::command]
fn prepare_quiz_regeneration(
    grants: State<'_, bundle_grant::BundleGrantState>,
    trusts: State<'_, repository_trust::RepositoryTrustState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
    quiz_id: String,
) -> Result<quiz_runtime::QuizScopePreview, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    let input = runtime.regeneration_input(&root, &quiz_id)?;
    let repository = quiz_repository_for_generation(
        grants.inner(),
        trusts.inner(),
        &root,
        quiz_scope_uses_git(input.scope_mode)
            || input.generation.mode == quiz_runtime::QuizGenerationMode::Automatic,
    )
    .map_err(|error| {
        if quiz_scope_uses_git(input.scope_mode) {
            "The historical Git scope can no longer be reproduced.".to_string()
        } else {
            error
        }
    })?;
    runtime.prepare_scope(&root, repository.as_deref(), &input)
}

#[tauri::command]
fn prepare_quiz_failure_retry(
    grants: State<'_, bundle_grant::BundleGrantState>,
    trusts: State<'_, repository_trust::RepositoryTrustState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
    failure_id: String,
) -> Result<quiz_runtime::QuizScopePreview, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    let input = runtime.generation_failure_retry_input(&root, &failure_id)?;
    let repository = quiz_repository_for_generation(
        grants.inner(),
        trusts.inner(),
        &root,
        quiz_scope_uses_git(input.scope_mode)
            || input.generation.mode == quiz_runtime::QuizGenerationMode::Automatic,
    )
    .map_err(|error| {
        if quiz_scope_uses_git(input.scope_mode) {
            "The historical Git scope can no longer be reproduced.".to_string()
        } else {
            error
        }
    })?;
    let preview = runtime.prepare_scope(&root, repository.as_deref(), &input)?;
    if let Err(error) = runtime.mark_generation_failure_retry(&preview.request_id, &failure_id) {
        runtime.remove_frozen_packet(&preview.request_id);
        return Err(error);
    }
    Ok(preview)
}

#[tauri::command]
async fn generate_quiz(
    app: AppHandle,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    input: quiz_provider::GenerateQuizInput,
) -> Result<quiz_provider::QuizGenerationOutcome, String> {
    Ok(quiz_provider::generate(&app, &runtime, input).await)
}

#[tauri::command]
fn preview_quiz_generation_prompt(
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    input: quiz_provider::GenerateQuizInput,
) -> Result<quiz_provider::QuizPromptPreview, String> {
    quiz_provider::prompt_preview(runtime.inner(), &input)
}

#[tauri::command]
fn cancel_quiz_generation(
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    request_id: String,
) -> bool {
    runtime.cancel_generation(&request_id)
}

#[tauri::command]
fn list_quizzes(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
) -> Result<Vec<quiz_runtime::QuizSummary>, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    runtime.list_quizzes(&root)
}

#[tauri::command]
fn list_quiz_generation_failures(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
) -> Result<Vec<quiz_runtime::QuizGenerationFailureSummary>, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    Ok(runtime.list_generation_failures(&root))
}

#[tauri::command]
fn list_quiz_attempts(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
    quiz_id: String,
) -> Result<Vec<quiz_runtime::QuizAttemptSummary>, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    runtime.list_attempts(&root, &quiz_id)
}

#[tauri::command]
fn start_quiz_attempt(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
    quiz_id: String,
) -> Result<quiz_runtime::QuizAttemptView, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    runtime.start_attempt(&root, &quiz_id)
}

#[tauri::command]
fn resume_quiz_attempt(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
    attempt_id: String,
) -> Result<quiz_runtime::QuizAttemptView, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    runtime.resume_attempt(&root, &attempt_id)
}

#[tauri::command]
fn submit_quiz_answer(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    input: quiz_runtime::SubmitQuizAnswerInput,
) -> Result<quiz_runtime::QuizAnswerReveal, String> {
    let root = grants.authorize_bundle(Path::new(&input.bundle_root))?;
    runtime.submit_answer(&root, &input)
}

#[tauri::command]
fn mark_quiz_question_not_important(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    input: quiz_runtime::MarkQuizQuestionNotImportantInput,
) -> Result<quiz_runtime::QuizAttemptView, String> {
    let root = grants.authorize_bundle(Path::new(&input.bundle_root))?;
    runtime.mark_question_not_important(&root, &input)
}

#[tauri::command]
fn get_quiz_results(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
    attempt_id: String,
) -> Result<quiz_runtime::QuizResults, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    runtime.results(&root, &attempt_id)
}

#[tauri::command]
fn delete_quiz(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
    quiz_id: String,
) -> Result<(), String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    runtime.delete_quiz(&root, &quiz_id)
}

#[tauri::command]
fn delete_quiz_generation_failure(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
    failure_id: String,
) -> Result<(), String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    runtime.delete_generation_failure(&root, &failure_id)
}

#[tauri::command]
fn delete_quiz_attempt(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
    attempt_id: String,
) -> Result<(), String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    runtime.delete_attempt(&root, &attempt_id)
}

#[tauri::command]
fn delete_bundle_quiz_history(
    grants: State<'_, bundle_grant::BundleGrantState>,
    runtime: State<'_, quiz_runtime::QuizRuntimeState>,
    bundle_root: String,
) -> Result<(), String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    runtime.delete_bundle_history(&root)
}

#[tauri::command]
async fn okf_compatibility_report(
    grants: State<'_, bundle_grant::BundleGrantState>,
    bundle_root: String,
) -> Result<okf_core::compatibility::CompatibilityReport, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    let scope = grants.document_scope_for_bundle(&root)?;
    tauri::async_runtime::spawn_blocking(move || {
        okf_core::compatibility::analyze(&document_links::read_bundle(&root, &scope).bundle)
    })
    .await
    .map_err(|_| "OKF Reviewer could not build the compatibility report.".to_string())
}

#[tauri::command]
async fn okf_profile_report(
    grants: State<'_, bundle_grant::BundleGrantState>,
    bundle_root: String,
) -> Result<okf_core::profile::ProfileReport, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = okf_core::read_bundle(&root);
        okf_core::profile::analyze(&root, &bundle)
    })
    .await
    .map_err(|_| "OKF Reviewer could not resolve the bundle profiles.".to_string())
}

#[tauri::command]
async fn okf_interop_report(
    grants: State<'_, bundle_grant::BundleGrantState>,
    bundle_root: String,
) -> Result<okf_core::interop::InteropReport, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = okf_core::read_bundle(&root);
        okf_core::interop::analyze(&root, &bundle)
    })
    .await
    .map_err(|_| "OKF Reviewer could not build the interoperability report.".to_string())
}

#[tauri::command]
fn read_asset(
    grants: State<'_, bundle_grant::BundleGrantState>,
    root: String,
    rel: String,
) -> Result<Option<String>, String> {
    let root = grants.authorize_bundle(Path::new(&root))?;
    Ok(okf_core::read_asset(&root, &rel))
}

#[tauri::command]
fn read_asset_data_url(
    grants: State<'_, bundle_grant::BundleGrantState>,
    root: String,
    rel: String,
) -> Result<Option<String>, String> {
    let root = grants.authorize_bundle(Path::new(&root))?;
    Ok(okf_core::read_asset_data_url(&root, &rel))
}

#[tauri::command]
async fn read_declared_computation(
    grants: State<'_, bundle_grant::BundleGrantState>,
    bundle_root: String,
    concept_id: String,
) -> Result<Option<String>, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = okf_core::read_bundle(&root);
        let concept = bundle
            .concepts
            .iter()
            .find(|concept| concept.id == concept_id)?;
        okf_core::read_declared_computation(&root, concept)
    })
    .await
    .map_err(|_| "OKF Reviewer could not read the declared computation.".to_string())
}

const MAX_RECEIPT_FIELDS: usize = 64;
const MAX_RECEIPT_VALUE_CHARS: usize = 256 * 1024;

#[tauri::command]
async fn attest_computation_run(
    grants: State<'_, bundle_grant::BundleGrantState>,
    bundle_root: String,
    concept_id: String,
    receipt: std::collections::BTreeMap<String, String>,
    today: String,
) -> Result<okf_core::attest::AttestationReport, String> {
    let root = grants.authorize_bundle(Path::new(&bundle_root))?;
    if receipt.len() > MAX_RECEIPT_FIELDS {
        return Err("That receipt declares too many fields.".to_string());
    }
    if receipt
        .values()
        .any(|value| value.len() > MAX_RECEIPT_VALUE_CHARS)
    {
        return Err("A receipt field is too large to attest.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = okf_core::read_bundle(&root);
        let concept = bundle
            .concepts
            .iter()
            .find(|concept| concept.id == concept_id)
            .ok_or_else(|| "That concept is not in this bundle.".to_string())?;
        Ok(okf_core::attest::attest_run(
            &root, concept, &receipt, &today,
        ))
    })
    .await
    .map_err(|_| "OKF Reviewer could not complete the attestation.".to_string())?
}

#[tauri::command]
fn start_watch(
    app: AppHandle,
    state: State<'_, WatchState>,
    grants: State<'_, bundle_grant::BundleGrantState>,
    folder: String,
) -> Result<(), String> {
    let folder = grants
        .authorize_bundle(Path::new(&folder))?
        .to_string_lossy()
        .into_owned();
    watch::start(app, state.inner(), folder);
    Ok(())
}

#[tauri::command]
fn stop_watch(state: State<'_, WatchState>) {
    watch::stop(state.inner());
}

const MAX_FRONTEND_LOG_CHARS: usize = 16 * 1024;
const FRONTEND_LOG_TRUNCATION_MARKER: &str = " … [truncated]";

fn bounded_frontend_diagnostic(message: &str) -> String {
    let mut diagnostic = String::new();
    let mut separated = false;
    let mut characters = message.trim().chars();
    for character in characters.by_ref().take(MAX_FRONTEND_LOG_CHARS) {
        if character.is_whitespace() {
            if !separated && !diagnostic.is_empty() {
                diagnostic.push(' ');
                separated = true;
            }
            continue;
        }
        if character.is_control() {
            continue;
        }
        diagnostic.push(character);
        separated = false;
    }
    if characters.next().is_some() {
        let available =
            MAX_FRONTEND_LOG_CHARS.saturating_sub(FRONTEND_LOG_TRUNCATION_MARKER.chars().count());
        diagnostic = diagnostic.chars().take(available).collect();
        diagnostic.push_str(FRONTEND_LOG_TRUNCATION_MARKER);
    }
    if diagnostic.is_empty() {
        "(empty diagnostic)".to_string()
    } else {
        diagnostic
    }
}

#[tauri::command]
fn frontend_log(message: String) {
    eprintln!("[frontend] {}", bounded_frontend_diagnostic(&message));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_filter(|label| label == "main")
            .with_state_flags(
                tauri_plugin_window_state::StateFlags::all()
                    - tauri_plugin_window_state::StateFlags::VISIBLE,
            )
            .build(),
    );

    builder
        .setup(|app| {
            app.manage(
                bundle_grant::BundleGrantState::load(app.handle()).map_err(|error| {
                    std::io::Error::other(format!("could not load bundle grants: {error}"))
                })?,
            );
            app.manage(
                repository_trust::RepositoryTrustState::load(app.handle()).map_err(|error| {
                    std::io::Error::other(format!("could not load repository trust: {error}"))
                })?,
            );
            app.manage(
                quiz_runtime::QuizRuntimeState::load(app.handle()).map_err(|error| {
                    std::io::Error::other(format!("could not load quiz data: {error}"))
                })?,
            );
            app.manage(WatchState::default());
            app.manage(app_updates::AppUpdateState::default());

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(10));
                if let Some(window) = handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                }
            });

            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| {
                    use gtk::glib::gobject_ffi;
                    use gtk::glib::prelude::ObjectExt;
                    use webkit2gtk::WebViewExt;
                    let webview = webview.inner();
                    // SAFETY: WebKitGTK owns this gesture object and the callback
                    // runs on the GTK main thread.
                    unsafe {
                        if let Some(gesture) =
                            webview.data::<gtk::GestureZoom>("wk-view-zoom-gesture")
                        {
                            gobject_ffi::g_signal_handlers_destroy(gesture.as_ptr().cast());
                        }
                    }
                    webview.set_zoom_level(1.0);
                    webview.connect_zoom_level_notify(|webview| {
                        if (webview.zoom_level() - 1.0).abs() > f64::EPSILON {
                            webview.set_zoom_level(1.0);
                        }
                    });
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_updates::check_app_update,
            app_updates::download_app_update,
            app_updates::install_app_update,
            pick_bundle_folder,
            revoke_bundle_grant,
            scan_bundles,
            read_bundle,
            open_linked_document,
            read_bundle_git_status,
            trust_bundle_repository,
            review_concept_preflight,
            review_concept,
            okf_quiz_capability_registration,
            validate_okf_quiz,
            quiz_provider_profiles,
            quiz_generator_settings,
            save_quiz_generator_settings,
            save_quiz_api_profile,
            delete_quiz_api_profile,
            quiz_provider_preflight,
            quiz_provider_login,
            cancel_quiz_provider_login,
            quiz_provider_live_test,
            quiz_topic_candidates,
            quiz_git_availability,
            quiz_git_revisions,
            prepare_quiz_scope,
            prepare_quiz_regeneration,
            prepare_quiz_failure_retry,
            generate_quiz,
            preview_quiz_generation_prompt,
            cancel_quiz_generation,
            list_quizzes,
            list_quiz_generation_failures,
            list_quiz_attempts,
            start_quiz_attempt,
            resume_quiz_attempt,
            submit_quiz_answer,
            mark_quiz_question_not_important,
            get_quiz_results,
            delete_quiz,
            delete_quiz_generation_failure,
            delete_quiz_attempt,
            delete_bundle_quiz_history,
            okf_compatibility_report,
            okf_profile_report,
            okf_interop_report,
            read_asset,
            read_asset_data_url,
            read_declared_computation,
            attest_computation_run,
            start_watch,
            stop_watch,
            frontend_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_frontend_diagnostic, FRONTEND_LOG_TRUNCATION_MARKER, MAX_FRONTEND_LOG_CHARS,
    };

    #[test]
    fn frontend_diagnostics_are_single_line_control_free_and_bounded() {
        assert_eq!(
            bounded_frontend_diagnostic(" first\u{1b}[31m\r\nsecond\tline\u{2028}three\0 "),
            "first[31m second line three"
        );
        assert_eq!(bounded_frontend_diagnostic("\r\n\t"), "(empty diagnostic)");

        let oversized = "é".repeat(MAX_FRONTEND_LOG_CHARS + 1);
        let bounded = bounded_frontend_diagnostic(&oversized);
        assert!(bounded.ends_with(FRONTEND_LOG_TRUNCATION_MARKER));
        assert_eq!(bounded.chars().count(), MAX_FRONTEND_LOG_CHARS);
        assert_eq!(
            bounded.matches('é').count(),
            MAX_FRONTEND_LOG_CHARS - FRONTEND_LOG_TRUNCATION_MARKER.chars().count()
        );
    }
}
