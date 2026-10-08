import { describe, expect, it } from "vitest";
import { mapElementText } from "./pacerLocate.ts";
import { renderMarkdown } from "@/shared/render/markdown.ts";
import { gitComparisons, insertGitComparisonControls, insertGitComparisons } from "./gitComparison.ts";

describe("paced prose with comparison controls", () => {
  it("excludes the added controls and earlier version from a tight list item's word offsets", () => {
    const body = "- Read the current wording";
    const changes = [{ start: 1, end: 1, previousText: "- Read the earlier wording" }];
    const root = document.createElement("div");
    root.innerHTML = insertGitComparisons(
      insertGitComparisonControls(renderMarkdown(body, undefined, changes), changes),
      gitComparisons(body, changes, [0]).map((comparison) => ({ comparison, view: "changes" })),
    );
    const item = root.querySelector("li")!;
    const mapped = mapElementText(item);
    expect(mapped.text).toBe("Read the current wording");
    expect(mapped.nodes[mapped.text.indexOf("current")]?.textContent).toContain("current wording");
  });
});
