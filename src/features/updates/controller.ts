import { nativeUpdateApi } from "./api.ts";
import type { AppUpdateCheck, AppUpdateInfo, AppUpdateProgress, UpdateApi } from "./api.ts";

export type UpdateStatus = "idle" | "unsupported" | "checking" | "current"
  | "available" | "downloading" | "ready" | "installing" | "restarting" | "error";

export interface UpdateState {
  status: UpdateStatus;
  update: AppUpdateInfo | null;
  downloaded: boolean;
  installation: AppUpdateCheck["installation"];
  progress: AppUpdateProgress;
  error: string | null;
  dismissedVersion: string | null;
}

export function updateBusy(status: UpdateStatus): boolean {
  return status === "downloading" || status === "installing" || status === "restarting";
}

export class UpdateController {
  private state: UpdateState = {
    status: "idle", update: null, downloaded: false, installation: null,
    progress: { downloaded: 0, total: null }, error: null, dismissedVersion: null,
  };
  private listeners = new Set<() => void>();

  constructor(private api: UpdateApi) {}

  getSnapshot = (): UpdateState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async check(): Promise<void> {
    if (this.state.status === "checking" || updateBusy(this.state.status)) return;
    this.set({ status: "checking", error: null });
    try {
      const result = await this.api.check();
      this.set({
        status: !result.supported ? "unsupported" : !result.update ? "current"
          : result.downloaded ? "ready" : "available",
        update: result.update, installation: result.installation,
        downloaded: Boolean(result.update && result.downloaded),
      });
      if (result.supported && result.update && !result.downloaded) await this.download();
    } catch (error) {
      // A failed refresh must not discard a previously verified update.
      this.set({ status: this.state.downloaded ? "ready" : "error", error: String(error) });
    }
  }

  dismiss() {
    this.set({ dismissedVersion: this.state.update?.version ?? null });
  }

  async download(): Promise<void> {
    if (!this.state.update || this.state.downloaded || updateBusy(this.state.status) || this.state.status === "checking") return;
    const version = this.state.update.version;
    this.set({ status: "downloading", error: null, progress: { downloaded: 0, total: null } });
    try {
      await this.api.download(version, (progress) => this.set({ progress }));
      this.set({ status: "ready", downloaded: true });
    } catch (error) {
      this.set({ status: "error", downloaded: false, error: String(error) });
    }
  }

  async install(beforeInstall: () => Promise<void>): Promise<void> {
    if (!this.state.update || !this.state.downloaded || this.state.status !== "ready") return;
    const version = this.state.update.version;
    this.set({ status: "installing", error: null });
    try {
      await beforeInstall();
      await this.api.install(version);
      this.set({ status: "restarting" });
    } catch (error) {
      // The native installer may have consumed its bytes. Prepare the signed
      // cache again before offering another explicit installation attempt.
      this.set({ status: "error", downloaded: false, error: String(error) });
    }
  }
}

export const appUpdates = new UpdateController(nativeUpdateApi);
