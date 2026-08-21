---
title: "Kodi media add-on — Phase 2"
document_type: plan
status: historical
classified: 2026-08-16
---
# Kodi media add-on — Phase 2

## Outcome

Phase 2 adds an authoritative native Kodi library mirror while retaining the dynamic Archivist add-on. Available films and episodes can therefore appear in Kodi's Movies, TV Shows, seasons, smart playlists and compatible skins. Playback remains an opaque Archivist plugin URL; server filesystem paths and credentials are never written to the mirror.

## Synchronization model

Archivist exposes `GET /api/v1/player/sync/manifest`, a profile-aware snapshot containing only playable films and episodes, their public metadata, artwork references and playback progress. A content digest identifies each snapshot. The Kodi client converts it into a managed tree beneath its add-on profile:

- `Movies/<title> (<year>) [<id>]/movie.strm` and `movie.nfo`
- `TV Shows/<title> (<year>) [<id>]/tvshow.nfo`
- `TV Shows/.../Season <number>/SxxExx.strm` and matching episode NFO
- conventional season artwork names such as `season01-poster.jpg`

The client hashes every generated file. Unchanged files are left untouched, changed files are replaced atomically, and files absent from the authoritative manifest are removed. It registers separate **Archivist Movies** and **Archivist TV Shows** sources while preserving unrelated user sources. The add-on assigns the exact managed paths Kodi's `movies` and `tvshows` content classifications with the bundled local-information scraper. Movie recursion is fixed at one level because every movie occupies its own folder; TV hierarchy traversal remains delegated to Kodi's TV scanner. The adapter discovers Kodi's active `MyVideos*.db` and updates only those two path rows, avoiding database-version assumptions and unrelated libraries. Kodi scans only after a material or classification change and cleans its database after removals.

## Metadata and artwork

NFO files include Archivist and provider unique IDs, titles, original/sort titles, dates, plots, exact runtime, genres, ratings, certification, network/studio, country, collections, cast, directors, writers, trailer, stream details, watched state and resume state where available. Posters, fanart, banners, logos, season posters and episode stills are authenticated once, cached locally and referenced by the NFO files. Kodi remains responsible for its texture cache.

The server persists ffprobe results keyed by media type, ID, path, size and modification time. Large unchanged libraries therefore reuse exact runtime, video, audio and subtitle metadata across server restarts; changed files invalidate their cached probe automatically.

## Native state reconciliation

The add-on service reads Kodi's native movie and episode database through JSON-RPC. Archivist IDs in NFO `uniqueid` fields provide stable identity. Watched, unwatched and resume changes made in Kodi are sent to the selected Archivist profile; progress changed on the server is written back into Kodi. The first reconciliation treats the server profile as authoritative. If both sides change between reconciliations, the server wins deterministically rather than oscillating.

When Kodi reports that a video scan completed, the service reapplies authoritative mutable fields with `VideoLibrary.Set*Details`. This makes updated runtime and metadata reach existing Kodi records instead of relying only on initial NFO ingestion.

## Operation

- Automatic synchronization is enabled by default every 15 minutes, with an immediate run on startup/upgrade for signed-in installations and immediately after first sign-in.
- Films and series can be independently included or excluded.
- **Synchronize now** is available in both the add-on home screen and settings.
- The dynamic browsing interface remains available even if native synchronization is disabled.
- All dynamic surfaces enrich local film, series and episode cards from the same manifest, so codec, resolution, audio, subtitle and exact runtime fields remain consistent across library, search, recent, continue-watching and collection views.

## Security and ownership

Only the folder carrying `.archivist-managed` and `.sync-state.json` is mutated. Archivist never edits arbitrary Kodi media folders. STRM files contain only plugin routes, not API tokens, cookies, URLs or filesystem paths.

## Remaining hardening

- Revocable per-device pairing tokens.
- Capability negotiation and remux/transcode fallback.
- Timestamp-aware merge UX for simultaneous changes made by two offline Kodi clients (the current deterministic server-wins rule prevents oscillation).
- Intro/credit skip presentation and edition selection.
