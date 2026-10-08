// Markdown rendering, sanitization, and intra-bundle link resolution.
//
// Concept bodies and log entries are raw markdown authored inside a bundle. We
// render them with `marked`, then ALWAYS pass the result through DOMPurify so no
// untrusted HTML reaches the DOM. Links between concepts are plain markdown
// links (e.g. `../tables/x.md`); `resolveHref` turns such an href into either a
// concept id (a bundle path minus `.md`), an external URL, or a broken marker.
// See docs/features/concept-reader.md and docs/architecture/okf-parsing.md.

import { marked } from "marked";
import type { Token, TokenizerAndRendererExtension, Tokens } from "marked";
import markedFootnote from "marked-footnote";
import { markedEmoji } from "marked-emoji";
import { gemoji } from "gemoji";
import DOMPurify from "dompurify";
import type { GitLineChange } from "@/shared/types.ts";

// GitHub's emoji shortcode set (:rocket: → 🚀), name → unicode char. Plain
// text output — no image sprites, nothing to fetch, per the offline stance.
const EMOJIS: Record<string, string> = {};
for (const entry of gemoji) {
  for (const name of entry.names) EMOJIS[name] = entry.emoji;
}
const EMOJI_RE = /:([a-z0-9_+-]+):/g;

// ---------------------------------------------------------------------------
// Math ($…$ / \(...\) inline, $$…$$ / \[…\] / ```math display), covering
// the common GitHub, Pandoc, and TeX-in-Markdown conventions.
//
// The extensions below only *fence off* the TeX from markdown processing (so
// `_` never becomes <em> and `\\` survives) and emit a placeholder whose text
// content is the raw TeX. The placeholder is plain markup that passes through
// DOMPurify untouched; KaTeX itself is heavy, so actual typesetting happens
// lazily in the reader's processBody pass (src/math.ts), exactly like Shiki
// highlighting. Until then — and anywhere that pass doesn't run, like the log
// view — the TeX source shows as readable text, never lost.

/** Escape text for safe embedding as HTML text content. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A fenced block is math only when its complete info string is `math`.
// `latex` and `tex` remain ordinary source-code fences.
const MATH_FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*math[ \t]*(?:\r?\n|$)/i;
// Display delimiters at block level, optionally spanning lines.
const BLOCK_DOLLAR_MATH_RE = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\r?\n|$)/;
const BLOCK_BRACKET_MATH_RE = /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\r?\n|$)/;
// `$…$` inline: no `$` or newline inside; `\x` escapes pass through. The
// closing `$` must not be followed by a digit, so "$5 and $10" stays currency.
const INLINE_MATH_RE = /^\$((?:\\.|[^\\$\n])+?)\$(?!\d)/;
// Display delimiters written mid-paragraph still mean display math.
const INLINE_DOLLAR_BLOCK_MATH_RE = /^\$\$((?:\\.|[^\\$])+?)\$\$/;
const INLINE_BRACKET_BLOCK_MATH_RE = /^\\\[([\s\S]+?)\\\]/;
const INLINE_PAREN_MATH_RE = /^\\\(([^\n]+?)\\\)/;

/** Earliest index of one of `needles`, or undefined when none occur. */
function firstIndex(src: string, needles: readonly string[]): number | undefined {
  let first = -1;
  for (const needle of needles) {
    const at = src.indexOf(needle);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  return first < 0 ? undefined : first;
}

interface MathToken extends Tokens.Generic {
  text: string;
  display: boolean;
  literal?: boolean;
}

/** Match a complete ```math / ~~~math block, including its closing fence. */
function mathFence(src: string): { raw: string; text: string } | undefined {
  const opening = MATH_FENCE_OPEN_RE.exec(src);
  if (!opening?.[0].endsWith("\n")) return undefined;
  const fence = opening[1];
  const closing = new RegExp(
    `^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`,
    "m",
  ).exec(src.slice(opening[0].length));
  if (!closing) return undefined;
  const bodyStart = opening[0].length;
  const bodyEnd = bodyStart + closing.index;
  const rawEnd = bodyEnd + closing[0].length;
  return {
    raw: src.slice(0, rawEnd),
    text: src.slice(bodyStart, bodyEnd).trim(),
  };
}

const blockMath: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  start: (src) => firstIndex(src, ["$$", "\\[", "```", "~~~"]),
  tokenizer(src) {
    const fenced = mathFence(src);
    if (fenced) {
      return {
        type: "blockMath",
        raw: fenced.raw,
        text: fenced.text,
        display: true,
      } satisfies MathToken;
    }
    const delimited = BLOCK_DOLLAR_MATH_RE.exec(src) ?? BLOCK_BRACKET_MATH_RE.exec(src);
    if (!delimited) return undefined;
    return {
      type: "blockMath",
      raw: delimited[0],
      text: delimited[1].trim(),
      display: true,
    } satisfies MathToken;
  },
  renderer(token) {
    // A span (styled display:block), not a div: display math can also occur
    // mid-paragraph, and a div inside <p> would make the parser split the
    // paragraph. KaTeX's own display wrapper is a span for the same reason.
    return `<span class="math math-block" role="region" aria-label="Equation" tabindex="0">${escapeHtml(String(token.text))}</span>\n`;
  },
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  start: (src) => firstIndex(src, ["$", "\\(", "\\["]),
  tokenizer(src) {
    const display =
      INLINE_DOLLAR_BLOCK_MATH_RE.exec(src) ?? INLINE_BRACKET_BLOCK_MATH_RE.exec(src);
    if (display) {
      return {
        type: "inlineMath",
        raw: display[0],
        text: display[1].trim(),
        display: true,
      } satisfies MathToken;
    }
    const paren = INLINE_PAREN_MATH_RE.exec(src);
    if (paren) {
      return {
        type: "inlineMath",
        raw: paren[0],
        text: paren[1].trim(),
        display: false,
      } satisfies MathToken;
    }
    const m = INLINE_MATH_RE.exec(src);
    // Pandoc's guard: the TeX must hug its delimiters ($x$, never $ x $),
    // which keeps a stray "cost $5 … paid $ later" from becoming math.
    if (!m || /^\s|\s$/.test(m[1])) {
      // Claim unmatched multi-character openers before Marked's escape rule
      // consumes their backslash (or splits `$$` into a later `$…$` match).
      const literal = ["$$", "\\[", "\\("].find((delimiter) =>
        src.startsWith(delimiter),
      );
      if (!literal) return undefined;
      return {
        type: "inlineMath",
        raw: literal,
        text: literal,
        display: false,
        literal: true,
      } satisfies MathToken;
    }
    return {
      type: "inlineMath",
      raw: m[0],
      text: m[1],
      display: false,
    } satisfies MathToken;
  },
  renderer(token) {
    if (token.literal) return escapeHtml(String(token.text));
    const cls = token.display ? "math math-block" : "math math-inline";
    const accessibility = token.display
      ? ' role="region" aria-label="Equation" tabindex="0"'
      : "";
    return `<span class="${cls}"${accessibility}>${escapeHtml(String(token.text))}</span>`;
  },
};

