---
title: Acquisition and release monitoring
document_type: feature-reference
status: canonical
updated: 2026-08-23
evidence:
  - apps/server/src/services/item-searches.ts
  - apps/server/src/services/music-metadata.ts
  - apps/server/src/modules/music/musicbrainz.ts
  - client/src/components/MetadataEditorModal.tsx
  - client/src/modules/music/index.tsx
  - apps/server/src/services/acquisition-state.ts
  - apps/server/src/item-searches/routes.ts
  - apps/server/src/services/indexer-bridge.ts
  - apps/server/src/indexers/routes.ts
  - client/src/modules/indexers/IndexersPage.tsx
  - packages/indexer-engine/src/definition-sync.ts
  - apps/server/src/indexers/endpoints/breaker.ts
  - apps/server/src/indexers/endpoints/resolver.ts
  - apps/server/src/indexers/endpoints/scoring.ts
  - apps/server/src/indexers/endpoints/scheduler.ts
  - apps/server/src/shared/rss-monitor.ts
  - apps/server/src/release-pipeline/orchestrator.ts
  - apps/server/src/release-pipeline/poller.ts
  - apps/server/src/release-pipeline/new-release-search.ts
  - apps/server/src/release-pipeline/missing-search.ts
  - apps/server/src/services/acquisition-decisions.ts
  - apps/server/src/services/download-manager.ts
  - apps/server/src/release-pipeline/subject-decisions.ts
  - apps/server/src/services/music-repair.ts
  - apps/server/src/services/library-scan.ts
  - packages/torrent-engine/src/metadata-fetcher.ts
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

Film and series quick, deep/manual, auto, season, and episode searches, plus Music album and artist-discography quick, deep, and auto searches, are durable worker jobs. `POST /api/v1/item-searches` records an `item_searches` row and a linked `system_jobs` item; the browser polls that record but does not own its execution. Leaving an item page therefore stops only browser polling. The worker continues the search, and a later visit restores its current state and accumulated results. Music manual searches persist each ranked indexer batch as that indexer finishes, so the polling browser renders accumulating, de-duplicated results without waiting for every indexer or query variant. Film and Series aggregation timing is unchanged. Selecting a Music result is submission rather than another search: album and discography selections go directly through subject appraisal and download-client acceptance, retain their decision evidence, and return as soon as the client accepts or rejects them. Dashboard Manual Search can target any combination of configured, enabled indexers; omitting the selector restriction retains the existing all-enabled-indexers behavior, and the server intersects supplied IDs with enabled runtime instances before searching.

Automatic and quick Music album searches hydrate missing track metadata first, persist the deterministically selected official MusicBrainz release and expected track count, establish artist/album identity, and reject explicit samplers, previews, partial releases, single/EP type mismatches, and declared track counts below expected coverage before audio quality is ranked. Existing local track rows backfill a zero stored count. Deep Music searches retain the broader manual-review behavior. Album identity normalization treats straight, typographic, and omitted possessive apostrophes consistently, so tracker spellings such as `Pepper's`, `Pepper’s`, and `Peppers` match the same stored title. Discography searches require the artist plus a discography/collection/year-range marker and retain their results through the same durable contract. Each artist discography scan issues only `<artist> discography`; the artist page displays that exact phrase and the durable search options retain it for restored jobs.

Music keeps the conceptual album (MusicBrainz release group) separate from its concrete releases. Opening an album's metadata modal loads and caches its official and alternate MusicBrainz releases, including release date, country, status, disambiguation, packaging, barcode, label, media formats, disc count, and concrete tracklist. Its scrollable **Releases** tab lists every cached edition and lets the user choose the acquisition target without changing the conceptual album year. The immediate local filter matches all entered terms across edition name, provider title, date, country, status, label, packaging, barcode, and media format without refetching releases. Each row uses the MusicBrainz disambiguation or distinct release-title qualifier as its primary edition name (for example, `Super Deluxe Edition` or `2009 Remaster`); date and country remain supporting metadata, with format/original-release fallbacks when MusicBrainz has no edition name. For a missing album, selection rebuilds the projected track rows from that concrete tracklist while preserving monitoring choices by recording identity or normalized title. An album with acquiring or collected tracks may switch between editions only when every normalized track title maps one-to-one; Archivist updates release IDs, numbering, and duration in place while retaining row IDs, statuses, and file ownership. A genuinely different tracklist remains blocked so edition selection cannot disconnect acquired files.

Quick and automatic searches add the selected release's differing year, disambiguation, and significant physical format to the indexer query. Completeness appraisal uses the selected track count and rejects a candidate that advertises a different release year, omits a selected deluxe/remaster/expanded/anniversary/mono/stereo marker, or conflicts with a selected vinyl/SACD/cassette format. Albums without a cached selected release retain the legacy release-group behavior.

