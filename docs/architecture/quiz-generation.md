---
type: Architecture Decision
title: Quiz Generation
description: Provider-neutral, evidence-scoped generation of untrusted quiz artifacts with deterministic backend validation and local storage.
tags:
- architecture
- quiz
- agents
- evidence
- validation
- storage
generated:
  by: codex/gpt-6
  at: 2026-10-08T20:31:16Z
status: stable
verified:
- by: human:reviewer
  at: 2026-07-30T16:59:45.9953518Z
- by: human:reviewer
  at: 2026-07-30T18:55:54.6076707Z
- by: human:reviewer
  at: 2026-07-30T18:57:16.3917790Z
---

# Review status

Provider execution, credentials, Git history, durable quiz data, answer-key
IPC, and the complete user interface materially expand the earlier foundation.
The lifecycle and human-verification metadata record review of this expanded
architecture separately from the foundation.

# Decision

The central application owns the complete quiz flow:

```text
scope selection
  -> frozen target request and bundle snapshot
  -> app-owned OKF consumer and quiz skills
  -> provider-neutral generator adapter
  -> untrusted provider output
  -> trusted Rust validation
  -> app-owned quiz definition
  -> deterministic quiz-taking and results
```

Opened OKF bundles remain read-only throughout generation, quiz-taking,
history, deletion, and regeneration. Codex CLI, Claude Code CLI, and configured
model APIs share one request, artifact, validation, persistence, and scoring
contract. Provider-specific values never enter the quiz domain model.

# Why this decision exists

A quiz must be grounded in the knowledge for which the user is being held
accountable. Giving a provider unrestricted repository access would make the
effective syllabus provider-dependent, permit outside knowledge to fill gaps,
and make an answer difficult to reproduce. Treating structured-output support
as validation would also let malformed, stale, or unsupported model output
become playable application state.

The application therefore freezes the evidence before transport and treats
every provider response as untrusted bytes. Deterministic validation, not model
fluency or provider claims, decides whether a quiz can be used.

# Stable task and capability

`okf-quiz` is an application-owned, provider-independent task. It is read-only:
it cannot stage or apply changes, write to the opened bundle, mutate application
settings, or acquire a wider capability during a run.

The application packages an `okf-consumer` skill for version-tolerant,
read-only bundle navigation and an `okf-quiz` skill for the quiz method and
artifact contract. The digest-bound capability also includes the canonical
`okf-quiz-v1` JSON Schema and valid, insufficient-evidence, and adversarial
examples. It reuses the capability-pack resource layout and digest validation
previously established by OKF Studio rather than creating a parallel framework.

Codex may read only the files copied into its isolated temporary workspace. The
task receives no web, research, staging, Apply, settings, opened-bundle write,
or arbitrary-network capability. Provider transport may use the network to
reach a configured provider; it does not authorize web search or another
network destination.

# Native boundaries

Quiz generation uses bounded native provider, credential, process, and Git
operations. Its architecture preserves these boundaries:

* Rust owns native processes, cancellation, environment filtering, application
  directories, provider networking, credentials, Git commands, validation, and
  persistence.
* The webview receives bounded typed models and cannot manufacture filesystem,
  process, credential, network, or Git authority.
* The existing bundle-grant registry remains the authority for the active
  bundle. A path string from frontend state grants nothing.
* The existing application store remains suitable for non-secret presentation
  preferences. Quiz definitions and attempts use the quiz-history store;
  provider profiles and CLI setup use a separate Rust-owned per-user settings
  file outside the installation. Both stores use atomic writes and load-time
  validation, while API secrets remain in the operating-system keyring.
* The former managed-agent catalog, process host, keyring credential store, and
  fixed-operation Git runner are design sources. Only the narrow portions
  required by quiz generation are reintroduced.

# Scope and frozen generation packet

The trusted backend builds a typed request containing:

* an application-generated request ID;
* the current bundle fingerprint and the selected scope fingerprint;
* a bounded human-readable scope description;
* one of `current-document`, `selected-documents`, `topic`, `bundle-diff`, or
  `reviewed-since-commit`;
* a quiz-specific Short, Medium, or Long length, closed difficulty, and a
  maximum of 1–20 questions;
* an optional topic;
* required base and working-tree revision identifiers for Git-backed current
  evidence, and optional selected head revisions for bundle diff;
  and
* a bounded ordered list of evidence sources.

Each evidence source contains an application-generated source ID, concept ID,
bundle-relative path, title, concept type, `current` or `base` version,
application-computed content hash, and Markdown content. The application, never
the model, owns the request ID, fingerprints, concept identity, paths, source
membership, and content hashes.

The target request is explicit and frozen for one request. Its evidence sources
remain the normative basis for every answer and quote; a provider cannot add a
source to the accepted scope by naming it in output.

The backend also freezes a read-only snapshot of the selected OKF bundle. It
contains parsed concepts, authored root and nested indexes, and `log.md` when
present, with regular-file, UTF-8, path-containment, 256 KiB-per-file,
512-document, and 4 MiB-total limits. This gives `okf-consumer` the wider
context needed to follow navigation and relationships without exposing the
live bundle or repository. OKF 0.1, 0.2, ODSF profile extensions, candidate
bundles without a declared version, and unfamiliar compatible versions are
interpreted tolerantly; malformed content is never silently repaired.

The backend derives the provider-facing question target from frozen evidence:
one question per 3 KiB for Short, 2 KiB for Medium, or 1.5 KiB for Long,
rounded up and capped by the quiz-specific maximum. The exact target is not a
user preference and is not offered as a generation control.

The confirmation projection names provider, profile, model, target document
count and bytes, bundle-context document count and bytes, omitted documents,
revision, and whether content leaves the local machine. Confirmation creates
an immutable backend-owned target and context snapshot; adapter code receives
no active bundle path.

The reader's one-click quick path prepares the current concept with the closed
default generation configuration and the configured default provider, then
runs the same preflight, frozen-packet transport, validation, persistence, and
scoring pipeline. The standard generation flow continues to show the explicit
configuration and confirmation projection.

## Current and selected concepts

Rust obtains current concept Markdown through the authorized bundle model and
computes source hashes from exact UTF-8 Markdown. Selected scope accepts at most
32 concepts, 64 evidence-source records, 256 KiB per source, and 1 MiB total.
All paths are canonicalized against the active root and then represented as
bundle-relative Markdown paths.

## Topic retrieval

Local deterministic retrieval scores normalized matches in title, description,
type, tags, headings, and body. Exact identity and title matches outrank tags,
headings, and prose. Results include a bounded selection reason. Explicit graph
links may add candidates but do not silently select them. The reviewed source
IDs, not the search query, define the frozen scope.

## Bundle diff

The Git adapter invokes Git directly with fixed read-only operations, bounded
output, prompts disabled, hooks and external diff programs disabled, and
validated commit IDs. Untrusted discovery first tries Git normally, then locates
only the nearest ancestor `.git` marker when Git's ownership protection blocks
discovery. A repository inside the original native folder grant needs no extra
permission when Git accepts it. Otherwise Rust returns the exact canonical
enclosing repository for a one-time confirmation.

Accepted repository paths are stored in bounded app-local permission data.
Every subsequent command receives that one exact path through a per-command
`safe.directory` override; the app never writes system, global, or repository
Git configuration. The repository path must still contain the registered bundle,
Git must report the same top-level path, and every accepted content path must
resolve below the active bundle root. This separate permission widens only
read-only Git inspection—it does not widen bundle or filesystem write grants.

Base content is read with `git show <revision>:<bundle-relative-path>` without
checking out or modifying the work tree. Current content comes from the
authorized working-tree bundle, or head content from a verified commit.
Repository changes outside the bundle are ignored. Added, deleted, and modified
concepts retain separate base and current evidence records and hashes. A
canonical semantic comparison excludes line-ending, frontmatter-ordering, and
Markdown-format-only changes where that can be established without interpreting
meaning. The diff scope fingerprint binds revisions, source identities,
versions, hashes, and semantic change records.