// ---------------------------------------------------------------------------
// Definition lists (PHP Markdown Extra syntax): a term line followed by one or
// more `: definition` lines; consecutive groups form one <dl>. marked has no
// built-in for this — the extension follows the descriptionList pattern from
// marked's own extension docs (child tokens inline-lexed, then parseInline'd).

// One or more term/definitions groups. A term line must not itself look like
// a definition, a blank line, or another block's marker (heading, quote,
// list bullet, ordered-list number). A definition may lazily continue on
// following indented lines (the PHP Markdown Extra convention).
const DEF_LIST_RE =
  /^(?:(?!(?:[:\s#>*+-]|\d+\.[ \t]))[^\n]+\n(?::[ \t][^\n]*(?:\n|$)(?:[ \t]+\S[^\n]*(?:\n|$))*)+\n?)+/;
const DEF_LINE_RE = /^:[ \t]+/;

interface DefListToken extends Tokens.Generic {
  items: { term: Token[]; defs: Token[][] }[];
}

const defList: TokenizerAndRendererExtension = {
  name: "defList",
  level: "block",
  start(src) {
    const m = /(^|\n)(?!(?:[:\s#>*+-]|\d+\.[ \t]))[^\n]+\n:[ \t]/.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    const m = DEF_LIST_RE.exec(src);
    if (!m) return undefined;
    // Assemble raw term/definition strings first (folding lazily-continued
    // indented lines into their definition), then inline-lex each whole one.
    const items: { term: string; defs: string[] }[] = [];
    for (const line of m[0].trimEnd().split("\n")) {
      const last = items.at(-1);
      if (DEF_LINE_RE.test(line)) {
        last?.defs.push(line.replace(DEF_LINE_RE, ""));
      } else if (/^[ \t]/.test(line)) {
        if (last && last.defs.length > 0) {
          last.defs[last.defs.length - 1] += ` ${line.trim()}`;
        }
      } else if (line.trim()) {
        items.push({ term: line, defs: [] });
      }
    }
    const token: DefListToken = { type: "defList", raw: m[0], items: [] };
    for (const item of items) {
      const term: Token[] = [];
      this.lexer.inline(item.term, term);
      const defs = item.defs.map((d) => {
        const def: Token[] = [];
        this.lexer.inline(d, def);
        return def;
      });
      token.items.push({ term, defs });
    }
    return token;
  },
  renderer(token) {
    const { items } = token as DefListToken;
    let out = "<dl>\n";
    for (const item of items) {
      out += `<dt>${this.parser.parseInline(item.term)}</dt>\n`;
      for (const def of item.defs) {
        out += `<dd>${this.parser.parseInline(def)}</dd>\n`;
      }
    }
    return `${out}</dl>\n`;
  },
};

marked.use(
  // Footnotes ([^1] refs + [^1]: definitions → a linked end-of-body section).
  markedFootnote(),
  // Emoji shortcodes; the renderer emits the bare unicode char.
  markedEmoji({ emojis: EMOJIS, renderer: (token) => token.emoji }),
  { extensions: [blockMath, inlineMath, defList] },
);

// GFM "alert" callouts: a blockquote whose first line is [!NOTE] / [!TIP] /
// [!IMPORTANT] / [!WARNING] / [!CAUTION] becomes a titled, themed callout.
const ALERT_LABELS: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};
const ALERT_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(<br\s*\/?>)?\s*/i;

/**
 * Promote GFM alert blockquotes into `<div class="callout callout-KIND">` with a
 * title row, operating on a detached DOM fragment (re-sanitized afterwards). A
 * no-op where `document` is unavailable.
 */
function transformCallouts(html: string): string {
  if (typeof document === "undefined") return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const bq of Array.from(tpl.content.querySelectorAll("blockquote"))) {
    const firstP = bq.querySelector("p");
    if (!firstP) continue;
    const m = ALERT_RE.exec(firstP.textContent || "");
    if (!m) continue;
    const kind = m[1].toLowerCase();
    firstP.innerHTML = firstP.innerHTML.replace(ALERT_RE, "");
    if (!firstP.textContent.trim() && !firstP.querySelector("*")) firstP.remove();

    const callout = document.createElement("div");
    callout.className = `callout callout-${kind}`;
    const title = document.createElement("p");
    title.className = "callout-title";
    title.textContent = ALERT_LABELS[kind];
    const body = document.createElement("div");
    body.className = "callout-body";
    while (bq.firstChild) body.appendChild(bq.firstChild);
    callout.append(title, body);
    bq.replaceWith(callout);
  }
  return tpl.innerHTML;
}

// A color value safe to inline verbatim into a `style` attribute: a hex color,
// or an rgb()/hsl() function restricted to digits, separators, and percent —
// no `;`, `<`, `}`, or `url(...)`, so there is no CSS-injection surface.
const SAFE_HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SAFE_FUNC = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%/\s]+\)$/i;

function isSafeColor(value: string): boolean {
  return SAFE_HEX.test(value) || SAFE_FUNC.test(value);
}

/** A token reference: inline code that is exactly `{group.name}`. */
const TOKEN_REF = /^\{([a-zA-Z0-9_.-]+)\}$/;

// A hex color appearing *within* prose text (not a whole code span): `#` plus
// exactly 3/4/6/8 hex digits, word-bounded so `#abcde` or a 7-digit run never
// half-matches. The digits-only body keeps it safe to inline as a style.
const HEX_IN_TEXT = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;

// Elements whose text must never be touched: code/pre (literal), links, and
// anything that already carries a chip.
const SKIP_TEXT_ANCESTORS = new Set(["CODE", "PRE", "A", "STYLE", "SCRIPT"]);

/** A validated-color swatch chip element. */
function makeChip(color: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "color-chip";
  chip.setAttribute("style", `background:${color}`);
  chip.setAttribute("aria-hidden", "true");
  return chip;
}

/** Prepend a validated-color swatch chip to a `<code>` element. */
function prependChip(code: Element, color: string): void {
  code.prepend(makeChip(color));
}

/**
 * Decorate hex colors that appear in plain prose (e.g. `borderColor (#d1d9e0)`)
 * with a swatch, by rewriting matching text nodes. Skips code/pre/link text (and
 * anything under them). The matched value is hex-only, so inlining it as a style
 * is safe.
 */
function decorateHexInText(root: DocumentFragment): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.nodeValue.includes("#")) continue;
    let el = text.parentElement;
    let skip = false;
    while (el) {
      // Math placeholders hold raw TeX (`\color{#ff0000}`) — never rewrite it.
      if (SKIP_TEXT_ANCESTORS.has(el.tagName) || el.classList.contains("math")) {
        skip = true;
        break;
      }
      el = el.parentElement;
    }
    if (!skip) targets.push(text);
  }
  for (const text of targets) {
    const value = text.nodeValue;
    HEX_IN_TEXT.lastIndex = 0;
    if (!HEX_IN_TEXT.test(value)) continue;
    HEX_IN_TEXT.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = HEX_IN_TEXT.exec(value)) !== null) {
      const hex = m[0];
      if (m.index > last) frag.appendChild(document.createTextNode(value.slice(last, m.index)));
      // Keep the chip and the hex on one line.
      const wrap = document.createElement("span");
      wrap.className = "color-token";
      wrap.appendChild(makeChip(hex));
      wrap.appendChild(document.createTextNode(hex));
      frag.appendChild(wrap);
      last = m.index + hex.length;
    }
    if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
    text.replaceWith(frag);
  }
}

