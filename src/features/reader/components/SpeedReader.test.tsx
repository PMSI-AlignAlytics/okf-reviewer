import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { SpeedReader } from "./SpeedReader.tsx";

afterEach(() => vi.useRealTimers());

describe("retained focus reading session", () => {
  it("stops its clock, keyboard capture and focus trap while the reader is inactive", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const view = (active: boolean) => (
      <>
        <input aria-label="Quiz answer" />
        <SpeedReader
          title="A concept"
          body="Read this whole sentence."
          wpm={60}
          chunk={1}
          boldStart={false}
          reduceMotion={false}
          active={active}
          onWpmChange={vi.fn()}
          onClose={onClose}
        />
      </>
    );
    const { container, rerender } = render(view(true));
    const word = container.querySelector(".speedread-word")?.textContent;
    expect(screen.getByRole("dialog", { name: "Speed reading: A concept" })).toBeInTheDocument();
    rerender(view(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    screen.getByRole("textbox", { name: "Quiz answer" }).focus();
    expect(screen.getByRole("textbox", { name: "Quiz answer" })).toHaveFocus();
    const key = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(5000));
    rerender(view(true));
    expect(container.querySelector(".speedread-word")?.textContent).toBe(word);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await act(() => vi.advanceTimersByTime(1200));
    expect(container.querySelector(".speedread-word")?.textContent).not.toBe(word);
  });
});
