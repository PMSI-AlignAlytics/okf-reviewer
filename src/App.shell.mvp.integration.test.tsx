import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ipc from "@/shared/ipc.ts";
import { MOCK_BUNDLE, MOCK_GIT_STATUS } from "@/mock/fixture.ts";
import { openBundle, renderApp } from "@/test/appHarness.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("focused reviewer shell", () => {
  it("offers only local bundle review on first run", async () => {
    renderApp();

    expect(
      await screen.findByRole("heading", { name: "OKF Reviewer" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /open local folder/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/agent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/open from url/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/new bundle/i)).not.toBeInTheDocument();
  });

  it("browses concepts and exposes lifecycle and review filters without Studio tools", async () => {
    const user = userEvent.setup();
    renderApp();
    await openBundle(user);

    expect(screen.getByRole("button", { name: "Navigate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search concepts" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Workspace layout" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /agent/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByRole("group", { name: "Lifecycle" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Human review" })).toBeInTheDocument();
  });

  it("marks actionable review work in files and collapsed directories", async () => {
    const user = userEvent.setup();
    const bundle = {
      ...MOCK_BUNDLE,
      concepts: MOCK_BUNDLE.concepts.map((concept) => {
        if (concept.id === "features/graph-view") {
          return {
            ...concept,
            verified: [{ by: "human:alex", at: "2026-08-20T09:00:00Z" }],
          };
        }
        if (concept.id === "features/concept-reader") {
          return { ...concept, status: "deprecated" as const };
        }
        return concept;
      }),
    };
    vi.spyOn(ipc, "readBundle").mockResolvedValue(bundle);
    // Human-review markers only: no concept is modified in Git.
    vi.spyOn(ipc, "readBundleGitStatus").mockResolvedValue({
      ...MOCK_GIT_STATUS,
      modifiedConceptIds: [],
      lineChangesByConcept: {},
    });

    renderApp();
    await openBundle(user);

    expect(screen.getByRole("treeitem", { name: "Graph View" })).not.toHaveTextContent("Review");
    expect(screen.getByRole("treeitem", { name: "Concept Reader" })).not.toHaveTextContent("Review");
    expect(screen.getByRole("treeitem", {
      name: /Speed Reading Needs human review/i,
    })).toHaveTextContent("Review");
    const designReviewCount = screen.getByText("Review 8");
    expect(designReviewCount).toHaveAttribute(
      "aria-label",
      "8 concepts need human review",
    );
    expect(designReviewCount.closest("[role='treeitem']")).toHaveTextContent("design/");

    await user.type(
      screen.getByLabelText("Search and filter concepts"),
      "review:human-reviewed",
    );
    const dimmedPending = screen.getByRole("treeitem", {
      name: /Speed Reading Needs human review/i,
    });
    expect(dimmedPending).toHaveClass("is-dimmed");
    expect(dimmedPending).toHaveTextContent("Review");
  });

  it("marks a previously reviewed concept when its content is newer", async () => {
    const user = userEvent.setup();
    const bundle = {
      ...MOCK_BUNDLE,
      concepts: MOCK_BUNDLE.concepts.map((concept) =>
        concept.id === "features/graph-view"
          ? {
              ...concept,
              generated: { by: "agent/1", at: "2026-08-21T09:00:00Z" },
              verified: [{ by: "human:alex", at: "2026-08-20T09:00:00Z" }],
            }
          : concept
      ),
    };
    vi.spyOn(ipc, "readBundle").mockResolvedValue(bundle);

    renderApp();
    await openBundle(user);

    const treeItems = screen.getAllByRole("treeitem");
    const graphView = treeItems.find((item) => item.textContent?.includes("Graph View"));
    expect(graphView).toHaveTextContent("Review");
    expect(graphView).toHaveAccessibleName(/Needs human review/i);

    await user.click(screen.getByRole("button", { name: "Filter" }));
    const requiredFilter = screen.getByText("Needs review").closest("button");
    expect(requiredFilter).not.toBeNull();
    expect(requiredFilter).toHaveTextContent("1");
  });

  it("keeps Git changes and human-review markers separate without changing counts", async () => {
    const user = userEvent.setup();
    const bundle = {
      ...MOCK_BUNDLE,
      concepts: MOCK_BUNDLE.concepts.map((concept) =>
        concept.id === "features/graph-view"
          ? {
              ...concept,
              verified: [{ by: "human:alex", at: "2026-08-20T09:00:00Z" }],
            }
          : concept
      ),
    };
    vi.spyOn(ipc, "readBundle").mockResolvedValue(bundle);
    vi.spyOn(ipc, "readBundleGitStatus")
      .mockResolvedValueOnce({
        available: true,
        headRevision: "abcdef0123456789",
        comparisonMode: "feature-branch",
        currentBranch: "feature/test",
        defaultBranch: "main",
        baseRevision: "abcdef0123456789",
        modifiedConceptIds: ["features/graph-view", "features/speed-reading"],
        deletedPaths: [],
        trustRequired: false,
        repositoryRoot: "C:\\fixture",
        message: null,
      })
      .mockResolvedValue({
        available: true,
        headRevision: "fedcba9876543210",
        comparisonMode: "working-tree",
        currentBranch: "main",
        defaultBranch: "main",
        baseRevision: "fedcba9876543210",
        modifiedConceptIds: [],
        deletedPaths: [],
        trustRequired: false,
        repositoryRoot: "C:\\fixture",
        message: null,
      });

    renderApp();
    await openBundle(user);

    const batch = screen.getByRole("region", { name: "Feature review batch" });
    expect(batch).toHaveTextContent("feature/test from main");
    expect(batch).toHaveTextContent("2 changed");
    expect(batch).toHaveTextContent("1 reviewed");
    expect(batch).toHaveTextContent("1 outstanding");
    expect(batch).toHaveTextContent("Baseline abcdef01");

    const reviewedModified = screen.getByRole("treeitem", {
      name: /Graph View Modified in the current Git review batch Human reviewed; changed in the current Git review batch/i,
    });
    expect(reviewedModified.querySelector(".sb-tree-review-badge"))
      .not.toBeInTheDocument();
    expect(within(reviewedModified).getByLabelText("Modified in the current Git review batch"))
      .toHaveTextContent("Changed");
    expect(reviewedModified.querySelector(".sb-tree-git-reviewed"))
      .toHaveTextContent("Reviewed");
    const pendingModified = screen.getByRole("treeitem", {
      name: /Speed Reading Modified in the current Git review batch Needs human review/i,
    });
    expect(within(pendingModified).getByLabelText("Modified in the current Git review batch"))
      .toHaveTextContent("Changed");
    expect(pendingModified.querySelector(".sb-tree-review-badge"))
      .toHaveAccessibleName("Needs human review");
    const featuresFolder = screen.getByRole("treeitem", {
      name: /Features Contains documents modified in the current Git review batch/i,
    });
    expect(within(featuresFolder).getByLabelText("Contains documents modified in the current Git review batch"))
      .toHaveTextContent("Changed");
    expect(featuresFolder.querySelector(".sb-tree-review-count"))
      .toHaveAccessibleName(/concepts? needs? human review/i);
    expect(featuresFolder.querySelector(".sb-tree-git-reviewed"))
      .not.toBeInTheDocument();
    expect(screen.getByText("Review 8")).toHaveAttribute(
      "aria-label",
      "8 concepts need human review",
    );

    await user.click(screen.getByRole("button", { name: "Refresh feature review batch" }));
    await waitFor(() => {
      expect(screen.getByRole("treeitem", { name: "Graph View" }))
        .not.toHaveTextContent("Review");
    });
    const pendingAfterCommit = screen.getByRole("treeitem", {
      name: /Speed Reading Needs human review/i,
    });
    expect(within(pendingAfterCommit).queryByLabelText("Modified in the current Git review batch"))
      .not.toBeInTheDocument();
    expect(pendingAfterCommit.querySelector(".sb-tree-review-badge"))
      .toHaveAccessibleName("Needs human review");
  });

  it("colours current Git diff text, previews word changes and compares in place", async () => {
    const user = userEvent.setup();
    const currentParagraph = MOCK_BUNDLE.concepts
      .find((concept) => concept.id === "features/graph-view")
      ?.body.split("\n")[2] ?? "";
    const previousParagraph = currentParagraph.replace("force-directed graph", "node-link diagram");
    expect(previousParagraph).not.toBe(currentParagraph);
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
          { start: 3, end: 3, previousText: previousParagraph },
        ],
      },
      trustRequired: false,
      repositoryRoot: "C:\\fixture",
      message: null,
    });

    renderApp();
    await openBundle(user);
    await user.click(screen.getByRole("treeitem", {
      name: /Graph View Modified in the current Git review batch/i,
    }));

    const readerBody = () => document.querySelector(".body.markdown");
    const heading = () => readerBody()?.querySelector<HTMLElement>("h2 .git-diff-change");
    const paragraph = () => readerBody()?.querySelector<HTMLElement>("p .git-diff-change");
    expect(heading()?.textContent).toBe("What it does");
    expect(paragraph()?.textContent).toContain("force-directed graph");
    expect(paragraph()?.querySelector("a[data-link='concept']")).toHaveTextContent("reader");
    expect(readerBody()?.querySelector("mark.git-diff-change")).toBeNull();

    // Hover previews the word changes, not the whole previous source.
    await user.hover(heading()!);
    const preview = await screen.findByRole("tooltip", { name: /What changed/i });
    expect(preview.querySelector("del")?.textContent).toBe("Removed: Previous purpose");
    expect(preview.querySelector("ins")?.textContent).toBe("Added: What it does");
    expect(preview).toHaveTextContent(/Click or press Enter to compare in place/);
    expect(heading()).toHaveAttribute("aria-describedby", preview.id);
    await user.hover(preview);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.unhover(preview);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    // A click opens the comparison beside its explicit control, directly below
    // the paragraph, and leaves focus with the reader.
    await user.click(paragraph()!);
    const panel = await screen.findByRole("group", { name: "Earlier version, change 2 of 2" });
    const controls: Element | null = panel.previousElementSibling;
    expect(controls).toHaveClass("git-diff-controls");
    expect(controls?.previousElementSibling?.tagName).toBe("P");
    expect(controls?.querySelector("button[data-git-compare-toggle]"))
      .toHaveAttribute("aria-expanded", "true");
    expect(panel.querySelector("del")?.textContent).toBe("Removed: node-link diagram");
    expect(panel.querySelector("ins")?.textContent).toBe("Added: force-directed graph");
    expect(panel).not.toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(paragraph()).toHaveClass("is-comparing");

    // An open comparison needs no preview.
    await user.hover(paragraph()!);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Previous text" }));
    const previousView = screen.getByRole("group", { name: "Earlier version, change 2 of 2" });
    expect(previousView.querySelector(".git-diff-compare-text")?.textContent).toBe(previousParagraph);
    expect(within(previousView).getByRole("button", { name: "Previous text" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(within(previousView).getByRole("button", { name: "Previous text" })).toHaveFocus();

    await user.click(within(previousView).getByRole("button", { name: "Close comparison" }));
    expect(screen.queryByRole("group", { name: /Earlier version/ })).not.toBeInTheDocument();
    expect(paragraph()).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    // From the keyboard: focus previews, Enter opens and moves into the
    // comparison, Escape closes it and returns to the passage.
    heading()?.focus();
    expect(await screen.findByRole("tooltip", { name: /What changed/i })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    const headingPanel = await screen.findByRole("group", { name: "Earlier version, change 1 of 2" });
    expect(headingPanel).toHaveFocus();
    expect(headingPanel.previousElementSibling).toHaveClass("git-diff-controls");
    expect(headingPanel.previousElementSibling?.previousElementSibling?.tagName).toBe("H2");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: /Earlier version/ })).not.toBeInTheDocument();
    expect(heading()).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    // A link inside a changed passage keeps its own focus and Enter; focusing
    // it previews the passage's change.
    const changedLink = paragraph()?.querySelector<HTMLElement>("a[data-link='concept']");
    changedLink?.focus();
    const focusPreview = await screen.findByRole("tooltip", { name: /What changed/i });
    expect(focusPreview.querySelector("ins")?.textContent).toBe("Added: force-directed graph");
    expect(changedLink).toHaveAttribute("aria-describedby", focusPreview.id);
    expect(screen.queryByLabelText(/Preview:/i)).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(changedLink).not.toHaveAttribute("aria-describedby");
  });

  it("confirms exact app-local repository trust before enabling Git markers", async () => {
    const user = userEvent.setup();
    const repositoryRoot = "C:\\fixture owner\\knowledge repository";
    vi.spyOn(ipc, "readBundleGitStatus").mockResolvedValue({
      available: false,
      headRevision: null,
      comparisonMode: "unavailable",
      currentBranch: null,
      defaultBranch: null,
      baseRevision: null,
      modifiedConceptIds: [],
      deletedPaths: [],
      trustRequired: true,
      repositoryRoot,
      message: "Confirmation required.",
    });
    const trust = vi.spyOn(ipc, "trustBundleRepository").mockResolvedValue({
      available: true,
      headRevision: "abcdef0123456789",
      comparisonMode: "working-tree",
      currentBranch: "main",
      defaultBranch: "main",
      baseRevision: "abcdef0123456789",
      modifiedConceptIds: ["features/graph-view"],
      deletedPaths: [],
      trustRequired: false,
      repositoryRoot,
      message: null,
    });

    renderApp();
    await user.click(screen.getAllByRole("button", { name: /open folder/i })[0]);

    const dialog = await screen.findByRole("dialog", {
      name: "Enable read-only Git inspection?",
    });
    expect(within(dialog).getByText(repositoryRoot)).toBeInTheDocument();
    expect(within(dialog).getByText(/Git configuration is not changed/i))
      .toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", {
      name: "Enable read-only Git",
    }));
    await waitFor(() => {
      expect(trust).toHaveBeenCalledWith(MOCK_BUNDLE.root, repositoryRoot);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", {
        name: "Enable read-only Git inspection?",
      })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("treeitem", {
      name: /Graph View Modified in the current Git review batch/i,
    })).toHaveTextContent("Review");
  });

  it("allows repository trust to be declined without changing Git configuration", async () => {
    const user = userEvent.setup();
    vi.spyOn(ipc, "readBundleGitStatus").mockResolvedValue({
      available: false,
      headRevision: null,
      comparisonMode: "unavailable",
      currentBranch: null,
      defaultBranch: null,
      baseRevision: null,
      modifiedConceptIds: [],
      deletedPaths: [],
      trustRequired: true,
      repositoryRoot: "C:\\fixture",
      message: "Confirmation required.",
    });
    const trust = vi.spyOn(ipc, "trustBundleRepository");

    renderApp();
    await user.click(screen.getAllByRole("button", { name: /open folder/i })[0]);
    const dialog = await screen.findByRole("dialog", {
      name: "Enable read-only Git inspection?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Not now" }));

    expect(trust).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", {
        name: "Enable read-only Git inspection?",
      })).not.toBeInTheDocument();
    });
  });

  it("typesets accessible math in indexes, concepts, and the bundle log", async () => {
    const user = userEvent.setup();
    renderApp();
    await openBundle(user);

    await waitFor(() => {
      expect(document.querySelector(".fh-intro .katex")).toBeInTheDocument();
    });
    expect(document.querySelector(".fh-intro math")).not.toBeNull();

    await user.click(screen.getByRole("treeitem", { name: /Concept Reader/i }));
    await screen.findByRole("heading", { name: "Concept Reader", level: 1 });
    await waitFor(() => {
      expect(document.querySelector(".body.markdown .katex")).toBeInTheDocument();
    });
    expect(document.querySelector(".body.markdown math")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Toggle bundle log" }));
    const log = await screen.findByLabelText("Change log");
    await waitFor(() => {
      expect(log.querySelector(".katex")).toBeInTheDocument();
    });
    expect(log.querySelector("math")).not.toBeNull();
  });

  it("removes the current registration while explicitly keeping files on disk", async () => {
    const user = userEvent.setup();
    const forget = vi.spyOn(ipc, "forgetBundle").mockResolvedValue([]);
    renderApp();
    await openBundle(user);
    await user.click(screen.getByRole("button", { name: "Switch bundle" }));

    const switcher = await screen.findByLabelText("Bundle switcher");
    const remove = within(switcher).getByRole("button", {
      name: "Remove current bundle",
    });
    expect(remove).toHaveAttribute(
      "title",
      "Remove this app reference. Files stay on disk.",
    );
    await user.click(remove);

    expect(forget).toHaveBeenCalledWith("/mock/workspace/docs");
    expect(
      await screen.findByRole("heading", { name: "OKF Reviewer" }),
    ).toBeInTheDocument();
  });
});
