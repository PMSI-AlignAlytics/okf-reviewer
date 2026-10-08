import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/shared/render/markdown.ts";
import {
  gitComparisons,
  insertGitComparisons,
  insertGitComparisonControls,
  comparisonTrigger,
  passageTabStop,
} from "@/features/reader/gitComparison.ts";
import type { ComparisonView } from "@/features/reader/gitComparison.ts";
import type { GitLineChange } from "@/shared/types.ts";

function open(
  body: string,
  changes: GitLineChange[],
  panels: [number, ComparisonView][],
): DocumentFragment {
  const views = new Map(panels);
  const html = insertGitComparisons(
    renderMarkdown(body, undefined, changes),
    gitComparisons(body, changes, [...views.keys()]).map((comparison) => ({
      comparison,
      view: views.get(comparison.index) ?? "changes",
    })),
  );
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

describe("gitComparisons", () => {
  it("compares replaced hunks with the current body lines and skips pure additions", () => {
    const body = ["# Title", "", "Added paragraph.", "", "The entire concept."].join("\n");
    const changes: GitLineChange[] = [
      { start: 1, end: 1, previousText: "# Old title" },
      { start: 3, end: 3, previousText: null },
      { start: 5, end: 5, previousText: "The whole concept." },
    ];

    const comparisons = gitComparisons(body, changes, [2, 1, 0, 2]);

    expect(comparisons.map(({ index, ordinal, total }) => [index, ordinal, total]))
      .toEqual([[0, 1, 2], [2, 2, 2]]);
    expect(comparisons[1].parts).toEqual([
      { kind: "same", text: "The " },
      { kind: "removed", text: "whole " },
      { kind: "added", text: "entire " },
      { kind: "same", text: "concept." },
    ]);
  });
});

describe("insertGitComparisons", () => {
  const paragraph = "A reviewer reads the entire concept before recording a review.";
  const changes: GitLineChange[] = [
    { start: 1, end: 1, previousText: "A reviewer reads the whole concept before recording a review." },
  ];

  it("leaves the body untouched when nothing is open", () => {
    const html = renderMarkdown(paragraph, undefined, changes);
    expect(insertGitComparisons(html, [])).toBe(html);
  });

  it("opens a comparison directly after the changed paragraph", () => {
    const root = open(`${paragraph}\n\nNext paragraph.`, changes, [[0, "changes"]]);
    const panel = root.querySelector<HTMLElement>(".git-diff-compare");

    expect(panel?.previousElementSibling?.tagName).toBe("P");
    expect(panel?.nextElementSibling?.textContent).toBe("Next paragraph.");
    expect(panel?.getAttribute("role")).toBe("group");
    expect(panel?.getAttribute("aria-label")).toBe("Earlier version");
    expect(panel?.tabIndex).toBe(-1);
    // The strike and underline stop at the word; the space follows outside.
    expect(panel?.querySelector("del")?.textContent).toBe("Removed: whole");
    expect(panel?.querySelector("ins")?.textContent).toBe("Added: entire");
    expect(panel?.querySelector("ins")?.nextSibling?.textContent).toBe(" concept before recording a review.");
    expect(panel?.querySelector('[data-git-compare-view="changes"]')?.getAttribute("aria-pressed"))
      .toBe("true");
    expect(root.querySelector("p .git-diff-change")?.classList.contains("is-comparing")).toBe(true);
  });

  it("shows the whole previous source in the previous-text view", () => {
    const root = open(paragraph, changes, [[0, "previous"]]);
    const panel = root.querySelector(".git-diff-compare");

    expect(panel?.querySelector(".git-diff-compare-text")?.textContent)
      .toBe(changes[0].previousText);
    expect(panel?.querySelector("del, ins")).toBeNull();
    expect(panel?.querySelector('[data-git-compare-view="previous"]')?.getAttribute("aria-pressed"))
      .toBe("true");
  });

  it("says so when only spacing or line breaks changed", () => {
    const root = open("one two\nthree", [
      { start: 1, end: 2, previousText: "one\ntwo three" },
    ], [[0, "changes"]]);

    expect(root.querySelector(".git-diff-compare-note")?.textContent)
      .toBe("Only spacing or line breaks changed.");
  });

  it("keeps a tight list item's panel above its nested list", () => {
    const body = ["- Changed item", "  - Nested item", "- Next item"].join("\n");
    const root = open(body, [{ start: 1, end: 1, previousText: "- Old item" }], [[0, "changes"]]);
    const item = root.querySelector("li");
    const panel = item?.querySelector(":scope > .git-diff-compare");

    expect(panel).not.toBeNull();
    expect(panel?.nextElementSibling?.tagName).toBe("UL");
  });

  it("opens a table row's comparison after the table", () => {
    const body = ["| Name | State |", "| --- | --- |", "| Reader | Changed |"].join("\n");
    const root = open(body, [{ start: 3, end: 3, previousText: "| Reader | Old |" }], [[0, "changes"]]);
    const panel = root.querySelector(".git-diff-compare");

    expect(panel?.previousElementSibling?.querySelector("table")).not.toBeNull();
    expect(root.querySelector("table .git-diff-compare")).toBeNull();
  });

  it("opens a code block's comparison after its block wrapper", () => {
    const body = ["```ts", "const changed = true;", "```"].join("\n");
    const root = open(body, [{ start: 2, end: 2, previousText: "const changed = false;" }], [[0, "changes"]]);
    const panel = root.querySelector(".git-diff-compare");

    expect(panel?.previousElementSibling?.classList.contains("git-diff-change-block")).toBe(true);
  });

  it("stacks comparisons for hunks in one paragraph in hunk order", () => {
    const body = ["First line changed", "middle line", "last line changed"].join("\n");
    const root = open(body, [
      { start: 1, end: 1, previousText: "First line" },
      { start: 3, end: 3, previousText: "last line" },
    ], [[1, "changes"], [0, "changes"]]);
    const panels = [...root.querySelectorAll<HTMLElement>(".git-diff-compare")];

    expect(panels.map((panel) => panel.dataset.gitCompare)).toEqual(["0", "1"]);
    expect(panels[0].previousElementSibling?.tagName).toBe("P");
    expect(panels[0].querySelector(".git-diff-compare-count")?.textContent).toBe("Change 1 of 2");
    expect(panels[1].getAttribute("aria-label")).toBe("Earlier version, change 2 of 2");
  });
});

describe("passageTabStop", () => {
  it("finds a hunk's single tab stop across a hard-wrapped paragraph", () => {
    const body = ["The first wrapped line", "and the second line."].join("\n");
    const html = renderMarkdown(body, undefined, [
      { start: 1, end: 2, previousText: "The first line\nand the second." },
    ]);
    const template = document.createElement("template");
    template.innerHTML = html;
    const passages = template.content.querySelectorAll<HTMLElement>(".git-diff-change");

    expect(passages).toHaveLength(2);
    expect(passages[0].tabIndex).toBe(0);
    expect(passages[1].hasAttribute("tabindex")).toBe(false);
    expect(passageTabStop(template.content, 0)).toBe(passages[0]);
    expect(passageTabStop(template.content, 1)).toBeNull();
  });
});

describe("explicit comparison controls", () => {
  const body = "Read the [authored link](target.md)\nand its wrapped continuation.";
  const changes: GitLineChange[] = [
    { start: 1, end: 2, previousText: "Read the earlier text." },
  ];

  function controls() {
    const template = document.createElement("template");
    template.innerHTML = insertGitComparisonControls(renderMarkdown(body, undefined, changes), changes);
    return template.content;
  }

  it("adds one named control for a wrapped hunk without replacing its prose or links", () => {
    const root = controls();
    const button = comparisonTrigger(root, 0);
    expect(root.querySelectorAll("[data-git-compare-toggle]")).toHaveLength(1);
    expect(button?.textContent).toBe("Compare changes");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    const target = root.querySelector(`#${button?.getAttribute("aria-controls")}`);
    expect(target).toHaveProperty("hidden", true);
    expect(button?.closest("p, a, .git-diff-change")).toBeNull();
    expect(root.querySelector("p a")?.getAttribute("href")).toBe("target.md");
    expect(root.querySelector("p [role='button'], p button")).toBeNull();
    expect(passageTabStop(root, 0)?.tagName).toBe("SPAN");
  });

  it("connects an expanded button to the existing in-place panel", () => {
    const template = document.createElement("template");
    template.innerHTML = insertGitComparisons(
      insertGitComparisonControls(renderMarkdown(body, undefined, changes), changes),
      gitComparisons(body, changes, [0]).map((comparison) => ({ comparison, view: "changes" })),
    );
    const root = template.content;
    const button = comparisonTrigger(root, 0);
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelectorAll(`#${button?.getAttribute("aria-controls")}`)).toHaveLength(1);
    expect(root.querySelector(`#${button?.getAttribute("aria-controls")}`)?.getAttribute("role")).toBe("group");
    expect(root.querySelector("[data-git-compare-placeholder]")).toBeNull();
  });

  it("places controls outside tables and keeps earlier HTML as literal source", () => {
    const markdown = "| Name | State |\n| --- | --- |\n| Reader | Changed |";
    const changes: GitLineChange[] = [{ start: 3, end: 3, previousText: '<img src=x onerror="alert(1)"> | Old |' }];
    const template = document.createElement("template");
    template.innerHTML = insertGitComparisons(
      insertGitComparisonControls(renderMarkdown(markdown, undefined, changes), changes),
      gitComparisons(markdown, changes, [0]).map((comparison) => ({ comparison, view: "previous" })),
    );
    expect(template.content.querySelector("table button[data-git-compare-toggle]")).toBeNull();
    const panel = template.content.querySelector(".git-diff-compare");
    expect(panel?.querySelector("img, [onerror]")).toBeNull();
    expect(panel?.querySelector(".git-diff-compare-text")?.textContent).toBe(changes[0].previousText);
  });
});
