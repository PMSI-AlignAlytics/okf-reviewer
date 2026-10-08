---
type: Design System
title: OKF Reviewer Design System
description: Reference tokens, guidelines, and ODSF HTML/CSS examples for OKF Reviewer.
tags: [overview, design-system]
status: stable
generated: { by: codex/gpt-6, at: 2026-10-08T20:31:16Z }
---

# Principles
1. **Dark-first, near-black.** Content sits on `colors.bg`; surfaces lift to `colors.surface`. Deep, calm, developer-native (the register of zed.dev).
2. **The accent marks what you can act on.** Identity is one hue, `colors.primary`, from the app icon's folder. It goes on links, the single primary button, and focus, and nowhere else. The icon's gradient stays on the icon.
3. **Restrained type.** Real typefaces, self-hosted; a display size that fits inside its measure; hierarchy from weight, color, and space rather than from scale. Monospace for labels, versions, and code.
4. **Space groups things.** Gaps are chosen to bind related blocks and separate unrelated ones, not set to the largest value available.
5. **Show the product, legibly.** A screenshot is evidence only if its text can be read; a sample of the real file format beats a paragraph describing it. If a surface does not ship yet, say so instead of illustrating it.
6. **Restraint over decoration.** No glow, no gradient fills, no movement on hover.
7. **Function first, edge to edge.** OKF Reviewer is a power tool: docked surfaces run flush behind a single hairline, and radius belongs to what floats. Beauty comes from alignment and rhythm, not enclosure (see [function-first](/guidelines/function-first.md)).

# Its relationship to the app
This reference palette was inherited from the predecessor's site and is used
for standalone examples in the reader. The desktop application's runtime
styles live in `src/styles.css`. The brand roles (`primary`, `primary-hover`,
`focus`, `error`, `warning`, `success`) **track the app** and must change with it;
the examples' surfaces and text roles deliberately differ from the denser tool
window. Both tables, with reasons, are in [color](/foundations/color.md);
`pnpm check:ds` enforces the shared roles.

# How to use this bundle
Start here, then pull the foundations from [`/styles/tokens.css`](/styles/tokens.css)
(import it once; every value is a CSS custom property). The language behind
those properties lives in [color](/foundations/color.md),
[typography](/foundations/typography.md), [spacing](/foundations/spacing.md),
[shape](/foundations/shape.md), [elevation](/foundations/elevation.md), and
[motion](/foundations/motion.md). The [components](/components/) and
[patterns](/patterns/) provide isolated reference markup; they can be opened
through the reader's Examples section. Example CSS consumes the token custom
properties via `var(--…)`.

The [dark-first guideline](/guidelines/dark-first.md) explains the reference
surface palette; [function-first](/guidelines/function-first.md) describes
the desktop application's layout.
