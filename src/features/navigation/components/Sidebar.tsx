// Left pane of the Browsing Layout. A persistent search box atop the active
// lens's content — Navigate (the index tree) or Filter (review + other facets),
// chosen from the Activity Bar. Active filters expose all matching concepts in
// either lens. The content renders inside a themed Base UI ScrollArea. Renders
// nothing until a bundle is loaded. Switching *bundles* lives in the top-left
// Bundle Switcher; the lens/visibility switchers live in the [ActivityBar].
// See docs/ux/browsing-layout.md.

import { Collapsible } from "@base-ui/react/collapsible";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { ChevronRight, RefreshCw, X } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import "@/shared/styles/baseui.css";
import "./Sidebar.css";
import { useApp } from "@/shared/store.tsx";
import { filteredConceptIds } from "@/shared/selectors.ts";
import { TypeFilters } from "@/features/navigation/components/TypeFilters.tsx";
import { TagBrowser } from "@/features/navigation/components/TagBrowser.tsx";
import { IndexTree } from "@/features/navigation/components/IndexTree.tsx";
import { LifecycleReviewFilters } from "@/features/navigation/components/LifecycleReviewFilters.tsx";
import { conceptReviewState, reviewStateLabel } from "@/features/review/state.ts";
import "@/shared/styles/chrome.css";

