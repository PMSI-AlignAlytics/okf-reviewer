import { Dialog } from "@base-ui/react/dialog";
import { CheckCircle2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Bundle, Concept } from "@/shared/types.ts";
import { reviewConceptPreflight } from "@/shared/ipc.ts";
import { useApp } from "@/shared/store.tsx";
import type { ReviewPreflight } from "@/features/review/types.ts";
import { reviewProblem } from "@/features/review/types.ts";
import {
  conceptReviewState,
  reviewStateLabel,
} from "@/features/review/state.ts";
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
  const [notice, setNotice] = useState("");
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
    setNotice("");
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
      setNotice(result.message);
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
  const disabledReason = checking
    ? "Checking whether this concept can be reviewed."
    : (preflightError || error) && !confirmOpen && !setupOpen
      ? (preflightError || error)
      : unavailable
        ? preflight.message
        : undefined;

  return (
    <>
      <div className="review-action-wrap">
        <button
          ref={confirmRef}
          type="button"
          className="review-action"
          disabled={checking || unavailable || preflight === null}
          title={disabledReason}
          aria-describedby={disabledReason ? "review-action-reason" : undefined}
          onClick={openConfirmation}
        >
          <CheckCircle2 size={15} aria-hidden="true" />
          {checking ? "Checking review…" : (preflight?.actionLabel ?? "Review unavailable")}
        </button>
        {disabledReason ? (
          <span id="review-action-reason" className="review-action-reason" role="status">
            {disabledReason}
            {preflightError && (
              <button type="button" className="btn ghost" onClick={() => {
                setPreflightState({ key: "", result: null, error: "" });
                setPreflightAttempt((attempt) => attempt + 1);
              }}>Retry review check</button>
            )}
          </span>
        ) : null}
        {notice ? (
          <span className="review-action-notice" role="status">
            {notice}
          </span>
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
                  This changes one local OKF concept after you confirm.
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
