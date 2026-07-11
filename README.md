# Archivist

Archivist is a self-hosted media automation and playback system. This repository contains both applications:

- **Archivist** on port `2424`: administration, discovery, acquisition, imports, library management, and the API.
- **Archivist Player** on port `4242`: browsing, Channels, playback, transcoding, and synchronized watch progress.

Both applications are built from one pnpm workspace and deployed from one Compose project. They remain separate containers so playback can be restarted or scaled independently from library automation.

## Automatic Acquisition

Archivist now operates without manual searches for monitored items:

- Enabled indexers are polled for new releases.
- A persistent targeted-search scheduler runs hourly for monitored missing films, aired episodes, albums, books, comic issues, and games.
- Each missing item has a four-hour persisted cooldown; up to 25 items are searched per hourly cycle.
- Continuing and upcoming series refresh metadata every six hours by default, discovering newly listed episodes. Ended series refresh weekly. Per-series refresh intervals override these defaults.
- Releases are parsed, matched to monitored subjects, evaluated against quality and upgrade rules, recorded in the acquisition ledger, and sent to the selected download client.
- Items only enter an acquiring state after the client confirms acceptance. Completed downloads are imported from the built-in engine, Transmission, or qBittorrent.

This means newly released films and episodes are found automatically when an enabled indexer returns a recognizable release and the item/episode is monitored. Availability still depends on indexer coverage, metadata-provider timing, title parseability, quality rules, and download-client health.

## Requirements

- Node.js 20+
- Corepack with pnpm 9.15.9
- Metadata provider credentials for the domains you use

## Source Setup

```bash
corepack enable
corepack pnpm install
corepack pnpm build
cp .env.example .env
```

On the first Admin visit, sign in with `archivist` / `archivist`. That bootstrap session can only create the first administrator account; Archivist immediately prompts for a personal username and password, then permanently disables the default credentials.

Set a strong `ARCHIVIST_API_TOKEN` for internal service access and the Player proxy. It is not a browser login credential. Generate one with:

```bash
openssl rand -hex 32
```

Run the admin application directly with `corepack pnpm start`. The production Player is normally run through Compose because its port-4242 server proxies the authenticated Player API and media streams without exposing the internal service token to the browser.

## Docker

The base stack publishes only the two application ports:

```bash
docker compose up -d --build
# Admin:  http://localhost:2424
# Player: http://localhost:4242
```

The built-in torrent engine can initiate outbound connections without publishing peer ports. Incoming peer connectivity and seeding will be reduced. To publish the dedicated P2P sockets, opt into the override:

```bash
docker compose -f docker-compose.yml -f docker-compose.torrents.yml up -d
```

That adds:

- `2425/tcp`: BitTorrent peer TCP
- `2426/udp`: DHT
- `2427/udp`: uTP

Do not map `2425/udp`; uTP uses `2427/udp` in Archivist. Forward the same ports on the router only when inbound peer connectivity is wanted.

When using Transmission or qBittorrent instead of the embedded engine, set `ARCHIVIST_EMBEDDED_TORRENTS=false` and leave the P2P override disabled. Archivist must be able to see the client download path. Use a shared mount or `REMOTE_PATH_MAP=/remote/path:/local/path`.

Persistent state is bind-mounted from `./data`; organized media is under `./media`; active and completed downloads are under `./downloads`. The repository tracks empty mount directories so Compose does not create root-owned bind paths on first boot. Ensure all three directories remain writable by UID/GID 1000 because the image runs as the unprivileged `node` user.

A single container serves both ports: **2424** is the admin UI + full API, and **4242** is the Player UI. The Player is served in-process by the same server, which exposes only the stable `/api/v1/player` contract and protected `/media/` assets on 4242 (the admin API is not reachable there) and injects the service token server-side so the browser never receives it.

## Published Image

`docker-compose.release.yml` runs:

- `ghcr.io/archivist-lab/archivist:latest`

The GitHub workflow publishes a multi-architecture amd64/arm64 image. This one image serves both the admin API (2424) and the Player UI (4242).

## Validation

```bash
corepack pnpm test
corepack pnpm verify
```

## Layout

- `apps/server/`: Express backend, schedulers, acquisition pipeline, imports, and Player API
- `apps/player/`: React Player plus its authenticated production proxy
- `client/`: Archivist administration SPA
- `packages/contracts|db|core/`: contracts, unified SQLite schema, and shared services
- `packages/types|bittorrent|torrent-engine|indexer-engine/`: torrent and indexer stack
