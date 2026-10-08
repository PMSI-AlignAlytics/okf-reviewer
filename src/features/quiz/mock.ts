import { MOCK_BUNDLE } from "@/mock/fixture.ts";
import type {
  GitQuizAvailability,
  GitRevision,
  MarkQuizQuestionNotImportantInput,
  PrepareQuizScopeInput,
  ProviderLoginMode,
  ProviderLoginResult,
  ProviderPreflight,
  PublicQuizQuestion,
  QuizAnswerReveal,
  QuizAttemptSummary,
  QuizAttemptView,
  QuizGenerationOutcome,
  QuizGenerationFailureSummary,
  QuizGeneratorSettings,
  QuizProviderProfile,
  QuizPromptPreview,
  QuizResults,
  QuizScopePreview,
  QuizScopeSourcePreview,
  QuizSummary,
  SaveQuizApiProfileInput,
  SaveQuizGeneratorSettingsInput,
  SubmitQuizAnswerInput,
  TopicCandidate,
} from "./types.ts";

interface MockQuestion {
  publicQuestion: Omit<PublicQuizQuestion, "attemptId" | "quizId" | "index" | "total" | "alreadyAnswered">;
  correctChoiceId: string;
  explanation: string;
  evidence: QuizAnswerReveal["evidence"];
}

interface MockQuiz {
  summary: QuizSummary;
  questions: MockQuestion[];
  preview: QuizScopePreview;
  input: PrepareQuizScopeInput;
}

interface MockGenerationFailure {
  summary: QuizGenerationFailureSummary;
  input: PrepareQuizScopeInput;
}

interface MockAttempt {
  attemptId: string;
  quizId: string;
  startedAt: string;
  completedAt: string | null;
  answers: Map<string, { selectedChoiceId: string; correct: boolean }>;
  notImportant: Set<string>;
}

const builtinProfiles: QuizProviderProfile[] = [
  {
    id: "codex-cli",
    kind: "codex-cli",
    label: "Codex CLI",
    model: "gpt-5.6-sol",
    endpoint: null,
    executablePath: null,
    reasoningEffort: "high",
    sendsContentOffDevice: true,
  },
  {
    id: "claude-cli",
    kind: "claude-cli",
    label: "Claude Code CLI",
    model: null,
    endpoint: null,
    executablePath: null,
    reasoningEffort: null,
    sendsContentOffDevice: true,
  },
];

let profiles = [...builtinProfiles];
let generatorSettings: QuizGeneratorSettings = {
  schemaVersion: 2,
  revision: "settings-mock-1",
  defaultProfileId: "codex-cli",
  codexCli: {
    enabled: true,
    executablePath: null,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    lastDiagnostic: null,
  },
  claudeCli: {
    enabled: true,
    executablePath: null,
    model: null,
    reasoningEffort: null,
    lastDiagnostic: null,
  },
  apiProfiles: [],
};
let frozen = new Map<string, {
  preview: QuizScopePreview;
  input: PrepareQuizScopeInput;
  retryFailureId: string | null;
}>();
let quizzes: MockQuiz[] = [];
let generationFailures: MockGenerationFailure[] = [];
let attempts: MockAttempt[] = [];
let sequence = 0;

function id(prefix: string): string {
  sequence += 1;
  return `${prefix}-mock-${sequence}`;
}

function hash(value: string): string {
  let result = 2_166_136_261;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16_777_619);
  }
  return Math.abs(result >>> 0).toString(16).padStart(8, "0");
}

function selectedConcepts(input: PrepareQuizScopeInput) {
  const requested = new Set(input.conceptIds);
  return MOCK_BUNDLE.concepts.filter((concept) => requested.has(concept.id));
}

