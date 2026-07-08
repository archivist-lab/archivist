# Archivist Player Kickoff Brief

_Last updated: 2026-07-09_

## Confidence markers

- **[Certain]** = grounded in the current Archivist repository or explicitly decided in conversation.
- **[Likely]** = strong product or architecture recommendation based on the current repo shape.
- **[Guessing]** = useful directional speculation that still needs validation.

---

## 1. Executive summary

[Certain] Archivist is currently positioned as a self-contained media automation backend with a preserved React frontend, unified database, cross-domain release pipeline, built-in torrent engine, and job/event-driven imports for films, series, music, books, comics, and games.

[Likely] The next logical product is not simply another Archivist UI. The next product should be a separate **player and consumption app** that integrates deeply with Archivist while also supporting manual library integration.

[Likely] Archivist should remain the system of record and automation brain: it finds, grabs, imports, edits, renames, monitors, upgrades, and maintains media.

[Likely] The new app should become the experience layer: it lets users browse, watch, listen, read, resume, search, discover, collect, and enjoy their library.

[Likely] The default and most polished experience should be for users to run both products together:

```txt
Archivist = acquisition, curation, editing, metadata, automation
Player app = playback, consumption, profiles, discovery, personal media experience
```

[Likely] Manual mode should exist, but it should be framed as fallback compatibility rather than the flagship experience.

---

## 2. Product thesis

[Likely] The core product thesis is:

> Archivist builds and maintains the perfect personal media archive. The player app turns that archive into a beautiful, usable, household-ready media experience.

[Likely] This split creates a cleaner product story than trying to make Archivist do everything in one interface.

[Likely] The value proposition is strongest when the two apps are paired:

1. Install Archivist.
2. Configure libraries, indexers, metadata providers, quality profiles, download behavior, and imports.
3. Install the player app.
4. Pair it with Archivist using local discovery or URL/API key.
5. Instantly browse and play the curated library.

[Likely] This also gives Archivist a clearer ecosystem:

```txt
Archivist Core       -> backend, automation, library management
Archivist Player     -> web/mobile/TV consumption layer
Archivist SDK        -> typed API client for integrations
Archivist Connectors -> future integrations with external libraries/services
```

---

## 3. Current Archivist repository evidence

[Certain] Archivist currently uses a Node/TypeScript monorepo structure with pnpm workspaces.

[Certain] The root package scripts build packages, server, and client independently, then together.

[Certain] The backend is an Express app using TypeScript, Zod contracts, better-sqlite3, ffmpeg/ffprobe tooling, and internal packages for contracts, core logic, database, torrent stack, and indexer engines.

[Certain] The current app serves both API and frontend from the same server by default.

[Certain] The current API is mounted under `/api/v1`.

[Certain] Existing API surfaces include system, arcade, shared, indexers, release pipeline, torrents, dashboard, diagnostics, films, series, music, books, comics, and games.

[Certain] The database already has the foundations needed for a consumption app: libraries, root folders, films, film editions, series, seasons, episodes, episode files, artists, albums, tracks, authors, books, book editions, comic series, comic issues, and games.

[Certain] Existing media entities already contain fields such as title, sort title, year, overview, poster/backdrop/logo/banner paths, file paths, file sizes, quality data, status, monitored state, current tier/resolution/source/codec, release title, and update timestamps.

[Certain] Existing `/media` static serving exposes organized media assets from the local media folder.

[Likely] The backend is close enough to support a player app, but the current routes are still shaped around administration and media management rather than a clean consumer-facing player contract.

---

## 4. Product boundary

### Archivist remains responsible for

[Likely]

- Library configuration
- Root folder management
- Metadata provider setup
- API key management
- Indexer setup
- Download client setup
- Torrent engine integration
- Release search
- Release scoring
- Grabbing
- Importing
- Renaming
- Track/subtitle cleanup
- Subtitle acquisition
- Edition handling
- Quality profiles
- Upgrade monitoring
- Missing media monitoring
- System jobs
- Backups
- Data integrity checks
- Administrative dashboards

