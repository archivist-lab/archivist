# Frontend API Compatibility Inventory

## Purpose

This document is the Step 9 inventory for the preserved Archivist frontend in `apps/archivist/client`.

The UI is a hard preservation target. V2 backend work must therefore preserve the current frontend's runtime contract:

- route paths
- request headers
- response key names
- response envelope shapes
- status enums used for rendering
- SSE event framing

This inventory is derived from the current frontend call sites in:

- `apps/archivist/client/src/lib/api.ts`
- `apps/archivist/client/src/lib/*.api.ts`
- `apps/archivist/client/src/lib/tab-context.tsx`
- direct `fetch()` calls inside feature modules

## Global Compatibility Rules

### 1. API Base Path

The frontend assumes all typed API calls live under:

- `/api/v1`

This is hard-coded in `src/lib/api.ts`.

### 2. Tab Context Header

The current UI is globally coupled to the legacy tab model.

`src/lib/api.ts` injects:

- `x-tab-context: <tab id>`

for most requests whenever an active tab exists.

V2 must therefore provide one of these compatibility options:

- accept `x-tab-context` directly and translate it to a V2 `library_id`
- provide a stable compatibility adapter in the backend that resolves tab ids to V2 library records

Removing this header contract before the frontend changes would break major flows.

### 3. Tab Object Shape

The shell expects tabs with legacy snake_case fields:

```ts
{
  id: number
  name: string
  media_type: 'films' | 'series' | 'music' | 'games' | 'books' | 'comics'
  db_path: string
  created_at: string
}
```

This shape drives:

- sidebar grouping and tab switching
- settings library management
- localStorage tab persistence

### 4. Mixed Snake Case / Camel Case

The frontend is not field-normalized.

Examples:

- films mostly use `poster_path`, `backdrop_path`
- series types tolerate both `poster_path` and `posterPath`
- dashboard calendar accepts both `logoPath` and `logo_path`

V2 should preserve field names exactly as the current UI expects, even if the internal model is normalized.

### 5. Delete / Empty Response Semantics

`request()` treats these as success with no JSON body:

- `204 No Content`
- `content-length: 0`

Delete routes should keep that behavior.

### 6. SSE Search Contract

`streamSearch()` expects:

- `Content-Type: text/event-stream`
- messages separated by blank lines
- optional `event: done`
- optional `event: error`
- `data: [...]` where the payload is a JSON array

This is used by release search flows.

### 7. Common Success/Error Envelope

Many direct `fetch()` call sites expect loose envelopes like:

- `{ success: true }`
- `{ success: boolean, message?: string }`
- `{ error: string }`

This is especially important for:

- missing search
- dashboard download actions
- torrent actions
- settings writes

## Endpoint Inventory

## Shell And Navigation

Source:

- `src/lib/tab-context.tsx`
- `src/components/Sidebar.tsx`
- `src/modules/settings/index.tsx`

Contracts:

- `GET /api/v1/tabs` -> `Tab[]`
- `POST /api/v1/tabs` body `{ name, mediaType, dbPath }` -> `Tab`
- `PUT /api/v1/tabs/:id` body `{ name }` -> `Tab`
- `DELETE /api/v1/tabs/:id?deleteFiles=true|false` -> empty success
- `GET /api/v1/tabs/root-folders` -> `Array<{ tabId: number; tabName: string; path: string }>`

Compatibility notes:

- the UI still thinks in "tabs", not "libraries"
- `db_path` is displayed in Settings; hiding or renaming it would change the current UI behavior
- tab selection is per media type and persisted in localStorage

## Shared Utility And Settings Surface

Source:

- `src/lib/shared.api.ts`
- `src/modules/settings/index.tsx`

Typed shapes consumed directly by the UI:

