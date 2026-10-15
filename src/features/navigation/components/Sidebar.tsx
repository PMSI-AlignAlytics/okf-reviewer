// Left pane of the Browsing Layout. A persistent search box atop the active
// lens's content — Navigate (the index tree) or Filter (review + other facets),
// chosen from the Activity Bar. Active filters expose all matching concepts in
// either lens. The content renders inside a themed Base UI ScrollArea. Renders
// nothing until a bundle is loaded. Switching *bundles* lives in the top-left
// Bundle Switcher; the lens/visibility switchers live in the [ActivityBar].
// See docs/ux/browsing-layout.md.

import { Collapsible } from "@base-ui/react/collapsible";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { CheckCircle2, ChevronRight, RefreshCw, X } from "lucide-react";
import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import "@/shared/styles/baseui.css";
import "./Sidebar.css";
import { useApp } from "@/shared/store.tsx";
import { quizGitRevisions } from "@/shared/ipc.ts";
import type { GitRevision } from "@/features/quiz/types.ts";
import { RemovedDocumentDialog } from "@/features/review/components/RemovedDocumentDialog.tsx";
import { filteredConceptIds } from "@/shared/selectors.ts";
import { TypeFilters } from "@/features/navigation/components/TypeFilters.tsx";
import { TagBrowser } from "@/features/navigation/components/TagBrowser.tsx";
import { IndexTree } from "@/features/navigation/components/IndexTree.tsx";
import { LifecycleReviewFilters } from "@/features/navigation/components/LifecycleReviewFilters.tsx";
import { reviewStateLabel } from "@/features/review/state.ts";
import {
  comparisonLabel,
  featureReviewBatch,
  nextOutstanding,
  pendingReason,
  reviewRecordMarkdown,
  shortRevision,
  type FeatureReviewItem,
} from "@/features/review/batch.ts";
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

type AppActions = ReturnType<typeof useApp>["actions"];

