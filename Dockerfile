# ── Build stage ───────────────────────────────────────────────────────────────
# Full bookworm image: includes python3/make/g++ for the native modules
# (better-sqlite3, utp-native) compiled during install.
FROM node:20-bookworm AS build

RUN corepack enable
WORKDIR /app

COPY . .

RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm build

# Drop dev dependencies; the store keeps compiled native side-effects so this
# re-link is cheap and keeps the built .node binaries.
RUN corepack pnpm install --prod --frozen-lockfile --force

# Vendor EmulatorJS (loader + selected WASM cores, ~9 MB) for the in-app retro
# arcade, so emulation is fully self-hosted with no external CDN at runtime.
# Pinned to the CDN 'stable' channel — bump to adopt a new EmulatorJS release.
RUN mkdir -p /app/emulatorjs/cores \
 && EJS=https://cdn.emulatorjs.org/stable/data \
 && for f in loader.js emulator.min.js emulator.min.css version.json; do \
      curl -fsSL "$EJS/$f" -o "/app/emulatorjs/$f"; done \
 && for c in fceumm snes9x gambatte genesis_plus_gx smsplus mupen64plus_next pcsx_rearmed yabause; do \
      curl -fsSL "$EJS/cores/$c-wasm.data" -o "/app/emulatorjs/cores/$c-wasm.data"; done

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app /app

# Indexer definitions ship with the image, outside /app/data so a data volume
# does not mask them.
RUN mv /app/data/indexer-definitions /app/indexer-definitions && rmdir /app/data || true
RUN mkdir -p /app/data /app/media /app/downloads/incomplete /app/downloads/complete && chown -R node:node /app
ENV ARCHIVIST_DEFINITIONS_PATH=/app/indexer-definitions

# Mutable state lives in three places: app data, the media library, and the
# Transmission-style downloads staging area (incomplete/ → complete/).
VOLUME ["/app/data", "/app/media", "/app/downloads"]

EXPOSE 2424

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:2424/ping').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER node
CMD ["node", "apps/server/dist/server.js"]
