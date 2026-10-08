import type {
  QuizArtifact,
  QuizChoice,
  QuizCriticality,
  QuizQuestionCategory,
} from "@/features/quiz/schema.generated.ts";

export * from "@/features/quiz/schema.generated.ts";

export const OKF_QUIZ_TASK_ID = "okf-quiz" as const;

export type QuizScopeMode =
  | "current-document"
  | "selected-documents"
  | "topic"
  | "bundle-diff"
  | "reviewed-since-commit";

export type QuizDifficulty = "foundational" | "applied" | "challenging";
export type QuizLength = "short" | "medium" | "long";
export type QuizGenerationMode = "automatic" | "manual";
export type QuizQuestionCountPolicy = "automatic" | "exact";

export interface QuizGenerationConfig {
  mode: QuizGenerationMode;
  length: QuizLength | null;
  difficulty: QuizDifficulty | null;
  maxQuestions: number;
}

export type QuizEvidenceVersion = "current" | "base";

export interface QuizEvidenceSource {
  sourceId: string;
  conceptId: string;
  path: string;
  title: string;
  type: string;
  version: QuizEvidenceVersion;
  contentHash: string;
  markdown: string;
}

export interface QuizGenerationRequest {
  requestId: string;
  bundleFingerprint: string;
  scopeFingerprint: string;
  scopeMode: QuizScopeMode;
  questionCountPolicy: QuizQuestionCountPolicy;
  requestedQuestionCount: number;
  requestedDifficulty: QuizDifficulty | null;
  evidenceSources: QuizEvidenceSource[];
  scopeSourceIds: string[];
  topic: string | null;
  baseRevisionId: string | null;
  headRevisionId: string | null;
}

export type QuizNetworkPolicy = "provider-transport-only";

export interface QuizTaskDefinition {
  schemaVersion: 1;
  id: typeof OKF_QUIZ_TASK_ID;
  title: string;
  capabilityId: typeof OKF_QUIZ_TASK_ID;
  skillResourceId: "okf-quiz-instructions";
  artifactSchemaId: "okf-quiz-v1";
  readOnly: true;
  providerIndependent: true;
  usesFrozenEvidencePacket: true;
  allowsBundleChanges: false;
  allowsSettingsMutation: false;
  allowedTools: ["repository-read", "git-read"];
  networkPolicy: QuizNetworkPolicy;
}

export interface QuizCapabilityResource {
  id: string;
  path: string;
  mediaType: string;
  sha256: string;
}

export interface QuizCapabilityRegistration {
  schemaVersion: 1;
  packId: typeof OKF_QUIZ_TASK_ID;
  packVersion: string;
  name: string;
  publisher: string;
  provenance: "built-in";
  manifestSha256: string;
  task: QuizTaskDefinition;
  resources: QuizCapabilityResource[];
}

export type QuizValidationIssueCode =
  | "invalid-request"
  | "output-too-large"
  | "malformed-json"
  | "duplicate-json-key"
  | "schema-violation"
  | "wrong-request-id"
  | "wrong-bundle-fingerprint"
  | "wrong-scope-fingerprint"
  | "duplicate-question-id"
  | "duplicate-choice-id"
  | "missing-correct-choice"
  | "duplicate-question-prompt"
  | "duplicate-choice-text"
  | "unknown-evidence-source"
  | "evidence-outside-scope"
  | "evidence-quote-not-found"
  | "critical-evidence-missing"
  | "excessive-question-count"
  | "unexpected-question-count"
  | "stale-bundle-fingerprint"
  | "stale-scope-fingerprint"
  | "stale-content-hash";

export interface QuizValidationIssue {
  code: QuizValidationIssueCode;
  message: string;
  questionId: string | null;
  sourceId: string | null;
}

export type QuizValidation =
  | { status: "no-output" }
  | { status: "invalid"; issues: QuizValidationIssue[] }
  | { status: "ready"; quiz: QuizArtifact }
  | { status: "insufficient-evidence"; result: QuizArtifact }
  | { status: "stale"; issues: QuizValidationIssue[] };

