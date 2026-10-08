import { nativeUpdateApi } from "./api.ts";
import type { AppUpdateCheck, AppUpdateInfo, AppUpdateProgress, UpdateApi } from "./api.ts";

export type UpdateStatus = "idle" | "unsupported" | "checking" | "current"
  | "available" | "downloading" | "installing" | "restarting" | "error";

export interface UpdateState {
  status: UpdateStatus;
  update: AppUpdateInfo | null;
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
    status: "idle", update: null, installation: null,
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
        status: !result.supported ? "unsupported" : result.update ? "available" : "current",
        update: result.update, installation: result.installation,
      });
    } catch (error) {
      this.set({ status: "error", update: null, error: String(error) });
    }
  }

  dismiss() {
    this.set({ dismissedVersion: this.state.update?.version ?? null });
  }

  async install(beforeInstall: () => Promise<void>): Promise<void> {
    if (!this.state.update || updateBusy(this.state.status) || this.state.status === "checking") return;
    const version = this.state.update.version;
    this.set({ status: "downloading", error: null, progress: { downloaded: 0, total: null } });
    try {
      await this.api.download(version, (progress) => this.set({ progress }));
      this.set({ status: "installing" });
      await beforeInstall();
      await this.api.install(version);
      this.set({ status: "restarting" });
    } catch (error) {
      // Every explicit retry downloads and verifies the artifact again.
      this.set({ status: "error", error: String(error) });
    }
  }
}

export const appUpdates = new UpdateController(nativeUpdateApi);
