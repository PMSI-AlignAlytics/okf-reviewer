import { useEffect, useMemo, useState } from "react";
import type { HTMLAttributes } from "react";
import { renderMathHtml } from "@/shared/render/math.ts";

export interface MathMarkdownProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "dangerouslySetInnerHTML"> {
  /** Sanitized HTML returned by `renderMarkdown`. */
  html: string;
}

/**
 * Render sanitized Markdown HTML and lazily upgrade any math placeholders.
 *
 * The result is paired with its source so a rapid content change can never
 * flash a completed render from the previous document. While KaTeX loads, or
 * if it is unavailable, the authored TeX fallback remains visible.
 */
export function MathMarkdown({ html, ...props }: MathMarkdownProps) {
  const [processed, setProcessed] = useState<{ source: string; html: string } | null>(null);

  useEffect(() => {
    if (!html.includes('class="math')) return;
    let cancelled = false;
    void renderMathHtml(html).then((next) => {
      if (!cancelled) setProcessed({ source: html, html: next });
    });
    return () => {
      cancelled = true;
    };
  }, [html]);

  const output = processed?.source === html ? processed.html : html;
  // React compares dangerouslySetInnerHTML by object identity; keep the wrapper
  // stable so unrelated parent updates do not replace the upgraded math DOM.
  const innerHtml = useMemo(() => ({ __html: output }), [output]);
  return <div {...props} dangerouslySetInnerHTML={innerHtml} />;
}
