# AGENT.md

Operating manual for AI agents working in this repository. Read this first; it is the
short, actionable layer. `ARCHIVIST_CORE.md` is the deep reference (architecture, domain
model, provider strategy, known gaps) — consult it when a change touches schema,
contracts, safety boundaries, or ownership.

> **Read §7 before running `pnpm verify` or trusting a green lint.** This checkout's Biome
> config is untracked, and CI does not have it.

---

## 1. What this project is

Archivist is a self-hosted media lifecycle system: `Discover → Monitor → Acquire →
Import → Organise → Programme → Watch`. It covers films, series, music, books, comics,
and games, plus pseudo-live Channels, a browser Player, and a Kodi client.

Four things to internalise before writing code:

- **One container, two runtime processes, three ports.** The supervisor starts an API
  process and an independently restartable worker. The API process serves Admin (`2424`),
  Player (`4242`), and Catalogue (`2428`); the worker owns durable job execution,
  Catalogue flows/schedules, automation, media queues, and the embedded torrent session.
- **Two SQLite databases.** Main state in `data/archivist.sqlite`, catalogue in
  `data/catalogue/catalogue.sqlite`. There is no PostgreSQL, no Redis, no external queue,
  no n8n. If a plan implies any of those, the plan is wrong.
- **Alpha software over real user media.** Import, organise, optimise, and Sweep code
  paths move and delete files on a mounted library. Mistakes here are unrecoverable for
  the user.
- **Single-image deployment.** Node 20 base, FFmpeg + Chromaprint installed, runs as
  UID/GID `1000`, mounts `/app/data`, `/app/media`, `/app/downloads`.

---

## 2. Commands

Package manager is **pnpm 9.15.9 via corepack**; Node 20+. All commands run from repo root.

### Setup

```bash
corepack pnpm install          # install workspace deps
corepack pnpm build            # build packages → server → client → player → catalogue → kodi
corepack pnpm bootstrap        # install + build in one step
cp .env.example .env           # provider keys and runtime overrides
```

### Develop

```bash
pnpm dev                       # API only, tsx watch, loads .env
pnpm dev:worker                # worker only; run in a second terminal
pnpm --filter archivist-client dev      # Admin SPA on :5173
pnpm --filter archivist-player dev      # Player SPA on :4242
pnpm --filter archivist-catalogue dev   # Catalogue SPA on :2428
```

`pnpm dev` starts **only** the API watcher. Run `pnpm dev:worker` in another terminal
for jobs, schedulers, media processing, Catalogue flows, and torrents. SPA dev servers
are also separate. When a SPA `dist/` exists, the API serves it directly.

### Verify

```bash
pnpm lint            # biome lint  (apps/server/src, client/src, packages)
pnpm lint:fix
pnpm format          # biome format --write, same scope
pnpm typecheck       # builds packages, then tsc --noEmit for server + client
pnpm test            # packages/db schema tests + server suite (tsx test/run-all.ts)
pnpm test:player     # vitest unit/component
pnpm test:kodi       # python3 unittest, apps/kodi/tests (14 files)
pnpm verify          # lint + typecheck + build + test + test:player + test:kodi
```

CI (`.github/workflows/verify.yml`) runs `pnpm install --frozen-lockfile`, then
`pnpm verify`, then installs Chromium and runs Player Playwright e2e. Admin's `test:e2e`
is **not** in CI. There is no separate Kodi CI step — Kodi tests reach CI only through
`pnpm verify`.

Targeted server suites (faster inner loop):

```bash
pnpm --filter archivist-server test:foundation
pnpm --filter archivist-server test:films      # also: libraries, series, music-books,
pnpm --filter archivist-server test:system     #        comics-games, platform
tsx apps/server/test/lists.test.ts             # any of the 44 test files runs standalone
```

### Ship

```bash
pnpm push "message"            # scripts/push.sh: clean, build, stage allowlist, commit, rebase, push
SKIP_BUILD=1 pnpm push "msg"   # skip rebuild if you already built
```

`push.sh` stages a fixed allowlist and hard-refuses to commit `.env`, SQLite files,
`data/backups|resume|torrents`, `media/`, `downloads/`, `node_modules`, or any `dist/`.
Root Markdown other than `README.md` is **not** in the allowlist — `AGENT.md` and
`ARCHIVIST_CORE.md` must be staged manually with `git add`.

---

## 3. Repository map

