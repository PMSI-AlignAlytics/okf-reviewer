import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import type { CSSProperties } from "react";
import { MathMarkdown } from "@/shared/render/MathMarkdown.tsx";
import { renderMarkdown } from "@/shared/render/markdown.ts";
import "./Reader.css";

const markdown = String.raw`# Mathematical notation

Inline dollar math $e^{i\pi}+1=0$ and TeX delimiters \(\nabla \cdot \mathbf{E}=\rho/\varepsilon_0\) follow the prose baseline.

\[
\operatorname{softmax}(z)_i =
\frac{e^{z_i}}{\sum_{j=1}^{K} e^{z_j}}
\]

~~~math
\begin{aligned}
f(x_1,\ldots,x_{16})={}&a_1x_1+a_2x_2+a_3x_3+a_4x_4+a_5x_5+a_6x_6+a_7x_7+a_8x_8\\
&+a_9x_9+a_{10}x_{10}+a_{11}x_{11}+a_{12}x_{12}+a_{13}x_{13}+a_{14}x_{14}+a_{15}x_{15}+a_{16}x_{16}
\end{aligned}
~~~

An unsupported expression stays readable: $\frac{a}{$.`;

function MarkdownMath() {
  return (
    <article
      className="concept-reader"
      style={{ "--reader-measure": "72ch" } as CSSProperties}
    >
      <MathMarkdown html={renderMarkdown(markdown)} className="body markdown" />
    </article>
  );
}

const meta = {
  title: "Reader/MarkdownMath",
  component: MarkdownMath,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MarkdownMath>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(async () => {
      await expect(canvasElement.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(4);
    });
    await expect(canvas.getAllByRole("region", { name: "Equation" })).toHaveLength(2);
    await expect(canvasElement.querySelector("math")).not.toBeNull();
    await expect(canvasElement.querySelector(".katex-error")).not.toBeNull();
  },
};

export const Light: Story = {
  globals: { theme: "light" },
  play: Dark.play,
};

export const Narrow: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  play: async ({ canvasElement }) => {
    await waitFor(async () => {
      await expect(canvasElement.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(4);
    });
    const equations = canvasElement.querySelectorAll<HTMLElement>(".math-block");
    const wide = equations[equations.length - 1];
    await expect(wide).toHaveAttribute("tabindex", "0");
    await expect(wide.scrollWidth).toBeGreaterThan(wide.clientWidth);
    await expect(document.body.scrollWidth).toBe(document.body.clientWidth);
  },
};
