import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type * as React from "react";
import { useApp, paneClamp } from "@/shared/store.tsx";
import { useGlobalKeys } from "@/keys.ts";
import { TopBar } from "@/features/shell/components/TopBar.tsx";
import { ActivityBar } from "@/features/shell/components/ActivityBar.tsx";
import { StatusBar } from "@/features/shell/components/StatusBar.tsx";
import { Sidebar } from "@/features/navigation/components/Sidebar.tsx";
import { Reader } from "@/features/reader/components/Reader.tsx";
import { TabStrip } from "@/features/shell/components/TabStrip.tsx";
import { ValidationPanel } from "@/features/shell/components/ValidationPanel.tsx";
import { LogView } from "@/features/shell/components/LogView.tsx";
import { Settings } from "@/features/shell/components/Settings.tsx";
import { EmptyState } from "@/features/shell/components/EmptyState.tsx";
import { ResizeHandles } from "@/features/shell/components/ResizeHandles.tsx";
import { QuizzesArea } from "@/features/quiz/components/QuizzesArea.tsx";
import { QuizGenerationNotice } from "@/features/quiz/components/QuizGenerationNotice.tsx";
import { QuizAuthenticationDialog } from "@/features/quiz/components/QuizAuthenticationDialog.tsx";
import { RepositoryTrustDialog } from "@/features/git/components/RepositoryTrustDialog.tsx";
import { showWindowWhenPainted } from "@/shared/platform/window.ts";
import { interfaceScale } from "@/shared/uiScale.ts";
import { AppUpdates } from "@/features/updates/AppUpdates.tsx";

export function App() {
  const { state } = useApp();
  const focusedSearchRequest = useRef(0);
  useGlobalKeys();

  useEffect(() => {
    if (!state.searchFocusRequest || !state.bundle
      || focusedSearchRequest.current === state.searchFocusRequest) return;
    focusedSearchRequest.current = state.searchFocusRequest;
    document.querySelector<HTMLInputElement>("[data-search]")?.focus();
  }, [state.searchFocusRequest, state.bundle]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const scale = interfaceScale(state.settings.uiScale);
    root.style.setProperty("--ui-scale", String(scale));
    root.style.zoom = String(scale);
    const resize = () => {
      root.dataset.compactUi = String(window.innerWidth / scale <= 720);
      root.dataset.compactHeight = String(window.innerHeight / scale <= 300);
    };
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      root.style.removeProperty("zoom");
      root.style.removeProperty("--ui-scale");
      delete root.dataset.compactUi;
      delete root.dataset.compactHeight;
    };
  }, [state.settings.uiScale]);

  // Reveal the hidden OS window on the first painted frame. Created visible,
  // the transparent borderless shell sits on screen as an empty rectangle for
  // the whole webview boot; created hidden, the app pops in fully drawn.
  // Double rAF so the reveal lands after the first frame has actually
  // painted; harmless if repeated (StrictMode re-mounts, pop-out windows).
  useEffect(() => {
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => void showWindowWhenPainted());
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="app" data-maximized={state.maximized || undefined}>
      <TopBar />
      <AppUpdates />
      <div className="app-main">
        <ActivityBar />
        {state.bundle ? <Workspace /> : <EmptyState />}
      </div>
      <StatusBar />
      <QuizGenerationNotice />
      <QuizAuthenticationDialog />
      <RepositoryTrustDialog />

      {/* Base UI Dialogs: mounted whenever a bundle is open; their `open` prop
          (from store state) drives visibility, so they manage their own
          focus/Escape/transitions. */}
      {state.bundle && (
        <>
          <LogView />
          <ValidationPanel />
        </>
      )}
      {/* Local preferences are available before a bundle is opened. */}
      <Settings />

      {/* Borderless-window resize handles (Tauri only). */}
      <ResizeHandles />
    </div>
  );
}

/** The fixed reviewer workspace: optional hierarchy beside the concept reader. */
function Workspace() {
  const { state, actions } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const quizzesVisible = state.workspaceArea === "quizzes";

  const showSidebar = state.panels.sidebar;
  const focusedSidebarWidth = state.paneSizes.sidebar !== null
    ? `${state.paneSizes.sidebar}px`
    : "var(--sidebar-default)";

  return (
    <>
    <div
      ref={ref}
      className="workspace"
      data-layout="review"
      hidden={quizzesVisible}
      style={
        {
          gridTemplateColumns: showSidebar
            ? "minmax(180px, var(--pane-sidebar)) var(--divider-w) minmax(0, 1fr)"
            : "minmax(0, 1fr)",
          "--pane-sidebar": focusedSidebarWidth,
        } as React.CSSProperties
      }
    >
      {showSidebar ? (
        <>
          <aside className="pane sidebar">
            <button
              type="button"
              className="compact-sidebar-close btn ghost"
              onClick={() => actions.togglePanel("sidebar", false)}
            >
              <X size={14} aria-hidden="true" /> Close navigation
            </button>
            <Sidebar />
          </aside>
          <Divider pane="sidebar" gridRef={ref} />
        </>
      ) : null}
      <section className="pane reader">
        <TabStrip />
        <Reader />
      </section>
    </div>
    {/* Keep drafts and attempts mounted when searching or reading. Reset them
        only when the active bundle changes. Hidden workspaces cannot take focus. */}
    <div className="workspace" data-layout="quizzes" hidden={!quizzesVisible}>
      <QuizzesArea key={state.activeRoot} />
    </div>
    </>
  );
}

