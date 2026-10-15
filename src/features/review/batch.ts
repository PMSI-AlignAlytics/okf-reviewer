// The feature review batch: concepts changed since the Git comparison base,
// with their human-review state. Read-only; nothing here writes to the bundle
// or to Git. The panel, the review confirmation, and the reader share it so a
// "changed", "reviewed", or "outstanding" count means the same thing everywhere.

import type { Bundle, BundleGitStatus, Concept } from "@/shared/types.ts";
import { isHuman } from "@/features/bundle/trust.ts";
import { resolveHref } from "@/shared/render/markdown.ts";
import {
  conceptReviewState,
  reviewStateLabel,
  type ConceptReviewState,
} from "@/features/review/state.ts";

/**
 * How the OKF review check treats one changed concept: it passes when the
 * lifecycle is stable and a human review covers the current body. Deprecated
 * concepts, like deleted ones, cannot be stamped into passing, so they are
 * left for a manual impact review.
 */
export type ReviewGate = "pass" | "block" | "manual";

export function reviewGate(concept: Concept): ReviewGate {
  if (concept.status === "deprecated") return "manual";
  return concept.status === "stable" && conceptReviewState(concept) === "human-reviewed"
    ? "pass"
    : "block";
}

export interface FeatureReviewItem {
  concept: Concept;
  reviewState: ConceptReviewState;
  /** Changed in the batch and not yet passing the review gate. */
  outstanding: boolean;
  /** The Markdown body differs from the comparison base, not only frontmatter. */
  wordingChanged: boolean;
}

/** A deleted document, or a changed concept that is now deprecated. */
export interface RetiredDocument {
  path: string;
  kind: "removed" | "deprecated";
  /** The concept, when it still exists (deprecated). */
  concept: Concept | null;
  /** Current concepts that link to it. */
  linkedFrom: Concept[];
}

export interface FeatureReviewBatch {
  items: FeatureReviewItem[];
  reviewed: FeatureReviewItem[];
  outstanding: FeatureReviewItem[];
  metadataOnly: FeatureReviewItem[];
  /** Removed and deprecated documents: no stamp applies, so review their impact. */
  retired: RetiredDocument[];
}

/** How one concept differs from the comparison base. */
export type ConceptChange =
  | { kind: "unchanged" }
  | { kind: "metadata" }
  | { kind: "wording"; passages: number };

/**
 * Concepts whose wording changed. Older status payloads lack the native list,
 * so fall back to body hunks, and then to every modified concept.
 */
function wordingChangedIds(status: BundleGitStatus): ReadonlySet<string> {
  return new Set(
    status.bodyChangedConceptIds ??
      (status.lineChangesByConcept
        ? Object.keys(status.lineChangesByConcept)
        : status.modifiedConceptIds),
  );
}

export function featureReviewBatch(
  bundle: Bundle,
  status: BundleGitStatus,
): FeatureReviewBatch {
  const modified = new Set(status.modifiedConceptIds);
  const wording = wordingChangedIds(status);
  const changed = bundle.concepts.filter((concept) => modified.has(concept.id));
  const items = changed
    .filter((concept) => reviewGate(concept) !== "manual")
    .map((concept) => ({
      concept,
      reviewState: conceptReviewState(concept),
      outstanding: reviewGate(concept) === "block",
      wordingChanged: wording.has(concept.id),
    }));
  const retired: RetiredDocument[] = [
    ...status.deletedPaths.map((path) => {
      const id = path.replace(/\.md$/iu, "");
      return {
        path,
        kind: "removed" as const,
        concept: null,
        linkedFrom: bundle.concepts.filter((concept) =>
          concept.brokenLinks.some((href) => {
            const target = resolveHref(href, concept.id);
            return target.kind === "concept" && target.id === id;
          })
        ),
      };
    }),
    ...changed
      .filter((concept) => reviewGate(concept) === "manual")
      .map((concept) => ({
        path: `${concept.id}.md`,
        kind: "deprecated" as const,
        concept,
        linkedFrom: concept.citedBy
          .map((id) => bundle.concepts.find((candidate) => candidate.id === id))
          .filter((candidate): candidate is Concept => candidate !== undefined),
      })),
  ];
  return {
    items,
    reviewed: items.filter((item) => !item.outstanding),
    outstanding: items.filter((item) => item.outstanding),
    metadataOnly: items.filter((item) => !item.wordingChanged),
    retired,
  };
}

/** Why an outstanding item does not pass yet, in a few words. */
export function pendingReason(item: FeatureReviewItem): string {
  return item.reviewState === "human-reviewed"
    ? `reviewed, still ${item.concept.status}`
    : "needs review";
}

export function conceptChange(
  conceptId: string,
  status: BundleGitStatus,
): ConceptChange | null {
  if (!status.available) return null;
  if (!status.modifiedConceptIds.includes(conceptId)) return { kind: "unchanged" };
  if (!wordingChangedIds(status).has(conceptId)) return { kind: "metadata" };
  return {
    kind: "wording",
    passages: status.lineChangesByConcept?.[conceptId]?.length ?? 0,
  };
}

/**
 * The next outstanding concept after `currentId` in bundle order, wrapping.
 * `settledIds` are treated as reviewed — for example a concept whose review
 * was just recorded before the reloaded bundle arrives.
 */
export function nextOutstanding(
  batch: FeatureReviewBatch,
  currentId: string | null,
  settledIds: readonly string[] = [],
): Concept | null {
  const start = batch.items.findIndex((item) => item.concept.id === currentId);
  for (let offset = 1; offset <= batch.items.length; offset += 1) {
    const item = batch.items[(start + offset) % batch.items.length];
    if (
      item.outstanding &&
      item.concept.id !== currentId &&
      !settledIds.includes(item.concept.id)
    ) {
      return item.concept;
    }
  }
  return null;
}

