// In-place comparison of a changed passage with the text Git has for it at the
// comparison base.
//
// Hovering a changed passage previews its word changes; clicking it (or Enter
// on its tab stop) opens a panel directly below the changed block. The panel is
// baked into the body HTML string rather than appended to the live DOM, for the
// reason in the note in Reader.tsx: anything added to the live body is wiped
// when React re-applies it. Its length therefore scrolls with the document
// instead of inside a box.

import { diffWords, hasWordChanges } from "@/shared/render/wordDiff.ts";
import type { DiffPart } from "@/shared/render/wordDiff.ts";
import type { GitLineChange } from "@/shared/types.ts";

export const COMPARE_CLASS = "git-diff-compare";

/** A changed passage that replaced earlier text, inline or as a whole block. */
export const PASSAGE_SELECTOR =
  ".git-diff-change.has-previous, .git-diff-change-block.has-previous";

/** What an open panel shows: word changes, or the whole previous source. */
export type ComparisonView = "changes" | "previous";

/** One hunk that replaced earlier text, with its word-level difference. */
export interface GitComparison {
  /** Position in the concept's line changes, as in `data-git-changes`. */
  index: number;
  /** One-based position among the concept's replacements. */
  ordinal: number;
  total: number;
  previousText: string;
  parts: DiffPart[];
}

/** Hunk indexes an annotation carries, as rendered into `data-git-changes`. */
export function changeIndexesOf(annotation: HTMLElement): number[] {
  return (annotation.dataset.gitChanges ?? "")
    .split(",")
    .filter((value) => value !== "")
    .map(Number)
    .filter((index) => Number.isInteger(index) && index >= 0);
}

/** The passage that is a hunk's keyboard tab stop (its first passage). */
export function passageTabStop(root: ParentNode, index: number): HTMLElement | null {
  return Array.from(
    root.querySelectorAll<HTMLElement>(".has-previous[data-git-changes][tabindex]"),
  ).find((passage) => changeIndexesOf(passage).includes(index)) ?? null;
}

/** The explicit control for a hunk, separate from its selectable prose. */
export function comparisonTrigger(root: ParentNode, index: number): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>(`[data-git-compare-toggle="${index}"]`);
}

/**
 * The comparison for each requested hunk that replaced earlier text. Pure
 * additions have nothing to compare and are skipped. Current text is read from
 * the concept body, whose lines the Git hunks are numbered against.
 */
export function gitComparisons(
  body: string,
  changes: readonly GitLineChange[],
  indexes: readonly number[],
): GitComparison[] {
  const replacements = changes.flatMap((change, index) =>
    change.previousText == null ? [] : [index],
  );
  const lines = body.split(/\r?\n/);
  const out: GitComparison[] = [];
  for (const index of [...new Set(indexes)].sort((a, b) => a - b)) {
    const change = changes[index] as GitLineChange | undefined;
    if (change?.previousText == null) continue;
    const current = lines.slice(Math.max(0, change.start - 1), Math.max(0, change.end)).join("\n");
    out.push({
      index,
      ordinal: replacements.indexOf(index) + 1,
      total: replacements.length,
      previousText: change.previousText,
      parts: diffWords(change.previousText, current),
    });
  }
  return out;
}

/** A changed run's words and the whitespace after them. The whitespace is
 *  drawn outside the strike or underline so the mark stops at the last word. */
export function splitTrailingSpace(text: string): [string, string] {
  const words = text.trimEnd();
  return words ? [words, text.slice(words.length)] : [text, ""];
}