export interface QuizObservedSource {
  sourceId: string;
  contentHash: string;
}

export interface QuizObservedState {
  bundleFingerprint: string;
  scopeFingerprint: string;
  sources: QuizObservedSource[];
}

export interface QuizValidationInput {
  request: QuizGenerationRequest;
  currentState: QuizObservedState;
  rawOutput: string | null;
}

export type QuizProviderKind = "codex-cli" | "claude-cli" | "model-api";
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface QuizProviderProfile {
  id: string;
  kind: QuizProviderKind;
  label: string;
  model: string | null;
  endpoint: string | null;
  executablePath: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  sendsContentOffDevice: boolean;
}

export interface CliDiagnostic {
  testedAt: string;
  available: boolean;
  authenticationRequired: boolean;
  executable: string | null;
  version: string | null;
  message: string;
  live: boolean;
}

export interface CliGeneratorSettings {
  enabled: boolean;
  executablePath: string | null;
  model: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  lastDiagnostic: CliDiagnostic | null;
}

export interface QuizGeneratorSettings {
  schemaVersion: 2;
  revision: string;
  defaultProfileId: string | null;
  codexCli: CliGeneratorSettings;
  claudeCli: CliGeneratorSettings;
  apiProfiles: QuizProviderProfile[];
}

export interface SaveQuizGeneratorSettingsInput {
  expectedRevision: string;
  defaultProfileId: string | null;
  codexCli: CliGeneratorSettings;
  claudeCli: CliGeneratorSettings;
}

export interface SaveQuizApiProfileInput {
  id: string | null;
  label: string;
  endpoint: string;
  model: string;
  apiKey: string | null;
}

export interface QuizScopeSourcePreview {
  sourceId: string;
  conceptId: string;
  path: string;
  title: string;
  type: string;
  version: QuizEvidenceVersion;
  contentHash: string;
  bytes: number;
  reason: string;
}

export interface QuizScopePreview {
  requestId: string;
  bundleName: string;
  bundleFingerprint: string;
  scopeFingerprint: string;
  scopeMode: QuizScopeMode;
  scopeDescription: string;
  sources: QuizScopeSourcePreview[];
  omittedDocuments: string[];
  totalEvidenceBytes: number;
  bundleContextDocuments: number;
  bundleContextBytes: number;
  bundleRevision: string;
  repositoryRoot: string | null;
  generation: QuizGenerationConfig;
}

export interface QuizPromptPreview {
  providerKind: QuizProviderKind;
  prompt: string | null;
  systemPrompt: string | null;
  userPrompt: string | null;
  workingDirectory: string | null;
}

export interface PrepareQuizScopeInput {
  bundleRoot: string;
  scopeMode: QuizScopeMode;
  conceptIds: string[];
  topic: string | null;
  baseRevisionId: string | null;
  headRevisionId: string | null;
  generation: QuizGenerationConfig;
}

export interface TopicCandidate {
  conceptId: string;
  title: string;
  path: string;
  type: string;
  tags: string[];
  contentHash: string;
  bytes: number;
  score: number;
  reason: string;
}

export interface GitQuizAvailability {
  available: boolean;
  repositoryRoot: string | null;
  headRevision: string | null;
  message: string;
}

export interface GitRevision {
  id: string;
  shortId: string;
  subject: string;
  timestamp: number;
}

export interface ProviderPreflight {
  profile: QuizProviderProfile;
  available: boolean;
  authenticationRequired: boolean;
  message: string;
  structuredOutput: boolean;
  executable: string | null;
  version: string | null;
  authenticationGuidance: ProviderAuthenticationGuidance | null;
  testedAt: string;
  live: boolean;
}

export interface ProviderAuthenticationGuidance {
  resolvedDisplayPath: string;
  loginCommand: string;
  deviceCodeLoginCommand: string | null;
  statusCommand: string;
}

export type ProviderLoginMode = "browser" | "device-code" | "terminal";

