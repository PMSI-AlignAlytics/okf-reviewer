// The complete frontend/backend boundary for the focused reviewer. Native
// commands are limited to local bundle reads, explicit human review, read-only
// reports and assets, provider-neutral quiz contract validation, filesystem
// watching, diagnostics, and local preferences.

import type {
  AttestationReport,
  Bundle,
  BundleGitStatus,
  BundleRoot,
  CompatibilityFinding,
  CompatibilityReport,
  ProfileReport,
  RecentBundle,
  Settings,
} from "@/shared/types.ts";
import type { InteropReport } from "@/features/bundle/interop.ts";
import type {
  ReviewConceptRequest,
  ReviewConceptResult,
  ReviewPreflight,
  ReviewPreflightRequest,
  ReviewProblemCode,
} from "@/features/review/types.ts";
import type {
  GitQuizAvailability,
  GitRevision,
  PrepareQuizScopeInput,
  ProviderLoginMode,
  ProviderLoginResult,
  ProviderPreflight,
  QuizAnswerReveal,
  QuizAttemptSummary,
  QuizAttemptView,
  QuizCapabilityRegistration,
  QuizGenerationOutcome,
  QuizGenerationFailureSummary,
  QuizGenerationProgress,
  QuizGeneratorSettings,
  QuizProviderProfile,
  QuizResults,
  QuizPromptPreview,
  QuizScopePreview,
  QuizSummary,
  SaveQuizApiProfileInput,
  SaveQuizGeneratorSettingsInput,
  SubmitQuizAnswerInput,
  MarkQuizQuestionNotImportantInput,
  TopicCandidate,
  QuizValidation,
  QuizValidationInput,
} from "@/features/quiz/types.ts";
import * as quizMock from "@/features/quiz/mock.ts";
import { DEFAULT_SETTINGS } from "@/shared/types.ts";
import { inlineComputation, mockAttestationFor } from "@/features/bundle/mockAttestation.ts";
import { today } from "@/features/bundle/trust.ts";
import {
  MOCK_ASSETS,
  MOCK_BUNDLE,
  MOCK_FOLDER,
  MOCK_GIT_STATUS,
  MOCK_RECENTS,
  MOCK_ROOTS,
} from "@/mock/fixture.ts";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function browserMockDelay(milliseconds: number): Promise<void> {
  const delay = import.meta.env.MODE === "test" ? 0 : milliseconds;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export function logToHost(message: string): void {
  console.warn(message);
  if (!isTauri()) return;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("frontend_log", { message }))
    .catch(() => {
      // Diagnostics must never throw.
    });
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return MOCK_FOLDER;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("pick_bundle_folder");
}

export async function revokeBundleGrant(folder: string): Promise<boolean> {
  if (!isTauri()) return true;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("revoke_bundle_grant", { folder });
}

export async function scanBundles(
  folder: string,
  maxDepth = 8,
): Promise<BundleRoot[]> {
  if (!isTauri()) return MOCK_ROOTS;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<BundleRoot[]>("scan_bundles", { folder, maxDepth });
}

export async function readBundle(root: string): Promise<Bundle> {
  if (!isTauri()) return MOCK_BUNDLE;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Bundle>("read_bundle", { root });
}

export async function readBundleGitStatus(root: string): Promise<BundleGitStatus> {
  if (!isTauri()) return MOCK_GIT_STATUS;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<BundleGitStatus>("read_bundle_git_status", { root });
}

export async function trustBundleRepository(
  root: string,
  repositoryRoot: string,
): Promise<BundleGitStatus> {
  if (!isTauri()) {
    throw new Error("Repository trust is available only in the desktop app.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<BundleGitStatus>("trust_bundle_repository", {
    root,
    repositoryRoot,
  });
}

export async function quizProviderProfiles(): Promise<QuizProviderProfile[]> {
  if (!isTauri()) return quizMock.mockProfiles();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizProviderProfile[]>("quiz_provider_profiles");
}

