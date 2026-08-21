---
title: "Seerr discovery analysis"
document_type: research
status: historical
classified: 2026-08-16
---
# Seerr discovery analysis

## What Seerr does well

Seerr combines four product functions effectively:

1. broad external discovery;
2. local availability and request status;
3. simple acquisition requests;
4. administrator-controlled discovery layout.

Its dependable quality comes primarily from clear state integration and mature request workflows, not from proprietary recommendation ranking.

## Candidate sources

Seerr's built-in Discover sliders include:

- recently added;
- recent requests;
- watchlist;
- trending;
- popular films;
- film genres;
- upcoming films;
- studios;
- popular series;
- series genres;
- upcoming series;
- networks.

Administrators can add custom sliders based on TMDB keywords, genres, searches, studios, networks and streaming providers. Sliders can be enabled and reordered in the database.

Sources:

- [Discovery slider constants](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/server/constants/discover.ts)
- [DiscoverSlider entity](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/server/entity/DiscoverSlider.ts)
- [Discover screen](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/src/components/Discover/index.tsx)

## Recommendation and similarity paths

The film and series routes call these TMDB endpoints directly:

- `/movie/{id}/recommendations`;
- `/movie/{id}/similar`;
- `/tv/{id}/recommendations`;
- `/tv/{id}/similar`.

Seerr preserves TMDB's order, looks up matching local `Media` rows, and adds availability/request information. There is no profile completion, abandonment, library-affinity or household reranking step.

Sources:

- [Movie routes](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/server/routes/movie.ts)
- [Series routes](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/server/routes/tv.ts)
- [TMDB adapter](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/server/api/themoviedb/index.ts)

## Discover filtering

TMDB Discover supports filters for:

- release/air dates;
- studio or network;
- genre and keywords;
- original language;
- runtime;
- vote average and count;
- streaming providers and region;
- status;
- certification.

The default sort for general film and series discovery is TMDB popularity descending. Trending is TMDB day/week trending.

This supplies breadth but not personal relevance. A popular title can appear for every user even if it conflicts with everything they finish.

Source: [Discover routes](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/server/routes/discover.ts)

## Local state enrichment

For each external result, Seerr performs a batched lookup by TMDB ID and media type. It adds status such as available, partially available, requested, processing or blocklisted.

This is a pattern Archivist should retain: recommendation identity and acquisition state must be joined before presentation, so one card can offer Play, Resume, View, Add or Upcoming without guessing.

Seerr's browser hook can hide available or blocklisted results after pages are fetched. Archivist should apply these policies server-side before pagination so counts and page density remain correct.

Sources:

- [Media.getRelatedMedia](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/server/entity/Media.ts)
- [useDiscover](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/src/hooks/useDiscover.ts)

## Watch history

Seerr contains a Tautulli adapter that can retrieve recent Plex history and percentage-complete data. The user route maps those records to local media and returns them as `recentlyWatched` with a total play count.

That data is used on the user profile. It does not feed the recommendation or Discover routes.

Sources:

- [Tautulli adapter](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/server/api/tautulli.ts)
- [User watch-data route](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/server/routes/user/index.ts)

## Cache and failure behaviour

Seerr wraps external APIs with:

- in-memory response caches;
- provider-specific TTLs;
- rate limits;
- rolling background refresh support;
- stable cache keys derived from endpoint and parameters.

TMDB responses commonly use a six-hour cache. Item details can use longer endpoint-specific lifetimes.

This reduces latency and external traffic, but caches are process-local. A restart loses them, and a complete TMDB outage can leave an uncached discovery request without useful results.

Sources:

- [ExternalAPI](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/server/api/externalapi.ts)
- [Cache manager](https://github.com/seerr-team/seerr/blob/5ae70d05e1ee123b3cda43153ed415754fd8e816/server/lib/cache.ts)

## Strengths to preserve

- Wide candidate coverage with minimal local computation.
- Clear local availability/request state on external results.
- Separate popular, trending, upcoming and filtered discovery concepts.
- Region and language awareness.
- Watchlists and blocklists.
- Administrator-curated source ordering.
- Batched identity joins.
- External API rate limiting and caching.
- Straightforward request action from a discovery card.

## Gaps Archivist should improve

### No personalised ranking

Recommendations are keyed to one seed item, not a user's watched body of work. Two profiles receive the same TMDB order for the same seed.

### Completion is unused

A film watched twice, a series completed across six seasons and a title abandoned after eight minutes do not affect Discover ranking.

### Available content can be filtered too late

Client filtering may require fetching several pages to fill a rail and makes server totals misleading.

### Weak explanations

“Recommended” and “Similar” do not explain which watched title, person, genre, continuity or viewing pattern caused the result.

### No household aggregate model

Seerr has user state but does not learn what the household collectively finishes.

### External dependence

TMDB is both the candidate source and the ranking authority for most discovery. There is no durable locally ranked snapshot.

### No recommendation-quality loop

There is no exposure log connecting a shown recommendation to later start, completion, abandonment or explicit rejection.

## Conclusion

Seerr should be treated as the baseline for discovery breadth, status presentation and actionability. Archivist's “better” layer should be completion-aware ranking, local durability, explanations, diversity and measurable outcomes.