- `GET /api/v1/indexers` -> `Indexer[]`
- `GET /api/v1/indexers/definitions/list` -> `any[]`
- `POST /api/v1/indexers`
- `PUT /api/v1/indexers/:id`
- `DELETE /api/v1/indexers/:id`
- `POST /api/v1/indexers/:id/test` -> `{ success, message, resultCount?, duration? }`
- `POST /api/v1/indexers/test-config` -> same envelope
- `GET /api/v1/download-clients` -> `DownloadClient[]`
- `POST /api/v1/download-clients` -> `DownloadClient`
- `PUT /api/v1/download-clients/:id` -> `DownloadClient`
- `DELETE /api/v1/download-clients/:id`
- `POST /api/v1/download-clients/test` -> `{ success, message, version? }`
- `POST /api/v1/download-clients/:id/test` -> `{ success, message }`
- `GET /api/v1/quality-profiles` -> `QualityProfile[]`
- `POST /api/v1/quality-profiles` -> `QualityProfile`
- `PUT /api/v1/quality-profiles/:id` -> `QualityProfile`
- `DELETE /api/v1/quality-profiles/:id`
- `GET /api/v1/root-folders` -> `RootFolder[]`
- `POST /api/v1/root-folders` body `{ path }` -> `RootFolder`
- `DELETE /api/v1/root-folders/:id`
- `GET /api/v1/settings/naming` -> `any`
- `PUT /api/v1/settings/naming` -> `any`
- `GET /api/v1/settings/media-management` -> `any`
- `PUT /api/v1/settings/media-management` -> `any`
- `GET /api/v1/settings/flaresolverr` -> `{ url, enabled }`
- `PUT /api/v1/settings/flaresolverr` -> same shape
- `GET /api/v1/settings/api-keys` -> `ApiKeysConfig`
- `PUT /api/v1/settings/api-keys` -> `{ success: boolean }`
- `GET /api/v1/settings/quality-tiers` -> `TierConfig`
- `PUT /api/v1/settings/quality-tiers` -> `TierConfig`
- `GET /api/v1/settings/acquisition-defaults` -> `AcquisitionDefaults`
- `PUT /api/v1/settings/acquisition-defaults` -> `AcquisitionDefaults`
- `GET /api/v1/settings/track-cleaner` -> `TrackCleanerConfig`
- `PUT /api/v1/settings/track-cleaner` -> `TrackCleanerConfig`
- `GET /api/v1/settings/track-cleaner/status` -> `{ available, version }`
- `GET /api/v1/settings/subtitles` -> `SubtitleConfig`
- `PUT /api/v1/settings/subtitles` -> `SubtitleConfig`
- `GET /api/v1/settings/media-base-dir` -> `{ path: string }`
- `POST /api/v1/media/clean-tracks` -> `{ success, message, removedAudio, removedSubs, originalSize, newSize }`
- `POST /api/v1/subtitles/search` -> `SubtitleSearchResult[]`
- `POST /api/v1/subtitles/download` -> `{ success, message, filePath? }`

Compatibility notes:

- several settings payloads are effectively untyped from the frontend perspective and should be treated as opaque compatibility contracts
- `settings/api-keys` returns masked values in the legacy UI flow; V2 must preserve that UX behavior if this screen remains unchanged
- root folder writes are still tab-scoped through `x-tab-context`

## Dashboard And Home

Source:

- `src/modules/home/Dashboard.tsx`
- `src/modules/home/DownloadMonitor.tsx`
- `src/modules/home/ManualSearch.tsx`
- `src/modules/home/UnifiedAddMedia.tsx`

Contracts:

- `GET /api/v1/dashboard/stats` ->  
  `{ counts: Record<string, { total?: number; count?: number; missing?: number; acquiring?: number }>, recentlyAdded: [...] }`
- `GET /api/v1/dashboard/system` ->  
  `{ cpu, memory, storage[] }`
- `GET /api/v1/dashboard/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD` -> `any[]`
- `GET /api/v1/dashboard/downloads` -> `{ torrents: TorrentSummary[] }`
- `POST /api/v1/dashboard/downloads/:id/action` body `{ action, deleteData }` -> loose success response
- `GET /api/v1/dashboard/search?...` -> `SearchResult[]`
- `POST /api/v1/dashboard/search/grab` body `{ downloadUrl, title }` -> loose success response

Dashboard calendar fields actively used by the UI:

- `date`
- `type`
- `tabId`
- `tabName`
- `displayTitle`
- `displaySub`
- `title`
- `overview`
- `poster_path`
- series-specific fields such as `seriesTitle`, `season_number`, `episode_number`, `air_date`, `still_path`, `logoPath`, `logo_path`, `tmdbId`

