---
title: Music service end-to-end review
document_type: assessment
status: active
updated: 2026-08-22
related:
  - music-acquisition-parity-plan.md
  - ../04-features/acquisition/acquisition-and-release-monitoring.md
  - ../01-foundation/known-limitations.md
  - ../05-media-domains/README.md
---

# Music service end-to-end review

## Purpose and scope

This assessment reviews Music from artist discovery through metadata, monitoring, release search, appraisal, torrent acquisition, progress reconciliation, import, organisation, existing-library adoption, and Admin presentation. It compares the delivered Music lifecycle with Films and Series without proposing changes to either of those domains.

The review is based on the repository and a read-only live-state snapshot captured at **2026-08-21 19:47 UTC**. Live counts are evidence from one installation, not product invariants. Implementation truth remains the code, schema, and tests.

## Executive conclusion

> **Implementation update — 2026-08-22:** Phase 1 has started. Migrations 44–46 and the Music acquisition services now give discography child albums explicit hash ownership, reconcile those children on orphan/terminal/import completion while preserving album takeovers, retire safe legacy null-hash orphan state, backfill local track counts, hydrate/persist a deterministic MusicBrainz release and expected coverage before appraisal, retain observed torrent-metadata outcomes, and model selectable concrete MusicBrainz releases beneath each conceptual release group. Selected releases retain edition provenance and their own tracklist and constrain quick/automatic search identity. Selected discography results submit directly through appraisal rather than re-entering the search queue; automatic Music searches share one bounded overall deadline; torrent enclosures are preferred with magnet fallback; metadata failure automatically blocklists and advances to the next candidate within a capped retry policy; observed swarm performance contributes a bounded ranking adjustment; and Music detail pages distinguish torrent-metadata retrieval from downloading. The findings below retain the 2026-08-21 evidence that motivated the work; tag-aware import and collected multi-edition coexistence remain in the programme.

Music has most of the necessary components, but they do not yet form a lifecycle as coherent or failure-tolerant as Films and Series.

The difference is partly external: public Music torrents commonly have fewer peers, less reliable reported seeder counts, older tracker lists, ambiguous release names, and many competing editions. The same indexer and torrent engine therefore receives worse evidence than it does for current films and television.

That does **not** fully explain the experience. Music also has internal maturity gaps:

- an artist-discography torrent can disappear while its child albums remain permanently marked `acquiring`;
- stored album track counts are always zero, weakening automatic rejection of incomplete releases;
- acquisition judges a torrent from indexer-reported seeders but does not verify that metadata or a usable peer is reachable before committing UI state;
- MusicBrainz ingestion is capped at the first 100 release groups and selects the first release in a group as the tracklist, without an edition policy;
- imports are driven mainly by folder and filename text rather than embedded audio tags and MusicBrainz identifiers;
- several long-running operations are owned by an HTTP request or the browser rather than a durable job;
- the Admin page performs broad refreshes, hides partially collected artists from both collection filters, and does not expose enough acquisition phase information to explain a stalled album;
- compatibility routes can bypass the subject-aware decision ledger.

The result is a service that can complete successful acquisitions, but feels less deterministic when evidence is sparse or anything goes wrong. The highest-value work is not a visual redesign. It is to make state reconciliation, release completeness, swarm viability, and import identity explicit, durable, and observable.

## End-to-end capability map

