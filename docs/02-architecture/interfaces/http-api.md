---
title: HTTP surfaces and API ownership
document_type: reference
status: canonical
updated: 2026-09-05
evidence:
  - apps/server/src/app.ts
  - apps/server/src/routes.ts
  - apps/server/src/gateway.ts
  - apps/server/src/player/routes.ts
  - apps/server/src/item-searches/routes.ts
  - apps/server/src/ratings/routes.ts
  - apps/server/src/modules/music/routes.ts
  - apps/server/src/modules/films/routes.ts
  - apps/server/src/tools/video-engine/routes.ts
---

# HTTP surfaces and API ownership

Archivist has no OpenAPI document. Route modules and shared Zod contracts are implementation truth; this page records stable ownership, not every parameter or response field.

## Public paths on port 2424

| Path | Owner | Authentication |
|---|---|---|
| `/` | Gateway chooser | No |
| `/library/*` | Library SPA | UI shell public; API data authenticated |
| `/player/*` | Player SPA | UI shell public; API/media authenticated |
| `/catalogue/*` | Catalogue SPA | UI shell public; API data authenticated |
| `/emulatorjs/*` | Vendored arcade runtime | Asset path public |
| `/ping` | Express | No; liveness only |
| `/api/v1/auth/status` | Express auth | No |
| `/api/v1/auth/login` | Express auth | No; rate-limited |
| `/api/v1/auth/setup` | Express auth | Bootstrap principal required; rate-limited |
| `/api/v1/auth/logout` | Express auth | Clears session |
| `/api/v1/health` | Express health | No; aggregate worker and backup health only |
| `/api/v1/*` | Express | API key, browser session, device credential, or bootstrap where applicable |
| `/media/*` | Express static media | Authenticated |

## API route families

- Platform: `/system`, `/indexers`, `/release-pipeline`, `/item-searches`, `/torrents`, `/dashboard`, `/diag`.
- Library/curation: `/tabs`, `/root-folders`, `/quality-*`, `/download-clients`, `/settings`, `/lists`, `/list-imports`, `/collections`, `/ratings`, `/recommendations`, `/leaving-soon`.
- Media domains: `/films`, `/series`, `/music`, `/books`, `/comics`, `/games`.
- Playback/programming: `/player`, `/channels`, subtitle and media-file routes.
- Processing: `/processing` and system processing-monitor/segment routes.
- Catalogue: `/catalogue` for overview, flows, runs, items, people, tables, queues/control, and maintenance.

The route family alone does not indicate read/write safety. Consult its route module and validation contracts before calling it.

`/ratings` addresses a subject as `/:type/:id`, where type is one of `film`, `series`,
`season`, `episode`, `artist`, `album`, or `track`. Two tree endpoints resolve a whole
hierarchy in one pass rather than a request per row: `GET /ratings/series/:id/tree` and
`GET /ratings/artist/:id/tree`.

`/music` covers three levels. Artist routes carry the quality/codec profile, release-type
selection, discography search and grab, and metadata/artwork. Album routes add
`/music/albums/:id/metadata` and `/music/albums/:id/images` for per-album editing and
cover art; album cover candidates require a MusicBrainz release-group id, so albums
created by a file scan have none to offer. `PUT /music/tracks/:id/lyrics` stores a
track's lyrics; no lyrics provider is wired up, so the column is populated by hand and
stamped `manual`.

`/item-searches` is library-scoped through `X-Tab-Context`. `POST /item-searches` enqueues quick, deep, auto, or per-season auto-episode work; `GET /item-searches/latest` restores the active or unexpired search for a subject; `GET /item-searches/:id` polls it; and `DELETE /item-searches/:id` requests cancellation. Enqueue returns `202` for queued work. Result polling is ordinary JSON, not an SSE connection, because execution survives browser disconnects.

## Cross-cutting behavior

- Responses carry `X-Request-Id`; terminal errors return a request ID without a stack.
- JSON bodies default to `1mb`; Player preferences have a stricter `32 KiB` guard.
- Authenticated writes are rate-limited; lookup/search endpoints have a separate limiter.
- `X-Tab-Context` selects the active logical library where a route requires it.
- CORS is for explicitly allowed development origins. Production applications are same-origin.
- `TRUST_PROXY` is opt-in because client IP and secure-cookie behavior rely on it.
- `/api/v1/events` is a Server-Sent Events stream.
- Player film/episode streaming supports HTTP range semantics; plans/tracks/subtitles/transcode have dedicated routes.

## Health semantics

- `/ping`: the API process can answer HTTP.
- `/api/v1/health`: public aggregate application health. `status` is `ok` only when a ready, healthy worker heartbeat exists; it also reports sanitized backup health.
- Docker healthcheck uses `/api/v1/health`, so a live API with a dead worker is intentionally unhealthy.

## Compatibility rule

All web applications use absolute `/api/v1/...` calls. A contract change must update the route, shared contract when present, every caller, and tests together. Do not use an old compatibility inventory as evidence; inspect current callers with `rg`.

## Bounded processing and film reads

`GET /api/v1/films?window=1&limit=100&offset=0` returns `{items,nextOffset}`.
`sort`, `direction`, `collection`, `release`, and existing search filters are
applied before paging. `ids` accepts up to 250 film IDs for visible-record refresh.
Existing cursor and unpaged response modes remain compatible.

`GET /api/v1/processing/scan?limit=200&offset=0` returns a bounded result page and
`nextOffset`; existing scan summary fields remain. Optimisation jobs accept
`limit`/`offset`, with active work ordered before history. Counts use SQL aggregates
rather than the displayed page. `POST /api/v1/processing/jobs/:id/recover` enqueues
durable replacement recovery. Cancellation is accepted only before the replacing
commit phase; acknowledged controls are applied by the worker.
