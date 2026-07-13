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

*NB - The current version is an Alpha release and is being actively worked on, however, all features below are working (though not fully optimised/realised yet).  Full discretion, the app design and architecture are human-led but the coding is being passed to AI agents to handle.  Strong recommendation would be to not use this against an existing library unless you have recently backed everything up.*  

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

**Archivist Player** is a dedicated consumption interface on port `4242`.

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

The Player port exposes only the Player API and protected media routes. The administration API remains on port `2424`.

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

## Two interfaces, one container

A single container serves both applications:

| Port | Application | Purpose |
|---:|---|---|
| `2424` | Archivist Admin | Setup, libraries, discovery, acquisition, imports, Channels and settings |
| `4242` | Archivist Player | Browsing, playback, progress, transcoding and channel viewing |

The Player listener exposes only:

```text
/api/v1/player
/media/
```

The internal service token is injected server-side and is not sent to the browser.

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

- **Admin:** http://localhost:2424
- **Player:** http://localhost:4242

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
      - "4242:4242"

    env_file:
      - .env

    environment:
      TZ: ${TZ:-UTC}
      ARCHIVIST_TRANSCODE_CONCURRENCY: ${ARCHIVIST_TRANSCODE_CONCURRENCY:-2}
      ARCHIVIST_LOUDNESS_CONCURRENCY: ${ARCHIVIST_LOUDNESS_CONCURRENCY:-2}
      PLAYER_ORIGINS: ${PLAYER_ORIGINS:-http://localhost:4242,http://127.0.0.1:4242}
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

TORRENT_INCOMPLETE_DIR=/app/downloads/incomplete
TORRENT_DOWNLOAD_DIR=/app/downloads/complete

PLAYER_ORIGINS=http://localhost:4242,http://127.0.0.1:4242
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
corepack pnpm dev
```

Production build:

```bash
corepack pnpm start
```

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
└── player/        Dedicated playback interface

client/            Archivist administration interface

packages/
├── contracts/
├── core/
├── db/
├── bittorrent/
├── torrent-engine/
├── indexer-engine/
└── types/
```

Media-specific server functionality lives under:

```text
apps/server/src/modules/
```

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
