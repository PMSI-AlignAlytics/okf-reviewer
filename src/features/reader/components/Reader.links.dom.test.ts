import { describe, expect, it } from "vitest";
import { MOCK_BUNDLE } from "@/mock/fixture.ts";
import { renderMarkdown } from "@/shared/render/markdown.ts";
import { classifyBodyLinks, classifyLink } from "./Reader.tsx";

const handoff = "../../docs/migration/native_dbt_workflow_handoff.md";
const restricted = "../../../private/report.md";
const bundle = {
  ...MOCK_BUNDLE,
  documentLinks: {
    project: [
      { href: handoff, state: "available" as const },
      { href: restricted, state: "outside-scope" as const },
    ],
  },
};

describe("reader document links", () => {
  it("routes an existing document outside the OKF bundle to the native opener", () => {
    expect(classifyLink(handoff, "project", bundle)).toEqual({ kind: "document" });
  });

  it("distinguishes an access boundary from a missing target", () => {
    expect(classifyLink(restricted, "project", bundle)).toEqual({ kind: "outside-scope" });
    expect(classifyLink("../../docs/missing.md", "project", bundle)).toEqual({ kind: "unresolved" });
  });

  it("does not reuse another document's relative-link resolution", () => {
    expect(classifyLink(handoff, "requirements/workflow", bundle)).toEqual({ kind: "unresolved" });
  });

  it("opens a reserved index target as its folder home", () => {
    expect(classifyLink("features/index.md", "project", bundle)).toEqual({
      kind: "directory", dir: "features",
    });
    expect(classifyLink("/index.md", "project", bundle)).toEqual({ kind: "directory", dir: "" });
  });

  it("labels local documents and access boundaries without broken-link cues", () => {
    const template = document.createElement("template");
    template.innerHTML = classifyBodyLinks(renderMarkdown(
      `[Handoff](${handoff}) [Private report](${restricted}) [Missing](missing.md)`,
    ), "project", bundle);
    const anchors = template.content.querySelectorAll("a");

    expect(anchors[0].dataset.link).toBe("document");
    expect(anchors[0].title).toContain("default app");
    expect(anchors[0].hasAttribute("aria-disabled")).toBe(false);
    expect(anchors[0].textContent).toContain("opens in default app");
    expect(anchors[1].dataset.link).toBe("outside-scope");
    expect(anchors[1].title).toContain("Open the containing folder");
    expect(anchors[1].getAttribute("aria-disabled")).toBe("true");
    expect(anchors[1].textContent).not.toContain("broken link");
    expect(anchors[2].dataset.link).toBe("unresolved");
    expect(anchors[2].textContent).toContain("broken link");
  });
});
