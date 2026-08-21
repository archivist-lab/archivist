---
title: "Zero-configuration Player and settings reduction"
document_type: plan
status: historical
classified: 2026-08-16
---
# Zero-configuration Player and settings reduction

## Decision

Retire the four Player presets (`classic`, `categories`, `compound`, `combined`) and the idea that a viewer chooses the application’s composition. Remove appearance and hub-design settings from the Player. A new profile should receive the canonical experience immediately.

“No customisation” applies to presentation and curation. It must not remove accessibility, profile identity or legitimate playback preferences.

## Remove from Player settings

- Interface preset selection.
- Accent/colour scheme selection.
- Artwork blur and dialog tint.
- Backdrop cycle and purely stylistic animation choices.
- Edge-rail style and arbitrary Home layout selection.
- Add/remove/rename/reorder hub and widget editors.
- Card view and detail-row composition controls whose existence changes the product’s intended hierarchy.
- Any reset option that implies a skin can be rebuilt by the viewer.

## Retain

- Profile selection and profile management.
- Text size, high contrast, reduced motion and subtitle appearance.
- Audio/subtitle language preference, captions-forced behaviour and default stream rules.
- Loudness normalisation, target level, OSD timeout, pause behaviour, time display and Still Watching interval.
- Privacy/telemetry information where applicable.
- Diagnostics/about information.

The retained settings should be grouped as Profile, Accessibility, Playback, Subtitles and About. Defaults must be good enough that most viewers never open this area.

## Move to server curation

Administrators may configure which institutional hubs exist, their names, sources, order, eligibility rules and featured-content behaviour. This belongs in the server app because it affects the whole collection, not one viewing session. Server defaults should still generate a complete experience without configuration.

Recommended default navigation:

1. Home
2. Films
3. Series
4. Collections/Journeys when data exists
5. Channels when enabled
6. Search
7. Downloads when active or explicitly enabled
8. Profile/Settings

Recommended default Home order:

1. Continue Watching, when non-empty
2. Featured by the curator
3. Recently Added Films
4. Recently Added Episodes
5. Continue the Journey / Next in Collection
6. Because You Watched
7. Downloads, only while active

Empty optional hubs do not appear. Core destinations never disappear merely because a feed is empty.

## Migration

1. Add a new preference schema version that accepts old documents but writes only retained settings.
2. Preserve profile, accessibility and playback values.
3. Discard preset, appearance and viewer-authored hub composition fields after recording a one-time migration event.
4. Map old profiles to the canonical layout without prompting.
5. Keep server parsing tolerant for at least one release cycle; remove old client controls in the same release that introduces the migration.
6. Do not delete watched progress, bookmarks, search history or stream-language choices.

## Acceptance criteria

- A fresh profile has a complete Home screen with zero decisions.
- Existing profiles retain identity, progress, accessibility and playback behaviour.
- Two profiles see the same product design; differences are limited to personal content state and retained preferences.
- An administrator can influence curated content without changing code or visiting every Player.
- No stale preference value can silently re-enable a retired visual variant.