export function mockTopicCandidates(topic: string): TopicCandidate[] {
  const terms = topic.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return MOCK_BUNDLE.concepts
    .map((concept) => {
      const title = concept.title.toLocaleLowerCase();
      const description = concept.description.toLocaleLowerCase();
      const tags = concept.tags.join(" ").toLocaleLowerCase();
      const body = concept.body.toLocaleLowerCase();
      let score = 0;
      const reasons = new Set<string>();
      for (const term of terms) {
        if (title.includes(term)) {
          score += 12;
          reasons.add("title");
        }
        if (description.includes(term)) {
          score += 8;
          reasons.add("description");
        }
        if (tags.includes(term)) {
          score += 6;
          reasons.add("tags");
        }
        if (body.includes(term)) {
          score += 2;
          reasons.add("body");
        }
      }
      return {
        conceptId: concept.id,
        title: concept.title,
        path: `${concept.id}.md`,
        type: concept.type,
        tags: concept.tags,
        contentHash: hash(concept.body),
        bytes: new TextEncoder().encode(concept.body).length,
        score,
        reason: `Matched ${[...reasons].join(", ")}`,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, 50);
}

export function mockPrepareScope(input: PrepareQuizScopeInput): QuizScopePreview {
  if (!Number.isInteger(input.generation.maxQuestions) || input.generation.maxQuestions < 1 || input.generation.maxQuestions > 20) {
    throw new Error("Maximum questions must be between 1 and 20.");
  }
  if (input.scopeMode === "bundle-diff" || input.scopeMode === "reviewed-since-commit") {
    throw new Error("Git-backed quizzes require the desktop Git integration.");
  }
  const concepts = selectedConcepts(input);
  if (concepts.length === 0) throw new Error("Select at least one document.");
  if (concepts.length > 32) throw new Error("Select at most 32 documents.");
  const sources: QuizScopeSourcePreview[] = concepts.map((concept, index) => ({
    sourceId: `source-${index + 1}`,
    conceptId: concept.id,
    path: `${concept.id}.md`,
    title: concept.title,
    type: concept.type,
    version: "current",
    contentHash: hash(concept.body),
    bytes: new TextEncoder().encode(concept.body).length,
    reason: input.scopeMode === "topic" ? "Selected after local topic retrieval" : "Selected by user",
  }));
  const totalEvidenceBytes = sources.reduce((total, source) => total + source.bytes, 0);
  const bundleContextBytes = MOCK_BUNDLE.concepts.reduce(
    (total, concept) => total + new TextEncoder().encode(concept.body).length,
    0,
  );
  if (totalEvidenceBytes > 1024 * 1024) {
    throw new Error("The selected evidence exceeds the 1 MiB context limit.");
  }
  const requestId = id("quiz-request");
  const scopeDescription = input.scopeMode === "current-document"
    ? `Current document: ${sources[0].title}`
    : input.scopeMode === "topic"
      ? `Topic “${input.topic ?? ""}” across ${sources.length} reviewed documents`
      : `${sources.length} selected documents`;
  const preview: QuizScopePreview = {
    requestId,
    bundleName: MOCK_BUNDLE.name,
    bundleFingerprint: hash(MOCK_BUNDLE.concepts.map((concept) => concept.body).join("\n")),
    scopeFingerprint: hash(JSON.stringify({ input, sources })),
    scopeMode: input.scopeMode,
    scopeDescription,
    sources,
    omittedDocuments: [],
    totalEvidenceBytes,
    bundleContextDocuments: MOCK_BUNDLE.concepts.length + 1,
    bundleContextBytes,
    bundleRevision: "Browser fixture",
    repositoryRoot: "C:\\mock-repository",
    generation: structuredClone(input.generation),
  };
  frozen.set(requestId, { preview, input: structuredClone(input), retryFailureId: null });
  return structuredClone(preview);
}

export function mockProfiles(): QuizProviderProfile[] {
  return structuredClone(profiles);
}

export function mockGeneratorSettings(): QuizGeneratorSettings {
  return structuredClone(generatorSettings);
}

export function mockSaveGeneratorSettings(
  input: SaveQuizGeneratorSettingsInput,
): QuizGeneratorSettings {
  if (input.expectedRevision !== generatorSettings.revision) {
    throw new Error("Generator settings changed outside this window. Reload Settings and try again.");
  }
  generatorSettings = {
    ...generatorSettings,
    revision: `settings-mock-${++sequence}`,
    defaultProfileId: input.defaultProfileId,
    codexCli: structuredClone(input.codexCli),
    claudeCli: structuredClone(input.claudeCli),
  };
  profiles = [
    ...(input.codexCli.enabled ? [{
      ...builtinProfiles[0],
      model: input.codexCli.model,
      executablePath: input.codexCli.executablePath,
      reasoningEffort: input.codexCli.reasoningEffort,
    }] : []),
    ...(input.claudeCli.enabled ? [{
      ...builtinProfiles[1],
      model: input.claudeCli.model,
      executablePath: input.claudeCli.executablePath,
      reasoningEffort: null,
    }] : []),
    ...generatorSettings.apiProfiles,
  ];
  return structuredClone(generatorSettings);
}

export function mockSaveProfile(input: SaveQuizApiProfileInput): QuizProviderProfile {
  const profile: QuizProviderProfile = {
    id: input.id ?? id("api"),
    kind: "model-api",
    label: input.label.trim(),
    endpoint: input.endpoint.trim(),
    executablePath: null,
    model: input.model.trim(),
    reasoningEffort: null,
    sendsContentOffDevice: !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/u.test(input.endpoint),
  };
  profiles = [...profiles.filter((candidate) => candidate.id !== profile.id), profile];
  generatorSettings = {
    ...generatorSettings,
    revision: `settings-mock-${++sequence}`,
    apiProfiles: [...generatorSettings.apiProfiles.filter((candidate) => candidate.id !== profile.id), profile],
  };
  return structuredClone(profile);
}

export function mockDeleteProfile(profileId: string): void {
  profiles = profiles.filter((profile) => profile.id !== profileId || profile.kind !== "model-api");
  generatorSettings = {
    ...generatorSettings,
    revision: `settings-mock-${++sequence}`,
    apiProfiles: generatorSettings.apiProfiles.filter((profile) => profile.id !== profileId),
  };
}

export function mockPreflight(profileId: string, live = false): ProviderPreflight {
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error("Provider profile not found.");
  const result: ProviderPreflight = {
    profile: structuredClone(profile),
    available: true,
    authenticationRequired: false,
    message: "Browser fixture provider is ready.",
    structuredOutput: true,
    executable: profile.executablePath ?? "mock-provider",
    version: "mock 1.0.0",
    authenticationGuidance: profile.kind === "codex-cli"
      ? {
          resolvedDisplayPath: profile.executablePath ?? "mock-provider",
          loginCommand: "codex login",
          deviceCodeLoginCommand: "codex login --device-auth",
          statusCommand: "codex login status",
        }
      : null,
    testedAt: new Date().toISOString(),
    live,
  };
  const diagnostic = {
    testedAt: result.testedAt,
    available: result.available,
    authenticationRequired: result.authenticationRequired,
    executable: result.executable,
    version: result.version,
    message: result.message,
    live,
  };
  generatorSettings = {
    ...generatorSettings,
    revision: `settings-mock-${++sequence}`,
    ...(profileId === "codex-cli"
      ? { codexCli: { ...generatorSettings.codexCli, lastDiagnostic: diagnostic } }
      : profileId === "claude-cli"
        ? { claudeCli: { ...generatorSettings.claudeCli, lastDiagnostic: diagnostic } }
        : {}),
  };
  return result;
}

export function mockProviderLogin(
  profileId: string,
  mode: ProviderLoginMode,
): ProviderLoginResult {
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile || profile.kind === "model-api") {
    throw new Error("Interactive sign-in is available only for CLI profiles.");
  }
  if (
    (profile.kind === "codex-cli" && mode === "terminal")
    || (profile.kind === "claude-cli" && mode === "device-code")
  ) throw new Error("That sign-in mode is unavailable for this CLI profile.");
  return {
    authenticated: true,
    cancelled: false,
    message: `Browser fixture ${profile.label} sign-in completed.`,
  };
}

function evidenceLine(conceptId: string): string {
  const concept = MOCK_BUNDLE.concepts.find((candidate) => candidate.id === conceptId);
  return concept?.body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 12 && !line.startsWith("#")) ??
    concept?.description ??
    "The selected bundle documents this behaviour.";
}