Automatic Music grabs require at least two reported seeders so a lone peer—which may be Archivist's own tracker announcement behind NAT—cannot make an otherwise dead swarm look viable. Quick/deep results remain visible and manually selectable; the floor applies only to automation.

Automatic Music selection has one 15-second overall search budget shared by its specialised search, generic fallback, and query variants; each individual indexer attempt is capped at eight seconds. Artist-discography automation stops after its first eligible pack instead of waiting for the remaining naming variants. This bounds degraded public indexers without changing exhaustive quick/deep result searches or the Film and Series search paths.

Subject-associated Music album grabs—including durable auto-search, manual result selection, bulk/scheduled work, RSS decisions, and the synchronous album-auto compatibility route—use the shared Music acquisition decision path. Candidate acceptance and rejection, Music scope and audio-quality scoring, blocklist outcomes, submission results, and source are retained in acquisition history. Manual selection can override saved quality preferences, but it does not bypass album identity, full-album scope, or blocklists. Album and wanted/missing track state advances only after the download client accepts the release.

Music search results retain both the indexer's download/enclosure URL and its magnet when both exist. Submission tries the enclosure first because valid bencoded torrent data already contains the file metadata, then falls back to the magnet if the enclosure is stale, HTML, or rejected. When a Music indexer exposes only a details page, Archivist checks the blocklist again after resolving that page to its canonical info hash. If the resolved swarm was already retired or deleted, album acquisition skips it and tries the next eligible release in the same ranked candidate set. This prevents a misleading indexer seeder count from repeatedly returning an album to a known metadata-stalled magnet.

Magnet metadata discovery allows the connection layer enough time to negotiate encryption, retry plaintext, and complete the extension handshake. Tracker and DHT peers that fail once may be retried after a bounded cooldown, up to a fixed attempt cap; they are not permanently suppressed for the remainder of the metadata window. Built-in-engine Music magnets use a five-minute metadata deadline by default (`MUSIC_TORRENT_METADATA_TIMEOUT_MINUTES` overrides it); other media retain the session-wide deadline. A Music timeout is recorded as observed swarm evidence, blocklists that hash, resets only the correlated album or artist acquisition, and queues a normal automatic search for the next eligible candidate. Fallback is capped at three failed hashes per subject in 24 hours.

Successful and failed Music metadata outcomes are persisted in `music_swarm_observations`. A known failed hash is heavily demoted (and independently rejected by the blocklist); a proven hash is promoted; after at least three observations, an indexer's recent observed metadata success rate provides a bounded tie-break adjustment. Audio quality and subject completeness remain the primary ranking rules.

Music artist and album detail responses correlate their acquisition hash with the live torrent runtime and expose the runtime phase. The client distinguishes submission, queued work, torrent-metadata retrieval, verification, downloading, completion, and error instead of showing zero-percent “downloading” while a magnet is still retrieving its file list.

For Music correlation, each successful decision retains the download client's runtime torrent ID and info hash when available. The monitor resolves runtime ID first, info hash second, and only then a unique exact normalized release title. A later match backfills the acquisition decision and album/artist state; ambiguous title matches are marked ambiguous and left for review rather than guessed. This applies to albums and artist discographies.

An artist-discography torrent records ownership only on albums whose files match that pack. Orphan, terminal-torrent, and completed-import reconciliation reset or release those exact child album/track states. An album that has subsequently acquired its own torrent hash is treated as a takeover and is not reset with the parent discography. Migration 44 also retires stale legacy null-hash Music acquisitions that have neither an active discography parent nor a correlated album decision; it does not touch collected files.

Music album import planning assigns source files to concrete track IDs and reports missing monitored tracks, unmatched files, and duplicate candidates. Execution uses only that reviewed mapping. An album becomes `collected` only when every monitored track has a collected file; partial coverage produces album and media-import state `partial`, returns unmatched monitored tracks to `missing`, and leaves unmatched or duplicate source files staged. Discography execution applies a separate plan to each album-specific folder and never substitutes the entire discography root when an album folder cannot be found.

The dedicated `searches` lane defaults to concurrency `1`, so item searches are processed in FIFO job order. Opening another film, series, season, episode, Music album, or Music artist and starting a search adds independent work behind the current item. An active search with the same library, subject, and mode is deduplicated rather than enqueued twice. `ARCHIVIST_JOB_CONCURRENCY_SEARCHES` may raise local concurrency, but doing so intentionally relaxes serial execution.

Quick and deep/manual results, failure details, and completion state remain available for 15 minutes after the search finishes, fails, or is cancelled. Returning during that window restores the result list; expired rows are removed on subsequent item-search access. Auto modes also run without a page connection and update acquisition state directly; their result list is not presented as a manual selection list.

## RSS pipeline

