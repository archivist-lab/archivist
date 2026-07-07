# Archivist Rebuild Plan

## 1. Purpose

This document translates the audit corpus in `apps/archivist/docs` into an execution plan that is grounded in the actual repository state as of 2026-05-10.

The short version:

- The docs describe a greenfield V2.
- The current codebase is a large V1-style Express monolith plus shared TS engines.
- We should not "refactor into V2" inside the existing request/DB model.
- The backend/data architecture should be rebuilt in parallel, but the current frontend UI must be preserved.

## 2. Source Of Truth

Authority order for rebuild decisions:

1. `apps/archivist/docs/unified-audit.md`
2. `apps/archivist/docs/archivist-audit.md`
3. Domain audits:
   `radarr-audit.md`, `sonarr-audit.md`, `lidarr-audit.md`, `readarr-audit.md`, `kapowarr-audit.md`, `gamearr-audit.md`, `prowlarr-audit.md`, `transmission-audit.md`
4. `apps/archivist/docs/migration-strategy.md`
5. Current code, only as a feature catalogue or salvage source

Locked from the docs before any rebuild work:

- V2 is greenfield.
- V2 uses Bun + Hono + Drizzle + better-sqlite3 + Zod + SSE.
- V2 uses one unified `archivist.sqlite`, not per-tab or per-media DB files.
- `x-tab-context` is rejected; `libraryId` replaces tab scoping.
- Films are the first vertical slice after foundation.
- API-key auth is enough for the first shipped foundation; forms/basic remain later-phase work.
- TCP-only torrent support is acceptable at initial ship; uTP is a hardening phase.

## 3. What Was Audited

Docs reviewed:

- `apps/archivist/docs/unified-audit.md`
- `apps/archivist/docs/archivist-audit.md`
- `apps/archivist/docs/ARCHITECTURE.md`
- `apps/archivist/docs/migration-strategy.md`
- `apps/archivist/docs/readme.md`

Code reviewed:

- `apps/archivist/src/server.ts`
- `apps/archivist/src/middleware/*`
- `apps/archivist/src/modules/*`
- `apps/archivist/src/services/*`
- `apps/archivist/client/src/*`
- `packages/core/src/*`
- `packages/indexer-engine/src/*`
- `packages/torrent-engine/src/*`
- `packages/bittorrent/src/*`
- `apps/archivist/src/tests/routes.test.ts`

Validation runs:

- `pnpm --filter archivist-app build` -> passes
- `pnpm build` in `apps/archivist/client` -> passes, but emits a large bundle warning
- `pnpm --filter archivist-app test` -> fails and then hangs until externally timed out

## 4. Current Repository Reality

Inventory:

- `apps/archivist/docs`: 17 documents
- `apps/archivist/src`: 60 TS files, about 17,893 LOC
- `apps/archivist/client/src`: 29 TS/TSX files, about 12,497 LOC
- `packages/*/src`: 51 TS files, about 12,053 LOC

Non-source payload inside the repo:

- `apps/archivist/media`: about 121G
- root `node_modules`: about 510M
- committed build output in `apps/archivist/dist` and `apps/archivist/client/dist`

Workspace/tooling observations:

- The repo root is not a git checkout right now.
- `apps/archivist/client` is not part of the root workspace filters, so `pnpm --filter archivist-client build` from the repo root fails with "No projects matched".
- Root scripts build `@archivist/core` and `archivist-app`, but not the client.
- `context.md` describes a different project shape than the audited docs and the current file tree.
- During Phase 0 implementation, Bun `1.3.13` in this environment could not load `better-sqlite3`; the live V2 scaffold therefore runs Hono on Node for now while preserving the same package boundaries and API shape.

## 5. Audit Findings

### 5.0. Frontend Freeze Is A Hard Constraint

New locked constraint from product direction:

- no visual redesign
- no route or navigation redesign
- no UX flow redesign
- no style-system replacement

Allowed frontend changes:

- data-fetching internals
- client-side state plumbing
- compatibility adapters
- type-safety improvements
- bug fixes that do not change the visible UI/UX contract

This changes the rebuild strategy materially:

- V2 backend can be greenfield
- V2 frontend presentation cannot be greenfield

### 5.1. The Current App Is Not The Target Architecture

The live application is centered on:

- Express in `apps/archivist/src/server.ts`
- per-tab SQLite routing via `x-tab-context`
- direct SQL in route handlers
- large feature routers under `apps/archivist/src/modules/*`
- shared mutable services started in-process at bootstrap

This is materially different from the target:

- Bun runtime
- Hono typed routes
- Drizzle migrations and schema ownership
- one DB with `library_id`
- department boundaries
- typed event bus as the main orchestration contract

Conclusion:

- We should treat the current app as legacy reference code, not as the base layer of V2.

### 5.2. The Persistence Model Is The Biggest Architectural Mismatch

Current reality:

- Shared DB plus tab DBs
- media type split across separate SQLite files
- route code and services call `openDb()` directly
- ad hoc migrations live next to feature modules such as `films/db.ts` and `series/db.ts`

Target reality:

- one `archivist.sqlite`
- `library_id` foreign key dimension
- Drizzle schema and migrations
- department-owned persistence boundaries

High-impact examples:

- `apps/archivist/src/middleware/tab-context.ts`
- `apps/archivist/src/modules/shared/routes.ts`
- `apps/archivist/src/modules/films/db.ts`
- `apps/archivist/src/modules/series/db.ts`

Conclusion:

- The DB model must be rebuilt before feature work, not gradually patched.

### 5.3. The HTTP Layer Must Be Replaced, But The UI Must Be Preserved

Current backend API:

- Express routers
- manual middleware composition
- manual JSON validation hooks
- partial SSE only for search streaming

Current frontend:

- React + Vite + BrowserRouter
- manual `fetch` wrappers in `client/src/lib/api.ts`
- React Context for tab scoping in `client/src/lib/tab-context.tsx`
- no TanStack Query
- no Zustand
- no Hono RPC client
- very large page components, including `films/index.tsx` at about 2,015 LOC and `settings/index.tsx` at about 1,877 LOC
- the visual system is already centralized in `index.css`, `tailwind.config.js`, `components/ui.tsx`, `Sidebar.tsx`, and the page modules

