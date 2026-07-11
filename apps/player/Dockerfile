FROM node:20-bookworm-slim AS build

RUN corepack enable
WORKDIR /app

COPY . .
RUN corepack pnpm install --frozen-lockfile --filter archivist-player...
RUN corepack pnpm --filter archivist-player build

FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/player/dist /app/dist
COPY --from=build /app/apps/player/server.mjs /app/server.mjs

RUN chown -R node:node /app
USER node

EXPOSE 4242
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4242/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
