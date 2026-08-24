---
title: Music acquisition and import parity plan
document_type: plan
status: historical
classified: 2026-08-21
related:
  - music-service-end-to-end-review.md
  - ../04-features/acquisition/acquisition-and-release-monitoring.md
  - ../05-media-domains/README.md
---

# Music acquisition and import parity plan

## Objective

Bring Music search, acquisition, torrent monitoring, import, and existing-library adoption to the same operational standard as Films and Series.

This work must not change established Film or Series behavior. Shared infrastructure may be extended for Music only when existing Film and Series contracts and tests remain unchanged.

## Status of this document

This is the implementation record for the first Music parity slices performed on 2026-08-21. Its point-in-time findings and outstanding lists are retained to explain that work and must not be used as a current backlog.

The current assessment and prioritized programme is [Music service end-to-end review](music-service-end-to-end-review.md).

Implementation truth remains in the code, schema, and tests. The canonical description of delivered acquisition behavior is [Acquisition and release monitoring](../04-features/acquisition/acquisition-and-release-monitoring.md).

## Implementation progress

### 2026-08-21: durability, correlation, repair, indexers, and existing-library discovery

Implemented:

- Artist discography quick, deep, and selected-release auto-grabs now use durable item-search jobs, restore retained results, and continue independently of browser navigation.
- Successful acquisition decisions persist runtime torrent IDs, info hashes, and correlation state. Music monitoring resolves runtime ID first, hash second, and unique exact title last for albums and discographies.
- A dry-run-first Music audit/repair API reports legacy null-hash acquisitions, incomplete collected albums, unresolved cases, and suspicious sampler decisions/hash links. It can identify pre-ledger acquisitions only from one unique active artist+album (or artist+discography) torrent match. Explicit apply repairs only deterministic correlations and collected-to-partial state and records maintenance events.
- Music category aliases, including provider `Music` and `Music/FLAC` forms, normalize to the Torznab Audio tree. Empty Music searches retain named per-indexer failure summaries.
- Existing-library scanning discovers supported audio, groups multi-disc album folders, skips owned track paths, matches existing artist/album records, and sends ambiguous albums to review. Adoption is in-place by default through the Music album import pipeline.

Operator follow-up remains required: run the audit against the deployed database, review its output, and explicitly apply selected repairs. The implementation does not silently rewrite live state.

### 2026-08-21: first P0 correctness slice

Implemented:

- Automatic album selection now establishes artist and album identity before quality ranking.
- Explicit samplers, previews, partial releases, single/EP type mismatches, and declared track counts below the expected album count are rejected from automatic selection.
- Quick album searches use the same scope guard; Deep searches remain unrestricted for manual review.
- Album auto-grab now returns a failed result when the download client rejects the release and does not advance album or track state.
- Successful album auto-grab advances both `wanted` and `missing` tracks to `acquiring`.
- Focused Music quality/scope regression tests cover the Morgan Wallen sampler case, identity mismatches, partial track counts, quality ordering after scope validation, and legitimate album titles containing `Sampler`.
- Music album quick, deep, and auto searches now use durable `item_searches` and `system_jobs` records in the bounded search lane.
- The Admin client restores retained album results when an album is expanded and resumes polling active work; navigation stops only browser polling.
- Schema migration 41 preserves existing item-search rows while extending the queue constraints with Music albums.
- Item-search API coverage verifies Music queueing, restoration, deduplication infrastructure, and cross-library isolation.
- Durable auto-search, the synchronous album auto compatibility route, and manual album-result grabs now use the shared Music decision implementation.
- The shared Music decision implementation records candidate acceptance/rejection, applies album scope and blocklist rules, ranks on the audio-quality ladder, records successful grabs, and advances wanted or missing tracks only after submission succeeds.
- Explicit manual selection may override saved quality and upgrade preferences without bypassing identity, full-album scope, blocklist, or acquisition-history records.
- Focused API coverage verifies that failed manual submissions remain audited without changing album state and that blocklisted Music releases are rejected and recorded.
- Music grabs recover an info hash from the final resolved magnet when the client omits it. If the hash is still delayed, the monitor can correlate a unique exact runtime torrent title with the latest successful album decision; ambiguous matches remain unlinked.
- Music album import plans now distinguish matched tracks, missing monitored tracks, unmatched files, and duplicates. Execution consumes that exact mapping instead of rematching permissively.
- Albums with some imported tracks remain `partial`; missing monitored tracks return to `missing`, duplicates and unmatched files remain staged, and only complete monitored-track coverage marks an album collected.
- Discography execution no longer falls back to the whole torrent root for an unmatched album. Each located album folder gets its own reviewed plan, and artist discography state reports `partial` until all monitored albums are complete.

Still outstanding from P0:

