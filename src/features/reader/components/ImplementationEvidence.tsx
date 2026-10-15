// The optional `implementation` frontmatter pointer: the last recorded check
// of this concept's obligations against a code state, kept in a delivery
// record. Shown read-only. It says whether that check covered the wording on
// screen; it never records or implies implementation acceptance.

import { AlertTriangle, CheckCircle2, CircleHelp } from "lucide-react";
import { useState, type MouseEvent } from "react";
import type { Bundle, Concept } from "@/shared/types.ts";
import { conceptById } from "@/shared/selectors.ts";
import { resolveHref } from "@/shared/render/markdown.ts";
import "./ImplementationEvidence.css";

export interface ImplementationRecord {
  specSha256: string | null;
  checkedAt: string | null;
  by: string | null;
  code: { kind: "commit" | "snapshot"; id: string } | null;
  evidence: string | null;
  /** Fields that do not match the delivery evidence conventions. */
  problems: string[];
}

const SHA256 = /^[0-9a-f]{64}$/iu;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read the pointer without repairing it; null when the key is not a mapping. */
export function parseImplementation(value: unknown): ImplementationRecord | null {
  if (!isRecord(value)) return null;
  const problems: string[] = [];
  const specSha256 = text(value.spec_sha256);
  if (!specSha256 || !SHA256.test(specSha256)) {
    problems.push("spec_sha256 should be a 64-character hexadecimal body hash.");
  }
  const checkedAt = text(value.checked_at);
  if (!checkedAt) problems.push("checked_at is missing.");
  const by = text(value.by);
  if (!by) problems.push("by is missing.");
  let code: ImplementationRecord["code"] = null;
  if (isRecord(value.code)) {
    const commit = text(value.code.commit);
    const snapshot = text(value.code.snapshot_sha256);
    if (commit && !snapshot && COMMIT.test(commit)) code = { kind: "commit", id: commit };
    else if (snapshot && !commit && SHA256.test(snapshot)) code = { kind: "snapshot", id: snapshot };
  }
  if (!code) {
    problems.push("code should name exactly one full commit or snapshot_sha256.");
  }
  const evidence = text(value.evidence);
  if (!evidence) problems.push("evidence is missing.");
  return {
    specSha256: specSha256 && SHA256.test(specSha256) ? specSha256.toLowerCase() : null,
    checkedAt,
    by,
    code,
    evidence,
    problems,
  };
}

export function ImplementationEvidence({
  bundle,
  concept,
  record,
  onOpenConcept,
  onOpenExternal,
  onOpenEvidence,
}: {
  bundle: Bundle | null;
  concept: Concept;
  record: ImplementationRecord;
  onOpenConcept: (id: string, event: MouseEvent<HTMLElement>) => void;
  onOpenExternal: (url: string) => void;
  /** Open a local delivery record outside the bundle, rechecked natively. */
  onOpenEvidence: (href: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ href: string; message: string } | null>(null);
  const current = concept.contentSha256?.toLowerCase() ?? null;
  const state = !record.specSha256 || !current
    ? "unknown"
    : record.specSha256 === current
      ? "current"
      : "earlier";
  const target = record.evidence && !/^https:\/\//iu.test(record.evidence) && bundle
    ? resolveHref(record.evidence, concept.id)
    : null;
  const evidenceConcept = target?.kind === "concept" && bundle
    ? conceptById(bundle, target.id)
    : null;
  // The native classification of a local record, when it still matches.
  const local = bundle?.evidenceLinks?.[concept.id];
  const localState = local?.href === record.evidence ? local.state : null;

  async function copyPath(path: string) {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) return;
    try {
      await clipboard.writeText(path);
      setCopied(path);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="impl-evidence">
      <p className="impl-evidence__status" data-state={state}>
        {state === "current" ? (
          <CheckCircle2 size={14} aria-hidden="true" />
        ) : state === "earlier" ? (
          <AlertTriangle size={14} aria-hidden="true" />
        ) : (
          <CircleHelp size={14} aria-hidden="true" />
        )}
        {state === "current"
          ? "Checked against this wording."
          : state === "earlier"
            ? "Checked against an earlier wording. The body changed after this check."
            : "The checked wording is unknown."}
      </p>
      <dl className="reader-meta">
        <div className="meta-row">
          <dt>Checked</dt>
          <dd>
            {record.checkedAt ?? "Unknown time"}
            {record.by ? ` by ${record.by}` : ""}
          </dd>
        </div>
        <div className="meta-row">
          <dt>Code</dt>
          <dd>
            {record.code ? (
              <code title={record.code.id}>
                {record.code.kind === "commit" ? "commit" : "snapshot"} {record.code.id.slice(0, 12)}
              </code>
            ) : (
              "Not identified"
            )}
          </dd>
        </div>
        <div className="meta-row">
          <dt>Evidence</dt>
          <dd>
            {!record.evidence ? (
              "Not linked"
            ) : /^https:\/\//iu.test(record.evidence) ? (
              <button
                type="button"
                className="link-btn"
                onClick={() => { if (record.evidence) onOpenExternal(record.evidence); }}
              >
                {record.evidence}
              </button>
            ) : evidenceConcept ? (
              <button
                type="button"
                className="link-btn"
                onClick={(event) => onOpenConcept(evidenceConcept.id, event)}
              >
                {evidenceConcept.title}
              </button>
            ) : localState === "available" ? (
              <span className="impl-evidence__path">
                <button
                  type="button"
                  className="link-btn"
                  title="Open the delivery record in your default app"
                  onClick={() => {
                    const href = record.evidence;
                    if (!href) return;
                    setOpenError(null);
                    void onOpenEvidence(href).catch((error: unknown) => {
                      setOpenError({ href, message: String(error) });
                    });
                  }}
                >
                  {record.evidence}
                </button>
                <span>Delivery record outside the bundle.</span>
                {openError?.href === record.evidence ? (
                  <span className="impl-evidence__error" role="alert">{openError.message}</span>
                ) : null}
              </span>
            ) : (
              <span className="impl-evidence__path">
                <code>{record.evidence}</code>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => { if (record.evidence) void copyPath(record.evidence); }}
                >
                  Copy path
                </button>
                <span role="status">
                  {copied === record.evidence
                    ? "Path copied."
                    : localState === "outside-scope"
                      ? "Outside the opened folder. Open the containing folder to read it."
                      : localState === "missing"
                        ? "Record not found."
                        : "Outside this bundle."}
                </span>
              </span>
            )}
          </dd>
        </div>
      </dl>
      {record.problems.length > 0 ? (
        <ul className="impl-evidence__problems" aria-label="Implementation record problems">
          {record.problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      ) : null}
      <p className="impl-evidence__note">
        A recorded check, not implementation acceptance. Acceptance belongs in the
        delivery record or pull request.
      </p>
    </div>
  );
}
