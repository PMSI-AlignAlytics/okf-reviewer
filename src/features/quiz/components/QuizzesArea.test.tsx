import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "@/shared/store.tsx";
import * as ipc from "@/shared/ipc.ts";
import type { QuizAttemptView, QuizGenerationFailureSummary, QuizSummary } from "../types.ts";
import { QuizzesArea } from "./QuizzesArea.tsx";

/** Keep the quiz subtree mounted while evidence is read, as the app shell does. */
function QuizWorkspace({ activeConcept = true }: { activeConcept?: boolean }) {
  const { state, actions } = useApp();
  return (
    <>
      <button onClick={() => void actions.openFolder()}>Open fixture bundle</button>
      {state.bundle && (
        <>
          <button onClick={() => {
            if (activeConcept) actions.selectConcept("product/overview");
            actions.setWorkspaceArea("quizzes");
          }}>Open quiz workspace</button>
          <button onClick={() => actions.setWorkspaceArea("reader")}>Read fixture evidence</button>
          <button
            disabled={state.quizGeneration !== null}
            onClick={() => actions.startQuickQuiz("product/overview")}
          >Quick fixture quiz</button>
          <div hidden={state.workspaceArea !== "quizzes"}>
            <QuizzesArea />
          </div>
        </>
      )}
    </>
  );
}

