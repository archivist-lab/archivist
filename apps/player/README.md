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
