---
title: "Library Scan Importer — Design"
document_type: feature-specification
status: historical
classified: 2026-08-16
---
# Library Scan Importer — Design

| Field | Value |
| --- | --- |
| Status | Implemented (Phase 1 + 2) |
| Version | 1.0 |
| Date | 2026-07-24 |
| Scope | Discovering and adopting pre-existing on-disk files (films & series) into the Archivist database |

### Implementation status

- **2026-07-24 — Phase 1 (films) + Phase 2 (series) shipped.** Films and series library roots are scanned; unowned video files are parsed, matched (existing item or TVDB/TMDB), and either auto-adopted (confidence ≥ 0.85) or parked in a review queue. Adoption is **in-place by default** (link where the file sits) with an opt-in **Normalise layout** path, both routed through the import pipeline via a new `inPlace` flag. Films create-from-TMDB and series **create-from-TVDB/TMDB with synchronous episode population** are both wired.
- Modules: `services/library-scan.ts` (scan/match/adopt/review), `modules/films/create.ts::createFilmFromTmdb`, `modules/series/create.ts::createSeriesFromMetadata` (lean, awaitable), `services/media-imports.ts` (`inPlace` on the film + single-episode paths), routes under `/system/library-scan/*`, UI on the **Acquisitions → Scan Library** tab, table `library_scan_candidates`.
- Verified by builds + the server test suite; **not** yet runtime-tested end-to-end (needs a live backend, TVDB/TMDB, and files on disk).

## 1. Problem & goal

Archivist can ingest files it **downloaded** (auto-import) and files sitting in the **downloads staging folder** (manual import). It has **no way to adopt files that already live in the library folders** — e.g. a pre-existing movie collection at `media/films/Some Movie (2011)/movie.mkv` that Archivist didn't create.

**Goal:** a "Scan Library" importer that walks the library roots, finds video files not linked to any DB item, identifies what they are, and brings them into the Archivist model — creating the film/series/episode records and linking (or normalising) the files — with a review step for anything it can't confidently match.

Non-goals (v1): music/books/comics/games adoption (film + series only); transcoding/upgrading adopted files; deleting anything.

## 2. Current state (what exists today)

Two ingestion paths exist. Both funnel into one pipeline.

### 2.1 Automatic import
`shared/monitor.ts` watches torrents; on completion+match it calls `queueMediaImport(payload)`.

### 2.2 Manual import (downloads only)
- `GET  /system/manual-imports/candidates` — scans **`ARCHIVIST_DOWNLOAD_DIR`** (default `./downloads/complete`) for entries not attached to an active torrent; scores each against existing DB items (`getManualImportCandidatesForLibrary`).
- `GET  /system/manual-imports/search` — free-text match against **existing DB items only** (no TMDB lookup).
- `POST /system/manual-imports/queue` — `{ tabId, mediaType, itemId, sourcePath, copy }` → `queueMediaImport`.
- UI: **Acquisitions** page (`client/src/modules/acquisitions/index.tsx`).

### 2.3 The shared import pipeline — `services/media-imports.ts`
`queueMediaImport(payload: MediaImportPayload)` enqueues a job that:
1. Resolves the target library root via `resolveLibraryRoot(db, libraryId)`.
2. Organises the source into the canonical layout (`organizeFilm` / `organizeEpisode` in `shared/media-organizer.ts`) — **moves, or copies when `copy: true`**.
3. Optionally cleans tracks (`cleanImportedTracks`).
4. Updates the DB: item → `collected`, sets `file_path`, quality snapshot; enqueues loudness/segment analysis.

`MediaImportPayload` (relevant fields): `tabId, tabName, dbPath, mediaType, itemId, torrentId, infoHash, sourcePath, copy, releaseTitle, expectedVersion?`. For episode imports, `itemId` is the **series id**; the pipeline resolves the concrete episode.

### 2.4 The gap
- Manual import scans the **downloads** dir, not the **library** roots.
- Manual-import search matches **existing** items only — you must **Add Film** first, then attach.
- `system/data-integrity.ts::scanLibrary` walks library folders but only to **report** problems (files owned by no DB row), never to import.

## 3. Building blocks to reuse

| Need | Existing piece |
| --- | --- |
| Library root path | `shared/library-paths.ts::resolveLibraryRoot(db, libraryId)` |
| Walk dirs / identify video files | `shared/media-organizer.ts` (`VIDEO_EXTS = .mkv .mp4 .avi .ts .m4v`), the walk helpers in `data-integrity.ts::scanLibrary` |
| Parse a filename → title/year/season/episode/quality | `release-pipeline/parser.ts::parseRelease(raw)` → `ParsedRelease { kind, title, year, season, episodes[], resolution, source, codec, … }` |
| Fuzzy match a name to a DB item | `system/admin-routes.ts::scoreManualMatch`, `getManualImportCandidatesForLibrary` |
| TMDB/TVDB lookup for new items | films `modules/films/tmdb.ts::searchMovies/getMovie`; series `modules/series/tvdb.ts::searchSeries/getSeriesTmdb` |
| Create a film from tmdbId | logic in `POST /films` (`INSERT INTO films …`) — factor into a reusable `createFilmFromTmdb(libraryId, tmdbId, …)` |
| Route a file into the library + DB | `services/media-imports.ts::queueMediaImport` |
| Title normalisation / query variants | `parser.ts::normalizeTitle`, `punctuationSafeQueryVariants` |
| File→item ownership | `film.file_path` / `episode.file_path` columns; segment/loudness signatures |