/**
 * Enhance rendered content in place, reading the document as authored:
 * - inline `<code>` that is *exactly* a color (hex / rgb / hsl) gets a swatch;
 * - inline `<code>` that is a `{group.name}` token reference is resolved against
 *   `tokenIndex` (when given) — annotated with the value it resolves to, and
 *   given a swatch too when that value is itself a color;
 * - a hex color appearing in plain prose (`(#d1d9e0)`) gets a swatch too.
 *
 * Runs on a detached fragment after sanitization; a chip's only dynamic part is
 * the color, validated by {@link isSafeColor} before it reaches the inline
 * style, and the resolved value is set via `setAttribute` (auto-escaped), so
 * there is no injection surface. A no-op without a DOM (SSR / node-env tests).
 */
function decorateColorValues(html: string, tokenIndex?: Record<string, string>): string {
  if (typeof document === "undefined") return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const code of Array.from(tpl.content.querySelectorAll("code"))) {
    if (code.querySelector(".color-chip")) continue; // idempotent
    const value = code.textContent.trim();
    if (isSafeColor(value)) {
      prependChip(code, value);
      continue;
    }
    const ref = TOKEN_REF.exec(value);
    if (tokenIndex && ref && Object.prototype.hasOwnProperty.call(tokenIndex, ref[1])) {
      const resolved = tokenIndex[ref[1]];
      code.setAttribute("title", `resolves to ${resolved}`);
      if (isSafeColor(resolved)) prependChip(code, resolved);
    }
  }
  decorateHexInText(tpl.content);
  neutralizeMedia(tpl.content);
  containInlineStyles(tpl.content);
  containTables(tpl.content);
  return tpl.innerHTML;
}

/**
 * Give authored tables their own horizontal overflow boundary. The table keeps
 * native layout and semantics; the wrapper prevents a genuinely wide schema
 * from widening the reader or forcing ordinary columns down to one character.
 */
function containTables(root: DocumentFragment): void {
  for (const table of Array.from(root.querySelectorAll("table"))) {
    if (table.parentElement?.classList.contains("markdown-table-scroll")) {
      table.parentElement.tabIndex = 0;
      continue;
    }
    const scroll = document.createElement("div");
    scroll.className = "markdown-table-scroll";
    scroll.tabIndex = 0;
    table.replaceWith(scroll);
    scroll.appendChild(table);
  }
}

