// Pure derivations over the parsed data model. With the React Compiler enabled,
// components call these in render and the results are auto-memoized.

import type {
  Bundle,
  Concept,
  ConceptStatus,
  IndexNode,
} from "@/shared/types.ts";
import { parseQuery, matchesCompiled, type CompiledQuery } from "@/shared/query.ts";
import {
  conceptReviewState,
  type ConceptReviewState,
} from "@/features/review/state.ts";

// ---- Folder homes -------------------------------------------------------
// A directory's index.md is never a concept (OKF reserves it), so it has no
// place in `concepts`. We still let the reader open it as a
// "folder home" using a synthetic selection id that mirrors the anchor scheme
// the core uses: "index" for the bundle root, "<dir>/index" for a subdirectory.
// No real concept id can collide (index.md files are excluded at parse time).

/** The folder-home selection id for a directory ("" = bundle root). */
export function indexIdForDir(dir: string): string {
  return dir ? `${dir}/index` : "index";
}

/** If `id` is a folder-home id, the directory it lands on ("" = root); else null. */
export function dirForIndexId(id: string | null): string | null {
  if (!id) return null;
  if (id === "index") return "";
  return id.endsWith("/index") ? id.slice(0, -"/index".length) : null;
}

/** The IndexNode a folder-home id resolves to, or null when it is not one. */
export function indexNodeForId(bundle: Bundle | null, id: string | null): IndexNode | null {
  const dir = dirForIndexId(id);
  if (dir === null || !bundle) return null;
  // The root node's dir may be "" or "." depending on how it was produced.
  if (dir === "") return bundle.indexes.find((n) => n.dir === "" || n.dir === ".") ?? null;
  return bundle.indexes.find((n) => n.dir === dir) ?? null;
}

/** Distinct concept types present in a bundle, sorted. */
export function distinctTypes(bundle: Bundle | null): string[] {
  if (!bundle) return [];
  return [...new Set(bundle.concepts.map((c) => c.type).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Synthesize a tag → concept-ids index by scanning frontmatter. */
export function buildTagIndex(concepts: Concept[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const c of concepts) {
    for (const tag of c.tags) {
      const list = index.get(tag) ?? [];
      list.push(c.id);
      index.set(tag, list);
    }
  }
  return index;
}

export interface Filter {
  query: string;
  hiddenTypes: string[];
  activeTag: string | null;
  activeStatuses?: ConceptStatus[];
  activeReviewStates?: ConceptReviewState[];
}

// One-entry compile cache: a query string is parsed once, then tested against
// every concept in the render. The same string flows to all consumers in a
// frame, so a single slot hits ~100%.
let queryCache: { q: string; compiled: CompiledQuery } | null = null;
function compile(q: string): CompiledQuery {
  if (queryCache?.q !== q) queryCache = { q, compiled: parseQuery(q) };
  return queryCache.compiled;
}

/**
 * Does a concept match the query? The query is the [faceted grammar](./query.ts)
 * — `type:`, `tag:`, `degree>N`, `is:orphan`, `has:broken`, and full-text —
 * falling back to plain substring for bare words.
 */
export function matchesQuery(c: Concept, q: string): boolean {
  if (!q) return true;
  return matchesCompiled(c, compile(q));
}

/** Is a concept visible under the current type filter and tag selection? */
export function isVisible(c: Concept, f: Filter): boolean {
  if (f.hiddenTypes.includes(c.type)) return false;
  if (f.activeTag && !c.tags.includes(f.activeTag)) return false;
  if (f.activeStatuses?.length && !f.activeStatuses.includes(c.status)) return false;
  if (f.activeReviewStates?.length) {
    const reviewState = conceptReviewState(c);
    if (!f.activeReviewStates.includes(reviewState)) return false;
  }
  return true;
}

/** Concept ids that pass both the filter and the text query. */
export function filteredConceptIds(bundle: Bundle | null, f: Filter): Set<string> {
  const ids = new Set<string>();
  if (!bundle) return ids;
  for (const c of bundle.concepts) {
    if (isVisible(c, f) && matchesQuery(c, f.query)) ids.add(c.id);
  }
  return ids;
}

/** Look up a concept by id. */
export function conceptById(bundle: Bundle | null, id: string | null): Concept | null {
  if (!bundle || !id) return null;
  return bundle.concepts.find((c) => c.id === id) ?? null;
}

/** Derive a display title for a concept id (its title, else the id). */
export function titleOf(bundle: Bundle | null, id: string): string {
  return conceptById(bundle, id)?.title ?? id;
}