/**
 * A keyboard-operable, draggable column divider.
 *
 * - `pane` is the track it resizes (`sidebar` measured from its left edge, or
 *   `reader` measured from the grid's right edge).
 * - Drag with the pointer, or focus and use arrow keys. Double-click (or
 *   Home/End) resets the track to its CSS default.
 */
function Divider({
  pane,
  gridRef,
}: {
  pane: "sidebar" | "reader";
  gridRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { state, actions } = useApp();
  const clamp = paneClamp(pane);
  const [measuredWidth, setMeasuredWidth] = useState(pane === "sidebar" ? 280 : 360);
  useEffect(() => {
    const element = gridRef.current?.querySelector<HTMLElement>(
      pane === "sidebar" ? ".sidebar" : ".reader",
    );
    if (!element) return;
    const measure = () => {
      if (element.offsetWidth) setMeasuredWidth(Math.round(element.offsetWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [gridRef, pane, state.workspaceArea]);
  const valueNow = measuredWidth;

  function current(): number {
    const stored = state.paneSizes[pane];
    if (stored !== null) return stored;
    // Default state: read the rendered track width so the first drag continues
    // smoothly from wherever the default put it.
    const grid = gridRef.current;
    const sel = pane === "sidebar" ? ".sidebar" : ".reader";
    const el = grid?.querySelector(sel) as HTMLElement | null;
    const width = el?.offsetWidth;
    if (width === undefined || width === 0) return measuredWidth;
    return width;
  }

  function widthFromPointer(clientX: number): number {
    const grid = gridRef.current;
    if (!grid) return current();
    const rect = grid.getBoundingClientRect();
    const scale = interfaceScale(state.settings.uiScale);
    // sidebar grows to the right; reader grows to the left.
    return pane === "sidebar"
      ? (clientX - rect.left) / scale
      : (rect.right - clientX) / scale;
  }

  // Teardown for an in-flight drag, so window listeners can't outlive the
  // divider if it unmounts mid-drag (a layout-mode change removing the track).
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // Suppress the column-track transition during the drag so it tracks the
    // pointer 1:1 (the transition is only wanted for mode changes).
    gridRef.current?.classList.add("dragging");
    // Drag imperatively: write the pane's CSS variable on each move instead of
    // dispatching to the store, so the whole app doesn't re-render 60×/s. Commit
    // the final width to the store once on release (persist + a single render).
    let latest: number | null = null;
    const move = (ev: PointerEvent) => {
      const w = Math.min(clamp.max, Math.max(clamp.min, widthFromPointer(ev.clientX)));
      latest = w;
      gridRef.current?.style.setProperty(`--pane-${pane}`, `${w}px`);
    };
    const up = () => {
      gridRef.current?.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragCleanupRef.current = null;
      if (latest !== null) actions.setPaneSize(pane, latest);
    };
    dragCleanupRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 48 : 16;
    // Arrow direction maps to "wider" depending on which side the pane sits.
    const grow = pane === "sidebar" ? "ArrowRight" : "ArrowLeft";
    const shrink = pane === "sidebar" ? "ArrowLeft" : "ArrowRight";
    if (e.key === grow) {
      e.preventDefault();
      actions.setPaneSize(pane, current() + step);
    } else if (e.key === shrink) {
      e.preventDefault();
      actions.setPaneSize(pane, current() - step);
    } else if (e.key === "Home" || e.key === "End" || e.key === "Enter") {
      e.preventDefault();
      actions.setPaneSize(pane, null); // reset to default
    }
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a focusable window-splitter separator is interactive (WAI-ARIA APG)
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={
        pane === "sidebar" ? "Resize sidebar" : "Resize reader"
      }
      aria-valuemin={clamp.min}
      aria-valuemax={clamp.max}
      aria-valuenow={valueNow}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => actions.setPaneSize(pane, null)}
      onKeyDown={onKeyDown}
    />
  );
}
