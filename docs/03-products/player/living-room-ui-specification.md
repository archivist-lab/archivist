---
title: "Archivist Player Living-Room UI Engineering Specification"
document_type: product-specification
status: historical
classified: 2026-08-16
---
# Archivist Player Living-Room UI Engineering Specification

Status: implementation-ready specification; no production implementation is included in this document.  
Reference baseline: Arctic Fuse 3 `omega`, observed 2026-07-12.  
Target release name: **Archivist Player Living-Room UI v2**.  
Decision owner: Archivist architecture.  

## 1 Executive Summary

Archivist Player must be rebuilt from a mouse-first web catalogue into a remote-first, focus-driven living-room interface. The present application borrows backdrop and rail styling, but it does not reproduce the system that makes Arctic Fuse 3 feel coherent: a persistent edge navigation rail, composable hubs, focus-driven artwork and information, deterministic directional navigation, layered dialogs, view modes, focus memory, and a low-latency video on-screen display (OSD).

The target is behavioral and experiential parity, not source or asset parity. Implementation MUST be clean-room and MUST NOT copy Arctic Fuse 3 XML, media, fonts, icons, strings, layout constants, names, screenshots, or branding. Arctic Fuse 3 is licensed under CC BY-NC-SA 4.0; adapting those materials could impose non-commercial and share-alike conditions. Archivist will reproduce independently observed interaction principles using Archivist-owned TypeScript, CSS, tokens, copy, and assets.

The honest assessment is that a CSS reskin is insufficient. The frontend navigation, state model, home composition, data-loading strategy, details pages, search, settings, and OSD all require structural work. The server must add server-backed UI preferences and richer paginated hub payloads. Playback transport and media probing remain intact. No new media engine, native TV application, external service, worker, queue, or plugin loader is introduced.

Research basis:

- [Arctic Fuse 3 repository](https://github.com/jurialmunkey/skin.arctic.fuse.3), including its hub, widget, dialog, view, and OSD file structure.
- [Arctic Fuse 3 Kodi forum thread](https://forum.kodi.tv/showthread.php?tid=383722). The forum rejected automated page access; conclusions from that thread are limited to search-indexed excerpts and are identified as user feedback, not normative behavior.
- [Arctic Fuse predecessor mode explanation by the same maintainer](https://forum.kodi.tv/showthread.php?pid=3182522), used only to understand the Classic, Categories, Compound, and Combined composition vocabulary that AF3 continues to expose.
- [Arctic Fuse OSD performance issue and maintainer response](https://github.com/jurialmunkey/skin.arctic.fuse.2/issues/513), used to establish the requirement that the first OSD layer perform no blocking fetch or expensive blur.

## 2 Goals

1. Make every primary player workflow fully operable with a D-pad, Enter/OK, Back, Play/Pause, and browser keyboard.
2. Replace the fixed top navigation with a persistent left edge rail that expands on focus and never permits Settings to become unreachable.
3. Introduce Home, Films, Series, and TV hubs with spotlight information, stacked widgets, selectable categories, focus-driven backdrops, and remembered focus.
4. Ship four deterministic layout presets: `classic`, `categories`, `compound`, and `combined`; default to `categories`.
5. Make focused media the source of backdrop, logo/title, metadata, plot, progress, and contextual action state.
6. Provide poster, landscape, wall, and list presentations with exact focus and information behavior.
7. Redesign film and series details as remote-first information surfaces with Play/Resume as the initial action and predictable season/episode traversal.
8. Redesign search as a full-screen hub with grouped Films, Series, and Episodes results and remote-friendly text entry.
9. Replace the playback controls with a layered, instant OSD supporting seek, audio, subtitles, video mode, information, queue, and Up Next.
10. Preserve direct play, compatibility transcoding, subtitle extraction, loudness normalization, channels sessions, progress synchronization, opaque stream URLs, and the limited port `4242` security boundary.
11. Persist UI preferences on the Archivist server while maintaining responsive local state and deterministic conflict handling.
12. Meet explicit latency, accessibility, memory, error-recovery, test, rollout, and rollback requirements.

## 3 Non Goals

1. Do not copy, vendor, translate, or execute Kodi skin XML or Python.
2. Do not include Arctic Fuse 3 artwork, icons, textures, fonts, screenshots, names, logos, or trademarked presentation in the product.
3. Do not make Archivist a Kodi addon or require Kodi, TMDb Helper, Skin Variables, Texture Maker, or any Kodi dependency.
4. Do not add music, books, comics, games, weather, addons, trailers, internet discovery, or external streaming providers to the Player in this release.
5. Do not replace FFmpeg, browser `<video>`, direct-play policy, transcode policy, loudness analysis, subtitle conversion, or Channels scheduling.
6. Do not add household user accounts, PIN-protected profiles, parental controls, remote WAN pairing, or a native Android/Apple/Roku/Fire TV client.
7. Do not expose acquisition, torrent, indexer, file path, quality-policy administration, or server operations through the Player.
8. Do not introduce a plugin runtime, arbitrary third-party widgets, executable themes, custom CSS upload, or remote script loading.
9. Do not promise pixel identity across browsers. The measurable target is interaction, hierarchy, motion, density, and OSD parity defined here.
10. Do not remove the legacy UI until the staged rollout and rollback window in sections 32 and 33 is complete.

## 4 Existing Architecture

### 4.1 Runtime and ownership

`apps/player` is a React 18, React Router 6, TypeScript, Vite, and Tailwind SPA. A single Archivist server process serves the admin/API listener on `2424` and the Player listener on `4242`. `apps/server/src/player-frontend.ts` delegates only `/api/v1/player/*` and `/media/*` to the main Express application, injects the service token server-side, and serves the static Player bundle. The browser never receives the service token.

### 4.2 Current UI

- `App.tsx` owns a fixed top navigation, expanding search field, and routes.
- `Home.tsx` resolves user-configured rails client-side and rotates a hero every nine seconds.
- `Library.tsx` provides poster, wall, and list modes with mouse-oriented controls.
- Film and series details use full-bleed backdrops and basic Play actions.
- Series details provide seasons and episode rows but not a persistent spatial focus graph.
- `Player.tsx` and `SessionPlayer.tsx` implement direct play, fallback transcoding, progress, tracks, subtitles, loudness, keyboard shortcuts, and auto-hidden controls.
- `store.ts` stores customization and a progress mirror in `localStorage`; playback progress is also persisted in SQLite.
- `sdk.ts` contains duplicated public types and a 30-second process-memory cache.

### 4.3 Current server and data

`apps/server/src/player/routes.ts` serializes film, series, episode, library, home, progress, channel, playback-session, stream, track, subtitle, transcode, and loudness responses directly inside one router file. `playback_progress` is keyed by `(profile_id, media_type, media_id)`. The API spans libraries and intentionally does not expose file paths. There is no server-backed player preference document, no paginated hub contract, no episode search group, and no UI telemetry route.

### 4.4 Gap analysis

| Area | Current behavior | Required behavior | Severity |
|---|---|---|---|
| Navigation | top bar; mouse hover; browser tab order | expanding edge rail; D-pad graph; focus memory; Back hierarchy | Architectural |
| Home | independent rails and timed hero | one focused context; categories; presets; stacked/combined modes | Architectural |
| Focus | CSS `:focus` on individual controls | central focus registry, directional scoring, modality, restoration | Blocking |
| Information | metadata tied to page or card | focused item drives backdrop, logo, plot, badges, actions | Major |
| Views | poster/wall/list toggles | poster, landscape, wall, list with view-specific info guarantees | Major |
| Search | text field plus flat film/series results | remote-first search hub; grouped films/series/episodes | Major |
| Details | mouse-first document layout | focus zones, action row, seasons, episode continuation | Major |
| OSD | one overlay with nested track menu | instant base OSD plus separate panels and Up Next | Architectural |
| Settings | rail editor optimized for pointer | safe preset wizard, preview, focus-safe editor, reset/undo | Major |
| State | local-only UI settings | optimistic server persistence with revision conflicts | Major |
| Performance | unbounded library rendering | paging, virtualization/windowing, image budgets, no-fetch OSD | Blocking for TV hardware |
| Licensing | “Arctic Fuse-inspired” comments only | explicit clean-room boundary and attribution record | Release blocker |

### 4.5 Reference design and user-feedback findings

The reference is excellent at information choreography, not merely dark styling. Its strongest idea is that one focused item coordinates the backdrop, identity, metadata, plot, actions, and neighboring content. Archivist currently presents attractive surfaces but does not coordinate them through a single focus context. That is why it looks adjacent to the reference without feeling like it.

| Observed finding | Honest assessment | Binding Archivist response |
|---|---|---|
| Multiple composition modes and source-by-view widgets create exceptional flexibility. | This is the reference’s defining strength. A single hardcoded home page would miss the product. | Ship four presets and a bounded source/view editor; store the result server-side. |
| Users report difficulty understanding modes, shortcuts, and widget setup. | Copying the configurability without onboarding would reproduce a known weakness. | Default to Categories, show original schematic previews, use drafts, require Save, provide reset, and document every mode. |
| The minimized/visible edge rail makes large content areas possible. | It is substantially better for a TV than Archivist’s fixed top navigation. | Replace top navigation with the expanding side rail and semantic focus restoration. |
| Users can make navigation or Settings difficult to recover in highly configurable skins. | A self-removing recovery surface is unacceptable. | Home, Search, and Settings cannot be disabled; Settings owns a stable direct route and Reset action. |
| Poster and landscape selection per widget is repeatedly valued. | Presentation belongs to the content purpose, not to a global card style. | Keep source and view independent for every supported widget. |
| Wall views can feel information-poor while moving across posters. | Dense art without context is visually impressive but functionally weak. | Wall always reserves a right-side information panel driven by focus. |
| Clear identity and plot information during pause are valued, while constant technical clutter is divisive. | Playback information should be layered and intentional. | Base OSD stays minimal; pause expands identity/plot after 600 ms; detailed media data lives in Info/Audio/Subtitle/Video panels. |
| OSD opening has caused frame skip on constrained devices in the reference lineage; simplifying the initial layer improved reports. | Visual sophistication cannot come at the cost of video continuity. | First OSD frame has zero fetch, image decode, media probe, or live blur and must appear within 50 ms p95. |
| Large widget directories and visual effects can tax or crash low-power devices. | A beautiful UI that only behaves well on a desktop fails the living-room requirement. | Paginate on the server, window on the client, cap DOM/artwork/cache memory, and test a 2 GB constrained client. |
| Simplified search hubs and season selectors receive positive feedback. | These reduce navigation depth and should be treated as primary surfaces. | Search is a grouped hub with a remote keyboard; series has persistent season tabs and focus-preserving episode traversal. |
| “Play next” behavior has produced integration edge cases in related skins/builds. | Automatic advance must be a tested state machine, not a timer attached to an overlay. | Define exact eligibility, threshold, countdown, cancel, failure, Channels ownership, and film exclusion rules. |

Forum research caveat: the supplied Kodi thread returned HTTP 403 to automated access. No protected post was scraped or quoted. The table uses the public reference repository, maintainer-authored public explanations, a public GitHub issue, and search-indexed themes from the supplied thread. Product decisions are based on converging behavior and feedback, not on an unverifiable individual comment.

## 5 Proposed Architecture

### 5.1 Module ownership

- **Community** owns the complete Player UI in `apps/player`. This is the ordinary consumption experience and MUST NOT be licence-gated.
- **Shared** owns Player request/response and preference types in `packages/contracts/src/player.ts` and persistence schema in `packages/db`.
- **Core** owns the stable consumer API adapter in `apps/server/src/player` because it translates Archivist domain data into public consumption contracts.
- **Pro** and **Enterprise** own no part of this feature.
- **Plugin** owns no part of this feature. No plugin interface changes and no UI injection hooks are permitted in this release.

### 5.2 Frontend layers

1. `App.tsx` performs bootstrap and selects legacy or v2 UI from the server flag.
2. `PlayerShell` owns routes, the side rail, modal stack, global backdrop, toast region, and input modality.
3. `FocusProvider` owns the registered focus graph, directional movement, restoration, scroll alignment, and Back dispatch.
4. Hub pages request server-composed widget descriptors and item pages, then render `Hub`, `Spotlight`, `Rail`, and `Cards` primitives.
5. `PlayerStore` owns normalized bootstrap, preferences, focus memory, modal state, media context, and progress mirror.
6. `ArchivistSdk` is the only network client and consumes types from `@archivist/contracts`.
7. `VideoOsd` is rendered over the existing playback engine and must not own stream selection or progress persistence.

### 5.3 Backend layers

1. `routes.ts` validates HTTP input, calls services, returns public contracts, and maps typed errors to status codes.
2. `serializers.ts` converts database rows into public media contracts; it is the only player module allowed to inspect media table columns.
3. `hub-service.ts` composes paginated widget sources using bounded SQL queries.
4. `preferences.ts` validates, seeds, reads, updates, resets, and revision-controls preference documents.
5. `telemetry.ts` aggregates optional anonymous client performance samples in memory; it does not persist events or contact an external endpoint.
6. `config.ts` parses Player UI environment variables once and exposes an immutable configuration object.

### 5.4 Request sequence

On startup the client requests `/api/v1/player/ui/bootstrap?profile=default`. When v2 is disabled, it renders the existing legacy route tree. When enabled, it hydrates preferences, libraries, progress, capabilities, and the initial Home hub, paints the shell, restores Home focus, and preloads only the focused item backdrop. No other widget artwork is eagerly decoded.

### 5.5 Plugin architecture

No repository Player plugin loader exists. This release MUST NOT create one indirectly. No plugins are affected, no plugin contract changes, no extension point is added, and no hook is exposed. Future plugins may consume the public Player API as external clients but may not inject components or widget sources. A future plugin RFC must define signature verification, permissions, API versioning, failure isolation, CSP, and UI review before any injection mechanism is accepted.

## 6 Architectural Decisions

### AD-001 — Clean-room experiential implementation

Decision: reproduce documented behavior and hierarchy using original Archivist code and assets. Do not derive code or assets from the reference repository. Reason: Arctic Fuse 3 is CC BY-NC-SA 4.0, while Archivist’s distribution model must remain independently licensable. Consequence: exact source-level and asset-level parity is explicitly rejected.

### AD-002 — Remote-first, pointer-compatible

Decision: directional focus is the authoritative navigation model. Pointer hover may update focus only after 80 ms of stable hover and may never create state unavailable to remote users. Touch uses direct activation. Reason: living-room behavior cannot be layered onto browser tab order.

### AD-003 — Internal focus engine, no runtime dependency

Decision: implement a small deterministic focus engine in two owned files rather than adopt a third-party spatial-navigation package. Reason: the required zone rules, restoration, scroll behavior, modal trapping, and long-press semantics are narrow and must remain stable. The algorithm is specified in section 12.3.

### AD-004 — Server-backed versioned preferences

Decision: persist one JSON preference document per `profile_id` with schema version and optimistic revision. Keep only session state and a write-through cache in the browser. Reason: TV/browser devices must share layout and playback preferences, while revision control prevents last-writer data loss.

### AD-005 — Stable v1 API with additive endpoints

Decision: retain `/api/v1/player`. Add contracts without changing or removing existing response fields. Existing clients continue to work. Reason: the player-facing boundary is already designated stable.

### AD-006 — Server-composed widgets, client-rendered layouts

Decision: the server determines item membership and pagination; preferences determine order and presentation; the client renders. Reason: the current client downloads whole libraries to resolve rails, which is not acceptable for large collections or TV hardware.

### AD-007 — One playback engine, layered OSD

Decision: retain current stream/transcode/session behavior and replace only presentation and interaction around it. Reason: playback policy is functional and independent of the skin experience.

### AD-008 — Low-cost compositing

Decision: use gradients, opacity, transforms, and pre-rendered artwork. Do not apply live blur or backdrop-filter over playing video. Reason: user reports in the reference ecosystem show OSD stutter on constrained devices when overlays are expensive.

### AD-009 — Four presets, bounded customization

Decision: expose exactly `classic`, `categories`, `compound`, and `combined`. Users can reorder, enable, and restyle supported widgets but cannot inject arbitrary URLs, HTML, CSS, or JavaScript. Reason: this captures the reference composition model without creating an unsafe theme platform.

### AD-010 — Settings is a protected navigation destination

Decision: Settings is always present as the final edge-rail item, cannot be disabled, and Reset is always reachable at `/settings?section=interface`. Reason: user feedback indicates configuration systems become unrecoverable when navigation can remove their own recovery surface.

### AD-011 — No new background infrastructure

Decision: no queue, cron job, scheduler, worker, event bus, or persistent telemetry table is added. Hub reads and preference writes are synchronous bounded requests. Existing loudness and Channels background behavior is unchanged.

### AD-012 — Feature-flagged replacement

Decision: deploy v2 and legacy UI in one bundle and select at runtime from server configuration. Reason: a UI architecture replacement needs an immediate rollback that does not require a new image.

## 7 Repository File Tree

Legend: `[M]` modify, `[N]` new, `[V]` verify with no content change, `[D]` delete after the final rollback window.

```text
.
├── .env.example                                           [M]
├── .github/workflows/verify.yml                           [N]
├── Dockerfile                                             [V]
├── docker-compose.yml                                     [M]
├── package.json                                           [M]
├── pnpm-lock.yaml                                         [M]
├── docs/
│   └── archivist-player-living-room-ui-spec.md            [N]
├── packages/
│   ├── contracts/src/
│   │   ├── index.ts                                       [M]
│   │   └── player.ts                                      [N]
│   └── db/
│       ├── src/schema.ts                                  [M]
│       └── test/schema.test.ts                            [M]
├── apps/server/
│   ├── src/player/
│   │   ├── config.ts                                      [N]
│   │   ├── hub-service.ts                                 [N]
│   │   ├── preferences.ts                                 [N]
│   │   ├── serializers.ts                                 [N]
│   │   ├── telemetry.ts                                   [N]
│   │   ├── routes.ts                                      [M]
│   │   ├── media.ts                                       [M]
│   │   └── loudness.ts                                    [M]
│   ├── src/player-frontend.ts                             [M]
│   └── test/
│       ├── player.e2e.test.ts                             [M]
│       ├── player-media.e2e.test.ts                       [M]
│       ├── player-ui.unit.test.ts                         [N]
│       ├── player-ui.e2e.test.ts                          [N]
│       └── run-all.ts                                     [M]
└── apps/player/
    ├── package.json                                       [M]
    ├── playwright.config.ts                               [N]
    ├── README.md                                          [M]
    ├── tailwind.config.js                                 [M]
    ├── vite.config.ts                                     [M]
    ├── src/
    │   ├── main.tsx                                       [M]
    │   ├── App.tsx                                        [M]
    │   ├── index.css                                      [M]
    │   ├── styles/
    │   │   ├── tokens.css                                 [N]
    │   │   └── motion.css                                 [N]
    │   ├── focus/
    │   │   ├── navigation.ts                              [N]
    │   │   └── FocusProvider.tsx                          [N]
    │   ├── lib/
    │   │   ├── sdk.ts                                     [M]
    │   │   ├── store.ts                                   [M]
    │   │   ├── preferences.ts                             [N]
    │   │   └── useMediaGain.ts                            [M]
    │   ├── components/
    │   │   ├── Shell.tsx                                  [N]
    │   │   ├── Hub.tsx                                    [N]
    │   │   ├── Cards.tsx                                  [M]
    │   │   ├── Rail.tsx                                   [M]
    │   │   ├── Player.tsx                                 [M]
    │   │   ├── SessionPlayer.tsx                          [M]
    │   │   ├── TrackMenu.tsx                              [M]
    │   │   └── osd/
    │   │       ├── VideoOsd.tsx                           [N]
    │   │       └── UpNext.tsx                             [N]
    │   └── pages/
    │       ├── Home.tsx                                   [M]
    │       ├── Library.tsx                                [M]
    │       ├── FilmDetail.tsx                             [M]
    │       ├── SeriesDetail.tsx                           [M]
    │       ├── SearchPage.tsx                             [M]
    │       ├── Channels.tsx                               [M]
    │       └── Settings.tsx                               [M]
    └── test/
        ├── e2e/
        │   └── remote-smoke.spec.ts                       [N]
        ├── setup.ts                                       [N]
        ├── navigation.test.ts                             [N]
        ├── pages.test.tsx                                 [N]
        ├── preferences.test.ts                            [N]
        ├── sdk-store.test.ts                              [N]
        ├── shell.test.tsx                                 [N]
        └── osd.test.tsx                                   [N]
```

`Connect.tsx` remains untouched and unreachable in production; it is not deleted because standalone/manual connection mode remains an explicit future product decision. Legacy JSX stays in version control until phase 5. After the rollback window, obsolete top-nav and legacy-only branches inside modified files are deleted rather than retained as separate files.

## 8 Component Impact Analysis

| Area | Impact | Required outcome |
|---|---|---|
| Backend services | Medium | split serialization, hubs, preferences, config, and telemetry from the monolithic router |
| Frontend | Very high | new shell, focus system, hubs, view behavior, details, search, settings, and OSD |
| API | Additive | bootstrap, preferences, hubs, grouped search, client telemetry, metrics snapshot |
| Database | Low | one `player_preferences` table and two indexes/constraints |
| Caching | Medium | route-aware SDK cache, artwork decode LRU, bounded server queries |
| Authentication | No model change | keep service-token injection and same-origin credentials |
| Authorisation | No role change | player scope remains read/play/progress/preferences; admin routes stay unavailable on `4242` |
| Feature flags | New | runtime v2 flag and deterministic rollback |
| Docker | Low | pass four environment variables; no new image, port, service, or volume |
| Logging | Medium | structured route, preference conflict, playback failure, and UI error records |
| Metrics/telemetry | New, local | optional anonymous client timings and in-memory aggregate snapshot |
| Events/message bus | None | no produced or consumed durable event contracts |
| Queues/schedulers | None | existing loudness and Channels work is unchanged |
| Search indexes | None | bounded SQLite `LIKE` search remains; no FTS migration in this release |
| File storage | Low | self-hosted font files may be added only if their licence files are committed; no cache volume |
| CI/CD | Medium | build Player, run unit/component/server tests, and run a browser remote-navigation smoke test |
| Documentation | High | update Player README, API contract notes, configuration, controls, presets, and clean-room notice |
| Backwards compatibility | Preserved | all existing endpoints and fields remain; legacy UI remains flag-selectable during rollout |

## 9 Database Design

### 9.1 Migration

Add schema migration version `4`, description `Add versioned player UI preferences`. The migration runs in the existing `applySchema` transaction path and executes:

```sql
CREATE TABLE IF NOT EXISTS player_preferences (
  profile_id     TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  revision       INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  document       TEXT NOT NULL CHECK (json_valid(document)),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_player_preferences_updated
  ON player_preferences(updated_at DESC);
```

No seed row is inserted by migration. `getPreferences('default')` inserts the canonical default document on first read using `INSERT OR IGNORE`, then reads the row. This avoids embedding mutable JSON in SQL.

### 9.2 Preference document schema version 1

```json
{
  "schemaVersion": 1,
  "preset": "categories",
  "navigation": { "edgeRail": "minimized", "showClock": true },
  "home": {
    "widgetMode": "stacked",
    "showSpotlight": true,
    "widgets": [
      { "id": "continue", "title": "Continue Watching", "source": "continue", "view": "landscape", "limit": 12, "enabled": true },
      { "id": "recent-films", "title": "Recently Added Films", "source": "recent-films", "view": "poster", "limit": 18, "enabled": true },
      { "id": "recent-episodes", "title": "New Episodes", "source": "recent-episodes", "view": "landscape", "limit": 18, "enabled": true },
      { "id": "downloading", "title": "Downloading", "source": "downloading", "view": "poster", "limit": 12, "enabled": true }
    ]
  },
  "libraries": {
    "films": { "view": "poster", "sort": "title", "hideUnavailable": false },
    "series": { "view": "poster", "sort": "title", "hideUnavailable": false }
  },
  "playback": {
    "normalizeVolume": true,
    "targetLufs": -16,
    "preferredAudioLanguage": null,
    "preferredSubtitleLanguage": null,
    "subtitles": "forced"
  },
  "accessibility": { "reducedMotion": "system", "highContrast": false, "textScale": 1 },
  "migration": { "legacyLocalStorageImported": false }
}
```

Preset application replaces `preset`, `navigation`, `home.widgetMode`, `home.showSpotlight`, and `home.widgets`; it preserves `libraries`, `playback`, `accessibility`, and `migration`. The exact preset matrix is:

| Preset | Edge rail | Widget mode | Spotlight | Categories |
|---|---|---|---|---|
| `classic` | visible | stacked | false | no category selector |
| `categories` | visible | stacked | true | category selector visible |
| `compound` | minimized | stacked | true | category selector visible |
| `combined` | minimized | combined | true | horizontal widget selector |

### 9.3 Concurrency and transactions

Updates execute one immediate SQLite transaction: read current revision, compare `expectedRevision`, validate the complete document, update `document`, increment `revision`, set `updated_at`, commit, and return the new row. A mismatch rolls back and returns `409 PLAYER_PREFERENCES_CONFLICT` with the current representation. Reset uses the same revision check and canonical defaults.

### 9.4 Rollback

Application rollback leaves `player_preferences` in place. Migration down is deliberately not executed in production because it would destroy user configuration. A manual destructive down script is not added. The legacy UI ignores the table.

## 10 API Design

All routes remain under `/api/v1/player`. JSON uses camelCase. All errors use `PlayerApiError` from section 15. Existing routes retain existing semantics and fields.

### 10.1 New endpoints

| Method and path | Request | Success | Errors | Cache |
|---|---|---|---|---|
| `GET /ui/bootstrap?profile=default` | optional profile matching validation rules | `PlayerBootstrap` | 400, 500 | `no-store` |
| `PUT /ui/preferences` | `UpdatePlayerPreferencesRequest` | `PlayerPreferencesEnvelope` | 400, 409, 500 | `no-store` |
| `POST /ui/preferences/reset` | `{profileId, expectedRevision}` | `PlayerPreferencesEnvelope` | 400, 409, 500 | `no-store` |
| `GET /hubs/:hubId` | `profile`, `libraryId`, `cursor`, `limit` | `PlayerHub` | 400, 404, 500 | private 15 s client cache |
| `POST /telemetry` | `PlayerTelemetryBatch`, max 50 samples | `204` | 400, 404 when disabled, 413 | `no-store` |
| `GET /metrics` | none | `PlayerMetricSnapshot` | 404 when telemetry disabled | `no-store` |

`hubId` is exactly `home`, `films`, `series`, or `tv`. `cursor` is an opaque base64url string emitted by the server; clients MUST NOT construct it. `limit` defaults to the widget preference, is clamped to `1..60`, and does not override a lower widget limit.

### 10.2 Existing endpoint additions

- `GET /search` accepts `types=film,series,episode` and `limit=1..30`. It retains `results` and adds `groups: {films, series, episodes}`. A missing `types` searches all three. Episode results include `seriesId`, `seriesTitle`, season/episode numbers, still, plot, availability, and playback.
- `GET /films` and `GET /series` accept `cursor`, `limit`, `sort=title|added|year|rating`, `direction=asc|desc`, and `available=true|false|all`; they add `nextCursor` and `total`. Omitting pagination preserves the current full-list response for legacy clients.
- Film, series, and episode details add `progress`, `primaryAction`, and normalized `displayMetadata`; existing properties remain.
- `GET /health` adds `uiV2`, `preferences`, and `telemetry` capability booleans. Existing capability keys remain.

### 10.3 Bootstrap contract

`PlayerBootstrap` contains `server`, `featureFlags`, `configuration`, `preferences`, `libraries`, `progress`, and `initialHub`. `initialHub` is the same shape as `GET /hubs/home`. This single response is mandatory to avoid startup waterfalls. The server completes its database work in one read transaction and returns `ETag: W/"player-bootstrap-<preferenceRevision>"`.

### 10.4 Compatibility

All API changes are additive and backwards compatible. Public types are exported from `@archivist/contracts`; frontend-local duplicates are removed. No existing URL, field, enum value, status code, or stream behavior may be removed or renamed during this release.

## 11 Backend Design

### 11.1 Hub sources

Supported `PlayerWidgetSource` values are exactly `continue`, `recent-films`, `recent-episodes`, `downloading`, `unwatched-films`, `films-az`, and `series-az`. Each source uses one bounded SQL statement. `continue` joins `playback_progress` to film/episode metadata, excludes completed entries and entries below 30 seconds or at/above 95%, and orders by progress update descending. `downloading` includes acquiring films and series episodes with a numeric progress when available.

### 11.2 Pagination

Title sorting cursor payload is `{sortValue:string,id:number}`. Date/rating cursor payload is `{sortValue:string|number|null,id:number}`. The server signs no cursor because the cursor is non-authoritative; it validates decoded shape and parameterizes values. Invalid cursors return `400 PLAYER_CURSOR_INVALID`. Queries use stable secondary `id` ordering and fetch `limit + 1` to compute `nextCursor`.

### 11.3 Preference service

Validation is structural and whitelist-based. Unknown keys, widget sources, view names, preset names, or enum values are rejected; they are not silently discarded. The service exports canonical defaults as a frozen object and deep-clones before return. It never logs the full preference document.

### 11.4 Telemetry service

When enabled, maintain count, sum, min, max, and fixed histogram buckets for approved numeric events. Store no title, media ID, query, route parameter, IP, user agent, or free text. Reset occurs on process restart. `/metrics` returns JSON, not Prometheus text, because the repository has no metrics exporter. The approved names and buckets are defined in section 27.

### 11.5 Media service impact

`media.ts` and `loudness.ts` behavior does not change. Add timing callbacks around probe, subtitle, transcode-start, and loudness lookup so `routes.ts` can record metrics without either service importing telemetry. No stream bytes, FFmpeg arguments, retry policy, or queue behavior changes.

### 11.6 Failure recovery

- Database unavailable: bootstrap/preferences return 503; playback routes already in progress continue until they require DB writes; the UI offers Retry and does not clear local state.
- Hub query failure: preserve the current backdrop and rendered widgets, show a row-level Retry card, and log the request ID.
- Telemetry unavailable: discard samples; never block rendering or playback.
- Cache unavailable: there is no external cache; perform the bounded database query.
- Queue unavailable: no new queue exists; existing loudness failure falls back to unnormalized playback.
- Plugin disabled: no plugin participates.
- Licence invalid: no licence check participates; Community behavior remains available.
- Configuration invalid: startup fails before opening listeners, with the invalid key and accepted values but without secrets.

## 12 Frontend Design

### 12.1 Visual system

Use Archivist’s own palette and type identity while adopting the reference hierarchy.

| Token | Value | Use |
|---|---|---|
| `--player-bg` | `#0a0a0f` | opaque base |
| `--player-panel` | `rgba(17,17,24,.92)` | dialogs and drawers |
| `--player-text` | `rgba(255,255,255,.92)` | primary text |
| `--player-muted` | `rgba(255,255,255,.58)` | metadata |
| `--player-dim` | `rgba(255,255,255,.32)` | inactive labels |
| `--player-focus` | `#ffffff` | primary focus ring |
| `--player-accent` | `#00d4ff` | progress and selected state |
| `--player-danger` | `#ff2d78` | destructive/error state |
| `--safe-x` | `clamp(24px, 3.33vw, 64px)` | horizontal TV-safe area |
| `--safe-y` | `clamp(20px, 3.33vh, 36px)` | vertical TV-safe area |
| `--rail-collapsed` | `72px` at 1080p reference | edge rail |
| `--rail-expanded` | `288px` at 1080p reference | focused edge rail |

Reference viewport is 1920×1080. Layout scales continuously from 1280×720 to 3840×2160. Below 960 CSS px width, cards shrink but the focus model remains; no mobile-only bottom navigation is introduced. Support 16:9, 16:10, 3:2, 4:3, 18:9, 19.5:9, and 21:9 by honoring safe-area tokens and capping content width at 2200 CSS px.

Use self-hosted DM Sans, Bebas Neue, and JetBrains Mono only when their font files and licence texts already exist or are added together. Remove the Google Fonts `@import`; runtime font fetches are forbidden. Font fallbacks are `system-ui`, `Arial Narrow`, and `ui-monospace` respectively.

Backdrop transitions use two absolutely positioned images, opacity crossfade of 280 ms, one linear left/bottom scrim, and no CSS blur. Only the current and incoming backdrop remain mounted. Focused cards scale to `1.055`, translate toward free space by no more than 4 px, use a 3 px white ring plus 8 px dark outer shadow, and complete in 140 ms. Reduced motion disables scale, translation, parallax, hero rotation, and smooth scroll; it preserves instantaneous focus rings and 80 ms opacity changes.

### 12.2 Shell and hubs

The side rail order is Home, Films, Series, TV, Search, Settings. The active route remains marked when the rail is unfocused. On left movement from the first focusable column, the rail receives focus. It expands from 72 to 288 px in 180 ms. Right returns to the exact remembered focus in content. Back closes, in order: nested OSD panel, modal, options drawer, expanded rail, detail page, then route history. Back on Home with no overlay does nothing.

The `categories` default Home has a spotlight zone occupying the upper 47% of 1080p and widget content beginning at 44%, allowing overlap. Spotlight shows logo or title, year, certification, runtime/episode label, rating, at most three genres, a plot capped at four lines, progress, and Play/Resume. It never auto-advances while any content element is focused. Automatic spotlight rotation is disabled by default and is not a user setting in v2.

Widget rows are vertically stacked. Up/Down changes rows; Left/Right changes cards. A focused card updates global media context after 100 ms; leaving before 100 ms cancels the update. Data fetching may not occur on focus. Empty widgets are omitted. If all widgets are empty, render the curated empty state with a Settings action and no management terminology.

### 12.3 Spatial navigation algorithm

Every focus target registers `{id, zoneId, element, disabled, preferredChildId}`. IDs are stable semantic strings, never array indexes. On directional input:

1. Ignore repeated keydown events during the 70 ms movement lock.
2. Restrict candidates to the active modal when a modal exists; otherwise use the active route.
3. Exclude disabled, hidden, zero-area, and `aria-hidden=true` elements.
4. Keep candidates whose center lies in the requested half-plane of the current center.
5. Compute `primaryDistance + 0.35 * perpendicularDistance + 0.002 * perpendicularDistance²`.
6. Subtract 120 when rectangles overlap on the perpendicular axis.
7. Subtract 60 for the current zone’s explicit directional neighbor.
8. Select the lowest score; tie-break by DOM registration order.
9. If none exists, execute the zone boundary rule: reveal rail on Left, retain focus on outer Right, move to previous/next row on Up/Down, or retain focus.
10. Call `scrollIntoView({block:'nearest',inline:'nearest',behavior:reducedMotion?'auto':'smooth'})`, focus with `preventScroll:true`, and persist the ID under the route key.

Keyboard mapping: Arrow keys move; Enter/Space activates; Escape and BrowserBack execute Back; `f` toggles fullscreen; `m` toggles mute; `c` opens subtitles; `a` opens audio; `i` opens information; Play/Pause media keys control playback. During playback, Left/Right seek rather than move OSD focus only when the base OSD is hidden; when visible, they navigate controls unless the seek bar is focused. Gamepad index 0 is polled with `requestAnimationFrame`; axes cross at ±0.55, release below ±0.35, and buttons map A=OK, B=Back, Start=Play/Pause. Disconnect stops polling within one frame.

Input modality is `remote`, `pointer`, or `touch`. Arrow/gamepad sets `remote`; mouse movement over 4 px sets `pointer`; touchstart sets `touch`. Focus rings remain visible in remote mode and keyboard mode; pointer mode suppresses rings until keyboard/remote input resumes.

### 12.4 View behavior

- `poster`: 244×366 reference cards, six visible at 1920 px after safe areas and rail; metadata in Spotlight/InfoPanel.
- `landscape`: 356×200 cards, four-and-a-half visible; title and episode label below or within the bottom scrim.
- `wall`: 174×261 cards, nine visible; a persistent right information panel occupies 32% width so focused items are never information-free.
- `list`: 68 px rows with thumbnail, title, secondary label, progress, quality badge, and availability; eight full rows visible.

Changing view opens an options drawer, persists only after confirmation, restores focus to the same media ID, and must not reset sort or scroll. Missing artwork renders an original Archivist gradient placeholder with the title; it never shows a broken-image icon.

### 12.5 Detail pages

Film detail zones are Action Row, Metadata, Cast, and Related. V2 does not populate Related until a supported server source exists, so the zone is omitted. Initial focus is Resume when progress is between 30 seconds and 95%, otherwise Play. Actions are Resume/Play, Restart when progress exists, More Information, and Mark Watched/Unwatched. Unavailable media disables Play with the label `Not available` and an explanatory info panel; no acquisition action is exposed.

Series detail initial focus is Resume Next when `primaryAction` exists, otherwise the first season. Season tabs are horizontal, include Specials only when season 0 has episodes, and keep the same episode focus when possible. Episode rows show `SxxExx`, title, air date, duration, progress, watched state, and availability. OK on playable episode opens Resume/Start when progress exists; otherwise playback begins. Right opens Episode Information. No `UP`, search, manual scan, or auto scan control appears in Player.

### 12.6 Search

Search is a route-level hub. On entry, focus the text field and invoke the platform keyboard on pointer/touch; remote users receive a built-in grid keyboard beneath the field. The grid contains A–Z, 0–9, Space, Backspace, Clear, and Done. Query execution starts after 250 ms idle and at two or more Unicode code points. Cancel in-flight requests with `AbortController`. Results render Films, Series, and Episodes rows; omit empty groups. Empty query shows Recent Searches stored locally as at most ten trimmed strings; search history never reaches the server. No-results copy is `No matches for “{query}”` and preserves the keyboard.

### 12.7 Settings

Settings is a hub with sections Interface, Home, Library, Playback, Accessibility, and About. Initial setup shows a preset preview with four choices and defaults to Categories. Each preview is an original schematic, not a reference screenshot. Changes update a local draft; Save performs one revision-controlled PUT. Leaving with a dirty draft opens Save/Discard/Cancel. Reset requires a confirmation dialog and retains playback progress and search history. A successful Save displays a toast for three seconds and keeps focus on Save.

Home widget editing supports enable, reorder, title, source, view, and limit. Reorder uses Move Up/Move Down actions in remote mode and pointer drag only as an additional method. Settings cannot disable itself, Search, or Home. Limits are 6, 12, 18, 24, 36, or 60.

### 12.8 Video OSD

The first OSD frame must require no network, database, image decode, blur, or synchronous media probe. On OK/pointer movement it displays within 50 ms: title/episode identity at top-left; current time, duration, buffered range, and progress at bottom; and Play/Pause, Previous, Next, Stop, Info, Audio, Subtitles, Video Mode, and More controls. Unsupported controls are omitted, not disabled placeholders.

While playing, the base OSD hides after 3,000 ms without input. While paused, it remains. After 600 ms paused, the top information layer expands to show logo/title, plot, year, certification, rating, and technical badges already present in memory. Opening Audio, Subtitles, Video Mode, Info, or Queue replaces the base control focus with a right-side panel and traps focus. Back closes the panel and returns to the invoking button.

Left/Right with hidden OSD seeks −10/+10 seconds and shows a lightweight seek indicator. Holding for 500 ms repeats every 250 ms; after 2 seconds each step is 30 seconds; after 5 seconds each step is 60 seconds. Clamp to `[0,duration-0.25]`. Up reveals the OSD. Down hides it when no panel is open. Stop returns to the origin route and origin focus ID.

Track probing begins asynchronously after `loadedmetadata`; its result is cached for the playback item. Until ready, Audio/Subtitles show a local `Loading tracks` row without blocking the base OSD. Selecting an incompatible audio track or subtitle burn-in uses the existing transcode restart flow and preserves time within ±2 seconds.

For episodic or Channels-session playback, Up Next appears at `max(duration-45, duration*0.90)` and never before 60 seconds elapsed. It shows next artwork, identity, and a 15-second countdown. OK plays now, Back cancels for this item, and timeout advances. If next item lacks a file or playback fails, cancel advance, retain the current end frame, and show a recoverable error. Films outside a session never show Up Next.

### 12.9 Accessibility

All controls have accessible names and roles. Focus order and visual order match. Text at 1080p is never below 18 CSS px for primary remote-readable text or 14 CSS px for secondary badges. Contrast is at least 4.5:1 for text and 3:1 for focus indicators. Dialogs use `aria-modal`, restore focus, and announce their title. Toasts use polite live regions; playback failures use assertive live regions. The app supports `prefers-reduced-motion`, 100/115/130% text scale, captions, browser zoom to 200%, and mouse/keyboard use without requiring a remote.

## 13 Event Flow

No durable application event, message-bus event, queue event, or dead-letter contract is added.

Durable event publishers: none. Durable event subscribers: none. Retry policy: not applicable. Dead-letter behavior: not applicable. Existing `system_events`, system jobs, loudness work, Channels scheduler, and SSE modules are neither publishers nor subscribers for this UI feature and must not be modified.

Client-local events are typed discriminated unions inside the store: `BOOTSTRAP_SUCCEEDED`, `BOOTSTRAP_FAILED`, `ROUTE_ENTERED`, `FOCUS_CHANGED`, `MODAL_OPENED`, `MODAL_CLOSED`, `PREFERENCES_DRAFTED`, `PREFERENCES_SAVED`, `PROGRESS_HYDRATED`, `PLAYBACK_STARTED`, `PLAYBACK_STOPPED`, and `PLAYBACK_FAILED`. They are synchronous reducer inputs, not public contracts.

Preference update sequence: Settings Save → SDK PUT with expected revision → server transaction → success updates store and local cache; conflict returns current envelope → client opens conflict dialog with Reload or Overwrite. Overwrite is a new PUT using the returned revision and the unchanged local draft. No automatic retry occurs.

Playback sequence: detail/card action → Player selects direct stream → `loadedmetadata` paints playback and starts nonblocking probe → progress saves at 10-second intervals and on pause, visibility change, ended, and unmount → OSD reads cached playback state → transcode only after browser error or explicit incompatible track selection.

## 14 Data Flow

```text
SQLite media + playback_progress + player_preferences
        │
        ▼
player serializers / hub service / preference service
        │ bounded, opaque Player contracts
        ▼
/api/v1/player on 2424 ── delegated with service token ── port 4242
        │
        ▼
ArchivistSdk cache and request cancellation
        │
        ▼
PlayerStore ──► Shell / Hub / Cards / Details / OSD
        │                        │
        ├─ preference PUT ──────┘
        ├─ progress POST/DELETE
        └─ optional anonymous timing batch ──► in-memory telemetry aggregate
```

Media paths flow only from SQLite to server stream functions and never enter public JSON, logs, telemetry, browser storage, or DOM attributes. Search text reaches only the search endpoint and is not logged or telemetered. Artwork URLs remain opaque URLs already permitted by the Player surface.

## 15 Interfaces

All listed types are exported from `packages/contracts/src/player.ts` unless marked frontend-internal.

### 15.1 Public exported types

```ts
type PlayerPreset = 'classic' | 'categories' | 'compound' | 'combined'
type PlayerView = 'poster' | 'landscape' | 'wall' | 'list'
type PlayerWidgetSource = 'continue' | 'recent-films' | 'recent-episodes' | 'downloading' | 'unwatched-films' | 'films-az' | 'series-az'
type PlayerHubId = 'home' | 'films' | 'series' | 'tv'
type PlayerMediaType = 'film' | 'series' | 'episode'
type PlayerPrimaryAction = 'play' | 'resume' | 'resume-next' | 'unavailable'

interface PlayerWidgetPreference { id:string; title:string; source:PlayerWidgetSource; view:PlayerView; limit:6|12|18|24|36|60; enabled:boolean }
interface PlayerPreferencesV1 { schemaVersion:1; preset:PlayerPreset; navigation:PlayerNavigationPreferences; home:PlayerHomePreferences; libraries:PlayerLibraryPreferences; playback:PlayerPlaybackPreferences; accessibility:PlayerAccessibilityPreferences; migration:{legacyLocalStorageImported:boolean} }
interface PlayerPreferencesEnvelope { profileId:string; revision:number; updatedAt:string; preferences:PlayerPreferencesV1 }
interface UpdatePlayerPreferencesRequest { profileId:string; expectedRevision:number; preferences:PlayerPreferencesV1 }
interface ResetPlayerPreferencesRequest { profileId:string; expectedRevision:number }
interface PlayerBootstrap { server:ServerHealth; featureFlags:PlayerFeatureFlags; configuration:PlayerPublicConfiguration; preferences:PlayerPreferencesEnvelope; libraries:PlayerLibrary[]; progress:PlaybackProgress[]; initialHub:PlayerHub }
interface PlayerHub { id:PlayerHubId; title:string; categories:PlayerHubCategory[]; spotlight:PlayerMediaCard|null; widgets:PlayerWidget[] }
interface PlayerWidget { id:string; title:string; source:PlayerWidgetSource; view:PlayerView; items:PlayerMediaCard[]; nextCursor:string|null; total:number }
interface PlayerMediaCard { key:string; mediaType:PlayerMediaType; id:number; route:string; title:string; subtitle:string|null; plot:string|null; year:number|null; posterUrl:string|null; landscapeUrl:string|null; backdropUrl:string|null; logoUrl:string|null; progress:PlayerProgressSummary|null; badges:PlayerBadge[]; available:boolean; primaryAction:PlayerPrimaryAction }
interface PlayerSearchGroups { films:FilmSummary[]; series:SeriesSummary[]; episodes:EpisodeSummary[] }
interface PlayerTelemetrySample { name:PlayerTelemetryName; valueMs:number; at:number }
interface PlayerTelemetryBatch { sessionId:string; samples:PlayerTelemetrySample[] }
interface PlayerMetricSnapshot { startedAt:string; metrics:Record<PlayerTelemetryName,PlayerMetricAggregate> }
interface PlayerApiError { error:{code:string; message:string; requestId:string; details?:Record<string,string|number|boolean>} }
```

Existing `Quality`, `Playback`, `FilmSummary`, `FilmDetail`, `SeriesSummary`, `SeriesDetail`, `EpisodeSummary`, `Season`, `PlayerLibrary`, `ServerHealth`, `PlaybackProgress`, Channels, session, track, and loudness types move unchanged from `apps/player/src/lib/sdk.ts` into the same shared contract file. This relocation is source-compatible for the HTTP API and requires import updates for TypeScript consumers.

### 15.2 Public services

```ts
createPlayerRouter(): Router
getPlayerConfig(env: NodeJS.ProcessEnv): Readonly<PlayerServerConfig>
getPlayerPreferences(profileId: string): PlayerPreferencesEnvelope
updatePlayerPreferences(input: UpdatePlayerPreferencesRequest): PlayerPreferencesEnvelope
resetPlayerPreferences(input: ResetPlayerPreferencesRequest): PlayerPreferencesEnvelope
getPlayerHub(input: GetPlayerHubInput): PlayerHub
recordPlayerTelemetry(batch: PlayerTelemetryBatch): void
getPlayerMetricSnapshot(): PlayerMetricSnapshot
```

Only `createPlayerRouter` is a cross-module server service today. The other functions are public within `apps/server/src/player`; they MUST NOT be exported from a workspace package in this release.

### 15.3 Frontend-internal interfaces

```ts
type Direction = 'left' | 'right' | 'up' | 'down'
type InputModality = 'remote' | 'pointer' | 'touch'
interface FocusRegistration { id:string; zoneId:string; element:HTMLElement; disabled:boolean; neighbors?:Partial<Record<Direction,string>> }
interface FocusController { register(input:FocusRegistration):()=>void; move(direction:Direction):boolean; focus(id:string):boolean; restore(routeKey:string,fallbackId:string):void; pushScope(scopeId:string):void; popScope(scopeId:string):void }
interface UseFocusableOptions { id:string; zoneId:string; disabled?:boolean; neighbors?:Partial<Record<Direction,string>>; onActivate?:()=>void }
interface UseFocusableResult { ref:React.RefObject<HTMLElement>; tabIndex:number; 'data-focus-id':string; onFocus:React.FocusEventHandler; onClick:React.MouseEventHandler }
```

No plugin interface, event-bus contract, webhook, GraphQL type, database repository interface, or external SDK package is added.

## 16 Detailed File Specifications

The following specification is normative for every file in section 7. “None” means the concern has been reviewed and the file must not implement it.

### 16.1 `/docs/03-products/player/living-room-ui-specification.md`

**File:** this document. **Purpose:** sole implementation authority for Living-Room UI v2. **Responsibilities:** decisions, contracts, sequence, acceptance, audit. **Imports:** none. **Exports:** documentation only. **Classes:** none. **Interfaces:** documents all interfaces in section 15. **Functions/method signatures:** documents, does not execute. **Parameters/returns/exceptions:** none. **Dependencies:** repository state observed 2026-07-12 and cited research. **Events/configuration/caching/transactions:** documents only. **Logging/telemetry/metrics:** documents only. **Security:** clean-room and limited-player-boundary requirements are normative. **Performance/concurrency/failure behavior:** sections 25 and 29 are normative. **Unit tests/integration tests:** none for Markdown; CI link validation MAY warn but MUST NOT block on the Kodi forum’s 403. **Files interacting:** every file in section 7. **Implementation notes:** production code must not be added to this file.

### 16.2 `/.env.example`

**File:** `.env.example`. **Purpose:** document runtime flags. **Responsibilities:** add the four keys in section 18 with comments and allowed values. **Imports/exports/classes/interfaces/functions/methods/parameters/returns/exceptions:** none. **Dependencies:** server config parser. **Events/caching/transactions/logging/telemetry/metrics:** none. **Configuration:** examples only; no secrets. **Security:** do not include service tokens or real origins. **Performance/concurrency:** none. **Failure behavior:** invalid copied values fail startup. **Unit tests:** config parser tests cover examples. **Integration tests:** compose config test. **Files interacting:** `docker-compose.yml`, `config.ts`, Player README. **Implementation notes:** retain all existing keys.

### 16.3 `/Dockerfile`

**File:** `Dockerfile`. **Purpose:** verify that the revised static bundle is already covered by the image build. **Responsibilities:** content remains unchanged; confirm existing `COPY . .`, `pnpm build`, production install, ports, health check, and non-root runtime satisfy section 19. **Imports/exports/classes/interfaces/functions/methods/parameters/returns/exceptions:** none. **Dependencies:** Node 20, existing FFmpeg runtime. **Events/configuration/caching/transactions/logging/telemetry/metrics:** none. **Security:** no reference-skin asset or remote font download; runtime remains non-root. **Performance:** final compressed Player targets are verified from built assets. **Concurrency:** unchanged. **Failure behavior:** build failure stops image construction. **Unit tests:** none. **Integration tests:** image build plus both health probes. **Files interacting:** `package.json`, Player dist, `player-frontend.ts`. **Implementation notes:** any Dockerfile diff is out of specification unless repository build behavior changes and the specification is amended.

### 16.4 `/docker-compose.yml`

**File:** `docker-compose.yml`. **Purpose:** pass runtime Player UI settings. **Responsibilities:** map all four variables using the defaults in section 18. **Imports/exports/classes/interfaces/functions/methods/parameters/returns/exceptions:** none. **Dependencies:** `.env`, server process. **Events/caching/transactions/logging/telemetry/metrics:** none. **Configuration:** exact `${KEY:-default}` forms. **Security:** no additional port exposure or secret. **Performance/concurrency:** unchanged single service. **Failure behavior:** invalid values cause the container to fail fast. **Unit tests:** none. **Integration tests:** `docker compose config` and health check. **Files interacting:** `.env.example`, `config.ts`. **Implementation notes:** retain ports 2424/4242 and existing volumes/networks.

### 16.5 `/package.json`

**File:** root `package.json`. **Purpose:** aggregate Player verification. **Responsibilities:** add `test:player` invoking the Player package test and make `verify` execute it after build and server tests. **Imports/exports/classes/interfaces/functions/methods/parameters/returns/exceptions:** none. **Dependencies:** workspace scripts. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency:** none. **Failure behavior:** nonzero child exit fails CI. **Unit tests/integration tests:** orchestration only. **Files interacting:** `apps/player/package.json`, CI workflow. **Implementation notes:** preserve package manager and existing script names.

### 16.6 `/pnpm-lock.yaml`

**File:** `pnpm-lock.yaml`. **Purpose:** reproducible test dependency resolution. **Responsibilities:** contain only resolver-generated changes corresponding to dependencies in sections 16.24 and 16.60. **Imports/exports/classes/interfaces/functions/methods/parameters/returns/exceptions/dependencies/events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency/failure behavior/unit tests/integration tests:** not executable. **Files interacting:** workspace package manifests. **Implementation notes:** regenerate with the repository’s pinned pnpm; never hand-edit; reject unrelated upgrades.

### 16.7 `/packages/contracts/src/index.ts`

**File:** contracts barrel. **Purpose:** expose Player contracts. **Responsibilities:** add `export * from './player.js'`. **Imports:** `player.ts`. **Exports:** all Player types. **Classes/functions/methods:** none. **Interfaces:** re-export only. **Parameters/returns/exceptions:** none. **Dependencies:** TypeScript ESM conventions. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency/failure behavior:** none. **Unit tests:** package typecheck. **Integration tests:** server and Player compile against barrel. **Files interacting:** `player.ts`, server, SDK. **Implementation notes:** retain all existing exports.

### 16.8 `/packages/contracts/src/player.ts`

**File:** shared Player contracts. **Purpose:** one source of truth for HTTP shapes. **Responsibilities:** define every type in section 15 plus existing SDK types; use `unknown` rather than `any` for unstructured cast/crew metadata, with explicit `PersonCredit`. **Imports:** common nullable/identifier types only when already present. **Exports:** types and `PLAYER_PREFERENCE_SCHEMA_VERSION = 1`; no runtime validators. **Classes/functions/methods:** none. **Parameters/returns/exceptions:** represented by request/response types. **Dependencies:** no Node, React, Express, or DB dependency. **Events:** telemetry batch types only; no event bus. **Configuration:** public configuration shape. **Caching/transactions/logging/telemetry/metrics:** data contracts only. **Security:** forbid file paths, tokens, queries, and free-text telemetry. **Performance:** contracts support pagination. **Concurrency:** revision fields. **Failure behavior:** `PlayerApiError`. **Unit tests:** TypeScript compile fixtures for representative payloads. **Integration tests:** server payloads satisfy contracts. **Files interacting:** SDK, serializers, routes, services. **Implementation notes:** preserve current field names and optionality.

### 16.9 `/packages/db/src/schema.ts`

**File:** unified schema. **Purpose:** persist preference envelopes. **Responsibilities:** add the table DDL to `SCHEMA` and migration v4 exactly as section 9. **Imports:** existing DB and migration helpers. **Exports:** existing exports unchanged. **Classes/interfaces/functions/methods:** no new public class; `applySchema` includes v4. **Parameters/returns:** existing. **Exceptions:** SQLite schema/migration errors propagate and stop startup. **Dependencies:** SQLite JSON1, which is required by current better-sqlite3 build. **Events/configuration/caching:** none. **Transactions:** existing migration runner. **Logging:** existing migration log only. **Telemetry/metrics:** none. **Security:** document contains UI preferences only. **Performance:** primary-key lookup; updated index. **Concurrency:** SQLite transaction serialization. **Failure behavior:** migration rollback by runner. **Unit tests:** creation, idempotency, JSON check, revision check. **Integration tests:** preference API. **Files interacting:** preferences service, DB tests. **Implementation notes:** migration version must be 4; do not resequence old migrations.

### 16.10 `/packages/db/test/schema.test.ts`

**File:** schema tests. **Purpose:** prove v4. **Responsibilities:** assert table/columns/index, reject invalid JSON and revision zero, accept canonical document, and rerun schema idempotently. **Imports:** Node test/assert, DB schema helpers. **Exports/classes/interfaces/functions:** none beyond test callbacks. **Parameters/returns:** test harness. **Exceptions:** assertions fail test. **Dependencies:** in-memory SQLite. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency:** none. **Failure behavior:** test process nonzero. **Unit tests:** all listed responsibilities. **Integration tests:** none. **Files interacting:** schema. **Implementation notes:** do not inspect unrelated tables beyond existing assertions.

### 16.11 `/apps/server/src/player/config.ts`

**File:** Player configuration parser. **Purpose:** fail-fast typed configuration. **Responsibilities:** implement `getPlayerConfig(env)`; parse four keys; freeze return; produce descriptive errors. **Imports:** `PlayerPublicConfiguration` from contracts. **Exports:** `PlayerServerConfig`, `getPlayerConfig`. **Classes:** none. **Functions:** `getPlayerConfig(env:NodeJS.ProcessEnv):Readonly<PlayerServerConfig>`. **Parameters:** environment map. **Returns:** validated config. **Exceptions:** `PlayerConfigError` with key and accepted range; never value for secret-like keys. **Dependencies:** none. **Events/caching/transactions:** none; the function is pure and does not memoize. `createPlayerRouter` calls it once and retains the immutable result. **Logging:** caller logs startup summary without profile data. **Telemetry/metrics:** controls telemetry enablement. **Security:** whitelist values. **Performance/concurrency:** O(1), immutable. **Failure behavior:** server startup aborts. **Unit tests:** defaults, booleans, enum, integer bounds, invalid values. **Integration tests:** bootstrap reflects config. **Files interacting:** routes, hub service, server tests, env docs. **Implementation notes:** do not read environment outside this file within Player modules.

### 16.12 `/apps/server/src/player/serializers.ts`

**File:** Player serializers. **Purpose:** isolate database shape from public API. **Responsibilities:** move and type film, series, episode, season, progress, card, badge, and display-metadata serialization out of routes. **Imports:** public contracts. **Exports:** `serializeFilmSummary`, `serializeFilmDetail`, `serializeSeriesSummary`, `serializeSeriesDetail`, `serializeEpisodeSummary`, `serializeProgress`, `toMediaCard`. **Classes:** none. **Interfaces:** private row types containing only read columns. **Functions:** each accepts a row plus optional progress and returns its named contract. **Exceptions:** malformed JSON fields use empty arrays and never throw; invalid IDs throw `PlayerSerializationError`. **Dependencies:** no DB handle or Express. **Events/configuration/caching/transactions/logging/telemetry/metrics:** none. **Security:** never return or log `file_path`; only derive `hasFile`. **Performance:** O(items), single JSON parse per field. **Concurrency:** pure. **Failure behavior:** caller maps typed error to 500. **Unit tests:** nulls, malformed JSON, path non-leak, progress/action. **Integration tests:** existing player e2e. **Files interacting:** routes, hub service. **Implementation notes:** summaries cap plot at 280 Unicode code points, details retain full plot.

### 16.13 `/apps/server/src/player/preferences.ts`

**File:** preference service. **Purpose:** canonical defaults and revision-safe persistence. **Responsibilities:** implement services in section 15, structural validation, preset generation, first-read seed, reset, and conflict error. **Imports:** DB accessor, contracts, config only for default preset. **Exports:** `DEFAULT_PLAYER_PREFERENCES`, `validatePlayerPreferences`, get/update/reset functions, `PlayerPreferencesConflictError`, `PlayerPreferencesValidationError`. **Classes:** two typed errors. **Functions/methods:** signatures in section 15; validator returns `PlayerPreferencesV1` or throws. **Parameters/returns:** complete documents only. **Exceptions:** validation, conflict, DB errors. **Dependencies:** SQLite. **Events/caching:** none. **Transactions:** immediate transaction for writes. **Logging:** profile ID, revision, outcome; never document. **Telemetry/metrics:** increment route-level conflict/error counters through caller. **Security:** whitelist; 32 KB serialized maximum. **Performance:** one row read; one-row write under 25 ms p95. **Concurrency:** optimistic revision. **Failure behavior:** rollback and typed error. **Unit tests:** defaults, every invalid enum/range/key, conflict, reset, immutability. **Integration tests:** new UI API tests. **Files interacting:** routes, schema, frontend migration. **Implementation notes:** deep clone defaults via structured cloning, not JSON roundtrip.

### 16.14 `/apps/server/src/player/hub-service.ts`

**File:** hub composition. **Purpose:** bounded server-side widgets. **Responsibilities:** implement exact sources, pagination, filtering, stable cursor, categories, spotlight selection, and initial Home hub. **Imports:** DB accessor, serializers, preference service/contracts, config. **Exports:** `GetPlayerHubInput`, `getPlayerHub`, `encodePlayerCursor`, `decodePlayerCursor`. **Classes:** `PlayerCursorError`, `PlayerHubNotFoundError`. **Functions:** public signature in section 15; helpers private except cursor functions for tests. **Parameters/returns:** validated hub/profile/library/cursor/limit to `PlayerHub`. **Exceptions:** typed 400/404 and DB. **Dependencies:** SQLite media schema/progress. **Events/configuration:** max widget count. **Caching:** none server-side. **Transactions:** one deferred read transaction for a hub. **Logging:** hub ID, counts, duration, request ID through caller; no titles. **Telemetry/metrics:** route duration/count. **Security:** parameterized SQL; cursor shape validation. **Performance:** at most one query per enabled widget plus one category query; 150 ms p95 at 10k media rows. **Concurrency:** read-only. **Failure behavior:** whole request fails; no partial ambiguous payload. **Unit tests:** every source, cursor, empty source, filters. **Integration tests:** hub endpoint. **Files interacting:** routes, serializers, preferences. **Implementation notes:** never call existing admin routes internally.

### 16.15 `/apps/server/src/player/telemetry.ts`

**File:** local telemetry aggregate. **Purpose:** low-risk performance evidence. **Responsibilities:** validate approved samples, aggregate fixed histograms, snapshot, and reset only for tests. **Imports:** telemetry contracts and Player config. **Exports:** `recordPlayerTelemetry`, `getPlayerMetricSnapshot`; `resetPlayerTelemetryForTest` only under test export convention. **Classes:** `PlayerTelemetryValidationError`. **Functions:** signatures in section 15. **Parameters/returns:** batches; snapshot. **Exceptions:** disabled route handled before call; invalid samples throw. **Dependencies:** process memory only. **Events:** consumes client timing samples; produces no external event. **Configuration:** enabled flag. **Caching:** aggregate is the store. **Transactions:** none. **Logging:** invalid batch warning without payload. **Telemetry/metrics:** owns names/buckets. **Security:** reject extra keys, session IDs not UUID v4, timestamps outside ±10 minutes, and values outside 0..120000 ms. **Performance:** O(samples), max 50. **Concurrency:** Node event loop updates. **Failure behavior:** sample rejection does not affect UI. **Unit tests:** validation and bucket boundaries. **Integration tests:** endpoint enabled/disabled. **Files interacting:** routes, SDK. **Implementation notes:** never persist or transmit externally.

### 16.16 `/apps/server/src/player/routes.ts`

**File:** stable Player router. **Purpose:** HTTP orchestration. **Responsibilities:** retain all existing routes, use serializers/services, add section 10 endpoints, validate inputs, attach request IDs, set cache headers, and map typed errors. **Imports:** Express, logger, DB, Channels, media/loudness, contracts, new services. **Exports:** `createPlayerRouter`. **Classes/interfaces:** none public. **Functions:** router factory plus small validation/error middleware. **Parameters/returns:** Express request/response. **Exceptions:** caught once and mapped through `sendPlayerError`. **Dependencies:** all Player services. **Events:** none. **Configuration:** immutable parsed config. **Caching:** HTTP headers only. **Transactions:** delegated. **Logging:** method, route template, status, duration, request ID; no query text/title/path/token. **Telemetry/metrics:** server route durations and approved client samples. **Security:** validate profile, cursor, body size; opaque URLs; service auth remains upstream. **Performance:** no unbounded new query. **Concurrency:** stateless router. **Failure behavior:** error contract and correct status. **Unit tests:** validation/error mapping. **Integration tests:** existing plus player-ui e2e. **Files interacting:** all server Player files. **Implementation notes:** split file to under 450 lines; do not change stream semantics.

### 16.17 `/apps/server/src/player/media.ts`

**File:** media probe/subtitle/transcode service. **Purpose:** existing playback mechanics. **Responsibilities:** add optional timing callback argument to `probeTracks`, `streamSubtitleVtt`, and `streamTranscode`; preserve behavior. **Imports/exports:** existing plus `type PlayerMediaTiming = (operation:string,durationMs:number,outcome:'ok'|'error')=>void`. **Classes/interfaces/functions/methods:** existing signatures gain final optional callback only. **Parameters/returns:** unchanged otherwise. **Exceptions:** existing behavior. **Dependencies:** FFmpeg/filesystem. **Events/configuration/caching/transactions:** unchanged. **Logging:** existing redaction; no path added. **Telemetry/metrics:** callback fires exactly once in `finally`. **Security/performance/concurrency/failure behavior:** unchanged. **Unit tests:** callback success/error. **Integration tests:** player media e2e. **Files interacting:** routes, loudness. **Implementation notes:** optional parameter preserves internal callers.

### 16.18 `/apps/server/src/player/loudness.ts`

**File:** loudness service. **Purpose:** existing normalization measurement. **Responsibilities:** expose lookup timing through an optional callback on `getLoudness`; change nothing else. **Imports/exports/classes/interfaces/functions/methods/parameters/returns/exceptions/dependencies/events/configuration/caching/transactions/logging/security/performance/concurrency/failure behavior:** existing contract, except one optional timing callback matching media.ts. **Telemetry/metrics:** callback once per lookup. **Unit tests:** callback on hit/miss. **Integration tests:** playback tests. **Files interacting:** routes, media. **Implementation notes:** do not modify worker queue, target LUFS, FFmpeg filter, or persistent loudness schema.

### 16.19 `/apps/server/src/player-frontend.ts`

**File:** limited Player listener. **Purpose:** static hosting and protected delegation. **Responsibilities:** retain delegation, add CSP and Permissions-Policy, serve self-hosted font MIME, and include `Server-Timing` only for static file reads. **Imports/exports:** existing. **Classes/interfaces/functions/methods:** existing `createPlayerFrontend` plus private `playerSecurityHeaders():Record<string,string>`. **Parameters/returns/exceptions:** router signature unchanged; helper returns the fixed headers. **Dependencies:** Node HTTP/FS, Express. **Events/configuration/caching/transactions:** static immutable caching remains. **Logging:** startup/errors only. **Telemetry/metrics:** none. **Security:** CSP `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'`; no inline runtime scripts. **Performance:** HEAD and immutable assets preserved. **Concurrency:** async per request. **Failure behavior:** 500 without filesystem path. **Unit tests:** delegated/static/path traversal/CSP. **Integration tests:** 4242 cannot reach admin API. **Files interacting:** Docker, Vite output. **Implementation notes:** do not expose admin endpoints.

### 16.20 `/apps/server/test/player.e2e.test.ts`

**File:** existing Player API tests. **Purpose:** protect stable contracts. **Responsibilities:** retain all assertions; import shared types where useful; add pagination, grouped episode search, additive detail fields, capabilities, error envelope, and path-leak assertions. **Imports:** Node test/assert, server harness, contracts. **Exports/classes/interfaces/functions:** test callbacks only. **Parameters/returns:** harness. **Exceptions:** assertions. **Dependencies:** fixture SQLite. **Events/configuration/caching/transactions/logging/telemetry/metrics:** none. **Security:** scan serialized bodies for fixture filesystem roots and tokens. **Performance:** assert query response under generous 2 s CI ceiling, not product p95. **Concurrency:** tests isolate DB. **Failure behavior:** nonzero. **Unit tests:** none. **Integration tests:** all responsibilities. **Files interacting:** routes, serializers, hub service. **Implementation notes:** do not weaken old assertions.

### 16.21 `/apps/server/test/player-media.e2e.test.ts`

**File:** media integration tests. **Purpose:** prove OSD refactor does not alter playback. **Responsibilities:** retain range/HEAD/probe/subtitle/transcode/loudness tests; add timing-callback and transcode resume-position assertions. **Imports/exports/classes/interfaces/functions:** existing test harness. **Parameters/returns/exceptions:** fixture behavior. **Dependencies:** FFmpeg fixture capability. **Events/configuration/caching/transactions/logging:** unchanged. **Telemetry/metrics:** assert approved operation names only. **Security:** no path in responses. **Performance:** no strict FFmpeg wall-time gate in shared CI. **Concurrency:** cleanup child processes. **Failure behavior:** terminate fixture process. **Unit tests:** none. **Integration tests:** listed. **Files interacting:** media, loudness, routes. **Implementation notes:** skip only when existing FFmpeg skip condition applies.

### 16.22 `/apps/server/test/player-ui.e2e.test.ts`

**File:** new UI API integration tests. **Purpose:** prove bootstrap/preferences/hubs/telemetry. **Responsibilities:** canonical bootstrap, first-read seed, update, conflict, overwrite, reset, legacy preference import payload, each preset, each hub source, cursor errors, telemetry enabled/disabled/invalid, and 32 KB body limit. **Imports:** Node test/assert, server harness, contracts. **Exports/classes/interfaces/functions:** test callbacks only. **Parameters/returns/exceptions:** harness. **Dependencies:** temporary SQLite and environment isolation. **Events:** none. **Configuration:** tests every key. **Caching:** assert no-store headers. **Transactions:** assert conflict leaves row unchanged. **Logging/telemetry/metrics:** snapshot assertions. **Security:** unknown keys and sensitive telemetry rejected. **Performance/concurrency:** concurrent same-revision PUT yields one 200 and one 409. **Failure behavior:** cleanup env/DB. **Unit tests:** none. **Integration tests:** all responsibilities. **Files interacting:** new server services/routes/schema. **Implementation notes:** reset module config cache between env cases.

### 16.23 `/apps/server/test/run-all.ts`

**File:** server test runner. **Purpose:** include new Player suites. **Responsibilities:** insert `test/player-ui.unit.test.ts` then `test/player-ui.e2e.test.ts` adjacent to existing Player tests. **Imports/exports/classes/interfaces/functions/methods/parameters/returns/exceptions/dependencies/events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency:** existing runner behavior. **Failure behavior:** propagate child failure. **Unit tests:** discovers Player unit file. **Integration tests:** discovers Player UI e2e file. **Files interacting:** both new server tests. **Implementation notes:** preserve deterministic test order.

### 16.24 `/apps/player/package.json`

**File:** Player manifest. **Purpose:** build and test the v2 SPA. **Responsibilities:** add workspace dependency `@archivist/contracts`; add `test`, `test:watch`, and `test:e2e` scripts; add dev dependencies `vitest@2.1.9`, `jsdom@25.0.1`, `@testing-library/react@16.1.0`, `@testing-library/user-event@14.5.2`, and `@playwright/test@1.49.1`; add no production runtime focus/state/icon library. **Imports/exports/classes/interfaces/functions/methods/parameters/returns/exceptions:** none. **Dependencies:** existing React/Vite/Tailwind plus listed test packages. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency:** none. **Failure behavior:** scripts propagate errors. **Unit tests/integration tests:** `test` runs Vitest once; `test:watch` watches; `test:e2e` runs Playwright Chromium. **Files interacting:** lockfile, root manifest, Vite/Playwright configs. **Implementation notes:** retain existing versions unless dependency resolution proves incompatibility; any version change requires explicit spec amendment.

### 16.25 `/apps/player/README.md`

**File:** Player README. **Purpose:** operator and contributor guide. **Responsibilities:** document v2 flag, presets, remote/keyboard/gamepad controls, same-origin architecture, preference storage, reset path, telemetry privacy, self-hosted fonts, clean-room boundary, test commands, rebuild/redeploy requirement, and rollback. **Imports/exports/classes/interfaces/functions/methods/parameters/returns/exceptions/dependencies/events/caching/transactions/logging/metrics/performance/concurrency:** documentation only. **Configuration:** reproduce section 18 table. **Telemetry/security/failure behavior:** explain exact behavior. **Unit tests/integration tests:** commands. **Files interacting:** all Player files and deployment. **Implementation notes:** state that production changes require rebuilding the image/bundle and redeploying unless running Vite development mode.

### 16.26 `/apps/player/tailwind.config.js`

**File:** Tailwind config. **Purpose:** bridge existing utility use to v2 tokens. **Responsibilities:** map noir/accent colors to CSS variables, add safe-area spacing and approved motion durations, and retain existing class compatibility. **Imports:** Tailwind config type only. **Exports:** default config. **Classes/interfaces/functions/methods/parameters/returns/exceptions/dependencies/events/configuration/caching/transactions/logging/telemetry/metrics/security/concurrency/failure behavior:** none. **Performance:** do not add runtime plugins. **Unit tests:** build detects missing classes. **Integration tests:** visual component tests use computed classes. **Files interacting:** index/tokens/motion CSS and components. **Implementation notes:** arbitrary values remain permitted; do not encode full layouts in the config.

### 16.27 `/apps/player/src/main.tsx`

**File:** React entry. **Purpose:** mount one application root. **Responsibilities:** import CSS in order `index.css`, `tokens.css`, `motion.css`; retain StrictMode; install no global mutation beyond root mount. **Imports:** React, ReactDOM, App, styles. **Exports/classes/interfaces/functions/methods/parameters/returns/exceptions:** none. **Dependencies:** DOM root `#root`. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency:** none. **Failure behavior:** missing root throws startup error rendered by browser; do not swallow. **Unit tests:** smoke import. **Integration tests:** SPA boot. **Files interacting:** App/styles/index.html. **Implementation notes:** service workers are out of scope.

### 16.28 `/apps/player/src/App.tsx`

**File:** application bootstrap and route selector. **Purpose:** choose legacy/v2 safely. **Responsibilities:** construct one SDK, request bootstrap, import legacy route tree lazily, render boot skeleton, select by server flag, hydrate store, establish error/retry surface, and preserve all existing routes. **Imports:** router, SDK, store, Shell, legacy pages. **Exports:** default `App`. **Classes/interfaces:** none. **Functions:** `App():JSX.Element`; private `LegacyApp` contains current behavior. **Parameters/returns:** none/element. **Exceptions:** bootstrap errors become UI state. **Dependencies:** bootstrap endpoint. **Events:** dispatch bootstrap success/failure. **Configuration:** feature flag from server only. **Caching:** SDK. **Transactions:** none. **Logging:** client error helper, no console in production. **Telemetry/metrics:** `bootstrap_ms`. **Security:** never accept feature flag from query/localStorage. **Performance:** legacy chunk loads only when flag false; v2 shell paints from single response. **Concurrency:** abort bootstrap on unmount. **Failure behavior:** Retry and legacy fallback button only when server reports flag false; network failure does not guess. **Unit tests:** flag branches/error. **Integration tests:** refresh each route. **Files interacting:** Shell, SDK, store, all pages. **Implementation notes:** no `Connect` route in production.

### 16.29 `/apps/player/src/index.css`

**File:** global CSS. **Purpose:** reset and baseline. **Responsibilities:** remove Google Fonts import; retain Tailwind directives; set body/root full viewport, overflow hidden for v2, base colors/type; provide scrollbar and screen-reader utilities. **Imports:** no remote URL. **Exports/classes/interfaces/functions/methods/parameters/returns/exceptions/dependencies/events/configuration/caching/transactions/logging/telemetry/metrics/security/concurrency/failure behavior:** CSS only. **Performance:** no global blur, animated background, or expensive universal transition. **Unit tests:** stylesheet build. **Integration tests:** CSP with no external font. **Files interacting:** token/motion CSS, Shell. **Implementation notes:** legacy scrolling is scoped under `.legacy-player` so rollback remains usable.

### 16.30 `/apps/player/src/styles/tokens.css`

**File:** visual tokens. **Purpose:** one exact v2 design vocabulary. **Responsibilities:** define section 12.1 tokens, typography scales, card sizes, elevations, z-index layers, safe areas, breakpoints via media queries, high contrast, and text scaling. **Imports/exports:** CSS variables on `.player-v2`. **Classes/interfaces/functions/methods/parameters/returns/exceptions/dependencies/events/configuration/caching/transactions/logging/telemetry/metrics/security/concurrency/failure behavior:** none. **Performance:** variables only. **Unit tests:** snapshot expected token names. **Integration tests:** 720p/1080p/4K computed layout. **Files interacting:** every v2 component. **Implementation notes:** no Arctic Fuse names or extracted constants in source comments.

### 16.31 `/apps/player/src/styles/motion.css`

**File:** motion primitives. **Purpose:** deterministic transitions. **Responsibilities:** define 80/140/180/280 ms opacity/focus/rail/backdrop transitions, skeleton pulse, OSD entrance, and reduced-motion overrides. **Imports/exports:** CSS classes and keyframes. **Classes/interfaces/functions/methods/parameters/returns/exceptions/dependencies/events/configuration/caching/transactions/logging/telemetry/metrics/security/concurrency/failure behavior:** none. **Performance:** animate opacity/transform only; no width animation on card collections, filter, or backdrop-filter. **Unit tests:** stylesheet build. **Integration tests:** reduced motion disables transform/smooth scroll. **Files interacting:** Shell, Hub, Cards, OSD. **Implementation notes:** rail uses transform/clip, not layout-thrashing per-frame width.

### 16.32 `/apps/player/src/focus/navigation.ts`

**File:** spatial focus engine. **Purpose:** deterministic remote navigation independent of React. **Responsibilities:** registry, scopes, algorithm section 12.3, focus memory, zone neighbors, movement lock, scroll, modality, and cleanup. **Imports:** contract-free DOM types. **Exports:** `Direction`, `InputModality`, `FocusRegistration`, `FocusController`, `createFocusController`. **Classes:** private `SpatialFocusController` implementing interface. **Functions:** `createFocusController():FocusController`; pure `scoreCandidate` exported for tests. **Parameters/returns:** section 15. **Exceptions:** duplicate active IDs throw in development and replace-with-warning in production. **Dependencies:** DOMRect, performance clock. **Events:** consumes key/gamepad/pointer intents via provider. **Configuration:** constants exactly section 12.3. **Caching:** rects for one movement frame only. **Transactions/logging/telemetry/metrics/security:** none. **Performance:** 2 ms p95 with 500 targets; no layout read outside move. **Concurrency:** movement lock; registration cleanup. **Failure behavior:** retain current focus if no candidate. **Unit tests:** all directions, ties, zones, hidden/disabled, scopes, restoration. **Integration tests:** shell tests. **Files interacting:** FocusProvider, all focusable components. **Implementation notes:** no React import.

### 16.33 `/apps/player/src/focus/FocusProvider.tsx`

**File:** React focus adapter. **Purpose:** bind inputs and components to navigation. **Responsibilities:** context, `useFocusable`, keyboard mapping, gamepad poll, pointer modality, scope push/pop, activation, Back callback, and ARIA tab index. **Imports:** React, navigation engine. **Exports:** `FocusProvider`, `useFocusController`, `useFocusable`, `useInputModality`. **Classes:** none. **Interfaces:** provider props and hooks from section 15. **Functions/methods:** hooks with exact interfaces. **Parameters/returns:** React props/results. **Exceptions:** hooks outside provider throw descriptive error. **Dependencies:** browser event APIs/Gamepad API. **Events:** adds global listeners on mount and removes on unmount. **Configuration:** key map section 12.3. **Caching:** controller in ref. **Transactions/logging:** none. **Telemetry/metrics:** when telemetry is enabled, report `player_focus_move_ms` for every twentieth successful move; never send IDs. **Security:** ignore synthetic untrusted global activation except tests. **Performance:** one RAF only while gamepad connected/available. **Concurrency:** prevent repeat and stale closures. **Failure behavior:** keyboard still works when Gamepad API missing. **Unit tests:** listener cleanup/key maps/hooks. **Integration tests:** shell/modal/OSD navigation. **Files interacting:** Shell and every interactive component. **Implementation notes:** only one provider may own document listeners.

### 16.34 `/apps/player/src/lib/sdk.ts`

**File:** typed HTTP client. **Purpose:** sole Player network boundary. **Responsibilities:** import shared contracts; retain all methods; add bootstrap/preferences/reset/hub/telemetry/metrics/paged search methods; support AbortSignal; route-aware TTLs; invalidate hubs after preference/progress writes; normalize error contract. **Imports:** contracts only. **Exports:** `ArchivistSdk`, `PlayerSdkError`, `clearSdkCache`; re-exporting contract types is forbidden. **Classes:** SDK and typed error. **Functions/method signatures:** existing plus `bootstrap(profile,signal)`, `updatePreferences(input,signal)`, `resetPreferences(input,signal)`, `hub(input,signal)`, `telemetry(batch)`, `metrics()`. **Parameters/returns:** shared contracts. **Exceptions:** `PlayerSdkError(status,code,requestId,message,details)`. **Dependencies:** fetch/AbortController. **Events/configuration:** same-origin connection. **Caching:** bootstrap no cache; hubs 15 s; details 30 s; libraries 60 s; track probes per playback item; max 100 JSON entries with LRU eviction. **Transactions:** none. **Logging:** none. **Telemetry:** batch with `sendBeacon` fallback to fetch keepalive. **Security:** credentials include; no API key in v2 same-origin URLs. **Performance:** request deduplication by URL. **Concurrency:** shared in-flight promise; abort removes only subscriber and aborts underlying when none remain. **Failure behavior:** typed errors. **Unit tests:** TTL/dedupe/abort/errors/invalidation. **Integration tests:** component mocks and server e2e. **Files interacting:** store/pages/player. **Implementation notes:** retain asset URL behavior for standalone dev.

### 16.35 `/apps/player/src/lib/store.ts`

**File:** central external store. **Purpose:** deterministic v2 session state while preserving legacy exports during rollout. **Responsibilities:** normalized bootstrap, preferences envelope/draft, progress, route focus memory, media context, modal stack, playback state, reducer events, subscriptions, legacy facade. **Imports:** React external-store hook and contracts. **Exports:** `playerStore`, `usePlayerSelector`, typed actions; existing legacy functions until phase 5. **Classes:** `PlayerStore` with `getState`, `dispatch`, `subscribe`. **Interfaces:** `PlayerState`, `PlayerAction`. **Functions/methods:** reducer is pure; selectors exported. **Parameters/returns:** typed state/action. **Exceptions:** invalid transitions throw only in development. **Dependencies:** localStorage for progress mirror/search/focus cache only. **Events:** section 13 local union. **Configuration:** none. **Caching:** in-memory normalized maps. **Transactions:** dispatch atomic per action. **Logging:** production errors through error boundary, no state dump. **Telemetry/metrics:** playback/UI timings dispatched separately. **Security:** never store token, file path, full API error body, or search on server. **Performance:** selector equality prevents unrelated renders. **Concurrency:** functional reducer; late response keyed by request ID. **Failure behavior:** retain last good state. **Unit tests:** every action and stale response. **Integration tests:** pages. **Files interacting:** App, Shell, pages, Player. **Implementation notes:** do not add Redux/Zustand.

### 16.36 `/apps/player/src/lib/preferences.ts`

**File:** client preference migration/presets. **Purpose:** bridge legacy local settings once. **Responsibilities:** validate server document defensively, map `archivist-player-settings` fields to v1, apply preset matrix, compare drafts, and emit complete update request. **Imports:** shared contracts. **Exports:** `migrateLegacySettings`, `applyPreset`, `isPreferencesDirty`, `readLegacySettings`, `clearLegacySettingsAfterImport`. **Classes:** none. **Functions:** pure except named localStorage read/clear. **Parameters/returns:** unknown input to validated partial/full results. **Exceptions:** malformed local JSON returns no migration. **Dependencies:** legacy keys exactly section 9/current store. **Events/configuration/caching/transactions/logging/telemetry/metrics:** none. **Security:** ignore legacy connection/apiKey and unknown fields. **Performance:** O(widget count). **Concurrency:** import only when server migration flag false; one PUT wins via revision. **Failure behavior:** leave legacy key untouched until successful PUT, then clear settings key but retain progress key. **Unit tests:** every mapping/malformed/conflict retry choice. **Integration tests:** first v2 boot. **Files interacting:** App/store/Settings. **Implementation notes:** map `hero` rail style to `landscape` plus spotlight; clamp limits to nearest allowed value upward.

### 16.37 `/apps/player/src/lib/useMediaGain.ts`

**File:** media gain hook. **Purpose:** preserve volume normalization. **Responsibilities:** read playback preferences from selector instead of legacy settings and preserve current Web Audio behavior. **Imports:** React, store selector. **Exports/functions/methods/parameters/returns/exceptions/dependencies/events/caching/transactions/logging/telemetry/metrics/security/performance/concurrency/failure behavior:** existing contract except settings source. **Unit tests:** preference changes and cleanup. **Integration tests:** Player normalization. **Files interacting:** Player/SessionPlayer/store. **Implementation notes:** do not create multiple AudioContexts for one element.

### 16.38 `/apps/player/src/components/Shell.tsx`

**File:** v2 shell. **Purpose:** global living-room frame. **Responsibilities:** side rail, route outlet, backdrop crossfade, contextual header/clock, modal/toast layers, Back hierarchy, safe areas, and focus restore. **Imports:** router, FocusProvider, store, Hub primitives. **Exports:** `PlayerShell`. **Classes:** none. **Interfaces:** `PlayerShellProps {sdk;bootstrap}`. **Functions:** component plus private navigation definitions. **Parameters/returns:** props/JSX. **Exceptions:** child errors caught by route error boundary. **Dependencies:** focus/store/router. **Events:** route/focus/modal actions. **Configuration:** edge rail/showClock. **Caching:** two artwork URLs. **Transactions:** none. **Logging:** error boundary uses structured client reporter. **Telemetry/metrics:** shell ready/backdrop decode. **Security:** nav routes hardcoded. **Performance:** one clock interval aligned to minute; max two backdrop images. **Concurrency:** stale image decode ignored by context key. **Failure behavior:** artwork failure keeps prior backdrop then gradient. **Unit tests:** nav order/protected Settings/Back. **Integration tests:** remote smoke. **Files interacting:** App, pages, focus. **Implementation notes:** no top navigation in v2.

### 16.39 `/apps/player/src/components/Hub.tsx`

**File:** shared hub presentation. **Purpose:** compose categories, spotlight, widgets, information, skeleton, and errors. **Responsibilities:** focused context delay, preset layouts, spotlight metadata/action, combined selector, row-level pagination, empty states, and options drawer. **Imports:** contracts, store, Cards, Rail, focus. **Exports:** `Hub`, `Spotlight`, `InfoPanel`, `HubSkeleton`, `WidgetErrorCard`. **Classes:** none. **Interfaces:** explicit props using `PlayerHub`/`PlayerMediaCard`. **Functions:** components only; no fetch. **Parameters/returns:** props/JSX. **Exceptions:** none. **Dependencies:** parent page loads data. **Events:** focus context and activation callbacks. **Configuration:** preset/preferences. **Caching/transactions/logging/telemetry/metrics/security:** none. **Performance:** memoize rows by widget ID/revision; no offscreen image eager load. **Concurrency:** 100 ms focus timer cancellation. **Failure behavior:** local error card/retry callback. **Unit tests:** four presets, empties, focus timer. **Integration tests:** Home/Library. **Files interacting:** Shell/pages/Cards/Rail. **Implementation notes:** no media-specific SQL/API knowledge.

### 16.40 `/apps/player/src/components/Cards.tsx`

**File:** media card primitives. **Purpose:** consistent focusable media representations. **Responsibilities:** poster/landscape/wall/list variants, watched/progress/availability/badges, placeholder, pointer-to-focus, image lazy/decode policy, and activation. **Imports:** router, contracts, focus. **Exports:** `MediaCard`, `PosterCard`, `LandscapeCard`, `WallCard`, `ListCard`, `CardPlaceholder`; old aliases during rollout. **Classes:** none. **Interfaces:** `MediaCardProps {item;view;zoneId;onFocused;onActivate}`. **Functions:** components and `getCardFocusId(item)`. **Parameters/returns:** props/JSX/string. **Exceptions:** none. **Dependencies:** focus/router. **Events:** focus/activate. **Configuration:** token CSS. **Caching:** browser image cache; decoded-image LRU coordinated in module, 80 URLs. **Transactions/logging/telemetry/metrics:** none. **Security:** URLs applied only to img/style image after rejecting `javascript:` and non-http/data/relative schemes. **Performance:** `loading=lazy`, `decoding=async`; focused next-neighbor preload only. **Concurrency:** cancel stale decode. **Failure behavior:** placeholder. **Unit tests:** all variants/statuses/URL guard. **Integration tests:** focus. **Files interacting:** Hub/Rail/pages. **Implementation notes:** no fetch and no local progress calculation beyond display percentage.

### 16.41 `/apps/player/src/components/Rail.tsx`

**File:** widget row. **Purpose:** horizontal/vertical focus zone and bounded rendering. **Responsibilities:** title/count, card window, pagination trigger, edge behavior, focus memory, and list/wall layout. **Imports:** Cards, focus, contracts. **Exports:** `Rail`. **Classes:** none. **Interfaces:** `RailProps {widget;focusedKey;onLoadMore;onItemFocused;onActivate}`. **Functions:** component and pure visible-window calculator. **Parameters/returns:** props/JSX. **Exceptions:** none. **Dependencies:** ResizeObserver. **Events:** load more once when focus enters last three items. **Configuration:** view tokens. **Caching:** retain at most current items supplied by parent. **Transactions/logging/telemetry/metrics/security:** none. **Performance:** window rows above 36 items with 2-card overscan; maintain spacer geometry. **Concurrency:** one in-flight cursor per widget. **Failure behavior:** retry sentinel retains focus. **Unit tests:** window, cursor dedupe, edge. **Integration tests:** hub navigation. **Files interacting:** Hub/Cards/pages. **Implementation notes:** current browser scrollbar is hidden; remote scroll is focus-driven.

### 16.42 `/apps/player/src/components/Player.tsx`

**File:** single-item playback engine component. **Purpose:** direct/transcode playback lifecycle. **Responsibilities:** preserve source selection, progress, resume, errors, tracks, subtitle, loudness; delegate visuals/input to VideoOsd and UpNext. **Imports:** SDK/contracts/store/gain/OSD. **Exports:** `Player`. **Classes:** none. **Interfaces:** existing props extended with `originFocusId`, `nextItem`, `onAdvance`. **Functions:** component and testable progress threshold helpers. **Parameters/returns:** props/JSX. **Exceptions:** converted to playback error state. **Dependencies:** browser video, SDK. **Events:** playback store actions. **Configuration:** playback preferences. **Caching:** track result per item. **Transactions:** progress requests. **Logging:** error code/request ID, no URL query. **Telemetry/metrics:** start, first frame, probe, transcode restart, fatal error. **Security:** opaque stream URLs. **Performance:** avoid state update on every timeupdate; sample UI at 250 ms, persist 10 s. **Concurrency:** abort probe/transcode selection on item change. **Failure behavior:** retry direct once only via existing fallback; user-visible choices Retry/Close. **Unit tests:** thresholds/progress/source transitions. **Integration tests:** media e2e/OSD. **Files interacting:** detail pages/SessionPlayer/OSD. **Implementation notes:** no new codec policy.

### 16.43 `/apps/player/src/components/SessionPlayer.tsx`

**File:** Channels queue playback. **Purpose:** preserve scheduled session modes with v2 OSD. **Responsibilities:** existing queue/current item/completion plus supply next item and Up Next callbacks to Player; restore TV focus on stop. **Imports:** Player, SDK/contracts/store. **Exports:** `SessionPlayer`. **Classes/interfaces/functions/methods/parameters/returns/exceptions/dependencies/events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency/failure behavior:** existing behavior, with origin focus and exact next-item failure rules section 12.8. **Unit tests:** auto-advance/cancel/missing next/stop restore. **Integration tests:** Channels session API. **Files interacting:** Channels, Player, UpNext. **Implementation notes:** `JOIN_LIVE`, `WATCH_FROM_HERE`, and `PLAY_THIS_ONLY` semantics do not change.

### 16.44 `/apps/player/src/components/TrackMenu.tsx`

**File:** audio/subtitle selection content. **Purpose:** reusable track lists inside OSD panels. **Responsibilities:** split content from overlay, show loading/empty/default/forced/language/codec/channels, provide Off for subtitles, and expose focus IDs. **Imports:** contracts/focus. **Exports:** `AudioTrackList`, `SubtitleTrackList`; retain `TrackMenu` compatibility wrapper during rollout. **Classes:** none. **Interfaces:** explicit list props and selection callbacks. **Functions:** components, `trackLabel`. **Parameters/returns:** tracks/JSX/string. **Exceptions:** none. **Dependencies:** none beyond focus. **Events:** selection callbacks. **Configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency:** none. **Failure behavior:** local empty state. **Unit tests:** labels/forced/default/off/focus. **Integration tests:** OSD. **Files interacting:** VideoOsd/Player. **Implementation notes:** no fetch or transcode decision.

### 16.45 `/apps/player/src/components/osd/VideoOsd.tsx`

**File:** layered playback UI. **Purpose:** exact OSD behavior section 12.8. **Responsibilities:** base overlay, timers, controls, seek state, pause info, right panels, focus scopes, keyboard/media commands, buffered/progress display, fullscreen/mute, and ARIA. **Imports:** React, focus, contracts, TrackMenu, store. **Exports:** `VideoOsd`, `formatPlaybackTime`, `getSeekStep`. **Classes:** none. **Interfaces:** `VideoOsdProps` contains immutable media metadata, playback snapshot, capability callbacks, tracks state, next state. **Functions/methods:** component and pure helpers. **Parameters/returns:** props/JSX. **Exceptions:** callback rejection becomes panel error. **Dependencies:** no SDK/fetch. **Events:** input/playback callbacks. **Configuration:** fixed timers/seek values. **Caching/transactions/logging:** none. **Telemetry/metrics:** OSD open latency and panel error. **Security:** metadata rendered as text. **Performance:** initial render uses memory only; no blur; under 3 ms script at p95. **Concurrency:** reset hide timer on input; cancel all timers on unmount. **Failure behavior:** panel error preserves base controls. **Unit tests:** every timer/control/scope/seek rule. **Integration tests:** Player. **Files interacting:** Player/SessionPlayer/TrackMenu/UpNext. **Implementation notes:** use SVG icons authored for Archivist or existing licensed icon primitives; no emoji controls.

### 16.46 `/apps/player/src/components/osd/UpNext.tsx`

**File:** next-item overlay. **Purpose:** deterministic episodic/session advance. **Responsibilities:** threshold helper, 15-second countdown, play/cancel, artwork/identity, accessibility announcement, and one-time cancellation. **Imports:** contracts/focus. **Exports:** `UpNext`, `shouldShowUpNext`. **Classes:** none. **Interfaces:** `UpNextProps {currentTime;duration;nextItem;cancelled;onPlay;onCancel}`. **Functions:** component and pure threshold. **Parameters/returns:** props/boolean/JSX. **Exceptions:** none. **Dependencies:** timer. **Events:** callbacks. **Configuration:** values section 12.8. **Caching/transactions/logging/telemetry/metrics/security:** none. **Performance:** one one-second interval only while visible. **Concurrency:** deadline derived from monotonic time, not decrement drift. **Failure behavior:** missing/unavailable item returns null. **Unit tests:** thresholds/countdown/cancel/visibility. **Integration tests:** SessionPlayer. **Files interacting:** Player/VideoOsd. **Implementation notes:** does not call SDK.

### 16.47 `/apps/player/src/pages/Home.tsx`

**File:** Home hub route. **Purpose:** render server-composed initial/home hub. **Responsibilities:** consume bootstrap hub, refresh stale hub, merge cursor pages, render Hub, route media activation, and preserve Home focus. **Imports:** SDK/store/Hub/contracts/router. **Exports:** `Home`. **Classes:** none. **Interfaces/functions:** route component; no source resolver. **Parameters/returns:** SDK/JSX. **Exceptions:** typed errors to Hub. **Dependencies:** hub endpoint. **Events:** route entered/context. **Configuration:** preferences from store. **Caching:** SDK. **Transactions/logging:** none. **Telemetry/metrics:** hub ready. **Security:** no admin terms. **Performance:** remove full film/series fetch and 9 s hero timer. **Concurrency:** abort stale request. **Failure behavior:** last good hub plus retry. **Unit tests:** bootstrap reuse/refresh/paging. **Integration tests:** shell. **Files interacting:** App/Hub/SDK. **Implementation notes:** delete current client `resolve` switch only after flag v2 branch exists.

### 16.48 `/apps/player/src/pages/Library.tsx`

**File:** Films/Series hub route. **Purpose:** remote-first browsable collection. **Responsibilities:** hub/category/filter/sort/view, cursor paging, item activation, focus persistence by kind/library, empty/error/loading. **Imports:** SDK/store/Hub/contracts/router. **Exports:** `Library`. **Classes:** none. **Interfaces:** existing `kind:'films'|'series'`. **Functions:** route component and query builder. **Parameters/returns:** props/JSX. **Exceptions:** typed errors. **Dependencies:** hubs and paged legacy list endpoints only for flag fallback. **Events:** preferences draft only on confirmed view. **Configuration:** per-kind preferences. **Caching:** SDK. **Transactions/logging:** none. **Telemetry/metrics:** library ready/pagination. **Security:** filters whitelist. **Performance:** never render full 10k collection; request 36 poster/wall or 60 list items. **Concurrency:** abort on filter change. **Failure behavior:** retain items while retrying. **Unit tests:** queries/view retention/filter. **Integration tests:** navigation. **Files interacting:** Hub/Cards/Settings. **Implementation notes:** category selector is distinct from library admin tabs.

### 16.49 `/apps/player/src/pages/FilmDetail.tsx`

**File:** film detail route. **Purpose:** focused film information and playback entry. **Responsibilities:** layout/action zones section 12.5, resume/restart/watched, cast, unavailable state, modal Player, origin focus restoration. **Imports:** SDK/store/focus/Player/contracts/Hub primitives. **Exports:** `FilmDetailPage`. **Classes:** none. **Interfaces/functions:** route component and action builder. **Parameters/returns:** SDK/JSX. **Exceptions:** 404 has Not Found with Back; others Retry. **Dependencies:** film/progress API. **Events:** progress/playback. **Configuration:** accessibility/playback. **Caching:** SDK detail. **Transactions:** progress writes. **Logging/telemetry/metrics/security:** no title/path telemetry; opaque streams. **Performance:** one detail request; lazy cast images. **Concurrency:** abort route change. **Failure behavior:** described errors. **Unit tests:** action priority/unavailable/resume thresholds. **Integration tests:** playback. **Files interacting:** Player/Shell/SDK. **Implementation notes:** no acquisition or trailer UI.

### 16.50 `/apps/player/src/pages/SeriesDetail.tsx`

**File:** series detail route. **Purpose:** seasons, episodes, and Resume Next. **Responsibilities:** exact season/episode behavior section 12.5, watched/progress, episode info, Player modal, focus retention. **Imports:** SDK/store/focus/Player/contracts. **Exports:** `SeriesDetailPage`. **Classes:** none. **Interfaces/functions:** route component, pure season sorting/action helpers. **Parameters/returns:** SDK/JSX. **Exceptions:** same detail error handling. **Dependencies:** series detail/progress. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency/failure behavior:** parallel FilmDetail, with potentially large episode lists windowed above 40. **Unit tests:** season 0, episode IDs, next action, unavailable. **Integration tests:** episode playback/Up Next. **Files interacting:** Player/Cards/SDK. **Implementation notes:** omit all scan/search/upgrade controls from consumer Player.

### 16.51 `/apps/player/src/pages/SearchPage.tsx`

**File:** search hub. **Purpose:** grouped remote-friendly discovery. **Responsibilities:** section 12.6 keyboard, debounce, cancellation, history, grouped results, focus movement, and activation. **Imports:** SDK/store/focus/Cards/contracts/router. **Exports:** `SearchPage`. **Classes:** none. **Interfaces/functions:** component; pure keyboard layout and history sanitizer. **Parameters/returns:** SDK/JSX. **Exceptions:** typed error row. **Dependencies:** grouped search API/localStorage history key `archivist-player-search-history-v1`. **Events:** query locally only. **Configuration:** none. **Caching:** no SDK result cache beyond in-flight dedupe. **Transactions/logging/telemetry/metrics:** search query and response timing are not logged or telemetered because section 27 defines no search metric. **Security:** render text, 120-code-point client cap. **Performance:** 250 ms debounce, max 30/group. **Concurrency:** AbortController. **Failure behavior:** keep query/keyboard and Retry. **Unit tests:** debounce/history/Unicode/cancel. **Integration tests:** group results. **Files interacting:** Shell/SDK/Cards. **Implementation notes:** browser URL contains `q` only after explicit submit; history is local.

### 16.52 `/apps/player/src/pages/Channels.tsx`

**File:** TV hub/guide. **Purpose:** preserve Channels in v2 shell. **Responsibilities:** wrap existing guide in hub visual hierarchy; make channel rows, time slots, and action sheet focus zones; retain three session modes; restore slot focus after playback; use contextual backdrop. **Imports:** existing SDK/contracts, focus, Shell primitives, SessionPlayer. **Exports:** `ChannelsPage`. **Classes/interfaces/functions/methods/parameters/returns/exceptions/dependencies/events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency/failure behavior:** existing guide semantics plus deterministic focus and abortable loads. **Unit tests:** grid direction, mode sheet, focus restore. **Integration tests:** existing Channels e2e. **Files interacting:** SessionPlayer/Shell/SDK. **Implementation notes:** no EPG schema or scheduler change.

### 16.53 `/apps/player/src/pages/Settings.tsx`

**File:** v2 settings hub. **Purpose:** safe bounded customization. **Responsibilities:** sections 12.7 and 9 preset/draft/save/conflict/reset/widget/library/playback/accessibility/about behavior. **Imports:** SDK/store/preferences/focus/contracts/Hub primitives. **Exports:** `SettingsPage`. **Classes:** none. **Interfaces/functions:** component and validation presentation helpers. **Parameters/returns:** SDK/JSX. **Exceptions:** typed validation/conflict/server errors become dialogs. **Dependencies:** preference API. **Events:** draft/save/reset. **Configuration:** displays public runtime config read-only. **Caching:** draft in store only. **Transactions:** server revision PUT. **Logging/telemetry/metrics:** save outcome only, no document. **Security:** no arbitrary source/markup; Settings immutable in nav. **Performance:** previews are CSS schematics. **Concurrency:** conflict flow exact section 13. **Failure behavior:** dirty draft retained on failed Save. **Unit tests:** presets, dirty exit, conflict, reset, reorder. **Integration tests:** persistence/reload. **Files interacting:** preferences/store/Shell/SDK. **Implementation notes:** legacy immediate-write controls exist only in LegacyApp.

### 16.54 `/apps/player/test/setup.ts`

**File:** frontend test setup. **Purpose:** deterministic browser API fakes. **Responsibilities:** install cleanup, matchMedia, ResizeObserver, DOMRect, requestAnimationFrame, HTMLMediaElement, fullscreen, and Gamepad stubs; reset localStorage/timers. **Imports:** Vitest/testing-library. **Exports:** typed helper factories for media cards and rects. **Classes:** minimal ResizeObserver fake. **Functions:** factories/reset. **Parameters/returns/exceptions:** test-only. **Dependencies:** jsdom. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency/failure behavior:** test-only. **Unit tests:** not separately tested. **Integration tests:** all frontend suites use setup. **Files interacting:** test config/package. **Implementation notes:** no production import may reference test setup.

### 16.55 `/apps/player/test/navigation.test.ts`

**File:** focus engine tests. **Purpose:** exhaust algorithm. **Responsibilities:** section 12.3 scoring, overlap, explicit neighbors, ties, lock, scroll, restoration, scopes, hidden/disabled, modality, gamepad thresholds, cleanup. **Imports:** Vitest, navigation/provider test harness. **Exports/classes/interfaces/functions:** tests only. **Parameters/returns/exceptions/dependencies/events/configuration/caching/transactions/logging/telemetry/metrics/security:** none. **Performance:** construct 500 targets and assert one move completes below 20 ms in CI; product p95 is telemetry criterion. **Concurrency/failure behavior:** fake timers. **Unit tests:** all. **Integration tests:** provider DOM. **Files interacting:** focus files. **Implementation notes:** use deterministic rectangles, not jsdom layout.

### 16.56 `/apps/player/test/preferences.test.ts`

**File:** preference tests. **Purpose:** exact local migration/preset behavior. **Responsibilities:** canonical four presets, legacy rails/styles/limits, ignored connection, malformed JSON, delayed clear, dirty compare, conflict request. **Imports:** Vitest, preferences/contracts. **Exports/classes/interfaces/functions:** tests only. **Dependencies:** setup localStorage. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency:** none. **Failure behavior:** assertions. **Unit tests:** all responsibilities. **Integration tests:** Settings suite. **Files interacting:** preferences/store. **Implementation notes:** fixture documents are complete schema v1.

### 16.57 `/apps/player/test/shell.test.tsx`

**File:** shell/hub component tests. **Purpose:** prove living-room navigation hierarchy. **Responsibilities:** nav order, expansion, protected Settings, Back order, route restoration, four presets, focus-driven backdrop, 100 ms debounce, empty/error, view preservation, pointer/remote modality, accessibility roles. **Imports:** Vitest/testing-library/router/providers. **Exports/classes/interfaces/functions:** tests only. **Dependencies:** setup/mocked SDK. **Events/configuration/caching/transactions/logging/telemetry/metrics/security:** assertions. **Performance:** fake image decode and timers. **Concurrency:** stale artwork test. **Failure behavior:** assertions. **Unit tests:** component-level. **Integration tests:** multi-route memory. **Files interacting:** Shell/Hub/Cards/Rail/pages. **Implementation notes:** no snapshot-only acceptance; assert behavior and accessible names.

### 16.58 `/apps/player/test/osd.test.tsx`

**File:** OSD tests. **Purpose:** exhaust playback presentation without real media. **Responsibilities:** 50 ms no-fetch open, 3 s hide, pause persistence/600 ms info, panels/scopes, all key commands, seek acceleration/clamp, track loading/error, Up Next threshold/countdown/cancel, stop restoration, reduced motion, ARIA. **Imports:** Vitest/testing-library/focus/OSD. **Exports/classes/interfaces/functions:** tests only. **Dependencies:** fake timers/media stubs. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency/failure behavior:** asserted from callbacks; `global.fetch` must be a throwing spy during base OSD open. **Unit tests:** helpers. **Integration tests:** components. **Files interacting:** VideoOsd/UpNext/TrackMenu/Player. **Implementation notes:** include rapid open/close timer-leak test.

### 16.59 `/apps/player/vite.config.ts`

**File:** Vite/Vitest configuration. **Purpose:** deterministic build/dev/unit-test configuration. **Responsibilities:** preserve React plugin, ports, and build output; change config import to `vitest/config`; add `test: {environment:'jsdom', setupFiles:['./test/setup.ts'], include:['test/**/*.test.{ts,tsx}'], restoreMocks:true, clearMocks:true, unstubGlobals:true}`. **Imports:** `defineConfig` from Vitest config and React plugin. **Exports:** default config. **Classes/interfaces/functions/methods/parameters/returns/exceptions:** none. **Dependencies:** Vite/Vitest. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency:** build/test configuration only. **Failure behavior:** invalid config fails command. **Unit tests:** all unit/component suites prove setup loading. **Integration tests:** Vite dev server supports Playwright. **Files interacting:** manifest, test setup, Playwright config. **Implementation notes:** do not add proxying or API secrets.

### 16.60 `/apps/player/playwright.config.ts`

**File:** Playwright configuration. **Purpose:** one deterministic Chromium remote smoke. **Responsibilities:** test directory `test/e2e`, one worker in CI, one retry in CI, trace on first retry, screenshot on failure, base URL `http://127.0.0.1:4242`, 30-second test timeout, and web server command `pnpm dev --host 127.0.0.1` with reuse outside CI. **Imports:** Playwright config. **Exports:** default config. **Classes/interfaces/functions/methods/parameters/returns/exceptions:** none. **Dependencies:** Playwright Chromium and Vite. **Events/configuration/caching/transactions/logging/telemetry/metrics/security:** test-only. **Performance:** smoke must finish under 30 seconds. **Concurrency:** one worker prevents shared route-fixture races. **Failure behavior:** retain trace/screenshot artifact. **Unit tests:** none. **Integration tests:** remote smoke. **Files interacting:** manifest, Vite config, CI workflow. **Implementation notes:** Firefox/WebKit remain manual matrix items in this release.

### 16.61 `/apps/player/test/e2e/remote-smoke.spec.ts`

**File:** Chromium remote-navigation smoke. **Purpose:** automate the release-critical D-pad journey without a live media library. **Responsibilities:** intercept every `/api/v1/player/*` call with complete shared-contract fixtures; fail on any unhandled request; stub HTMLMediaElement deterministically; execute Home → Film → Play → OSD → Audio → Back → Stop → restored Film focus → Home → Settings → Reset cancel using only Arrow, Enter, Escape; assert accessible names and focused semantic IDs after each transition. **Imports:** Playwright test/expect and contract fixture types. **Exports/classes/interfaces/functions:** tests and private route-fixture helper. **Parameters/returns/exceptions:** test-only. **Dependencies:** Vite v2 app with feature flag fixture true. **Events/configuration/caching/transactions/logging/telemetry/metrics/security:** telemetry fixture disabled; assert no external request. **Performance:** no arbitrary sleep; wait on roles/state. **Concurrency:** one page/test. **Failure behavior:** unhandled network or focus mismatch fails. **Unit tests:** none. **Integration tests:** the smoke itself. **Files interacting:** App/Shell/Home/Film/Player/OSD/Settings. **Implementation notes:** fixture titles/assets are original synthetic values and local data URLs.

### 16.62 `/.github/workflows/verify.yml`

**File:** CI verification workflow. **Purpose:** block merges on build/test/browser regressions. **Responsibilities:** run on pull requests and pushes to main; use `actions/checkout@v4`, `pnpm/action-setup@v4` with version `9.15.9`, `actions/setup-node@v4` with Node `20` and pnpm cache, `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm --dir apps/player exec playwright install --with-deps chromium`, `pnpm --filter archivist-player test:e2e`, and `actions/upload-artifact@v4` on failure with path `apps/player/playwright-report` and retention seven days. **Imports/exports/classes/interfaces/functions/methods/parameters/returns/exceptions:** YAML workflow only. **Dependencies:** GitHub-hosted Ubuntu and the named actions. **Events:** PR/push. **Configuration/caching:** pnpm store cache only. **Transactions/logging/telemetry/metrics/security:** permissions `contents: read`; no secret; no publish. **Performance:** 30-minute job timeout. **Concurrency:** group `verify-<git-ref>` with cancel-in-progress true. **Failure behavior:** any command blocks merge. **Unit tests/integration tests:** executes all. **Files interacting:** root/Player scripts and Playwright config. **Implementation notes:** Docker publish workflow remains separate and unchanged.

### 16.63 `/apps/server/test/player-ui.unit.test.ts`

**File:** server Player unit suite. **Purpose:** own pure/service-level tests declared by sections 16.11–16.15. **Responsibilities:** config parsing, serializer null/malformed/path safety, preference validation/presets/immutability, cursor encode/decode and stable page boundaries, hub-source SQL against in-memory fixtures, and telemetry buckets. **Imports:** Node test/assert, DB fixture helper, contracts, new Player services. **Exports/classes/interfaces/functions:** tests only. **Dependencies:** in-memory SQLite; no HTTP listener. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency/failure behavior:** assert declared service behavior. **Unit tests:** all responsibilities. **Integration tests:** none. **Files interacting:** config, serializers, preferences, hub service, telemetry. **Implementation notes:** restore environment and DB after each test.

### 16.64 `/apps/player/test/sdk-store.test.ts`

**File:** SDK/store unit suite. **Purpose:** own network/cache/reducer tests declared in sections 16.34–16.35. **Responsibilities:** typed error mapping, TTL/LRU, dedupe, abort subscribers, invalidation, beacon fallback, every reducer action, stale-response rejection, selector notification, local progress/search/focus storage privacy, and StrictMode-safe cleanup. **Imports:** Vitest, SDK, store, contract fixtures. **Exports/classes/interfaces/functions:** tests only. **Dependencies:** jsdom fetch/beacon fakes. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency/failure behavior:** asserted. **Unit tests:** all responsibilities. **Integration tests:** none. **Files interacting:** SDK/store/setup. **Implementation notes:** fake clock controls every TTL.

### 16.65 `/apps/player/test/pages.test.tsx`

**File:** route/page component suite. **Purpose:** own page tests declared in sections 16.47–16.53. **Responsibilities:** Home bootstrap/paging, Library filter/view/focus, film action priority, series Specials/Resume Next/windowing, search Unicode/debounce/cancel/history/groups, Channels focus/session modes, and Settings drafts/conflict/reset/reorder. **Imports:** Vitest/testing-library, memory router, providers, SDK mock, fixtures. **Exports/classes/interfaces/functions:** tests only. **Dependencies:** setup and route components. **Events/configuration/caching/transactions/logging/telemetry/metrics/security/performance/concurrency/failure behavior:** asserted per page specifications. **Unit tests:** component-level. **Integration tests:** route transitions with store/focus. **Files interacting:** all pages, SDK/store/focus. **Implementation notes:** do not duplicate shell or OSD cases already owned by their suites.

## 17 Hidden Dependencies

1. `kickoff-brief.md` establishes the Player as a consumption surface, forbids file-path exposure, recommends a stable narrow API, and separates Player concerns from acquisition. This specification makes those statements binding for v2.
2. `docs/06-design/design-system.md` defines Archivist colors and typography. V2 keeps the identity but changes density, navigation, and focus hierarchy for a ten-foot interface.
3. `apps/server/src/player-frontend.ts` is a security boundary, not only a static server. Every new Player route is automatically reachable on `4242`; no admin route may be delegated.
4. `apps/server/src/middleware/request-id.ts` and auth middleware run on delegated API requests. New logs and error envelopes must reuse the existing request ID rather than generate a second server ID.
5. `packages/db/src/schema.ts` owns the only supported unified database migration chain. Creating a separate Player database is forbidden.
6. `playback_progress.profile_id` already establishes the string profile namespace. Preferences must use the same identifier and the current literal `default`.
7. The current server serializer infers availability from `file_path`. V2 must preserve that rule while preventing the path from crossing the API boundary.
8. `<video>` and `<track>` cannot attach custom auth headers. Same-origin delegation and token injection are therefore required for streams, subtitles, and transcodes.
9. Browser codec support varies. OSD design cannot imply that Video Mode changes the underlying browser capability; it selects direct or compatibility behavior already supported by the server.
10. Channels playback has its own session completion semantics. Generic episode Up Next must not double-advance a Channels session.
11. Loudness work has an existing background queue. V2 preference changes select existing behavior; they do not synchronously measure media.
12. Current localStorage keys are `archivist-player-settings` and `archivist-player-progress`. Migration must preserve progress and must not import the old `connection` field.
13. The current Google Fonts import violates offline operation and the proposed CSP. It must be removed before CSP enforcement is enabled.
14. React StrictMode mounts effects twice in development. every listener, timer, gamepad RAF, fetch, image decode, and media callback must have idempotent cleanup.
15. The working tree contained unrelated changes in server settings, parser tests, and admin settings when this specification was written. Implementation must not overwrite or reformat those files.
16. Arctic Fuse 3 supports Kodi-specific metadata, actions, and addons that Archivist does not possess. Visual affordances must be omitted when their underlying capability is absent; fabricated controls are forbidden.

## 18 Configuration

| Key | Default | Required | Validation | Environment variable | Public in bootstrap | Documentation |
|---|---:|---|---|---|---|---|
| `playerUiV2Enabled` | `false` | no | strict `true` or `false`, case-insensitive | `PLAYER_UI_V2_ENABLED` | yes | `.env.example`, compose, Player README |
| `playerUiDefaultPreset` | `categories` | no | `classic`, `categories`, `compound`, or `combined` | `PLAYER_UI_DEFAULT_PRESET` | yes | same |
| `playerUiMaxWidgetItems` | `36` | no | base-10 integer `12..60` | `PLAYER_UI_MAX_WIDGET_ITEMS` | yes | same |
| `playerUiTelemetryEnabled` | `false` | no | strict `true` or `false`, case-insensitive | `PLAYER_UI_TELEMETRY_ENABLED` | yes | same |

The default preset is used only when creating or resetting a preference row. Changing the environment does not overwrite existing preferences. The item maximum clamps both stored widget limits and query limits at response time; the stored document remains unchanged so raising the limit later restores the user’s selected value. Telemetry disabled means the client does not collect or send samples and the server returns 404 for `/telemetry` and `/metrics`.

Existing `PLAYER_PORT`, `PLAYER_ORIGINS`, `ARCHIVIST_PLAYER_DIR`, `ARCHIVIST_SERVICE_TOKEN`, server host, and API-key configuration remain unchanged. No new secret, path, URL, port, timeout, cache directory, or feature licence value exists.

## 19 Docker Changes

- **Services:** no new service. The single Archivist process remains authoritative.
- **Ports:** no change; `2424` admin/API and `4242` Player.
- **Volumes:** no change; preferences live in the existing SQLite database under the existing data volume.
- **Health checks:** retain `/ping` on `2424`; deployment verification additionally probes `/healthz` on `4242` outside the Dockerfile health check.
- **Compose:** pass the four variables in section 18.
- **Environment:** no build-time Vite flag; selection is runtime server configuration.
- **Networking:** no new network, hostname, proxy, or outbound request.
- **Secrets:** no new secret.
- **Image:** Player test dependencies are removed by the existing production-only install. Self-hosted fonts are static build assets.
- **Build:** a Player code or static asset change requires `pnpm build` in local deployment or a Docker image rebuild and redeploy in container deployment. Restarting an old image cannot expose new frontend code.

## 20 Feature Flags

`PLAYER_UI_V2_ENABLED` is the sole release flag. It defaults to `false` in release R. The bootstrap endpoint returns the evaluated boolean; the browser cannot override it.

Rollout is exact:

1. Release R: flag false by default. Internal and opt-in installations enable it after migration/test gates pass.
2. Observe at least seven consecutive days on one library containing at least 1,000 films/episodes and one constrained 4-core/2 GB client. Zero release-blocking defects and section 29 p95 targets are required.
3. Release R+1: default becomes true. Legacy remains bundled and the flag remains functional.
4. Observe one full release interval with no unresolved severity-1 or severity-2 regression.
5. Release R+2: remove LegacyApp branches and flag. Keep the preference table and v2 APIs.

There is no percentage rollout service. Operators select per deployment. Preference migration occurs only when v2 is enabled and only after a successful bootstrap. Disabling v2 never modifies or deletes preference data.

## 21 Licensing

This feature is **Community**. There is no Pro or Enterprise licence check in server, frontend, API, plugin loader, database, Docker image, or build. Every Player user receives the same interaction, preference, hub, and OSD behavior.

Clean-room rules are release blockers:

1. Do not copy or translate Arctic Fuse 3 source, XML structures, texture coordinates, media, icons, screenshots, strings, or branding into the repository.
2. Do not vendor `skin.arctic.fuse.3` as a package, submodule, build input, fixture, or test snapshot.
3. Do not name product components, CSS classes, presets, telemetry, or routes `arctic`, `fuse`, `jurial`, or `kodi`. The four generic preset labels may be used because they describe composition, not brand identity.
4. Every new image and SVG must be authored for Archivist or trace to a licence compatible with Archivist distribution. Record third-party asset name, author, source, licence, and modification in the existing repository attribution mechanism; if no mechanism exists, add `apps/player/public/assets/ATTRIBUTION.md` and include it in the file tree through a specification amendment before adding the asset.
5. Font files must include their licence text. If files are not already present and no approved fonts are added, use the system fallbacks.
6. The reference repository and forum links belong only in engineering documentation, never in end-user branding or About copy.
7. A release reviewer must run a filename/hash/text search for prohibited reference materials and sign the acceptance checklist.

## 22 Authentication

Authentication architecture does not change. The main Express application enforces existing service/API authentication. Requests arriving through `4242` receive the service token from the in-process listener. Browser JavaScript uses same-origin credentials and receives no token. Direct requests to `2424` continue to follow existing API-key/browser-session rules.

Preference `profileId` is not an authentication credential. In this release only `default` is accepted by the public HTTP validator even though the schema can store future IDs. No login, pairing, PIN, cookie, or token endpoint is added. Telemetry endpoints require the same Player authentication middleware as every `/api/v1/player` route.

## 23 Authorisation

The Player authority is read media metadata, stream playable media, read/write/delete playback progress, read/write/reset Player preferences, use Channels sessions, and submit/read local anonymous performance aggregates when enabled. The Player is not authorized to mutate libraries, acquisition, indexers, downloads, users, server settings, file metadata, or filesystem paths.

Port `4242` must return the SPA shell rather than proxying any `/api/v1/*` path outside `/api/v1/player/*`; tests must assert a representative admin route is unreachable. The preference service accepts only `profileId=default`. There are no role differences, content restrictions, plugin permissions, licence permissions, or per-library ACLs in this release.

## 24 Validation Rules

### 24.1 HTTP and identity

- Profile: literal `default`; length and other-character rules are reserved and not accepted.
- Media/library IDs: decimal positive safe integers; leading plus/minus, exponent, whitespace, float, zero, and values above `Number.MAX_SAFE_INTEGER` are rejected.
- Query string: at most 120 Unicode code points after NFC normalization and trim; control characters rejected; empty returns empty groups.
- Cursor: base64url length 1..512, decoded JSON object with only required sort keys; malformed or extra keys rejected.
- Request JSON: `Content-Type: application/json`; maximum 32 KiB preferences and 16 KiB telemetry; arrays and scalars rejected where object required.
- Unknown request keys: rejected with their JSON pointer, capped at ten reported paths.

### 24.2 Preferences

- `schemaVersion` must equal integer 1.
- All enumerations must match exact lowercase values.
- Widget IDs match `^[a-z0-9][a-z0-9-]{0,39}$`, are unique, and number 1..12.
- Widget title is NFC-normalized, trimmed, 1..48 Unicode code points, no control character or bidi override.
- Widget source is one supported source; view is one supported view; limit is one allowed literal; enabled is boolean.
- Home must retain at least one enabled widget. Duplicated sources are permitted only when IDs and titles differ.
- Target LUFS is one of `-14`, `-16`, `-18`, `-23`.
- Preferred language is `null` or lowercase ISO 639-1 two-letter code. Unsupported stored preference still remains but falls back at playback.
- Subtitle mode is `off`, `forced`, or `preferred`.
- Text scale is `1`, `1.15`, or `1.3`.
- Preference serialized size is at most 32 KiB.
- `expectedRevision` is an integer `>=1` and must equal the stored revision.

### 24.3 Telemetry

- `sessionId` is UUID v4 generated with `crypto.randomUUID()` once per page lifetime.
- Batch contains 1..50 samples.
- Name is one approved name from section 27.
- `valueMs` is finite `0..120000`.
- `at` is an integer epoch millisecond within ten minutes of server time.
- Extra fields and free text are rejected.

### 24.4 UI input

- Search begins at two code points and truncates at 120 before URL construction.
- Seek values clamp to stream duration and ignore nonfinite duration.
- Progress positions below zero become zero; values above duration become duration; completed remains governed by existing server route logic.
- Artwork URL accepts same-origin relative, `http:`, `https:`, `data:image/`, or `blob:`. `data:` is permitted only for `image/*`; all other schemes are rejected.

## 25 Error Handling

| Code | HTTP | Trigger | UI behavior | Retry |
|---|---:|---|---|---|
| `PLAYER_INPUT_INVALID` | 400 | query/body validation | field message; retain draft/query | after correction |
| `PLAYER_CURSOR_INVALID` | 400 | bad/stale cursor shape | clear only cursor, reload first page | automatic once |
| `PLAYER_NOT_FOUND` | 404 | media/hub missing | Not Found with Back | no automatic retry |
| `PLAYER_TELEMETRY_DISABLED` | 404 | telemetry route off | silent discard | no |
| `PLAYER_UNAVAILABLE` | 409 | no playable file | info panel, no playback | after user reload |
| `PLAYER_PREFERENCES_CONFLICT` | 409 | revision mismatch | Reload/Overwrite dialog | explicit only |
| `PLAYER_BODY_TOO_LARGE` | 413 | request limit | settings error | after correction |
| `PLAYER_MEDIA_GONE` | 410 | file missing | close playback, item unavailable message | one metadata refresh |
| `PLAYER_RATE_LIMITED` | 429 | existing middleware | preserve screen, countdown Retry | honor Retry-After |
| `PLAYER_DATABASE_UNAVAILABLE` | 503 | DB open/query failure | full bootstrap Retry or row Retry | exponential 1,2,4,8, max 15 s |
| `PLAYER_STREAM_FAILED` | 500 | direct stream error | compatibility retry once, then Retry/Close | bounded |
| `PLAYER_TRANSCODE_FAILED` | 500 | FFmpeg failure | retain time and show Retry Direct/Close | user action |
| `PLAYER_INTERNAL_ERROR` | 500 | unclassified | request ID and Retry | user action |

Every server error returns the section 15 envelope. Message text is user-safe and contains no SQL, stack, path, token, FFmpeg command, or environment value. The client distinguishes aborted requests from errors and shows no error for abort. Row errors do not replace the global shell. Playback errors never leave an invisible focus trap. Retried writes are not automatic except telemetry, which is discarded; preference writes require explicit conflict resolution.

## 26 Logging

Use the existing `createLogger` with contexts `Player`, `PlayerPreferences`, `PlayerHub`, `PlayerTelemetry`, and `PlayerFrontend`.

Required structured logical fields, passed as a redacted object argument when JSON logging is enabled:

- Request completion: `requestId`, `method`, route template, `status`, `durationMs`.
- Hub completion: `requestId`, `hubId`, widget count, item count, `durationMs`.
- Preference write: `requestId`, profile ID, old revision, new revision, outcome `saved|conflict|reset`.
- Playback: request ID, media type, numeric media ID, operation `stream|probe|subtitle|transcode`, outcome, duration; do not log title.
- UI client error: client session ID, approved error code, route template, browser phase; no stack from the browser in this release.
- Startup: v2 enabled, default preset, max items, telemetry enabled.

Never log search text, plot, titles, cast, preference documents, localStorage, full URLs containing query parameters, IP for telemetry correlation, user agent, file paths, API keys, cookies, authorization headers, subtitle content, or FFmpeg command lines. Success route logs use debug except preference writes and startup, which use info. Validation and conflicts use warn. Internal/DB/playback process failures use error.

## 27 Metrics

There is no external metrics system. When telemetry is enabled, `/metrics` returns in-memory aggregates for these exact names:

| Name | Source | Target | Histogram buckets in ms |
|---|---|---:|---|
| `player_bootstrap_ms` | client | p95 ≤ 1000 warm LAN | 50,100,250,500,1000,2000,5000 |
| `player_shell_ready_ms` | client | p95 ≤ 1200 | 50,100,250,500,1000,2000,5000 |
| `player_hub_ready_ms` | client | p95 ≤ 800 cached, 1500 cold | 50,100,250,500,800,1500,3000 |
| `player_focus_move_ms` | client sampled 1/20 | p95 ≤ 16 | 1,2,4,8,16,32,64 |
| `player_backdrop_ready_ms` | client sampled 1/10 | p95 ≤ 300 cached | 16,32,64,128,300,600,1200 |
| `player_osd_open_ms` | client | p95 ≤ 50 | 4,8,16,32,50,100,250 |
| `player_playback_start_ms` | client | p95 ≤ 2000 direct LAN | 100,250,500,1000,2000,5000,10000 |
| `player_probe_ms` | server/client | observe, no release gate | 50,100,250,500,1000,2500,5000 |
| `player_transcode_start_ms` | server/client | p95 ≤ 5000 supported host | 250,500,1000,2500,5000,10000,30000 |
| `player_preference_save_ms` | client | p95 ≤ 300 LAN | 25,50,100,200,300,600,1200 |
| `player_api_error_count` | client | zero severity-1 in gate | counter, no buckets |
| `player_preference_conflict_count` | server | observe | counter |

Each aggregate contains `count`, `sum`, `min`, `max`, and cumulative bucket counts. No label dimensions exist, preventing cardinality and identity leakage. Metrics reset on restart. No dashboard or alerting service is added. The release report is a manually captured snapshot compared with section 29; this is the only dashboard requirement for this release.

Alerts are operational log conditions: five `PLAYER_INTERNAL_ERROR` events in five minutes, three transcode process failures in five minutes, or bootstrap 503 on three consecutive requests. The current repository has no alert dispatcher, so operators consume these through existing container logs; do not claim automated notification.

## 28 Telemetry

Telemetry is local, optional, anonymous performance sampling. Default is off. When off, no PerformanceObserver, timing batch, beacon, or server aggregate runs. When on, the client measures only approved names and sends batches at 20 samples, 30 seconds, visibility hidden, or page unload. Failed submission is discarded; samples are not persisted in localStorage or IndexedDB.

Tracing uses the existing request ID at HTTP boundaries. The client stores a request ID returned in errors and may display it. No distributed tracing SDK, OpenTelemetry collector, trace exporter, external analytics, cookies, fingerprinting, crash upload, session replay, or third-party endpoint is introduced.

The About screen displays `Local performance telemetry: On/Off` and explains that values remain on the Archivist server until restart. The user cannot toggle the operator environment flag from Player settings.

## 29 Performance

Reference server dataset: 10,000 films, 1,000 series, 25,000 episodes, 2,000 progress rows, 12 widgets. Reference network: wired LAN, 20 ms round-trip or lower. Reference constrained client: four CPU cores, 2 GB available memory, Chromium-class browser at 1920×1080.

Expected sustained throughput is 50 non-stream Player JSON requests/second with 20 concurrent clients and one preference write/second on the reference server. The release load test runs for five minutes with error rate below 0.1% and retains the latency budgets below. Media byte throughput and simultaneous transcode capacity remain host/storage/codec dependent and are unchanged by this feature; no new capacity claim is made.

- Bootstrap server p95 ≤ 250 ms and JSON ≤ 350 KiB before compression.
- Home hub server p95 ≤ 150 ms after DB warmup and JSON ≤ 300 KiB.
- Paged library server p95 ≤ 150 ms for 60 items.
- Preference read/write p95 ≤ 25 ms server processing.
- First shell paint ≤ 1,200 ms p95 from navigation on warm LAN.
- Focus response ≤ 16 ms p95 and no long task above 50 ms during ten consecutive D-pad moves.
- Base OSD appears ≤ 50 ms p95 and triggers zero network requests.
- Backdrop context changes start within 100 ms focus debounce and complete cached decode/crossfade ≤ 300 ms p95.
- Scroll maintains 50 frames/second or higher at p95 frame interval on the constrained client.
- Player JS ≤ 260 KiB gzip for v2 initial chunk; lazy legacy chunk excluded. Total first-route CSS ≤ 55 KiB gzip.
- Decoded artwork budget ≤ 80 managed URLs and estimated 160 MiB; evict least-recent nonvisible URL before adding the 81st.
- DOM focus targets ≤ 500 and total mounted media cards ≤ 120 per route.
- In-memory SDK JSON cache ≤ 100 entries; telemetry aggregate ≤ 1 MiB.
- No automatic hero rotation, polling hub request, animated blur, video backdrop-filter, or full-library client fetch.

Scaling remains vertical in one Node process with SQLite. No horizontal coordination is added. Concurrent preference writes are revision-controlled. Concurrent hub reads are SQLite reads. Transcode concurrency remains governed by existing behavior and is not expanded.

## 30 Security

1. Preserve port `4242` limited-route delegation and server-side token injection.
2. Enforce CSP and Permissions-Policy `camera=(), microphone=(), geolocation=(), payment=(), usb=()`.
3. Keep `X-Content-Type-Options`, `Referrer-Policy`, and `X-Frame-Options` headers.
4. Parameterize all SQL. Cursor values are data, never SQL fragments; sort fields map through fixed server dictionaries.
5. Validate complete preference documents, reject prototypes/unknown keys, and deep-clone frozen defaults to prevent prototype pollution.
6. Render metadata as React text. Do not use `dangerouslySetInnerHTML`.
7. Validate artwork URL schemes and never interpolate metadata into CSS declarations.
8. Keep file paths, stream source paths, tokens, and FFmpeg commands out of contracts/logs/telemetry/DOM/localStorage.
9. Cap body, query, widget, result, cursor, cache, and telemetry sizes as documented.
10. Do not load remote fonts, scripts, styles, frames, SVG, theme packages, or reference assets.
11. Search history is local, capped at ten, clearable, and excluded from server preferences.
12. No Player preference may modify CSP, server origin, API key, media path, plugin, or executable content.
13. Dependency review must show zero new production runtime dependency and no critical/high production vulnerability introduced by test tooling.
14. Threat tests cover traversal, admin-route reachability, SQL injection strings in query/cursor, prototype keys, malicious artwork schemes, oversized bodies, and path leakage.

## 31 Testing Strategy

### 31.1 Test layers

- **Contract/type:** workspace TypeScript builds server and Player against `@archivist/contracts`.
- **Pure unit:** cursor, serializers, preference validation/presets/migration, focus scoring, view windows, OSD thresholds/seek.
- **Component:** Shell, Hub, Cards, Rail, Settings, search, details, VideoOsd, UpNext with jsdom and fake rectangles/media.
- **Server integration:** all existing Player tests plus bootstrap/preferences/hubs/search/telemetry/security.
- **Browser smoke:** the specified Playwright Chromium test uses intercepted complete Player API fixtures and Arrow/Enter/Escape only to cover Home → Film → Play → OSD → Audio → Back → Stop → restored Film focus → Home → Settings → Reset cancel. No live library or external network is required.
- **Manual device:** Chromium desktop, Firefox desktop, Safari desktop, Android TV Chromium/WebView when supported, Fire TV browser/WebView when supported, gamepad, keyboard, pointer, 720p, 1080p, 4K, 4:3, and 21:9.

### 31.2 Required fixtures

Fixtures include available/unavailable film, resumable/completed film, series with Specials and three seasons, missing episode, forced/default/multiple tracks, missing artwork, malformed metadata JSON, 60+ library items, Channels session with next item, empty library, server error, preference conflict, and Unicode/RTL title. Fixtures must use generated media names and repository test assets, not copyrighted reference screenshots.

### 31.3 Accessibility

Automated assertions cover roles, names, modal trap, focus restoration, reduced motion, text scale class, contrast token values, no keyboard trap, and hidden-content exclusion. Manual screen-reader checks cover shell nav, search keyboard, detail actions, track panels, playback error, and Up Next announcement.

### 31.4 Visual regression

Capture original Archivist-owned screenshots at 1280×720, 1920×1080, 2560×1080, and 3840×2160 for Home presets, film/series details, library views, search, settings, base/paused/panel OSD, Up Next, empty, loading, and error. Pixel threshold is 0.2% differing pixels after masking clock/progress. Reference-skin screenshots must not enter fixtures.

### 31.5 Exit gate

All existing server tests, new server tests, Player unit/component tests, build/typecheck, Docker build, security checks, browser smoke, acceptance criteria, and manual constrained-device performance run must pass. Flaky tests may be retried once in CI; a test failing twice blocks release and cannot be disabled without a specification amendment.

## 32 Migration Strategy

Migration is additive and staged.

1. Deploy schema migration v4 and additive APIs with v2 flag false. Existing Player remains the only visible UI.
2. On first v2 bootstrap for `default`, the server creates canonical preferences revision 1 when absent.
3. Client reads `archivist-player-settings`. If server preference `migration.legacyLocalStorageImported` is false and a valid legacy document exists, map fields using section 16.36, set the migration flag true, and PUT with current revision.
4. On successful PUT, remove only `archivist-player-settings`. Preserve `archivist-player-progress`, search history, and route focus cache. On failure or conflict, preserve the legacy key and retry only on a later app start or explicit user action.
5. Server playback progress remains authoritative and hydrates the local mirror. No progress-row migration occurs.
6. Enable v2 in the rollout cohorts from section 20. Both UIs read the same progress and media endpoints.
7. At R+1, change only the environment default; do not rewrite stored preferences.
8. At R+2, remove legacy branches and old settings facade after the rollback gate. Leave migration flag and ignored old localStorage behavior for one further release, then remove client migration code through a separate reviewed change.

Deployment order is database/server first, then static Player bundle, then flag. In the single image they ship atomically, but this order governs code dependency and tests. There is no data backfill, media rescan, search reindex, background job, downtime, or manual SQL step. The v4 migration is expected below 100 ms because it creates an empty table and index.

Backwards compatibility is mandatory: old Player bundles continue to use existing endpoints after server deployment; new bundles with flag false use LegacyApp; new bundles with flag true require bootstrap and fall back only through explicit operator flag change.

## 33 Rollback Strategy

### Immediate runtime rollback

Set `PLAYER_UI_V2_ENABLED=false` and restart the Archivist process. The next bootstrap renders LegacyApp. No image rebuild is required when the deployed image already contains both UIs. Active playback continues in the loaded browser until refresh; do not force clients to reload.

### Image rollback

Redeploy the preceding image. Migration v4 and preference rows remain in SQLite and are ignored. Existing tables/endpoints are additive, so the preceding server must tolerate the extra table. If the preceding image predates migration v4, SQLite still opens because unknown tables are harmless.

### API rollback

Do not remove additive v2 routes during R or R+1. If one is defective, disable v2 and patch forward. Existing stable routes remain available. Telemetry can be independently stopped by setting `PLAYER_UI_TELEMETRY_ENABLED=false`.

### Data rollback

Do not drop `player_preferences` and do not decrement `_migrations`. A destructive data rollback is prohibited because it provides no operational benefit and loses user settings. Restore the existing database backup only when the entire database is corrupt, following the repository backup procedure.

### Rollback validation

After disabling v2, verify `/api/v1/player/health`, Home, film playback, episode playback, progress save, Channels session, subtitles, transcode fallback, and Settings in legacy UI. Completion requires zero console error caused by ignored v2 preferences and no change to progress rows.

## 34 Acceptance Criteria

### Architecture and compatibility

- [ ] V2 runs exclusively through `/api/v1/player` and protected `/media` access.
- [ ] Port `4242` cannot reach a representative admin endpoint.
- [ ] No public response, log, telemetry batch, DOM attribute, or localStorage entry contains a media file path or service token.
- [ ] Every existing Player endpoint and field passes its pre-change test.
- [ ] V2 can be disabled at runtime without deleting data or rebuilding the deployed dual-UI image.
- [ ] No new production runtime dependency, service, port, volume, queue, worker, scheduler, plugin loader, or external request exists.

### Living-room interaction

- [ ] A user can complete Home → Film → Play → OSD → Stop → Home using only Arrow, Enter, and Escape/Back.
- [ ] The side rail order and protected Settings behavior match section 12.2.
- [ ] Returning right from the rail restores the exact previous content focus.
- [ ] Back follows the exact nested hierarchy and does nothing at bare Home.
- [ ] Focus movement follows section 12.3 for 100% of deterministic focus tests.
- [ ] Focus rings remain visible in remote modality and no focus target is hidden behind viewport edges.
- [ ] Pointer and touch complete every action without creating remote-inaccessible state.
- [ ] Route, widget, season, and origin playback focus restore by semantic media ID after navigation.

### Hubs, views, and details

- [ ] Categories is the first-run preset; all four presets render the exact matrix in section 9.2.
- [ ] Focused media updates backdrop and information after 100 ms without a focus-triggered request.
- [ ] Empty widgets are omitted and the all-empty state contains no acquisition terminology.
- [ ] Poster, landscape, wall, and list views meet dimensions and information guarantees.
- [ ] Wall always has a persistent focused-item information panel.
- [ ] Changing view preserves media focus, sort, filter, and scroll.
- [ ] Film initial action is Resume, Play, or Not available according to progress/availability rules.
- [ ] Series handles Specials, seasons, unavailable episodes, episode info, and Resume Next.
- [ ] No Player page exposes scan, search-missing, acquisition, torrent, indexer, quality-policy administration, or `UP` actions.

### Search and settings

- [ ] Search groups films, series, and episodes and cancels stale requests.
- [ ] Remote keyboard contains the exact key set and returns focus predictably between keyboard and results.
- [ ] Search text never enters logs, telemetry, server preferences, or external services.
- [ ] Settings supports preset preview, bounded widget edit, Save/Discard/Cancel, conflict Reload/Overwrite, and Reset confirmation.
- [ ] Reset preserves progress and search history.
- [ ] A failed preference save retains the complete local draft.
- [ ] Two same-revision concurrent writes produce exactly one success and one conflict.

### Playback and OSD

- [ ] Direct play, range/HEAD, resume, progress, compatibility transcode, subtitle WebVTT, audio selection, loudness, and Channels modes pass existing tests.
- [ ] Base OSD renders within 50 ms p95 and makes zero network calls.
- [ ] Playing OSD hides at 3,000 ms; paused OSD persists and expands information at 600 ms.
- [ ] Audio, Subtitle, Video Mode, Info, and Queue panels trap and restore focus.
- [ ] Hidden-OSD seek uses exact acceleration and clamps safely.
- [ ] Track loading never blocks playback or the base OSD.
- [ ] Track-driven transcode resumes within ±2 seconds.
- [ ] Up Next follows the threshold, countdown, cancel, unavailable-next, and film-exclusion rules.
- [ ] Stopping playback restores the exact origin focus.
- [ ] Playback failure always leaves visible Retry/Close controls and no focus trap.

### Visual, accessibility, and performance

- [ ] No Arctic Fuse/Kodi source, asset, screenshot, brand, prohibited identifier, or hash match ships.
- [ ] Runtime makes no Google Fonts or other font request.
- [ ] CSP passes without inline-script/style or remote-resource violation.
- [ ] Layout passes 720p, 1080p, 4K, 4:3, and 21:9 screenshots.
- [ ] Reduced motion, three text scales, keyboard, gamepad, pointer, touch, and screen reader checks pass.
- [ ] Text/focus contrast and minimum text-size requirements pass.
- [ ] Every performance budget in section 29 passes on the reference dataset/client.
- [ ] Ten rapid route changes, 100 D-pad moves, and 20 OSD open/close cycles leak no listener, timer, RAF, media callback, or unbounded cache entry.

### Deployment and documentation

- [ ] Schema v4 is idempotent and preference rollback is non-destructive.
- [ ] Docker image builds, both ports pass health checks, and existing volumes remain unchanged.
- [ ] `.env.example`, compose, Player README, controls, tests, rebuild/redeploy note, clean-room notice, and rollback are current.
- [ ] All tests in section 31 pass and no pre-existing assertion is weakened or skipped.
- [ ] Release reviewer signs the licensing and completeness audit.

## 35 Future Enhancements

The following are excluded from this implementation and require independent specifications:

1. Native Android TV, tvOS, Fire TV, Roku, Tizen, or webOS clients.
2. Multiple household profiles, authentication boundaries, PINs, parental controls, and profile switching.
3. A signed Player plugin/widget runtime with permissions and failure isolation.
4. Music, books, comics, games, photos, weather, addons, favorites, and cross-media universal search.
5. Trailers, extras, recommendations, actor/person pages, and external discovery providers.
6. Full-text search indexing, fuzzy matching, transliteration, voice search, and remote companion text entry.
7. Server-pushed library/progress updates using SSE or WebSocket and an explicit event contract.
8. Persistent Prometheus/OpenTelemetry export, dashboards, automated alerts, and external observability backends.
9. Offline PWA caching, downloads, service workers, and WAN pairing.
10. Theme packs or alternate palettes after a safe asset/licensing model exists.
11. Hardware-specific decode capability negotiation beyond current browser/direct/transcode behavior.
12. Favorites and custom hubs after their domain and persistence ownership are defined.

## 36 Implementation Plan

### Step 1 — Freeze contracts and configuration

**Objective:** add shared Player contracts and the strict config parser. **Reason:** all subsequent server/frontend work must compile against one vocabulary. **Files affected:** contracts `player.ts`/barrel, server `config.ts`, `.env.example`. **Dependencies:** existing contracts package and environment conventions. **Database changes:** none. **API changes:** type definitions only. **Frontend changes:** none. **Tests required:** contract build and config unit/integration cases. **Validation:** every enum/range/default from sections 15 and 18 compiles and tests. **Rollback:** revert additive files/exports; no data. **Completion criteria:** server and Player can import contracts; invalid config prevents startup with the documented message.

### Step 2 — Add preference persistence

**Objective:** migration v4 and preference service. **Reason:** v2 layout cannot rely on one browser’s localStorage. **Files affected:** DB schema/tests, server preferences, player-ui e2e. **Dependencies:** step 1 contracts/config. **Database changes:** section 9 table/index/migration. **API changes:** service layer only. **Frontend changes:** none. **Tests required:** schema, defaults, validation, transaction, conflict, reset, concurrency. **Validation:** canonical document round-trips and invalid documents never commit. **Rollback:** leave table unused. **Completion criteria:** all service tests pass and migration is idempotent.

### Step 3 — Extract serializers and implement hubs

**Objective:** isolate public media shapes and bounded widget composition. **Reason:** current routes combine SQL, serialization, and HTTP and force client full-library loads. **Files affected:** serializers, hub service, routes, existing/new server tests. **Dependencies:** steps 1–2 and current media schema. **Database changes:** none. **API changes:** internal services plus pagination/grouped search preparation. **Frontend changes:** none. **Tests required:** serializers, all widget sources, cursors, sorting/filtering, path non-leak. **Validation:** results are stable by secondary ID and bounded to limits. **Rollback:** routes can continue using old inline serializers while new files remain unused. **Completion criteria:** existing API tests remain green and hub service meets SQL/latency requirements.

### Step 4 — Add bootstrap, preferences, hubs, search, and telemetry routes

**Objective:** expose the complete additive v2 HTTP surface. **Reason:** frontend work must target final contracts. **Files affected:** routes, telemetry, media/loudness timing, player frontend security headers, server tests. **Dependencies:** steps 1–3. **Database changes:** preference reads/writes only. **API changes:** all section 10 additions; existing additive fields. **Frontend changes:** none. **Tests required:** every route/status/header/security/size/telemetry case and existing media regression. **Validation:** port 4242 delegation and CSP tests pass; old clients pass. **Rollback:** keep flag false; additive routes may remain. **Completion criteria:** server suites pass and OpenAPI-equivalent examples in contract tests match runtime JSON.

### Step 5 — Build visual tokens, store, SDK, and migration

**Objective:** establish frontend foundations without changing visible legacy behavior. **Reason:** shell/components require stable style/state/network layers. **Files affected:** manifest/lock, main/index/tailwind/tokens/motion, SDK, store, preferences, frontend tests setup/preferences. **Dependencies:** step 4 endpoints and contracts. **Database changes:** none. **API changes:** client methods only. **Frontend changes:** self-hosted typography policy, v2 state/cache. **Tests required:** SDK, reducer, migration, preset, CSS build. **Validation:** no remote font request and no runtime dependency. **Rollback:** legacy imports and facade remain. **Completion criteria:** Player build/tests pass with v2 not rendered.

### Step 6 — Implement spatial navigation and shell

**Objective:** remote-first global frame. **Reason:** every page interaction depends on deterministic focus and Back. **Files affected:** navigation, FocusProvider, Shell, App, shell/navigation tests. **Dependencies:** step 5. **Database changes:** none. **API changes:** bootstrap consumption. **Frontend changes:** side rail, backdrop, routes, scopes, modality. **Tests required:** complete section 12.3 and Shell behavior. **Validation:** browser smoke navigates shell using only Arrow/Enter/Back; Settings is protected. **Rollback:** flag false selects LegacyApp. **Completion criteria:** feature-flagged shell renders all routes and restores focus.

### Step 7 — Implement hub, cards, rails, Home, and Library

**Objective:** deliver the primary browse experience and four presets. **Reason:** this is the largest experiential gap. **Files affected:** Hub, Cards, Rail, Home, Library, Shell/store tests. **Dependencies:** steps 3–6. **Database changes:** none. **API changes:** hubs/pagination consumed. **Frontend changes:** spotlight, categories, views, paging, artwork, empty/error states. **Tests required:** four presets, views, focus context, cursor merge, virtualization, image failure. **Validation:** acceptance hub/view criteria and performance budgets. **Rollback:** legacy Home/Library in flag-off branch. **Completion criteria:** Home and 10k-item libraries are remote-operable without full-list fetch.

### Step 8 — Implement detail and search routes

**Objective:** complete film, series, episode, and search workflows. **Reason:** users need a coherent path from browse to playback. **Files affected:** FilmDetail, SeriesDetail, SearchPage, store/SDK, component tests. **Dependencies:** steps 4–7. **Database changes:** none. **API changes:** additive detail/search fields consumed. **Frontend changes:** action zones, seasons/episodes, keyboard, groups. **Tests required:** action priority, Specials, unavailable, resume, Unicode, cancellation, no query telemetry. **Validation:** section 12.5/12.6 acceptance criteria. **Rollback:** legacy routes flag-off. **Completion criteria:** browser remote workflow reaches correct playable target from every supported result.

### Step 9 — Implement settings and first-run migration

**Objective:** safe comprehensible customization. **Reason:** reference-style power without recovery/clarity creates a poor product. **Files affected:** Settings, preferences/store/SDK, README, tests. **Dependencies:** steps 2, 4–7. **Database changes:** create/update/reset preference row. **API changes:** preference endpoints consumed. **Frontend changes:** preset preview, bounded editor, draft, conflict, reset. **Tests required:** full Settings behavior and local migration. **Validation:** failure preserves draft, conflict is deterministic, Settings cannot disappear. **Rollback:** preference rows remain; legacy reads its original settings only when preserved. **Completion criteria:** reload on a second browser reproduces saved v2 layout/playback preferences.

### Step 10 — Implement layered OSD and Up Next

**Objective:** replace playback chrome without changing media mechanics. **Reason:** OSD responsiveness and hierarchy define the playback feel. **Files affected:** Player, SessionPlayer, TrackMenu, VideoOsd, UpNext, media gain, OSD/media tests. **Dependencies:** steps 5–8 and existing playback APIs. **Database changes:** existing progress only. **API changes:** none beyond timing already added. **Frontend changes:** complete section 12.8. **Tests required:** all OSD unit/component/media/session cases. **Validation:** zero-fetch ≤50 ms OSD, exact timers/seek/focus/advance, playback regressions green. **Rollback:** flag false uses legacy playback presentation; server media unchanged. **Completion criteria:** direct/transcode/subtitle/loudness/Channels workflows pass automated and manual tests.

### Step 11 — Adapt Channels, accessibility, performance, and observability

**Objective:** finish all secondary surfaces and nonfunctional gates. **Reason:** a living-room UI is incomplete if TV, constrained devices, or assistive use regress. **Files affected:** Channels, Shell/components/styles, telemetry, tests/docs. **Dependencies:** steps 6–10. **Database changes:** none. **API changes:** telemetry submission only. **Frontend changes:** guide focus, text scale, reduced motion, ARIA, performance sampling. **Tests required:** Channels, accessibility, cache/leak, responsive visual, metrics. **Validation:** sections 27–31 and acceptance gates. **Rollback:** disable telemetry independently; disable v2 for UI. **Completion criteria:** constrained-device run and accessibility checklist pass.

### Step 12 — Deploy flag-off, validate, and roll out

**Objective:** ship safely and progress through section 20. **Reason:** immediate runtime rollback is required for an architectural UI replacement. **Files affected:** Docker/compose/env/README/release evidence. **Dependencies:** steps 1–11 all green. **Database changes:** migration v4 executes. **API changes:** additive routes live. **Frontend changes:** dual UI bundle. **Tests required:** Docker build/health, image smoke, old/new flag, rollback, licensing scan, full acceptance. **Validation:** release R gate, seven-day cohort, R+1/R+2 criteria. **Rollback:** exact section 33. **Completion criteria:** signed release report records tests, performance snapshot, licence audit, flag value, migration version, and rollback result.

No step may begin before its declared dependencies pass. A later step may add tests for earlier behavior but may not revise an earlier public interface without updating this specification and rerunning all dependent steps.

## 37 AI Implementation Contract

The implementation AI receives this document as the sole design authority and must translate it into production code mechanically.

The implementation AI MUST:

- Follow the architecture, ownership, decisions, file tree, names, routes, types, SQL, algorithms, constants, presets, tokens, timers, limits, rollout, and order exactly.
- Preserve every existing stable Player API field, endpoint, stream behavior, progress behavior, Channels mode, loudness behavior, and port boundary.
- Implement every affected file responsibility and every test listed in sections 16 and 31.
- Implement migration v4 exactly and preserve preference data during rollback.
- Implement all validation, error codes, logging, telemetry privacy, metrics, caching, concurrency, security headers, accessibility, and performance budgets.
- Preserve unrelated working-tree changes and restrict edits to section 7 files.
- Use original Archivist code/assets and comply with the clean-room/licensing rules.
- Update documentation and record build/test/performance/licensing evidence.
- Stop and report the exact missing fact when repository reality contradicts a required signature, migration version, test runner, middleware behavior, or file path.

The implementation AI MUST NOT:

- Redesign the architecture, invent abstractions, rename files, rename components, rename routes, rename APIs, change interfaces, reorder migration versions, or substitute dependencies.
- Copy, port, translate, vendor, or derive from Arctic Fuse 3/Kodi source or assets.
- Add a production runtime dependency, plugin hook, worker, queue, scheduler, service, port, volume, event bus, external endpoint, search index, user model, licence gate, or persistent telemetry store.
- Simplify or skip requirements, tests, validation, error handling, logging, metrics, telemetry privacy, accessibility, security, documentation, migration, rollout, or rollback.
- Remove or weaken an existing test, use snapshot-only tests as behavioral proof, mark a failing test skipped, or widen a timeout to conceal a performance defect.
- Expose media paths, tokens, API keys, query text, preference documents, or copyrighted reference materials.
- Change direct-play/transcode policy while implementing the OSD.
- Infer a product decision from the reference skin when this specification omits that capability.

If ambiguity exists, the implementation AI MUST stop before modifying affected production code and report: the conflicting section, observed repository evidence with file/line, the decision that cannot be made mechanically, and the minimum specification amendment required. It must not select an alternative independently.

## 38 Completeness Audit

Audit performed against repository state and user-required categories on 2026-07-12.

- [x] **Every affected file:** section 7 tree and 65 repeated file specifications in section 16.
- [x] **Every API:** existing compatibility plus all new/additive routes, contracts, statuses, cache rules, and errors in sections 10 and 15.
- [x] **Every database change:** one table, constraint set, index, migration v4, transaction, seed-on-read, and non-destructive rollback in sections 9, 32, and 33.
- [x] **Every migration and rollback:** version, execution order, localStorage import, deployment order, runtime/image/API/data rollback.
- [x] **Every configuration and environment variable:** four new keys and all unchanged relevant keys in sections 18–20.
- [x] **Every Docker modification:** services, ports, volumes, health, compose, networking, secrets, and build in section 19.
- [x] **Every plugin change:** none; absence, rationale, and future integration boundary explicitly stated in sections 5.5 and 35.
- [x] **Every feature flag:** one runtime flag, default, cohort, default flip, removal, and migration behavior in section 20.
- [x] **Every licence rule:** Community ownership, no enforcement gate, clean-room constraints, asset/font review, and release audit in section 21.
- [x] **Every background worker, queue, and scheduled task:** none added; existing loudness and Channels responsibilities explicitly unchanged.
- [x] **Every event:** no durable events; complete local action flow and absence of retry/dead-letter requirements in section 13.
- [x] **Every cache:** SDK TTL/LRU, artwork decode LRU, focus rect frame cache, track cache, local progress/search/focus state, HTTP caching, and limits in sections 12, 16, and 29.
- [x] **Every log:** contexts, fields, levels, prohibited data, and failure records in section 26.
- [x] **Every metric and telemetry event:** exact names, sources, targets, buckets, batching, privacy, retention, endpoint, and disabled behavior in sections 27–28.
- [x] **Every test:** contract, unit, component, integration, browser, manual, accessibility, visual, performance, security, fixtures, and exit gate in section 31.
- [x] **Every validation rule and edge case:** identities, Unicode, cursors, preferences, telemetry, UI values, unknown keys, size limits, missing artwork/media, stale/conflicting state, and browser limitations in sections 12, 24, and 25.
- [x] **Every permission:** authentication, Player authority, forbidden admin authority, profile scope, telemetry auth, port boundary in sections 22–23.
- [x] **Every security consideration:** CSP, policies, SQL, XSS, URL schemes, secrets, bounded input/cache, dependency and threat tests in section 30.
- [x] **Every performance consideration:** dataset/client, latency, payload, frame, bundle, DOM, memory, cache, query, OSD, concurrency, and scaling targets in section 29.
- [x] **Every deployment consideration:** image build, rebuild/redeploy rule, migration order, flag rollout, cohort gate, health checks, evidence, and rollback in sections 19, 20, 32, 33, and 36.
- [x] **Every documentation update:** specification, Player README, env/compose comments, controls, presets, privacy, testing, licensing, rebuild/redeploy, and rollback.
- [x] **Module ownership/Public contracts/Plugin architecture/Licensing:** explicitly answered in sections 5, 10, 15, and 21.
- [x] **Database/API/cache/auth/authorization/flags/Docker/config/logs/telemetry/metrics/tracing/queues/schedulers/events/search/file storage/CI/deployment/backward compatibility/licensing/plugins/extensibility:** each reviewed and either fully specified or explicitly declared unaffected.
- [x] **Failure recovery:** database, API, preference conflict, media gone, stream/transcode, cache, telemetry, queue, plugin, licence, and configuration cases are deterministic.

Final audit decision: the implementation contains no unresolved architectural, structural, product, naming, interface, sequencing, migration, rollout, or rollback choice. Any contradiction discovered during implementation triggers the stop rule in section 37 rather than independent redesign.
