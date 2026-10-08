import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openBundle, renderApp } from "@/test/appHarness.tsx";
import { PacerIndex } from "@/features/reader/pacerLocate.ts";
import * as ipc from "@/shared/ipc.ts";
import { MOCK_BUNDLE, MOCK_GIT_STATUS } from "@/mock/fixture.ts";
import { DEFAULT_SETTINGS } from "@/shared/types.ts";

afterEach(() => vi.restoreAllMocks());

async function openConcept(user: ReturnType<typeof userEvent.setup>) {
  renderApp();
  await openBundle(user);
  await user.click(screen.getByRole("treeitem", { name: /Graph View/ }));
  await screen.findByRole("heading", { name: "Graph View", level: 1 });
}

describe("reader suspension across workspaces", () => {
  it("can preview the same authored link again after returning to the reader", async () => {
    const user = userEvent.setup();
    vi.spyOn(ipc, "readBundleGitStatus").mockResolvedValue({
      ...MOCK_GIT_STATUS, modifiedConceptIds: [], lineChangesByConcept: {},
    });
    await openConcept(user);
    const link = screen.getByRole("link", { name: "reader" });
    fireEvent.mouseOver(link);
    await screen.findByRole("tooltip", { name: "Preview: Concept Reader" });
    fireEvent.click(screen.getByRole("button", { name: "Quizzes" }));
    await screen.findByRole("heading", { name: "Quizzes", level: 1 });
    expect(screen.queryByRole("tooltip", { name: "Preview: Concept Reader" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Quizzes" }));
    await screen.findByRole("heading", { name: "Graph View", level: 1 });
    fireEvent.mouseOver(link);
    expect(await screen.findByRole("tooltip", { name: "Preview: Concept Reader" })).toBeInTheDocument();
  });

  it("uses the same logical heading activation threshold under interface magnification", async () => {
    const user = userEvent.setup();
    vi.spyOn(ipc, "loadSettings").mockResolvedValue({ ...DEFAULT_SETTINGS, uiScale: 2 });
    vi.spyOn(ipc, "readBundle").mockResolvedValue({
      ...MOCK_BUNDLE,
      concepts: MOCK_BUNDLE.concepts.map((concept) => concept.id === "features/graph-view" ? {
        ...concept,
        body: "# First\n\nFirst paragraph.\n\n# Middle\n\nMiddle paragraph.\n\n# Last\n\nLast paragraph.",
      } : concept),
    });
    await openConcept(user);
    const scroller = document.querySelector<HTMLElement>(".pane.reader")!;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 400, configurable: true },
      scrollTop: { value: 100, configurable: true },
    });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 400));
    const headings = scroller.querySelectorAll<HTMLElement>(".body.markdown h2");
    [0, 180, 600].forEach((top, index) => {
      vi.spyOn(headings[index], "getBoundingClientRect").mockReturnValue(new DOMRect(0, top, 300, 40));
    });
    fireEvent.scroll(scroller);
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "On this page" }))
      .getByRole("button", { name: "Middle" })).toHaveAttribute("aria-current", "location"));
  });

  it("dismisses a retained reader preference portal when entering quizzes", async () => {
    const user = userEvent.setup();
    await openConcept(user);
    await user.click(screen.getByRole("button", { name: "Reading preferences" }));
    expect(await screen.findByRole("dialog", { name: "Reading preferences" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Quizzes" }));
    await screen.findByRole("heading", { name: "Quizzes", level: 1 });
    expect(screen.queryByRole("dialog", { name: "Reading preferences" })).not.toBeInTheDocument();
  });

  it.each(["focus", "guided"] as const)("suspends a retained %s reading session and restores it on return", async (mode) => {
    const user = userEvent.setup();
    vi.spyOn(PacerIndex.prototype, "rect").mockReturnValue(null);
    await openConcept(user);
    if (mode === "focus") {
      await user.click(screen.getByRole("button", { name: "Speed-read this concept" }));
      await screen.findByRole("dialog", { name: "Speed reading: Graph View" });
    } else {
      await user.click(screen.getByRole("button", { name: "Reading preferences" }));
      await user.click(await screen.findByRole("button", { name: "Guided" }));
      await screen.findByRole("group", { name: "Guided pacing" });
    }
    // The app can switch its retained workspace without unmounting Reader.
    fireEvent.click(screen.getByRole("button", { name: "Quizzes" }));
    await screen.findByRole("heading", { name: "Quizzes", level: 1 });
    expect(document.querySelector(".speedread, .pacer-bar, .reading-beam")).toBeNull();
    const key = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    await user.click(screen.getByRole("button", { name: "Quizzes" }));
    await screen.findByRole("heading", { name: "Graph View", level: 1 });
    await waitFor(() => expect(document.querySelector(mode === "focus" ? ".speedread" : ".pacer-bar")).not.toBeNull());
  });
});
