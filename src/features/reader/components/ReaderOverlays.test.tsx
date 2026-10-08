import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MOCK_BUNDLE } from "@/mock/fixture.ts";
import { PeekCard } from "./PeekCard.tsx";
import { GitDiffTooltip } from "./GitDiffTooltip.tsx";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function dimensions(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height);
  vi.stubGlobal("innerWidth", 1000);
  vi.stubGlobal("innerHeight", 800);
}

describe("reader previews at interface magnification", () => {
  it("places and flips the concept preview using scaled viewport bounds", () => {
    dimensions(340, 100);
    render(<PeekCard
      target={{ id: "features/graph-view", anchor: new DOMRect(800, 650, 80, 40) }}
      bundle={MOCK_BUNDLE}
      dark={false}
      uiScale={2}
    />);
    expect(screen.getByRole("tooltip", { name: "Preview: Graph View" }))
      .toHaveStyle({ width: "340px", left: "152px", top: "217px" });
  });

  it("places the change preview in CSS coordinates and bounds its width", () => {
    dimensions(300, 80);
    render(<GitDiffTooltip
      target={{ anchor: new DOMRect(200, 120, 80, 40), comparisons: [] }}
      onPointerEnter={vi.fn()}
      onPointerLeave={vi.fn()}
      uiScale={2}
    />);
    expect(screen.getByRole("tooltip"))
      .toHaveStyle({ left: "100px", top: "88px", maxWidth: "484px" });
  });

  it("uses the card's narrowed measured width in a magnified popout", () => {
    dimensions(264, 100);
    vi.stubGlobal("innerWidth", 560);
    render(<PeekCard
      target={{ id: "features/graph-view", anchor: new DOMRect(280, 120, 80, 40) }}
      bundle={MOCK_BUNDLE}
      dark={false}
      uiScale={2}
    />);
    expect(screen.getByRole("tooltip", { name: "Preview: Graph View" }))
      .toHaveStyle({ width: "264px", left: "8px", top: "88px" });
  });
});
