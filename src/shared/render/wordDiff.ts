// Word-level comparison of a Git hunk's previous and current Markdown source,
// for the reader's change preview and in-place comparison.
//
// Git reports whole changed lines, and a Markdown paragraph is usually a single
// line, so a one-word edit arrives as two near-identical paragraphs. Diffing the
// words inside the hunk shows the edit itself.
//
// A token is a word with the whitespace after it, and tokens compare by the word
// alone: re-wrapping a hard-wrapped paragraph moves line breaks without marking
// every line-end word as changed. Unchanged text is reported with the current
// whitespace.

export interface DiffPart {
  kind: "same" | "removed" | "added";
  text: string;
}

/** A condensed part: a diff part, or unchanged text left out of a preview. */
export type PreviewPart = DiffPart | { kind: "elided" };

const TOKEN = /\s+|\S+\s*/g;

// Cells in the longest-common-subsequence table for the part of the hunk that
// differs after trimming the shared prefix and suffix. Past this the middle is
// reported as one replacement: a rewrite that large reads better as old text
// then new text than as interleaved fragments, and the table stays small.
const MAX_CELLS = 1_000_000;

const tokenize = (text: string): string[] => text.match(TOKEN) ?? [];
const keyOf = (token: string): string => token.trim() || " ";

function push(parts: DiffPart[], kind: DiffPart["kind"], text: string): void {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

/** Removed-then-added operations for the differing middle of a hunk. */
function middleParts(before: string[], after: string[]): DiffPart[] {
  const parts: DiffPart[] = [];
  const n = before.length;
  const m = after.length;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    push(parts, "removed", before.join(""));
    push(parts, "added", after.join(""));
    return parts;
  }
  const a = before.map(keyOf);
  const b = after.map(keyOf);
  // lcs[i * (m + 1) + j] is the common-subsequence length of a[i..] and b[j..].
  // The product bound keeps min(n, m) at or below 1000, inside Uint16 range.
  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  // Walk the table, gathering each run of edits so removed text is reported
  // before added text rather than word by word in alternation.
  let removed = "";
  let added = "";
  const flush = () => {
    push(parts, "removed", removed);
    push(parts, "added", added);
    removed = "";
    added = "";
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      push(parts, "same", after[j]);
      i++;
      j++;
    } else if (j >= m || (i < n && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      removed += before[i++];
    } else {
      added += after[j++];
    }
  }
  flush();
  return parts;
}

/** The word-level difference from `before` to `after`. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && keyOf(a[start]) === keyOf(b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && keyOf(a[endA - 1]) === keyOf(b[endB - 1])) {
    endA--;
    endB--;
  }
  const parts: DiffPart[] = [];
  push(parts, "same", b.slice(0, start).join(""));
  for (const part of middleParts(a.slice(start, endA), b.slice(start, endB))) {
    push(parts, part.kind, part.text);
  }
  push(parts, "same", b.slice(endB).join(""));
  return parts;
}

/** True when the parts record any word change, not only whitespace. */
export function hasWordChanges(parts: readonly DiffPart[]): boolean {
  return parts.some((part) => part.kind !== "same");
}

/**
 * Keep each change with up to `context` unchanged words on either side and
 * replace the rest of the unchanged text with an elision, for a preview that
 * shows the edit without the paragraph around it.
 */
export function condenseDiff(parts: readonly DiffPart[], context = 8): PreviewPart[] {
  const out: PreviewPart[] = [];
  parts.forEach((part, index) => {
    if (part.kind !== "same") {
      out.push(part);
      return;
    }
    const words = part.text.match(/\s*\S+\s*/g) ?? [];
    const leading = index === 0;
    const trailing = index === parts.length - 1;
    if (leading && trailing) {
      out.push(part);
    } else if (leading) {
      if (words.length > context) out.push({ kind: "elided" });
      out.push({ kind: "same", text: words.slice(-context).join("") || part.text });
    } else if (trailing) {
      out.push({ kind: "same", text: words.slice(0, context).join("") || part.text });
      if (words.length > context) out.push({ kind: "elided" });
    } else if (words.length > context * 2) {
      out.push({ kind: "same", text: words.slice(0, context).join("") });
      out.push({ kind: "elided" });
      out.push({ kind: "same", text: words.slice(-context).join("") });
    } else {
      out.push(part);
    }
  });
  return out;
}
