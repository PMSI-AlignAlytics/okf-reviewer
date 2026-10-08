import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as ipc from "@/shared/ipc.ts";
import { MOCK_BUNDLE } from "@/mock/fixture.ts";
import { openBundle, renderApp } from "@/test/appHarness.tsx";
import type { Bundle } from "@/shared/types.ts";

const sourceId = "product/overview";
const handoff = "../../docs/migration/native_dbt_workflow_handoff.md";
const restricted = "../../../private/report.md";
const bundle: Bundle = {
  ...MOCK_BUNDLE,
  concepts: MOCK_BUNDLE.concepts.map((concept) => concept.id === sourceId ? {
    ...concept,
    title: "Project context",
    body: `[Migration handoff](${handoff}) [Private report](${restricted}) [Missing report](missing.md) [Features section](/features/index.md)`,
    brokenLinks: ["missing.md"],
  } : concept),
  documentLinks: {
    [sourceId]: [
      { href: handoff, state: "available" },
      { href: restricted, state: "outside-scope" },
    ],
  },
};

afterEach(() => vi.restoreAllMocks());

async function openContext(user: ReturnType<typeof userEvent.setup>) {
  vi.spyOn(ipc, "readBundle").mockResolvedValue(bundle);
  renderApp();
  await openBundle(user);
  await user.click(screen.getByRole("treeitem", { name: /Overview/ }));
  await screen.findByRole("heading", { name: "Project context", level: 1 });
}

describe("local document link activation", () => {
  it("opens the authored local reference and keeps unavailable links inert", async () => {
    const user = userEvent.setup();
    const openDocument = vi.spyOn(ipc, "openLinkedDocument").mockResolvedValue();
    await openContext(user);

    await user.click(screen.getByRole("link", { name: /Migration handoff/ }));
    expect(openDocument).toHaveBeenCalledWith(bundle.root, sourceId, handoff);
    expect(screen.getByRole("heading", { name: "Project context", level: 1 })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /Private report/ }));
    await user.click(screen.getByRole("link", { name: /Missing report/ }));
    expect(openDocument).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("link", { name: "Features section" }));
    expect(await screen.findByRole("heading", { name: "Features", level: 1 })).toBeInTheDocument();
    expect(openDocument).toHaveBeenCalledTimes(1);
  });

  it("supports keyboard activation and reports a stale target without losing the source", async () => {
    const user = userEvent.setup();
    const openDocument = vi.spyOn(ipc, "openLinkedDocument")
      .mockRejectedValueOnce("The linked Markdown document is no longer available. Reload the bundle.")
      .mockResolvedValue();
    await openContext(user);

    screen.getByRole("link", { name: /Migration handoff/ }).focus();
    await user.keyboard("{Enter}");
    expect(openDocument).toHaveBeenCalledWith(bundle.root, sourceId, handoff);
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
    expect(screen.getByRole("heading", { name: "Project context", level: 1 })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(openDocument).toHaveBeenCalledTimes(2);
  });
});