Client build status:

- production build succeeds
- main JS bundle is about 533.83 kB before gzip, enough to trigger Vite's chunk warning

Conclusion:

- The API and client data layer should be rebuilt under the current UI.
- The visible frontend should be treated as a preservation surface.
- Backend changes must either keep current payload shapes stable or introduce an internal compatibility layer so the UI stays visually identical.

### 5.4. There Are Strong Salvage Candidates

These areas contain real value and should inform or feed the rebuild:

- `packages/torrent-engine`
- `packages/bittorrent`
- `packages/indexer-engine`
- `packages/core/src/utils/scoring.ts`
- `apps/archivist/src/modules/release-pipeline/title-index.ts`
- `apps/archivist/src/modules/release-pipeline/subject-decisions.ts`
- `apps/archivist/src/services/system-store.ts`
- `apps/archivist/src/services/job-runner.ts`
- `apps/archivist/src/services/data-integrity.ts`
- `apps/archivist/src/services/media-imports.ts`
- `apps/archivist/src/services/media-processor.ts`

Important nuance:

- Several of these should be salvaged as algorithms and invariants, not copied as-is.
- `packages/indexer-engine/src/cardigann/executor.ts` currently uses Nunjucks, which the docs explicitly reject for V2.
- `subject-decisions.ts` contains a good grouping idea, but it is still wired to tab DBs and direct router-era side effects.

### 5.5. Some Current Patterns Should Be Explicitly Retired

Retire, do not port:

- `x-tab-context` request scoping
- `tabs` as the primary storage boundary
- Express router-per-domain as the long-term API model
- route handlers performing DB writes directly
- Nunjucks Cardigann template execution
- three-level series storage without `episode_files`
- repo-local committed dist output as part of the source tree

### 5.6. Test Coverage Is Not A Reliable Safety Net Yet

Observed baseline:

- `apps/archivist/src/tests/routes.test.ts` is the only visible test file in the app
- shared route tests pass
- films route tests fail
- the test process does not terminate cleanly after failure

Concrete failures:

- `GET /films` returned `400` instead of the expected `200`
- `GET /films/:id` returned `400` instead of the expected `404`
- the process required external timeout termination

Likely cause:

- the films router now requires tab context globally, but the tests still assume a non-tab-scoped entry path

Conclusion:

- V2 needs a real test pyramid from the start: schema tests, service tests, route tests, and at least one end-to-end vertical slice test per completed phase.

## 6. Keep / Adapt / Rewrite Matrix

| Area | Decision | Notes |
|---|---|---|
| `packages/torrent-engine` | Keep and harden | Core engine exists; Phase 7 is parity and production hardening |
| `packages/bittorrent` | Keep and harden | Protocol layer is valuable and already substantial |
| `packages/indexer-engine` | Keep, then refactor | Preserve loader/search concepts; replace Nunjucks executor |
| quality tier scoring | Keep | Archivist-specific differentiator |
| title index + grouped decisions | Keep conceptually | Rebuild on unified DB + typed commands |
| job store + event log | Adapt | Good model; move into Drizzle schema and typed event bus |
| data integrity scanner | Adapt | Strong candidate after unified DB exists |
| media import validation | Adapt | Pre/post probe and chapter-regression checks are worth preserving |
| Express routes | Rewrite | Wrong API and ownership model |
| tab middleware | Rewrite | Request-scoping model is incompatible with `library_id` |
| tab UI experience | Adapt internally, preserve visually | Keep the current library/tab UX while changing the backing model |
| per-domain SQLite schema files | Rewrite | Replace with unified Drizzle schema |
| manual fetch client | Rewrite | Replace with Hono RPC + TanStack Query |

## 7. Strategic Decision Before We Write Code

Recommended execution model:

1. Freeze the current frontend UI as the canonical presentation baseline.
2. Freeze the current Express server as legacy reference code.
3. Build the V2 backend/data stack in parallel inside this repo.
4. Reuse engines and proven algorithms selectively.
5. Cut over by vertical slice, with backend compatibility for the preserved UI.

Why:

- The current architecture is too far from the target for safe in-place conversion.
- The tab DB model infects the API, services, tests, and UI simultaneously.
- A parallel backend rebuild lets us preserve the live UI while avoiding half-migrated states.
- The frontend constraint means "replace the app" is too expensive visually; we need "replace the machinery behind the glass."

## 8. Proposed Build Structure

The exact package names can be chosen when implementation starts, but the shape should be:

- one new backend app for Bun + Hono
- one shared package for Zod contracts and API types
- one shared package for Drizzle schema and migrations
- existing engine packages retained and upgraded in place
- the existing React frontend retained as the canonical UI, with adapter work limited to non-visual internals

Recommended constraint:

- Do not put the V2 app under the existing `apps/archivist/src` tree.
- Keep a clean boundary between legacy and rebuild code.
- Do not create a competing second UI unless there is a pure internal need for storybook/test fixtures; production UI stays the current one.

## 9. Execution Plan

### Phase 0A - Repo Preparation

Goals:

- carve out a clean V2 workspace
- stop legacy artefacts from polluting the rebuild
- lock tooling and quality gates

Tasks:

- Add the new V2 app/package directories to the workspace explicitly.
- Bring the frontend into normal workspace management instead of the current nested isolated setup.
- Define source/build/test scripts from the repo root for backend and frontend.
- Establish artifact policy for `dist`, local DBs, logs, fixtures, and media.
- Mark legacy code and docs clearly so we do not accidentally keep building on the tab model.
- Capture the frontend preservation contract:
  visual snapshots, route inventory, payload inventory, and "no visible UI drift" acceptance criteria.

Exit criteria:

- new workspace packages resolve correctly from the repo root
- root scripts can build and test both halves of V2
- legacy app remains runnable but isolated

### Phase 0B - Foundation

Goals:

- establish the target runtime, API, DB, config, and event primitives

Tasks:

- scaffold Bun server boot
- scaffold Hono route registry
- add `/api/v1/health`
- add `/ping`
- add SSE endpoint with a `system:ready` event
- add `config.toml` loader with API-key auth support
- create initial Drizzle schema and first migration
- create shared Zod contracts and typed RPC surface
- port job/event concepts from `system-store.ts` and `job-runner.ts`
- build a compatibility layer for the preserved frontend:
  either stable endpoint shapes or a client-side adapter module behind the existing UI

Initial schema should include at least:

- `app_settings`
- `libraries`
- `root_folders`
- `quality_profiles`
- `system_jobs`
- `system_events`
- `release_blocklist`
- `acquisition_decisions`

Exit criteria:

- `bun run dev` starts backend and frontend
- `/api/v1/health` returns 200
- `/ping` returns 200
- first migration applies cleanly
- SSE readiness signal is visible

Current implementation note:

- The scaffolded V2 backend is currently executable under Node + Hono because Bun in this environment cannot yet load `better-sqlite3`.
- The V2 config boundary now supports the audited `config.toml` shape via `apps/archivist-v2/config.example.toml`, accepts environment overrides, and enforces API-key auth on protected `/api/v1/*` routes while leaving `/ping` and `/api/v1/health` public.
- The V2 backend now includes a persisted system jobs/events runtime with typed contracts, `/api/v1/system/jobs` and `/api/v1/system/events` routes, handler-scoped job claiming, retry/cancel semantics, and boot-time event recording.
- The preserved frontend API contract has now been inventoried in `apps/archivist/docs/frontend-api-compatibility.md`; use that document as the source of truth for backend compatibility work before any frontend-facing cutover.
- The V2 backend now includes first-class `libraries` CRUD plus the first preserved-frontend compatibility adapter: legacy `/api/v1/tabs`, `/api/v1/tabs/root-folders`, and scoped `/api/v1/root-folders` now resolve against the unified library model, preserve `db_path` as compatibility metadata, and enforce a backend invariant that every library retains at least one root folder.
- The first feature route is now in place: `/api/v1/films/lookup?q=` runs through a dedicated V2 TMDB client boundary, reads `x-tab-context` as compatibility metadata, marks `alreadyAdded` from a new unified `films` table when the scoped library is a films library, and is verifiable offline through a local TMDB mock via the new `metadata.tmdb` config section.
- The first usable films workflow is now in place on V2: `POST /api/v1/films` and `GET /api/v1/films` preserve the current frontend payload/response shape closely enough for the locked UI, enforce films-library scoping via `x-tab-context`, populate the unified `films` table from TMDB detail metadata, derive a per-film `root_folder_path` under the selected library root, reject duplicate `tmdbId` values per library with `409`, and keep `/api/v1/films/lookup` in sync via `alreadyAdded`.
- The first film detail/update slice is now in place on V2: `GET /api/v1/films/:id` and `PUT /api/v1/films/:id` preserve the current detail-page contract closely enough for the locked UI, expose persisted TMDB logo/trailer-video/cast/crew metadata from the unified `films` table, persist policy edits such as `upgrade_allowed`, `target_*`, and `default_edition_id`, and return `404` for missing records under the current `x-tab-context` library scope.
- The first film appraisal/search slice is now in place on V2: `GET /api/v1/films/releases/search` now preserves the current SSE contract, runs the locked title/year/tier/resolution/source/codec appraisal rules through a dedicated V2 search service, and is verifiable end-to-end with an injected provider stub; the default standalone runtime still uses an empty provider until unified indexer-registry integration is added.
- The first film acquisition-action slice is now in place on V2: `POST /api/v1/films/download` preserves the current frontend request/response shape, reuses the shared download-client sender through a V2 `download_clients` seam, records acquisition events in the system event store, and persists the film into `acquiring` state with `info_hash`, `download_tier`, and `downloadProgress` fields in the unified `films` table after a successful dispatch.
- The TMDB-keyed film compatibility lookup is now in place on V2: `GET /api/v1/films/tmdb/:tmdbId` returns the local scoped film record when the current films library already contains that TMDB id, otherwise falls back to the TMDB boundary and returns an `uncollected` compatibility payload without requiring legacy per-tab DB assumptions.
- The first film delete slice is now in place on V2: `DELETE /api/v1/films/:id` preserves the legacy `204 No Content` behavior, deletes only within the scoped films library under `x-tab-context`, and records a system event when a local film row is actually removed.
- The first film metadata-refresh slice is now in place on V2: `POST /api/v1/films/refresh` preserves the current frontend response shape as `{ success, updated }`, refreshes only the current films library under `x-tab-context` against the TMDB boundary, updates the unified `films` metadata fields in place, and records both aggregate success and per-film failure events.
- The first film auto-grab slice is now in place on V2: `POST /api/v1/films/:id/auto-grab` preserves the current frontend response shape as `{ success, message }`, searches with the stored per-film `target_*` filters through the existing V2 appraisal/search seam, selects the top-ranked release, dispatches it through the shared download-client seam, persists the film into `acquiring` state, and records both successful dispatch and no-match events.
- The first film acquisition-history slice is now in place on V2: `GET /api/v1/films/:id/acquisition-history` now returns the preserved `{ decisions, blocks }` shape backed by the unified acquisition tables, and the existing `POST /api/v1/films/download` and `POST /api/v1/films/:id/auto-grab` paths now record compatibility-facing acquisition decision rows so the locked history panel has real data to render.
- The first film reject-current-release slice is now in place on V2: `POST /api/v1/films/:id/reject-current-release` preserves the current `{ success }` contract, writes the active release into the unified blocklist using the recorded acquisition metadata, clears the film’s transient acquisition state, records a system event, and causes the preserved acquisition-history panel to surface the new block entry immediately.
- The first film repair slice is now in place on V2: `POST /api/v1/films/:id/repair` preserves the current repair contract for the locked UI, optionally deletes the media file from disk, optionally blocklists the active release under the unified acquisition store, resets the film back to `missing` state in the unified `films` table, records a system event, and returns the updated film detail payload.
- The first film metadata-edit slice is now in place on V2: `PUT /api/v1/films/:id/metadata` preserves the locked UI text-edit contract, updates only the manual metadata fields with legacy null-as-no-op semantics, rewrites the per-film NFO into the stored root folder path, records metadata events, and returns the updated film detail payload.
- The first film image-search slice is now in place on V2: `GET /api/v1/films/:id/images` preserves the locked UI’s flat candidate-image array, searches TMDB first and Fanart.tv second, deduplicates candidate URLs, tolerates partial upstream failure without breaking the page, and returns the expected `{ url, source, type, language, width?, height? }[]` shape.
- The first film image-save slice is now in place on V2: `PUT /api/v1/films/:id/images` preserves the locked UI’s `{ success, path }` response, downloads the chosen asset into the film folder, derives the legacy-compatible `/media/...` path when possible, updates the stored artwork column for poster/backdrop/logo/banner selections, and records a metadata event.
- The first film edition-rules slice is now in place on V2: the full `GET /api/v1/films/edition-rules/all`, `POST /api/v1/films/edition-rules`, `PUT /api/v1/films/edition-rules/:id`, and `DELETE /api/v1/films/edition-rules/:id` compatibility surface is now library-scoped under `x-tab-context`, seeded with the legacy default ruleset on first access, preserves the old snake_case field names, and keeps delete idempotent with `{ success: true }`.
- The first live indexer-search slice is now in place on V2: the standalone runtime no longer uses the empty release-search provider, but instead loads enabled `indexers_ts` rows from the unified DB, honors per-module media-type enable/priority settings, reuses the existing indexer-engine definitions set, preserves the SSE route contract, and falls back from `movie` to generic `search` when specialized results come back empty.
- The first route-layer acquisition/blocklist enforcement slice is now in place on V2: `GET /api/v1/films/releases/search` now filters blocklisted releases out of SSE batches when the current film can be resolved in the scoped library, `POST /api/v1/films/download` now rejects blocklisted manual selections with `409`, and `POST /api/v1/films/:id/auto-grab` now records rejected blocked candidates before dispatching the best remaining allowed release.
- The first job-driven film dispatch slice is now in place on V2: film-linked `POST /api/v1/films/download` and `POST /api/v1/films/:id/auto-grab` no longer orchestrate acquisition directly in the route layer, but instead execute through a typed film pipeline service that creates a real `film.download.dispatch` system-job record, preserves the current HTTP response shape, marks the film `acquiring`, records the accepted acquisition decision, and queues the next `film.await-intake` job so the restoration pipeline has a concrete handoff point.
- The first real film restoration slice is now in place on V2: the queued `film.restore` job now moves a downloaded release into the film vault, writes a per-edition NFO, downloads poster/backdrop/logo assets into the film folder when needed, preserves trailer/extras side files, transitions the film through `restoring` into `collected`, clears transient acquisition state, and records restoration events from the unified system runtime.
- The films phase now has a permanent end-to-end verification suite on V2: `apps/archivist-v2/test/films.e2e.test.ts` exercises metadata/detail compatibility, acquisition/blocklist/history/reject/repair behavior, and full disk-backed download-to-restore lifecycle handling, and films should not be treated as phase-complete unless `pnpm --filter archivist-v2-backend test:films`, `pnpm typecheck:v2`, and `pnpm build:v2` all pass together.
- The series foundation is now in place on V2: the shared contracts package now carries typed Zod schemas for series, seasons, episodes, releases, monitor strategies, and compatibility payloads, while the unified DB now defines the audited four-level `series -> seasons -> episodes -> episode_files` model with fresh-db migration coverage and the critical `episodes.episode_file_id` link required for multi-episode-file support.
- The first real series compatibility slice is now in place on V2: the standalone backend now exposes `GET /api/v1/series`, `GET /api/v1/series/lookup`, `GET /api/v1/series/:id`, `GET /api/v1/series/tmdb/:tmdbId`, `POST /api/v1/series`, `PUT /api/v1/series/:id`, and `DELETE /api/v1/series/:id`, all backed by the unified series store, TMDB-derived series metadata boundary, audited monitor-strategy seeding, and a disposable route smoke test that verified lookup already-added semantics, add/detail/list/update/delete behavior, duplicate protection, and TMDB fallback/local branches.
- The second series compatibility slice is now in place on V2: the preserved frontend’s separate season and episode surfaces now exist on the unified backend via `GET /api/v1/series/:id/seasons`, `GET /api/v1/series/:id/episodes`, `PUT /api/v1/series/seasons/:seasonId`, and `PUT /api/v1/series/episodes/:episodeId`, with season updates preserving the frontend’s `204` no-body contract and episode updates returning the updated compatibility payload, all verified through a disposable route smoke test.
- The first series acquisition slice is now in place on V2: `GET /api/v1/series/releases/search` now streams SSE batches from a dedicated TV search service backed by live unified indexers with series-title/episode validation and tier scoring, while `POST /api/v1/series/download` now dispatches through the shared download-client seam and marks either an individual episode or an entire season pack as `acquiring` with persisted `info_hash` and current-release metadata, verified through a disposable search-and-dispatch smoke test.
- The first series refresh and calendar slice is now in place on V2: `POST /api/v1/series/refresh` now refreshes the scoped library’s stored series metadata plus season/episode metadata, records per-series cadence fields (`last_metadata_refresh_at`, `next_metadata_refresh_at`, `refresh_interval_hours`) in the unified DB, and `GET /api/v1/series/calendar` now emits the loose upcoming-episode payload shape the preserved UI expects, both verified through a disposable refresh-and-calendar smoke test.
- The second series acquisition slice is now in place on V2: the preserved frontend’s season and episode acquisition control surfaces now exist on the unified backend via `GET /api/v1/series/seasons/:seasonId/acquisition-history`, `POST /api/v1/series/seasons/:seasonId/reject-current-release`, `POST /api/v1/series/seasons/:seasonId/repair`, `GET /api/v1/series/episodes/:episodeId/acquisition-history`, `POST /api/v1/series/episodes/:episodeId/reject-current-release`, and `POST /api/v1/series/episodes/:episodeId/repair`, with manual series downloads now recording unified acquisition decisions for both subject types and a disposable smoke harness verifying history reads, blocklist writes, coherent state resets, and on-disk file deletion behavior.
- The first real series lifecycle slice is now in place on V2: `POST /api/v1/series/download` now runs through a typed `series.download.dispatch -> series.await-intake -> series.restore` pipeline backed by the unified system job store, the backend now persists real `episode_files` rows during restore instead of leaving series stuck in `acquiring`, and the new restore path can match and collect multi-episode files, season-pack directories, daily releases by air date, and anime releases by absolute episode number, all verified through a disposable route-and-runner smoke harness. The important current caveat is runtime parity, not UI parity: standalone V2 still uses a null series intake resolver, so live restore remains dependent on the later intake-discovery integration even though the lifecycle architecture and persistence path are now in place.
- The series phase now has a permanent end-to-end verification suite on V2: `apps/archivist-v2/test/series.e2e.test.ts` covers preserved UI compatibility routes, acquisition history/reject/repair behavior, and the job-driven lifecycle for multi-episode, season-pack, daily, and anime cases, and the current series slice should not be treated as stable unless `pnpm --filter archivist-v2-backend test:series`, `pnpm typecheck:v2`, and `pnpm build:v2` all pass together.
- Treat this as a temporary runtime workaround, not a frontend or product change.

