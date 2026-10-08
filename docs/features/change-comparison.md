---
type: Feature
title: Change Comparison
description: How the reader previews and compares a changed passage with its earlier version from the read-only Git diff.
tags:
  - feature
  - reader
  - git
  - review
generated:
  by: codex/gpt-6
  at: 2026-10-08T18:34:35Z
status: draft
---

# Change Comparison

When a concept's Markdown differs from the Git comparison base, the reader
marks and underlines the current text of each changed hunk. A hunk that replaced earlier
text is a *changed passage*: the reader can preview what changed and compare it
with the earlier version where it stands. A pure addition has no earlier text
and has no earlier-version comparison.

The comparison is built from the same read-only Git diff as the explorer's
review markers. It never changes Git state or the bundle. It lets a reviewer see
exactly what changed before recording a
[human review](../review-operation.md).

## Word changes

Git reports whole lines, and a Markdown paragraph is usually a single line, so
a one-word edit arrives as two near-identical paragraphs. The reader compares
the words inside the hunk instead:

- removed words are struck through in the error ink, added words underlined in
  the accent ink, and each run is labelled "Removed" or "Added" for assistive
  technology;
- a run of edits reads as the removed words followed by the added words;
- words compare without their surrounding whitespace, so re-wrapping a
  hard-wrapped paragraph is not a change. A hunk whose words are unchanged says
  that only spacing or line breaks changed;
- Markdown syntax stays attached to its word, so a changed link target shows
  as the whole link replaced;
- a rewrite too large to align word by word is shown as the earlier text
  followed by the current text.

Both sides are Markdown source, not rendered output.

## Preview

Hovering a changed passage for 300 ms, or moving keyboard focus onto it, shows
a *What changed* preview beside it: the word changes with up to eight unchanged
words either side, the rest elided. It lists at most three changes, clamps each
to six lines, and never scrolls, because a preview is not a reading surface.
The pointer can move onto the preview without dismissing it. The preview ends
with the instruction to click or press Enter to compare in place.

No preview appears for a passage whose comparison is already open, or for focus
that arrives from a click.

## In-place comparison

Selecting its named *Compare changes* button, clicking a changed passage, or
pressing Enter or Space on its tab stop opens
an *Earlier version* panel in the document directly below the changed block:
after the paragraph or heading, inside a list item below its own text and
above any nested list, after a table, or after a code, math, callout or HTML
block. A long earlier version therefore scrolls with the page.

- The panel shows the word changes by default; *Previous text* shows the whole
  earlier source of the hunk.
- Several panels can be open at once. Panels below the same block stack in
  hunk order, and a concept with several replacements labels each panel
  "Change *n* of *m*".
- While its panel is open, the passage is underlined.
- Clicking the passage again, the panel's *Close* button, or Escape inside the
  panel closes it.
- A double-click, a text selection, and a click on a link or control inside
  the passage do not toggle a comparison; links keep their own navigation.

Each replaced hunk has a named comparison button announcing its expanded state
and the panel it controls. Its first passage also remains a keyboard tab stop, even when
the passage contains a link or a hard-wrapped paragraph renders the hunk as a
passage per line. Opening a comparison from the keyboard moves focus into the
panel; closing it returns focus to the passage. A pointer user's focus is not
moved into the panel.

Open comparisons belong to the concept and the current hunk ranges. Opening
another concept, or a file change that moves the hunks, closes them. They are
not persisted.

## Limits

- A deletion with no remaining current line is not marked, so it cannot be
  previewed or compared.
- Comparison is per hunk. The panel does not show unchanged text outside the
  hunk.
