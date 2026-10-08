---
type: Feature
title: Knowledge Quizzes
description: Evidence-bound multiple-choice quizzes that assess accountable understanding of documented project knowledge.
tags:
- feature
- quiz
- assessment
- evidence
- accountability
generated:
  by: codex/gpt-6
  at: 2026-10-08T20:31:16Z
status: stable
verified:
- by: human:reviewer
  at: 2026-07-30T16:59:45.983395Z
- by: human:reviewer
  at: 2026-07-30T18:55:54.6076707Z
- by: human:reviewer
  at: 2026-07-30T18:57:16.3917790Z
---

# Review status

This concept materially expands the provider-independent quiz foundation into
the end-to-end feature. Its lifecycle and human-verification metadata record
review of the expanded requirements separately from the earlier foundation.

# Goal

Knowledge quizzes help users assess whether they understand documented project
knowledge sufficiently to be accountable for decisions. A quiz tests the
ability to apply important implementation decisions, architecture choices,
constraints, assumptions, trade-offs, failure modes, edge cases, and material
changes recorded in an active OKF bundle.

The quiz assesses understanding of what is documented. Passing does not prove
that the knowledge or decision is correct, complete, current, or suitable for a
formal certification. Questions whose answers are not defensible from the
reviewed evidence are omitted.

# Quiz scopes

Every quiz target is selected by the application and frozen before generation.
The provider cannot search the repository or add target evidence. A separate
frozen snapshot of the selected OKF bundle supplies read-only interpretive
context without changing which documents can support an answer.

## Current document

The current-document scope uses the concept open in the reader. Before
generation the user sees its title, bundle-relative path, concept type, and
current content hash.

## Selected documents

The selected-documents scope lets the user search concepts, filter by type and
tag, select all visible results, clear the selection, and review the estimated
evidence size. A selection contains at most 32 concepts and 1 MiB of Markdown.
The interface identifies the documents omitted by these limits and explains
that an oversized scope must be narrowed before generation.

## Topic within the bundle

The user enters a topic that is interpreted only against the active bundle.
Deterministic local retrieval considers title, description, type, tags,
headings, and body content. Directly linked concepts may be proposed when the
existing graph supplies an explicit connection.

The application shows every proposed concept and a bounded reason for its
selection. The user may add or remove concepts before freezing the scope. A
provider never decides the topic evidence set.

## Bundle changes

The bundle-diff scope compares a selected base Git commit with either the
current working-tree bundle or a safely supported head commit. It includes only
concept files under the active OKF root and ignores repository changes outside
that root.

The reviewed scope identifies added, removed, and modified concepts; base and
current content and hashes; semantic additions and removals; and the base and
head or working-tree revision. Questions focus on changes to meaning,
behaviour, decisions, assumptions, constraints, trade-offs, and failure modes.
Formatting-only changes are excluded where deterministic normalization can
establish that no meaningful content changed.

The mode is disabled with a clear explanation when Git is unavailable, the
bundle is not in a repository, the base commit is unavailable, the bundle did
not exist at that revision, or the selected comparison cannot be reproduced.

Nested bundles work when the Git root is above the folder opened in the app.
In that case—or when Git's ownership check blocks the repository—the app shows
the exact canonical repository path and asks for read-only inspection
permission. Approval is stored only in OKF Reviewer and passed to Git as an exact
per-command `safe.directory`; it never edits global or repository Git config.

## Reviewed since last commit

The reviewed-since-commit scope freezes current versions of documents whose
parsed `verified` metadata contains an exact human event—its `human:` actor and
`at` value—that is absent from the same document at `HEAD`. Pre-existing human
reviews combined with unrelated edits, machine verification, removed events,
and content-only changes do not qualify. A newly reviewed untracked concept
does qualify.

The configuration shows the captured short `HEAD` and has no revision picker.
Preparation rejects a changed `HEAD` and asks the user to refresh instead of
silently moving the baseline. Qualifying documents are ranked by added plus
deleted lines relative to `HEAD`, with bundle-relative path as the deterministic
tie-breaker. Selection is greedy within 32 documents, 256 KiB per document, and
1 MiB total. Confirmation names every omitted path and gives each selected
source its new-review reason and changed-line score. When no document qualifies,
or none fits, generation is blocked with guidance.

