---
title: "Archivist Codebase Guide for AI Agents"
document_type: architecture
status: historical
classified: 2026-08-16
---
# Archivist Codebase Guide for AI Agents

This document is written for AI coding agents that need to work in the Archivist repository with minimal rediscovery. It explains how the application is structured, where important behavior lives, how data flows through the system, and what invariants must be respected when making changes.

Use this alongside `../01-foundation/capability-map.md`, which is the product-level feature inventory. This document focuses on implementation, architecture, file ownership, and development workflow.

## High-Level Mental Model

Archivist is a TypeScript monorepo that implements a self-contained media automation system for:

- Films.
- Series.
- Music.
- Books.
- Comics.
- Games.
- Indexers.
- Torrents.
- Manual imports.
- Release acquisition.
- Library management.
- System operations.

There are three major runtime layers:

1. React frontend in `client/`.
2. Express backend in `apps/server/`.
3. Shared packages in `packages/`.

The backend owns the database, provider integrations, release decisions, torrent session, background jobs, imports, and file/media operations. The frontend owns UI state, active library context, and calls the backend through typed API wrapper modules.

The database model is intentionally unified. The old UI terminology says "tabs", but in Archivist a tab is a `libraries` row in one SQLite database.

## Repository Root

Application root:

```text
archivist/
```

Important root files:

- `README.md`: setup, run, test, Docker, and layout summary.
- `package.json`: root pnpm scripts.
- `pnpm-workspace.yaml`: workspace membership.
- `tsconfig.base.json`: shared TypeScript config.
- `Dockerfile`: production image.
- `docker-compose.yml`: source-build local deployment.
- `docker-compose.release.yml`: prebuilt image deployment.
- `.env.example`: environment variable reference.
- `config.toml`: local runtime config when present.
- `data/`: runtime SQLite DB, indexer definitions, torrent state, downloads.
- `media/`: organized media output.

Do not edit generated/runtime artifacts unless explicitly asked:

- `client/dist/`.
- `apps/server/dist/`.
- `packages/*/dist/`.
- `node_modules/`.
- `data/archivist.sqlite*`.
- `packages/core/server.log`.
- `*.tsbuildinfo`.

## Package and App Boundaries

### `apps/server/`

The backend app.

Main responsibilities:

- Build Express app.
- Initialize SQLite.
- Ensure default libraries.
- Mount API routes.
- Serve the built React app in production.
- Start background services.
- Bridge indexers and torrent engine.
- Run metadata provider integrations.
- Make acquisition decisions.
- Queue and run media imports.
- Manage settings and system operations.

Main files:

- `src/server.ts`: standalone server entrypoint.
- `src/app.ts`: constructs the Express app, initializes DB/indexers/torrent engine, mounts routers, starts/stops background work.
- `src/routes.ts`: central router registry and background service startup registry.
- `src/db.ts`: server-local handle to the unified database.
- `src/config.ts`: config loading.

### `client/`

The React SPA.

Main responsibilities:

- App shell and routing.
- Sidebar/library context.
- Dashboard.
- Media library/detail pages.
- Add/search flows.
- Acquisitions/torrent UI.
- Indexer UI.
- Settings/system UI.

Main files:

- `src/main.tsx`: React root, wraps app in tab context.
- `src/App.tsx`: shell routes.
- `src/lib/api.ts`: base fetch wrapper, tab header injection, streaming search.
- `src/lib/tab-context.tsx`: library/tab state and active tab selection.
- `src/lib/*.api.ts`: frontend API wrappers.
- `src/components/`: shared UI building blocks.
- `src/modules/`: feature pages.

### `packages/contracts/`

Shared Zod contracts.

Use these for route body validation and shared type vocabulary:

- `common.ts`: IDs, media types, lifecycle states, error/success envelopes, pagination, download URL validation.
- `libraries.ts`: library/tab/root folder contracts.
- `domains.ts`: media-domain add/update/download request contracts.
- `quality.ts`: quality profile/definition/tier contracts.
- `settings.ts`: naming, media management, CloudflareBypass, acquisition defaults, track cleaner, subtitles, API keys.
- `system.ts`: jobs, events, health contracts.
- `index.ts`: exports.

The server imports contracts as `@archivist/contracts`.

### `packages/db/`

Unified SQLite schema and DB helpers.

Main files:

- `src/client.ts`: cached better-sqlite3 connection management.
- `src/schema.ts`: full unified schema and default seed data.
- `src/migrations.ts`: simple migration helpers.
- `src/index.ts`: package exports and `openUnifiedDb`.

Important invariants:

- There is exactly one SQLite DB.
- Foreign keys are enabled.
- WAL mode is enabled.
- Default libraries are created by server shared routes, not by the DB package.
- Schema columns preserve old frontend-compatible names in many places.
- `library_id = 0` means global scope for settings-like tables.
- Normal library-scoped rows use a positive library ID.

### `packages/core/`

Shared non-UI utilities and legacy-compatible services.

Exports include:

- DB helpers from `src/db/`.
- Indexer helpers from `src/indexers/`.
- Download client helpers.
- `registerSessionSendFn` for the embedded torrent session.
- Release scoring terms and `scoreRelease`.
- Logging.
- Config helpers.
- Constants.

### `packages/indexer-engine/`

Indexer runtime package.

Exports include:

- Cardigann definition loader.
- Cardigann executor.
- Torznab client/caps/response builders.
- Search aggregator.
- Indexer store.
- Definition sync.

Used by server indexer routes and release/search flows.

### `packages/bittorrent/`

Low-level BitTorrent protocol implementation.

Feature areas:

- Bencode.
- Torrent file parsing.
- Peer connection, handshake, wire protocol.
- Message stream encryption.
- DHT.
- PEX.
- LPD.
- Tracker announces.
- uTP.
- Port forwarding.

### `packages/torrent-engine/`

High-level torrent session implementation.

Feature areas:

- `Session`: root torrent session object.
- `Swarm`: peer swarm.
- `Storage`: disk IO.
- `PieceManager`: piece/block tracking.
- `MetadataFetcher`: magnet metadata.
- `ResumeStore`: persisted state.
- `SessionBandwidth` and `TorrentBandwidth`.
- Piece verifier worker.

The server uses this through `apps/server/src/services/torrent-session.ts`.

### `packages/types/`

Shared TypeScript types for:

- Events.
- Indexers.
- Sessions.
- Torrents.

## Root Scripts

Root `package.json` scripts:

- `corepack pnpm bootstrap`: install and build.
- `corepack pnpm build:packages`: build all packages.
- `corepack pnpm build:server`: build server.
- `corepack pnpm build:client`: build client.
- `corepack pnpm build`: full build.
- `corepack pnpm dev`: run development server with `tsx watch --env-file=.env apps/server/src/server.ts`.
- `corepack pnpm start`: run built server.
- `corepack pnpm test`: backend test suite.
- `corepack pnpm typecheck`: server typecheck.
- `corepack pnpm verify`: build plus test.

When making code changes, prefer targeted tests first, then build/typecheck depending on risk. Do not run long or network-dependent commands unless needed.

## Backend Boot Flow

The main boot path is:

```text
server.ts
  -> createApp()
     -> loadConfig()
     -> initDb(config.database.path)
     -> ensureDefaultLibraries()
     -> initIndexerBridge(getDb(), config.definitions.path)
     -> optionally initTorrentSession()
     -> configure Express middleware
     -> mount /ping
     -> mount /media static
     -> configure /api/v1 auth + rate limits + health + SSE
     -> mount system runtime router
     -> mount shared router
     -> registerRoutes(api, ctx)
     -> optionally serve SPA
     -> startJobRunner()
     -> startBackgroundServices()
```

`createApp` returns:

- `app`: Express instance.
- `config`: loaded config.
- `stop`: async shutdown function.

Tests can pass `skipBackground` to avoid starting torrent/session/schedulers while still mounting routes.

## Express Middleware

Middleware order in `app.ts` matters:

1. Request ID.
2. Security headers.
3. JSON/body parsing.
4. Library context.
5. CORS.
6. `/ping`.
7. `/media` static.
8. `/api/v1` router.

API router adds:

- API auth.
- Write rate limit for POST/PUT/PATCH/DELETE.
- Search rate limit for metadata lookup routes.
- `/health`.
- `/events` SSE.
- Runtime system router.
- Shared router.
- Domain/platform routers.
- API 404 handler.

## Route Registration

Routes are centralized in:

```text
apps/server/src/routes.ts
```

Platform routers:

- `/indexers`: `indexers/routes.ts`.
- `/system`: `system/admin-routes.ts`.
- `/release-pipeline`: `release-pipeline/routes.ts`.
- `/torrents`: `torrents/routes.ts`.
- Dashboard routes.
- Diagnostics routes.

Domain routers:

- Films.
- Series.
- Music.
- Books.
- Comics.
- Games.

Background services are also registered in `routes.ts`:

- Media import jobs.
- Maintenance jobs and scheduler.
- Backup jobs and scheduler.
- Integrity jobs and scheduler.
- Download monitor.
- Release orchestrator.
- Missing search scheduler.

## Database Access Pattern

Server code gets the unified DB via:

```ts
import { getDb } from '../db.js'
```

`apps/server/src/db.ts` wraps the package DB:

- `initDb(path)`: opens unified DB and applies schema.
- `getDb()`: returns initialized DB or throws.
- `resetDbForTests()`: test helper.

The DB connection itself is from `packages/db/src/client.ts`:

- Cached by resolved path.
- WAL journaling.
- `synchronous = NORMAL`.
- `foreign_keys = ON`.
- `busy_timeout = 5000`.

Do not introduce separate per-library database files. If a task mentions "tab DB", translate that into the unified DB plus `library_id`.

## Library and Tab Context

Frontend uses "tab" context. Backend uses `library_id`.

Client path:

```text
client/src/lib/tab-context.tsx
client/src/lib/api.ts
```

Key behavior:

- Active tab ID is stored in localStorage.
- Per-media-type active tab map is stored in localStorage under `archivist_active_tabs`.
- `setTabContext(id)` sets a module-global active tab in `api.ts`.
- Requests include `x-tab-context` if active.
- `requestWithTab(tabId, path, options)` makes one request with a specific tab and does not mutate global context.

Server path:

```text
apps/server/src/middleware/library-context.ts
```

Expected server behavior:

- Parse `X-Tab-Context`.
- Attach library scope to request.
- `scopeId(req)` resolves current library scope, usually from middleware.

Agent rule:

- When adding frontend API calls that are library-scoped, use `request()` if the current active tab is correct.
- Use `requestWithTab()` when the action targets a specific tab without changing UI state.
- When adding backend queries for media rows, filter by current `library_id` unless intentionally global.

## Shared Router Responsibilities

File:

```text
apps/server/src/shared/routes.ts
```

This is a central server surface for cross-domain functionality.

It owns:

- Library/tab CRUD.
- Default library creation.
- Library clearing/deleting.
- Root folders.
- Quality profiles.
- Quality definitions.
- Download clients.
- Naming settings.
- Media-management settings.
- CloudflareBypass settings.
- Acquisition defaults.
- Quality tiers.
- Track cleaner settings and status.
- File metadata read/write.
- Track cleaning.
- Subtitle search/download.
- API key read/write.
- Media base directory.

Important defaults in this file:

- Naming defaults.
- Media management defaults.
- CloudflareBypass defaults.
- Acquisition defaults.
- Track cleaner defaults.
- Subtitle defaults.

Important safety behavior:

- Root folders must be absolute paths.
- Null bytes are rejected.
- Optional `ARCHIVIST_ALLOWED_ROOTS` constrains allowed root folders.
- Library clear/delete can delete media files only when `deleteFiles=true`.
- API keys are masked on read and persisted to `.env` on write.

## System Routers and Runtime Services

Runtime system routes:

```text
apps/server/src/system/routes.ts
```

Admin system routes:

```text
apps/server/src/system/admin-routes.ts
```

System service files:

- `event-store.ts`: jobs/events persistence helpers.
- `job-runner.ts`: job handler registry and runner loop.
- `sse.ts`: server-sent event bus.
- `maintenance.ts`: retention, stale job recovery, DB checkpointing.
- `backups.ts`: backup config/scheduler/manifest creation.
- `data-integrity.ts`: integrity scan, problem categorization, repair.

System jobs:

- `media-import`.
- `system-maintenance`.
- `system-backup`.
- `integrity-scan`.

Events are used heavily for operational observability. If adding background behavior, record useful events with category, action, severity, subject type, subject ID, message, and data.

## Domain Router Pattern

Each media domain usually has:

```text
apps/server/src/domains/<domain>/routes.ts
apps/server/src/domains/<domain>/serialize.ts
apps/server/src/domains/<domain>/<provider>.ts
```

Typical route responsibilities:

- List current library items.
- Lookup external metadata.
- Get detail.
- Add item.
- Update item or child item.
- Delete item, optionally delete files.
- Refresh metadata.
- Update metadata.
- Search images.
- Save image.
- Download/grab.
- Auto-grab where supported.
- Acquisition history.
- Reject current release.
- Repair/reacquire state.

Serialization files exist to normalize SQLite row shapes into frontend-consumable JSON.

Agent rule:

- Prefer following the nearest domain’s route/serializer pattern.
- If adding a new field, update schema, serializer, route SQL, frontend API types, and UI display/edit surface as needed.
- Keep status vocabulary compatible with existing frontend expectations.

## Shared Acquisition Controls

File:

```text
apps/server/src/shared/acquisition-controls.ts
```

This helper registers common endpoints for supported entities:

- `GET <route>/acquisition-history`.
- `POST <route>/reject-current-release`.
- `POST <route>/repair`.

It is used by non-film domains and by series subresources where appropriate. Films have some additional custom handling because editions/file behavior is richer.

If implementing acquisition controls for a new subject type, prefer this helper unless the subject has domain-specific repair semantics.

## Films Implementation

Server files:

- `apps/server/src/domains/films/routes.ts`.
- `apps/server/src/domains/films/serialize.ts`.
- `apps/server/src/domains/films/tmdb.ts`.

Client files:

- `client/src/modules/films/index.tsx`.
- `client/src/lib/films.api.ts`.

DB tables:

- `films`.
- `film_editions`.
- `edition_rules`.

Films are the richest domain.

Important server behavior:

- TMDB lookup and TMDB detail.
- Add film from TMDB.
- Create film folder/artwork via media organizer.
- Store target acquisition policy.
- Store current quality snapshot.
- Support editions and default edition.
- Update film metadata.
- Search and save images.
- Release search via streaming SSE.
- Download specific release.
- Auto-grab.
- Refresh library metadata.
- Reject/block current release.
- Repair status for reacquisition.
- Edition rule CRUD.

Important client behavior:

- `FilmsPage` defines routes:
  - index library.
  - `/add`.
  - `/:slug/:id`.
  - `/:param`.
- `useEnsureFilmsTabContext()` ensures film routes use a films library.
- Film library supports search, filters, edit mode, bulk delete, and missing search.
- Detail page includes:
  - metadata.
  - cast/crew.
  - trailer modal.
  - edition selection/rename/default.
  - subtitles.
  - file metadata edit.
  - release search console.
  - active download.
  - reject/repair/history/remove/delete/edit.

When modifying films:

- Be careful with `film_editions` vs root `films` fields.
- Current file info may come from active edition or root film.
- Edition names affect file naming and NFO generation.
- Film add behavior may use `requestWithTab` to target a specific library without switching global context.

## Series Implementation

Server files:

- `apps/server/src/domains/series/routes.ts`.
- `apps/server/src/domains/series/serialize.ts`.
- `apps/server/src/domains/series/tvdb.ts`.

Client files:

- `client/src/modules/series/index.tsx`.
- `client/src/lib/series.api.ts`.

DB tables:

- `series`.
- `seasons`.
- `episodes`.
- `episode_files`.

Important server behavior:

- Lookup and preview before add.
- Add series with monitored season selection.
- Maintain series -> seasons -> episodes.
- Update series, season, and episode monitoring/upgrade flags.
- Calendar endpoint.
- Metadata refresh.
- Release search.
- Download/grab at series, season, or episode level.
- Image search/save.
- Acquisition controls for series, seasons, and episodes.

Important client behavior:

- Series library supports search, collection filters, status filters, edit mode, bulk delete, and missing search.
- Detail page loads seasons and lazily loads episodes per selected season.
- Scan series.
- Search season.
- Search individual episode.
- Episode release modal.
- Episode file metadata editing.
- Reacquire selector is season-oriented.

Series acquisition complexity:

- Single episodes.
- Multi-episode releases.
- Season packs.
- Multi-season packs.
- Daily series by air date.
- Anime absolute numbering is recognized but not fully handled.

When modifying series:

- Always preserve season/episode status semantics.
- If changing acquisition, check `release-pipeline/subject-decisions.ts`.
- If changing UI episode behavior, inspect `client/src/lib/series.api.ts` because it adapts backend shapes for the frontend.

## Music Implementation

Server files:

- `apps/server/src/domains/music/routes.ts`.
- `apps/server/src/domains/music/serialize.ts`.
- `apps/server/src/domains/music/musicbrainz.ts`.
- `apps/server/src/domains/music/fanart.ts`.

Client files:

- `client/src/modules/music/index.tsx`.
- `client/src/lib/music.api.ts`.

DB tables:

- `artists`.
- `albums`.
- `tracks`.

Important behavior:

- Add artist from MusicBrainz MBID.
- Optional album type selection at add time.
- Fanart-backed image enrichment.
- Artist detail includes grouped albums.
- Album rows have quality/acquisition policy.
- Track rows show status/progress.
- Album acquisition controls support reject/repair/history.

When modifying music:

- Artist-level delete cascades albums/tracks.
- Album type grouping in UI maps `Album` to `Studio Album`.
- Track lists are loaded through album detail endpoint behavior.

## Books Implementation

Server files:

- `apps/server/src/domains/books/routes.ts`.
- `apps/server/src/domains/books/serialize.ts`.
- `apps/server/src/domains/books/google-books.ts`.

Client files:

- `client/src/modules/books/index.tsx`.
- `client/src/lib/books.api.ts`.

DB tables:

- `authors`.
- `books`.
- `book_editions`.

Important behavior:

- Add author by name.
- Optional series names during add.
- Author lookup.
- Author detail with book list.
- Book metadata editing.
- Book edition format creation.
- Acquisition controls for authors/books.

When modifying books:

- The current UI is author-centric.
- Book-level edit uses shared `MetadataEditorModal`.
- Download endpoint is generic for book releases.

## Comics Implementation

Server files:

- `apps/server/src/domains/comics/routes.ts`.
- `apps/server/src/domains/comics/serialize.ts`.
- `apps/server/src/domains/comics/comicvine.ts`.

Client files:

- `client/src/modules/comics/index.tsx`.
- `client/src/lib/comics-games.api.ts`.

DB tables:

- `comic_series`.
- `comic_issues`.

Important behavior:

- Add series from ComicVine ID.
- Optional monitor-all behavior.
- Series detail lists issues.
- Issue expansion includes quality policy and Get Issue action.
- Issue auto-grab.
- Acquisition controls for series/issues.

When modifying comics:

- Issue numbers are strings, not necessarily integers.
- Import matching must account for issue number formatting.
- Supported import extensions include cbz, cbr, and pdf-like assets.

## Games Implementation

Server files:

- `apps/server/src/domains/games/routes.ts`.
- `apps/server/src/domains/games/serialize.ts`.
- `apps/server/src/domains/games/igdb.ts`.

Client files:

- `client/src/modules/games/index.tsx`.
- `client/src/lib/comics-games.api.ts`.

DB table:

- `games`.

Important behavior:

- Add game by IGDB ID.
- Platform selection when adding.
- Platform filtering in add search.
- All-games library view.
- Platform group/cards and platform page.
- Detail page supports auto-grab, quality policy, metadata edit, history/reject/repair/remove/delete.
- Game acquisition can require trusted release markers.

When modifying games:

- Platforms are stored as JSON text in DB and arrays in client types.
- UI maps Windows PC/Mac/Linux labels to Steam in some contexts.
- Acquisition decisions can reject releases missing trusted game markers.

## Indexer System

Server files:

- `apps/server/src/indexers/routes.ts`.
- `apps/server/src/services/indexer-bridge.ts`.
- `packages/indexer-engine/src/*`.

Client files:

- `client/src/modules/indexers/IndexersPage.tsx`.
- `client/src/lib/shared.api.ts` under `indexers`.

DB table:

- `indexers_ts`.
- `indexer_rss_state`.

Important concepts:

- Indexers are global.
- Per-media routing lives in indexer `settings.mediaTypes`.
- Cardigann definitions come from bundled `data/indexer-definitions`.
- Torznab is also supported.
- CloudflareBypass can be globally configured and per-indexer enabled.
- Indexer status tracks failure counts and recent failures.

Indexers routes:

- `GET /indexers`.
- `GET /indexers/definitions/list`.
- `GET /indexers/:id`.
- `POST /indexers`.
- `PUT /indexers/:id`.
- `DELETE /indexers/:id`.
- `POST /indexers/:id/test`.
- `POST /indexers/test-config`.

Client modal behavior:

- Choose definition.
- Base URL and API key.
- Definition settings.
- CloudflareBypass toggle.
- Per-media enabled/priority.
- Test unsaved config before saving.

When modifying indexers:

- Preserve support for both Cardigann and Torznab.
- If adding definition settings, ensure they flow through `settings`.
- If adding media routing, update both UI media map and release/search filtering behavior.

## Release Pipeline

Server files:

- `release-pipeline/orchestrator.ts`.
- `release-pipeline/poller.ts`.
- `release-pipeline/parser.ts`.
- `release-pipeline/identifier.ts`.
- `release-pipeline/title-index.ts`.
- `release-pipeline/subject-decisions.ts`.
- `release-pipeline/state-store.ts`.
- `release-pipeline/health.ts`.
- `release-pipeline/missing-search.ts`.
- `release-pipeline/routes.ts`.
- `shared/rss-monitor.ts`.
- `services/acquisition-decisions.ts`.

Main runtime flow:

```text
Release orchestrator tick
  -> get enabled indexers
  -> check indexer poll state/health
  -> poll indexer
  -> parse releases
  -> identify monitored subject via title index
  -> group by subject
  -> evaluate candidates
  -> record every decision
  -> choose best accepted release
  -> send to download client
  -> mark decision grabbed
  -> update media status/info_hash
```

Decision services:

- `evaluateRelease(ctx, release)`.
- `chooseBestRelease(ctx, releases)`.
- `recordReleaseDecision(ctx, decision)`.
- `markDecisionGrabbed(decisionId, result)`.
- `blockRelease(input)`.
- `findBlockedRelease(ctx, release)`.

Decision criteria:

- Subject title inclusion.
- Film year match.
- Foreign language rejection unless multi/English marker exists.
- Target tier.
- Manual resolution/source/codec filters.
- Upgrade comparison against current quality.
- Upgrade allowed flag.
- Trusted game marker requirement.
- Seeders.
- Indexer priority.
- Blocklist.

Subject decision functions:

- `decideFilm`.
- `decideSeries`.
- `decideAlbum`.
- `decideGame`.
- `decideForSubject`.

Known limitation:

- Subject decision discovery shows explicit support for films, series, music albums, and games. Other domains can still have manual grabs/routes, but automatic RSS subject decisions may not be equally deep.

When modifying acquisition:

- Start with `services/acquisition-decisions.ts` for scoring/evaluation.
- Then inspect `release-pipeline/subject-decisions.ts` for status updates and download-client categories.
- Then inspect the relevant domain route for manual/auto-grab behavior.
- Update acquisition history UI only if the audit shape changes.

## Torrent System

Server files:

- `apps/server/src/torrents/routes.ts`.
- `apps/server/src/services/torrent-session.ts`.
- `packages/torrent-engine/src/session.ts`.
- `packages/torrent-engine/src/swarm.ts`.
- `packages/torrent-engine/src/piece-manager.ts`.
- `packages/torrent-engine/src/storage.ts`.
- `packages/torrent-engine/src/resume.ts`.
- `packages/bittorrent/src/*`.