export async function quizGeneratorSettings(): Promise<QuizGeneratorSettings> {
  if (!isTauri()) return quizMock.mockGeneratorSettings();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizGeneratorSettings>("quiz_generator_settings");
}

export async function saveQuizGeneratorSettings(
  input: SaveQuizGeneratorSettingsInput,
): Promise<QuizGeneratorSettings> {
  if (!isTauri()) return quizMock.mockSaveGeneratorSettings(input);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizGeneratorSettings>("save_quiz_generator_settings", { input });
}

export async function saveQuizApiProfile(
  input: SaveQuizApiProfileInput,
): Promise<QuizProviderProfile> {
  if (!isTauri()) return quizMock.mockSaveProfile(input);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizProviderProfile>("save_quiz_api_profile", { input });
}

export async function deleteQuizApiProfile(profileId: string): Promise<void> {
  if (!isTauri()) return quizMock.mockDeleteProfile(profileId);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("delete_quiz_api_profile", { profileId });
}

export async function quizProviderPreflight(
  profileId: string,
  model: string | null,
): Promise<ProviderPreflight> {
  if (!isTauri()) return quizMock.mockPreflight(profileId);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProviderPreflight>("quiz_provider_preflight", {
    input: { profileId, model },
  });
}

export async function quizProviderLiveTest(
  profileId: string,
  model: string | null,
): Promise<ProviderPreflight> {
  if (!isTauri()) return quizMock.mockPreflight(profileId, true);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProviderPreflight>("quiz_provider_live_test", {
    input: { profileId, model },
  });
}

export async function quizProviderLogin(
  profileId: string,
  mode: ProviderLoginMode,
): Promise<ProviderLoginResult> {
  if (!isTauri()) return quizMock.mockProviderLogin(profileId, mode);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProviderLoginResult>("quiz_provider_login", {
    input: { profileId, mode },
  });
}

export async function cancelQuizProviderLogin(): Promise<boolean> {
  if (!isTauri()) return true;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("cancel_quiz_provider_login");
}

export async function quizTopicCandidates(
  bundleRoot: string,
  topic: string,
): Promise<TopicCandidate[]> {
  if (!isTauri()) return quizMock.mockTopicCandidates(topic);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<TopicCandidate[]>("quiz_topic_candidates", { bundleRoot, topic });
}

export async function quizGitAvailability(
  bundleRoot: string,
): Promise<GitQuizAvailability> {
  if (!isTauri()) return quizMock.mockGitAvailability();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<GitQuizAvailability>("quiz_git_availability", { bundleRoot });
}

export async function quizGitRevisions(bundleRoot: string): Promise<GitRevision[]> {
  if (!isTauri()) return quizMock.mockGitRevisions();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<GitRevision[]>("quiz_git_revisions", { bundleRoot });
}

export async function prepareQuizScope(
  input: PrepareQuizScopeInput,
): Promise<QuizScopePreview> {
  if (!isTauri()) return quizMock.mockPrepareScope(input);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizScopePreview>("prepare_quiz_scope", { input });
}

export async function prepareQuizRegeneration(
  bundleRoot: string,
  quizId: string,
): Promise<QuizScopePreview> {
  if (!isTauri()) return quizMock.mockPrepareRegeneration(quizId);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizScopePreview>("prepare_quiz_regeneration", {
    bundleRoot,
    quizId,
  });
}

export async function prepareQuizFailureRetry(
  bundleRoot: string,
  failureId: string,
): Promise<QuizScopePreview> {
  if (!isTauri()) return quizMock.mockPrepareFailureRetry(failureId);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizScopePreview>("prepare_quiz_failure_retry", {
    bundleRoot,
    failureId,
  });
}

export async function generateQuiz(
  requestId: string,
  profileId: string,
  model: string | null,
): Promise<QuizGenerationOutcome> {
  if (!isTauri()) return quizMock.mockGenerate(requestId, profileId);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizGenerationOutcome>("generate_quiz", {
    input: { requestId, profileId, model },
  });
}

