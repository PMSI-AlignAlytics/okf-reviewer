---
type: Guideline
title: Function first, edge to edge
description: Docked tool surfaces run edge-to-edge behind a hairline; radius and padding are reserved for things that float.
tags: [guidelines, layout, density, zed]
status: stable
generated: { by: codex/gpt-6, at: 2026-10-08T20:31:16Z }
sources:
  - id: zed
    resource: https://zed.dev
    title: zed.dev — the register this system builds from
  - id: dark-first
    resource: /guidelines/dark-first.md
    title: Dark-first, never flat black — the companion surface rule
---

# Rule
OKF Reviewer is a power tool. A surface that is **docked** — a composer at a panel's bottom, a shelf, a status strip, a header — runs edge-to-edge and is separated by a single 1px `colors.border` hairline. Do not float it in outer padding or wrap it in its own rounded, bordered box. Corner radius and enclosing borders are reserved for surfaces that **float**: popovers, menus, dialogs, and blocks that sit inside a scrolling document (a user message, a diff card).

# Why
This is Zed's design stance, and the reason its panels read as instruments instead of forms: the frame communicates structure (what is docked where), while boxes-within-boxes communicate nothing and cost width, height, and calm. Every wrapper around a docked surface adds two borders and two paddings between the user and the function. Intention goes to function first — beauty comes from alignment, rhythm, and restraint, not from enclosure.

# Do
- Dock the toolbar and status bar flush to the panel's edges; the hairline is the separator, and the surface shares the panel background.
- Show keyboard focus on an edge-to-edge editor by tinting its hairline (`colors.accent`), since there is no box for a focus ring to wrap.
- Keep inset padding *inside* the surface for its text and controls (align to the panel's gutter), and keep ancillary rows (chips, notices, errors) on that same gutter.
- Let resting states stay silent; spend color and weight on the exception (running, failed, staged).

# Don't
- Don't wrap a docked input in a rounded `border` + `radius.md` shell inside a padded panel — that is a web form, not a tool.
- Don't stack enclosures (a bordered box inside a padded region inside a bordered panel).
- Don't give a docked surface a different background from its panel just to mark its extent; the hairline already does.

# Applies to
The desktop app's toolbar, sidebar, and status bar use this rule. Reader
overlays and settings dialogs are floating surfaces and retain their own
boundaries.
