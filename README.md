# Archivist

Self-contained Archivist: unified-database media automation backend (Express +
better-sqlite3) with the preserved React frontend, cross-domain release pipeline,
built-in torrent engine, and job/event-driven imports for films, series, music,
books, comics, and games.

## Requirements

- Node.js 20+
- corepack enabled (`corepack enable`) — pnpm 9.15.9 is pinned via `packageManager`

## Setup

```bash
corepack pnpm bootstrap   # install + build packages, server, and client
```

Copy `.env.example` to `.env` and fill in your metadata provider keys (TMDB,
TVDB, ComicVine, IGDB, ...). An optional `config.toml` at the repo root
overrides defaults — see `apps/server/config.example.toml`.

## Run

```bash
corepack pnpm start       # production: node apps/server/dist/server.js
corepack pnpm dev         # development: tsx watch with hot reload
```

The app serves the frontend and API on <http://localhost:2424> by default
(`ARCHIVIST_PORT` / `config.toml` to change).

Everything the app writes lives inside this folder:

- `data/` — SQLite database, torrent state, downloads, indexer definitions
- `media/` — organized library files

## Docker

For local development or source-based installs:

```bash
cp .env.example .env
docker compose up -d      # builds the image, serves on http://localhost:2424
```

State lives in bind-mounted host folders `./data` (SQLite DB, downloads,
torrent state) and `./media` (your organized library) — both directly browsable
on disk; point them elsewhere (e.g. a NAS mount) by editing the `volumes:` in
`docker-compose.yml`. API keys come from `.env` via `env_file`. The image
bundles ffmpeg/ffprobe and the indexer definitions, so no other containers or
host tools are required.

For users who only want the published image:

```bash
mkdir archivist
cd archivist
curl -fsSLO https://raw.githubusercontent.com/archivist-lab/archivist/main/docker-compose.release.yml
curl -fsSLo .env.example https://raw.githubusercontent.com/archivist-lab/archivist/main/.env.example
cp .env.example .env
mv docker-compose.release.yml docker-compose.yml
docker compose up -d
```

## Test

```bash
corepack pnpm test        # full backend suite (offline; providers are mocked)
corepack pnpm verify      # build + test
```

## Distribute

Two ways to let others run Archivist:

**From source** — push this repo to GitHub; users clone it, create their `.env`,
and run `docker compose up -d` (the image builds on their machine).

**Prebuilt image** — `.github/workflows/docker.yml` builds a multi-arch
(amd64 + arm64) image on every push to `main` and publishes it to GitHub
Container Registry as `ghcr.io/archivist-lab/archivist`. Tag a release
(`git tag v2.0.0 && git push --tags`) to get version tags. Users then only
need `docker-compose.release.yml` renamed to `docker-compose.yml` plus their
own `.env` — no source, no build tools.

To publish manually instead:

```bash
docker login
docker tag archivist:1 yourusername/archivist:latest
docker push yourusername/archivist:latest
```

Note: the GitHub package is private by default the first time the workflow
publishes it — flip it to public in the package settings on GitHub so others
can pull without authentication.

## Layout

- `apps/server/` — the backend (Express, Zod contracts at the boundary)
- `client/` — React SPA (built output is served by the backend from `client/dist`)
- `packages/contracts|db|core` — shared schemas, unified database, domain services
- `packages/types|bittorrent|torrent-engine|indexer-engine` — torrent stack
