---
title: "Archivist recommendation engine specification"
document_type: research
status: historical
classified: 2026-08-16
---
# Archivist recommendation engine specification

> Delivery status: the deterministic `hybrid-v1` implementation is now present. See [Recommendation engine implementation status](implementation-status.md) for validated behavior and remaining data-dependent extensions.

## Objective

Help each profile discover:

- **existing** items already available in the museum;
- **new** released items not yet in the library;
- **acquiring** items already wanted, queued or downloading;
- **upcoming** films and series likely to be relevant.

Recommendations must be dependable, explainable and actionable. The engine should optimise for meaningful starts and eventual completion, not card clicks.

## Core principles

### Completion is the strongest implicit signal

Finishing a film or all currently eligible episodes of a series is strong evidence of interest. Rewatching is stronger again.

### Incomplete does not automatically mean disliked

An unfinished item can mean:

- active viewing;
- missing or unaired episodes;
- a long series being consumed slowly;
- playback failure;
- accidental start;
- genuine abandonment.

Only dormant, sufficiently watched-but-not-finished behaviour should become negative. Missing and future episodes must be excluded from the denominator.

### Explicit feedback outranks inference

`More like this`, `Less like this`, `Not interested`, watchlist/add and manual ratings override weak behavioural inference.

### Candidate generation and ranking are separate

External services may propose candidates. Archivist decides their order.

### Every recommendation has a reason

The API returns the strongest human-readable explanation and structured contributors. The UI must not display unexplained “AI picks”.

### The system works without the network

The Player reads durable recommendation snapshots. External APIs refresh candidates asynchronously and never sit on the Home request path.

## Discovery surfaces

### In your museum

Available, playable items the profile has not completed:

- likely next film;
- an unwatched series matching completed series;
- overlooked library items;
- recently acquired items with strong affinity.

### New discoveries

Released films and series not in the library. Cards offer Add/Monitor with the normal tier and quality flow.

### Coming to the museum

Wanted, queued, downloading or processing items, ranked by profile relevance but with honest state.

### Upcoming for you

Unreleased titles with a credible release/air date. Cards offer Watchlist/Monitor, not Play.

### Because you finished…

A transparent seed-specific rail. This is the closest equivalent to Seerr/TMDB item recommendations, but Archivist reranks and diversifies the returned candidates.

### Explore an affinity

Explainable entity rails such as:

- More from Denis Villeneuve;
- HBO dramas you may like;
- Modern gothic horror;
- Next in the X-Men continuity;
- Highly rated Korean thrillers.

## Server Films and Series Recommendations tabs

Recommendations are a first-class part of the Server application as well as the Player. Add a fixed **Recommendations** tab beneath each media section:

- **Films → Recommendations** contains film candidates only;
- **Series → Recommendations** contains series candidates only.

These are not additional user-created library tabs and must not change the active library-tab context. They are acquisition and collection-management surfaces backed by the same ranked snapshots as the rest of the feature.

The Server defaults to a household recommendation view because it is the shared collection-management application. Where Player profiles exist, a context selector may switch between **Household** and a named profile. A profile view must use only that profile's eligible signals; the household view must never reveal which profile supplied a signal.

Each media tab groups findings into the relevant sections:

- **In Your Museum** — available but unfinished or overlooked items;
- **New Discoveries** — released items not in the library;
- **Coming to the Museum** — wanted, queued, downloading or processing items;
- **Upcoming** — unreleased items with a qualified date;
- **Because You Finished…** and affinity groups when a stable explanation exists.

Empty sections disappear. Film and series candidates never mix on these two views, even though the Player may use mixed-media rails elsewhere.

### Search-result interaction parity

A recommendation finding is a search result with additional ranking context, not a separate kind of media card. The implementation must reuse the existing media-specific search-result model and interaction path:

1. The whole card has the same pointer and keyboard activation behaviour as a film or series metadata search result.
2. Activating it opens the same `SearchDetailModal`, with the same metadata preview, artwork and accessibility behaviour.
3. A title not in the library exposes the same **Add** action and then the same media-specific acquisition dialog used by search. Tier, resolution, source, codec, monitoring, root-folder and target library-tab rules remain authoritative.
4. A title already in the library exposes **View in Library** and opens its existing item page. It must never create a duplicate.
5. Wanted, queued, downloading or processing titles expose their current state and route to the existing item/acquisition view instead of offering Add again.
6. A successful Add updates the recommendation card in place to its new state without waiting for a full recommendation rebuild.

The recommendation reason is additive presentation data. It may appear as a reason line or badge on the card and in the detail modal, but it must not replace, intercept or fork the normal search-result behavior.

## Candidate generation

The candidate worker builds a union of bounded pools.

### External item-to-item sources

For the strongest completed seeds:

- TMDB recommendations;
- TMDB similar;
- collection/franchise members;
- combined credits for high-affinity cast and creators.

Preserve provider rank as one feature, never as the final order.

### External discovery sources

- popular by media type and region;
- day/week trending;
- upcoming by region;
- high-quality genre/keyword combinations;
- network and studio feeds;
- original-language discovery;
- curated provider feeds if later enabled.

### Local metadata graph

Generate candidates by weighted relationships:

- continuity/universe;
- collection;
- genres;
- keywords;
- director/creator;
- principal cast;
- studio/network;
- original language/country;
- era;
- runtime band.

Use inverse-frequency weighting so “Drama” contributes less than a rare, informative keyword.