### Player app becomes responsible for

[Likely]

- Home screen
- Library browsing
- Film playback
- Series/episode playback
- Continue watching
- Recently added
- Search
- Detail pages
- Profiles
- Watch progress
- Playback history
- Favorites/watchlist
- Basic collection shelves
- Subtitles/audio selection UI
- Manual library scan mode
- Local-only mode where Archivist is not installed
- Later: TV/mobile/tablet/native clients

### Player app should not own

[Likely]

- Torrent management
- Indexer setup
- Download-client setup
- Release scoring
- Metadata editing as a primary workflow
- Import matching as a primary workflow
- Quality profile administration
- Backup jobs
- System maintenance

[Likely] The player can expose lightweight status indicators, but it should not become an operations dashboard.

---

## 5. Positioning

[Likely] The new app should be positioned as the viewer/reader/listener/player for an Archivist-managed library.

[Likely] The product should not initially position itself as a full Plex/Jellyfin replacement. That comparison creates too many expectations too early: transcoding, native TV apps, remote access, user management, live TV, plugins, hardware acceleration, federation, and mature subtitle/audio handling.

[Likely] The sharper initial position is:

> A beautiful local-first media player designed for Archivist libraries, with optional manual library support.

[Likely] Over time, if playback, transcoding, clients, and remote access mature, it can compete more directly with Jellyfin/Plex-style use cases.

---

## 6. Default experience

[Likely] The default and most polished experience should be **Archivist-paired mode**.

### First-run flow

[Likely]

1. User opens player app.
2. App asks: `Connect to Archivist` or `Use manual library`.
3. Recommended option is clearly `Connect to Archivist`.
4. App attempts local discovery.
5. If local discovery fails, user enters Archivist URL.
6. User enters API key or completes a future pairing-code flow.
7. App calls Archivist health endpoint.
8. App loads libraries.
9. App lands on home screen.

### Pairing copy

[Likely]

```txt
Connect to Archivist
Use Archivist as your media brain: metadata, imports, quality, downloads, editions, and library management. This player becomes the clean front door to everything Archivist maintains.
```

### Manual mode copy

[Likely]

```txt
Manual Library
Point the player at existing folders. Useful if you already have media files and do not want Archivist managing acquisition or imports yet.
```

---

## 7. Manual library mode

[Likely] Manual library mode is valuable because it lowers adoption friction.

[Likely] Manual mode should allow users to:

- Add root folders.
- Scan film and series files.
- Infer metadata from folder/file names.
- Match against TMDB/TVDB or local NFO files.
- Store results in a local player database.
- Browse and play files.
- Track progress locally.

[Likely] Manual mode should not try to replicate Archivist’s full acquisition pipeline.

[Likely] Manual mode can later include an upgrade path:

```txt
Manual player library -> Connect Archivist -> Offer migration/import into Archivist
```

[Likely] This makes the player a soft acquisition funnel for Archivist.

---

## 8. MVP scope

[Likely] The first release should focus on **films and series only**.

[Likely] Films and series create the clearest initial value because they make the player feel alive quickly: posters, backdrops, playback, progress, continue watching, next episode, and home rails.

[Likely] Music, books, comics, and games should wait until the playback/reading/emulation interaction model is clearer.

### MVP v1 should include

[Likely]

- Archivist connection setup
- API key authentication
- Health check
- Library list
- Films grid
- Film detail page
- Film playback
- Series grid
- Series detail page
- Season/episode browser
- Episode playback
- Continue watching
- Recently added
- Search across films/series
- Basic profile support
- Local watch progress
- Direct play only
- Manual folder scan for films/series

### MVP v1 should exclude

[Likely]