export interface ProviderLoginResult {
  authenticated: boolean;
  cancelled: boolean;
  message: string;
}

export type QuizGenerationState =
  | "generating"
  | "validating"
  | "ready"
  | "authentication-required"
  | "insufficient-evidence"
  | "invalid-output"
  | "provider-error"
  | "cancelled"
  | "stale";

export interface QuizGenerationProgress {
  requestId: string;
  state: QuizGenerationState;
  message: string;
}

export interface QuizGenerationOutcome {
  requestId: string;
  state: QuizGenerationState;
  quizId: string | null;
  failureId: string | null;
  warnings: string[];
  issues: QuizValidationIssue[];
  message: string;
}

export type QuizGenerationFailureKind =
  | "provider-error"
  | "invalid-output"
  | "insufficient-evidence"
  | "stale";

export interface QuizGenerationFailureSummary {
  failureId: string;
  scopeMode: QuizScopeMode;
  scopeDescription: string;
  providerKind: QuizProviderKind;
  providerProfile: string;
  model: string | null;
  failedAt: string;
  failureKind: QuizGenerationFailureKind;
  message: string;
  retryCount: number;
  generation: QuizGenerationConfig;
}

export interface QuizSummary {
  quizId: string;
  title: string;
  scopeMode: QuizScopeMode;
  scopeDescription: string;
  providerKind: QuizProviderKind;
  providerProfile: string;
  model: string | null;
  generatedAt: string;
  questionCount: number;
  attemptCount: number;
  latestScore: number | null;
  latestTotal: number | null;
  stale: boolean;
  staleReason: string | null;
}

export interface QuizAttemptSummary {
  attemptId: string;
  quizId: string;
  startedAt: string;
  completedAt: string | null;
  answered: number;
  excluded: number;
  total: number;
  correct: number;
}

export interface PublicQuizQuestion {
  attemptId: string;
  quizId: string;
  questionId: string;
  index: number;
  total: number;
  category: QuizQuestionCategory;
  criticality: QuizCriticality;
  prompt: string;
  choices: QuizChoice[];
  alreadyAnswered: boolean;
}

export interface QuizAttemptView {
  summary: QuizAttemptSummary;
  nextQuestion: PublicQuizQuestion | null;
  stale: boolean;
  staleReason: string | null;
}

export interface SubmitQuizAnswerInput {
  bundleRoot: string;
  attemptId: string;
  questionId: string;
  selectedChoiceId: string;
}

export interface MarkQuizQuestionNotImportantInput {
  bundleRoot: string;
  attemptId: string;
  questionId: string;
}

export interface ResolvedQuizEvidence {
  sourceId: string;
  conceptId: string;
  title: string;
  path: string;
  version: QuizEvidenceVersion;
  heading: string;
  quote: string;
}

export interface QuizAnswerReveal {
  attemptId: string;
  questionId: string;
  selectedChoiceId: string;
  correct: boolean;
  correctChoiceId: string;
  explanation: string;
  evidence: ResolvedQuizEvidence[];
  completed: boolean;
}

export interface QuizCategoryResult {
  category: QuizQuestionCategory;
  correct: number;
  total: number;
}

export interface QuizIncorrectAnswer {
  questionId: string;
  prompt: string;
  selectedChoiceId: string;
  correctChoiceId: string;
  explanation: string;
  evidence: ResolvedQuizEvidence[];
}

export interface QuizExcludedQuestion {
  questionId: string;
  prompt: string;
  category: QuizQuestionCategory;
  criticality: QuizCriticality;
}

export interface QuizResults {
  attemptId: string;
  quizId: string;
  title: string;
  correct: number;
  total: number;
  criticalCorrect: number;
  criticalTotal: number;
  criticalGap: boolean;
  stale: boolean;
  staleReason: string | null;
  completedAt: string | null;
  byCategory: QuizCategoryResult[];
  incorrectAnswers: QuizIncorrectAnswer[];
  excludedQuestions: QuizExcludedQuestion[];
}
