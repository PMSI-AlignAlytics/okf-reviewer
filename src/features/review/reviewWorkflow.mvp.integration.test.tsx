import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ipc from "@/shared/ipc.ts";
import { MOCK_BUNDLE, MOCK_GIT_STATUS } from "@/mock/fixture.ts";
import type { Bundle, BundleGitStatus } from "@/shared/types.ts";
import { DEFAULT_SETTINGS } from "@/shared/types.ts";
import type { ReviewPreflight } from "@/features/review/types.ts";
import { fillText, openBundle, openBundleAtOverview, renderApp } from "@/test/appHarness.tsx";

const HASH = "a".repeat(64);

const featureStatus: BundleGitStatus = {
  ...MOCK_GIT_STATUS,
  comparisonMode: "feature-branch",
  currentBranch: "feature/spec",
  defaultBranch: "main",
  baseRevision: "1234567890abcdef",
  modifiedConceptIds: ["product/overview", "reference/glossary"],
  bodyChangedConceptIds: ["product/overview"],
  lineChangesByConcept: {
    "product/overview": [
      { start: 1, end: 1, previousText: "## What it was" },
      { start: 3, end: 3, previousText: null },
    ],
  },
  uncommittedConceptIds: [],
  uncommittedReviewConceptIds: [],
  uncommittedDeletedPaths: [],
};

function withHashes(reviewedIds: readonly string[] = []): Bundle {
  return {
    ...MOCK_BUNDLE,
    concepts: MOCK_BUNDLE.concepts.map((concept) => ({
      ...concept,
      contentSha256: HASH,
      ...(reviewedIds.includes(concept.id)
        ? {
            status: "stable" as const,
            statusExplicit: true,
            verified: [{ by: "human:alex", at: "2026-10-14T09:00:00Z", contentSha256: HASH }],
          }
        : {}),
    })),
  };
}

function preflight(overrides: Partial<ReviewPreflight> = {}): ReviewPreflight {
  return {
    available: true,
    reasonCode: null,
    message: "This app will append a human verification record. Frontmatter YAML may be reformatted; the Markdown body is preserved.",
    conceptId: "product/overview",
    relativePath: "product/overview.md",
    fingerprint: "fixture-fingerprint",
    currentStatus: "stable",
    statusExplicit: true,
    reviewState: "unverified",
    reviewerHasReviewed: false,
    actionLabel: "Mark as reviewed",
    resultingStatus: "stable",
    reviewedAt: "2026-10-14T09:00:00Z",
    contentSha256: HASH,
    ...overrides,
  };
}