/**
 * Defuse media loading at render time — the offline stance: nothing in a body
 * may auto-fetch. For `<img>` (markdown or embedded HTML alike), a non-`data:`
 * `src` moves to `data-mdsrc` and `srcset` is dropped; the reader then resolves
 * each image — inlining a local bundle file, or offering a remote one as an
 * external link. Embedded `<video>`/`<audio>`/`<source>`/`<track>` have no
 * offline resolver, so their fetching attributes are simply removed and the
 * players render inert. Inline `data:` sources are left as-is.
 */
function neutralizeMedia(root: DocumentFragment): void {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src && !/^data:/i.test(src)) {
      img.setAttribute("data-mdsrc", src);
      img.removeAttribute("src");
    }
    img.removeAttribute("srcset");
  }
  for (const el of Array.from(root.querySelectorAll("video, audio, source, track"))) {
    for (const attr of ["src", "srcset", "poster"]) {
      const value = el.getAttribute(attr);
      if (value && !/^data:/i.test(value)) el.removeAttribute(attr);
    }
  }
}

/**
 * Contain embedded HTML's inline styles to the prose flow. `style` attributes
 * survive sanitization (embedded HTML legitimately uses them for color and
 * alignment), but bundle content must never escape its box and overlay the
 * app's UI — so out-of-flow positioning is dropped. `relative` stays: it can't
 * leave the reader column.
 */
function containInlineStyles(root: DocumentFragment): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
    const position = el.style.getPropertyValue("position");
    if (/^(fixed|sticky|absolute)$/i.test(position.trim())) {
      el.style.removeProperty("position");
    }
  }
}

/** Slugify heading text into a stable id (matches the reader's outline). */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/**
 * Prepare body headings *in the HTML string* — demote, slug, and anchor them —
 * so the result is inherent to the rendered DOM (scroll-spy, the outline,
 * anchor permalinks, and hash links all rely on it). Baking it here — rather
 * than mutating the injected DOM at mount — keeps it present no matter how
 * React re-applies the `dangerouslySetInnerHTML` body.
 *
 * - Body `<h1>`s demote to `<h2>`: the page's one h1 is the concept title, and
 *   OKF bodies conventionally use `# Section` headings (`# Schema`,
 *   `# Examples`) — left as h1 they'd rival the title and, worse, sit outside
 *   the outline/anchor pass entirely.
 * - Every h2–h6 gets a deduped slug id and a hover permalink (`.heading-anchor`)
 *   that scrolls to the section; the click is routed by the reader's delegated
 *   body handler.
 */
function slugifyHeadings(html: string): string {
  if (typeof document === "undefined") return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const h1 of Array.from(tpl.content.querySelectorAll("h1"))) {
    const h2 = document.createElement("h2");
    while (h1.firstChild) h2.appendChild(h1.firstChild);
    h1.replaceWith(h2);
  }
  const used = new Set<string>();
  for (const h of Array.from(tpl.content.querySelectorAll("h2, h3, h4, h5, h6"))) {
    // The footnotes section's heading keeps its `footnote-label` id (every
    // ref's aria-describedby points at it) and gets no permalink; dropping
    // the extension's sr-only class shows it as a normal section heading.
    if (h.closest("[data-footnotes]")) {
      h.classList.remove("sr-only");
      if (!h.classList.length) h.removeAttribute("class");
      continue;
    }
    const base = slugify(h.textContent);
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    h.id = id;
    const a = document.createElement("a");
    a.className = "heading-anchor";
    a.href = `#${id}`;
    a.textContent = "#";
    a.setAttribute("aria-label", `Link to section: ${h.textContent}`);
    h.appendChild(a);
  }
  return tpl.innerHTML;
}

/** What kind of thing a `PlainBlock` was in the source. */
export type PlainBlockKind =
  // Prose — carries readable text.
  | "paragraph"
  | "heading"
  | "listItem"
  | "quote"
  // Not prose — carries source that only means anything rendered as itself.
  | "code"
  | "table"
  | "math"
  | "mermaid";

/** The prose kinds, i.e. the blocks whose `text` is worth reading aloud. */
export const PROSE_BLOCK_KINDS: ReadonlySet<PlainBlockKind> = new Set<PlainBlockKind>([
  "paragraph",
  "heading",
  "listItem",
  "quote",
]);

/** One block of a markdown body, split before syntax is stripped. */
export interface PlainBlock {
  kind: PlainBlockKind;
  /** Prose with markdown syntax stripped; empty for the non-prose kinds. */
  text: string;
  /** The authored source, verbatim — what a non-prose block renders from. */
  source: string;
  /** Heading depth (1–6) for `heading`; 0 otherwise. */
  level: number;
}

/** Inline markdown → bare text. Block-level markers are stripped by the
 *  splitter, which knows which construct a line belongs to. */
