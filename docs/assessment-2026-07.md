# Archivist Assessment and Improvement Register

Updated: 2026-07-10

## System Shape

Archivist is a TypeScript/pnpm monorepo. Express and better-sqlite3 own automation and library state; the admin React SPA is served on 2424. Archivist Player is now `apps/player`, served by a small reverse-proxy/static server on 4242. Docker runs two containers from one Compose project and one source tree.

The acquisition path is: indexer RSS or targeted search -> parse -> monitored title index -> per-subject decision -> audit ledger -> download client -> completion monitor -> durable import job -> organizer/validation -> collected library record.

## Implemented During This Assessment

- Automatic hourly targeted searches with persisted cooldown and monitoring filters.
- Six-hour continuing/upcoming series metadata refresh and weekly ended-series refresh through durable jobs.
- Serialized acquisition decisions to avoid overlapping RSS/search duplicate grabs.
- Download-client acceptance checks before status transitions and hash persistence for automatic grabs.
- Aired/monitored episode filtering, including season and multi-season packs.
- Automatic books/comics discovery; complete book monitoring, organization, validation, and edition import.
- Transmission and qBittorrent progress/completion snapshots and import control alongside the embedded engine.
- Scheduled Channels guide replenishment.
- Persisted local administrator credentials, scrypt password hashing, forced `archivist`/`archivist` bootstrap setup, opaque HttpOnly sessions, login throttling, exact CORS origins, service-token Player proxy, and protected media files.
- Server-backed Player progress, ffprobe caching, bounded transcodes, and non-root containers.
- One workspace and Compose project with ports 2424/4242; P2P ports moved to an optional override.
- Explicit schema migration for persistent automation and playback state.

## Remaining Priority Work

### High

- Release identification is intentionally conservative and exact-slug based. Add provider aliases, alternate titles, anime absolute-number mapping, and ambiguity review rather than broad fuzzy matching.
- Polls are decision-serialized, but releases fetched concurrently from separate indexers are not globally aggregated before choosing a winner. A short per-subject appraisal window would improve best-release selection.
- External-client polling currently fetches qBittorrent file lists per torrent. Batch/cache snapshots and expose client-health events for large queues.
- Book, comic, film, music, and game metadata refresh endpoints still contain detached legacy loops. Move them to the same durable job model used by series.

### Medium

- Split large domain route modules into application services and transport-only routers. Series, films, and media imports carry too many responsibilities.
- Add bounded parallelism and cancellation to provider artwork/metadata refreshes.
- Add a first-class remote-path mapping table with validation instead of one environment string.
- Add multi-profile Player progress and user authorization if the system becomes multi-user.
- Add retention/seed-ratio policy per external client rather than removing completed torrents immediately after successful import.

### Frontend and Delivery

- The admin JavaScript bundle remains approximately 634 kB minified. Lazy-load domain routes and heavy editors.
- Add component/browser tests for admin authentication, setup, acquisition repair, Player resume, and Channels playback.
- Add Docker image smoke tests and Compose health tests to CI.
- Add structured metrics for scheduler lag, search yield, decision rejection reasons, import latency, and transcode saturation.

## Operational Caveats

- Automatic acquisition requires at least one healthy enabled indexer and a working download client.
- New episodes can only be discovered after TVDB/TMDB publishes them; the default metadata delay is at most six hours plus the targeted-search cadence.
- A release must parse to a monitored subject and pass quality, blocklist, language, and upgrade rules.
- External download paths must be mounted into Archivist or translated with `REMOTE_PATH_MAP`.
- Omitting published P2P ports is valid for outbound downloading, but reduces incoming peers and seeding performance.
- Browser authentication is always enabled. `ARCHIVIST_API_TOKEN` is an internal service credential and is required for the production Player proxy; it is never accepted by the browser login form.
