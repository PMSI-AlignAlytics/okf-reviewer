# Update Log

## 2026-10-09

* **Release**: 0.11.0. Added automatic signed-release checks, manual checks in General settings, release notes, download progress, retry actions, and one-click update and restart. Updates use the current Windows MSI/NSIS or Linux AppImage/Debian installation format, verify the artifact and signed release version, save preferences before exit, and wait for quiz generation to finish. GitHub Actions builds and signs every package, verifies all signatures against the app public key, and uploads a complete installer-specific update feed before publishing a version-tagged release. Existing application and data identities are preserved; the first updater-enabled release must be installed manually.

## 2026-10-08

* **Release**: 0.10.1. Renamed the application and reference examples to OKF Reviewer and set the source, issue, and release links to PMSI-AlignAlytics/okf-reviewer. Preserved the application-data and versioned artifact identities, pinned the existing MSI upgrade code, and declared Debian package replacement. Documented the one-time migration for older NSIS installations. Removed the inherited contributing guide, moved current publication guidance into the README, and replaced the obsolete MVP plan with current architecture documentation. Removed stale Studio agent, graph, platform, version, and documentation references from the retained examples and comments. Historical attribution and existing verification events are preserved.

* **Release**: 0.10.0. Added independent interface enlargement, consistent search across workspaces, review-first filtering, accessible change comparisons, truthful settings save feedback, and confirmed reset scope. Quiz drafts and reader position survive workspace switches. Updated the application icon and established the application versioning policy.
* **Update**: Search results expose every matching concept with its path; Changed, Review, and Reviewed cues distinguish Git changes from human verification. Keyboard help, compact page outlines, visible review blockers, and retry actions make the existing workflows easier to operate. See [Review Workspace Usability](features/review-usability.md).

* **Security**: Updated rendering and transport dependencies, added real-library diagram regression coverage, and added secret and dependency checks to CI. Local credential and editor configuration files are excluded from tracked content. Published examples use generic names; the two quiz concepts retain their review events and timestamps under a pseudonymous reviewer identifier.

## 2026-10-07

* **Fix**: Existing local Markdown references outside the active OKF bundle, including reports in an enclosing repository, are no longer labelled broken when they fall within the opened folder. They open in the default app after native checks of the current authored link and folder grant. Paths outside that grant show an access-boundary cue; missing files still warn. Reserved `index.md` links open folder homes. Bundle content and review metadata remain unchanged.

## 2026-10-06

* **Fix**: Bundle navigation now includes unlisted folders and concept documents, including folders linked only from index prose and nested folders without indexes. Authored navigation order, labels, descriptions, prose, and warnings remain intact. Ignore rules and reserved filenames still apply, and no bundle files are rewritten. Regression coverage includes a prose-linked dataset folder, partial indexes, nested synthesized listings, ignore negations, and symlinks.

## 2026-09-24

* **Update**: Changed passages now show what changed instead of the whole previous source. Hovering or focusing one previews its word changes in a short box that never scrolls; clicking it, or pressing Enter on it, opens an *Earlier version* comparison in the document below the changed block, with word changes or the full previous text. Each replaced hunk is one keyboard tab stop. Added the draft [Change Comparison](features/change-comparison.md) concept. The Git diff, bundle files, and review metadata are unchanged.

## 2026-09-23

* **Update**: Human reviews now record the `content_sha256` of the Markdown body they approved. A review stays current while the body matches that hash, so body edits need review even when `generated.at` is not updated. Older reviews without a hash keep the timestamp rule.

## 2026-09-19

* **Fix**: Index navigation tolerates colon-separated descriptions while reporting the non-standard format. Unrecognized navigation entries are reported with source locations and retained as prose; fenced examples do not become navigation. Folder homes surface index warnings and distinguish an empty index from a folder containing documents. No bundle files or review metadata are rewritten.

## 2026-07-30

* **Release**: 0.9.1. Established the focused OKF Review MVP.
* **Update**: Removed repository-installed skills and their duplicate archive, the agent and provider stack, Git and remote-bundle tooling, general authoring and repair flows, graph visualizations, update infrastructure, benchmarks, and the obsolete marketing site.
* **Update**: Reduced the native command registry and frontend state boundary to local reads, reports, watching, reviewer settings, and the controlled human-review operation.
* **Update**: Replaced the inherited product documentation with the MVP boundary and the exact human-review operation.
* **Proposal**: Added draft requirements and architecture concepts for provider-independent, evidence-bound knowledge quiz generation. No quiz implementation or human verification was added.
* **Review**: Human reviewer `human:reviewer` approved the Knowledge Quizzes and Quiz Generation concepts through the controlled review operation.
* **Implementation**: Added the application-owned `okf-quiz` task and capability resources, canonical v1 schema, generated TypeScript artifact types, trusted Rust validation, fixtures, and model-free tests. Provider invocation, quiz UI, attempts, scoring, history, and Git diff selection remain deferred.
* **Proposal**: Expanded the Knowledge Quizzes and Quiz Generation concepts to cover provider profiles, Codex and Claude CLI execution, model APIs, reviewed current, selected, topic, and bundle-diff scopes, Rust-owned persistence, answer-key IPC, quiz-taking, results, history, scoped stale detection, cleanup, privacy, and accessibility. This materially revises the previously reviewed foundation, so both concepts returned to draft without a new human verification event and implementation stopped at the review gate.
* **Review**: Human reviewer `human:reviewer` approved the expanded end-to-end Knowledge Quizzes and Quiz Generation concepts through the controlled review operation.
* **Implementation**: Built the complete application-owned quiz flow around the approved capability: trusted current, selected, topic, and bundle-diff scope freezing; Codex CLI, Claude Code CLI, and OpenAI-compatible API adapters; isolated temporary workspaces; shared validation; bounded application-data persistence; answer-key IPC; deterministic quiz-taking, results, evidence navigation, history, scoped stale detection, regeneration, cancellation, and accessibility coverage. Opened OKF bundles remain read-only.
