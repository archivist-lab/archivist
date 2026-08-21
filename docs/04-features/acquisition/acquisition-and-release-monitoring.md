---
title: Acquisition and release monitoring
document_type: feature-reference
status: canonical
updated: 2026-08-21
evidence:
  - apps/server/src/services/item-searches.ts
  - apps/server/src/item-searches/routes.ts
  - apps/server/src/services/indexer-bridge.ts
  - apps/server/src/shared/rss-monitor.ts
  - apps/server/src/release-pipeline/orchestrator.ts
  - apps/server/src/release-pipeline/poller.ts
  - apps/server/src/release-pipeline/new-release-search.ts
  - apps/server/src/release-pipeline/missing-search.ts
  - apps/server/src/services/acquisition-decisions.ts
  - packages/torrent-engine/src/storage.ts
  - apps/server/src/services/media-imports.ts
---

# Acquisition and release monitoring

## What is automatic

The worker starts three complementary search paths:

1. Normal RSS polling of enabled RSS-participating indexers.
2. Air-time-aware release monitoring for monitored, wanted/missing episodes with an exact `air_at`.
3. Scheduled backlog search for older missing items that RSS is unlikely to catch.

All candidates ultimately use the shared parsing, identity, quality, indexer-priority, blocklist, decision, and grab path. A feed result is not downloaded merely because it exists.

## Interactive item searches

Film and series quick, deep/manual, auto, season, and episode searches are durable worker jobs. `POST /api/v1/item-searches` records an `item_searches` row and a linked `system_jobs` item; the browser polls that record but does not own its execution. Leaving an item page therefore stops only browser polling. The worker continues the search, and a later visit restores its current state and accumulated results.

The dedicated `searches` lane defaults to concurrency `1`, so item searches are processed in FIFO job order. Opening another film, series, season, or episode and starting a search adds independent work behind the current item. An active search with the same library, subject, and mode is deduplicated rather than enqueued twice. `ARCHIVIST_JOB_CONCURRENCY_SEARCHES` may raise local concurrency, but doing so intentionally relaxes serial execution.

Quick and deep/manual results, failure details, and completion state remain available for 15 minutes after the search finishes, fails, or is cancelled. Returning during that window restores the result list; expired rows are removed on subsequent item-search access. Auto modes also run without a page connection and update acquisition state directly; their result list is not presented as a manual selection list.

## RSS pipeline

The orchestrator starts after a five-second delay and ticks every 30 seconds. Each indexer retains its own last-poll, cursor, health, failure, and backoff state in SQLite. Only enabled indexers whose `settings.rss` is not false participate. Indexers are ordered by RSS priority and bounded to four concurrent polls.

A poll fetches recent releases, deduplicates/cursor-filters them, parses titles, identifies monitored subjects, records decisions, and grabs accepted releases. Feed health/backoff prevents a failing indexer from being hammered. Forced refresh is available through release-pipeline routes.

## New episode state machine

For a monitored series/season/episode that is wanted or missing and has no file:

```text
pending → rapid RSS window → repeated targeted episode search → backlog → complete
                                                       └──────→ cancelled
```

Exact behavior is configurable through release-monitoring settings. During an imminent/recent air window, RSS can poll at the rapid interval and coalesces episodes into a single forced refresh across healthy RSS indexers. After the RSS window, targeted searches run with bounded concurrency until the targeted window ends. Unresolved episodes transfer to backlog ownership. Successful acquisition/file state completes the row; unmonitored/no-longer-wanted state cancels it.

## Airtime and timezone

Automation depends on `episodes.air_at`, an absolute timestamp. Metadata refresh obtains episode dates and may enrich exact airtime using Skyhook/TVDB-derived data. `deriveEpisodeAirtime` prefers an explicit provider UTC timestamp; otherwise it combines date, series time, and the configured release timezone.

- `TVDB_API_KEY` is required for direct TVDB API authentication.
- `TVDB_PIN` is sent when configured and is required only for TVDB keys/accounts whose login response requires it; Archivist does not invent or recover a PIN.
- Skyhook is used as an airtime source when a TVDB series ID is available and does not require the user’s TVDB PIN.
- The release timezone follows Search Missing settings; `system` uses the host process timezone. A valid IANA timezone should be configured when the broadcaster’s wall-clock time differs from the host.
- OMDb is not an airtime source in the implemented series pipeline.

An air date without time/timezone cannot drive precise post-air automation. Manual series schedule updates can set time/timezone and recompute `air_at`.

## Partial selection and import staging

The embedded engine writes to the incomplete directory and moves each file into the
download directory when the torrent completes. Deselecting files in the torrent file
picker is a supported action: unwanted files are never written, and the pieces covering
them are marked skipped, which is why a partially selected torrent legitimately reports
100% and completes.

Completion therefore does not mean every file in the torrent exists on disk. The move
treats a missing source as expected rather than fatal, isolates per-file errors instead
of abandoning the remaining files, and only sweeps the incomplete folder once nothing
failed to move. It is idempotent, so an interrupted move can be re-run; an import that
finds nothing importable asks for exactly that repair before giving up, at most once per
torrent per five minutes.

An import plan classifies the download's files. Deselected files are reported as such
rather than as a missing download, because the two call for different action. A
multi-album pack is expected to carry more than the library tracks — other albums,
alternate pressings, rip sidecars — so unmatched extras are warnings; only an empty match
blocks the import.

## Why a title can return no result

Check, in order:

1. At least one indexer is enabled, tested, and enabled for the relevant media type/workflow.
2. Its Cardigann/Torznab definition supports the query parameters and categories being sent.
3. Credentials, cookies, base URL, anti-bot requirements, and site availability are valid.
4. The provider/indexer actually has a matching release; test success alone proves only connectivity/test logic.
5. Parsed title/year/season/episode identifiers match the monitored record and aliases.
6. Quality/source/codec/size/seed/priority/custom-format rules do not reject it.
7. It is not already downloaded, grabbed, blocklisted, cursor-filtered, or duplicate.
8. The download URL is usable and the chosen embedded/external client accepts the add.
9. For air-time automation, monitoring is enabled at series, season, and episode levels and `air_at` is populated.

Use release-pipeline status, per-indexer state, acquisition decisions, torrent diagnostics, system events, and worker logs together. Do not diagnose RSS from the browser search result alone.

## Delivery guarantee

Archivist will schedule and attempt automatic acquisition when the prerequisites above are met. It cannot guarantee availability, indexer correctness, provider uptime, title mapping, or peer health. Documentation and UI should say “automatically attempts and queues accepted releases,” not “will download every release.”
