import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProvider, useApp } from "./store.tsx";
import * as ipc from "./ipc.ts";
import { DEFAULT_SETTINGS, type Settings } from "./types.ts";

const LOADED_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  theme: "light",
  reviewerName: "Loaded reviewer",
};

function deferredSave() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

function SettingsConsumer() {
  const { state, actions } = useApp();
  return (
    <>
      <label>
        Reviewer name
        <input
          value={state.settings.reviewerName}
          onChange={(event) => actions.updateSettings({ reviewerName: event.target.value })}
        />
      </label>
      <output aria-label="Settings save status">{state.settingsSaveStatus}</output>
      {state.settingsSaveError && <p role="alert">{state.settingsSaveError}</p>}
      <button onClick={() => {
        actions.updateSettings({ theme: "dark" });
        actions.updateSettings({ reduceMotion: true });
        actions.updateSettings({ uiScale: 1.5 });
      }}>Apply rapid preferences</button>
      <button onClick={() => actions.retrySettingsSave()}>Retry settings save</button>
    </>
  );
}

async function renderSettings() {
  render(<AppProvider><SettingsConsumer /></AppProvider>);
  const input = screen.getByRole("textbox", { name: "Reviewer name" });
  await waitFor(() => expect(input).toHaveValue(LOADED_SETTINGS.reviewerName));
  return input;
}

beforeEach(() => {
  vi.spyOn(ipc, "loadSettings").mockResolvedValue({ ...LOADED_SETTINGS });
});

describe("settings persistence", () => {
  it("serializes rapid snapshots, merges every patch, and stays saving until the latest snapshot finishes", async () => {
    const first = deferredSave();
    const second = deferredSave();
    const latest = deferredSave();
    const save = vi.spyOn(ipc, "saveSettings")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => latest.promise);
    const user = userEvent.setup();
    await renderSettings();
    await user.click(screen.getByRole("button", { name: "Apply rapid preferences" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenNthCalledWith(1, { ...LOADED_SETTINGS, theme: "dark" });
    expect(screen.getByLabelText("Settings save status")).toHaveTextContent("saving");
    await act(async () => { first.resolve(); await first.promise; });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenNthCalledWith(2, {
      ...LOADED_SETTINGS, theme: "dark", reduceMotion: true,
    });
    expect(screen.getByLabelText("Settings save status")).toHaveTextContent("saving");

    await act(async () => { second.resolve(); await second.promise; });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(save).toHaveBeenNthCalledWith(3, {
      ...LOADED_SETTINGS, theme: "dark", reduceMotion: true, uiScale: 1.5,
    });
    expect(screen.getByLabelText("Settings save status")).toHaveTextContent("saving");
    await act(async () => { latest.resolve(); await latest.promise; });
    await waitFor(() => expect(screen.getByLabelText("Settings save status")).toHaveTextContent("saved"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains the edited value after a save failure and retries the current settings snapshot", async () => {
    const failed = deferredSave();
    const retry = deferredSave();
    const save = vi.spyOn(ipc, "saveSettings")
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => retry.promise);
    const input = await renderSettings();
    fireEvent.change(input, { target: { value: "Unsaved reviewer" } });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await act(async () => {
      failed.reject(new Error("Settings storage is unavailable."));
      await failed.promise.catch(() => undefined);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Settings storage is unavailable.");
    expect(screen.getByLabelText("Settings save status")).toHaveTextContent("error");
    expect(input).toHaveValue("Unsaved reviewer");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry settings save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith({ ...LOADED_SETTINGS, reviewerName: "Unsaved reviewer" });
    expect(screen.getByLabelText("Settings save status")).toHaveTextContent("saving");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).toHaveValue("Unsaved reviewer");

    await act(async () => { retry.resolve(); await retry.promise; });
    await waitFor(() => expect(screen.getByLabelText("Settings save status")).toHaveTextContent("saved"));
    expect(input).toHaveValue("Unsaved reviewer");
  });

  it("continues to the latest queued save after an earlier rejection without reporting that stale failure", async () => {
    const earlier = deferredSave();
    const latest = deferredSave();
    const save = vi.spyOn(ipc, "saveSettings")
      .mockImplementationOnce(() => earlier.promise)
      .mockImplementationOnce(() => latest.promise);
    const input = await renderSettings();
    fireEvent.change(input, { target: { value: "Earlier reviewer" } });
    fireEvent.change(input, { target: { value: "Latest reviewer" } });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenNthCalledWith(1, { ...LOADED_SETTINGS, reviewerName: "Earlier reviewer" });
    expect(input).toHaveValue("Latest reviewer");
    await act(async () => {
      earlier.reject(new Error("Earlier snapshot failed."));
      await earlier.promise.catch(() => undefined);
    });

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith({ ...LOADED_SETTINGS, reviewerName: "Latest reviewer" });
    expect(screen.getByLabelText("Settings save status")).toHaveTextContent("saving");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).toHaveValue("Latest reviewer");
    await act(async () => { latest.resolve(); await latest.promise; });
    await waitFor(() => expect(screen.getByLabelText("Settings save status")).toHaveTextContent("saved"));
    expect(input).toHaveValue("Latest reviewer");
  });
});