### Phase 1 - Films Vertical Slice

Goals:

- prove the architecture end-to-end on the smallest high-value domain

Tasks:

- implement `libraries` + films schema in unified DB
- implement film lookup/add/detail/list flows
- implement TMDB client boundary
- implement appraisal for film releases
- port quality tier scoring and layer it under the locked scoring rules
- integrate indexer search using the existing engine package
- integrate intake path using the existing torrent engine package
- port restoration essentials: track cleaner, poster/assets, NFO writing
- port vault rules for hardlink/copy semantics
- model and enforce the canonical state machine
- preserve current film UI behaviour and visual output while changing only the backing contracts/plumbing

Salvage targets during this phase:

- `packages/core/src/utils/scoring.ts`
- `apps/archivist/src/services/acquisition-decisions.ts`
- `apps/archivist/src/services/media-processor.ts`
- selected logic from `media-imports.ts`

Exit criteria:

- add a film
- search
- grab
- transition `wanted -> acquiring -> restoring -> collected`
- verify file, assets, and NFO on disk
- automated integration test passes

### Phase 2 - Series

Tasks:

- implement `series -> seasons -> episodes -> episode_files`
- implement episode, season, and series search commands
- implement multi-episode file handling
- implement daily and anime handling
- implement per-series refresh cadence
- implement TVDB v4 auth flow

