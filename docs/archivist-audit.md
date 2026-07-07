# Archivist V2: The Comprehensive Rebuild Bible

> **Architect's Foreword (160+ IQ 360° Vision):**
> This document is the canonical, exhaustive specification for rebuilding Archivist on the modern stack. It is **not** a tour of the V1 codebase — V1 is the *feature catalogue*, the proof-of-concept that validated which features matter. The build target is the V2 stack: Bun + Hono + Drizzle + better-sqlite3 (WAL) + headless React + TanStack Query + Tailwind + SSE + in-memory event bus + persistent SQLite job queue.
>
> This document **subsumes** the strategic blueprint formerly in `ARCHITECTURE.md`. The original `ARCHITECTURE.md` is deprecated — every architectural tenet, departmental responsibility, design-system specification, and stack choice it contained is captured here.
>
> Archivist V1 is genuinely ambitious — it tried to fold the responsibilities of Sonarr, Radarr, Lidarr, Readarr, Mylar, Prowlarr, and qBittorrent into a single Node.js monolith with a custom in-process JS torrent engine, a Cardigann YAML execution engine, multi-tenant per-tab SQLite databases, automated track cleaning via FFmpeg, and a Plex-quality cinematic UI. It works in places, sketches in others, and has drifted from its own architecture document in several load-bearing ways. V2's job is to ship the V1 vision *correctly*.
>
> **How to read this document:**
> - Sections 1–6 are the **strategic spec**: principles, architecture, data model, lifecycle.
> - Sections 7–14 are the **departmental feature catalogue** — what each Museum department must do, with explicit cross-references to the radarr/sonarr/prowlarr/transmission audits where Archivist mimics those upstream systems.
> - Sections 15–22 are the **implementation surface** — schemas, APIs, UI surface, configuration.
> - Sections 23–26 are the **execution plan** — phased build order, parity criteria, V1-divergence resolution rules, and the coverage checklist.
>
> Everywhere V1's implementation diverges from `ARCHITECTURE.md`, the latter wins unless explicitly overridden.

---

## 1. Core Principles

### 1.1. Tenets (from ARCHITECTURE.md, restated as the contract)
1.  **Modular Monolith.** Strict bounded contexts (Museum departments). No cross-context DB access; only typed events on the bus or RPC calls into a department's public surface.
2.  **Domain-Driven (Museum Metaphor).** `Artifacts` (physical media files), `Exhibits` (TMDB-style normalised metadata), `Leads` (potential acquisition sources / torrents). The metaphor is not decoration — it shapes the package layout, the event names, and the UI vocabulary.
3.  **Interface-Driven Logistics.** External tools (qBittorrent, Transmission, TMDB, Prowlarr) are interchangeable plugins. Core domain knows nothing about their wire formats.
4.  **Type Safety & Determinism.** End-to-end via Hono RPC: backend route signatures become frontend client types; schema changes break compilation.

### 1.2. Tenets Specific to V2 (extending V1's intent)
5.  **Single Process.** The torrent engine, indexer engine, metadata engine, scheduler, RPC API, and SSE hub all run in one Bun process. No sidecars by default; the optional Sidecar Daemon Pattern (§6 of ARCHITECTURE.md) is reserved for users who need native libtorrent throughput.
6.  **Single Unified Database.** `archivist.sqlite` (WAL mode, `synchronous=NORMAL`). V1's per-tab fragmentation (`films.db`, `films-4k.db`, `films-kids.db`, `series.db`, `music.db`, …) is **rejected** in V2; libraries become a `library_id` foreign-key dimension, not a physical DB boundary.
7.  **Greenfield.** No data migration from V1's databases. Users start fresh on V2; their media files on disk are re-imported via the Holding Pen / Manual Import flow.
8.  **Headless Components, Cyberpunk Skin.** Behaviour from Radix UI / React Aria; aesthetic from Tailwind + the Noir + accent-neon palette frozen in `ARCHITECTURE.md` §7.1.

---

## 2. Stack

### 2.1. Backend
| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Bun** (Node.js compatibility shim where needed) | Native TypeScript execution; `Bun.serve` HTTP; `worker_threads` for CPU-bound workers |
| HTTP framework | **Hono** | Edge-ready; `@hono/zod-validator` for request validation; Hono RPC for typed clients |
| Database | **better-sqlite3** with WAL | Synchronous API simpler than async drivers; checkpoint via `wal_checkpoint(TRUNCATE)` |
| ORM | **Drizzle** | Pure SQL builder; typed schema; `drizzle-kit` migrations |
| Job queue | **In-memory `EventEmitter` + SQLite-backed jobs table** | Survives crashes; no Redis dependency |
| Validation | **Zod** | Shared schemas between Hono routes and frontend |
| Logging | Custom logger (V1 retains its `createLogger` shape) | Levels: trace/debug/info/warn/error/fatal |
| Process management | Native Bun + `Bun.spawn` for ffmpeg/ffprobe | Worker pool for CPU-bound (piece verify, track clean) |

### 2.2. Frontend
| Layer | Choice | Notes |
|---|---|---|
| Framework | **React** + **Vite** | Existing V1 frontend already React; preserve |
| Routing | **React Router v6** | App.tsx pattern from V1 |
| Data fetching | **TanStack Query** | Aggressive caching; SSE-driven invalidation |
| Forms | **React Hook Form** + **Zod** resolvers | Shared validation with backend |
| Headless behaviour | **Radix UI** + **React Aria** where Radix doesn't cover | Accessibility, keyboard, focus management |
| Styling | **Tailwind CSS** + custom Noir palette | See §17 |
| Icons | Inline SVG components | No icon library bundle |
| State | **Zustand** for cross-tree state (active library, theme) | TanStack Query covers server state |
| Realtime | Native `EventSource` (SSE) | One open channel per UI session |

### 2.3. Embedded Engines
| Engine | Source | Notes |
|---|---|---|
| Torrent | `@torrentstack/torrent-engine` (existing pure-TS) | See `transmission-audit.md` §10–§59 for protocol surface |
| Indexer | `@torrentstack/indexer-engine` (existing) | See `prowlarr-audit.md` for Cardigann surface |
| Bencode + BitTorrent protocol | `@torrentstack/bittorrent` (existing) | uTP impl is incomplete; ship TCP-only initially |
| Metadata clients | `@archivist/core` extensions | TMDB, TVDB, MusicBrainz, ComicVine, IGDB, Google Books, Fanart.tv |

### 2.4. External Binaries
| Binary | Role | Bundling |
|---|---|---|
| `ffmpeg` | Track stripping, transcoding, NFO probing, chapter extraction | `ffmpeg-static` npm |
| `ffprobe` | Stream analysis | `ffprobe-static` npm |
| FlareSolverr (optional) | Cloudflare bypass for indexers | User-supplied; reachable via HTTP |

---

## 3. The Museum (Bounded Contexts / Departments)

The package layout follows the museum metaphor. Each department is a folder under `src/` with a strict public surface (`index.ts` re-exports only the typed contracts; everything else is private to the department).

```
src/
├── acquisitions/      # The Sourcing Department — finding Leads
├── intake/            # The Loading Dock — downloading bytes
├── appraisal/         # Authentication & ID — parsing, identifying, scoring
├── restoration/       # Conservation Lab — track cleaning, subtitles, metadata
├── vault/             # Archives — filesystem moves, NFO, hardlinks, DB writes
├── galleries/         # Exhibition Halls — read API, dashboard, calendar, search
├── curator/           # Director's Office — scheduler, event bus, lifecycle FSM
├── shared/            # Cross-cutting types, utils, db client
├── server.ts          # Bootstrap
└── routes.ts          # Hono RPC route registry
```

### 3.1. Inter-Department Communication
*   **Events** flow **upstream-to-downstream** through the central `EventBus`. Departments declare which events they emit and which they subscribe to in their `index.ts`.
*   **Commands** flow downstream-to-upstream as direct typed RPC calls. The Curator dispatches to other departments by importing their public surface; departments never call each other directly.
*   **Reads** are unrestricted within a department against its own tables; cross-department reads must go through that department's typed read API.

### 3.2. The Event Catalogue (Initial Set)
| Event | Producer | Consumers |
|---|---|---|
| `LeadFoundEvent` | `acquisitions` | `curator`, `appraisal` |
| `LeadAcceptedEvent` | `appraisal` | `intake`, `curator` |
| `LeadRejectedEvent` | `appraisal` | `curator` (for blocklist) |
| `ArtifactDownloadStartedEvent` | `intake` | `galleries`, `curator` |
| `ArtifactProgressEvent` | `intake` | `galleries` (SSE) |
| `ArtifactArrivedEvent` | `intake` | `appraisal`, `curator` |
| `ArtifactAppraisedEvent` | `appraisal` | `restoration`, `vault`, `curator` |
| `RestorationCompleteEvent` | `restoration` | `vault`, `curator`, `galleries` |
| `ArtifactArchivedEvent` | `vault` | `galleries`, `curator`, `notifications` |
| `ExhibitWantedEvent` | `curator` | `acquisitions` |
| `ExhibitMissingEvent` | `curator` | `acquisitions`, `notifications` |
| `IntegrityProblemFoundEvent` | `curator` | `notifications` |
| `JobStartedEvent` / `JobFinishedEvent` | `curator` | `galleries`, `notifications` |
| `IndexerStatusChangedEvent` | `acquisitions` | `galleries`, `notifications` |
| `TabContextSwitchedEvent` | UI → server | (no-op on backend; UI cache key) |

All events are typed Zod schemas in `shared/events.ts`; the bus is a strongly-typed `EventEmitter<EventMap>`.

---

## 4. The Unified Vault — Data Model

The full Drizzle schema lives in `vault/schema.ts`. Below is the high-level shape; sections 15–16 give the complete column lists.

### 4.1. Top-Level Concepts
*   **Library** (`libraries`): a logical collection (`Main Films`, `4K Films`, `Kids Films`, `Anime`, `Music`, `Comics`, `Games`, `Books`, `Magazines`, `Podcasts`). Replaces V1's per-tab DBs. `media_type` column. Each library has a `root_folder_path`, a default quality profile, and tags.
*   **Compendium** (`compendiums`): cross-media franchise grouping (e.g. "Marvel Cinematic Universe"). Optional foreign key on every specialised media table. Enables cross-media dashboards.
*   **Exhibit**: a metadata record (one per work). Distinct typed tables per media type (`films`, `series`, `seasons`, `episodes`, `artists`, `albums`, `tracks`, `authors`, `books`, `comic_series`, `comic_issues`, `games`, `magazines`, `podcast_shows`, `podcast_episodes`).
*   **Artifact** (`*_files`): the physical file row attached to an Exhibit. 1:N relationship — multi-edition films, multi-episode TV files, multi-format books.
*   **Lead**: a parsed search result that may resolve to an Exhibit. Persisted as `acquisition_decisions` (audit ledger) and `release_blocklist` (deny list).

### 4.2. Specialised Vaults (per `ARCHITECTURE.md` §4.2)
Strictly-typed tables per media type — no Single Table Inheritance.
*   `films`, `film_editions` (1:N — V1 already has this)
*   `series` → `seasons` → `episodes` → `episode_files` (the `EpisodeFile` 1:N pattern from `sonarr-audit.md` §9.4)
*   `artists` → `albums` → `tracks`
*   `authors` → `books` → `book_editions`
*   `comic_series` → `comic_issues`
*   `games`
*   `magazines` (V1 unimplemented — V2 must add)
*   `podcast_shows` → `podcast_episodes` (V1 unimplemented — V2 must add)

Each specialised table carries a strict `library_id` foreign key (replaces the V1 multi-DB tab system) and an optional `compendium_id`.