| Path | What it is | Notes for agents |
|---|---|---|
| `apps/server/` | Express API, supervisor, isolated worker, providers, acquisition, playback, catalogue runner, media tooling | `supervisor.ts` owns production lifecycle; `server.ts` and `worker.ts` are separate processes. |
| `client/` | **Admin SPA** (React + Vite) | At repo **root**, not `apps/client`. Package name `archivist-client`. |
| `apps/player/` | Player SPA, TV-oriented navigation | Vitest + Playwright. |
| `apps/catalogue/` | Catalogue SPA (Flow Studio, items, people) | No React Router; more local shapes than Admin. |
| `apps/kodi/` | Python Kodi add-on + repo packaging | **Not a pnpm package** — no `package.json`. Built with `python3 apps/kodi/build.py`. |
| `packages/db/` | Main SQLite schema + migration runner | `schema.ts` is implementation truth for main DB. |
| `packages/catalogue/` | Universal catalogue schema + identity ops | Applied after legacy catalogue schema init. |
| `packages/contracts/` | Shared TS types and Zod schemas | Substantial but not universal coverage. |
| `packages/core/` | Config, `createLogger`, indexer + utility code | Contains a `_deprecated/` tree — don't extend it. |
| `packages/design-system/` | Shared UI tokens/components | Small; does not yet unify all three SPAs. |
| `packages/indexer-engine/` | Cardigann-style indexer definition execution | Reads `data/indexer-definitions/`. |
| `packages/bittorrent/`, `torrent-engine/`, `types/` | Embedded torrent stack | `utp-native` is an approved native build dep. |
| `private-packages/archivist-backup/` | Recovery guidance, outside the workspace | Intentionally excluded from the build graph. |
| `data/`, `media/`, `downloads/` | Runtime state and mounted content | Git-ignored except `data/indexer-definitions/`. **Never treat as fixtures.** |

Server internals worth knowing: `modules/<domain>/` (films, series, music, books, comics,
games), plus `system/`, `player/`, `segments/`, `lists/`, `channels/`, `recommendations/`,
`release-pipeline/`, `torrents/`, `indexers/`, `leaving-soon/`, `services/`, `shared/`,
`tools/video-engine/`, `middleware/`.

---

## 4. Conventions

### TypeScript

- Strict, ES2022, `module: NodeNext`. Relative imports **must carry `.js` extensions**.
- Files kebab-case (`media-organizer.ts`); React components PascalCase; domain screens
  often `index.tsx`.
- Types/classes/components PascalCase, functions/variables camelCase, env vars
  `UPPER_SNAKE` (application-level ones prefixed `ARCHIVIST_`; provider keys are not
  consistently prefixed).
- There is **no root `typescript` dependency**. Each package brings its own (server and
  client pin `^5.4.0`). Don't assume a repo-wide `tsc` on PATH.

### Formatting (Biome 1.9.4)

Two-space indent, **single quotes**, **no semicolons**, trailing commas, arrow parens as
needed, 160-char lines. `organizeImports` is off — don't reshuffle imports as a side
effect.

The local `biome.json` turns *off* `noExplicitAny`, `noConsoleLog`, `noArrayIndexKey`,
`noBannedTypes`, `noNonNullAssertion`, and `useTemplate`. They are off for the existing
codebase's sake, not as an invitation — prefer typed values, `createLogger`, and template
literals in new code. See §7 for why a clean `pnpm lint` here does not mean a clean CI.

> **Lint/typecheck coverage gap:** `pnpm lint` targets only `apps/server/src`,
> `client/src`, and `packages`. `pnpm typecheck` covers only server + client. The Player
> and Catalogue SPAs are type-checked solely through their own `build` (`tsc --noEmit &&
> vite build`). If you change those apps, run their build — lint/typecheck will not catch
> you.

### Server / API

- JSON over HTTP under `/api/v1`, kebab-case routes. Media streams via `/media` and
  Player stream routes with HTTP range support. No OpenAPI spec; `v1` is the only version.
- Routes grouped by domain: `modules/<domain>/routes.ts`, plus subsystem route files.
- Prefer `validateBody` / `validateQuery` from `middleware/validate.ts` with schemas from
  `@archivist/contracts` over hand-rolled `typeof` checks. Query schemas need `z.coerce.*`;
  the parsed query is read via `validatedQuery` (`res.locals.query`), not `req.query`.
- Use `createLogger('Context')` from `@archivist/core`. No raw `console.*` in server code.
- Never return secrets or raw internal error text. The global error handler already
  redacts and returns a request ID.
