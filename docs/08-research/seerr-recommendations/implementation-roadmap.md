---
title: "Data contracts, delivery roadmap and acceptance gates"
document_type: research
status: historical
classified: 2026-08-16
---
# Data contracts, delivery roadmap and acceptance gates

> Implementation note (20 July 2026): the deterministic `hybrid-v1` engine, durable snapshots, Server film/series tabs, Player available-only widget, feedback, diagnostics and governance controls are delivered. See [Recommendation engine implementation status](implementation-status.md) for the exact implemented scope and intentionally deferred data-dependent work.

## Current Archivist baseline

Archivist already has important foundations:

- profile-scoped `playback_progress`;
- completed state, position, duration and update time;
- film/series TMDB identities and series TVDB identities;
- genres, cast, crew, studio/network, ratings and collections;
- film and episode availability/acquisition states;
- Player hubs, browse, details, post-play recommendations and profiles;
- TMDB/TVDB metadata clients;
- background jobs and system events.

The largest data gap is event history. `playback_progress` stores the latest state, not meaningful starts, completion time, replay count or previous abandonment cycles. Version 1 can rank from the current state, but dependable learning requires milestone events.

## Proposed modules

Keep recommendation domains separate:

- `recommendations/catalog` — external candidates and canonical identity;
- `recommendations/features` — structured metadata features;
- `recommendations/engagement` — milestones and explicit feedback;
- `recommendations/affinity` — profile and household vectors;
- `recommendations/candidates` — source adapters and candidate union;
- `recommendations/ranker` — versioned scoring and diversity;
- `recommendations/snapshots` — durable materialised results;
- `recommendations/routes` — Player and administrator contracts;
- `recommendations/diagnostics` — health, reasons and evaluation.

Do not place all functionality in the existing Player router.

## Database additions

Names are indicative; the implementation should follow existing migration conventions.

### `recommendation_catalog`

One canonical record per external identity:

- `id`;
- `media_type`;
- `tmdb_id`;
- `tvdb_id`;
- `imdb_id`;
- `internal_media_type`;
- `internal_media_id`;
- `title`;
- `release_at`;
- `availability_state`;
- `metadata_json`;
- `metadata_hash`;
- `source_updated_at`;
- `last_verified_at`.

Unique key: media type plus TMDB ID. TVDB/IMDb mappings are secondary unique identities when non-null.

### `recommendation_item_features`

- candidate ID;
- feature schema version;
- feature type;
- feature key;
- value/weight;
- updated time.

A row model makes IDF and explanation queries possible. A compact JSON materialisation may be maintained for fast scoring.

### `engagement_events`

Record milestones, not heartbeats:

- profile ID;
- media identity;
- event type;
- value;
- playback session ID;
- source;
- occurred time;
- metadata JSON.

Event types:

- `meaningful_start`;
- `progress_25`;
- `progress_50`;
- `progress_75`;
- `completed`;
- `replay_completed`;
- `watchlist_added`;
- `acquisition_requested`;
- `more_like_this`;
- `less_like_this`;
- `not_interested`;
- `already_seen`;
- `feedback_reverted`.

Use idempotency keys for session milestones.

### `recommendation_feedback`

Current reversible explicit state:

- profile ID;
- candidate identity;
- feedback type;
- reason scope if applicable;
- created/updated time.

Unique by profile and candidate.

### `recommendation_affinities`

- owner type: profile or household;
- owner ID;
- feature schema/model version;
- feature type/key;
- score;
- positive and negative support;
- calculated time.

### `recommendation_source_candidates`

- source;
- source seed identity;
- candidate identity;
- provider rank;
- source score;
- fetched time;
- expires time;
- raw provenance JSON.

This is durable external-source caching, not only in-memory caching.

### `recommendation_snapshots`

- profile ID;
- surface;
- model version;
- feature version;
- generation ID;
- generated/valid/stale-after times;
- result JSON;
- source health JSON;
- generation duration.

Unique active snapshot per profile/surface/model.

### `recommendation_exposures`

- profile ID;
- generation ID;
- candidate identity;
- surface;
- rank;
- reason code;
- rendered time;
- perceived time;
- first outcome and outcome time.

Retention should be configurable and bounded.

## Contract sketch

### Recommendation result

Each item should provide:

- canonical identity;
- internal ID when present;
- title and artwork;
- media type;
- release date;
- availability state;
- primary action;
- progress if locally available;
- display reason;
- structured reason code;
- contributing seed IDs safe for that profile;
- source provenance;
- snapshot/model version.

Raw internal scores belong in administrator diagnostics, not normal Player payloads.

For Server film and series views, the result must preserve the corresponding metadata-search result shape and append recommendation context rather than introduce a second card DTO. The appended context is:

- recommendation reason and structured reason code;
- availability/acquisition state;
- snapshot and model version;
- source surface/group;
- safe seed identity when the reason is seed-specific.

This lets the Server pass a recommendation result directly through the existing film or series search detail and Add flow. Canonical identity and `alreadyAdded`/availability state must be resolved before rendering.

