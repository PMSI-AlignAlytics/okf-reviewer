import { useEffect, useSyncExternalStore } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Download, RefreshCw, X } from "lucide-react";
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
  const blocked = state.downloaded && Boolean(appState.quizGeneration);
  const Icon = state.downloaded ? RefreshCw : Download;
  return (
    <>
      <button type="button" className="btn primary"
        disabled={blocked || updateBusy(state.status) || state.status === "checking"}
        onClick={() => void (state.downloaded ? controller.install(() => actions.flushSettings()) : controller.download())}>
        <Icon size={14} aria-hidden="true" />
        {state.status === "downloading" ? "Downloading…" : state.downloaded ? "Install and restart"
          : state.status === "error" ? "Retry download" : "Download update"}
      </button>
      {blocked && <p className="app-update-help">Finish or cancel quiz generation before updating.</p>}
    </>
  );
}

export function AppUpdatesSettings({ controller = appUpdates }: { controller?: UpdateController }) {
  const { actions } = useApp();
  const state = useUpdateState(controller);
  const percent = downloadPercent(state);
  const message = state.status === "unsupported" || (!isTauri() && state.status === "idle")
    ? "Updates are available in installed desktop releases."
    : state.status === "checking" ? "Checking for updates…"
      : state.status === "current" ? "You’re using the latest version."
        : state.status === "downloading" ? `Downloading version ${state.update?.version}${percent === undefined ? "…" : `: ${percent}%`}`
          : state.status === "installing" || state.status === "restarting" ? "Installing the update and restarting…"
            : state.downloaded ? `Version ${state.update?.version} is ready to install.`
              : state.update ? `Version ${state.update.version} is available.`
                : "Checks for new releases when the app starts and every six hours.";
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
        <p className="app-update-help">Updates download automatically in the background. Installation and restart happen only when you choose.</p>
        {state.status === "downloading" && <progress max={100} value={percent} aria-label="Update download" />}
        {state.update && <p className="app-update-help">
          {state.downloaded && "The download is verified and saved on this device. "}
          Your settings, bundles, and saved quiz history are kept when you update.
          {state.installation === "deb" && " Your system may ask for administrator authentication."}
        </p>}
        {state.error && <div className="app-update-error" role="alert">
          <p>{state.error}</p>
          <p>{state.downloaded ? "The verified update is still ready to install."
            : state.update ? "Retry the download to prepare the update again, or download the release manually."
              : "Check your connection and try again, or download the release manually."}</p>
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
  const installing = state.status === "installing" || state.status === "restarting";
  const percent = downloadPercent(state);
  useEffect(() => {
    if (!isTauri()) return;
    void controller.check();
    const interval = window.setInterval(() => void controller.check(), 6 * 60 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [controller]);
  return (
    <>
      {state.update && !installing && state.dismissedVersion !== state.update.version && (
        <aside className="app-update-notice" aria-label="Application update">
          <div role="status">
            <strong>OKF Reviewer {state.update.version} {state.downloaded ? "is ready to install." : state.status === "downloading" ? "is downloading." : "is available."}</strong>
            <span>{state.status === "downloading" ? percent === undefined ? "You can keep working." : `Downloaded ${percent}%. You can keep working.`
              : state.downloaded ? "Install and restart when you’re ready." : "Retry the download to prepare the update."}</span>
          </div>
          <div className="app-update-notice__actions">
            <UpdateButton controller={controller} state={state} />
            <button type="button" className="btn ghost icon" aria-label="Dismiss update notification" onClick={() => controller.dismiss()}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </aside>
      )}
      <Dialog.Root open={installing}>
        <Dialog.Portal>
          <Dialog.Backdrop className="ui-backdrop" />
          <Dialog.Popup className="ui-dialog app-update-dialog">
            <Dialog.Title>Updating OKF Reviewer</Dialog.Title>
            <Dialog.Description>The app will restart when the update finishes. Keep it open until then.</Dialog.Description>
            <div role="status" aria-live="polite">
              {state.status === "restarting" ? "Restarting…" : "Verifying and installing…"}
            </div>
            {state.installation === "deb" && <p className="app-update-help">Approve the system authentication dialog if it appears.</p>}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
