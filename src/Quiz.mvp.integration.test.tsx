import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import * as ipc from "@/shared/ipc.ts";
import { openBundleAtOverview, renderApp } from "@/test/appHarness.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

async function openQuizzes() {
  const user = userEvent.setup();
  renderApp();
  await openBundleAtOverview(user);
  await user.click(screen.getByRole("button", { name: "Quizzes" }));
  await screen.findByRole("heading", { name: "Quizzes", level: 1 });
  return user;
}

async function openGeneratedQuiz(user: ReturnType<typeof userEvent.setup>) {
  const open = await screen.findByRole("button", { name: "Open quizzes" });
  await user.click(open);
  await screen.findByRole("heading", { name: "Quizzes", level: 1 });
  await user.click(await screen.findByRole("button", { name: "Start quiz" }));
}

describe("provider-independent quiz workflow", () => {
  it("generates, answers, reveals evidence, and scores without later provider calls", async () => {
    const generate = vi.spyOn(ipc, "generateQuiz");
    const previewPrompt = vi.spyOn(ipc, "previewQuizGenerationPrompt");
    const user = await openQuizzes();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));
    expect(await screen.findByRole("heading", { name: "Generate a quiz" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /review evidence/i }));

    expect(await screen.findByRole("heading", { name: "Confirm generation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Confirm generation" })).toHaveFocus();
    expect(screen.getByText(/selected bundle content will be sent through codex cli/i))
      .toBeInTheDocument();
    expect(screen.getByText(/frozen evidence/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /view generation prompt/i }));
    const promptDialog = await screen.findByRole("dialog", { name: "Generation prompt" });
    expect(within(promptDialog).getByText("Repository working directory")).toBeInTheDocument();
    expect(within(promptDialog).getByText("C:\\mock-repository")).toBeInTheDocument();
    const prompt = within(promptDialog).getByRole("textbox", { name: "Prompt" });
    expect((prompt as HTMLTextAreaElement).value).toContain("Inspect Git read-only");
    expect((prompt as HTMLTextAreaElement).value).not.toContain("@@ -");
    await user.click(within(promptDialog).getByRole("button", { name: /copy prompt/i }));
    expect(writeText).toHaveBeenCalledWith((prompt as HTMLTextAreaElement).value);
    await user.click(within(promptDialog).getByRole("button", { name: "Close" }));
    expect(previewPrompt).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /generate in background/i }));
    expect(await screen.findByRole("heading", { name: "Overview", level: 1 }))
      .toBeInTheDocument();
    await openGeneratedQuiz(user);

    const firstPrompt = await screen.findByRole("heading", {
      name: /which statement is documented/i,
      level: 1,
    });
    expect(firstPrompt).toBeInTheDocument();
    expect(firstPrompt).toHaveFocus();
    expect(screen.queryByText("Correct")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Bundle evidence" })).not.toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);

    const firstAnswers = screen.getAllByRole("radio");
    firstAnswers[1].focus();
    await user.keyboard(" ");
    expect(firstAnswers[1]).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(await screen.findByRole("heading", { name: "Not quite" })).toBeInTheDocument();
    expect(screen.getByText(/correct answer is/i)).toHaveTextContent("A");
    expect(screen.getByRole("heading", { name: "Bundle evidence" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open overview/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "See results" }));

    expect(await screen.findByText("0 of 1 correct")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /knowledge quiz/i, level: 1 })).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent(/critical understanding gaps remain/i);
    expect(screen.getByText(/not validation that the documented decisions are correct/i))
      .toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("excludes a not-important question from scoring and starts retakes clean", async () => {
    const user = await openQuizzes();
    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));
    await user.click(screen.getByRole("button", { name: /review evidence/i }));
    await user.click(screen.getByRole("button", { name: /generate in background/i }));
    await openGeneratedQuiz(user);

    const prompt = await screen.findByRole("heading", {
      name: /which statement is documented/i,
      level: 1,
    });
    await user.click(screen.getByRole("button", { name: "Not Important" }));

    expect(await screen.findByText("No scored questions")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Marked Not Important (1)" }))
      .toBeInTheDocument();
    expect(screen.getByRole("heading", { name: prompt.textContent ?? "" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("No scored questions")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Attempts (1)" }));
    const attemptHistory = screen.getByRole("heading", { name: /Attempts for/i })
      .closest("section");
    expect(attemptHistory).toHaveTextContent("No scored questions");
    expect(attemptHistory).toHaveTextContent("1 marked Not Important");
    await user.click(screen.getByRole("button", { name: "Review results" }));
    await user.click(screen.getByRole("button", { name: /retake without generating/i }));
    expect(await screen.findByRole("heading", {
      name: /which statement is documented/i,
      level: 1,
    })).toBeInTheDocument();
    expect(screen.getByText("Question 1 of 1")).toBeInTheDocument();
  });

  it("uses local topic retrieval, permits evidence edits, and keeps answers hidden", async () => {
    const user = await openQuizzes();
    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));
    await user.click(screen.getByRole("radio", { name: "Topic in this bundle" }));

    const topic = screen.getByRole("textbox", { name: /topic restricted to this bundle/i });
    await user.type(topic, "architecture");
    await user.click(screen.getByRole("button", { name: "Find bundle documents" }));
    expect(await screen.findByText(/locally matched documents proposed/i)).toBeInTheDocument();

    const documents = screen.getByRole("group", { name: "Bundle documents" });
    const checked = within(documents).getAllByRole("checkbox", { checked: true });
    expect(checked.length).toBeGreaterThan(0);
    const unchecked = within(documents)
      .getAllByRole("checkbox")
      .find((checkbox) => !(checkbox as HTMLInputElement).checked);
    if (unchecked) await user.click(unchecked);
    await user.click(checked[0]);
    await user.click(screen.getByRole("button", { name: /review evidence/i }));

    expect(await screen.findByRole("heading", { name: "Confirm generation" })).toBeInTheDocument();
    expect(screen.getByText(/topic “architecture”/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /generate in background/i }));
    await openGeneratedQuiz(user);

    await screen.findByRole("heading", { name: /which statement is documented/i });
    expect(screen.queryByRole("heading", { name: "Why" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Bundle evidence" })).not.toBeInTheDocument();
  });

  it("prepares reviewed-since-commit from the displayed HEAD and explains omissions", async () => {
    const head = "abcdef0123456789abcdef0123456789abcdef01";
    vi.spyOn(ipc, "quizGitAvailability").mockResolvedValue({
      available: true,
      repositoryRoot: "C:/fixture",
      headRevision: head,
      message: "Git-backed quiz scopes are available.",
    });
    const revisions = vi.spyOn(ipc, "quizGitRevisions");
    const prepare = vi.spyOn(ipc, "prepareQuizScope").mockResolvedValue({
      requestId: "quiz-request-reviewed",
      bundleName: "Fixture",
      bundleFingerprint: "bundle-reviewed",
      scopeFingerprint: "scope-reviewed",
      scopeMode: "reviewed-since-commit",
      scopeDescription: "1 document reviewed since abcdef01",
      sources: [{
        sourceId: "source-1",
        conceptId: "product/overview",
        path: "product/overview.md",
        title: "Overview",
        type: "Product",
        version: "current",
        contentHash: "1234567890abcdef",
        bytes: 420,
        reason: "New human review since abcdef01; 7 changed lines",
      }],
      omittedDocuments: ["features/large.md", "features/later.md"],
      totalEvidenceBytes: 420,
      bundleContextDocuments: 4,
      bundleContextBytes: 2048,
      bundleRevision: "abcdef01..WORKTREE",
      repositoryRoot: "C:/fixture",
      generation: { mode: "automatic", length: null, difficulty: null, maxQuestions: 20 },
    });
    const user = await openQuizzes();
    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));

    const reviewedScope = screen.getByRole("radio", {
      name: "Reviewed since last commit",
    });
    expect(reviewedScope).toBeInTheDocument();
    await user.click(reviewedScope);
    expect(await screen.findByText("HEAD abcdef01")).toBeInTheDocument();
    expect(revisions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /review evidence/i }));

    expect(prepare).toHaveBeenCalledWith({
      bundleRoot: expect.any(String),
      scopeMode: "reviewed-since-commit",
      conceptIds: [],
      topic: null,
      baseRevisionId: head,
      headRevisionId: null,
      generation: { mode: "automatic", length: null, difficulty: null, maxQuestions: 20 },
    });
    expect(await screen.findByRole("heading", { name: "Confirm generation" }))
      .toBeInTheDocument();
    expect(screen.getByText("features/large.md")).toBeInTheDocument();
    expect(screen.getByText("features/later.md")).toBeInTheDocument();
    expect(screen.getByText(/7 changed lines/)).toBeInTheDocument();
  });

  it("disables reviewed-since-commit preparation when Git is unavailable", async () => {
    vi.spyOn(ipc, "quizGitAvailability").mockResolvedValue({
      available: false,
      repositoryRoot: null,
      headRevision: null,
      message: "The Git repository does not have a current HEAD commit.",
    });
    const prepare = vi.spyOn(ipc, "prepareQuizScope");
    const user = await openQuizzes();
    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));
    await user.click(screen.getByRole("radio", { name: "Reviewed since last commit" }));
    expect(await screen.findByText(/does not have a current HEAD commit/i))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /review evidence/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/does not have a current HEAD commit/i);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("shows stale history distinctly and preserves historical retakes", async () => {
    vi.spyOn(ipc, "listQuizzes").mockResolvedValue([{
      quizId: "quiz-stale",
      title: "Historical architecture quiz",
      scopeMode: "selected-documents",
      scopeDescription: "2 selected documents",
      providerKind: "codex-cli",
      providerProfile: "codex-cli",
      model: null,
      generatedAt: "2026-07-29T12:00:00Z",
      questionCount: 5,
      attemptCount: 1,
      latestScore: 3,
      latestTotal: 5,
      stale: true,
      staleReason: "Architecture changed after this quiz was generated.",
    }]);
    await openQuizzes();

    const card = await screen.findByRole("heading", { name: "Historical architecture quiz" });
    expect(card.closest("article")).toHaveTextContent("Stale");
    expect(card.closest("article")).toHaveTextContent(
      "Architecture changed after this quiz was generated.",
    );
    expect(screen.getByRole("button", { name: "Retake" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
    expect(await screen.findByText("3/5")).toBeInTheDocument();
  });

  it("has an accessible generation form at a narrow viewport", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 480 });
    const user = await openQuizzes();
    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));
    const heading = await screen.findByRole("heading", { name: "Generate a quiz" });
    expect(heading).toHaveFocus();
    expect(screen.getByRole("radiogroup", { name: "Quiz scope" })).toBeInTheDocument();
    expect(screen.getByText(/Automatic mode is on/i)).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Medium" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Maximum questions" }))
      .not.toBeInTheDocument();
    await user.click(screen.getByText("Advanced Options"));
    await user.click(screen.getByRole("checkbox", {
      name: /Set length and difficulty manually/i,
    }));
    expect(screen.getByRole("radio", { name: "Medium" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Maximum questions" })).toHaveValue(20);
    expect(screen.queryByRole("radio", { name: "5 questions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review evidence/i })).toBeEnabled();

    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        targets: violation.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  });

  it("requires a manual override for API profiles", async () => {
    vi.spyOn(ipc, "quizProviderProfiles").mockResolvedValue([
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
        id: "fixture-api",
        kind: "model-api",
        label: "Fixture API",
        model: "fixture-model",
        endpoint: "https://example.invalid/v1/responses",
        executablePath: null,
        reasoningEffort: null,
        sendsContentOffDevice: true,
      },
    ]);
    const user = await openQuizzes();
    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));
    await user.click(await screen.findByRole("radio", { name: "Fixture API" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      /Automatic mode requires Codex CLI or Claude Code/i,
    );
    expect(screen.getByRole("button", { name: /review evidence/i })).toBeDisabled();

    await user.click(screen.getByText("Advanced Options"));
    await user.click(screen.getByRole("checkbox", { name: /Set length and difficulty manually/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review evidence/i })).toBeEnabled();
  });

  it("requires a manual override when the bundle has no trusted Git repository", async () => {
    vi.spyOn(ipc, "readBundleGitStatus").mockResolvedValue({
      available: false,
      headRevision: null,
      comparisonMode: "unavailable",
      currentBranch: null,
      defaultBranch: null,
      baseRevision: null,
      modifiedConceptIds: [],
      deletedPaths: [],
      lineChangesByConcept: {},
      trustRequired: false,
      repositoryRoot: null,
      message: "The active bundle is not inside a Git repository.",
    });
    const user = await openQuizzes();
    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      /Automatic mode requires a trusted Git repository/i,
    );
    expect(screen.getByRole("button", { name: /review evidence/i })).toBeDisabled();

    await user.click(screen.getByText("Advanced Options"));
    await user.click(screen.getByRole("checkbox", { name: /Set length and difficulty manually/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review evidence/i })).toBeEnabled();
  });

  it("generates a quick quiz in one click with the default settings", async () => {
    const prepare = vi.spyOn(ipc, "prepareQuizScope");
    const preflight = vi.spyOn(ipc, "quizProviderPreflight");
    const originalGenerate = ipc.generateQuiz;
    let releaseGeneration!: () => void;
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const generate = vi.spyOn(ipc, "generateQuiz").mockImplementation(
      async (requestId, profileId, model) => {
        await generationGate;
        return originalGenerate(requestId, profileId, model);
      },
    );
    const user = userEvent.setup();
    renderApp();
    await openBundleAtOverview(user);

    await user.click(screen.getByRole("button", { name: "Make a quick quiz from this concept" }));
    expect(await screen.findByText("Generating quiz in the background…"))
      .toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Overview", level: 1 })).toBeInTheDocument();
    await user.click(screen.getByRole("treeitem", { name: /Graph View/i }));
    expect(await screen.findByRole("heading", { name: "Graph View", level: 1 }))
      .toBeInTheDocument();
    expect(screen.getByText("Generating quiz in the background…")).toBeInTheDocument();
    act(() => releaseGeneration());
    await openGeneratedQuiz(user);
    expect(await screen.findByRole("heading", {
      name: /which statement is documented/i,
      level: 1,
    })).toBeInTheDocument();
    expect(prepare).toHaveBeenCalledWith({
      bundleRoot: expect.any(String),
      scopeMode: "current-document",
      conceptIds: ["product/overview"],
      topic: null,
      baseRevisionId: null,
      headRevisionId: null,
      generation: {
        mode: "automatic",
        length: null,
        difficulty: null,
        maxQuestions: 20,
      },
    });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Generate a quiz" })).not.toBeInTheDocument();
  });

  it("requires Codex CLI sign-in and resumes only after a manual status recheck", async () => {
    const ready = await ipc.quizProviderPreflight("codex-cli", "gpt-5.6-sol");
    const signedOut = {
      ...ready,
      available: false,
      authenticationRequired: true,
      message: "Codex is installed, but sign-in is required.",
    };
    const preflight = vi.spyOn(ipc, "quizProviderPreflight")
      .mockResolvedValueOnce(signedOut)
      .mockResolvedValueOnce(ready);
    const login = vi.spyOn(ipc, "quizProviderLogin");
    const openExternal = vi.spyOn(ipc, "openExternal").mockResolvedValue(undefined);
    const user = await openQuizzes();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));
    await user.click(screen.getByRole("button", { name: /review evidence/i }));
    await user.click(screen.getByRole("button", { name: /generate in background/i }));

    expect(await screen.findByRole("heading", { name: "Codex CLI sign-in required" }))
      .toBeInTheDocument();
    expect(screen.getByText("mock-provider")).toBeInTheDocument();
    expect(screen.getByText("mock 1.0.0")).toBeInTheDocument();
    const commands = within(screen.getByLabelText("Codex CLI commands"));
    expect(commands.getByText("codex login")).toBeInTheDocument();
    expect(commands.getByText("codex login --device-auth")).toBeInTheDocument();
    expect(commands.getByText("codex login status")).toBeInTheDocument();
    expect(screen.getByText(/does not ask for or store your password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy sign in command" }));
    expect(writeText).toHaveBeenCalledWith("codex login");
    await user.click(screen.getByRole("button", { name: "Open official instructions" }));
    expect(openExternal).toHaveBeenCalledWith("https://developers.openai.com/codex/auth");
    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("button", { name: "Open quizzes" })).toBeInTheDocument();
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(login).not.toHaveBeenCalled();
  });

  it("returns to the Codex prerequisite without polling when a recheck is still signed out", async () => {
    const ready = await ipc.quizProviderPreflight("codex-cli", "gpt-5.6-sol");
    const preflight = vi.spyOn(ipc, "quizProviderPreflight").mockResolvedValue({
      ...ready,
      available: false,
      authenticationRequired: true,
      message: "Codex is installed, but sign-in is required.",
    });
    const login = vi.spyOn(ipc, "quizProviderLogin");
    const generate = vi.spyOn(ipc, "generateQuiz");
    const user = await openQuizzes();

    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));
    await user.click(screen.getByRole("button", { name: /review evidence/i }));
    await user.click(screen.getByRole("button", { name: /generate in background/i }));
    await user.click(await screen.findByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("heading", { name: "Codex CLI sign-in required" }))
      .toBeInTheDocument();
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(login).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("recovers a generation-time Codex authentication loss without saving a failure", async () => {
    const ready = await ipc.quizProviderPreflight("codex-cli", "gpt-5.6-sol");
    const signedOut = {
      ...ready,
      available: false,
      authenticationRequired: true,
      message: "Codex CLI sign-in expired.",
    };
    const preflight = vi.spyOn(ipc, "quizProviderPreflight")
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(signedOut)
      .mockResolvedValueOnce(ready);
    const originalGenerate = ipc.generateQuiz;
    const generate = vi.spyOn(ipc, "generateQuiz")
      .mockResolvedValueOnce({
        requestId: "late-auth",
        state: "authentication-required",
        quizId: null,
        failureId: null,
        warnings: [],
        issues: [],
        message: "Provider authentication is required.",
      })
      .mockImplementation(originalGenerate);
    const user = await openQuizzes();

    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));
    await user.click(screen.getByRole("button", { name: /review evidence/i }));
    await user.click(screen.getByRole("button", { name: /generate in background/i }));

    expect(await screen.findByRole("heading", { name: "Codex CLI sign-in required" }))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("button", { name: "Open quizzes" })).toBeInTheDocument();
    expect(preflight).toHaveBeenCalledTimes(3);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("guides a signed-out Claude Code user through a visible sign-in window", async () => {
    const ready = await ipc.quizProviderPreflight("claude-cli", null);
    vi.spyOn(ipc, "quizProviderPreflight").mockResolvedValue({
      ...ready,
      available: false,
      authenticationRequired: true,
      message: "Claude Code is installed, but sign-in is required.",
    });
    const login = vi.spyOn(ipc, "quizProviderLogin");
    const user = await openQuizzes();

    await user.click(screen.getByRole("button", { name: /generate your first quiz/i }));
    await user.click(screen.getByRole("radio", { name: "Claude Code CLI" }));
    await user.click(screen.getByRole("button", { name: /review evidence/i }));
    await user.click(screen.getByRole("button", { name: /generate in background/i }));

    expect(await screen.findByRole("heading", { name: "Claude Code sign-in required" }))
      .toBeInTheDocument();
    expect(screen.getByText(/credentials are handled by the Claude Code CLI/i))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open sign-in window" }));

    expect(login).toHaveBeenCalledWith("claude-cli", "terminal");
    expect(await screen.findByRole("button", { name: "Open quizzes" })).toBeInTheDocument();
  });

  it("shows a persisted failed-generation card and retries its saved request", async () => {
    const originalPrepare = ipc.prepareQuizScope;
    const retryPreview = await originalPrepare({
      bundleRoot: "mock-bundle",
      scopeMode: "selected-documents",
      conceptIds: ["product/overview"],
      topic: null,
      baseRevisionId: null,
      headRevisionId: null,
      generation: { mode: "manual", length: "short", difficulty: "challenging", maxQuestions: 7 },
    });
    vi.spyOn(ipc, "listQuizGenerationFailures").mockResolvedValue([{
      failureId: "quiz-failure-saved",
      scopeMode: "selected-documents",
      scopeDescription: retryPreview.scopeDescription,
      providerKind: "codex-cli",
      providerProfile: "codex-cli",
      model: "gpt-saved-model",
      failedAt: "2026-08-03T10:30:00Z",
      failureKind: "provider-error",
      message: "The quiz provider failed: ERROR codex_models_manager::cache: failed to load models cache: unknown variant `max`, expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; raw model response follows",
      retryCount: 0,
      generation: retryPreview.generation,
    }]);
    const prepareRetry = vi.spyOn(ipc, "prepareQuizFailureRetry")
      .mockResolvedValue(retryPreview);
    const generate = vi.spyOn(ipc, "generateQuiz");
    const user = await openQuizzes();

    const cardHeading = await screen.findByRole("heading", {
      name: "Quiz generation failed",
    });
    const card = cardHeading.closest("article");
    expect(card).toHaveTextContent("Generation failed");
    expect(card).toHaveTextContent("short, challenging, up to 7 questions");
    expect(card).toHaveTextContent(
      "This Codex CLI cannot read the current Codex model catalog.",
    );
    expect(card).not.toHaveTextContent("codex_models_manager");
    expect(within(card!).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(card!).getByRole("button", { name: "Review settings" })).toBeInTheDocument();

    await user.click(within(card!).getByRole("button", { name: "Retry" }));
    expect(prepareRetry).toHaveBeenCalledWith(expect.any(String), "quiz-failure-saved");
    expect(await screen.findByRole("button", { name: "Open quizzes" })).toBeInTheDocument();
    expect(generate).toHaveBeenCalledWith(
      retryPreview.requestId,
      "codex-cli",
      "gpt-saved-model",
    );
  });

  it("opens persistent generator setup and exposes separate local and live CLI tests", async () => {
    const user = await openQuizzes();
    await user.click(screen.getByRole("button", { name: "Generate quiz" }));
    await user.click(screen.getByRole("button", { name: "Generator settings" }));

    expect(await screen.findByRole("heading", { name: "Quiz generators", level: 2 }))
      .toBeInTheDocument();
    const setupChecks = screen.getAllByRole("button", { name: "Check setup" });
    const liveTests = screen.getAllByRole("button", { name: "Run live test" });
    expect(setupChecks).toHaveLength(2);
    expect(liveTests).toHaveLength(2);
    expect(screen.getAllByText(/may consume provider credits/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("textbox", { name: /Model \(optional\)/i })[0])
      .toHaveValue("gpt-5.6-sol");
    expect(screen.getByRole("combobox", { name: /Reasoning effort/i }))
      .toHaveValue("high");

    await user.click(setupChecks[0]);
    expect((await screen.findAllByText(/Browser fixture provider is ready/)).length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole("button", { name: "Run live test" })[0]);
    expect((await screen.findAllByText(/Browser fixture provider is ready/)).length).toBeGreaterThan(0);
  });
});
