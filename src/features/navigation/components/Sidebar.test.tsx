import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WithStore } from "@/mock/withStore.tsx";
import { MOCK_BUNDLE } from "@/mock/fixture.ts";
import * as ipc from "@/shared/ipc.ts";
import { useApp } from "@/shared/store.tsx";
import type { Bundle, Concept, IndexNode } from "@/shared/types.ts";
import { DEFAULT_SETTINGS } from "@/shared/types.ts";
import { Sidebar } from "./Sidebar.tsx";

function concept(overrides: Partial<Concept>): Concept {
  return {
    ...MOCK_BUNDLE.concepts[0],
    id: "guides/listed",
    type: "Guide",
    title: "Listed guide",
    description: "",
    tags: ["guide"],
    body: "needle",
    generated: null,
    verified: [],
    timestamp: "2026-07-01T00:00:00Z",
    status: "stable",
    statusExplicit: true,
    computation: null,
    extra: {},
    links: [],
    ...overrides,
  };
}

function index(dir: string, sections: IndexNode["sections"]): IndexNode {
  return { dir, title: dir || "Navigation fixture", intro: "", synthesized: false, sections };
}

const bundle: Bundle = {
  ...MOCK_BUNDLE,
  name: "Navigation fixture",
  concepts: [
    concept({}),
    concept({ id: "guides/deep/nested", title: "Reference", tags: ["finance"] }),
    concept({ id: "references/unlisted", title: "Reference", tags: ["finance"] }),
    concept({
      id: "guides/reviewed",
      title: "Reviewed guide",
      body: "Approved content",
      status: "draft",
      verified: [{ by: "human:reviewer", at: "2026-07-02T00:00:00Z" }],
    }),
    concept({ id: "archive/old", title: "Historical guide", status: "deprecated", body: "Historical content" }),
  ],
  indexes: [
    index("", [{ heading: "", entries: [
      { title: "guides/", target: "guides", kind: "directory", description: "" },
      { title: "archive/", target: "archive", kind: "directory", description: "" },
    ] }]),
    index("guides", [{ heading: "", entries: [
      { title: "Listed guide", target: "guides/listed", kind: "concept", description: "" },
      { title: "Reviewed guide", target: "guides/reviewed", kind: "concept", description: "" },
      { title: "deep/", target: "guides/deep", kind: "directory", description: "" },
    ] }]),
    index("guides/deep", [{ heading: "", entries: [
      { title: "Reference", target: "guides/deep/nested", kind: "concept", description: "" },
    ] }]),
    index("archive", [{ heading: "", entries: [
      { title: "Historical guide", target: "archive/old", kind: "concept", description: "" },
    ] }]),
  ],
};

function NavigationHarness() {
  const { state, actions } = useApp();
  return (
    <>
      <button onClick={() => actions.setLens("navigate")}>Navigate lens</button>
      <button onClick={() => actions.setLens("filter")}>Filter lens</button>
      <Sidebar />
      <output aria-label="Active concept">{state.activeConceptId}</output>
      <ul aria-label="Open test tabs">
        {state.tabs.map((tab) => <li key={tab.id}>{tab.conceptId}</li>)}
      </ul>
    </>
  );
}

async function renderNavigation(uiScale = 1) {
  vi.spyOn(ipc, "loadSettings").mockResolvedValue({ ...DEFAULT_SETTINGS, uiScale });
  vi.spyOn(ipc, "readBundle").mockResolvedValue(bundle);
  vi.spyOn(ipc, "readBundleGitStatus").mockResolvedValue({
    available: true,
    headRevision: "abcdef0123456789",
    comparisonMode: "working-tree",
    currentBranch: "main",
    defaultBranch: "main",
    baseRevision: "abcdef0123456789",
    modifiedConceptIds: ["guides/deep/nested", "guides/reviewed", "archive/old"],
    deletedPaths: [],
    trustRequired: false,
    repositoryRoot: bundle.root,
    message: null,
  });
  render(<WithStore withBundle><NavigationHarness /></WithStore>);
  await screen.findByRole("searchbox", { name: "Search and filter concepts" });
}

