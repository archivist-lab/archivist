---
title: "Navigation and information architecture"
document_type: plan
status: historical
classified: 2026-08-16
---
# Navigation and information architecture

## Objective

Make the Player understandable as a small set of stable places, with contextual journeys branching from items. Navigation must not grow with every backend capability.

## Primary structure

- **Home:** personal continuation plus curated discovery.
- **Films:** available film library.
- **Series:** available series library, with season and episode depth inside each item.
- **Journeys:** collections, universes and continuities when curated data exists.
- **Channels:** programmed viewing when enabled.
- **Search:** cross-library search.
- **Downloads:** explicit exception where unavailable/acquiring media is shown.
- **Profile/Settings:** viewer identity, accessibility and playback preferences.

Downloads may be a contextual Home row and status destination rather than a permanent rail item when idle. Server administration never appears here.

## Server-mirror shell

The server Sidebar and page frame are authoritative. The Player uses the same fixed-left structure, logo treatment, surface, border, widths, item height, radius, spacing, icon language and selected-state treatment. Player destinations replace administrative destinations but do not trigger a redesign of the navigation component.

The default Player shell must not include a page-wide focused-art backdrop, streaming-service-style navigation treatment or a second set of rail dimensions. At television scale, larger focus outlines and minimum targets are permitted; any dimensional increase should be tokenised and proportional rather than recomposed.

## Navigation behaviours

- The sidebar follows the server collapsed/expanded behaviour and geometry. Its shape is fixed by the shared product component, not a Player preference.
- Back closes the deepest transient layer first: menu → drawer → detail child → prior route → Home. It never unexpectedly exits playback or the app.
- Returning from a detail page restores the exact card, rail position, filter and scroll offset.
- Deep links to film, series, person, journey and playback targets work after bootstrap.
- A globally persistent Now Playing surface is available while playback is minimised.
- Focus never jumps because artwork loads, a download percentage updates or a Home rail disappears.

## Page hierarchy

Every browse destination follows the server page grammar:

1. shared `PageHeader` title, context and tabs where needed;
2. server-style panels, section labels and grids/rows;
3. a single shared options surface for sort and filter;
4. shared loading, empty and error states.

Every item detail starts from the server detail primitives and follows:

1. identity and availability;
2. primary play/resume action;
3. short metadata and synopsis;
4. the next meaningful choice (edition, season or episode);
5. relationships and people;
6. technical information.

## Route model

Use stable entity routes (`/film/:id`, `/series/:id`, `/person/:id`, `/journey/:id`) and query parameters only for reproducible view state. Avoid internal widget IDs as the only way to reach content. A relationship link must resolve independently of the Home configuration.

## Acceptance criteria

- Every destination is reachable with a remote in a bounded number of moves.
- Focus and scroll restore after Back on all browse/detail transitions.
- Primary navigation contains no empty or disabled destination.
- The same content entity has one canonical detail route.
- Playback, dialogs and drawers have documented Back/Escape behaviour and automated navigation tests.