Client files:

- `client/src/modules/torrents/TorrentsPage.tsx`.
- `client/src/modules/acquisitions/index.tsx`.
- `client/src/modules/home/DownloadMonitor.tsx`.
- `client/src/lib/shared.api.ts` under `system` torrent helpers.

Main route capabilities:

- `GET /torrents`.
- `GET /torrents/network`.
- `POST /torrents/reorder`.
- `GET /torrents/:id`.
- `GET /torrents/:id/acquisition-match`.
- `PUT /torrents/:id/acquisition-match`.
- `GET /torrents/:id/import-plan`.
- `GET /torrents/:id/diagnostics`.
- `POST /torrents`.
- `POST /torrents/bulk-action`.
- `DELETE /torrents/:id`.
- `POST /torrents/:id/start`.
- `POST /torrents/:id/stop`.
- `POST /torrents/:id/recheck`.
- `POST /torrents/:id/reannounce`.
- `PATCH /torrents/:id/priority`.
- `PATCH /torrents/:id/files`.

Important implementation details:

- Orphaned staged downloads are represented as synthetic torrent rows with ID prefix `orphan:`.
- Removing a torrent without deleting data can ignore the staged path.
- Deleting/removing a torrent can blocklist the release and reset acquisition state.
- Acquisition match overrides connect torrent/source paths to library items.
- Import plans are generated from match override plus source files.
- File tree priority/wanted changes go to torrent session file priority updates.

Embedded torrent session:

- Configured in `services/torrent-session.ts`.
- Uses download, incomplete, resume, and torrent-file directories.
- Enables DHT, PEX, LPD, uTP.
- Registers torrent events to system event store.
- Registers a send function so acquisition can add torrents internally.
- Exposes network diagnostics.

When modifying torrent behavior:

- UI detail state is large; locate subcomponents inside `TorrentsPage.tsx` by function names:
  - `TorrentsPage`.
  - `TorrentDetail`.
  - `TorrentDiagnostics`.
  - `AcquisitionMatch`.
  - `FileTree`.
  - `AddTorrentModal`.
- For API shape changes, update `shared.api.ts` interfaces.
- For session behavior, inspect `packages/torrent-engine/src/session.ts` before changing server wrapper behavior.

## Media Imports

Server files:

- `apps/server/src/services/media-imports.ts`.
- `apps/server/src/shared/media-organizer.ts`.
- `apps/server/src/shared/monitor.ts`.
- `apps/server/src/shared/library-paths.ts`.
- `apps/server/src/shared/library-migration.ts`.

DB tables:

- `media_imports`.
- `ignored_staged_downloads`.
- `torrent_match_overrides`.

Main concepts:

- Downloads complete into staging/download paths.
- Monitor detects completed downloads and/or manual import candidates.
- A media import job is queued.
- Import job resolves item, source files, destination paths.
- Organizer moves/copies files.
- DB row is updated.
- Validation events are recorded.

Import payload:

- `tabId`.
- `tabName`.
- `dbPath`.
- `mediaType`.
- `itemId`.
- `torrentId`.
- `infoHash`.
- `sourcePath`.
- `copy`.
- `expectedVersion`.
- `releaseTitle`.

Supported match media types:

- `films`.
- `series`.
- `series-season`.
- `series-episode`.
- `music`.
- `music-album`.
- `music-discography`.
- `games`.
- `comics`.
- `comics-issue`.
- `comics-volume`.

Import plan roles:

- `primary`.
- `extra`.
- `track`.
- `issue`.
- `ignored`.
- `unmatched`.

Import plan statuses:

- `ready`.
- `needs-review`.
- `blocked`.

Ignored file logic:

- Samples.
- Metadata/proof files.
- Screenshots.
- Files not selected in torrent file list.
- Some partial files.

Validation:

- Video file exists.
- Video file not tiny.
- Video stream exists.
- Audio stream exists.
- Subtitle warnings.
- Chapter warnings/errors.
- Asset extension and size checks.

When modifying imports:

- Update `createImportPlan` and `runMediaImportJob` together if changing mapping behavior.
- Update torrent import-plan UI if plan shape changes.
- Preserve event logging; imports are operationally sensitive.
- Be careful with cross-device moves; organizer already has robust rename/copy fallback.

## Media Organizer

File:

```text
apps/server/src/shared/media-organizer.ts
```

Responsibilities:

- Compute media root.
- Map remote paths with `REMOTE_PATH_MAP`.
- Move files robustly across filesystems.
- Create film folders.
- Download artwork assets.
- Generate film NFO.
- Identify main film file by largest video.
- Move trailers and extras.
- Organize music, episodes, games, comics.
- Probe file info with ffmpeg/ffprobe.
- Detect resolution, codec, audio, subtitles, chapters.

When changing naming/path behavior:

- Check `library-paths.ts` and `library-migration.ts`.
- Check settings defaults in `shared/routes.ts`.
- Check frontend settings UI if user-configurable.

## Media Processor

File:

```text
apps/server/src/services/media-processor.ts
```

Responsibilities:

- Check ffmpeg/ffprobe availability.
- Probe file metadata.
- Probe chapters.
- Clean tracks based on settings.
- Write embedded metadata/chapter/audio/subtitle title edits.

Frontend callers:

- `FileMetadataEditorModal`.
- Film detail Clean Tracks.
- Settings Media Processing.

When modifying file processing:

- Preserve clear error messages; failures surface directly in modals.
- Record events for successful metadata rewrites.
- Validate resulting media in import paths when applicable.

## Subtitle Provider

File:

```text
apps/server/src/services/subtitle-provider.ts
```

Responsibilities:

- Read subtitle settings.
- Search configured provider.
- Download subtitle by file ID.
- Auto-acquire subtitles after imports when enabled.

Frontend callers:

- Film detail subtitle search/download.
- Settings Subtitles.

The current UI and settings are OpenSubtitles-focused.

## Dashboard

Server:

- `apps/server/src/dashboard/routes.ts`.

Client:

- `client/src/modules/home/Dashboard.tsx`.
- `client/src/modules/home/UnifiedAddMedia.tsx`.
- `client/src/modules/home/ManualSearch.tsx`.
- `client/src/modules/home/DownloadMonitor.tsx`.

Dashboard endpoints:

- `/dashboard/stats`.
- `/dashboard/calendar`.
- `/dashboard/system`.
- `/dashboard/downloads`.
- `/dashboard/downloads/:id/action`.
- `/dashboard/search`.
- `/dashboard/search/grab`.

Dashboard is a composite UI. Be careful when changing shared API wrappers because it uses many domains at once.

## Frontend API Layer

Base:

```text
client/src/lib/api.ts
```

Exports:

- `BASE = '/api/v1'`.
- `setTabContext`.
- `getTabContext`.
- `getTabGeneration`.
- `request`.
- `requestWithTab`.
- `streamSearch`.
- `tmdbImage`.
- `formatSize`.
- `formatRuntime`.
- `formatDuration`.

Domain API wrappers:

- `films.api.ts`.
- `series.api.ts`.
- `music.api.ts`.
- `books.api.ts`.
- `comics-games.api.ts`.
- `shared.api.ts`.

Agent rule:

- Do not call `fetch` directly from feature modules unless there is a very good reason.
- Add API methods to the relevant wrapper.
- Add/update TypeScript interfaces in the wrapper.
- Preserve `x-tab-context` behavior.
- Use `streamSearch` for SSE release-search endpoints.

## Frontend Route Layout

App routes in `client/src/App.tsx`:

- `/`: Dashboard.
- `/films/*`: FilmsPage.
- `/series/*`: SeriesPage.
- `/music/*`: MusicPage.
- `/books/*`: BooksPage.
- `/comics/*`: ComicsPage.
- `/games/*`: GamesPage.
- `/acquisitions`: AcquisitionsPage.
- `/settings`: SettingsPage.
- `/system`: SettingsPage alias.

Each media module contains its own nested `Routes`.

Common nested pattern:

- Index library.
- `/add`.
- `/:id` detail.
- Additional domain-specific paths such as game platform pages or films library slug.

## Frontend Shared Components

File:

```text
client/src/components/ui.tsx
```

Key components:

- `Spinner`.
- `Modal`.
- `Field`.
- `Input`.
- `Select`.
- `TabSelect`.
- `Toggle`.
- `QualityPolicyPanel`.
- `ReleaseList`.
- `DetailPage`.
- `DetailHeader`.
- `DetailPoster`.
- `DetailMain`.
- `DetailStoryline`.
- `DetailMetaItem`.
- `LibraryCard`.
- `CollectionFilterBar`.
- `SelectionBar`.
- `StatusBadge`.
- `SearchInput`.
- `PosterSkeleton`.
- `EmptyState`.

Other shared components:

- `Sidebar`.
- `PageHeader`.
- `MetadataEditorModal`.
- `FileMetadataEditorModal`.
- `ItemActions`.
- `MissingSearchModal`.
- `SearchDetailModal`.
- `ErrorBoundary`.

Agent rule:

- Reuse shared components before adding new local UI patterns.
- For metadata editing, prefer `MetadataEditorModal`.
- For acquisition actions, prefer `ItemActionsBar`.
- For quality policy, use `QualityPolicyPanel`.
- For list cards, use `LibraryCard`.

## Settings UI

File:

```text
client/src/modules/settings/index.tsx
```

This file is large and contains multiple local tab components:

- `LibraryTabsTab`.
- `QualityProfilesTab`.
- `RootFoldersTab`.
- `SystemTab`.
- `ApiKeysTab`.
- `TierAccordion`.
- `QualityTiersTab`.
- `AcquisitionDefaultsTab`.
- `MediaProcessingTab`.
- `SubtitlesTab`.
- `EditionRulesTab`.
- `SettingsPage`.

Settings tab names:

- Library Tabs.
- Indexers.
- Quality Profiles.
- Edition Rules.
- Root Folders.
- Acquisition Defaults.
- Quality Tiers.
- Media Processing.
- Subtitles.
- API Keys.
- System.

When modifying settings:

- Check `shared.api.ts` first for existing methods.
- Check `shared/routes.ts` for backend route defaults.
- Check contracts in `packages/contracts/src/settings.ts` if adding validated settings.
- Keep scoped vs global settings clear.

Global setting example:

- CloudflareBypass is global.

Scoped setting examples:

- Acquisition defaults.
- Quality tiers.
- Track cleaner.
- Subtitles.
- Naming/media-management in current route config.

## Configuration and Environment

Config is loaded by `apps/server/src/config.ts`. If direct inspection is unavailable, use README and config example.

Common environment/config concepts:

- App port defaults to `2424`.
- Database path defaults to `./data/archivist.sqlite` or `ARCHIVIST_DB`.
- Media base defaults to `./media` or `ARCHIVIST_MEDIA_BASE`.
- JSON body limit can be set by `ARCHIVIST_JSON_LIMIT`.
- API CORS origins via `ALLOWED_ORIGINS`.
- Root folder safety via `ARCHIVIST_ALLOWED_ROOTS`.
- Torrent directories:
  - `TORRENT_DOWNLOAD_DIR`.
  - `TORRENT_INCOMPLETE_DIR`.
  - `TORRENT_RESUME_DIR`.
  - `TORRENT_FILES_DIR`.
- Torrent ports:
  - `TORRENT_TCP_PORT` / `TORRENT_PEER_PORT`.
  - `TORRENT_ADVERTISE_PORT`.
  - `TORRENT_DHT_PORT`.
  - `TORRENT_UTP_PORT`.
- Provider keys:
  - `TMDB_API_KEY`.
  - `TVDB_API_KEY`.
  - `TVDB_PIN`.
  - `GOOGLE_BOOKS_API_KEY`.
  - `COMICVINE_API_KEY`.
  - `IGDB_CLIENT_ID`.
  - `IGDB_CLIENT_SECRET`.
  - `FANART_API_KEY`.
- Path mapping:
  - `REMOTE_PATH_MAP`.