Compatibility notes:

- the dashboard calendar shape is a real compatibility hotspot because it is not normalized or typed in the frontend
- `UnifiedAddMedia` still uses per-domain lookup endpoints and, for films, `requestWithTab()` to avoid mutating global tab state

## Films

Source:

- `src/lib/films.api.ts`
- `src/modules/films/index.tsx`

Primary contracts:

- `GET /api/v1/films` -> `Movie[]`
- `GET /api/v1/films/:id` -> `Movie`
- `GET /api/v1/films/tmdb/:tmdbId` -> `TmdbResult`
- `POST /api/v1/films` -> `Movie`
- `PUT /api/v1/films/:id` -> `Movie`
- `DELETE /api/v1/films/:id`
- `POST /api/v1/films/refresh` -> `{ success, updated }`
- `POST /api/v1/films/:id/auto-grab` -> `{ success, message }`
- `GET /api/v1/films/:id/acquisition-history` -> `{ decisions: any[]; blocks: any[] }`
- `POST /api/v1/films/:id/reject-current-release` -> `{ success }`
- `POST /api/v1/films/:id/repair` -> `Movie`
- `GET /api/v1/films/lookup?q=` -> `TmdbResult[]`
- `PUT /api/v1/films/:id/metadata` -> `Movie`
- `GET /api/v1/films/:id/images?type=&language=` -> `any[]`
- `PUT /api/v1/films/:id/images` -> `{ success, path }`
- `GET /api/v1/films/releases/search...` -> SSE batches of `MovieRelease[]`
- `POST /api/v1/films/download` -> `{ success, message }`
- `GET /api/v1/films/edition-rules/all` -> `any[]`
- `POST /api/v1/films/edition-rules` -> `any`
- `PUT /api/v1/films/edition-rules/:id` -> `any`
- `DELETE /api/v1/films/edition-rules/:id` -> `{ success }`

Direct extra contracts in the films module:

- `PUT /api/v1/films/editions/:id` body `{ edition_name }`
- `PATCH /api/v1/torrents/:id/files` body `{ updates: Array<{ index, wanted?, priority? }> }`
- `POST /api/v1/dashboard/downloads/:id/action` body `{ action, deleteData }`
- `GET /api/v1/torrents` -> used to match `infoHash` against `film.info_hash`
- `GET /api/v1/torrents/:id` -> active-download detail view
- `POST /api/v1/release-pipeline/missing-search` body `{ tabId, overrides }` -> `{ success, error? }`

Fields the current film UI relies on heavily:

- `status`
- `poster_path`, `backdrop_path`
- `title`, `year`, `overview`, `runtime`
- `studio`, `certification`, `rating`, `country`, `trailerPath`
- acquisition fields such as `downloadProgress`, `info_hash`, `current_*`, `target_*`, `upgrade_allowed`
- edition fields such as `default_edition_id`, `editions`

## Series

Source:

- `src/lib/series.api.ts`
- `src/modules/series/index.tsx`

Contracts:

- `GET /api/v1/series` -> `Series[]`
- `GET /api/v1/series/:id` -> `Series & { seasons?: Season[] }`
- `GET /api/v1/series/:id/seasons` -> `Season[]`
- `GET /api/v1/series/:id/episodes` -> `Episode[]`
- `POST /api/v1/series` -> `Series`
- `PUT /api/v1/series/:id` -> `Series`
- `DELETE /api/v1/series/:id`
- `GET /api/v1/series/tmdb/:tmdbId` -> `any`
- `POST /api/v1/series/refresh` -> `{ success, message }`
- `PUT /api/v1/series/seasons/:seasonId` -> empty success
- `GET /api/v1/series/seasons/:seasonId/acquisition-history` -> `{ decisions, blocks }`
- `POST /api/v1/series/seasons/:seasonId/reject-current-release` -> `{ success }`
- `POST /api/v1/series/seasons/:seasonId/repair` -> `Season`
- `PUT /api/v1/series/episodes/:id` -> `Episode`
- `GET /api/v1/series/episodes/:id/acquisition-history` -> `{ decisions, blocks }`
- `POST /api/v1/series/episodes/:id/reject-current-release` -> `{ success }`
- `POST /api/v1/series/episodes/:id/repair` -> `Episode`
- `GET /api/v1/series/lookup?q=` -> `SeriesSearchResult[]`
- `GET /api/v1/series/releases/search?q=` -> SSE batches of `SeriesRelease[]`
- `POST /api/v1/series/download` -> `{ success, message }`
- `GET /api/v1/series/calendar` -> `any[]`
- `POST /api/v1/release-pipeline/missing-search` body `{ tabId, overrides }`

