---
title: "Archivist — Codebase Review & Improvement Plan"
document_type: plan
status: historical
classified: 2026-08-16
---
# Archivist — Codebase Review & Improvement Plan

Review date: 2026-07-26 · App version at review: **v0.0.03 · alpha**

Scope surveyed: ~82k lines — server (33.8k / 125 files), client (21.5k / 55 files),
packages (15.3k / 66 files), player (5.7k / 47 files), Kodi (3.2k / 34 files).

---

## 0. What is already well done

These were each verified against the source, not assumed:

- **Async error discipline.** Of 110 async route handlers, **109 have `try`/`catch`**.
  Only `apps/server/src/player/routes.ts:895` is unguarded. On Express 4.18 — which does
  *not* auto-catch async rejections — this is a genuine achievement.
- **SQL injection surface is clean.** 41 template-literal SQL sites all interpolate
  *whitelisted ternaries* (sort fields, table names) or `Math.trunc()`'d numbers; values
  are properly bound as parameters.
- **SQLite configured correctly** — WAL, `synchronous=NORMAL`, `foreign_keys=ON`,
  `busy_timeout=5000` (`packages/db/src/client.ts`).
- **77 indices across 80 tables** — indexed deliberately.
- **Consistent module shape** — every media type is `routes.ts` / `serialize.ts` / `<provider>.ts`.
- **Secrets hygiene** — `.env` gitignored, no tracked databases or keys.
- **Docker** — multi-stage, `NODE_ENV=production`, and non-root `USER node`.
- **`app.ts` is disciplined** — security headers, CORS allowlist (no `*`), tiered rate
  limits (login 10/15m, writes 60/m, search 30/m), clean shutdown.
- `strict: true` across all tsconfigs; 35 test files with real e2e coverage.

The findings below are about scaling and endurance, not rescue.

---

## P1 — Highest impact

### 1. The SSE bus is built but never consumed  ⚠️ biggest win

The server has `system/sse.ts`, a live `GET /api/v1/events` endpoint, and `getSseBus()`.
The client has **zero** `EventSource` usage. Instead there are 10+ polling intervals:

| Location | Interval |
|---|---|
| `settings/ProcessingMonitorTab.tsx` | **1.5s** |
| `series/index.tsx` (active torrents) | 3s |
| `home/DownloadMonitor.tsx`, `music`, `comics`, `series`, `settings/ImportFilesTab` | 5s |
| `lib/useProcessingActivity.ts` | configurable |

Each tick is a round-trip → SQL query → serialize → React re-render, per open tab,
forever. On a Pi/NAS this is most of the idle CPU cost. Several poll the same data.

**Fix:** connect the client to the existing SSE bus; push invalidations instead of
polling. Keep a slow poll only as a reconnect fallback. Infrastructure already exists —
best effort-to-payoff change in the repo.

### 2. No process-level crash guards

`server.ts` handles `SIGTERM`/`SIGINT` but there is **no `unhandledRejection` and no
`uncaughtException` handler**, and **no global 4-arg Express error middleware** (the only
one is scoped to player JSON-parse errors).

Under Node 20 an unhandled rejection **terminates the process**. For an always-on
self-hosted service that is a hard outage until Docker restarts it.

**Fix:** add both process handlers (log + graceful drain) and a terminal Express error
middleware returning the standard error envelope rather than Express's default HTML.

### 3. 830 KB single bundle, zero code splitting

`dist/assets/index-*.js` is **830 KB** (~200 KB gzipped) with **no `React.lazy` /
`Suspense` anywhere**. Settings (3,214 lines), Arcade, TorrentsPage and all six media
modules load before first paint.

**Fix:** route-level `React.lazy`. Arcade and Settings alone are a large slice. Matters
most on mobile.

---

## P2 — Structural

### 4. God files

| File | Lines |
|---|---|
| `client/src/modules/settings/index.tsx` | **3,214** (23 `useEffect`s) |
| `client/src/modules/films/index.tsx` | 2,410 |
| `client/src/modules/series/index.tsx` | 1,787 |
| `apps/server/src/modules/series/routes.ts` | 1,702 |
| `client/src/lib/shared.api.ts` | 923 (40 KB) |

Settings already proves the fix — `ImportListsTab`, `ProcessingMonitorTab`,
`RecommendationsSystemTab` are extracted. **Finish the pattern**: one file per tab. Same
for films/series (detail page, library grid, add page are separable).

### 5. 769 `any` casts undermining `strict: true`

619 server / 150 client, clustered at the DB boundary — nearly every `.all()` is
`as any[]`. Paying for strict mode and opting out where data shape matters most.

### 6. No data access layer — 895 raw `.prepare()` calls across 60 files

