---
title: "Archivist"
document_type: product-overview
status: canonical
classified: 2026-08-16
---
# Archivist

<p align="center">
  <strong>Your media library should do more than sit on a hard drive.</strong>
</p>

<p align="center">
  Archivist discovers, acquires, organises, enriches, schedules and plays your personal media collection - from one self-hosted application.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-archivist-does">Features</a> ·
  <a href="#your-own-tv-network">Channels</a> ·
  <a href="#docker-compose">Docker</a> ·
  <a href="#configuration">Configuration</a>
</p>

*NB — Archivist is an alpha under active development. The capabilities below are implemented, but provider credentials, indexer/site behavior, host permissions, codecs, and configuration still determine whether a specific workflow succeeds. The product direction is human-led and implementation is assisted by AI agents. Do not use Archivist against an unbacked existing library.*

## Media automation meets your own television network

Archivist is a self-hosted media automation and playback system for people who want more than a folder browser.

It brings the full lifecycle of a personal media collection into one place:

```text
Discover → Monitor → Acquire → Import → Organise → Programme → Watch
```

Build and maintain libraries of films, television, music, books, comics and games. Monitor future releases. Let indexer feeds detect new content. Import completed downloads. Organise the files. Then open **Archivist Player** and enjoy the collection you built.

And when scrolling through a library feels like work, create your own television channels.

Saturday morning cartoons. Friday night classics. Sunday premieres. A channel for comfort shows, animation, documentaries, horror or whatever else deserves a place in your schedule.

**You own the library. Now run the network.**

> [!IMPORTANT]
> Archivist is under active development. Back up your data before major upgrades and expect interfaces to evolve.

---

## What Archivist does

### One platform for every kind of media

Archivist supports libraries for:

- Films
- Television series and episodes
- Music and albums
- Books
- Comics
- Games

Enable only the media types you use during setup. Unused domains can remain hidden across the application.

### Automatic release monitoring

Archivist watches enabled indexers for newly published releases and evaluates them against the media you monitor.

The release pipeline can:

- poll recent-release feeds automatically;
- enter rapid polling mode around monitored episode air times;
- refresh imminent series metadata;
- parse and identify releases;
- match titles, seasons and episodes;
- apply quality and upgrade rules;
- record accepted and rejected decisions;
- submit approved releases to a download client;
- mark items as acquiring only after the client confirms acceptance.

New content is handled by feed monitoring. Older missing content is handled separately through the configurable **Search Missing** backlog scheduler.

### Controlled backlog recovery

Search Missing is deliberately conservative.

By default Archivist searches for:

```text
1 older missing item per day
```

You can configure:

- whether scheduled backlog searches are enabled;
- a different item limit for every day;
- a different run time for every day;
- the recent-release exclusion window;
- retry cooldowns;
- selection strategy;
- manual runs.

That means your backlog can improve steadily without hammering indexers or competing with new-release monitoring.

### Built-in and external download clients

Archivist can work with:

- its embedded BitTorrent engine;
- Transmission;
- qBittorrent.

The embedded workflow is straightforward:

```text
downloads/incomplete
        ↓
downloads/complete
        ↓
validated import
        ↓
organised library
```

External clients can use shared mounts or `REMOTE_PATH_MAP` when reported paths differ from the paths visible inside Archivist.

### Automatic imports and organisation

After a download completes, Archivist can validate and move it into the correct library structure.

Depending on media type and configuration, Archivist can manage:

- destination folders;
- seasons and episodes;
- file naming;
- metadata records;
- artwork;
- audio and subtitle tracks;
- import state;
- acquisition history.

### A real playback application

**Archivist Player** is a dedicated consumption interface at `/player`.

It includes:

- film and series browsing;
- search and detail pages;
- direct playback;
- compatibility transcoding;
- audio-track selection;
- subtitle selection and extraction;
- synchronised watch progress;
- continue watching;
- full-screen playback;
- automatic next-item playback;
- channel sessions.

The Player is one of three surfaces served from a single port. Separation between them is by authentication, not by network listener — see the surface table below.