- Auth is single-tier after authentication: API keys, browser sessions (salted scrypt,
  HTTP-only/SameSite=Strict cookies), and revocable Kodi device bearer tokens. There are
  no roles. Don't assume a permission check exists.

### Database

- Plural lowercase snake_case tables; integer `id` in the main schema; domain-qualified
  keys in catalogue (`item_id`, `person_id`).
- Main-schema changes go through numbered, transactional, idempotent migrations. The
  runner and helpers live in `packages/db/src/migrations.ts`; the migration list itself is
  the inline array passed to `runMigrations(db, [...])` in `packages/db/src/schema.ts`
  (currently through version 27). Each entry is `{ version, description, up }`, tracked in
  the `_migrations` table. Append a new version — never renumber or edit an applied one.
  Use `ensureColumn` for additive column work.
- Migrations run automatically at startup via `openUnifiedDb`. There is **no** migration
  CLI and **no** seed command — tests build temporary databases.
- Preserve provider IDs and raw source payloads. Never merge people or organisations on
  name similarity alone.

### Configuration

`apps/server/src/config.ts` is the typed boundary. Precedence: **environment variables >
`config.toml` > defaults**. Provider keys are mirrored into `process.env` because some
ported provider clients read env directly. Add new settings to the Zod schema there and to
`.env.example` / `apps/server/config.example.toml` — don't read `process.env` ad hoc in
new code.

### Frontend

React 18 + Vite 5 + Tailwind. Admin and Player use React Router 6; Catalogue does not.
Admin and Player share `@archivist/contracts` types; Catalogue uses more local shapes.

---

## 5. Safety rules

These are non-negotiable. Several protect a user's irreplaceable media library.

1. **Never modify, move, replace, or delete original media** without explicit
   authorization *and* a design with path containment, validation, rollback/quarantine,
   and an audit trail consistent with existing code (`shared/media-organizer.ts`,
   `shared/library-paths.ts` → `safeDeleteMediaPath`, video-engine quarantine).
2. **Never run destructive database or filesystem commands** without explicit
   authorization and exact target verification. No `rm -rf`, no `DROP`, no bulk `DELETE`
   against `data/`. Note this checkout has a **live populated `data/`** — real
   `archivist.sqlite`, `backups/`, `resume/`, `torrents/`, and catalogue databases.
3. **Never stage, print, or transmit secrets or runtime state** — `.env`, SQLite files,
   `data/backups|resume|torrents`, media, downloads, provider credentials, session or
   device tokens.
   **`data/backups/` contains secrets in this version.** `system/backups.ts:107` calls
   `copyIfExists('.env', backupPath, 'env', files)` unconditionally, so every system
   backup embeds a copy of `.env` — all provider API keys included. There is no
   include-env toggle here. Treat any backup directory or archive as credential material:
   never commit one, attach one, paste its file listing, or move one off the host.
4. **Never invent architecture.** No PostgreSQL, no n8n, no microservices, no external
   broker. `packages/db/src/schema.ts` and the two catalogue schema layers are truth.
   (The `Film Catalogue - *.json` files in the repo root are untracked local exports, not
   part of the application — see §7.)
5. **Preserve legacy API and database behavior** unless a migration and compatibility
   decision are explicitly approved. Older routes intentionally keep legacy response
   shapes.
6. **Keep listener boundaries intact.** Admin, Player, and Catalogue port responsibilities
   don't get rearranged without a reviewed architecture change.
7. **Preserve unrelated working-tree changes.** Never revert, stash, or "clean up" changes
   you didn't make — including the untracked root files listed in §7.
8. **Validate untrusted paths before handing them to FFmpeg/FFprobe.** See
   `apps/server/test/path-containment.test.ts` for the regression this guards.

---

## 6. Working agreements

- **Read before you write.** Inspect the code, schema, tests, and config for the area.
  Filenames are not a reliable guide to conventions here — consistency varies by subsystem
  age.
- **Reuse before you build.** Use existing services and contracts rather than adding a
  parallel implementation. Check `packages/contracts/` before defining a new shape.
- **Small, reviewable changes.** Prefer a focused diff over a sweeping refactor.
- **Test behavioral changes,** including failure and retry paths. Server tests are plain
  `tsx` files registered in `test/run-all.ts`; use `test/helpers.ts` and
  `test/provider-mock.ts` rather than hitting live providers.
- **State what you ran.** If you did not run tests, say so plainly. Never describe
  scaffolding as implemented, and label proposals as proposals.
- **Surface contradictions.** Where this repo is inconsistent (and it is, in known places),
  say so instead of silently picking a side.
