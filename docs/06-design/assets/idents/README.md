---
title: "Archivist Idents"
document_type: asset-guide
status: superseded
classified: 2026-08-16
superseded_by: docs/06-design/assets/icon-pack/
superseded_on: 2026-08-19
---
# Archivist Idents

> **Superseded by [`../icon-pack/`](../icon-pack/).** These idents use a 3.2
> stroke against the pack's 3, and each carries a small solid marker dot placed
> off the drawing rather than as part of it. All ten are covered by the pack:
> films by `reel`, music by `groove`, books by `folio`, and the rest by their
> module icons. Kept here for comparison; nothing imports them.

A cohesive set of standalone SVG idents for Archivist.

## Included
- films
- series
- music
- books
- comics
- games
- channels
- home
- acquisitions
- settings

## Shared design language
- 64 × 64 viewBox
- 3.2px rounded strokes
- `currentColor` for easy theming
- One small solid archive-marker dot per icon
- No CSS variables, scripts, editor metadata, or external dependencies

## Colouring
Inline:

```html
<img src="films.svg" style="color:#9B59B6">
```

For inline SVG:

```css
.archivist-ident {
  color: #9B59B6;
}
```

The SVGs inherit `currentColor`, so one colour assignment controls the complete ident.
