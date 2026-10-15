import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { readRemovedBundleDocument } from "@/shared/ipc.ts";
import "@/shared/styles/baseui.css";
import "@/shared/styles/chrome.css";
import "./ReviewAction.css";

/**
 * The last committed Markdown source of a removed document, read-only. A
 * removed document cannot be stamped, so the reviewer checks what it said and
 * what depended on it instead. Source, not rendered output, as in the
 * reader's change comparison.
 */
export function RemovedDocumentDialog({
  root,
  revision,
  path,
  onClose,
}: {
  root: string;
  revision: string;
  path: string | null;
  onClose: () => void;
}) {
  const key = path ? `${root}\0${revision}\0${path}` : "";
  const [loaded, setLoaded] = useState<{ key: string; text: string; error: string }>({
    key: "",
    text: "",
    error: "",
  });

  useEffect(() => {
    if (!path) return;
    let current = true;
    void readRemovedBundleDocument(root, revision, path).then(
      (text) => {
        if (current) setLoaded({ key, text, error: "" });
      },
      (cause: unknown) => {
        if (current) {
          setLoaded({
            key,
            text: "",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [key, path, revision, root]);

  const ready = loaded.key === key;
  return (
    <Dialog.Root open={path !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-backdrop" />
        <Dialog.Popup className="ui-dialog review-dialog removed-document-dialog">
          <header className="review-dialog__header">
            <div>
              <Dialog.Title>Removed: {path}</Dialog.Title>
              <Dialog.Description>
                Last version at {revision.slice(0, 8)}. A removed document cannot be
                stamped; check what depended on it.
              </Dialog.Description>
            </div>
            <button
              type="button"
              className="btn ghost icon"
              aria-label="Close removed document"
              onClick={onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          <div className="review-dialog__body">
            {!ready ? (
              <p className="review-dialog__note" role="status">Reading the last version…</p>
            ) : loaded.error ? (
              <p className="review-dialog__error" role="alert">{loaded.error}</p>
            ) : (
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard to scroll it (WCAG 2.1.1)
              <pre className="removed-document" tabIndex={0} aria-label={`Last version of ${path ?? ""}`}>
                <code>{loaded.text}</code>
              </pre>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
