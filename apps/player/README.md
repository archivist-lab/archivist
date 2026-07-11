# Archivist Player

Archivist Player is the consumption application in the Archivist workspace. It is served on port `4242` and proxies only the stable `/api/v1/player` contract and protected media assets to Archivist on port `2424`.

The browser never receives `ARCHIVIST_SERVICE_TOKEN`. The production Node server injects it on upstream requests, preserving range and streaming responses.

## Development

```bash
corepack pnpm --filter archivist-player dev
corepack pnpm --filter archivist-player build
```

## Production

Run Player through the repository-level `docker-compose.yml`. The Player automatically uses its same-origin proxy; there is no first-run server URL or API-key pairing step.

Playback progress is cached locally for responsiveness and persisted to Archivist SQLite for cross-browser continuity. Direct play, subtitle extraction, loudness normalization, compatibility transcoding, and Channels sessions use the server Player API.
