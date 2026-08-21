---
title: "API contracts and server readiness"
document_type: plan
status: historical
classified: 2026-08-16
---
# API contracts and server readiness

## Objective

Give the Player bounded, presentation-ready contracts. It should not reconstruct museum curation by joining administration endpoints or guessing from filenames.

## Contract principles

- Version Player contracts independently from internal server models.
- Use stable IDs, explicit entity types and ISO UTC timestamps.
- Include display-ready availability and relationship semantics while preserving machine-readable fields.
- Paginate large collections with stable cursors/order.
- Use consistent asset URLs and cache metadata.
- Return capabilities/feature flags so destinations are omitted cleanly.
- Keep acquisition mutations and server configuration outside Player credentials.

## Required aggregate contracts

### Bootstrap

Profile summary, retained preferences, navigation policy, enabled capabilities, initial curated Home, server time/timezone context and contract version.

### Exhibit summary/detail

Identity, entity type, artwork roles, availability, progress, concise metadata, ratings, actions/capabilities, relationships and canonical route. Detail adds synopsis, people, editions/seasons/episodes, media summary and provenance as appropriate.

### Curated hub

Stable hub/row IDs, product-defined presentation kind, source rationale, ordered entities, paging/show-more target and freshness information. Player receives rendered curation, not arbitrary executable filters.

### Journey graph

Journey identity/kind, synopsis/artwork, named orders, typed members, current position, next available unwatched member and typed relationship edges.

### Activity

Unified acquisition plus processing items with entity hierarchy, artwork references, exact state, byte/progress data, ETA/error summary, playable-current-version and stable grouping keys.

### Playback

Stream URL/capabilities, editions, normalised media tracks, chapters, segments, duration, compatibility requirements and next-item eligibility. Track language/title/flags should come from the same server normaliser used by the administration UI.

## Events

Provide scoped events for progress/watched change, availability change, acquisition progress, processing progress, metadata/artwork refresh and curation invalidation. Events carry entity/revision identifiers; clients refetch bounded resources rather than accepting arbitrary payloads as truth.

## Server gaps to prioritise

1. Shared design-token package/build artifact.
2. Server-owned Player navigation/hub curation policy and defaults.
3. First-class journey/relationship schema and curator UI.
4. Presentation-ready activity aggregation across film/series/season/episode.
5. Unified media-track normalisation and default-selection metadata.
6. Consistent availability and Next Episode/Journey eligibility services.
7. Targeted events and cache revisions.
8. Artwork variants/provenance and robust fallbacks.

## Acceptance criteria

- Player pages do not call administration list endpoints to assemble display state.
- Contract fixtures cover every entity/state and are shared by server and Player tests.
- A contract-version mismatch fails clearly rather than rendering partial undefined content.
- Journey, availability and default-track decisions are deterministic server services.
- Player credentials cannot mutate acquisition policy or server curation unless a separately scoped curator role is introduced.
