---
type: Architecture
title: OKF Reviewer Application Architecture
description: Current reader, human-review, read-only Git, and evidence-bound quiz boundaries.
tags:
  - review
  - architecture
generated:
  by: codex/gpt-6
  at: 2026-10-08T20:31:16Z
status: stable
---

# OKF Reviewer Application Architecture

## Application

OKF Reviewer is a local desktop reader for OKF v0.2 bundles. A reviewer can browse
and search concepts, inspect authored metadata, follow links and backlinks,
filter by lifecycle and review state, and view validation findings and bundle
history. The source and Windows/Linux releases are maintained in
[PMSI-AlignAlytics/okf-reviewer](https://github.com/PMSI-AlignAlytics/okf-reviewer).

Bundle navigation follows the full directory tree of readable concept documents.
Authored `index.md` sections keep their order, labels, descriptions, and prose;
unlisted immediate folders and concepts are appended to the navigation model.
Folders without indexes receive listings of their immediate folders and concepts.
Ignore rules and reserved filenames still apply, and directory symlinks are not
followed. Navigation synthesis never rewrites bundle files.

Markdown links distinguish bundle concepts, folder homes, and supporting local
Markdown documents. Links to reserved `index.md` files open their folder homes.
Supporting documents outside the bundle, such as repository migration reports,
open in the operating system's default app when they are within the folder
opened through the native picker. They do not become concepts, graph edges, or
human-review targets. Existing documents are excluded from broken-link warnings.

Paths beyond that folder grant are labelled outside the opened folder, with
guidance to open the containing folder. Their existence is not inferred or
checked outside the grant. Missing targets within the grant retain broken-link
warnings. Activation rechecks the current source's authored link, the native
grant, the canonical path, and the target's Markdown extension. Symlinks cannot
expand the grant, and file or opener failures appear in the current reader.

The only bundle mutation is the [Human Review Operation](../review-operation.md). It sets
one concept's `status` to `stable` and appends a `human:` verification event.
Lifecycle and verification remain separate concepts.

## Product boundary

The application provides:

* local folder selection and bounded bundle discovery;
* index navigation, tabs, reading history, search, and facets;
* sanitized Markdown, metadata, evidence, links, and local assets;
* read-only compatibility, profile, and interoperability reports;
* reviewer identity, appearance, and reader preferences;
* local filesystem watching and explicit bundle removal;
* read-only Git status, passage comparison, and bounded quiz evidence; and
* evidence-bound quiz generation, taking, results, history, and stale detection.

General agent chat, general editing, repair and export, Git-writing operations,
remote bundles, bundle creation, projections, and standalone graph views remain
outside the application. Model providers are used for the bounded quiz task.

## Reader extensions

The reader renders sanitized Markdown, highlighted code, math, and Mermaid
diagrams. ODSF-style concept extensions add token tables and swatches, schema
summaries, and HTML/CSS examples. HTML examples are displayed in script-free,
sandboxed frames; CSS examples are shown as source. The repository's
`design-system/` bundle contains reference examples for these capabilities.

Interface enlargement and reading preferences are independent. Search,
review-state filters, keyboard help, settings-save recovery, and continuity
across Reader and Quizzes are documented in
[Review Workspace Usability](../features/review-usability.md).

## Trust boundary

The React frontend requests typed operations. The native backend owns folder
grants, canonical path checks, bundle reads, file watching, and review writes.
No frontend code writes bundle files directly.
Local document opening also stays in the native backend; Git-only repository
trust does not grant access to documents outside the picked folder.

The command registry exposes bounded bundle reads, scoped document opening,
reports, watch controls, application logging, the review preflight/apply pair,
read-only Git operations, quiz configuration, generation, and history, and
signed application updates restricted to the main window. The backend uses the
compiled release endpoint and public key; the frontend cannot supply download
URLs, signing keys, or installer bytes.
Removing a bundle revokes the application grant when it is no longer used;
it never deletes user files.

## Git and quiz boundaries

Git operations inspect status, the earlier version of a changed passage,
semantic changes since a selected revision, and newly reviewed documents.
Ownership and enclosing-repository access require trust for the exact canonical
repository. Trust is app-local; each Git command receives its own exact-path
`safe.directory` setting. Global and repository Git configuration are preserved.

Quiz scope is selected by the application and frozen before a provider runs.
Codex CLI, Claude Code CLI, and configured OpenAI-compatible model APIs share
one artifact contract. The native backend validates every response against the
request, source hashes, and quoted evidence before storing a playable quiz.
Definitions and attempts are kept in application data; generation does not
write to the opened bundle. API credentials are held by the operating-system
credential store. See [Knowledge Quizzes](../features/quizzes.md) and
[Quiz Generation](quiz-generation.md).

## Review safety

The review writer:

1. resolves the concept below a canonical, user-granted bundle root;
2. validates the source, frontmatter, lifecycle, and verification records;
3. fingerprints the exact source shown at confirmation;
4. preserves the Markdown body and every unrelated frontmatter value;
5. writes and validates a same-directory transaction file;
6. checks the source fingerprint again immediately before replacement; and
7. refuses malformed input, ambiguous paths, symlinks, and concurrent changes.

Every metadata transformation has native tests.

## Validation and release identity

Changes are checked through:

* frontend type checking, linting, unit, component, integration, accessibility,
  and Storybook tests;
* theme, artifact, version, and OKF conformance checks;
* Rust formatting, linting, and tests for the core and native host;
* a production frontend build; and
* indexed-publication, secret, dependency, and renderer-security checks.

The display name is OKF Reviewer. The installed application identifier
`app.okfviewer.desktop`, native executable name `okf-viewer`, credential-service
identifiers, and versioned artifact identifiers retain their established values
so upgrades can reuse existing settings and data. The Windows MSI upgrade code
is pinned to the value derived from the former display name, OKF Review.
The Debian package declares replacement of `okf-review`. Existing Windows
NSIS installations require the one-time migration described in the README.

The application version comes from `package.json`; `pnpm version:set` synchronizes
the Rust manifests, lockfile, and reference examples. Release builds have
read-only GitHub permissions, and a separate publishing job uploads their
packages and the installer-specific update feed to a draft in this repository
before publishing. Both artifact signatures and their signed release versions
must verify against the app public key. Automatic checks run at startup and
every six hours; installation is explicit and preserves the established data
locations. Windows installer upgrades and native download verification are
covered by automated tests.