### Routes

- `GET /api/v1/player/recommendations`
  - profile, surface, cursor and limit;
  - reads a snapshot only.
- `GET /api/v1/player/recommendations/:type/:id/related`
  - explainable seed-specific candidates.
- `POST /api/v1/player/recommendations/feedback`
  - idempotent, profile-scoped feedback.
- `POST /api/v1/player/recommendations/exposures`
  - batched perceived-card events.
- `GET /api/v1/system/recommendations/health`
  - administrator-only source and snapshot health.
- `GET /api/v1/system/recommendations/explain/:profile/:type/:id`
  - administrator-only score breakdown with access audit.
- `GET /api/v1/recommendations/films`
  - household by default, optionally profile-scoped;
  - returns film search-result records plus recommendation context;
  - accepts surface, cursor and limit.
- `GET /api/v1/recommendations/series`
  - household by default, optionally profile-scoped;
  - returns series search-result records plus recommendation context;
  - accepts surface, cursor and limit.

Acquisition continues through existing film/series add routes so tier, quality, monitoring and root-folder rules remain authoritative.

## Server media-section interaction

Add **Recommendations** as a fixed sub-tab under both Films and Series. It sits alongside that media section's normal library and Add/Search experience, but does not become a configurable library tab and does not overwrite the active library-tab selection.

The UI should use shared recommendation-page composition while delegating each result to the existing media-specific search interaction:

- film cards use the film search card, `SearchDetailModal` mapping and film acquisition form;
- series cards use the series search card, series preview/detail mapping and `AcquisitionAddModal` flow;
- the recommendation reason is supplied through a small shared extension slot;
- card focus, hover, click target, modal dismissal and keyboard handling remain identical to search;
- successful acquisition invalidates the matching canonical identity in both Search and Recommendations query caches;
- back navigation restores the recommendation section, scroll position and focused card.

The detail modal resolves current state at open time. If another process or user has added the item since the snapshot was generated, the modal must show **In Library** or the active acquisition state and suppress a duplicate Add.

## Background jobs

### Metadata enrichment

On metadata add/refresh:

- update canonical identity;
- fetch/store keywords and relationship details not currently persisted;
- rebuild item features;
- enqueue affected affinities and snapshots.

### External candidate refresh

Suggested cadence:

- trending: every 6 hours;
- popular/discover feeds: every 12 hours;
- seed recommendations/similar: every 24 hours for active strong seeds;
- upcoming: daily, with more frequent refresh near release;
- credits/collections: on demand then long TTL.

Use bounded concurrency, provider rate limits, exponential backoff and stale retention.

### Affinity rebuild

- incremental after meaningful completion/feedback;
- coalesced after progress milestones;
- full nightly reconciliation;
- non-reentrant per profile.

### Snapshot generation

Trigger:

- after affinity change;
- after explicit feedback;
- after acquisition/availability state change;
- after candidate-source refresh;
- nightly reconciliation.

Debounce bursts. Keep the prior successful snapshot until the replacement transaction commits.

## Server-owned discovery composition

The Player should not expose a Seerr-style visual slider editor. Server curation defines a stable composition:

1. Continue Watching;
2. For You in the Museum;
3. Because You Finished…;
4. New Discoveries;
5. Coming to the Museum;
6. Upcoming for You;
7. Trending/Explore fallback.

Empty rails disappear without shifting focus unpredictably. A profile can provide feedback and content/access preferences, not redesign the page.

## Player interaction

### Available item

Primary action: Play or Resume.

Secondary actions:

- More Like This;
- Less Like This;
- Not Interested;
- explanation/details.

### External released item

Primary action: Add to Archivist.

The existing add flow must ask for or apply the correct tier, quality, monitoring and folder policy. Recommendation rank cannot override acquisition policy.

### Wanted/acquiring item

Primary action: View status. Do not offer a duplicate Add action.

### Upcoming item

Primary action: Monitor/Watchlist. Show a qualified date and metadata refresh state.

### Feedback response

Optimistically remove Not Interested items, preserve focus on the next card and reconcile with the server. More/Less Like This may update the rail after a quiet refresh; it should not reorder the row under the user's current focus.

## Administrator experience

Add a Recommendations area under Server settings/system with:

- engine enabled/status;
- source health and rate limits;
- candidate counts by source/state;
- snapshot age by profile;
- model version;
- last rebuild duration/error;
- explanation inspector;
- rebuild profile/all;
- clear external candidate cache;
- evaluation summary;
- privacy/retention settings.

Weights should be visible in an advanced diagnostic view. Avoid exposing dozens of casual tuning controls before evaluation data exists.

## Delivery phases

### Phase 0 — Instrumentation and identity

1. Add milestone engagement events.
2. Make completion time and replay completion observable.
3. Define eligible series completion.
4. Build canonical external identity mapping.
5. Add explicit feedback records.

