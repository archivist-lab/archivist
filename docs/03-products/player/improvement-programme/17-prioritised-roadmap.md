---
title: "Prioritised delivery roadmap"
document_type: plan
status: historical
classified: 2026-08-16
---
# Prioritised delivery roadmap

## Implementation status — 20 July 2026

The first foundation slice is implemented:

- server and Player now consume one shared colour, typography and semantic-token stylesheet;
- Player font stacks now name the server families;
- the Player ignores stored accent, blur, dialog-tint, preset and hub-layout variants;
- Home hubs render through the single standard composition;
- Settings exposes only Profiles, Playback, Accessibility and About;
- browse no longer exposes view, saved-view, default-view or Pin to Hub customisation;
- film and series information hierarchy is fixed by the product;
- the server accepts legacy preference documents, preserves their content/profile/playback/accessibility state and normalises visual fields to the canonical composition.

The earlier “same family, different density” interpretation is superseded by the component-parity contract in document 01.

### Canonical shell and typography pass — completed 20 July 2026

- Removed focused-media ambient artwork and scrims from the application shell.
- Replaced the focus-expanding Player rail with the server Sidebar geometry, logo, borders, navigation rows, content-type active states and matching content offsets.
- Applied the server page-frame padding to Player routes.
- Removed the active Home spotlight composition and locked Home to the standard server-mirror layout.
- Applied Bebas Neue display headings and card titles, JetBrains Mono section labels/metadata and DM Sans prose roles across the shell, Home, Browse, Search, Settings, Channels, cards and Now Playing surface.
- Replaced the common Player pill treatments touched by this slice with server-style rounded controls.
- Removed combined/wall visual-regression variants and regenerated the canonical 1080p/4K baselines.
- Verified 30 Player unit tests, four Chromium remote/visual journeys and the production build.

The next parity slice is the detail system. Film, series, person and episode surfaces still use the bespoke Player hero/dock/drawer composition and must be migrated to the server `DetailPage` family without losing editions, track selection, watched state or playback actions.

Remaining foundation work is to migrate detail and dialog primitives, self-host the shared fonts, finish the shared icon family, move hub definitions out of profile preferences into server-owned curation, and remove deprecated visual fields from the contract in a versioned schema migration.

## Sequencing principle

Lock the product and contracts before polishing individual pages. Removing customisation reduces the number of states every later feature must support.

## Phase 0 — Decisions and foundations (P0)

1. Approve the museum principles and canonical information architecture.
2. Freeze new preset/theme work.
3. Define shared design tokens, bundled fonts, semantic statuses and icon system.
4. Define the retained preference schema and migration away from visual/hub customisation.
5. Define Player contract versioning and server-owned curation policy.

Exit gate: one approved reference Home, film detail, series detail and OSD composition; schema/contract migration specified and tested.

## Phase 1 — Canonical shell and Home (P0)

1. Complete shared fonts/icons and enforce server typography roles in Player components.
2. Replace the Player ambient shell with the server Sidebar and page frame composition.
3. Remove Player appearance/interface/hub editors; retain Profile, Accessibility, Playback, Subtitles and About.
4. Implement server-curated navigation and a Home composition that mirrors the server Dashboard.
5. Make Home updates targeted and focus-stable.

Exit gate: a fresh or migrated profile opens a complete, paired-looking Player without configuration.

## Phase 2 — Exhibit pages and relationships (P0/P1)

1. Apply the shared exhibit hierarchy to film and series.
2. Complete compact season switching, hidden-watched episode behaviour and unified episode details.
3. Normalise media-track data and pre-play selection.
4. Add relationship/journey schema, curator UI and Player journey pages.
5. Replace generic recommendation headings with explicit relationship reasons.

Exit gate: viewers can move through a film/series/universe journey with correct availability, progress and Back restoration.

## Phase 3 — Discovery and activity (P1)

1. Simplify browse filters and category search around available content.
2. Complete entity-specific download grouping/cards and event updates.
3. Surface conservation status read-only.
4. Strengthen artwork variants, missing-art designs and metadata invalidation.
5. Align watched/progress state across all surfaces and devices.

Exit gate: search, browse, Home and Downloads agree on state and update without full-page churn.

## Phase 4 — Playback hardening (P1)

1. Formalise and test the playback state machine.
2. Simplify the first OSD layer and finish secondary panels.
3. Verify stream defaults, compatibility fallback, segments, Up Next, Still Watching and post-play.
4. Profile on low-powered television hardware.

Exit gate: all core playback paths pass remote, resilience and performance tests.

## Phase 5 — Channels and refinement (P2)

1. Bring Channels into the shared exhibit/guide language.
2. Finish cross-app status/copy alignment.
3. Address localisation, unusual aspect ratios and long-library scale.
4. Close remaining visual-regression and accessibility findings.

## First implementation slice

The completed first slice was deliberately narrow:

- introduce shared token/font assets;
- lock the Player to canonical cyan/noir styling;
- remove the four preset selector and visual appearance controls;
- migrate preferences while retaining accessibility/playback/profile data;
- keep existing hub data temporarily but render it through one layout.

This reduced configuration states but did not produce visual coherence on its own. The next slice must be the shell and typography-role parity pass before further aesthetic or feature expansion. Server-owned hub curation can follow behind the stable contract without preserving multiple UI styles.

## Programme completion criteria

- One visual system and one canonical composition ship across supported Players.
- Server curation controls shared presentation; Player profiles control only personal state and retained preferences.
- Universes/continuities are first-class, explainable journeys.
- Available/acquiring/processing states agree everywhere.
- Core journeys meet remote, accessibility, visual and performance gates on target hardware.