/** A collapsible top-level sidebar section with a chevron + title trigger. */
function Section({
  title,
  summary,
  defaultOpen = true,
  className,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible.Root
      defaultOpen={defaultOpen}
      className={`sb-collapsible${className ? ` ${className}` : ""}`}
    >
      <Collapsible.Trigger className="ui-collapsible-trigger">
        <span className="ui-collapsible-chevron" aria-hidden="true">
          <ChevronRight size={14} />
        </span>
        <span>{title}</span>
        {summary ? <span className="sb-section-summary">{summary}</span> : null}
      </Collapsible.Trigger>
      <Collapsible.Panel className="ui-collapsible-panel">
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** Flat matches include concepts absent from the authored navigation index. */
function MatchingConcepts({ ids }: { ids: ReadonlySet<string> }) {
  const { state, actions } = useApp();
  const bundle = state.bundle;
  if (!bundle) return null;
  const concepts = bundle.concepts
    .filter((concept) => ids.has(concept.id))
    .sort((left, right) =>
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id)
    );

  function open(id: string, event: MouseEvent<HTMLButtonElement>) {
    if (event.ctrlKey || event.metaKey || event.button === 1) {
      actions.openInNewTab(id, { background: !event.shiftKey });
    } else {
      actions.selectConcept(id);
    }
  }

  return (
    <Section title="Matching concepts" summary={String(concepts.length)}>
      {concepts.length === 0 ? (
        <p className="sb-matches-empty" role="status">
          No concepts match. Clear or adjust the search and filters.
        </p>
      ) : (
        <ul className="sb-matches" aria-label="Matching concepts">
          {concepts.map((concept) => (
            <li key={concept.id}>
              <button
                type="button"
                className={`sb-match${state.activeConceptId === concept.id ? " is-active" : ""}`}
                aria-current={state.activeConceptId === concept.id ? "true" : undefined}
                title={`${concept.title} — ${concept.id}.md`}
                onClick={(event) => open(concept.id, event)}
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault();
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) open(concept.id, event);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    actions.openInNewTab(concept.id, { background: !event.shiftKey });
                  }
                }}
              >
                <span className="sb-match-title">{concept.title}</span>
                <span className="sb-match-path">{concept.id}.md</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function Sidebar() {
  const { state, actions } = useApp();
  if (!state.bundle) return null;

  // The one filter state, shown as a live result count. The search field speaks
  // the faceted grammar (query.ts); type/tag facets AND in via the Filter lens.
  const total = state.bundle.concepts.length;
  const filtering =
    state.query.trim() !== "" ||
    state.hiddenTypes.length > 0 ||
    state.activeTag !== null ||
    state.activeStatuses.length > 0 ||
    state.activeReviewStates.length > 0;
  const matchingIds = filtering
    ? filteredConceptIds(state.bundle, {
        query: state.query,
        hiddenTypes: state.hiddenTypes,
        activeTag: state.activeTag,
        activeStatuses: state.activeStatuses,
        activeReviewStates: state.activeReviewStates,
      })
    : new Set<string>();
  const shown = filtering ? matchingIds.size : total;
  const changedConcepts = state.bundle.concepts.filter((concept) =>
    state.bundleGitStatus.modifiedConceptIds.includes(concept.id)
  );
  const reviewedChanges = changedConcepts.filter(
    (concept) => conceptReviewState(concept) === "human-reviewed",
  ).length;

  function clearAll() {
    actions.setQuery("");
    actions.showAllTypes();
    actions.setTag(null);
    actions.clearLifecycleReview();
  }

  return (
    <nav className="sb" aria-label="Bundle navigation">
      <div className="sb-search-wrap">
        <input
          data-search
          type="search"
          className="sb-search"
          // Short enough to survive the default sidebar width. The old string
          // ("Search, or filter: type: tag: degree>…") measured 245px against
          // 207px of field, so it always rendered clipped mid-word as
          // "…type: tag: deg" — teaching one broken fragment of the syntax and
          // reading as a rendering bug. The full field syntax, with worked
          // examples, is on the title below.
          placeholder="Search or filter…"
          aria-label="Search and filter concepts"
          title="Filter with fields: type:Table tag:revenue status:draft review:review-required, or plain text"
          value={state.query}
          onChange={(e) => actions.setQuery(e.target.value)}
        />
        {state.query && (
          <button
            type="button"
            className="sb-search-clear"
            aria-label="Clear search"
            onClick={() => actions.setQuery("")}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {filtering && (
        <>
          <div className="sb-result-count" aria-live="polite">
            <span className={shown === 0 ? "sb-count-none" : undefined}>
              {shown} of {total} concepts
            </span>
            <button type="button" className="sb-link-btn" onClick={clearAll}>
              Clear
            </button>
          </div>
          <div className="sb-active-filters" role="group" aria-label="Active filters">
            {state.hiddenTypes.length > 0 ? (
              <button
                type="button"
                className="sb-filter-criterion"
                aria-label={`Clear type filters: ${state.hiddenTypes.join(", ")} hidden`}
                title={`Hidden types: ${state.hiddenTypes.join(", ")}`}
                onClick={() => actions.showAllTypes()}
              >
                <span>{state.hiddenTypes.length} type{state.hiddenTypes.length === 1 ? "" : "s"} hidden</span>
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
            {state.activeTag ? (
              <button
                type="button"
                className="sb-filter-criterion"
                aria-label={`Clear tag filter: ${state.activeTag}`}
                title={`Tag: ${state.activeTag}`}
                onClick={() => actions.setTag(null)}
              >
                <span>#{state.activeTag}</span><X size={12} aria-hidden="true" />
              </button>
            ) : null}
            {state.activeStatuses.map((status) => (
              <button
                key={status}
                type="button"
                className="sb-filter-criterion"
                aria-label={`Clear lifecycle filter: ${status}`}
                onClick={() => actions.toggleStatus(status)}
              >
                <span>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
                <X size={12} aria-hidden="true" />
              </button>
            ))}
            {state.activeReviewStates.map((review) => (
              <button
                key={review}
                type="button"
                className="sb-filter-criterion"
                aria-label={`Clear human review filter: ${reviewStateLabel(review)}`}
                onClick={() => actions.toggleReviewState(review)}
              >
                <span>{reviewStateLabel(review)}</span><X size={12} aria-hidden="true" />
              </button>
            ))}
          </div>
        </>
      )}

      <div className="sb-body">
        <ScrollArea.Root className="ui-scrollarea sb-scroll">
          <ScrollArea.Viewport className="ui-scrollarea-viewport sb-scroll-viewport">
            <div className="sb-sections">
              {state.lens === "navigate" ? (
                // Flat matches complement the authored hierarchy, which stays
                // available with its folder homes and keyboard navigation.
                <>
                  {state.bundleGitStatus.available && (
                    <section className="sb-review-batch" aria-label="Feature review batch">
                      <div className="sb-review-batch__heading">
                        <div>
                          <strong>Feature review</strong>
                          <span>
                            {state.bundleGitStatus.comparisonMode === "feature-branch"
                              ? `${state.bundleGitStatus.currentBranch ?? "Feature branch"} from ${state.bundleGitStatus.defaultBranch ?? "default branch"}`
                              : "Working tree from HEAD"}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="sb-link-btn sb-review-batch__refresh"
                          onClick={() => void actions.refreshBundleGitStatus()}
                          aria-label="Refresh feature review batch"
                          title="Refresh feature review batch"
                        >
                          <RefreshCw size={13} aria-hidden="true" />
                        </button>
                      </div>
                      <div className="sb-review-batch__counts">
                        <span><strong>{changedConcepts.length}</strong> changed</span>
                        <span><strong>{reviewedChanges}</strong> reviewed</span>
                        <span><strong>{changedConcepts.length - reviewedChanges}</strong> outstanding</span>
                      </div>
                      <small>
                        Baseline {state.bundleGitStatus.baseRevision?.slice(0, 8) ?? "unavailable"}
                        {state.bundleGitStatus.deletedPaths.length > 0
                          ? ` · ${state.bundleGitStatus.deletedPaths.length} deleted excluded`
                          : ""}
                      </small>
                    </section>
                  )}
                  {filtering ? <MatchingConcepts ids={matchingIds} /> : null}
                  <IndexTree key="index" />
                </>
              ) : (
                <>
                  <Section title="Lifecycle and review">
                    <LifecycleReviewFilters />
                  </Section>
                  <Section
                    title="Types"
                    defaultOpen={false}
                    summary={state.hiddenTypes.length > 0 ? `${state.hiddenTypes.length} hidden` : undefined}
                  >
                    <TypeFilters />
                  </Section>
                  <Section
                    title="Tags"
                    defaultOpen={false}
                    summary={state.activeTag ? `#${state.activeTag}` : undefined}
                  >
                    <TagBrowser />
                  </Section>
                  {filtering ? <MatchingConcepts ids={matchingIds} /> : null}
                </>
              )}
            </div>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar className="ui-scrollarea-scrollbar">
            <ScrollArea.Thumb className="ui-scrollarea-thumb" />
          </ScrollArea.Scrollbar>
          <ScrollArea.Corner />
        </ScrollArea.Root>
      </div>
    </nav>
  );
}