## Reviewed since commit

The same hardened runner reads the current `HEAD`, historical concept content,
and added/deleted line counts without changing repository state. The frontend
passes the full `HEAD` it displayed; preparation verifies that object still
exists and that `HEAD` has not moved.

Rust parses `verified` at the base and current versions and compares a multiset
of exact `(by, at)` human events. Only a higher current count qualifies. Current
Markdown is then ranked by changed-line score and frozen greedily within 32
documents, 256 KiB per document, and 1 MiB total; ties use bundle-relative path.
Untracked reviewed concepts use their current line count. Every omission is
retained in the confirmation projection. This mode admits current evidence
only, while its request and scope fingerprint bind the full base commit and
literal `WORKTREE`.

# Skill method

The packaged quiz skill instructs every provider to keep answers and exact
quotes bound to the declared target and never use general knowledge to fill a
gap. The consumer skill may navigate the frozen bundle to interpret terminology,
relationships, assumptions, and consequences around that target. The quiz
method prioritizes:

* implementation and architecture decisions;
* business and technical constraints;
* explicit and implicit assumptions;
* trade-offs, failure modes, and edge cases;
* consequences when an assumption is false; and
* material differences between base and current knowledge.

Scenario and application questions are preferred to simple recall. Each
question has exactly one defensible correct choice and plausible distractors
drawn from likely misunderstandings, rejected alternatives, or near-miss
interpretations.

The skill requires the provider to draft choice meanings before assigning
display positions, randomize the correct choice's position independently per
question, update `correctChoiceId` after shuffling, and check the completed set
for an all-same-position bias. Larger quizzes keep correct positions reasonably
balanced without introducing a predictable sequence.

The method forbids trick questions, double negatives, `all of the above`, `none
of the above`, giveaway answer wording, unsupported interpretations, and
questions that need knowledge outside the declared target. It attaches evidence
to every question, skips ambiguous material, returns `insufficient-evidence`
when an adequate quiz cannot be generated, and returns only the schema-defined
object.

# Provider-neutral generation

One Rust-owned adapter contract exposes preflight, explicit sign-in, generation,
progress, cancellation, and a normalized raw-result type. Preflight reports availability,
authentication state, selected model support, whether content leaves the
machine, and bounded diagnostics. The lifecycle is `idle`,
`preparing-scope`, `awaiting-confirmation`, `generating`, `validating`, `ready`,
`insufficient-evidence`, `invalid-output`, `provider-error`, `cancelled`, or
`stale`.

All adapters receive immutable application-owned inputs and return only bounded raw output and
redacted metadata. They cannot return a trusted quiz. The same Rust validator
promotes output from every adapter.

## Temporary CLI workspace

Each CLI generation creates a unique directory below Rust-owned application
cache. It contains `quiz-request.json`, the frozen `bundle/` snapshot, the two
skills under `.agents/skills`, and the output schema. The process working
directory is this directory, never the active
bundle, repository, or a directory containing project-local `AGENTS.md` or
`CLAUDE.md`.

The host copies no Git metadata, credentials, or unrelated project files.
Environment variables are reduced to a tested allowlist plus provider-required
authentication variables; their values are never logged. The workspace is
deleted after success, provider failure, validation failure, cancellation, and
startup recovery of abandoned runs. Cleanup failure is recorded as bounded
metadata and retried without exposing contents.

## Codex CLI

The Codex adapter resolves an automatic or user-configured executable, checks
its version and `codex login status`, and validates the documented isolated
`codex exec` structured-output flags. Its prompt explicitly invokes
`$okf-consumer` and `$okf-quiz` and points them to `bundle/` and
`quiz-request.json`; the skill method and artifact details are not duplicated
in the prompt. The process runs in the temporary workspace with read-only
filesystem access, no web search, active-bundle access, repository writes, Git
mutation, or session restore. Cancellation terminates the
owned process tree. New user configuration defaults to `gpt-5.6-sol` with
`high` reasoning effort. Both values are passed explicitly to live tests and
real generation because `--ignore-user-config` intentionally excludes ordinary
Codex CLI defaults.