export async function previewQuizGenerationPrompt(
  requestId: string,
  profileId: string,
  model: string | null,
): Promise<QuizPromptPreview> {
  if (!isTauri()) return quizMock.mockPromptPreview(profileId);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizPromptPreview>("preview_quiz_generation_prompt", {
    input: { requestId, profileId, model },
  });
}

export async function cancelQuizGeneration(requestId: string): Promise<boolean> {
  if (!isTauri()) return true;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("cancel_quiz_generation", { requestId });
}

export async function onQuizGenerationProgress(
  listener: (progress: QuizGenerationProgress) => void,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<QuizGenerationProgress>("quiz-generation-progress", (event) =>
    listener(event.payload)
  );
}

export async function listQuizzes(bundleRoot: string): Promise<QuizSummary[]> {
  if (!isTauri()) return quizMock.mockListQuizzes();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizSummary[]>("list_quizzes", { bundleRoot });
}

export async function listQuizGenerationFailures(
  bundleRoot: string,
): Promise<QuizGenerationFailureSummary[]> {
  if (!isTauri()) return quizMock.mockListGenerationFailures();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizGenerationFailureSummary[]>("list_quiz_generation_failures", { bundleRoot });
}

export async function listQuizAttempts(
  bundleRoot: string,
  quizId: string,
): Promise<QuizAttemptSummary[]> {
  if (!isTauri()) return quizMock.mockListAttempts(quizId);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizAttemptSummary[]>("list_quiz_attempts", { bundleRoot, quizId });
}

export async function startQuizAttempt(
  bundleRoot: string,
  quizId: string,
): Promise<QuizAttemptView> {
  if (!isTauri()) return quizMock.mockStartAttempt(quizId);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizAttemptView>("start_quiz_attempt", { bundleRoot, quizId });
}

export async function resumeQuizAttempt(
  bundleRoot: string,
  attemptId: string,
): Promise<QuizAttemptView> {
  if (!isTauri()) return quizMock.mockResumeAttempt(attemptId);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizAttemptView>("resume_quiz_attempt", { bundleRoot, attemptId });
}

export async function submitQuizAnswer(
  input: SubmitQuizAnswerInput,
): Promise<QuizAnswerReveal> {
  if (!isTauri()) return quizMock.mockSubmitAnswer(input);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizAnswerReveal>("submit_quiz_answer", { input });
}

export async function markQuizQuestionNotImportant(
  input: MarkQuizQuestionNotImportantInput,
): Promise<QuizAttemptView> {
  if (!isTauri()) return quizMock.mockMarkNotImportant(input);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizAttemptView>("mark_quiz_question_not_important", { input });
}

export async function getQuizResults(
  bundleRoot: string,
  attemptId: string,
): Promise<QuizResults> {
  if (!isTauri()) return quizMock.mockResults(attemptId);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizResults>("get_quiz_results", { bundleRoot, attemptId });
}

export async function deleteQuiz(bundleRoot: string, quizId: string): Promise<void> {
  if (!isTauri()) return quizMock.mockDeleteQuiz(quizId);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("delete_quiz", { bundleRoot, quizId });
}

export async function deleteQuizGenerationFailure(
  bundleRoot: string,
  failureId: string,
): Promise<void> {
  if (!isTauri()) return quizMock.mockDeleteGenerationFailure(failureId);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("delete_quiz_generation_failure", { bundleRoot, failureId });
}

export async function deleteQuizAttempt(
  bundleRoot: string,
  attemptId: string,
): Promise<void> {
  if (!isTauri()) return quizMock.mockDeleteAttempt(attemptId);
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("delete_quiz_attempt", { bundleRoot, attemptId });
}