API keys can be updated through the Settings UI and persisted to `.env`.

## Data Model Summary

Global/system tables:

- `libraries`.
- `app_settings`.
- `root_folders`.
- `quality_profiles`.
- `quality_definitions`.
- `custom_formats`.
- `custom_format_specifications`.
- `download_clients`.
- `indexers_ts`.
- `system_jobs`.
- `system_events`.
- `acquisition_decisions`.
- `release_blocklist`.
- `media_imports`.
- `ignored_staged_downloads`.
- `torrent_match_overrides`.
- `indexer_rss_state`.

Domain tables:

- Films:
  - `films`.
  - `film_editions`.
  - `edition_rules`.
- Series:
  - `series`.
  - `seasons`.
  - `episodes`.
  - `episode_files`.
- Music:
  - `artists`.
  - `albums`.
  - `tracks`.
- Books:
  - `authors`.
  - `books`.
  - `book_editions`.
- Comics:
  - `comic_series`.
  - `comic_issues`.
- Games:
  - `games`.

Common domain row concepts:

- `library_id`.
- Metadata provider IDs.
- Title/sort title/year/overview.
- Artwork paths/URLs.
- Monitored flag.
- Status.
- Root folder.
- Quality profile.
- Target tier/resolution/source/codec.
- Upgrade allowed.
- Current quality snapshot.
- Current release title/group/size.
- Download progress.
- `info_hash`.
- Added/updated timestamps.

## Status Vocabulary

Status values vary by domain. Do not blindly normalize all domains without checking UI expectations.

Common statuses:

- `wanted`.
- `missing`.
- `acquiring`.
- `downloading`.
- `downloaded`.
- `collected`.
- `ignored`.
- `unaired`.

Series status also includes series lifecycle states like:

- `continuing`.
- `ended`.
- `upcoming`.
- `unknown`.

Client `StatusBadge` maps status/progress visually. If adding a status, check both server serializers and `StatusBadge`.

## Quality and Release Scoring

Relevant files:

- `apps/server/src/services/quality.ts`.
- `apps/server/src/services/acquisition-decisions.ts`.
- `packages/core/src/utils/scoring.ts`.
- `packages/contracts/src/quality.ts`.
- `client/src/components/ui.tsx` for `QualityPolicyPanel`.
- `client/src/modules/settings/index.tsx` for quality tiers.

Quality concepts:

- Target tier.
- Target resolution.
- Target source.
- Target codec.
- Current tier.
- Current resolution.
- Current source.
- Current codec.
- Current release group.
- Current edition.
- Current size.
- Current release title.
- Upgrade allowed.

Release scoring combines:

- Static scoring from release title.
- Tier terms.
- Seeders.
- Indexer priority.
- Upgrade comparison.
- Manual filters.
- Blocklist.

## Image Handling

Relevant files:

- Domain provider files.
- Domain image routes.
- `apps/server/src/shared/image-save.ts`.
- `apps/server/src/shared/media-organizer.ts`.
- `client/src/components/MetadataEditorModal.tsx`.

Pattern:

1. Search provider images through domain route.
2. User chooses candidate or custom URL.
3. Server downloads/saves image under media folder.
4. Server updates DB field with `/media/...` path.
5. Client displays via `tmdbImage()` or direct URL/path handling.

When adding image types:

- Update backend search/save route allowed types.
- Update serializer.
- Update frontend metadata editor image type list.

## Provider Integrations

Provider files:

- TMDB: `domains/films/tmdb.ts`.
- TVDB/TMDB series: `domains/series/tvdb.ts`.
- MusicBrainz: `domains/music/musicbrainz.ts`.
- Fanart: `domains/music/fanart.ts`.
- Google Books/OpenLibrary-style: `domains/books/google-books.ts`.
- ComicVine: `domains/comics/comicvine.ts`.
- IGDB: `domains/games/igdb.ts`.
- OpenSubtitles: `services/subtitle-provider.ts`.

Provider code generally:

- Reads API keys from environment.
- Returns normalized objects.
- Is called from routes.
- Is mocked in tests where needed.

When modifying providers:

- Preserve normalized field names expected by add routes and frontend API types.
- Keep provider failures actionable.
- Avoid making tests network-dependent.

## Tests

Server tests:

- `apps/server/test/auth.test.ts`.
- `apps/server/test/config.test.ts`.
- `apps/server/test/foundation.test.ts`.
- `apps/server/test/parser.test.ts`.
- `apps/server/test/quality.test.ts`.
- `apps/server/test/films.e2e.test.ts`.
- `apps/server/test/series.e2e.test.ts`.
- `apps/server/test/music-books.e2e.test.ts`.
- `apps/server/test/comics-games.e2e.test.ts`.
- `apps/server/test/system.e2e.test.ts`.
- `apps/server/test/metadata-edit.test.ts`.
- `apps/server/test/file-metadata.test.ts`.
- `apps/server/test/library-migration.test.ts`.
- `apps/server/test/provider-mock.ts`.
- `apps/server/test/helpers.ts`.
- `apps/server/test/run-all.ts`.

DB tests:

- `packages/db/test/schema.test.ts`.

Testing rules for agents:

- For route/domain changes, run the relevant e2e test file if possible.
- For schema changes, add/update DB schema tests.
- For acquisition/parser changes, run parser and quality tests.
- For system/admin changes, run system e2e tests.
- Provider tests should use mocks; do not require live API keys.

## Common Development Recipes

### Add a Field to a Media Entity

Typical steps:

1. Update `packages/db/src/schema.ts`.
2. Add migration if needed for existing DBs.
3. Update domain SQL select/insert/update in `apps/server/src/domains/<domain>/routes.ts`.
4. Update serializer in `serialize.ts`.
5. Update frontend API type in `client/src/lib/<domain>.api.ts`.
6. Update UI display/edit form.
7. Update metadata editor field list if editable.
8. Add/update tests.

### Add a New Domain Route

Typical steps:

1. Add contract in `packages/contracts/src/domains.ts` if body validation is needed.
2. Add route in domain `routes.ts`.
3. Use `validateBody()` if request body is structured.
4. Use `scopeId(req)` for library-scoped data.
5. Serialize response consistently.
6. Add wrapper method in `client/src/lib/<domain>.api.ts`.
7. Use wrapper in UI.
8. Add tests.

### Add a New Settings Surface

Typical steps:

1. Add contract in `packages/contracts/src/settings.ts`.
2. Add default and route entry in `shared/routes.ts`.
3. Decide whether setting is global or scoped.
4. Add `sharedApi.settings` methods.
5. Add Settings UI tab or panel.
6. If background service reads it, make sure it handles missing/default values.

### Add a New Acquisition Decision Rule

Typical steps:

1. Update `services/acquisition-decisions.ts`.
2. Ensure reason/rejection text is clear; it appears in acquisition history.
3. Update tests for quality/acquisition if present.
4. Check manual filters still work.
5. Check upgrade behavior for collected items.

### Add a New Import Mapping

Typical steps:

1. Update `services/media-imports.ts` plan and job execution.
2. Update `shared/media-organizer.ts` if destination organization changes.
3. Update validation if file type differs.
4. Update torrent import-plan UI if needed.
5. Add tests or provider mocks for the new path.

### Add a New Frontend Page

Typical steps:

1. Add module under `client/src/modules/`.
2. Add API wrapper methods if needed.
3. Add route in `App.tsx` or nested media module.
4. Add sidebar nav item if top-level.
5. Use existing UI components.
6. Check mobile and narrow layouts if changing UI.

## Agent Search Guide

Use these starting points by task:

- App startup/API mounting: `apps/server/src/app.ts`, `apps/server/src/routes.ts`.
- New API endpoint: relevant `routes.ts`, contracts, frontend API wrapper.
- Library/tab behavior: `shared/routes.ts`, `library-context.ts`, `tab-context.tsx`.
- DB shape: `packages/db/src/schema.ts`.
- Migration: `packages/db/src/migrations.ts`.
- Film UI: `client/src/modules/films/index.tsx`.
- Series UI: `client/src/modules/series/index.tsx`.
- Music UI: `client/src/modules/music/index.tsx`.
- Books UI: `client/src/modules/books/index.tsx`.
- Comics UI: `client/src/modules/comics/index.tsx`.
- Games UI: `client/src/modules/games/index.tsx`.
- Settings UI: `client/src/modules/settings/index.tsx`.
- Indexers UI/API: `client/src/modules/indexers/IndexersPage.tsx`, `apps/server/src/indexers/routes.ts`.
- Torrents UI/API: `client/src/modules/torrents/TorrentsPage.tsx`, `apps/server/src/torrents/routes.ts`.
- Dashboard: `dashboard/routes.ts`, `client/src/modules/home/*`.
- Release scoring: `services/acquisition-decisions.ts`, `packages/core/src/utils/scoring.ts`.
- Release parsing: `release-pipeline/parser.ts`.
- Release identification: `release-pipeline/identifier.ts`, `title-index.ts`.
- RSS/polling: `release-pipeline/orchestrator.ts`, `poller.ts`, `shared/rss-monitor.ts`.
- Imports: `services/media-imports.ts`, `shared/media-organizer.ts`.
- File metadata/ffmpeg: `services/media-processor.ts`.
- Subtitles: `services/subtitle-provider.ts`.
- Jobs/events: `system/event-store.ts`, `system/job-runner.ts`.
- Maintenance: `system/maintenance.ts`.
- Backups: `system/backups.ts`.
- Integrity: `system/data-integrity.ts`.

## Important Invariants and Pitfalls

- Do not reintroduce physical per-tab DBs. Tabs are libraries in one DB.
- Do not edit generated `dist` output by hand.
- Do not bypass `request()`/`requestWithTab()` in frontend API calls.
- Do not forget `library_id` filtering on media queries.
- Do not treat all settings as global. Many are scoped by library.
- Do not change response shapes casually; the UI often consumes legacy column names.
- Do not change status values without checking UI filters and `StatusBadge`.
- Do not delete user files unless the user action includes `deleteFiles=true` or `deleteData=true`.
- Do not make provider tests require live network/API keys.
- Do not assume films, series, music, books, comics, and games all have identical acquisition depth.
- Do not assume a torrent row is always a live torrent; it may be an orphaned staged download.
- Do not assume a media import source is local until `mapRemotePath()` is applied.
- Do not remove acquisition decision recording; users depend on audit history.
- Do not bypass release blocklist checks when adding new grab flows.
- Do not perform broad refactors in large single-file UI modules unless the task demands it.

## Current Large Files Worth Treating Carefully

Large frontend files:

- `client/src/modules/films/index.tsx`.
- `client/src/modules/settings/index.tsx`.
- `client/src/modules/torrents/TorrentsPage.tsx`.
- `client/src/modules/series/index.tsx`.

Large backend files:

- `apps/server/src/domains/films/routes.ts`.
- `apps/server/src/domains/series/routes.ts`.
- `apps/server/src/services/media-imports.ts`.
- `apps/server/src/system/data-integrity.ts`.
- `apps/server/src/shared/media-organizer.ts`.
- `packages/torrent-engine/src/session.ts`.

When editing these, make small, localized patches and inspect surrounding helper functions first.

## API Surface Summary

Shared/global:

- `/api/v1/health`.
- `/api/v1/events`.
- `/api/v1/tabs`.
- `/api/v1/tabs/root-folders`.
- `/api/v1/download-clients`.
- `/api/v1/quality-profiles`.
- `/api/v1/quality-definitions`.
- `/api/v1/root-folders`.
- `/api/v1/settings/*`.
- `/api/v1/media/file-metadata/read`.
- `/api/v1/media/file-metadata`.
- `/api/v1/media/clean-tracks`.
- `/api/v1/subtitles/search`.
- `/api/v1/subtitles/download`.

Dashboard:

- `/api/v1/dashboard/stats`.
- `/api/v1/dashboard/calendar`.
- `/api/v1/dashboard/system`.
- `/api/v1/dashboard/downloads`.
- `/api/v1/dashboard/search`.

Indexers:

- `/api/v1/indexers`.
- `/api/v1/indexers/definitions/list`.
- `/api/v1/indexers/:id/test`.
- `/api/v1/indexers/test-config`.

Torrents:

- `/api/v1/torrents`.
- `/api/v1/torrents/network`.
- `/api/v1/torrents/reorder`.
- `/api/v1/torrents/:id`.
- `/api/v1/torrents/:id/acquisition-match`.
- `/api/v1/torrents/:id/import-plan`.
- `/api/v1/torrents/:id/diagnostics`.
- `/api/v1/torrents/:id/start`.
- `/api/v1/torrents/:id/stop`.
- `/api/v1/torrents/:id/recheck`.
- `/api/v1/torrents/:id/reannounce`.
- `/api/v1/torrents/:id/priority`.
- `/api/v1/torrents/:id/files`.

System:

- `/api/v1/system/jobs`.
- `/api/v1/system/events`.
- `/api/v1/system/rss/run`.
- `/api/v1/system/acquisition-decisions`.
- `/api/v1/system/release-blocklist`.
- `/api/v1/system/media-imports`.
- `/api/v1/system/integrity`.
- `/api/v1/system/manual-imports/*`.
- `/api/v1/system/overview`.
- `/api/v1/system/maintenance`.
- `/api/v1/system/backups`.
- `/api/v1/system/db`.

Domains:

- `/api/v1/films/*`.
- `/api/v1/series/*`.
- `/api/v1/music/*`.
- `/api/v1/books/*`.
- `/api/v1/comics/*`.
- `/api/v1/games/*`.

## Final Orientation for Future Agents

If you are starting a task cold:

1. Identify the domain or platform area.
2. Open the frontend API wrapper for that area.
3. Open the corresponding server router.
4. Open the DB schema section for affected tables.
5. Open serializer/provider/service helpers as needed.
6. Check whether the feature is library-scoped.
7. Check whether acquisition/import/history/blocklist behavior is involved.
8. Make the smallest coherent change.
9. Update tests for the affected layer.
10. Do not touch generated or runtime data files.

Archivist’s core design is simple but broad: one unified database, library-scoped media rows, route-level vertical slices, shared contracts at API boundaries, React modules per product area, and background services for acquisition/import/system operations. Most successful changes follow existing local patterns rather than introducing new abstractions.

---

# Appendices: Fast Reference for Agents

These appendices turn the guide into a denser working reference. They cover the remaining material needed to reduce repeated analysis: exact runtime config, endpoint ownership, request contracts, table fields, workflow call graphs, tests, known risk areas, and agent startup protocol.

## Appendix A: Exact Runtime Configuration

Config is loaded by `apps/server/src/config.ts`.

Load order:

1. Read TOML from explicit `loadConfig(configPath)`, otherwise `ARCHIVIST_CONFIG`, otherwise `./config.toml`.
2. Parse with `smol-toml`.
3. Validate/default with Zod `ConfigSchema`.
4. Override selected values from environment variables.
5. Mirror provider credentials into `process.env` for provider clients that read env directly.

Config schema and defaults:

| Config path | Type | Default | Env override |
|---|---:|---|---|
| `server.host` | string | `0.0.0.0` | `ARCHIVIST_HOST`, fallback `HOST` |
| `server.port` | number | `2424` | `ARCHIVIST_PORT`, fallback `PORT` |
| `auth.api_key` | string | empty string | `ARCHIVIST_API_TOKEN`, fallback `ARCHIVIST_AUTH_TOKEN` |
| `database.path` | string | `./data/archivist.sqlite` | `ARCHIVIST_DB` |
| `definitions.path` | string | `./data/indexer-definitions` | `ARCHIVIST_DEFINITIONS_PATH` |
| `definitions.offline` | boolean | `false` | `DEFINITIONS_OFFLINE` |
| `downloads.download_dir` | string | `./data/downloads` | `TORRENT_DOWNLOAD_DIR` |
| `downloads.incomplete_dir` | string | `./data/incomplete` | `TORRENT_INCOMPLETE_DIR` |
| `downloads.resume_dir` | string | `./data/resume` | `TORRENT_RESUME_DIR` |
| `downloads.torrents_dir` | string | `./data/torrents` | `TORRENT_FILES_DIR` |
| `downloads.embedded_engine` | boolean | `true` | `ARCHIVIST_EMBEDDED_TORRENTS` |
| `metadata.tmdb.api_key` | string | empty string | `TMDB_API_KEY` |
| `metadata.tmdb.base_url` | string | `https://api.themoviedb.org/3` | `TMDB_BASE_URL` |
| `metadata.tvdb.api_key` | string | empty string | `TVDB_API_KEY` |
| `metadata.tvdb.pin` | string | empty string | `TVDB_PIN` |
| `metadata.google_books.api_key` | string | empty string | `GOOGLE_BOOKS_API_KEY` |
| `metadata.comicvine.api_key` | string | empty string | `COMICVINE_API_KEY` |
| `metadata.igdb.client_id` | string | empty string | `IGDB_CLIENT_ID` |
| `metadata.igdb.client_secret` | string | empty string | `IGDB_CLIENT_SECRET` |
| `metadata.fanart.api_key` | string | empty string | `FANART_API_KEY` |

Other environment variables used outside `config.ts`:

| Env var | Used by | Purpose |
|---|---|---|
| `ARCHIVIST_JSON_LIMIT` | `app.ts` | Express JSON body limit, default `1mb`. |
| `ALLOWED_ORIGINS` | `app.ts` | Comma-separated CORS allow list, default local Vite origins. |
| `ARCHIVIST_ALLOWED_ROOTS` | `shared/routes.ts` | Optional absolute-path allow list for root folders. |
| `ARCHIVIST_MEDIA_BASE` | `shared/media-organizer.ts`, `shared/routes.ts` | Media root override. |
| `REMOTE_PATH_MAP` | `shared/media-organizer.ts` | Comma-separated `remote:local` path mappings. |
| `TORRENT_PEER_HOST` | `services/torrent-session.ts` | TCP peer bind host, default `0.0.0.0`. |
| `TORRENT_TCP_PORT` | `services/torrent-session.ts` | TCP peer port, fallback `TORRENT_PEER_PORT`, default `2425`. |
| `TORRENT_ADVERTISE_PORT` | `services/torrent-session.ts` | Public advertised torrent port. |
| `TORRENT_DHT_PORT` | `services/torrent-session.ts` | DHT UDP port, default `2426`. |
| `TORRENT_UTP_PORT` | `services/torrent-session.ts` | uTP UDP port, default `2427`. |

Provider credentials mirrored into env:

- `TMDB_API_KEY`
- `TMDB_BASE_URL`
- `TVDB_API_KEY`
- `TVDB_PIN`
- `GOOGLE_BOOKS_API_KEY`
- `COMICVINE_API_KEY`
- `IGDB_CLIENT_ID`
- `IGDB_CLIENT_SECRET`
- `FANART_API_KEY`

If adding config:

1. Add Zod schema/default in `config.ts`.
2. Add env override if needed.
3. Mirror provider keys if provider code reads env.
4. Add `.env.example` and `apps/server/config.example.toml` entries.
5. Add/update `apps/server/test/config.test.ts`.

## Appendix B: Endpoint Matrix

All paths below are mounted under `/api/v1` unless noted. `/ping` is mounted at app root and remains public.

### Public and Runtime

| Method | Path | Owner | Purpose |
|---|---|---|---|
| GET | `/ping` | `app.ts` | Public process ping. |
| GET | `/health` | `app.ts` | API health/version. |
| GET | `/events` | `app.ts`, `system/sse.ts` | SSE stream. |

### Shared Libraries, Settings, and Media Utilities

Owner: `apps/server/src/shared/routes.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/tabs` | List libraries using legacy tab shape. |
| GET | `/tabs/root-folders` | List root folders across all tabs. |
| POST | `/tabs` | Create library/tab. Body: `CreateLibrary`. |
| PUT | `/tabs/:id` | Rename library/tab. Body: `UpdateLibrary`. |
| POST | `/tabs/:id/clear` | Clear library contents; `deleteFiles=true` removes files. |
| DELETE | `/tabs/:id` | Delete library; `deleteFiles=true` removes files. |
| GET | `/download-clients` | List scoped download clients. |
| POST | `/download-clients` | Create scoped download client. Body: `CreateDownloadClient`. |
| PUT | `/download-clients/:id` | Update scoped download client. |
| DELETE | `/download-clients/:id` | Delete scoped download client. |
| POST | `/download-clients/test` | Test unsaved download-client config. |
| POST | `/download-clients/:id/test` | Test saved download client. |
| GET | `/quality-profiles` | List scoped quality profiles. |
| POST | `/quality-profiles` | Create scoped quality profile. |
| PUT | `/quality-profiles/:id` | Update scoped quality profile. |
| DELETE | `/quality-profiles/:id` | Delete scoped quality profile. |
| GET | `/quality-definitions` | List scoped quality definitions. |
| POST | `/quality-definitions` | Create scoped quality definition. |
| PUT | `/quality-definitions/:id` | Update scoped quality definition. |
| DELETE | `/quality-definitions/:id` | Delete scoped quality definition. |
| GET | `/root-folders` | List scoped root folders with disk stats. |
| POST | `/root-folders` | Add scoped root folder. Body: `AddRootFolder`. |
| DELETE | `/root-folders/:id` | Delete scoped root folder. |
| GET | `/settings/naming` | Get scoped naming settings. |
| PUT | `/settings/naming` | Merge scoped naming settings. |
| GET | `/settings/media-management` | Get scoped media-management settings. |
| PUT | `/settings/media-management` | Merge scoped media-management settings. |
| GET | `/settings/acquisition-defaults` | Get scoped acquisition defaults. |
| PUT | `/settings/acquisition-defaults` | Merge scoped acquisition defaults. |
| GET | `/settings/track-cleaner` | Get scoped track cleaner settings. |
| PUT | `/settings/track-cleaner` | Merge scoped track cleaner settings. |
| GET | `/settings/subtitles` | Get scoped subtitle settings. |
| PUT | `/settings/subtitles` | Merge scoped subtitle settings. |
| GET | `/settings/cloudflareBypass` | Get global CloudflareBypass settings. |
| PUT | `/settings/cloudflareBypass` | Merge global CloudflareBypass settings. |
| GET | `/settings/media-base-dir` | Return resolved media base path. |
| GET | `/settings/quality-tiers` | Get scoped quality tier terms. |
| PUT | `/settings/quality-tiers` | Replace scoped quality tier terms. |
| GET | `/settings/track-cleaner/status` | Check ffmpeg/ffprobe availability. |
| POST | `/media/file-metadata/read` | Probe file metadata. Body: `{ filePath }`. |
| PUT | `/media/file-metadata` | Rewrite chapters/audio/subtitle titles. |
| POST | `/media/clean-tracks` | Run track cleaner on a media file. |
| POST | `/subtitles/search` | Search subtitles. |
| POST | `/subtitles/download` | Download subtitle beside media file. |
| GET | `/settings/api-keys` | Read masked provider key state. |
| PUT | `/settings/api-keys` | Persist provider keys to env and `.env`. |

### Dashboard

Owner: `apps/server/src/dashboard/routes.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard/stats` | Aggregate counts/recent additions. |
| GET | `/dashboard/calendar` | Calendar events for date range. |
| GET | `/dashboard/system` | CPU/memory/storage snapshot. |
| GET | `/dashboard/downloads` | Compact active download list. |
| POST | `/dashboard/downloads/:id/action` | Pause/resume/remove/delete download. |
| GET | `/dashboard/search` | Manual indexer search. |
| POST | `/dashboard/search/grab` | Grab manual search result. |

### Indexers