| Stage | Delivered Music behavior | Difference from Films and Series | Assessment |
|---|---|---|---|
| Discover artist | MusicBrainz artist search, metadata, relations, Fanart.tv artwork | Provider calls are process-local rate limited and artist creation performs catalogue/artwork work inside the request | Functional, fragile under latency |
| Build catalogue | Release groups become albums; tracks are fetched lazily | First 100 release groups only; no release-edition model; selected tracklist is the first release returned | Material identity gap |
| Monitor | Artist monitoring cascades to albums; album policies are mirrored | State vocabulary exists, but discography child state is not reconciled on orphan reset | P0 correctness gap |
| Search | Album and discography quick/deep/auto searches use durable item-search jobs | “All Releases” remains a browser-owned serial loop; compatibility search/grab surfaces remain | Mostly durable, inconsistent edges |
| Identify release | Artist/album title, album type, sampler/partial terms, year and quality parsing | No reliable expected track count in stored album rows; edition, media count and tag identity are absent | P0 completeness gap |
| Rank release | Audio quality ladder, target policy, blocklist, minimum automatic seeders | Seeder count is reported by the indexer, not verified against the swarm; quality can dominate availability | Correct policy, weak availability evidence |
| Submit torrent | Shared download-client path; magnet resolution; decision/torrent correlation | Metadata may take up to the engine timeout; the item enters acquiring before viability is proved | Operationally slow on dead swarms |
| Reconcile progress | Runtime ID/hash/exact-title recovery; album share within discography packs | Null-hash child albums can survive after their parent discography is retired | P0 stuck-state gap |
| Import album | Explicit plan, matched/missing/duplicate roles, partial state, supported audio extensions | Filename and track-number matching; no embedded tag or release-ID matching | Good safety, lower confidence |
| Import discography | Per-album folder matching; no whole-root fallback; partial state | Album-folder title containment is vulnerable to deluxe/live/remaster and same-title collisions | Safer than before, still heuristic |
| Adopt existing files | Scan groups album folders, auto-adopts confident matches and queues ambiguity | Identity is path/name based and artwork is limited for scan-created albums without a release-group ID | Useful but not metadata-rich |
| Operate in Admin | Artist/album state, progress, search modes, result selection and repair tooling | Broad activity reloads, binary filters omit partial artists, and acquisition phase is not visible | Main source of “not slick” feedback |

## Findings

### P0 — child albums can remain acquiring after a discography torrent disappears

`monitorMusic` retires a stale artist discography by clearing `artists.discography_info_hash`, `discography_status`, and progress. It does not reset albums that the pack marked acquiring. Album orphan handling only resets an acquiring album when that album has an `info_hash`; discography child albums normally do not.

The live snapshot showed the consequence:

- the embedded torrent runtime snapshot was empty;
- 16 albums were still `acquiring`;
- all 16 had null album info hashes;
- 103 tracks were still `acquiring` with no file paths;
- the artist no longer had an active discography state.

This is a deterministic state-machine hole, not a seeder problem. A parent acquisition must own its child state explicitly. Retiring, failing, cancelling, or completing the parent must reconcile every child that was advanced by that parent, without touching already-collected files.

Acceptance criteria:

- child albums/tracks record which artist acquisition advanced them, or an equivalent durable relation;
- orphan, failure, cancellation, and import completion reconcile only those children;
- a null-hash acquiring album cannot remain indefinitely without an active parent or album decision;
- restart and torrent-removal tests cover the transition.

### P0 — expected album completeness is effectively unknown

MusicBrainz release-group ingestion writes `trackCount: 0`, and album inserts do not persist a later expected count. In the live database, all 66 album rows had `track_count = 0`, even though 295 track rows existed. Artist detail computes a display count from the track table, but automated appraisal reads `albums.track_count` directly.

Consequently, the release-scope logic can reject explicit “sampler”, “preview”, and partial-title signals, but cannot reliably reject a candidate whose declared track count is lower than the album expected count. This weakens one of the most important protections in a domain full of samplers, bonus editions, split discs, and partial uploads.

The tracklist also comes from the first MusicBrainz release returned for a release group (`limit: 1`). There is no persisted selected release ID, country, format, medium count, barcode, or edition rule. The chosen tracklist may therefore describe a different edition from both the user’s intent and the acquired torrent.

Acceptance criteria:

- persist an authoritative expected track count derived from a selected MusicBrainz release;
- retain the selected release ID and enough edition provenance to explain the choice;
- define a deterministic release-selection policy, with manual override for ambiguous groups;
- use expected tracks/media in automatic completeness checks and import reporting.

### P1 — reported seeders are not proof of a viable acquisition

Automatic Music selection now requires at least two indexer-reported seeders and the metadata engine retries peers. Those changes remove the worst zero/one-seeder automatic choices, but they do not establish that a peer will answer the BitTorrent metadata extension or that the swarm still contains the payload.

