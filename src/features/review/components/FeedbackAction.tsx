import { Dialog } from "@base-ui/react/dialog";
import { MessageSquareText, X } from "lucide-react";
import { useRef, useState } from "react";
import type { Concept } from "@/shared/types.ts";
import { useApp } from "@/shared/store.tsx";
import { feedbackMarkdown } from "@/features/review/batch.ts";
import "@/shared/styles/baseui.css";
import "@/shared/styles/chrome.css";
import "./ReviewAction.css";

/** Text selected inside the rendered concept body, if any. */
function selectedPassage(): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return "";
  const node = selection.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest(".body.markdown") ? selection.toString().trim() : "";
}

/**
 * The counterpart to the review action: when the wording is not ready to
 * approve, saying so should be as easy as approving. Feedback is copied for
 * the concept's author — usually an agent session — and never written to the
 * bundle, so it adds no workflow state.
 */
export function FeedbackAction({ concept }: { concept: Concept }) {
  const { state } = useApp();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ conceptId: "", passage: "", note: "" });
  const [error, setError] = useState("");
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  // Read on pointer down, before activating the button can disturb the selection.
  const pendingSelection = useRef("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  function begin() {
    const selection = pendingSelection.current || selectedPassage();
    pendingSelection.current = "";
    setDraft((current) =>
      current.conceptId === concept.id
        ? { ...current, passage: selection || current.passage }
        : { conceptId: concept.id, passage: selection, note: "" }
    );
    setError("");
    setCopiedFor(null);
    setOpen(true);
  }

  async function copy() {
    if (!draft.note.trim()) {
      setError("Describe what should change before copying.");
      noteRef.current?.focus();
      return;
    }
    const unavailable = "The clipboard is unavailable, so the feedback was not copied.";
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      setError(unavailable);
      return;
    }
    try {
      await clipboard.writeText(feedbackMarkdown({
        concept,
        status: state.bundleGitStatus,
        passage: draft.passage,
        note: draft.note,
        reviewerId: state.settings.reviewerId,
      }));
      setDraft({ conceptId: concept.id, passage: "", note: "" });
      setCopiedFor(concept.id);
      setOpen(false);
    } catch {
      setError(unavailable);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="feedback-action"
        title="Write feedback for this concept's author and copy it. The document is not changed."
        onPointerDown={() => {
          pendingSelection.current = selectedPassage();
        }}
        onClick={begin}
      >
        <MessageSquareText size={15} aria-hidden="true" />
        Give feedback
      </button>
      {copiedFor === concept.id ? (
        <span className="review-action-notice" role="status">
          Feedback copied. The document is unchanged.
        </span>
      ) : null}

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="ui-backdrop" />
          <Dialog.Popup
            className="ui-dialog review-dialog"
            initialFocus={noteRef}
            finalFocus={triggerRef}
          >
            <header className="review-dialog__header">
              <div>
                <Dialog.Title>Give feedback</Dialog.Title>
                <Dialog.Description>
                  Not ready to approve? Say what should change, then paste the copied
                  text into the session that wrote this concept. Nothing in the
                  document changes.
                </Dialog.Description>
              </div>
              <button
                type="button"
                className="btn ghost icon"
                aria-label="Close feedback"
                onClick={() => setOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <form
              className="review-dialog__form"
              onSubmit={(event) => {
                event.preventDefault();
                void copy();
              }}
            >
              <label htmlFor="feedback-passage">Passage (optional)</label>
              <textarea
                id="feedback-passage"
                rows={3}
                value={draft.passage}
                onChange={(event) => setDraft({ ...draft, passage: event.target.value })}
              />
              <label htmlFor="feedback-note">What should change</label>
              <textarea
                ref={noteRef}
                id="feedback-note"
                rows={5}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "feedback-error" : undefined}
                value={draft.note}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              />
              {error ? (
                <p id="feedback-error" className="review-dialog__error" role="alert">{error}</p>
              ) : null}
              <footer className="review-dialog__footer">
                <button type="button" className="btn" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn primary">
                  Copy feedback
                </button>
              </footer>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
