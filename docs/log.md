# Update Log

## 2026-10-15

* **Release**: 0.12.1. Aligned the Tauri opener and store JavaScript packages (2.7 and 2.5) with their Rust plugins, which earlier dependency maintenance had updated alone. `tauri build` refuses mismatched major or minor versions, so the 0.12.0 release build stopped before packaging and 0.12.0 was not published; 0.12.1 carries all of its changes. CI now runs `pnpm check:tauri-versions`, which applies the same rule to the installed npm packages and Cargo.lock.

* **Release**: 0.12.0. Made the Feature review panel a work queue for the human review gate. A *Compare with* choice, saved per bundle and branch, compares the batch with the automatic base or a commit in the branch's history such as the approved specification; Git status refuses a saved commit outside that history and falls back with a notice. *Outstanding* follows the OKF review check (stable lifecycle and a human review of the current body), with a shared decision table for the starter pack's validator. The changed, reviewed, and outstanding counts list their documents with wording or metadata-only changes and the reason each is outstanding; *Next outstanding* opens the next one, and the reader reports remaining work after each stamp. Removed documents and changed deprecated concepts are listed for an impact check with their linking documents, and a removed document's last committed source can be read. Reviews not yet committed to `HEAD` are flagged, and once nothing is outstanding a Markdown review record with bases, `HEAD`, commit state, body hashes, lifecycles, current reviews, and removed or deprecated documents can be copied. The review confirmation states that a review approves the body's wording only and shows its hash and changes; an unchanged approval by the same reviewer is acknowledged instead of stamped again, and the native writer refuses the duplicate. The reader names documents linking to changed wording or a deprecated concept, keeps speed reading out of the header for outstanding work, adds *Give feedback* to copy a revision request without changing the bundle, and shows a read-only *Implementation evidence* card for the optional `implementation` pointer; a local Markdown delivery record it names opens under the same native checks as linked documents. AGENTS.md now states the established scope. Updated quinn-proto to 0.11.19 and rustls to 0.23.46 for RUSTSEC-2026-0338 to 0342 and 0346 to 0349, and recorded a time-bounded maintenance notice for unsafe-libyaml 0.2.11 (RUSTSEC-2024-0449), the unmaintained YAML backend of serde_yaml_ng, pending a separately reviewed migration. Browser-preview reviews refresh the panel, and a slow Markdown stress test has a longer timeout. See [Review Workspace Usability](features/review-usability.md) and [Human Review Operation](review-operation.md).

## 2026-10-09

* **Release**: 0.11.3. Updated the native Tauri store and window-state plugins, keyring, Tokio, Serde, and serde_json after compatibility review. The maintenance batch includes keyring initialization and Windows process cleanup fixes, retains the existing dependency features, and was validated together across the current review and persistence workflows.

* **Release**: 0.11.2. Aligned the Storybook core, React framework, and Vitest addon at 10.6.1, retaining the test runner startup timeout patch and regenerating its pnpm 10 lock metadata. Pinned pnpm consistently for dependency updates, CI, and tagged release builds, with a fallback for older tags. Grouped related Dependabot updates and deferred incompatible routine major upgrades to planned migrations while retaining minor, patch, and security updates.

* **Release**: 0.11.1. Updated regex, UUID, and the native Tauri opener and dialog dependencies after compatibility review. The dependency maintenance batch retains the current review workflow, signed updater configuration, application identity, and data locations.

* **Fix**: Repeat release workflows verify the existing public installers, signatures, source commit, and update feed, then finish successfully while preserving the published assets. Manual runs can use the current workflow with an existing tag's original source. This changes release automation only; the application remains at 0.11.0.

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
