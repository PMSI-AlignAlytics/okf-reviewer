// The top chrome bar: Open Folder, back/forward history, the current bundle
// name with bundle-level actions, and the right-side cluster (layout switch ·
// window controls). App-level actions (Settings, shortcuts) live in the
// [ActivityBar]; reading prefs ("Aa") live with content in the [Reader].
// See docs/ux/browsing-layout.md.

import { useRef } from "react";
import type { MouseEvent } from "react";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import { Toolbar } from "@base-ui/react/toolbar";
import { Tooltip } from "@base-ui/react/tooltip";
import { useApp } from "@/shared/store.tsx";
import { isMac } from "@/shared/platform/platform.ts";
import { startWindowDrag, toggleMaximizeWindow } from "@/shared/platform/window.ts";
import { BundleSwitcher } from "@/features/bundle/components/BundleSwitcher.tsx";
import { WindowControls } from "@/features/shell/components/WindowControls.tsx";
import "@/shared/styles/chrome.css";
import "@/shared/styles/baseui.css";
import "./TopBar.css";

// Mac shows ⌘K; everything else shows Ctrl K.
const searchHint = isMac ? "⌘K" : "Ctrl K";
export function TopBar() {
  const { state, actions } = useApp();

  // Custom title-bar dragging, driven manually rather than via
  // data-tauri-drag-region: the built-in double-click "restore" leaves a
  // borderless window at its maximized size (tauri-apps/tauri#11945). We use the
  // JS window API (which resizes correctly) and a move-threshold so a
  // double-click (maximize/restore) and a drag never race.
  const dragArmed = useRef(false);

  function onBarMouseDown(e: MouseEvent<HTMLElement>) {
    if (e.button !== 0) return;
    // Only the bar's own background is a drag handle — never a child control.
    if (!(e.target as HTMLElement).matches(".topbar, .topbar-spacer")) return;
    if (e.detail === 2) {
      dragArmed.current = false;
      void toggleMaximizeWindow();
    } else {
      dragArmed.current = true; // start the OS move on first motion, not on press
    }
  }
  function onBarMouseMove(e: MouseEvent<HTMLElement>) {
    if (dragArmed.current && e.buttons === 1) {
      dragArmed.current = false;
      void startWindowDrag();
    }
  }
  function onBarMouseUp() {
    dragArmed.current = false;
  }

  const canBack = state.back.length > 0;
  const canForward = state.fwd.length > 0;

  return (
    <Tooltip.Provider delay={400}>
      <Toolbar.Root
        render={
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Toolbar.Root injects role="toolbar"; handlers implement window dragging (no keyboard equivalent exists)
          <div
            className="topbar"
            onMouseDown={onBarMouseDown}
            onMouseMove={onBarMouseMove}
            onMouseUp={onBarMouseUp}
          />
        }
      >
        <div className="topbar-left">
          <BundleSwitcher />
        </div>

        {/* Window-centered command center: back/forward immediately left of the
            search, in the spirit of VS Code's command center. */}
        <div className="topbar-center">
          <Toolbar.Group className="topbar-nav">
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Toolbar.Button
                    className="btn ghost icon"
                    aria-label="Go back"
                    disabled={!canBack}
                    onClick={() => actions.back()}
                  >
                    <ArrowLeft size={17} aria-hidden="true" />
                  </Toolbar.Button>
                }
              />
              <Tooltip.Portal>
                <Tooltip.Positioner className="ui-tooltip-positioner" sideOffset={6}>
                  <Tooltip.Popup className="ui-tooltip">Back</Tooltip.Popup>
                </Tooltip.Positioner>
              </Tooltip.Portal>
            </Tooltip.Root>

            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Toolbar.Button
                    className="btn ghost icon"
                    aria-label="Go forward"
                    disabled={!canForward}
                    onClick={() => actions.forward()}
                  >
                    <ArrowRight size={17} aria-hidden="true" />
                  </Toolbar.Button>
                }
              />
              <Tooltip.Portal>
                <Tooltip.Positioner className="ui-tooltip-positioner" sideOffset={6}>
                  <Tooltip.Popup className="ui-tooltip">Forward</Tooltip.Popup>
                </Tooltip.Positioner>
              </Tooltip.Portal>
            </Tooltip.Root>
          </Toolbar.Group>

          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Toolbar.Button
                  id="topbar-search"
                  className="topbar-search"
                  aria-label="Search concepts"
                  aria-keyshortcuts="Control+K Meta+K"
                  disabled={!state.bundle}
                  onClick={() => actions.focusConceptSearch()}
                >
                  <Search className="topbar-search-icon" size={15} aria-hidden="true" />
                  <span className="topbar-search-label">Search…</span>
                  <kbd className="kbd topbar-search-kbd" aria-hidden="true">
                    {searchHint}
                  </kbd>
                </Toolbar.Button>
              }
            />
            <Tooltip.Portal>
              <Tooltip.Positioner className="ui-tooltip-positioner" sideOffset={6}>
                <Tooltip.Popup className="ui-tooltip">
                  Search concepts ({searchHint} or /)
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        </div>

        <div className="topbar-right">
          <WindowControls />
        </div>
      </Toolbar.Root>
    </Tooltip.Provider>
  );
}
