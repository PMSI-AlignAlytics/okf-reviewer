import { Dialog } from "@base-ui/react/dialog";
import { CheckCircle2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Bundle, BundleGitStatus, Concept } from "@/shared/types.ts";
import { reviewConceptPreflight } from "@/shared/ipc.ts";
import { useApp } from "@/shared/store.tsx";
import type { ReviewPreflight } from "@/features/review/types.ts";
import { reviewProblem } from "@/features/review/types.ts";
import {
  conceptReviewState,
  reviewStateLabel,
} from "@/features/review/state.ts";
import {
  comparisonLabel,
  conceptChange,
  featureReviewBatch,
  nextOutstanding,
  shortRevision,
} from "@/features/review/batch.ts";
import "@/shared/styles/baseui.css";
import "@/shared/styles/chrome.css";
import "./ReviewAction.css";

function preflightKey(bundle: Bundle, concept: Concept, reviewerId: string): string {
  return [
    bundle.root,
    concept.id,
    concept.status,
    concept.statusExplicit ? "explicit" : "implicit",
    concept.generated?.at ?? concept.timestamp ?? "unknown-generation-time",
    JSON.stringify(concept.verified),
    reviewerId,
  ].join("\0");
}

/** What changed in this concept since the comparison base, in one phrase. */
function changeDescription(conceptId: string, status: BundleGitStatus): string | null {
  const change = conceptChange(conceptId, status);
  if (!change) return null;
  const since = `since ${shortRevision(status.baseRevision)} (${comparisonLabel(status)})`;
  switch (change.kind) {
    case "unchanged":
      return `No changes ${since}`;
    case "metadata":
      return `Wording unchanged ${since}; only metadata changed`;
    case "wording":
      return change.passages > 0
        ? `${change.passages} changed passage${change.passages === 1 ? "" : "s"} ${since}`
        : `Wording changed ${since}`;
  }
}

export function ReviewStateBadge({ concept }: { concept: Concept }) {
  const state = conceptReviewState(concept);
  return (
    <span className="review-state-badge" data-review-state={state}>
      Review: {reviewStateLabel(state)}
    </span>
  );
}

