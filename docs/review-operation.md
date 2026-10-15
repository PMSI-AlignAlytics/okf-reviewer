---
type: Operations Guide
title: Human Review Operation
description: How OKF Reviewer records a safe human verification on one local OKF v0.2 concept.
tags:
  - review
  - operations
  - safety
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-15T10:06:51Z
status: draft
---

# Human Review Operation

OKF Reviewer has one authoring operation: a named person can review the concept
open in the reader. The operation does not edit the Markdown body, rewrite
other concepts, commit to Git, or contact a remote service.

## Reviewer identity

Set a stable reviewer ID in **Settings → Reviewer**. Name and email are optional
local display settings and are not written into the bundle. The writer records
the ID as:

```text
human:<reviewer-id>
```

## Independent states

Lifecycle and verification answer different questions:

* `status` describes the concept lifecycle. In OKF v0.2, an omitted status is
  implicitly `stable`.
* `verified` records verification history. Only an actor beginning with
  `human:` counts as a human review.

A concept can therefore be stable and unreviewed, or draft and already
human-reviewed.

## Review a concept

1. Open a local bundle and select a concept.
2. Inspect its content, metadata, lifecycle, links, and backlinks.
3. Choose the review action.
4. Confirm the exact concept, relative path, SHA-256 of the body being
   approved, how the body differs from the Git comparison base, resulting
   lifecycle, reviewer, and timestamp.
5. Select **Confirm review**.

The confirmation states that a review approves the wording of the body only,
not code, metadata, implementation, or deployment. It also notes that
frontmatter YAML may be reformatted while the Markdown body is preserved.

The action is unavailable for deprecated concepts and for files the writer
cannot transform safely. It is also unavailable when the concept is stable and
the reviewer's own earlier review records the current body hash: another
identical stamp would add a duplicate event without a new approval, so the
reader acknowledges the existing one instead. Another reviewer can still add a
review, and a reviewer can review again after the body or lifecycle changes.

To decline instead, *Give feedback* copies a revision request for the
concept's author. It does not change the concept.

Because a deprecated concept cannot be reviewed, the Feature review panel lists
a changed deprecated concept with removed documents for a manual impact check
instead of counting it as outstanding.

## Exact transformation

For an accepted concept, the native writer:

1. resolves the concept below the canonical, user-granted bundle root;
2. rejects reserved files, traversal, symlinks, oversized files, invalid UTF-8,
   and missing or malformed frontmatter;
3. validates lifecycle and every existing verification entry;
4. fingerprints the source used by the confirmation;
5. refuses to repeat the reviewer's existing approval of the same body on a
   stable concept;
6. sets `status: stable`;
7. appends the new human record, including the `content_sha256` of the
   Markdown body it approved, without deleting prior records;
8. writes, syncs, reads back, and validates a same-directory transaction file;
9. checks the source fingerprint immediately before atomic replacement; and
10. lets filesystem watching refresh the reader.

Existing generated metadata, unknown frontmatter fields, nested values, and
Markdown body bytes are preserved. YAML presentation may normalize because the
writer transforms parsed YAML rather than editing text with a regular
expression.

## Failure and recovery

* On a concurrent edit, replacement is refused and the external edit remains.
* Malformed metadata is reported without a write.
* A temporary write, validation, sync, or replacement failure leaves the
  original file in place.
* A removed file or revoked grant must be reopened before another review.

Removing a bundle from the switcher removes only the app registration and local
grant. It never removes the directory or concept files.

## Example

Before:

```yaml
---
type: Decision
custom_field:
  owner: platform
---
```

After a review by `alex`:

```yaml
---
type: Decision
custom_field:
  owner: platform
status: stable
verified:
  - by: human:alex
    at: 2026-07-30T09:10:11Z
    content_sha256: 3f1c…
---
```

The body after the closing frontmatter fence remains byte-for-byte unchanged.

## When a review is current

A concept is human-reviewed while its body still matches a review:

1. If any `human:` event's `content_sha256` equals the SHA-256 of the current
   body, the review is current, whatever `generated.at` says.
2. Otherwise, if the latest `human:` event has a `content_sha256`, the body
   changed after that review, so the concept needs review.
3. Otherwise, for older reviews without a hash, the review is current when the
   latest `human:` event is at or after `generated.at`.

The hash covers the Markdown body after the closing frontmatter fence, with
CRLF normalized to LF. Frontmatter is excluded because reviewing rewrites it,
so state obligations in the body. The analytics starter pack's validator
applies the same rule; change both together.
