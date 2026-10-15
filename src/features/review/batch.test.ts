import { describe, expect, it } from "vitest";
import { MOCK_BUNDLE, MOCK_GIT_STATUS } from "@/mock/fixture.ts";
import type { Bundle, BundleGitStatus, Concept } from "@/shared/types.ts";
import {
  comparisonLabel,
  conceptChange,
  featureReviewBatch,
  feedbackMarkdown,
  nextOutstanding,
  pendingReason,
  reviewRecordMarkdown,
} from "./batch.ts";

const HASH = "a".repeat(64);

function concept(id: string, overrides: Partial<Concept> = {}): Concept {
  return {
    ...MOCK_BUNDLE.concepts[0],
    id,
    title: id,
    status: "draft",
    statusExplicit: true,
    generated: null,
    timestamp: "2026-10-01T00:00:00Z",
    verified: [],
    contentSha256: HASH,
    computation: null,
    citedBy: [],
    ...overrides,
  };
}

const reviewed = (id: string) =>
  concept(id, {
    status: "stable",
    verified: [{ by: "human:alex", at: "2026-10-14T09:00:00Z", contentSha256: HASH }],
  });

const bundle: Bundle = {
  ...MOCK_BUNDLE,
  concepts: [
    concept("spec/a"),
    reviewed("spec/b"),
    concept("spec/c"),
    concept("spec/untouched"),
    reviewed("spec/d"),
  ],
};

const status: BundleGitStatus = {
  ...MOCK_GIT_STATUS,
  comparisonMode: "feature-branch",
  currentBranch: "feature/occupancy",
  defaultBranch: "main",
  baseRevision: "1234567890abcdef",
  headRevision: "fedcba0987654321",
  modifiedConceptIds: ["spec/a", "spec/b", "spec/c", "spec/d"],
  bodyChangedConceptIds: ["spec/a", "spec/b", "spec/c"],
  lineChangesByConcept: {
    "spec/a": [
      { start: 1, end: 1, previousText: "Old" },
      { start: 4, end: 5, previousText: null },
    ],
  },
  deletedPaths: [],
  uncommittedConceptIds: [],
  uncommittedReviewConceptIds: [],
  uncommittedDeletedPaths: [],
};

describe("feature review batch", () => {
  it("separates reviewed, outstanding, and metadata-only changes in bundle order", () => {
    const batch = featureReviewBatch(bundle, status);
    expect(batch.items.map((item) => item.concept.id)).toEqual(["spec/a", "spec/b", "spec/c", "spec/d"]);
    expect(batch.outstanding.map((item) => item.concept.id)).toEqual(["spec/a", "spec/c"]);
    expect(batch.reviewed.map((item) => item.concept.id)).toEqual(["spec/b", "spec/d"]);
    expect(batch.metadataOnly.map((item) => item.concept.id)).toEqual(["spec/d"]);
  });

  it("treats every modified concept as reworded when an older status lacks wording data", () => {
    const legacy = { ...status, bodyChangedConceptIds: undefined, lineChangesByConcept: undefined };
    expect(featureReviewBatch(bundle, legacy).metadataOnly).toEqual([]);
  });

  it("describes one concept's change against the comparison base", () => {
    expect(conceptChange("spec/a", status)).toEqual({ kind: "wording", passages: 2 });
    expect(conceptChange("spec/d", status)).toEqual({ kind: "metadata" });
    expect(conceptChange("spec/untouched", status)).toEqual({ kind: "unchanged" });
    expect(conceptChange("spec/a", { ...status, available: false })).toBeNull();
  });

  it("finds the next outstanding concept after the current one, wrapping and skipping settled reviews", () => {
    const batch = featureReviewBatch(bundle, status);
    expect(nextOutstanding(batch, "spec/a")?.id).toBe("spec/c");
    expect(nextOutstanding(batch, "spec/c")?.id).toBe("spec/a");
    expect(nextOutstanding(batch, "spec/untouched")?.id).toBe("spec/a");
    expect(nextOutstanding(batch, "spec/a", ["spec/a", "spec/c"])).toBeNull();
  });
});