Non-negotiable constraint:

- do not carry the current 3-level series model into V2

### Phase 3 - Music And Books

Tasks:

- implement music MVP first
- then books/audiobooks on one engine, not split apps
- preserve domain-specific appraisal/spec behaviour from the docs

### Phase 4 - Comics And Games

Tasks:

- implement comics MVP and games in parallel if capacity allows
- defer extended comics acquisition sources until the MVP is stable

### Phase 5 - New Domains And Platform Features

Tasks:

- migration engine
- magazines
- podcasts
- compendium
- security/identity
- mobile remote
- AI discovery

### Phase 6 - Polish

Tasks:

- notification surface
- import lists
- health catalog
- quality/custom-format/editor UI surfaces
- bulk editing

### Phase 7 - Engine Hardening

Tasks:

- protocol parity items from the transmission audit
- production hardening for the embedded torrent engine
- deferred auth and operational features that are explicitly later-phase

## 9A. Prompt Bank For Each Phase

### Shared Agent Brief

Use this brief in every phase prompt below:

```text
Operate as a principal software architect and senior engineer with extremely strong systems judgment, rigorous taste, and zero tolerance for architectural drift.

Your job is to execute only the named phase of the Archivist rebuild plan.

Non-negotiable constraints:
- Do not change the visible frontend UI, routes, navigation, styling, typography, layout, or interaction model.
- The existing frontend is a preserved presentation surface. Only non-visual plumbing changes are allowed.
- Prefer parallel V2 backend/data architecture over mutating the legacy Express architecture in place.
- Preserve the current UI contract by maintaining stable payload shapes or adding compatibility adapters where needed.
- Prefer explicit boundaries, typed contracts, deterministic behavior, and measurable verification.
- Reuse proven engines and algorithms selectively, but do not copy legacy architectural mistakes.
- Do not introduce `x-tab-context` into V2. Move toward unified DB + `library_id`.
- At the end, report what changed, what was verified, what remains blocked, and any assumptions that still need to be locked.

Quality bar:
- Think like the final maintainer, not a feature sprinter.
- Make impossible states hard to represent.
- Keep the codebase boring in the best possible way: clear ownership, clear contracts, clear migration path.
```

### Prompt - Phase 0A

```text
Use the shared agent brief.

Execute Phase 0A: Repo Preparation for Archivist V2.

Objective:
Create a clean workspace foundation for the parallel V2 backend and shared packages while keeping the current frontend UI untouched.

Specific goals:
- Ensure workspace/package structure cleanly supports the preserved frontend and the new V2 backend/shared packages.
- Add or refine root scripts for building, typechecking, and running the V2 path.
- Establish artifact hygiene so build outputs, logs, databases, and large runtime assets do not pollute source concerns.
- Mark legacy versus V2 boundaries clearly so future work does not accidentally continue inside the wrong architecture.
- Capture the frontend preservation contract in docs or implementation notes where needed.

Constraints:
- No visible frontend changes.
- No backend feature work beyond what is necessary to support the workspace foundation.
- Do not refactor legacy Express modules as a substitute for V2 scaffolding.

Required deliverables:
- Workspace manifests and scripts updated.
- New package/app directories present and coherent.
- Clear separation between legacy and V2 code paths.
- Verification that the workspace can resolve the new V2 packages.

Verification:
- Run the relevant root scripts.
- Confirm the preserved frontend package still builds on its existing path.
- Report any environmental constraint honestly, especially runtime/tooling incompatibilities.
```

