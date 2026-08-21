---
title: "Recommendation engine implementation status"
document_type: research
status: historical
classified: 2026-08-16
---
# Recommendation engine implementation status

## Delivered on 20 July 2026

Archivist now has a first-party, completion-aware recommendation engine spanning the Server and Player applications.

### Persistence and identity

Database migration 13 adds:

- external source candidates with provenance and expiry;
- atomic, versioned recommendation snapshots by audience, media type and library;
- profile feedback;
- exposure/outcome storage for later evaluation;
- bounded engagement events derived from Player progress.

Film and series identities remain media-type-qualified and use TMDB IDs as the recommendation provider identity. Series results retain TVDB IDs for Archivist's native add flow.

### Ranking model

The delivered `hybrid-v1` ranker:

- treats a completed film or caught-up series as the strongest implicit seed;
- gives active partial progress a much smaller positive weight;
- cautiously makes dormant, materially unfinished viewing a weak negative signal;
- ignores accidental starts below the confidence threshold;
- uses recency decay without erasing older completed interests;
- blends profile and household seeds at 75/25 when personal evidence exists;
- uses a reduced household model for profile cold start;
- applies explicit More Like This, Less Like This, Not Interested and Already Seen feedback;
- scores shared genres, people, studio/network relationships, TMDB seed recommendations, rating and popularity;
- applies deterministic ordering and a dominant-genre diversity cap;
- removes completed and dismissed candidates before presentation;
- emits a reason derived from the strongest positive contribution.

### Candidate sources

The local catalogue is always available as a candidate source. External refresh adds:

- TMDB film and series recommendations for the strongest household seeds;
- weekly trending films and series;
- upcoming films;
- on-air and future series discovery;
- cached TMDB genre maps for external feature matching.

External candidates are durable for 24 hours. Failed sources do not remove previous valid candidates or prevent local ranking.

### Serving and background work

Recommendations are materialised in SQLite rather than generated on every UI render. Snapshot replacement is transactional. Invalidated snapshots rebuild immediately when requested; old snapshots are served while an age-based refresh is scheduled.

The background service performs an initial external refresh after startup and then every six hours. Concurrent refresh requests coalesce into one operation. Candidate, engagement and exposure retention is bounded by the configured privacy window.

### Server application

Delivered fixed media-section tabs:

- **Films → Recommendations**;
- **Series → Recommendations**.

Both support household and Player-profile contexts. Results are grouped into Because You Finished, In Your Museum, New Discoveries, Coming to the Museum and Upcoming without duplicating a title across groups.

Cards use the existing `LibraryCard` interaction, `SearchDetailModal`, film acquisition form and series `AcquisitionAddModal`. Existing items open their library page; new items follow the same tier, resolution, source, codec and target-library workflow as Search. Successful adds update the card immediately and invalidate snapshots.

Profile views expose explicit feedback actions. Household views intentionally disable personal feedback because a shared model cannot safely attribute it to a person.

### Player application

The Player Home hub now supports **For You in the Museum**. It reads only available local results from durable recommendation snapshots and never performs an external request on the playback path.

Film and series detail recommendations now use the same ranked snapshots rather than the previous genre-only SQL queries. Recommendation reasons are shown on cards.

### Administration

**System → Recommendations** provides:

- enabled state;
- model version;
- external candidate counts and refresh times;
- snapshot state by audience, media type and library;
- feedback count;
- manual source refresh;
- engine enable/disable;
- 30/90/180/365-day privacy retention settings.

## Validation completed

- Database schema and migration tests.
- Offline film and series recommendation generation.
- Completed-seed exclusion and explanation checks.
- Explicit feedback suppression and snapshot invalidation.
- TMDB source refresh through an isolated provider mock.
- Candidate deduplication.
- Player Home recommendation widget and available-only enforcement.
- Governance setting validation.
- Server type-check.
- Server and Player production builds.
- Full Server regression suite.

## Intentionally deferred

These require real household outcome data and should not be represented as delivered yet:

- learned pairwise or collaborative ranking;
- synopsis/theme embeddings;
- online A/B model comparison;
- statistically meaningful completion-weighted NDCG evaluation;
- automatic weight tuning;
- Trakt as an additional candidate provider;
- a full perceived-card exposure client using intersection observers.

`hybrid-v1` remains deterministic and inspectable. Advanced learned ranking should only replace it after Archivist has enough consented outcome data to prove an improvement.