- Transcoding
- Native mobile apps
- Native TV apps
- Remote streaming outside LAN
- Music playback
- Audiobook playback
- Comic reader
- Ebook reader
- Game launcher
- Multi-user remote auth
- Social/sharing features
- Metadata editing
- Torrent/download management

---

## 9. Architecture recommendation

[Likely] The player app should live in a separate repository.

```txt
archivist-lab/archivist
  apps/server
  client
  packages/contracts
  packages/db
  packages/core
  packages/*

archivist-lab/archivist-player
  apps/web
  packages/player-sdk
  packages/ui
  packages/types
```

[Likely] A separate repository forces a clean boundary and prevents the player from becoming another embedded admin surface.

[Likely] Archivist should expose a dedicated player-facing API instead of requiring the player to consume the existing admin/domain routes directly.

### Proposed Archivist backend addition

[Likely]

```txt
apps/server/src/player/routes.ts
```

Registered from the existing route registry or app bootstrap as:

```ts
api.use('/player', createPlayerRouter())
```

Resulting route prefix:

```txt
/api/v1/player/*
```

---

## 10. Player API contract

[Likely] The player API should be read-heavy, stable, and intentionally narrower than the full Archivist API.

### Health and pairing

[Likely]

```txt
GET /api/v1/player/health
GET /api/v1/player/server-info
```

Example response:

```json
{
  "status": "ok",
  "serverName": "Archivist",
  "version": "2.0.0",
  "capabilities": {
    "films": true,
    "series": true,
    "music": false,
    "books": false,
    "comics": false,
    "games": false,
    "directPlay": true,
    "transcoding": false,
    "events": true
  }
}
```

### Libraries

[Likely]

```txt
GET /api/v1/player/libraries
```

Purpose:

- Return libraries/tabs in a consumption-friendly shape.
- Hide admin-only config.
- Include media type, name, item count, available count, and poster samples.

### Home

[Likely]

```txt
GET /api/v1/player/home
```

Home response should include rails:

- Continue watching
- Recently added films
- Recently added episodes
- Recently completed downloads
- New series episodes
- In-progress series
- Recommended from library

### Search

[Likely]

```txt
GET /api/v1/player/search?q=alien
```

Search should return mixed results:

```txt
film | series | episode | person later | collection later
```

### Films

[Likely]

```txt
GET /api/v1/player/films
GET /api/v1/player/films/:id
GET /api/v1/player/films/:id/play
```

Film list should include:

- id
- title
- sortTitle
- year
- overview snippet
- poster
- backdrop
- logo
- runtime
- rating
- certification
- genres
- status
- quality
- hasFile
- defaultEditionId
- progress

Film detail should include:

- full metadata
- available editions
- playback target
- trailer if present
- cast/crew
- related items later

### Series

[Likely]

```txt
GET /api/v1/player/series
GET /api/v1/player/series/:id
GET /api/v1/player/series/:id/seasons
GET /api/v1/player/episodes/:id
GET /api/v1/player/episodes/:id/play
```

Series detail should include:

- metadata
- seasons
- episodes
- watched/unwatched state
- next episode
- series progress

### Progress

[Likely]

```txt
GET /api/v1/player/progress
POST /api/v1/player/progress
DELETE /api/v1/player/progress/:id
```

Progress write body:

```json
{
  "profileId": "local-default",
  "mediaType": "film",
  "itemId": 123,
  "positionSeconds": 3912,
  "durationSeconds": 7200,
  "completed": false,
  "updatedAt": "2026-07-09T00:00:00Z"
}
```

[Likely] Progress should initially be stored in the player app database, not Archivist, unless multi-device sync is included in the first release.

[Likely] Archivist-hosted progress sync can be added later as a player API extension.

---

## 11. Streaming strategy

[Likely] The player should not rely permanently on raw `/media` static file serving for playback.

[Likely] Static serving is useful for posters/backdrops and simple local access, but a real player app needs controlled stream endpoints.

### Required stream endpoints

[Likely]

