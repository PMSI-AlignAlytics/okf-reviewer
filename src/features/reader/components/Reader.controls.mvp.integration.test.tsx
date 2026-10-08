import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ipc from "@/shared/ipc.ts";
import { MOCK_BUNDLE } from "@/mock/fixture.ts";
import { openBundle, renderApp } from "@/test/appHarness.tsx";

afterEach(() => vi.restoreAllMocks());

async function showChangedConcept(user: ReturnType<typeof userEvent.setup>) {
  vi.spyOn(ipc, "readBundleGitStatus").mockResolvedValue({
    available: true,
    headRevision: "abcdef0123456789",
    comparisonMode: "working-tree",
    currentBranch: "main",
    defaultBranch: "main",
    baseRevision: "abcdef0123456789",
    modifiedConceptIds: ["features/graph-view"],
    deletedPaths: [],
    lineChangesByConcept: {
      "features/graph-view": [{ start: 1, end: 1, previousText: "# Previous purpose" }],
    },
    trustRequired: false,
    repositoryRoot: "C:\\fixture",
    message: null,
  });
  renderApp();
  await openBundle(user);
  await user.click(screen.getByRole("treeitem", { name: /Graph View/ }));
  await screen.findByRole("heading", { name: "Graph View", level: 1 });
}

describe("reader comparison and folder controls", () => {
  it("opens the named control with Enter and returns focus and expanded state on Escape", async () => {
    const user = userEvent.setup();
    await showChangedConcept(user);
    const control = screen.getByRole("button", { name: "Compare changes" });
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(control).toHaveAttribute("aria-controls", "git-diff-compare-0");
    expect(screen.getByText(/and marked blocks have changed/)).toBeInTheDocument();
    control.focus();
    await user.keyboard("{Enter}");
    const panel = await screen.findByRole("group", { name: "Earlier version" });
    expect(panel).toHaveFocus();
    expect(panel.id).toBe("git-diff-compare-0");
    expect(screen.getByRole("button", { name: "Compare changes" })).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Earlier version" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare changes" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Compare changes" })).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps passage activation and returns focus to the route that opened a comparison", async () => {
    const user = userEvent.setup();
    await showChangedConcept(user);
    const body = document.querySelector(".body.markdown")!;
    const passage = () => body.querySelector<HTMLElement>("h2 .git-diff-change")!;
    expect(passage().getAttribute("role")).toBeNull();
    passage().focus();
    await user.keyboard("{Enter}");
    const panel = await screen.findByRole("group", { name: "Earlier version" });
    expect(panel).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(passage()).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Compare changes" }));
    await user.click(screen.getByRole("button", { name: "Close comparison" }));
    expect(screen.getByRole("button", { name: "Compare changes" })).toHaveFocus();
  });

  it("opens ancestor homes and supports modifier background and foreground tabs", async () => {
    const user = userEvent.setup();
    await showChangedConcept(user);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("button", { name: MOCK_BUNDLE.name })).toBeInTheDocument();
    await user.keyboard("{Control>}");
    await user.click(within(crumbs).getByRole("button", { name: "Features" }));
    await user.keyboard("{/Control}");
    expect(screen.getByRole("heading", { name: "Graph View", level: 1 })).toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "Open concepts" });
    expect(within(tabs).getByRole("tab", { name: "features/index" })).toHaveAttribute("aria-selected", "false");
    await user.keyboard("{Control>}{Shift>}");
    await user.click(within(crumbs).getByRole("button", { name: MOCK_BUNDLE.name }));
    await user.keyboard("{/Shift}{/Control}");
    expect(await screen.findByRole("heading", { name: MOCK_BUNDLE.name, level: 1 })).toBeInTheDocument();
    await user.click(within(tabs).getByRole("tab", { name: /Graph View/ }));
    await user.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Features" }));
    expect(await screen.findByRole("heading", { name: "Features", level: 1 })).toBeInTheDocument();
  });
});
