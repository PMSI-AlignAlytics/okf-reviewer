import { Fragment, useLayoutEffect, useRef } from "react";
import { condenseDiff, hasWordChanges } from "@/shared/render/wordDiff.ts";
import type { PreviewPart } from "@/shared/render/wordDiff.ts";
import { splitTrailingSpace } from "@/features/reader/gitComparison.ts";
import type { GitComparison } from "@/features/reader/gitComparison.ts";
import { interfaceScale } from "@/shared/uiScale.ts";
import "./GitDiffTooltip.css";

export const GIT_DIFF_TOOLTIP_ID = "git-diff-previous-text";

export interface GitDiffTooltipTarget {
  anchor: DOMRect;
  comparisons: GitComparison[];
}

const GAP = 8;
const MARGIN = 8;
/** Hunks a preview lists before summarizing the rest; the panel shows them all. */
const MAX_SHOWN = 3;

function DiffText({ parts }: { parts: readonly PreviewPart[] }) {
  return (
    <p className="git-diff-tooltip-text">
      {parts.map((part, index) => {
        const key = `${index}:${part.kind}`;
        if (part.kind === "same") return <span key={key}>{part.text}</span>;
        if (part.kind === "elided") {
          return (
            <span key={key}>
              <span className="git-diff-elided" aria-hidden="true">…</span>
              <span className="sr-only"> unchanged text omitted </span>
            </span>
          );
        }
        const Tag = part.kind === "removed" ? "del" : "ins";
        const [words, space] = splitTrailingSpace(part.text);
        return (
          <Fragment key={key}>
            <Tag className={!space && part.kind === "removed" ? "git-diff-joined" : undefined}>
              <span className="sr-only">{part.kind === "removed" ? "Removed: " : "Added: "}</span>
              {words}
            </Tag>
            {space}
          </Fragment>
        );
      })}
    </p>
  );
}

/**
 * Hover and focus preview of a changed passage: its word changes with a little
 * surrounding context, never scrolling. The full comparison opens in place from
 * the passage itself.
 */
export function GitDiffTooltip({
  target,
  onPointerEnter,
  onPointerLeave,
  uiScale = 1,
}: {
  target: GitDiffTooltipTarget;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  uiScale?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { anchor } = target;
    const scale = interfaceScale(uiScale);
    const viewportWidth = window.innerWidth / scale;
    const viewportHeight = window.innerHeight / scale;
    el.style.maxWidth = `${Math.max(0, viewportWidth - 2 * MARGIN)}px`;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.max(MARGIN, Math.min(anchor.left / scale, viewportWidth - width - MARGIN));
    const below = anchor.bottom / scale + GAP;
    const top =
      below + height + MARGIN <= viewportHeight || anchor.top / scale - GAP - height < MARGIN
        ? below
        : anchor.top / scale - GAP - height;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(MARGIN, top)}px`;
  }, [target, uiScale]);

  const shown = target.comparisons.slice(0, MAX_SHOWN);
  const more = target.comparisons.length - shown.length;
  return (
    <div
      ref={ref}
      id={GIT_DIFF_TOOLTIP_ID}
      className="git-diff-tooltip"
      role="tooltip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="git-diff-tooltip-title">What changed</div>
      {shown.map((comparison) => (
        <div className="git-diff-tooltip-segment" key={comparison.index}>
          {target.comparisons.length > 1 && (
            <div className="git-diff-tooltip-hunk">
              Change {comparison.ordinal} of {comparison.total}
            </div>
          )}
          {hasWordChanges(comparison.parts) ? (
            <DiffText parts={condenseDiff(comparison.parts)} />
          ) : (
            <p className="git-diff-tooltip-note">Only spacing or line breaks changed.</p>
          )}
        </div>
      ))}
      {more > 0 && (
        <div className="git-diff-tooltip-hunk">
          {more === 1 ? "1 more change" : `${more} more changes`}
        </div>
      )}
      <div className="git-diff-tooltip-hint">Click or press Enter to compare in place, or use Compare changes</div>
    </div>
  );
}
