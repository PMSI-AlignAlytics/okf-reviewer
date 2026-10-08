import { FolderOpen } from "lucide-react";
import { useApp } from "@/shared/store.tsx";
import { modKey } from "@/shared/platform/platform.ts";
import appIcon from "@/assets/icon.png";
import "@/shared/styles/chrome.css";
import "./EmptyState.css";

export function EmptyState() {
  const { state, actions } = useApp();

  if (state.loading) {
    return (
      <div className="empty" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <p className="empty-line">Scanning local folders…</p>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="empty" role="alert">
        <h2>Couldn’t open that folder</h2>
        <p className="empty-err">{state.error}</p>
        <button className="btn primary" onClick={() => void actions.openFolder()}>
          Try another folder
        </button>
      </div>
    );
  }

  if (state.folder && state.bundles.length === 0) {
    return (
      <div className="empty">
        <h2>No OKF bundles found</h2>
        <p className="empty-line">
          Choose a folder containing an OKF bundle with <code>index.md</code> and
          Markdown concepts whose frontmatter has a non-empty <code>type</code>.
        </p>
        <p className="empty-path muted">{state.folder}</p>
        <button className="btn primary" onClick={() => void actions.openFolder()}>
          Open another folder
        </button>
      </div>
    );
  }

  return (
    <div className="empty hero">
      <img className="hero-mark" src={appIcon} alt="" aria-hidden="true" />
      <h1 className="hero-title">OKF Reviewer</h1>
      <p className="hero-tagline">
        Browse local OKF v0.2 bundles and record explicit human review.
      </p>
      <nav className="hero-actions" aria-label="Get started">
        <button
          type="button"
          className="hero-action hero-action--primary"
          onClick={() => void actions.openFolder()}
        >
          <FolderOpen size={18} aria-hidden="true" />
          <span className="hero-action-text">
            <span className="hero-action-label">Open local folder…</span>
            <span className="hero-action-desc">
              Register and browse one or more OKF bundles already on disk
            </span>
          </span>
          <span className="hero-action-keys">
            <kbd className="kbd">{modKey}</kbd> <kbd className="kbd">O</kbd>
          </span>
        </button>
      </nav>
      <p className="hero-note">
        Opening is read-only. A concept changes only after you confirm a human review.
      </p>
    </div>
  );
}
