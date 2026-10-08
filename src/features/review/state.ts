import type { Concept } from "@/shared/types.ts";
import { authoredAt, isHuman } from "@/features/bundle/trust.ts";

export type ConceptReviewState =
  | "unverified"
  | "machine-confirmed"
  | "review-required"
  | "human-reviewed";

interface Instant {
  epochSecond: number;
  fraction: string;
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Parse the bounded RFC 3339 spelling used by OKF without losing sub-ms precision. */
function instant(value: string | null): Instant | null {
  if (value === null) return null;
  const match = INSTANT.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) return null;

  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  const signedOffset = match[9] === "-" ? -1 : 1;
  const offsetSeconds = signedOffset * (offsetHour * 60 + offsetMinute) * 60;
  return {
    epochSecond: utc.getTime() / 1000 - offsetSeconds,
    fraction: match[7] || "",
  };
}

function compareInstant(left: Instant, right: Instant): number {
  if (left.epochSecond !== right.epochSecond) {
    return left.epochSecond < right.epochSecond ? -1 : 1;
  }
  const width = Math.max(left.fraction.length, right.fraction.length);
  const leftFraction = left.fraction.padEnd(width, "0");
  const rightFraction = right.fraction.padEnd(width, "0");
  return leftFraction === rightFraction ? 0 : leftFraction < rightFraction ? -1 : 1;
}

export function conceptReviewState(concept: Concept): ConceptReviewState {
  const humanEvents = concept.verified.filter(isHuman);
  if (humanEvents.length === 0) {
    return concept.verified.length > 0 ? "machine-confirmed" : "unverified";
  }

  // A review that recorded a content hash covers exactly that body, whatever
  // generated.at says.
  const current = concept.contentSha256;
  if (current && humanEvents.some((entry) => entry.contentSha256 === current)) {
    return "human-reviewed";
  }

  const dated = humanEvents
    .map((entry) => ({ entry, at: instant(entry.at) }))
    .filter((value): value is { entry: typeof value.entry; at: Instant } => value.at !== null);
  if (dated.length === 0) return "review-required";
  const latest = dated.reduce((newest, candidate) =>
    compareInstant(candidate.at, newest.at) > 0 ? candidate : newest
  );
  // The latest review approved a different body: the content changed since.
  if (latest.entry.contentSha256) return "review-required";

  // Older reviews without a hash fall back to comparing timestamps.
  const authored = instant(authoredAt(concept));
  if (authored === null) return "review-required";
  return compareInstant(authored, latest.at) > 0
    ? "review-required"
    : "human-reviewed";
}

/**
 * Whether the focused review operation can add the human sign-off this concept
 * is missing. Lifecycle and review remain separate: drafts can already be
 * human-reviewed, while stable concepts can still need review. Deprecated
 * concepts are excluded because the MVP deliberately makes them historical
 * and non-reviewable.
 */
export function requiresHumanReview(concept: Concept): boolean {
  return concept.status !== "deprecated" && conceptReviewState(concept) !== "human-reviewed";
}

/** Pending-review concepts under each directory, credited to every ancestor. */
export function humanReviewCountsByDirectory(
  concepts: readonly Concept[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const concept of concepts) {
    if (!requiresHumanReview(concept)) continue;
    let slash = concept.id.lastIndexOf("/");
    while (slash > 0) {
      const dir = concept.id.slice(0, slash);
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
      slash = dir.lastIndexOf("/");
    }
  }
  return counts;
}

export function reviewStateLabel(state: ConceptReviewState): string {
  switch (state) {
    case "human-reviewed":
      return "Human reviewed";
    case "review-required":
      return "Needs review";
    case "machine-confirmed":
      return "Machine confirmed";
    default:
      return "Unreviewed";
  }
}