Compatibility notes:

- the current series `get()` helper compensates for backend inconsistency by fetching seasons separately if missing
- V2 should preserve that endpoint pair or provide an equivalent compatibility response including seasons

## Music

Source:

- `src/lib/music.api.ts`
- `src/modules/music/index.tsx`

Contracts:

- `GET /api/v1/music/artists` -> `Artist[]`
- `GET /api/v1/music/artists/:id` -> `Artist & { albums: Album[] }`
- `POST /api/v1/music/artists` body `{ mbid, monitored, albumTypes }` -> `Artist`
- `DELETE /api/v1/music/artists/:id`
- `POST /api/v1/music/refresh` -> `{ success, message }`
- `GET /api/v1/music/albums/:id` -> `Album`
- `PUT /api/v1/music/albums/:id` -> `Album`
- `GET /api/v1/music/albums/:id/acquisition-history` -> `{ decisions, blocks }`
- `POST /api/v1/music/albums/:id/reject-current-release` -> `{ success }`
- `POST /api/v1/music/albums/:id/repair` -> `Album`
- `GET /api/v1/music/lookup?q=` -> `any[]`
- `GET /api/v1/music/lookup/:mbid` -> `any`
- `POST /api/v1/music/download` -> `{ success, message }`
- `POST /api/v1/release-pipeline/missing-search` body `{ tabId, overrides }`

## Books

Source:

- `src/lib/books.api.ts`
- `src/modules/books/index.tsx`

Contracts:

- `GET /api/v1/books/authors` -> `Author[]`
- `GET /api/v1/books/authors/:id` -> `Author & { books: Book[] }`
- `POST /api/v1/books/authors` body `{ name, monitored, seriesNames }` -> `Author`
- `DELETE /api/v1/books/authors/:id`
- `POST /api/v1/books/refresh` -> `{ success, message }`
- `PUT /api/v1/books/:id` -> `Book`
- `GET /api/v1/books/:id/acquisition-history` -> `{ decisions, blocks }`
- `POST /api/v1/books/:id/reject-current-release` -> `{ success }`
- `POST /api/v1/books/:id/repair` -> `Book`
- `GET /api/v1/books/lookup/authors?q=` -> `any[]`
- `GET /api/v1/books/lookup/author/:name` -> `any`
- `POST /api/v1/books/download` -> `{ success, message }`
- `POST /api/v1/release-pipeline/missing-search` body `{ tabId, overrides }`

## Comics

Source:

- `src/lib/comics-games.api.ts`
- `src/modules/comics/index.tsx`

Contracts:

- `GET /api/v1/comics/series` -> `ComicSeries[]`
- `GET /api/v1/comics/series/:id` -> `ComicSeries & { issues: ComicIssue[] }`
- `POST /api/v1/comics/series` body `{ cvId }` -> `ComicSeries`
- `DELETE /api/v1/comics/series/:id`
- `POST /api/v1/comics/refresh` -> `{ success, message }`
- `PUT /api/v1/comics/issues/:id` -> `ComicIssue`
- `POST /api/v1/comics/issues/:id/auto-grab` -> `{ success, message }`
- `GET /api/v1/comics/issues/:id/acquisition-history` -> `{ decisions, blocks }`
- `POST /api/v1/comics/issues/:id/reject-current-release` -> `{ success }`
- `POST /api/v1/comics/issues/:id/repair` -> `ComicIssue`
- `GET /api/v1/comics/lookup?q=` -> `any[]`
- `POST /api/v1/comics/download` -> `{ success, message }`
- `POST /api/v1/release-pipeline/missing-search` body `{ tabId, overrides }`