Music is affected more than Films and Series because older album torrents often have stale tracker counts and a small, intermittent swarm. A release can therefore rank well, enter `acquiring`, and spend the metadata timeout waiting for evidence that was never real.

Recommended design:

1. Separate **candidate appraisal** from **swarm verification**.
2. For automatic Music only, probe the top bounded set for metadata/peer viability before committing the subject to acquiring.
3. Fall through to the next accepted candidate when a probe fails, recording the resolved hash and reason in the decision ledger/blocklist.
4. Keep manual selection permissive, but label unverified or sparse releases clearly.
5. Track time in `resolving metadata`, `downloading`, `stalled`, and `importing` as distinct phases.

This should be bounded and cancellable. It must not turn every search into an open-ended swarm crawl.

### P1 — provider ingestion is synchronous, truncated, and not restart-safe

Adding an artist performs MusicBrainz lookups, album enumeration, directory creation, and artwork work before the request completes. Refreshing one artist has similar behavior. Global Music refresh returns immediately but starts an untracked async loop in the API process; it has no durable progress record and is lost on restart.

`getArtistAlbums` requests `limit: 100` without paging, so large catalogues are silently truncated. The process-local two-second MusicBrainz limiter coordinates only one process lifetime, has no durable cache, and uses a placeholder repository URL in its User-Agent.

Recommended design:

- create the artist promptly, then enqueue durable metadata hydration;
- page all selected release-group types, with progress and restart-safe checkpoints;
- cache provider responses by MBID with provenance and refresh timestamps;
- move global and per-artist refresh onto the worker queue;
- configure an honest MusicBrainz contact identity and respect response retry guidance.

### P1 — audio identity is weaker than the domain requires

Album import has become deliberately conservative: it constructs a plan, distinguishes matches/missing files/duplicates, avoids whole-root fallback, and leaves incomplete albums `partial`. That is a strong base.

However, matching still relies primarily on normalized album/track text and disc/track numbers parsed from paths. Discography routing uses normalized album-title containment in paths. Archivist does not use embedded ID3/Vorbis/MP4 tags, embedded MusicBrainz IDs, album artist, disc totals, track totals, barcode/catalogue number, or acoustic fingerprints to establish identity.

This is much more consequential for Music than for video. A film commonly has one primary video file, while a series has explicit `SxxEyy` identity. An album can have multiple discs, repeated track titles, deluxe/remaster/live editions, bonus tracks, featured artists, vinyl side numbering, and folder names chosen by an uploader.

Recommended matching order:

1. embedded MusicBrainz release/recording IDs;
2. selected release identity plus disc and track number;
3. album artist/title/year plus tagged track title;
4. filename/path heuristics;
5. optional Chromaprint reconciliation for ambiguous unmatched audio.

Every fallback should retain confidence and provenance in the import plan. Low-confidence cross-edition matches should remain staged for review.

### P1 — durable workflows have compatibility bypasses

Album and artist-discography item searches are durable and use the bounded search lane. Subject-associated album grabs use the recorded decision path. Two edges remain inconsistent:

- `POST /music/artists/:id/grab-discography` submits directly to a client and advances artist state without the shared artist decision flow;
- `POST /music/download` accepts an unassociated URL when no album ID is supplied and cannot create a meaningful subject decision.

These routes make history, blocking, correlation, and failure semantics depend on which UI or caller initiated the same conceptual action. They should either become explicit low-level operator tools with clear labeling or delegate to one subject-aware orchestration service.

The artist acquisition-history endpoint also returns child album history only. Artist-level discography decisions are absent, so the page cannot provide a complete explanation of artist acquisition activity.

### P1 — Admin state and feedback obscure what is happening

The Music Admin module is a large component that owns catalogue display, metadata editing, search polling, result selection, bulk orchestration, progress, and filters. Both library and artist screens subscribe to generic activity and broadly reload their data after a debounce. This is functional at the current library size but creates avoidable churn and makes state transitions visually coarse.

Specific defects and friction:

- an artist with some collected albums, no active downloads, and remaining missing albums is neither “Missing” nor “Collected”; it appears only under “All”;
- “All Releases” calls album acquisition sequentially from the browser, so leaving the page skips the remaining albums;
- acquisition feedback does not clearly distinguish queued search, indexer query, resolving URL, resolving magnet metadata, downloading, stalled, import queued, importing, partial, and failed;
- the UI does not surface the selected torrent name/hash, actual peer state, last progress time, decision rejection summary, or import job on the album row;
- generic activity can refresh an entire artist when only one search/progress record changed.

Recommended UI/service boundary:

- use a durable artist acquisition command for “All Releases” and expose its child work;
- represent `missing`, `partial`, `acquiring`, and `collected` as mutually comprehensible filters;
- load artist details, album states, search results, and activity independently;
- render cached state immediately and apply event-specific updates;
- add a compact acquisition phase/status disclosure rather than more permanent card chrome.

### P2 — the catalogue model is release-group-centric rather than library-edition-centric

Albums are keyed to MusicBrainz release groups. That is useful for grouping, but insufficient for a library that acquires concrete editions. Quality fields describe the current torrent, yet there is no first-class relation between the acquired files and a specific MusicBrainz release/edition.

This limits edition-aware upgrades, accurate tracklists, artwork selection, multi-disc handling, and explanations such as “collected 2011 remaster; target original CD.” A future schema should preserve the release group as the conceptual album while adding a selected/collected release identity and provenance. It should not explode every provider release into the main artist page by default.

### P2 — operational metrics and tests stop short of the failure boundary

The repository has meaningful Music tests for CRUD/e2e routes, quality and scope parsing, audio filename parsing, discography import plans, import completeness, library scans, category normalization, durable item searches, ratings, and file metadata. Recent work materially improved this surface.

Missing coverage is concentrated where the real failures occur:

- no end-to-end test from indexer result through URL resolution, magnet metadata, torrent completion, import, and final file/DB state;
- no focused metadata-fetcher peer-retry/timeout test in the torrent-engine package;
- no restart/orphan test for a discography parent and acquiring child albums;
- no MusicBrainz pagination or release-edition selection test;
- no contract test proving persisted expected track counts reach appraisal;
- no tag-based or ambiguous-edition import fixtures;
- no Admin component tests for partial filtering, restored search state, navigation during bulk work, or phase display;
- no artist history test combining artist-level and album-level decisions.

## Live-state observations

The live database snapshot is small enough that raw catalogue size is not the present performance bottleneck:

| Measure | Snapshot |
|---|---:|
| Artists | 5 |
| Albums | 66 |
| Tracks | 295 |
| Collected albums | 10 |
| Missing albums | 40 |
| Acquiring albums | 16 |
| Collected tracks with valid stored paths | 153 |
| Collected track paths missing on disk | 0 |
| Acquiring tracks | 103 |
| Album rows with stored `track_count = 0` | 66 |
| Artists omitted by both Missing and Collected filters | 1 |
| Active torrent runtime entries | 0 |

Positive evidence:

- all 153 collected track paths existed on disk;
- no collected track had a null path;
- the service and worker were healthy at capture time;
- recent Music decisions contained recorded candidate acceptance/rejection and resolved torrent correlation;
- successful import validation events exist.

Concerning evidence:

- acquiring child state remained after the torrent and parent discography state were gone;
- automatic decisions accepted candidates that were not ultimately grabbed, which is valid only if the UI exposes the subsequent submission/fallback outcome clearly;
- recent provider results demonstrate the domain ambiguity directly, including samplers and format/edition variants for the same nominal album.

No live data was changed during this assessment.

## Why Films and Series feel more advanced

Films and Series benefit from stronger identity signals and simpler file topology:

- TMDB/TVDB/IMDb IDs, title/year, season/episode numbers, air times, and pack coverage constrain search and import;
- a film normally resolves to one primary video, and an episode has a durable `SxxEyy` address;
- series automation can cascade series → season → episode based on completed seasons and coverage;
- availability is generally better for current mainstream video releases;
- video monitoring and import have broader lifecycle test history.

Music combines weaker supply with a harder identity problem: conceptual album versus concrete release, multi-disc layouts, bonus material, artist aliases, featured artists, tag quality, and many files per acquisition. Reusing the video-shaped state machine without first-class edition and track identity leaves more decisions implicit.

