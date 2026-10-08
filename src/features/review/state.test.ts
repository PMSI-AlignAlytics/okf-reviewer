import { describe, expect, it } from "vitest";
import { mockConcept } from "@/mock/conceptFixtures.ts";
import {
  conceptReviewState,
  humanReviewCountsByDirectory,
  requiresHumanReview,
} from "@/features/review/state.ts";

describe("requiresHumanReview", () => {
  it("marks unverified and machine-confirmed concepts as pending", () => {
    expect(requiresHumanReview(mockConcept({ verified: [] }))).toBe(true);
    expect(requiresHumanReview(mockConcept({
      verified: [{ by: "generator/catalog", at: "2026-08-20T09:00:00Z" }],
    }))).toBe(true);
  });

  it("does not conflate lifecycle with human review", () => {
    expect(requiresHumanReview(mockConcept({
      status: "draft",
      generated: { by: "agent/1", at: "2026-08-19T09:00:00Z" },
      verified: [{ by: "human:alex", at: "2026-08-20T09:00:00Z" }],
    }))).toBe(false);
    expect(requiresHumanReview(mockConcept({
      status: "stable",
      generated: { by: "agent/1", at: "2026-08-19T09:00:00Z" },
      verified: [{ by: "human:alex", at: "2026-08-20T09:00:00Z" }],
    }))).toBe(false);
  });

  it("marks content generated after the latest human review as pending", () => {
    const concept = mockConcept({
      generated: { by: "agent/1", at: "2026-08-21T09:00:00Z" },
      verified: [
        { by: "human:alex", at: "2026-08-20T09:00:00Z" },
        { by: "process:ci", at: "2026-08-22T09:00:00Z" },
      ],
    });

    expect(conceptReviewState(concept)).toBe("review-required");
    expect(requiresHumanReview(concept)).toBe(true);
  });

  it("uses the latest human instant rather than list order", () => {
    const concept = mockConcept({
      generated: { by: "agent/1", at: "2026-08-21T09:00:00Z" },
      verified: [
        { by: "human:newer", at: "2026-08-21T10:00:00+01:00" },
        { by: "human:older", at: "2026-08-20T09:00:00Z" },
      ],
    });

    expect(conceptReviewState(concept)).toBe("human-reviewed");
    expect(requiresHumanReview(concept)).toBe(false);
  });

  it("compares fractional instants without losing precision", () => {
    expect(conceptReviewState(mockConcept({
      generated: { by: "agent/1", at: "2026-08-20T09:00:00.0000002Z" },
      verified: [{ by: "human:alex", at: "2026-08-20T09:00:00.0000001Z" }],
    }))).toBe("review-required");
    expect(conceptReviewState(mockConcept({
      generated: { by: "agent/1", at: "2026-08-20T09:00:00.100Z" },
      verified: [{ by: "human:alex", at: "2026-08-20T10:00:00.1+01:00" }],
    }))).toBe("human-reviewed");
  });

  it("requires review when relevant timestamps cannot establish freshness", () => {
    expect(conceptReviewState(mockConcept({
      verified: [{ by: "human:alex", at: "2026-08-20T09:00:00Z" }],
    }))).toBe("review-required");
    expect(conceptReviewState(mockConcept({
      generated: { by: "agent/1", at: "2026-08-20T09:00:00Z" },
      verified: [{ by: "human:alex", at: null }],
    }))).toBe("review-required");
    expect(conceptReviewState(mockConcept({
      generated: { by: "agent/1", at: "2026-02-30T09:00:00Z" },
      verified: [{ by: "human:alex", at: "2026-03-01T09:00:00Z" }],
    }))).toBe("review-required");
  });

  it("falls back to the legacy authored timestamp", () => {
    expect(conceptReviewState(mockConcept({
      timestamp: "2026-08-20T09:00:00Z",
      verified: [{ by: "human:alex", at: "2026-08-20T09:00:00Z" }],
    }))).toBe("human-reviewed");
    expect(conceptReviewState(mockConcept({
      timestamp: "2026-08-21T09:00:00Z",
      verified: [{ by: "human:alex", at: "2026-08-20T09:00:00Z" }],
    }))).toBe("review-required");
  });

  it("treats a review as current exactly while the body hash matches", () => {
    const stamped = {
      generated: { by: "agent/1", at: "2026-08-21T09:00:00Z" },
      verified: [{ by: "human:alex", at: "2026-08-20T09:00:00Z", contentSha256: "aaa" }],
    };
    // generated.at is newer, but the approved body is unchanged.
    expect(conceptReviewState(mockConcept({ ...stamped, contentSha256: "aaa" }))).toBe("human-reviewed");
    // The body changed without generated.at being updated.
    expect(conceptReviewState(mockConcept({
      ...stamped,
      generated: { by: "agent/1", at: "2026-08-19T09:00:00Z" },
      contentSha256: "bbb",
    }))).toBe("review-required");
  });

  it("accepts an older review whose hash matches reverted content", () => {
    expect(conceptReviewState(mockConcept({
      contentSha256: "aaa",
      verified: [
        { by: "human:alex", at: "2026-08-20T09:00:00Z", contentSha256: "aaa" },
        { by: "human:sam", at: "2026-08-21T09:00:00Z", contentSha256: "bbb" },
      ],
    }))).toBe("human-reviewed");
  });

  it("falls back to timestamps only when the latest review has no hash", () => {
    expect(conceptReviewState(mockConcept({
      contentSha256: "ccc",
      generated: { by: "agent/1", at: "2026-08-19T09:00:00Z" },
      verified: [
        { by: "human:alex", at: "2026-08-18T09:00:00Z", contentSha256: "aaa" },
        { by: "human:sam", at: "2026-08-20T09:00:00Z" },
      ],
    }))).toBe("human-reviewed");
  });

  it("excludes deprecated concepts because review is unavailable", () => {
    expect(requiresHumanReview(mockConcept({
      status: "deprecated",
      verified: [],
    }))).toBe(false);
  });
});

describe("humanReviewCountsByDirectory", () => {
  it("counts each pending concept once in every ancestor directory", () => {
    const counts = humanReviewCountsByDirectory([
      mockConcept({ id: "tables/orders/amount" }),
      mockConcept({
        id: "tables/orders/id",
        generated: { by: "agent/1", at: "2026-08-19T09:00:00Z" },
        verified: [{ by: "human:alex", at: "2026-08-20T09:00:00Z" }],
      }),
      mockConcept({
        id: "tables/customers",
        verified: [{ by: "generator/catalog", at: null }],
      }),
      mockConcept({ id: "archive/legacy", status: "deprecated" }),
    ]);

    expect([...counts.entries()]).toEqual([
      ["tables/orders", 1],
      ["tables", 2],
    ]);
  });
});