describe("sidebar matching concepts", () => {
  it.each(["Navigate lens", "Filter lens"])("opens collapsed and unlisted matches from %s", async (lens) => {
    const user = userEvent.setup();
    await renderNavigation();
    expect(screen.getByRole("treeitem", { name: /^guides\// })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /^Reference/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: lens }));
    await user.type(screen.getByRole("searchbox"), "needle");

    const matches = screen.getByRole("list", { name: "Matching concepts" });
    expect(within(matches).getAllByRole("button")).toHaveLength(3);
    expect(within(matches).getByRole("button", { name: "Reference guides/deep/nested.md" })).toBeInTheDocument();
    const unlisted = within(matches).getByRole("button", { name: "Reference references/unlisted.md" });
    await user.click(unlisted);
    expect(screen.getByLabelText("Active concept")).toHaveTextContent("references/unlisted");

    await user.click(screen.getByRole("button", { name: "Navigate lens" }));
    expect(screen.getByRole("tree", { name: "Navigation fixture index" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("list", { name: "Matching concepts" })).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: /^guides\// })).toBeInTheDocument();
  });

  it("opens background and foreground tabs through matching-result modifiers", async () => {
    await renderNavigation();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "needle" } });
    const matches = screen.getByRole("list", { name: "Matching concepts" });
    fireEvent.click(within(matches).getByRole("button", { name: "Reference guides/deep/nested.md" }), { ctrlKey: true });
    expect(screen.getByLabelText("Active concept")).toHaveTextContent("index");
    expect(screen.getByRole("list", { name: "Open test tabs" })).toHaveTextContent("guides/deep/nested");

    fireEvent.keyDown(within(matches).getByRole("button", { name: "Reference references/unlisted.md" }), {
      key: "Enter", metaKey: true, shiftKey: true,
    });
    expect(screen.getByLabelText("Active concept")).toHaveTextContent("references/unlisted");
    fireEvent(within(matches).getByRole("button", { name: "Listed guide guides/listed.md" }),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(screen.getByRole("list", { name: "Open test tabs" })).toHaveTextContent("guides/listed");
    expect(screen.getByLabelText("Active concept")).toHaveTextContent("references/unlisted");
  });

  it.each([
    { scale: 1, rowTop: 400, expectedScroll: 255 },
    { scale: 2, rowTop: 400, expectedScroll: 255 },
    { scale: 2, rowTop: 180, expectedScroll: 35 },
  ])("reveals a nested selection at $scale magnification without moving a visible row", async ({ scale, rowTop, expectedScroll }) => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("ui-scrollarea-viewport")) {
        return new DOMRect(0, 100 * scale, 280 * scale, 200 * scale);
      }
      if (this instanceof HTMLElement && this.dataset.rowKey?.endsWith(":guides/deep/nested")) {
        return new DOMRect(40 * scale, rowTop * scale, 200 * scale, 40 * scale);
      }
      return new DOMRect();
    });
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    await renderNavigation(scale);
    const viewport = screen.getByRole("tree").closest<HTMLElement>(".ui-scrollarea-viewport")!;
    viewport.scrollTop = 35;
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "needle" } });
    fireEvent.click(within(screen.getByRole("list", { name: "Matching concepts" }))
      .getByRole("button", { name: "Reference guides/deep/nested.md" }));

    await waitFor(() => expect(screen.getByRole("treeitem", { name: /^Reference/ })).toHaveAttribute("aria-current", "true"));
    expect(screen.getByRole("treeitem", { name: /^guides\// })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("treeitem", { name: /^deep\// })).toHaveAttribute("aria-expanded", "true");
    expect(viewport.scrollTop).toBe(expectedScroll);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps active facets visible and combines them without losing the other choices", async () => {
    const user = userEvent.setup();
    await renderNavigation();
    await user.click(screen.getByRole("button", { name: "Filter lens" }));
    expect(screen.getByRole("button", { name: "Lifecycle and review" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Types" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Tags" })).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: "Stable 3" }));
    await user.click(screen.getByRole("button", { name: "Unreviewed 4" }));
    await user.click(screen.getByRole("button", { name: "Tags" }));
    await user.click(screen.getByRole("button", { name: "#finance 2" }));
    await user.click(screen.getByRole("button", { name: "Tags #finance" }));
    expect(screen.getByRole("button", { name: "Clear tag filter: finance" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear lifecycle filter: stable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear human review filter: Unreviewed" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Matching concepts" })).getAllByRole("button")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Types" }));
    await user.click(screen.getByRole("button", { name: "Hide Guide" }));
    await user.click(screen.getByRole("button", { name: "Types 1 hidden" }));
    expect(screen.getByText("No concepts match. Clear or adjust the search and filters.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear type filters: Guide hidden" }));
    expect(within(screen.getByRole("list", { name: "Matching concepts" })).getAllByRole("button")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByLabelText("Active filters")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Types" }));
    expect(screen.getByRole("button", { name: "Hide Guide" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps Git changes separate from strictly human-review folder counts", async () => {
    const user = userEvent.setup();
    await renderNavigation();
    const guides = screen.getByRole("treeitem", { name: /^guides\// });
    expect(within(guides).getByText("Changed")).toBeInTheDocument();
    expect(within(guides).getByLabelText("2 concepts need human review")).toHaveTextContent("Review 2");
    const archive = screen.getByRole("treeitem", { name: /^archive\// });
    expect(within(archive).getByText("Changed")).toBeInTheDocument();
    expect(within(archive).queryByText(/Review/)).not.toBeInTheDocument();

    await user.click(guides);
    const reviewed = screen.getByRole("treeitem", { name: /^Reviewed guide/ });
    expect(within(reviewed).getByText("Changed")).toBeInTheDocument();
    expect(within(reviewed).getByText("Reviewed")).toBeInTheDocument();
    expect(within(reviewed).queryByText("Review", { exact: true })).not.toBeInTheDocument();
    await user.click(screen.getByRole("treeitem", { name: /^deep\// }));
    const pending = screen.getByRole("treeitem", { name: /^Reference/ });
    expect(within(pending).getByText("Changed")).toBeInTheDocument();
    expect(within(pending).getByText("Review", { exact: true })).toBeInTheDocument();
  });
});
