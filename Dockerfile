# ── Build stage ───────────────────────────────────────────────────────────────
# Full bookworm image: includes python3/make/g++ for the native modules
# (better-sqlite3, utp-native) compiled during install.
FROM node:20-bookworm AS build

RUN corepack enable
WORKDIR /app

COPY . .

RUN corepack pnpm install --frozen-lockfile
# The Docker profile: Library and Player. Control is the bare-metal operations
# surface — it manages systemd units this image has no access to — and the
# Catalogue SPA is bare-metal only, so neither is built here.
RUN corepack pnpm build:docker

# Drop dev dependencies; the store keeps compiled native side-effects so this
# re-link is cheap and keeps the built .node binaries.
RUN corepack pnpm install --prod --frozen-lockfile --force

# Vendor EmulatorJS (loader + selected standard and legacy WASM cores) for the
# retro arcade, so emulation is fully self-hosted with no external CDN at
# runtime. EmulatorJS uses the legacy core unless WebGL2 is explicitly enabled,
# so both variants are required even in modern browsers.
# Served at /emulatorjs/ by apps/server/src/gateway.ts and referenced only by the
# Player's arcade shell (/player/emu.html); the Express API exposes no arcade surface.
RUN mkdir -p /app/emulatorjs/cores/reports /app/emulatorjs/compression /app/emulatorjs/localization \
 && EJS=https://cdn.emulatorjs.org/stable/data \
 && for f in loader.js emulator.min.js emulator.min.css version.json; do \
      curl -fsSL "$EJS/$f" -o "/app/emulatorjs/$f"; done \
 && for f in extract7z.js extractzip.js libunrar.js libunrar.wasm; do \
      curl -fsSL "$EJS/compression/$f" -o "/app/emulatorjs/compression/$f"; done \
 && curl -fsSL "$EJS/localization/en-US.json" \
      -o "/app/emulatorjs/localization/en-US.json" \
 && for c in fceumm snes9x gambatte genesis_plus_gx smsplus mupen64plus_next pcsx_rearmed yabause; do \
      curl -fsSL "$EJS/cores/$c-wasm.data" -o "/app/emulatorjs/cores/$c-wasm.data"; \
      curl -fsSL "$EJS/cores/$c-legacy-wasm.data" -o "/app/emulatorjs/cores/$c-legacy-wasm.data"; \
      curl -fsSL "$EJS/cores/reports/$c.json" -o "/app/emulatorjs/cores/reports/$c.json"; \
    done

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# System ffmpeg built with VAAPI/QSV + VMAF, plus VA drivers. The Video
# Optimisation Engine prefers this HW-capable binary over the bundled
# software-only ffmpeg-static. Pass a GPU with `/dev/dri` (and `group_add:
# [render]`) to actually use QSV/VAAPI; NVENC needs the nvidia runtime.
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; \
    else \
      sed -i 's/ main$/ main contrib non-free non-free-firmware/' /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ffmpeg libchromaprint-tools mesa-va-drivers vainfo; \
    arch="$(dpkg --print-architecture)"; \
    if [ "$arch" = "amd64" ]; then \
      apt-get install -y --no-install-recommends intel-media-va-driver-non-free i965-va-driver; \
    fi; \
    fpcalc -version; \
    rm -rf /var/lib/apt/lists/*
ENV ARCHIVIST_FFMPEG_PATH=/usr/bin/ffmpeg
ENV ARCHIVIST_FFPROBE_PATH=/usr/bin/ffprobe
ENV ARCHIVIST_FPCALC_PATH=/usr/bin/fpcalc

COPY --from=build /app /app

# Indexer definitions ship with the image, outside /app/data so a data volume
# does not mask them.
RUN mv /app/data/indexer-definitions /app/indexer-definitions && rmdir /app/data || true
RUN mkdir -p /app/data /app/media /app/downloads/incomplete /app/downloads/complete && chown -R node:node /app
ENV ARCHIVIST_DEFINITIONS_PATH=/app/indexer-definitions

# Mutable state lives in three places: app data, the media library, and the
# Transmission-style downloads staging area (incomplete/ → complete/).
VOLUME ["/app/data", "/app/media", "/app/downloads"]

# The Catalogue SPA is not in the Docker profile, so its prefix stays
# unmounted rather than serving a 503 behind a card on the chooser. Its API and
# ingestion still run: only the browsing UI is absent.
ENV ARCHIVIST_CATALOGUE_ENABLED=false

# One port serves everything in this profile: /library (administration UI),
# /player, /api/v1.
EXPOSE 2424

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:2424/api/v1/health').then(async r => process.exit(r.ok && (await r.json()).status === 'ok' ? 0 : 1)).catch(() => process.exit(1))"

USER node
CMD ["node", "apps/server/dist/supervisor.js"]
