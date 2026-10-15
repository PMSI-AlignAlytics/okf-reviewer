import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MOCK_BUNDLE } from "@/mock/fixture.ts";
import type { Attribution, Concept, ConceptStatus } from "@/shared/types.ts";
import { conceptReviewState } from "./state.ts";
import { reviewGate } from "./batch.ts";
import table from "./review-gate-cases.json";

interface GateCase {
  name: string;
  frontmatter: {
    status?: string;
    generated?: { by: string; at: string };
    timestamp?: string;
    verified?: { by: string; at: string; content_sha256?: string }[];
  };
  body: string;
  human_review: "current" | "review";
  gate: "pass" | "block" | "manual";
}

/** The concept okf-core would produce, including its stamp-hash normalization. */
function parsed({ frontmatter, body }: GateCase): Concept {
  const verified: Attribution[] = (frontmatter.verified ?? []).map((event) => ({
    by: event.by,
    at: event.at,
    contentSha256: event.content_sha256?.trim().toLowerCase() ?? null,
  }));
  return {
    ...MOCK_BUNDLE.concepts[0],
    status: (frontmatter.status ?? "stable") as ConceptStatus,
    statusExplicit: frontmatter.status !== undefined,
    generated: frontmatter.generated ?? null,
    timestamp: frontmatter.timestamp ?? null,
    verified,
    body,
    contentSha256: createHash("sha256").update(body.replace(/\r\n/gu, "\n")).digest("hex"),
  };
}

describe("shared review gate decision table", () => {
  it.each((table.cases as GateCase[]).map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      const concept = parsed(entry);
      expect(conceptReviewState(concept) === "human-reviewed" ? "current" : "review")
        .toBe(entry.human_review);
      expect(reviewGate(concept)).toBe(entry.gate);
    },
  );
});
