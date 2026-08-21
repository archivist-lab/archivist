---
title: "Home, hubs and curation"
document_type: plan
status: historical
classified: 2026-08-16
---
# Home, hubs and curation

## Objective

Turn Home into the playback-facing mirror of the server Dashboard. It should mix personal relevance with server-owned curation while using the server's page header, panels, section labels, spacing and card grammar.

## Composition

Home uses one canonical composition:

- the shared server page frame and heading hierarchy;
- dashboard-style sections and panels using the same borders, radii and density logic;
- grids or remote-friendly rows built from the shared library-card grammar;
- stable section titles with optional one-line rationale;
- a compact active-download row only when work exists.

The server determines eligible rows and ordering. The Player may omit an optional empty row but does not locally invent, rename or reorder it.

## Required sources

- Continue Watching.
- Recently Added Films.
- Recently Added Episodes.
- Curator Featured.
- Next Episode.
- Next in Journey/Collection.
- Because You Watched, with a visible reason.
- Unwatched From Your Library.
- Active Downloads.
- Recently Restored or Upgraded, when conservation history supports it.

## Featured-content rules

- Featured content is presented in a server-style panel or card section, not a mandatory full-width cinematic hero.
- Only available, playable media is eligible.
- Prefer curated candidates; fall back to a relevant unwatched/next item.
- Respect profile watched state and age/certification restrictions if introduced.
- Always provide Play/Resume and a route to the full item.
- Missing artwork uses the shared server fallback treatment.

## Card grammar

All entity cards start from the server `LibraryCard`: the same radius, border, image opacity/hover or focus behaviour, title block, Bebas display title and mono secondary line. Playback progress and watched state extend that component; they do not replace it with a separate streaming card.

- Film: poster, title, year or concise context, progress/state.
- Series: series poster, title, next-episode or unwatched context.
- Season: season poster with series and season identity.
- Episode: landscape still, series and episode number above the episode title.
- Journey: artwork mosaic or designated key art, title and ordered-item count.
- Download: entity-specific artwork plus exact progress and state; never styled as already playable.

## Ranking and stability

Ranking occurs server-side so all clients receive the same ordered result. Personal signals may adjust Continue/Next/Because You Watched, while curator pins always remain explicit. Results should use stable daily randomisation where variety is intended; rows must not reorder during focus.

## Empty and failure states

- A new library receives a welcoming explanation, not a grid of empty skeletons.
- A single failed feed does not blank Home; render successful rows and a quiet retry state for the failure.
- Downloads vanish cleanly when complete without moving the viewer’s current focus.
- Offline/cache fallback clearly indicates that content may be stale.

## Acceptance criteria

- Home is useful without Player-side configuration.
- Every recommendation can state why it is present.
- All featured items are playable.
- Realtime download updates do not reset focus or reload unrelated rows.
- The same curation configuration is reflected consistently across profiles, with only personal-state ranking differences.
