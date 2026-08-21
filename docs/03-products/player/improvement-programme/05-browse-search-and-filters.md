---
title: "Browse, search and filters"
document_type: plan
status: historical
classified: 2026-08-16
---
# Browse, search and filters

## Objective

Let viewers find an available item quickly without exposing the complexity of server acquisition filters or requiring saved-view configuration.

## Browse experience

Films and Series open in one product-defined layout with a clear sort/filter drawer. Poster grids are the default for title libraries; episode results use landscape rows/cards. The Player may adapt column count to viewport and text scale, but not present a user-selectable skin matrix.

Default eligibility is `available = true`. Series remain eligible when at least one episode is playable; their detail page explains partial availability. Watched items remain visible in film/series libraries, while episode lists hide watched episodes by default with an explicit Show Watched toggle.

## Filters

Keep the living-room filter set small and meaningful:

- genre;
- year or decade;
- certification;
- studio/network;
- watched/unwatched/in progress;
- journey/collection/universe;
- quality/resolution only as an advanced filter;
- availability, only in Downloads or an explicitly expanded advanced state.

Filters combine server-side and expose a human-readable summary. Clear All is always reachable. Do not carry old filters invisibly into a new destination.

## Search

- Search films, series, episodes, people and journeys together.
- Group results by entity type; do not mix an episode and its series as visually identical cards.
- Debounce input, cancel stale requests and preserve the query when opening/returning from a result.
- Normalise punctuation, diacritics, alternate titles and common article differences server-side.
- Show local/available results first. The Player does not perform external metadata lookup or add-to-library actions.
- Empty search explains what was searched and offers spelling recovery or broader categories.

## Alphabet and long-list navigation

Alphabet jumps and result counts must be backed by server pagination, not client subsets. Remote focus moves into the requested section and announces the new range. Daily random sorts are stable for the day and pagination cursor.

## Acceptance criteria

- General browse/search never presents an unavailable result as playable.
- Combined filters work over the full result set and survive pagination.
- Search categories, Back restoration and alphabet jumping are remote-safe.
- Entity cards remain distinguishable without reading small metadata.
- Search remains responsive under stale or cancelled requests.
