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

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app /app

# Indexer definitions ship with the image, outside /app/data so a data volume
# does not mask them.
RUN mv /app/data/indexer-definitions /app/indexer-definitions && rmdir /app/data || true
ENV ARCHIVIST_DEFINITIONS_PATH=/app/indexer-definitions

# Mutable state lives in exactly two places
VOLUME ["/app/data", "/app/media"]

EXPOSE 2424

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:2424/ping').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/server/dist/server.js"]
