---
title: "Archivist Player improvement programme"
document_type: plan
status: historical
classified: 2026-08-16
---
# Archivist Player improvement programme

Status: proposed product and engineering programme  
Created: 19 July 2026  
Scope: the living-room Player in `archivist/apps/player`, and the server capabilities required to support it

## Purpose

Archivist Player is the playback-facing mirror of the Archivist server. The server acquires, catalogues and administers the collection; the Player presents the same collection through the same visual and interaction grammar, substituting playback actions for acquisition actions. A correctly configured server should produce a coherent Player without asking each viewer to design their own interface.

This programme replaces both the four-style/preset direction and the earlier skin-led/cinematic interpretation with one locked Archivist interface. The server application is the visual source of truth: typography roles, shell geometry, spacing, surfaces, cards, headings, controls, status language and detail composition should match unless television focus or playback creates a documented exception.

## Product decisions

- One visual style, maintained by Archivist. No themes, colour schemes, layout presets, artwork blur controls or dialog tint controls.
- Server components are the reference compositions. Colour-token sharing by itself does not count as convergence.
- Server-owned curation. Hubs, ordering, featured exhibits and relationships are configured centrally and rendered automatically.
- Player-owned preferences are limited to identity, accessibility and playback behaviour.
- Available media is the default everywhere except explicit acquisition/download views.
- Film, series, season and episode pages are exhibits, not database records: artwork, context and relationships lead; technical details remain accessible without dominating.
- Universe, continuity, collection and adaptation links are first-class navigable relationships.
- Remote control and television focus behaviour are release requirements, not later polish.

## Documents

| Area | Document | Priority |
|---|---|---:|
| North star and principles | [00-vision-and-principles.md](00-vision-and-principles.md) | P0 |
| Server/Player visual convergence | [01-server-player-design-convergence.md](01-server-player-design-convergence.md) | P0 |
| Remove themes and move to zero-configuration | [02-zero-configuration-and-settings.md](02-zero-configuration-and-settings.md) | P0 |
| Navigation and information architecture | [03-navigation-and-information-architecture.md](03-navigation-and-information-architecture.md) | P0 |
| Home, hubs and discovery | [04-home-hubs-and-curation.md](04-home-hubs-and-curation.md) | P0 |
| Browse, search and filtering | [05-browse-search-and-filters.md](05-browse-search-and-filters.md) | P1 |
| Film/series/season/episode/person pages | [06-detail-experiences.md](06-detail-experiences.md) | P0 |
| Universes, continuity and relationships | [07-universes-continuity-and-relationships.md](07-universes-continuity-and-relationships.md) | P0 |
| Playback, OSD and stream selection | [08-playback-osd-and-media-selection.md](08-playback-osd-and-media-selection.md) | P1 |
| Progress, watched state and profiles | [09-progress-watched-state-and-profiles.md](09-progress-watched-state-and-profiles.md) | P1 |
| Downloads, availability and processing | [10-downloads-availability-and-processing.md](10-downloads-availability-and-processing.md) | P1 |
| Artwork, metadata and provenance | [11-artwork-metadata-and-provenance.md](11-artwork-metadata-and-provenance.md) | P1 |
| Channels and programmed viewing | [12-channels-and-programmed-viewing.md](12-channels-and-programmed-viewing.md) | P2 |
| Remote focus, accessibility and motion | [13-remote-accessibility-and-motion.md](13-remote-accessibility-and-motion.md) | P0 |
| Performance and resilience | [14-performance-caching-and-resilience.md](14-performance-caching-and-resilience.md) | P1 |
| Contracts and server readiness | [15-api-contracts-and-server-readiness.md](15-api-contracts-and-server-readiness.md) | P0 |
| Testing and quality gates | [16-testing-and-quality-gates.md](16-testing-and-quality-gates.md) | P0 |
| Delivery sequence | [17-prioritised-roadmap.md](17-prioritised-roadmap.md) | — |

## Definition of success

A new profile can open the Player and understand what to watch, where it belongs, why it is related, whether it is playable and how to continue within ten seconds—without first visiting Player settings. The interface remains recognisably Archivist at every resolution and input method, and a server curator can improve the experience for every Player from one place.

## Relationship to older documents

`../implementation-plan.md` records a large body of completed capability work and remains useful implementation history. `../../kodi/player-gap-analysis.md` is a capability comparison, but several of its statuses are now stale (watched state, filters, collections, segments, subtitle acquisition, profiles and OSD functions have moved on). Neither is the new product north star. This folder is the current improvement programme; implementation work should update these files as decisions or statuses change.