describe("review gate in the batch", () => {
  it("keeps a reviewed draft outstanding until it is stable, and says why", () => {
    const draftReviewed = concept("spec/draft", {
      status: "draft",
      verified: [{ by: "human:alex", at: "2026-10-14T09:00:00Z", contentSha256: HASH }],
    });
    const scoped = { ...status, modifiedConceptIds: ["spec/a", "spec/draft"], bodyChangedConceptIds: [] };
    const batch = featureReviewBatch({ ...bundle, concepts: [concept("spec/a"), draftReviewed] }, scoped);
    expect(batch.outstanding.map((item) => [item.concept.id, pendingReason(item)])).toEqual([
      ["spec/a", "needs review"],
      ["spec/draft", "reviewed, still draft"],
    ]);
    expect(batch.reviewed).toEqual([]);
  });

  it("lists removed and changed deprecated documents, with what links to them, instead of queueing them", () => {
    const linking = concept("spec/linking", {
      brokenLinks: ["gone.md#rules"],
      citedBy: [],
    });
    const retired = concept("spec/retired", { status: "deprecated", citedBy: ["spec/linking"] });
    const scoped = {
      ...status,
      modifiedConceptIds: ["spec/retired"],
      bodyChangedConceptIds: ["spec/retired"],
      deletedPaths: ["spec/gone.md"],
    };
    const batch = featureReviewBatch({ ...bundle, concepts: [linking, retired] }, scoped);
    expect(batch.items).toEqual([]);
    expect(batch.outstanding).toEqual([]);
    expect(batch.retired.map((document) => ({
      path: document.path,
      kind: document.kind,
      concept: document.concept?.id ?? null,
      linkedFrom: document.linkedFrom.map((item) => item.id),
    }))).toEqual([
      { path: "spec/gone.md", kind: "removed", concept: null, linkedFrom: ["spec/linking"] },
      { path: "spec/retired.md", kind: "deprecated", concept: "spec/retired", linkedFrom: ["spec/linking"] },
    ]);
    const record = reviewRecordMarkdown(batch, scoped, { copiedAt: "2026-10-14T10:00:00Z", reviewerId: "" });
    expect(record).toContain("Removed or deprecated since the comparison base (no stamp applies; assess their impact separately):");
    expect(record).toContain("- `spec/gone.md`: removed; linked from `spec/linking.md`");
    expect(record).toContain("- `spec/retired.md`: deprecated; linked from `spec/linking.md`");
  });

  it("names a selected comparison commit and the automatic base", () => {
    const selected: BundleGitStatus = {
      ...status,
      comparisonMode: "selected-commit",
      baseRevision: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      defaultBaseRevision: "1234567890abcdef",
      baseSubject: "Approve occupancy | spec",
    };
    expect(comparisonLabel(selected)).toBe("feature/occupancy since selected commit");
    expect(reviewRecordMarkdown(featureReviewBatch(bundle, selected), selected, {
      copiedAt: "2026-10-14T10:00:00Z",
      reviewerId: "",
    })).toContain(
      "- Comparison: feature/occupancy compared with selected commit `a1b2c3d4e5f60718293a4b5c6d7e8f9012345678` (Approve occupancy \\| spec); automatic base `1234567890abcdef`",
    );
  });
});