Only current Markdown is evidence in this mode. The frozen request, fingerprint,
preview, persistence, retries, and regeneration record the exact base commit
and `WORKTREE`.

## Bundle context

The application packages an `okf-consumer` skill that navigates root and nested
indexes, concepts, bundle-relative links, backlinks, tags, sources, and bundle
history. It distinguishes OKF 0.1 fallbacks from OKF 0.2 provenance, lifecycle,
verification, and freshness fields; retains ODSF and unknown extensions; and
handles candidate or newer compatible bundles without silently repairing them.

At preparation time Rust freezes the selected bundle's parsed concepts,
authored indexes, and `log.md` when present. Codex can use that snapshot to
understand the review target, but every answer, explanation, and exact quote
must remain defensible from the declared target sources. Context is bounded to
512 Markdown documents, 256 KiB per document, and 4 MiB total.

# Configuration and confirmation

The user chooses a scope, 5, 10, or 15 questions, a difficulty, and a provider
profile. Difficulty affects question style but never permits unsupported
content:

* **Foundational** tests direct comprehension.
* **Applied** tests scenarios and consequences.
* **Challenging** tests trade-offs, edge cases, and interacting assumptions.

Before content leaves the application, confirmation names the provider,
profile, model where known, target document count and bytes, bundle-context
document count and bytes, omitted documents, bundle revision, and whether the
selected content leaves the local machine. Confirmation freezes both target
and context. Generation cannot silently add a target source after it starts.

The reader's **Quick quiz** action is the deliberate one-click path. It freezes
the open concept as the target plus the selected bundle as context, then
immediately generates with the default provider, Medium length, Applied
difficulty, and a 20-question maximum. It does not open the configuration or
confirmation screens; all other generation entry points retain the reviewed
confirmation flow.

# Generation lifecycle

The visible lifecycle is `idle`, `preparing-scope`, `awaiting-confirmation`,
`generating`, `validating`, `ready`, `insufficient-evidence`,
`invalid-output`, `provider-error`, `cancelled`, or `stale`.

After a frozen request is handed to a provider, generation is owned by the
application shell rather than the Quizzes screen. The reader opens immediately
so the user can continue navigating the bundle. A persistent status-bar item
and badge on the Quizzes activity show that work is in progress and provide
cancellation. Completion, insufficient evidence, cancellation, and failure
raise an app-level notification; successful and failed notifications open the
active bundle's refreshed quiz history.

Generation supports cancellation and useful bounded errors for a missing CLI,
authentication requirement, unavailable provider, unsupported model, timeout,
malformed output, validation failure, stale bundle, and oversized scope. A
cancelled, failed, invalid, or stale generation never creates a current
playable quiz. A non-cancelled failure instead creates a clearly labelled,
non-playable history record with its bounded diagnostic, scope, generator, and
generation configuration. Retry prepares a new frozen snapshot from that saved
request and replaces the failure record only after a successful generation.

For Codex CLI, setup and generation check `codex login status`. A signed-out
user must sign in from their own terminal before generation can continue. OKF
Reviewer shows the exact resolved executable and version, copyable commands for
`codex login`, `codex login --device-auth`, and `codex login status`, and a link
to OpenAI's authentication instructions. The user explicitly selects **Check
again** after completing sign-in; OKF Reviewer never polls, opens a terminal or
browser, or handles credentials. A successful recheck resumes the unchanged
frozen quiz request. If authentication expires during generation, the same
prerequisite is shown and no failed quiz record is created.

For Claude Code CLI, setup and generation check `claude auth status`. A signed-out
user is offered a visible command window running `claude auth login`; Claude
opens its OAuth flow and the window remains available if an authorization code
must be pasted. Claude Code owns and reuses its locally stored credentials;
OKF Reviewer stores no Claude password or token. Model API authentication remains
provider-configured.

