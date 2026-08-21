---
title: Archivist capability map
document_type: reference
status: canonical
updated: 2026-08-21
evidence:
  - apps/server/src/routes.ts
  - apps/server/src/worker.ts
  - client/src/App.tsx
  - apps/player/src/App.tsx
  - apps/catalogue/src/App.tsx
  - apps/control/src/server/index.ts
  - apps/control-agent/src/index.ts
  - apps/server/src/services/item-searches.ts
  - apps/server/src/lists/compilers/tmdb.ts
  - apps/server/src/lists/lookup.ts
  - client/src/lib/lists.api.ts
  - client/src/modules/lists/index.tsx
  - client/src/modules/films/index.tsx
  - client/src/modules/series/index.tsx
  - apps/server/src/services/ratings.ts
  - apps/server/src/modules/music/routes.ts
  - client/src/modules/music/index.tsx
---

# Archivist capability map

This is the canonical implemented-capability register. “Implemented” means an executable route, service, UI, schema, or test exists in this repository. It does not promise that every provider account, indexer definition, codec, browser, or host permission will work without configuration.

## Product surfaces

| Surface | Production URL | Purpose | Delivery state |
|---|---|---|---|
| Chooser | `/` on port `2424` | Links the three application surfaces | Implemented |
| Library | `/library/` | Administration, acquisition, library management, settings, processing, and operations | Implemented |
| Player | `/player/` | Living-room browsing, search, playback, channels, and arcade | Implemented |
| Catalogue | `/catalogue/` | Catalogue flow studio, item/people inspection, table operations, and run control | Implemented |
| API | `/api/v1/` | Shared API for web/device clients; auth/bootstrap and aggregate health have explicit public routes | Implemented |
| Control | loopback port `2429` | Host telemetry, service recovery, logs, releases, backups, and files | Implemented on bare metal only |
| Kodi | packaged Python add-on | Device client using Archivist API/device credentials | Implemented; maintained separately from pnpm workspace |
| Mobile/remote | none | Proposed companion/remote experience | Not implemented as a separate app |

The three web applications and API use one production listener. Ports `5173`, `4242`, `2428`, and `2430` are development-server defaults, not production services.

## Media lifecycle

Archivist implements the lifecycle `Discover → Monitor → Acquire → Import → Organise → Programme → Watch` across six library domains.

| Capability | Films | Series | Music | Books | Comics | Games |
|---|---:|---:|---:|---:|---:|---:|
| Library records and root folders | Yes | Yes | Yes | Yes | Yes | Yes |
| Provider lookup and add workflow | Yes | Yes | Yes | Yes | Yes | Yes |
| Metadata refresh | Yes | Yes | Yes | Yes | Yes | Yes |
| Monitoring and wanted-state management | Yes | Yes | Yes | Yes | Yes | Yes |
| Interactive indexer search/grab | Yes | Yes | Yes | Yes | Yes | Yes |
| Release parsing and acquisition decisions | Yes | Yes | Yes | Yes | Yes | Yes |
| Download tracking and import | Yes | Yes | Yes | Yes | Yes | Yes |
| Player playback surface | Yes | Yes | Partial | Partial | Partial | Arcade |

“Partial” means the domain is represented and browsable but does not have the same rich browser playback path as film/episode video. Provider availability and identifiers differ by domain; consult configuration and provider code before promising a specific source.

## Acquisition and torrents

- Cardigann-style YAML definitions and Torznab indexers are loaded through `packages/indexer-engine` and the server bridge.
- Definitions ship under `data/indexer-definitions`; the configured runtime path takes precedence.
- Indexers support configuration, per-media priority, separate RSS priority, testing, enabled/disabled state, and RSS participation.
- Interactive searches aggregate enabled indexers and pass results through parsing, matching, quality, priority, blocklist, and decision logic.
- Film and series quick, deep/manual, and auto searches execute as durable background jobs. Navigation does not stop them; work queues serially by default, and returning within 15 minutes restores retained results.
- The release orchestrator polls enabled RSS feeds, persists per-indexer cursor/health/backoff state, deduplicates releases, and passes candidates through the same decision pipeline.
- Monitored episodes with an exact `air_at` timestamp enter a durable post-air state machine: rapid RSS, targeted search, backlog, then completion/cancellation.
- A release is queued automatically only when it matches a monitored wanted item, passes acquisition policy, has a usable download URL, and a functioning selected download client or embedded engine accepts it.
- A successful indexer test proves that test request, not every category/query path. Definition/site changes, credentials, anti-bot measures, and title/category mappings remain operational failure points.
- The embedded BitTorrent engine supports torrent session state, magnets/torrent files, trackers, DHT/PEX/LPD/uTP, file priorities, start/stop, recheck, reannounce, ordering, bandwidth/network status, and resume data. External download-client configuration is also supported.
- The torrent UI exposes queue state, network state, files, diagnostics, acquisition matching, import plans, manual match overrides, force import, bulk actions, and removal.

RSS and automatic release monitoring are therefore implemented, but they are conditional systems—not guarantees that an arbitrary title will be found. See [`acquisition-and-release-monitoring.md`](../04-features/acquisition/acquisition-and-release-monitoring.md).

## Library and curation

