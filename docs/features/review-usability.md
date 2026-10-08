---
type: Feature
title: Review Workspace Usability
description: Search, review triage, interface enlargement, settings recovery, and workspace continuity.
tags:
  - feature
  - reader
  - accessibility
  - review
generated:
  by: codex/gpt-6
  at: 2026-10-08T18:34:35Z
status: draft
---

# Review Workspace Usability

The review workspace supports reading and human verification without changing
the application's bundle-write boundary. The controlled
[human review operation](../review-operation.md) retains its confirmation,
metadata preservation, and concurrent-change protections.

## Search and review triage

The toolbar search action, Ctrl/Cmd+K, and the slash shortcut open concept
search from the reader, a collapsed sidebar, or Quizzes. Search presents
actionable results with relative paths, including matches in collapsed or
unlisted locations. Existing query fields, facets, hierarchy, and tab-opening
gestures remain available.

Filtering presents lifecycle and human-review controls before the collapsible
Types and Tags groups. Active criteria can be removed individually or cleared
together, and matching concepts can be opened from either sidebar lens.
Changed indicates membership in the Git comparison batch; Review indicates
that human verification is needed; Reviewed identifies current verification.
Lifecycle status and human verification remain separate.

## Interface size and keyboard access

Settings offers interface sizes from 100% to 200%, independently of reader
text preferences. Compact layouts keep navigation, settings, quizzes, and
floating controls reachable. The sidebar divider reports its measured width,
and a compact On this page control preserves access to the document outline.

Settings search and reviewer identity fields show keyboard focus. Searchable
keyboard help is available in Settings. Dialogs contain focus, close with
Escape, and restore focus to their trigger. Concept breadcrumbs open folder
homes and retain the application's tab-opening gestures.

## Recovery and continuity

Settings reports saving, successful persistence, or a save error from the
actual persistence result. Failed saves retain entered values and offer retry.
Reset to defaults explains its global scope, including reviewer identity, and
requires confirmation.

Unavailable review actions show their reason beside the control. Failed
preflight checks offer retry without changing the existing review safeguards.

Switching between the reader and [Quizzes](quizzes.md) preserves reader scroll,
unfinished quiz configuration, and answers. Reader pacing and overlays pause
while Quizzes is active. Quiz scopes and provider modes retain their existing
capabilities; mode descriptions follow the selected configuration. Generation
prompt inspection and copying use a managed dialog.

Changed passages provide a named, expandable
[Compare changes](change-comparison.md) control in addition to their existing
hover previews and passage activation. Authored links and selectable prose
retain their own interactions.