### Kodi media add-on

Archivist also includes a Kodi add-on for available films and television. It uses Kodi's native player while synchronising Archivist metadata, artwork, resume positions and watched state, and supports capability-aware playback, editions, preferred tracks, intro/credit segments, revocable device credentials, event-driven library updates and last-known-good offline browsing. Build the installable ZIP with:

```bash
corepack pnpm build:kodi
```

See [`apps/kodi/README.md`](apps/kodi/README.md) for installation and connection settings.

### Loudness normalisation

Archivist can measure and normalise volume across titles.

| Mode | Target |
|---|---:|
| Loud | -14 LUFS |
| Standard | -16 LUFS |
| Quiet | -18 LUFS |
| Reference | -23 LUFS |

Direct playback can apply client-side gain when analysis is available. Transcoded playback can apply normalisation server-side.

### Video optimisation

The published image includes FFmpeg tooling for:

- software transcoding;
- Intel Quick Sync and VAAPI-capable environments;
- AMD VAAPI-capable environments;
- VMAF analysis;
- configurable transcode concurrency;
- configurable loudness-analysis concurrency.

Hardware acceleration still requires the correct host drivers and container device configuration.

---

## Your own TV network

Channels are one of Archivist's defining features.

Instead of choosing a file every time you sit down, programme a slate and tune in.

Create channels around:

- genres;
- franchises;
- collections;
- moods;
- eras;
- weekdays;
- family routines;
- seasonal events;
- personal traditions.

Example schedule:

```text
Saturday 08:00  Saturday Morning Cartoons
Friday   20:00  Friday Night Classics
Sunday   19:30  Premiere Night
Daily    22:00  Comfort Television
October          Horror After Dark
December         Christmas Channel
```

Archivist can generate guide slots from programming blocks, maintain future schedules and launch playback sessions that continue through the slate.

The result sits between an on-demand library and live television:

1. Open the guide.
2. Choose a channel.
3. Select a programme.
4. Start from that point.
5. Let Archivist continue through the schedule.

You are not merely collecting media. You are curating an experience.

---

## Three interfaces, one container

A single container serves all three applications:

Everything is served from one port (`2424` by default), routed by path prefix:

| Path | Application | Purpose |
|---|---|---|
| `/library` | Archivist Library | Setup, libraries, discovery, acquisition, imports, Channels and settings |
| `/player` | Archivist Player | Browsing, playback, progress, transcoding and channel viewing |
| `/catalogue` | Archivist Catalogue | Universal film, TV, book, music and identity ingestion; visual checking; flows and data maintenance |
| `/api/v1` | API | Shared by all three surfaces and by external clients such as Kodi |
| `/media` | Media | Protected artwork and organised media |
| `/` | Chooser | A small page linking to the three applications |

Archivist previously bound three ports (`2424` library, `4242` player, `2428` catalogue), and the player listener could not reach the administration API at all. That was a network-level restriction; on a single port it no longer exists. Every surface shares one origin, and access to the administration API is gated by session or API-key authentication alone. Put Archivist behind a reverse proxy and set `TRUST_PROXY` if you need per-path restrictions.

The internal service token is injected server-side and is not sent to the browser.

Bare-metal installations also get **Archivist Control** on loopback port `2429`. It is a separate failure domain for host telemetry, endpoint health, systemd lifecycle actions, storage pressure, and the Archivist journal, so it can remain reachable when the primary runtime is unhealthy. Control is localhost-only by default, gates mutations behind a dedicated token, and does not receive Archivist's provider secrets. See [`apps/control/README.md`](apps/control/README.md) for the current systemd topology and Docker-parity roadmap.

The bare-metal installer is deliberately plan-only until `--apply` is supplied:

```bash
./deploy/preflight-bare-metal.sh
sudo ./deploy/install-bare-metal.sh
sudo ./deploy/install-bare-metal.sh --apply
```

It creates atomic application releases with persistent external state, locked runtime/control accounts, hardened systemd services, and unit/verb-scoped polkit authorization. Docker bind-mount migration, rollback, and non-destructive uninstall commands are documented in the Control guide.