async function openWorkspace({ activeConcept = true } = {}) {
  const user = userEvent.setup();
  const rendered = render(
    <AppProvider><QuizWorkspace activeConcept={activeConcept} /></AppProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Open fixture bundle" }));
  await user.click(await screen.findByRole("button", { name: "Open quiz workspace" }));
  await screen.findByRole("heading", { name: "Quizzes", level: 1 });
  return { user, ...rendered };
}

async function openConfiguration() {
  const workspace = await openWorkspace();
  await workspace.user.click(await screen.findByRole("button", { name: "Generate your first quiz" }));
  await screen.findByRole("heading", { name: "Generate a quiz", level: 1 });
  return workspace;
}

describe("quiz workspace usability", () => {
  it("traps prompt focus, copies the unchanged prompt, and restores its trigger on Escape", async () => {
    const { user, container } = await openConfiguration();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "Review evidence" }));
    const trigger = await screen.findByRole("button", { name: "View generation prompt" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Generation prompt" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    const copy = within(dialog).getByRole("button", { name: "Copy prompt" });
    const prompt = within(dialog).getByRole("textbox", { name: "Prompt" });

    expect(container).not.toContainElement(dialog);
    await waitFor(() => expect(close).toHaveFocus());
    await user.tab({ shift: true });
    await waitFor(() => expect(copy).toHaveFocus());
    await user.tab();
    await waitFor(() => expect(close).toHaveFocus());
    await user.tab();
    expect(prompt).toHaveFocus();
    await user.click(copy);
    expect(writeText).toHaveBeenCalledWith((prompt as HTMLTextAreaElement).value);
    expect((prompt as HTMLTextAreaElement).value).toContain("Inspect Git read-only");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("describes the active configuration and sends the unchanged manual request fields", async () => {
    const prepare = vi.spyOn(ipc, "prepareQuizScope");
    const { user } = await openConfiguration();
    expect(screen.getByText(/Automatic mode is on/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Current document" })).toBeChecked();
    const scope = screen.getByRole("radiogroup", { name: "Quiz scope" });
    expect(within(scope).getAllByRole("radio")).toHaveLength(5);
    expect(within(scope).getByRole("group", { name: "Choose documents" })).toBeInTheDocument();
    expect(within(scope).getByRole("group", { name: "Use repository history" })).toBeInTheDocument();

    await user.click(screen.getByText("Advanced Options"));
    const manual = screen.getByRole("checkbox", { name: "Set length and difficulty manually" });
    await user.click(manual);
    expect(screen.queryByText(/Automatic mode is on/)).not.toBeInTheDocument();
    expect(screen.getByText(/Manual mode is on/)).toHaveTextContent("up to 20 questions");
    await user.click(screen.getByRole("radio", { name: "Short" }));
    await user.click(screen.getByRole("radio", { name: "Challenging" }));
    const maximum = screen.getByRole("spinbutton", { name: "Maximum questions" });
    await user.click(maximum);
    await user.keyboard("{Control>}a{/Control}7");
    expect(maximum).toHaveValue(7);
    expect(screen.getByText(/Manual mode is on/)).toHaveTextContent("up to 7 questions");
    await user.click(screen.getByRole("button", { name: "Review evidence" }));
    await screen.findByRole("heading", { name: "Confirm generation" });
    expect(prepare).toHaveBeenLastCalledWith({
      bundleRoot: expect.any(String),
      scopeMode: "current-document",
      conceptIds: ["product/overview"],
      topic: null,
      baseRevisionId: null,
      headRevisionId: null,
      generation: { mode: "manual", length: "short", difficulty: "challenging", maxQuestions: 7 },
    });
    await user.click(screen.getByRole("button", { name: "Change scope" }));
    await user.click(screen.getByText("Advanced Options"));
    await user.click(screen.getByRole("checkbox", { name: "Set length and difficulty manually" }));
    expect(screen.getByText(/Automatic mode is on/)).toBeInTheDocument();
    expect(screen.queryByText(/Manual mode is on/)).not.toBeInTheDocument();
  });

  it("defaults to document selection when no reader concept is open and retains every scope", async () => {
    const { user } = await openWorkspace({ activeConcept: false });
    await user.click(await screen.findByRole("button", { name: "Generate your first quiz" }));
    expect(screen.getByRole("radio", { name: "Selected documents" })).toBeChecked();
    for (const name of ["Current document", "Topic in this bundle", "Bundle changes", "Reviewed since last commit"]) {
      expect(screen.getByRole("radio", { name })).toBeEnabled();
    }
    expect(screen.getByRole("group", { name: "Bundle documents" })).toBeInTheDocument();
  });

  it("preserves an unfinished generation form while the reader is open", async () => {
    const { user } = await openConfiguration();
    await user.click(screen.getByRole("radio", { name: "Topic in this bundle" }));
    const topic = screen.getByRole("textbox", { name: "Topic restricted to this bundle" });
    await user.type(topic, "architecture");
    await user.click(screen.getByRole("button", { name: "Read fixture evidence" }));
    expect(screen.queryByRole("heading", { name: "Generate a quiz" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open quiz workspace" }));
    expect(screen.getByRole("radio", { name: "Topic in this bundle" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Topic restricted to this bundle" })).toHaveValue("architecture");
  });

  it.each(["quiz", "failure"] as const)("preserves an edited %s regeneration draft across provider refreshes", async (target) => {
    const quiz: QuizSummary = {
      quizId: "quiz-regeneration", title: "Saved quiz", scopeMode: "current-document",
      scopeDescription: "Overview", providerKind: "codex-cli", providerProfile: "codex-cli", model: null,
      generatedAt: "2026-10-08T10:00:00Z", questionCount: 2, attemptCount: 0,
      latestScore: null, latestTotal: null, stale: true, staleReason: "The document changed.",
    };
    const failure: QuizGenerationFailureSummary = {
      failureId: "failure-regeneration", scopeMode: "current-document", scopeDescription: "Overview",
      providerKind: "codex-cli", providerProfile: "codex-cli", model: null,
      failedAt: quiz.generatedAt, failureKind: "provider-error", message: "Generator unavailable.",
      retryCount: 0, generation: { mode: "automatic", length: null, difficulty: null, maxQuestions: 20 },
    };
    vi.spyOn(ipc, "listQuizzes").mockResolvedValue(target === "quiz" ? [quiz] : []);
    vi.spyOn(ipc, "listQuizGenerationFailures").mockResolvedValue(target === "failure" ? [failure] : []);
    const prepareRetry = vi.spyOn(ipc, target === "quiz" ? "prepareQuizRegeneration" : "prepareQuizFailureRetry")
      .mockImplementation((root) => ipc.prepareQuizScope({
        bundleRoot: root, scopeMode: "current-document", conceptIds: ["product/overview"],
        topic: null, baseRevisionId: null, headRevisionId: null, generation: failure.generation,
      }));
    const getProfiles = ipc.quizProviderProfiles;
    let refreshed = false;
    let includeClaude = true;
    vi.spyOn(ipc, "quizProviderProfiles").mockImplementation(async () =>
      (await getProfiles())
        .filter((profile) => includeClaude || profile.id !== "claude-cli")
        .map((profile) => profile.id === "claude-cli" && refreshed
          ? { ...profile, label: "Claude Code CLI refreshed" }
          : profile),
    );
    const { user } = await openWorkspace();
    await user.click(await screen.findByRole("button", { name: target === "quiz" ? "Regenerate" : "Review settings" }));
    await screen.findByRole("heading", { name: "Confirm generation" });
    await user.click(screen.getByRole("button", { name: "Change scope" }));
    await user.click(screen.getByText("Advanced Options"));
    await user.click(screen.getByRole("checkbox", { name: "Set length and difficulty manually" }));
    await user.click(screen.getByRole("radio", { name: "Long" }));
    await user.click(screen.getByRole("radio", { name: "Challenging" }));
    const maximum = screen.getByRole("spinbutton", { name: "Maximum questions" });
    await user.click(maximum);
    await user.keyboard("{Control>}a{/Control}7");
    await user.click(screen.getByRole("radio", { name: "Claude Code CLI" }));

    refreshed = true;
    await user.click(screen.getByRole("button", { name: "Read fixture evidence" }));
    await user.click(screen.getByRole("button", { name: "Open quiz workspace" }));
    expect(await screen.findByRole("radio", { name: "Claude Code CLI refreshed" })).toBeChecked();
    expect(screen.getByRole("heading", { name: "Generate a quiz" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Set length and difficulty manually" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Long" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Challenging" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Maximum questions" })).toHaveValue(7);
    expect(prepareRetry).toHaveBeenCalledTimes(1);

    includeClaude = false;
    await user.click(screen.getByRole("button", { name: "Read fixture evidence" }));
    await user.click(screen.getByRole("button", { name: "Open quiz workspace" }));
    await waitFor(() => expect(screen.queryByRole("radio", { name: "Claude Code CLI refreshed" })).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "Codex CLI" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Set length and difficulty manually" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Long" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Challenging" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Maximum questions" })).toHaveValue(7);
    expect(prepareRetry).toHaveBeenCalledTimes(1);
  });

  it("handles consecutive quick launches in the same mounted workspace and returns to refreshed history", async () => {
    const generate = vi.spyOn(ipc, "generateQuiz");
    const prepare = vi.spyOn(ipc, "prepareQuizScope");
    const { user } = await openWorkspace();
    const quick = screen.getByRole("button", { name: "Quick fixture quiz" });
    await user.click(quick);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(quick).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Open quiz workspace" }));
    expect(await screen.findByRole("button", { name: "Start quiz" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Preparing quiz" })).not.toBeInTheDocument();
    await user.click(quick);
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenLastCalledWith({
      bundleRoot: expect.any(String),
      scopeMode: "current-document",
      conceptIds: ["product/overview"],
      topic: null,
      baseRevisionId: null,
      headRevisionId: null,
      generation: { mode: "automatic", length: null, difficulty: null, maxQuestions: 20 },
    });
    await waitFor(() => expect(quick).toBeEnabled());
  });

  it("keeps a selected answer while reading evidence and advances the accessible progress value", async () => {
    const quiz: QuizSummary = {
      quizId: "quiz-persistence", title: "Reader persistence quiz", scopeMode: "current-document",
      scopeDescription: "Overview", providerKind: "codex-cli", providerProfile: "codex-cli", model: null,
      generatedAt: "2026-10-08T10:00:00Z", questionCount: 2, attemptCount: 0,
      latestScore: null, latestTotal: null, stale: false, staleReason: null,
    };
    const first: QuizAttemptView = {
      summary: { attemptId: "attempt-persistence", quizId: quiz.quizId, startedAt: quiz.generatedAt,
        completedAt: null, answered: 0, excluded: 0, total: 2, correct: 0 },
      nextQuestion: { attemptId: "attempt-persistence", quizId: quiz.quizId, questionId: "question-1",
        index: 0, total: 2, category: "architecture", criticality: "important", prompt: "First question",
        choices: [{ id: "A", text: "First answer" }, { id: "B", text: "Second answer" }], alreadyAnswered: false },
      stale: false, staleReason: null,
    };
    const second: QuizAttemptView = {
      ...first,
      summary: { ...first.summary, answered: 1, correct: 1 },
      nextQuestion: { ...first.nextQuestion!, questionId: "question-2", index: 1, prompt: "Second question" },
    };
    vi.spyOn(ipc, "listQuizzes").mockResolvedValue([quiz]);
    vi.spyOn(ipc, "startQuizAttempt").mockResolvedValue(first);
    vi.spyOn(ipc, "resumeQuizAttempt").mockResolvedValue(second);
    vi.spyOn(ipc, "submitQuizAnswer").mockResolvedValue({
      attemptId: "attempt-persistence", questionId: "question-1", selectedChoiceId: "A",
      correct: true, correctChoiceId: "A", explanation: "Documented in the bundle.", evidence: [], completed: false,
    });
    const { user } = await openWorkspace();
    await user.click(await screen.findByRole("button", { name: "Start quiz" }));
    await screen.findByRole("heading", { name: "First question" });
    const firstProgress = screen.getByRole("progressbar", { name: "Quiz progress" });
    expect(firstProgress).toHaveAttribute("aria-valuenow", "1");
    await user.click(screen.getByRole("radio", { name: "A First answer" }));
    await user.click(screen.getByRole("button", { name: "Read fixture evidence" }));
    await user.click(screen.getByRole("button", { name: "Open quiz workspace" }));
    expect(screen.getByRole("radio", { name: "A First answer" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Submit answer" }));
    await user.click(await screen.findByRole("button", { name: "Next question" }));
    await screen.findByRole("heading", { name: "Second question" });
    const nextProgress = screen.getByRole("progressbar", { name: "Quiz progress" });
    expect(nextProgress).toHaveAttribute("aria-valuenow", "2");
  });
});