function stripInline(s: string): string {
  return (
    s
      // Display math is an object, not prose. Drop it even when authored
      // mid-paragraph; block-level display math is split out before this pass.
      .replace(/\$\$(?:\\.|[^\\$])*?\$\$/gs, " ")
      .replace(/\\\[[\s\S]*?\\\]/g, " ")
      // Inline math keeps its TeX minus the delimiters. Currency is safe: the
      // pattern needs a non-space on both inner edges.
      .replace(/\$(\S(?:[^$\n]*?\S)?)\$(?!\d)/g, "$1")
      .replace(/\\\(([^\n]+?)\\\)/g, "$1")
      // Embedded HTML: tags drop but keep their text content (`<kbd>Ctrl</kbd>`
      // reads as `Ctrl`). Prose like "a < b" is untouched — the tag pattern
      // requires a letter (or /) right after the bracket.
      .replace(/<\/?[a-zA-Z][^>\n]*>/g, "")
      // Images (before links: same bracket syntax) and links → their alt/text.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Footnotes: a [^ref] marker vanishes; a definition keeps only its prose.
      .replace(/\[\^[^\]\s]+\]:?/g, "")
      // GFM alert markers ([!NOTE] etc.) read as noise without their styling.
      .replace(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gi, "")
      // Emoji shortcodes read as their character (unknown names stay literal).
      .replace(EMOJI_RE, (m, name: string) => EMOJIS[name] ?? m)
      // Inline emphasis/code tokens → bare text.
      .replace(/(\*\*|__|[*_~`])/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const FENCE_RE = /^ {0,3}(```+|~~~+)[ \t]*([^\n]*)$/;
const FENCE_END_RE = /^ {0,3}(```+|~~~+)[ \t]*$/;
const TABLE_RE = /^ {0,3}\|/;
const RULE_RE = /^ {0,3}([-=_*][ \t]*){3,}$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const QUOTE_RE = /^ {0,3}> ?/;
const LIST_RE = /^[ \t]*([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/;
const DEF_MARKER_RE = /^ {0,3}:[ \t]+/;
const DOLLAR_BLOCK_MATH_OPEN_RE = /^ {0,3}\$\$/;
const BRACKET_BLOCK_MATH_OPEN_RE = /^ {0,3}\\\[/;
const DOLLAR_BLOCK_MATH_CLOSE_RE = /\$\$[ \t]*$/;
const BRACKET_BLOCK_MATH_CLOSE_RE = /\\\][ \t]*$/;

/** Index just after a complete block-math expression, or null if unmatched. */
function blockMathEnd(lines: readonly string[], start: number): number | null {
  const opening = DOLLAR_BLOCK_MATH_OPEN_RE.test(lines[start])
    ? DOLLAR_BLOCK_MATH_OPEN_RE
    : BRACKET_BLOCK_MATH_OPEN_RE.test(lines[start])
      ? BRACKET_BLOCK_MATH_OPEN_RE
      : null;
  if (!opening) return null;
  const closing =
    opening === DOLLAR_BLOCK_MATH_OPEN_RE
      ? DOLLAR_BLOCK_MATH_CLOSE_RE
      : BRACKET_BLOCK_MATH_CLOSE_RE;
  const afterOpening = lines[start].replace(opening, "");
  if (afterOpening && closing.test(afterOpening)) return start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    if (closing.test(lines[i])) return i + 1;
  }
  return null;
}

/**
 * Split a markdown body into ordered blocks, keeping prose and non-prose apart.
 *
 * Splitting *before* stripping is what lets a consumer treat a code fence, a
 * table, or a display equation as an object rather than as a run of words: the
 * reader's [speed-reading mode](../../features/reader/speedread.ts) stops at
 * those blocks instead of tokenizing them, and `plainExcerpt` simply drops them.
 * Pure string work (no DOM), so it runs anywhere.
 */
export function plainBlocks(md: string): PlainBlock[] {
  // Comments can span blocks, so they go before any line work.
  const lines = md.replace(/<!--[\s\S]*?(-->|$)/g, " ").split(/\r?\n/);
  const out: PlainBlock[] = [];
  let para: string[] = [];

  // Only ever called for the prose kinds; a block that stripped down to nothing
  // (a bare `>` line, a marker with no words) is not a block worth carrying.
  const push = (kind: PlainBlockKind, text: string, source: string, level = 0) => {
    if (text) out.push({ kind, text, source, level });
  };
  const flushPara = () => {
    if (para.length === 0) return;
    const source = para.join("\n");
    // A definition-list line (`: definition`) is the one block-level marker
    // that can appear inside an ordinary paragraph run.
    const text = stripInline(para.map((l) => l.replace(DEF_MARKER_RE, "")).join("\n"));
    para = [];
    if (text) out.push({ kind: "paragraph", text, source, level: 0 });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const start = i;
      i++;
      while (i < lines.length && !FENCE_END_RE.test(lines[i])) i++;
      if (i < lines.length) i++; // consume the closing fence
      const source = lines.slice(start, i).join("\n");
      out.push({
        kind:
          fence[2].trim().toLowerCase() === "mermaid"
            ? "mermaid"
            : fence[2].trim().toLowerCase() === "math"
              ? "math"
              : "code",
        text: "",
        source,
        level: 0,
      });
      continue;
    }

    const mathEnd = blockMathEnd(lines, i);
    if (mathEnd !== null) {
      flushPara();
      const start = i;
      i = mathEnd;
      out.push({ kind: "math", text: "", source: lines.slice(start, i).join("\n"), level: 0 });
      continue;
    }

    if (TABLE_RE.test(line)) {
      flushPara();
      const start = i;
      while (i < lines.length && TABLE_RE.test(lines[i])) i++;
      out.push({ kind: "table", text: "", source: lines.slice(start, i).join("\n"), level: 0 });
      continue;
    }

    if (RULE_RE.test(line)) {
      flushPara();
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      push("heading", stripInline(heading[2]), line, heading[1].length);
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flushPara();
      const start = i;
      while (i < lines.length && lines[i].trim() && QUOTE_RE.test(lines[i])) i++;
      const raw = lines.slice(start, i);
      push("quote", stripInline(raw.map((l) => l.replace(QUOTE_RE, "")).join("\n")), raw.join("\n"));
      continue;
    }

    if (LIST_RE.test(line)) {
      flushPara();
      const start = i;
      i++;
      // Indented continuations belong to the item; a new marker starts a new one.
      while (i < lines.length && lines[i].trim() && !LIST_RE.test(lines[i]) && /^[ \t]+\S/.test(lines[i])) {
        i++;
      }
      const raw = lines.slice(start, i);
      push("listItem", stripInline(raw.join("\n").replace(LIST_RE, "")), raw.join("\n"));
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out;
}

/**
 * A plain-text excerpt of a markdown body for the reader's peek card — the
 * first real prose, markdown syntax stripped, clamped to `max` characters at a
 * word boundary. Pure string work (no DOM), so it runs anywhere and is cheap
 * enough to compute on hover. See docs/proposals/multi-view.md.
 */
export function plainExcerpt(md: string, max = 280): string {
  const text = plainBlocks(md)
    .filter((b) => PROSE_BLOCK_KINDS.has(b.kind))
    .map((b) => b.text)
    .join(" ")
    .trim();
  if (text.length <= max) return text;
  // Clamp at a word boundary, then signal the cut.
  const cut = text.slice(0, max + 1);
  const atWord = cut.slice(0, cut.lastIndexOf(" "));
  return `${(atWord.length > max / 2 ? atWord : cut.slice(0, max)).trimEnd()}…`;
}

/**
 * Render markdown to sanitized, safe-to-inject HTML. When `tokenIndex` is given
 * (the reader passes the bundle's design-token index), `{group.name}` references
 * in inline code are resolved and annotated. See docs/architecture/application.md#reader-extensions.
 */
const GIT_DIFF_CLASS = "git-diff-change";
const TABLE_DIVIDER_RE =
  /^ {0,3}\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT_OR_RULE_RE = /^ {0,3}(?:=+|-+|(?:[*_]\s*){3,})\s*$/;

function lineChangeIndexes(
  lineCount: number,
  changes: readonly GitLineChange[],
): number[][] {
  const indexes = Array.from({ length: lineCount }, () => [] as number[]);
  changes.forEach((change, index) => {
    const start = Math.max(1, Math.trunc(change.start));
    const end = Math.min(lineCount, Math.trunc(change.end));
    for (let line = start; line <= end; line++) indexes[line - 1].push(index);
  });
  return indexes;
}

function changeAttribute(indexes: readonly number[]): string {
  return indexes.join(",");
}

function changedSpan(content: string, indexes: readonly number[]): string {
  return `<span class="${GIT_DIFF_CLASS}" data-git-changes="${changeAttribute(indexes)}">${content}</span>`;
}

function blockMarker(indexes: readonly number[]): string {
  return `<span data-okf-git-diff-block="${changeAttribute(indexes)}"></span>`;
}

function blockChangeIndexes(
  changesByLine: readonly (readonly number[])[],
  start: number,
  end: number,
): number[] {
  const indexes = new Set<number>();
  for (let line = start; line <= end; line++) {
    for (const index of changesByLine[line] ?? []) indexes.add(index);
  }
  return [...indexes];
}

/** True for a table pipe that is neither escaped nor inside an inline-code run. */
function tablePipes(line: string): number[] {
  const pipes: number[] = [];
  let codeFence = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "`" && (i === 0 || line[i - 1] !== "\\")) {
      let run = 1;
      while (line[i + run] === "`") run++;
      codeFence = codeFence === run ? 0 : codeFence === 0 ? run : codeFence;
      i += run - 1;
      continue;
    }
    if (line[i] === "|" && codeFence === 0 && (i === 0 || line[i - 1] !== "\\")) {
      pipes.push(i);
    }
  }
  return pipes;
}

/** Wrap the visible content of every table cell without moving its pipes. */
function annotateTableRow(line: string, indexes: readonly number[]): string {
  const pipes = tablePipes(line);
  if (pipes.length === 0) return annotateProseLine(line, indexes);
  const boundaries = [-1, ...pipes, line.length];
  let output = "";
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i] + 1;
    const end = boundaries[i + 1];
    const cell = line.slice(start, end);
    const leading = /^\s*/.exec(cell)?.[0] ?? "";
    const trailing = /\s*$/.exec(cell)?.[0] ?? "";
    const content = cell.slice(leading.length, cell.length - trailing.length);
    output += leading;
    if (content) output += changedSpan(content, indexes);
    output += trailing;
    if (end < line.length) output += "|";
  }
  return output;
}

