import { isTauri } from "@/shared/ipc.ts";

export interface AppUpdateInfo {
  version: string;
  notes: string | null;
}

export interface AppUpdateCheck {
  supported: boolean;
  installation: "msi" | "nsis" | "deb" | "appimage" | null;
  update: AppUpdateInfo | null;
}

export interface AppUpdateProgress {
  downloaded: number;
  total: number | null;
}

export interface UpdateApi {
  check(): Promise<AppUpdateCheck>;
  download(version: string, onProgress: (progress: AppUpdateProgress) => void): Promise<void>;
  install(version: string): Promise<void>;
}

export const nativeUpdateApi: UpdateApi = {
  async check() {
    if (!isTauri()) return { supported: false, installation: null, update: null };
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<AppUpdateCheck>("check_app_update");
  },
  async download(version, onProgress) {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    const progress = new Channel<AppUpdateProgress>();
    progress.onmessage = onProgress;
    await invoke("download_app_update", { version, onProgress: progress });
  },
  async install(version) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("install_app_update", { version });
  },
};