## 4. Proposed design

A new module `services/library-scan.ts` plus a small set of `/system/library-scan/*` routes and a UI panel on the **Acquisitions** page (next to manual imports).

### 4.1 Pipeline overview

```
Scan library roots
   → enumerate video files (recursively)
   → drop files already owned (path matches a film/episode file_path)
   → parse filename (parseRelease)
   → resolve target item:
        (a) exact/high-confidence match to an EXISTING library item  → adopt
        (b) confident TMDB/TVDB lookup (no library item yet)          → create item, then adopt
        (c) low confidence / ambiguous / multiple candidates          → REVIEW queue
   → adopt = link the file to the item (see §4.4 in-place vs normalise)
```

### 4.2 Discovery & ownership
- Walk each library's root (`resolveLibraryRoot`) for films and series libraries.
- Collect files whose extension ∈ `VIDEO_EXTS`, skipping `sample`, `trailer`, extras, and sub-min-size files (e.g. < 50 MB) to avoid junk.
- **Owned** if the absolute path equals an existing `films.file_path` or `episodes.file_path` (also consider path under a known edition). Owned files are skipped — this makes re-scans idempotent.
- Result: a list of **unowned** video files per library.

### 4.3 Identification & matching (confidence-scored)
For each unowned file, `parseRelease(basename or parent-dir name)`:
- **Films** (`kind === 'movie'`, or no episode markers): title + year.
  1. Score against existing library films (`scoreManualMatch`). Strong match (title+year) → candidate (a).
  2. Else `searchMovies("<title> <year>")`; take best TMDB hit; year match + title similarity → candidate (b).
- **Series** (`kind === 'series'`, has S/E markers): series title + season + episode(s).
  1. Match to an existing series; resolve season/episode; the concrete episode is candidate (a).
  2. Else `searchSeries` → create series → resolve episode → candidate (b).
- Produce a **confidence** score in [0,1] from: parse quality, title similarity, year/season/episode agreement, single-vs-multiple candidates.

`AUTO_THRESHOLD` (e.g. 0.85): ≥ → auto-adopt; below → **review**.

### 4.4 Adoption — the key decision: in-place vs normalise
Two ways to "bring it in":

- **A. Normalise (default of `queueMediaImport`)** — moves/copies the file into the canonical layout `media/films/Title (Year)/Title (Year).mkv`. Pros: one consistent library that matches the download path; reuses the pipeline verbatim (`copy: false` moves, cleans tracks, sets status). Cons: **mutates the user's existing layout/paths**.
- **B. Adopt-in-place** — leave the file where it is; just `INSERT`/link the DB row with `file_path = <existing path>` and run the post-import analysis (quality snapshot, loudness, segments) **without moving**. Pros: non-destructive; respects a curated on-disk layout. Cons: needs a lighter code path than `queueMediaImport` (skip organise), and the library layout stays non-canonical.

**Chosen:** **B (adopt-in-place)** by default, with an opt-in **"Normalise layout"** toggle. Rather than a separate `adoptFileInPlace` helper, this is implemented as an **`inPlace` flag on `queueMediaImport`**: when set, the film and single-episode import paths skip the organise/move and the destructive-only steps (track rewrite, subtitle fetch, move validation) and link the existing `sourcePath` — reusing all of the pipeline's DB/quality/loudness logic. Normalise adoption simply omits the flag (standard organise + move).

### 4.5 Review queue
Persist ambiguous/low-confidence results so the user can confirm. Reuse the manual-import UX shape (candidate dropdown per file). On confirm, the user's choice routes to adopt (in-place or normalise).

### 4.6 Creating items that aren't in the library yet
- **Films** — `createFilmFromTmdb(db, libraryId, tmdbId)` (a faithful extraction of the `POST /films` insert; the route was left untouched to avoid regressions, so the two are kept in sync manually).
- **Series** — `createSeriesFromMetadata(db, libraryId, { tvdbId, tmdbId })`. Unlike `POST /series`, which populates seasons/episodes in a **background** IIFE, this populates them **synchronously (awaited)** because the scan must resolve a concrete episode id immediately after creation. It is intentionally **lean**: it writes the series + seasons + episode rows but skips NFO generation, episode thumbnails, and airtime normalisation. Those enrichments are backfilled by the existing metadata-refresh scheduler, so a scan-created series starts slightly sparse (e.g. `air_at`/`air_time` null) and fills in over time. `POST /series` was **not** refactored — series-add-from-metadata has no automated test coverage, so a blind refactor of that provider-dependent handler was judged too risky.

## 5. Data model

New table `library_scan_candidates` (mirrors the spirit of `recommendation_source_candidates`):