### Prompt - Phase 0B

```text
Use the shared agent brief.

Execute Phase 0B: Foundation for Archivist V2.

Objective:
Stand up the minimum viable V2 backend foundation: runtime boot, typed routes, config loading, schema bootstrap, health endpoints, and SSE readiness.

Specific goals:
- Implement the V2 server bootstrap with Hono.
- Add `/ping`, `/api/v1/health`, and an SSE endpoint that emits a readiness event.
- Add typed config loading with `config.toml` support and environment overrides.
- Create the initial shared contracts package.
- Create the initial DB/schema package and first migration bootstrap.
- Add the first system tables: settings, libraries, jobs, events, blocklist, acquisition decisions.
- Keep the design compatible with the eventual Bun target, while using a temporary runtime workaround if Bun cannot execute the chosen SQLite layer in this environment.

Constraints:
- No frontend UI changes.
- No domain-specific film/series logic beyond what is required for foundation.
- No drifting back into per-tab DB architecture.

Required deliverables:
- Bootable V2 backend.
- Typed contracts package.
- Typed DB/schema package.
- First working migration/bootstrap path.
- Working health, ping, and SSE readiness smoke tests.

Verification:
- Typecheck shared packages and backend.
- Build shared packages and backend.
- Start the backend and exercise `/ping`, `/api/v1/health`, `/api/v1/events`, and the initial libraries endpoint.
- Document any runtime workaround in the plan or implementation notes.
```

### Prompt - Phase 1

```text
Use the shared agent brief.

Execute Phase 1: Films Vertical Slice.

Objective:
Deliver the first real end-to-end V2 media workflow for films while preserving the current film UI behavior and presentation.

Specific goals:
- Implement unified-DB film storage under `library_id`.
- Add film lookup, add, list, and detail flows.
- Implement a clean TMDB boundary.
- Implement film appraisal and release scoring using the locked decision rules.
- Reuse quality tier logic where it is sound, but fit it into the V2 scoring model.
- Integrate indexer search and the intake path through the preserved engine packages.
- Implement restoration essentials: track cleaning, poster/assets, NFO writing.
- Implement vault write rules and the lifecycle state machine.
- Preserve current UI payload expectations or add a compatibility adapter layer to keep the frontend visually unchanged.

Constraints:
- Do not redesign the films UI.
- Do not expose legacy tab DB assumptions through the new API.
- Do not weaken the canonical lifecycle rules to match legacy shortcuts.

Required deliverables:
- Film vertical slice works end to end.
- Backend-compatible response shapes for the preserved UI.
- Tests covering add, search, grab, state transitions, and archive completion.

Verification:
- Prove `wanted -> acquiring -> restoring -> collected`.
- Verify assets/NFO/files on disk.
- Verify the preserved frontend still renders film data without visual regressions.
```

### Prompt - Phase 2

```text
Use the shared agent brief.

Execute Phase 2: Series.

Objective:
Implement the V2 series domain correctly, including the four-level model and all load-bearing TV behaviors that the legacy code underspecifies.

Specific goals:
- Implement `series -> seasons -> episodes -> episode_files`.
- Support episode, season, and series search commands.
- Support multi-episode files and season packs.
- Implement daily-series handling, anime handling, and per-series refresh cadence.
- Integrate TVDB v4 auth flow.
- Preserve current series UI behavior by adapting payloads rather than redesigning the UI.

Constraints:
- Do not carry forward the legacy 3-level series model.
- Do not flatten multi-episode file relationships.
- No visual series UI changes.

Required deliverables:
- Correct four-level storage and API shape.
- Search/grab flows for normal, daily, anime, multi-episode, and season-pack cases.
- Compatibility path for the preserved UI.

Verification:
- Add and manage a standard series, a daily series, and an anime case.
- Verify refresh cadence logic.
- Verify multi-episode and season-pack handling against the state machine.
```

### Prompt - Phase 3

```text
Use the shared agent brief.

Execute Phase 3: Music and Books.

Objective:
Implement music first, then books/audiobooks, using the V2 architecture and preserving the current frontend presentation contract.

Specific goals:
- Implement `artists -> albums -> tracks` with MusicBrainz/Fanart boundaries.
- Implement books/audiobooks as one coherent engine, not split stacks.
- Preserve domain-specific scoring and acquisition behavior from the authoritative audits.
- Keep UI compatibility through adapters or stable payloads.

Constraints:
- No UI redesign.
- Do not split audiobooks into a separate architectural path.
- Do not regress the unified DB model.

Required deliverables:
- Music MVP and books/audiobooks domain surfaces.
- Scheduled refresh behavior and typed APIs.
- Compatibility with the preserved frontend.

Verification:
- Add an artist and confirm album/track flows.
- Add books/audiobooks and confirm edition/format handling.
- Confirm preserved UI screens render correctly without visual change.
```

### Prompt - Phase 4

```text
Use the shared agent brief.

Execute Phase 4: Comics and Games.

Objective:
Implement comics MVP and games on the V2 platform while keeping the current UI intact.

Specific goals:
- Add comics series/issue support with correct metadata boundaries.
- Add games support with IGDB integration.
- Keep acquisition/storage logic aligned with the authoritative audits.
- Delay extended acquisition-source complexity until the MVP is stable.

Constraints:
- No frontend redesign.
- No premature expansion into extended comics source complexity before core correctness is established.

Required deliverables:
- Working comics MVP.
- Working games MVP.
- Preserved frontend compatibility.

Verification:
- Add/manage comics and games via the V2 path.
- Verify stored metadata, files, and API payloads against the preserved UI.
```

### Prompt - Phase 5

```text
Use the shared agent brief.

Execute Phase 5: New Domains and Platform Features.

Objective:
Introduce migration, magazines, podcasts, compendium, identity/security, mobile remote, and AI discovery only after the earlier domain architecture is stable.

Specific goals:
- Build new domains and platform capabilities on top of the stabilized V2 core.
- Keep platform concerns separated from domain concerns.
- Preserve the frontend UI surface while extending backend capability.

Constraints:
- No frontend visual redesign.
- No shortcuts that leak enterprise/platform concerns into domain packages.

Required deliverables:
- Working migration engine baseline.
- Magazines/podcasts baseline.
- Compendium support.
- Security/mobile/AI foundations appropriate to this phase.

Verification:
- Demonstrate each new capability through tests and documented flows.
- Confirm no visible frontend drift.
```