### Catalogue architecture

The Catalogue is a first-class workspace app in `apps/catalogue`, backed by the reusable catalogue domain package in `packages/catalogue`. It remains part of the same Archivist image and process; the `/catalogue` prefix serves the Catalogue SPA, and its API lives at `/api/v1/catalogue`. Ingestion is IMDb-led: filtered IMDb datasets establish canonical titles, people and credits, then configured OMDb, TVDB and TMDB providers enrich only those accepted IMDb IDs.

The catalogue database uses a universal item layer for films, TV series, seasons, episodes, book works, and music release groups. Type-specific tables extend those records:

- Books distinguish works from editions, publishers, series entries, contents, awards, and contributor credits.
- Music distinguishes artists, band membership, release groups, releases, media, tracks, recordings, compositions, labels, and credits.
- People are canonical across every media domain. Provider IDs and aliases are stored separately, uncertain duplicate matches require review, and confirmed merges retain reversible audit records.
- Organisations represent studios, networks, publishers, labels, developers, and other non-person contributors.

Existing `films.sqlite` catalogues are renamed to `catalogue.sqlite` and migrated in place on first start. A migration validates that every legacy film has a canonical item before committing.

---

## Quick start

### Requirements

For Docker:

- Docker Engine
- Docker Compose
- Writable storage for data, media and downloads
- Metadata-provider credentials for the media domains you enable

For development from source:

- Node.js 20+
- Corepack
- pnpm `9.15.9`

---

## Docker Compose

### 1. Create a directory

```bash
mkdir archivist
cd archivist
```

### 2. Download the deployment files

```bash
curl -fsSLO \
  https://raw.githubusercontent.com/archivist-lab/archivist/main/docker-compose.release.yml

curl -fsSLo .env.example \
  https://raw.githubusercontent.com/archivist-lab/archivist/main/.env.example

mv docker-compose.release.yml docker-compose.yml
cp .env.example .env
```

### 3. Generate the internal service token

```bash
openssl rand -hex 32
```

Add the generated value to `.env`:

```env
ARCHIVIST_API_TOKEN=replace-with-your-generated-token
```

This is an internal service credential. It is not your browser password.

### 4. Create persistent directories

```bash
mkdir -p data media downloads/incomplete downloads/complete
sudo chown -R 1000:1000 data media downloads
```

Archivist runs as an unprivileged user with UID/GID `1000`.

### 5. Start Archivist

```bash
docker compose up -d
```

Open:

- **Library:** http://localhost:2424/library/
- **Player:** http://localhost:2424/player/
- **Catalogue:** http://localhost:2424/catalogue/

http://localhost:2424 serves a chooser linking to all three.

### 6. Complete first-run setup

Use the temporary bootstrap credentials:

```text
Username: archivist
Password: archivist
```

Archivist immediately asks you to create a personal administrator account. The bootstrap credentials are then permanently disabled.

---

## Practical Compose example

```yaml
services:
  archivist:
    image: ghcr.io/archivist-lab/archivist:latest
    container_name: archivist
    restart: unless-stopped

    ports:
      - "2424:2424"

    env_file:
      - .env

    environment:
      TZ: ${TZ:-UTC}
      ARCHIVIST_TRANSCODE_CONCURRENCY: ${ARCHIVIST_TRANSCODE_CONCURRENCY:-2}
      ARCHIVIST_LOUDNESS_CONCURRENCY: ${ARCHIVIST_LOUDNESS_CONCURRENCY:-2}
      ARCHIVIST_CATALOGUE_DB: ${ARCHIVIST_CATALOGUE_DB:-/app/data/catalogue/catalogue.sqlite}
      ARCHIVIST_CATALOGUE_ARTWORK: ${ARCHIVIST_CATALOGUE_ARTWORK:-/app/data/catalogue/artwork}
      TORRENT_INCOMPLETE_DIR: /app/downloads/incomplete
      TORRENT_DOWNLOAD_DIR: /app/downloads/complete

    volumes:
      - ./data:/app/data
      - ./media:/app/media
      - ./downloads:/app/downloads
```