- Multiple logical libraries (“tabs”) per media type, each with roots, quality settings, download clients, and context carried by `X-Tab-Context`.
- Dashboard statistics, release calendar, global search, add-media, active downloads, and download actions.
- Film and series library cards expose Auto Scan until the item reaches its configured quality. Series card scans use a staged series-pack, season-pack, then episode strategy when at least one season has fully aired, and go directly episode-by-episode when no season has finished airing. Series details expose monitoring beside the Keep/Sweep control.
- Lists with provider lookup, preview, refresh runs, item review, individual/bulk add, and dismissal. Status queues load independently in paginated batches and retain per-status in-memory caches while the detail page is mounted. Genre uses a media-specific TMDB autocomplete; Series Lists additionally support TMDB network autocomplete and stable `with_networks` filtering.
- Manual and ordered collections with candidates, artwork, membership, and ordering.
- Personal ratings, unrated queue, dismissals, and rating trees. Ratings cover seven
  subject types across two hierarchies — film, and series ⇢ season ⇢ episode, and
  artist ⇢ album ⇢ track — resolved by specificity, so a track falls back to its album
  and then to its artist. The unrated queue is still driven by playback completion, so
  it surfaces films and episodes only.
- Recommendation snapshots, source refresh, feedback, invalidation, health, and settings.
- Leaving Soon rules, evaluation, keep requests, notifications, reconciliation, sweeping, and reports.
- Artwork selection/upload, metadata editing, acquisition history, scanning, and domain-specific management.
- Music artist pages carry an artist-wide quality/codec profile that cascades to every
  album, a discography search that maps one multi-album torrent onto individual albums,
  and an "All Releases" sweep that auto-grabs every monitored album the artist is still
  missing. The sweep runs sequentially in the browser and stops if the page is left.
- Music metadata editing spans all three levels: artist and album use the shared editor
  (fields plus artwork); a track's editable metadata is its lyrics, stored per track and
  entered by hand.
- Media-file metadata read/write/preview, subtitle search/download, audio/subtitle track cleaning, and video optimisation analysis/execution/quarantine restore.

## Player

- Profile-aware bootstrap and versioned preferences (current schema version `5`).
- Home hubs, domain browsing, field filters, search, film/series/episode/person details, recommendations, library selection, and sync manifest/change feeds.
- Playback progress, watched state, bookmarks, resume, editions, audio/subtitle track choice, external subtitle download, HTTP range streaming, transcode planning, and loudness state.
- Remote/keyboard focus navigation, sidebar rail, OSD, accessibility scaling/high contrast, and reduced-motion-aware interaction.
- Programmed Channels with guide/now-playing data and play sessions.
- Arcade using self-hosted EmulatorJS assets and game records; its looser CSP is deliberately scoped to the arcade shell/assets.
- Leaving Soon display and keep actions.

## Catalogue

- A separate SQLite catalogue database, initialized with legacy film catalogue tables and the universal catalogue schema.
- Flow definitions represented as editable graphs, publish/run/cancel operations, node-run state, bounded logs, and mapping-issue inspection.
- Catalogue overview, item and person browsing, identity-match inspection, artwork delivery, allowlisted table browsing/editing, checkpoint/reset, and runner control.
- Scheduled flow work and catalogue queues run in the background worker, not in the Catalogue SPA.
- Catalogue is an operational data/flow surface today; it is not yet the sole metadata database for every Library domain.

## Control

- Host load, CPU, memory, uptime, temperature, filesystem volumes, configured endpoints, service state, backup health, and bounded seven-day telemetry history.
- Immutable release inventory with current/previous targets and bootability/recovery checks.
- Allowlisted start/stop/restart for `archivist.service` through a unit/verb-scoped polkit rule; bounded journald reads.
- File Browser roots for the full filesystem and Cardigann definitions. Reads depend on Unix permissions and explicit protected-path blocks.
- Writes only under `ARCHIVIST_FILE_WRITE_PATHS`; supplied units allow `/home`, `/mnt`, `/media`, `/srv`, `/tmp`, `/var/tmp`, and the definitions directory.
- File download via single-use 30-second ticket; upload, create directory, move, recoverable trash, and restore. Mutations require the control token and append to the action audit log.
- The root-owned Control Agent has a Unix socket only and no network namespace. The web process remains unprivileged and does not receive arbitrary root execution.
- SMART, sensor, Btrfs, and ZFS support is capability detection only.

Not implemented in Control: arbitrary terminal/shell, Docker/Portainer-style container management, disk partitioning or formatting, mount management, SMB share administration, automatic application/OS updates, or unattended rollback. These remain future capabilities and must cross the restricted agent boundary if built.

## Platform and operations

- API and worker are separate child processes managed by the production supervisor; worker restart uses exponential backoff.
- The worker holds a renewable SQLite lease so only one background owner processes scheduled/durable work.
- Durable system jobs, processing monitor, process registry, event store, SSE, maintenance, backup, integrity, download, recommendation, list, channel, metadata, segment, loudness, and release schedulers.
- Request IDs, authenticated application routes, public bootstrap/aggregate-health exceptions, browser sessions, revocable device credentials, read/write/search rate limiting, library context, security headers, and redacted terminal errors.
- Main and catalogue SQLite databases; no Redis, PostgreSQL, external message broker, or n8n runtime.
- Docker application deployment and host-native full ecosystem deployment. Control is host-native in every deployment profile.

## Evidence and interpretation

Primary evidence is the route registry, worker startup list, schemas/migrations, UI route trees, deployment files, and tests listed in the frontmatter. A feature specification is not evidence of delivery. When implementation changes, update this register in the same change and run `pnpm docs:check`.