`modules/series/routes.ts` alone has 79. A column rename is grep-and-pray; there is no
seam for caching or query logging. Statements are also re-prepared per call rather than
hoisted (better-sqlite3 rewards module-level caching).

**Fix (incremental):** thin per-entity repositories (`films.repo.ts`, `series.repo.ts`)
returning typed rows. Resolves #5 and #6 together. One entity at a time — never big-bang.

### 7. ~~Dead validation infrastructure~~ — **CORRECTION: this finding was wrong**

The original review claimed `validateBody()` was never imported. **That was a research
error** — the grep behind it was truncated and misread. `validateBody` is in fact used at
**31 call sites** across films, series, music, books, comics, games and shared routes,
with `domains.*` schemas from `@archivist/contracts`. The validation layer is
well-adopted, not dead.

The *real* gap was narrower: there was no equivalent for **query parameters**, which is
where most of the 52 hand-rolled `typeof` checks actually live (`validateBody` cannot
help there). Addressed by adding `validateQuery`/`validatedQuery`.

### 8. Copy-paste helpers

- `fmtBytes` defined **4×** (`films`, `torrents`, `settings` ×2) — while `formatSize`
  already exists in `lib/api.ts`
- `CertificationBadge`, `CountryFlag` duplicated across films/series
- ~~`TypeModal` duplicated across music/books~~ — **not actually duplicated**. They share
  a name only: Music renders a fixed list of release types; Books asynchronously fetches
  an author's series list. Different props, state and data source. Merging them would be
  forced abstraction, so they were left alone.

The genuinely shared ones belong in `components/ui.tsx` / a formatting module.

---

## P3 — Tooling & hygiene

### 9. No linter or formatter at all

No ESLint / Prettier / Biome config anywhere. Biggest process gap for an 82k-line
codebase. **Recommendation: Biome** — single binary, format + lint, minimal config, fast.
Mechanically catches unused vars, floating promises, `any` drift.

### 10. Client is untested and unverified in CI

21.5k lines of React with **zero tests**, and `pnpm typecheck` only covers the *server* —
the client `tsc --noEmit` is not in `verify`.

**Fix:** add client typecheck to `verify`; then unit-test the pure logic most likely to
regress — `lib/nlSearch.ts` (three parser bugs already fixed) and `lib/librarySearch.ts`.

### 11. Dependency vulnerabilities

`pnpm audit`: **71 findings — 2 critical, 29 high, 29 moderate, 11 low**.

Both criticals (`simple-git`, `vitest`) are **dev-only**, not shipped. Runtime-relevant:
`react-router` 6.30.3 (moderate; SSR-hydration — no SSR here, so low real risk). Worth
bumping `express` 4.18.0 → 4.21.x and `axios` 1.6.0 → 1.7.x.

**Fix:** run `pnpm audit --prod` to separate shipped risk from toolchain noise; patch the
prod set first.

### 12. Missing SQLite performance pragmas

Correctness pragmas are present; add the speed ones in `packages/db/src/client.ts`:
`cache_size = -64000` (64 MB), `temp_store = MEMORY`, `mmap_size = 268435456`.

### 13. No request cancellation

`lib/api.ts` `request()` has no `AbortController`. The `tabGeneration` counter is a manual
workaround for stale responses that `AbortSignal` solves natively, and would also stop
in-flight scans landing after navigation.

---

## Execution order

