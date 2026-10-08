import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { PacerIndex } from "@/features/reader/pacerLocate.ts";
import { ReadingPacer } from "./ReadingPacer.tsx";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function showPacer(top: number, reduceMotion: boolean, uiScale = 1) {
  const bodyRef = createRef<HTMLDivElement>();
  const scroll = vi.fn();
  const onClose = vi.fn();
  vi.spyOn(PacerIndex.prototype, "rect").mockReturnValue(new DOMRect(120, top, 44, 24));
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 800, 500));
  const tree = (active: boolean) => (
    <div className="pane" ref={(node) => { if (node) node.scrollBy = scroll; }}>
      <div ref={bodyRef}><p>Read this sentence.</p></div>
      <ReadingPacer
        body="Read this sentence."
        bodyRef={bodyRef}
        wpm={60}
        chunk={1}
        reduceMotion={reduceMotion}
        uiScale={uiScale}
        active={active}
        onWpmChange={vi.fn()}
        onClose={onClose}
      />
    </div>
  );
  const result = render(tree(true));
  return { ...result, scroll, onClose, setActive: (active: boolean) => result.rerender(tree(active)) };
}

describe("guided reading beam", () => {
  it("keeps the measured word geometry and starts paused when reduced motion is selected", () => {
    const { container, scroll } = showPacer(180, true);
    const beam = container.querySelector(".reading-beam");
    expect(beam).toHaveStyle({ transform: "translate(120px, 180px)", width: "44px", height: "24px" });
    expect(beam).toHaveAttribute("data-reduced-motion", "true");
    expect(beam).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "Start pacing" })).toBeInTheDocument();
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each([
    { reduceMotion: true, behavior: "auto" },
    { reduceMotion: false, behavior: "smooth" },
  ])("still follows an off-screen word with $behavior scrolling", ({ reduceMotion, behavior }) => {
    const { container, scroll } = showPacer(600, reduceMotion);
    expect(container.querySelector(".reading-beam")).toBeNull();
    expect(scroll).toHaveBeenCalledWith({ top: 425, behavior });
  });

  it("converts magnified viewport geometry into CSS beam and bar coordinates", () => {
    const { container } = showPacer(180, true, 2);
    expect(container.querySelector(".reading-beam"))
      .toHaveStyle({ transform: "translate(60px, 90px)", width: "22px", height: "12px" });
    expect(screen.getByRole("group", { name: "Guided pacing" }))
      .toHaveStyle({ left: "250px", maxWidth: "368px" });
  });

  it("converts a magnified scroll correction into CSS scroll units", () => {
    const { scroll } = showPacer(600, true, 2);
    expect(scroll).toHaveBeenCalledWith({ top: 212.5, behavior: "auto" });
  });

  it("suspends the retained session's overlay, clock and keys while its workspace is hidden", async () => {
    vi.useFakeTimers();
    const { container, setActive, onClose, scroll } = showPacer(180, false);
    const rect = vi.mocked(PacerIndex.prototype.rect);
    const current = rect.mock.calls.at(-1)?.[0].text;
    setActive(false);
    expect(container.querySelector(".reading-beam, .pacer-bar")).toBeNull();
    const key = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    const calls = rect.mock.calls.length;
    await act(() => vi.advanceTimersByTime(5000));
    expect(rect).toHaveBeenCalledTimes(calls);
    expect(scroll).not.toHaveBeenCalled();
    setActive(true);
    expect(rect.mock.calls.at(-1)?.[0].text).toBe(current);
    expect(screen.getByRole("button", { name: "Pause pacing" })).toBeInTheDocument();
  });
});