## Games

Source:

- `src/lib/comics-games.api.ts`
- `src/modules/games/index.tsx`

Contracts:

- `GET /api/v1/games` -> `Game[]`
- `GET /api/v1/games/:id` -> `Game`
- `POST /api/v1/games` body `{ igdbId, platforms }` -> `Game`
- `PUT /api/v1/games/:id` -> `Game`
- `DELETE /api/v1/games/:id`
- `POST /api/v1/games/refresh` -> `{ success, message }`
- `POST /api/v1/games/:id/auto-grab` -> `{ success, message }`
- `GET /api/v1/games/:id/acquisition-history` -> `{ decisions, blocks }`
- `POST /api/v1/games/:id/reject-current-release` -> `{ success }`
- `POST /api/v1/games/:id/repair` -> `Game`
- `GET /api/v1/games/lookup?q=&platformId=` -> `any[]`
- `POST /api/v1/games/download` -> `{ success, message }`
- `POST /api/v1/release-pipeline/missing-search` body `{ tabId, overrides }`

## Torrents And Acquisitions

Source:

- `src/modules/torrents/TorrentsPage.tsx`
- `src/modules/home/DownloadMonitor.tsx`
- `src/modules/films/index.tsx`
- `src/lib/shared.api.ts`

Direct contracts:

- `GET /api/v1/torrents` -> `Torrent[]`
- `GET /api/v1/torrents/:id` -> `Torrent`
- `POST /api/v1/torrents` body `{ magnetLink?; torrentUrl? }` -> `{ success?: boolean; error?: string; ... }`
- `POST /api/v1/torrents/:id/start`
- `POST /api/v1/torrents/:id/stop`
- `DELETE /api/v1/torrents/:id?deleteData=true|false`
- `POST /api/v1/torrents/bulk-action` body `{ ids, action, deleteData }`
- `PATCH /api/v1/torrents/:id/priority` body `{ bandwidthPriority }`
- `POST /api/v1/torrents/reorder` body `{ orderedIds }`
- `POST /api/v1/torrents/:id/recheck`
- `POST /api/v1/torrents/:id/reannounce`
- `PATCH /api/v1/torrents/:id/files` body `{ updates }`
- `GET /api/v1/torrents/:id/acquisition-match` -> `{ match: ManualImportCandidate | null }`
- `PUT /api/v1/torrents/:id/acquisition-match` -> `{ match: ManualImportCandidate }`
- `GET /api/v1/torrents/:id/import-plan` -> `{ plan: ImportPlan | null }`
- `GET /api/v1/torrents/network` -> `NetworkDiagnostics | null`

Dashboard-specific torrent contracts:

- `GET /api/v1/dashboard/downloads` -> `{ torrents: TorrentSummary[] }`
- `POST /api/v1/dashboard/downloads/:id/action` body `{ action, deleteData }`

Manual import contracts:

- `GET /api/v1/system/manual-imports/candidates` -> `{ downloadDir: string; items: ManualImportItem[] }`
- `GET /api/v1/system/manual-imports/search?...` -> `{ results: ManualImportCandidate[] }`
- `POST /api/v1/system/manual-imports/queue` -> `{ success: boolean; jobId: number | null }`

Critical torrent fields the UI uses directly:

- top-level status and transfer fields such as `status`, `progress`, `downloadSpeed`, `uploadSpeed`, `downloadedBytes`, `sizeBytes`, `eta`
- queue and cleanup fields such as `queuePosition`, `bandwidthPriority`, `orphaned`, `sourcePath`
- detail arrays: `files[]`, `trackers[]`, `peers[]`
- diagnostics object: `connected`, `failed`, `peerSources`, `failureBuckets`, `recentFailures`, `availability`, `requests`

This is one of the most brittle compatibility zones in the entire app.

## System Operations

Source:

- `src/lib/shared.api.ts`
- `src/modules/settings/index.tsx`

Contracts:

- `POST /api/v1/system/rss/run` -> `{ success }`
- `GET /api/v1/system/overview` -> `SystemOverview`
- `GET /api/v1/system/integrity` -> `{ config, lastReport, current }`
- `PUT /api/v1/system/integrity` -> `{ config }`
- `POST /api/v1/system/integrity/run` -> `{ report }`
- `POST /api/v1/system/integrity/repair` -> `{ result, backup, integrity }`
- `POST /api/v1/system/integrity/repair-bulk` -> `{ result, backup, integrity }`
- `GET /api/v1/system/jobs?limit=` -> `{ jobs: SystemJob[] }`
- `GET /api/v1/system/events?limit=` -> `{ events: SystemEvent[] }`
- `GET /api/v1/system/media-imports?limit=` -> `{ imports: any[] }`
- `GET /api/v1/system/acquisition-decisions?limit=` -> `{ decisions: any[] }`
- `GET /api/v1/system/release-blocklist?limit=` -> `{ blocks: any[] }`
- `DELETE /api/v1/system/release-blocklist/:id` -> `{ success }`
- `GET /api/v1/system/db` -> `{ shared, tabs, openConnections }`
- `POST /api/v1/system/db/checkpoint` -> `{ results: [...] }`
- `GET /api/v1/system/maintenance` -> `{ config, lastResult }`
- `PUT /api/v1/system/maintenance` -> `{ config }`
- `POST /api/v1/system/maintenance/run` -> `{ result }`
- `GET /api/v1/system/backups` -> `{ config, lastBackup, backups }`
- `PUT /api/v1/system/backups` -> `{ config }`
- `POST /api/v1/system/backups/run` -> `{ backup }`
- `POST /api/v1/system/jobs/:id/cancel` -> `{ success }`
- `POST /api/v1/system/jobs/:id/retry` -> `{ success }`

Compatibility notes:

- the UI already assumes the `/system/jobs` and `/system/events` shape that V2 has started implementing
- `SystemOverview` is large and currently drives multiple settings/system panels

## Highest-Risk Coupling Points

### 1. `x-tab-context`

This is the single biggest compatibility constraint.

The UI assumes:

- one active tab at a time
- requests scoped by tab header
- multiple tabs per media type

V2 should not force the frontend to understand `library_id` directly in Phase 1.

### 2. Mixed Field Naming

Examples:

- `poster_path` and `posterPath`
- `logo_path` and `logoPath`
- tab fields in snake_case
- some system DB responses in camelCase

Do not normalize response keys at the frontend boundary yet.

### 3. Direct Torrent Fetches

The torrents UI bypasses the shared API layer and uses large unwrapped payloads.

That means:

- no adapter currently centralizes torrent response translation
- V2 must preserve this shape exactly or introduce a dedicated compatibility wrapper before cutover

### 4. Dashboard Calendar

The dashboard modal and calendar cards rely on a loose, polymorphic event object with media-specific fields.

This should be treated as a compatibility contract, not a convenient aggregation to redesign.

### 5. Untyped Settings And Lookup Results

Several endpoints are consumed as `any`, including:

- naming settings
- media management settings
- edition rules
- multiple lookup endpoints
- parts of the indexer UI

Untyped does not mean safe to change. It means the frontend has no compile-time guardrails.

## Required Adapter Work For V2

V2 should provide a frontend compatibility layer with these guarantees:

1. Accept `x-tab-context` and resolve it to a V2 library internally.
2. Preserve current `/api/v1/...` paths during the UI-preservation phase.
3. Preserve current response key names, including snake_case where the UI expects it.
4. Preserve current success/error envelopes used by direct `fetch()` calls.
5. Preserve SSE framing for release search endpoints.
6. Preserve tab-management endpoints even if the internal V2 model no longer stores per-tab databases.
7. Preserve current torrent payload richness until the frontend is explicitly refactored.
8. Preserve current settings payloads, especially masked secret fields and tab-scoped defaults.

## Recommended Execution Consequence

Before migrating any domain UI to V2 data, treat the following as a non-negotiable backend boundary:

- shell and tab endpoints
- films payloads
- torrents payloads
- dashboard calendar payloads
- system/settings payloads

That means Phase 1 should not only prove films business logic. It must also prove that the preserved frontend can keep talking to V2 through a compatibility surface that honors this document.