### 4.3. Cross-Cutting Tables
*   `tags`, plus M:N join tables to every entity that can be tagged (`*_tags`) — drives routing for indexers, download clients, notifications, delay profiles. Identical pattern to Sonarr/Radarr.
*   `quality_profiles`, `quality_definitions`, `custom_formats`, `custom_format_specifications` — borrowed wholesale from `radarr-audit.md` §16–§17, extended with the TV-specific spec types from `sonarr-audit.md` §15.
*   `release_profiles` — legacy required/ignored/preferred words. Co-exists with custom formats per `sonarr-audit.md` §9.8.
*   `quality_tiers` — Archivist's distinguishing feature: hand-curated release-group tier lists (Tier 1 = QxR, Tigole, Bandi; Tier 2 = UTR, Joy; Tier 3 = YIFY, PSA; configurable per media type).
*   `edition_rules` — V1 innovation: regex-pattern → output-label mapping for naming editions (Director's Cut, Extended, Remastered, etc.). Per `films/db.ts` migration v16.
*   `indexers`, `indexer_status`, `indexer_proxies` — full Prowlarr-equivalent surface per `prowlarr-audit.md`.
*   `download_clients` — qBittorrent + Transmission + Sabnzbd + NzbGet adapters. Per-library scoping plus global default.
*   `system_jobs`, `system_events` — persistent job queue + audit log. V1 already has this in `services/job-runner.ts` + `services/system-store.ts`.
*   `media_imports` — manual/holding-pen import queue. V1's `services/media-imports.ts` shape is sound; preserve.
*   `acquisition_decisions`, `release_blocklist` — full release-evaluation audit ledger. V1's `services/acquisition-decisions.ts` shape is sound; preserve.
*   `notifications`, `notification_status`, `notification_targets` — full Sonarr-equivalent provider matrix.
*   `history` — append-only event log keyed by media-type + entity id. Replaces V1's scattered logging in each module.
*   `app_settings` — typed key/value config rows: `naming, mediaManagement, hostConfig, uiConfig, trackCleaner, subtitles, qualityTiers, acquisitionDefaults, flaresolverr, apiKeys (encrypted)`.

---

## 5. The Lifecycle State Machine

Every Exhibit follows a deterministic state machine. This is the core contract — a misimplemented FSM is what breaks the *arr ecosystem on busy libraries.

### 5.1. States
```
upcoming → wanted → searching → acquiring → restoring → collected
   ↑         ↑         ↓             ↓           ↓          ↓
   └─────────┴─────────┴─────────────┴───────────┴──────────┘
                        (failure paths return → wanted)

   wanted ⇆ ignored                  (user toggle)
   collected → rejected → wanted     (user marks bad)
```

| State | Meaning |
|---|---|
| `upcoming` | Monitored; release date in future. Curator's calendar trigger flips → `wanted` on release day. |
| `wanted` | Released, no leads acquired. Eligible for next RSS / missing-search cycle. |
| `searching` | A targeted search is in flight. Mostly informational for the UI. |
| `acquiring` | A lead was selected; download client is fetching. |
| `restoring` | Download complete; track cleaning, subtitle fetch, NFO generation, asset download in progress. |
| `collected` | File on disk in the Vault, NFO + assets written, fully on display. |
| `rejected` / `blacklisted` | User marked bad OR auto-rejected. Hash blacklisted; reverts to `wanted` if monitored. |
| `ignored` | User explicitly told the Curator not to source. |

### 5.2. Transition Rules
*   Every transition is a Curator method dispatched in response to an event. Departments do not flip status fields directly.
*   Failed downloads (`DownloadFailedEvent` while in `acquiring`): blacklist the lead's `info_hash`, transition → `wanted`, dispatch a new search after exponential backoff (60s → 5m → 30m → 6h cap).
*   Completed downloads in `acquiring` → `restoring` (Restoration always runs even if no work to do; emits `RestorationCompleteEvent` immediately on no-op).
*   `restoring` → `collected` requires the Vault's `ArtifactArchivedEvent`. The Vault is the only writer of file paths and `collected` state.
*   The state machine refuses illegal transitions and emits a `StateMachineViolationEvent` with stack trace. Health alert raised; transition rejected.

### 5.3. Per-Hierarchy Status
*   For TV: `series` has its own `status` (`continuing | ended | upcoming | deleted`, sourced from TVDB — see `sonarr-audit.md` §18.2). `episode.status` is **derived**: `tba | unaired | downloaded | missing | acquiring | restoring`.
*   For films, music albums, books, comics, games: status is stored on the entity row.
*   Compendium and Library have no status; they're organisational only.

---

## 6. Cross-Reference: Where Archivist Mimics Upstream

Archivist V2 deliberately reproduces specific behaviours from each upstream tool. This table is the index into the existing audit docs:

| Archivist Department | Mimics | Source audit | Sections |
|---|---|---|---|
| `acquisitions` | Prowlarr (indexer engine + Cardigann + push) | `prowlarr-audit.md` | §11–§14, §29–§50 |
| `acquisitions` (RSS / search lifecycle) | Sonarr/Radarr release pipeline | `sonarr-audit.md`, `radarr-audit.md` | sonarr §13, radarr §15 |
| `intake` (built-in torrent engine) | Transmission | `transmission-audit.md` | §10–§59 |
| `intake` (external client adapters) | Sonarr download-client model | `sonarr-audit.md` | §17 |
| `appraisal` (parser + identification) | Sonarr/Radarr parser | `sonarr-audit.md`, `radarr-audit.md` | sonarr §32, radarr §17 |
| `appraisal` (custom formats) | Radarr Custom Format engine | `radarr-audit.md` | §17 |
| `restoration` (track cleaning) | Original Archivist innovation | — | §10 of this doc |
| `restoration` (subtitles) | OpenSubtitles client | — | §11 of this doc |
| `vault` (naming + NFO) | Sonarr/Radarr naming engine | `sonarr-audit.md`, `radarr-audit.md` | sonarr §14, radarr §20 |
| `vault` (atomic hardlinks) | Transmission set-location semantics | `transmission-audit.md` | §24.5 |
| `galleries` (calendar/iCal) | Sonarr calendar | `sonarr-audit.md` | §20 |
| `galleries` (dashboard) | Original Archivist Command Center | — | §13 of this doc |
| `curator` (commands) | Sonarr command pattern | `sonarr-audit.md` | §13.9, §44 |
| `curator` (data integrity) | Original Archivist innovation | — | §14 of this doc |

Where this document is silent on a behaviour explicitly covered upstream, **defer to the upstream audit**. This document only deviates when Archivist V2 takes a different path or adds a V1 innovation.

---

## 7. Department: `acquisitions`

### 7.1. Responsibility
Source `Leads` for missing Exhibits. Owns indexers, RSS polling, search queries, anti-bot bypass, and definition sync.

### 7.2. Surface (V1's `services/indexer-bridge.ts` + `modules/indexers/routes.ts` + `modules/release-pipeline/`)

The full Prowlarr-equivalent surface — see `prowlarr-audit.md` for the contract:
*   **Indexer registry** with three implementations: `Newznab`, `Torznab`, `Cardigann` (`prowlarr-audit.md` §11).
*   **Cardigann YAML execution engine** — V1 already ships this in `packages/indexer-engine/src/cardigann/`. Switch from Nunjucks to a hand-rolled `{{ }}` evaluator per `prowlarr-audit.md` §29.5; Nunjucks's semantics drift from Go templates and silently break ~5% of community definitions.
*   **Definition repository sync** from `Prowlarr/Indexers` GitHub repo. ZIP-based, SHA-256-verified, atomic extract-and-swap (`prowlarr-audit.md` §46).
*   **FlareSolverr proxy** for Cloudflare-protected indexers (`prowlarr-audit.md` §19, §30).
*   **Per-indexer health + escalation** with the 8-tier backoff schedule (`prowlarr-audit.md` §16.4).
*   **Search aggregation** with parallel fan-out + 3-pass dedup (`prowlarr-audit.md` §15).
*   **Per-indexer rate limiting** + cookie persistence + UA strategy (`prowlarr-audit.md` §40).

### 7.3. The Release Pipeline (V1's `modules/release-pipeline/`)
This is V1's biggest correctness win and must be preserved:
*   **Per-indexer RSS orchestrator** with watermark + GUID dedup + 4-concurrent poll budget (V1's `orchestrator.ts`).
*   **In-memory Title Index** — every monitored subject across every library indexed by normalised slug; refresh every 2 minutes (V1's `title-index.ts`).
*   **Identification** with year-tolerance + cross-media fallback (V1's `identifier.ts`; aligns with `sonarr-audit.md` §32).
*   **Subject-grouped decision pipeline** — replaces Sonarr's old O(items × releases) loop with O(releases) parse + O(unique subjects) decision (V1's `subject-decisions.ts`).
*   **Missing-search scheduler** — RSS-complement targeted searches every 6h (V1's `missing-search.ts`; aligns with `sonarr-audit.md` §13.4).

### 7.4. V1 Quirks to Preserve
*   The **Quality Tier system** (`shared/routes.ts` `getTierTermsForMedia`) is an Archivist-specific innovation — hand-curated release-group lists (Tier 1: QxR/Tigole/Bandi; Tier 2: UTR/Joy/Korach; Tier 3: YIFY/PSA/MeGusta). V1 stores per-media-type tier mappings; V2 must preserve this as a first-class scoring layer **on top of** Radarr Custom Formats, not a replacement for them.
*   **Tiered search strategy** in `films/routes.ts` `performTieredSearch` — escalates queries from strictest (tier-specific term + resolution + source + codec) to broadest (just title + year). Preserve the strategy; ship as `appraisal/search-strategy.ts`.

### 7.5. V1 Divergence from Goal
*   V1 does NOT implement the prowlarr-style "push to apps" model — it acts as both Prowlarr and Sonarr in one process. V2 inherits this monolithic posture; it does NOT need to expose `/release/push` to itself.
*   V1's indexer engine speaks Newznab/Torznab and Cardigann. **It does NOT need to expose a unified Newznab endpoint at `/<indexerId>/api`** because there are no external `*arr` apps to feed; everything is in-process.

---

## 8. Department: `intake`

### 8.1. Responsibility
Transport bytes from outside world to the Loading Dock. Owns the embedded torrent engine, external client adapters, partial-download priority, holding pen, and remote path mapping.

### 8.2. The Embedded Torrent Engine (V1's `@torrentstack/torrent-engine`)

**LOCK: Pure-TypeScript engine is the V2 default.** No N-API, no sidecar, no external daemon. The single-process "fully built-in" experience is a core product identity decision, validated against the practical reality that V1 already ships ~14 of 15 major subsystems in pure TS.

The protocol surface and required parity is documented in full in `transmission-audit.md` Parts II + III — treat that document as the spec. The Transmission learnings transfer **directly** for ~95% of subsystems (choke algorithm, piece picker, MSE handshake, DHT, tracker, hashfail banning, state machine, etc.); the one exception is uTP/LEDBAT — see §8.6b below.

The engine production-readiness plan with three concrete validation milestones is locked in `unified-audit.md` §30. **V1.0 cannot ship until all three milestones pass.**

**V1 status** (per inspection of `packages/bittorrent/` + `packages/torrent-engine/`):
*   ✅ BEP 3 wire protocol (handshake + 10 core messages)
*   ✅ Bencode codec
*   ✅ Metainfo v1 (BEP 3); v2/hybrid (BEP 52) partial
*   ✅ HTTP tracker (BEP 23 compact)
*   ✅ UDP tracker (BEP 15)
*   ✅ DHT (Mainline BEP 5) — basic
*   ✅ PEX (BEP 11)
*   ✅ LPD (BEP 14)
*   ✅ MSE/PE handshake — partial (verify against `transmission-audit.md` §37)
*   ⚠️  uTP (BEP 29) — present but not robust; ship TCP-only by default
*   ✅ Fast Extension (BEP 6)
*   ✅ Extension Protocol (BEP 10) + ut_metadata (BEP 9)
*   ✅ Webseeds (BEP 19)
*   ✅ Worker-pool piece verification (`piece-verifier.worker.ts`)
*   ⚠️  Custom piece picker patch (`services/torrent-session.ts` `applyPatches`) is currently **disabled** — re-enable only after fixing the bug noted in source comments
*   ❌ BEP 42 (secure node id) — implement per `transmission-audit.md` §39.1
*   ❌ Lazy bitfield (`have_all`/`have_none`) — implement per `transmission-audit.md` §49

### 8.3. External Client Adapters
Per `sonarr-audit.md` §17 + `transmission-audit.md` §20:
*   **qBittorrent** Web API (cookie session, `/api/v2/`)
*   **Transmission** RPC (`X-Transmission-Session-Id` 409 retry; full method catalogue per `transmission-audit.md` §20)
*   **SABnzbd** (Usenet)
*   **NzbGet** (Usenet)

V1's `dashboard/routes.ts` already has the qBittorrent + Transmission adapters. V2 keeps them under `intake/clients/` with shared `DownloadClient` interface.

### 8.4. Holding Pen (V1 Innovation)
The `data/downloads/` watch folder pattern from V1's `services/media-imports.ts`:
1.  User drops a file/folder into `<incomplete-dir>` or a pre-configured holding-pen path.
2.  Watcher (`chokidar` with `awaitWriteFinish` for stable-size detection — `transmission-audit.md` §52) detects new content.
3.  Surfaces in UI as a "Pending Manual Import" with auto-suggested target Exhibit (token-based fuzzy match across all libraries).
4.  User confirms target + edition + quality.
5.  `intake/manual-import.ts` validates, runs MediaInfo, persists, dispatches `ArtifactArrivedEvent`.

### 8.5. Remote Path Mapping
V1's `mediaorganizer.mapRemotePath` translates paths reported by external clients (running on a different host or container) to the local mount. V2 generalises:
```ts
type PathMapping = { remotePrefix: string; localPrefix: string }
// Configured per download client; first matching mapping wins.
```

### 8.6. Partial Downloads & Wanted-Progress
Per `transmission-audit.md` §17.3:
*   File deselection via priority `0` for unwanted files.
*   Engine treats unwanted pieces as `STATUS_SKIPPED`.
*   Progress reporting computed against wanted bytes only (`getWantedProgress`).
*   UI's percent-complete reflects this — 100% when wanted bytes finish, even if 8/10 GB of "extras" untouched.

### 8.6a. Required Engine Feature Parity (LOCK)

Whichever engine is chosen (pure-TS or native binding — see `unified-audit.md` §C7 for the conflict to resolve), it MUST expose the following user-facing controls. The UI assumes these are present; missing any of them is a feature regression:

| Feature | Spec |
|---|---|
| **Sequential downloading** | "Stream-while-download" mode — engine prioritises pieces in file-byte order (BEP 6 strict-priority picker). Toggle per torrent OR globally via `sequentialDownloadDefault`. Used for media-preview workflows. |
| **Micro-manageable piece selection** | Per-file priority within a multi-file torrent: `do-not-download | low | normal | high`. Persisted in resume file's `priority[]` array. Re-applied on engine restart. |
| **Dynamic bandwidth scheduling** | Two distinct rate-limit profiles (Normal + Turtle Mode). `alt-speed-time-enabled` plus `alt-speed-time-day` (bitmask: Mon=1..Sun=64) plus `alt-speed-time-begin`/`alt-speed-time-end` for scheduling. Manual one-click toggle separate from schedule. |
| **Ratio & idle management** | Per-torrent `seedRatioMode` (0=global, 1=single, 2=unlimited) + `seedRatioLimit` (float). Same shape for `seedIdleMode` + `seedIdleLimit` (minutes). Engine auto-pauses when limit reached; fires `script-torrent-done-seeding`. |
| **Permission control (umask)** | Engine respects `umask` setting (default `002` for group-write). Files written by the engine inherit the umask; the Vault inherits too. Critical for headless setups where the Archivist user is in a `media` group. |
| **Network interface binding (VPN lock)** | `bind_address_ipv4` + `bind_address_ipv6` settings. Engine binds outbound sockets to that interface. On interface disappearance, **all torrent activity pauses** and a `InterfaceMissingHealthAlert` is raised. On reappearance, unpauses + clears alert. This is the kill-switch behaviour. |
| **Native incomplete staging** | Active downloads write to `<incomplete-dir>` with `.part` suffix on filenames (per `transmission-audit.md` §43.2). On 100% completion, `.part` is renamed and the file is moved (rename within FS, byte-copy + verify across FS) to `<download-dir>`. The Vault's organise step **only sees fully-staged files**. |

### 8.6b. uTP / LEDBAT — The Single Pure-TS Limitation (LOCK)

LEDBAT (RFC 6817) requires microsecond-precision one-way delay measurements over UDP, with a 100 ms queueing-delay target and a 2-minute sliding base-delay window. **Pure-TS cannot match libtransmission's precision** — Node/Bun GC pauses spike 50–200 ms, corrupting LEDBAT's measurements.

**The locked mitigation:**
1. **V1.0 ships TCP-only.** TCP-only covers ~99% of public swarms; uTP is a router-friendliness optimisation, not a correctness requirement.
2. **For mandatory-uTP private trackers** (a small subset), the external download-client adapter (§8.3) is the escape hatch — users configure qBittorrent alongside the built-in engine and Archivist routes those grabs externally.
3. uTP is documented as a **Phase 8+ stretch goal**, not a Phase 7 blocker. A best-effort uTP impl can be added later without blocking V1.0 ship.

This is the only subsystem where pure-TS is meaningfully behind libtransmission. Everything else in `transmission-audit.md` Parts II + III ports cleanly.

### 8.7. Torrent Engine Settings
Mirror Transmission's `settings.json` per `transmission-audit.md` §25 — every key reachable via `/api/v1/config/intake`. V2 adds:
*   `embedEngineEnabled: bool` (false → require external client; true is default)
*   `vpnLockBindAddress: string | null` (per `transmission-audit.md` §32)

---

## 9. Department: `appraisal`

### 9.1. Responsibility
Inspect raw release titles + arrived files; identify what they are; verify quality. The brain.

### 9.2. The Lexical Parser
V1 has a mature parser in `modules/release-pipeline/parser.ts` that already handles:
*   Standard `S\d+E\d+` with multi-episode + range variants
*   Daily `\d{4}-\d{2}-\d{2}`
*   Anime absolute-episode + bracketed forms
*   PROPER/REPACK/REPACK2 versioning
*   33-language tokens
*   Audio codec + channels (TrueHD/DTS-HD/EAC3 etc., 7.1/5.1/2.0)
*   HDR/Dolby Vision/HLG, 3D
*   Specials/OVA/NCED/NCOP

The contextual-lexer approach from `ARCHITECTURE.md` §5.1 is the intent. V1's implementation is regex-heavy but **structurally a contextual lexer** (anime → daily → standard dispatch). V2 keeps the dispatch shape; cleans up the regex into a proper tokeniser per `sonarr-audit.md` §32.5.

### 9.3. The `ParsedRelease` Contract
V1's `ParsedRelease` shape (`modules/release-pipeline/parser.ts`) is sound and aligned with Sonarr's `ParsedEpisodeInfo` (`sonarr-audit.md` §32.2). Preserve verbatim:
```ts
{
  kind: 'series'|'movie'|'unknown',
  title: string,
  titleNormalized: string,
  year: number | null,
  season: number | null,
  episodes: number[],
  absoluteEpisode: number | null,
  airDate: string | null,
  isSeasonPack: boolean,
  isMultiEpisode: boolean,
  isSpecial: boolean,
  resolution: '2160p'|'1080p'|'720p'|'480p'|'SD'|null,
  source: 'REMUX'|'BluRay'|'WEB'|'HDTV'|'DVD'|null,
  codec: 'AV1'|'x265'|'x264'|null,
  hdr: boolean,
  remux: boolean,
  threeD: boolean,
  audioCodec: 'TrueHD'|'DTS-HD'|'DTS'|'EAC3'|'AC3'|'AAC'|'OPUS'|'FLAC'|'MP3'|null,
  audioChannels: '7.1'|'5.1'|'2.0'|null,
  releaseGroup: string | null,
  edition: string | null,
  language: string[],
  proper: number,  // 0=v1, 1=PROPER, 2=REPACK, ...
}
```

### 9.4. Identification (V1's `identifier.ts`)
Same algorithm as `sonarr-audit.md` §32 — slug lookup against the in-memory Title Index, year-tolerance disambiguation, cross-media fallback. Preserve.

### 9.5. The Scoring Layers
Three layered scoring engines (descending priority):
1.  **Hard gates** — Quality Definition size envelope, Release Profile required/ignored words, Custom Format `required` specs (per `radarr-audit.md` §16.1).
2.  **Custom Formats** — full Radarr engine + Sonarr's TV-specific specs (`radarr-audit.md` §17, `sonarr-audit.md` §15). Score sum.
3.  **Quality Tier (Archivist innovation)** — V1's hand-curated tier lists. Tier 1 wins over Tier 2 wins over Tier 3 wins over untiered — **regardless of format score**. This is intentional: an Archivist user trusts their hand-curated release-group list more than any computed score.
*   **Tiebreakers** within tier: format score → seeders → indexer priority.

### 9.6. The Decision Context
V1's `acquisition-decisions.ts:DecisionContext` shape is sound. Preserve the per-decision audit ledger: every release evaluation persists `{ accepted, score, customTier, reasons[], rejectionReasons[] }` to `acquisition_decisions`. Powers the per-Exhibit "Acquisition History" UI tab and the manual-grab override flow.

### 9.7. The Blocklist
V1's `release_blocklist` table keyed on `info_hash + guid + URL` with structured reason. Preserve. UI lists at `/api/v1/release-blocklist`.

### 9.8. On-the-Fly File Analysis
V1's `media-organizer.ts:getFilmFileInfo` runs `ffprobe` to extract video codec, audio tracks, subtitle tracks, chapters. Used by:
*   Detail-page UI rendering (live, not cached).
*   Pre/post import validation (chapter-count regression detection).
*   Track Cleaner's strip plan generation.

V2 ships this as `appraisal/probe.ts` with a 2-minute LRU cache to avoid re-probing on rapid UI navigation.

---

## 10. Department: `restoration`

### 10.1. Responsibility
Long-running post-processing of arrived artifacts before they enter the Vault. Track stripping, subtitle acquisition, asset download (posters/fanart/logos), NFO generation, transcoding (V2 future).

### 10.2. Track Cleaner (Archivist's Defining Feature)
V1's `services/media-processor.ts` is the prototype. Behaviour:
*   `ffprobe` analyses embedded streams.
*   Configured language profile decides what stays:
    *   **Original-language audio** (per the Exhibit's TMDB `originalLanguage`) — kept if `keepOriginalLanguage: true`.
    *   **Preferred-language audio + subs** — kept if `keepPreferredAudio` / `keepPreferredSubs`.
    *   **Commentary tracks** — kept if `keepCommentary` (heuristic: title contains "commentary"/"director"/"cast", or `disposition.comment = 1`).
    *   **Music-only / score-only / isolated-score** tracks — always kept (rare; never user-removed by accident).
    *   Additional language whitelist (`additionalLanguages: string[]`).
*   `ffmpeg -map ... -c copy` (stream copy, no re-encode) preserves quality; outputs run in 1–10 s for typical 4K REMUX.
*   `-map_chapters 0` preserves embedded chapter markers.
*   Default/forced disposition flags reapplied to chosen tracks.

V2 enhancements:
*   **Subtitle co-import detection** — external `.srt`/`.ass` files alongside the video are preserved via `vault/asset-organizer.ts`, never overwritten by track cleaning.
*   **Validation pipeline** — pre/post probe, chapter-count regression alarm (file shrinks unexpectedly → reject), audio-track-zero-after-clean alarm.
*   **Resource sandboxing** — `Bun.spawn({ env: { GOMAXPROCS: '1' }, ... })` plus OS-level niceness on Linux to keep ffmpeg from starving the event loop.

### 10.3. Subtitle Provider
V1's `services/subtitle-provider.ts` is OpenSubtitles-only. Behaviour:
*   REST API v2 with JWT login (username/password + apiKey + appName as User-Agent).
*   Search by IMDB ID, TMDB ID, or text query.
*   Filters: language, hearing-impaired, forced-only.
*   Auto-acquire post-organise (toggle).
*   Downloads to `<videoDir>/<basename>.<lang>[.forced|.sdh].srt`.

V2 expansions:
*   Add Bazarr-style provider matrix (Subscene, Addic7ed, Subdivx, etc.) — multi-provider fallback.
*   Per-language priority list (try EN-forced before EN-full when watching dubs).
*   Embed provider scores in subtitle table (downloads, rating, hearingImpaired, forced).

### 10.4. Asset Acquisition
Posters, fanart, logos, banners, clearart, clearlogo per upstream source:
*   Films: TMDB images endpoint + Fanart.tv (V1 already implements both per `films/routes.ts:GET /films/:id/images`).
*   Series: TVDB v4 (with PIN OAuth per `sonarr-audit.md` §22) + TMDB-TV fallback + Fanart.tv.
*   Music: MusicBrainz cover-art-archive + Fanart.tv music endpoints.
*   Books: Google Books API + OpenLibrary cover.
*   Comics: ComicVine.
*   Games: IGDB.

Stored on disk alongside media files (Plex/Kodi convention) AND mirrored to MediaCover cache (`<appdata>/covers/<entityType>/<entityId>/`) for fast UI rendering.

### 10.5. NFO Writer
Kodi-compatible XML files per upstream conventions:
*   `movie.nfo` next to `Movie (Year).mkv`.
*   `tvshow.nfo` at series root + `season.nfo` at season root + `episode.nfo` per episode.
*   `artist.nfo` + `album.nfo`.

Schema reference: `sonarr-audit.md` §35.2–§35.3, `radarr-audit.md` §6.2.

### 10.6. The Restoration Pipeline
```
ArtifactArrivedEvent
  ↓
1. Probe with ffprobe → cache StreamSnapshot
  ↓
2. Track Cleaning (if enabled, stream-copy, in-place atomic rename)
  ↓
3. Re-probe → validate chapters not regressed
  ↓
4. Subtitle Acquisition (if enabled)
  ↓
5. Asset Download (poster/fanart/logo/banner)
  ↓
6. NFO Generation
  ↓
RestorationCompleteEvent → Vault
```

Each step is a job in the persistent queue (`system_jobs`). Failure of any step does NOT block the next — Restoration is best-effort. Failures surface as Health alerts but the Vault still archives the file.

---

## 11. Department: `vault`

### 11.1. Responsibility
**Only** writer of permanent state. All cross-department writes funnel through Vault. Owns DB transactions, filesystem moves, NFO writes, hardlink semantics.

### 11.2. Atomic Hardlinking
Per `ARCHITECTURE.md` §2.5 + `radarr-audit.md` §6.1:
*   Same filesystem → `link(2)` (zero-byte operation, preserves seeding).
*   Cross-filesystem → byte-copy + `fsync` + verify size + delete source. Pause torrent during copy.
*   On failure: leave source intact; transition Exhibit to `restoring` failed; raise health alert.

### 11.3. Naming Engine
Full template surface per `sonarr-audit.md` §14 + `radarr-audit.md` §20.
*   Three TV templates (`standardEpisodeFormat`, `dailyEpisodeFormat`, `animeEpisodeFormat`).
*   One movie template (`movieFileFormat` + `movieFolderFormat`).
*   Music: `albumFolderFormat` + `trackFileFormat` (artist/album/disc/track tokens).
*   Books: `bookFolderFormat` + `bookFileFormat`.
*   Comics: `comicSeriesFolderFormat` + `comicIssueFileFormat`.
*   MultiEpisodeStyle (six modes per `sonarr-audit.md` §14.3).
*   Illegal-character sanitisation, colon-replacement modes (delete | dash | spaceDash | spaceDashSpace | smart).

### 11.4. The IO Mutex
Per `ARCHITECTURE.md` §4.3:
*   Global async mutex keyed by absolute path prefix.
*   Two libraries pointing at the same physical root folder serialise their organise operations.
*   Prevents `EBUSY` on concurrent same-folder writes.

### 11.5. Edition Support
V1 already has the `film_editions` table + `default_edition_id` foreign key (`films/db.ts` migration v15). Multiple file paths per Exhibit, each with its own quality/edition_name/info_hash. UI lets user select default. V2 generalises:
*   `*_editions` table per media type that supports it (films + books).
*   `<basename> ({Edition Name}).<ext>` naming convention (e.g. `Blade Runner (1982) (Final Cut).mkv`).

### 11.6. Edition Rules Engine (Archivist Innovation)
V1's `edition_rules` table — regex pattern + output label + priority. Used by the parser to extract edition names from release titles. Default seed:
*   Director's Cut, Extended, Remastered, Unrated, Final Cut, Redux, Rogue Cut, Despecialized.

V2: expose CRUD endpoints (V1 already has these in `films/routes.ts`); UI editor in Settings.

### 11.7. Recycle Bin
Per `radarr-audit.md` §30.1:
*   On upgrade or user-deletion (with recycle option), move file → `<recycleBin>/<relativePath>` preserving structure.
*   Housekeeping job (24h cadence) purges entries older than `recycleBinCleanupDays` (default 30).
*   UI surface to manually purge or restore.

### 11.8. The Vault's Public Surface
All write operations exposed as RPC methods, not direct DB access:
*   `vault.archiveArtifact({ artifact, exhibit })`
*   `vault.upgradeArtifact({ exhibitId, newArtifact, oldArtifact })`
*   `vault.removeExhibit({ exhibitId, deleteFiles, addToBlocklist })`
*   `vault.relocateLibrary({ libraryId, newRoot, moveFiles })`

---

## 12. Department: `galleries`

### 12.1. Responsibility
The read-API + UI rendering surface. Read-heavy. **Never writes** (writes go to Vault via RPC).

### 12.2. Per-Library Views
Each library gets a typed listing endpoint that the UI consumes via Hono RPC:
*   `GET /api/v1/films?libraryId=&page=&pageSize=&sortBy=&filter=`
*   `GET /api/v1/films/:id` — detail view with editions, file info, MediaInfo, acquisition history.
*   ... same shape per media type.

### 12.3. The Command Center (Archivist Innovation)
V1's `dashboard/routes.ts` aggregates per-tab counts + system telemetry + downloads from all clients. V2 generalises:
*   `GET /api/v1/dashboard/overview` — counts + sizes across all libraries.
*   `GET /api/v1/dashboard/system` — CPU/RAM/disk via `systeminformation` package.
*   `GET /api/v1/dashboard/downloads` — unified view across built-in engine + qBittorrent + Transmission instances.
*   `GET /api/v1/dashboard/calendar?start=&end=` — aggregated calendar across films (theatrical/digital/physical) + series (episode airdates) + games (release dates) + music (album release dates) + comics (issue cover dates).

### 12.4. Omni-Search (Archivist Innovation)
V1's `home/UnifiedAddMedia.tsx` — single search bar that queries TMDB, TVDB, MusicBrainz, IGDB, ComicVine, Google Books in parallel and presents grouped results. User picks a result; dispatcher prompts which library to add to.

V2 spec:
*   `GET /api/v1/omni-search?q=<query>&type=all|films|series|music|...` returns aggregated results with provider-of-record tagged.
*   On selection: `POST /api/v1/exhibits` with `{ libraryId, providerType, providerId }` — dispatches to the appropriate `add` flow.

### 12.5. SSE Channel
`GET /api/v1/events` — keeps a long-lived `text/event-stream` connection. Backend pushes:
*   `download:progress` (every 1s while torrents active)
*   `exhibit:status-changed`
*   `job:created` / `job:updated` / `job:completed`
*   `health:alert-raised` / `health:alert-cleared`
*   `notification:fired`

Frontend wires SSE to TanStack Query `queryClient.invalidateQueries(...)` for the affected key.

### 12.6. API Authentication
*   API key (32-char hex) generated on first run, stored in `config.toml` (see §16.1).
*   Bearer token: `Authorization: Bearer <key>` OR `X-API-Key` header.
*   `timingSafeEqual` comparison.
*   `/health` and `/ping` carve-outs.
*   Anti-brute-force: 100 fails → 1h IP ban (`prowlarr-audit.md` §50).

### 12.7. Rate Limiting
*   Search endpoints: 30 req/min per IP.
*   Write endpoints: 60 req/min per IP.
*   Read endpoints: unrestricted.

### 12.8. Cinematic Detail Pages
The V1 `DetailHeader / DetailPoster / DetailMain` pattern from `ARCHITECTURE.md` §7.1 must be preserved component-for-component.

---

## 13. Department: `curator`

### 13.1. Responsibility
Orchestrate. The Curator owns:
*   The persistent job queue (`system_jobs`).
*   The scheduler (cron + per-entity scheduled-time queues).
*   The lifecycle FSM (state transitions).
*   The data integrity scanner.
*   The backup scheduler.
*   The maintenance scheduler.

### 13.2. The Job Runner
V1's `services/job-runner.ts` is sound. Preserve:
*   `system_jobs` table with `(id, type, status, subjectType, subjectId, attempts, maxAttempts, payload, lastError, availableAt, lockedAt, ...)`.
*   `claimNextJob` with row-level lock (UPDATE-WHERE-status='queued').
*   Exponential-backoff retry on failure.
*   `enqueueUniqueJob` to dedupe `(type, subjectType, subjectId)` while one is already queued.
*   `system_events` audit log (debug/info/warn/error severity, structured `data` JSON).

### 13.3. The Command Catalogue
Borrowed shape from `sonarr-audit.md` §13.9 / `radarr-audit.md` §15.2:

| Command | Default Interval | Notes |
|---|---|---|
| `RssSyncCommand` | 15 min | Per-indexer poll loop |
| `MissingSearchCommand` | 6 h | Targeted searches for monitored-and-missing |
| `CutoffUnmetSearchCommand` | daily | Quality + custom-format upgrade search |
| `RefreshExhibitCommand` | per-entity scheduled-time queue | Series: 1h/12h/24h/7d cadence per `sonarr-audit.md` §12. Films: 12h. Albums: 7d. |
| `RescanLibraryCommand` | manual + on `RootFolder` change | Walk physical files, surface unmatched |
| `BackupCommand` | weekly | Per `radarr-audit.md` §9.1 |
| `MaintenanceCommand` | 24 h | V1's `services/maintenance.ts` shape |
| `IntegrityCommand` | 12 h | V1's `services/data-integrity.ts` shape |
| `IndexerDefinitionUpdateCommand` | 24 h | Pull `Prowlarr/Indexers` repo |
| `XemUpdateCommand` | daily (anime only) | Per `sonarr-audit.md` §10.4 |
| `HousekeepingCommand` | 24 h | Prune history/jobs/imports/decisions |
| `ImportListSyncCommand` | 6 h | Trakt/IMDB/Plex Watchlist sync |
| `RenameLibraryCommand` | manual | Apply current naming format to existing files |

### 13.4. Per-Entity Refresh Cadence
Per `sonarr-audit.md` §12 — per-series scheduled-time priority queue (min-heap on `nextRefreshAt`). Same pattern applied to:
*   Series (1h / 12h / 24h / 7d per status)
*   Films (12h continuing → 7d ended)
*   Albums (7d ended → daily for upcoming)
*   Comics (daily for ongoing → weekly for ended)

### 13.5. Data Integrity Scanner
V1's `services/data-integrity.ts` shape:
*   Scans for orphaned download records, missing files referenced in DB, stale acquisitions, broken hardlinks.
*   Categorised problem catalog with severity.
*   Single + bulk repair endpoints.
*   Optional pre-repair backup (atomic safety net).
*   12 h scheduled scans; manual trigger.

### 13.6. Backup Scheduler
V1's `services/backups.ts` shape:
*   `better-sqlite3` `.backup()` method (online; no lock contention).
*   ZIP includes: `archivist.sqlite`, `config.toml`, torrent resume/state, `.env`-encoded API keys.
*   Retention policy (default 7).
*   Pre-update + pre-integrity-repair hooks fire backups synchronously.
*   Encryption: optional AES-256-GCM with user passphrase (default off; recommended on for shared backups).

### 13.7. Maintenance Scheduler
V1's `services/maintenance.ts` shape:
*   Stale running-job recovery (jobs locked >2h → reset to queued).
*   Retention-based pruning of `system_jobs`, `system_events`, `media_imports`, `acquisition_decisions`, `history`.
*   WAL checkpoint of unified DB.

---

## 14. Cross-Cutting Concerns

### 14.1. Configuration
Two-tier split (preserved from `radarr-audit.md` §13):
*   **`config.toml`** (read pre-DB) — `port, urlBase, bindAddress, apiKey, branch, logLevel, authMethod, authRequired, dbPath, telemetryEnabled`.
*   **`app_settings` table** (post-DB) — domain config: naming, media-management, host config, UI prefs, indexer-defaults, etc.

V1 used `config.xml`-style + `.env`. V2 standardises on `config.toml` (cleaner; first-class support in Bun).

### 14.2. Logging
Per `radarr-audit.md` §14:
*   Levels: `trace | debug | info | warn | error | fatal`.
*   Sinks: rolling files (`logs/archivist.txt` + 5 rotations of 1 MB each) + DB mirror (`logs.db` separate from main DB to avoid contention).
*   Runtime-changeable via `/api/v1/config/host`.
*   Categories: `acquisitions, intake, appraisal, restoration, vault, galleries, curator, indexer, parser, db, http`.

### 14.3. Health Checks
Per `sonarr-audit.md` §21 + `radarr-audit.md` §8.8 + `prowlarr-audit.md` §21, plus Archivist-specific:

*   `MediaProcessorAvailableCheck` — ffmpeg + ffprobe present.
*   `TrackCleanerLanguageCheck` — preferred language not detected in any recently-imported file (warns user the cleaner may be over-aggressive).
*   `RemoteMountCheck` — root folders accessible AND writable.
*   `HardlinkSupportCheck` — across-device test to root folder; warns if cross-device fallback is required.
*   `IntegrityIssueCheck` — rolls up Curator's last integrity scan results.
*   `EnginePortCheck` — peer port reachable from outside (port-forwarding / NAT-PMP success).

### 14.4. Notifications
Sonarr/Radarr provider matrix per `sonarr-audit.md` §22 / `radarr-audit.md` §9:
*   Email/SMTP, Discord, Slack, Telegram, Pushover, Pushbullet, Gotify, Notifiarr, Plex (library refresh), Emby, Jellyfin, Kodi, Webhook, Custom Script.
*   Triggers: `OnGrab, OnDownload, OnUpgrade, OnRename, OnExhibitAdded, OnExhibitDelete, OnArtifactDelete, OnArtifactDeleteForUpgrade, OnHealthIssue, OnHealthRestored, OnApplicationUpdate, OnManualInteractionRequired`.
*   Tag-based filtering.
*   Library-section-scoped Plex/Emby/Jellyfin refresh per `sonarr-audit.md` §23.1.

### 14.5. Import Lists
*   **Films:** Trakt/IMDB/TMDB Lists/Letterboxd/Plex Watchlist/MDBList/StevenLu.
*   **Series:** Trakt user/popular/anticipated/trending, IMDb List, Plex Watchlist, MyAnimeList, AniList.
*   **Music:** Last.fm scrobbles, Spotify playlists (with OAuth), MusicBrainz collections.
*   **Books:** Goodreads list (deprecated but works), OpenLibrary lists.
*   **Comics:** Manual only (no good list provider).
*   **Games:** Steam library, IGDB collections.

### 14.6. Import Exclusions
Per `radarr-audit.md` §10.3 — `(externalId, mediaType, title)` table; list-sync skips matched ids silently.

---

## 15. Data Model — Drizzle Schema Surface

This is the high-level shape; full column-by-column definitions live in `db/schema.ts`. References upstream audits where shapes are inherited.

### 15.1. Core Tables
```ts
// shared
libraries          { id, name, mediaType, rootFolderPath, qualityProfileId, languageProfileId, monitor (default), tags[], settings (json) }
compendiums        { id, name, description, externalIds (json: tmdb/tvdb/etc) }
tags               { id, label, color }
quality_profiles   { id, name, cutoff, items (json), upgradeAllowed, minFormatScore, cutoffFormatScore, formatItems (json: formatId→score) }
quality_definitions{ id, quality (enum), title, weight, minSize, maxSize, preferredSize }
custom_formats     { id, name, includeInRenaming, specifications (json) }
release_profiles   { id, name, enabled, required[], ignored[], indexerId (0=any), tags[] }
quality_tiers      { id, mediaType, tier (1|2|3), terms (json: string[]), priority }
edition_rules      { id, ruleName, regexPattern, outputLabel, priority, active, mediaType }
```

### 15.2. Films
```ts
films              { id, libraryId, compendiumId?, tmdbId, imdbId,
                     title, originalTitle, sortTitle, year, overview,
                     runtime, genres[], certification, studio, country, rating,
                     posterPath, backdropPath, logoPath, bannerPath,
                     cast (json), crew (json),
                     status, monitored,
                     releaseDate, digitalReleaseDate, physicalReleaseDate, acquiredAt,
                     targetTier, targetResolution, targetSource, targetCodec,
                     upgradeAllowed, currentTier, currentResolution, currentSource,
                     currentCodec, currentReleaseGroup, currentEdition, currentSizeBytes,
                     currentReleaseTitle, defaultEditionId, availableVersions (json),
                     ... }
film_editions      { id, filmId, editionName, runtime, releaseDate, overview,
                     posterPath, backdropPath, status, downloadProgress, infoHash,
                     filePath, fileSize, quality, currentTier, ..., addedAt, updatedAt }
```

### 15.3. Series → Seasons → Episodes → EpisodeFiles
Per `sonarr-audit.md` §9. The 4-level model is mandatory; V1's 3-level (no separate `EpisodeFiles`) is a defect and breaks multi-episode files.
```ts
series          { id, libraryId, compendiumId?, tvdbId, tvMazeId, tmdbId, imdbId,
                  title, sortTitle, titleSlug, cleanTitle, year, overview,
                  network, airTime, timeZone, status, seriesType, runtime,
                  certification, country, rating, genres[], language,
                  posterPath, backdropPath, logoPath, bannerPath, cast, crew,
                  monitored, monitorNewItems, seasonFolder,
                  qualityProfileId, rootFolderPath, path,
                  upgradeAllowed, targetTier, targetResolution, targetSource, targetCodec,
                  alternateTitles (json), addOptions (json), tags[], ... }
seasons         { id, seriesId, seasonNumber, title, overview, posterPath,
                  episodeCount, monitored, downloadProgress, infoHash, upgradeAllowed }
episodes        { id, seriesId, seasonId, seasonNumber, episodeNumber,
                  absoluteEpisodeNumber, sceneSeasonNumber, sceneEpisodeNumber,
                  sceneAbsoluteEpisodeNumber, title, overview, airDate, airDateUtc,
                  runtime, stillPath, episodeType, monitored,
                  episodeFileId (FK to episode_files), unverifiedSceneNumbering,
                  upgradeAllowed, currentTier, ... }
episode_files   { id, seriesId, seasonNumber, relativePath, path, size, dateAdded,
                  sceneName, releaseGroup, languages (json), quality (json),
                  customFormats (json), customFormatScore, indexerFlags,
                  mediaInfo (json), originalFilePath }
scene_mappings  { tvdbId, seasonNumber, sceneSeasonNumber, sceneOrigin, title, parseTerm, type }
alternate_titles { id, seriesId, title, sceneSeasonNumber, sceneOrigin, comment }
```

### 15.4. Music → Albums → Tracks
```ts
artists  { id, libraryId, musicbrainzId, name, sortName, overview, disambiguation,
           genres[], albumTypes[], imageUrl, backdropUrl, logoUrl, monitored,
           rootFolderPath, addedAt, updatedAt }
albums   { id, artistId, musicbrainzId, title, releaseDate, year, albumType,
           genres[], coverUrl, cdartUrl, label, trackCount, monitored, status,
           downloadProgress, infoHash, upgradeAllowed, targetTier, currentTier, ... }
tracks   { id, albumId, artistId, musicbrainzId, title, trackNumber, discNumber,
           duration, monitored, status, filePath, fileSize, quality, ... }
```

### 15.5. Books, Comics, Games, Magazines, Podcasts
*   `authors → books → book_editions` per V1's `books/db.ts`.
*   `comic_series → comic_issues` per V1's `comics/db.ts`.
*   `games` flat per V1's `games/db.ts`.
*   `magazines` (NEW IN V2) — `{ id, libraryId, publisher, title, issueNumber, year, format, coverUrl, status, ... }`.
*   `podcast_shows → podcast_episodes` (NEW IN V2) — RSS-feed-driven; episodes auto-discovered from feed; downloads from enclosure URL.

### 15.6. Indexers + Acquisitions
```ts
indexers            { id, name, implementation (Newznab|Torznab|Cardigann),
                      definitionFile?, settings (json), enable, redirect, priority,
                      seedRatio, seedTime, seasonPackSeedTime, capabilities (json),
                      animeStandardFormatSearch, vipExpiration, tags[],
                      indexerUrls[], legacyUrls[] }
indexer_status      { id, indexerId, initialFailure, mostRecentFailure,
                      escalationLevel, disabledTill, cookies (json, encrypted) }
indexer_proxies     { id, name, implementation (FlareSolverr|Http|Socks4|Socks5),
                      settings (json), tags[] }
indexer_definition_versions { id, definitionFile, version, hash, lastModified }

acquisition_decisions { id, createdAt, source, libraryId, libraryName, mediaType,
                        subjectType, subjectId, subjectTitle, releaseGuid, releaseTitle,
                        downloadUrl, indexerName, indexerPriority, sizeBytes, seeders,
                        leechers, publishDate, accepted, score, customTier, reasons[],
                        rejectionReasons[], grabbed, grabResult }
release_blocklist    { id, createdAt, infoHash, releaseGuid, downloadUrl,
                       releaseTitle, reason, libraryId, mediaType, subjectType, subjectId }
download_clients     { id, name, implementation, enable, protocol, priority,
                       removeCompletedDownloads, removeFailedDownloads, settings (json),
                       libraryId? (null = global), tags[] }
```

### 15.7. Curator + Cross-Cutting
```ts
system_jobs         { id, type, status, subjectType, subjectId, attempts,
                      maxAttempts, payload, lastError, availableAt, lockedAt,
                      createdAt, updatedAt, startedAt, finishedAt }
system_events       { id, ts, category, action, severity, subjectType, subjectId,
                      message, data (json) }
media_imports       { id, type, status, payload (json), error, createdAt, updatedAt }
history             { id, mediaType, subjectType, subjectId, eventType, date,
                      data (json) }
notifications       { id, name, implementation, settings (json), tags[],
                      onGrab, onDownload, onUpgrade, onRename, onHealthIssue, ... }
notification_status { id, notificationId, initialFailure, mostRecentFailure,
                      escalationLevel, disabledTill }
import_lists        { id, name, implementation, settings (json), enabled,
                      enableAuto, monitor, searchOnAdd, qualityProfileId,
                      rootFolderPath, tags[], libraryId }
import_list_status  { ... }
import_exclusions   { id, mediaType, externalId, title }
app_settings        { key, value (json) }
release_profiles    { ... }
```

---

## 16. The HTTP Surface — Hono RPC Routes

End-to-end-typed routes; the frontend imports the route registry's `AppType` and constructs a typed client.

### 16.1. Route Tree (selected)
```
/api/v1
├── /health                         (no auth)
├── /ping                           (no auth)
├── /events                         (SSE)
│
├── /libraries                      CRUD libraries
├── /libraries/:id/refresh          Trigger RescanLibraryCommand
├── /compendiums                    CRUD compendiums
├── /tags                           CRUD tags
│
├── /films                          List films (paginated)
├── /films/:id                      Film detail + editions + fileInfo
├── /films/lookup                   TMDB lookup
├── /films/:id/auto-grab            Trigger immediate search+grab
├── /films/:id/reject-current       Blocklist current release, revert to wanted
├── /films/:id/repair               Fix orphaned-file or path-mismatch state
├── /films/:id/metadata             Manual metadata edit (locks fields)
├── /films/:id/images               Image search (TMDB + Fanart.tv)
├── /films/edition-rules            Edition rules CRUD
│  ... (mirror endpoints for /series, /seasons, /episodes, /artists, /albums,
│       /tracks, /authors, /books, /comic-series, /comic-issues, /games)
│
├── /omni-search                    Cross-provider search
├── /search                         Search a single indexer or aggregator
│
├── /indexers                       CRUD + test + testall + schema
├── /indexer-proxies                CRUD + test
├── /indexer-stats                  Per-indexer query/grab/failure aggregates
├── /quality-profiles               CRUD
├── /custom-formats                 CRUD + schema
├── /release-profiles               CRUD
├── /root-folders                   CRUD
├── /naming-config                  Read/update naming templates
├── /media-management               Read/update media-management config
├── /track-cleaner                  Read/update + status (ffmpeg available?)
├── /subtitles                      Search + download
├── /api-keys                       Read (masked) + write (env-persisted)
│
├── /download-clients               CRUD + test + testall
├── /downloads                      Unified queue across all clients
├── /downloads/:id/action           pause | resume | remove | recheck | reannounce
│
├── /jobs                           List + create + cancel + retry
├── /events                         List system events (audit log)
├── /acquisition-decisions          List
├── /release-blocklist              List + delete
├── /media-imports                  List + queue
├── /manual-imports                 List candidates + queue
│
├── /notifications                  CRUD + test
├── /import-lists                   CRUD + test
├── /import-list-exclusions         CRUD
│
├── /system/status                  Version, branch, platform, db status
├── /system/overview                Big aggregated snapshot (jobs/events/imports/acquisitions/torrents/integrity/db)
├── /system/task                    Manually trigger a command
├── /system/backup                  List + run + download
├── /system/restart                 Graceful restart
├── /system/shutdown                Graceful shutdown
│
├── /maintenance                    Read/update config + run + lastResult
├── /backups                        Read/update config + run + list
├── /integrity                      Read/update config + run + repair (single + bulk)
│
├── /dashboard/overview             Library counts + sizes
├── /dashboard/system               CPU/RAM/disk
├── /dashboard/downloads            Cross-client torrent list
├── /dashboard/calendar             Cross-media chronological view
│
└── /config/host                    config.toml host fields
```

Each route is a Hono handler with Zod-validated request body and typed response. The frontend's `client.ts` is built via:
```ts
import { hc } from 'hono/client'
import type { AppType } from '../../server/routes'
export const client = hc<AppType>(import.meta.env.VITE_API_URL)
```

### 16.2. Tab/Library Context
V1's `x-tab-context` header pattern is **rejected** for V2. Library scope is a query param (`?libraryId=`) on read endpoints; resource-scoped routes embed the library id via the entity's foreign key (you don't ask "what library is this film in?" — the film row knows).

Cross-library aggregations (dashboard, calendar, omni-search) require no scoping.

---

## 17. The Frontend — Module Surface

### 17.1. Page Tree
```
/                       Dashboard (Command Center)
/films                  Films grid (with library tabs)
/films/:id              Film detail (cinematic header)
/films/add              Add Film (TMDB lookup)
/series                 Series grid
/series/:id             Series detail (seasons + episodes)
/series/:id/seasons/:n  Season detail
/series/add             Add Series (TVDB lookup)
/music                  Artists grid
/music/:id              Artist detail (discography)
/music/albums/:id       Album detail
/music/add              Add Artist
/books                  Authors grid
/books/:id              Author detail
/books/add              Add Author/Book
/comics                 Series grid
/comics/:id             Comic series detail
/comics/add             Add Comic Series
/games                  Games grid
/games/:id              Game detail
/games/add              Add Game
/acquisitions           Activity (queue + history + blocklist + manual imports + manual search)
/settings               Settings (Sonarr-style nested tree)
/system                 System (status, tasks, backup, updates, events, logs)
```

Settings tree:
```
/settings
├── /libraries          Library management (add/edit/delete + tabs)
├── /naming             Naming templates per media type
├── /media-management   File operations (hardlink, recycle bin, free-space guard)
├── /quality            Quality profiles + Quality definitions + Quality tiers
├── /custom-formats     Custom format CRUD
├── /release-profiles   Required/ignored/preferred words
├── /track-cleaner      Track cleaning preferences
├── /subtitles          Subtitle provider config
├── /indexers           Indexer CRUD
├── /indexer-proxies    FlareSolverr / HTTP / SOCKS proxies
├── /download-clients   Built-in engine + qBit/Transmission/SAB/NzbGet
├── /import-lists       Trakt / Plex Watchlist / etc.
├── /connect            Notifications
├── /tags               Tag management
├── /general            Bind address, port, URL base, branch, log level, auth, theme
└── /ui                 Date format, first day of week, theme accent
```

### 17.2. Design System (frozen)
*   **Typography:** Bebas Neue (display, tracking-widest section titles), JetBrains Mono (data/paths/IDs/secondary subtitles), DM Sans (body).
*   **Noir palette (backgrounds & surfaces):**
    - `noir-950: #0a0a0f` — absolute base SPA background. Applied as `<div class="fixed inset-0 bg-noir-950 -z-20">`.
    - `noir-900: #111118` — primary cards, sidebars, elevated surfaces.
    - `noir-800: #1a1a24` — secondary elevated surfaces, hover states.
    - `noir-700: #242430` — borders and dividers.
*   **Media accent palette (neon glows):** Films/System cyan `#00D4FF`, Series violet `#9B59B6`, Music pink `#FF2D78`, Books yellow `#F1C40F`, Comics orange `#E67E22`, Games emerald `#2ECC71`.
*   **Structural layout:**
    - SPA with fixed app-wide `bg-noir-950` base.
    - Sidebar: `w-16` collapsed / `w-52` expanded; fixed-position left.
    - Main content: pushes right via `ml-16` → `ml-52` (responsive `lg:` for the expanded variant).
*   **Detail page primitives — exact Tailwind values (LOCK):**
    - **`DetailHeader`** — 600px-tall hero. Backdrop image stretched full-width with `class="blur-sm opacity-40"` plus a dark bottom-to-top gradient overlay. Title + poster + core metadata sit in the bottom-left of the gradient (immersive cinematic feel).
    - **`DetailPoster`** — floating poster with heavy shadow `class="shadow-[0_0_50px_rgba(0,0,0,0.5)]"`, positioned within the hero header slightly offset.
    - **`DetailMain`** — content area below the hero. Responsive `class="grid grid-cols-1 lg:grid-cols-3 gap-6"`. Left 2/3: primary content (Storyline, Cast, Editions, Seasons). Right 1/3: technical metadata sidebar (file size, codec, path, TMDB links).
    - **`DetailMetaItem`** — standardised key/value pairs. Label: `class="text-white/20 font-mono text-[10px] uppercase tracking-widest"`. Value: accent color (`text-cyan` for films, `text-violet` for series, etc., per the Media accent palette).

### 17.3. Headless Behaviour
All interactive components built on Radix UI primitives (Dialog, Select, Combobox, Dropdown, Tooltip, Tabs, Toast). Where Radix doesn't ship (Calendar grid, virtualised lists), use React Aria primitives.

### 17.4. The Konami Easter Egg
V1's `App.tsx` listener for `↑ ↑ ↓ ↓ ← → ← → b a Enter` triggers a "you retro nerd…" modal. **Preserve verbatim.** This is identity, not feature.

### 17.5. Per-Library Tabs in Sidebar
V1's pattern (`Sidebar.tsx`) — clicking a media-type nav item shows a sub-list of that media type's libraries (Main / 4K / Kids / Documentaries / etc.) with the user's last-selected library remembered. Preserve.

### 17.6. State Management
*   **Server state:** TanStack Query.
*   **UI state (cross-tree):** Zustand store (`useUiStore`) for: active library per media type, sidebar collapsed flag, theme, current modal.
*   **Form state:** React Hook Form per form.

### 17.7. SSE-Driven Cache Invalidation
A single `useEventStream()` hook in `lib/sse.ts`:
```ts
useEffect(() => {
  const es = new EventSource('/api/v1/events')
  es.addEventListener('exhibit:status-changed', e => {
    const { mediaType, id } = JSON.parse((e as MessageEvent).data)
    queryClient.invalidateQueries(['exhibit', mediaType, id])
  })
  // ... per event type
  return () => es.close()
}, [])
```

---

## 18. Configuration & Operations

### 18.1. `config.toml` (Pre-DB)
```toml
[server]
host = "0.0.0.0"
port = 2424
url_base = ""
bind_address_ipv4 = "0.0.0.0"

[auth]
api_key = "<generated on first run>"
auth_method = "none"           # none | basic | forms
auth_required = "disabled-for-local-addresses"

[paths]
data_dir = "./data"
logs_dir = "./logs"
backups_dir = "./data/backups"

[database]
path = "./data/archivist.sqlite"
wal = true
synchronous = "normal"

[update]
branch = "main"                # main | develop | nightly
mechanism = "auto"             # auto | external | docker

[telemetry]
enabled = false                # default off

[log]
level = "info"
file_size_limit_kb = 1024
file_count = 5
```

### 18.2. The `app_settings` Table (Post-DB)
Typed key/value rows:
*   `naming` (per media type templates)
*   `mediaManagement` (hardlinks, recycle bin, free-space guard, file permissions)
*   `trackCleaner`
*   `subtitles`
*   `qualityTiers`
*   `acquisitionDefaults`
*   `flaresolverr`
*   `apiKeys` (encrypted with derived key from a per-install secret)
*   `uiPreferences` (theme, date format, locale, first day of week)
*   `systemMaintenance`
*   `systemBackups`
*   `systemIntegrity`

### 18.3. Bootstrap Order
Per `radarr-audit.md` §13.3:
1.  Load `config.toml` — bind ports, set log level.
2.  Open `archivist.sqlite` → run pending Drizzle migrations (taking pre-migration backup).
3.  Open `logs.db` → start file + DB log sinks.
4.  Initialise services (DI container or composition root).
5.  Hydrate refresh queue from per-entity cadence rules.
6.  Load Cardigann definitions from disk into in-memory cache.
7.  Initialise embedded torrent session (DHT bootstrap, port forwarding, resume files).
8.  Start scheduler + SSE hub + HTTP server.
9.  Record startup event in `system_events`.

### 18.4. Graceful Shutdown
On `SIGTERM`/`SIGINT`:
1.  Stop accepting new HTTP requests.
2.  Drain in-flight requests (max 30s).
3.  Pause job queue; wait for running jobs (max 60s); cancel still-running.
4.  Announce STOP to trackers.
5.  Flush logs.
6.  Checkpoint SQLite WAL.
7.  Close DB connections.
8.  Stop torrent session (close peer connections, persist resume files).
9.  Exit.

---

## 19. Migrations

### 19.1. From V1
**No data migration.** V2 is greenfield per `ARCHITECTURE.md` §7.3. V1's per-tab DBs are discarded; users re-add libraries and re-import existing files via the Holding Pen.

The V1 `data/films.db, films-4k.db, films-kids.db, films-documentaries.db, series.db, music.db, games.db, books.db, comics.db, shared.db` are renamed-and-archived (`data/v1-backup-<timestamp>/`) on first V2 boot, never opened.

### 19.2. Within V2
Drizzle-kit migrations under `db/migrations/`:
*   Numeric monotonic (`0001_initial.sql`, `0002_add_compendiums.sql`, …).
*   Each runs in a single transaction.
*   Pre-migration backup taken automatically.
*   Failure rolls back transaction; daemon refuses to start until manual intervention.

---

## 20. The Build Plan — Phased

### 20.1. Phase 0 — Foundation (Week 0–2)
*   Bun + Hono + Drizzle scaffolding with the 7-department package layout.
*   `config.toml` loader.
*   Drizzle schema for `libraries, tags, app_settings, system_jobs, system_events`.
*   Job runner (port V1's `services/job-runner.ts` shape).
*   Logger.
*   Health check framework.
*   `/api/v1/health` + `/api/v1/ping` + auth middleware.
*   SSE hub.
*   React + Vite + TanStack Query frontend skeleton with the Noir layout (sidebar + main content), Konami easter egg, theme palette.

### 20.2. Phase 1 — Films End-to-End (Week 3–6)
The "vertical slice" that proves the architecture. After Phase 1, the user can:
*   Add a film via TMDB lookup.
*   See it appear in the Films grid.
*   Configure indexers + a download client.
*   Trigger interactive search → see streaming results.
*   Grab a release → watch progress in the Activity page.
*   File arrives, is identified, track-cleaned, posters fetched, NFO written, archived.
*   Film transitions to `collected`; detail page shows file info, MediaInfo, acquisition history.

This phase exercises every department once. Sticky points:
*   Cardigann executor (port V1's existing `cardigann/executor.ts` from Nunjucks → hand-rolled `{{ }}` evaluator).
*   Track cleaner (port V1's `media-processor.ts` directly; minimal changes).
*   Hardlink + cross-device fallback in Vault.

### 20.3. Phase 2 — Series & Anime (Week 7–10)
*   Series → seasons → episodes → episode_files (4-level model).
*   Three search-command shapes (`Episode`, `Season`, `Series`).
*   MultiEpisodeStyle naming.
*   TBA episode handling + per-series refresh cadence.
*   XEM + AniDB anime mapping pipeline.
*   Calendar with episode-type icons + iCal feed.
*   TVDB v4 OAuth PIN flow.

### 20.4. Phase 3 — Music + Books (Week 11–12)
*   `artists → albums → tracks` with MusicBrainz + Fanart.tv music.
*   `authors → books → book_editions` with Google Books.
*   Track-aware search shaping (`q=artist album`).
*   Per-format search (book ePub vs PDF vs Audiobook).

### 20.5. Phase 4 — Comics + Games (Week 13–14)
*   `comic_series → comic_issues` with ComicVine.
*   `games` flat with IGDB (OAuth client-credentials flow).
*   CBZ/CBR file handling in Vault.
*   **Steam/GOG Sync:** Automated wishlist monitoring for games.
*   **Manga Parser:** Specialized chapter/volume extraction.

### 20.6. Phase 5 — Enterprise Pillars (Week 15–18)
*   **Migration Engine:** Legacy Sonarr/Radarr/Lidarr harvester (`migration-strategy.md`).
*   **Security & Identity:** OIDC/OAuth integration + RBAC (`identity-security-audit.md`).
*   **AI Discovery:** Vector embedding pipeline + semantic search (`museum-intelligence.md`).
*   **Mobile Remote:** PWA optimization + smart networking (`mobile-remote-spec.md`).
*   `magazines` (PDF cataloguing + cover scanning).
*   `podcast_shows + podcast_episodes` (RSS-driven).
*   Compendium UI (cross-media franchise dashboard).
*   Bazarr-style multi-provider subtitle matrix.

### 20.7. Phase 6 — Polish + Hardening (Week 19–21)
*   Notifications (full provider matrix).
*   Import lists (Trakt, Plex Watchlist, etc.).
*   Health check catalog complete.
*   Backup encryption + restore flow.
*   Data integrity scanner with all problem categories.
*   Custom format scoring (full Radarr engine).
*   Quality tier UI editor.
*   Release profile UI editor.
*   Edition rules UI editor.

### 20.8. Phase 7 — Embedded Engine Hardening (Week 21–24)
The embedded torrent engine inherited from V1 needs the parity items in `transmission-audit.md` §35 + §59:
*   BEP 42 secure node id.
*   Lazy bitfield.
*   Re-enable file-priority piece picker (currently disabled).
*   MSE handshake validation against `transmission-audit.md` §37.
*   Hashfail peer banning (3-strikes).
*   Stalled-torrent detection.
*   Free-space preflight.
*   Full RPC surface (or omit external RPC entirely if Archivist consumes the engine in-process only).

---

## 21. V1 Divergence Resolution Rules

When V1's implementation contradicts `ARCHITECTURE.md` or upstream audit specs, follow these rules:

| V1 Reality | V2 Rule |
|---|---|
| Express + better-sqlite3 + per-tab DBs | Reject. V2: Bun + Hono + unified `archivist.sqlite` with `library_id` discriminator. |
| Pure JS torrent engine in-process | Accept (V2 keeps `@torrentstack/torrent-engine`). The audit-doc-recommended Sidecar Daemon is opt-in only. |
| `x-tab-context` header for tab routing | Reject. V2: `?libraryId=` query param + foreign keys. |
| 3-level series model (no `EpisodeFiles`) | Reject. V2: 4-level per `sonarr-audit.md` §9.4. |
| Nunjucks for Cardigann templates | Reject. V2: hand-rolled `{{ }}` per `prowlarr-audit.md` §29.5. |
| Two-tier config (`config.xml` + `app_settings`) | Accept (rename to `config.toml`). |
| Quality Tier scoring (Archivist-specific) | Accept. Layer it on top of Custom Formats; tier wins as hard tiebreaker. |
| Edition Rules Engine | Accept. UI editor in V2. |
| In-memory Title Index + Subject-grouped Decision pipeline | Accept. This is V1's biggest correctness win. |
| Job runner + system_events | Accept. Port verbatim. |
| Data integrity scanner | Accept. Port verbatim. |
| Backup scheduler | Accept. Add encryption per `prowlarr-audit.md` §48. |
| Tag-context middleware | Reject. Tags are domain entities, not request context. |
| `services/media-imports.ts` validation pipeline | Accept. Pre/post probe + chapter regression detection is genuinely novel. |
| Track Cleaner default behaviour | Accept. Conservative defaults (keep original-language + preferred + commentary). |
| FlareSolverr global config | Accept; extend to per-indexer with tag-routing per `prowlarr-audit.md` §19. |
| Konami code | Accept. |
| Aspirational Sidecar Daemon (`ARCHITECTURE.md` §6) | Reject as default. Document as optional advanced setup. |
| Aspirational `compendiums` cross-media linking | Accept. Implement in Phase 5. |
| Aspirational `podcasts`, `magazines` libraries | Accept. Implement in Phase 5. |
| Aspirational SSE state-sync everywhere | Accept. Replace V1's REST polling. |

---

## 22. Things to Get Right That Are Easy to Get Wrong

A defects-checklist drawn from the upstream audits:

1.  **`EpisodeFile` 1:N to `Episodes`** — multi-episode files (`E01-E02.mkv`) are a single file row referenced by two episode rows. V1 misses this.
2.  **TVDB v4 OAuth PIN flow** — v3-style flat API key does not work. See `sonarr-audit.md` §22.
3.  **TVDB Episode Order Types** — six values (`default | official | alternate | dvd | absolute | regional`); per-series setting; affects which TVDB endpoint to fetch from. See `sonarr-audit.md` §50.
4.  **Per-series refresh cadence is dynamic** — 1h / 12h / 24h / 7d based on series state (continuing-with-airing-soon / TBA / continuing / ended). Not a global cron. See `sonarr-audit.md` §12.
5.  **Anime category 5070** — many indexers won't return anime under `5000`. Anime profiles must include 5070 explicitly. See `sonarr-audit.md` §16.2.
6.  **The Cardigann template engine's `{{ .Categories }}` emits site-specific IDs**, not Newznab IDs. See `prowlarr-audit.md` §29.4.
7.  **MSE/PE 1024-byte RC4 burn** — skipping this silently corrupts every byte. The #1 source of "MSE works against some peers and not others" bugs. See `transmission-audit.md` §37.3.
8.  **Free-space preflight before torrent-add** — must check at add-time, not late. See `transmission-audit.md` §43.
9.  **Hashfail peer ban at 3 strikes per session** — without this, malicious peers slow downloads. See `transmission-audit.md` §42.1.
10. **Torrent state machine illegal transitions** — `STOPPED → SEED` direct is illegal; must go through `CHECK_WAIT → CHECK → SEED_WAIT → SEED`. See `transmission-audit.md` §41.
11. **Watch-folder stable-size detection** — `inotify` fires `CREATE` at 0 bytes; must poll until two consecutive size reads match. See `transmission-audit.md` §52.
12. **Custom Format quality definition size envelope is a hard gate** — releases outside size bounds rejected before scoring. Easy to miss. See `radarr-audit.md` §16.1.
13. **`/ping` must be auth-bypassed and at root** (no URL base). Reverse proxies depend on it.
14. **`config.toml` API key vs in-DB API key separation** — auth must work pre-DB.
15. **Anti-brute-force on RPC** — 100 fails → 1h IP ban. Without this, exposed daemons get credential-stuffed.
16. **Atomic resume-file writes** — `write-temp + fsync + rename`. Crash mid-write corrupts state forever. See `transmission-audit.md` §19.2.
17. **The `Series.airDayOfWeek` derivation + airDateUtc timezone math** — Calendar's "Today" highlight depends on this. See `sonarr-audit.md` §39.
18. **Multi-Episode file naming styles** — six modes (`Extend | Duplicate | Repeat | Scene | Range | PrefixedRange`); user-selectable. See `sonarr-audit.md` §14.3.
19. **Track cleaner must preserve chapters and `Music Only`/`Score Only` audio tracks** — V1 already handles this but it's an easy regression.
20. **Hardlink cross-device fallback** — must pause torrent, byte-copy, fsync, verify, unlink source. Naive implementations leave dangling files.

---

## 23. Coverage Checklist

A V2 candidate is ready when it answers "yes" to all of:

### Foundation
- [ ] Bun + Hono + Drizzle stack.
- [ ] Single `archivist.sqlite` (WAL).
- [ ] Hono RPC end-to-end types.
- [ ] SSE event stream.
- [ ] `config.toml` two-tier config.
- [ ] API key + Forms + DisabledForLocalAddresses auth.
- [ ] `/ping` carve-out.
- [ ] Anti-brute-force.
- [ ] Pre-migration backup.
- [ ] Drizzle migrations.

### Departments
- [ ] All 7 departments with strict bounded contexts.
- [ ] Typed event bus with full event catalogue.
- [ ] Job runner with persistent queue + audit log.
- [ ] Per-entity refresh cadence (priority queue).
- [ ] Curator commands list + intervals + exclusivity.

### Domain Coverage
- [ ] Films + film_editions.
- [ ] Series → seasons → episodes → **episode_files** (4-level).
- [ ] Artists → albums → tracks.
- [ ] Authors → books → book_editions.
- [ ] Comic_series → comic_issues.
- [ ] Games.
- [ ] Magazines (NEW).
- [ ] Podcast_shows → podcast_episodes (NEW).
- [ ] Libraries with `library_id` discriminator.
- [ ] Compendiums (cross-media linking).
- [ ] Tags M:N to every routable entity.

### Acquisitions (Prowlarr-equivalent)
- [ ] Newznab + Torznab + Cardigann implementations.
- [ ] Cardigann YAML executor with hand-rolled `{{ }}` template engine.
- [ ] Definition repo sync (ZIP, SHA-256, atomic).
- [ ] FlareSolverr integration with session reuse.
- [ ] Per-indexer escalation backoff.
- [ ] Search aggregation with 3-pass dedup.
- [ ] In-memory Title Index.
- [ ] Subject-grouped decision pipeline.
- [ ] Missing-search scheduler.
- [ ] **Quality Tiers** scoring layer (Archivist innovation).

### Appraisal (Sonarr/Radarr-equivalent)
- [ ] Lexical parser with anime → daily → standard dispatch.
- [ ] All TV-specific specs (`EpisodeTitleSpec`, `SceneNumberingSpec`, `SeasonPackSpec`, `EpisodeTypeSpec`).
- [ ] Quality Definitions with size envelope hard gate.
- [ ] Custom Formats engine with all spec types.
- [ ] Release Profiles (legacy required/ignored/preferred).
- [ ] Acquisition Decision audit ledger.
- [ ] Release blocklist.
- [ ] Cutoff + cutoffFormatScore evaluated per-entity.

### Intake (Transmission-equivalent)
- [ ] Built-in TS torrent engine with BEP 3 + Fast Ext + Ext Proto + ut_metadata + webseeds.
- [ ] DHT (BEP 5) with BEP 42 secure node id.
- [ ] Tracker (HTTP + UDP) with tier failover.
- [ ] PEX + LPD.
- [ ] MSE/PE with 1024-byte burn.
- [ ] Hashfail peer banning.
- [ ] Stalled detection.
- [ ] Free-space preflight.
- [ ] Atomic resume-file writes.
- [ ] qBittorrent + Transmission + SAB + NzbGet adapters.
- [ ] Holding pen with stable-size detection.
- [ ] Remote path mapping.
- [ ] Wanted-progress reporting.

### Restoration
- [ ] **Track cleaner** with language + commentary + music-only handling.
- [ ] Subtitle provider (OpenSubtitles + Bazarr-style multi-provider).
- [ ] Asset acquisition (TMDB + TVDB + Fanart.tv + MusicBrainz + ComicVine + IGDB + Google Books).
- [ ] NFO writer (Kodi/Plex schemas).
- [ ] Pre/post probe validation.

### Vault
- [ ] Atomic hardlinking with cross-device fallback.
- [ ] Naming engine with all media-type templates + MultiEpisodeStyle.
- [ ] **Edition rules engine** (Archivist innovation).
- [ ] IO Mutex on shared root folders.
- [ ] Recycle bin lifecycle.
- [ ] Vault-only writes (departments call RPC).

### Galleries
- [ ] All media-type read APIs.
- [ ] **Omni-search** (Archivist innovation).
- [ ] **Command Center dashboard** (counts + system + downloads + calendar).
- [ ] Cross-media calendar with iCal feed.
- [ ] Cinematic detail pages (DetailHeader/Poster/Main primitives).
- [ ] SSE-driven cache invalidation.

### Curator
- [ ] All commands in catalogue with intervals + exclusivity.
- [ ] Per-entity refresh cadence priority queue.
- [ ] Data integrity scanner with bulk repair.
- [ ] Backup scheduler with encryption.
- [ ] Maintenance scheduler.

### Frontend
- [ ] Full sidebar with library tabs per media type.
- [ ] All media-type pages (films, series, music, books, comics, games + magazines + podcasts).
- [ ] Settings nested tree.
- [ ] Cinematic detail pages on all media types.
- [ ] SSE event stream wiring.
- [ ] Konami easter egg.
- [ ] Theme palette frozen per `ARCHITECTURE.md` §7.1.

### Cross-Cutting
- [ ] Notifications full provider matrix.
- [ ] Import lists for every media type.
- [ ] Import exclusions.
- [ ] Health check catalogue.
- [ ] Logging with all levels + categories + rotation.
- [ ] Telemetry consent (off by default).
- [ ] Backup-before-update.
- [ ] Graceful shutdown sequence.
- [ ] All upstream-mandated APIs preserved (`/api/v1/health`, `/ping`, etc.).

---

## 24. Non-Goals (Explicitly Out of Scope)

To prevent scope creep, V2 deliberately does **not** include:

*   **Subtitle authoring/editing** (use Aegisub).
*   **Live transcoding for streaming** (use Plex/Jellyfin).
*   **Mobile native apps** (PWA wrap of the web UI is sufficient).
*   **Multi-user authentication beyond a single API key** (use a reverse-proxy auth layer for OIDC/SSO).
*   **A Prowlarr push API for external apps** (Archivist is monolithic; no external `*arr` integration target).
*   **Payment integration** (no subscription checkout).
*   **Public sharing or seeding-as-a-service** (private use only).
*   **Any blockchain anything.**

---

## 25. Final Caveats

### 25.1. The Embedded Torrent Engine Is the Riskiest Component
A pure-TS BitTorrent client is ~5–10 KLOC of subtle protocol code. V1's `@torrentstack/*` packages give a head start but `transmission-audit.md` §35 + §59 lists 100+ parity items, and at least 30% are not yet implemented. Plan accordingly: the engine may need 2–3 months of focused hardening before it's production-trustworthy on private trackers.

### 25.2. The Cardigann Engine Is the Second-Riskiest Component
Per `prowlarr-audit.md` §50.1 — community definitions break constantly. Mirror the upstream `Prowlarr/Indexers` repo verbatim; do not fork. Allocate 4–6 weeks for the executor itself.

### 25.3. The Track Cleaner Is the Killer Feature
V1's `media-processor.ts` is genuinely better than every Sonarr/Radarr stack. Storage savings of 30–60% on multi-language 4K REMUX library are achievable. Promote prominently in the UI; this is what users will love.

### 25.4. The Quality Tier System Is the Differentiator
V1's hand-curated release-group tier lists (Tier 1: QxR/Tigole; Tier 2: UTR/Joy; Tier 3: YIFY/PSA) are not in any upstream tool. Trash Guides users will recognise the philosophy but appreciate the explicit hand-curation. Keep this as a hard tiebreaker over Custom Format scores.

### 25.5. Greenfield Means Greenfield
Resist the temptation to write a V1→V2 migrator. The data shape is different enough that a migrator costs more engineering than re-importing files via the Holding Pen, and any migrator carries V1's accumulated bugs forward. Users keep their **media files**; they restart their **library state**.

### 25.6. The Cinematic UI Is Identity, Not Decoration
The Noir aesthetic is what makes Archivist visually distinctive. Do not let it drift toward generic Sonarr-clone styling. Every detail page must feel cinematic; every accent colour must be the prescribed hex. The Konami code stays.

### 25.7. The Museum Metaphor Pays Off in Onboarding
Every stakeholder who reads "Acquisitions sources Leads, Intake transports Artifacts to the Loading Dock, Appraisal verifies them, Restoration cleans them, the Vault preserves them, the Galleries display them, and the Curator orchestrates the whole museum" — gets it instantly. The metaphor is a serious onboarding asset, not whimsy. Use it in error messages, log lines, and command names.

---

## 26. Companion Documents

This bible references and supersedes:
*   ~~`ARCHITECTURE.md`~~ — **DEPRECATED.** All content folded into this document. Safe to delete.
*   `radarr-audit.md` — film-side feature catalogue; Custom Formats engine.
*   `sonarr-audit.md` — TV-side feature catalogue; series/season/episode/file model.
*   `prowlarr-audit.md` — indexer engine; Cardigann YAML; FlareSolverr.
*   `transmission-audit.md` — embedded torrent engine; BEP protocols.
*   `unified-audit.md` — operational concerns (logging, errors, security, deployment, testing) + cross-document conflict resolution.

Where any of these documents conflict with `archivist-audit.md` (this file), **this document wins for V2 build decisions** — except `unified-audit.md`, which wins over this document where they conflict (it is the more recent pass).

---

# Part II: Concrete Implementation Surface

> **Re-implementer's Note:** Sections 1–26 are the strategic spec. Sections 27 onwards capture the *blank-slate* concrete detail — exact endpoint signatures, exact request/response shapes, exact algorithm pseudocode, exact database column lists, exact UI layouts, exact env-var catalogues, exact external-API contracts, exact validation rules. Any V2 implementer with *no* access to V1's source code should be able to recreate the app from §27 onwards alone.

---

## 27. The Complete Database Schema (Drizzle)

Every column of every table. Field naming follows snake_case in DB, camelCase in TypeScript types.

### 27.1. Core / Cross-Cutting Tables

```sql
CREATE TABLE libraries (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  media_type          TEXT NOT NULL,                      -- 'films' | 'series' | 'music' | 'books' | 'comics' | 'games' | 'magazines' | 'podcasts'
  root_folder_path    TEXT NOT NULL,
  quality_profile_id  INTEGER REFERENCES quality_profiles(id),
  tags                TEXT NOT NULL DEFAULT '[]',         -- JSON int[]
  settings            TEXT NOT NULL DEFAULT '{}',         -- JSON {accentColor?, defaultMonitor?, ...}
  display_order       INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_libraries_media_type ON libraries(media_type);

CREATE TABLE compendiums (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT,
  external_ids TEXT NOT NULL DEFAULT '{}',                -- {"tmdbCollection": 123, "tvdbId": 456}
  cover_url    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  color TEXT                                              -- hex string for UI
);

CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                                     -- JSON
);
```

### 27.2. Quality / Custom Format Tables

```sql
CREATE TABLE quality_definitions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  quality         TEXT NOT NULL UNIQUE,                   -- 'WEBDL-1080p', 'Bluray-2160p-Remux', ...
  title           TEXT NOT NULL,
  weight          INTEGER NOT NULL,
  min_size_mb_per_min INTEGER,                            -- gating
  max_size_mb_per_min INTEGER,
  preferred_size_mb_per_min INTEGER
);

CREATE TABLE quality_profiles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  upgrade_allowed   INTEGER NOT NULL DEFAULT 1,
  cutoff            TEXT NOT NULL,                        -- a quality_definitions.quality
  min_format_score  INTEGER NOT NULL DEFAULT 0,
  cutoff_format_score INTEGER NOT NULL DEFAULT 0,
  items             TEXT NOT NULL DEFAULT '[]',           -- JSON: ordered list of {qualityOrGroup, allowed}
  format_items      TEXT NOT NULL DEFAULT '[]',           -- JSON: [{formatId, score}]
  language_id       INTEGER,                              -- legacy languages
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE custom_formats (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  name                        TEXT NOT NULL UNIQUE,
  include_in_renaming         INTEGER NOT NULL DEFAULT 0,
  specifications              TEXT NOT NULL DEFAULT '[]', -- JSON [{implementation, name, negate, required, fields}]
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE release_profiles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  required    TEXT NOT NULL DEFAULT '[]',                 -- JSON string[]
  ignored     TEXT NOT NULL DEFAULT '[]',
  preferred   TEXT NOT NULL DEFAULT '[]',                 -- [{term, score}]
  indexer_id  INTEGER NOT NULL DEFAULT 0,                 -- 0 = any
  tags        TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE quality_tiers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type  TEXT NOT NULL,                              -- 'films' | 'series' | ...
  tier        INTEGER NOT NULL,                           -- 1, 2, 3
  term        TEXT NOT NULL,                              -- 'QxR', 'Tigole', 'YIFY'
  priority    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(media_type, tier, term)
);
```

**Default Quality Profiles seeded on first boot:**
- `Any` — cutoff `Unknown`, all qualities allowed.
- `HD - 720p` — cutoff `WEB-DL-720p`, items `[HDTV-720p, WEB-DL-720p, Bluray-720p]`.
- `HD - 1080p` — cutoff `WEB-DL-1080p`, items `[HDTV-1080p, WEBRip-1080p, WEB-DL-1080p, Bluray-1080p]`.
- `4K` — cutoff `WEB-DL-2160p`, items `[WEB-DL-2160p, Bluray-2160p, Bluray-2160p-Remux]`.
- `Lossless` — cutoff `Bluray-1080p-Remux`, items `[Bluray-1080p-Remux, Bluray-2160p-Remux]`.

**Default Quality Tiers seeded** (per-media-type from `services/quality-tiers.ts`):

*Films Tier 1:* `QxR, Tigole, Bandi, Ghost, Kappa, SAMPA, Silence, t3nzin, YOGI, TAoE, Ainz, ANONAZ, xtrem3x, afm72, FreetheFish, Garshasp, Ime, Langbard, LION, Panda, MONOLITH, Natty, r00t, RCVR, RZeroX, AJJMIN, ArcX, bccornfo, DNU, DrainedDay, DUHIT, Erie, Frys, Goki, HxD, jb2049, JBENT, Nostradamus, r0b0t, Species180, TheSickle, WEM, POIASD, SARTRE`

*Films Tier 2:* `R1GY3B, Ralphy, TimeDistortion, SQS, Chivaman, Vyndros, Prof, HeVK, UTR, Joy, Q22, ImE, Qman, Q18, theincognito, Korach, D0ct0rLew, SM737`

*Films Tier 3:* `iVy, KONTRAST, PHOCiS, YAWNiX, edge2020, YIFY, PSA, MeGusta`

*Series Tier 1:* `BluRay, BDRip, REMUX`
*Series Tier 2:* `WEB-DL, WEBRip, 1080p`
*Series Tier 3:* `720p, HDTV`

### 27.3. Indexer Tables

```sql
CREATE TABLE indexers (
  id                       TEXT PRIMARY KEY,              -- UUID
  name                     TEXT NOT NULL,
  type                     TEXT NOT NULL DEFAULT 'torrent', -- 'torrent' | 'usenet'
  protocol                 TEXT NOT NULL DEFAULT 'cardigann', -- 'newznab' | 'torznab' | 'cardigann'
  definition_id            TEXT,                           -- references definition file id (cardigann only)
  enabled                  INTEGER NOT NULL DEFAULT 1,
  priority                 INTEGER NOT NULL DEFAULT 25,    -- 1-50
  redirect                 INTEGER NOT NULL DEFAULT 0,
  base_url                 TEXT NOT NULL DEFAULT '',
  api_path                 TEXT NOT NULL DEFAULT '/api',
  api_key                  TEXT,
  username                 TEXT,
  password                 TEXT,                           -- ENCRYPTED at rest in V2
  download_link_type       TEXT NOT NULL DEFAULT 'torrent', -- 'torrent' | 'magnet'
  minimum_seeders          INTEGER NOT NULL DEFAULT 0,
  seed_ratio               REAL,
  seed_time                INTEGER,                         -- minutes
  season_pack_seed_time    INTEGER,
  sync_profile_id          TEXT,
  tags                     TEXT NOT NULL DEFAULT '[]',
  vip_expiration           TEXT,                            -- ISO date
  additional_parameters    TEXT NOT NULL DEFAULT '',
  settings                 TEXT NOT NULL DEFAULT '{}',     -- per-indexer JSON (cookieHeader, mediaTypes, ...)
  status                   TEXT NOT NULL DEFAULT '{}',     -- {mostRecentFailure, disabledTill, initialFailure, failureCount}
  last_tested_at           INTEGER,                         -- unix ms
  capabilities             TEXT NOT NULL DEFAULT '{}',
  created_at               INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at               INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE indexer_definition_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_file TEXT NOT NULL UNIQUE,
  version         INTEGER NOT NULL,                         -- schema version (9, 10, 11)
  hash            TEXT NOT NULL,                            -- SHA-256 of definition file
  last_modified   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE indexer_proxies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  implementation TEXT NOT NULL,                              -- 'FlareSolverr' | 'Http' | 'Socks4' | 'Socks5'
  settings     TEXT NOT NULL DEFAULT '{}',
  tags         TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE indexer_release_state (
  indexer_id          TEXT NOT NULL,                          -- FK to indexers.id
  highest_pub_date    INTEGER NOT NULL DEFAULT 0,             -- watermark
  recent_guids        TEXT NOT NULL DEFAULT '[]',             -- JSON string[] (cap 500)
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  health              TEXT NOT NULL DEFAULT 'unknown',         -- 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  last_polled_at      INTEGER,
  last_success_at     INTEGER,
  last_failure_at     INTEGER,
  last_failure_msg    TEXT,
  PRIMARY KEY (indexer_id)
);
```

### 27.4. Films Tables

```sql
CREATE TABLE films (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id               INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  compendium_id            INTEGER REFERENCES compendiums(id),
  tmdb_id                  INTEGER UNIQUE,
  imdb_id                  TEXT,
  title                    TEXT NOT NULL,
  original_title           TEXT,
  sort_title               TEXT,                              -- title with leading 'The|A|An' stripped, lowercased
  year                     INTEGER,
  overview                 TEXT,
  runtime                  INTEGER,                            -- minutes
  genres                   TEXT NOT NULL DEFAULT '[]',
  poster_path              TEXT,
  backdrop_path            TEXT,
  logo_path                TEXT,
  banner_path              TEXT,
  cast                     TEXT,                               -- JSON [{id, name, character, profilePath}]
  crew                     TEXT,                               -- JSON [{id, name, job, profilePath}]
  country                  TEXT,                               -- ISO 3166-1 alpha-2
  rating                   REAL,
  certification            TEXT,                               -- 'PG-13' etc.
  studio                   TEXT,
  status                   TEXT NOT NULL DEFAULT 'wanted',     -- 'wanted' | 'acquiring' | 'collected' | 'missing' | 'ignored' | 'rejected' | 'upcoming'
  monitored                INTEGER NOT NULL DEFAULT 1,
  quality_profile_id       INTEGER,
  root_folder_path         TEXT,
  file_path                TEXT,
  file_size                INTEGER,
  quality                  TEXT,
  release_date             TEXT,                               -- theatrical, ISO YYYY-MM-DD
  digital_release_date     TEXT,
  physical_release_date    TEXT,
  acquired_at              TEXT,
  download_progress        REAL DEFAULT 0,                     -- 0..1
  info_hash                TEXT,
  download_tier            INTEGER,                             -- 1..3 of last grab
  available_versions       TEXT,                                -- JSON string[]: extracted from TMDB notes
  expected_version         TEXT,
  upgrade_allowed          INTEGER NOT NULL DEFAULT 1,
  target_tier              TEXT,                                -- 'Tier 1' | 'Tier 2' | 'Tier 3' | 'Any'
  target_resolution        TEXT,                                -- '2160p' | '1080p' | '720p' | 'Any'
  target_source            TEXT,                                -- 'BluRay' | 'WEB' | 'Any'
  target_codec             TEXT,                                -- 'x265' | 'x264' | 'AV1' | 'Any'
  current_tier             INTEGER NOT NULL DEFAULT 0,
  current_resolution       TEXT,
  current_source           TEXT,
  current_codec            TEXT,
  current_release_group    TEXT,
  current_edition          TEXT,
  current_size_bytes       INTEGER,
  current_release_title    TEXT,
  default_edition_id       INTEGER REFERENCES film_editions(id) ON DELETE SET NULL,
  added_at                 TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_films_status ON films(status);
CREATE INDEX idx_films_sort ON films(sort_title);
CREATE INDEX idx_films_library ON films(library_id);

CREATE TABLE film_editions (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id                   INTEGER NOT NULL REFERENCES films(id) ON DELETE CASCADE,
  edition_name              TEXT NOT NULL,                       -- 'Theatrical' | "Director's Cut" | ...
  runtime                   INTEGER,
  release_date              TEXT,
  overview                  TEXT,
  poster_path               TEXT,
  backdrop_path             TEXT,
  status                    TEXT NOT NULL DEFAULT 'wanted',
  download_progress         REAL DEFAULT 0,
  info_hash                 TEXT,
  file_path                 TEXT,
  file_size                 INTEGER,
  quality                   TEXT,
  current_tier              INTEGER NOT NULL DEFAULT 0,
  current_resolution        TEXT,
  current_source            TEXT,
  current_codec             TEXT,
  current_release_group     TEXT,
  current_edition           TEXT,
  current_size_bytes        INTEGER,
  current_release_title     TEXT,
  added_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_film_editions_film_id ON film_editions(film_id);

CREATE TABLE edition_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_name       TEXT NOT NULL,
  regex_pattern   TEXT NOT NULL,                                  -- e.g. "(?i)(director'?s\\s*cut)"
  output_label    TEXT NOT NULL,                                  -- e.g. "Director's Cut"
  priority        INTEGER NOT NULL DEFAULT 0,                     -- higher wins
  active          INTEGER NOT NULL DEFAULT 1,
  media_type      TEXT NOT NULL DEFAULT 'films'
);

-- Default edition rules seeded on first boot:
-- "Director's Cut" / "(?i)(director'?s\\s*cut)" / 10
-- "Extended Edition" / "(?i)(extended)" / 10
-- "Remastered" / "(?i)(remastered)" / 5
-- "Unrated" / "(?i)(unrated)" / 10
-- "Final Cut" / "(?i)(final\\s*cut)" / 10
-- "Redux" / "(?i)(redux)" / 10
-- "Rogue Cut" / "(?i)(rogue\\s*cut)" / 10
-- "Despecialized" / "(?i)(despecialized)" / 20
```

### 27.5. Series → Seasons → Episodes → EpisodeFiles

```sql
CREATE TABLE series (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id        INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  compendium_id     INTEGER REFERENCES compendiums(id),
  tvdb_id           INTEGER UNIQUE,
  tmdb_id           INTEGER,
  tv_maze_id        INTEGER,
  imdb_id           TEXT,
  title             TEXT NOT NULL,
  sort_title        TEXT,
  title_slug        TEXT NOT NULL UNIQUE,                          -- 'breaking-bad-2008'
  clean_title       TEXT,                                           -- alphanumeric-only normalisation
  year              INTEGER,
  overview          TEXT,
  network           TEXT,
  air_time          TEXT,                                           -- 'HH:MM' local-to-network
  air_day           TEXT,                                           -- 'monday' .. 'sunday' (derived)
  time_zone         TEXT NOT NULL DEFAULT 'UTC',                    -- IANA
  status            TEXT NOT NULL DEFAULT 'continuing',             -- 'continuing' | 'ended' | 'upcoming' | 'deleted'
  series_type       TEXT NOT NULL DEFAULT 'standard',               -- 'standard' | 'daily' | 'anime'
  series_episode_order TEXT NOT NULL DEFAULT 'default',             -- 'default'|'official'|'alternate'|'dvd'|'absolute'|'regional'
  use_scene_numbering INTEGER NOT NULL DEFAULT 0,
  monitor_new_items TEXT NOT NULL DEFAULT 'all',                    -- 'all' | 'none'
  season_folder     INTEGER NOT NULL DEFAULT 1,
  runtime           INTEGER,
  certification     TEXT,
  country           TEXT,
  rating            REAL,
  language          TEXT NOT NULL DEFAULT 'en',
  original_language TEXT,
  genres            TEXT NOT NULL DEFAULT '[]',
  poster_path       TEXT,
  backdrop_path     TEXT,
  logo_path         TEXT,
  banner_path       TEXT,
  cast              TEXT,
  crew              TEXT,
  alternate_titles  TEXT NOT NULL DEFAULT '[]',                     -- JSON
  add_options       TEXT NOT NULL DEFAULT '{}',                     -- {searchForMissingEpisodes, monitor}
  monitored         INTEGER NOT NULL DEFAULT 1,
  quality_profile_id INTEGER,
  root_folder_path  TEXT,
  path              TEXT,
  upgrade_allowed   INTEGER NOT NULL DEFAULT 1,
  target_tier       TEXT,
  target_resolution TEXT,
  target_source     TEXT,
  target_codec      TEXT,
  next_refresh_at   INTEGER,                                        -- unix ms — used by per-series refresh queue
  last_info_sync    INTEGER,
  added_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE seasons (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id         INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season_number     INTEGER NOT NULL,
  title             TEXT,
  overview          TEXT,
  poster_path       TEXT,
  episode_count     INTEGER NOT NULL DEFAULT 0,
  monitored         INTEGER NOT NULL DEFAULT 1,
  upgrade_allowed   INTEGER NOT NULL DEFAULT 1,
  download_progress REAL DEFAULT 0,
  info_hash         TEXT,                                           -- season-pack acquiring
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(series_id, season_number)
);

CREATE TABLE episodes (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id                     INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season_id                     INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  season_number                 INTEGER NOT NULL,
  episode_number                INTEGER NOT NULL,
  absolute_episode_number       INTEGER,
  scene_season_number           INTEGER,
  scene_episode_number          INTEGER,
  scene_absolute_episode_number INTEGER,
  unverified_scene_numbering    INTEGER NOT NULL DEFAULT 0,
  tvdb_episode_id               INTEGER,
  title                         TEXT,
  overview                      TEXT,
  air_date                      TEXT,                                 -- 'YYYY-MM-DD' local-to-network
  air_date_utc                  INTEGER,                              -- unix ms (precomputed)
  runtime                       INTEGER,
  still_path                    TEXT,
  episode_type                  TEXT NOT NULL DEFAULT 'standard',     -- 'standard' | 'seasonPremiere' | 'midSeasonFinale' | 'seasonFinale' | 'seriesFinale' | 'midSeasonPremiere'
  monitored                     INTEGER NOT NULL DEFAULT 1,
  episode_file_id               INTEGER REFERENCES episode_files(id) ON DELETE SET NULL,
  upgrade_allowed               INTEGER NOT NULL DEFAULT 1,
  current_tier                  INTEGER NOT NULL DEFAULT 0,
  current_resolution            TEXT,
  current_source                TEXT,
  current_codec                 TEXT,
  current_release_group         TEXT,
  current_edition               TEXT,
  current_size_bytes            INTEGER,
  current_release_title         TEXT,
  last_search_time              INTEGER,                              -- per-episode targeted search dedup
  added_at                      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(series_id, season_number, episode_number)
);
CREATE INDEX idx_episodes_series ON episodes(series_id);
CREATE INDEX idx_episodes_air_date_utc ON episodes(air_date_utc);

CREATE TABLE episode_files (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id           INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season_number       INTEGER NOT NULL,
  relative_path       TEXT NOT NULL,
  path                TEXT NOT NULL,
  size                INTEGER NOT NULL,
  date_added          TEXT NOT NULL DEFAULT (datetime('now')),
  scene_name          TEXT,
  release_group       TEXT,
  languages           TEXT NOT NULL DEFAULT '[]',
  quality             TEXT NOT NULL DEFAULT '{}',                     -- {quality, revision: {version, real, isRepack}}
  custom_formats      TEXT NOT NULL DEFAULT '[]',
  custom_format_score INTEGER NOT NULL DEFAULT 0,
  indexer_flags       TEXT NOT NULL DEFAULT '[]',
  media_info          TEXT NOT NULL DEFAULT '{}',
  original_file_path  TEXT,
  subtitles           TEXT NOT NULL DEFAULT '[]'                      -- external subtitle paths
);

CREATE TABLE alternate_titles (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id           INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  scene_season_number INTEGER,
  scene_origin        TEXT,
  comment             TEXT
);

CREATE TABLE scene_mappings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tvdb_id             INTEGER NOT NULL,
  season_number       INTEGER,
  scene_season_number INTEGER,
  scene_origin        TEXT,
  title               TEXT,
  parse_term          TEXT,
  type                TEXT
);
```

### 27.6. Music, Books, Comics, Games, Magazines, Podcasts

```sql
-- Music
CREATE TABLE artists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  musicbrainz_id TEXT UNIQUE,
  name TEXT NOT NULL,
  sort_name TEXT,
  overview TEXT,
  disambiguation TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  album_types TEXT NOT NULL DEFAULT '[]',          -- ['Album', 'EP', 'Single', 'Live', ...]
  image_url TEXT,
  backdrop_url TEXT,
  logo_url TEXT,
  monitored INTEGER NOT NULL DEFAULT 1,
  root_folder_path TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  musicbrainz_id TEXT,
  title TEXT NOT NULL,
  release_date TEXT,
  year INTEGER,
  album_type TEXT DEFAULT 'Album',
  genres TEXT NOT NULL DEFAULT '[]',
  cover_url TEXT,
  cdart_url TEXT,
  label TEXT,
  track_count INTEGER DEFAULT 0,
  monitored INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'missing',
  download_progress REAL DEFAULT 0,
  info_hash TEXT,
  upgrade_allowed INTEGER NOT NULL DEFAULT 1,
  target_tier TEXT,
  current_tier INTEGER NOT NULL DEFAULT 0,
  current_resolution TEXT, current_source TEXT, current_codec TEXT,
  current_release_group TEXT, current_edition TEXT,
  current_size_bytes INTEGER, current_release_title TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  musicbrainz_id TEXT,
  title TEXT NOT NULL,
  track_number INTEGER,
  disc_number INTEGER DEFAULT 1,
  duration INTEGER,                                  -- ms
  monitored INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'missing',
  file_path TEXT,
  file_size INTEGER,
  quality TEXT,
  download_progress REAL DEFAULT 0,
  info_hash TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Books
CREATE TABLE authors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  google_books_id TEXT,
  open_library_id TEXT,
  name TEXT NOT NULL,
  sort_name TEXT,
  overview TEXT,
  image_url TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  monitored INTEGER NOT NULL DEFAULT 1,
  root_folder_path TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  google_books_id TEXT,
  isbn_13 TEXT,
  title TEXT NOT NULL,
  subtitle TEXT,
  series_name TEXT,                                  -- "Stormlight Archive"
  series_position REAL,                              -- 1.5 for novellas
  published_date TEXT,
  year INTEGER,
  publisher TEXT,
  page_count INTEGER,
  overview TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  cover_url TEXT,
  language TEXT DEFAULT 'en',
  monitored INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'missing',
  download_progress REAL DEFAULT 0,
  info_hash TEXT,
  upgrade_allowed INTEGER NOT NULL DEFAULT 1,
  target_tier TEXT,
  current_tier INTEGER NOT NULL DEFAULT 0,
  current_resolution TEXT, current_source TEXT, current_codec TEXT,
  current_release_group TEXT, current_edition TEXT,
  current_size_bytes INTEGER, current_release_title TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE book_editions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  format TEXT NOT NULL,                              -- 'epub' | 'pdf' | 'mobi' | 'azw3' | 'cbz' | 'cbr' | 'audiobook'
  narrator TEXT,                                     -- audiobook only
  duration_minutes INTEGER,                          -- audiobook only
  file_path TEXT,
  file_size INTEGER,
  status TEXT NOT NULL DEFAULT 'missing',
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Comics
CREATE TABLE comic_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  comicvine_id INTEGER UNIQUE,
  title TEXT NOT NULL,
  sort_title TEXT,
  start_year INTEGER,
  publisher TEXT,
  overview TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  image_url TEXT,
  issue_count INTEGER DEFAULT 0,
  series_type TEXT DEFAULT 'ongoing',                -- 'ongoing' | 'limited' | 'one-shot'
  status TEXT DEFAULT 'continuing',
  monitored INTEGER NOT NULL DEFAULT 1,
  root_folder_path TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE comic_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL REFERENCES comic_series(id) ON DELETE CASCADE,
  comicvine_id INTEGER,
  issue_number TEXT NOT NULL,                        -- string because of '4.5', 'Annual 1' etc.
  title TEXT,
  cover_date TEXT,
  year INTEGER,
  overview TEXT,
  image_url TEXT,
  monitored INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'missing',
  file_path TEXT,
  file_size INTEGER,
  format TEXT DEFAULT 'cbz',
  download_progress REAL DEFAULT 0,
  info_hash TEXT,
  upgrade_allowed INTEGER NOT NULL DEFAULT 1,
  current_tier INTEGER NOT NULL DEFAULT 0,
  current_resolution TEXT, current_source TEXT, current_codec TEXT,
  current_release_group TEXT, current_edition TEXT,
  current_size_bytes INTEGER, current_release_title TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(series_id, issue_number)
);

-- Games
CREATE TABLE games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  igdb_id INTEGER UNIQUE,
  title TEXT NOT NULL,
  sort_title TEXT,
  year INTEGER,
  release_date TEXT,
  overview TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  platforms TEXT NOT NULL DEFAULT '[]',              -- ['PC', 'PS5', 'Switch']
  cover_url TEXT,
  screenshot_url TEXT,
  rating REAL,
  developer TEXT,
  publisher TEXT,
  status TEXT NOT NULL DEFAULT 'wanted',
  monitored INTEGER NOT NULL DEFAULT 1,
  root_folder_path TEXT,
  file_path TEXT,
  file_size INTEGER,
  download_progress REAL DEFAULT 0,
  info_hash TEXT,
  upgrade_allowed INTEGER NOT NULL DEFAULT 1,
  target_tier TEXT,
  current_tier INTEGER NOT NULL DEFAULT 0,
  current_resolution TEXT, current_source TEXT, current_codec TEXT,
  current_release_group TEXT, current_edition TEXT,
  current_size_bytes INTEGER, current_release_title TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Magazines (NEW)
CREATE TABLE magazines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  publisher TEXT,
  title TEXT NOT NULL,
  issue_number TEXT,
  issue_date TEXT,
  year INTEGER,
  format TEXT DEFAULT 'pdf',
  cover_url TEXT,
  status TEXT NOT NULL DEFAULT 'wanted',
  monitored INTEGER NOT NULL DEFAULT 1,
  root_folder_path TEXT,
  file_path TEXT,
  file_size INTEGER,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Podcasts (NEW)
CREATE TABLE podcast_shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  feed_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  artwork_url TEXT,
  author TEXT,
  language TEXT,
  monitored INTEGER NOT NULL DEFAULT 1,
  last_fetched_at INTEGER,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE podcast_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL REFERENCES podcast_shows(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,                                -- from RSS
  title TEXT NOT NULL,
  description TEXT,
  pub_date INTEGER,                                  -- unix ms
  duration_seconds INTEGER,
  enclosure_url TEXT NOT NULL,
  enclosure_type TEXT,                               -- 'audio/mpeg' etc.
  enclosure_size INTEGER,
  status TEXT NOT NULL DEFAULT 'wanted',
  file_path TEXT,
  file_size INTEGER,
  download_progress REAL DEFAULT 0,
  info_hash TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(show_id, guid)
);
```

### 27.7. Acquisitions / Curator / System Tables

```sql
CREATE TABLE acquisition_decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  source          TEXT NOT NULL,                            -- 'rss' | 'manual' | 'auto-grab'
  library_id      INTEGER,
  library_name    TEXT,
  media_type      TEXT NOT NULL,
  subject_type    TEXT NOT NULL,                            -- 'film' | 'episode' | 'season' | 'album' | ...
  subject_id      TEXT,
  subject_title   TEXT NOT NULL,
  release_guid    TEXT,
  release_title   TEXT NOT NULL,
  download_url    TEXT NOT NULL,
  indexer_name    TEXT,
  indexer_priority INTEGER,
  size_bytes      INTEGER,
  seeders         INTEGER,
  leechers        INTEGER,
  publish_date    TEXT,
  accepted        INTEGER NOT NULL,                          -- 0/1
  score           INTEGER NOT NULL,
  custom_tier     INTEGER NOT NULL,                          -- 0..3
  reasons         TEXT NOT NULL,                              -- JSON string[]
  rejection_reasons TEXT NOT NULL,                            -- JSON string[]
  grabbed         INTEGER NOT NULL DEFAULT 0,
  grab_result     TEXT
);
CREATE INDEX idx_acquisition_decisions_subject ON acquisition_decisions(media_type, subject_type, subject_id, created_at DESC);
CREATE INDEX idx_acquisition_decisions_release ON acquisition_decisions(release_guid, release_title);

CREATE TABLE release_blocklist (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  info_hash     TEXT,
  release_guid  TEXT,
  download_url  TEXT,
  release_title TEXT NOT NULL,
  reason        TEXT NOT NULL,
  library_id    INTEGER,
  media_type    TEXT,
  subject_type  TEXT,
  subject_id    TEXT
);
CREATE INDEX idx_blocklist_hash ON release_blocklist(info_hash);
CREATE INDEX idx_blocklist_guid ON release_blocklist(release_guid);

CREATE TABLE system_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',              -- 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  subject_type  TEXT,
  subject_id    TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  payload       TEXT NOT NULL DEFAULT '{}',
  last_error    TEXT,
  available_at  TEXT NOT NULL DEFAULT (datetime('now')),
  locked_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX idx_system_jobs_status ON system_jobs(status, created_at);
CREATE INDEX idx_system_jobs_subject ON system_jobs(subject_type, subject_id);

CREATE TABLE system_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  category     TEXT NOT NULL,                                -- 'system'|'rss'|'job'|'torrent'|'download'|'import'|...
  action       TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info',                 -- 'debug'|'info'|'warn'|'error'
  subject_type TEXT,
  subject_id   TEXT,
  message      TEXT NOT NULL,
  data         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_system_events_ts ON system_events(ts DESC);
CREATE INDEX idx_system_events_subject ON system_events(subject_type, subject_id);

CREATE TABLE media_imports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,                              -- 'auto' | 'manual'
  status          TEXT NOT NULL DEFAULT 'queued',             -- 'queued' | 'running' | 'succeeded' | 'failed'
  payload         TEXT NOT NULL,                              -- {tabId, tabName, dbPath, mediaType, itemId, torrentId, infoHash, sourcePath, copy, releaseTitle}
  error           TEXT,
  validation_summary TEXT,                                     -- JSON
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         INTEGER NOT NULL,                              -- unix ms
  media_type   TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id   TEXT,
  event_type   TEXT NOT NULL,                                  -- 'grabbed' | 'downloaded' | 'imported' | 'upgraded' | 'renamed' | 'failed' | 'deleted'
  data         TEXT NOT NULL DEFAULT '{}'                     -- {indexer, downloadClient, infoHash, downloadId, releaseGroup, message}
);
CREATE INDEX idx_history_subject ON history(media_type, subject_type, subject_id, date DESC);

CREATE TABLE notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  implementation  TEXT NOT NULL,                              -- 'Discord' | 'Email' | 'Webhook' | 'CustomScript' | ...
  settings        TEXT NOT NULL DEFAULT '{}',
  tags            TEXT NOT NULL DEFAULT '[]',
  on_grab         INTEGER NOT NULL DEFAULT 0,
  on_download     INTEGER NOT NULL DEFAULT 0,
  on_upgrade      INTEGER NOT NULL DEFAULT 0,
  on_rename       INTEGER NOT NULL DEFAULT 0,
  on_health_issue INTEGER NOT NULL DEFAULT 0,
  on_health_restored INTEGER NOT NULL DEFAULT 0,
  on_application_update INTEGER NOT NULL DEFAULT 0,
  on_manual_interaction_required INTEGER NOT NULL DEFAULT 0,
  on_exhibit_added INTEGER NOT NULL DEFAULT 0,
  on_exhibit_delete INTEGER NOT NULL DEFAULT 0,
  on_artifact_delete INTEGER NOT NULL DEFAULT 0,
  on_artifact_delete_for_upgrade INTEGER NOT NULL DEFAULT 0,
  include_health_warnings INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notification_status (
  notification_id        INTEGER PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
  initial_failure        TEXT,
  most_recent_failure    TEXT,
  escalation_level       INTEGER NOT NULL DEFAULT 0,
  disabled_till          TEXT
);

CREATE TABLE import_lists (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  implementation  TEXT NOT NULL,                              -- 'TraktUserList' | 'IMDBList' | ...
  enabled         INTEGER NOT NULL DEFAULT 1,
  enable_auto     INTEGER NOT NULL DEFAULT 1,
  monitor         TEXT NOT NULL DEFAULT 'all',                -- 'all' | 'future' | 'missing' | 'existing' | 'none'
  search_on_add   INTEGER NOT NULL DEFAULT 0,
  quality_profile_id INTEGER,
  root_folder_path TEXT,
  library_id      INTEGER,
  tags            TEXT NOT NULL DEFAULT '[]',
  settings        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE import_exclusions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type    TEXT NOT NULL,
  external_id   TEXT NOT NULL,                                -- tmdbId | tvdbId | mbid | ...
  title         TEXT,
  UNIQUE(media_type, external_id)
);

CREATE TABLE download_clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,                                   -- 'transmission' | 'qbittorrent' | 'sabnzbd' | 'nzbget' | 'built-in'
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL,
  use_ssl     INTEGER NOT NULL DEFAULT 0,
  url_base    TEXT NOT NULL DEFAULT '',
  username    TEXT,
  password    TEXT,
  category    TEXT NOT NULL DEFAULT 'archivist',
  enabled     INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 1,
  tags        TEXT NOT NULL DEFAULT '[]',
  library_id  INTEGER,                                         -- NULL = global default
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE root_folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL UNIQUE,
  library_id  INTEGER REFERENCES libraries(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 27.8. M:N Tag Join Tables

```sql
CREATE TABLE film_tags         (film_id INTEGER, tag_id INTEGER, PRIMARY KEY(film_id, tag_id));
CREATE TABLE series_tags       (series_id INTEGER, tag_id INTEGER, PRIMARY KEY(series_id, tag_id));
CREATE TABLE artist_tags       (artist_id INTEGER, tag_id INTEGER, PRIMARY KEY(artist_id, tag_id));
CREATE TABLE author_tags       (author_id INTEGER, tag_id INTEGER, PRIMARY KEY(author_id, tag_id));
CREATE TABLE comic_series_tags (comic_series_id INTEGER, tag_id INTEGER, PRIMARY KEY(comic_series_id, tag_id));
CREATE TABLE game_tags         (game_id INTEGER, tag_id INTEGER, PRIMARY KEY(game_id, tag_id));
CREATE TABLE library_tags      (library_id INTEGER, tag_id INTEGER, PRIMARY KEY(library_id, tag_id));
CREATE TABLE indexer_tags      (indexer_id TEXT, tag_id INTEGER, PRIMARY KEY(indexer_id, tag_id));
CREATE TABLE download_client_tags (download_client_id INTEGER, tag_id INTEGER, PRIMARY KEY(download_client_id, tag_id));
CREATE TABLE notification_tags (notification_id INTEGER, tag_id INTEGER, PRIMARY KEY(notification_id, tag_id));
CREATE TABLE import_list_tags  (import_list_id INTEGER, tag_id INTEGER, PRIMARY KEY(import_list_id, tag_id));
CREATE TABLE indexer_proxy_tags (indexer_proxy_id INTEGER, tag_id INTEGER, PRIMARY KEY(indexer_proxy_id, tag_id));
CREATE TABLE film_compendiums  (film_id INTEGER, compendium_id INTEGER, PRIMARY KEY(film_id, compendium_id));
CREATE TABLE series_compendiums (series_id INTEGER, compendium_id INTEGER, PRIMARY KEY(series_id, compendium_id));
-- ... per media type
```

---

## 28. The Lexical Parser — Concrete Algorithm

Pseudocode in TS for the contextual lexer (replaces the dispatched-regex approach in V1).

### 28.1. Public API
```ts
interface ParsedRelease {
  kind: 'series' | 'movie' | 'unknown'
  title: string
  titleNormalized: string
  year: number | null
  season: number | null
  episodes: number[]
  absoluteEpisode: number | null
  airDate: string | null
  isSeasonPack: boolean
  isMultiEpisode: boolean
  isSpecial: boolean
  resolution: '2160p' | '1080p' | '720p' | '480p' | 'SD' | null
  source: 'REMUX' | 'BluRay' | 'WEB' | 'HDTV' | 'DVD' | null
  codec: 'AV1' | 'x265' | 'x264' | null
  hdr: boolean
  remux: boolean
  threeD: boolean
  audioCodec: 'TrueHD' | 'DTS-HD' | 'DTS' | 'EAC3' | 'AC3' | 'AAC' | 'OPUS' | 'FLAC' | 'MP3' | null
  audioChannels: '7.1' | '5.1' | '2.0' | null
  releaseGroup: string | null
  releaseHash: string | null            // anime [ABCD1234]
  edition: string | null
  language: string[]
  proper: number                         // 0=v1, 1=PROPER, 2=REPACK, 3=REPACK2...
}

function parseRelease(title: string): ParsedRelease
function normalizeTitle(s: string): string  // lowercase, alphanum-only
```

### 28.2. The Dispatch Pipeline

1. **Pre-process**: strip container extension (`.mkv|.mp4|...`); replace separator chars with spaces; collapse whitespace.
2. **Try anime parser** — match anime-specific anchors (`[Group] Show - 1054 [1080p]`, bracketed episode number, hashed release group prefix). On match: set `kind='unknown'`, `absoluteEpisode=N`, `releaseHash` if `[ABCD1234]` trailing, exit.
3. **Try daily parser** — match `\d{4}[-. _]\d{2}[-. _]\d{2}` anchor. On match: set `kind='series'`, `airDate='YYYY-MM-DD'`, year is **not** captured separately, exit.
4. **Try standard parser** — detect S/E anchors with multi-episode variants. On match: set `kind='series'`, populate `season + episodes[]`, exit.
5. **Try movie parser** — detect 4-digit year `(YYYY)` or standalone `YYYY` per "1917 defense" heuristic (right-to-left scan, prefer parenthesised). On match: `kind='movie'`, exit.
6. **Fallback**: `kind='unknown'`, attempt title extraction as everything before the first detected metadata token.

### 28.2a. Verification-Fallback Strategy (LOCK)

After dispatch, the parsed result is sent to the Appraisal department's identification pass against the metadata source of truth (TMDB / TVDB / etc.). If identification **rejects** the parse (e.g., a year that doesn't match any known release), the lexer is instructed to retry with a fallback strategy and re-verify:

| Original parse | Fallback strategy |
|---|---|
| `kind='movie'` rejected (no TMDB match for `<title>` + `<year>`) | Re-try with the year token treated as part of the title (handles "1917 (2019)" type ambiguity). If still no match, drop the year entirely. |
| `kind='series'` rejected (no TVDB match for `<title>`) | Strip trailing `(YYYY)` from the title and retry — handles `"Doctor Who (2005)"`-style year-suffix titles. |
| `kind='unknown'` (anime, no absolute mapping) | Fall back to standard parser with the bracketed group treated as release group, not absolute number wrapper. |
| Daily parse with conflicting year | Re-try as standard with the date split as `season=year, episode=MMDD`. |

The fallback engine is bounded — at most 2 retries per release; failure to identify after 2 retries logs an unmatched-release event and aborts the parse. **Never hammer TMDB/TVDB with unbounded retries.**

The fallback is what keeps the parser robust against title quirks that would otherwise require a regex change.

### 28.3. Token Detection Tables

```ts
const RX = {
  container: /\.(mkv|mp4|avi|wmv|m4v|ts|webm|mov|flac|mp3|m4a)$/i,
  releaseGroup: /-([A-Za-z0-9][A-Za-z0-9._]{1,24})$/,
  episodeStrict: /\bS(\d{1,3})[. _x-]?E(\d{1,3})/i,
  episodeRangeAfter: /^-E?(\d{1,3})\b/i,
  episodeMultiAfter: /^[. _]?E(\d{1,3})(?:[. _]?E(\d{1,3}))?(?:[. _]?E(\d{1,3}))?/i,
  episodeLoose: /\b(\d{1,2})x(\d{1,3})(?:-(\d{1,3}))?\b/i,
  seasonOnly: /\bS(\d{1,3})(?!\s*E\d|\d)\b/i,
  seasonPackComplete: /\b(?:Complete|COMPLETE|complete)\b/,
  dailyDate: /\b(19\d{2}|20\d{2})[. _-](\d{2})[. _-](\d{2})\b/,
  animeAbsolute: /(?:\s|^)-\s+(\d{1,4})(?:v\d)?\s+(?=[\[(]|\d{3,4}p|$)/,
  animeAbsoluteBracket: /\[(\d{1,4})(?:v\d)?\]/,
  yearInParens: /\((19\d{2}|20\d{2})\)/,
  yearStandalone: /\b(19\d{2}|20\d{2})\b/,
  special: /\b(OVA|ONA|Special|Specials|NCED|NCOP)\b/i,
  hdr: /\b(HDR(?:10\+?)?|DV|Dolby[. ]Vision|HLG)\b/i,
  remux: /\bremux\b/i,
  threeD: /\b3D\b/,
  audioCodec: /\b(TrueHD|DTS-?HD(?:\.MA)?|DTS|EAC3|DDP|DD\+|AC3|DD|AAC|OPUS|FLAC|MP3)\b/i,
  audioChannels: /\b([257])[. ]?[01]\b/,
  proper: /\bPROPER\b/i,
  repack: /\bREPACK(\d?)\b/i,
  language: /\b(MULTi|FRENCH|VOSTFR|GERMAN|SPANISH|ITALIAN|DUTCH|JAPANESE|KOREAN|RUSSIAN|HINDI|CHINESE|PORTUGUESE|POLISH|HEBREW|HUNGARIAN|TURKISH|SWEDISH|NORWEGIAN|DANISH|FINNISH|GREEK|UKRAINIAN|CZECH|THAI|VIETNAMESE|ARABIC|ROMANIAN|BULGARIAN|CROATIAN|SERBIAN|SLOVENIAN|SLOVAK)\b/i,
  edition: /\b(Extended|Director'?s\.?Cut|Theatrical|Criterion|Remastered|IMAX|Ultimate\.?Cut|Special\.?Edition|Unrated|Uncut)\b/i,
}

const LANGUAGE_MAP: Record<string, string> = {
  multi: 'multi', french: 'fr', vostfr: 'fr', german: 'de', spanish: 'es', italian: 'it',
  dutch: 'nl', japanese: 'ja', korean: 'ko', russian: 'ru', hindi: 'hi', chinese: 'zh',
  portuguese: 'pt', polish: 'pl', hebrew: 'he', hungarian: 'hu', turkish: 'tr',
  swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', greek: 'el',
  ukrainian: 'uk', czech: 'cs', thai: 'th', vietnamese: 'vi', arabic: 'ar',
  romanian: 'ro', bulgarian: 'bg', croatian: 'hr', serbian: 'sr', slovenian: 'sl', slovak: 'sk',
}
```

### 28.4. Quality Token Extraction (`parseQualityFromTitle`)

```ts
function parseQualityFromTitle(title: string): {
  tier: number              // 0..3 from scoreRelease()
  resolution: string | null // '2160p' | '1080p' | '720p' | 'SD' | null
  source: string | null     // 'REMUX' | 'BluRay' | 'WEB' | 'HDTV' | 'DVD'
  codec: string | null      // 'AV1' | 'x265' | 'x264'
  releaseGroup: string | null
  edition: string | null
} {
  const RESOLUTION_SCORE = { '2160p': 4, '1080p': 3, '720p': 2, SD: 1 }
  const SOURCE_SCORE     = { REMUX: 5, BluRay: 4, WEB: 3, HDTV: 2, DVD: 1 }
  const CODEC_SCORE      = { AV1: 4, x265: 3, HEVC: 3, x264: 2, AVC: 2 }

  return {
    tier: scoreRelease(title).tier,
    resolution: /\b(2160p|4k|uhd)\b/i.test(title) ? '2160p'
              : /\b1080p\b/i.test(title) ? '1080p'
              : /\b720p\b/i.test(title) ? '720p'
              : /\b(480p|576p|dvdrip|sdtv)\b/i.test(title) ? 'SD' : null,
    source: /\bremux\b/i.test(title) ? 'REMUX'
          : /\bblu-?ray|bdrip|brrip\b/i.test(title) ? 'BluRay'
          : /\bweb-?dl|webrip|web\b/i.test(title) ? 'WEB'
          : /\bhdtv\b/i.test(title) ? 'HDTV'
          : /\bdvd|dvdrip\b/i.test(title) ? 'DVD' : null,
    codec: /\bav1\b/i.test(title) ? 'AV1'
         : /\b(x265|h\.?265|hevc)\b/i.test(title) ? 'x265'
         : /\b(x264|h\.?264|avc)\b/i.test(title) ? 'x264' : null,
    edition: /\b(extended|director'?s cut|theatrical|criterion|remastered|imax|ultimate cut|special edition)\b/i.exec(title)?.[1] ?? null,
    releaseGroup: /-([A-Za-z0-9][A-Za-z0-9._-]{1,24})$/.exec(title)?.[1] ?? null,
  }
}
```

### 28.5. Quality Tier Scoring (`scoreRelease`)

```ts
const TIER_1_REGEXES = [
  /(?<=^|[\s.-])(QxR|afm72|Bandi|FreetheFish|Garshasp|Ghost|Ime|Kappa|Langbard|LION|Panda|MONOLITH|Natty|r00t|RCVR|RZeroX|SAMPA|Silence|t3nzin|Tigole|YOGI)\b/i,
  /(?<=^|[\s.-])(TAoE|Ainz|AJJMIN|ANONAZ|ArcX|bccornfo|DNU|DrainedDay|DUHIT|Erie|Frys|Goki|HxD|jb2049|JBENT|Nostradamus|r0b0t|Species180|TheSickle|xtrem3x|WEM|POIASD)\b/i,
  /(?<=^|[\s.-])SARTRE\b/i,
]

const TIER_2_REGEXES = [
  /(?<=^|[\s.-])R1GY3B\b/i, /(?<=^|[\s.-])Ralphy\b/i, /(?<=^|[\s.-])TimeDistortion\b/i,
  /(?<=^|[\s.-])SQS\b/i, /(?<=^|[\s.-])Chivaman\b/i, /(?<=^|[\s.-])Vyndros\b/i,
  /(?<=^|[\s.-])Prof\b/i, /(?<=^|[\s.-])HeVK\b/i,
  /(?<=^|[\s.-])(UTR|Joy|Q22|ImE|Qman|Q18|Ime|theincognito)\b/i,
  /(?<=^|[\s.-])Korach\b/i, /(?<=^|[\s.-])D0ct0rLew\b/i, /(?<=^|[\s.-])SM737\b/i,
]

const TIER_3_REGEXES = [
  /(?<=^|[\s.-])iVy\b/i, /(?<=^|[\s.-])KONTRAST\b/i, /(?<=^|[\s.-])PHOCiS\b/i,
  /(?<=^|[\s.-])YAWNiX\b/i, /(?<=^|[\s.-])edge2020\b/i,
  /(?<=^|[\s.-])YIFY\b/i, /(?<=^|[\s.-])PSA\b/i, /(?<=^|[\s.-])MeGusta\b/i,
]

function scoreRelease(title: string): { tier: 0|1|2|3, score: number } {
  if (TIER_1_REGEXES.some(rx => rx.test(title))) return { tier: 1, score: 1000 }
  if (TIER_2_REGEXES.some(rx => rx.test(title))) return { tier: 2, score: 500 }
  if (TIER_3_REGEXES.some(rx => rx.test(title))) return { tier: 3, score: 100 }
  return { tier: 0, score: 0 }
}
```

### 28.6. Release Validation (`validateFilmRelease`)

```ts
const SCORE_TITLE_MATCH = 1_000
const SCORE_YEAR_EXACT = 5_000
const SCORE_YEAR_ADJACENT = 500
const SCORE_NO_TITLE = -5_000
const SCORE_NO_YEAR = -3_000

function validateFilmRelease(releaseTitle: string, query: string, year?: number): { valid: boolean; score: number } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const t = norm(releaseTitle)
  const q = norm(query)

  let score = 0
  if (t.includes(q)) score += SCORE_TITLE_MATCH
  else score += SCORE_NO_TITLE

  if (year) {
    const yearMatch = releaseTitle.match(/\b(19\d{2}|20\d{2})\b/)
    if (yearMatch) {
      const yearInTitle = parseInt(yearMatch[1])
      if (yearInTitle === year) score += SCORE_YEAR_EXACT
      else if (Math.abs(yearInTitle - year) === 1) score += SCORE_YEAR_ADJACENT
      else score += SCORE_NO_YEAR
    } else {
      score += SCORE_NO_YEAR
    }
  }

  return { valid: score > 0, score }
}
```

### 28.7. Tiered Search Strategy (`performTieredSearch`)

```ts
async function performTieredSearch(
  db: Database, query: string, year: number | undefined,
  enabledIndexers: IndexerInstance[], limit: number,
  resolution?: string, tier?: string, source?: string, codec?: string,
  checkCancelled?: () => void,
  onResults?: (batch: any[]) => void,
): Promise<Release[]> {
  const releases: Release[] = []
  const tierTerms = getTierTermsForMedia('films', db) // {tier1[], tier2[], tier3[]}
  const TIER_PROBE_ORDER = tier === 'Tier 3' ? [tierTerms.tier3]
                        : tier === 'Tier 2' ? [tierTerms.tier2, tierTerms.tier1]
                        : tier === 'Tier 1' ? [tierTerms.tier1]
                        : tier === 'Broad'  ? [['']]
                        :                     [tierTerms.tier1, tierTerms.tier2, tierTerms.tier3]

  for (const terms of TIER_PROBE_ORDER) {
    if (releases.length >= limit) break

    for (const term of terms) {
      checkCancelled?.()
      if (releases.length >= limit) break

      // Build query: "<title> <year> <term> <resolution> <source> <codec>"
      const parts = [query]
      if (year) parts.push(String(year))
      if (term) parts.push(term)
      if (resolution && resolution !== 'Any') parts.push(resolution)
      if (source && source !== 'Any') parts.push(source)
      if (codec && codec !== 'Any') parts.push(codec)
      const sq = parts.join(' ')

      const results = await searchViaIndexers(enabledIndexers, sq, { type: 'movie', module: 'films' })
      const prevLen = releases.length

      for (const r of results) {
        if (releases.length >= limit) break
        const val = validateFilmRelease(r.title, query, year)
        if (!val.valid) continue
        if (codec === 'Legacy' && /\b(x265|h\.?265|hevc|av1)\b/i.test(r.title)) continue
        releases.push({
          ...r,
          customTier: scoreRelease(r.title).tier,
          customScore: val.score,
        })
      }

      const batch = releases.slice(prevLen)
      if (batch.length > 0) onResults?.(sortReleases([...batch]))
    }
  }

  // Last resort: drop resolution filter
  if (releases.length === 0 && resolution) {
    const broad = await performTieredSearch(db, query, year, enabledIndexers, limit, undefined, 'Broad', source, checkCancelled, onResults, codec)
    releases.push(...broad)
  }

  return releases
}

function sortReleases(releases: Release[]): Release[] {
  const normTier = (t: number) => t === 0 ? 4 : t   // untiered ranks below tier 3
  return releases.sort((a, b) => {
    const tierA = normTier(a.customTier ?? 0)
    const tierB = normTier(b.customTier ?? 0)
    if (tierA !== tierB) return tierA - tierB                // tier ASC
    if ((a.customScore ?? 0) !== (b.customScore ?? 0)) return (b.customScore ?? 0) - (a.customScore ?? 0) // score DESC
    if ((a.seeders ?? 0) !== (b.seeders ?? 0)) return (b.seeders ?? 0) - (a.seeders ?? 0) // seeders DESC
    return (a.indexerPriority ?? 25) - (b.indexerPriority ?? 25) // indexer priority ASC
  })
}
```

---

## 29. Track Cleaner — Concrete Algorithm

The Archivist signature feature. Pseudocode for the full pipeline:

### 29.1. Configuration
```ts
interface TrackCleanerConfig {
  enabled: boolean              // default true
  preferredLanguage: string     // ISO 639-1, default 'en'
  keepOriginalLanguage: boolean // default true
  keepPreferredAudio: boolean   // default true
  keepPreferredSubs: boolean    // default true
  keepCommentary: boolean       // default true
  additionalLanguages: string[] // extra codes ['spa', 'fre']
}
```

### 29.2. Language Map (ISO 639-1 → 639-2/B alternates)
```ts
const LANG_MAP: Record<string, string[]> = {
  en: ['eng', 'en'],          es: ['spa', 'es'],          fr: ['fre', 'fra', 'fr'],
  de: ['ger', 'deu', 'de'],   it: ['ita', 'it'],          pt: ['por', 'pt'],
  ru: ['rus', 'ru'],          ja: ['jpn', 'ja'],          ko: ['kor', 'ko'],
  zh: ['chi','zho','zh','cmn','yue','cn'],                 cn: [...],  yue: [...],
  hi: ['hin', 'hi'],          ar: ['ara', 'ar'],          nl: ['dut', 'nld', 'nl'],
  sv: ['swe', 'sv'],          no: ['nor', 'no', 'nob', 'nno'],         da: ['dan', 'da'],
  fi: ['fin', 'fi'],          pl: ['pol', 'pl'],          tr: ['tur', 'tr'],
  th: ['tha', 'th'],          cs: ['cze', 'ces', 'cs'],   hu: ['hun', 'hu'],
  ro: ['rum', 'ron', 'ro'],   el: ['gre', 'ell', 'el'],   he: ['heb', 'he'],
  uk: ['ukr', 'uk'],          vi: ['vie', 'vi'],          id: ['ind', 'id'],
  ms: ['may', 'msa', 'ms'],   tl: ['tgl', 'fil', 'tl'],
}

function langMatches(streamLang: string | undefined, target: string): boolean {
  if (!streamLang) return false
  const sl = streamLang.toLowerCase().split('-')[0]
  const tl = target.toLowerCase().split('-')[0]
  if (sl === tl) return true
  if (LANG_MAP[tl]?.includes(sl)) return true
  for (const codes of Object.values(LANG_MAP)) {
    if (codes.includes(tl) && codes.includes(sl)) return true
  }
  return false
}
```

### 29.3. Stream Classification
```ts
function isCommentary(stream: StreamInfo): boolean {
  const title = (stream.tags?.title ?? '').toLowerCase()
  return title.includes('commentary') || title.includes('director')
      || title.includes('cast') || (stream.disposition?.comment ?? 0) === 1
}

function isMusicOnly(stream: StreamInfo): boolean {
  const title = `${stream.tags?.title ?? ''} ${stream.tags?.handler_name ?? ''}`.toLowerCase()
  return title.includes('music only') || title.includes('score only') || title.includes('isolated score')
}

function isUnknownLanguage(lang: string | undefined): boolean {
  return !lang || ['und', 'unk', 'unknown'].includes(lang.toLowerCase())
}
```

### 29.4. The Cleaning Plan
```ts
function buildCleanPlan(streams: StreamInfo[], originalLang: string | null, config: TrackCleanerConfig): {
  keep: number[],     // stream indices to keep
  drop: number[],     // stream indices to drop
  removedAudio: number,
  removedSubs: number
} {
  const keepSet = new Set<number>()
  const wantedLangs = new Set<string>()

  if (config.keepPreferredAudio || config.keepPreferredSubs) wantedLangs.add(config.preferredLanguage)
  if (config.keepOriginalLanguage && originalLang) wantedLangs.add(originalLang)
  for (const lang of config.additionalLanguages) wantedLangs.add(lang)

  let removedAudio = 0, removedSubs = 0

  for (const stream of streams) {
    const idx = stream.index
    const lang = stream.tags?.language

    if (stream.codec_type === 'video') {
      keepSet.add(idx)
      continue
    }

    if (stream.codec_type === 'audio') {
      // Always keep music-only / score-only tracks
      if (isMusicOnly(stream)) { keepSet.add(idx); continue }
      // Commentary: keep if config says so
      if (isCommentary(stream) && config.keepCommentary) { keepSet.add(idx); continue }
      // Unknown language: keep (be cautious)
      if (isUnknownLanguage(lang)) { keepSet.add(idx); continue }
      // Match against wanted languages
      if ([...wantedLangs].some(w => langMatches(lang, w))) {
        keepSet.add(idx)
      } else {
        removedAudio++
      }
      continue
    }

    if (stream.codec_type === 'subtitle') {
      if (isUnknownLanguage(lang)) { keepSet.add(idx); continue }
      if ([...wantedLangs].some(w => langMatches(lang, w))) {
        keepSet.add(idx)
      } else {
        removedSubs++
      }
      continue
    }

    if (stream.codec_type === 'attachment' || stream.codec_type === 'data') {
      keepSet.add(idx) // preserve fonts/cover art/metadata streams
    }
  }

  return {
    keep: [...keepSet].sort((a, b) => a - b),
    drop: streams.filter(s => !keepSet.has(s.index)).map(s => s.index),
    removedAudio, removedSubs,
  }
}
```

### 29.5. The ffmpeg Invocation
```ts
async function cleanTracks(filePath: string, originalLang: string | null, config = getTrackCleanerConfig()): Promise<CleanResult> {
  if (!config.enabled) return { success: true, message: 'Disabled', removedAudio: 0, removedSubs: 0, originalSize: 0, newSize: 0 }

  const probe = await runFfprobe(filePath)
  const plan = buildCleanPlan(probe.streams, originalLang, config)

  if (plan.drop.length === 0) {
    return { success: true, message: 'Nothing to remove', removedAudio: 0, removedSubs: 0, originalSize: statSync(filePath).size, newSize: statSync(filePath).size }
  }

  const tmpPath = `${filePath}.cleaning.tmp.mkv`
  const args = [
    '-i', filePath,
    ...plan.keep.flatMap(idx => ['-map', `0:${idx}`]),
    '-c', 'copy',
    '-map_chapters', '0',
    '-map_metadata', '0',
    // Re-set default disposition for the chosen tracks
    ...buildDispositionArgs(plan.keep, probe.streams, config),
    '-y',
    tmpPath,
  ]

  const originalSize = statSync(filePath).size
  await runFfmpeg(args)
  const newSize = statSync(tmpPath).size

  // Atomic replace
  unlinkSync(filePath)
  renameSync(tmpPath, filePath)

  return {
    success: true,
    message: `Removed ${plan.removedAudio} audio + ${plan.removedSubs} subtitle tracks (${formatBytes(originalSize - newSize)} saved)`,
    removedAudio: plan.removedAudio,
    removedSubs: plan.removedSubs,
    originalSize, newSize,
  }
}
```

### 29.6. Validation (post-clean)
```ts
function validateCleanedFile(beforeChapters: ChapterProbeResult, afterChapters: ChapterProbeResult, file: FileInfo): { ok: boolean, errors: string[], warnings: string[] } {
  const errors: string[] = [], warnings: string[] = []

  if (!file) { errors.push('Cleaned file could not be probed'); return { ok: false, errors, warnings } }

  const tracks = file.tracks ?? []
  if (tracks.filter(t => t.type === 'video').length === 0) errors.push('Cleaned file has no primary video stream')
  if (tracks.filter(t => t.type === 'audio').length === 0) errors.push('Cleaned file has no audio stream')

  // Chapter regression
  if (afterChapters.count < beforeChapters.count) {
    errors.push(`Chapter count dropped from ${beforeChapters.count} to ${afterChapters.count}`)
  }

  if (file.size < 50 * 1024 * 1024) errors.push(`Cleaned file is unexpectedly small: ${file.size} bytes`)

  return { ok: errors.length === 0, errors, warnings }
}
```

If validation fails, the cleaning is **rolled back** — the temp file is deleted, the original is preserved untouched, and a `RestorationFailedEvent` is raised.

---

## 30. The Naming Engine — Token Reference

V2 ships a hand-rolled `{token}` evaluator (no Mustache/Handlebars).

### 30.1. Filename Tokens (per media type)

**Films:**
| Token | Output |
|---|---|
| `{Movie Title}` | `The Matrix` |
| `{Movie CleanTitle}` | `Matrix` (article stripped, illegal chars removed) |
| `{Movie OriginalTitle}` | original-language title |
| `{Movie TitleThe}` | `Matrix, The` |
| `{Movie TitleYear}` | `The Matrix (1999)` |
| `{Movie Year}` / `{Release Year}` | `1999` |
| `{Edition Tags}` | `Director's Cut` |
| `{Edition}` | edition_name from film_editions table |
| `{Quality Title}` | `Bluray-1080p` |
| `{Quality Full}` | `Bluray-1080p Proper` |
| `{MediaInfo VideoCodec}` | `x264` |
| `{MediaInfo VideoBitDepth}` | `10` |
| `{MediaInfo VideoDynamicRange}` | `HDR` |
| `{MediaInfo VideoDynamicRangeType}` | `HDR10` / `HDR10+` / `DV` |
| `{MediaInfo AudioCodec}` | `DTS-HD` |
| `{MediaInfo AudioChannels}` | `5.1` |
| `{MediaInfo AudioLanguages}` | `[EN+JA]` |
| `{MediaInfo SubtitleLanguages}` | `[EN]` |
| `{MediaInfo Simple}` | `x264 DTS` |
| `{MediaInfo Full}` | `x264 DTS 5.1` |
| `{Custom Formats}` | `HDR x265` |
| `{Custom Format:HDR}` | conditional emit |
| `{Release Group}` | `GROUP` |
| `{IMDb Id}` | `tt0133093` |
| `{TMDb Id}` | `603` |

**Series (TV):**
| Token | Output |
|---|---|
| `{Series Title}` | `The Office` |
| `{Series CleanTitle}` | `Office` |
| `{Series TitleYear}` | `The Office (2005)` |
| `{Series TitleThe}` | `Office, The` |
| `{Series TitleFirstCharacter}` | `T` (folder grouping) |
| `{Series Year}` | `2005` |
| `{Series TVDBId}` / `{Series TVMazeId}` / `{Series TmdbId}` / `{Series ImdbId}` | external ids |
| `{Season}` / `{season:00}` | `1` / `01` |
| `{Episode}` / `{episode:00}` | `5` / `05` |
| `{Episode Title}` | episode name |
| `{Episode CleanTitle}` | sanitised |
| `{Episode CleanTitle:30}` | truncated to 30 chars |
| `{Air-Date}` | `2024-05-05` |
| `{absolute}` / `{absolute:000}` | `1054` |
| `{Anime Release Group}` | preserves exact case |

### 30.2. Default Templates
```ts
const DEFAULT_NAMING = {
  movieFolderFormat:  '{Movie CleanTitle} ({Release Year})',
  movieFileFormat:    '{Movie CleanTitle} ({Release Year}) {Quality Full}',
  // V1 also includes edition: '{Movie CleanTitle} ({Release Year}) ({Edition})'

  seriesFolderFormat: '{Series TitleYear}',
  seasonFolderFormat: 'Season {season:00}',
  specialsFolderFormat: 'Specials',
  standardEpisodeFormat: '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}',
  dailyEpisodeFormat:    '{Series Title} - {Air-Date} - {Episode Title} {Quality Full}',
  animeEpisodeFormat:    '{Series Title} - S{season:00}E{episode:00} - {absolute:000} - {Episode Title} {Quality Full}',

  artistFolderFormat: '{Artist Name}',
  albumFolderFormat:  '{Album Title} ({Album Year})',
  trackFileFormat:    '{Disc:00}-{Track:00} - {Track Title}',

  authorFolderFormat: '{Author SortName}',
  bookFileFormat:     '{Book Title} - {Author Name} {Book Format}',
  bookSeriesFormat:   '{Series Name} {Series Position} - {Book Title}',

  comicSeriesFolderFormat: '{Series Title} ({Start Year})',
  comicIssueFileFormat:    '{Series Title} #{Issue Number} ({Cover Year})',

  gameFolderFormat: '{Game Title} ({Year})',
  gameFileFormat:   '{Game Title}',

  multiEpisodeStyle: 'Extend',  // 'Extend' | 'Duplicate' | 'Repeat' | 'Scene' | 'Range' | 'PrefixedRange'
  renameMovies: true,
  colonReplacement: 'spaceDash',  // 'delete' | 'dash' | 'spaceDash' | 'spaceDashSpace' | 'smart'
  illegalCharReplacement: '',
}
```

### 30.3. Multi-Episode Style Outputs
For an EpisodeFile mapped to episodes 1, 2, 3:

| Mode | Render |
|---|---|
| `Extend` (default) | `S01E01-E03` |
| `Duplicate` | `S01E01E02E03` |
| `Repeat` | `S01E01-S01E02-S01E03` |
| `Scene` | `s01e01-e03` |
| `Range` | `S01E01-03` |
| `PrefixedRange` | `S01E01-E03` |

### 30.4. Sanitisation Pipeline
1. Replace illegal characters: `: * ? " < > |` → according to `colonReplacement` setting (`:` only) and `illegalCharReplacement` (everything else).
2. Strip leading/trailing whitespace.
3. Collapse repeated spaces to single space.
4. Strip trailing dot or whitespace before extension.
5. Apply OS-specific path-length cap (Windows: 259 chars; Linux: 4096).

---

## 31. Hono RPC Routes — Concrete Endpoint Surface

Every endpoint with HTTP method, path, request shape, response shape. Frontend uses `hc<AppType>()` to build a typed client.

### 31.1. Films

```
GET    /api/v1/films?libraryId=N
       → Movie[]
GET    /api/v1/films/:id
       → Movie & { editions: FilmEdition[], fileInfo: FileInfo | null, trailerPath?: string }
GET    /api/v1/films/lookup?q=<text>
       → TmdbResult[]
GET    /api/v1/films/tmdb/:tmdbId
       → TmdbResult | (Movie + status='uncollected')
POST   /api/v1/films
       body: { tmdbId: string, qualityProfileId?, libraryId, monitored?, target_tier?, target_resolution?, target_source?, target_codec? }
       → Movie
PUT    /api/v1/films/:id
       body: { monitored?, status?, qualityProfileId?, libraryId?, upgrade_allowed?, target_*?, default_edition_id? }
       → Movie
DELETE /api/v1/films/:id?deleteFiles=bool&addExclusion=bool
       → 204
POST   /api/v1/films/refresh
       → { success: bool, updated: int }
GET    /api/v1/films/:id/acquisition-history
       → { decisions: AcquisitionDecision[], blocks: ReleaseBlock[] }
POST   /api/v1/films/:id/reject-current-release
       body: { reason?: string }
       → { success: true } — adds current info_hash to blocklist + reverts to wanted
POST   /api/v1/films/:id/repair
       body: { deleteFile?: bool, rejectCurrent?: bool }
       → Movie
PUT    /api/v1/films/:id/metadata
       body: { title?, original_title?, year?, overview?, genres?, certification?, studio?, runtime?, country?, rating? }
       → Movie  (fields are LOCKED — future TMDB refresh won't overwrite)
GET    /api/v1/films/:id/images?type=poster|backdrop|logo|banner|clearart|thumb|disc&language=en
       → [{ url, source: 'TMDB' | 'Fanart.tv', type, language, width?, height? }]
PUT    /api/v1/films/:id/images
       body: { url: string, type: 'poster'|'backdrop'|'logo'|'banner'|'clearart'|'thumb'|'disc' }
       → { success: true, path: '/media/...' }
GET    /api/v1/films/releases/search?q=<text>&year=N&resolution=&tier=&source=&codec=
       → SSE: data: <Release[]> events stream as indexers respond; event: done when complete
POST   /api/v1/films/download
       body: { downloadUrl, filmId?, tier?, version? }
       → { success, message, infoHash? }
POST   /api/v1/films/:id/auto-grab
       → { success, message }
PUT    /api/v1/films/editions/:id
       body: { edition_name?, ... }
       → FilmEdition
GET    /api/v1/films/edition-rules/all
       → EditionRule[]
POST   /api/v1/films/edition-rules
       body: { rule_name, regex_pattern, output_label, priority?, active? }
       → EditionRule
PUT    /api/v1/films/edition-rules/:id
       body: { ...partial }
       → EditionRule
DELETE /api/v1/films/edition-rules/:id
       → { success: true }
```

### 31.2. Series

```
GET    /api/v1/series?libraryId=N
       → Series[]
GET    /api/v1/series/:id
       → Series & { seasons: Season[], episodes: Episode[], episodeFiles: EpisodeFile[] }
GET    /api/v1/series/lookup?q=<text>
       → SeriesSearchResult[]
GET    /api/v1/series/tmdb/:tmdbId
       → SeriesEntity | local series
POST   /api/v1/series
       body: { tvdbId? | tmdbId?, monitored?, monitoredSeasons?: 'all'|'latest'|'none', monitor?: MonitorType,
               qualityProfileId?, libraryId, rootFolderPath?, upgrade_allowed?, target_*? }
       → Series  (dispatches RefreshSeriesCommand immediately)
PUT    /api/v1/series/:id
       body: { monitored?, qualityProfileId?, upgrade_allowed?, target_*? }
       → Series
DELETE /api/v1/series/:id?deleteFiles=bool&addExclusion=bool
       → 204
POST   /api/v1/series/refresh
       → { success, updated }
GET    /api/v1/series/:id/seasons
       → Season[]
PUT    /api/v1/series/seasons/:seasonId
       body: { monitored?, upgrade_allowed? }
       → Season
GET    /api/v1/series/:id/episodes
       → Episode[]
PUT    /api/v1/series/episodes/:episodeId
       body: { monitored?, upgrade_allowed? }
       → Episode
GET    /api/v1/series/releases/search?q=<text>&season=&episode=  (SSE)
POST   /api/v1/series/download
       body: { downloadUrl }
       → { success, message }
GET    /api/v1/series/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
       → CalendarEvent[]
```

### 31.3. Music / Books / Comics / Games / Magazines / Podcasts
Mirror endpoints with their entity shapes. Pattern:
- `GET /<media-type>` — list root entities (artists/authors/comic_series/games/...)
- `GET /<media-type>/:id` — detail with children
- `GET /<media-type>/lookup?q=` — provider search
- `POST /<media-type>` — add by external id
- `PUT /<media-type>/:id` — update
- `DELETE /<media-type>/:id`
- `GET /<media-type>/releases/search?q=` (SSE) — interactive search
- `POST /<media-type>/download` — manual grab
- `POST /<media-type>/:id/auto-grab` — automatic best-grab

### 31.4. Acquisitions / Indexers / Indexer Proxies

```
GET    /api/v1/indexers
       → Indexer[]
GET    /api/v1/indexers/definitions/list
       → DefinitionEntry[]
GET    /api/v1/indexers/:id
       → Indexer
POST   /api/v1/indexers
       body: { name, type?, protocol?, definitionId?, baseUrl, apiKey?, settings, ... }
       → Indexer
PUT    /api/v1/indexers/:id
       → Indexer
DELETE /api/v1/indexers/:id
       → 204
POST   /api/v1/indexers/:id/test
       → { success: bool, message: string, validationFailures?: [{propertyName, errorMessage, severity}] }
POST   /api/v1/indexers/test
       body: <full proposed config>
       → { success, message, validationFailures? }
POST   /api/v1/indexers/testall
       → [{ id, name, success, message }]

GET    /api/v1/indexer-proxies
GET    /api/v1/indexer-proxies/:id
POST   /api/v1/indexer-proxies
PUT    /api/v1/indexer-proxies/:id
DELETE /api/v1/indexer-proxies/:id
POST   /api/v1/indexer-proxies/:id/test

GET    /api/v1/indexerstats?startDate=&endDate=
       → { indexers: [...], userAgents: [...], hosts: [...] }
```

### 31.5. Download Clients & Downloads

```
GET    /api/v1/download-clients?libraryId=N
       → DownloadClient[]
POST   /api/v1/download-clients
PUT    /api/v1/download-clients/:id
DELETE /api/v1/download-clients/:id
POST   /api/v1/download-clients/test
POST   /api/v1/download-clients/:id/test

GET    /api/v1/dashboard/downloads
       → { torrents: [{ id, infoHash, name, status, progress, downloadSpeed, uploadSpeed, sizeBytes, eta, peersConnected, seedsConnected, error }] }
POST   /api/v1/dashboard/downloads/:id/action
       body: { action: 'pause'|'resume'|'remove'|'recheck'|'reannounce', deleteData?: bool }
       → { success: bool }
```

### 31.6. Settings / Configuration

```
GET    /api/v1/settings/naming
PUT    /api/v1/settings/naming
GET    /api/v1/settings/media-management
PUT    /api/v1/settings/media-management
GET    /api/v1/settings/media-base-dir
       → { path: '<absolute>' }
GET    /api/v1/settings/flaresolverr
PUT    /api/v1/settings/flaresolverr
       body: { url, enabled }
GET    /api/v1/settings/acquisition-defaults
PUT    /api/v1/settings/acquisition-defaults
GET    /api/v1/settings/quality-tiers
PUT    /api/v1/settings/quality-tiers
       body: TierConfig
GET    /api/v1/settings/track-cleaner
PUT    /api/v1/settings/track-cleaner
GET    /api/v1/settings/track-cleaner/status
       → { available: bool, ffmpegPath?: string, ffprobePath?: string, version?: string }
POST   /api/v1/media/clean-tracks
       body: { filePath, originalLanguage?, tmdbId? }
       → CleanResult
GET    /api/v1/settings/subtitles
PUT    /api/v1/settings/subtitles
POST   /api/v1/subtitles/search
       body: { imdbId?, tmdbId?, query?, language?, seasonNumber?, episodeNumber? }
       → SubtitleSearchResult[]
POST   /api/v1/subtitles/download
       body: { fileId, mediaFilePath, language? }
       → { success, message, filePath? }
GET    /api/v1/settings/api-keys
       → masked values
PUT    /api/v1/settings/api-keys
       body: ApiKeysConfig

GET    /api/v1/quality-profiles?libraryId=N
POST   /api/v1/quality-profiles
PUT    /api/v1/quality-profiles/:id
DELETE /api/v1/quality-profiles/:id

GET    /api/v1/root-folders?libraryId=N
       → RootFolder[]
POST   /api/v1/root-folders
       body: { path, libraryId? }
DELETE /api/v1/root-folders/:id

GET    /api/v1/libraries
POST   /api/v1/libraries
       body: { name, mediaType, rootFolderPath? }
PUT    /api/v1/libraries/:id
       body: { name?, ... }
DELETE /api/v1/libraries/:id?deleteFiles=bool
```

### 31.7. System / Curator

```
GET    /api/v1/health
       → { status: 'ok', version: '2.0.0', alerts: HealthAlert[] }
GET    /api/v1/ping        → 'pong'                                            (NO AUTH; pre-router)
GET    /api/v1/system/status
       → { version, branch, platform, uptime_seconds, dbStatus: [...] }
GET    /api/v1/system/overview
       → big aggregate snapshot { jobs, events, imports, acquisitions, torrents, integrity, db, maintenance, backups }
POST   /api/v1/system/restart
POST   /api/v1/system/shutdown

GET    /api/v1/jobs?limit=N
       → Job[]
POST   /api/v1/jobs
       body: { type, subjectType?, subjectId?, payload?, maxAttempts? }
POST   /api/v1/jobs/:id/cancel
POST   /api/v1/jobs/:id/retry

GET    /api/v1/events?limit=N
       → Event[] from system_events
GET    /api/v1/acquisition-decisions?limit=N
GET    /api/v1/release-blocklist?limit=N
DELETE /api/v1/release-blocklist/:id

GET    /api/v1/maintenance
PUT    /api/v1/maintenance
POST   /api/v1/maintenance/run
GET    /api/v1/backups
PUT    /api/v1/backups
POST   /api/v1/backups/run

GET    /api/v1/integrity
PUT    /api/v1/integrity
POST   /api/v1/integrity/run
POST   /api/v1/integrity/repair
       body: { problem: IntegrityProblem, backupBeforeRepair?: bool }
POST   /api/v1/integrity/repair-bulk
       body: { problems: IntegrityProblem[], backupBeforeRepair?: bool }

POST   /api/v1/rss/run
       → triggers force-refresh of all enabled indexers
POST   /api/v1/release-pipeline/refresh
POST   /api/v1/release-pipeline/refresh/:indexerId
POST   /api/v1/release-pipeline/missing-search
GET    /api/v1/release-pipeline/health
```

### 31.8. Manual Imports / Holding Pen

```
GET    /api/v1/manual-imports/candidates
       → { downloadDir, items: [{ sourcePath, name, size, modifiedAt, candidates: [...] }] }
GET    /api/v1/manual-imports/search?mediaType=&query=&sourceName=
       → { results: [...] }
POST   /api/v1/manual-imports/queue
       body: { libraryId, mediaType, itemId, sourcePath, copy?, releaseTitle? }
       → { success, jobId }

GET    /api/v1/media-imports?limit=N
       → MediaImport[]
```

### 31.9. Dashboard

```
GET    /api/v1/dashboard/stats
       → { counts: { films: {total, missing, acquiring}, series: {...}, music: {...}, books: {...}, comics: {...}, games: {...} } }
GET    /api/v1/dashboard/system
       → { cpu: {load, cores}, memory: {total, used, free}, storage: [{fs, mount, size, used}] }
GET    /api/v1/dashboard/calendar?start=&end=
       → CalendarEvent[]   (cross-media)
GET    /api/v1/dashboard/search?q=&category=&type=&module=
       → manual aggregator search across all enabled indexers
POST   /api/v1/dashboard/search/grab
       body: { downloadUrl, title, mediaType }
       → { success, message }
```

### 31.10. SSE Stream

```
GET    /api/v1/events  (Accept: text/event-stream)
       Events:
       - download:progress  data: { id, progress, downloadSpeed, uploadSpeed, peers, eta }
       - exhibit:status-changed  data: { mediaType, id, status }
       - job:created / job:updated / job:completed  data: { jobId, type, status }
       - health:alert-raised / health:alert-cleared  data: { source, type, message }
       - notification:fired  data: { ... }
```

### 31.11. Authentication
- All `/api/v1/*` requires `Authorization: Bearer <key>` OR `X-API-Key: <key>` header.
- `/api/v1/health` is exempt (returns alerts metadata anyway).
- `/api/v1/ping` is fully unauthenticated and root-level.
- Validation comparison via `crypto.timingSafeEqual`.
- Anti-brute-force: track failed auths per IP; 100 fails → 1h ban (in-memory map).

### 31.12. Rate Limiting
- Search endpoints (`*/lookup`, `*/releases/search`, `*/dashboard/search`): **30 req/min per IP**.
- Write endpoints (POST/PUT/PATCH/DELETE): **60 req/min per IP**.
- Read endpoints: unlimited.

### 31.13. Standard Headers
Server emits on every response:
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- `X-Frame-Options: SAMEORIGIN`
- `X-Powered-By` is **disabled**.
- `Access-Control-Allow-Origin`: configurable via `ALLOWED_ORIGINS` env (default `http://localhost:5173,http://127.0.0.1:5173`).
- `Access-Control-Allow-Headers: Content-Type, Authorization, X-API-Key, X-Request-Id`.

---

## 32. External API Contracts (Third-Party Providers)

### 32.1. TMDB (Films + Series)
- **Base:** `https://api.themoviedb.org/3`
- **Auth:** `?api_key=<TMDB_API_KEY>` query param.
- **Image base:** `https://image.tmdb.org/t/p/<size>`. Sizes: `w92, w154, w185, w342, w500, w780, w1280, original`.
- **Endpoints used:**
  - `GET /search/movie?query=&include_adult=false` — film lookup.
  - `GET /movie/{tmdbId}?append_to_response=release_dates,images,credits,videos,alternative_titles&include_image_language=en,null` — film detail.
  - `GET /search/tv?query=` — series lookup (TVDB fallback).
  - `GET /tv/{tmdbId}?append_to_response=external_ids,images,credits` — series detail.
- **Release date types** (films): `1=Premiere, 2=Limited Theatrical, 3=Theatrical, 4=Digital, 5=Physical, 6=TV`.
- **Certification source:** `release_dates.results[].iso_3166_1='US'.release_dates[].certification`.
- **Available versions extraction**: scan `release_dates[].note` and `alternative_titles.titles[].title` against the Edition Rules regex catalogue.

### 32.2. TVDB v4 (Series)
- **Base:** `https://api4.thetvdb.com/v4`
- **Auth:** OAuth-PIN flow:
  1. `POST /login` with `{ apikey, pin }` → `{ data: { token } }`. Token valid 30 days (Archivist refreshes after 23h to be safe).
  2. Subsequent calls: `Authorization: Bearer <token>`.
- **Endpoints used:**
  - `GET /search?query=&type=series&limit=20` — search.
  - `GET /series/{id}/extended?meta=translations` — full series + alternate titles.
  - `GET /series/{id}/episodes/{order}` — episode list per order: `default | official | alternate | dvd | absolute | regional`.
- **Image URLs:** TVDB returns absolute URLs.
- **Fallback:** if TVDB returns 0 results, fall back to TMDB-TV (`searchSeriesTmdb`).

### 32.3. MusicBrainz (Music)
- **Base:** `https://musicbrainz.org/ws/2`
- **Auth:** none (rate-limited to 1 req/sec; User-Agent required).
- **User-Agent:** `Archivist/2.0 (https://github.com/yourorg/archivist)`.
- **Endpoints used:**
  - `GET /artist?query=&limit=20&fmt=json` — artist search.
  - `GET /artist/{mbid}?inc=genres+tags+url-rels&fmt=json` — artist detail.
  - `GET /release-group?artist={mbid}&limit=100&offset=0&fmt=json&type=album|ep|single|compilation|live|remix|soundtrack` — releases.
  - `GET /release/{mbid}?inc=recordings&fmt=json` — track list.
- **Cover art:** `https://coverartarchive.org/release-group/{mbid}/front-500` (HTTP redirect).
- **Fanart enrichment:** `https://webservice.fanart.tv/v3/music/{mbid}?api_key=<FANART_API_KEY>`.
- **Rate limit guard:** 2-second floor between requests; 429/503/502 → exponential backoff (2s, 4s, 6s, max 3 retries).

### 32.4. ComicVine (Comics)
- **Base:** `https://comicvine.gamespot.com/api`
- **Auth:** `?api_key=<COMICVINE_API_KEY>&format=json`.
- **Endpoints used:**
  - `GET /search/?query=&resources=volume&field_list=...&limit=20` — series search.
  - `GET /volume/4050-{cvId}/?field_list=...` — series detail.
  - `GET /issues/?filter=volume:{cvId}&field_list=...&sort=issue_number:asc&limit=100&offset=0` — issue list.
- **Response wrapping:** `{ status_code, error, results }`. `status_code !== 1` → error.

### 32.5. IGDB (Games)
- **Base:** `https://api.igdb.com/v4`
- **Auth:** OAuth client-credentials via Twitch:
  1. `POST https://id.twitch.tv/oauth2/token` form-urlencoded `{client_id, client_secret, grant_type=client_credentials}`.
  2. Use returned `access_token` as `Authorization: Bearer <token>` + `Client-ID: <client_id>`.
- **Endpoints used:** POST with body in **Apicalypse** query language:
  ```
  POST /games
  body: search "The Witcher 3"; fields name,first_release_date,summary,cover.url,platforms.name,involved_companies.developer,involved_companies.company.name; limit 20;
  ```
- **Image URLs:** prefix with `https:` and replace `t_thumb` with `t_cover_big_2x` for large covers.
- **Rate limit:** 4 req/sec; Archivist enforces 1-second floor between requests.

### 32.6. Google Books + OpenLibrary (Books)
- **Google Books:** `https://www.googleapis.com/books/v1/volumes?q=&maxResults=40&orderBy=relevance&key=<GOOGLE_BOOKS_API_KEY>`.
- **OpenLibrary fallback:** `https://openlibrary.org/search/authors.json?q=&limit=20`.
- **Cover URLs:** `https://covers.openlibrary.org/a/olid/{olid}-L.jpg` for authors; `https://covers.openlibrary.org/b/isbn/{isbn}-L.jpg` for books.

### 32.7. Fanart.tv (Multi-media images)
- **Base:** `https://webservice.fanart.tv/v3`
- **Auth:** `?api_key=<FANART_API_KEY>`.
- **Endpoints used:**
  - `/movies/{tmdbId}` — movie images.
  - `/tv/{tvdbId}` — TV images.
  - `/music/{mbid}` — music images.
- **Image categories returned:** `movieposter, moviebackground, hdmovielogo, movielogo, moviebanner, hdmovieclearart, movieart, moviethumb, moviedisc, hdtvlogo, tvthumb, hdclearart, tvbanner, characterart, seasonposter, seasonthumb, seasonbanner, showbackground, artistthumb, artistbackground, hdmusiclogo, musiclogo, albumcover, cdart`.

### 32.8. OpenSubtitles v2 (Subtitles)
- **Base:** `https://api.opensubtitles.com/api/v1`
- **Auth headers:** `Api-Key: <key>`, `User-Agent: <appName> v2.0`. Optional JWT via `POST /login`.
- **Endpoints used:**
  - `GET /subtitles?imdb_id=&tmdb_id=&query=&languages=&season_number=&episode_number=&hearing_impaired=only|exclude&foreign_parts_only=only|exclude` — search.
  - `POST /download` body `{ file_id }` — get a temporary download URL.
- **Result fields:** `attributes.feature_details.title|year|episode_number|season_number`, `attributes.files[].file_id, file_name`, `attributes.language, download_count, hearing_impaired, foreign_parts_only, ratings, upload_date`.

### 32.9. FlareSolverr (Cloudflare Bypass)
- **Base:** user-configured URL (e.g. `http://192.168.1.5:8191`). Append `/v1`.
- **Request:** `POST /v1` JSON `{ cmd: 'request.get'|'request.post'|'sessions.create'|'sessions.list'|'sessions.destroy', url, maxTimeout: 60000, session?, cookies?: [...], userAgent? }`.
- **Response:** `{ status, message, solution: { url, status, headers, response, cookies, userAgent } }`.
- **Use cases in V2:**
  1. Cardigann indexer routing (per-indexer, when `useFlareSolverr=true`).
  2. Detail-page-to-magnet resolution (`download-manager.ts:resolveDetailPage`) — extracts magnet/torrent links from HTML responses.

---

## 33. The Embedded Torrent Engine — Concrete Settings

### 33.1. Default Session Settings
```ts
{
  downloadDir:           process.env.TORRENT_DOWNLOAD_DIR ?? './data/downloads',
  incompleteDir:         process.env.TORRENT_INCOMPLETE_DIR ?? './data/incomplete',
  incompleteDirEnabled:  false,
  resumeDir:             process.env.TORRENT_RESUME_DIR ?? './data/resume',
  torrentsDir:           process.env.TORRENT_FILES_DIR ?? './data/torrents',
  startAddedTorrents:    true,
  dhtEnabled:            true,
  pexEnabled:            true,
  lpdEnabled:            true,
  utpEnabled:            true,    // NB: V1 ships uTP but it's incomplete; ship TCP-only by default in V2
  peerHost:              process.env.TORRENT_PEER_HOST ?? '0.0.0.0',
  peerPort:              parseInt(process.env.TORRENT_TCP_PORT ?? '2425'),
  advertisedPeerPort:    parseInt(process.env.TORRENT_ADVERTISE_PORT ?? '2425'),
  dhtPort:               parseInt(process.env.TORRENT_DHT_PORT ?? '2426'),
  utpPort:               parseInt(process.env.TORRENT_UTP_PORT ?? '2427'),
  portForwardingEnabled: false,   // useless on CGNAT/public WiFi
  peerLimitGlobal:       1000,
  peerLimitPerTorrent:   200,
  cacheSize:             128,     // MB
  sequentialDownloadDefault: false,
  queueStalledEnabled:   false,
}
```

### 33.2. Torrent Status Enum (matches Transmission)
```ts
type TorrentStatus =
  | 'stopped'         // 0
  | 'check-pending'   // 1
  | 'checking'        // 2
  | 'queued-download' // 3
  | 'downloading'     // 4
  | 'queued-seed'     // 5
  | 'seeding'         // 6
  | 'orphaned'        // synthetic — Archivist-only, for leftover-files in download-dir
```

### 33.3. Engine Events
- `torrent:added` `(id)` — a new torrent was added.
- `torrent:removed` `(id)` — a torrent was removed.
- `torrent:complete` `(id)` — a torrent finished downloading wanted files.
- `torrent:error` `(id, error: string)` — fatal error.
- `torrent:progress` `(id, progress: number)` — emitted every ~1s during download.
- `torrent:peer-connected` `(id, peerId)` — debug-only.

### 33.4. Wanted-Progress Calculation
```ts
function getWantedProgress(t: SessionTorrent): number {
  if (t.status === 'seeding') return 1
  if (!t.files || t.files.length === 0) return t.progress
  const wantedFiles = t.files.filter(f => f.wanted)
  if (wantedFiles.length === 0) return t.progress
  let totalWanted = 0, totalDownloaded = 0
  for (const f of wantedFiles) { totalWanted += f.sizeBytes; totalDownloaded += f.downloadedBytes }
  return totalWanted > 0 ? Math.min(1, totalDownloaded / totalWanted) : 0
}

function isComplete(t: SessionTorrent): boolean {
  if (t.status === 'seeding') return true
  if (t.files && t.files.length > 0) {
    const wanted = t.files.filter(f => f.wanted)
    if (wanted.length === 0) return false
    return wanted.every(f => f.progress >= 0.999 || f.downloadedBytes >= f.sizeBytes)
  }
  return false
}
```

### 33.5. Download Monitor (V1's `modules/shared/monitor.ts`)
Runs every `MONITOR_INTERVAL_MS = 5000`:
1. Iterate every active torrent in the session.
2. For each: fan out to every library DB (films, series, music, comics, games, books).
3. Match torrent → DB row by `info_hash` (primary) or normalised title (fallback).
4. If found and torrent reports progress: update `download_progress`.
5. If `isComplete()` returns true:
   - Compute final wanted file paths.
   - Dispatch `RestorationCompleteEvent` → Vault organiser runs `organize<Module>(film, sourcePath)`.
   - Run `cleanTracks` (track cleaner) if enabled.
   - Run `autoAcquireSubtitle` if enabled.
   - Update DB row: `status='collected'`, `file_path=<finalPath>`, `quality=<parsed>`.
   - Persist quality snapshot.
   - Remove the torrent from the engine **only after** the file is hardlinked to the library — keep seeding from the original location.

### 33.6. Sample-File Detection
```ts
const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.ts', '.m4v', '.part'])
const SAMPLE_BLOCKLIST = (entry: string) => entry.toLowerCase().includes('sample')
                       || entry.toLowerCase() === 'proof'
                       || entry.toLowerCase() === 'screens'

// Reject: size < 70 MB OR filename matches blocklist
```

### 33.7. The "Largest Wanted File" Heuristic
For multi-file torrents (movie packs with extras): the main feature is the **largest wanted video file** (excluding samples/extras). Used by `organizeFilm` to identify which file to move into the library.

---

## 34. UI Pages — Concrete Layout

### 34.1. App Shell (`App.tsx`)
- React Router v6 `BrowserRouter`.
- Fixed-position `Sidebar` on left.
- `<main>` content offset by `ml-16` (collapsed) / `ml-52` (expanded).
- Global Konami code listener (`↑ ↑ ↓ ↓ ← → ← → b a Enter`) → "you retro nerd…" modal.
- ErrorBoundary wraps each route.

### 34.2. Sidebar (`Sidebar.tsx`)
- Logo + "ARCHIVIST" wordmark (clickable → toggle collapse).
- Nav items in this order:
  1. 🏠 Home (cyan)
  2. 🎬 Films (cyan, library tabs expand below)
  3. 📺 Series (violet)
  4. 🎵 Music (pink)
  5. 📚 Books (yellow)
  6. 🦸 Comics (orange)
  7. 🎮 Games (green)
  8. ⏬ Acquisitions (cyan)
  9. ⚙️ Settings (white)
- Library tabs: when a media-type group has >1 library, expand-arrow appears on hover; clicking switches active library; library context persisted to localStorage per media type.
- "+ Manage Libraries" link at bottom (links to /settings).

### 34.3. Dashboard (`Home/Dashboard.tsx`)
- **Header:** "DASHBOARD" big display title.
- **Library cards (grid):** 6 cards (Films/Series/Music/Books/Comics/Games), each shows:
  - Icon + label
  - Total count
  - Missing count (red badge)
  - Acquiring count (yellow badge)
  - Click → navigate to /films, /series, etc.
- **Calendar (3-week view):** 21-day grid starting Monday of previous week. Each day cell shows up to 3 media events (film theatrical/digital/physical release, episode airdate, album release, etc.). Click event → modal with full details + "Search Now" button → triggers auto-grab.
- **System telemetry:** CPU, RAM, Disk usage gauges via `systeminformation` package.
- **Active downloads:** unified list across built-in engine + qBittorrent + Transmission instances. Per-row controls: pause/resume/remove/recheck/reannounce.
- **Manual Search bar** (top): single input that fans out to all enabled indexers; results shown in a table below with grab buttons.
- **Add Media button** → opens UnifiedAddMedia modal with omni-search bar.
- **Refresh:** every 30 seconds for stats; calendar refreshes on offset change.

### 34.4. Films Page (`films/index.tsx`)
- **List view:**
  - Search input + sort dropdown + library tab switcher.
  - Filter chips: status (All/Wanted/Acquiring/Collected/Missing), monitored/unmonitored.
  - Selection bar: when selecting multiple, exposes "Bulk Edit", "Bulk Delete".
  - **Poster grid mode** (default): `grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6`; each card shows poster, title, year, status badge, download progress bar (if acquiring).
  - **Table mode** (toggle): rows with title, year, quality, status, size, added date.
- **Detail page:**
  - **Hero:** 600px tall; full-width blurred backdrop (`blur-sm opacity-40`); gradient overlay; bottom-left has poster (floating, heavy shadow), title (display font), year, runtime, certification badge, country flag, language flag chips, IMDB rating.
  - **Right rail (1/3 width):**
    - File info (path, size, codec, resolution, audio tracks, subtitle tracks, chapters).
    - TMDB / IMDB external links.
    - "Auto-Grab" button (cyan).
    - "Repair" button (yellow).
    - "Reject Current Release" button (red).
    - "Edit Metadata" button.
    - "Search Images" button.
  - **Main column (2/3 width):**
    - Storyline tab — overview text.
    - Cast tab — horizontal scroller of cast member cards (poster + name + character).
    - Crew tab — director/writer/producer chips.
    - Editions tab — list of FilmEdition rows; each shows edition name, file path, quality, "Set Default", "Rename", "Delete".
    - Acquisition History tab — table of past acquisition_decisions for this film.
    - Trailer player (YouTube embed if `videos[].site === 'YouTube' && type === 'Trailer'`).
- **Add modal:** TMDB lookup search; results show poster + title + year + already-added flag; click → POST to `/api/v1/films`.
- **Interactive Search modal:** SSE-streaming results table; filters for tier/resolution/source/codec; per-row "Grab" button + "Why?" tooltip showing rejection reasons.

### 34.5. Series Page (`series/index.tsx`)
- List view: same structure as Films but "Episodes" count instead of "Films".
- Detail page:
  - Hero: same shape as Films but with network + air-time.
  - Seasons accordion: each season row is collapsible; shows poster, episode count, downloaded count, monitor toggle.
  - Episodes within: row per episode with monitor toggle, status, file info (if downloaded), air date, individual "Search" button.
  - "Search Season" button at season level; "Search Episode" per-episode.
- Add modal: TVDB lookup with TMDB-TV fallback; preview shows seasons + episode count.

### 34.6. Music / Books / Comics / Games / Magazines / Podcasts
Mirror the films/series pattern with appropriate hierarchy:
- **Music:** Artists list → Artist detail (discography with album cards) → Album detail (track list).
- **Books:** Authors list → Author detail (bookography grouped by series) → Book detail.
- **Comics:** Series list → Series detail (issue grid).
- **Games:** Games list (no hierarchy) → Game detail.
- **Magazines:** Title list → Title detail (issue list).
- **Podcasts:** Show list → Show detail (episode list with playback / download).

### 34.7. Acquisitions Page (`acquisitions/index.tsx`)
Tabs:
- **Queue** — active downloads (from Dashboard's Downloads section).
- **History** — `system_events` filtered to grab/import/restore events; sortable, filterable.
- **Blocklist** — `release_blocklist` rows; per-row "Remove from Blocklist" button.
- **Manual Imports** — files in `<download-dir>` not yet imported; per-row: candidates dropdown, "Import" button.
- **Manual Search** — fan-out search across all indexers; same as Dashboard's manual search but with persistent results and history.

### 34.8. Settings Page (`settings/index.tsx`)
Tabs (top-level):
- **General** — bind address, port, URL base, branch, log level, theme.
- **Libraries** — Library tabs CRUD (add/edit/delete/move), root folders per library.
- **Quality** — three sub-tabs:
  - **Profiles** — quality profile CRUD with drag-to-reorder items.
  - **Definitions** — quality definitions size envelopes editor.
  - **Tiers** — Quality Tier editor: 3 tiers × N terms × N media types (multi-select chips).
- **Custom Formats** — custom format CRUD with specification builder.
- **Release Profiles** — required/ignored/preferred words editor.
- **Naming** — naming templates per media type with token autocomplete + live preview.
- **Media Management** — copy mode (hardlink/copy/move), delete-empty-folders, recycle bin path, file permissions.
- **Track Cleaner** — preferred language picker, toggles for keepOriginal/keepPreferred/keepCommentary, additional languages multi-select.
- **Subtitles** — provider picker (OpenSubtitles), API key, language, hearing-impaired/forced toggles, auto-acquire toggle.
- **Indexers** — indexer CRUD; "Add Indexer" wizard groups definitions by language/country/privacy.
- **Indexer Proxies** — FlareSolverr URL, HTTP/SOCKS proxies, per-indexer routing.
- **Download Clients** — qBit/Transmission/SAB/NzbGet adapters; "Test" button per client; built-in engine always present as id=-1.
- **Import Lists** — Trakt / Plex Watchlist / IMDb List CRUD per media type.
- **Connect (Notifications)** — Discord/Email/Webhook/Custom Script CRUD with event toggles + tag filtering.
- **Tags** — tag CRUD; per-tag list of associated indexers/clients/notifications/series/movies.
- **API Keys** — TMDB/TVDB/MusicBrainz/IGDB/ComicVine/Google Books/Fanart.tv keys; `tvdbPin` for v4 OAuth.
- **System** — backups (run + retention), maintenance (run + retention), integrity (run + repair), update mechanism.
- **About** — version, branch, commit hash, links.

### 34.9. Modal Components
- `Modal` — backdrop blur + centered dialog.
- `MissingSearchModal` — bulk-search dialog showing per-item progress.
- `EditionRenamerModal` — rename a film edition with optional "save as parsing rule" toggle.
- `ImagePickerModal` — preview + select from TMDB/Fanart.tv image search results.
- `MetadataEditorModal` — edit film/series fields with field-locking indicator.

### 34.10. Reusable UI Components
Headless behaviour from Radix UI / React Aria; Tailwind for styling.
- `SearchInput` — input with clear button.
- `Select` — dropdown.
- `Toggle` — toggle switch.
- `Field` — labelled wrapper (label, hint, error).
- `Input` — styled text input.
- `Spinner` — loading indicator.
- `TabSelect` — segmented control.
- `LibraryCard` — clickable card.
- `CollectionFilterBar` — filter chip rail.
- `SelectionBar` — bulk-action bar.
- `EmptyState` — empty-state placeholder.
- `StatusBadge` — colored status pill.
- `ReleaseList` — release-row table (used in interactive search).
- `PosterSkeleton` — loading skeleton.
- `QualityPolicyPanel` — quality profile selector + tier/resolution/source/codec dropdowns.

---

## 35. Configuration — Concrete Schemas

### 35.1. `config.toml` (Pre-DB)
```toml
[server]
host = "0.0.0.0"
port = 2424
url_base = ""
allowed_origins = "http://localhost:5173,http://127.0.0.1:5173"
json_limit = "1mb"

[auth]
api_key = ""                              # generated on first run if empty
auth_method = "none"                      # none | basic | forms
auth_required = "disabled-for-local-addresses"
anti_brute_force_enabled = true
anti_brute_force_threshold = 100

[paths]
data_dir = "./data"
media_dir = "./media"
logs_dir = "./logs"
backups_dir = "./data/backups"
allowed_roots = ""                        # comma-separated; if non-empty, sandbox file ops

[database]
path = "./data/archivist.sqlite"
wal = true
synchronous = "normal"
busy_timeout_ms = 5000

[update]
branch = "main"                           # main | develop | nightly
mechanism = "auto"                        # auto | external | docker

[telemetry]
enabled = false

[log]
level = "info"
file_size_limit_kb = 1024
file_count = 5

[torrent]
download_dir = "./data/downloads"
incomplete_dir = "./data/incomplete"
resume_dir = "./data/resume"
torrents_dir = "./data/torrents"
peer_host = "0.0.0.0"
peer_port = 2425
advertise_port = 2425
dht_port = 2426
utp_port = 2427
peer_limit_global = 1000
peer_limit_per_torrent = 200
cache_size_mb = 128
```

### 35.2. Required Environment Variables
None of these are required to start the server — every API key has graceful fallback that disables the relevant integration.

| Env Var | Required For |
|---|---|
| `TMDB_API_KEY` | Films + Series TMDB lookup |
| `TVDB_API_KEY` + `TVDB_PIN` | Series detail (v4 OAuth) |
| `GOOGLE_BOOKS_API_KEY` | Books search (rate-limited without) |
| `COMICVINE_API_KEY` | Comics |
| `IGDB_CLIENT_ID` + `IGDB_CLIENT_SECRET` | Games |
| `FANART_API_KEY` | Image enrichment (defaults to a public key) |
| `OPENSUBTITLES_API_KEY` (in `app_settings.subtitles`) | Subtitles |
| `REMOTE_PATH_MAP` | "remote:local,remote2:local2" path translation |
| `ARCHIVIST_DEFINITIONS_PATH` | Cardigann definition directory |
| `ARCHIVIST_API_TOKEN` (or `ARCHIVIST_AUTH_TOKEN`) | API auth (if empty, auth disabled) |
| `ARCHIVIST_PORT` / `PORT` | HTTP port |
| `ARCHIVIST_HOST` / `HOST` | Bind address |
| `ARCHIVIST_MEDIA_BASE` | Media root for new libraries |
| `ARCHIVIST_DOWNLOAD_DIR` | Holding pen / staged downloads |
| `ARCHIVIST_BACKUP_DIR` | Backup destination |
| `ARCHIVIST_SHARED_DB` | Override DB path |

### 35.3. `app_settings` Default Rows
On first DB init, seed the following keys:

```ts
app_settings = [
  ['naming', JSON.stringify(DEFAULT_NAMING)],
  ['mediaManagement', JSON.stringify(DEFAULT_MEDIA)],
  ['flaresolverr', JSON.stringify({ url: '', enabled: false })],
  ['acquisitionDefaults', JSON.stringify({ tier: 'Any', resolution: 'Any', source: 'Any', codec: 'Any' })],
  ['qualityTiers', JSON.stringify(DEFAULT_TIERS)],
  ['trackCleaner', JSON.stringify(DEFAULT_TRACK_CLEANER)],
  ['subtitles', JSON.stringify(DEFAULT_SUBTITLE_CONFIG)],
  ['systemMaintenance', JSON.stringify(DEFAULT_MAINTENANCE_CONFIG)],
  ['systemBackups', JSON.stringify(DEFAULT_BACKUP_CONFIG)],
  ['systemIntegrity', JSON.stringify(DEFAULT_INTEGRITY_CONFIG)],
  ['uiPreferences', JSON.stringify({ theme: 'noir', firstDayOfWeek: 'monday', dateFormat: 'YYYY-MM-DD', timeFormat: '24h' })],
]
```

### 35.4. Default Maintenance / Backup / Integrity Config
```ts
DEFAULT_MAINTENANCE_CONFIG = {
  enabled: true,
  intervalHours: 24,
  jobRetentionDays: 30,
  eventRetentionDays: 30,
  importRetentionDays: 60,
  acquisitionRetentionDays: 30,
  staleRunningJobMinutes: 120,
  checkpointDatabases: true,
}

DEFAULT_BACKUP_CONFIG = {
  enabled: true,
  intervalHours: 24,
  retentionCount: 7,
  includeTorrentState: true,
  encryption: false,        // V2: optional AES-256-GCM
  passphrase: '',           // V2: user-provided
}

DEFAULT_INTEGRITY_CONFIG = {
  enabled: true,
  intervalHours: 12,
  recordCleanScans: false,
  backupBeforeRepair: true,
}
```

---

## 36. NFO Schemas (Kodi-Compatible)

### 36.1. `<film name>.nfo` (Movie)
```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>{title}</title>
  <originaltitle>{original_title}</originaltitle>
  <year>{year}</year>
  <plot>{overview}</plot>
  <runtime>{runtime}</runtime>
  <mpaa>{certification}</mpaa>
  <uniqueid type="tmdb" default="true">{tmdb_id}</uniqueid>
  <uniqueid type="imdb">{imdb_id}</uniqueid>
  <genre>{genre1} / {genre2} / ...</genre>
  <studio>{studio}</studio>
  <country>{country}</country>
  <rating>{rating}</rating>
</movie>
```
Filename: `{Movie Title} ({Year}).nfo` next to the video file.

### 36.2. `tvshow.nfo` (Series)
```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>{title}</title>
  <originaltitle>{original_title}</originaltitle>
  <showtitle>{title}</showtitle>
  <plot>{overview}</plot>
  <runtime>{runtime}</runtime>
  <thumb aspect="poster">{poster}</thumb>
  <fanart><thumb>{backdrop}</thumb></fanart>
  <mpaa>{certification}</mpaa>
  <uniqueid type="tvdb" default="true">{tvdb_id}</uniqueid>
  <uniqueid type="imdb">{imdb_id}</uniqueid>
  <uniqueid type="tmdb">{tmdb_id}</uniqueid>
  <genre>{genres}</genre>
  <studio>{network}</studio>
  <country>{country}</country>
  <status>{status}</status>
  <namedseason number="1">Season 1 Title</namedseason>
</tvshow>
```
Path: `<series root>/tvshow.nfo`.

### 36.3. `season.nfo` (Per-Season)
```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<season>
  <seasonnumber>{season_number}</seasonnumber>
  <title>{title}</title>
  <plot>{overview}</plot>
  <thumb aspect="poster">{poster}</thumb>
</season>
```
Path: `<series root>/Season XX/season.nfo`.

### 36.4. `<episode>.nfo` (Per-Episode)
```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<episodedetails>
  <title>{title}</title>
  <showtitle>{series_title}</showtitle>
  <season>{season_number}</season>
  <episode>{episode_number}</episode>
  <aired>{air_date}</aired>
  <runtime>{runtime}</runtime>
  <plot>{overview}</plot>
  <thumb>{still}</thumb>
  <uniqueid type="tvdb" default="true">{tvdb_episode_id}</uniqueid>
  <fileinfo>
    <streamdetails>
      <video><codec/><width/><height/><durationinseconds/></video>
      <audio><codec/><language/><channels/></audio>
      <subtitle><language/></subtitle>
    </streamdetails>
  </fileinfo>
</episodedetails>
```
Filename: same basename as the video file but `.nfo`.

### 36.5. Album / Track / Author / Comic NFOs
- `album.nfo` at `<artist>/<album>/album.nfo` with `<musicbrainzalbumid>`, `<title>`, `<artist>`, `<year>`, `<genre>`, `<releasedate>`, `<thumb>`.
- `<track>.nfo` per track (rare; usually skipped).
- `author.nfo` at `<author>/author.nfo` with name, overview, image_url.

### 36.6. Asset Files Alongside Media
Per Plex/Kodi convention, save:
- `poster.jpg` — main poster (~600×900).
- `backdrop.jpg` — fanart (~1920×1080).
- `logo.png` — series/movie logo with transparency.
- `banner.jpg` — series banner (~758×140).
- `clearart.png` — clear art with transparency.
- `thumb.jpg` — backdrop thumbnail.
- `disc.png` — disc art (films only).
- `season01-poster.jpg` — per-season poster (TV).
- `<episode>-thumb.jpg` — per-episode thumbnail (TV).

---

## 37. The Job Runner — Concrete Behaviour

```ts
const POLL_INTERVAL_MS = 2_000

function startJobRunner() {
  if (timer) return
  timer = setInterval(() => runOnce().catch(handleError), POLL_INTERVAL_MS)
  runOnce().catch(handleError) // initial tick
}

async function runOnce() {
  if (running) return
  running = true
  try {
    const job = claimNextJob([...handlers.keys()])  // SQL UPDATE-WHERE-status='queued' returning row
    if (!job) return

    const handler = handlers.get(job.type)
    if (!handler) { failJob(job.id, `No handler for type "${job.type}"`); return }

    recordEvent({ category: 'job', action: 'started', subjectType: 'job', subjectId: String(job.id), message: `Started job ${job.type} #${job.id}`, data: { type: job.type, attempts: job.attempts } })

    try {
      await handler(job)
      completeJob(job.id)
      recordEvent({ category: 'job', action: 'succeeded', subjectType: 'job', subjectId: String(job.id), message: `Completed job ${job.type} #${job.id}` })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failJob(job.id, message)
      recordEvent({ category: 'job', action: 'failed', severity: 'error', subjectType: 'job', subjectId: String(job.id), message, data: { type: job.type } })
    }
  } finally { running = false }
}

function failJob(id: number, error: string) {
  const job = getJob(id)
  if (!job) return
  if (job.attempts < job.maxAttempts) {
    // Retry with exponential backoff: min(60s, 1s × 2^(attempts-1))
    const delayMs = Math.min(60_000, 1000 * Math.pow(2, Math.max(0, job.attempts - 1)))
    db.prepare(`
      UPDATE system_jobs SET status='queued', last_error=?, available_at=?, locked_at=NULL, updated_at=datetime('now')
      WHERE id=?
    `).run(error, new Date(Date.now() + delayMs).toISOString(), id)
    return
  }
  finishJob(id, 'failed', error)
}
```

---

## 38. Final Coverage Additions (Concrete)

In addition to §23:

- [ ] All 12 specialised media tables created with full column lists from §27.
- [ ] All M:N tag join tables present.
- [ ] Default seeded data on first boot: 5 quality profiles, 3 quality tiers per media type, 8 edition rules.
- [ ] Lexical parser produces every field of `ParsedRelease` per §28.1.
- [ ] All tier regex patterns from §28.5 byte-equivalent.
- [ ] `validateFilmRelease` scoring per §28.6 (constants exact).
- [ ] `performTieredSearch` algorithm per §28.7.
- [ ] Track cleaner with full LANG_MAP + classification rules per §29.
- [ ] All naming tokens per §30.1 implemented.
- [ ] All 6 MultiEpisodeStyle modes per §30.3.
- [ ] Hono RPC endpoints per §31 with Zod validation on POST/PUT bodies.
- [ ] SSE event stream per §31.10 with all named events.
- [ ] Anti-brute-force per §31.11.
- [ ] Rate limiting per §31.12 (30/min search, 60/min write).
- [ ] Standard security headers per §31.13.
- [ ] All 9 external API contracts per §32 (TMDB / TVDB / MusicBrainz / ComicVine / IGDB / Google Books / OpenLibrary / Fanart.tv / OpenSubtitles / FlareSolverr).
- [ ] Torrent engine settings per §33.1 with all 8 torrent status values.
- [ ] Engine emits all 5 event types per §33.3.
- [ ] Wanted-progress + isComplete per §33.4 byte-equivalent.
- [ ] Sample-file rejection per §33.6.
- [ ] Largest-wanted-file heuristic per §33.7.
- [ ] All 9 UI pages per §34 with their listed sub-tabs and components.
- [ ] Dashboard with library cards + 3-week calendar + telemetry + downloads per §34.3.
- [ ] Settings tabs all 17 per §34.8 implemented.
- [ ] `config.toml` with all sections per §35.1.
- [ ] All env vars per §35.2 honoured.
- [ ] All 4 NFO schemas per §36 (movie, tvshow, season, episodedetails).
- [ ] Asset files written per §36.6 (poster.jpg, backdrop.jpg, logo.png, banner.jpg, clearart.png, thumb.jpg, disc.png, season01-poster.jpg, episode-thumb.jpg).
- [ ] Job runner with 2s poll + exponential backoff per §37.
- [ ] All Zod schemas from §31 enforce request validation.

---

## 39. Quick-Reference Constants

```ts
// HTTP timeouts
const TIMEOUT_SHORT = 5_000
const TIMEOUT_DEFAULT = 10_000
const TIMEOUT_LONG = 15_000

// FlareSolverr
const FLARE_MAX_TIMEOUT = 90_000
const FLARE_AXIOS_TIMEOUT = 100_000
const FLARE_SESSION_TTL_MS = 30 * 60 * 1_000

// Download monitor
const MONITOR_INTERVAL_MS = 5_000

// Indexer search
const MAX_BASE_URLS_TO_TRY = 3
const SEARCH_TIMEOUT_MS = 45_000
const RSS_TIMEOUT_MS = 60_000
const RELEASE_PIPELINE_TICK_MS = 30_000
const RELEASE_PIPELINE_STARTUP_DELAY_MS = 5_000
const RELEASE_PIPELINE_MAX_CONCURRENT = 4
const TITLE_INDEX_REFRESH_MS = 2 * 60_000
const MISSING_SEARCH_INTERVAL_MS = 6 * 60 * 60 * 1000   // 6h
const MISSING_SEARCH_STARTUP_DELAY_MS = 60_000
const MISSING_SEARCH_ITEM_COOLDOWN_MS = 4 * 60 * 60 * 1000
const MISSING_SEARCH_MAX_ITEMS_PER_CYCLE = 10
const MISSING_SEARCH_PER_TIMEOUT_MS = 30_000
const MISSING_SEARCH_INTER_DELAY_MS = 750

// Release scoring (must match V1 byte-for-byte)
const SCORE_TITLE_MATCH = 1_000
const SCORE_YEAR_EXACT = 5_000
const SCORE_YEAR_ADJACENT = 500
const SCORE_NO_TITLE = -5_000
const SCORE_NO_YEAR = -3_000

// Torrent engine
const TORRENT_PEER_LIMIT_GLOBAL = 1000
const TORRENT_PEER_LIMIT_PER_TORRENT = 200
const TORRENT_CACHE_MB = 128

// Sample detection
const SAMPLE_SIZE_THRESHOLD_BYTES = 70 * 1024 * 1024  // 70 MB

// Indexer escalation backoff (per Sonarr/Radarr/Prowlarr pattern)
const INDEXER_BACKOFF_MS = [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
  8 * 60 * 60_000,
  24 * 60 * 60_000,
]

// Per-series refresh cadence
const SERIES_REFRESH_AIRING_SOON_MS = 60 * 60_000     // 1h if airing within 24h
const SERIES_REFRESH_TBA_MS = 12 * 60 * 60_000        // 12h for TBA
const SERIES_REFRESH_CONTINUING_MS = 24 * 60 * 60_000 // daily
const SERIES_REFRESH_ENDED_MS = 7 * 24 * 60 * 60_000  // weekly
```

---

## 40. The Final Word

This document is now complete enough to rebuild Archivist V2 from scratch with no access to V1's source code:

- Sections 1–26 give the strategic architecture, departments, lifecycle, and phased build plan.
- Sections 27–39 give the concrete implementation surface — every column, every endpoint, every algorithm, every constant.
- Cross-references to `radarr-audit.md`, `sonarr-audit.md`, `prowlarr-audit.md`, `transmission-audit.md` cover the upstream behaviours Archivist mimics. Where any of those documents conflict with this one for V2 build decisions, **this document wins**.

A re-implementer working from this document alone should be able to deliver a feature-complete V2 on the modern stack defined in `ARCHITECTURE.md` in approximately 24 weeks per the phased build plan in §20. The riskiest components (in descending order):

1. **Cardigann YAML execution engine** (4–6 weeks) — see `prowlarr-audit.md`.
2. **Embedded torrent engine hardening** (8–12 weeks) — see `transmission-audit.md`.
3. **Lexical parser** (2–3 weeks) — concrete spec in §28.
4. **Track cleaner** (1–2 weeks) — concrete spec in §29.
5. **Unified database migration** (1 week) — schema in §27.

Everything else is well-trodden Node.js + React work.

The Archivist museum is open. Build it.