Owner: `apps/server/src/indexers/routes.ts`, mounted at `/indexers`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/indexers` | List configured indexers. |
| GET | `/indexers/definitions/list` | List bundled definition summaries. |
| GET | `/indexers/:id` | Get one indexer config. |
| POST | `/indexers` | Create indexer. |
| PUT | `/indexers/:id` | Update indexer. |
| DELETE | `/indexers/:id` | Delete indexer. |
| POST | `/indexers/:id/test` | Test saved indexer. |
| POST | `/indexers/test-config` | Test unsaved indexer config. |

### Release Pipeline

Owner: `apps/server/src/release-pipeline/routes.ts`, mounted at `/release-pipeline`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/release-pipeline/health` | Pipeline/indexer state summary. |
| POST | `/release-pipeline/refresh` | Force refresh all enabled indexers. |
| POST | `/release-pipeline/refresh/:indexerId` | Force refresh one indexer. |
| POST | `/release-pipeline/missing-search` | Trigger missing-search cycle. |

### Torrents

Owner: `apps/server/src/torrents/routes.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/torrents` | List live torrents and orphan staged downloads. |
| GET | `/torrents/network` | Web/TCP/tracker/DHT/uTP/LPD diagnostics. |
| POST | `/torrents/reorder` | Persist queue order. Body: `{ orderedIds }`. |
| GET | `/torrents/:id` | Get torrent or orphan. |
| GET | `/torrents/:id/acquisition-match` | Get match override. |
| GET | `/torrents/:id/import-plan` | Build import plan for matched torrent/source. |
| PUT | `/torrents/:id/acquisition-match` | Save match override and mark target acquiring. |
| GET | `/torrents/:id/diagnostics` | Detailed live torrent diagnostics. |
| POST | `/torrents` | Add magnet or torrent URL. |
| POST | `/torrents/bulk-action` | Bulk start/stop/remove/delete. |
| DELETE | `/torrents/:id` | Remove torrent/orphan; `deleteData=true` deletes files. |
| POST | `/torrents/:id/start` | Start torrent. |
| POST | `/torrents/:id/stop` | Stop torrent. |
| POST | `/torrents/:id/recheck` | Verify torrent. |
| POST | `/torrents/:id/reannounce` | Reannounce trackers. |
| PATCH | `/torrents/:id/priority` | Set bandwidth priority. |
| PATCH | `/torrents/:id/files` | Set file wanted/priority updates. |

### System Runtime and Admin

Owners: `apps/server/src/system/routes.ts` and `apps/server/src/system/admin-routes.ts`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/system/jobs` | List jobs. |
| GET | `/system/events` | List events. |
| POST | `/system/jobs/:id/cancel` | Cancel job. |
| POST | `/system/jobs/:id/retry` | Retry job. |
| POST | `/system/rss/run` | Force RSS run. |
| POST | `/system/jobs` | Admin enqueue job. |
| GET | `/system/acquisition-decisions` | List acquisition audit decisions. |
| GET | `/system/release-blocklist` | List blocked releases. |
| DELETE | `/system/release-blocklist/:id` | Unblock release. |
| GET | `/system/media-imports` | List import records. |
| GET | `/system/integrity` | Get integrity config/report/current scan. |
| PUT | `/system/integrity` | Update integrity config. |
| POST | `/system/integrity/run` | Run integrity scan. |
| POST | `/system/integrity/repair` | Repair one integrity problem. |
| POST | `/system/integrity/repair-bulk` | Bulk repair integrity problems. |
| GET | `/system/manual-imports/candidates` | Scan staged downloads for candidates. |
| GET | `/system/manual-imports/search` | Search library targets for manual import. |
| POST | `/system/manual-imports/queue` | Queue manual import. |
| GET | `/system/overview` | Aggregate ops overview. |
| GET | `/system/maintenance` | Get maintenance config/result. |
| PUT | `/system/maintenance` | Update maintenance config. |
| POST | `/system/maintenance/run` | Run maintenance now. |
| GET | `/system/backups` | Get backup config/manifests. |
| PUT | `/system/backups` | Update backup config. |
| POST | `/system/backups/run` | Run backup now. |
| GET | `/system/db` | DB status/open connections. |
| POST | `/system/db/checkpoint` | SQLite checkpoint. |

### Domain Endpoints

Films, owner `domains/films/routes.ts`:

- `GET /films`
- `GET /films/lookup`
- `GET /films/:id`
- `GET /films/tmdb/:tmdbId`
- `POST /films`
- `PUT /films/editions/:id`
- `PUT /films/:id`
- `GET /films/:id/acquisition-history`
- `POST /films/:id/reject-current-release`
- `POST /films/:id/repair`
- `DELETE /films/:id`
- `POST /films/refresh`
- `GET /films/releases/search`
- `POST /films/download`
- `POST /films/:id/auto-grab`
- `PUT /films/:id/metadata`
- `GET /films/:id/images`
- `PUT /films/:id/images`
- `GET /films/edition-rules/all`
- `POST /films/edition-rules`
- `PUT /films/edition-rules/:id`
- `DELETE /films/edition-rules/:id`

Series, owner `domains/series/routes.ts`:

- `GET /series`
- `GET /series/lookup`
- `GET /series/preview`
- `GET /series/calendar`
- `GET /series/:id`
- `GET /series/tmdb/:tmdbId`
- `POST /series`
- `PUT /series/:id`
- `PUT /series/:id/metadata`
- `GET /series/:id/images`
- `PUT /series/:id/images`
- `GET /series/:id/acquisition-history`
- `DELETE /series/:id`
- `POST /series/refresh`
- `GET /series/:id/seasons`
- `PUT /series/seasons/:seasonId`
- `GET /series/:id/episodes`
- `PUT /series/episodes/:episodeId`
- `GET /series/releases/search`
- `POST /series/download`

Music, owner `domains/music/routes.ts`:

- `GET /music/artists`
- `GET /music/artists/:id`
- `POST /music/artists`
- `PUT /music/artists/:id/metadata`
- `GET /music/artists/:id/images`
- `PUT /music/artists/:id/images`
- `GET /music/artists/:id/acquisition-history`
- `DELETE /music/artists/:id`
- `POST /music/refresh`
- `GET /music/albums/:id`
- `PUT /music/albums/:id`
- `GET /music/lookup`
- `GET /music/lookup/:mbid`
- `POST /music/albums/:id/auto-grab`
- `POST /music/download`

Books, owner `domains/books/routes.ts`:

- `GET /books/authors`
- `GET /books/authors/:id`
- `POST /books/authors`
- `PUT /books/authors/:id/metadata`
- `PUT /books/:id/metadata`
- `GET /books/authors/:id/images`
- `PUT /books/authors/:id/images`
- `GET /books/:id/images`
- `PUT /books/:id/images`
- `GET /books/authors/:id/acquisition-history`
- `DELETE /books/authors/:id`
- `PUT /books/:id`
- `POST /books/:id/editions`
- `GET /books/lookup/authors`
- `GET /books/lookup/author/:name`
- `GET /books/lookup/books`
- `POST /books/:id/auto-grab`
- `POST /books/download`
- `POST /books/refresh`

Comics, owner `domains/comics/routes.ts`:

- `POST /comics/issues/:id/auto-grab`
- `GET /comics/series`
- `GET /comics/series/:id`
- `POST /comics/series`
- `PUT /comics/series/:id/metadata`
- `GET /comics/series/:id/images`
- `PUT /comics/series/:id/images`
- `GET /comics/series/:id/acquisition-history`
- `DELETE /comics/series/:id`
- `PUT /comics/issues/:id`
- `GET /comics/lookup`
- `POST /comics/download`
- `POST /comics/refresh`

Games, owner `domains/games/routes.ts`:

- `GET /games`
- `GET /games/lookup`
- `GET /games/:id`
- `POST /games`
- `PUT /games/:id`
- `PUT /games/:id/metadata`
- `GET /games/:id/images`
- `PUT /games/:id/images`
- `DELETE /games/:id`
- `POST /games/:id/auto-grab`
- `POST /games/download`
- `POST /games/refresh`

Shared acquisition-control helper may add these for selected subject routes:

- `GET <route>/acquisition-history`
- `POST <route>/reject-current-release`
- `POST <route>/repair`

## Appendix C: Request Contract Matrix

Source: `packages/contracts/src`.

| Contract | Required | Optional | Notes |
|---|---|---|---|
| `AddFilm` | `tmdbId` | `qualityProfileId`, `rootFolderPath`, `monitored`, target tier/resolution/source/codec | `tmdbId` string/number transformed. |
| `UpdateFilm` | none | `monitored`, `status`, `qualityProfileId`, `rootFolderPath`, `upgrade_allowed`, target fields, `default_edition_id` | Status enum: wanted/downloading/downloaded/missing/ignored. |
| `DownloadFilm` | `downloadUrl` | `filmId`, `tier`, `version` | Tier 1-3. |
| `AddSeries` | `tvdbId` or `tmdbId` | `monitored`, `monitoredSeasons`, `qualityProfileId`, `rootFolderPath`, `upgrade_allowed`, target fields | Refinement requires one provider ID. |
| `UpdateSeries` | none | `monitored`, `qualityProfileId`, `rootFolderPath`, `upgrade_allowed`, target fields | No status field. |
| `UpdateSeason` | none | `monitored`, `upgrade_allowed` | Boolean toggles. |
| `UpdateEpisode` | none | `monitored`, `upgrade_allowed` | Boolean toggles. |
| `DownloadSeries` | `downloadUrl` | route accepts passthrough extras | Series/season/episode targeting is loose. |
| `AddArtist` | `mbid` | `monitored`, `rootFolderPath`, `albumTypes` | MusicBrainz ID. |
| `UpdateAlbum` | none | `monitored`, `status`, `upgrade_allowed`, `target_tier` | Status enum: missing/downloading/downloaded/ignored. |
| `DownloadMusic` | `downloadUrl` | passthrough extras | Generic release grab. |
| `AddBookAuthor` | `name` | `monitored`, `rootFolderPath`, `seriesNames` | Author-centric. |
| `UpdateBook` | none | `monitored`, `status` | Status enum: missing/downloading/downloaded/ignored. |
| `AddBookEdition` | `format` | none | epub/pdf/mobi/azw3/cbz/cbr. |
| `DownloadBooks` | `downloadUrl` | passthrough extras | Generic release grab. |
| `AddComicSeries` | `cvId` | `monitored`, `monitorAll`, `rootFolderPath` | ComicVine ID. |
| `UpdateComicSeries` | none | `monitored` | Simple toggle. |
| `UpdateComicIssue` | none | `monitored`, `status`, `upgrade_allowed` | Status enum includes unaired. |
| `DownloadComics` | `downloadUrl` | passthrough extras | Generic release grab. |
| `AddGame` | `igdbId` | `monitored`, `rootFolderPath`, `platforms` | IGDB ID. |
| `UpdateGame` | none | `monitored`, `status`, `upgrade_allowed`, `target_tier` | Status enum: missing/downloading/downloaded/ignored. |
| `DownloadGames` | `downloadUrl` | passthrough extras | Generic release grab. |
| `CreateDownloadClient` | `name`, `type`, `host`, `port` | `useSsl`, `urlBase`, `username`, `password`, `category`, `enabled`, `priority`, `tags` | Type enum: transmission/qbittorrent. |
| `CreateLibrary` | `name`, `mediaType`, `dbPath` | none | `dbPath` is compatibility metadata. |
| `UpdateLibrary` | `name` | none | Rename only. |
| `AddRootFolder` | `path` | none | Server requires absolute path. |
| `CreateQualityProfile` | `name` | `cutoff`, `items`, `upgradeAllowed`, `minFormatScore` | Scoped. |
| `UpdateQualityProfile` | none | same profile fields | Scoped. |
| `CreateQualityDefinition` | `title` | `weight`, `minSize`, `maxSize` | Validates min <= max. |
| `UpdateQualityDefinition` | none | same definition fields | Validates min <= max. |
| `AcquisitionDefaults` | `tier`, `resolution`, `source`, `codec` | none | Scoped setting. |
| `TrackCleanerConfig` | all cleaner booleans/language fields | none | Scoped setting. |
| `SubtitleConfig` | enabled/provider/api key/default language/acquire flags | none | Client currently carries extra OpenSubtitles fields too. |
| `UpdateApiKeys` | all provider key fields default string | none | Masked values are ignored by server persistence. |

## Appendix D: Database Field Map

This is an orientation map. `packages/db/src/schema.ts` remains final truth.

Global/config tables:

- `libraries`: `id`, `name`, `media_type`, `db_path`, `created_at`.
- `app_settings`: `library_id`, `key`, `value`; primary key `(library_id, key)`.
- `root_folders`: `id`, `library_id`, `path`, `created_at`; unique `(library_id, path)`.
- `quality_profiles`: `id`, `library_id`, `name`, `upgrade_allowed`, `cutoff`, `min_format_score`, `items`, `created_at`.
- `quality_definitions`: `id`, `library_id`, `title`, `weight`, `min_size`, `max_size`; unique `(library_id, title)`.
- `custom_formats`: `id`, `library_id`, `name`, `include_when_renaming`, `created_at`.
- `custom_format_specifications`: `id`, `custom_format_id`, `name`, `implementation`, `negate`, `required`, `fields`.
- `download_clients`: `id`, `library_id`, `name`, `type`, `host`, `port`, `use_ssl`, `url_base`, `username`, `password`, `category`, `enabled`, `priority`, `tags`, `created_at`, `updated_at`.
- `indexers_ts`: `id`, `name`, `type`, `protocol`, `definition_id`, `enabled`, `priority`, `redirect`, `base_url`, `api_path`, `api_key`, `username`, `password`, `download_link_type`, `minimum_seeders`, `seed_ratio`, `seed_time`, `sync_profile_id`, `tags`, `vip_expiration`, `additional_parameters`, `settings`, `status`, `last_tested_at`, `capabilities`, `created_at`, `updated_at`.

System/audit tables:

- `system_jobs`: `id`, `type`, `status`, `subject_type`, `subject_id`, `attempts`, `max_attempts`, `payload`, `last_error`, `available_at`, `locked_at`, `created_at`, `updated_at`, `started_at`, `finished_at`.
- `system_events`: `id`, `ts`, `category`, `action`, `severity`, `subject_type`, `subject_id`, `message`, `data`.
- `acquisition_decisions`: decision audit fields for source, library, media subject, release identity, indexer metadata, accepted/score/tier/reasons, grabbed/result.
- `release_blocklist`: `id`, `created_at`, `info_hash`, `release_guid`, `download_url`, `release_title`, `reason`, `tab_id`, `media_type`, `subject_type`, `subject_id`.
- `media_imports`: import audit fields for library, media type/item, torrent/hash/source/destination, status/copy/attempts/error/payload.
- `ignored_staged_downloads`: `id`, `created_at`, `source_path`, `name`, `reason`.
- `torrent_match_overrides`: saved torrent/source-to-media match fields including library, media type, item ID, title, subtitle, status, score.
- `indexer_rss_state`: per-indexer poll timestamps, success/failure counters, backoff, highest pub date, recent GUIDs, last error, health, poll interval.

Domain tables:

- `films`: identity/provider fields, metadata/art/cast/crew, status/monitoring/policy, file/progress/hash, release dates, target policy, current quality snapshot, default edition, timestamps.
- `film_editions`: `film_id`, edition metadata, status/file/current quality fields, timestamps.
- `edition_rules`: scoped regex rules for detecting edition labels.
- `series`: identity/provider fields, metadata/art/cast/crew, status/type/schedule, policy/targets, refresh cadence, timestamps.
- `seasons`: `series_id`, `season_number`, metadata/art, episode count, monitoring/upgrade, progress/hash.
- `episodes`: `series_id`, `season_id`, season/episode numbers, provider ID, metadata/still, monitoring/status, file/progress/hash, current quality.
- `episode_files`: grouped file records for series episodes.
- `artists`: identity/provider fields, metadata/art, album types, monitoring/root, timestamps.
- `albums`: artist/provider fields, metadata/art, monitoring/status/policy, current quality, progress/hash.
- `tracks`: album/artist/provider fields, track numbering/duration, monitoring/status/file/progress/hash.
- `authors`: metadata/art/genres, monitoring/root, timestamps.
- `books`: author/provider/ISBN fields, book/series metadata, monitoring/status/policy/current quality/progress/hash.
- `book_editions`: format/narrator/duration/file/status.
- `comic_series`: provider/metadata/art/status/monitoring/root.
- `comic_issues`: series/provider issue fields, metadata/art/status/file/current quality/progress/hash.
- `games`: provider/metadata/platform/art/status/file/policy/current quality/progress/hash.

Scope rule:

- `library_id = 0` means global setting scope for settings-style tables.
- Positive `library_id` means actual library/tab scope.
- Media rows should always carry a positive `library_id` at the root entity level.

## Appendix E: Core Workflow Call Graphs

### App Boot

```text
server.ts
  createApp()
    loadConfig()
    initDb(config.database.path)
      openUnifiedDb()
        openDatabase()
        applySchema()
        runMigrations()
    ensureDefaultLibraries()
    initIndexerBridge(getDb(), config.definitions.path)
    optionally initTorrentSession()
    configure Express middleware
    mount runtime/shared/domain routers
    optionally serve SPA
    startJobRunner()
    startBackgroundServices()
