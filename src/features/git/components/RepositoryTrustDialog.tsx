import { Dialog } from "@base-ui/react/dialog";
import { GitBranch, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { useApp } from "@/shared/store.tsx";
import "@/shared/styles/baseui.css";
import "@/shared/styles/chrome.css";
import "./RepositoryTrustDialog.css";

export function RepositoryTrustDialog() {
  const { state, actions } = useApp();
  const status = state.bundleGitStatus;
  const repository = status.repositoryRoot;
  const [dismissedRepository, setDismissedRepository] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    repository: string;
    message: string;
  } | null>(null);

  const open = Boolean(
    state.bundle &&
      status.trustRequired &&
      repository &&
      repository !== dismissedRepository,
  );

  function dismiss() {
    if (repository) setDismissedRepository(repository);
    setError(null);
  }

  async function enable() {
    if (!repository) return;
    setBusy(true);
    setError(null);
    try {
      await actions.trustActiveRepository(repository);
      setDismissedRepository(null);
    } catch (cause) {
      setError({ repository, message: String(cause) });
    }
    setBusy(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) dismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-backdrop" />
        <Dialog.Popup className="ui-dialog repository-trust-dialog">
          <header className="repository-trust-dialog__header">
            <span className="repository-trust-dialog__icon" aria-hidden="true">
              <GitBranch size={20} />
            </span>
            <div>
              <Dialog.Title>Enable read-only Git inspection?</Dialog.Title>
              <Dialog.Description>
                This bundle is inside a repository that Git or the opened-folder scope
                does not trust automatically.
              </Dialog.Description>
            </div>
            <button
              type="button"
              className="btn ghost icon"
              aria-label="Close repository trust dialog"
              disabled={busy}
              onClick={dismiss}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          <div className="repository-trust-dialog__body">
            <p>
              Allow OKF Reviewer to inspect this exact repository for status markers and
              Git-backed quiz scopes:
            </p>
            <code className="repository-trust-dialog__path">{repository}</code>
            <p className="repository-trust-dialog__assurance">
              <ShieldCheck size={16} aria-hidden="true" />
              The permission is stored only by OKF Reviewer. Git configuration is not
              changed, and the app will not commit, stage, or modify repository files.
            </p>
            {error?.repository === repository ? (
              <p className="repository-trust-dialog__error" role="alert">
                {error.message}
              </p>
            ) : null}
          </div>
          <footer className="repository-trust-dialog__footer">
            <button type="button" className="btn" disabled={busy} onClick={dismiss}>
              Not now
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void enable()}
            >
              {busy ? "Enabling…" : "Enable read-only Git"}
            </button>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
