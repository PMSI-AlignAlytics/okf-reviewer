import { describe, expect, it, vi } from "vitest";
import { UpdateController } from "./controller.ts";
import type { AppUpdateCheck, UpdateApi } from "./api.ts";

const release: AppUpdateCheck = {
  supported: true, installation: "nsis", update: { version: "1.2.3", notes: "New release" }, downloaded: false,
};

function fixture() {
  const api = {
    check: vi.fn<UpdateApi["check"]>().mockResolvedValue(release),
    download: vi.fn<UpdateApi["download"]>().mockResolvedValue(undefined),
    install: vi.fn<UpdateApi["install"]>().mockResolvedValue(undefined),
  };
  return { api, controller: new UpdateController(api) };
}

describe("application updates", () => {
  it("deduplicates concurrent checks and distinguishes current and unsupported installations", async () => {
    const { api, controller } = fixture();
    let resolve!: (value: AppUpdateCheck) => void;
    api.check.mockReturnValueOnce(new Promise((success) => { resolve = success; }));
    const check = controller.check();
    await controller.check();
    expect(api.check).toHaveBeenCalledTimes(1);
    resolve({ supported: true, installation: "deb", update: null, downloaded: false });
    await check;
    expect(controller.getSnapshot().status).toBe("current");
    api.check.mockResolvedValueOnce({ supported: false, installation: null, update: null, downloaded: false });
    await controller.check();
    expect(controller.getSnapshot().status).toBe("unsupported");
    expect(api.download).not.toHaveBeenCalled();
  });

  it("downloads automatically, waits for verification and an explicit install, then saves and installs once", async () => {
    const { api, controller } = fixture();
    const events: string[] = [];
    let complete!: () => void;
    api.download.mockImplementation(async (_version, progress) => {
      events.push("download");
      progress({ downloaded: 50, total: 100 });
      await new Promise<void>((resolve) => { complete = resolve; });
      events.push("verified");
    });
    api.install.mockImplementation(() => { events.push("install"); return Promise.resolve(); });
    let saved!: () => void;
    const save = vi.fn(() => {
      events.push("save");
      return new Promise<void>((resolve) => { saved = resolve; });
    });
    const check = controller.check();
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe("downloading"));
    await controller.download();
    await controller.install(save);
    await controller.check();
    expect(api.check).toHaveBeenCalledTimes(1);
    expect(api.download).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().progress).toEqual({ downloaded: 50, total: 100 });
    complete();
    await check;
    expect(controller.getSnapshot().status).toBe("ready");
    expect(save).not.toHaveBeenCalled();
    expect(api.install).not.toHaveBeenCalled();
    const install = controller.install(save);
    await controller.install(save);
    await controller.check();
    saved();
    await install;
    expect(events).toEqual(["download", "verified", "save", "install"]);
    expect(api.install).toHaveBeenCalledExactlyOnceWith("1.2.3");
    expect(controller.getSnapshot().status).toBe("restarting");
  });

  it("never installs a failed download, and an explicit retry only prepares it", async () => {
    const { api, controller } = fixture();
    api.download.mockRejectedValueOnce(new Error("Invalid signature"));
    await controller.check();
    const save = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    await controller.install(save);
    expect(controller.getSnapshot().error).toContain("Invalid signature");
    expect(save).not.toHaveBeenCalled();
    expect(api.install).not.toHaveBeenCalled();
    await controller.download();
    expect(api.download).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().status).toBe("ready");
    expect(api.install).not.toHaveBeenCalled();
    await controller.install(save);
    expect(api.install).toHaveBeenCalledTimes(1);
  });

  it("keeps the app open if saving settings or installing fails, then prepares a safe retry", async () => {
    const { api, controller } = fixture();
    await controller.check();
    await controller.install(() => Promise.reject(new Error("Settings disk full")));
    expect(api.install).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe("error");
    await controller.download();
    api.install.mockRejectedValueOnce(new Error("Permission denied"));
    await controller.install(() => Promise.resolve());
    expect(controller.getSnapshot().error).toContain("Permission denied");
    expect(controller.getSnapshot().downloaded).toBe(false);
    expect(controller.getSnapshot().update?.version).toBe("1.2.3");
    await controller.download();
    expect(controller.getSnapshot().status).toBe("ready");
    expect(api.install).toHaveBeenCalledTimes(1);
  });

  it("restores a verified cached release without downloading or installing it", async () => {
    const { api, controller } = fixture();
    api.check.mockResolvedValue({ ...release, downloaded: true });
    await controller.check();
    await controller.check();
    expect(controller.getSnapshot().status).toBe("ready");
    expect(api.download).not.toHaveBeenCalled();
    expect(api.install).not.toHaveBeenCalled();
  });

  it("keeps a verified download installable when a later release check is offline", async () => {
    const { api, controller } = fixture();
    await controller.check();
    api.check.mockRejectedValueOnce(new Error("Offline"));
    await controller.check();
    expect(controller.getSnapshot().status).toBe("ready");
    expect(controller.getSnapshot().error).toContain("Offline");
    await controller.install(() => Promise.resolve());
    expect(api.download).toHaveBeenCalledTimes(1);
    expect(api.install).toHaveBeenCalledExactlyOnceWith("1.2.3");
  });

  it("lets a later version notify again after dismissing an earlier version", async () => {
    const { api, controller } = fixture();
    await controller.check();
    controller.dismiss();
    api.check.mockResolvedValueOnce({ ...release, downloaded: true });
    await controller.check();
    expect(controller.getSnapshot().dismissedVersion).toBe("1.2.3");
    expect(api.download).toHaveBeenCalledTimes(1);
    api.check.mockResolvedValueOnce({ ...release, update: { version: "1.2.4", notes: null } });
    await controller.check();
    expect(controller.getSnapshot().update?.version).toBe("1.2.4");
    expect(controller.getSnapshot().status).toBe("ready");
    expect(controller.getSnapshot().dismissedVersion).toBe("1.2.3");
    expect(api.download).toHaveBeenLastCalledWith("1.2.4", expect.any(Function));
    expect(api.install).not.toHaveBeenCalled();
  });

  it("recovers from an offline startup without blocking local reading", async () => {
    const { api, controller } = fixture();
    api.check.mockRejectedValueOnce(new Error("Offline"));
    await controller.check();
    expect(controller.getSnapshot().status).toBe("error");
    expect(api.download).not.toHaveBeenCalled();
    await controller.check();
    expect(controller.getSnapshot().status).toBe("ready");
    expect(controller.getSnapshot().error).toBeNull();
  });
});
