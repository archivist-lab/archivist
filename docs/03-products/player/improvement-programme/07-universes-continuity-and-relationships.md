---
title: "Universes, continuity and relationships"
document_type: plan
status: historical
classified: 2026-08-16
---
# Universes, continuity and relationships

## Objective

Make the collection’s intellectual structure visible. Archivist should connect items that belong together without reducing every relationship to a TMDB collection or opaque recommendation.

## Relationship model

The server needs first-class, curated relationship entities. A journey has an identity and an ordered set of members; direct edges explain additional links.

Recommended journey kinds:

- collection;
- franchise/universe;
- continuity/timeline;
- series/story arc;
- adaptation lineage;
- curator-defined exhibition.

Recommended direct relationship types:

- sequel / prequel;
- spin-off;
- same universe;
- alternate continuity;
- remake / original;
- adaptation / source;
- crossover;
- contains / part of;
- curator related.

Each relationship records source, display label, optional explanation, order, confidence and whether a curator has locked it. Provider-derived links must not overwrite a locked curator decision.

## Ordering

A journey may support multiple named orders, such as Release Order and Chronological Order. One is the curator default. Members may include films, series, seasons or selected episodes; the Player must visibly distinguish entity types and partial availability.

## Player experience

- Item heroes show concise membership, for example “Marvel Cinematic Universe · Phase 2 · 4 of 6”.
- A Continue Journey action points to the next available unwatched member.
- Journey pages explain the chosen order and show unavailable members as context only when the viewer intentionally opens the journey.
- Relationship rows use specific headings: “Next in continuity”, “Adapted from”, “Alternate version”, not merely “Related”.
- The viewer can switch among server-defined orders but cannot rearrange membership.
- Cross-media journeys preserve progress at the member level.

## Curator experience on the server

The server app should support create/edit journey, add/remove member, drag order, choose default order, add alternate order, set artwork/synopsis and lock provider relationships. It should flag broken references, duplicates and impossible reciprocal edges.

## Fallbacks

Use provider collections where trustworthy. Use shared genres/people only for recommendations and label the reason; do not silently claim continuity. When no curated relationship exists, omit the section rather than manufacture a universe.

## Acceptance criteria

- Every displayed relationship has a type and human-readable reason.
- A journey can mix films and series and support at least two orders.
- Continue Journey selects the next available unwatched member deterministically.
- Curator locks survive metadata refresh.
- Relationship cycles, deleted members and unavailable members have defined validation and rendering behaviour.