```txt
GET /api/v1/player/stream/films/:filmId
GET /api/v1/player/stream/film-editions/:editionId
GET /api/v1/player/stream/episodes/:episodeId
```

### Stream endpoint requirements

[Likely]

- API key enforcement
- Library authorization
- No absolute path leakage
- Path traversal protection
- File existence checks
- MIME type detection
- HTTP range request support
- HEAD support
- Cache headers where appropriate
- Clear 404/410 response when file no longer exists
- Separate subtitle endpoints
- Later: transcoding handoff

### Initial playback approach

[Likely]

Start with **direct play only**.

[Likely] Direct play avoids the complexity of hardware acceleration, ffmpeg session orchestration, adaptive bitrate ladders, HLS generation, subtitles burn-in, audio transcoding, and remote streaming constraints.

[Likely] Transcoding should be treated as a later feature once target devices are known.

---

## 12. Authentication and security

[Likely] The player app should not use the full Archivist admin API key forever.

[Likely] MVP can use the existing API key, but the target architecture should introduce scoped player tokens.

### Token types

[Likely]

```txt
admin token     -> full Archivist control
player token    -> read/play/progress only
pairing token   -> temporary setup token
```

### Player token permissions

[Likely]

- Read libraries
- Read player metadata
- Stream available files
- Read player home/search
- Write watch progress if Archivist sync is enabled
- No torrent/download/indexer/system admin access

### Pairing flow later

[Likely]

1. Player app shows pairing code.
2. Archivist admin UI shows pending player.
3. User approves.
4. Archivist issues scoped player token.
5. Player stores token securely.

[Likely] This is safer and cleaner than asking users to paste permanent admin API keys into every client.

---

## 13. Data model implications

[Certain] Archivist already stores file paths and metadata across films, film editions, episodes, tracks, book editions, comic issues, and games.

[Likely] The player app should never need to know actual server file paths.

[Likely] The player should receive opaque playable IDs and stream URLs.

### Example media item shape

[Likely]

```json
{
  "id": 123,
  "type": "film",
  "title": "Alien",
  "year": 1979,
  "posterUrl": "/api/v1/player/artwork/films/123/poster",
  "backdropUrl": "/api/v1/player/artwork/films/123/backdrop",
  "status": "available",
  "runtimeSeconds": 7020,
  "quality": {
    "resolution": "1080p",
    "source": "Bluray",
    "codec": "HEVC",
    "tier": 3
  },
  "playback": {
    "directPlay": true,
    "streamUrl": "/api/v1/player/stream/films/123"
  }
}
```

[Likely] This lets the player survive internal Archivist schema changes.

---

## 14. User experience principles

[Likely] The player should feel calm, premium, and fast.

[Likely] Archivist can be dense because it is an operations tool. The player should not be dense.

### UI principles

[Likely]

- Fewer controls by default.
- Big artwork.
- Fast search.
- Clear continue-watching state.
- Minimal admin language.
- No torrent/indexer terminology in the default player experience.
- Hide missing/unavailable items unless the user chooses to show them.
- Show quality information subtly, not as the main UI.
- Let the user start playback in one or two actions.

### Home rails

[Likely]

Initial rails:

1. Continue Watching
2. Recently Added
3. New Episodes
4. Films
5. Series
6. Unwatched
7. Downloading / Recently Completed, optional and subtle

### Detail page priorities

[Likely]

Film detail page:

1. Play button
2. Resume button if partially watched
3. Artwork/title/year/runtime/rating
4. Overview
5. Editions if multiple exist
6. Cast/crew
7. Quality/file info collapsed by default

Series detail page:

1. Resume/Next Episode
2. Season picker
3. Episode list
4. Watched state
5. Series overview
6. Quality/status collapsed by default

---

## 15. Naming candidates

[Likely] The name should feel like the viewing room attached to Archivist, not another automation tool.

### Best candidates

[Likely]