- Operator-reviewed application of repairs to the live database after deployment.
- Manual disposition of non-deterministic cases such as a sampler acquired for the wrong album.

## Executive finding

Music has many of the same individual components as Films and Series, including quality parsing, release-pipeline identification, download-client integration, torrent monitoring, import planning, media organisation, acquisition history endpoints, and manual torrent matching.

At the time of the initial review, those components were connected through two different workflows:

1. Background Music acquisition uses parts of the shared release decision pipeline.
2. Interactive Music searches and grabs used separate synchronous routes that bypassed durable item searches and much of the shared appraisal and acquisition-history machinery.

The first P0 slices moved Admin album quick, deep, and auto searches onto durable jobs, corrected false-success reporting, and joined subject-associated album grabs to the shared recorded decision path. Discography search remains synchronous, and the unassociated `/music/download` compatibility path cannot create a subject decision because it has no album identity. Torrent correlation and import correctness also remain outstanding.

## Comparison with Films and Series

| Lifecycle stage | Films and Series | Music |
|---|---|---|
| Interactive search | Durable worker jobs with progress, cancellation, result retention, and controlled concurrency | Album and artist-discography quick/deep/auto use durable jobs |
| Identification | Title, year, season, episode, and pack-coverage validation | Primarily normalized artist and album title matching |
| Candidate appraisal | Shared decisions, rejection reasons, blocklists, and recorded grab results | Subject-associated album auto/manual, bulk, scheduled, and RSS grabs use the shared recorded Music decision path |
| Completeness | Series packs are coverage-aware | Automatic and quick album searches reject explicit samplers and partial releases; import-time completeness is still outstanding |
| Download result | A rejected download remains a failed acquisition | Rejected submissions remain failed and accepted/rejected candidates are retained in acquisition history |
| Torrent association | Acquisition state is consistently attached to the target | Runtime torrent ID/hash correlation is persisted and reconciled; ambiguous legacy cases remain reviewable |
| Import matching | Files are matched to concrete films, editions, seasons, and episodes | Track-title and zero-padded track-number substring matching |
| Existing-library adoption | Film and Series scanning identifies and adopts existing video files | Music scanning discovers album folders, auto-adopts confident existing-album matches, and queues ambiguity for review |
| Test coverage | Broad lifecycle and item-search coverage | Mostly CRUD, quality parsing, file parsing, and isolated import-plan coverage |

## Live findings on 2026-08-21

The live main database was at schema version 40 with all 40 migrations applied. No database-schema migration failure was found.

The live Music state contained:

- 5 acquiring albums, including 1 without an info hash.
- 106 acquiring tracks.
- 0 Music acquisition-decision records.
- 0 Music media-import records.

For comparison, the same database contained 186 Series acquisition decisions and 64 successful Series media-import records.

### Morgan Wallen examples

`I'm the Problem` was almost complete in the torrent engine with info hash `b95d3a6ad72604bf5c2afef3987e8f8c4d231ef9`, while its album row had no info hash. The Music monitor could not correlate that torrent with the album and therefore could not enqueue its automatic import through the normal hash-based path.

`One Thing at a Time` had been associated with a torrent whose title explicitly contained `Sampler`, despite the album having 36 expected tracks. Music ranking favored the advertised audio quality without first verifying that the torrent represented the complete album.

## Confirmed implementation gaps

### 1. Album and discography search durability (resolved)

`apps/server/src/services/item-searches.ts` supports Music albums and artists, and the Admin client uses it for quick, deep, and auto album/discography work. Legacy compatibility routes remain available but are no longer the Admin workflow.

Consequences include:

- Discography execution remains tied to an HTTP request.
- Discography results and progress are not restored after navigation.
- Album bulk operations now serialize through durable jobs, but the client-side loop still owns enqueueing each subsequent album.

### 2. Interactive acquisition bypasses the shared decision record (resolved for subject-associated album grabs)

The shared release pipeline implements album decisions in `apps/server/src/release-pipeline/subject-decisions.ts`, including candidate recording, blocklist handling, selection, and grab-result recording.

Durable album auto-search, manual result selection, bulk album acquisition, scheduled/RSS work, and the synchronous album auto compatibility route now call the shared Music decision implementation. It applies Music scope and quality scoring, blocklists, candidate recording, grab-result recording, and post-success album/track transitions. The unassociated `/music/download` compatibility path remains direct because no album subject is supplied.

### 3. Album auto-grab false success (resolved in the first P0 slice)

The album auto-grab route previously updated album state only when the download-client result succeeded but reported `success: true` regardless. It now propagates download-client failure and leaves album and track state unchanged.

### 4. Release scope validation (partially resolved)

Automatic and quick album searches now establish basic artist/album identity and reject explicit partial-release markers before quality ranking. Torrent metadata and import-time coverage still need to become the authoritative completeness gate.

