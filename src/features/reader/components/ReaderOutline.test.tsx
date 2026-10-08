import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompactReaderOutline, ReaderOutline } from "./ReaderOutline.tsx";

const items = [
  { id: "overview", text: "Overview", level: 2 },
  { id: "detail", text: "Detail", level: 3 },
  { id: "next", text: "Next section", level: 2 },
];

describe("reader page outline", () => {
  it("keeps every side-rail heading and marks the active location", async () => {
    const onJump = vi.fn();
    const user = userEvent.setup();
    render(<ReaderOutline items={items} activeId="detail" onJump={onJump} />);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(items.map((item) => item.text));
    expect(screen.getByRole("button", { name: "Detail" })).toHaveAttribute("aria-current", "location");
    await user.click(screen.getByRole("button", { name: "Next section" }));
    expect(onJump).toHaveBeenCalledWith("next");
  });

  it("opens with Enter, closes on Escape and restores focus to its trigger", async () => {
    const user = userEvent.setup();
    render(<CompactReaderOutline items={items} activeId="overview" onJump={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "On this page" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const popup = await screen.findByRole("dialog", { name: "On this page" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(popup).getAllByRole("button")).toHaveLength(3);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("jumps to a nested heading and closes the compact outline", async () => {
    const onJump = vi.fn();
    const user = userEvent.setup();
    render(<CompactReaderOutline items={items} activeId="overview" onJump={onJump} />);
    const trigger = screen.getByRole("button", { name: "On this page" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Detail" }));
    expect(onJump).toHaveBeenCalledWith("detail");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
