import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "@/shared/store.tsx";
import * as ipc from "@/shared/ipc.ts";
import * as nativeWindow from "@/shared/platform/window.ts";
import { AppUpdates, AppUpdatesSettings } from "./AppUpdates.tsx";
import { UpdateController } from "./controller.ts";
import type { UpdateApi } from "./api.ts";

function fixture() {
  vi.spyOn(nativeWindow, "isWindowMaximized").mockResolvedValue(false);
  vi.spyOn(nativeWindow, "onWindowResized").mockResolvedValue(() => {});
  const api = {
    check: vi.fn<UpdateApi["check"]>().mockResolvedValue({ supported: true, installation: "nsis", update: { version: "1.2.3", notes: "New release" } }),
    download: vi.fn<UpdateApi["download"]>().mockResolvedValue(undefined),
    install: vi.fn<UpdateApi["install"]>().mockResolvedValue(undefined),
  };
  const controller = new UpdateController(api);
  render(<AppProvider><AppUpdates controller={controller} /><AppUpdatesSettings controller={controller} /></AppProvider>);
  return { api, controller };
}

describe("update interface", () => {
  it("checks on startup, dismisses the notice, and keeps the manual update available", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    fixture();
    const user = userEvent.setup();
    const notice = await screen.findByRole("complementary", { name: "Application update" });
    expect(within(notice).getByText("OKF Reviewer 1.2.3 is available.")).toBeVisible();
    await user.click(within(notice).getByRole("button", { name: "Dismiss update notification" }));
    expect(screen.queryByRole("complementary", { name: "Application update" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update and restart" })).toBeEnabled();
  });

  it("shows download progress and refuses installation if preferences cannot be saved", async () => {
    vi.spyOn(ipc, "isTauri").mockReturnValue(true);
    vi.spyOn(ipc, "saveSettings").mockRejectedValue(new Error("Could not save preferences"));
    const { api } = fixture();
    let finish!: () => void;
    api.download.mockImplementation(async (_version, progress) => {
      progress({ downloaded: 25, total: 100 });
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    const user = userEvent.setup();
    const notice = await screen.findByRole("complementary", { name: "Application update" });
    await user.click(within(notice).getByRole("button", { name: "Update and restart" }));
    const dialog = await screen.findByRole("dialog", { name: "Downloading update" });
    expect(within(dialog).getByRole("progressbar", { name: "Update download" })).toHaveAttribute("value", "25");
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    await act(async () => { finish(); await Promise.resolve(); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save preferences");
    expect(api.install).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: "Retry update" })[0]).toBeEnabled();
  });

  it("explains why updates cannot run in a browser preview", () => {
    fixture();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    expect(screen.getByText("Updates are available in installed desktop releases.")).toBeVisible();
  });
});