The appraisal path needs to identify or reject:

- Samplers and previews.
- Singles or EPs returned for an album request.
- Bonus-disc-only and partial releases.
- Wrong editions and similarly named albums.
- Track-count or disc-count mismatches when torrent metadata is available.

### 5. Torrent correlation can become disconnected (resolved for new acquisitions; repair available for legacy state)

Music monitoring in `apps/server/src/shared/monitor.ts` associates an album torrent using `albums.info_hash` and a discography using `artists.discography_info_hash`.

Music recovers a hash from the final resolved magnet when possible and persists the download client's runtime torrent ID and hash on the successful decision. The monitor resolves runtime ID, then hash, then unique exact title and backfills album/artist state. Ambiguous title-only matches deliberately remain unlinked. The Music repair audit exposes deterministic legacy matches without guessing.

### 6. Partial imports can become collected albums (resolved)

Music planning now assigns exact source files to track IDs, reports missing monitored tracks and duplicate candidates, and execution consumes only those assignments. Album status is derived from monitored-track coverage: complete coverage is `collected`, some coverage is `partial`, and no coverage is `missing`. The durable media-import record is also `partial` when the album is incomplete.

### 7. Discography matching is too permissive (partially resolved)

Discography execution no longer uses the whole-root fallback. It skips albums without an album-specific folder, builds and executes a separate track plan for every located folder, preserves partial album state, and reports partial artist-discography completion. Folder identity matching still needs stronger year/release-group/tag evidence.

### 8. Music indexer results are lost through category mapping (resolved for common aliases)

Service logs showed Music results from indexers whose raw categories were `/music` or `music` but whose normalized category list was empty. Strict Music searches using category `3000` can discard those results.

The same logs showed repeated 403 and 429 responses and Cloudflare browser-pool exhaustion. Inline repeated Music searches magnify these failures.

Search query construction also needs punctuation-safe variants for typographic apostrophes, colons, dashes, and other common artist and album punctuation.

### 9. Existing-library discovery does not support Music (initial implementation delivered)

There are three separate migration concerns:

1. Database schema migrations are current and were not the source of this failure.
2. Library-layout reconciliation supports Music artwork and track path rewrites.
3. Existing-file discovery supports Films and Series, but does not scan audio libraries.

The library scanner now discovers supported audio by album folder, folds common multi-disc subfolders into one candidate, ignores already-owned track paths, matches existing artist/album records, and places ambiguous folders into review. Embedded-tag and MusicBrainz identity enrichment remain future hardening.

### 10. Lifecycle testing is incomplete

Existing Music tests cover useful isolated behavior, including API CRUD, quality grading, audio filename parsing, and discography import planning. They do not prove the complete search-to-import lifecycle.

## Implementation roadmap

### P0: acquisition and import correctness

#### Durable Music search (album work delivered; discography outstanding)

- [x] Extend durable item-search contracts with Music media and album subject types.
- [x] Support album quick, deep, and auto modes.
- [x] Add discography search as an explicit Music subject type.
- [x] Preserve all existing Film and Series item-search behavior.
- [x] Run Music searches in the existing bounded search lane.
- [x] Retain and restore Music album results using the existing item-search lifetime.

#### One Music decision path (subject-associated album work delivered)

- [x] Route interactive, bulk, scheduled, and RSS album candidates through the shared album decision implementation.
- [x] Record each subject-associated candidate, rejection, selected release, download result, and source.
- [x] Apply Music blocklists consistently to every subject-associated album entry point.
- [x] Ensure manual selection can still override quality preferences without bypassing audit records.

#### Accurate download state

- Return a failed API response whenever URL resolution or the download client fails.
- Do not change album or track state after a failed submission.
- [x] Persist a runtime torrent ID/hash/correlation state on successful acquisition decisions.
- [x] Prefer a resolved magnet or torrent info hash; otherwise retain a pending correlation record.
- [x] Reconcile a delayed info hash from the torrent runtime rather than leaving the album disconnected.

#### Full-album validation

- Classify album, single, EP, sampler, compilation, and discography scope before quality ranking.
- Reject obvious sampler, preview, and partial releases for a full-album request.
- Compare expected track and disc counts when metadata is available.
- Treat title, artist, release year, and edition identity as hard or strongly weighted evidence.
- Apply audio quality ranking only after identity and scope validation.

#### Import completeness (delivered)

- [x] Track matched, missing, unmatched, and duplicate tracks explicitly.
- [x] Do not mark an album collected while required monitored tracks remain missing.
- [x] Represent partial import state in the database and UI.
- [x] Leave unmatched files staged for review instead of silently completing the album.
- [x] Make Music import execution honor the import plan rather than independently repeating permissive matching.

