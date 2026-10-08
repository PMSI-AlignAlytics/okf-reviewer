import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ipc from "@/shared/ipc.ts";
import { DEFAULT_SETTINGS } from "@/shared/types.ts";
import { openBundle, renderApp } from "@/test/appHarness.tsx";

describe("shared usability improvements", () => {
  it("reopens collapsed navigation and announces the default divider width", async () => {
    const user = userEvent.setup();
    renderApp();
    await openBundle(user);
    expect(screen.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute("aria-valuenow", "280");
    await user.keyboard("[[");
    expect(screen.queryByLabelText("Search and filter concepts")).not.toBeInTheDocument();
    await user.keyboard("{Control>}k{/Control}");
    await waitFor(() => expect(screen.getByLabelText("Search and filter concepts")).toHaveFocus());
  });
  it.each(["button", "shortcut", "slash"])("returns from Quizzes to focused search using %s", async (route) => {
    const user = userEvent.setup();
    renderApp();
    await openBundle(user);
    await user.click(screen.getByRole("button", { name: "Quizzes" }));
    expect(screen.getByRole("button", { name: /generate quiz/i })).toBeVisible();
    if (route === "button") await user.click(screen.getByRole("button", { name: "Search concepts" }));
    else await user.keyboard(route === "shortcut" ? "{Control>}k{/Control}" : "/");
    await waitFor(() => expect(screen.getByLabelText("Search and filter concepts")).toHaveFocus());
    expect(screen.getByRole("button", { name: "Navigate" })).toBeVisible();
  });

  it("enlarges the interface independently from reader text", async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(ipc, "saveSettings").mockResolvedValue();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.click(screen.getByRole("button", { name: "Appearance" }));
    await user.click(screen.getByRole("combobox", { name: "Interface size" }));
    await user.click(screen.getByRole("option", { name: "200%" }));
    await waitFor(() => expect(document.documentElement.style.zoom).toBe("2"));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ uiScale: 2, readerScale: 1 }));
    expect(await screen.findByText("Preferences saved on this device")).toBeVisible();
  });

  it("explains reset scope and lets Escape cancel only the confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(ipc, "loadSettings").mockResolvedValue({ ...DEFAULT_SETTINGS, reviewerId: "alex", readerScale: 1.3 });
    const save = vi.spyOn(ipc, "saveSettings").mockResolvedValue();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    const confirmation = screen.getByRole("dialog", { name: "Reset all local preferences?" });
    expect(confirmation).toHaveTextContent("reviewer ID, name, and email");
    expect(confirmation).toHaveTextContent("Bundle files, recorded reviews, quiz history, and quiz generator profiles are kept");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset all local preferences?" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    await user.click(screen.getByRole("button", { name: "Reset all preferences" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(DEFAULT_SETTINGS));
  });

  it("shows the reason review is unavailable and recovers from a failed check", async () => {
    const user = userEvent.setup();
    const check = vi.spyOn(ipc, "reviewConceptPreflight")
      .mockRejectedValueOnce(new Error("Bundle cannot be read right now"));
    renderApp();
    await openBundle(user);
    await user.click(screen.getByRole("treeitem", { name: /Speed Reading Needs human review/i }));
    const retry = await screen.findByRole("button", { name: "Retry review check" });
    const reason = retry.closest('[role="status"]');
    expect(reason).toHaveTextContent("Bundle cannot be read right now");
    expect(reason).not.toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "Review unavailable" })).toBeDisabled();
    await user.click(retry);
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark as reviewed" })).toBeEnabled());
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("provides searchable keyboard help without activating commands inside settings", async () => {
    const user = userEvent.setup();
    renderApp();
    await openBundle(user);
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await user.type(within(dialog).getByRole("searchbox", { name: "Search settings" }), "shortcuts");
    await user.click(within(dialog).getByRole("button", { name: /Keyboard shortcuts/ }));
    expect(within(dialog).getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
    await user.keyboard("{Control>}k{/Control}");
    expect(dialog).toBeVisible();
    expect(screen.getByLabelText("Search and filter concepts")).not.toHaveFocus();
  });

  it("keeps an edited preference and shows retry when local persistence fails", async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(ipc, "saveSettings")
      .mockRejectedValueOnce(new Error("Storage is temporarily unavailable"))
      .mockResolvedValue();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.click(screen.getByRole("button", { name: "Reviewer" }));
    const name = screen.getByRole("textbox", { name: "Reviewer name" });
    await user.click(name);
    await user.paste("Alex");
    expect(await screen.findByText("Preferences could not be saved")).toBeVisible();
    expect(name).toHaveValue("Alex");
    expect(screen.queryByText("Preferences saved on this device")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry save" }));
    expect(await screen.findByText("Preferences saved on this device")).toBeVisible();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ reviewerName: "Alex" }));
  });
});
