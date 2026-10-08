import { describe, expect, it } from "vitest";
import { mockConcept } from "@/mock/conceptFixtures.ts";
import { isVisible } from "@/shared/selectors.ts";

const baseFilter = {
  query: "",
  hiddenTypes: [],
  activeTag: null,
};

describe("reviewer filters", () => {
  it("keeps lifecycle and review state as independent facets", () => {
    const humanDraft = mockConcept({
      status: "draft",
      generated: { by: "agent/1", at: "2026-07-29T09:10:11Z" },
      verified: [{ by: "human:alex", at: "2026-07-30T09:10:11Z" }],
    });

    expect(isVisible(humanDraft, {
      ...baseFilter,
      activeStatuses: ["draft"],
      activeReviewStates: ["human-reviewed"],
    })).toBe(true);
    expect(isVisible(humanDraft, {
      ...baseFilter,
      activeStatuses: ["stable"],
      activeReviewStates: ["human-reviewed"],
    })).toBe(false);
    expect(isVisible(humanDraft, {
      ...baseFilter,
      activeStatuses: ["draft"],
      activeReviewStates: ["unverified"],
    })).toBe(false);
  });

  it("distinguishes machine verification from human review", () => {
    const machine = mockConcept({
      verified: [{ by: "generator/catalog", at: "2026-07-30T09:10:11Z" }],
    });
    const unverified = mockConcept({ verified: [] });

    expect(isVisible(machine, {
      ...baseFilter,
      activeReviewStates: ["machine-confirmed"],
    })).toBe(true);
    expect(isVisible(machine, {
      ...baseFilter,
      activeReviewStates: ["human-reviewed"],
    })).toBe(false);
    expect(isVisible(unverified, {
      ...baseFilter,
      activeReviewStates: ["unverified"],
    })).toBe(true);
  });

  it("filters a historical human review separately when content is newer", () => {
    const outdated = mockConcept({
      generated: { by: "agent/1", at: "2026-08-21T09:00:00Z" },
      verified: [{ by: "human:alex", at: "2026-08-20T09:00:00Z" }],
    });

    expect(isVisible(outdated, {
      ...baseFilter,
      activeReviewStates: ["review-required"],
    })).toBe(true);
    expect(isVisible(outdated, {
      ...baseFilter,
      activeReviewStates: ["human-reviewed"],
    })).toBe(false);
  });
});
