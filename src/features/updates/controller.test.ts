import { describe, expect, it, vi } from "vitest";
import { UpdateController } from "./controller.ts";
import type { AppUpdateCheck, UpdateApi } from "./api.ts";

function fixture() {
  const api = {
    check: vi.fn<UpdateApi["check"]>().mockResolvedValue({ supported: true, installation: "nsis", update: { version: "1.2.3", notes: "New release" } }),
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
    resolve({ supported: true, installation: "deb", update: null });
    await check;
    expect(controller.getSnapshot().status).toBe("current");
    api.check.mockResolvedValueOnce({ supported: false, installation: null, update: null });
    await controller.check();
    expect(controller.getSnapshot().status).toBe("unsupported");
  });

  it("verifies the download, saves settings, then installs once despite repeated clicks", async () => {
    const { api, controller } = fixture();
    await controller.check();
    const events: string[] = [];
    let complete!: () => void;
    api.download.mockImplementation(async (_version, progress) => {
      events.push("download");
      progress({ downloaded: 50, total: 100 });
      await new Promise<void>((resolve) => { complete = resolve; });
      events.push("verified");
    });
    api.install.mockImplementation(() => { events.push("install"); return Promise.resolve(); });
    const save = vi.fn(() => { events.push("save"); return Promise.resolve(); });
    const install = controller.install(save);
    await controller.install(save);
    await controller.check();
    expect(controller.getSnapshot().progress).toEqual({ downloaded: 50, total: 100 });
    complete();
    await install;
    expect(events).toEqual(["download", "verified", "save", "install"]);
    expect(api.check).toHaveBeenCalledTimes(1);
    expect(api.install).toHaveBeenCalledWith("1.2.3");
    expect(api.install).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().status).toBe("restarting");
  });

  it("never installs an unverified download and permits an explicit retry", async () => {
    const { api, controller } = fixture();
    await controller.check();
    api.download.mockRejectedValueOnce(new Error("Invalid signature"));
    const save = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    await controller.install(save);
    expect(controller.getSnapshot().error).toContain("Invalid signature");
    expect(save).not.toHaveBeenCalled();
    expect(api.install).not.toHaveBeenCalled();
    await controller.install(save);
    expect(api.download).toHaveBeenCalledTimes(2);
    expect(api.install).toHaveBeenCalledTimes(1);
  });

  it("keeps the app open if saving settings or installing fails", async () => {
    const { api, controller } = fixture();
    await controller.check();
    await controller.install(() => Promise.reject(new Error("Settings disk full")));
    expect(api.install).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe("error");
    api.install.mockRejectedValueOnce(new Error("Permission denied"));
    await controller.install(() => Promise.resolve());
    expect(controller.getSnapshot().error).toContain("Permission denied");
    expect(controller.getSnapshot().update?.version).toBe("1.2.3");
  });

  it("lets a later version notify again after dismissing an earlier version", async () => {
    const { api, controller } = fixture();
    await controller.check();
    controller.dismiss();
    await controller.check();
    expect(controller.getSnapshot().dismissedVersion).toBe("1.2.3");
    api.check.mockResolvedValueOnce({ supported: true, installation: "nsis", update: { version: "1.2.4", notes: null } });
    await controller.check();
    expect(controller.getSnapshot().update?.version).toBe("1.2.4");
    expect(controller.getSnapshot().dismissedVersion).toBe("1.2.3");
  });

  it("recovers from an offline check without blocking local reading", async () => {
    const { api, controller } = fixture();
    api.check.mockRejectedValueOnce(new Error("Offline"));
    await controller.check();
    expect(controller.getSnapshot().status).toBe("error");
    await controller.check();
    expect(controller.getSnapshot().status).toBe("available");
    expect(controller.getSnapshot().error).toBeNull();
  });
});