export function shortRevision(revision: string | null): string {
  return revision ? revision.slice(0, 8) : "unavailable";
}

/** "feature/x from main", a selected commit, or the working-tree fallback. */
export function comparisonLabel(status: BundleGitStatus): string {
  switch (status.comparisonMode) {
    case "feature-branch":
      return `${status.currentBranch ?? "Feature branch"} from ${status.defaultBranch ?? "default branch"}`;
    case "selected-commit":
      return `${status.currentBranch ?? "Branch"} since selected commit`;
    default:
      return "Working tree from HEAD";
  }
}

function cell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

/** The review that makes this concept current, if any. */
function currentReview(item: FeatureReviewItem): string {
  const humans = item.concept.verified.filter(isHuman);
  const hash = item.concept.contentSha256;
  const exact = hash
    ? humans.filter((entry) => entry.contentSha256 === hash).at(-1)
    : undefined;
  if (exact) return `Current: ${exact.by} at ${exact.at ?? "unknown time"}`;
  if (item.reviewState === "human-reviewed") {
    const latest = humans.at(-1);
    return `Current by timestamp: ${latest?.by ?? "human"} at ${latest?.at ?? "unknown time"}`;
  }
  return reviewStateLabel(item.reviewState);
}

/**
 * A Markdown record of the batch's document stamps for a delivery record or
 * PR. It names the exact comparison base and HEAD, and says when reviews are
 * not yet committed, because only a commit makes an approval durable.
 */
export function reviewRecordMarkdown(
  batch: FeatureReviewBatch,
  status: BundleGitStatus,
  { copiedAt, reviewerId }: { copiedAt: string; reviewerId: string },
): string {
  const base = `\`${status.baseRevision ?? "unavailable"}\``;
  const comparison = status.comparisonMode === "feature-branch"
    ? `${status.currentBranch ?? "feature branch"} compared with ${status.defaultBranch ?? "the default branch"} at merge base ${base}`
    : status.comparisonMode === "selected-commit"
      ? `${status.currentBranch ?? "branch"} compared with selected commit ${base}${status.baseSubject ? ` (${cell(status.baseSubject)})` : ""}; automatic base \`${status.defaultBaseRevision ?? "unavailable"}\``
      : `working tree compared with HEAD ${base}`;
  const lines = [
    "## Feature review record",
    "",
    `- Comparison: ${comparison}`,
    `- HEAD: \`${status.headRevision ?? "unavailable"}\``,
  ];
  if (status.uncommittedConceptIds) {
    const pending =
      status.uncommittedConceptIds.length + (status.uncommittedDeletedPaths?.length ?? 0);
    const reviews = status.uncommittedReviewConceptIds?.length ?? 0;
    lines.push(
      pending === 0
        ? "- Commit state: bundle documents match HEAD."
        : `- Commit state: ${pending} bundle document${pending === 1 ? "" : "s"} differ${pending === 1 ? "s" : ""} from HEAD${reviews > 0 ? `, including ${reviews} uncommitted review${reviews === 1 ? "" : "s"}` : ""}. Commit them and copy this record again so it names the commit that contains these reviews.`,
    );
  }
  lines.push(
    `- Copied: ${copiedAt}${reviewerId ? ` by human:${reviewerId}` : ""}`,
    "",
    "| Concept path | Body SHA-256 | Change | Lifecycle | Human review |",
    "| --- | --- | --- | --- | --- |",
    ...batch.items.map((item) =>
      `| \`${cell(item.concept.id)}.md\` | \`${item.concept.contentSha256 ?? "unavailable"}\` | ${item.wordingChanged ? "Wording" : "Metadata only"} | ${item.concept.status} | ${cell(currentReview(item))} |`
    ),
  );
  if (batch.retired.length > 0) {
    lines.push(
      "",
      "Removed or deprecated since the comparison base (no stamp applies; assess their impact separately):",
      ...batch.retired.map((document) =>
        `- \`${document.path}\`: ${document.kind}${document.linkedFrom.length > 0 ? `; linked from ${document.linkedFrom.map((concept) => `\`${concept.id}.md\``).join(", ")}` : ""}`
      ),
    );
  }
  lines.push(
    "",
    "Document stamps approve the wording of each body. They do not approve code, metadata, implementation, or deployment.",
  );
  return lines.join("\n");
}

/**
 * Feedback for whoever authored a concept, usually an agent. It identifies the
 * exact wording the reviewer read and asks for a revision without a stamp.
 */
export function feedbackMarkdown({
  concept,
  status,
  passage,
  note,
  reviewerId,
}: {
  concept: Concept;
  status: BundleGitStatus;
  passage: string;
  note: string;
  reviewerId: string;
}): string {
  const lines = [
    `## Feedback on "${concept.title}" (\`${concept.id}.md\`)`,
    "",
    `- Body SHA-256 read: \`${concept.contentSha256 ?? "unavailable"}\``,
  ];
  if (status.available) {
    lines.push(
      `- Compared with: \`${shortRevision(status.baseRevision)}\` (${comparisonLabel(status)})`,
    );
  }
  lines.push(`- Human review: ${reviewStateLabel(conceptReviewState(concept))}`);
  if (reviewerId) lines.push(`- From: human:${reviewerId}`);
  const quoted = passage.trim();
  if (quoted) {
    lines.push("", "Passage:", "", ...quoted.split(/\r?\n/u).map((line) => `> ${line}`));
  }
  lines.push(
    "",
    "Feedback:",
    "",
    note.trim(),
    "",
    "Revise the concept body to address this feedback. Keep its existing verification history; the human review stays pending until I review the revised wording.",
  );
  return lines.join("\n");
}
