import {
  AlertTriangle,
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  CircleX,
  Clipboard,
  Eye,
  History,
  LoaderCircle,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useApp } from "@/shared/store.tsx";
import * as ipc from "@/shared/ipc.ts";
import type { Concept } from "@/shared/types.ts";
import type {
  GitQuizAvailability,
  GitRevision,
  QuizAnswerReveal,
  QuizAttemptSummary,
  QuizAttemptView,
  QuizDifficulty,
  QuizGenerationConfig,
  QuizGenerationFailureSummary,
  QuizGeneratorSettings,
  QuizLength,
  QuizProviderProfile,
  QuizPromptPreview,
  QuizResults,
  QuizScopeMode,
  QuizScopePreview,
  QuizSummary,
  TopicCandidate,
} from "../types.ts";
import "@/shared/styles/baseui.css";
import "./QuizzesArea.css";

type AreaView = "home" | "generate" | "take" | "results";
type GenerateStage = "configure" | "confirmation" | "generating" | "failure";

const LENGTHS: { value: QuizLength; label: string; detail: string }[] = [
  { value: "short", label: "Short", detail: "A focused check" },
  { value: "medium", label: "Medium", detail: "Balanced coverage" },
  { value: "long", label: "Long", detail: "Broader coverage" },
];
const DIFFICULTIES: { value: QuizDifficulty; label: string; detail: string }[] = [
  { value: "foundational", label: "Foundational", detail: "Direct comprehension" },
  { value: "applied", label: "Applied", detail: "Scenarios and consequences" },
  { value: "challenging", label: "Challenging", detail: "Trade-offs and edge cases" },
];
const SCOPE_GROUPS = [
  {
    label: "Choose documents",
    options: [
      ["current-document", "Current document", "The concept open in the reader"],
      ["selected-documents", "Selected documents", "Choose the bundle concepts to include"],
      ["topic", "Topic in this bundle", "Find matching documents locally, then review the selection"],
    ],
  },
  {
    label: "Use repository history",
    options: [
      ["bundle-diff", "Bundle changes", "Concept changes since a Git revision"],
      ["reviewed-since-commit", "Reviewed since last commit", "Current content with human reviews added since the last commit"],
    ],
  },
] as const;
const DEFAULT_QUIZ_GENERATION: QuizGenerationConfig = {
  mode: "automatic",
  length: null,
  difficulty: null,
  maxQuestions: 20,
};
const DEFAULT_MANUAL_LENGTH: QuizLength = "medium";
const DEFAULT_MANUAL_DIFFICULTY: QuizDifficulty = "applied";
const CODEX_MODEL_CATALOG_INCOMPATIBLE_MESSAGE =
  "This Codex CLI cannot read the current Codex model catalog. Update or reinstall Codex CLI, or choose a compatible Codex executable in Generator settings, then retry.";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function conceptBytes(concept: Concept): number {
  return new TextEncoder().encode(concept.body).length;
}

function providerName(
  profiles: QuizProviderProfile[],
  profileId: string,
): string {
  return profiles.find((profile) => profile.id === profileId)?.label ?? profileId;
}

function failureMessageForDisplay(message: string): string {
  const diagnostic = message.toLowerCase();
  const isCodexModelCatalogIncompatibility =
    diagnostic.includes("unknown variant") &&
    diagnostic.includes("expected one of") &&
    diagnostic.includes("xhigh") &&
    (diagnostic.includes("codex_models_manager") ||
      diagnostic.includes("failed to load models cache") ||
      diagnostic.includes("failed to decode models response") ||
      diagnostic.includes("failed to refresh available models"));

  return isCodexModelCatalogIncompatibility
    ? CODEX_MODEL_CATALOG_INCOMPATIBLE_MESSAGE
    : message;
}