### Prompt - Phase 6

```text
Use the shared agent brief.

Execute Phase 6: Polish.

Objective:
Finish the operational and editorial surfaces that make the system complete without destabilizing the preserved UI.

Specific goals:
- Implement notifications, import lists, health catalog, editor surfaces, and bulk-edit support.
- Keep the architecture disciplined: these are integrations and tooling layers, not excuses for core-domain shortcuts.
- Preserve the current UI appearance while enriching behavior behind it.

Constraints:
- No frontend redesign.
- No erosion of typed boundaries or test coverage.

Required deliverables:
- Operational completeness for the planned polish scope.
- Editor/admin surfaces wired behind the preserved UI.

Verification:
- Test provider integrations and editing flows.
- Confirm the UI remains visually identical while behavior expands.
```

### Prompt - Phase 7

```text
Use the shared agent brief.

Execute Phase 7: Engine Hardening.

Objective:
Take the embedded torrent engine and related protocol surface from "works in principle" to "defensible for production use" under the V2 architecture.

Specific goals:
- Implement or explicitly defer the parity items called out in the transmission audit and unified audit.
- Harden protocol correctness, recovery, peer handling, free-space checks, and state transitions.
- Preserve the stable API/UI surface while raising backend reliability.

Constraints:
- No frontend redesign.
- No silent deferrals; every omitted parity item must be documented with rationale and risk.

Required deliverables:
- Hardened engine behavior.
- Updated documentation for completed versus deferred parity work.
- Measurable reliability improvements.

Verification:
- Run targeted protocol/state tests.
- Verify no regressions in the preserved UI contract.
```

## 10. Immediate Backlog For The Next Implementation Turn

When we start coding, the first tranche should be:

1. Create the parallel V2 workspace skeleton.
2. Add root scripts for V2 backend and V2 frontend.
3. Add the shared contracts package.
4. Add the shared DB/schema package with Drizzle.
5. Implement the initial migration and DB bootstrap.
6. Implement Hono app boot with `/health`, `/ping`, and SSE readiness.
7. Implement typed config loading and API-key auth.
8. Port the system jobs/events model into the new schema.
9. Inventory the current frontend API payloads that must remain compatible.
10. Add the first `libraries` read/write routes.
11. Add the film TMDB lookup route as the first feature route.

## 10A. Prompt Bank For The Immediate Backlog

### Prompt - Step 1

```text
Use the shared agent brief.

Execute Immediate Backlog Step 1: create the parallel V2 workspace skeleton.

Deliver a clean backend/shared-package skeleton for V2 without changing the visible frontend. Verify the new directories, manifests, and source entrypoints are coherent and future-proof.
```

### Prompt - Step 2

```text
Use the shared agent brief.

Execute Immediate Backlog Step 2: add root scripts for the V2 backend and preserved frontend.

Make the root workspace operational for V2 work. Do not alter frontend behavior; only improve workspace invocation, build, and typecheck ergonomics.
```

### Prompt - Step 3

```text
Use the shared agent brief.

Execute Immediate Backlog Step 3: add the shared contracts package.

Create typed contracts that will anchor V2 backend/frontend compatibility. Optimize for stable payload contracts and long-term API discipline.
```

### Prompt - Step 4

```text
Use the shared agent brief.

Execute Immediate Backlog Step 4: add the shared DB/schema package with Drizzle.

Create the unified V2 schema foundation and migration bootstrap. Avoid any regression into per-tab storage thinking.
```

### Prompt - Step 5

```text
Use the shared agent brief.

Execute Immediate Backlog Step 5: implement the initial migration and DB bootstrap.

Make the V2 database path bootable, deterministic, and easy to verify. Include the minimum system tables required by the plan.
```

### Prompt - Step 6

```text
Use the shared agent brief.

Execute Immediate Backlog Step 6: implement Hono app boot with `/health`, `/ping`, and SSE readiness.

Stand up the minimum live backend contract for V2. Verify the endpoints end-to-end rather than stopping at static compilation.
```

### Prompt - Step 7

```text
Use the shared agent brief.

Execute Immediate Backlog Step 7: implement typed config loading and API-key auth.

Add a disciplined configuration boundary that works in the current environment and remains aligned with the V2 target architecture.
```

### Prompt - Step 8

```text
Use the shared agent brief.

Execute Immediate Backlog Step 8: port the system jobs/events model into the new schema.

Preserve the good ideas from the legacy implementation, but re-home them in the V2 schema and contracts cleanly.
```

### Prompt - Step 9

```text
Use the shared agent brief.

Execute Immediate Backlog Step 9: inventory the current frontend API payloads that must remain compatible.

Treat the preserved UI as a hard contract. Enumerate the payload shapes, coupling points, and adapter needs before broader feature migration.
```

### Prompt - Step 10

```text
Use the shared agent brief.

Execute Immediate Backlog Step 10: add the first `libraries` read/write routes.

Implement the first V2 domain-neutral API surface under the unified DB model and verify it works live.
```

### Prompt - Step 11

```text
Use the shared agent brief.

Execute Immediate Backlog Step 11: add the film TMDB lookup route as the first feature route.

Use this as the first real proof that the V2 backend can power preserved frontend behavior without inheriting legacy architectural flaws.
```

## 10B. Strict Numbered Execution Backlog

This section is the active execution ledger for the backend rebuild.

Use it to answer two different questions precisely:

- "How many steps remain before the whole backend can cut over to V2?"
- "How many steps remain before the audited backend plan is fully complete?"

Status snapshot:

- Completed execution steps: `39`
- Remaining execution steps to backend cutover: `16`
- Remaining execution steps to full audited backend completion: `23`
- Total execution backlog to backend cutover: `55`
- Total execution backlog to full audited backend completion: `62`
- Step-count completion to backend cutover: `70.9%`
- Step-count completion to full audited backend completion: `62.9%`