/** Keep block syntax outside the generated span so Marked still sees the same
 * heading/list/definition structure and trailing hard-break whitespace. */
function annotateProseLine(line: string, indexes: readonly number[]): string {
  if (!line.trim() || SETEXT_OR_RULE_RE.test(line)) return line;
  // Link reference definitions have no directly rendered text; wrapping their
  // destination would change Markdown resolution rather than highlighting it.
  if (/^ {0,3}\[[^\]^]+\]:/.test(line)) return line;

  const prefix = /^( {0,3}(?:#{1,6}[ \t]+|(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|\[\^[^\]]+\]:[ \t]*|:[ \t]+)?)/
    .exec(line)?.[0] ?? "";
  const remainder = line.slice(prefix.length);
  const trailing = /(?: {2,}|\\)$/.exec(remainder)?.[0] ?? "";
  const content = remainder.slice(0, remainder.length - trailing.length);
  if (!content) return line;
  return `${prefix}${changedSpan(content, indexes)}${trailing}`;
}

/** Insert a private, empty marker before a Markdown block. It is promoted into
 * a wrapper on the rendered block and removed before sanitization, allowing
 * code, math, callouts, and embedded HTML to keep their native rendering. */
function appendBlock(
  output: string[],
  lines: readonly string[],
  start: number,
  end: number,
  changeIndexes: readonly number[],
): void {
  if (changeIndexes.length > 0) {
    if (output.length > 0 && output.at(-1) !== "") output.push("");
    output.push(blockMarker(changeIndexes), "");
  }
  output.push(...lines.slice(start, end + 1));
}

/** Add diff annotations to authored source before Marked parses it. Inline
 * prose is wrapped at the content boundary; syntax-sensitive blocks receive a
 * marker that is applied to their rendered container afterward. */
function annotateGitDiff(md: string, changes: readonly GitLineChange[]): string {
  const lines = md.split(/\r?\n/);
  const changesByLine = lineChangeIndexes(lines.length, changes);
  const tableLines = new Set<number>();
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!TABLE_DIVIDER_RE.test(lines[i + 1]) || tablePipes(lines[i]).length === 0) continue;
    tableLines.add(i);
    tableLines.add(i + 1);
    for (let row = i + 2; row < lines.length && tablePipes(lines[row]).length > 0; row++) {
      tableLines.add(row);
    }
  }

  const output: string[] = [];
  for (let i = 0; i < lines.length;) {
    const fence = FENCE_OPEN_RE.exec(lines[i]);
    if (fence) {
      const delimiter = fence[1];
      const close = new RegExp(`^ {0,3}${delimiter[0]}{${delimiter.length},}\\s*$`);
      let end = i + 1;
      while (end < lines.length && !close.test(lines[end])) end++;
      if (end >= lines.length) end = lines.length - 1;
      appendBlock(output, lines, i, end, blockChangeIndexes(changesByLine, i, end));
      i = end + 1;
      continue;
    }

    if (/^ {0,3}>/.test(lines[i])) {
      let end = i;
      while (end + 1 < lines.length && /^ {0,3}>/.test(lines[end + 1])) end++;
      appendBlock(output, lines, i, end, blockChangeIndexes(changesByLine, i, end));
      i = end + 1;
      continue;
    }

    const mathDelimiter = /^ {0,3}(\$\$|\\\[)/.exec(lines[i])?.[1];
    if (mathDelimiter) {
      const closing = mathDelimiter === "$$" ? /\$\$\s*$/ : /\\\]\s*$/;
      let end = i;
      const afterOpen = lines[i].replace(/^ {0,3}(?:\$\$|\\\[)/, "");
      if (!closing.test(afterOpen)) {
        end++;
        while (end < lines.length && !closing.test(lines[end])) end++;
        if (end >= lines.length) end = lines.length - 1;
      }
      appendBlock(output, lines, i, end, blockChangeIndexes(changesByLine, i, end));
      i = end + 1;
      continue;
    }

    if (/^(?: {4}|\t)\S/.test(lines[i])) {
      let end = i;
      while (end + 1 < lines.length && /^(?: {4}|\t|\s*$)/.test(lines[end + 1])) end++;
      appendBlock(output, lines, i, end, blockChangeIndexes(changesByLine, i, end));
      i = end + 1;
      continue;
    }

    // Block HTML needs to stay byte-for-byte intact for Marked. Annotate its
    // rendered container when a tag-led block line changes.
    if (/^ {0,3}<(?:address|article|aside|blockquote|details|div|figure|footer|header|main|nav|ol|p|pre|section|summary|table|ul)\b/i.test(lines[i])) {
      const tag = /^ {0,3}<([a-z][\w-]*)\b/i.exec(lines[i])?.[1];
      let end = i;
      if (tag && !new RegExp(`</${tag}>`, "i").test(lines[i])) {
        while (end + 1 < lines.length) {
          end++;
          if (new RegExp(`</${tag}>`, "i").test(lines[end])) break;
        }
      }
      appendBlock(output, lines, i, end, blockChangeIndexes(changesByLine, i, end));
      i = end + 1;
      continue;
    }

    // Separator rows are table syntax, not visible text. Wrapping one in a
    // change span stops Marked recognizing the table (including new files).
    const tableLine = tableLines.has(i);
    const tableDivider = tableLine && TABLE_DIVIDER_RE.test(lines[i]);
    output.push(
      changesByLine[i].length > 0 && !tableDivider
        ? tableLine
          ? annotateTableRow(lines[i], changesByLine[i])
          : annotateProseLine(lines[i], changesByLine[i])
        : lines[i],
    );
    i++;
  }
  return output.join("\n");
}

