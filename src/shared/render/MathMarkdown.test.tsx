import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderMathHtmlMock = vi.hoisted(() => vi.fn<(html: string) => Promise<string>>());

vi.mock("@/shared/render/math.ts", () => ({
  renderMathHtml: renderMathHtmlMock,
}));

import { MathMarkdown } from "@/shared/render/MathMarkdown.tsx";

describe("MathMarkdown", () => {
  beforeEach(() => {
    renderMathHtmlMock.mockReset();
  });

  it("shows the source fallback before upgrading it with lazy KaTeX output", async () => {
    renderMathHtmlMock.mockResolvedValue(
      '<p>Value <span class="math math-inline"><span class="katex">x²</span></span></p>',
    );
    render(
      <MathMarkdown
        html='<p>Value <span class="math math-inline">x^2</span></p>'
        data-testid="body"
      />,
    );

    expect(screen.getByTestId("body")).toHaveTextContent("Value x^2");
    await waitFor(() => {
      expect(screen.getByTestId("body").querySelector(".katex")).not.toBeNull();
    });
  });

  it("never applies a late result from previously rendered Markdown", async () => {
    let finishFirst: ((html: string) => void) | undefined;
    renderMathHtmlMock
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(
        '<p><span class="math math-inline"><span class="katex">second</span></span></p>',
      );

    const { rerender } = render(
      <MathMarkdown
        html='<p><span class="math math-inline">first</span></p>'
        data-testid="body"
      />,
    );
    rerender(
      <MathMarkdown
        html='<p><span class="math math-inline">second</span></p>'
        data-testid="body"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("body")).toHaveTextContent("second");
    });
    await act(async () => {
      finishFirst?.(
        '<p><span class="math math-inline"><span class="katex">stale first</span></span></p>',
      );
      await Promise.resolve();
    });
    expect(screen.getByTestId("body")).toHaveTextContent("second");
    expect(screen.getByTestId("body")).not.toHaveTextContent("stale first");
  });

  it("does not invoke the lazy renderer for Markdown without math", () => {
    render(<MathMarkdown html="<p>Plain prose.</p>" data-testid="body" />);
    expect(screen.getByTestId("body")).toHaveTextContent("Plain prose.");
    expect(renderMathHtmlMock).not.toHaveBeenCalled();
  });
});