export function ReviewAction({
  bundle,
  concept,
}: {
  bundle: Bundle;
  concept: Concept;
}) {
  const { state, actions } = useApp();
  const currentPreflightKey = preflightKey(
    bundle,
    concept,
    state.settings.reviewerId,
  );
  const [preflightState, setPreflightState] = useState<{
    key: string;
    result: ReviewPreflight | null;
    error: string;
  }>({ key: "", result: null, error: "" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Keyed by concept: the reader keeps this action mounted across navigation.
  const [notice, setNotice] = useState<{ conceptId: string; message: string } | null>(null);
  const [preflightAttempt, setPreflightAttempt] = useState(0);
  const [reviewerId, setReviewerId] = useState(state.settings.reviewerId);
  const [reviewerName, setReviewerName] = useState(state.settings.reviewerName);
  const [reviewerEmail, setReviewerEmail] = useState(state.settings.reviewerEmail);
  const setupIdRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let current = true;
    void reviewConceptPreflight({
      bundleRoot: bundle.root,
      conceptId: concept.id,
      reviewerId: state.settings.reviewerId || null,
    })
      .then((result) => {
        if (current) setPreflightState({ key: currentPreflightKey, result, error: "" });
      })
      .catch((cause: unknown) => {
        if (current) {
          setPreflightState({
            key: currentPreflightKey,
            result: null,
            error: reviewProblem(cause).message,
          });
        }
      });
    return () => {
      current = false;
    };
  }, [bundle.root, concept.id, currentPreflightKey, state.settings.reviewerId, preflightAttempt]);

  const checking = preflightState.key !== currentPreflightKey;
  const preflight = checking ? null : preflightState.result;
  const preflightError = checking ? "" : preflightState.error;

  function openConfirmation() {
    setError("");
    setNotice(null);
    if (!state.settings.reviewerId.trim()) {
      setReviewerId("");
      setReviewerName(state.settings.reviewerName);
      setReviewerEmail(state.settings.reviewerEmail);
      setSetupOpen(true);
      return;
    }
    setConfirmOpen(true);
  }

  async function saveReviewer() {
    const id = reviewerId.trim().replace(/^human:/, "");
    setBusy(true);
    setError("");
    try {
      const next = await reviewConceptPreflight({
        bundleRoot: bundle.root,
        conceptId: concept.id,
        reviewerId: id,
      });
      if (!next.available) {
        setError(next.message);
        setBusy(false);
        return;
      }
      actions.updateSettings({
        reviewerId: id,
        reviewerName: reviewerName.trim(),
        reviewerEmail: reviewerEmail.trim(),
      });
      setPreflightState({
        key: preflightKey(bundle, concept, id),
        result: next,
        error: "",
      });
      setSetupOpen(false);
      setConfirmOpen(true);
      setBusy(false);
    } catch (cause) {
      setError(reviewProblem(cause).message);
      setBusy(false);
    }
  }

  async function confirmReview() {
    if (!preflight || !state.settings.reviewerId) return;
    setBusy(true);
    setError("");
    try {
      const result = await actions.reviewConcept({
        bundleRoot: bundle.root,
        conceptId: concept.id,
        reviewerId: state.settings.reviewerId,
        expectedFingerprint: preflight.fingerprint,
        reviewedAt: preflight.reviewedAt,
      });
      setNotice({ conceptId: concept.id, message: result.message });
      setConfirmOpen(false);
      setBusy(false);
    } catch (cause) {
      const problem = reviewProblem(cause);
      setError(problem.message);
      if (problem.code === "conflict") {
        await actions.reloadActiveBundle().catch(() => null);
      }
      setBusy(false);
    }
  }

  const unavailable = preflight !== null && !preflight.available;
  // The reviewer's own stamp already covers this exact wording: acknowledge
  // the finished work rather than presenting it as a blocker.
  const acknowledged = unavailable && preflight.reasonCode === "already-reviewed";
  const disabledReason = checking
    ? "Checking whether this concept can be reviewed."
    : (preflightError || error) && !confirmOpen && !setupOpen
      ? (preflightError || error)
      : unavailable
        ? preflight.message
        : undefined;
  const recorded = notice?.conceptId === concept.id ? notice : null;
  // A just-recorded review's notice supersedes the acknowledgement it causes.
  const showReason = Boolean(disabledReason) && !(acknowledged && recorded);
  const batch = featureReviewBatch(bundle, state.bundleGitStatus);
  const inBatch = batch.items.some((item) => item.concept.id === concept.id);
  const remaining = batch.outstanding.filter((item) => item.concept.id !== concept.id).length;
  const next = recorded ? nextOutstanding(batch, concept.id, [concept.id]) : null;
  const change = changeDescription(concept.id, state.bundleGitStatus);
  const contentHash = preflight?.contentSha256 ?? concept.contentSha256 ?? null;

  return (
    <>
      <div className="review-action-wrap">
        <button
          ref={confirmRef}
          type="button"
          className="review-action"
          data-acknowledged={acknowledged || undefined}
          disabled={checking || unavailable || preflight === null}
          title={disabledReason}
          aria-describedby={showReason ? "review-action-reason" : undefined}
          onClick={openConfirmation}
        >
          <CheckCircle2 size={15} aria-hidden="true" />
          {checking
            ? "Checking review…"
            : acknowledged
              ? "Reviewed by you"
              : (preflight?.actionLabel ?? "Review unavailable")}
        </button>
        {showReason ? (
          <span
            id="review-action-reason"
            className={`review-action-reason${acknowledged ? " is-acknowledged" : ""}`}
            role="status"
          >
            {disabledReason}
            {preflightError && (
              <button type="button" className="btn ghost" onClick={() => {
                setPreflightState({ key: "", result: null, error: "" });
                setPreflightAttempt((attempt) => attempt + 1);
              }}>Retry review check</button>
            )}
          </span>
        ) : null}
        {recorded ? (
          <span className="review-action-notice" role="status">
            {recorded.message}
            {inBatch
              ? remaining > 0
                ? ` ${remaining} of ${batch.items.length} changed document${batch.items.length === 1 ? "" : "s"} still need${remaining === 1 ? "s" : ""} review.`
                : " Every changed document in this feature review now has a current review."
              : ""}
          </span>
        ) : null}
        {next ? (
          <button
            type="button"
            className="btn ghost review-action-next"
            title={`${next.title} — ${next.id}.md`}
            onClick={() => actions.selectConcept(next.id)}
          >
            Next: <span>{next.title}</span>
          </button>
        ) : null}
      </div>

      <Dialog.Root open={setupOpen} onOpenChange={setSetupOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="ui-backdrop" />
          <Dialog.Popup
            className="ui-dialog review-dialog"
            initialFocus={setupIdRef}
            finalFocus={confirmRef}
          >
            <header className="review-dialog__header">
              <div>
                <Dialog.Title>Set reviewer identity</Dialog.Title>
                <Dialog.Description>
                  A reviewer ID is required. The concept records it as a{" "}
                  <code>human:</code> actor; name and email stay in local app settings.
                </Dialog.Description>
              </div>
              <button
                type="button"
                className="btn ghost icon"
                aria-label="Close reviewer setup"
                onClick={() => setSetupOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <form
              className="review-dialog__form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveReviewer();
              }}
            >
              <label htmlFor="reviewer-id">Reviewer ID</label>
              <div className="reviewer-id-input">
                <span aria-hidden="true">human:</span>
                <input
                  ref={setupIdRef}
                  id="reviewer-id"
                  required
                  maxLength={128}
                  pattern="[A-Za-z0-9._@-]+"
                  value={reviewerId.replace(/^human:/, "")}
                  onChange={(event) => setReviewerId(event.target.value)}
                  autoComplete="username"
                />
              </div>
              <label htmlFor="reviewer-name">Name (optional)</label>
              <input
                id="reviewer-name"
                value={reviewerName}
                onChange={(event) => setReviewerName(event.target.value)}
                autoComplete="name"
              />
              <label htmlFor="reviewer-email">Email (optional)</label>
              <input
                id="reviewer-email"
                type="email"
                value={reviewerEmail}
                onChange={(event) => setReviewerEmail(event.target.value)}
                autoComplete="email"
              />
              {error ? <p className="review-dialog__error" role="alert">{error}</p> : null}
              <footer className="review-dialog__footer">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => setSetupOpen(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn primary" disabled={busy}>
                  {busy ? "Checking…" : "Continue"}
                </button>
              </footer>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) setError("");
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="ui-backdrop" />
          <Dialog.Popup
            className="ui-dialog review-dialog"
            finalFocus={confirmRef}
          >
            <header className="review-dialog__header">
              <div>
                <Dialog.Title>Confirm human review</Dialog.Title>
                <Dialog.Description>
                  You approve the wording of this document&apos;s body, not its code,
                  metadata, implementation, or deployment. Confirming changes one local
                  OKF concept.
                </Dialog.Description>
              </div>
              <button
                type="button"
                className="btn ghost icon"
                aria-label="Close review confirmation"
                onClick={() => setConfirmOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            {preflight ? (
              <div className="review-dialog__body">
                <dl className="review-confirmation">
                  <div>
                    <dt>Concept</dt>
                    <dd>{concept.title}</dd>
                  </div>
                  <div>
                    <dt>File</dt>
                    <dd><code>{preflight.relativePath}</code></dd>
                  </div>
                  <div>
                    <dt>Approves</dt>
                    <dd>
                      Body wording{" "}
                      {contentHash ? (
                        <code title={contentHash}>sha256 {contentHash.slice(0, 12)}…</code>
                      ) : null}
                    </dd>
                  </div>
                  {change ? (
                    <div>
                      <dt>Changes</dt>
                      <dd>{change}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Lifecycle</dt>
                    <dd>
                      {preflight.currentStatus}
                      {preflight.statusExplicit === false ? " (implicit)" : ""} → stable
                    </dd>
                  </div>
                  <div>
                    <dt>Review</dt>
                    <dd>{preflight.actionLabel}</dd>
                  </div>
                  <div>
                    <dt>Reviewer</dt>
                    <dd>
                      {state.settings.reviewerName || "Unnamed reviewer"}{" "}
                      <code>human:{state.settings.reviewerId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Timestamp</dt>
                    <dd><time dateTime={preflight.reviewedAt}>{preflight.reviewedAt}</time></dd>
                  </div>
                </dl>
                <p className="review-dialog__note">{preflight.message}</p>
                {error ? <p className="review-dialog__error" role="alert">{error}</p> : null}
              </div>
            ) : null}
            <footer className="review-dialog__footer">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || !preflight}
                onClick={() => void confirmReview()}
              >
                {busy ? "Saving review…" : "Confirm review"}
              </button>
            </footer>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