/** Replace generated marker paragraphs with a stable wrapper around the next
 * rendered block. The wrapper survives lazy code/diagram/math enhancement. */
function prepareGitDiffAnnotations(
  html: string,
  changes: readonly GitLineChange[],
): string {
  if (typeof document === "undefined" || changes.length === 0) {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const marker of Array.from(
    template.content.querySelectorAll<HTMLElement>("[data-okf-git-diff-block]"),
  )) {
    const markerBlock = marker.parentElement;
    const target = markerBlock?.nextElementSibling;
    if (markerBlock && target) {
      const wrapper = document.createElement("div");
      wrapper.className = `${GIT_DIFF_CLASS}-block`;
      wrapper.dataset.gitChanges = marker.dataset.okfGitDiffBlock ?? "";
      target.replaceWith(wrapper);
      wrapper.appendChild(target);
      markerBlock.remove();
    } else {
      marker.remove();
    }
  }

  // One tab stop per replaced hunk, on its first passage: the reader opens the
  // hunk's comparison from there with Enter, even when the passage holds a
  // link, and a hard-wrapped paragraph (a passage per line) is still one stop.
  const tabStops = new Set<number>();
  for (const annotation of Array.from(
    template.content.querySelectorAll<HTMLElement>(
      `.${GIT_DIFF_CLASS}[data-git-changes], .${GIT_DIFF_CLASS}-block[data-git-changes]`,
    ),
  )) {
    const replaced = (annotation.dataset.gitChanges ?? "")
      .split(",")
      .map(Number)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < changes.length)
      .filter((index) => changes[index].previousText != null);
    if (replaced.length === 0) continue;
    annotation.classList.add("has-previous");
    if (replaced.some((index) => !tabStops.has(index))) {
      annotation.tabIndex = 0;
      for (const index of replaced) tabStops.add(index);
    }
  }
  return template.innerHTML;
}

