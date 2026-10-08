# OKF Reviewer

OKF Reviewer is a desktop browser for local [Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundles. It provides reading, navigation, evidence-bound quizzes, and one controlled write operation: a named human reviewer can mark an individual concept stable and append a human verification record.

Source, issues, and Windows/Linux downloads are maintained in
[PMSI-AlignAlytics/okf-reviewer](https://github.com/PMSI-AlignAlytics/okf-reviewer).
Installers are attached to [GitHub Releases](https://github.com/PMSI-AlignAlytics/okf-reviewer/releases).

Bundles remain ordinary Markdown files with YAML frontmatter on disk. Reading
and human review require no application account, and the application has no
telemetry. Optional quiz providers handle their own authentication. Opening,
switching, and removing a bundle registration never deletes bundle files.

## Capabilities

- Register a local folder, detect one or more OKF bundles, reopen recent bundles, switch between them, and remove an app registration without deleting files.
- Browse the full bundle document tree, preserving `index.md` grouping and adding unlisted folders and concepts, with persistent concept selection, back/forward history, internal links, backlinks, and an in-page outline.
- Search title, description, type, tags, identifier, and Markdown body.
- Filter by type, tag, lifecycle, and human-review state.
- See amber `Review` markers for outstanding human review and blue `Review`
  markers for concept Markdown modified relative to `HEAD`; folder review
  counts remain strictly human-review work.
- Hover or focus a changed passage to preview its word changes, and click it
  or press Enter to compare it with the earlier version in place.
- Render sanitized Markdown, tables, local images, syntax-highlighted code, footnotes, metadata, and unknown frontmatter fields.
- Follow local Markdown references outside the active bundle in the default app when they are inside the opened folder; distinguish missing files from paths outside that folder's access scope.
- Reload when bundle files change on disk while retaining the current selection when it still exists.
- Persist a reviewer ID plus optional local display name and email.
- Confirm the exact concept, path, lifecycle change, actor, and timestamp before recording a review.
- Generate evidence-bound quizzes from the current concept, a reviewed document
  selection, a locally retrieved topic, semantic bundle changes since a Git
  revision, or current documents newly human-reviewed since `HEAD`.
- Generate through Codex CLI, Claude Code CLI, or a configured
  OpenAI-compatible model API, with one provider-neutral artifact contract and
  trusted native validation.
- Take and retake quizzes without further model calls, reveal explanations and
  resolved bundle evidence only after submission, review attempts and results,
  and distinguish stale quizzes from current ones.

General agent chat, repository-wide Git management, graph visualizations,
remote bundles, bundle creation, recipient projections, and general-purpose
authoring are intentionally outside this interface. Git access is limited to
read-only bundle status, diff evidence, and reviewed-since-commit evidence; the
application never stages, commits, checks out, or otherwise changes Git state.
When Git rejects an enclosing repository because of ownership, or the bundle
folder was opened below the repository root, OKF Reviewer asks once before saving
an app-local permission for that exact canonical repository. Each Git read uses
the exact path as a per-command `safe.directory`; global and repository Git
configuration are never changed.

## Knowledge quizzes

The application owns the provider-independent `okf-quiz` task, generation
skill, bounded `okf-quiz-v1` JSON Schema, frozen evidence packet, scoring, stale
detection, and local retention policy. The active OKF bundle remains read-only.
CLI providers run statelessly in an application cache workspace containing only
the frozen packet and packaged quiz resources. Model API credentials stay in
the operating-system credential store.

Raw provider output is untrusted. The Rust validator binds it to the exact
application-generated request, scope and bundle fingerprints; rechecks source
hashes and evidence quotes; rejects unknown or malformed fields; and stores
only playable `ready` artifacts. Quiz definitions and attempts live in
application data, never in the opened bundle or project repository.

## Human review semantics

Lifecycle and review are separate:

- an absent `status` is the OKF v0.2 implicit `stable` lifecycle;
- a human review is present only when `verified` contains an actor beginning with `human:`;
- machine or generator verification does not count as human review.

A confirmed action writes `status: stable` and appends:

```yaml
verified:
  - by: human:<reviewer-id>
    at: <RFC-3339 timestamp>
    content_sha256: <SHA-256 of the Markdown body>
```

A review stays current while the body still matches its `content_sha256`;
editing the body makes the concept need review again, even if `generated.at`
is not updated. Reviews recorded without a hash fall back to comparing
timestamps. See [Review operation](docs/review-operation.md#when-a-review-is-current).

The writer refuses malformed frontmatter or `verified` values, deprecated concepts, unsafe paths, and concurrent edits. It validates a same-directory temporary file before atomically replacing the source. Parsed unknown fields, generated metadata, and Markdown body bytes are preserved; YAML presentation such as comments or scalar style may normalize.

See [Review operation](docs/review-operation.md) for the reviewer workflow, failure behavior, and recovery guidance, and [Application architecture](docs/architecture/application.md) for the current application boundaries.

## Develop and run

Prerequisites:

- stable Rust with the host platform's native build tools;
- Node.js 20.19+ or 22.12+;
- pnpm 10.

On Windows, install WebView2 and the MSVC build tools. Linux additionally needs the Tauri WebKitGTK/GTK development packages.

```bash
pnpm install
pnpm dev
pnpm tauri dev
```

Run the verification gate:

```bash
pnpm lint
pnpm typecheck
pnpm check:theme
pnpm check:quiz-schema
pnpm check:version
pnpm check:publication
pnpm test
pnpm test:integration
pnpm build
cargo fmt --all -- --check
cargo clippy -p okf-core --all-targets -- -D warnings
cargo test -p okf-core
cargo clippy -p okf-viewer --all-targets -- -D warnings
cargo test -p okf-viewer --no-fail-fast
node scripts/okf-validate.mjs docs
node scripts/okf-validate.mjs design-system
pnpm tauri build
```

On Linux, Tauri's `.deb` is unreadable by dpkg when the building account's UID
exceeds 999999, because the UID overflows a fixed-width archive header field.
`pnpm repack:deb` rebuilds the package from Tauri's staging tree as
`target/release/bundle/deb/<package>_<version>_<arch>.deb`.

The integration lane covers local bundle browsing, filtering, registration
removal, accessibility, the controlled review write, and deterministic quiz
generation, answer reveal, scoring, history, and stale-state presentation.

## Releases and publication

The release workflow builds Windows NSIS/MSI installers and Linux `.deb` and
AppImage packages. Build jobs run with read-only permissions; a separate job
uploads all installers after the builds succeed. Workflow actions are pinned
to commit SHAs, and Dependabot proposes dependency and action updates.

For a clean public copy, stage the intended snapshot and run
`pnpm check:publication`. This checks indexed files for local credentials,
machine-specific configuration, build artifacts, and personal filesystem paths.
Start fresh Git history from that reviewed snapshot. Keep the private checkout's
`.git` directory, branches, and old pull-request history out of the new copy.
CI runs Gitleaks over reachable history and tracked contents.

Dependency checks are `pnpm audit --audit-level low` and
`pnpm check:rust-security`. The verified `vendor/glib` backport and its native
regression test cover the GTK3 dependency's VariantStrIter advisory;
`python3 scripts/check-vendor.py` verifies the vendor files. Maintenance notices
in `security/maintenance-policy.json` have explicit review dates.

`pnpm check:render-security` exercises the real Mermaid and KaTeX renderers
against malformed input in Chromium. Install the test browser with
`pnpm exec playwright install chromium` when needed.

Set release versions with `pnpm version:set <version>`, record a dated
`**Release**: <version>` entry in `docs/log.md`, and run `pnpm check:version`
before committing or packaging. The display name is OKF Reviewer; the established
application identifier and native executable name are retained for installation
and data compatibility. The MSI upgrade code is pinned to its former value
(derived from `OKF Review.exe.app.x64`) so the display-name change preserves
Windows MSI upgrade detection.

The Debian package is now `okf-reviewer` and replaces the former `okf-review`
package. For an existing Windows NSIS (`.exe`) installation, uninstall
**OKF Review** once before installing **OKF Reviewer**; leave the uninstaller's
app-data deletion option unchecked to retain settings and quiz history.
Subsequent installations use the new name consistently.

## Repository layout

| Path | Contents |
|---|---|
| [`src/`](src/) | React/TypeScript reader, navigation, filters, review and quiz workflows, and typed IPC client |
| [`src-tauri/`](src-tauri/) | Tauri host, scoped filesystem access, watcher, review transaction, quiz adapters, persistence, scoring, and stale detection |
| [`.codex/skills/okf-quiz/`](.codex/skills/okf-quiz/) | Application-owned quiz task, skill, canonical schema, and examples |
| [`crates/okf-core/`](crates/okf-core/) | Tolerant OKF discovery, parsing, links, indexes, and validation |
| [`docs/`](docs/) | Product and implementation knowledge bundle |
| [`scripts/`](scripts/) | Validation and repository gates |
| [`design-system/`](design-system/) | Reference tokens and HTML/CSS examples used to exercise ODSF reader extensions |

The project is available under the [MIT license](LICENSE).
