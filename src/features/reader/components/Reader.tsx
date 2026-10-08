// Concept Reader: a reading-first pane. A centered, measure-capped prose column
// (frontmatter header + sanitized markdown body with live intra-bundle links)
// beside a quiet right context rail — On this page (scroll-spy outline), Cited
// by, Links to, Related by tag, Details, Broken links. The rail sits to the
// side in reader-only mode and falls below the article when space is tight (the
// split layout, or a narrow pane). See docs/features/concept-reader.md.

import { BrainCircuit, Gauge, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  FocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import { useActiveConcept, useApp } from "@/shared/store.tsx";
import { interfaceScale } from "@/shared/uiScale.ts";
import { titleOf, conceptById, indexIdForDir, indexNodeForId } from "@/shared/selectors.ts";
import { FolderHome } from "@/features/bundle/components/FolderHome.tsx";
import { buildTypePalette, resolveDark } from "@/shared/theme.ts";
import { renderMarkdown, resolveAssetHref, resolveHref } from "@/shared/render/markdown.ts";
import { readAssetDataUrl, readDeclaredComputation } from "@/shared/ipc.ts";
import {
  declaredComputationPath,
  materializeFileComputation,
} from "@/features/bundle/computation.ts";
import { highlightCodeBlocks } from "@/shared/render/highlight.ts";
import { renderMathBlocks } from "@/shared/render/math.ts";
import { renderMermaidBlocks } from "@/shared/render/mermaid.ts";
import type { Bundle, Concept } from "@/shared/types.ts";
import { useProfileReport } from "@/shared/useProfileReport.ts";
import { useInteropReport } from "@/shared/useInteropReport.ts";
import { buildTokenIndex, conceptAppliesTo } from "@/shared/odsf.ts";
import { ReaderPrefs } from "@/features/reader/components/ReaderPrefs.tsx";
import { SpeedReader } from "@/features/reader/components/SpeedReader.tsx";
import { ReadingPacer } from "@/features/reader/components/ReadingPacer.tsx";
import { ReaderOutline, CompactReaderOutline } from "@/features/reader/components/ReaderOutline.tsx";
import { buildReadingStream } from "@/features/reader/speedread.ts";
import { matchBlockElements } from "@/features/reader/pacerLocate.ts";
import { onSpeedReadRequest } from "@/features/reader/speedReadStart.ts";
import type { SpeedReadMode } from "@/features/reader/speedReadStart.ts";
import { TokenViz } from "@/features/viz/components/TokenViz.tsx";
import { ExamplePreview } from "@/features/bundle/components/ExamplePreview.tsx";
import { PeekCard } from "@/features/reader/components/PeekCard.tsx";
import type { PeekTarget } from "@/features/reader/components/PeekCard.tsx";
import {
  GIT_DIFF_TOOLTIP_ID,
  GitDiffTooltip,
} from "@/features/reader/components/GitDiffTooltip.tsx";
import type { GitDiffTooltipTarget } from "@/features/reader/components/GitDiffTooltip.tsx";
import {
  COMPARE_CLASS,
  PASSAGE_SELECTOR,
  changeIndexesOf,
  comparisonTrigger,
  gitComparisons,
  insertGitComparisonControls,
  insertGitComparisons,
  passageTabStop,
} from "@/features/reader/gitComparison.ts";
import type { ComparisonView } from "@/features/reader/gitComparison.ts";
import {
  MetadataInspector,
  ODSF_METADATA_KEYS,
} from "@/features/reader/components/MetadataInspector.tsx";
import {
  ConceptTrust,
  hasTrustSignals,
} from "@/features/reader/components/ConceptTrust.tsx";
import {
  ConceptComputation,
  hasComputation,
} from "@/features/reader/components/ConceptComputation.tsx";
import {
  ReviewAction,
  ReviewStateBadge,
} from "@/features/review/components/ReviewAction.tsx";
import { TypedRelationships } from "@/features/reader/components/TypedRelationships.tsx";
import { ReliabilityNotice } from "@/features/reader/components/ReliabilityNotice.tsx";
import { EvidencePanel } from "@/features/reader/components/EvidencePanel.tsx";
import { AccessNotice } from "@/features/reader/components/AccessNotice.tsx";
import {
  ConceptLanguageSelect,
  ConceptResources,
} from "@/features/reader/components/ConceptExtensions.tsx";
import { conceptNeedsInteropReport } from "@/features/bundle/interop.ts";
import { assessReliability } from "@/shared/reliability.ts";
import { assessAccessHints } from "@/shared/access.ts";
import {
  inspectConceptEvidence,
  materializeEvidenceFootnotes,
} from "@/shared/evidence.ts";
import "@/shared/styles/chrome.css";
import "./Reader.css";

/** Dwell before a hovered concept link shows its peek card (ms) — long enough
 *  that scanning prose doesn't flash cards, short enough to answer "worth
 *  opening?" without a click. Wikipedia's page previews use a similar dwell. */
const PEEK_DELAY = 450;
const GIT_DIFF_TOOLTIP_DELAY = 300;
/** No comparison open: one shared empty list, so derived values stay stable. */
const NO_COMPARISONS: readonly OpenComparison[] = [];
const SESSION_DAY = new Date().toISOString().slice(0, 10);

/** An in-place comparison open below a changed passage. */
interface OpenComparison {
  index: number;
  view: ComparisonView;
}

/** Where focus goes once an opened, closed or switched comparison re-renders. */
interface ComparisonFocus {
  index: number;
  to: "panel" | "passage" | "trigger" | ComparisonView;
}

interface OutlineItem {
  id: string;
  text: string;
  level: number;
}

/** True when an id is a real concept in the bundle. */
function conceptExists(bundle: Bundle | null, id: string): boolean {
  return conceptById(bundle, id) !== null;
}

/** Append a visually-hidden cue to a link. Idempotent so the cue is never
 *  duplicated across re-parses. */
function appendSrOnly(a: HTMLAnchorElement, text: string): void {
  if (a.querySelector(".sr-only")) return;
  const span = document.createElement("span");
  span.className = "sr-only";
  span.textContent = text;
  a.appendChild(span);
}

/** What a body link points at, so the reader can both style and route it. */
export type LinkKind =
  | { kind: "external"; url: string }
  | { kind: "asset" }
  | { kind: "concept"; id: string }
  | { kind: "directory"; dir: string }
  | { kind: "anchor"; id: string }
  | { kind: "document" }
  | { kind: "outside-scope" }
  | { kind: "unresolved" };

/** True when `dir` is a real directory in the bundle (a concept lives under it). */
function dirHasConcepts(bundle: Bundle | null, dir: string): boolean {
  return bundle?.concepts.some((x) => x.id.startsWith(`${dir}/`)) ?? false;
}

/** Classify a body link against the bundle: where does clicking it lead? */
export function classifyLink(href: string, fromId: string, bundle: Bundle | null): LinkKind {
  // A pure in-page anchor jumps to a section of this concept (heading ids are
  // baked into the body by renderMarkdown).
  if (href.startsWith("#")) return { kind: "anchor", id: href.slice(1) };
  const r = resolveHref(href, fromId);
  if (r.kind === "external") return { kind: "external", url: r.url };
  // A companion asset (.html/.css/.svg) renders as a live preview, not a concept.
  if (/\.(html|css|svg)(#|$)/i.test(href)) return { kind: "asset" };
  if (r.kind === "concept" && conceptExists(bundle, r.id)) return { kind: "concept", id: r.id };
  if (r.kind === "concept") {
    const index = indexNodeForId(bundle, r.id);
    if (index) return { kind: "directory", dir: index.dir === "." ? "" : index.dir };
  }
  if (r.kind === "concept" && dirHasConcepts(bundle, r.id)) return { kind: "directory", dir: r.id };
  const document = bundle?.documentLinks?.[fromId]?.find((link) => link.href === href);
  if (document?.state === "available") return { kind: "document" };
  if (document?.state === "outside-scope") return { kind: "outside-scope" };
  return { kind: "unresolved" };
}

/** Classify every link in the body HTML *string* and bake the routing/styling
 *  attributes (data-link, title, rel, screen-reader cue) into it. Doing this in
 *  the string — not by mutating the live DOM after render — keeps the cues from
 *  being wiped when React re-applies `dangerouslySetInnerHTML`. */
export function classifyBodyLinks(html: string, fromId: string, bundle: Bundle | null): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const a of Array.from(tpl.content.querySelectorAll("a"))) {
    // Heading permalinks carry their own styling and label (renderMarkdown).
    if (a.classList.contains("heading-anchor")) continue;
    const href = a.getAttribute("href");
    if (!href) continue;
    const link = classifyLink(href, fromId, bundle);
    switch (link.kind) {
      case "external":
        a.dataset.link = "external";
        a.setAttribute("rel", "noopener noreferrer");
        a.setAttribute("title", `Opens in your browser: ${link.url}`);
        appendSrOnly(a, " (opens in browser)");
        break;
      case "asset":
        a.dataset.link = "asset";
        a.setAttribute("title", `Companion asset: ${href}`);
        break;
      case "concept":
        // No title attribute: the peek card (hover/focus preview) supersedes
        // the native tooltip, and the two would race each other.
        a.dataset.link = "concept";
        break;
      case "directory":
        a.dataset.link = "directory";
        a.setAttribute("title", `Open section: ${link.dir}`);
        break;
      case "anchor":
        a.dataset.link = "anchor";
        a.setAttribute("title", "Jump to section");
        break;
      case "document":
        a.dataset.link = "document";
        a.setAttribute("title", `Open Markdown document in your default app: ${href}`);
        appendSrOnly(a, " (opens in default app)");
        break;
      case "outside-scope":
        a.dataset.link = "outside-scope";
        a.setAttribute("aria-disabled", "true");
        a.setAttribute("title", `Outside the opened folder. Open the containing folder in OKF Reviewer: ${href}`);
        appendSrOnly(a, " (outside the opened folder)");
        break;
      default:
        a.dataset.link = "unresolved";
        a.setAttribute("aria-disabled", "true");
        a.setAttribute("title", `Broken link (target not found in this bundle): ${href}`);
        appendSrOnly(a, " (broken link)");
    }
  }
  return tpl.innerHTML;
}

/** Humanize a path segment for the breadcrumb (e.g. "data-model" → "Data Model"). */
function humanize(seg: string): string {
  return seg.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/** Whether a raw image src is an external URL (vs a bundle-relative path). */
function isExternalUrl(raw: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//");
}

/** A non-fetching stand-in for a remote image: opens it in the system browser
 *  (handled by the body click delegation), honoring the offline stance. */
function remoteImage(url: string, alt: string | null): HTMLButtonElement {
  const label = alt?.trim() ? alt.trim() : "Remote image";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "md-img-remote";
  btn.dataset.remoteSrc = url;
  btn.title = url;
  btn.textContent = `🖼 ${label} — open in browser`;
  return btn;
}

/** Wrap a resolved image in a real `<button>` so the spotlight is reachable by
 *  keyboard (Enter/Space), not just a mouse click on the bare `<img>`. The body
 *  click delegation routes the click via the button's `data-lightbox` marker. */
function makeZoomable(img: HTMLImageElement): void {
  img.classList.add("md-img");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "md-img-zoom";
  btn.dataset.lightbox = "1";
  btn.setAttribute("aria-label", "View image full size");
  img.replaceWith(btn);
  btn.appendChild(img);
}

/** A quiet placeholder for a local image that could not be read. */
function brokenImage(raw: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "md-img-broken";
  span.textContent = `🖼 missing image: ${raw}`;
  return span;
}

/**
 * Post-process a (already-sanitized) body HTML string and return the rewritten
 * string, baked once so it survives React re-applying dangerouslySetInnerHTML:
 * - render **mermaid diagrams** (before highlighting, which would eat the block);
 * - **syntax-highlight** the remaining code blocks (Shiki, lazy + offline);
 * - **typeset math** placeholders (KaTeX, equally lazy + offline);
 * - resolve every `<img>` — a local bundle image becomes an inline `data:` URL
 *   (offline-safe, zoomable), a remote one an open-in-browser placeholder, an
 *   unresolvable one a quiet "missing" note.
 * Operates on a detached template; the diagram/highlighter/typesetter output,
 * the trusted core's data URL, and the constructed placeholders need no
 * re-sanitizing.
 */
async function processBody(html: string, conceptId: string, bundle: Bundle): Promise<string> {
  if (typeof document === "undefined") return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  await renderMermaidBlocks(tpl.content);
  await highlightCodeBlocks(tpl.content);
  await renderMathBlocks(tpl.content);
  // The await can outlive the environment (a test's DOM torn down mid-flight).
  if (typeof document === "undefined") return html;
  // A copy affordance on each fenced code block, baked into the string (the
  // click is handled by the reader's delegated body handler).
  for (const pre of Array.from(tpl.content.querySelectorAll("pre"))) {
    if (pre.querySelector(".code-copy")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.textContent = "Copy";
    btn.setAttribute("aria-label", "Copy code");
    pre.appendChild(btn);
  }
  for (const img of Array.from(tpl.content.querySelectorAll("img"))) {
    const raw = img.getAttribute("data-mdsrc");
    if (!raw) {
      // An author-inlined data: image — just make it zoomable.
      if (img.getAttribute("src")?.startsWith("data:")) {
        makeZoomable(img);
      }
      continue;
    }
    const rel = resolveAssetHref(raw, conceptId);
    if (rel) {
      const url = await readAssetDataUrl(bundle.root, rel);
      if (url) {
        img.setAttribute("src", url);
        img.removeAttribute("data-mdsrc");
        makeZoomable(img);
      } else {
        img.replaceWith(brokenImage(raw));
      }
    } else if (isExternalUrl(raw)) {
      img.replaceWith(remoteImage(raw, img.getAttribute("alt")));
    } else {
      img.replaceWith(brokenImage(raw));
    }
  }
  return tpl.innerHTML;
}

/** Concepts sharing a tag with `c`, excluding itself and its direct relations. */
function relatedByTag(bundle: Bundle | null, c: Concept): string[] {
  if (!bundle || c.tags.length === 0) return [];
  const exclude = new Set([c.id, ...c.links, ...c.citedBy]);
  const tags = new Set(c.tags);
  const out: string[] = [];
  for (const other of bundle.concepts) {
    if (exclude.has(other.id)) continue;
    if (other.tags.some((t) => tags.has(t))) out.push(other.id);
    if (out.length >= 6) break;
  }
  return out;
}

export function Reader() {
  const c = useActiveConcept();
  const { state, actions } = useApp();
  const bundle = state.bundle;
  const profileReport = useProfileReport(bundle);
  const interopReport = useInteropReport(
    conceptNeedsInteropReport(c, bundle) ? bundle : null,
  );
  const readerScale = state.settings.readerScale;
  const reduceMotion = state.settings.reduceMotion;
  const uiScale = interfaceScale(state.settings.uiScale);
  const readerActive = state.workspaceArea === "reader";

  const bodyRef = useRef<HTMLDivElement>(null);
  const lightboxCloseRef = useRef<HTMLButtonElement>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // The image currently shown in the spotlight overlay (a data URL), or null.
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<{
    root: string; fromId: string; message: string;
  } | null>(null);
  // Peek card: which concept to preview and where its trigger sits, or null.
  const [peek, setPeek] = useState<PeekTarget | null>(null);
  const [gitDiffTooltip, setGitDiffTooltip] = useState<GitDiffTooltipTarget | null>(null);
  // The dwell timer and the body anchor currently owning it/the card, so
  // pointer moves within one link don't restart the dwell.
  const peekTimerRef = useRef<number | null>(null);
  const peekAnchorRef = useRef<HTMLElement | null>(null);
  const gitDiffTimerRef = useRef<number | null>(null);
  const gitDiffHideTimerRef = useRef<number | null>(null);
  const gitDiffAnchorRef = useRef<HTMLElement | null>(null);
  const gitDiffDescriptionsRef = useRef<{
    element: HTMLElement;
    previous: string | null;
  }[]>([]);
  // In-place comparisons, tagged with the concept and its hunk ranges so that a
  // diff that moves closes them by derivation rather than by an effect racing
  // the render. Opening another concept clears them (see peekFor below).
  const [comparing, setComparing] = useState<{
    key: string;
    open: readonly OpenComparison[];
  } | null>(null);
  // Opening or closing a comparison re-applies the body, replacing the element
  // that had focus; this says where focus belongs afterwards.
  const comparisonFocusRef = useRef<ComparisonFocus | null>(null);
  const comparisonOriginRef = useRef(new Map<number, "passage" | "trigger">());
  // Focus that arrives by pointer or by that restoration is not a request for
  // a preview: a click is about to open the comparison, or already did.
  const pointerFocusRef = useRef(false);
  const restoringFocusRef = useRef(false);
  // Body HTML with images resolved, paired with the source html it derives from
  // (so a concept switch never renders the previous body while the new one loads).
  const [processed, setProcessed] = useState<{ src: string; html: string } | null>(null);
  // A file-stored computation, keyed by concept so a stale read from the
  // previous concept can never be rendered under the current one.
  const [computationSource, setComputationSource] =
    useState<{ conceptId: string; text: string | null } | null>(null);
  // Which pacing mode is running, if any. Deliberately not persisted: text that
  // advances on its own has to follow a press every time (WCAG 2.2.2). Tagged
  // with the concept it was started on, so opening another concept ends the
  // session by derivation rather than by an effect racing the render.
  const [speedRequest, setSpeedRequest] = useState<{
    conceptId: string;
    mode: SpeedReadMode;
  } | null>(null);

  // Bundle-wide design-token index (empty for a plain OKF bundle); drives both
  // the body's `{ref}` resolution and the TokenViz below.
  const tokenIndex = buildTokenIndex(bundle);
  const conceptEvidence = c
    ? inspectConceptEvidence(c.extra, c.body)
    : inspectConceptEvidence({}, "");
  const lineChanges = c
    ? state.bundleGitStatus.lineChangesByConcept?.[c.id] ?? []
    : [];
  const comparisonKey = c
    ? `${c.id}:${lineChanges.map((change) => `${change.start}-${change.end}`).join(",")}`
    : "";
  const openComparisons = comparing?.key === comparisonKey ? comparing.open : NO_COMPARISONS;
  // Classify links in the HTML string (not by post-render DOM mutation) so the
  // routing/styling cues survive React re-applying the body's innerHTML.
  const bodyHtml = c
    ? classifyBodyLinks(
        renderMarkdown(
          materializeFileComputation(
            materializeEvidenceFootnotes(c.body, conceptEvidence),
            c,
            computationSource?.conceptId === c.id ? computationSource.text : null,
          ),
          tokenIndex,
          lineChanges,
        ),
        c.id,
        bundle,
      )
    : "";
  // Use the image-resolved html once it matches the current body; until then
  // (or when there are no images) render the body as-is.
  // Open comparisons are baked in last, so toggling one never re-runs the
  // image, code and math processing above.
  const baseHtml = insertGitComparisonControls(
    processed?.src === bodyHtml ? processed.html : bodyHtml,
    lineChanges,
  );
  const comparisonViews = new Map(openComparisons.map((open) => [open.index, open.view]));
  const displayHtml = c && openComparisons.length > 0
    ? insertGitComparisons(
        baseHtml,
        gitComparisons(c.body, lineChanges, [...comparisonViews.keys()]).map((comparison) => ({
          comparison,
          view: comparisonViews.get(comparison.index) ?? "changes",
        })),
      )
    : baseHtml;
  // Identity-stable {__html} wrapper — correctness, not perf (so the React
  // Compiler convention of no manual memoization doesn't apply): React 19
  // diffs the dangerouslySetInnerHTML prop by OBJECT identity, so an inline
  // literal re-sets innerHTML on every host update of the div (e.g. when
  // onClick's identity changes) even when the string is unchanged — killing
  // the transient "Copied" feedback and detaching nodes mid-click.
  const displayHtmlProp = useMemo(() => ({ __html: displayHtml }), [displayHtml]);

  // After the body renders: build the outline and wire scroll-spy. Reads only —
  // everything the body *shows* (link cues, heading ids and permalinks, copy
  // buttons, images) is baked into the HTML string above, because anything
  // merely appended to the live DOM here is wiped when React re-applies
  // `dangerouslySetInnerHTML`.
  useEffect(() => {
    const el = bodyRef.current;
    if (!readerActive) return;
    if (!el || !c) {
      setOutline([]);
      return;
    }

    const heads = Array.from(el.querySelectorAll("h2, h3"));
    const items: OutlineItem[] = heads.map((h) => {
      const id = h.id; // baked into the HTML by renderMarkdown
      // Heading text without the baked "#" permalink glyph.
      const clone = h.cloneNode(true) as HTMLElement;
      clone.querySelector(".heading-anchor")?.remove();
      const text = clone.textContent;
      return { id, text, level: h.tagName === "H2" ? 2 : 3 };
    });
    setOutline(items);
    setActiveId(items[0]?.id ?? null);

    if (heads.length === 0) return;
    // Scroll-spy: highlight the section currently being read. A scroll handler
    // (rather than an IntersectionObserver "top band") so it stays correct at
    // the bottom of the page — short trailing sections can never scroll up into
    // a band, so there we force-activate the last heading instead.
    const scroller = el.closest(".pane");
    if (!scroller) return;
    let raf = 0;
    const sync = () => {
      raf = 0;
      // Query the *live* headings each time and map by index to the outline
      // `items`. The heading nodes captured above can be replaced after this
      // effect runs (React re-applies the dangerouslySetInnerHTML body), leaving
      // the captured nodes detached (zero rects) and the live ones without ids —
      // so we read positions from the live DOM but ids from `items`, which the
      // rail actually renders with. Index alignment holds: both are the h2/h3
      // sequence in document order.
      const live = scroller.querySelectorAll<HTMLElement>(
        ".body.markdown h2, .body.markdown h3",
      );
      if (live.length === 0 || live.length !== items.length) return;
      // Not scrollable (short doc, or jsdom) → keep the first heading active.
      if (scroller.scrollHeight <= scroller.clientHeight) return;
      // At the bottom, the last sections can't reach the top — activate the last.
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
        setActiveId(items[items.length - 1].id);
        return;
      }
      // Otherwise: the last heading scrolled above a line just below the top.
      const top = scroller.getBoundingClientRect().top;
      let idx = 0;
      for (let i = 0; i < live.length; i++) {
        if (live[i].getBoundingClientRect().top - top <= 96 * uiScale) idx = i;
        else break;
      }
      setActiveId(items[idx].id);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(sync);
    };
    sync();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // `c` is tracked via c?.id; the effect only needs to re-run on concept change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.id, displayHtml, bundle, readerActive, uiScale]);

  // Post-process the body into the HTML *string* (not by mutating the live DOM):
  // syntax-highlight code blocks and resolve images (local → inline data URL,
  // remote → open-in-browser). Baking the result into the rendered string (like
  // heading ids) keeps it from being wiped when React re-applies
  // dangerouslySetInnerHTML. `processed` is paired with the source html so a
  // concept switch never shows the previous body.
  useEffect(() => {
    let cancelled = false;
    const needsProcessing =
      bodyHtml.includes("<img") || bodyHtml.includes("<pre") || bodyHtml.includes('class="math');
    if (c && bundle && needsProcessing) {
      void processBody(bodyHtml, c.id, bundle).then((html) => {
        if (!cancelled) setProcessed({ src: bodyHtml, html });
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.id, bodyHtml, bundle?.root]);

  // Load a file-stored computation so the body can render it under the same
  // `# Computation` heading an inline one uses. Keyed by concept id rather than
  // just cancelled, because the body is derived from this during render: an
  // unkeyed value would let the previous concept's SQL appear under the new
  // concept's heading for one frame.
  //
  // `null` text is a resolved miss (absent, oversized, unreadable), not a
  // pending read. The rail panel is what tells the reader the file could not be
  // read; the body simply omits the section rather than showing an empty fence.
  // Nothing is cleared on the way out. Clearing here would be a synchronous
  // setState inside an effect — a cascading render — and it would buy nothing:
  // the body reads this only when `conceptId` matches the concept on screen, so
  // a leftover value from a previous concept is already unreachable.
  useEffect(() => {
    let cancelled = false;
    if (c && bundle && declaredComputationPath(c)) {
      const conceptId = c.id;
      void readDeclaredComputation(bundle.root, conceptId).then((text) => {
        if (!cancelled) setComputationSource({ conceptId, text });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [c, bundle]);

  // Image spotlight focus management: move focus into the dialog on open, trap
  // Tab (the close button is the only focusable element), close on Escape, and
  // restore focus to the trigger on close — the aria-modal contract.
  useEffect(() => {
    if (!lightbox || !readerActive) return;
    const returnTo = document.activeElement as HTMLElement | null;
    lightboxCloseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLightbox(null);
      } else if (e.key === "Tab") {
        e.preventDefault();
        lightboxCloseRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (returnTo?.isConnected && !returnTo.closest("[hidden]")) returnTo.focus();
    };
  }, [lightbox, readerActive]);

  // ---- Speed reading ------------------------------------------------------
  // A new concept is a new text: the request only counts for the concept it was
  // made on, so navigating away ends pacing without an effect.
  const speedMode = speedRequest && speedRequest.conceptId === c?.id ? speedRequest.mode : null;

  // The global shortcut asks for a mode from outside the reader.
  const activeConceptId = c?.id;
  useEffect(() => {
    if (!activeConceptId || !readerActive) return;
    return onSpeedReadRequest((mode) => setSpeedRequest({ conceptId: activeConceptId, mode }));
  }, [activeConceptId, readerActive]);

  /** Leave the focus player, putting the prose back where reading stopped. */
  function closeSpeedReader(blockIndex: number) {
    setSpeedRequest(null);
    const el = bodyRef.current;
    if (!el || !c || blockIndex < 0) return;
    const stream = buildReadingStream(c.body, { chunk: state.settings.speedReadChunk });
    const target = matchBlockElements(el, stream)[blockIndex];
    target?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
    });
  }

  // ---- Peek card (hover/focus preview of a concept link) ------------------
  // Declared before the no-concept early return: the effects below are hooks.
  // The handler function declarations hoist, so the effects may call them.

  function cancelPeekTimer() {
    if (peekTimerRef.current != null) {
      clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
    }
  }
  function hidePeek() {
    cancelPeekTimer();
    peekAnchorRef.current = null;
    setPeek(null);
  }

  function cancelGitDiffTimer() {
    if (gitDiffTimerRef.current != null) {
      clearTimeout(gitDiffTimerRef.current);
      gitDiffTimerRef.current = null;
    }
  }
  function cancelGitDiffHideTimer() {
    if (gitDiffHideTimerRef.current != null) {
      clearTimeout(gitDiffHideTimerRef.current);
      gitDiffHideTimerRef.current = null;
    }
  }
  function restoreGitDiffDescriptions() {
    for (const { element, previous } of gitDiffDescriptionsRef.current) {
      if (!element.isConnected) continue;
      if (previous == null) element.removeAttribute("aria-describedby");
      else element.setAttribute("aria-describedby", previous);
    }
    gitDiffDescriptionsRef.current = [];
  }
  function hideGitDiffTooltip() {
    cancelGitDiffTimer();
    cancelGitDiffHideTimer();
    restoreGitDiffDescriptions();
    gitDiffAnchorRef.current = null;
    setGitDiffTooltip(null);
  }
  function scheduleGitDiffHide() {
    cancelGitDiffHideTimer();
    gitDiffHideTimerRef.current = window.setTimeout(() => {
      gitDiffHideTimerRef.current = null;
      hideGitDiffTooltip();
    }, 120);
  }
  function showGitDiffTooltip(annotation: HTMLElement, described: HTMLElement) {
    if (!annotation.isConnected || !c) return;
    // A hunk whose comparison is already open below needs no preview.
    const body = bodyRef.current;
    const indexes = changeIndexesOf(annotation).filter(
      (index) => !body?.querySelector(`[data-git-compare="${index}"]`),
    );
    const comparisons = gitComparisons(c.body, lineChanges, indexes);
    if (comparisons.length === 0) return;
    restoreGitDiffDescriptions();
    const elements = annotation === described ? [annotation] : [annotation, described];
    gitDiffDescriptionsRef.current = elements.map((element) => ({
      element,
      previous: element.getAttribute("aria-describedby"),
    }));
    for (const element of elements) {
      const previous = element.getAttribute("aria-describedby");
      element.setAttribute(
        "aria-describedby",
        previous ? `${previous} ${GIT_DIFF_TOOLTIP_ID}` : GIT_DIFF_TOOLTIP_ID,
      );
    }
    setGitDiffTooltip({
      anchor: annotation.getBoundingClientRect(),
      comparisons,
    });
  }
  function scheduleGitDiffTooltip(annotation: HTMLElement) {
    cancelGitDiffTimer();
    gitDiffTimerRef.current = window.setTimeout(() => {
      gitDiffTimerRef.current = null;
      showGitDiffTooltip(annotation, annotation);
    }, GIT_DIFF_TOOLTIP_DELAY);
  }
  /** After the dwell, show the card anchored to `el`'s current position. */
  function schedulePeek(id: string, el: HTMLElement) {
    cancelPeekTimer();
    peekTimerRef.current = window.setTimeout(() => {
      peekTimerRef.current = null;
      // A navigation may have swapped the body while the dwell ran — a
      // detached trigger means the peek is stale, not due.
      if (!el.isConnected) return;
      setPeek({ id, anchor: el.getBoundingClientRect() });
    }, PEEK_DELAY);
  }
  /** Shared trigger for rail rows: peek `id` while hovered/focused. */
  function peekStart(id: string, el: HTMLElement) {
    if (!c || id === c.id) return;
    peekAnchorRef.current = el;
    schedulePeek(id, el);
  }

  // Dismiss on scroll (the anchor rect goes stale) and Escape while shown;
  // cancel an in-flight dwell timer on unmount.
  useEffect(() => {
    if (!peek || !readerActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hidePeek();
    };
    const scroller = bodyRef.current?.closest(".pane");
    scroller?.addEventListener("scroll", hidePeek, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      scroller?.removeEventListener("scroll", hidePeek);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek, readerActive]);
  useEffect(() => () => cancelPeekTimer(), []);
  useEffect(() => {
    if (!c || !readerActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideGitDiffTooltip();
    };
    const scroller = bodyRef.current?.closest(".pane");
    scroller?.addEventListener("scroll", hideGitDiffTooltip, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      scroller?.removeEventListener("scroll", hideGitDiffTooltip);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c?.id, readerActive]);
  useEffect(() => () => {
    cancelPeekTimer();
    cancelGitDiffTimer();
    cancelGitDiffHideTimer();
    restoreGitDiffDescriptions();
    peekAnchorRef.current = null;
    gitDiffAnchorRef.current = null;
    // A retained, hidden reader must not leave a pending hover preview behind.
  }, [readerActive, uiScale]);
  // After a comparison opens, closes or switches view, the body has been
  // re-applied; move focus to the new panel, back to the passage, or to the
  // same view button, before paint.
  useLayoutEffect(() => {
    const plan = comparisonFocusRef.current;
    comparisonFocusRef.current = null;
    const body = bodyRef.current;
    if (!plan || !body) return;
    const panel = body.querySelector<HTMLElement>(`[data-git-compare="${plan.index}"]`);
    const target =
      plan.to === "panel" ? panel
        : plan.to === "passage" ? passageTabStop(body, plan.index)
          : plan.to === "trigger" ? comparisonTrigger(body, plan.index)
          : panel?.querySelector<HTMLElement>(`[data-git-compare-view="${plan.to}"]`) ?? null;
    if (!target) return;
    restoringFocusRef.current = true;
    target.focus();
    restoringFocusRef.current = false;
  }, [displayHtml]);
  // Navigating away always drops the card — adjust-state-during-render (the
  // palette's appliedSeed pattern), so no effect and no extra commit. A dwell
  // timer that outlives the navigation is defused by the isConnected check in
  // schedulePeek (the old body's anchors are detached by the swap).
  const [peekFor, setPeekFor] = useState<string | null>(c?.id ?? null);
  if (peekFor !== (c?.id ?? null)) {
    setPeekFor(c?.id ?? null);
    if (peek) setPeek(null);
    if (gitDiffTooltip) setGitDiffTooltip(null);
    // Returning to a concept starts with its comparisons closed.
    if (comparing) setComparing(null);
  }
  const previewScope = `${readerActive}:${uiScale}`;
  const [previewFor, setPreviewFor] = useState(previewScope);
  if (previewFor !== previewScope) {
    setPreviewFor(previewScope);
    if (peek) setPeek(null);
    if (gitDiffTooltip) setGitDiffTooltip(null);
    if (lightbox) setLightbox(null);
  }

  if (!c) {
    // A directory's index.md is never a concept, but it can still be opened as a
    // "folder home" (default landing, or a directory row in the tree).
    const home = indexNodeForId(bundle, state.activeConceptId);
    if (home) return <FolderHome node={home} />;
    return (
      <div className="reader-empty">
        <p>No concept selected.</p>
        <p className="muted">Pick a concept in the sidebar to read it here.</p>
      </div>
    );
  }

  // Body hover/focus is delegated like click routing. A replacement previews
  // its word changes first; elsewhere, a concept link previews its target.
  function onBodyHoverOver(
    e: MouseEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>,
  ) {
    if (!c) return;
    const target = e.target as HTMLElement;
    const focus = e.type === "focus";
    // Focus from a click or from restoring focus after a comparison toggle is
    // not a preview request; hovering still previews after its dwell.
    if (focus && (pointerFocusRef.current || restoringFocusRef.current)) return;
    const annotation = target.closest<HTMLElement>(PASSAGE_SELECTOR);
    if (annotation) {
      hidePeek();
      // A hard-wrapped paragraph renders one hunk as a passage per line;
      // moving between them keeps the same preview.
      const current = gitDiffAnchorRef.current;
      if (
        annotation === current ||
        (current?.isConnected && current.dataset.gitChanges === annotation.dataset.gitChanges)
      ) {
        if (focus) {
          cancelGitDiffTimer();
          showGitDiffTooltip(annotation, target);
        }
        return;
      }
      hideGitDiffTooltip();
      gitDiffAnchorRef.current = annotation;
      if (focus) showGitDiffTooltip(annotation, target);
      else scheduleGitDiffTooltip(annotation);
      return;
    }
    hideGitDiffTooltip();
    const a = (e.target as HTMLElement).closest("a");
    if (a === peekAnchorRef.current) return; // still inside the same link
    hidePeek();
    const href = a?.getAttribute("href");
    if (!a || !href) return;
    const link = classifyLink(href, c.id, bundle);
    if (link.kind !== "concept" || link.id === c.id) return;
    peekAnchorRef.current = a;
    schedulePeek(link.id, a);
  }
  function onBodyHoverOut(
    e: MouseEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>,
  ) {
    const annotation = gitDiffAnchorRef.current;
    if (annotation) {
      const to = e.relatedTarget as Node | null;
      const toPassage = to instanceof Element ? to.closest<HTMLElement>(PASSAGE_SELECTOR) : null;
      if (to && annotation.contains(to)) return;
      if (toPassage?.dataset.gitChanges === annotation.dataset.gitChanges) return;
      if (e.type === "mouseout" && gitDiffTooltip) scheduleGitDiffHide();
      else hideGitDiffTooltip();
    }
    const a = peekAnchorRef.current;
    if (!a) return;
    const to = e.relatedTarget as Node | null;
    if (to && a.contains(to)) return; // moving within the link
    hidePeek();
  }

  const palette = buildTypePalette(
    bundle?.concepts.map((x) => x.type) ?? [],
    resolveDark(state.settings.theme),
  );
  const typeColor = palette.color(c.type);
  const related = relatedByTag(bundle, c);
  const hasRelationshipMetadata = Object.hasOwn(c.extra, "relationships");
  // Design-system (ODSF) extras, feature-detected — null/empty on plain OKF.
  const reliability = assessReliability(c, profileReport.report, SESSION_DAY);
  const accessHints = assessAccessHints(c);
  const appliesTo = conceptAppliesTo(c);
  // Breadcrumb: the concept's directory path (its place in the bundle).
  const crumbs = c.id.includes("/") ? c.id.split("/").slice(0, -1) : [];

  // Rail rows and body links route through one opener: plain click navigates
  // the current tab; Ctrl/Cmd+click opens a background tab (add Shift to also
  // switch) — the browser link gestures.
  const select = (id: string, e?: MouseEvent<HTMLElement>) => {
    hideGitDiffTooltip();
    hidePeek(); // the click answered the "worth opening?" question
    if (e && (e.ctrlKey || e.metaKey)) {
      actions.openInNewTab(id, { background: !e.shiftKey });
    } else {
      actions.selectConcept(id);
    }
  };

  // Event delegation for body anchor clicks: route concept links in-app,
  // external links to the OS browser, and keep unresolved links inert.
  // Declared before onBodyClick (which calls it): the React Compiler cannot
  // yet rewrite hoisted function references.
  function jumpTo(id: string) {
    const el = bodyRef.current?.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    setActiveId(id);
  }

  // ---- In-place comparison of a changed passage -------------------------
  // Each change is state, not DOM: the panels are baked into the body string
  // (see insertGitComparisons), so opening one re-applies the body and the
  // layout effect above puts focus where the reader expects it.

  /** Open the comparisons for a passage's hunks, or close them if all are open. */
  function toggleComparison(passage: HTMLElement, fromKeyboard: boolean) {
    const indexes = changeIndexesOf(passage).filter(
      (index) => lineChanges[index]?.previousText != null,
    );
    if (indexes.length === 0) return;
    hideGitDiffTooltip();
    const isOpen = (index: number) => openComparisons.some((open) => open.index === index);
    const closing = indexes.every(isOpen);
    const origin = passage.hasAttribute("data-git-compare-toggle") ? "trigger" : "passage";
    for (const index of indexes) comparisonOriginRef.current.set(index, origin);
    setComparing({
      key: comparisonKey,
      open: closing
        ? openComparisons.filter((open) => !indexes.includes(open.index))
        : [
            ...openComparisons,
            ...indexes.filter((index) => !isOpen(index)).map((index) => ({
              index,
              view: "changes" as const,
            })),
          ],
    });
    // A pointer user keeps reading where they clicked; a keyboard user is
    // taken into the panel they opened, and back to the passage on closing.
    comparisonFocusRef.current = fromKeyboard
      ? { index: indexes[0], to: closing ? origin : "panel" }
      : origin === "trigger" ? { index: indexes[0], to: "trigger" } : null;
  }
  function closeComparison(index: number) {
    hideGitDiffTooltip();
    setComparing({
      key: comparisonKey,
      open: openComparisons.filter((open) => open.index !== index),
    });
    comparisonFocusRef.current = { index, to: comparisonOriginRef.current.get(index) ?? "passage" };
  }
  function showComparisonView(index: number, view: ComparisonView) {
    if (!openComparisons.some((open) => open.index === index && open.view !== view)) return;
    setComparing({
      key: comparisonKey,
      open: openComparisons.map((open) => (open.index === index ? { index, view } : open)),
    });
    comparisonFocusRef.current = { index, to: view };
  }

  function onBodyKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (e.key === "Escape") {
      const panel = target.closest<HTMLElement>(`.${COMPARE_CLASS}`);
      if (panel) {
        e.preventDefault();
        closeComparison(Number(panel.dataset.gitCompare));
      }
      return;
    }
    // Enter or Space on a passage's own tab stop; a link inside it keeps its
    // own Enter.
    if ((e.key === "Enter" || e.key === " ") && target.matches(PASSAGE_SELECTOR)) {
      e.preventDefault();
      toggleComparison(target, true);
    }
  }

  function onBodyClick(e: MouseEvent<HTMLDivElement>) {
    if (!c) return;
    hideGitDiffTooltip();
    hidePeek(); // any click resolves the "worth opening?" question
    const target = e.target as HTMLElement;
    const compareToggle = target.closest<HTMLButtonElement>("[data-git-compare-toggle]");
    if (compareToggle) {
      toggleComparison(compareToggle, e.detail === 0);
      return;
    }
    // The in-place comparison's own controls.
    const panel = target.closest<HTMLElement>(`.${COMPARE_CLASS}`);
    if (panel) {
      const index = Number(panel.dataset.gitCompare);
      const view = target.closest<HTMLElement>("[data-git-compare-view]")?.dataset.gitCompareView;
      if (target.closest("[data-git-compare-close]")) closeComparison(index);
      else if (view === "changes" || view === "previous") showComparisonView(index, view);
      return;
    }
    // The copy affordance baked into each fenced code block.
    const copyBtn = target.closest<HTMLButtonElement>("button.code-copy");
    if (copyBtn) {
      const text = copyBtn.closest("pre")?.querySelector("code")?.textContent ?? "";
      // clipboard is undefined in insecure contexts despite the DOM lib type.
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (!clipboard) return;
      const body = bodyRef.current;
      const idx = body
        ? Array.from(body.querySelectorAll("button.code-copy")).indexOf(copyBtn)
        : -1;
      void clipboard.writeText(text).then(() => {
        // React may re-apply the body's innerHTML while the write is in
        // flight, detaching the clicked node — flag the live button instead.
        const live = copyBtn.isConnected
          ? copyBtn
          : (body?.querySelectorAll<HTMLButtonElement>("button.code-copy")[idx] ?? null);
        if (!live) return;
        live.textContent = "Copied";
        window.setTimeout(() => {
          live.textContent = "Copy";
        }, 1200);
      });
      return;
    }
    // A local image opens in the spotlight overlay — the click lands on the
    // wrapping button (also reachable by keyboard) whose img carries the src.
    const zoomBtn = target.closest<HTMLElement>("button[data-lightbox]");
    if (zoomBtn) {
      const src = zoomBtn.querySelector("img")?.getAttribute("src");
      if (src) setLightbox(src);
      return;
    }
    // A remote-image placeholder opens the original in the system browser.
    const remote = target.closest<HTMLElement>("[data-remote-src]");
    if (remote?.dataset.remoteSrc) {
      actions.openExternal(remote.dataset.remoteSrc);
      return;
    }
    const anchor = target.closest("a");
    if (!anchor) {
      // A click on a changed passage opens its comparison in place — but not
      // the second click of a double-click, the end of a text selection, or a
      // click on a control inside the passage.
      const passage = target.closest<HTMLElement>(PASSAGE_SELECTOR);
      if (
        passage &&
        e.detail <= 1 &&
        window.getSelection()?.isCollapsed !== false &&
        !target.closest("button, summary, input, select, textarea, label")
      ) {
        toggleComparison(passage, false);
      }
      return;
    }
    const href = anchor.getAttribute("href");
    if (!href) return;
    // Route by the same classification baked into the link's styling.
    const link = classifyLink(href, c.id, bundle);
    e.preventDefault();
    if (link.kind === "external") {
      actions.openExternal(link.url);
    } else if (link.kind === "concept") {
      select(link.id, e);
    } else if (link.kind === "directory") {
      // Enter the section: open its folder home (index.md landing).
      select(indexIdForDir(link.dir), e);
    } else if (link.kind === "document" && bundle) {
      setDocumentError(null);
      const root = bundle.root;
      const fromId = c.id;
      void actions.openLinkedDocument(root, fromId, href).catch((error: unknown) => {
        setDocumentError({ root, fromId, message: String(error) });
      });
    } else if (link.kind === "asset") {
      // Scroll to the asset's rendered preview above the body, if one exists.
      bodyRef.current
        ?.closest(".reader-main")
        ?.querySelector(".examples")
        ?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    } else if (link.kind === "anchor") {
      // In-page section jump — heading permalinks and authored #anchors alike.
      jumpTo(link.id);
    }
    // Missing and out-of-scope destinations remain inert.
  }

  function onBodyMouseDown(e: MouseEvent<HTMLDivElement>) {
    // Focus moves as part of the press, before the next task; until then it
    // comes from the pointer (see onBodyHoverOver).
    pointerFocusRef.current = true;
    window.setTimeout(() => {
      pointerFocusRef.current = false;
    }, 0);
    onBodyMiddleDown(e);
  }
  // Middle-click on a concept link opens it in a background tab (the browser
  // gesture). mousedown suppresses the default middle-button behaviors
  // (autoscroll/paste, which can swallow auxclick); mouseup performs the open.
  function onBodyMiddleDown(e: MouseEvent<HTMLDivElement>) {
    if (e.button === 1 && (e.target as HTMLElement).closest("a")) {
      e.preventDefault();
    }
  }
  function onBodyMiddleUp(e: MouseEvent<HTMLDivElement>) {
    if (!c || e.button !== 1) return;
    const href = (e.target as HTMLElement).closest("a")?.getAttribute("href");
    if (!href) return;
    const link = classifyLink(href, c.id, bundle);
    if (link.kind === "concept") {
      e.preventDefault();
      actions.openInNewTab(link.id, { background: true });
    }
  }

  return (
    <div
      className="reader-shell"
      data-rail="side"
      // The measure choice also feeds the side-rail collapse breakpoint: a
      // wider prose column leaves less room for the rail (Reader.css).
      data-measure={state.settings.readerMeasure}
      // Reader-scoped reading layer (the content-scoped replacement for page
      // zoom), driven by the "Aa" preferences and persisted in settings. Set
      // on the shell, not the article, so the rail sees the vars too.
      style={
        {
          "--reader-scale": readerScale,
          "--reader-measure": `${state.settings.readerMeasure}ch`,
          "--reader-leading": state.settings.readerLeading,
          "--reader-font":
            state.settings.readerFont === "serif" ? "var(--serif)" : "var(--ui)",
        } as CSSProperties
      }
    >
      <article
        className="reader-main concept-reader"
        data-reader-selection-scope
        data-concept-id={c.id}
        data-aids={state.settings.readerAids ? "on" : undefined}
      >
        <header className="reader-header">
          {/* Top row: breadcrumb at the left, reading-preferences ("Aa") at the
              right — reading options live with the content, not the title bar. */}
          <div className="reader-header-top">
              <nav className="reader-crumbs" aria-label="Breadcrumb">
                <span className="crumb">
                  <button type="button" className="reader-crumb-link" onClick={(e) => select(indexIdForDir(""), e)}>
                    {bundle?.name ?? "Home"}
                  </button>
                </span>
                {crumbs.map((seg, i) => (
                  <span key={i} className="crumb">
                    <button
                      type="button"
                      className="reader-crumb-link"
                      onClick={(e) => select(indexIdForDir(crumbs.slice(0, i + 1).join("/")), e)}
                    >
                      {humanize(seg)}
                    </button>
                  </span>
                ))}
              </nav>
            {/* Reading controls stay with the content. Human review is the only
                authoring action in this focused workspace. */}
            <div className="reader-header-actions">
              <div className="reader-action-group" role="group" aria-label="Reading">
                {/* Speed reading needs a visible way in, not only the `S` key
                    and a control inside the "Aa" popover — a mode nobody can
                    see is a mode nobody starts. This runs the focus player;
                    guided pacing and the pace itself stay in the popover. */}
                <button
                  id="reader-speed-read"
                  type="button"
                  className="reader-speed-read"
                  aria-label="Speed-read this concept"
                  title="Speed-read this concept (S)"
                  onClick={() => setSpeedRequest({ conceptId: c.id, mode: "focus" })}
                >
                  <Gauge size={14} aria-hidden="true" />
                  Speed read
                  {/* The key printed on the control, per the cap convention in
                      shared/styles/chrome.css: a boxed .kbd names a key someone
                      should press, so it need not be looked up on the sheet. */}
                  <kbd className="kbd" aria-hidden="true">
                    S
                  </kbd>
                </button>
                {readerActive && <ReaderPrefs
                  onStartSpeedRead={(mode) => setSpeedRequest({ conceptId: c.id, mode })}
                />}
              </div>
              <button
                type="button"
                className="reader-speed-read"
                aria-label="Make a quick quiz from this concept"
                title="Use this concept as the quiz target and the selected bundle as context"
                onClick={() => actions.startQuickQuiz(c.id)}
              >
                <BrainCircuit size={14} aria-hidden="true" />
                Quick quiz
              </button>
              <span className="reader-action-divider" aria-hidden="true" />
              {bundle ? <ReviewAction bundle={bundle} concept={c} /> : null}
            </div>
          </div>
          {/* One quiet meta line, not a row of pills: the type carries its
              palette color as a dot (the same encoding the Filter lens uses),
              and status only speaks up when it is exceptional. */}
          <div className="reader-labels">
            <span className="type-label">
              <span
                className="type-dot"
                style={{ background: typeColor }}
                aria-hidden="true"
              />
              {c.type}
            </span>
            <span className="status-label" data-status={c.status}>
              Lifecycle: {c.status}
              {!c.statusExplicit ? " (implicit)" : ""}
            </span>
            <ReviewStateBadge concept={c} />
            {appliesTo.length > 0 && (
              <span className="applies-label">{appliesTo.join(" · ")}</span>
            )}
            {interopReport.status === "ready" && interopReport.report ? (
              <ConceptLanguageSelect
                conceptId={c.id}
                report={interopReport.report}
                onSelect={(conceptId) => actions.selectConcept(conceptId)}
              />
            ) : null}
          </div>
          <h1>{c.title}</h1>
          {c.description && <p className="desc">{c.description}</p>}
          {lineChanges.length > 0 && (
            <p className="git-diff-legend">
              <span className="git-diff-legend-sample">Underlined text</span> and marked blocks have changed.
              {lineChanges.some((change) => change.previousText != null) ? " Compare changes shows earlier wording." : " This text was added."}
            </p>
          )}
          {readerActive && outline.length > 1 && (
            <CompactReaderOutline items={outline} activeId={activeId} onJump={jumpTo} />
          )}
          <ReliabilityNotice assessment={reliability} />
          <AccessNotice hints={accessHints} />

          {c.tags.length > 0 && (
            <ul className="tag-list" aria-label="Tags">
              {c.tags.map((t) => (
                <li key={t} className="tag">
                  {t}
                </li>
              ))}
            </ul>
          )}
        </header>

        {/* Design-token visualizations (ODSF): swatches, specimens, scales —
            renders nothing for a concept without tokens. */}
        <TokenViz concept={c} index={tokenIndex} />

        {/* Live previews of the concept's example assets (ODSF) — renders
            nothing for a concept without example HTML. Keyed by id so each
            concept mounts fresh (no stale-preview flash on navigation). */}
        <ExamplePreview key={c.id} concept={c} bundle={bundle} />

        {documentError?.root === bundle?.root && documentError?.fromId === c.id && (
          <p role="alert">{documentError.message}</p>
        )}

        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- delegated routing for in-body <a>s, which are natively keyboard-accessible (Enter fires a bubbling click), and for changed passages, whose tab stops take Enter through onKeyDown */}
        <div
          ref={bodyRef}
          className="body markdown"
          onClick={onBodyClick}
          onMouseDown={onBodyMouseDown}
          onMouseUp={onBodyMiddleUp}
          onKeyDown={onBodyKeyDown}
          onMouseOver={onBodyHoverOver}
          onMouseOut={onBodyHoverOut}
          onFocus={onBodyHoverOver}
          onBlur={onBodyHoverOut}
          // Sanitized in renderMarkdown via DOMPurify; images resolved (to local
          // data URLs / placeholders) by processBodyImages before injection.
          dangerouslySetInnerHTML={displayHtmlProp}
        />
      </article>

      <aside className="reader-rail" aria-label="Concept context">
        {outline.length > 1 && (
          <nav className="rail-module rail-outline" aria-label="On this page">
            <h3 className="rail-title">On this page</h3>
            <ReaderOutline items={outline} activeId={activeId} onJump={jumpTo} />
          </nav>
        )}

        <TypedRelationships
          bundle={bundle}
          conceptId={c.id}
          hasMetadata={hasRelationshipMetadata}
          status={profileReport.status}
          report={profileReport.report}
          message={profileReport.message}
          onSelect={select}
          onPeek={peekStart}
          onPeekEnd={hidePeek}
        />

        <EvidencePanel
          key={c.id}
          evidence={conceptEvidence}
          onOpenExternal={(url) => actions.openExternal(url)}
        />

        {bundle && interopReport.status === "ready" && interopReport.report ? (
          <ConceptResources
            conceptId={c.id}
            report={interopReport.report}
          />
        ) : null}

        {c.citedBy.length > 0 && (
          <RailModule title="Cited by" count={c.citedBy.length}>
            <RelRows bundle={bundle} ids={c.citedBy} onSelect={select} onPeek={peekStart} onPeekEnd={hidePeek} />
          </RailModule>
        )}

        {c.links.length > 0 && (
          <RailModule title="Links to" count={c.links.length}>
            <RelRows bundle={bundle} ids={c.links} onSelect={select} onPeek={peekStart} onPeekEnd={hidePeek} />
          </RailModule>
        )}

        {related.length > 0 && (
          <RailModule title="Related" count={related.length}>
            <RelRows bundle={bundle} ids={related} onSelect={select} onPeek={peekStart} onPeekEnd={hidePeek} />
          </RailModule>
        )}

        <RailModule title="Details">
          <dl className="reader-meta">
            {c.timestamp && (
              <div className="meta-row">
                <dt>Updated</dt>
                <dd>
                  <time dateTime={c.timestamp}>{c.timestamp}</time>
                </dd>
              </div>
            )}
            {c.resource && (
              <div className="meta-row">
                <dt>Resource</dt>
                <dd>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      if (c.resource) actions.openExternal(c.resource);
                    }}
                  >
                    {c.resource}
                  </button>
                </dd>
              </div>
            )}
            <div className="meta-row">
              <dt>File</dt>
              <dd>
                <code className="concept-id">{c.id}.md</code>
              </dd>
            </div>
            <div className="meta-row">
              <dt>Lifecycle</dt>
              <dd>
                {c.status}
                {!c.statusExplicit ? " (implicit OKF v0.2 default)" : ""}
              </dd>
            </div>
            <div className="meta-row">
              <dt>Concept ID</dt>
              <dd>
                <code className="concept-id">{c.id}</code>
              </dd>
            </div>
          </dl>
        </RailModule>

        {/* Above the metadata panels on purpose: whether to believe a concept
            and whether it is still current outrank the producer keys it
            happens to carry. Renders nothing on a concept that declares none of
            it, so a v0.1 bundle does not grow an empty panel per concept. */}
        {hasTrustSignals(c) && (
          <RailModule title="Trust and provenance">
            <ConceptTrust
              concept={c}
              onOpenResource={(resource) => actions.openExternal(resource)}
            />
          </RailModule>
        )}

        {/* Above the metadata panels for the same reason the trust panel is: a
            computation's contract is what the concept is for, not producer
            metadata it happens to carry. */}
        {hasComputation(c) && (
          <RailModule title="Computation contract">
            <ConceptComputation concept={c} bundleRoot={bundle?.root} />
          </RailModule>
        )}

        {bundle ? (
          <MetadataInspector
            title="Bundle metadata"
            source="index.md"
            values={bundle.extra}
          />
        ) : null}

        <MetadataInspector
          title="Concept metadata"
          source={`${c.id}.md`}
          values={c.extra}
          excludeKeys={[
            ...ODSF_METADATA_KEYS,
            "audience",
            "sensitivity",
            "handling_notes",
            "evidence",
            "provenance",
            "language",
            "translation_of",
            "sidecars",
          ]}
        />

        {c.brokenLinks.length > 0 && (
          <RailModule title="Broken links" count={c.brokenLinks.length}>
            <ul className="broken-list">
              {c.brokenLinks.map((href) => (
                <li key={href} className="broken-link" title="Unresolved link">
                  {href}
                </li>
              ))}
            </ul>
          </RailModule>
        )}
      </aside>

      {/* Speed reading. Focus replaces the screen with one word at a time;
          guided leaves the concept in place and paces a beam through it. Both
          are started by hand from the "Aa" popover — see speed-reading.md. */}
      {speedMode === "focus" && (
        <SpeedReader
          // A different text (or a different frame size) is a different reading
          // session, not the old cursor pointed at new words.
          key={`${c.id}:${state.settings.speedReadChunk}`}
          title={c.title}
          body={c.body}
          wpm={state.settings.speedReadWpm}
          chunk={state.settings.speedReadChunk}
          boldStart={state.settings.speedReadBoldStart}
          reduceMotion={reduceMotion}
          active={readerActive}
          onWpmChange={(speedReadWpm) => actions.updateSettings({ speedReadWpm })}
          onClose={closeSpeedReader}
        />
      )}
      {speedMode === "guided" && (
        <ReadingPacer
          key={`${c.id}:${state.settings.speedReadChunk}`}
          body={c.body}
          bodyRef={bodyRef}
          wpm={state.settings.speedReadWpm}
          chunk={state.settings.speedReadChunk}
          reduceMotion={reduceMotion}
          active={readerActive}
          uiScale={uiScale}
          onWpmChange={(speedReadWpm) => actions.updateSettings({ speedReadWpm })}
          onClose={() => setSpeedRequest(null)}
        />
      )}

      {/* Peek card: a hover/focus preview of a concept link — see PeekCard. */}
      {readerActive && peek && (
        <PeekCard
          target={peek}
          bundle={bundle}
          dark={resolveDark(state.settings.theme)}
          uiScale={uiScale}
        />
      )}

      {readerActive && gitDiffTooltip && (
        <GitDiffTooltip
          target={gitDiffTooltip}
          onPointerEnter={cancelGitDiffHideTimer}
          onPointerLeave={hideGitDiffTooltip}
          uiScale={uiScale}
        />
      )}

      {/* Image spotlight. Click anywhere or the close button to dismiss; Escape
          is handled by an effect. Keyboard-accessible via the close button. */}
      {readerActive && lightbox && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events -- backdrop click-to-close; Escape + a real close button provide keyboard access
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={() => setLightbox(null)}
        >
          <img className="lightbox-img" src={lightbox} alt="" />
          <button
            ref={lightboxCloseRef}
            type="button"
            className="lightbox-close"
            aria-label="Close image preview"
            onClick={() => setLightbox(null)}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

/** A titled context module in the rail, with an optional count badge. */
function RailModule({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="rail-module">
      <h3 className="rail-title">
        {title}
        {count != null && <span className="rail-count">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A list of concept rows that navigate on click (Ctrl/Cmd+click → new tab)
 *  and peek their target while hovered or focused. */
function RelRows({
  bundle,
  ids,
  onSelect,
  onPeek,
  onPeekEnd,
}: {
  bundle: Bundle | null;
  ids: string[];
  onSelect: (id: string, e?: MouseEvent<HTMLElement>) => void;
  onPeek: (id: string, el: HTMLElement) => void;
  onPeekEnd: () => void;
}) {
  return (
    <ul className="rel-list">
      {ids.map((id) => (
        <li key={id}>
          <button
            type="button"
            className="rel-link"
            onClick={(e) => onSelect(id, e)}
            onMouseEnter={(e) => onPeek(id, e.currentTarget)}
            onMouseLeave={onPeekEnd}
            onFocus={(e) => onPeek(id, e.currentTarget)}
            onBlur={onPeekEnd}
          >
            {titleOf(bundle, id)}
          </button>
        </li>
      ))}
    </ul>
  );
}