export async function mockGenerate(
  requestId: string,
  profileId: string,
): Promise<QuizGenerationOutcome> {
  const packet = frozen.get(requestId);
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!packet || !profile) throw new Error("The frozen request or provider is unavailable.");
  await Promise.resolve();
  const bytesPerQuestion = packet.input.generation.mode === "automatic"
    ? 2048
    : ({ short: 3072, medium: 2048, long: 1536 } as const)[
        packet.input.generation.length ?? "medium"
      ];
  const questions = Array.from(
    {
      length: Math.min(
        packet.input.generation.maxQuestions,
        Math.max(1, Math.ceil(
          packet.preview.totalEvidenceBytes / bytesPerQuestion,
        )),
      ),
    },
    (_, index): MockQuestion => {
      const source = packet.preview.sources[index % packet.preview.sources.length];
      const quote = evidenceLine(source.conceptId);
      return {
        publicQuestion: {
          questionId: `Q${index + 1}`,
          category: packet.input.scopeMode === "bundle-diff" ? "change" : "architecture",
          criticality: index === 0 ? "critical" : "important",
          prompt: `Which statement is documented in “${source.title}”? (${index + 1})`,
          choices: [
            { id: "A", text: quote },
            { id: "B", text: "The provider may expand the scope after generation starts." },
            { id: "C", text: "The opened bundle is updated with quiz history." },
          ],
        },
        correctChoiceId: "A",
        explanation: `The accepted answer is quoted directly from “${source.title}”.`,
        evidence: [{
          sourceId: source.sourceId,
          conceptId: source.conceptId,
          title: source.title,
          path: source.path,
          version: "current",
          heading: source.title,
          quote,
        }],
      };
    },
  );
  const quizId = id("quiz");
  quizzes.unshift({
    summary: {
      quizId,
      title: `${packet.preview.bundleName} knowledge quiz`,
      scopeMode: packet.preview.scopeMode,
      scopeDescription: packet.preview.scopeDescription,
      providerKind: profile.kind,
      providerProfile: profile.id,
      model: profile.model,
      generatedAt: new Date().toISOString(),
      questionCount: questions.length,
      attemptCount: 0,
      latestScore: null,
      latestTotal: null,
      stale: false,
      staleReason: null,
    },
    questions,
    preview: structuredClone(packet.preview),
    input: structuredClone(packet.input),
  });
  if (packet.retryFailureId) {
    generationFailures = generationFailures.filter(
      (failure) => failure.summary.failureId !== packet.retryFailureId,
    );
  }
  frozen.delete(requestId);
  return {
    requestId,
    state: "ready",
    quizId,
    failureId: null,
    warnings: [],
    issues: [],
    message: "Quiz generated and validated by the browser fixture.",
  };
}