export async function deleteBundleQuizHistory(bundleRoot: string): Promise<void> {
  if (!isTauri()) return quizMock.mockDeleteAll();
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("delete_bundle_quiz_history", { bundleRoot });
}

function mockReviewFingerprint(conceptId: string): string {
  const concept = MOCK_BUNDLE.concepts.find((item) => item.id === conceptId);
  if (!concept) return "mock-missing";
  return [
    "mock",
    concept.id,
    concept.status,
    concept.statusExplicit ? "explicit" : "implicit",
    concept.verified.length,
    concept.body.length,
  ].join("-");
}

class MockReviewError extends Error {
  readonly code: ReviewProblemCode;

  constructor(code: ReviewProblemCode, message: string) {
    super(message);
    this.name = "MockReviewError";
    this.code = code;
  }
}

export async function reviewConceptPreflight(
  input: ReviewPreflightRequest,
): Promise<ReviewPreflight> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<ReviewPreflight>("review_concept_preflight", { input });
  }
  const concept = MOCK_BUNDLE.concepts.find((item) => item.id === input.conceptId);
  if (!concept) {
    throw new MockReviewError("missing-concept", "The concept file is no longer available.");
  }
  const reviewer = input.reviewerId?.trim().replace(/^human:/u, "") ?? "";
  const reviewerValid =
    reviewer.length === 0 ||
    (reviewer.length <= 128 && /^[A-Za-z0-9._@-]+$/u.test(reviewer));
  const humanActors = concept.verified
    .map((entry) => entry.by)
    .filter((actor) => actor.startsWith("human:"));
  const actor = reviewer ? `human:${reviewer}` : null;
  const reviewerHasReviewed = actor !== null && humanActors.includes(actor);
  const available = concept.status !== "deprecated" && reviewerValid;
  const reviewedAt = new Date().toISOString();
  const actionLabel = reviewerHasReviewed
    ? "Review again"
    : concept.status !== "stable"
      ? "Mark reviewed and stable"
      : humanActors.length === 0
        ? "Mark as reviewed"
        : "Add my review";
  return {
    available,
    reasonCode: !reviewerValid
      ? "invalid-reviewer"
      : concept.status === "deprecated"
        ? "deprecated"
        : null,
    message: !reviewerValid
      ? "Reviewer ID contains unsupported characters."
      : concept.status === "deprecated"
        ? "Deprecated concepts are historical. Review is unavailable by default."
        : concept.statusExplicit
          ? "This app will append a human verification record."
          : "Status is implicitly stable. This review will author status: stable and append a human verification record.",
    conceptId: concept.id,
    relativePath: `${concept.id}.md`,
    fingerprint: mockReviewFingerprint(concept.id),
    currentStatus: concept.status,
    statusExplicit: concept.statusExplicit,
    reviewState:
      humanActors.length > 0
        ? "human-reviewed"
        : concept.verified.length > 0
          ? "machine-confirmed"
          : "unverified",
    reviewerHasReviewed,
    actionLabel: available ? actionLabel : null,
    resultingStatus: available ? "stable" : null,
    reviewedAt,
  };
}

export async function reviewConcept(
  input: ReviewConceptRequest,
): Promise<ReviewConceptResult> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<ReviewConceptResult>("review_concept", { input });
  }
  const concept = MOCK_BUNDLE.concepts.find((item) => item.id === input.conceptId);
  if (!concept) {
    throw new MockReviewError("missing-concept", "The concept file is no longer available.");
  }
  if (mockReviewFingerprint(concept.id) !== input.expectedFingerprint) {
    throw new MockReviewError(
      "conflict",
      "The concept changed after confirmation opened. Reload it and try again.",
    );
  }
  const reviewer = input.reviewerId.trim().replace(/^human:/u, "");
  if (!reviewer || reviewer.length > 128 || !/^[A-Za-z0-9._@-]+$/u.test(reviewer)) {
    throw new MockReviewError("invalid-reviewer", "Reviewer ID is invalid.");
  }
  const actor = `human:${reviewer}`;
  concept.status = "stable";
  concept.statusExplicit = true;
  concept.verified.push({ by: actor, at: input.reviewedAt });
  return {
    conceptId: concept.id,
    relativePath: `${concept.id}.md`,
    fingerprint: mockReviewFingerprint(concept.id),
    status: "stable",
    statusExplicit: true,
    actor,
    reviewedAt: input.reviewedAt,
    verificationCount: concept.verified.length,
    message: "Human review recorded.",
  };
}