/** Word changes as `del`/`ins` runs, each labelled for assistive technology. */
export function appendDiffParts(
  parent: HTMLElement,
  parts: readonly (DiffPart | { kind: "elided" })[],
): void {
  for (const part of parts) {
    if (part.kind === "same") {
      parent.append(part.text);
    } else if (part.kind === "elided") {
      const gap = document.createElement("span");
      gap.className = "git-diff-elided";
      gap.setAttribute("aria-hidden", "true");
      gap.textContent = "…";
      const label = document.createElement("span");
      label.className = "sr-only";
      label.textContent = " unchanged text omitted ";
      parent.append(gap, label);
    } else {
      const run = document.createElement(part.kind === "removed" ? "del" : "ins");
      const label = document.createElement("span");
      label.className = "sr-only";
      label.textContent = part.kind === "removed" ? "Removed: " : "Added: ";
      const [words, space] = splitTrailingSpace(part.text);
      // Removed text at the end of a line meets the added text directly.
      if (!space && part.kind === "removed") run.className = "git-diff-joined";
      run.append(label, words);
      parent.append(run);
      if (space) parent.append(space);
    }
  }
}

function viewButton(view: ComparisonView, current: ComparisonView, label: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "git-diff-compare-view";
  button.dataset.gitCompareView = view;
  button.setAttribute("aria-pressed", String(view === current));
  button.textContent = label;
  return button;
}

function panelElement(comparison: GitComparison, view: ComparisonView): HTMLElement {
  const panel = document.createElement("div");
  panel.className = COMPARE_CLASS;
  panel.id = `git-diff-compare-${comparison.index}`;
  panel.dataset.gitCompare = String(comparison.index);
  panel.setAttribute("role", "group");
  const count = comparison.total > 1
    ? `Change ${comparison.ordinal} of ${comparison.total}`
    : "";
  panel.setAttribute("aria-label", count ? `Earlier version, ${count.toLowerCase()}` : "Earlier version");
  panel.tabIndex = -1;

  const head = document.createElement("div");
  head.className = "git-diff-compare-head";
  const title = document.createElement("span");
  title.className = "git-diff-compare-title";
  title.textContent = "Earlier version";
  head.append(title);
  if (count) {
    const counter = document.createElement("span");
    counter.className = "git-diff-compare-count";
    counter.textContent = count;
    head.append(counter);
  }
  const views = document.createElement("span");
  views.className = "git-diff-compare-views";
  views.setAttribute("role", "group");
  views.setAttribute("aria-label", "Show");
  views.append(
    viewButton("changes", view, "Changes"),
    viewButton("previous", view, "Previous text"),
  );
  const close = document.createElement("button");
  close.type = "button";
  close.className = "git-diff-compare-close";
  close.dataset.gitCompareClose = "";
  close.textContent = "Close";
  close.setAttribute("aria-label", "Close comparison");
  head.append(views, close);

  const text = document.createElement("div");
  text.className = "git-diff-compare-text";
  if (view === "previous") {
    text.textContent = comparison.previousText;
  } else {
    appendDiffParts(text, comparison.parts);
  }
  panel.append(head, text);
  if (view === "changes" && !hasWordChanges(comparison.parts)) {
    const note = document.createElement("div");
    note.className = "git-diff-compare-note";
    note.textContent = "Only spacing or line breaks changed.";
    panel.append(note);
  }
  return panel;
}

const isElement = (node: Node | null): node is Element => node?.nodeType === 1;

const BLOCK_TAGS = new Set([
  "ADDRESS", "BLOCKQUOTE", "DETAILS", "DIV", "DL", "FIGURE", "H1", "H2", "H3",
  "H4", "H5", "H6", "HR", "OL", "P", "PRE", "SECTION", "TABLE", "UL",
]);

