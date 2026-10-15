---
type: Feature
title: Review Workspace Usability
description: Search, review triage, feature review batches, interface enlargement, settings recovery, and workspace continuity.
tags:
  - feature
  - reader
  - accessibility
  - review
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-15T13:34:35Z
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

## Feature review

When Git is available, the navigation lens opens with a Feature review panel.
On a feature branch it compares the bundle with the default branch's merge
base; otherwise it compares the working tree with `HEAD`. The changed concepts
form one review batch.

- *Compare with* replaces that automatic base with a recent commit in the
  branch's history, such as the approved specification commit, so a second
  review shows only what changed since approval. The choice is saved per bundle
  and branch in local settings. A saved commit that is no longer in the
  branch's history is not used; the panel says so and uses the automatic base.
- A changed concept is *outstanding* until its lifecycle is stable and a human
  review covers its current body: the rule the OKF review check applies to
  pull requests. The changed, reviewed, and outstanding counts each list their
  documents. Every entry says whether its wording changed or only its
  metadata, and why it is still outstanding.
- Removed documents and changed concepts that are now deprecated take no stamp,
  so they are listed separately for an impact check with the number of current
  documents linking to them. A deprecated concept opens in the reader; a
  removed one shows its last committed Markdown source, read-only.
- *Next outstanding* opens the next outstanding concept in bundle order. After
  a review is recorded, the reader reports how many changed documents still
  need review and offers the next one.
- Reviews present only in the working tree are flagged until they are
  committed, because a commit is what makes an approval durable in Git.
- When nothing is outstanding, *Copy review record* copies a Markdown record:
  the comparison base (and the automatic base when a commit was selected),
  `HEAD`, whether bundle documents differ from `HEAD`, each concept's body
  SHA-256, lifecycle, and current review, and the removed and deprecated
  documents with what links to them. Copying approves nothing.

The panel, the reader, and the review confirmation share one definition of the
batch. None of them writes to Git or to the bundle. The review gate's decision
table is kept in `src/features/review/review-gate-cases.json` so the analytics
starter pack's validator can assert the same cases.

## Reviewing a changed concept

- A concept whose frontmatter changed but whose body did not says that only
  metadata changed, so a reviewer does not look for missing underlines.
- When the wording changed, the reader names the unchanged concepts that link
  to it: their text is the same, but their meaning may not be. A changed
  deprecated concept names every concept that links to it.
- While a concept is outstanding review work, speed reading leaves the reader
  header so the review action is not presented beside a skimming control. It
  remains available from Reading preferences and its keyboard shortcut.
- *Give feedback* is the counterpart to the review action. It copies the
  concept path, the body SHA-256 read, an optional selected passage, and the
  reviewer's note for whoever authored the concept, asking for a revision
  without a stamp. It never writes to the bundle and adds no workflow state.
- The [human review operation](../review-operation.md) confirmation states what
  a review approves, and an unchanged approval by the same reviewer is
  acknowledged rather than stamped again.
- A concept with an optional `implementation` pointer to a recorded check shows
  an *Implementation evidence* card: whether the check covered the current
  body hash or an earlier wording, when and by whom it was recorded, the
  checked code, and the evidence record. An HTTPS record, such as the pull
  request, opens in the browser; a record that is a concept in the bundle opens
  in the reader. A local Markdown delivery record outside the bundle, such as
  one under `knowledge/delivery/`, opens in the default app when it is inside
  the opened folder, under the same native checks as a linked document. A
  record outside the opened folder, missing, or not Markdown is named with a
  reason and its path can be copied. The card offers no acceptance action: a
  recorded check is not implementation acceptance. A pointer that does not match the expected
  shape lists its problems and stays visible under Concept metadata.

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