Exit gate: a diagnostic report accurately distinguishes completed, active, accidental, caught-up and dormant-abandoned items.

### Phase 1 — Local recommender

1. Extract features from the existing library.
2. Build profile and household affinities.
3. Rank available, uncompleted library items.
4. Generate explanations.
5. Materialise snapshots.
6. Add “For You in the Museum”.

Exit gate: fully offline recommendations work and every card has a valid reason.

### Phase 2 — Seerr-equivalent breadth

1. Add TMDB recommendation/similar adapters.
2. Add popular, trending, upcoming and discover sources.
3. Persist source candidates with TTL/provenance.
4. Join native availability/acquisition state.
5. Add new, acquiring and upcoming surfaces.
6. Add film-only and series-only recommendation query contracts for the Server application.
7. Add **Films → Recommendations** and **Series → Recommendations** using the existing search-result cards and detail modals.

Exit gate: discovery breadth matches Seerr while all ordering is Archivist-ranked.

### Phase 3 — Actions and feedback

1. Connect Add/Monitor to native acquisition.
2. Add More Like This, Less Like This, Not Interested and Already Seen.
3. Record perceived exposures and outcomes.
4. Add focus-stable rail updates.
5. Add administrator diagnostics.
6. Route Server recommendation Add actions through the exact existing film/series acquisition dialogs and endpoints.
7. Update card availability immediately after Add and reconcile it on snapshot refresh.

Exit gate: actions are idempotent, feedback is reversible and outcomes can be attributed to a model snapshot.

### Phase 4 — Quality and diversity

1. Run temporal offline evaluation.
2. Establish a TMDB-order baseline.
3. Tune only with versioned changes.
4. Enforce diversity/calibration guardrails.
5. Add stale/failure drills.

Exit gate: the hybrid model improves completion-weighted ranking over TMDB order without reducing coverage or diversity.

### Phase 5 — Optional advanced ranking

Only when the data supports it:

- pairwise learning-to-rank;
- implicit latent factors;
- synopsis/theme embeddings;
- context-aware session reranking.

The deterministic model remains the fallback and explanation source.

## Acceptance gates

### Correctness

- Fully watched/caught-up seeds outweigh otherwise equal unfinished seeds.
- Unaired or unavailable episodes never reduce completion.
- Explicit Not Interested removes a candidate everywhere for that profile.
- Available-only surfaces contain no unavailable cards.
- Identity joins never merge a film and series sharing a numeric provider ID.
- Existing wanted/queued/downloaded items never create duplicate acquisitions.
- Films Recommendations never contains series, and Series Recommendations never contains films.
- Recommendation results resolve the same canonical identity and current library state as metadata search results.
- Adding from Recommendations applies the same tier, quality, monitoring, root-folder and target-tab rules as adding from Search.

### Server interaction parity

- Films and Series each expose a visible, fixed Recommendations tab.
- Clicking a recommendation card opens the same detail modal as clicking the equivalent search result.
- Pointer, keyboard and focus behavior matches the equivalent search result.
- Already-owned items offer View in Library; queued, downloading and processing items offer their existing status view.
- No recommendation state can expose a second Add action for an existing or active acquisition.
- A completed Add changes the card state in place and remains correct after reload.
- Returning from a detail page restores the previous section, scroll position and focused card.

### Dependability

- Player recommendation requests perform no external network calls.
- Last successful snapshots survive restarts and provider outages.
- Snapshot replacement is atomic.
- One failed source does not remove local recommendations.
- Rebuild jobs are cancellable, non-reentrant and visible in Processing.
- Correlation IDs connect generation failures to logs.

### Performance

Initial targets:

- cached recommendation response p95 below 100 ms on the local server;
- Home recommendation payload bounded by server-configured rail/limit;
- snapshot generation does not block playback/import;
- candidate and exposure retention remain bounded;
- no full-profile rebuild on every progress heartbeat.

### Quality

- explanation coverage above 95%;
- no repeated item within one discovery page;
- franchise and genre caps pass deterministic tests;
- temporal evaluation has no future-data leakage;
- completion-weighted NDCG@10 exceeds raw TMDB order before default rollout;
- catalogue coverage and diversity remain within approved guardrails.

### Privacy

- profile history is never sent to external candidate providers;
- household explanations never name profiles;
- feedback/history export and deletion are supported;
- administrator explanation access is authenticated and audited;
- retention defaults are documented.

## “Equal or better than Seerr” definition

Archivist reaches parity when it provides:

- popular, trending, upcoming and filter-based discovery;
- item recommendations and similar titles;
- local availability/acquisition status;
- watchlist/monitor and add actions;
- region/language awareness;
- reliable caching and source fallback.

Archivist exceeds Seerr when it additionally provides:

- profile and household completion-aware ranking;
- explicit abandonment safeguards;
- native existing-library rediscovery;
- explanations tied to real score contributions;
- continuity-aware recommendations;
- durable offline snapshots;
- diversity control;
- recommendation outcome measurement;
- direct, policy-safe Archivist acquisition.