### Local catalogue recovery

All available but uncompleted library items remain eligible. This prevents external novelty from burying excellent items already owned.

### Curator sources

Server-authored exhibits, continuity orders and featured lists can nominate candidates. Curation contributes a feature; it does not bypass safety, availability or profile exclusions.

## Canonical identity

Every candidate must resolve to:

- media type;
- TMDB ID;
- TVDB ID when relevant;
- IMDb ID when available;
- internal film/series ID if known.

The identity service merges provider records, prevents movie/series collisions and attaches one availability state:

- `available`;
- `partially_available`;
- `processing`;
- `downloading`;
- `queued`;
- `wanted`;
- `upcoming`;
- `external`;
- `blocked`.

Blocked and dismissed candidates are removed before ranking.

## Feature model

Store structured candidate features rather than rendered labels.

### Content features

- genres and keywords;
- cast and crew roles;
- studio/network;
- collection and continuity;
- language and country;
- release year/era;
- runtime;
- certification;
- series status;
- public rating and vote count.

### Behaviour features

- profile completion weight;
- household completion weight;
- repeat-play weight;
- active-progress weight;
- abandonment penalty;
- explicit feedback;
- recommendation exposure history;
- previous recommendation outcome.

### Context features

- surface;
- desired availability state;
- current time and release proximity;
- recent profile viewing;
- session media type;
- locale and certification limits.

## Profile and household models

Generate two affinity vectors.

### Profile vector

Built only from the active profile's behaviour and feedback. This should dominate personalised surfaces.

### Household vector

Built from aggregate signals across eligible profiles. It provides:

- useful cold start;
- shared-interest discovery;
- evidence that certain library items are broadly finished or broadly abandoned.

Default blend:

- 75% profile affinity;
- 25% household affinity.

For a new profile with insufficient evidence, invert the blend temporarily and reduce household influence as personal confidence grows.

No profile should expose another profile's viewing history or explanation. Household explanations should say “Popular in this library”, not name viewers.

## Series completion

Series completion is calculated from eligible episodes:

- regular episodes only by default;
- aired by the calculation timestamp;
- available to the profile;
- not explicitly excluded by specials policy.

`eligible_completion = completed_eligible_episodes / eligible_episodes`

A continuing series can be “caught up” when every currently aired and available eligible episode is complete. Newly aired episodes move it back to in progress without rewriting historical signals.

Do not penalise a series for:

- unaired episodes;
- monitored but not acquired episodes;
- known playback failures;
- episodes hidden by access policy.

## Explicit feedback

Every recommendation card should offer:

- More Like This;
- Less Like This;
- Not Interested;
- Already Seen;
- Hide this reason;
- Add/Monitor or Play/Resume as applicable.

In the Server Films and Series Recommendations tabs, feedback controls are secondary actions. They must not reduce the card's main clickable area or change the established search-result click-to-details behavior.

`Already Seen` records completion without fabricating a playback position. `Not Interested` suppresses the title and downweights its strongest features. `Less Like This` adjusts affinity but does not permanently block the title.

## Explanations

Each result returns:

- display reason;
- primary seed or affinity;
- source types;
- top contributing features;
- availability reason;
- score version.

Examples:

- “Because you finished Succession”
- “You finish 82% of HBO dramas”
- “Next in the X-Men continuity”
- “From the director of Arrival”
- “Popular in your library, and matches political drama”
- “Upcoming in October · matches completed science-fiction films”

Reasons must be generated from actual score contributions. If no stable reason exists, place the item in Trending rather than For You.

## Diversity and exploration

After scoring, rerank each rail to prevent monotony:

- cap titles from one franchise;
- cap repeated dominant genres;
- avoid multiple candidates explained by the same seed consecutively;
- balance film and series only on mixed surfaces;
- reserve a small exploration share.

Suggested composition:

- 70% high-confidence affinity;
- 20% adjacent-interest candidates;
- 10% exploration/trending.

Exploration must still pass certification, blocklist, quality and popularity-confidence thresholds.

## Cold start

For a profile with little history:

1. use household completed-title affinity;
2. use library composition as a weak prior;
3. offer a short optional “choose a few favourites” interaction;
4. show diversified popular/trending/upcoming rails;
5. learn quickly from explicit feedback and meaningful starts.

Do not treat the mere presence of an item in the library as proof the active profile likes it.

## Reliability

### Snapshot serving

Generate versioned recommendation snapshots per profile and surface. Home/detail requests read snapshots from SQLite.

### Stale-while-revalidate

Serve the last successful snapshot while candidate sources refresh. Display a stale indicator only in diagnostics, not in the living-room UI.

### Determinism

Given the same model version, feature snapshot and seed, ranking must be reproducible. Exploration rotates on a daily deterministic seed.

### Partial-source tolerance

If TMDB recommendation calls fail:

- retain prior external candidates;
- generate from the local metadata graph;
- continue serving available-library recommendations.

### Observability

Record:

- generation duration;
- candidate count by source;
- rejection count by rule;
- stale-source age;
- rank distributions;
- explanation coverage;
- snapshot age;
- outcome metrics by model version.

## Safety and governance

- Respect profile certification/content restrictions before ranking.
- Never send private playback history to TMDB.
- Keep external credentials server-side.
- Support export/delete of profile feedback and recommendation history.
- Do not infer sensitive personal attributes.
- Keep model weights versioned and administrator-inspectable.
- Allow the recommendation engine to be disabled without affecting library playback.