export function mockPromptPreview(profileId: string): QuizPromptPreview {
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error("Provider profile not found.");
  const prompt = "Generate an OKF quiz from the frozen evidence. Inspect Git read-only and do not modify repository state.";
  return profile.kind === "model-api"
    ? {
        providerKind: profile.kind,
        prompt: null,
        systemPrompt: "Application-owned OKF quiz instructions.",
        userPrompt: prompt,
        workingDirectory: null,
      }
    : {
        providerKind: profile.kind,
        prompt,
        systemPrompt: null,
        userPrompt: null,
        workingDirectory: "C:\\mock-repository",
      };
}

export function mockListQuizzes(): QuizSummary[] {
  return structuredClone(quizzes.map((quiz) => quiz.summary));
}

export function mockListGenerationFailures(): QuizGenerationFailureSummary[] {
  return structuredClone(generationFailures.map((failure) => failure.summary));
}

export function mockPrepareRegeneration(quizId: string): QuizScopePreview {
  const quiz = quizzes.find((candidate) => candidate.summary.quizId === quizId);
  if (!quiz) throw new Error("Quiz not found.");
  return mockPrepareScope({
    ...structuredClone(quiz.input),
    conceptIds: quiz.preview.sources
      .filter((source) => source.version === "current")
      .map((source) => source.conceptId),
  });
}

export function mockPrepareFailureRetry(failureId: string): QuizScopePreview {
  const failure = generationFailures.find((candidate) => candidate.summary.failureId === failureId);
  if (!failure) throw new Error("Failed quiz generation not found.");
  const preview = mockPrepareScope(structuredClone(failure.input));
  const packet = frozen.get(preview.requestId);
  if (packet) packet.retryFailureId = failureId;
  return preview;
}

