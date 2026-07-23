# Archivist for Kodi

Archivist for Kodi is a read/play client for available films and television episodes in an Archivist library. Kodi performs playback; Archivist supplies browsing, metadata, artwork, search, recommendations, resume state and watched state.

## Requirements

- Kodi with Python 3 add-on support.
- An Archivist server reachable from the Kodi device.
- An Archivist username and password configured through the Server application.
- Kodi must connect to Archivist's main server port (`2424` by default), not the browser Player port (`4242`).

## Build and install

From the Archivist repository:

```sh
pnpm build:kodi
```

This creates `apps/kodi/dist/plugin.video.archivist-<version>.zip`. In Kodi, enable installation from unknown sources and use **Add-ons → Install from zip file**.

For automatic updates, install `apps/kodi/repository/public/repository.archivist-<version>.zip` once, then install **Archivist** from **Archivist Repository → Video add-ons**. Kodi reads repository metadata from the Archivist GitHub repository and applies later releases through its normal update system.

Open the add-on settings and enter:

- **Server URL:** for example `http://192.168.1.20:2424`.
- **Username and password:** use the same account as the Archivist Server application. Choose **Configure Connection** inside the add-on to sign in; the password is not stored.
- **Player profile:** normally `default`; use another Archivist Player profile when watched history should be separate.

Use **Test Connection** from the add-on's root screen before playback.

## Player and library behaviour

- Only locally available films, series and episodes are listed.
- Original media is streamed over HTTP with range support and played by Kodi.
- Protected posters, fanart, logos and episode stills are cached in Kodi's add-on profile and refreshed weekly.
- Kodi's normal OSD selects embedded audio and subtitle tracks.
- Sidecar subtitles are attached to the Kodi item.
- Resume position and watched state synchronize with the selected Archivist profile.
- Playback progress is sent every 15 seconds by default and on pause/stop/end.
- The next unwatched available episode can play automatically.
- Available films and episodes synchronize immediately after a server-side library change. A 15-minute periodic reconciliation remains enabled as a missed-event and connectivity fallback.
- Previously loaded browse screens remain available from a profile-scoped last-known-good cache during temporary server outages. Kodi clearly labels offline fallback; playback and watched-state changes still require the server.
- The managed Movies and TV Shows paths are automatically assigned Kodi's fixed `movies` and `tvshows` content types using local NFO metadata; no manual **Set content** step is required.
- The Movies source is scanned recursively by one level because every generated movie has its own folder; Kodi handles the TV show hierarchy through its dedicated TV scanner.
- A signed-in installation synchronizes immediately on Kodi startup or add-on upgrade, and signing in triggers the first synchronization directly.
- Native entries use local NFO metadata, cached artwork and secure Archivist plugin playback URLs.
- Exact media probes are cached persistently on the server, so repeat library syncs do not re-run ffprobe for unchanged files.
- Kodi-native watched, unwatched and resume changes reconcile back to Archivist; server-side changes reconcile into Kodi.
- Kodi negotiates direct play against configured codec and resolution capabilities, with a one-shot compatibility-transcode retry when direct playback cannot start.
- Preferred audio and subtitle languages are selected before playback while Kodi's native OSD remains available.
- Films with multiple available editions present an edition selector without changing Archivist's default edition.
- Archivist intro and credit segments can prompt for skipping; credits can optionally be skipped automatically. Embedded chapters remain untouched.
- New sign-ins receive a named, revocable device credential. Devices can be revoked from **Server Settings → System → Devices**.
- Synchronization failures use bounded exponential backoff and remain visible through **Synchronization Status**. **Repair Archivist Kodi Library** rebuilds only the managed mirror.
- Existing native rows receive authoritative metadata again after a completed Kodi video scan.
- Removed or unavailable Archivist items are removed from the managed mirror on the next synchronization.
- Films and series synchronization can be controlled independently, and **Synchronize now** is available in settings.
- Offline browse fallback is enabled by default with a configurable retention period and an **Offline Cache Status** diagnostic screen.

Kodi exchanges the temporary login session for a named, one-year revocable device credential and never stores the account password. An API token remains available as an advanced fallback. Treat the Kodi device as trusted.

## Development tests

```sh
pnpm test:kodi
```