```

### Frontend Request With Library Scope

```text
Sidebar/useTabs setActiveTabForMedia(mediaType, tabId)
  tab-context setActiveTabId(tabId)
    localStorage update
    api.ts setTabContext(tabId)
feature api wrapper calls request(path)
  request() adds x-tab-context
server libraryContextMiddleware parses header
  route calls scopeId(req)
  SQL filters by library_id
```

### Add Film

```text
filmsApi.lookup(q) -> GET /films/lookup
  films/routes -> tmdb search
user confirms
  filmsApi.add() or requestWithTab(tabId, '/films')
    POST /films
      validate AddFilm
      tmdb getMovie()
      ensureFilmFolder()
      INSERT films row
      serialize response
```

### Film Release Search and Grab

```text
FilmDetailPage handleSearch()
  filmsApi.releases.search()
    streamSearch('/films/releases/search')
      server searches indexers
      SSE batches to ReleaseList
user grabs
  POST /films/download
    sendToDownloadClient()
    update media status/hash when applicable
    record/mark acquisition decision
```

### Automatic RSS Acquisition

```text
startReleaseOrchestrator()
  startTitleIndex()
  tick every 30s
    get enabled indexers
    state-store getState()
    health.isReadyToPoll()
    pollIndexer()
      fetch releases
      processReleaseBatch()
        parseRelease()
        identifyRelease()
        group by subject
        decideForSubject()
          evaluateRelease()
          recordReleaseDecision()
          chooseBestRelease()
          sendToDownloadClient()
          markDecisionGrabbed()
          update media acquiring/hash
      saveState()
```

### Missing Search

```text
POST /release-pipeline/missing-search
  triggerMissingSearchNow(tabId?, overrides?)
    missing-search runCycle()
      query missing/wanted monitored items
      search indexers
      processReleaseBatch() with manual overrides
```

### Add Torrent Manually

```text
TorrentsPage AddTorrentModal
  POST /torrents { magnetLink | torrentUrl, labels? }
    getTorrentSession().addTorrent()
      torrent-engine Session.addTorrent()
        fetch metadata if magnet
        persist torrent/resume state
        start if configured
```

### Torrent Match and Import Plan

```text
TorrentDetail AcquisitionMatch
  GET /torrents/:id/acquisition-match
  GET /system/manual-imports/search
  PUT /torrents/:id/acquisition-match
    resolve live torrent or orphan
    validate media type belongs to library
    applyMatchToLibrary()
    setTorrentMatchOverride()
  GET /torrents/:id/import-plan
    createImportPlan(payload, db, sourcePath, torrent.files)
```

### Completed Download Import

```text
startDownloadMonitor()
  detect completed matched download
  queueMediaImport(payload)
    enqueueUniqueJob('media-import')
job-runner claims job
  runMediaImportJob()
    createImportPlan()
    organizeFilm/Episode/Music/Game/ComicIssue()
    optional cleanTracks()
    optional autoAcquireSubtitle()
    validate imported file/asset
    update domain rows
    complete job and record events
```

### Manual Import Review

```text
Acquisitions ManualImportReview
  GET /system/manual-imports/candidates
  user selects candidate
  POST /system/manual-imports/queue
    queueMediaImport()
    media-import job processes same path as completed torrent imports
```

### Metadata Edit

```text
MetadataEditorModal
  onSave -> PUT /<domain>/<id>/metadata
    update domain DB fields
    save local image if image route used
    return serialized entity
```

### File Metadata Edit

```text
FileMetadataEditorModal
  POST /media/file-metadata/read
    media-processor readFileMetadata() via ffprobe
  PUT /media/file-metadata
    media-processor writeFileMetadata() via ffmpeg
    record metadata event
```

### Library Create/Delete and Folder Migration

```text
POST /tabs
  INSERT libraries
  seed quality/edition defaults
  reconcileTypeAfterChange(mediaType)
    if second library added: migrate flat media/<type> to namespaced folders
DELETE /tabs/:id
  delete library and scoped settings
  optionally safeDeleteMediaPath()
  reconcileTypeAfterChange(mediaType)
    if one library remains: collapse back to flat media/<type>
