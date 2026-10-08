import { useEffect, useSyncExternalStore } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Download, X } from "lucide-react";
import { version } from "../../../package.json";
import { useApp } from "@/shared/store.tsx";
import { isTauri } from "@/shared/ipc.ts";
import { SettingRow, SettingsGroup } from "@/features/shell/components/SettingsWorkspace.tsx";
import { appUpdates, updateBusy } from "./controller.ts";
import type { UpdateController, UpdateState } from "./controller.ts";
import "@/shared/styles/baseui.css";
import "./AppUpdates.css";

function useUpdateState(controller: UpdateController) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot);
}

function downloadPercent(state: UpdateState): number | undefined {
  const { downloaded, total } = state.progress;
  return total && total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : undefined;
}

function UpdateButton({ controller, state }: { controller: UpdateController; state: UpdateState }) {
  const { state: appState, actions } = useApp();
  const blocked = Boolean(appState.quizGeneration);
  return (
    <>
      <button type="button" className="btn primary"
        disabled={blocked || updateBusy(state.status) || state.status === "checking"}
        onClick={() => void controller.install(() => actions.flushSettings())}>
        <Download size={14} aria-hidden="true" />
        {state.status === "error" ? "Retry update" : "Update and restart"}
      </button>
      {blocked && <p className="app-update-help">Finish or cancel quiz generation before updating.</p>}
    </>
  );
}

export function AppUpdatesSettings({ controller = appUpdates }: { controller?: UpdateController }) {
  const { actions } = useApp();
  const state = useUpdateState(controller);
  const message = state.status === "unsupported" || (!isTauri() && state.status === "idle")
    ? "Updates are available in installed desktop releases."
    : state.status === "checking" ? "Checking for updates…"
      : state.status === "current" ? "You’re using the latest version."
        : state.update ? `Version ${state.update.version} is available.`
          : "Checks for new releases automatically when the app starts and every six hours.";
  return (
    <SettingsGroup title="Application updates" description={`OKF Reviewer ${version}`}>
      <div id="setting-app-updates" className="app-update-settings" tabIndex={-1}>
        <SettingRow title="Latest release" description={message} control={(
          state.update
            ? <UpdateButton controller={controller} state={state} />
            : <button type="button" className="btn" disabled={state.status === "checking" || state.status === "unsupported" || !isTauri()}
                onClick={() => void controller.check()}>
                {state.status === "checking" ? "Checking…" : "Check for updates"}
              </button>
        )} />
        {state.update && <p className="app-update-help">
          The app will restart after updating. Your settings, bundles, and saved quiz history are kept.
          {state.installation === "deb" && " Your system may ask for administrator authentication."}
        </p>}
        {state.error && <div className="app-update-error" role="alert">
          <p>{state.error}</p>
          <p>{state.update ? "Try the update again, or download the release manually." : "Check your connection and try again, or download the release manually."}</p>
        </div>}
        {state.update?.notes && <details className="app-update-notes"><summary>Release notes</summary><p>{state.update.notes}</p></details>}
        <a href="https://github.com/PMSI-AlignAlytics/okf-reviewer/releases" target="_blank" rel="noreferrer"
          onClick={(event) => { event.preventDefault(); actions.openExternal("https://github.com/PMSI-AlignAlytics/okf-reviewer/releases"); }}>View releases on GitHub</a>
      </div>
    </SettingsGroup>
  );
}

export function AppUpdates({ controller = appUpdates }: { controller?: UpdateController }) {
  const state = useUpdateState(controller);
  const busy = updateBusy(state.status);
  const percent = downloadPercent(state);
  useEffect(() => {
    if (!isTauri()) return;
    void controller.check();
    const interval = window.setInterval(() => void controller.check(), 6 * 60 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [controller]);
  return (
    <>
      {state.update && !busy && state.dismissedVersion !== state.update.version && (
        <aside className="app-update-notice" aria-label="Application update">
          <div role="status"><strong>OKF Reviewer {state.update.version} is available.</strong><span>Restart to use the latest release.</span></div>
          <div className="app-update-notice__actions">
            <UpdateButton controller={controller} state={state} />
            <button type="button" className="btn ghost icon" aria-label="Dismiss update notification" onClick={() => controller.dismiss()}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </aside>
      )}
      <Dialog.Root open={busy}>
        <Dialog.Portal>
          <Dialog.Backdrop className="ui-backdrop" />
          <Dialog.Popup className="ui-dialog app-update-dialog">
            <Dialog.Title>{state.status === "downloading" ? "Downloading update" : "Updating OKF Reviewer"}</Dialog.Title>
            <Dialog.Description>The app will restart when the update finishes. Keep it open until then.</Dialog.Description>
            <div role="status" aria-live="polite">
              {state.status === "downloading" ? percent === undefined ? "Downloading…" : `Downloaded ${percent}%`
                : state.status === "restarting" ? "Restarting…" : "Verifying and installing…"}
            </div>
            {state.status === "downloading" && <progress max={100} value={percent} aria-label="Update download" />}
            {state.installation === "deb" && <p className="app-update-help">Approve the system authentication dialog if it appears.</p>}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
