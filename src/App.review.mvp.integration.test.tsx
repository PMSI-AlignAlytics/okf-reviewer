import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ipc from "@/shared/ipc.ts";
import { MOCK_BUNDLE } from "@/mock/fixture.ts";
import { DEFAULT_SETTINGS } from "@/shared/types.ts";
import type { ReviewPreflight } from "@/features/review/types.ts";
import {
  fillText,
  openBundleAtOverview,
  renderApp,
} from "@/test/appHarness.tsx";

function preflight(
  overrides: Partial<ReviewPreflight> = {},
): ReviewPreflight {
  return {
    available: true,
    reasonCode: null,
    message:
      "Status is implicitly stable. This review will author status: stable and append a human verification record.",
    conceptId: "product/overview",
    relativePath: "product/overview.md",
    fingerprint: "fixture-fingerprint",
    currentStatus: "stable",
    statusExplicit: false,
    reviewState: "unverified",
    reviewerHasReviewed: false,
    actionLabel: "Mark as reviewed",
    resultingStatus: "stable",
    reviewedAt: "2026-07-30T09:10:11Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("human concept review MVP", () => {
  it("collects a missing reviewer, confirms the exact change, and reloads", async () => {
    const user = userEvent.setup();
    const reviewedBundle = {
      ...MOCK_BUNDLE,
      concepts: MOCK_BUNDLE.concepts.map((concept) =>
        concept.id === "product/overview"
          ? {
              ...concept,
              status: "stable" as const,
              statusExplicit: true,
              verified: [
                ...concept.verified,
                { by: "human:alex", at: "2026-07-30T09:10:11Z" },
              ],
            }
          : concept
      ),
    };
    let applied = false;
    vi.spyOn(ipc, "readBundle").mockImplementation(() =>
      Promise.resolve(applied ? reviewedBundle : MOCK_BUNDLE)
    );
    vi.spyOn(ipc, "readBundleGitStatus").mockImplementation(() =>
      Promise.resolve({
        available: true,
        headRevision: "abcdef0123456789",
        comparisonMode: "working-tree",
        currentBranch: "main",
        defaultBranch: "main",
        baseRevision: "abcdef0123456789",
        modifiedConceptIds: applied ? ["product/overview"] : [],
        deletedPaths: [],
        trustRequired: false,
        repositoryRoot: "C:\\fixture",
        message: null,
      })
    );
    vi.spyOn(ipc, "reviewConceptPreflight").mockResolvedValue(preflight());
    const apply = vi.spyOn(ipc, "reviewConcept").mockImplementation(() => {
      applied = true;
      return Promise.resolve({
        conceptId: "product/overview",
        relativePath: "product/overview.md",
        fingerprint: "updated-fingerprint",
        status: "stable",
        statusExplicit: true,
        actor: "human:alex",
        reviewedAt: "2026-07-30T09:10:11Z",
        verificationCount: 1,
        message: "Human review recorded.",
      });
    });

    renderApp();
    await openBundleAtOverview(user);
    const pendingOverview = screen.getByRole("treeitem", {
      name: /Overview Needs human review/i,
    });
    expect(pendingOverview).toHaveClass("is-active");
    expect(pendingOverview).toHaveTextContent("Review");
    await user.click(await screen.findByRole("button", { name: "Mark as reviewed" }));

    expect(
      screen.getByRole("heading", { name: "Set reviewer identity" }),
    ).toBeInTheDocument();
    await fillText(user, screen.getByRole("textbox", { name: "Reviewer ID" }), "alex");
    await fillText(user, screen.getByRole("textbox", { name: "Name (optional)" }), "Alex Lee");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("heading", { name: "Confirm human review" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("product/overview.md")).not.toHaveLength(0);
    expect(screen.getByText(/stable \(implicit\).*stable/)).toBeInTheDocument();
    expect(screen.getByText("human:alex")).toBeInTheDocument();
    expect(screen.getByText("2026-07-30T09:10:11Z")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm review" }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({
        bundleRoot: "/mock/workspace/docs",
        conceptId: "product/overview",
        reviewerId: "alex",
        expectedFingerprint: "fixture-fingerprint",
        reviewedAt: "2026-07-30T09:10:11Z",
      }));
    expect(await screen.findByText("Human review recorded.")).toBeInTheDocument();
    const reviewedModified = await screen.findByRole("treeitem", {
      name: /Overview Modified in the current Git review batch Human reviewed; changed in the current Git review batch/i,
    });
    expect(reviewedModified).toHaveTextContent("Changed");
    expect(reviewedModified).toHaveTextContent("Reviewed");
    expect(reviewedModified.querySelector(".sb-tree-review-badge"))
      .not.toBeInTheDocument();
    expect(reviewedModified).not.toHaveAccessibleName(/needs human review/i);
    expect(reviewedModified.querySelector(".sb-tree-git-reviewed"))
      .toBeInTheDocument();
    expect(
      await screen.findAllByLabelText(
        "Contains human-reviewed documents changed in the current Git review batch",
      ),
    ).not.toHaveLength(0);
  });

  it("uses reviewer-aware action labels and explains a disabled concept", async () => {
    const user = userEvent.setup();
    vi.spyOn(ipc, "loadSettings").mockResolvedValue({
      ...DEFAULT_SETTINGS,
      reviewerId: "alex",
    });
    vi.spyOn(ipc, "reviewConceptPreflight").mockResolvedValue(
      preflight({
        available: false,
        reasonCode: "deprecated",
        message: "Deprecated concepts are historical. Review is unavailable by default.",
        actionLabel: null,
        resultingStatus: null,
      }),
    );

    renderApp();
    await openBundleAtOverview(user);
    const button = await screen.findByRole("button", { name: "Review unavailable" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Deprecated concepts are historical. Review is unavailable by default.",
    );
    expect(screen.getByText("Deprecated concepts are historical. Review is unavailable by default.")).toBeVisible();
  });
});
