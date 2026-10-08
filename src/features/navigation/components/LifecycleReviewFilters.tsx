import { Toggle } from "@base-ui/react/toggle";
import { useApp } from "@/shared/store.tsx";
import type { ConceptStatus } from "@/shared/types.ts";
import type { ConceptReviewState } from "@/features/review/state.ts";
import {
  conceptReviewState,
  reviewStateLabel,
} from "@/features/review/state.ts";

const STATUSES: readonly ConceptStatus[] = [
  "draft",
  "stable",
  "experimental",
  "deprecated",
];
const REVIEW_STATES: readonly ConceptReviewState[] = [
  "unverified",
  "machine-confirmed",
  "review-required",
  "human-reviewed",
];

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function LifecycleReviewFilters() {
  const { state, actions } = useApp();
  const bundle = state.bundle;
  if (!bundle) return null;

  const statusCounts = new Map<ConceptStatus, number>();
  const reviewCounts = new Map<ConceptReviewState, number>();
  for (const concept of bundle.concepts) {
    statusCounts.set(concept.status, (statusCounts.get(concept.status) ?? 0) + 1);
    const review = conceptReviewState(concept);
    reviewCounts.set(review, (reviewCounts.get(review) ?? 0) + 1);
  }

  return (
    <div className="sb-section lifecycle-review-filters">
      <fieldset className="sb-facet-group">
        <legend>Lifecycle</legend>
        <ul className="sb-tags">
          {STATUSES.filter((status) => statusCounts.has(status)).map((status) => {
            const active = state.activeStatuses.includes(status);
            return (
              <li key={status}>
                <Toggle
                  className={`ui-toggle sb-tag${active ? " is-active" : ""}`}
                  pressed={active}
                  onPressedChange={() => actions.toggleStatus(status)}
                >
                  <span className="sb-tag-label">{sentenceCase(status)}</span>
                  <span className="sb-tag-count">{statusCounts.get(status)}</span>
                </Toggle>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <fieldset className="sb-facet-group">
        <legend>Human review</legend>
        <ul className="sb-tags">
          {REVIEW_STATES.map((review) => {
            const active = state.activeReviewStates.includes(review);
            return (
              <li key={review}>
                <Toggle
                  className={`ui-toggle sb-tag${active ? " is-active" : ""}`}
                  pressed={active}
                  onPressedChange={() => actions.toggleReviewState(review)}
                >
                  <span className="sb-tag-label">{reviewStateLabel(review)}</span>
                  <span className="sb-tag-count">{reviewCounts.get(review) ?? 0}</span>
                </Toggle>
              </li>
            );
          })}
        </ul>
      </fieldset>
    </div>
  );
}
