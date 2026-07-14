# Archivist Player

Archivist Player is the consumption application in the Archivist workspace — the React frontend users watch/listen from.

In production it is served on port `4242` **in-process by the main Archivist server** (`apps/server`), which builds this app's `dist/` into its image. That listener exposes only the stable `/api/v1/player` contract and protected `/media/` assets (delegated to the main app in-process); the admin API is not reachable on 4242. `ARCHIVIST_SERVICE_TOKEN` is injected server-side, so the browser never receives it. There is no longer a separate player container — see `apps/server/src/player-frontend.ts`.

## Development

```bash
corepack pnpm --filter archivist-player dev     # standalone Vite dev server on 4242
corepack pnpm --filter archivist-player build    # produces dist/, served by apps/server in prod
```

## Production

Run the single `archivist` service from the repository-level `docker-compose.yml`; it serves the admin API on 2424 and this Player on 4242. The Player uses its same-origin API; there is no first-run server URL or API-key pairing step.

Playback progress is cached locally for responsiveness and persisted to Archivist SQLite for cross-browser continuity. Direct play, subtitle extraction, loudness normalization, compatibility transcoding, and Channels sessions use the server Player API.

## Living-Room UI v2

The v2 interface is a clean-room Archivist implementation informed by living-room media interaction patterns. It contains no Kodi skin code, artwork, screenshots, fonts, branding, or copied assets. It uses system fonts and makes no runtime font or external-service requests.

Enable it at runtime with `PLAYER_UI_V2_ENABLED=true`. The legacy interface remains in the same bundle for immediate rollback; set the flag to `false` and restart the service. Disabling v2 does not delete its saved preferences.

| Environment variable | Default | Accepted values |
|---|---:|---|
| `PLAYER_UI_V2_ENABLED` | `false` | `true`, `false` |
| `PLAYER_UI_DEFAULT_PRESET` | `categories` | `classic`, `categories`, `compound`, `combined` |
| `PLAYER_UI_MAX_WIDGET_ITEMS` | `36` | integer from `12` through `60` |
| `PLAYER_UI_TELEMETRY_ENABLED` | `false` | `true`, `false` |

The four presets change the shell and Home composition. Preferences are stored in the existing Archivist SQLite database under profile `default`; Settings supports Save, Discard, conflict resolution, and Reset. Reset preserves playback progress and local search history.

### Controls

- Arrow keys or D-pad: move focus; hold Left/Right during playback for accelerated seeking.
- Enter, Space, or gamepad primary: activate the focused action.
- Escape, Browser Back, Backspace outside text input, or gamepad secondary: close the current panel, then move back through the route hierarchy.
- `F`: fullscreen; `M`: mute; `C`: subtitles off; `N`: next Channels item.
- Pointer and touch remain supported for every action.

The video OSD exposes Information, Audio, Subtitles, Video mode, and—during Channels sessions—Queue. It hides after three seconds while playing, stays visible when paused, and offers retry/close controls after playback failure.

### Telemetry and privacy

Telemetry defaults off. When enabled, the browser sends only approved performance metric names, numeric durations, timestamps, and a random session UUID to the same Archivist server. The server aggregates them in memory and clears them on restart. Search text, media titles, file paths, account identifiers, tokens, and free text are rejected and never stored in telemetry.

### Verification

```bash
corepack pnpm --filter archivist-player test
corepack pnpm --filter archivist-player build
corepack pnpm --filter archivist-player test:e2e
corepack pnpm verify
```

Production frontend changes require a new bundle. For a source installation run `corepack pnpm build` and restart Archivist. For Docker, rebuild the image and redeploy the service; restarting an old image cannot expose new Player code. Verify `/ping` on port `2424` and `/healthz` on port `4242` after deployment.
