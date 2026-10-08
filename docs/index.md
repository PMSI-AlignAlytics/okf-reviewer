---
okf_version: "0.2"
---

# OKF Reviewer

OKF Reviewer is a focused desktop reader for local Open Knowledge Format bundles.
It supports one controlled mutation: a named human reviewer may set the open
concept's lifecycle status to `stable` and append a human verification event.

The application preserves unknown OKF fields, keeps filesystem writes in the
trusted native backend, and refuses to overwrite concurrent external changes.
It does not provide agents, general authoring, Git-writing or repository
management, remote bundles, bundle creation, repair, export, or additional
workflow states. Its Git access is fixed and read-only: explorer status, the
reader's change comparison, and bounded quiz evidence inspection. Enclosing repositories that are outside the
opened bundle folder or rejected by Git ownership checks require confirmation
of the exact path; trust stays app-local and never changes Git configuration.

# Application

* [Application Architecture](architecture/application.md) - Current reader, review, Git, quiz, and release boundaries.
* [Human Review Operation](review-operation.md) - Exact transformation, safeguards, and recovery behavior.

# Reader

* [Change Comparison](features/change-comparison.md) - How the reader previews and compares a changed passage with its earlier version from the read-only Git diff.
* [Review Workspace Usability](features/review-usability.md) - Search, review triage, interface enlargement, settings recovery, and workspace continuity.

# Quiz feature

* [Knowledge Quizzes](features/quizzes.md) - End-to-end quiz generation, taking, results, history, and staleness requirements.
* [Quiz Generation](architecture/quiz-generation.md) - Provider, process, persistence, Git, validation, and answer-key architecture.
