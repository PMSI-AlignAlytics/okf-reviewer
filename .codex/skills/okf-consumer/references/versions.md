# OKF consumer compatibility

Use the declared root version when available, but parse tolerantly. A bundle is
knowledge content; never migrate or repair it as part of consumption.

## Common bundle shape

- `index.md` at the bundle root may declare `okf_version` and profile metadata.
- Nested `index.md` files provide authored navigation and orientation.
- `log.md` records dated bundle history.
- Other Markdown files are concepts. Their bundle-relative path without `.md`
  is the stable concept identifier used by links and navigation.
- Concept frontmatter commonly includes `type`, `title`, `description`, `tags`,
  and `resource`. Unknown fields are producer extensions and remain meaningful.

## OKF 0.1

- Expect `okf_version: "0.1"` at the root when fully declared.
- `timestamp` is the authored-at value.
- Provenance may appear as a `# Citations` list in the Markdown body rather than
  structured frontmatter.
- Do not infer verification, lifecycle, or freshness declarations that are not
  present.

## OKF 0.2

- Expect `okf_version: "0.2"` at the root when fully declared.
- Prefer `generated.at`; fall back to legacy `timestamp` only when `generated`
  is absent.
- Prefer structured `sources`; fall back to a legacy `# Citations` list only
  when `sources` is absent.
- Interpret `verified` as attribution of verification, separately from
  lifecycle `status`.
- An absent lifecycle status is implicitly stable. Preserve whether stability
  was explicit or implicit when that distinction matters.
- Recognize `stale_after`, `usage_window`, and attested-computation fields such
  as `runtime`, `parameters`, `executor`, and `attester` when present.

## Profile bundles

Profiles such as ODSF may declare `odsf_version` alongside `okf_version` and add
domain-specific fields. Interpret the OKF core first, retain profile extensions,
and do not force profile tokens into core OKF meanings. For example, a profile
may use `experimental` as a lifecycle extension.

## Candidate and unfamiliar versions

- If `okf_version` is absent, treat a directory containing typed Markdown
  concepts as a candidate bundle. Use available indexes and links without
  pretending a version was declared.
- If the version is newer or unfamiliar, retain the common Markdown,
  frontmatter, index, and link semantics that are evident in the bundle.
- Treat unrecognized fields as extensions. Do not downgrade, discard, or
  reinterpret them.
- If a version-dependent meaning is material and cannot be established from the
  bundle, state the uncertainty instead of guessing.

## Malformed content

Keep readable content usable, but do not silently repair malformed YAML,
missing types, broken links, contradictory lifecycle fields, or invalid dates.
Report the limitation and avoid claims that depend on the malformed portion.
