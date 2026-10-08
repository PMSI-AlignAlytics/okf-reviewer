import fs from "node:fs";
import { expect, it } from "vitest";
import { renderMarkdown } from "@/shared/render/markdown.ts";
import { classifyBodyLinks } from "@/features/reader/components/Reader.tsx";
import type { Bundle } from "@/shared/types.ts";

// Optional local smoke check: the captured bundle snapshots are not repository fixtures.
const snapshotsPath = "/tmp/okf-review-avalon-snapshots-20261008.json";
it.skipIf(!fs.existsSync(snapshotsPath))("checks every current Avalon Project Context body link", () => {
  const snapshots = JSON.parse(fs.readFileSync(snapshotsPath, "utf8")) as Record<string, Bundle>;
  for (const [scope, bundle] of Object.entries(snapshots)) {
    const context = bundle.concepts.find((concept) => concept.id === "project")!;
    const template = document.createElement("template");
    template.innerHTML = classifyBodyLinks(renderMarkdown(context.body), context.id, bundle);
    const links = Array.from(template.content.querySelectorAll<HTMLAnchorElement>("a[href]:not(.heading-anchor)"));
    console.log(JSON.stringify({scope, links: links.map((a) => ({label: a.textContent, href: a.getAttribute("href"), kind: a.dataset.link, title: a.title}))}));
    expect(links.filter((a) => a.dataset.link === "unresolved")).toHaveLength(0);
  }
});