Codex CLI, Claude Code CLI, and configured model APIs all generate the same
application-owned artifact contract. Provider choice must not change scope
selection, validation, scoring, answer submission, stale detection, storage,
or bundle-write policy.

For Codex CLI, the isolated workspace contains the frozen bundle snapshot,
`quiz-request.json`, and project-local `$okf-consumer` and `$okf-quiz` skills.
The invocation prompt points Codex to those inputs and repeats no quiz-design
method beyond the target/context boundary. The quiz skill owns question quality,
difficulty handling, evidence quoting, insufficient-evidence behavior, and the
output structure.

# Quiz-taking experience

A playable quiz contains bounded multiple-choice questions with three to five
choices and exactly one declared correct choice. One question is shown at a
time with progress, category, criticality, prompt, selectable choices, and a
Submit answer action.

Correct choices are shuffled before their display IDs are assigned. Across a
multi-question quiz their positions must not all default to the first or any
other single slot, and larger quizzes distribute correct positions without a
predictable sequence.

Before submission, ordinary question-rendering state contains no answer key,
explanation, or evidence quote that would reveal the answer. Submission locks
the selected choice and deterministically returns whether it is correct, the
correct choice, explanation, and validated bundle evidence. Evidence opens the
resolved concept in the existing reader and navigates to its heading where
practical. Diff evidence distinguishes base from current knowledge.

Answering, reveal, navigation, scoring, result display, and retaking an existing
quiz make no provider or model calls.

# Results and history

Results show the overall score, number correct, critical questions correct and
incorrect, category results, incorrect answers, explanations, and source
concepts to revisit. If any critical question is incorrect, the result
prominently states that critical understanding gaps remain.

The Quizzes area lists the active bundle's quiz history with current or stale
state, scope, provider, latest result, retake, and deletion controls. Users may
delete one quiz and its attempts, an individual attempt, or all history for the
active bundle. The feature provides no audit-grade badge or accountability
approval.

# Storage and staleness

Quiz definitions and attempts are bounded application data stored outside the
opened bundle and project repository. Stored data is treated as untrusted when
loaded. It lives below the stable operating-system application-data directory,
not the replaceable installation directory, so reinstalling the same application
does not remove it. Playable quizzes, attempts, and failed-generation records
are retained for 30 days, then pruned on startup or the next quiz-store write.

A quiz stores schema, bundle and scope identities, source concept identities
and hashes, provider metadata, validated questions, answer key, explanations,
evidence, warnings, and timestamps. Attempts separately store selected answers,
correctness, completion state, overall result, and critical-question result.

A quiz becomes stale when an in-scope current source hash changes, a required
Git base or head can no longer be reproduced, or its schema version is no
longer supported. Historical reviewed-since-commit retries also fail clearly
when their captured base is unavailable or no longer the displayed `HEAD`. A
bundle fingerprint change alone does not make a quiz stale when every in-scope
source remains unchanged. Stale quizzes are clearly
historical: they may be viewed, completed, regenerated where possible, or
deleted, but are never presented as testing the current bundle.

# Privacy and accessibility

The feature adds no telemetry. It does not log complete bundle contents,
credentials, complete provider request bodies, or complete raw responses by
default. Diagnostics contain bounded metadata and redacted errors.

Generation, taking, results, history, and dialogs follow the existing design
system. Keyboard operation, focus management, screen-reader labels, and narrow
viewport layouts are required.

# Non-goals

This feature does not provide:

* writes to an opened bundle or quiz files in a project repository;
* source-code quizzes or evidence outside the OKF bundle;
* web research, free-text grading, or adaptive model follow-ups;
* automatic correction, lifecycle changes, human verification, or
  accountability approval;
* multiplayer quizzes, shared cloud history, or cloud sync;
* formal employee certification; or
* deterministic proof that a distractor is pedagogically strong or an
  explanation is the only possible interpretation of ambiguous prose.

The trust, provider, process, persistence, and answer-key boundaries are
defined by [Quiz Generation](../architecture/quiz-generation.md).