export function renderMarkdown(
  md: string,
  tokenIndex?: Record<string, string>,
  lineChanges: readonly GitLineChange[] = [],
): string {
  // `async: false` forces the synchronous overload (string, not Promise).
  // `gfm` enables tables/strikethrough; `breaks:false` keeps authored single
  // newlines from becoming spurious <br>.
  const source = lineChanges.length > 0 ? annotateGitDiff(md, lineChanges) : md;
  const html = marked.parse(source, {
    async: false,
    gfm: true,
    breaks: false,
  });
  const clean = DOMPurify.sanitize(
    prepareGitDiffAnnotations(
      slugifyHeadings(transformCallouts(html)),
      lineChanges,
    ),
    {
      USE_PROFILES: { html: true },
    },
  );
  // Decorate after sanitizing: the chip is fully constructed here from a
  // strictly-validated color, so it adds no untrusted markup.
  return decorateColorValues(clean, tokenIndex);
}

/** Outcome of resolving a markdown link href found inside a concept body. */
export type ResolvedHref =
  | { kind: "concept"; id: string }
  | { kind: "external"; url: string }
  | { kind: "broken"; href: string };

const PERCENT_BYTE_RUN = /(?:%[0-9a-f]{2})+/gi;

/** Decode valid percent-byte runs while leaving malformed sequences literal. */
function percentDecodePath(value: string): string {
  return value.replace(PERCENT_BYTE_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      const bytes = run.match(/[0-9a-f]{2}/gi)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
      return new TextDecoder().decode(Uint8Array.from(bytes));
    }
  });
}

/** The directory portion of a concept id (path), or "" for a root-level id. */
function dirOf(conceptId: string): string {
  const slash = conceptId.lastIndexOf("/");
  return slash === -1 ? "" : conceptId.slice(0, slash);
}

/** Normalize a POSIX-style path, collapsing "." and ".." segments. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Pop a real segment if we have one; otherwise the "../" escapes the
      // bundle root and we keep it so the caller can treat it as broken.
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

/**
 * Resolve a markdown link href, relative to the concept it was found in.
 *
 * - http(s):// and mailto: → external (opened in the system browser).
 * - bundle-absolute `/a/b.md` → resolved from the bundle root.
 * - relative `x.md` / `../d/x.md` → resolved from the linking concept's dir.
 * - trailing `#anchor` is stripped; a trailing `.md` is dropped to yield the id.
 *
 * Returns `kind: "concept"` with the resolved id; the caller verifies that id
 * exists in the bundle and renders unknown ids with broken styling. An href
 * that resolves to nothing usable (empty, or escaping the root) is "broken".
 */
export function resolveHref(href: string, fromConceptId: string): ResolvedHref {
  const raw = href.trim();
  if (!raw) return { kind: "broken", href };

  // External schemes and protocol-relative URLs open in the system browser.
  if (/^(https?:|mailto:|tel:)/i.test(raw) || raw.startsWith("//")) {
    return { kind: "external", url: raw };
  }

  // A pure in-page anchor has no concept target.
  if (raw.startsWith("#")) return { kind: "broken", href };

  // Strip any query/fragment; concept targets are file paths, not anchors.
  const authoredPath = raw.split("#")[0].split("?")[0];
  if (!authoredPath) return { kind: "broken", href };
  const path = percentDecodePath(authoredPath);

  if (/^(https?:|mailto:|tel:)/i.test(path) || path.startsWith("//")) {
    return { kind: "external", url: raw };
  }

  // Resolve against the bundle root (absolute) or the linking concept's dir.
  let combined: string;
  if (path.startsWith("/")) {
    combined = path.slice(1);
  } else {
    const dir = dirOf(fromConceptId);
    combined = dir ? `${dir}/${path}` : path;
  }

  const normalized = normalizePath(combined);
  // Escaped the bundle root, or normalized to nothing → unresolvable.
  if (!normalized || normalized.startsWith("..")) {
    return { kind: "broken", href };
  }

  // Drop the conventional .md extension to get the concept id.
  const id = normalized.endsWith(".md") ? normalized.slice(0, -3) : normalized;
  if (!id) return { kind: "broken", href };

  return { kind: "concept", id };
}

/**
 * Resolve a companion-asset href (an ODSF `*.example.html` or a `styles/*.css`
 * it links) to a normalized **bundle-relative path**, keeping the extension —
 * the form `read_asset` expects. Like {@link resolveHref} but for assets, not
 * concepts. Returns null for external/data hrefs or anything escaping the root.
 *
 * `fromId` is the path the href is relative to: a concept id for an `examples`
 * entry or a body link, or an asset's own bundle path when resolving the
 * stylesheets that asset links.
 */
export function resolveAssetHref(href: string, fromId: string): string | null {
  const raw = href.trim();
  if (!raw) return null;
  if (/^(https?:|mailto:|tel:|data:)/i.test(raw) || raw.startsWith("//")) return null;

  const authoredPath = raw.split("#")[0].split("?")[0];
  if (!authoredPath) return null;
  const path = percentDecodePath(authoredPath);

  let combined: string;
  if (path.startsWith("/")) {
    combined = path.slice(1);
  } else {
    const dir = dirOf(fromId);
    combined = dir ? `${dir}/${path}` : path;
  }

  const normalized = normalizePath(combined);
  if (!normalized || normalized.startsWith("..")) return null;
  return normalized;
}