Codex writes the authoritative structured result to its dedicated
`--output-last-message` file. That file retains the 256 KiB provider-output
limit. Stdout and stderr are non-authoritative progress and diagnostic streams;
the backend drains them concurrently into small bounded buffers, truncating
excess transcript data without rejecting an otherwise bounded final result.
This also prevents verbose CLI output from blocking the child process or
growing temporary diagnostic files without bound.

When `codex login status` reports no session, preflight reports authentication
as a prerequisite without starting a login process. The shell shows the exact
resolved executable and version, copyable browser-login, device-code, and status
commands, and OpenAI's authentication documentation. The user runs the command
in their own terminal and explicitly selects **Check again**. A successful
recheck resumes the unchanged frozen request; an unsuccessful recheck returns
to the prerequisite without polling. Generation-time authentication loss uses
the same state and is never persisted as a failed quiz.

All Codex version, capability, status, live-test, and generation commands share
the same native executable, `CODEX_HOME`, filtered environment, and explicit
`cli_auth_credentials_store="auto"` override. On Windows, resolution scans all
PATH candidates for a standalone native executable before using npm's native
payload or a command shim. This keeps `--ignore-user-config` isolation from
silently changing the credential backend used by the preceding status check.
OKF Reviewer stores no Codex password, token, device code, or login output.

The canonical schema remains the trusted validation contract. Codex transport
receives an application-derived Structured Outputs projection that omits JSON
Schema composition and uniqueness keywords unsupported by the provider. The
backend always validates the returned object against the full canonical schema,
so the transport projection cannot weaken acceptance. Constant and enum fields
declare explicit primitive types because Codex rejects otherwise-valid schemas
that leave those types implicit.

## Claude Code CLI

The Claude adapter resolves an automatic or user-configured executable, checks
its version and `claude auth status`, and follows the documented structured
output contract rather than assuming `claude --help` lists every flag. Bare
mode, tools, slash commands, external MCP configuration, and session
persistence are disabled. Claude receives no active bundle path.

When Claude reports no authenticated session, the shell offers a visible,
cancellable sign-in window and runs `claude auth login`. The CLI opens its OAuth
flow and may accept a pasted authorization code in that same window when the
local callback is unavailable. A successful status recheck continues the frozen
quiz request. Claude Code owns its normal local credential storage; no password,
OAuth code, or token is returned over IPC or persisted by OKF Reviewer.

Both CLI integrations expose a free local/authentication check and a separate
explicit live structured-output test. The live test may consume provider
credits but contains no OKF bundle content.

## Model APIs

Model API profiles and requests remain native. The first implementation is an
OpenAI-compatible adapter behind the common interface; additional API providers
do not change quiz types or UI. Profile metadata contains endpoint, model,
timeout, and disclosure information. API keys live only in the operating-system
credential store under an opaque profile ID and never cross IPC.

Endpoint validation requires an explicit supported scheme, rejects credentials
in URLs, bounds redirects and response bytes, applies timeouts and cancellation,
and redacts secrets and bundle text from diagnostics. One request contains
system-level skill instructions, the frozen evidence, requested configuration,
and output schema. Tools, web search, and function calls are disabled.

# Canonical artifact contract

`okf-quiz-v1.schema.json` is the single source of truth for quiz output. Quiz
questions are dedicated typed objects rather than generic artifact fields.
Unknown fields are rejected.

The top-level object binds `schemaVersion: 1`, request ID, bundle fingerprint,
and scope fingerprint to either:

* `ready`, with a bounded title, at least one question, and bounded warnings; or
* `insufficient-evidence`, with no playable questions and at least one warning.