```

### Integrity, Backup, Maintenance

```text
POST /system/integrity/run -> runIntegrityScan() -> scanDataIntegrity() -> persist report
POST /system/integrity/repair -> optional backup -> repairIntegrityProblem() -> rescan
POST /system/backups/run -> createSystemBackup() -> copy DB/torrent state -> manifest -> prune
POST /system/maintenance/run -> runSystemMaintenance() -> stale job recovery/retention/checkpoint
```

## Appendix F: Background Services and Job Handlers

| Service | Start | Stop | Default cadence/notes |
|---|---|---|---|
| Job runner | `startJobRunner(intervalMs = 2000)` | `stopJobRunner()` | Claims queued jobs every 2s. |
| Release orchestrator | `startReleaseOrchestrator()` | `stopReleaseOrchestrator()` | 5s startup delay, 30s tick, max 4 concurrent indexer polls. |
| Title index | `startTitleIndex()` | `stopTitleIndex()` | Started by release orchestrator. |
| Missing search | `startMissingSearchScheduler()` | `stopMissingSearchScheduler()` | Triggerable by route; inspect file before changing cadence. |
| Download monitor | `startDownloadMonitor()` | `stopDownloadMonitor()` | Watches torrent completion/import opportunities. |
| Maintenance scheduler | `startMaintenanceScheduler(db, pollMs = 15 * 60_000)` | `stopMaintenanceScheduler()` | Polls every 15m; config controls actual run interval. |
| Backup scheduler | `startBackupScheduler(db, pollMs = 15 * 60_000)` | `stopBackupScheduler()` | Polls every 15m; config controls actual run interval. |
| Integrity scheduler | `startIntegrityScheduler(db, pollMs = 15 * 60_000)` | `stopIntegrityScheduler()` | Polls every 15m; config controls actual run interval. |

Registered job handlers:

| Job type | Register function | Handler behavior |
|---|---|---|
| `media-import` | `registerMediaImportJobs()` | Runs `runMediaImportJob(job)`. |
| `system-maintenance` | `registerMaintenanceJobs()` | Runs maintenance retention/checkpoint work. |
| `system-backup` | `registerBackupJobs()` | Creates backup manifest/files. |
| `integrity-scan` | `registerIntegrityJobs()` | Runs data integrity scan. |

## Appendix G: Test Matrix by Change Type

| Change type | Primary tests | Secondary tests |
|---|---|---|
| App boot, health, tabs, scoped settings, jobs | `apps/server/test/foundation.test.ts` | `auth.test.ts`, `system.e2e.test.ts` |
| Config/env/provider key mirroring | `apps/server/test/config.test.ts` | Foundation |
| API auth | `apps/server/test/auth.test.ts` | Foundation |
| DB schema/migrations/defaults/scoping | `packages/db/test/schema.test.ts` | Relevant domain e2e |
| Films | `apps/server/test/films.e2e.test.ts` | `metadata-edit.test.ts`, `file-metadata.test.ts` |
| Series | `apps/server/test/series.e2e.test.ts` | `parser.test.ts`, `quality.test.ts` |
| Music/books | `apps/server/test/music-books.e2e.test.ts` | `metadata-edit.test.ts` |
| Comics/games | `apps/server/test/comics-games.e2e.test.ts` | `metadata-edit.test.ts` |
| Metadata/image editing | `apps/server/test/metadata-edit.test.ts` | Domain e2e |
| File metadata/ffmpeg | `apps/server/test/file-metadata.test.ts` | Films e2e |
| Release parser | `apps/server/test/parser.test.ts` | Series/system e2e |
| Quality profile/definition/scoring | `apps/server/test/quality.test.ts` | Domain acquisition tests |
| Library folder migration/safe delete | `apps/server/test/library-migration.test.ts` | Foundation, films e2e |
| Indexers/dashboard/system/torrents/manual import | `apps/server/test/system.e2e.test.ts` | Foundation |
| Integrity/maintenance/backups/checkpoint | `apps/server/test/system.e2e.test.ts` | DB schema |

Coverage highlights:

- `films.e2e.test.ts`: TMDB mock, lookup/add/list/detail, TMDB compatibility lookup, policy update, NFO rewrite, acquisition history/reject/repair, SSE release search, edition rules, refresh, delete scoping.
- `series.e2e.test.ts`: lookup/add four-level structure, stats, detail/TMDB lookup, season/episode updates, policy, acquisition controls, calendar, SSE release search, refresh cadence, delete cascade.
- `music-books.e2e.test.ts`: MusicBrainz artist/album/track flows, book author/book flows, acquisition controls, cross-library isolation, delete cascade.
- `comics-games.e2e.test.ts`: ComicVine/IGDB lookup/add/update/acquisition/refresh/delete flows.
- `system.e2e.test.ts`: indexers CRUD, dashboard, torrent orphans, release pipeline health/missing search, integrity, maintenance, backups, DB checkpoint, overview, acquisition admin, manual imports, import plans.

Testing rules:

- Use provider mocks; do not require live keys.
- For schema changes, add/update `packages/db/test/schema.test.ts`.
- For request shape changes, add route/e2e tests and update client API interfaces.
- For background jobs, test persisted rows and idempotent retry/cancel behavior when possible.

## Appendix H: Known Fragile Areas and Review Checklist

Large files to edit with care:

- `client/src/modules/films/index.tsx`
- `client/src/modules/settings/index.tsx`
- `client/src/modules/torrents/TorrentsPage.tsx`
- `client/src/modules/series/index.tsx`
- `apps/server/src/domains/films/routes.ts`
- `apps/server/src/domains/series/routes.ts`
- `apps/server/src/services/media-imports.ts`
- `apps/server/src/shared/media-organizer.ts`
- `apps/server/src/system/data-integrity.ts`
- `packages/torrent-engine/src/session.ts`

Legacy-compatible behavior to preserve:

- UI/API still says tabs; backend means libraries.
- `db_path` is compatibility metadata only.
- Many responses preserve snake_case DB field names.
- Status labels differ by domain.
- Settings can be scoped or global; do not assume one scope.

Before editing, answer:

1. Is this library-scoped? If yes, where does `library_id` come from?
2. Does the frontend request need `request()` or `requestWithTab()`?
3. Does the DB schema need a field or migration?
4. Does a serializer expose the field?
5. Does a frontend API interface need updating?
6. Does acquisition history or blocklist behavior apply?
7. Does import/file-path/delete behavior apply?
8. Does a background job/scheduler need updating?
9. Which test from Appendix G covers the path?

Backend review checklist:

- Scoped SQL filters by `library_id`.
- Structured bodies use contracts/validation.
- Destructive actions require explicit flags.
- Operational changes record events.
- Background jobs are idempotent or uniquely queued.
- Provider code is mockable and offline-testable.
- New settings have defaults.
- New DB fields are serialized.

Frontend review checklist:

- Uses API wrappers, not raw fetch.
- Preserves tab context.
- Handles loading/error/empty states.
- Uses shared components where possible.
- Confirms destructive actions.
- Does not assume all domains share statuses.

Torrent/import review checklist:

- Handles live torrents and orphan staged downloads.
- Applies `mapRemotePath()` before local file access.
- Does not delete files without explicit delete flag.
- Purges stale import references on remove.
- Maintains release blocklist behavior.
- Keeps import plans inspectable.

Release/acquisition review checklist:

- Decision reasons are human-readable.
- Rejections are recorded where expected.
- Current-quality upgrade logic still works.
- Manual filters still override correctly.
- Blocklist checks still happen.
- Successful grabs mark decisions grabbed.

## Appendix I: Provider Normalized Shapes

Use provider files as final truth. This is the practical UI/server expectation map.

Films/TMDB result:

- `tmdbId`, `title`, `originalTitle`, `year`, `overview`, `genres`, `posterPath`, `backdropPath`, `logoPath`, `rating`, `cast`, `crew`, `country`, `trailerPath`, `runtime`, `certification`, `studio`, `releaseDate`, `digitalReleaseDate`, `physicalReleaseDate`.
- Local compatibility fields may include `localId`, `status`, `file_path`, `acquired_at`, `fileInfo`.

Series search result:

- `tvdbId`, `tmdbId`, `title`, `year`, `overview`, `posterPath`, `logoPath`, `network`, `status`, `cast`, `crew`, `country`, `certification`.
- Preview may include `seasonCount`, `episodeCount`, `firstAired`, `lastAired`, `status`.

Music artist/album:

- Artist: `mbid`, `name`, sort name, `overview`, `disambiguation`, `genres`, image/backdrop/logo URLs.
- Album: MusicBrainz ID, `title`, `release_date`, `year`, `album_type`, `genres`, cover/CD art, `label`, `track_count`.

Books:

- Author lookup: `name`, `imageUrl`, `overview`/`bio`, `workCount`, `topWork`, series names when available.
- Book: provider/ISBN IDs, `title`, `subtitle`, `series_name`, `series_position`, publish/year/publisher/page metadata, `overview`, `genres`, `cover_url`, `language`.

Comics:

- Series: ComicVine ID, `name`/`title`, `publisher`, `startYear`, `issueCount`, cover/image URL, description/overview.
- Issue: ComicVine ID, `issue_number`, `title`, `cover_date`, `year`, `overview`, `image_url`.

Games/IGDB:

- `igdbId`, `title`, `year`, `overview`/`summary`, `genres`, `platforms`, `coverUrl`, `screenshotUrl`, `rating`, `developer`, `publisher`, `releaseDate`.

If changing provider shapes:

1. Update provider normalization.
2. Update route add/lookup mapping.
3. Update client API interfaces.
4. Update `SearchDetailModal` mappings in unified/domain add pages.
5. Update provider mocks/tests.

## Appendix J: Frontend Component Prop Orientation

| Component | Use when | Important props |
|---|---|---|
| `Modal` | Overlay/modal | `title`, `onClose`, `children`, `width` |
| `Field` | Labeled form row | `label`, `hint`, `children` |
| `Input` | Styled text input | Native input props |
| `Select` | Styled select | Native select props |
| `TabSelect` | Segmented option control | `label`, `options`, `value`, `onChange`, `accentColor` |
| `Toggle` | Boolean setting | `checked`, `onChange`, `label` |
| `QualityPolicyPanel` | Tier/resolution/source/codec/upgrade policy | `value`, `onChange`, `compact`, `action` |
| `ReleaseList` | Indexer releases | `releases`, `onGrab`, `grabbing`, `grabbed`, `accentClass` |
| `LibraryCard` | Poster grid/list card | image/title/subtitle/status/badge/accent/selection props |
| `CollectionFilterBar` | Collection status filters | `value`, `onChange`, `filters`, `accentColor` |
| `SelectionBar` | Bulk edit/delete controls | count and selection/delete/done callbacks |
| `StatusBadge` | Status/progress chip | `status`, `progress`, `className` |
| `SearchInput` | Library search field | `value`, `onChange`, `placeholder`, `className` |
| `PosterSkeleton` | Loading grid | `count`, `cols` |
| `EmptyState` | Empty/error display | `icon`, `title`, `subtitle`, `action` |
| `MetadataEditorModal` | Shared metadata/image editor | `title`, `fields`, `initial`, `onSave`, `onClose`, `images` |
| `FileMetadataEditorModal` | Embedded file metadata editing | `filePath`, `onClose`, `onSaved` |
| `MissingSearchModal` | Missing search filters | `onSearch`, `onClose`, labels/children |
| `ItemActionsBar` | Detail page actions | `reacquire`, `loadHistory`, `onRemove`, `onDelete`, `onEdit`, `extra` |
| `SearchDetailModal` | Provider search preview | image/backdrop/title/year/rating/genres/overview/facts/add |

Selection rule:

- New collection page: use `SearchInput`, `CollectionFilterBar`, `LibraryCard`, `SelectionBar`, `EmptyState`, `PosterSkeleton`.
- New detail page: use `DetailPage`, `DetailHeader`, `DetailPoster`, `DetailMain`, `DetailStoryline`, `DetailMetaItem`, `ItemActionsBar`, `MetadataEditorModal`.

## Appendix K: Source Anchors by Feature

| Feature | Start here | Then inspect |
|---|---|---|
| App boot | `apps/server/src/app.ts` | `server.ts`, `routes.ts`, `config.ts` |
| DB schema | `packages/db/src/schema.ts` | `migrations.ts`, serializers |
| Library tabs | `shared/routes.ts` | `library-context.ts`, `tab-context.tsx` |
| Frontend API | `client/src/lib/api.ts` | relevant `*.api.ts` wrapper |
| Settings | `shared/routes.ts` | `settings/index.tsx`, contracts |
| Films | `domains/films/routes.ts` | `films/index.tsx`, `films.api.ts`, `media-organizer.ts` |
| Series | `domains/series/routes.ts` | `series/index.tsx`, `series.api.ts`, `subject-decisions.ts` |
| Music | `domains/music/routes.ts` | `music/index.tsx`, `musicbrainz.ts`, `fanart.ts` |
| Books | `domains/books/routes.ts` | `books/index.tsx`, `google-books.ts` |
| Comics | `domains/comics/routes.ts` | `comics/index.tsx`, `comicvine.ts` |
| Games | `domains/games/routes.ts` | `games/index.tsx`, `igdb.ts` |
| Indexers | `indexers/routes.ts` | `services/indexer-bridge.ts`, `packages/indexer-engine/src/*` |
| Release pipeline | `release-pipeline/orchestrator.ts` | `poller.ts`, `parser.ts`, `identifier.ts`, `subject-decisions.ts` |
| Acquisition decisions | `services/acquisition-decisions.ts` | `services/quality.ts`, `packages/core/src/utils/scoring.ts` |
| Torrents | `torrents/routes.ts` | `services/torrent-session.ts`, `packages/torrent-engine/src/session.ts` |
| Imports | `services/media-imports.ts` | `shared/media-organizer.ts`, `shared/monitor.ts` |
| File metadata | `services/media-processor.ts` | `FileMetadataEditorModal.tsx` |
| Subtitles | `services/subtitle-provider.ts` | Settings and film subtitle UI |
| Jobs/events | `system/event-store.ts` | `job-runner.ts`, `system/routes.ts` |
| Integrity | `system/data-integrity.ts` | `system/admin-routes.ts`, settings UI |
| Backups | `system/backups.ts` | `system/admin-routes.ts` |
| Maintenance | `system/maintenance.ts` | `system/admin-routes.ts` |

## Appendix L: Agent Startup Protocol

For future agents:

1. Classify the task: UI-only, API-only, DB/schema, domain, acquisition, torrent/import, system/admin, or cross-cutting.
2. Open the matching source anchor from Appendix K.
3. Open the frontend API wrapper before editing UI.
4. Open the server route before editing backend behavior.
5. Check schema only if persistence changes.
6. Check contracts if request bodies change.
7. Check whether the feature is library-scoped.
8. Make the smallest coherent patch.
9. Run the narrow test from Appendix G.
10. Do not inspect or edit `dist/`, `node_modules/`, SQLite runtime files, or the entire indexer YAML dataset unless directly relevant.