| Name | Rationale |
|---|---|
| Archivist Player | Clearest initial name; no confusion. |
| Archivist View | Strong ecosystem naming; slightly broader than playback. |
| Screenroom | Human, simple, media-consumption focused. |
| Vaultscreen | Fits archive/vault language. |
| Lumen | Premium, clean, projector/light association. |
| Reelhouse | Warmer and more film-first. |
| Atlas Player | Good if cross-media navigation becomes central. |
| Curio | Good for films/books/comics/games, less obviously playback. |

[Likely] The best working name is **Archivist Player**.

[Likely] The best polished ecosystem name may become **Archivist View** if the app grows beyond video playback into reading, listening, comics, and games.

[Likely] The file and project can use `archivist-player` until branding is deliberately revisited.

---

## 16. Suggested repository/package names

[Likely]

```txt
Repository: archivist-lab/archivist-player
App name: Archivist Player
Package namespace: @archivist/player-*
Web app: apps/web
SDK: packages/player-sdk
Shared UI: packages/ui
Shared types: packages/types
```

[Likely] If the app remains in the existing monorepo temporarily, use:

```txt
apps/player
packages/player-sdk
```

[Likely] Long term, a separate repo is cleaner.

---

## 17. Technical stack recommendation

[Likely] For the first web app:

```txt
TypeScript
React
Vite
TanStack Query or equivalent server-state layer
React Router
SQLite or IndexedDB for local/manual mode metadata and progress
HTML5 video direct play
HLS.js later if HLS/transcoding is added
```

[Likely] The player SDK should be generated or manually typed from shared contracts.

[Likely] The first version should prioritize web/LAN use before TV-native or mobile-native clients.

### Why web first

[Likely]

- Fastest to build.
- Easy to test against local Archivist.
- Works on desktop, tablets, and some TV browsers.
- Proves API contract before native clients harden it.

### Later clients

[Likely]

- Android TV
- Apple TV
- iOS/iPadOS
- Android
- Desktop shell if useful

---

## 18. Roadmap

### Phase 0: Archivist backend player surface

[Likely]

- Add `/api/v1/player/health`.
- Add `/api/v1/player/server-info`.
- Add `/api/v1/player/libraries`.
- Add `/api/v1/player/films`.
- Add `/api/v1/player/films/:id`.
- Add `/api/v1/player/series`.
- Add `/api/v1/player/series/:id`.
- Add `/api/v1/player/episodes/:id`.
- Add direct stream endpoint with range requests.
- Add player API tests.

### Phase 1: Player web MVP

[Likely]

- Create `archivist-player` repo.
- Add Vite/React app.
- Add connection settings.
- Add player SDK.
- Add home page.
- Add films grid.
- Add film detail.
- Add video playback.
- Add series grid.
- Add series detail.
- Add episode playback.
- Add local progress.

### Phase 2: Manual mode

[Likely]

- Add root folder setup.
- Add folder scanner.
- Add metadata matching.
- Add manual local database.
- Add manual films/series browsing.
- Add manual direct playback.
- Add migration path to Archivist.

### Phase 3: Better playback

[Likely]

- Subtitle selection.
- Audio track selection if browser supports it or via stream variants.
- Better resume handling.
- Watch states.
- Keyboard/remote controls.
- Fullscreen polish.
- Playback error handling.

### Phase 4: Multi-profile and sync

[Likely]

- Profiles.
- Per-profile progress.
- Optional Archivist-backed sync.
- Continue watching across clients.
- Watched/unwatched management.

### Phase 5: Wider media types

[Likely]

- Music playback.
- Audiobook playback.
- Ebook reader.
- Comic reader.
- Game launching or web arcade integration.

### Phase 6: Native/TV clients

[Likely]

- Android TV.
- Apple TV.
- Mobile companions.
- Remote-friendly UI.

---

## 19. Immediate implementation checklist

[Likely] First Archivist-side tasks:

```txt
[ ] Create apps/server/src/player/routes.ts
[ ] Register player router under /api/v1/player
[ ] Add player health endpoint
[ ] Add player library endpoint
[ ] Add player films list endpoint
[ ] Add player film detail endpoint
[ ] Add player series list endpoint
[ ] Add player series detail endpoint
[ ] Add player episode detail endpoint
[ ] Add direct stream endpoint for film default edition
[ ] Add direct stream endpoint for episode
[ ] Add HTTP range request support
[ ] Add tests for all player endpoints
[ ] Add docs for player API
```

[Likely] First player-app tasks:

```txt
[ ] Create archivist-player repo
[ ] Add Vite React TypeScript app
[ ] Add connection screen
[ ] Add typed Archivist API client
[ ] Add server health check
[ ] Add local settings storage
[ ] Add home layout
[ ] Add films grid
[ ] Add film detail page
[ ] Add video player component
[ ] Add continue watching local store
[ ] Add series grid
[ ] Add series detail page
[ ] Add episode playback
```

---

## 20. Risks

### Risk: Player couples to internal admin routes

[Likely] If the player consumes existing management routes directly, Archivist backend changes will break the player.

[Likely] Mitigation: create `/api/v1/player/*` as a stable read/play contract.

### Risk: Transcoding derails MVP

[Likely] Transcoding will balloon complexity.

[Likely] Mitigation: direct play first; define transcoding as a separate phase.

### Risk: Product becomes a Plex/Jellyfin clone too early

[Likely] Competing head-on with mature media servers creates an expectation gap.

[Likely] Mitigation: position around Archivist-native curated playback first.

### Risk: Manual mode becomes a second product

[Likely] Manual mode can consume a lot of time if it tries to match Archivist capabilities.

[Likely] Mitigation: keep manual mode simple: scan, match, browse, play, track progress.

### Risk: Security model is too broad

[Likely] Reusing admin API keys in player clients is acceptable for a private MVP but poor long-term design.

[Likely] Mitigation: introduce scoped player tokens and pairing flow.

### Risk: Static media serving leaks too much

[Likely] Direct `/media` static serving is not enough for a proper player.

[Likely] Mitigation: use authenticated stream endpoints and opaque media IDs.

---

## 21. Open questions

[Likely]

1. Should the initial player app support remote access, or LAN-only?
2. Should watch progress live in Archivist from day one or remain local at first?
3. Should profiles be local-only first?
4. Should unavailable/missing items appear in the player by default?
5. Should the player expose download/upgrading status?
6. Should the app eventually include management-light actions such as “search for upgrade” or “mark watched”?
7. Should the player support multiple Archivist servers?
8. Should manual mode use the same local schema as Archivist or a simpler player schema?
9. Should media artwork be proxied through player endpoints or served from existing media paths?
10. Should the long-term brand be Archivist Player, Archivist View, or something more independent?

---

## 22. Success metrics

[Likely] Early success should be measured by whether the app makes an Archivist-managed library feel instantly usable.

### MVP success criteria

[Likely]

- User can connect to Archivist in under two minutes.
- User can browse films and series without touching Archivist admin UI.
- User can play a film.
- User can play an episode.
- User can resume partially watched media.
- User can search across films and series.
- Player never exposes internal file paths.
- Player does not require torrent/indexer/admin knowledge.
- Player remains usable with direct play only.

---

## 23. Strategic recommendation

[Likely] Build the Archivist player API first, then build the player app against only that API.

[Likely] Do not start by styling the current Archivist frontend into a player.

[Likely] Do not start with transcoding.

[Likely] Do not start with all media types.

[Likely] Do not let manual mode drive the architecture.

[Likely] The correct first move is:

```txt
Create a stable /api/v1/player surface inside Archivist.
Then create archivist-player as a separate app that treats Archivist as its premium backend.
```

[Likely] This gives the project a clean product boundary:

> Archivist manages the archive. Archivist Player experiences it.