export function QuizzesArea() {
  const { state, actions } = useApp();
  const [view, setView] = useState<AreaView>(() => state.quizLaunch ? "generate" : "home");
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [generationFailures, setGenerationFailures] = useState<
    QuizGenerationFailureSummary[]
  >([]);
  const [profiles, setProfiles] = useState<QuizProviderProfile[]>([]);
  const [generatorSettings, setGeneratorSettings] = useState<QuizGeneratorSettings | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<QuizAttemptView | null>(null);
  const [reveal, setReveal] = useState<QuizAnswerReveal | null>(null);
  const [results, setResults] = useState<QuizResults | null>(null);
  const [historyQuiz, setHistoryQuiz] = useState<QuizSummary | null>(null);
  const [history, setHistory] = useState<QuizAttemptSummary[]>([]);
  const [regenerateQuiz, setRegenerateQuiz] = useState<QuizSummary | null>(null);
  const [regenerateFailure, setRegenerateFailure] = useState<
    QuizGenerationFailureSummary | null
  >(null);
  const [quickLaunch, setQuickLaunch] = useState(() => state.quizLaunch);
  const [quickLaunchId, setQuickLaunchId] = useState(0);
  const [quickOrigin, setQuickOrigin] = useState(() => quickLaunch !== null);
  const root = state.activeRoot;

  // A new launch is an explicit replacement for the generation form. Consume
  // it before rendering children so a preserved workspace starts it exactly once.
  if (state.quizLaunch && state.quizLaunch !== quickLaunch) {
    setQuickLaunch(state.quizLaunch);
    setQuickLaunchId((current) => current + 1);
    setQuickOrigin(true);
    setRegenerateQuiz(null);
    setRegenerateFailure(null);
    setView("generate");
  }

  const refresh = useCallback(async () => {
    if (!root) return;
    setBusy(true);
    setError(null);
    try {
      const [quizList, failureList, profileList, configuredGenerators] = await Promise.all([
        ipc.listQuizzes(root),
        ipc.listQuizGenerationFailures(root),
        ipc.quizProviderProfiles(),
        ipc.quizGeneratorSettings(),
      ]);
      setQuizzes(quizList);
      setGenerationFailures(failureList);
      setProfiles(profileList);
      setGeneratorSettings(configuredGenerators);
    } catch (problem) {
      setError(String(problem));
    }
    setBusy(false);
  }, [root]);

  useEffect(() => {
    if (state.workspaceArea === "quizzes") void Promise.resolve().then(refresh);
  }, [refresh, state.workspaceArea]);

  useEffect(() => {
    if (!state.quizLaunch) return;
    actions.clearQuizLaunch();
  }, [actions, state.quizLaunch]);

  async function start(quizId: string) {
    if (!root) return;
    setError(null);
    try {
      const next = await ipc.startQuizAttempt(root, quizId);
      setAttempt(next);
      setReveal(null);
      setResults(null);
      setView("take");
    } catch (problem) {
      setError(String(problem));
    }
  }

  async function resume(attemptId: string, completed: boolean) {
    if (!root) return;
    setError(null);
    try {
      if (completed) {
        setResults(await ipc.getQuizResults(root, attemptId));
        setView("results");
      } else {
        setAttempt(await ipc.resumeQuizAttempt(root, attemptId));
        setReveal(null);
        setView("take");
      }
    } catch (problem) {
      setError(String(problem));
    }
  }

  async function openHistory(quiz: QuizSummary) {
    if (!root) return;
    setHistoryQuiz(quiz);
    setHistory(await ipc.listQuizAttempts(root, quiz.quizId));
  }

  async function removeQuiz(quiz: QuizSummary) {
    if (!root || !window.confirm(`Delete “${quiz.title}” and all of its attempts?`)) return;
    await ipc.deleteQuiz(root, quiz.quizId);
    if (historyQuiz?.quizId === quiz.quizId) setHistoryQuiz(null);
    await refresh();
  }

  async function retryFailure(failure: QuizGenerationFailureSummary) {
    if (!root || state.quizGeneration) return;
    const profile = profiles.find((candidate) => candidate.id === failure.providerProfile);
    if (!profile) {
      setError("The saved quiz generator is no longer configured. Review the saved settings before retrying.");
      return;
    }
    setError(null);
    try {
      const preview = await ipc.prepareQuizFailureRetry(root, failure.failureId);
      const retryProfile = failure.model === null ? profile : { ...profile, model: failure.model };
      if (!actions.startQuizGeneration({ bundleRoot: root, preview, profile: retryProfile })) {
        setError("Another quiz is already being generated.");
      }
    } catch (problem) {
      setError(String(problem));
    }
  }

  async function removeFailure(failure: QuizGenerationFailureSummary) {
    if (!root || !window.confirm("Delete this failed quiz generation record?")) return;
    await ipc.deleteQuizGenerationFailure(root, failure.failureId);
    await refresh();
  }

  if (!root || !state.bundle) return null;

  return (
    <main className="quizzes-area">
      {view === "home" && (
        <QuizHome
          quizzes={quizzes}
          failures={generationFailures}
          profiles={profiles}
          generationInProgress={state.quizGeneration !== null}
          busy={busy}
          error={error}
          historyQuiz={historyQuiz}
          history={history}
          onGenerate={() => {
            setQuickLaunch(null);
            setQuickOrigin(false);
            setRegenerateQuiz(null);
            setRegenerateFailure(null);
            setView("generate");
          }}
          onStart={(quizId) => void start(quizId)}
          onHistory={(quiz) => void openHistory(quiz)}
          onResume={(attemptId, completed) => void resume(attemptId, completed)}
          onDelete={(quiz) => void removeQuiz(quiz)}
          onDeleteAttempt={(attemptId) => {
            void (async () => {
              if (!window.confirm("Delete this quiz attempt?")) return;
              await ipc.deleteQuizAttempt(root, attemptId);
              if (historyQuiz) await openHistory(historyQuiz);
              await refresh();
            })();
          }}
          onRegenerate={(quiz) => {
            setQuickLaunch(null);
            setQuickOrigin(false);
            setRegenerateQuiz(quiz);
            setRegenerateFailure(null);
            setView("generate");
          }}
          onRetryFailure={(failure) => void retryFailure(failure)}
          onReviewFailure={(failure) => {
            setQuickLaunch(null);
            setQuickOrigin(false);
            setRegenerateQuiz(null);
            setRegenerateFailure(failure);
            setView("generate");
          }}
          onDeleteFailure={(failure) => void removeFailure(failure)}
          onDeleteAll={() => {
            void (async () => {
              if (!window.confirm("Delete all quiz history for this bundle?")) return;
              await ipc.deleteBundleQuizHistory(root);
              setHistoryQuiz(null);
              await refresh();
            })();
          }}
        />
      )}
      {view === "generate" && (
        <GenerateQuiz
          key={quickLaunch ? `quick-${quickLaunchId}` : "configure"}
          bundle={state.bundle}
          root={root}
          activeConceptId={quickLaunch?.conceptId ?? state.activeConceptId}
          quickStart={quickLaunch !== null}
          providersReady={!busy}
          regenerateQuiz={regenerateQuiz}
          regenerateFailure={regenerateFailure}
          profiles={profiles}
          defaultProfileId={generatorSettings?.defaultProfileId ?? null}
          onGenerationStarted={() => {
            setQuickLaunch(null);
            setQuickOrigin(false);
            setView("home");
          }}
          onOpenGeneratorSettings={() => {
            window.dispatchEvent(new CustomEvent("okf-review:open-settings-section", {
              detail: "generators",
            }));
            actions.setSettingsOpen(true);
          }}
          onBack={() => {
            if (quickOrigin) {
              setQuickLaunch(null);
              setQuickOrigin(false);
              setView("home");
              actions.setWorkspaceArea("reader");
            } else {
              setView("home");
            }
          }}
        />
      )}
      {view === "take" && attempt && (
        <TakeQuiz
          key={attempt.nextQuestion?.questionId ?? attempt.summary.attemptId}
          root={root}
          attempt={attempt}
          reveal={reveal}
          onReveal={setReveal}
          onAttempt={setAttempt}
          onResults={(nextResults) => {
            setResults(nextResults);
            setView("results");
            void refresh();
          }}
          onExit={() => {
            setView("home");
            void refresh();
          }}
          onOpenEvidence={(conceptId) => {
            actions.selectConcept(conceptId);
          }}
        />
      )}
      {view === "results" && results && (
        <QuizResultsView
          results={results}
          onBack={() => {
            setView("home");
            void refresh();
          }}
          onRetake={() => void start(results.quizId)}
          onOpenEvidence={(conceptId) => actions.selectConcept(conceptId)}
        />
      )}
    </main>
  );
}