Question category is a closed enum: `decision`, `assumption`, `constraint`,
`architecture`, `behaviour`, `failure-mode`, `change`, or `fact`. Criticality
is `critical`, `important`, or `supporting`. Each question has a stable ID,
learning objective, prompt, three to five choices, one correct choice ID, a
bounded explanation, and one or more evidence references. Each evidence
reference names a source ID and contains a bounded heading and exact quote.

The schema bounds total output size, question and warning counts, prompt,
choice, explanation, heading, and quote lengths, and evidence references per
question. Rust and TypeScript types are generated from the schema where the
repository toolchain supports it; otherwise conformance tests bind separately
maintained types to this canonical schema.

# Trusted validation

Raw provider output remains available only for bounded diagnostics. It never
crosses into the playable quiz model until the trusted backend:

1. extracts exactly one complete quiz object and enforces the total byte bound;
2. validates JSON syntax, canonical JSON Schema, closed enums, and unknown-field
   rejection;
3. requires exact schema version, request ID, bundle fingerprint, and scope
   fingerprint matches;
4. recomputes every evidence-source content hash from the frozen request and
   returns `stale` when request evidence no longer matches;
5. requires unique question IDs and unique choice IDs within each question;
6. requires three to five non-empty choices and exactly one existing choice
   named by `correctChoiceId`;
7. rejects duplicate normalized question prompts and duplicate normalized
   choice text within a question;
8. resolves every evidence source ID against the frozen packet and confirms it
   belongs to the accepted scope;
9. normalizes source and quote line endings from CRLF or CR to LF, then requires
   the evidence quote to occur verbatim in the corresponding Markdown source;
10. requires direct bundle evidence for every critical question;
11. requires a ready result to have questions and an insufficient-evidence
    result to have none and to contain a warning; and
12. enforces all size, string, choice, evidence, warning, and question bounds.

Whitespace or punctuation is not otherwise rewritten during quote matching.
The validator does not silently repair provider output.

Validation returns a typed state:

* `no-output` when no candidate quiz object exists;
* `invalid` when syntax, schema, identity, scope, evidence, or bounds fail;
* `ready` for a playable, fully validated quiz;
* `insufficient-evidence` for a valid non-playable result; or
* `stale` when the request or selected knowledge no longer matches.

The backend also rechecks current source identities before accepting or loading
a quiz. A changed bundle fingerprint is not by itself stale when every in-scope
current hash remains identical. Invalid output cannot be exposed as playable.
A stale generation cannot create a current quiz; a previously stored stale quiz
may be opened only through the explicitly historical projection.

# What deterministic validation cannot prove

Validation can prove identity, shape, bounds, source membership, quote
occurrence, and declared answer consistency. It cannot prove that:

* a distractor is pedagogically strong;
* the declared answer is the best interpretation of genuinely ambiguous prose;
* an explanation captures every relevant nuance;
* a question measures durable understanding rather than short-term recall; or
* the source knowledge itself is true or complete.

These limitations remain explicit in diagnostics and product copy. They do not
weaken the deterministic acceptance rules.

# Persistence boundary

Quiz data is stored under the operating system application-data directory in a
versioned Rust-owned quiz store, never in the bundle, repository, or replaceable
application installation directory. The stable application identifier keeps
that location unchanged across reinstall. The store retains quizzes, their
attempts, and failed-generation records for 30 days, with additional caps of
100 quiz definitions, 100 failed generations, 20 attempts per quiz, and 20 MiB
total. Text remains bounded by the canonical artifact and request limits.
Startup and subsequent writes prune expired definitions together with their
attempts; an unparseable timestamp fails store validation rather than being
silently guessed or repaired.

Writes use a same-directory temporary file, validation, flush, and atomic
replacement. Loading treats JSON as untrusted: unknown schema versions,
oversized files, invalid identities, malformed artifacts, impossible answer
records, and unresolved evidence are rejected or quarantined rather than
repaired. Complete raw provider responses are not stored by default; diagnostics
retain bounded hashes, sizes, provider metadata, and redacted errors.