function asReviewer() {
  vi.spyOn(ipc, "loadSettings").mockResolvedValue({ ...DEFAULT_SETTINGS, reviewerId: "alex" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("feature review workflow", () => {
  it("states what a review approves, then shows progress and the next outstanding document", async () => {
    const user = userEvent.setup();
    asReviewer();
    let applied = false;
    vi.spyOn(ipc, "readBundle").mockImplementation(() =>
      Promise.resolve(withHashes(applied ? ["product/overview"] : []))
    );
    vi.spyOn(ipc, "readBundleGitStatus").mockResolvedValue(featureStatus);
    vi.spyOn(ipc, "reviewConceptPreflight").mockResolvedValue(preflight());
    vi.spyOn(ipc, "reviewConcept").mockImplementation(() => {
      applied = true;
      return Promise.resolve({
        conceptId: "product/overview",
        relativePath: "product/overview.md",
        fingerprint: "updated",
        status: "stable",
        statusExplicit: true,
        actor: "human:alex",
        reviewedAt: "2026-10-14T09:00:00Z",
        verificationCount: 1,
        message: "Human review recorded.",
      });
    });

    renderApp();
    await openBundleAtOverview(user);
    // Outstanding review work keeps speed reading out of the header.
    expect(screen.queryByRole("button", { name: "Speed-read this concept" })).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Mark as reviewed" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm human review" });
    expect(dialog).toHaveTextContent(
      "You approve the wording of this document's body, not its code, metadata, implementation, or deployment.",
    );
    const approves = within(dialog).getByText("Approves").closest("div")!;
    expect(approves).toHaveTextContent("Body wording sha256 aaaaaaaaaaaa…");
    expect(within(approves).getByTitle(HASH)).toBeInTheDocument();
    expect(within(dialog).getByText("Changes").closest("div"))
      .toHaveTextContent("2 changed passages since 12345678 (feature/spec from main)");

    await user.click(within(dialog).getByRole("button", { name: "Confirm review" }));
    expect(
      await screen.findByText("Human review recorded. 1 of 2 changed documents still needs review."),
    ).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Speed-read this concept" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next: Glossary" }));
    await screen.findByRole("heading", { name: "Glossary", level: 1 });
    expect(
      screen.getByText("Only metadata changed since 12345678; the wording is unchanged."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Human review recorded/)).not.toBeInTheDocument();
  });

  it("acknowledges an unchanged approval instead of offering another stamp", async () => {
    const user = userEvent.setup();
    asReviewer();
    vi.spyOn(ipc, "reviewConceptPreflight").mockResolvedValue(preflight({
      available: false,
      reasonCode: "already-reviewed",
      message: "You approved this exact wording at 2026-10-14T09:00:00Z. Review again after the body changes.",
      reviewState: "human-reviewed",
      reviewerHasReviewed: true,
      actionLabel: null,
      resultingStatus: null,
    }));

    renderApp();
    await openBundleAtOverview(user);
    const button = await screen.findByRole("button", { name: "Reviewed by you" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-acknowledged", "true");
    expect(
      screen.getByText("You approved this exact wording at 2026-10-14T09:00:00Z. Review again after the body changes."),
    ).toHaveClass("is-acknowledged");
  });

  it("points from changed wording to the unchanged documents that link to it", async () => {
    const user = userEvent.setup();
    renderApp();
    await openBundle(user);
    await user.click(screen.getByRole("treeitem", { name: /Graph View/ }));
    await screen.findByRole("heading", { name: "Graph View", level: 1 });

    const impact = screen.getByText("Impact:").closest("p")!;
    expect(impact).toHaveTextContent(
      "Impact: 3 unchanged documents link here. Their wording did not change, but their meaning might have: Overview, Concept Reader, On Call.",
    );
    await user.click(within(impact).getByRole("button", { name: "Concept Reader" }));
    await screen.findByRole("heading", { name: "Concept Reader", level: 1 });
    expect(screen.queryByText("Impact:")).not.toBeInTheDocument();
  });

  it("copies feedback with the selected passage and leaves the document unchanged", async () => {
    const user = userEvent.setup();
    asReviewer();
    vi.spyOn(ipc, "readBundle").mockResolvedValue(withHashes());
    vi.spyOn(ipc, "readBundleGitStatus").mockResolvedValue(featureStatus);
    const review = vi.spyOn(ipc, "reviewConcept");

    renderApp();
    await openBundleAtOverview(user);
    const paragraph = await screen.findByText(/Open a folder to find every bundle inside/);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    await user.click(screen.getByRole("button", { name: "Give feedback" }));
    const dialog = await screen.findByRole("dialog", { name: "Give feedback" });
    expect(within(dialog).getByRole("textbox", { name: "Passage (optional)" }))
      .toHaveValue(paragraph.textContent.trim());
    expect(within(dialog).getByRole("textbox", { name: "What should change" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Copy feedback" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Describe what should change before copying.");

    await fillText(
      user,
      within(dialog).getByRole("textbox", { name: "What should change" }),
      "Name the folder types the scan skips.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Copy feedback" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Give feedback" })).not.toBeInTheDocument());
    expect(screen.getByText("Feedback copied. The document is unchanged.")).toBeInTheDocument();

    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('## Feedback on "Overview" (`product/overview.md`)');
    expect(copied).toContain(`- Body SHA-256 read: \`${HASH}\``);
    expect(copied).toContain("- From: human:alex");
    expect(copied).toContain("> Open a folder to find every bundle inside");
    expect(copied).toContain("Name the folder types the scan skips.");
    expect(review).not.toHaveBeenCalled();
  });

  function withEvidence(specSha256: string, evidence: string): Bundle {
    const hashed = withHashes();
    return {
      ...hashed,
      concepts: hashed.concepts.map((concept) => concept.id === "product/overview"
        ? {
            ...concept,
            extra: {
              ...concept.extra,
              implementation: {
                spec_sha256: specSha256,
                checked_at: "2026-10-14T11:00:00Z",
                by: "codex/gpt-6",
                code: { commit: "c".repeat(40) },
                evidence,
              },
            },
          }
        : concept),
    };
  }

  it("shows that recorded evidence covers this wording and opens an in-bundle record", async () => {
    const user = userEvent.setup();
    vi.spyOn(ipc, "readBundle").mockResolvedValue(withEvidence(HASH, "../reference/glossary.md"));

    renderApp();
    await openBundleAtOverview(user);
    const card = (await screen.findByText("Checked against this wording.")).closest<HTMLElement>(".impl-evidence")!;
    expect(card).toHaveTextContent("2026-10-14T11:00:00Z by codex/gpt-6");
    expect(card).toHaveTextContent("commit cccccccccccc");
    expect(card).toHaveTextContent("A recorded check, not implementation acceptance.");
    await user.click(within(card).getByRole("button", { name: "Glossary" }));
    await screen.findByRole("heading", { name: "Glossary", level: 1 });
  });

  it("flags evidence recorded for an earlier wording and copies an outside path", async () => {
    const user = userEvent.setup();
    vi.spyOn(ipc, "readBundle").mockResolvedValue(
      withEvidence("e".repeat(64), "../../delivery/occupancy.md"),
    );

    renderApp();
    await openBundleAtOverview(user);
    const card = (
      await screen.findByText("Checked against an earlier wording. The body changed after this check.")
    ).closest<HTMLElement>(".impl-evidence")!;
    expect(within(card).getByText("../../delivery/occupancy.md")).toBeInTheDocument();
    expect(within(card).getByText("Outside this bundle.")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Copy path" }));
    expect(await within(card).findByText("Path copied.")).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe("../../delivery/occupancy.md");
  });

  it("opens a local delivery record natively and reports a refused open inline", async () => {
    const user = userEvent.setup();
    const href = "../../delivery/2026-10-15-occupancy.md";
    vi.spyOn(ipc, "readBundle").mockResolvedValue({
      ...withEvidence(HASH, href),
      evidenceLinks: { "product/overview": { href, state: "available" } },
    });
    const open = vi.spyOn(ipc, "openEvidenceDocument")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce("This concept no longer names that evidence record. Reload the bundle.");

    renderApp();
    await openBundleAtOverview(user);
    const card = (await screen.findByText("Checked against this wording.")).closest<HTMLElement>(".impl-evidence")!;
    expect(within(card).getByText("Delivery record outside the bundle.")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: href }));
    expect(open).toHaveBeenCalledWith("/mock/workspace/docs", "product/overview", href);
    expect(within(card).queryByRole("alert")).not.toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: href }));
    expect(await within(card).findByRole("alert"))
      .toHaveTextContent("This concept no longer names that evidence record. Reload the bundle.");
  });

  it("explains a delivery record outside the opened folder", async () => {
    const user = userEvent.setup();
    const href = "../../delivery/2026-10-15-occupancy.md";
    vi.spyOn(ipc, "readBundle").mockResolvedValue({
      ...withEvidence(HASH, href),
      evidenceLinks: { "product/overview": { href, state: "outside-scope" } },
    });
    const open = vi.spyOn(ipc, "openEvidenceDocument");

    renderApp();
    await openBundleAtOverview(user);
    const card = (await screen.findByText("Checked against this wording.")).closest<HTMLElement>(".impl-evidence")!;
    expect(within(card).getByText("Outside the opened folder. Open the containing folder to read it."))
      .toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: href })).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Copy path" })).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it("treats a changed deprecated document like a removed one", async () => {
    const user = userEvent.setup();
    const hashed = withHashes();
    vi.spyOn(ipc, "readBundle").mockResolvedValue({
      ...hashed,
      concepts: hashed.concepts.map((concept) => concept.id === "reference/glossary"
        ? { ...concept, status: "deprecated" as const, statusExplicit: true }
        : concept),
    });
    vi.spyOn(ipc, "readBundleGitStatus").mockResolvedValue(featureStatus);
    vi.spyOn(ipc, "reviewConceptPreflight").mockResolvedValue(preflight({
      available: false,
      reasonCode: "deprecated",
      message: "Deprecated concepts are historical. Review is unavailable by default.",
      conceptId: "reference/glossary",
      relativePath: "reference/glossary.md",
      currentStatus: "deprecated",
      actionLabel: null,
      resultingStatus: null,
    }));

    renderApp();
    await openBundle(user);
    const panel = await screen.findByRole("region", { name: "Feature review batch" });
    expect(within(panel).getByRole("button", { name: "1 outstanding" })).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "1 removed or deprecated" }));
    await user.click(within(panel).getByRole("button", { name: /^Glossary Deprecated · linked from \d+$/ }));
    await screen.findByRole("heading", { name: "Glossary", level: 1 });

    const impact = screen.getByText("Impact:").closest("p")!;
    expect(impact).toHaveTextContent(/Deprecated since 12345678, so no review stamp applies\. \d+ documents link here and may need updating:/);
    expect(within(impact).getByRole("button", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review unavailable" })).toBeDisabled();
    // Not outstanding review work, so reading controls stay in place.
    expect(screen.getByRole("button", { name: "Speed-read this concept" })).toBeInTheDocument();
  });
});