function QuizHome({
  quizzes,
  failures,
  profiles,
  generationInProgress,
  busy,
  error,
  historyQuiz,
  history,
  onGenerate,
  onStart,
  onHistory,
  onResume,
  onDelete,
  onDeleteAttempt,
  onRegenerate,
  onRetryFailure,
  onReviewFailure,
  onDeleteFailure,
  onDeleteAll,
}: {
  quizzes: QuizSummary[];
  failures: QuizGenerationFailureSummary[];
  profiles: QuizProviderProfile[];
  generationInProgress: boolean;
  busy: boolean;
  error: string | null;
  historyQuiz: QuizSummary | null;
  history: QuizAttemptSummary[];
  onGenerate: () => void;
  onStart: (quizId: string) => void;
  onHistory: (quiz: QuizSummary) => void;
  onResume: (attemptId: string, completed: boolean) => void;
  onDelete: (quiz: QuizSummary) => void;
  onDeleteAttempt: (attemptId: string) => void;
  onRegenerate: (quiz: QuizSummary) => void;
  onRetryFailure: (failure: QuizGenerationFailureSummary) => void;
  onReviewFailure: (failure: QuizGenerationFailureSummary) => void;
  onDeleteFailure: (failure: QuizGenerationFailureSummary) => void;
  onDeleteAll: () => void;
}) {
  return (
    <div className="quiz-page">
      <header className="quiz-page-header">
        <div>
          <p className="quiz-eyebrow">Knowledge checks</p>
          <h1>Quizzes</h1>
          <p>
            Test your understanding of what the active bundle documents. A result
            does not prove that the documented decision itself is correct. Quiz
            history stays in local app data for 30 days, including across reinstalls.
          </p>
        </div>
        <button
          type="button"
          className="quiz-primary"
          onClick={onGenerate}
          disabled={generationInProgress}
        >
          <Plus size={16} aria-hidden="true" /> Generate quiz
        </button>
      </header>

      {error && <p className="quiz-callout quiz-callout--error" role="alert">{error}</p>}
      {generationInProgress && (
        <p className="quiz-callout" role="status">
          <LoaderCircle size={17} className="quiz-spin" aria-hidden="true" />
          A quiz is being generated in the background. You can keep browsing while it finishes.
        </p>
      )}
      {busy && (
        <p className="quiz-loading" role="status">
          <LoaderCircle size={17} className="quiz-spin" aria-hidden="true" />
          Loading quiz history…
        </p>
      )}
      {!busy && quizzes.length === 0 && failures.length === 0 && (
        <section className="quiz-empty">
          <BrainCircuit size={30} aria-hidden="true" />
          <h2>No quizzes for this bundle yet</h2>
          <p>Generate one from the current document, a reviewed selection, a topic, or bundle changes.</p>
          <button
            type="button"
            className="quiz-primary"
            onClick={onGenerate}
            disabled={generationInProgress}
          >
            Generate your first quiz
          </button>
        </section>
      )}
      {(quizzes.length > 0 || failures.length > 0) && (
        <>
          <div className="quiz-section-heading">
            <h2>Bundle quiz history</h2>
            <button type="button" className="quiz-danger-link" onClick={onDeleteAll}>
              Delete all history
            </button>
          </div>
          <div className="quiz-history-grid">
            {failures.map((failure) => (
              <article
                className="quiz-history-card quiz-history-card--failed"
                key={failure.failureId}
              >
                <div className="quiz-card-title">
                  <div>
                    <div className="quiz-badges">
                      <span>{failure.scopeMode.replaceAll("-", " ")}</span>
                      <span className="quiz-failed">Generation failed</span>
                    </div>
                    <h3>Quiz generation failed</h3>
                  </div>
                  <button
                    type="button"
                    className="quiz-icon-button"
                    aria-label="Delete failed quiz generation"
                    onClick={() => onDeleteFailure(failure)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
                <p>{failure.scopeDescription}</p>
                <p className="quiz-failure-note">
                  <CircleX size={15} aria-hidden="true" />
                  <span>{failureMessageForDisplay(failure.message)}</span>
                </p>
                <dl className="quiz-card-meta">
                  <div>
                    <dt>Provider</dt>
                    <dd>{providerName(profiles, failure.providerProfile)}</dd>
                  </div>
                  <div><dt>Failed</dt><dd>{formatDate(failure.failedAt)}</dd></div>
                  <div>
                    <dt>Configuration</dt>
                    <dd>
                      {failure.generation.mode === "automatic"
                        ? `Automatic, up to ${failure.generation.maxQuestions} questions`
                        : `${failure.generation.length}, ${failure.generation.difficulty}, up to ${failure.generation.maxQuestions} questions`}
                    </dd>
                  </div>
                  <div>
                    <dt>Retries</dt>
                    <dd>{failure.retryCount}</dd>
                  </div>
                </dl>
                <div className="quiz-card-actions">
                  <button
                    type="button"
                    className="quiz-primary"
                    disabled={generationInProgress}
                    onClick={() => onRetryFailure(failure)}
                  >
                    <RotateCcw size={15} aria-hidden="true" /> Retry
                  </button>
                  <button
                    type="button"
                    className="quiz-secondary"
                    disabled={generationInProgress}
                    onClick={() => onReviewFailure(failure)}
                  >
                    Review settings
                  </button>
                </div>
              </article>
            ))}
            {quizzes.map((quiz) => (
              <article className="quiz-history-card" key={quiz.quizId}>
                <div className="quiz-card-title">
                  <div>
                    <div className="quiz-badges">
                      <span>{quiz.scopeMode.replaceAll("-", " ")}</span>
                      <span className={quiz.stale ? "quiz-stale" : "quiz-current"}>
                        {quiz.stale ? "Stale" : "Current"}
                      </span>
                    </div>
                    <h3>{quiz.title}</h3>
                  </div>
                  <button
                    type="button"
                    className="quiz-icon-button"
                    aria-label={`Delete ${quiz.title}`}
                    onClick={() => onDelete(quiz)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
                <p>{quiz.scopeDescription}</p>
                {quiz.stale && (
                  <p className="quiz-stale-note">
                    <AlertTriangle size={15} aria-hidden="true" />
                    {quiz.staleReason ?? "This quiz no longer represents current bundle knowledge."}
                  </p>
                )}
                <dl className="quiz-card-meta">
                  <div><dt>Provider</dt><dd>{providerName(profiles, quiz.providerProfile)}</dd></div>
                  <div><dt>Generated</dt><dd>{formatDate(quiz.generatedAt)}</dd></div>
                  <div><dt>Questions</dt><dd>{quiz.questionCount}</dd></div>
                  <div>
                    <dt>Latest</dt>
                    <dd>
                      {quiz.latestScore === null
                        ? "Not attempted"
                        : quiz.latestTotal === 0
                          ? "No scored questions"
                          : `${quiz.latestScore}/${quiz.latestTotal}`}
                    </dd>
                  </div>
                </dl>
                <div className="quiz-card-actions">
                  <button type="button" className="quiz-primary" onClick={() => onStart(quiz.quizId)}>
                    <RotateCcw size={15} aria-hidden="true" />
                    {quiz.attemptCount > 0 ? "Retake" : "Start quiz"}
                  </button>
                  <button type="button" className="quiz-secondary" onClick={() => onHistory(quiz)}>
                    <History size={15} aria-hidden="true" /> Attempts ({quiz.attemptCount})
                  </button>
                  {quiz.stale && (
                    <button
                      type="button"
                      className="quiz-secondary"
                      onClick={() => onRegenerate(quiz)}
                      disabled={generationInProgress}
                    >
                      Regenerate
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {historyQuiz && (
        <section className="quiz-attempt-history" aria-labelledby="attempt-history-title">
          <h2 id="attempt-history-title">Attempts for {historyQuiz.title}</h2>
          {history.length === 0 ? (
            <p>No attempts yet.</p>
          ) : (
            <ul>
              {history.map((attempt) => (
                <li key={attempt.attemptId}>
                  <div>
                    <strong>
                      {attempt.completedAt && attempt.answered === 0
                        ? "No scored questions"
                        : `${attempt.correct}/${attempt.answered} correct`}
                    </strong>
                    <span>{formatDate(attempt.startedAt)}</span>
                    {attempt.excluded > 0 && (
                      <span>{attempt.excluded} marked Not Important</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="quiz-secondary"
                    onClick={() => onResume(attempt.attemptId, attempt.completedAt !== null)}
                  >
                    {attempt.completedAt ? "Review results" : "Continue"}
                  </button>
                  <button
                    type="button"
                    className="quiz-icon-button"
                    aria-label={`Delete attempt from ${formatDate(attempt.startedAt)}`}
                    onClick={() => onDeleteAttempt(attempt.attemptId)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function GenerateQuiz({
  bundle,
  root,
  activeConceptId,
  quickStart,
  providersReady,
  regenerateQuiz,
  regenerateFailure,
  profiles,
  defaultProfileId,
  onGenerationStarted,
  onOpenGeneratorSettings,
  onBack,
}: {
  bundle: NonNullable<ReturnType<typeof useApp>["state"]["bundle"]>;
  root: string;
  activeConceptId: string | null;
  quickStart: boolean;
  providersReady: boolean;
  regenerateQuiz: QuizSummary | null;
  regenerateFailure: QuizGenerationFailureSummary | null;
  profiles: QuizProviderProfile[];
  defaultProfileId: string | null;
  onGenerationStarted: () => void;
  onOpenGeneratorSettings: () => void;
  onBack: () => void;
}) {
  const { state, actions } = useApp();
  const activeConcept = bundle.concepts.find((concept) => concept.id === activeConceptId);
  const [stage, setStage] = useState<GenerateStage>(
    () => quickStart ? "generating" : "configure",
  );
  const [scope, setScope] = useState<QuizScopeMode>(
    () => activeConcept ? "current-document" : "selected-documents",
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(activeConcept ? [activeConcept.id] : []),
  );
  const [topic, setTopic] = useState("");
  const [topicCandidates, setTopicCandidates] = useState<TopicCandidate[]>([]);
  const [topicSearched, setTopicSearched] = useState(false);
  const [documentQuery, setDocumentQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [manualOverride, setManualOverride] = useState(false);
  const [length, setLength] = useState<QuizLength>(DEFAULT_MANUAL_LENGTH);
  const [difficulty, setDifficulty] = useState<QuizDifficulty>(
    DEFAULT_MANUAL_DIFFICULTY,
  );
  const [maxQuestions, setMaxQuestions] = useState(DEFAULT_QUIZ_GENERATION.maxQuestions);
  const [profileId, setProfileId] = useState(
    profiles.some((profile) => profile.id === defaultProfileId)
      ? defaultProfileId ?? ""
      : profiles[0]?.id ?? "",
  );
  const [preview, setPreview] = useState<QuizScopePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [git, setGit] = useState<GitQuizAvailability | null>(null);
  const [revisions, setRevisions] = useState<GitRevision[]>([]);
  const [baseRevision, setBaseRevision] = useState("");
  const [promptPreview, setPromptPreview] = useState<QuizPromptPreview | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const promptTriggerRef = useRef<HTMLButtonElement>(null);
  const promptCloseRef = useRef<HTMLButtonElement>(null);
  const quickStarted = useRef(false);
  const retryInitialization = useRef<{
    targetKey: string;
    preparation: Promise<QuizScopePreview>;
    completed: boolean;
  } | null>(null);

  useEffect(() => {
    const retryTarget = regenerateFailure ?? regenerateQuiz;
    if (!retryTarget || !providersReady) return;
    const targetKey = JSON.stringify([
      root, regenerateFailure?.failureId ?? null, regenerateQuiz?.quizId ?? null,
    ]);
    let initialization = retryInitialization.current;
    if (initialization?.targetKey !== targetKey) {
      const preparation = regenerateFailure
        ? ipc.prepareQuizFailureRetry(root, regenerateFailure.failureId)
        : regenerateQuiz
          ? ipc.prepareQuizRegeneration(root, regenerateQuiz.quizId)
          : null;
      if (!preparation) return;
      initialization = { targetKey, preparation, completed: false };
      retryInitialization.current = initialization;
    }
    // A provider refresh must not replace an edited draft or prepare it again.
    if (initialization.completed) return;
    let active = true;
    void initialization.preparation
      .then((nextPreview) => {
        if (!active || initialization.completed) return;
        initialization.completed = true;
        const preferredProfile = profiles.some(
          (profile) => profile.id === retryTarget.providerProfile,
        )
          ? retryTarget.providerProfile
          : profiles[0]?.id ?? "";
        setProfileId(preferredProfile);
        setManualOverride(nextPreview.generation.mode === "manual");
        setLength(nextPreview.generation.length ?? DEFAULT_MANUAL_LENGTH);
        setDifficulty(nextPreview.generation.difficulty ?? DEFAULT_MANUAL_DIFFICULTY);
        setMaxQuestions(nextPreview.generation.maxQuestions);
        setPreview(nextPreview);
        setStage("confirmation");
      })
      .catch((problem: unknown) => {
        if (!active || initialization.completed) return;
        initialization.completed = true;
        setError(String(problem));
        setStage("failure");
      });
    return () => {
      active = false;
    };
  }, [profiles, providersReady, regenerateFailure, regenerateQuiz, root]);

  useEffect(() => {
    if (scope !== "bundle-diff" && scope !== "reviewed-since-commit") return;
    let active = true;
    void Promise.all([
      ipc.quizGitAvailability(root),
      scope === "bundle-diff" ? ipc.quizGitRevisions(root) : Promise.resolve([]),
    ])
      .then(([availability, history]) => {
        if (!active) return;
        setGit(availability);
        setRevisions(history);
        setBaseRevision(
          scope === "bundle-diff"
            ? history[0]?.id ?? ""
            : availability.headRevision ?? "",
        );
      })
      .catch((problem: unknown) => {
        if (!active) return;
        setGit({
          available: false,
          repositoryRoot: null,
          headRevision: null,
          message: String(problem),
        });
      });
    return () => {
      active = false;
    };
  }, [root, scope, state.bundleGitStatus.headRevision]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [stage]);

  const types = useMemo(
    () => [...new Set(bundle.concepts.map((concept) => concept.type))].sort(),
    [bundle],
  );
  const tags = useMemo(
    () => [...new Set(bundle.concepts.flatMap((concept) => concept.tags))].sort(),
    [bundle],
  );
  const visibleConcepts = useMemo(() => {
    const query = documentQuery.trim().toLocaleLowerCase();
    return bundle.concepts.filter((concept) =>
      (!query ||
        concept.title.toLocaleLowerCase().includes(query) ||
        concept.description.toLocaleLowerCase().includes(query)) &&
      (!typeFilter || concept.type === typeFilter) &&
      (!tagFilter || concept.tags.includes(tagFilter))
    );
  }, [bundle, documentQuery, tagFilter, typeFilter]);
  const selectedConcepts = bundle.concepts.filter((concept) => selected.has(concept.id));
  const estimatedBytes = selectedConcepts.reduce(
    (total, concept) => total + conceptBytes(concept),
    0,
  );
  const effectiveProfileId = profiles.some((profile) => profile.id === profileId)
    ? profileId
    : profiles.some((profile) => profile.id === defaultProfileId)
      ? defaultProfileId ?? ""
      : profiles[0]?.id ?? "";
  // Reconcile a removed profile without resetting any other generation choices.
  if (providersReady && profileId !== effectiveProfileId) {
    setProfileId(effectiveProfileId);
  }
  const selectedProfile = useMemo(() => {
    const configured = profiles.find((profile) => profile.id === effectiveProfileId) ?? null;
    return configured
      && regenerateFailure?.providerProfile === configured.id
      && regenerateFailure.model !== null
      ? { ...configured, model: regenerateFailure.model }
      : configured;
  }, [effectiveProfileId, profiles, regenerateFailure]);
  const previewDocumentCount = preview
    ? new Set(preview.sources.map((source) => source.conceptId)).size
    : 0;
  const promptCopyText = promptPreview?.systemPrompt
    ? `System message:\n${promptPreview.systemPrompt}\n\nUser message:\n${promptPreview.userPrompt ?? ""}`
    : promptPreview?.prompt ?? "";
  const generation: QuizGenerationConfig = manualOverride
    ? { mode: "manual", length, difficulty, maxQuestions }
    : DEFAULT_QUIZ_GENERATION;
  const automaticUnavailableReason = !manualOverride
    ? selectedProfile?.kind === "model-api"
      ? "Automatic mode requires Codex CLI or Claude Code. Turn on ‘Set length and difficulty manually’ in Advanced Options to use this API profile."
      : !state.bundleGitStatus.available
        ? "Automatic mode requires a trusted Git repository. Trust this repository or turn on ‘Set length and difficulty manually’ in Advanced Options."
        : null
    : null;

  const startBackgroundGeneration = useCallback((
    nextPreview: QuizScopePreview,
    profile: QuizProviderProfile,
  ) => {
    setError(null);
    if (!actions.startQuizGeneration({ bundleRoot: root, preview: nextPreview, profile })) {
      setError("Another quiz is already being generated.");
      setStage("failure");
    } else {
      onGenerationStarted();
    }
  }, [actions, onGenerationStarted, root]);

  useEffect(() => {
    if (!quickStart || quickStarted.current || !providersReady) return;
    quickStarted.current = true;
    if (!activeConcept || !selectedProfile || selectedProfile.kind === "model-api" || !state.bundleGitStatus.available) {
      const setupError = !activeConcept
        ? "The concept selected for this quick quiz is no longer available."
        : !selectedProfile
          ? "Configure a default quiz generator before starting a quick quiz."
          : selectedProfile.kind === "model-api"
            ? "Quick quizzes use automatic mode and require Codex CLI or Claude Code."
            : "Quick quizzes use automatic mode and require a trusted Git repository.";
      void Promise.resolve().then(() => {
        setError(setupError);
        setStage("failure");
      });
      return;
    }
    void ipc.prepareQuizScope({
      bundleRoot: root,
      scopeMode: "current-document",
      conceptIds: [activeConcept.id],
      topic: null,
      baseRevisionId: null,
      headRevisionId: null,
      generation: DEFAULT_QUIZ_GENERATION,
    }).then((nextPreview) => {
      setPreview(nextPreview);
      startBackgroundGeneration(nextPreview, selectedProfile);
    }).catch((problem: unknown) => {
      setError(String(problem));
      setStage("failure");
    });
  }, [
    activeConcept,
    providersReady,
    quickStart,
    root,
    startBackgroundGeneration,
    selectedProfile,
    state.bundleGitStatus.available,
  ]);

  function toggleConcept(conceptId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(conceptId)) next.delete(conceptId);
      else next.add(conceptId);
      return next;
    });
  }

  async function retrieveTopic() {
    setError(null);
    if (!topic.trim()) {
      setError("Enter a topic to search within this bundle.");
      return;
    }
    try {
      const candidates = await ipc.quizTopicCandidates(root, topic);
      setTopicCandidates(candidates);
      setSelected(new Set(candidates.slice(0, 8).map((candidate) => candidate.conceptId)));
      setTopicSearched(true);
      if (candidates.length === 0) setError("No bundle documents matched that topic.");
    } catch (problem) {
      setError(String(problem));
    }
  }

  async function reviewEvidence() {
    setError(null);
    let conceptIds: string[];
    if (scope === "current-document") {
      if (!activeConcept) {
        setError("Open a concept in the reader before using current-document scope.");
        return;
      }
      conceptIds = [activeConcept.id];
    } else if (scope === "bundle-diff" || scope === "reviewed-since-commit") {
      conceptIds = [];
      const requiredBase = scope === "bundle-diff" ? baseRevision : git?.headRevision;
      if (!git?.available || !requiredBase) {
        setError(git?.message ?? "Refresh Git availability before preparing this scope.");
        return;
      }
    } else {
      conceptIds = [...selected];
      if (conceptIds.length === 0) {
        setError("Select at least one document.");
        return;
      }
      if (scope === "topic" && !topicSearched) {
        setError("Retrieve and review the proposed topic documents first.");
        return;
      }
    }
    if (conceptIds.length > 32 || estimatedBytes > 1024 * 1024) {
      setError("Narrow the selection to 32 documents and approximately 1 MiB of evidence.");
      return;
    }
    if (!effectiveProfileId) {
      setError("Choose a provider profile.");
      return;
    }
    if (automaticUnavailableReason) {
      setError(automaticUnavailableReason);
      return;
    }
    try {
      const nextPreview = await ipc.prepareQuizScope({
        bundleRoot: root,
        scopeMode: scope,
        conceptIds,
        topic: scope === "topic" ? topic.trim() : null,
        baseRevisionId:
          scope === "bundle-diff"
            ? baseRevision
            : scope === "reviewed-since-commit"
              ? git?.headRevision ?? null
              : null,
        headRevisionId: null,
        generation,
      });
      setPreview(nextPreview);
      setStage("confirmation");
    } catch (problem) {
      setError(String(problem));
    }
  }

  function generate() {
    if (!preview || !selectedProfile) return;
    startBackgroundGeneration(preview, selectedProfile);
  }

  async function viewPrompt() {
    if (!preview || !selectedProfile) return;
    setError(null);
    try {
      setPromptPreview(await ipc.previewQuizGenerationPrompt(
        preview.requestId,
        selectedProfile.id,
        selectedProfile.model,
      ));
      setPromptOpen(true);
    } catch (problem) {
      setError(String(problem));
    }
  }

  return (
    <div className="quiz-page quiz-generate">
      <button type="button" className="quiz-back" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" /> {quickStart ? "Reader" : "Quiz history"}
      </button>
      <h1 ref={headingRef} tabIndex={-1}>
        {stage === "configure"
          ? "Generate a quiz"
          : stage === "confirmation"
            ? "Confirm generation"
            : stage === "generating"
              ? "Preparing quiz"
              : "Generation needs attention"}
      </h1>
      {error && <p className="quiz-callout quiz-callout--error" role="alert">{error}</p>}

      {stage === "configure" && (
        <div className="quiz-form-layout">
          <section className="quiz-form-section">
            <h2>1. Choose knowledge scope</h2>
            <div className="quiz-scope-options" role="radiogroup" aria-label="Quiz scope">
              {SCOPE_GROUPS.map((group) => (
                <div className="quiz-scope-group" role="group" aria-label={group.label} key={group.label}>
                  <h3>{group.label}</h3>
                  <div className="quiz-scope-grid">
                    {group.options.map(([value, label, detail]) => (
                      <label className="quiz-choice-card" key={value}>
                        <input
                          aria-label={label}
                          type="radio"
                          name="scope"
                          value={value}
                          checked={scope === value}
                          onChange={() => setScope(value)}
                        />
                        <span><strong>{label}</strong><small>{detail}</small></span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {scope === "current-document" && (
              <div className="quiz-document-summary">
                {activeConcept ? (
                  <>
                    <strong>{activeConcept.title}</strong>
                    <span>{activeConcept.id}.md · {activeConcept.type}</span>
                    <small>The quiz uses a snapshot of this document, captured before you confirm generation.</small>
                  </>
                ) : (
                  <p>Open a concept in the reader first.</p>
                )}
              </div>
            )}

            {(scope === "selected-documents" || scope === "topic") && (
              <DocumentSelector
                concepts={visibleConcepts}
                selected={selected}
                query={documentQuery}
                typeFilter={typeFilter}
                tagFilter={tagFilter}
                types={types}
                tags={tags}
                topic={scope === "topic" ? topic : null}
                topicCandidates={topicCandidates}
                topicSearched={topicSearched}
                onQuery={setDocumentQuery}
                onType={setTypeFilter}
                onTag={setTagFilter}
                onTopic={setTopic}
                onRetrieve={() => void retrieveTopic()}
                onToggle={toggleConcept}
                onSelectVisible={() =>
                  setSelected((current) =>
                    new Set([...current, ...visibleConcepts.map((concept) => concept.id)])
                  )
                }
                onClear={() => setSelected(new Set())}
              />
            )}

            {scope === "bundle-diff" && (
              <div className="quiz-diff">
                {!git && <p role="status">Checking Git availability…</p>}
                {git && !git.available && (
                  <p className="quiz-callout"><AlertTriangle size={16} /> {git.message}</p>
                )}
                {git?.available && (
                  <>
                    <label>
                      Base revision
                      <select value={baseRevision} onChange={(event) => setBaseRevision(event.target.value)}>
                        {revisions.map((revision) => (
                          <option value={revision.id} key={revision.id}>
                            {revision.shortId} · {revision.subject}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p>Compared with the current working-tree bundle. Repository changes outside the active bundle are ignored.</p>
                  </>
                )}
              </div>
            )}
            {scope === "reviewed-since-commit" && (
              <div className="quiz-diff">
                {!git && <p role="status">Checking Git availability…</p>}
                {git && !git.available && (
                  <p className="quiz-callout"><AlertTriangle size={16} /> {git.message}</p>
                )}
                {git?.available && git.headRevision && (
                  <>
                    <p>
                      Current documents with human reviews added since the last commit{" "}
                      <code>HEAD {git.headRevision.slice(0, 8)}</code> will be considered.
                    </p>
                    <p>
                      Documents are ranked by changed lines. Up to 32 documents and 1 MiB
                      of current content will be included; unrelated edits alone do not qualify.
                    </p>
                  </>
                )}
              </div>
            )}
            {(scope === "selected-documents" || scope === "topic") && (
              <p className={selected.size > 32 || estimatedBytes > 1024 * 1024 ? "quiz-limit-error" : "quiz-estimate"}>
                {selected.size} selected · approximately {formatBytes(estimatedBytes)}
                {" "}of 1 MiB · maximum 32 documents
              </p>
            )}
          </section>

          <section className="quiz-form-section">
            <h2>2. Configure the quiz</h2>
            <p className="quiz-automatic-summary" aria-live="polite">
              {manualOverride
                ? `Manual mode is on. The quiz will use your chosen length and difficulty, with up to ${maxQuestions} questions.`
                : "Automatic mode is on. Your generator will use the selected documents and repository context to choose a suitable number and difficulty mix of questions."}
            </p>
            <details className="quiz-advanced-options">
              <summary>Advanced Options</summary>
              <label
                className="quiz-manual-toggle"
                htmlFor="quiz-manual-override"
                aria-label="Manual quiz settings override"
              >
                <input
                  id="quiz-manual-override"
                  aria-label="Set length and difficulty manually"
                  type="checkbox"
                  checked={manualOverride}
                  onChange={(event) => setManualOverride(event.target.checked)}
                />
                <span>
                  <strong>Set length and difficulty manually</strong>
                  <small>Choose the length and difficulty yourself, or use an API generator.</small>
                </span>
              </label>
              {manualOverride && (
                <div className="quiz-config-grid">
                  <fieldset>
                    <legend>Length</legend>
                    <div className="quiz-difficulty-list">
                      {LENGTHS.map((option) => (
                        <label key={option.value}>
                          <input
                            aria-label={option.label}
                            type="radio"
                            name="length"
                            checked={length === option.value}
                            onChange={() => setLength(option.value)}
                          />
                          <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend>Difficulty</legend>
                    <div className="quiz-difficulty-list">
                      {DIFFICULTIES.map((option) => (
                        <label key={option.value}>
                          <input
                            aria-label={option.label}
                            type="radio"
                            name="difficulty"
                            checked={difficulty === option.value}
                            onChange={() => setDifficulty(option.value)}
                          />
                          <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <label className="quiz-model-input">
                    Maximum questions <span>(1-20)</span>
                    <input
                      aria-label="Maximum questions"
                      type="number"
                      min={1}
                      max={20}
                      value={maxQuestions}
                      onChange={(event) =>
                        setMaxQuestions(Math.max(1, Math.min(20, Number(event.target.value) || 1)))
                      }
                    />
                    <small>The exact request is scaled to the selected evidence and capped here.</small>
                  </label>
                </div>
              )}
            </details>
          </section>

          <section className="quiz-form-section">
            <div className="quiz-section-heading">
              <h2>3. Choose a generator</h2>
              <button type="button" className="quiz-secondary" onClick={onOpenGeneratorSettings}>
                Generator settings
              </button>
            </div>
            {profiles.length === 0 ? (
              <p>No provider profiles are configured.</p>
            ) : (
              <div className="quiz-provider-list">
                {profiles.map((profile) => (
                  <label key={profile.id}>
                    <input
                      aria-label={profile.label}
                      type="radio"
                      name="provider"
                      checked={effectiveProfileId === profile.id}
                      onChange={() => setProfileId(profile.id)}
                    />
                    <span>
                      <strong>{profile.label}</strong>
                      <small>
                        {profile.kind === "model-api" ? "API connection" : "Command-line generator"} ·{" "}
                        {profile.sendsContentOffDevice
                          ? "selected bundle content leaves this device"
                          : "local endpoint"}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>

          {automaticUnavailableReason && (
            <p className="quiz-callout quiz-callout--error" role="alert">
              {automaticUnavailableReason}
            </p>
          )}

          <div className="quiz-form-actions">
            <button type="button" className="quiz-secondary" onClick={onBack}>Cancel</button>
            <button
              type="button"
              className="quiz-primary"
              onClick={() => void reviewEvidence()}
              disabled={automaticUnavailableReason !== null}
            >
              Review evidence <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {stage === "confirmation" && preview && selectedProfile && (
        <section className="quiz-confirmation">
          <p className="quiz-callout">
            A snapshot of your selected documents and bundle context is ready. Generation will continue in the background while you browse.
          </p>
          <dl className="quiz-confirm-grid">
            <div><dt>Provider</dt><dd>{selectedProfile.label}</dd></div>
            <div>
              <dt>Model or profile</dt>
              <dd>
                {selectedProfile.model ?? "Provider default"}
              </dd>
            </div>
            <div>
              <dt>Quiz settings</dt>
              <dd>{preview.generation.mode === "automatic" ? "Automatic" : "Manual"}</dd>
            </div>
            {preview.generation.mode === "manual" && (
              <>
                <div><dt>Length</dt><dd>{preview.generation.length}</dd></div>
                <div><dt>Difficulty</dt><dd>{preview.generation.difficulty}</dd></div>
                <div><dt>Maximum questions</dt><dd>{preview.generation.maxQuestions}</dd></div>
              </>
            )}
            <div><dt>Scope</dt><dd>{preview.scopeDescription}</dd></div>
            <div><dt>Documents</dt><dd>{previewDocumentCount}</dd></div>
            <div><dt>Evidence size</dt><dd>{formatBytes(preview.totalEvidenceBytes)}</dd></div>
            <div><dt>Bundle context</dt><dd>{preview.bundleContextDocuments} documents ({formatBytes(preview.bundleContextBytes)})</dd></div>
            <div><dt>Bundle revision</dt><dd>{preview.bundleRevision}</dd></div>
            <div>
              <dt>Privacy</dt>
              <dd>
                {selectedProfile.sendsContentOffDevice
                  ? `Selected bundle content will be sent through ${selectedProfile.label}.`
                  : "The selected profile identifies a local endpoint."}
              </dd>
            </div>
            <div><dt>Omitted</dt><dd>{preview.omittedDocuments.length || "None"}</dd></div>
          </dl>
          {preview.omittedDocuments.length > 0 && (
            <div className="quiz-omitted-documents">
              <h2>Omitted documents</h2>
              <p>These qualifying documents did not fit the evidence limits:</p>
              <ul>
                {preview.omittedDocuments.map((path) => <li key={path}>{path}</li>)}
              </ul>
            </div>
          )}
          <h2>Frozen evidence</h2>
          <ul className="quiz-evidence-review">
            {preview.sources.map((source) => (
              <li key={source.sourceId}>
                <div>
                  <strong>{source.title}</strong>
                  <span>{source.path} · {source.type} · {source.version}</span>
                  <small>{source.reason}</small>
                </div>
                <code>{source.contentHash.slice(0, 12)}</code>
              </li>
            ))}
          </ul>
          <div className="quiz-form-actions">
            <button type="button" className="quiz-secondary" onClick={() => setStage("configure")}>
              Change scope
            </button>
            <button ref={promptTriggerRef} type="button" className="quiz-secondary" onClick={() => void viewPrompt()}>
              <Eye size={16} aria-hidden="true" /> View generation prompt
            </button>
            <button type="button" className="quiz-primary" onClick={generate}>
              Generate in background
            </button>
          </div>
        </section>
      )}

      {promptPreview && (
        <Dialog.Root open={promptOpen && state.workspaceArea === "quizzes"} onOpenChange={setPromptOpen}>
          <Dialog.Portal>
            <Dialog.Backdrop className="ui-backdrop quiz-prompt-backdrop" />
            <Dialog.Popup
              className="ui-dialog quiz-prompt-dialog"
              initialFocus={promptCloseRef}
              finalFocus={promptTriggerRef}
            >
              <div className="quiz-section-heading">
                <div>
                  <Dialog.Title id="quiz-prompt-title">Generation prompt</Dialog.Title>
                  <Dialog.Description className="sr-only">
                    Read or copy the exact messages prepared for your selected generator.
                  </Dialog.Description>
                </div>
                <button ref={promptCloseRef} type="button" className="quiz-secondary" onClick={() => setPromptOpen(false)}>
                  Close
                </button>
              </div>
              <dl className="quiz-prompt-context">
                <div>
                  <dt>Provider</dt>
                  <dd>{promptPreview.providerKind.replaceAll("-", " ")}</dd>
                </div>
                {promptPreview.workingDirectory && (
                  <div>
                    <dt>Repository working directory</dt>
                    <dd>{promptPreview.workingDirectory}</dd>
                  </div>
                )}
              </dl>
              {promptPreview.systemPrompt && (
                <label>
                  System message
                  <textarea readOnly value={promptPreview.systemPrompt} />
                </label>
              )}
              <label>
                {promptPreview.systemPrompt ? "User message" : "Prompt"}
                <textarea
                  readOnly
                  value={promptPreview.userPrompt ?? promptPreview.prompt ?? ""}
                />
              </label>
              <div className="quiz-form-actions">
                <button
                  type="button"
                  className="quiz-primary"
                  onClick={() => void navigator.clipboard.writeText(promptCopyText)}
                >
                  <Clipboard size={16} aria-hidden="true" /> Copy prompt
                </button>
              </div>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}

      {stage === "generating" && (
        <section className="quiz-generation-status" role="status">
          <LoaderCircle size={34} className="quiz-spin" aria-hidden="true" />
          <h2>Preparing the current document</h2>
          <p>Your generator is choosing questions that match the amount and complexity of the selected content.</p>
          <p>It has been instructed to inspect the repository without changing it.</p>
        </section>
      )}

      {stage === "failure" && (
        <section className="quiz-generation-status">
          <CircleX size={34} aria-hidden="true" />
          <h2>Quiz was not created</h2>
          <p>{error}</p>
          <button
            type="button"
            className="quiz-secondary"
            onClick={quickStart ? onBack : () => setStage("configure")}
          >
            {quickStart ? "Back to reader" : "Back to configuration"}
          </button>
        </section>
      )}
    </div>
  );
}

function DocumentSelector({
  concepts,
  selected,
  query,
  typeFilter,
  tagFilter,
  types,
  tags,
  topic,
  topicCandidates,
  topicSearched,
  onQuery,
  onType,
  onTag,
  onTopic,
  onRetrieve,
  onToggle,
  onSelectVisible,
  onClear,
}: {
  concepts: Concept[];
  selected: Set<string>;
  query: string;
  typeFilter: string;
  tagFilter: string;
  types: string[];
  tags: string[];
  topic: string | null;
  topicCandidates: TopicCandidate[];
  topicSearched: boolean;
  onQuery: (value: string) => void;
  onType: (value: string) => void;
  onTag: (value: string) => void;
  onTopic: (value: string) => void;
  onRetrieve: () => void;
  onToggle: (conceptId: string) => void;
  onSelectVisible: () => void;
  onClear: () => void;
}) {
  const reasons = new Map(topicCandidates.map((candidate) => [candidate.conceptId, candidate.reason]));
  return (
    <div className="quiz-document-selector">
      {topic !== null && (
        <div className="quiz-topic-search">
          <label>
            Topic restricted to this bundle
            <input
              value={topic}
              onChange={(event) => onTopic(event.target.value)}
              placeholder="software architecture"
            />
          </label>
          <button type="button" className="quiz-secondary" onClick={onRetrieve}>
            Find bundle documents
          </button>
          {topicSearched && (
            <p>{topicCandidates.length} locally matched documents proposed. Review, add, or remove them below.</p>
          )}
        </div>
      )}
      <div className="quiz-document-filters">
        <label>Search<input value={query} onChange={(event) => onQuery(event.target.value)} /></label>
        <label>Type<select value={typeFilter} onChange={(event) => onType(event.target.value)}><option value="">All types</option>{types.map((type) => <option key={type}>{type}</option>)}</select></label>
        <label>Tag<select value={tagFilter} onChange={(event) => onTag(event.target.value)}><option value="">All tags</option>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select></label>
      </div>
      <div className="quiz-selector-actions">
        <button type="button" onClick={onSelectVisible}>Select all visible</button>
        <button type="button" onClick={onClear}>Clear selection</button>
      </div>
      <div className="quiz-document-list" role="group" aria-label="Bundle documents">
        {concepts.map((concept) => (
          <label key={concept.id}>
            <input
              type="checkbox"
              checked={selected.has(concept.id)}
              onChange={() => onToggle(concept.id)}
            />
            <span>
              <strong>{concept.title}</strong>
              <small>{concept.type} · {concept.id}.md · {formatBytes(conceptBytes(concept))}</small>
              {reasons.has(concept.id) && <em>{reasons.get(concept.id)}</em>}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function TakeQuiz({
  root,
  attempt,
  reveal,
  onReveal,
  onAttempt,
  onResults,
  onExit,
  onOpenEvidence,
}: {
  root: string;
  attempt: QuizAttemptView;
  reveal: QuizAnswerReveal | null;
  onReveal: (reveal: QuizAnswerReveal | null) => void;
  onAttempt: (attempt: QuizAttemptView) => void;
  onResults: (results: QuizResults) => void;
  onExit: () => void;
  onOpenEvidence: (conceptId: string) => void;
}) {
  const question = attempt.nextQuestion;
  const [selectedChoice, setSelectedChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  if (!question) return null;
  const currentQuestion = question;

  async function submit() {
    if (!selectedChoice) {
      setError("Choose an answer before submitting.");
      return;
    }
    setError(null);
    try {
      onReveal(await ipc.submitQuizAnswer({
        bundleRoot: root,
        attemptId: currentQuestion.attemptId,
        questionId: currentQuestion.questionId,
        selectedChoiceId: selectedChoice,
      }));
    } catch (problem) {
      setError(String(problem));
    }
  }

  async function next() {
    if (reveal?.completed) {
      onResults(await ipc.getQuizResults(root, currentQuestion.attemptId));
      return;
    }
    onAttempt(await ipc.resumeQuizAttempt(root, currentQuestion.attemptId));
    onReveal(null);
  }

  async function markNotImportant() {
    setError(null);
    try {
      const nextAttempt = await ipc.markQuizQuestionNotImportant({
        bundleRoot: root,
        attemptId: currentQuestion.attemptId,
        questionId: currentQuestion.questionId,
      });
      if (!nextAttempt.nextQuestion) {
        onResults(await ipc.getQuizResults(root, currentQuestion.attemptId));
        return;
      }
      onReveal(null);
      onAttempt(nextAttempt);
    } catch (problem) {
      setError(String(problem));
    }
  }

  return (
    <div className="quiz-page quiz-taking">
      <header className="quiz-taking-header">
        <button type="button" className="quiz-back" onClick={onExit}>
          <ArrowLeft size={16} /> Save and exit
        </button>
        <span>Question {question.index + 1} of {question.total}</span>
      </header>
      <div
        className="quiz-progress"
        role="progressbar"
        aria-label="Quiz progress"
        aria-valuenow={question.index + 1}
        aria-valuemin={1}
        aria-valuemax={question.total}
      >
        <span style={{ width: `${((question.index + 1) / question.total) * 100}%` }} />
      </div>
      {attempt.stale && (
        <p className="quiz-stale-note" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          Historical quiz: {attempt.staleReason ??
            "its source knowledge has changed since generation."}
        </p>
      )}
      <article className="quiz-question-card">
        <div className="quiz-badges">
          <span>{question.category.replaceAll("-", " ")}</span>
          <span className={`quiz-criticality quiz-criticality--${question.criticality}`}>
            {question.criticality}
          </span>
        </div>
        <h1 ref={headingRef} tabIndex={-1}>{question.prompt}</h1>
        <fieldset className="quiz-answer-list" disabled={reveal !== null}>
          <legend className="sr-only">Choose one answer</legend>
          {question.choices.map((choice) => {
            const stateClass = reveal
              ? choice.id === reveal.correctChoiceId
                ? " is-correct"
                : choice.id === reveal.selectedChoiceId
                  ? " is-incorrect"
                  : ""
              : "";
            return (
              <label className={`quiz-answer${stateClass}`} key={choice.id}>
                <input
                  type="radio"
                  name="answer"
                  checked={selectedChoice === choice.id}
                  onChange={() => setSelectedChoice(choice.id)}
                />
                <span className="quiz-answer-id">{choice.id}</span>
                <span>{choice.text}</span>
              </label>
            );
          })}
        </fieldset>
        {error && <p className="quiz-callout quiz-callout--error" role="alert">{error}</p>}
        {!reveal ? (
          <div className="quiz-question-actions">
            <button type="button" className="quiz-primary quiz-submit" onClick={() => void submit()}>
              Submit answer
            </button>
            <button type="button" className="quiz-secondary quiz-submit" onClick={() => void markNotImportant()}>
              Not Important
            </button>
          </div>
        ) : (
          <div className="quiz-reveal" aria-live="polite">
            <h2 className={reveal.correct ? "quiz-correct-text" : "quiz-incorrect-text"}>
              {reveal.correct
                ? <><CheckCircle2 size={20} /> Correct</>
                : <><CircleX size={20} /> Not quite</>}
            </h2>
            {!reveal.correct && <p>The correct answer is <strong>{reveal.correctChoiceId}</strong>.</p>}
            <h3>Why</h3>
            <p>{reveal.explanation}</p>
            <h3>Bundle evidence</h3>
            <ul className="quiz-reveal-evidence">
              {reveal.evidence.map((evidence) => (
                <li key={`${evidence.sourceId}-${evidence.heading}`}>
                  <blockquote>{evidence.quote}</blockquote>
                  <button type="button" onClick={() => onOpenEvidence(evidence.conceptId)}>
                    Open {evidence.title}
                    {evidence.version === "base" ? " (base revision)" : ""}
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="quiz-primary" onClick={() => void next()}>
              {reveal.completed ? "See results" : "Next question"} <ChevronRight size={16} />
            </button>
          </div>
        )}
      </article>
    </div>
  );
}

function QuizResultsView({
  results,
  onBack,
  onRetake,
  onOpenEvidence,
}: {
  results: QuizResults;
  onBack: () => void;
  onRetake: () => void;
  onOpenEvidence: (conceptId: string) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  const percentage = results.total === 0 ? 0 : Math.round((results.correct / results.total) * 100);
  return (
    <div className="quiz-page quiz-results">
      <button type="button" className="quiz-back" onClick={onBack}>
        <ArrowLeft size={16} /> Quiz history
      </button>
      <header>
        <p className="quiz-eyebrow">Attempt complete</p>
        <h1 ref={headingRef} tabIndex={-1}>{results.title}</h1>
        <div className="quiz-score">
          <strong>{results.total === 0 ? "—" : `${percentage}%`}</strong>
          <span>
            {results.total === 0
              ? "No scored questions"
              : `${results.correct} of ${results.total} correct`}
          </span>
        </div>
        <p>
          This reflects understanding of what the bundle documents. It is not
          validation that the documented decisions are correct.
        </p>
      </header>
      {results.stale && (
        <p className="quiz-stale-note" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          Historical result: {results.staleReason ??
            "this quiz no longer represents current bundle knowledge."}
        </p>
      )}
      {results.criticalGap ? (
        <p className="quiz-critical-gap" role="alert">
          <AlertTriangle size={20} />
          Critical understanding gaps remain: {results.criticalCorrect} of {results.criticalTotal} critical questions were correct.
        </p>
      ) : results.criticalTotal > 0 ? (
        <p className="quiz-callout quiz-callout--success">
          All {results.criticalTotal} critical questions were answered correctly.
        </p>
      ) : null}
      <section>
        <h2>Results by category</h2>
        <div className="quiz-category-results">
          {results.byCategory.map((category) => (
            <div key={category.category}>
              <span>{category.category.replaceAll("-", " ")}</span>
              <strong>{category.correct}/{category.total}</strong>
            </div>
          ))}
        </div>
      </section>
      {results.excludedQuestions.length > 0 && (
        <section>
          <h2>Marked Not Important ({results.excludedQuestions.length})</h2>
          <div className="quiz-incorrect-list">
            {results.excludedQuestions.map((question) => (
              <article key={question.questionId}>
                <h3>{question.prompt}</h3>
                <p>
                  {question.category.replaceAll("-", " ")} · {question.criticality}
                </p>
              </article>
            ))}
          </div>
        </section>
      )}
      <section>
        <h2>Incorrect answers and concepts to revisit</h2>
        {results.incorrectAnswers.length === 0 ? (
          <p>No incorrect answers in this attempt.</p>
        ) : (
          <div className="quiz-incorrect-list">
            {results.incorrectAnswers.map((answer) => (
              <article key={answer.questionId}>
                <h3>{answer.prompt}</h3>
                <p>Selected <strong>{answer.selectedChoiceId}</strong>; correct answer <strong>{answer.correctChoiceId}</strong>.</p>
                <p>{answer.explanation}</p>
                <div>
                  {answer.evidence.map((evidence) => (
                    <button
                      type="button"
                      className="quiz-evidence-link"
                      key={evidence.sourceId}
                      onClick={() => onOpenEvidence(evidence.conceptId)}
                    >
                      Revisit {evidence.title}
                      {evidence.version === "base" ? " (base)" : ""}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <div className="quiz-form-actions">
        <button type="button" className="quiz-secondary" onClick={onBack}>Done</button>
        <button type="button" className="quiz-primary" onClick={onRetake}>
          <RotateCcw size={16} /> Retake without generating
        </button>
      </div>
    </div>
  );
}