- **Update docs when reality changes.** Architecture, contracts, commands, providers, or
  safety boundaries changing means `ARCHIVIST_CORE.md` — and this file, if commands or
  rules move — need the same edit.
- **Git.** Commits are short imperative titles; no enforced convention. Branch from and
  target `main`. Only commit or push when asked.

---

## 7. State of this checkout

This tree has divergences that will mislead you if you assume a clean repo.

### The Biome config is untracked — CI lints with different rules

`biome.json` is **not tracked by git**. It exists only in this working tree. A CI
checkout therefore has no Biome config, and `biome lint` falls back to Biome's default
recommended ruleset.

Measured on this tree, same file scope:

| Config | Result |
|---|---|
| Local `biome.json` (untracked) | 3 warnings, exit 0 — **passes** |
| Biome defaults (what CI gets) | **1564 errors**, non-zero exit — **fails** |

`pnpm verify` runs `pnpm lint` first, so on a clean checkout the Verify workflow fails
before it reaches typecheck, build, or any test. A green local `pnpm lint` proves nothing
about CI until `biome.json` is committed. **Committing `biome.json` is the fix**; it is
also the one change that makes CI meaningful again. Don't "fix" the 1564 by rewriting
source.

### Untracked and deleted files

| File | State | Treat as |
|---|---|---|
| `biome.json` | untracked | Lint config — see above. Should be committed. |
| `ARCHIVIST_CORE.md` | untracked | The architecture reference. Not in `push.sh`'s allowlist. |
| `Film Catalogue - Complete Artwork v2.json`, `… with Artwork.json`, `… Portable.json` | untracked, ~100 KB each | Local workflow exports. Not application inputs. Leave them alone; don't commit them. |
| `TIER_TEMPLATE.md`, `archivist-player.md` | tracked, deleted in working tree | Deletions are staged-pending. Don't resurrect without asking. |
| `docker-compose.release.yml` | modified | Uncommitted local edit. |

---

## 8. Known traps

| Trap | Reality |
|---|---|
| Trusting a green `pnpm lint` | The config that makes it green is untracked. See §7. |
| `client/` vs `apps/client/` | Admin SPA lives at repo root as `client/`. |
| `apps/kodi` in a pnpm command | It has no `package.json`. Use `pnpm build:kodi` / `pnpm test:kodi`. |
| Player/Catalogue type errors slipping through | Not covered by `pnpm lint` or `pnpm typecheck`. Run their `build`. |
| `pnpm dev` "doesn't run tasks" | It starts the API only. Run `pnpm dev:worker` in another terminal. |
| `pnpm dev` "doesn't load the UI" | It starts only the API watcher. Either build the SPAs or run their Vite servers. |
| `pnpm start` | Runs the built supervisor, which starts API and worker children. It does not build. |
| Adding a root `.md` and expecting `pnpm push` to include it | The allowlist only covers `README.md`. `git add` it explicitly. |
| Missing `.js` on a relative import | NodeNext ESM; it will fail at runtime, sometimes only in the built output. |
| Semicolons / double quotes | Biome enforces no semicolons and single quotes. |
| Expecting a root `tsc` | No root `typescript` dep; each package supplies its own. |
| Assuming API routes execute work inline | Mutating task routes enqueue durable work. The worker owns execution; health is degraded when its heartbeat is absent. |
| Treating `data/`, `media/`, `downloads/` as fixtures | That is live runtime state, populated in this checkout. |
| Assuming `data/backups/` is safe to share | Every backup embeds a copy of `.env`. See §5 rule 3. |

---

## 9. Where to look next

| Question | Source of truth |
|---|---|
| Full architecture, domain model, provider strategy, gaps | `ARCHIVIST_CORE.md` |
| Product overview, Docker/self-hosting setup | `README.md` |
| Main database shape | `packages/db/src/schema.ts` (tables + migration list), `migrations.ts` (runner) |
| Catalogue schema and identity ops | `packages/catalogue/src/schema.ts`, `identity.ts` |
| Shared request/response types | `packages/contracts/src/` |
| Runtime configuration surface | `apps/server/src/config.ts`, `.env.example`, `apps/server/config.example.toml` |
| Ports and startup sequence | `apps/server/src/supervisor.ts`, `server.ts`, `worker-runtime.ts`, `app.ts` |
| Lint/format rules | `biome.json` (untracked — see §7) |
| CI expectations | `.github/workflows/verify.yml`, `docker.yml` |
| Publish behavior and safety net | `scripts/push.sh` |