Important distinction:

- Steps `31-55` are the minimum remaining execution backlog before the working backend can be migrated fully onto V2.
- Steps `56-62` are still part of the audited backend plan, but they are best treated as post-cutover polish/hardening unless an earlier risk forces them forward.

Completed steps:

1. Create the parallel V2 workspace skeleton.
2. Add root scripts for the V2 backend and preserved frontend.
3. Add the shared contracts package.
4. Add the shared DB/schema package with Drizzle.
5. Implement the initial migration and DB bootstrap.
6. Implement Hono app boot with `/health`, `/ping`, and SSE readiness.
7. Implement typed config loading and API-key auth.
8. Port the system jobs/events model into the new schema.
9. Inventory the current frontend API payloads that must remain compatible.
10. Add unified `libraries` routes plus the first `tabs`/`root-folders` compatibility layer.
11. Add the film TMDB lookup route.
12. Add film list/add flows.
13. Add film detail/update flows.
14. Add film release-search SSE.
15. Add film manual download dispatch.
16. Add TMDB-keyed film compatibility lookup.
17. Add scoped legacy-compatible film delete behavior.
18. Add scoped film metadata refresh behavior.
19. Add film auto-grab behavior backed by V2 release search and dispatch.
20. Add film acquisition-history behavior backed by unified acquisition records.
21. Add film reject-current-release behavior backed by unified blocklist writes.
22. Add film repair behavior with optional file deletion and unified blocklist integration.
23. Add film metadata-edit behavior with NFO rewrite compatibility.
24. Add film image-search behavior with TMDB and Fanart.tv compatibility.
25. Add film image-save behavior with legacy-compatible artwork persistence.
26. Add film edition-rules CRUD behavior with default-rule seeding.
27. Replace the empty provider with live unified indexer search integration.
28. Wire film acquisition decisions and release blocklist behavior into the V2 route layer.
29. Wire film download dispatch into system jobs and the intake/restoration pipeline.
30. Implement film vault rules, asset/NFO writing, and the canonical `wanted -> acquiring -> restoring -> collected` state machine.
31. Add film end-to-end integration tests and declare films phase-complete only after disk, metadata, and lifecycle verification pass.
32. Implement unified `series -> seasons -> episodes -> episode_files` schema and contracts.
33. Implement series lookup/add/list/detail/update/delete routes.
34. Implement seasons and episodes read/update compatibility routes.
35. Implement series releases SSE/manual download routes.
36. Implement series refresh, calendar, and TVDB sync cadence.
37. Implement season and episode acquisition-history/reject/repair routes.
38. Implement daily-series, anime, multi-episode, and season-pack handling through intake and state transitions.
39. Add series end-to-end integration tests and parity verification against the preserved UI contract.

Remaining steps to backend cutover:

### Phase 2 - Series

### Phase 3 - Music And Books

40. Implement music schema/contracts plus metadata boundaries.
41. Implement music artist/album CRUD, refresh, lookup, releases, and download routes.
42. Implement music acquisition-history/reject/repair plus intake/restoration/state handling.
43. Implement books/audiobooks schema/contracts plus metadata boundaries.
44. Implement books author/book CRUD, refresh, lookup, and download routes.
45. Implement books acquisition-history/reject/repair plus intake/restoration/state handling.
46. Add music/books integration tests and preserved-UI parity verification.

### Phase 4 - Comics And Games

47. Implement comics schema/contracts, series/issue CRUD, refresh, lookup, and download/auto-grab routes.
48. Implement comics acquisition-history/reject/repair plus intake/restoration/state handling.
49. Implement games schema/contracts, CRUD, refresh, lookup, and download/auto-grab routes.
50. Implement games acquisition-history/reject/repair plus intake/restoration/state handling.
51. Add comics/games integration tests and preserved-UI parity verification.

### Phase 5 - Platform Features And Migration

52. Implement download-clients CRUD/test routes plus dashboard downloads/search-grab and torrent control/detail parity routes.
53. Implement manual-import, integrity-repair, and remaining shared admin/system backend surfaces needed by the preserved UI.
54. Build the legacy-tab-DB to unified-V2 migration engine and validation tooling.
55. Build the mixed-mode cutover path: route delegation from the legacy app into V2, parity test suite, migration rehearsal, rollback plan, and final backend cutover verification.

Remaining steps after cutover for full audited backend completion:

### Phase 6 - Polish

56. Implement notifications backend surfaces.
57. Implement import lists and health-catalog backend surfaces.
58. Implement quality/custom-format/editor backend surfaces.
59. Implement bulk-edit backend surfaces and admin workflows.

### Phase 7 - Engine Hardening

60. Complete embedded torrent engine parity and reliability hardening.
61. Complete runtime/deployment/recovery/load hardening for the V2 backend.
62. Complete post-cutover soak verification, observability/runbooks, and final backend hardening sign-off.

Cutover gate:

- Do not migrate the working backend fully onto V2 until steps `16-55` are complete.
- Do not call the audited backend plan fully complete until steps `56-62` are also complete.

## 11. What We Should Not Do

Do not:

- keep adding features to the legacy Express app while the rebuild is starting
- migrate V1 tab DBs into V2 as a compatibility layer
- port the `x-tab-context` model forward
- rewrite route handlers one-by-one inside the old app and call that V2
- start with series, music, or cross-media features before films are complete
- spend early rebuild time on OIDC, AI, mobile remote, or full notification coverage
- redesign the frontend
- swap out the current visual language
- change component markup/CSS unless required for a non-visual plumbing fix

## 12. Final Recommendation

The existing codebase proves that the product idea is viable and that several subsystems are real assets. It does not provide a safe architectural base for the V2 described in the docs.

The correct move is:

- preserve the current frontend UI as-is
- preserve the current code as legacy reference where useful
- extract only the reusable engines and invariants
- build the real V2 backend/data architecture in parallel
- ship foundation first, then films, then widen by domain

That is the lowest-risk path that still matches the audited rebuild spec.
