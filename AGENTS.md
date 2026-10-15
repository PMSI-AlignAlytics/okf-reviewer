# Project scope

This project is a focused OKF bundle reader and human-review application.

The only permitted bundle mutation is the controlled review operation that:

1. sets `status` to `stable`; and
2. appends a human verification event recording the `content_sha256` of the body it approves.

It refuses to repeat a reviewer's existing approval of an unchanged body. See `docs/review-operation.md`.

These capabilities are established and in scope:

- Read-only Git inspection: status, change comparison, feature review batches against an automatic or reviewer-selected commit, removed-document text, and quiz evidence. Never stage, commit, check out, or change Git configuration.
- Outputs for other tools, such as review records and reviewer feedback, go to the clipboard. They are never written to the bundle or repository.
- Application-owned knowledge quizzes, with provider output validated natively and quiz data kept in application data.

Do not introduce general document editing, further bundle mutations, Git-writing features, agent chat or other AI features beyond the bounded quiz task, or additional workflow states (such as "changes requested" or implementation acceptance) without an explicit requirement.

## Implementation principles

- Reuse existing components and patterns in this repository before creating replacements.
- Treat the current OKF specification as authoritative.
- Preserve unknown OKF fields.
- Keep filesystem writes in the trusted backend.
- Never overwrite concurrent external changes.
- Prefer minimal, reviewable file diffs.
- Add tests for every metadata transformation.
- Do not silently repair malformed user data.
- Keep lifecycle status and human verification conceptually separate.

## Application versioning

- Increment the app version once per completed application change, before committing or building an installer.
- Use PATCH for fixes, usability polish, and compatible maintenance.
- Use MINOR for new user-facing capabilities.
- While below 1.0, use MINOR for breaking changes and document them. Moving to 1.0 requires an explicit release decision.
- Documentation-only and test-only changes do not require a bump.
- Use `pnpm version:set <new-version>` to update all version declarations.
- Add a dated `**Release**: <new-version>` entry to `docs/log.md` describing the changes.
- Run `pnpm check:version` before committing and packaging.
- Report the previous and new versions in the completion message.