Useful commands:

```bash
docker compose pull
docker compose up -d
docker compose logs -f archivist
docker compose down
```

---

## Persistent storage

| Host path | Container path | Purpose |
|---|---|---|
| `./data` | `/app/data` | Database, settings, state and application data |
| `./media` | `/app/media` | Organised media libraries |
| `./downloads` | `/app/downloads` | Incomplete and completed downloads |

For a NAS or larger disk:

```yaml
volumes:
  - /srv/archivist/data:/app/data
  - /mnt/media:/app/media
  - /mnt/downloads:/app/downloads
```

Your library remains visible on the host rather than being trapped inside a container layer.

---

## Optional incoming BitTorrent ports

The embedded engine can download with outbound connectivity alone. Incoming peer connectivity and seeding may be reduced.

Use the torrent override when you want the dedicated peer ports:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.torrents.yml \
  up -d
```

| Port | Protocol | Purpose |
|---:|---|---|
| `2425` | TCP | BitTorrent peer traffic |
| `2426` | UDP | DHT |
| `2427` | UDP | uTP |

Do not map `2425/udp`; Archivist uses `2427/udp` for uTP.

---

## Transmission or qBittorrent

Disable the embedded engine:

```env
ARCHIVIST_EMBEDDED_TORRENTS=false
```

Archivist must be able to access the completed files reported by the external client.

Use identical shared mounts or configure:

```env
REMOTE_PATH_MAP=/downloads:/app/downloads/complete
```

The first path is reported by the download client. The second is the matching path visible inside Archivist.

---

## Hardware acceleration

### Intel or AMD

Add `/dev/dri`:

```yaml
services:
  archivist:
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - render
```

Use:

```env
ARCHIVIST_FFMPEG_PATH=/usr/bin/ffmpeg
```

Check visibility:

```bash
docker exec -it archivist vainfo
```

### NVIDIA

NVIDIA acceleration requires the NVIDIA Container Toolkit and a compatible container runtime configuration.

A typical Compose addition is:

```yaml
services:
  archivist:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

Exact configuration varies by host.

> [!NOTE]
> Hardware acceleration is optional. Software transcoding performance depends on the host CPU.

---

## Configuration

Copy `.env.example` to `.env` and configure the services you use.

Common settings include:

```env
TZ=UTC

ARCHIVIST_API_TOKEN=
ARCHIVIST_EMBEDDED_TORRENTS=true

ARCHIVIST_TRANSCODE_CONCURRENCY=2
ARCHIVIST_LOUDNESS_CONCURRENCY=2
ARCHIVIST_SKIP_INTRO_ENABLED=false
ARCHIVIST_SEGMENT_CONCURRENCY=1
ARCHIVIST_SEGMENT_SWEEP_MAX=50

TORRENT_INCOMPLETE_DIR=/app/downloads/incomplete
TORRENT_DOWNLOAD_DIR=/app/downloads/complete

# Set when Archivist runs behind a reverse proxy: a hop count (1), a subnet, or 'true'.
TRUST_PROXY=
```

You may also need metadata-provider credentials for enabled library domains.

Do not commit your populated `.env` file.

---

## How acquisition works

### New and recent releases

```text
Indexer feed
    ↓
Unseen release
    ↓
Parse and identify
    ↓
Match monitored media
    ↓
Apply quality rules
    ↓
Submit to download client
```

When a monitored episode approaches its air time, Archivist can temporarily increase polling frequency and refresh the series metadata.

### Older missing media

```text
Scheduled backlog item
    ↓
Targeted indexer search
    ↓
Candidate evaluation
    ↓
Best acceptable result
```

Search Missing defaults to one item per day and can be configured by weekday and time.

### Decision history

Archivist records:

- what was discovered;
- what matched;
- what was rejected;
- why it was rejected;
- what was accepted;
- what was submitted;
- whether a client confirmed the download.

Automation should be inspectable, not mysterious.

