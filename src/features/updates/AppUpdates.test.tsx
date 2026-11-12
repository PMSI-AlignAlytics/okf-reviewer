import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "@/shared/store.tsx";
import * as ipc from "@/shared/ipc.ts";
import * as nativeWindow from "@/shared/platform/window.ts";
import { AppUpdates, AppUpdatesSettings } from "./AppUpdates.tsx";
import { UpdateController } from "./controller.ts";
import type { UpdateApi } from "./api.ts";

function fixture(download?: UpdateApi["download"]) {
  vi.spyOn(nativeWindow, "isWindowMaximized").mockResolvedValue(false);
  vi.spyOn(nativeWindow, "onWindowResized").mockResolvedValue(() => {});
  const api = {
    check: vi.fn<UpdateApi["check"]>().mockResolvedValue({ supported: true, installation: "nsis", update: { version: "1.2.3", notes: "New release" }, downloaded: false }),
    download: vi.fn<UpdateApi["download"]>().mockImplementation(download ?? (() => Promise.resolve())),
    install: vi.fn<UpdateApi["install"]>().mockResolvedValue(undefined),
  };
  const controller = new UpdateController(api);
  render(<AppProvider><AppUpdates controller={controller} /><AppUpdatesSettings controller={controller} /></AppProvider>);
  return { api, controller };
}

describe("update interface", () => {
  it("downloads on startup, waits for the user to install, and keeps a dismissed update in settings", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    const { api } = fixture();
    const user = userEvent.setup();
    const notice = await screen.findByRole("complementary", { name: "Application update" });
    expect(within(notice).getByText("OKF Reviewer 1.2.3 is ready to install.")).toBeVisible();
    expect(api.download).toHaveBeenCalledTimes(1);
    expect(api.install).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(within(notice).getByRole("button", { name: "Dismiss update notification" }));
    expect(screen.queryByRole("complementary", { name: "Application update" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install and restart" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(await screen.findByRole("dialog", { name: "Updating OKF Reviewer" })).toBeVisible();
    expect(api.install).toHaveBeenCalledExactlyOnceWith("1.2.3");
    expect(api.download).toHaveBeenCalledTimes(1);
  });

  it("shows background progress without a modal and saves preferences only when installation is requested", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    const save = vi.spyOn(ipc, "saveSettings").mockRejectedValue(new Error("Could not save preferences"));
    let finish!: () => void;
    const { api } = fixture(async (_version, progress) => {
      progress({ downloaded: 25, total: 100 });
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    const user = userEvent.setup();
    expect(await screen.findByRole("progressbar", { name: "Update download" })).toHaveAttribute("value", "25");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View releases on GitHub" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Install and restart" })).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    await act(async () => { finish(); await Promise.resolve(); });
    const notice = screen.getByRole("complementary", { name: "Application update" });
    expect(within(notice).getByRole("button", { name: "Install and restart" })).toBeEnabled();
    expect(api.install).not.toHaveBeenCalled();
    await user.click(within(notice).getByRole("button", { name: "Install and restart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save preferences");
    expect(api.install).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "Retry download" })[0]).toBeEnabled();
  });

  it("retries a failed background download without installing it", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    const { api } = fixture(() => Promise.reject(new Error("Connection lost")));
    const user = userEvent.setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    api.download.mockResolvedValue(undefined);
    await user.click(within(screen.getByRole("complementary", { name: "Application update" })).getByRole("button", { name: "Retry download" }));
    expect(screen.getAllByRole("button", { name: "Install and restart" })[0]).toBeEnabled();
    expect(api.install).not.toHaveBeenCalled();
  });

  it("explains why updates cannot run in a browser preview", () => {
    fixture();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(screen.getByText("Updates are available in installed desktop releases.")).toBeVisible();
  });
});