#### Repair existing live state

After the correctness changes are deployed:

- Reconcile `I'm the Problem` with info hash `b95d3a6ad72604bf5c2afef3987e8f8c4d231ef9` if the runtime torrent is still present and matches the intended album.
- Remove or rematch the `One Thing at a Time` sampler acquisition.
- Verify all 36 expected tracks before marking `One Thing at a Time` collected.
- Audit every acquiring Music album with a null hash.
- Audit collected albums that still contain missing or acquiring tracks.

### P1: reliability and migration parity

#### Indexer correctness

- [x] Correct Music category normalization for `music`, lossless/FLAC, MP3, and related provider categories.
- [x] Add tests proving provider Music aliases map to the Newznab Audio tree.
- Generate punctuation-safe artist and album query variants.
- Avoid immediately repeating identical failed searches across bulk operations.
- [x] Surface named per-indexer failure summaries in empty Music search results.

#### Existing Music discovery

- [x] Extend library scanning to supported audio extensions.
- [x] Group audio by artist, album folder, and common disc-folder boundaries.
- Match MusicBrainz artist and release-group identities where confidence is sufficient.
- [x] Place ambiguous folders into the existing review workflow.
- [x] Import in place when files already sit under the configured Music root.
- [x] Never move or rename existing audio unless the operator explicitly enables Normalise Layout.

#### Discography safety

- Require an artist-level identity match before considering album folders.
- Match albums using release-group ID where embedded metadata permits it.
- Use folder boundaries, year, disc number, track number, and expected track count.
- [x] Remove the whole-root fallback for an unmatched album.
- [x] Produce an album-by-album plan during execution.
- [x] Report partial discography completion rather than treating one imported album as overall success.

#### Operator visibility

- Show queued, searching, selected, submitted, correlating, downloading, importing, partial, blocked, and collected states.
- Display the associated torrent name and info hash on acquiring albums.
- Link album acquisition history to its torrent and media-import job.
- Provide an explicit repair action for null-hash acquisitions and partial imports.

### P2: parity tests and operational hardening

Add tests proving:

- Music searches continue after browser navigation and worker restart.
- Duplicate active searches are deduplicated.
- A rejected download-client result remains a failed acquisition.
- Interactive and background Music searches create acquisition-decision records.
- A sampler cannot satisfy a full album.
- A partial track import cannot mark an album collected.
- A delayed or initially absent info hash is reconciled safely.
- A completed Music torrent enqueues exactly one media-import job.
- Discography files cannot cross-match between albums.
- Existing audio files can be discovered and reviewed without destructive mutation.
- Film and Series item-search, appraisal, monitoring, and import tests remain unchanged and green.

## Suggested delivery slices

1. Correct auto-grab success handling and add regression coverage.
2. Add full-album identity and sampler rejection before Music quality ranking.
3. Add Music albums to durable item searches. Then route album auto-grab through the shared decision path.
4. Persist reliable acquisition-to-torrent correlation and repair null-hash state.
5. Enforce track-completeness gates and add partial-import state.
6. Harden discography planning and execution.
7. Correct Music category mappings and query variants.
8. Add existing-Music-library scanning and review.
9. Complete end-to-end Music lifecycle tests and operator diagnostics.

## Acceptance criteria

The plan is complete when:

- Music interactive searches are durable and resumable.
- All Music acquisition entry points share one recorded appraisal path.
- The UI never reports a successful grab after client rejection.
- A sampler or partial release cannot mark a full album collected.
- Every acquiring album has a recoverable association with its torrent.
- Completed Music torrents enqueue observable, idempotent import jobs.
- Album state reflects actual imported track coverage.
- Existing Music folders can be safely discovered and adopted.
- Acquisition history explains every Music decision and transition.
- Film and Series behavior and tests remain unchanged.

## Evidence reviewed

- `apps/server/src/modules/music/routes.ts`
- `apps/server/src/services/item-searches.ts`
- `apps/server/src/release-pipeline/missing-search.ts`
- `apps/server/src/release-pipeline/subject-decisions.ts`
- `apps/server/src/release-pipeline/music-quality.ts`
- `apps/server/src/release-pipeline/title-index.ts`
- `apps/server/src/release-pipeline/identifier.ts`
- `apps/server/src/services/download-manager.ts`
- `apps/server/src/shared/monitor.ts`
- `apps/server/src/services/media-imports.ts`
- `apps/server/src/shared/media-organizer.ts`
- `apps/server/src/services/library-scan.ts`
- `apps/server/src/shared/library-migration.ts`
- `apps/server/src/system/admin-routes.ts`
- `client/src/modules/music/index.tsx`
- `client/src/lib/music.api.ts`
- Live SQLite state and `archivist.service` logs inspected read-only on 2026-08-21.