function attemptSummary(attempt: MockAttempt, quiz: MockQuiz): QuizAttemptSummary {
  return {
    attemptId: attempt.attemptId,
    quizId: attempt.quizId,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    answered: attempt.answers.size,
    excluded: attempt.notImportant.size,
    total: quiz.questions.length,
    correct: [...attempt.answers.values()].filter((answer) => answer.correct).length,
  };
}

function attemptView(attempt: MockAttempt, quiz: MockQuiz): QuizAttemptView {
  const index = quiz.questions.findIndex(
    (question) =>
      !attempt.answers.has(question.publicQuestion.questionId)
      && !attempt.notImportant.has(question.publicQuestion.questionId),
  );
  const question = index >= 0 ? quiz.questions[index] : null;
  return {
    summary: attemptSummary(attempt, quiz),
    stale: quiz.summary.stale,
    staleReason: quiz.summary.staleReason,
    nextQuestion: question
      ? {
          ...structuredClone(question.publicQuestion),
          attemptId: attempt.attemptId,
          quizId: quiz.summary.quizId,
          index,
          total: quiz.questions.length,
          alreadyAnswered: false,
        }
      : null,
  };
}

export function mockStartAttempt(quizId: string): QuizAttemptView {
  const quiz = quizzes.find((candidate) => candidate.summary.quizId === quizId);
  if (!quiz) throw new Error("Quiz not found.");
  const attempt: MockAttempt = {
    attemptId: id("attempt"),
    quizId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    answers: new Map(),
    notImportant: new Set(),
  };
  attempts.push(attempt);
  quiz.summary.attemptCount += 1;
  return attemptView(attempt, quiz);
}

export function mockResumeAttempt(attemptId: string): QuizAttemptView {
  const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
  const quiz = attempt && quizzes.find((candidate) => candidate.summary.quizId === attempt.quizId);
  if (!attempt || !quiz) throw new Error("Quiz attempt not found.");
  return attemptView(attempt, quiz);
}

export function mockListAttempts(quizId: string): QuizAttemptSummary[] {
  const quiz = quizzes.find((candidate) => candidate.summary.quizId === quizId);
  if (!quiz) throw new Error("Quiz not found.");
  return attempts
    .filter((attempt) => attempt.quizId === quizId)
    .map((attempt) => attemptSummary(attempt, quiz));
}

export function mockSubmitAnswer(input: SubmitQuizAnswerInput): QuizAnswerReveal {
  const attempt = attempts.find((candidate) => candidate.attemptId === input.attemptId);
  const quiz = attempt && quizzes.find((candidate) => candidate.summary.quizId === attempt.quizId);
  const question = quiz?.questions.find(
    (candidate) => candidate.publicQuestion.questionId === input.questionId,
  );
  if (!attempt || !quiz || !question) throw new Error("Quiz question not found.");
  if (attempt.answers.has(input.questionId)) throw new Error("That answer is already locked.");
  if (!question.publicQuestion.choices.some((choice) => choice.id === input.selectedChoiceId)) {
    throw new Error("Select one of the available choices.");
  }
  const correct = input.selectedChoiceId === question.correctChoiceId;
  attempt.answers.set(input.questionId, { selectedChoiceId: input.selectedChoiceId, correct });
  const completed = attempt.answers.size + attempt.notImportant.size === quiz.questions.length;
  if (completed) attempt.completedAt = new Date().toISOString();
  quiz.summary.latestScore = [...attempt.answers.values()].filter((answer) => answer.correct).length;
  quiz.summary.latestTotal = attempt.answers.size;
  return {
    attemptId: attempt.attemptId,
    questionId: input.questionId,
    selectedChoiceId: input.selectedChoiceId,
    correct,
    correctChoiceId: question.correctChoiceId,
    explanation: question.explanation,
    evidence: structuredClone(question.evidence),
    completed,
  };
}

