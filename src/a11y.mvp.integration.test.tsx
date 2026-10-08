import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import * as ipc from "@/shared/ipc.ts";
import { openBundle, renderApp } from "@/test/appHarness.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectNoViolations(node: Element) {
  const results = await axe.run(node, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

describe("focused reviewer accessibility", () => {
  it("has no structural violations on first run", async () => {
    const { container } = renderApp();
    await screen.findByRole("heading", { name: "OKF Reviewer" });
    await expectNoViolations(container);
  });

  it("has no structural violations while browsing a bundle", async () => {
    const user = userEvent.setup();
    const { container } = renderApp();
    await openBundle(user);
    await screen.findByRole("button", { name: "Navigate" });
    await expectNoViolations(container);
  });

  async function openChangedConcept(user: ReturnType<typeof userEvent.setup>) {
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
        "features/graph-view": [
          { start: 1, end: 1, previousText: "# Previous purpose" },
        ],
      },
      trustRequired: false,
      repositoryRoot: "C:\\fixture",
      message: null,
    });

    const view = renderApp();
    await openBundle(user);
    await user.click(screen.getByRole("treeitem", {
      name: /Graph View Modified in the current Git review batch/i,
    }));
    return view;
  }

  it("has no structural violations with a change preview open", async () => {
    const user = userEvent.setup();
    const { container } = await openChangedConcept(user);
    const changedHeading = container.querySelector<HTMLElement>("h2 .git-diff-change");
    changedHeading?.focus();
    await screen.findByRole("tooltip", { name: /What changed/i });

    await expectNoViolations(container);
  });

  it("has no structural violations with an in-place comparison open", async () => {
    const user = userEvent.setup();
    const { container } = await openChangedConcept(user);
    container.querySelector<HTMLElement>("h2 .git-diff-change")?.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("group", { name: "Earlier version" })).toHaveFocus();

    await expectNoViolations(container);
  });
});