The orchestrator starts after a five-second delay and ticks every 30 seconds. Each indexer retains its own last-poll, cursor, health, failure, and backoff state in SQLite. Only enabled indexers whose `settings.rss` is not false participate. Indexers are ordered by RSS priority and bounded to four concurrent polls.

A poll fetches recent releases, deduplicates/cursor-filters them, parses titles, identifies monitored subjects, records decisions, and grabs accepted releases. Feed health/backoff prevents a failing indexer from being hammered. Forced refresh is available through release-pipeline routes.

## Indexer endpoint failover

### Definition source and selection

Archivist executes the YAML definitions from Jackett's canonical [`src/Jackett.Common/Definitions`](https://github.com/Jackett/Jackett/tree/master/src/Jackett.Common/Definitions) directory. They are stored under the configured repository-local definitions directory (`./data/indexer-definitions/jackett` by default). Repository-owned custom definitions live separately in `./config/indexer-definitions` (or `ARCHIVIST_CUSTOM_DEFINITIONS_PATH`) and load after Jackett, so a custom file with the same ID intentionally overrides upstream. Unless `DEFINITIONS_OFFLINE=true`, each server runtime performs an ETag-aware upstream check when its saved sync is older than seven days and repeats that check weekly. The first successful Jackett refresh removes the previously managed Prowlarr `definitions/` tree but never changes the custom directory. A changed archive is loaded into the running definition registry without requiring a restart. An unchanged response advances the check timestamp so restarts do not repeatedly contact GitHub.

The Add Indexer selector supports combined name/ID, access (`public`, `semi-private`, or `private`), language, and media-capability filters. Media capabilities are derived from the definition's declared search modes and Torznab category mappings, rather than from the user's later per-workflow enablement choices.

Endpoint health measurement is deliberately separated from live acquisition traffic. Automatic and reactive probes make one representative request per endpoint and do not use CloudflareBypass; a manual Resolve may use the bypass, subject to its dedicated concurrency limit, and probes mirrors sequentially. Reactive/onboarding resolution stops as soon as it proves a direct or browser-assisted endpoint healthy.

The Base URL saved in the indexer form is the user's preferred endpoint, not merely an initial value. Archivist reconciles it with the endpoint candidate set, pins it without changing a definition-managed endpoint into a user-managed endpoint, and keeps the saved preference distinct from a temporary healthy failover. A definition refresh cannot replace that preference with its first/default link. A proven healthy alternative may still carry traffic while the preferred endpoint is degraded or down; the resolver returns automatically when the preference becomes healthy again.

An active indexer fails over only to an endpoint previously measured as tier A (direct) or tier B (CloudflareBypass). Unknown, degraded, and dead mirrors never receive speculative live retries. When no proven replacement exists, Archivist retains the current URL and schedules measurement instead of cycling through untested mirrors. Manual mode always retains its configured endpoint, and a rate-limit cooldown never clears the active selection.

A successful real search is stronger evidence than an older synthetic probe: it immediately restores the active endpoint to direct or CloudflareBypass health and clears stale failure state. Empty query results and selector misses do not trip the live-search circuit breaker.

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

Music item searches include named per-indexer failures when no usable result survives. Cardigann Music category aliases such as `Music`, `/music`, and `Music/FLAC` are normalized to the Torznab Audio tree before strict category filtering.

## Music state audit and repair

Legacy Music state can be inspected without mutation through `GET /api/v1/system/music-repair/audit`. It reports null-hash album/discography acquisitions, deterministic runtime matches, incomplete albums incorrectly marked collected, and suspicious sampler decisions or hash-linked torrents. For acquisitions predating decision records, a repair is proposed only when one active torrent uniquely contains both artist and album identity (or artist plus a discography marker). The response is always a dry run.

After reviewing issue IDs, `POST /api/v1/system/music-repair/apply` requires an explicit JSON body containing `{"apply":true}` and optionally `libraryId` and `issueIds`. It applies only deterministic torrent correlation and collected-to-partial corrections, in one transaction, and records maintenance events. Unresolved or suspicious acquisitions remain report-only.

## Existing Music files

The Import Files scanner includes Music library roots. It groups supported audio files by album folder (folding `CD1`, `Disc 2`, and equivalent subfolders into one candidate), skips track paths already owned by the database, and matches artist/album folder identity against existing Music albums. High-confidence matches use the existing auto-adopt preference; ambiguous folders enter the same review workflow. Adoption queues a normal Music album import and remains in place by default. Normalise Layout is the explicit opt-in that may reorganize files.

## Delivery guarantee

Archivist will schedule and attempt automatic acquisition when the prerequisites above are met. It cannot guarantee availability, indexer correctness, provider uptime, title mapping, or peer health. Documentation and UI should say “automatically attempts and queues accepted releases,” not “will download every release.”
