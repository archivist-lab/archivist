---
title: "Kodi media add-on — Phase 1"
document_type: plan
status: historical
classified: 2026-08-16
---
# Kodi media add-on — Phase 1

## Scope

Phase 1 is deliberately a media client rather than an Archivist administration client. It uses dynamic Kodi plugin directories and Kodi's native video player. It does not modify Kodi's video database and does not expose acquisition, metadata editing, indexers, downloads or processing controls.

## Components

- `default.py` dispatches Kodi plugin routes.
- `resources/lib/archivist/plugin.py` presents the library using native Kodi list items.
- `resources/lib/archivist/api.py` is the isolated Archivist Player API client.
- `service.py` starts a background `xbmc.Player` observer.
- `resources/lib/archivist/service.py` synchronizes playback progress and watched state.

The API abstraction intentionally hides Kodi from connection and transport logic so a future device-token pairing flow can replace the current API token without rewriting browsing or playback.

## Supported flows

1. Configure the server URL and sign in with an Archivist username and password.
2. Test the authenticated Player API connection.
3. Browse Continue Watching, recently added media, recommendations, films, series, seasons, collections and search results.
4. Resolve an opaque Archivist stream URL and let Kodi direct-play it.
5. Use Kodi's built-in OSD for embedded audio, embedded subtitles and chapters.
6. Attach external sidecar subtitles returned by Archivist.
7. Restore the Archivist resume point.
8. Report start, periodic progress, pause, stop and completion to Archivist.
9. Optionally launch the next available unwatched episode after completion.

## Security boundary

The add-on uses only `/api/v1/player` and protected `/media` URLs. It never receives server filesystem paths. A normal Archivist login returns a 30-day session which Kodi uses for API, artwork and media requests through Kodi's URL-header format. The password is not persisted. The service API token remains an optional advanced fallback.

## Acceptance criteria

- Unavailable media does not appear in normal library browsing.
- A film and episode can direct-play with HTTP range requests.
- Posters, fanart and Kodi video metadata populate native skins.
- A stopped item resumes from the synchronized position on another client.
- Completing an item marks it watched in the Archivist profile.
- Mark watched/unwatched context actions update Archivist.
- Embedded stream selection remains under Kodi's native OSD.
- Sidecar subtitles are offered without transcoding.
- Network or authentication errors close the Kodi directory cleanly and show a useful error.
- The distributable ZIP validates its XML and Python before packaging.

## Deferred

- Revocable device-token and short-code approval flow.
- Durable server change feed and offline cache.
- Kodi database synchronization.
- Client capability negotiation, remux and Kodi-specific transcoding.
- Intro/credit skip prompts and film edition selection.
- Remote control and casting.