describe("review record", () => {
  it("lists each changed document's exact wording hash and current review", () => {
    const complete = featureReviewBatch(
      { ...bundle, concepts: [reviewed("spec/b"), reviewed("spec/d")] },
      status,
    );
    const record = reviewRecordMarkdown(complete, status, {
      copiedAt: "2026-10-14T10:00:00Z",
      reviewerId: "alex",
    });
    expect(record).toContain(
      "- Comparison: feature/occupancy compared with main at merge base `1234567890abcdef`",
    );
    expect(record).toContain("- HEAD: `fedcba0987654321`");
    expect(record).toContain("- Commit state: bundle documents match HEAD.");
    expect(record).toContain("- Copied: 2026-10-14T10:00:00Z by human:alex");
    expect(record).toContain("| Concept path | Body SHA-256 | Change | Lifecycle | Human review |");
    expect(record).toContain(
      `| \`spec/b.md\` | \`${HASH}\` | Wording | stable | Current: human:alex at 2026-10-14T09:00:00Z |`,
    );
    expect(record).toContain(
      `| \`spec/d.md\` | \`${HASH}\` | Metadata only | stable | Current: human:alex at 2026-10-14T09:00:00Z |`,
    );
    expect(record).toContain("They do not approve code, metadata, implementation, or deployment.");
  });

  it("says when reviews are uncommitted and lists removed documents", () => {
    const pending = {
      ...status,
      uncommittedConceptIds: ["spec/b", "spec/c"],
      uncommittedReviewConceptIds: ["spec/b"],
      uncommittedDeletedPaths: ["spec/gone.md"],
      deletedPaths: ["spec/gone.md"],
    };
    const record = reviewRecordMarkdown(featureReviewBatch(bundle, pending), pending, {
      copiedAt: "2026-10-14T10:00:00Z",
      reviewerId: "",
    });
    expect(record).toContain(
      "- Commit state: 3 bundle documents differ from HEAD, including 1 uncommitted review. Commit them and copy this record again so it names the commit that contains these reviews.",
    );
    expect(record).toContain("- Copied: 2026-10-14T10:00:00Z\n");
    expect(record).toContain("| `spec/a.md` | `" + HASH + "` | Wording | draft | Unreviewed |");
    expect(record).toContain("- `spec/gone.md`: removed");
  });

  it("names a timestamp-rule review without claiming a hash match", () => {
    const legacy = concept("spec/legacy", {
      contentSha256: HASH,
      verified: [{ by: "human:sam", at: "2026-10-02T00:00:00Z" }],
    });
    const scoped = { ...status, modifiedConceptIds: ["spec/legacy"], bodyChangedConceptIds: ["spec/legacy"] };
    const record = reviewRecordMarkdown(
      featureReviewBatch({ ...bundle, concepts: [legacy] }, scoped),
      scoped,
      { copiedAt: "2026-10-14T10:00:00Z", reviewerId: "" },
    );
    expect(record).toContain("Current by timestamp: human:sam at 2026-10-02T00:00:00Z");
  });
});

describe("feedback", () => {
  it("identifies the wording read and asks for a revision without a stamp", () => {
    const text = feedbackMarkdown({
      concept: concept("spec/a", { title: "Nightly occupancy" }),
      status,
      passage: "Cancelled bookings must be excluded.\nNo-shows count.",
      note: "  Say whether no-shows count as occupied.  ",
      reviewerId: "alex",
    });
    expect(text).toContain('## Feedback on "Nightly occupancy" (`spec/a.md`)');
    expect(text).toContain(`- Body SHA-256 read: \`${HASH}\``);
    expect(text).toContain("- Compared with: `12345678` (feature/occupancy from main)");
    expect(text).toContain("- Human review: Unreviewed");
    expect(text).toContain("- From: human:alex");
    expect(text).toContain("> Cancelled bookings must be excluded.\n> No-shows count.");
    expect(text).toContain("Feedback:\n\nSay whether no-shows count as occupied.\n");
    expect(text).toContain("the human review stays pending until I review the revised wording.");
  });

  it("omits the passage, comparison, and reviewer when there are none", () => {
    const text = feedbackMarkdown({
      concept: concept("spec/a"),
      status: { ...status, available: false },
      passage: "  ",
      note: "Clarify the grain.",
      reviewerId: "",
    });
    expect(text).not.toContain("Passage:");
    expect(text).not.toContain("Compared with");
    expect(text).not.toContain("From:");
  });
});