The appropriate parity target is therefore not identical code or UI. It is identical operational guarantees: durable work, explainable decisions, bounded retries, exact ownership of state transitions, safe imports, restart recovery, and a clear next action after failure.

## Prioritized implementation programme

### Phase 1 — restore state-machine correctness

1. Model and reconcile discography-owned child album/track state.
2. Repair current null-hash orphan states through the existing dry-run-first Music audit flow.
3. Persist expected track counts and selected release provenance.
4. Add regression tests for restart, torrent removal, failure, cancellation, and incomplete candidates.

Exit condition: no Music subject can remain acquiring without an active acquisition/import owner, and automatic completeness decisions use non-zero expected coverage when provider tracks are known.

### Phase 2 — make acquisition availability-aware and explainable

1. Add bounded automatic swarm verification with candidate fallback.
2. Unify compatibility grabs behind subject-aware decision orchestration.
3. Include artist and album decisions in artist history.
4. Expose explicit acquisition phases, timestamps, selected release, peers, and failure reason.

Exit condition: a dead first-choice magnet automatically falls through or reaches a clear terminal state, and the operator can explain every transition from the UI/history.

### Phase 3 — make provider and bulk work durable

1. Move artist creation hydration, artist/global refresh, and All Releases orchestration to jobs.
2. Page MusicBrainz release groups and cache provider snapshots.
3. Define and persist release-edition selection.
4. Split Admin data loading by resource and event type; correct partial filters.

Exit condition: navigation or process restart does not lose intended work, large catalogues are complete, and routine progress does not force broad reloads.

### Phase 4 — raise import identity confidence

1. Read embedded tags and MusicBrainz IDs into import plans.
2. Match by release/recording identity before path heuristics.
3. Add explicit ambiguous-edition review and optional Chromaprint fallback.
4. Build a real torrent-to-library integration fixture across album and discography cases.

Exit condition: common multi-disc, deluxe/remaster, duplicate-title, and featured-artist cases are deterministic or explicitly held for review.

## Success measures

Track these separately for automatic album and discography acquisitions:

- median and p95 time from search start to first accepted candidate;
- median and p95 time in metadata resolution;
- percentage of automatic first choices that obtain metadata;
- fallback success rate after an unviable first candidate;
- acquisitions that end without a terminal state;
- acquiring subjects with no active decision, torrent, or import owner;
- complete, partial, unmatched, and duplicate rates at import;
- percentage of imported tracks matched by embedded ID, tags, number/title, and path fallback;
- provider refresh completion/retry rate and catalogues truncated by paging failures;
- broad artist/library reloads per acquisition event.

The key product target is: **every Music action either progresses durably or reaches an explainable terminal state with a safe retry path.**

## Evidence map

- Provider ingestion and tracklists: `apps/server/src/modules/music/musicbrainz.ts`
- Music HTTP orchestration and history: `apps/server/src/modules/music/routes.ts`
- Durable searches: `apps/server/src/services/item-searches.ts`
- Candidate scope and quality: `apps/server/src/release-pipeline/music-quality.ts`, `apps/server/src/release-pipeline/subject-decisions.ts`
- Download resolution and metadata: `apps/server/src/services/download-manager.ts`, `packages/torrent-engine/src/metadata-fetcher.ts`
- Progress/orphan reconciliation: `apps/server/src/shared/monitor.ts`
- Import planning/execution: `apps/server/src/services/media-imports.ts`, `apps/server/src/shared/music-files.ts`, `apps/server/src/shared/media-organizer.ts`
- Existing-library adoption: `apps/server/src/services/library-scan.ts`
- Audit/repair: `apps/server/src/services/music-repair.ts`
- Admin behavior: `client/src/modules/music/index.tsx`, `client/src/lib/music.api.ts`
- Data model: `packages/db/src/schema.ts`
- Focused tests: `apps/server/test/music-*.test.ts`, `apps/server/test/discography-import-plan.test.ts`, `apps/server/test/item-searches.test.ts`, `apps/server/test/indexer-music-categories.test.ts`