/** The node a panel for `annotation` goes after: the end of its rendered block. */
function insertionPoint(annotation: HTMLElement): ChildNode {
  if (annotation.classList.contains("git-diff-change-block")) return annotation;
  const cell = annotation.closest("td, th");
  if (cell) {
    const table = cell.closest("table");
    const scroll = table?.parentElement;
    if (scroll?.classList.contains("markdown-table-scroll")) return scroll;
    if (table) return table;
  }
  const block = annotation.closest("p, h1, h2, h3, h4, h5, h6, li, dt, dd");
  if (!block) return annotation;
  if (!["LI", "DT", "DD"].includes(block.tagName)) return block;
  // A tight list item holds its text directly: end the panel's run of inline
  // content before any nested list or block.
  let node: ChildNode = annotation;
  while (node.parentNode !== block && node.parentElement) node = node.parentElement;
  while (node.nextSibling && !(isElement(node.nextSibling) && BLOCK_TAGS.has(node.nextSibling.tagName))) {
    node = node.nextSibling;
  }
  return node;
}

/** Add one named control beside each replacement, after its last changed
 * block. A hidden target keeps aria-controls valid while the panel is closed.
 * This decorates already-sanitized HTML with DOM-created controls; no authored
 * passage or nested link becomes a button. */
export function insertGitComparisonControls(
  html: string,
  changes: readonly GitLineChange[],
): string {
  if (typeof document === "undefined" || !changes.some((change) => change.previousText != null)) {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  const annotations = Array.from(template.content.querySelectorAll<HTMLElement>(PASSAGE_SELECTOR));
  const replacements = changes.flatMap((change, index) => change.previousText == null ? [] : [index]);
  for (const [ordinal, index] of replacements.entries()) {
    const last = annotations.filter((annotation) => changeIndexesOf(annotation).includes(index)).at(-1);
    if (!last) continue;
    const controls = document.createElement("div");
    controls.className = "git-diff-controls";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "git-diff-compare-toggle";
    button.dataset.gitCompareToggle = String(index);
    button.dataset.gitChanges = String(index);
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", `git-diff-compare-${index}`);
    button.textContent = "Compare changes";
    if (replacements.length > 1) {
      const count = `Change ${ordinal + 1} of ${replacements.length}`;
      button.setAttribute("aria-label", `Compare changes, ${count.toLowerCase()}`);
      const counter = document.createElement("span");
      counter.className = "git-diff-control-count";
      counter.textContent = count;
      controls.append(counter);
    }
    controls.append(button);
    const closed = document.createElement("div");
    closed.id = `git-diff-compare-${index}`;
    closed.hidden = true;
    closed.dataset.gitComparePlaceholder = String(index);
    let point = insertionPoint(last);
    while (isElement(point.nextSibling) && (
      point.nextSibling.classList.contains("git-diff-controls") ||
      point.nextSibling.hasAttribute("data-git-compare-placeholder")
    )) point = point.nextSibling;
    point.after(controls, closed);
  }
  return template.innerHTML;
}

/**
 * Bake a comparison panel for each open hunk into rendered body HTML, directly
 * after the block holding the hunk's last changed passage, and mark the hunk's
 * passages as being compared. Panels for hunks in the same block stack in order.
 */
export function insertGitComparisons(
  html: string,
  panels: readonly { comparison: GitComparison; view: ComparisonView }[],
): string {
  if (panels.length === 0 || typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const annotations = Array.from(
    template.content.querySelectorAll<HTMLElement>(".has-previous[data-git-changes]"),
  );
  for (const { comparison, view } of panels) {
    const passages = annotations.filter((annotation) =>
      changeIndexesOf(annotation).includes(comparison.index),
    );
    const last = passages.at(-1);
    if (!last) continue;
    for (const passage of passages) passage.classList.add("is-comparing");
    const trigger = comparisonTrigger(template.content, comparison.index);
    trigger?.setAttribute("aria-expanded", "true");
    const placeholder = template.content.querySelector(`[data-git-compare-placeholder="${comparison.index}"]`);
    if (placeholder) {
      placeholder.replaceWith(panelElement(comparison, view));
      continue;
    }
    let point = insertionPoint(last);
    while (isElement(point.nextSibling) && point.nextSibling.classList.contains(COMPARE_CLASS)) {
      point = point.nextSibling;
    }
    point.after(panelElement(comparison, view));
  }
  return template.innerHTML;
}
