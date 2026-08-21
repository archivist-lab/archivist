---
title: Design knowledge
document_type: index
status: canonical
updated: 2026-08-19
---

# Design knowledge

- [`design-system.md`](design-system.md) — canonical implemented palette, typography, shape, motion, focus, product expression, and accessibility rules.
- [`assets/icon-pack/`](assets/icon-pack/) — **the icon system**: 177 icons, one drawing per concept, React component, sprite, manifest and preview sheet.
- [`iconography-review-2026-08-19.md`](iconography-review-2026-08-19.md) — canonical review of every icon, ident and glyph Archivist renders, deduplicated, with the adoption plan.
- [`assets/`](assets/) — asset sources. `idents/` and `media-icons/` are superseded by the icon pack and kept for comparison.
- [`iconography.md`](iconography.md) — the 2026-08-16 inventory, kept unchanged for comparison; not current truth.
- [`reviews/`](reviews/) — dated style/branding assessments.

Shared implementation lives in `packages/design-system/tokens.css` and exported components. Application-specific CSS is evidence for product specialization, not permission to change shared brand semantics silently.