Definitions store quiz ID, title, scope configuration, bundle identity,
fingerprints, source identities and hashes, provider/profile/model metadata,
generation time, validated questions and answer key, explanations, evidence,
warnings, and stale state. Attempts separately store attempt ID, quiz ID,
timestamps, selected answers, correctness, overall result, and critical result.

Delete commands remove one attempt, one quiz and its attempts, or all quiz
history for one active bundle. No cloud sync is provided.

# Answer-key and scoring boundary

The stored trusted artifact does not enter ordinary frontend state. Rust exposes
purpose-specific commands equivalent to:

* create and list quizzes;
* start an attempt and fetch one public question;
* submit one answer and receive its deterministic reveal;
* complete an attempt and fetch bounded results;
* delete an attempt, quiz, or bundle history.

Before submission the public question contains only ID, prompt, choices,
category, and criticality. Submission validates the attempt and question
sequence, locks the selected answer, compares it with the stored answer key,
persists correctness, and returns correct choice, explanation, and resolved
evidence. Results are derived entirely from stored answers. No provider adapter
is reachable from answer submission, reveal, navigation, scoring, results, or
retake.

This boundary prevents accidental disclosure in ordinary application state; it
is not examination-grade security.

# UI and evidence navigation

Quizzes is a first-class activity using the existing navigation, typography,
controls, dialogs, error presentation, and responsive design tokens. Generation
has scope, evidence review, configuration, confirmation, progress, cancellation,
and validation states. Taking renders one question at a time. Results and
history use public backend projections.

Scope preparation and confirmation remain local to the Quizzes activity. Once
generation starts, an application-wide controller owns the provider preflight,
generation promise, progress listener, and cancellation state, so unmounting
the Quizzes activity during reader navigation cannot orphan the run. Only one
generation is active at a time. The persistent shell renders its progress and
announces its final outcome; successful and failed notifications link back to
refreshed quiz history for the bundle that originated the request.

Evidence references are resolved during validation to stored source identities.
Navigation accepts a concept ID from that trusted mapping, opens it in the
reader, and applies a heading anchor where practical. Base evidence in a diff is
rendered as historical text and cannot be mistaken for or used to open an
arbitrary provider path.

# Stale detection and regeneration

For current sources, Rust rereads the authorized bundle and compares the stored
source hashes. Unrelated concept changes do not mark a quiz stale. Diff quizzes
also require the recorded base/head objects and scope to remain reproducible.
Unsupported schema versions are stale and non-current. Reviewed-since-commit
regeneration and failure retry revalidate the captured base and fail clearly
when it is unavailable or `HEAD` has moved.

Stale quizzes remain available as clearly labelled historical assessments and
may be completed, deleted, or regenerated from the same stored scope
configuration when its concepts and revisions remain available. Regeneration
creates a new definition and never mutates the old result.

# Security, cancellation, and recovery

Cancellation is owned by Rust and terminates the exact request or process tree.
Cancelled, timed-out, failed, invalid, or stale runs create no playable
definition. Non-cancelled failures are stored separately from playable quiz
definitions with their bounded diagnostic and retry input. Retrying refreezes
the saved scope, increments the failure on another failure, and removes it only
when the replacement succeeds. Startup removes abandoned temporary workspaces
and marks interrupted generation records cancelled.

No telemetry is added. Logs exclude API keys, authentication tokens, complete
bundle content, complete request bodies, and complete provider responses.
Diagnostics are control-free, redacted, and bounded.

# Verification

Normal CI uses deterministic fake adapters, fixed CLI help/output fixtures,
temporary Git repositories, and local API servers. It requires no live cloud
credential. A provider path is reported working only after its invocation is
covered by an automated executable fixture, verified installed executable, or
successful manual smoke test.

The user experience and scope semantics are defined by
[Knowledge Quizzes](../features/quizzes.md).
