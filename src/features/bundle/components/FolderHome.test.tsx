import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useApp } from "@/shared/store.tsx";
import { MOCK_BUNDLE } from "@/mock/fixture.ts";
import { DEFAULT_SETTINGS, type Bundle, type IndexNode } from "@/shared/types.ts";
import { FolderHome } from "./FolderHome.tsx";

vi.mock("@/shared/store.tsx", () => ({ useApp: vi.fn() }));
const selectConcept = vi.fn();
const openLinkedDocument = vi.fn().mockResolvedValue(undefined);
const node: IndexNode = { dir: "", title: "Analytics", intro: "", synthesized: false, sections: [] };

function show(home: IndexNode, bundle: Bundle = MOCK_BUNDLE) {
  vi.mocked(useApp).mockReturnValue({
    state: { bundle, settings: DEFAULT_SETTINGS },
    actions: { selectConcept, openLinkedDocument },
  } as unknown as ReturnType<typeof useApp>);
  return render(<FolderHome node={home} />);
}

beforeEach(() => vi.clearAllMocks());

describe("index navigation diagnostics", () => {
  it("shows source-local warnings while keeping recognized entries clickable", async () => {
    const user = userEvent.setup();
    show({
      ...node,
      sections: [{ heading: "Docs", entries: [{ title: "Overview", target: "product/overview", kind: "concept", description: "Description" }] }],
    }, {
      ...MOCK_BUNDLE,
      issues: [
        { conceptId: null, level: "warning", message: "index.md:6: non-standard index separator ':'; entry remains navigable." },
        { conceptId: null, level: "warning", message: "elsewhere/index.md:3: unrelated warning" },
      ],
    });
    expect(screen.getByRole("status")).toHaveTextContent("Source files have not been changed");
    expect(screen.getByRole("status")).toHaveTextContent("index.md:6");
    expect(screen.queryByText(/unrelated warning/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Overview Description" }));
    expect(selectConcept).toHaveBeenCalledWith("product/overview");
  });

  it("does not call an unparseable populated folder empty", () => {
    show(node);
    expect(screen.getByText(/index has no navigable entries.*folder contains documents/)).toBeInTheDocument();
    expect(screen.queryByText("This folder holds no concepts.")).not.toBeInTheDocument();
  });

  it("counts descendants of a nested folder but not similarly named siblings", () => {
    show({ ...node, dir: "product" });
    expect(screen.getByText(/folder contains documents/)).toBeInTheDocument();
  });

  it("keeps genuinely empty folders distinct", () => {
    show({ ...node, dir: "product-empty" });
    expect(screen.getByText("This folder holds no concepts.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("folder home document links", () => {
  const href = "../../docs/migration/handoff.md";
  const localBundle: Bundle = {
    ...MOCK_BUNDLE,
    documentLinks: { index: [{ href, state: "available" }] },
  };

  it("routes an authored intro link through the native document opener", async () => {
    const user = userEvent.setup();
    show({ ...node, intro: `[Handoff](${href})` }, localBundle);
    await user.click(screen.getByRole("link", { name: /Handoff/ }));
    expect(openLinkedDocument).toHaveBeenCalledWith(localBundle.root, "index", href);
    expect(selectConcept).not.toHaveBeenCalled();
  });

  it("shows a native opener failure in the folder home", async () => {
    const user = userEvent.setup();
    openLinkedDocument.mockRejectedValueOnce("The document is no longer available.");
    show({ ...node, intro: `[Handoff](${href})` }, localBundle);
    await user.click(screen.getByRole("link", { name: /Handoff/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
  });

  it("prevents navigation when the reference is outside the opened folder", async () => {
    const user = userEvent.setup();
    show({ ...node, intro: `[Handoff](${href})` }, {
      ...localBundle,
      documentLinks: { index: [{ href, state: "outside-scope" }] },
    });
    await user.click(screen.getByRole("link", { name: /Handoff/ }));
    expect(openLinkedDocument).not.toHaveBeenCalled();
    expect(selectConcept).not.toHaveBeenCalled();
  });
});