export function mockMarkNotImportant(
  input: MarkQuizQuestionNotImportantInput,
): QuizAttemptView {
  const attempt = attempts.find((candidate) => candidate.attemptId === input.attemptId);
  const quiz = attempt && quizzes.find((candidate) => candidate.summary.quizId === attempt.quizId);
  if (!attempt || !quiz) throw new Error("Quiz question not found.");
  const current = attemptView(attempt, quiz).nextQuestion;
  if (current?.questionId !== input.questionId) {
    throw new Error("Questions must be handled in quiz order.");
  }
  attempt.notImportant.add(input.questionId);
  if (attempt.answers.size + attempt.notImportant.size === quiz.questions.length) {
    attempt.completedAt = new Date().toISOString();
  }
  quiz.summary.latestScore = [...attempt.answers.values()].filter((answer) => answer.correct).length;
  quiz.summary.latestTotal = attempt.answers.size;
  return attemptView(attempt, quiz);
}

export function mockResults(attemptId: string): QuizResults {
  const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
  const quiz = attempt && quizzes.find((candidate) => candidate.summary.quizId === attempt.quizId);
  if (!attempt || !quiz) throw new Error("Quiz attempt not found.");
  const answered = quiz.questions.filter((question) =>
    attempt.answers.has(question.publicQuestion.questionId)
  );
  const critical = answered.filter(
    (question) => question.publicQuestion.criticality === "critical",
  );
  const criticalCorrect = critical.filter(
    (question) => attempt.answers.get(question.publicQuestion.questionId)?.correct,
  ).length;
  const correct = [...attempt.answers.values()].filter((answer) => answer.correct).length;
  const categories = new Map<string, { correct: number; total: number }>();
  for (const question of answered) {
    const category = question.publicQuestion.category;
    const result = categories.get(category) ?? { correct: 0, total: 0 };
    result.total += 1;
    if (attempt.answers.get(question.publicQuestion.questionId)?.correct) result.correct += 1;
    categories.set(category, result);
  }
  return {
    attemptId,
    quizId: quiz.summary.quizId,
    title: quiz.summary.title,
    correct,
    total: answered.length,
    criticalCorrect,
    criticalTotal: critical.length,
    criticalGap: criticalCorrect < critical.length,
    stale: quiz.summary.stale,
    staleReason: quiz.summary.staleReason,
    completedAt: attempt.completedAt,
    byCategory: [...categories].map(([category, result]) => ({
      category: category as QuizResults["byCategory"][number]["category"],
      ...result,
    })),
    incorrectAnswers: answered
      .filter((question) => !attempt.answers.get(question.publicQuestion.questionId)?.correct)
      .map((question) => ({
        questionId: question.publicQuestion.questionId,
        prompt: question.publicQuestion.prompt,
        selectedChoiceId: attempt.answers.get(question.publicQuestion.questionId)?.selectedChoiceId ?? "",
        correctChoiceId: question.correctChoiceId,
        explanation: question.explanation,
        evidence: structuredClone(question.evidence),
      })),
    excludedQuestions: quiz.questions
      .filter((question) => attempt.notImportant.has(question.publicQuestion.questionId))
      .map((question) => ({
        questionId: question.publicQuestion.questionId,
        prompt: question.publicQuestion.prompt,
        category: question.publicQuestion.category,
        criticality: question.publicQuestion.criticality,
      })),
  };
}

export function mockDeleteQuiz(quizId: string): void {
  quizzes = quizzes.filter((quiz) => quiz.summary.quizId !== quizId);
  attempts = attempts.filter((attempt) => attempt.quizId !== quizId);
}

export function mockDeleteGenerationFailure(failureId: string): void {
  generationFailures = generationFailures.filter(
    (failure) => failure.summary.failureId !== failureId,
  );
}

export function mockDeleteAttempt(attemptId: string): void {
  attempts = attempts.filter((attempt) => attempt.attemptId !== attemptId);
}

export function mockDeleteAll(): void {
  quizzes = [];
  attempts = [];
  generationFailures = [];
}

export function mockGitAvailability(): GitQuizAvailability {
  return {
    available: false,
    repositoryRoot: null,
    headRevision: null,
    message: "Git-backed quizzes are available in the desktop app when the bundle is in Git.",
  };
}

export function mockGitRevisions(): GitRevision[] {
  return [];
}

export function resetQuizMock(): void {
  profiles = [...builtinProfiles];
  frozen = new Map();
  quizzes = [];
  generationFailures = [];
  attempts = [];
  sequence = 0;
}