/** Open a listed concept, honouring the app's tab-opening modifiers. */
function openListedConcept(
  actions: AppActions,
  id: string,
  event: MouseEvent<HTMLButtonElement>,
) {
  if (event.ctrlKey || event.metaKey || event.button === 1) {
    actions.openInNewTab(id, { background: !event.shiftKey });
  } else {
    actions.selectConcept(id);
  }
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
    openListedConcept(actions, id, event);
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

type BatchList = "changed" | "reviewed" | "outstanding";

const BATCH_LISTS: readonly BatchList[] = ["changed", "reviewed", "outstanding"];

const OUTSTANDING_RULE =
  "Outstanding until the lifecycle is stable and a human review covers the current body: the rule the OKF review check applies to pull requests.";

/**
 * The reviewer's comparison commit for this branch: the automatic base, or a
 * recent commit such as the approved specification. Saved per bundle and
 * branch; a commit outside the branch's history falls back natively. Recent
 * commits are read only when the reviewer reaches for the control.
 */
function BaselineSelect() {
  const { state, actions } = useApp();
  const status = state.bundleGitStatus;
  const root = state.activeRoot;
  const historyKey = `${root ?? ""}\0${status.headRevision ?? ""}`;
  const [revisions, setRevisions] = useState<{ key: string; list: GitRevision[] } | null>(null);
  const requested = useRef("");
  const [busy, setBusy] = useState(false);

  function loadRevisions() {
    if (!root || requested.current === historyKey) return;
    requested.current = historyKey;
    const key = historyKey;
    void quizGitRevisions(root).then(
      (list) => setRevisions({ key, list }),
      () => setRevisions({ key, list: [] }),
    );
  }

  if (!status.currentBranch) return null;
  const automatic = status.defaultBaseRevision ?? null;
  const automaticLabel = automatic && automatic === status.headRevision ? "HEAD" : "branch base";
  const selected = status.comparisonMode === "selected-commit" ? status.baseRevision ?? "" : "";
  const listed = (revisions?.key === historyKey ? revisions.list : [])
    .filter((revision) => revision.id !== automatic);
  const selectedMissing = selected !== "" && !listed.some((revision) => revision.id === selected);

  return (
    <label className="sb-review-batch__baseline">
      <span>Compare with</span>
      <select
        value={selected}
        disabled={busy}
        onFocus={loadRevisions}
        onPointerEnter={loadRevisions}
        onChange={(event) => {
          setBusy(true);
          void actions
            .setReviewBaseline(event.target.value || null)
            .finally(() => setBusy(false));
        }}
      >
        <option value="">
          Automatic: {automaticLabel} · {shortRevision(automatic)}
        </option>
        {selectedMissing ? (
          <option value={selected}>
            {shortRevision(selected)} · {status.baseSubject ?? "selected commit"}
          </option>
        ) : null}
        {listed.map((revision) => (
          <option key={revision.id} value={revision.id}>
            {revision.shortId} · {revision.subject}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The documents changed since the comparison base, as a work queue: each count
 * lists its documents, the next outstanding one is a click away, removed and
 * deprecated documents are listed for an impact check, and a completed batch
 * can be copied as a review record. Read-only throughout.
 */
function FeatureReviewPanel() {
  const { state, actions } = useApp();
  const [list, setList] = useState<BatchList | "retired" | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [removedPath, setRemovedPath] = useState<string | null>(null);
  const bundle = state.bundle;
  const status = state.bundleGitStatus;
  if (!bundle || !status.available) return null;

  const batch = featureReviewBatch(bundle, status);
  const lists: Record<BatchList, FeatureReviewItem[]> = {
    changed: batch.items,
    reviewed: batch.reviewed,
    outstanding: batch.outstanding,
  };
  const shown = list && list !== "retired" ? lists[list] : [];
  const next = nextOutstanding(batch, state.activeConceptId);
  const uncommittedReviews = status.uncommittedReviewConceptIds?.length ?? 0;
  const complete =
    batch.items.length + batch.retired.length > 0 && batch.outstanding.length === 0;

  async function copyRecord() {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      setCopyState("failed");
      return;
    }
    try {
      await clipboard.writeText(reviewRecordMarkdown(batch, status, {
        copiedAt: new Date().toISOString(),
        reviewerId: state.settings.reviewerId,
      }));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <section className="sb-review-batch" aria-label="Feature review batch">
      <div className="sb-review-batch__heading">
        <div>
          <strong>Feature review</strong>
          <span>{comparisonLabel(status)}</span>
        </div>
        <button
          type="button"
          className="sb-link-btn sb-review-batch__refresh"
          onClick={() => {
            setCopyState("idle");
            void actions.refreshBundleGitStatus();
          }}
          aria-label="Refresh feature review batch"
          title="Refresh feature review batch"
        >
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>
      <BaselineSelect />
      {status.baselineNotice ? (
        <p className="sb-review-batch__uncommitted" role="status">{status.baselineNotice}</p>
      ) : null}
      <div className="sb-review-batch__counts" role="group" aria-label="Feature review documents">
        {BATCH_LISTS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="sb-review-batch__count"
            aria-pressed={list === kind}
            disabled={lists[kind].length === 0}
            title={kind === "outstanding" ? OUTSTANDING_RULE : undefined}
            onClick={() => setList(list === kind ? null : kind)}
          >
            <strong>{lists[kind].length}</strong> {kind}
          </button>
        ))}
        {batch.retired.length > 0 ? (
          <button
            type="button"
            className="sb-review-batch__count"
            aria-pressed={list === "retired"}
            onClick={() => setList(list === "retired" ? null : "retired")}
          >
            <strong>{batch.retired.length}</strong> removed or deprecated
          </button>
        ) : null}
      </div>
      {list && list !== "retired" && shown.length > 0 ? (
        <ul className="sb-matches sb-review-batch__list" aria-label={`${list.charAt(0).toUpperCase()}${list.slice(1)} documents`}>
          {shown.map((item) => (
            <li key={item.concept.id}>
              <button
                type="button"
                className={`sb-match${state.activeConceptId === item.concept.id ? " is-active" : ""}`}
                aria-current={state.activeConceptId === item.concept.id ? "true" : undefined}
                onClick={(event) => openListedConcept(actions, item.concept.id, event)}
              >
                <span className="sb-match-title">{item.concept.title}</span>
                <span className="sb-match-path">
                  {item.wordingChanged ? "Wording" : "Metadata only"}
                  {item.outstanding ? ` · ${pendingReason(item)}` : " · reviewed"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {list === "retired" ? (
        <>
          <p className="sb-review-batch__note">
            No stamp applies to these documents. Check what linked to them.
          </p>
          <ul className="sb-matches sb-review-batch__list" aria-label="Removed or deprecated documents">
            {batch.retired.map((document) => (
              <li key={document.path}>
                <button
                  type="button"
                  className={`sb-match${state.activeConceptId === document.concept?.id ? " is-active" : ""}`}
                  onClick={(event) => {
                    if (document.concept) {
                      openListedConcept(actions, document.concept.id, event);
                    } else {
                      setRemovedPath(document.path);
                    }
                  }}
                >
                  <span className="sb-match-title">
                    {document.concept?.title ?? document.path}
                  </span>
                  <span className="sb-match-path">
                    {document.kind === "removed" ? "Removed · view last version" : "Deprecated"}
                    {document.linkedFrom.length > 0
                      ? ` · linked from ${document.linkedFrom.length}`
                      : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {batch.metadataOnly.length > 0 ? (
        <small>
          {batch.items.length - batch.metadataOnly.length} wording · {batch.metadataOnly.length} metadata only
        </small>
      ) : null}
      {next ? (
        <button
          type="button"
          className="btn sb-review-batch__next"
          title={`${next.title} — ${next.id}.md`}
          onClick={() => actions.selectConcept(next.id)}
        >
          Next outstanding: <span>{next.title}</span>
        </button>
      ) : null}
      {uncommittedReviews > 0 ? (
        <p className="sb-review-batch__uncommitted">
          {uncommittedReviews} review{uncommittedReviews === 1 ? " is" : "s are"} not committed yet.
          Commit {uncommittedReviews === 1 ? "it" : "them"} to record the approval in Git.
        </p>
      ) : null}
      {complete ? (
        <div className="sb-review-batch__complete">
          <p>
            <CheckCircle2 size={13} aria-hidden="true" />
            {batch.items.length > 0
              ? `All ${batch.items.length} changed document${batch.items.length === 1 ? " is" : "s are"} stable with a current review.`
              : "No changed document needs a stamp."}
          </p>
          <button type="button" className="btn" onClick={() => void copyRecord()}>
            Copy review record
          </button>
          <span role="status">
            {copyState === "copied"
              ? "Review record copied."
              : copyState === "failed"
                ? "The clipboard is unavailable."
                : ""}
          </span>
        </div>
      ) : null}
      <small>
        Baseline {shortRevision(status.baseRevision)}
        {status.baseSubject ? ` · ${status.baseSubject}` : ""}
      </small>
      {state.activeRoot && status.baseRevision ? (
        <RemovedDocumentDialog
          root={state.activeRoot}
          revision={status.baseRevision}
          path={removedPath}
          onClose={() => setRemovedPath(null)}
        />
      ) : null}
    </section>
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
                  <FeatureReviewPanel />
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
