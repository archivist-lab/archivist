---
title: "Remote focus, accessibility and motion"
document_type: plan
status: historical
classified: 2026-08-16
---
# Remote focus, accessibility and motion

## Objective

Make the Player fully operable and legible from a sofa. Accessibility settings are not visual customisation and remain available under the locked design system.

## Focus contract

- Every actionable element participates in a named focus zone.
- Directional movement is deterministic; nearest-element geometry is a fallback, not the sole navigation model.
- Focus is always visible in remote modality and never relies only on colour.
- Opening a drawer/dialog moves focus inside; closing restores the invoking element.
- Back closes layers in a fixed order and never strands focus behind an overlay.
- Realtime updates may not remove the focused node without moving focus to a logical sibling and announcing the change.
- Virtualised grids retain logical focus and scroll position.

## Target and typography standards

- Minimum remote target: 48 CSS pixels, with larger primary actions.
- Default body copy is television-legible and avoids low-opacity text for essential information.
- Text scaling reflows rather than clipping, including the OSD and track selectors.
- Titles may truncate on cards but full accessible names remain available; synopsis text wraps at readable line length.

## Retained accessibility controls

- text size;
- high contrast;
- reduced motion;
- subtitle font size, colour, background and edge treatment within safe supported bounds;
- captions preference and preferred spoken/subtitle languages.

## Motion grammar

Motion explains focus and hierarchy: short focus scale, crossfade for artwork, slide for contextual drawers and no ornamental parallax. The current 80–280 ms primitives are a sensible base, but focus enlargement must not crop cards or cause adjacent layout movement. Reduced motion removes scale and large travel while retaining instant state feedback.

## Semantic accessibility

Use native controls, meaningful headings/landmarks, `aria-live` only for important status, and labels independent of icon glyphs. Progress exposes value/state text. Flags supplement language names and never replace them.

## Test matrix

- keyboard arrows/Enter/Backspace/Escape;
- gamepad polling and repeat behaviour;
- pointer interoperability after remote input;
- 1080p, 4K, 4:3-ish and ultra-wide layouts;
- 100%, 115% and 130% text scales;
- reduced motion and high contrast;
- screen-reader smoke tests for settings, details and OSD.

## Acceptance criteria

- Every primary journey is completable without a mouse.
- Automated focus tests cover route return, dialogs, season switching, filters, OSD and live-download updates.
- Essential text meets contrast targets in default and high-contrast modes.
- No animation is required to understand state.
