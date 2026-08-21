---
title: Archivist design system
document_type: design
status: canonical
updated: 2026-08-16
evidence:
  - packages/design-system/tokens.css
  - packages/design-system/src/Level.tsx
  - packages/design-system/src/ArchivistLoginPage.tsx
  - client/src/index.css
  - apps/player/src/styles/tokens.css
  - apps/control/src/ui/styles.css
---

# Archivist design system

The implemented visual system is a dark archival/cinematic interface with high-information Library surfaces and a spacious living-room Player. Shared tokens are authoritative; application CSS may specialize density and layout but should not redefine brand semantics.

## Core palette

| Token | Value | Meaning |
|---|---|---|
| Canvas | `#0a0a0f` | Global background |
| Surface 1 / 2 / 3 | `#111118` / `#1a1a24` / `#242430` | Elevation hierarchy |
| Foreground / text / muted / dim | white at `94%` / `82%` / `58%` / `40%` | Information hierarchy |
| Cyan | `#00d4ff` | Films, action, and focus |
| Violet | `#9b59b6` | Series |
| Pink | `#ff2d78` | Music and destructive accent |
| Yellow | `#f1c40f` | Books |
| Orange | `#e67e22` | Comics |
| Green | `#2ecc71` | Games |
| Success / warning / danger | `#10b981` / `#f59e0b` / `#ef4444` | State semantics |

Media colors identify domains and are not user-selectable skins. Cyan is also the invariant action/focus color.

## Typography

- Bebas Neue: display headings and product marks; uppercase, generous tracking, normal weight.
- DM Sans Variable: interface text and controls.
- JetBrains Mono Variable: metadata, telemetry, labels, codes, and compact technical state.

Shared type tokens define a `3rem` page title, `0.8125rem` card title, `0.65625rem` metadata/control label, and `0.78125rem` metadata value. Applications can scale for context, but hierarchy and font roles stay consistent.

## Shape, motion, and focus

- Radii: `0.5rem`, `0.75rem`, `1rem`, `1.5rem`.
- Control heights: `2rem` compact, `2.75rem` standard, `3rem` Player.
- Motion: `140ms`, `220ms`, `300ms`; respect reduced-motion preferences.
- Focus is visible cyan with a dark separation ring. Remote navigation uses the same focus token.
- Selected sidebar items combine accent foreground, tinted surface, accent border, and restrained glow; `aria-current="page"` is the canonical hook.
- Cards/dialogs use dark elevation, fine translucent borders, and restrained shadows. Glow communicates active/focused state, not decoration everywhere.

## Product expression

- Library: dense administrative information. Desktop applies the existing `0.85` document zoom at widths `≥1024px`; mobile preserves real tap-target size.
- Player: full-height, overflow-contained living-room canvas with safe-area clamps, expandable rail, remote focus, optional text scaling/high contrast, and artwork-led composition.
- Catalogue: operational studio/data interface using the shared palette and typography.
- Control: cockpit layout with 220px sidebar, 82px brand/top bar, mono telemetry, health/status colors, and the same selection language.

## Accessibility rules

- Interactive elements require visible `:focus-visible`; Player must also show focus in remote modality.
- Never communicate health, media type, or destructive intent by color alone; pair it with text/icon/state.
- Preserve mobile touch target size and Player safe areas.
- Maintain readable contrast for muted text; use `dim` for secondary/decorative content, not essential actions.
- Animation must not block navigation and must degrade under reduced motion.

## Shared implementation

`packages/design-system/tokens.css` is the canonical token source. The package currently exports shared level and login components; it is not a complete component library. The Catalogue-styled login surface is explicitly the shared authentication source of truth. Reusable cross-app patterns should move into this package only when their API and accessibility behavior are genuinely shared.

## Asset rules

Icons and idents live under [`assets/`](assets/). Prefer the established vector/icon system over emoji in primary UI. Preserve source/license/provenance notes for externally derived assets. Generated imagery must be an asset with a documented role, not a replacement for semantic UI controls.