---

## Development from source

```bash
git clone https://github.com/archivist-lab/archivist.git
cd archivist

corepack enable
corepack pnpm install
corepack pnpm build
cp .env.example .env
```

Development mode:

```bash
# Terminal 1: HTTP API and all three application listeners
corepack pnpm dev

# Terminal 2: jobs, schedulers, Catalogue flows, media work, and torrents
corepack pnpm dev:worker

# Optional bare-metal control plane (built UI + API on 127.0.0.1:2429)
corepack pnpm build:control
corepack pnpm dev:control
```

Production build:

```bash
corepack pnpm start
```

`pnpm start` runs the built supervisor, which starts separate API and worker
processes. The worker is independently restarted after a failure while the API
remains available. Use `pnpm start:api` or `pnpm start:worker` only when an
external process manager will supervise the two roles.

Validation:

```bash
corepack pnpm test
corepack pnpm verify
```

---

## Repository layout

```text
apps/
├── server/        Backend, schedulers, imports, release pipeline and Player API
├── player/        Dedicated playback interface
├── catalogue/     Catalogue ingestion and data workspace
├── control/       Bare-metal host control plane and operations dashboard
└── kodi/          Kodi media add-on, background progress service and packaging

client/            Archivist administration interface

packages/
├── contracts/
├── core/
├── db/
├── bittorrent/
├── torrent-engine/
├── indexer-engine/
└── types/

docs/              Canonical knowledge base, decisions, history, research and runbooks
```

Media-specific server functionality lives under:

```text
apps/server/src/modules/
```

The documentation source of truth starts at [`docs/README.md`](docs/README.md). Its canonical capability, architecture, data, product, design, and operations pages are reconciled against code; plans and historical specifications are explicitly non-authoritative. Run `corepack pnpm docs:check` to validate metadata, local links, and code-bound documentation invariants.

---

## Security notes

- Replace the bootstrap administrator during setup.
- Generate a strong `ARCHIVIST_API_TOKEN`.
- Do not expose the Admin interface publicly without a properly configured reverse proxy.
- Restrict `PLAYER_ORIGINS` to origins you use.
- Keep `.env` private.
- Back up `data/` before major upgrades.
- Treat indexer URLs, passkeys and download-client credentials as secrets.
- Review mounted paths before using destructive reset or library operations.
- The bare-metal Control File Browser can inspect the host filesystem after token authentication. Uploads, folder creation, moves and recoverable trash are restricted to `/home`, `/mnt`, `/media`, `/srv`, `/tmp`, `/var/tmp` and the persistent Cardigann definitions directory; core OS paths are read-only and configuration, databases, backups and torrent state are inaccessible.

---

## Backups

At minimum, back up:

```text
data/
```

For fuller recovery, also protect:

```text
media/
downloads/
.env
docker-compose.yml
```

---

## Updating

```bash
docker compose pull
docker compose up -d
docker compose logs -f archivist
```

Back up `data/` before major upgrades.

---

## Why Archivist?

There are excellent tools for acquiring media.

There are excellent tools for playing media.

There are excellent tools for creating pseudo-live television channels.

Archivist's ambition is to connect those experiences:

```text
One collection
One automation layer
One player
One personal network
```

Monitor a show, acquire a new episode, import it, organise it, programme it into a channel and watch it from the same system.

No chain of disconnected dashboards. No collection that stops being useful once the files arrive.

**Archivist is for people who enjoy building a library - and want that library to feel alive.**

---

## Project status

Archivist is actively developed and changing quickly.

Before relying on it as the only copy of important media or metadata:

- keep backups;
- test updates;
- review configuration changes;
- report reproducible issues with logs and environment details.

Contributions, testing and thoughtful feedback are welcome.

---

## Responsible use

Archivist is a media-management and playback tool.

Use it only with media, indexers, download sources and services you are legally authorised to access. You are responsible for complying with the laws and terms that apply in your jurisdiction.

---

<p align="center">
  <strong>Collect it. Curate it. Programme it. Press play.</strong>
</p>