1. **Wire up SSE** — kills the polling tax; infrastructure already exists
2. **Crash guards + global error middleware** — prevents hard outages
3. **Biome + client typecheck in `verify`** — stops further drift
4. **Route-level code splitting** — mobile payoff
5. **`pnpm audit --prod` + patch runtime deps**
6. **Incrementally:** repositories per entity (kills #5 + #6); split god files as touched

Items 1–5 are each a focused session. Item 6 is the long game — opportunistic, never a
big-bang rewrite.

---

## Meta-observation

The **server is noticeably more disciplined than the client**. The server has consistent
module shape, thorough error handling, and tests; the client has 3,000-line files, no
tests, and duplicated helpers. That asymmetry is the clearest signal of where to invest.

---

## Progress log

All of the following landed in **v0.0.04** and were verified with
`pnpm typecheck` (server + client), `pnpm --filter archivist-server test`
(**289 passing, 0 failing**), `pnpm test:db` (13 passing) and `vite build`.

| # | Item | Status |
|---|---|---|
| 1 | SSE wiring (replace polling) | ✅ done |
| 2 | Crash guards + global error middleware | ✅ done |
| 3 | Biome lint + client typecheck in `verify` | ✅ done |
| 4 | Route-level code splitting | ✅ done |
| 5 | Dependency audit + prod patches | ✅ done |
| 12 | SQLite performance pragmas | ✅ done |
| 6 | Repositories per entity | ✅ foundation + films/series — v0.0.05 |
| 7 | Validation (see correction above) | ✅ done — v0.0.05 |
| 8 | De-duplicate helpers | ✅ done — v0.0.05 |
| 13 | AbortController in `request()` | ✅ done — v0.0.06 |

### v0.0.06 — item 13 (request cancellation)

`signal` already flowed through `request()` via `RequestInit`, so the missing pieces
were a lifecycle-aware way to produce one and consistent handling of the resulting
rejection.

- **`lib/useAbortable.ts`** — `useAbortController()` returns a function that aborts the
  previous request and yields a fresh signal, and cancels anything outstanding on
  unmount. Used at **17 call sites**.
- **`lib/api.ts`** — added `isAbortError()`. Every abortable `catch` now ignores it, so
  navigating away cannot flash a spurious error.
- **API layers** — `signal` threaded through films, series, music, books, comics, games,
  and the two processing endpoints.
- **Converted** — all six library grids (the tab-switch race), the series detail page,
  `useProcessingActivity`, and `ProcessingMonitorTab`. The series detail torrent poller
  previously fired three requests per tick and guarded them with a `cancelled` boolean;
  it now actually cancels them.
- **Removed the dead `tabGeneration` counter.** It was built to detect stale responses
  after a tab switch but **no component ever read it** — the guard was never wired up.
  Cancellation supersedes it: the response never arrives, so there is nothing to detect.

Note: a `useAbortableEffect` helper was written and then deleted before shipping — it
ended up unused (`useAbortController` covered every case) and its re-throw-inside-catch
would have produced unhandled rejections. Shipping it would have recreated exactly the
dead-infrastructure problem this document complains about in item 7.

### v0.0.05 — items 6, 7, 8

**8 — De-duplication.** New `client/src/lib/format.ts` holds the byte/rate/duration
family. The four `fmtBytes` copies were **not identical** — films/torrents use decimal
(SI) units, Settings uses binary (1024), and the two Settings copies round and render
zero differently. Rather than silently changing numbers already on screen, each
behaviour is preserved as a distinct named export (`formatBytes`, `formatBytesBinary`,
`formatBytesFixed`), with the differences documented. `formatSpeed` takes the idle
placeholder as a parameter because films used `'--'` and torrents `'—'`. Call sites keep
their local names via import aliases, so no call site changed.
`CertificationBadge` / `CountryFlag` / `LanguageFlag` moved to `components/ui.tsx`; the
film and TV certification maps merged safely because their overlapping keys
(G, PG, PG-13, R) already carried identical styles.

**7 — Validation.** Added `validateQuery` + `validatedQuery` to
`middleware/validate.ts` (the real gap), improved the error envelope to name the failing
location, and added `RecommendationSettingsPatch` / `RecommendationFeedbackRequest`
schemas to `@archivist/contracts`. The recommendation routes now use them, replacing ~14
lines of hand-rolled checks with two middleware calls, and the variety/history unions
moved to contracts so client, server and validator cannot drift.

**6 — Repositories.** New `shared/repository.ts` provides `stmt()` — a prepared-statement
cache keyed per connection in a `WeakMap`, so statements are prepared once and reused for
the life of the connection (and dropped with it, which keeps `resetDbForTests` working) —
plus `placeholders()`/`chunked()` for IN clauses. On top of it,
`modules/films/repo.ts` and `modules/series/repo.ts` provide typed rows and the
repeated lookups.

The headline win is **eliminating eight N+1 query loops**. Both `/lookup`,
`/discover-by-field`, `/discover-compound` and `/discover` (films *and* series) ran
`db.prepare(...).get(...)` **once per TMDB result** — up to 50–100 prepare+execute cycles
per request — to decide `alreadyAdded`. These are now a single batched
`ownedTmdbIds()` / `ownedProviderIds()` query.

Typing the rows also surfaced two latent issues that `as any` had been hiding:
`current_release_title` was missing from the film row shape, and — more interestingly —
`target_tier`/`minimum_tier` are **TEXT** labels in the schema while
`current_tier`/`download_tier` are **INTEGER** scores. That asymmetry is real and is now
documented in both repos.

Scope note: this is the foundation plus the two heaviest entities, per the "one entity at
a time, never big-bang" plan. Music/books/comics/games still use inline SQL.

### What changed, concretely

**1 — SSE.** New `client/src/lib/sse.ts` (one shared `EventSource`, backoff reconnect,
subscribe-by-event) and `client/src/lib/useLiveRefresh.ts` (hook + imperative
`subscribeActivity`). New server `system/activity-monitor.ts` broadcasts
`activity:state` (probing only while SSE clients are connected). Converted pollers:
`ProcessingMonitorTab` (1.5s → active-only, 30s idle), `DownloadMonitor` (5s → 60s idle),
`useProcessingActivity` (1.5s → 45s idle), series detail (5s + a 3-request 3s loop),
series/music/comics library grids. Idle request volume drops by roughly an order of
magnitude; the offline fallback preserves old behaviour if the stream drops.

**2 — Resilience.** `unhandledRejection` now logs and keeps serving;
`uncaughtException` drains and exits 1 for Docker to restart. Shutdown is idempotent.
Added a terminal 4-arg Express error handler that logs with the request id and never
leaks a stack.

**3 — Tooling.** Biome 1.9.4 + `biome.json` tuned to house style (single quotes, no
semicolons, width 160) with a focused rule set. **0 errors, 86 warnings**; 25 files
auto-fixed. The two `noDoubleEquals` hits in the Cardigann executor are *intentional*
(Jackett type-coercion semantics) and are suppressed with an explanatory
`biome-ignore`. `verify` now runs `lint` → `typecheck` (server **and** client) → build →
tests.

**4 — Code splitting.** Entry bundle **830 KB → 300 KB** (200 KB → 88 KB gzipped, −56%);
every section plus the Arcade now loads on demand behind `Suspense`.

**5 — Dependencies.** axios 1.6.0 → 1.16.0 (multiple SSRF/DoS/prototype-pollution highs —
material here because Archivist makes outbound requests to TMDB and indexers),
express 4.18.0 → 4.21.2 (body-parser + path-to-regexp), simple-git 3.22.0 → 3.36.0.
Prod vulnerabilities **62 → 32**, high **26 → 9**, critical **1 → 0**. The axios bump
tightened header typing and surfaced a real latent bug in
`shared/media-organizer.ts` (`res.headers['content-type']` is not necessarily a string) —
now normalised. Remaining findings are deep transitives awaiting upstream.

**12 — SQLite.** Added `cache_size = -64000` (64 MB), `temp_store = MEMORY`, and a
guarded `mmap_size = 256 MB` alongside the existing durability pragmas.

---

## v0.0.07 — post-implementation audit follow-ups

A full re-audit after the bulk of the work landed. Baseline at that point was already
healthy: lint clean, 298 server tests passing, 30 player tests passing, client building.
Three issues were found and fixed.

### A. `verify` failed on a clean checkout — ordering bug (regression from v0.0.04)

`typecheck` ran **before** `build`, but the server and client typecheck against the
workspace packages' emitted `dist/*.d.ts`. On a fresh clone — or any time
`packages/*/src` changed — this produced ~23 phantom errors
(`Cannot find module '@torrentstack/indexer-engine'`) that had nothing to do with the
code. Reproduced deliberately by deleting `packages/indexer-engine/dist`: 23 errors
before, 0 after.

**Fix:** `typecheck` now runs `build:packages` first; `typecheck:only` is available for
the fast inner-loop case where packages are known current.

### B. Dependency vulnerabilities

Direct, in-major bumps only — no majors, since Express 5 is a breaking rewrite that a
self-hosted app does not need for a ReDoS fix:

| Package | From | To |
|---|---|---|
| axios | 1.16.0 | 1.18.1 |
| express | 4.21.2 | 4.22.2 |
| systeminformation | ^5.31.5 | 5.33.1 |
| js-yaml | 4.1.1 | 4.3.0 (stayed on 4.x; latest is 5.2.2) |

Prod vulnerabilities **32 → 14**, high **9 → 5**. Remaining are deep transitives
awaiting upstream. The one *critical* is `vitest` — dev-only, never shipped.

### C. Polling loops missed by the v0.0.04 SSE pass

Nine flat `setInterval` polls remained. Converted to `subscribeActivity`:
`TorrentsPage` (list + detail, 3s each), the film detail page (5s refresh, 3s torrent
detail, 3s active torrent), the games grids (5s ×3) and the books grid (5s).

**Deliberately left alone** — converting these would be wrong, not merely unnecessary:

- `settings/index.tsx:2410` — already gated on `scan?.status === 'scanning' || jobs.some(...)`,
  so its 1s cadence only runs while work is genuinely in flight.
- `settings/index.tsx:2315` — a live CPU/memory graph. System stats change independently
  of job activity, so activity-gating would freeze the display.
- `Dashboard.tsx:333` (30s) and `settings/index.tsx:341` (15s) — already cheap.
- `ImportFilesTab.tsx:46` — already conditional on `status?.running`.

Verified: lint 0 errors · typecheck 0 errors · server 298 passed · db 13 passed ·
player 30 passed · client build OK.