export async function readQuizCapabilityRegistration(): Promise<QuizCapabilityRegistration> {
  if (!isTauri()) {
    return {
      schemaVersion: 1,
      packId: "okf-quiz",
      packVersion: "1.0.0",
      name: "OKF Quiz",
      // Match the native v1 capability pack's fixed publisher identifier.
      publisher: "OKF Review",
      provenance: "built-in",
      manifestSha256: "browser-mock",
      task: {
        schemaVersion: 1,
        id: "okf-quiz",
        title: "Generate an evidence-bound knowledge quiz",
        capabilityId: "okf-quiz",
        skillResourceId: "okf-quiz-instructions",
        artifactSchemaId: "okf-quiz-v1",
        readOnly: true,
        providerIndependent: true,
        usesFrozenEvidencePacket: true,
        allowsBundleChanges: false,
        allowsSettingsMutation: false,
        allowedTools: ["repository-read", "git-read"],
        networkPolicy: "provider-transport-only",
      },
      resources: [],
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizCapabilityRegistration>("okf_quiz_capability_registration");
}

export async function validateQuizArtifact(
  input: QuizValidationInput,
): Promise<QuizValidation> {
  if (!isTauri()) {
    throw new Error("Quiz artifacts require trusted native validation.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<QuizValidation>("validate_okf_quiz", { input });
}

function mockCompatibilityReport(): CompatibilityReport {
  const findings: CompatibilityFinding[] = MOCK_BUNDLE.issues.map((issue) => ({
    ruleId: issue.message.includes("link target not found")
      ? "okf.conformance.link-target"
      : "okf.conformance.parser",
    category: issue.message.includes("link target not found") ? "link" : "parser",
    level: issue.level,
    basis: "okf-conformance",
    file: issue.message.split(":", 1)[0] || `${issue.conceptId ?? "bundle"}.md`,
    conceptId: issue.conceptId,
    message: issue.message,
    repair: null,
  }));
  findings.push({
    ruleId: "okf.portability.relative-link",
    category: "link",
    level: "advice",
    basis: "portability",
    file: "architecture/application.md",
    conceptId: "architecture/application",
    message:
      "Use ../review-operation.md so this link travels reliably between OKF consumers.",
    repair: null,
  });
  findings.push({
    ruleId: "okf.extensions.preserved",
    category: "extension",
    level: "information",
    basis: "preservation",
    file: "architecture/application.md",
    conceptId: "architecture/application",
    message: "Producer-defined frontmatter was preserved.",
    repair: null,
  });
  return { schemaVersion: 1, findings, truncated: false };
}

export async function readCompatibilityReport(
  bundleRoot: string,
): Promise<CompatibilityReport> {
  if (!isTauri()) {
    await browserMockDelay(40);
    return mockCompatibilityReport();
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CompatibilityReport>("okf_compatibility_report", { bundleRoot });
}

function mockProfileReport(): ProfileReport {
  return {
    schemaVersion: 1,
    profiles: [{
      namespace: "com.example.knowledge",
      version: "1.2.0",
      descriptorPath: "profiles/com.example.knowledge.json",
      status: "active",
      message: "Resolved from this bundle.",
      descriptor: {
        schemaVersion: 1,
        namespace: "com.example.knowledge",
        version: "1.2.0",
        title: "Team knowledge",
        description: "Shared product-knowledge conventions.",
        fields: [],
        relationships: [{
          id: "supports",
          label: "Supports",
          inverse: "supported-by",
          description: "This concept provides implementation support.",
        }],
        checks: [],
      },
      extra: {},
    }],
    diagnostics: [],
    edges: [{
      sourceId: "product/overview",
      targetId: "features/graph-view",
      namespace: "com.example.knowledge",
      type: "supports",
      label: "Supports",
      inverse: "supported-by",
      recognized: true,
      targetExists: true,
      portableLink: true,
    }],
    truncated: false,
  };
}

export async function readProfileReport(bundleRoot: string): Promise<ProfileReport> {
  if (!isTauri()) {
    await browserMockDelay(40);
    return mockProfileReport();
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProfileReport>("okf_profile_report", { bundleRoot });
}

function mockInteropReport(): InteropReport {
  return {
    schemaVersion: 1,
    multilingual: {
      groups: [],
      conventions: [],
      adoptionReady: false,
      message: "No multilingual conventions were detected.",
    },
    externalBundles: [],
    semanticWeb: {
      exportableRelationships: 1,
      unsupportedRelationships: 0,
      message: "One typed relationship is available.",
    },
    sidecars: [{
      conceptId: "product/overview",
      path: "assets/example.notebook",
      mediaType: "application/x-ipynb+json",
      authoredDigest: null,
      actualDigest: null,
      size: null,
      status: "missing",
      openPolicy: "download-only",
      message: "The declared resource is not available.",
    }],
    diagnostics: [],
    truncated: false,
  };
}

export async function readInteropReport(bundleRoot: string): Promise<InteropReport> {
  if (!isTauri()) {
    await browserMockDelay(40);
    return mockInteropReport();
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<InteropReport>("okf_interop_report", { bundleRoot });
}

export async function readAsset(
  root: string,
  rel: string,
): Promise<string | null> {
  if (!isTauri()) {
    const key = rel.replace(/^\/+/u, "");
    const extension = key.split(".").pop()?.toLowerCase() ?? "";
    if (!["html", "css", "svg"].includes(extension)) return null;
    return MOCK_ASSETS[key] ?? null;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("read_asset", { root, rel });
}

export async function readDeclaredComputation(
  bundleRoot: string,
  conceptId: string,
): Promise<string | null> {
  if (!isTauri()) {
    const concept = MOCK_BUNDLE.concepts.find((item) => item.id === conceptId);
    const declared = concept?.computation?.computation;
    return declared ? MOCK_ASSETS[declared.replace(/^\/+/u, "")] ?? null : null;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("read_declared_computation", { bundleRoot, conceptId });
}

function mockAttestation(
  conceptId: string,
  receipt: Record<string, string>,
  on: string,
): AttestationReport {
  const concept = MOCK_BUNDLE.concepts.find((item) => item.id === conceptId);
  if (!concept) {
    return {
      conceptId,
      conceptTitle: conceptId,
      runtime: null,
      source: null,
      contractError: { reason: "notAComputation" },
      attestation: null,
      verdict: "contract-unreadable",
    };
  }
  const path = concept.computation?.computation ?? null;
  const stored = path
    ? MOCK_ASSETS[path.replace(/^\/+/u, "")] ?? null
    : inlineComputation(concept.body);
  return mockAttestationFor(concept, stored, path, receipt, on);
}

export async function attestComputationRun(
  bundleRoot: string,
  conceptId: string,
  receipt: Record<string, string>,
  on = today(),
): Promise<AttestationReport> {
  if (!isTauri()) return mockAttestation(conceptId, receipt, on);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AttestationReport>("attest_computation_run", {
    bundleRoot,
    conceptId,
    receipt,
    today: on,
  });
}

export async function readAssetDataUrl(
  root: string,
  rel: string,
): Promise<string | null> {
  if (!isTauri()) {
    const key = rel.replace(/^\/+/u, "");
    const text = MOCK_ASSETS[key];
    if (!text) return null;
    const mime = key.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png";
    return `data:${mime};base64,${btoa(text)}`;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("read_asset_data_url", { root, rel });
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export async function openLinkedDocument(root: string, fromId: string, href: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<null>("open_linked_document", { root, fromId, href });
}

const STORE_FILE = "okf-review.json";
const RECENTS_KEY = "recentBundles";
const RECENTS_CAP = 12;

async function store() {
  const { load } = await import("@tauri-apps/plugin-store");
  return load(STORE_FILE);
}

export async function loadSettings(): Promise<Settings> {
  if (!isTauri()) return { ...DEFAULT_SETTINGS };
  const saved = await (await store()).get<Partial<Settings>>("settings");
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (!isTauri()) return;
  const localStore = await store();
  await localStore.set("settings", settings);
  await localStore.save();
}

let mockRecents: RecentBundle[] | null = null;

async function readRecents(): Promise<RecentBundle[]> {
  if (!isTauri()) {
    return (mockRecents ??= MOCK_RECENTS.map((entry) => ({ ...entry })));
  }
  return (await (await store()).get<RecentBundle[]>(RECENTS_KEY)) ?? [];
}

async function writeRecents(next: RecentBundle[]): Promise<void> {
  if (!isTauri()) {
    mockRecents = next;
    return;
  }
  const localStore = await store();
  await localStore.set(RECENTS_KEY, next);
  await localStore.save();
}

export async function recentBundles(): Promise<RecentBundle[]> {
  return readRecents();
}

function capRecents(list: RecentBundle[]): RecentBundle[] {
  let unpinned = 0;
  return list.filter((entry) => {
    if (entry.pinned === true) return true;
    unpinned += 1;
    return unpinned <= RECENTS_CAP;
  });
}

export async function pushRecentBundle(
  entry: Omit<RecentBundle, "ts" | "pinned">,
): Promise<RecentBundle[]> {
  const previous = await readRecents();
  const pinned = previous.find((candidate) => candidate.root === entry.root)?.pinned ?? false;
  const next = capRecents([
    { ...entry, ts: Date.now(), pinned },
    ...previous.filter((candidate) => candidate.root !== entry.root),
  ]);
  await writeRecents(next);
  return next;
}

export async function pinBundle(root: string): Promise<RecentBundle[]> {
  const next = (await readRecents()).map((entry) =>
    entry.root === root ? { ...entry, pinned: !entry.pinned } : entry
  );
  await writeRecents(next);
  return next;
}

export async function forgetBundle(root: string): Promise<RecentBundle[]> {
  const next = (await readRecents()).filter((entry) => entry.root !== root);
  await writeRecents(next);
  return next;
}

export interface BundleChanged {
  root: string;
  conceptIds: string[];
}

export async function startWatch(
  folder: string,
  onChanged: (event: BundleChanged) => void,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<BundleChanged>("bundle-changed", (event) =>
    onChanged(event.payload)
  );
  try {
    await invoke("start_watch", { folder });
  } catch (error) {
    unlisten();
    throw error;
  }
  return () => {
    unlisten();
    void invoke("stop_watch").catch(() => {
      // Best-effort cleanup while the window closes or switches bundles.
    });
  };
}

const initialReviewState = new Map(
  MOCK_BUNDLE.concepts.map((concept) => [
    concept.id,
    {
      status: concept.status,
      statusExplicit: concept.statusExplicit,
      verified: concept.verified.map((entry) => ({ ...entry })),
    },
  ]),
);

export function resetBrowserMockForTests(): void {
  mockRecents = null;
  quizMock.resetQuizMock();
  for (const concept of MOCK_BUNDLE.concepts) {
    const initial = initialReviewState.get(concept.id);
    if (!initial) continue;
    concept.status = initial.status;
    concept.statusExplicit = initial.statusExplicit;
    concept.verified = initial.verified.map((entry) => ({ ...entry }));
  }
}
