# Project scope

This project is a focused OKF bundle reader and human-review application.

The only permitted concept mutation in the MVP is the controlled operation that:

1. sets `status` to `stable`; and
2. appends a human verification event.

Do not introduce general document editing, AI features, quiz features, Git-management features or additional workflow states without an explicit requirement.

## Implementation principles

- Reuse existing OKF Studio components before creating replacements.
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