```sql
CREATE TABLE IF NOT EXISTS library_scan_candidates (
  id           INTEGER PRIMARY KEY,
  library_id   INTEGER NOT NULL,
  media_type   TEXT NOT NULL,              -- 'film' | 'episode'
  source_path  TEXT NOT NULL UNIQUE,
  parsed       TEXT NOT NULL DEFAULT '{}', -- ParsedRelease JSON
  best_item_id INTEGER,                    -- resolved/created item, if any
  best_tmdb_id INTEGER,
  confidence   REAL NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT 'review'
    CHECK (state IN ('review','auto','adopted','ignored','failed')),
  candidates   TEXT NOT NULL DEFAULT '[]', -- top matches for the review UI
  last_error   TEXT,
  scanned_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Auto-adopted rows can be recorded as `adopted` for an audit trail; a persisted `ignored` state lets the user permanently dismiss files (analogous to `ignored_staged_downloads`).

## 6. API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/system/library-scan/run` | Kick off a scan (all film/series libraries or a specific `libraryId`). Async job; returns a job id. |
| `GET`  | `/system/library-scan/status` | Progress + counts (scanned / owned / auto-adopted / review / failed). |
| `GET`  | `/system/library-scan/review` | List candidates in `review` (with parsed info + top matches). |
| `POST` | `/system/library-scan/resolve` | `{ id, itemId?, tmdbId?, normalise? }` → adopt a reviewed file. |
| `POST` | `/system/library-scan/ignore` | `{ id }` → permanently dismiss. |

Adoption internally reuses `queueMediaImport` (normalise) or the new `adoptFileInPlace` (in-place).

## 7. UI

A **"Scan Library"** panel on the Acquisitions page:
- "Scan now" button + progress/summary (X adopted, Y need review, Z ignored).
- A review list styled like manual imports: each row shows the file, the parsed guess, and a candidate dropdown (existing item / "create from TMDB: …") + Adopt / Ignore.
- A global **"Normalise layout on adopt"** toggle (default off).

## 8. Key design decisions (resolved)

1. **Auto-create vs review** — ✅ **hybrid**: auto-adopt at confidence ≥ `AUTO_THRESHOLD` (0.85 — title+year, or title+resolved season/episode, agree); everything else → review.
2. **In-place vs normalise** — ✅ **in-place default**, opt-in **Normalise layout** toggle (§4.4).
3. **Move vs copy on normalise** — ✅ move (`copy: false`), consistent with imports.
4. **Confidence threshold** — ✅ `AUTO_THRESHOLD = 0.85`; scoring = normalised-title match (exact 0.8 / substring 0.5) ± year agreement, ×0.9–0.98 preference for existing library items over fresh TMDB hits, +0.1 when a concrete episode resolves.
5. **File filtering** — ✅ video extensions only (`.mkv .mp4 .avi .ts .m4v`), skip `sample`/`trailer`, min size 50 MB (`MIN_SIZE`).
6. **Season packs / multi-episode / specials** — v1 adopts single `SxxEyy` episodes (first episode number); packs/multi-ep fall to review. Series title is read from the parent folder (skipping a `Season NN` level), S/E from the filename.
7. **Subtitles/extras** — main video only.

## 9. Edge cases

- Multiple video files in one movie folder (main + extras/samples) → pick the largest non-sample; others ignored.
- File already owned by a *different* item (moved/renamed) → surface as a conflict in review, not a silent re-link.
- Ambiguous TMDB matches (remakes, same title/different year) → review with the year as tiebreaker.
- Re-running the scan must be idempotent (owned + `adopted`/`ignored` rows skipped).
- Files mid-download or partial (`.part`) → skip.
- Series with no TVDB/TMDB match, or episode numbers outside known seasons → review.

## 10. Phasing

- **Phase 1 — Films, in-place.** ✅ Done. Scan film roots → parse → match existing / create-from-TMDB → adopt-in-place; review queue + Acquisitions UI.
- **Phase 2 — Series/episodes.** ✅ Done. Season/episode resolution, series create-from-TVDB/TMDB (synchronous episode population), per-episode adopt; packs/multi-ep to review.
- **Phase 3 — Normalise option.** ✅ Done. Shipped as the `inPlace` flag on `queueMediaImport` + the "Normalise layout" toggle.
- **Phase 4 — Polish.** ⏳ Not started. Candidate items: conflict handling (file already owned by a *different* item), bulk "adopt all high-confidence", scheduled/periodic rescans, dashboard surfacing, season-pack/multi-episode adoption, enrichment parity for scan-created series (or reuse `POST /series`'s populate once it's factored), and per-library exclusions.

## 11. Open questions (resolved) & remaining choices

Resolved: hybrid auto/review (§8.1), adopt-in-place default with opt-in normalise (§8.2), films + series both supported.

Still open (Phase 4 / owner input):

1. Should a scan stay **manual-only** (button), or also run **periodically**?
2. Any libraries/paths to **exclude**?
3. Permanently-unmatched files: keep in **review indefinitely**, or auto-**ignore** after N scans?
4. Is the **lean** scan-created series acceptable long-term, or should series creation be unified with `POST /series` (which needs the background-populate handler factored into a shared, awaitable helper first)?
