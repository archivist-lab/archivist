---
title: Product performance and correctness review
document_type: assessment
status: historical
classified: 2026-09-05
---

# Product performance and correctness review

Review of the working tree on 2026-09-05, including existing uncommitted changes. This is a code review and verification snapshot, not a production CPU profile. At the time of the original review, application code and live media were not modified. The implementation addendum below records subsequent authorised remediation.

## Assessment

The architecture has useful foundations: separate API and worker processes, SQLite WAL, durable job lanes, route splitting in Admin, cursor-based collection APIs, abortable film requests, Player probe caching, and performance telemetry. However, several ordinary request paths still block the API event loop, background media queues compete without a common resource budget, and optimisation has correctness failures that undermine cancellation and completion reporting.

I would prioritise media safety and job correctness first, then remove blocking API work and whole-library refreshes. These findings do not justify changing databases or introducing more services. They require tightening the existing process, queue, data, and UI boundaries.

Severity: **P1** means address before treating the affected feature as dependable; **P2** means a material scaling, responsiveness, or resilience defect. Source observations below are confirmed by inspection; workload-dependent impact is explicitly conditional. No production latency or CPU percentages were measured.

## Findings

### 1. P1 — Ordinary film details and cold playback probes block the API

Evidence: `apps/server/src/modules/films/routes.ts:256,300`, `shared/media-organizer.ts:1162–1237`, `player/media.ts:175–182`, `tools/video-engine/routes.ts:77–81`, `tools/video-engine/analyzer.ts:131,183` (server paths relative to `apps/server/src`).

Film detail handlers call `getFilmFileInfo` for editions. That helper synchronously launches FFprobe and then FFmpeg for chapters, without a timeout or a metadata cache. Player has a useful path/mtime/size cache, but its cache miss also uses synchronous FFprobe without a timeout. The processing analysis route and conversion enqueue checks have the same problem.

While any subprocess runs, that API process cannot service other JavaScript callbacks. A slow or unavailable media mount can therefore stall unrelated requests, stream handling, and SSE. An `async` route declaration alone would not fix this.

Repair: a shared asynchronous probe service with bounded concurrency, deadlines, cancellation, in-flight deduplication, and persistent metadata keyed by file identity. Fetch chapters in the same probe. Return cached details immediately where appropriate. Verify that a deliberately delayed probe does not delay an unrelated health request.

### 2. P1 — Optimisation cancellation can be acknowledged while work continues

Evidence: `apps/server/src/tools/video-engine/queue.ts:183–190,289–339,389–409` and processing routes calling `enqueue` and `cancelJob` in the API process.

Enqueue stores a job in the API's local `jobs` map. The worker separately loads queued jobs into its map. Cancelling a locally known queued job changes its database status directly; it does not send a control request. The worker ignores already-known jobs during queue reload and selects its next job from memory, without an atomic database claim that checks the current status.

Reproduction condition: pause the worker queue, enqueue through the API, let the worker cache the job, cancel through the same API, then resume. The worker's cached entry remains queued. The same stale API entry can also report cancellation after the worker has started encoding. This can cause unwanted processing and eventual media replacement after cancellation was acknowledged.

Repair: make the worker the sole execution-state owner, send controls through durable commands consistently, and atomically claim only currently queued database rows. Add a two-process regression test for cancellation before claim and during encoding.

### 3. P1 — Optimisation reports success after a failed library path update

Evidence: `apps/server/src/tools/video-engine/queue.ts:480–530`.

After moving the original to quarantine and installing the replacement, `updateDbPath` catches a database error and only logs a warning. Processing then records completion. If the extension changed, the library can still point at the now-missing original path while the UI reports success. Recovery of a recorded replacement does not establish that the library pointer was repaired either.

Repair: persist a recoverable replacement state machine covering original, output, quarantine record, and database pointer. Do not mark complete until the pointer is verified. Exercise failure and restart at each boundary, using synthetic files. Retain the original until recovery is settled.

### 4. P1 — Enabled VMAF quality validation fails open

Evidence: `apps/server/src/tools/video-engine/queue.ts:465–473`, `vmaf.ts:33–55`.

When comparison fails, `computeVmaf` returns null. The queue explicitly records null as a passing check and proceeds to replacement. When the filter is unavailable, the enabled gate is skipped altogether. Thus an enabled minimum-quality setting does not guarantee that quality was measured. The comparison subprocess also has no deadline or cancellation handle exposed to the queue.

Repair: when the gate is enabled, require a finite passing score before replacement. Distinguish unavailable, failed, timed out, and passed. Bound and cancel the comparison process. Test each failure case.

### 5. P1 — Cross-filesystem quarantine copies freeze the shared worker

Evidence: `apps/server/src/tools/video-engine/queue.ts:71–73,238–245,484`, `worker-runtime.ts:14,31–45`.

Quarantine defaults to the data directory, while originals are under media. When these are separate filesystems, `moveFile` falls back to `copyFileSync` followed by unlink. A large film copy blocks the worker event loop for the entire copy. Torrent handling, job heartbeats, cancellation, and other queue scheduling share that process. Worker lease renewal is scheduled every five seconds with a twenty-second TTL; blocked callbacks cannot renew on time. Actual lease takeover requires another contender, but missed heartbeat and control responsiveness do not.

Repair: asynchronous bounded copy, verified temporary destination, durable recovery metadata, and safe finalisation. Prefer same-filesystem quarantine when compatible with retention requirements. Test a slow cross-device copy while monitoring heartbeat age and cancellation latency.

### 6. P1 — Media queues lack a shared CPU budget

Evidence: `apps/server/src/tools/video-engine/execution-config.ts:37–44,58`, `executor.ts:65–103`, `services/media-processor.ts:339`, `player/loudness.ts:119–123`, `player/media.ts:315` onward, `tools/video-engine/vmaf.ts:35`.

Optimisation defaults to one job but allows eight; generic FFmpeg processing defaults to two; loudness independently allows up to two by default; playback starts its own subprocesses. Software optimisation encoders do not set an explicit per-job thread budget. VMAF independently selects up to eight threads. Each subsystem is locally bounded or request-driven, but those limits do not reserve shared capacity for playback. On a small host, simultaneous jobs can consume all available CPU and storage bandwidth.

Repair: coordinate admission and resource budgets across these existing paths, prioritising live playback. Limit software encoder threads using available deployment CPU capacity, validate concurrency settings, and defer background work when capacity is occupied. Measure concurrent playback, imports, scans, and downloads together.

### 7. P1 — Film browsing still waits for and renders the entire collection

Evidence: `client/src/lib/films.api.ts:88–105`, `client/src/modules/films/index.tsx:1667–1699,1859`.

The API requests are correctly paginated into 250-item pages, but `listAllFilms` downloads every page sequentially and returns only after all pages arrive. The screen then maps every result into a card. There is no viewport windowing at this render site. Activity refresh repeats the entire traversal every five seconds, cancelling the preceding load. If a traversal takes longer than the refresh interval, it can repeatedly lose progress and never present a complete fresh result.

A 10,000-film collection requires 40 sequential requests per completed refresh before the caller receives its result. This is request-count arithmetic, not a measured latency claim.

Repair: consume visible pages incrementally, virtualise large grids, retain visible data while refreshing, and update changed records without rebuilding the whole collection. Preserve server-side filtering and deterministic sorting when introducing incremental rendering.

### 8. P2 — Shared live refresh permits overlapping work and event bursts

Evidence: `client/src/lib/useLiveRefresh.ts:11–29,85–114`; direct timers also exist in Settings and Catalogue.

Refresh callbacks are launched without awaiting completion. Timers and SSE events can each start another load, with no single-flight guard or coalescing. Cleanup stops future scheduling but does not itself cancel existing requests. Neither helper suspends work when the document is hidden. Callers such as Films have their own cancellation protection; the generic helper does not guarantee it to other consumers.

Repair: schedule after completion, coalesce event bursts, support cancellation and stale-result rejection, and pause nonessential hidden-tab refreshes. Verify maximum in-flight requests under a slow response and an SSE burst, rather than merely testing the timer interval.

### 9. P2 — Catalogue polling repeatedly aggregates large tables

Evidence: `apps/catalogue/src/App.tsx:471–478`, `apps/server/src/catalogue-routes.ts:36–58`.

Every signed-in Catalogue tab polls overview every five seconds, regardless of which view is visible. Each request recomputes grouped counts across items and three queues, plus row totals and latest-run data. These are synchronous SQLite operations. Existing indexes help access patterns but do not make repeated exact aggregates constant-cost.

Repair: publish or briefly cache an overview snapshot, update counters at controlled intervals, and suspend hidden-tab polling. Test request time and statement cost against a realistically large synthetic catalogue.

### 10. P2 — Player refresh rebuilds every hub widget for download progress

Evidence: `apps/player/src/pages/Home.tsx:31–36`, `apps/server/src/player/hub-service.ts:121–179,420`, `player/routes.ts:259`.

Presence of a downloading widget starts a full hub refresh every five seconds, even if the widget currently has no active downloads. Hub assembly resolves all configured widgets again. Acquisition-card matching performs per-torrent `LOWER(info_hash)` lookups over films and episodes before slicing to the requested display limit. No corresponding expression index was found in the reviewed schema.

Repair: refresh the acquisition widget independently while downloads are active, batch identity lookups, and add an appropriate indexed normalised identity lookup after checking query plans. Reuse unchanged widget data. Verify query count as torrent and library counts increase.

### 11. P2 — Scan snapshots create quadratic cumulative serialisation work

Evidence: `apps/server/src/tools/video-engine/scanner.ts:65–75,98–106,117–154`.

The scanner retains every result in `state.items` and persists the entire growing state every 25 scanned targets. For successful scans, serialisation volume therefore grows approximately quadratically with the number of files: snapshots contain 25, 50, 75, and so on up to N items. The read endpoint returns the full state. Its analysis cache also retains paths without a size limit or eviction. Probes remain synchronous, with an event-loop yield only periodically between successful results.

Repair: store results separately by scan/item, persist small progress summaries, expose paginated result reads, and bound the metadata cache. Verify scan write volume and memory growth on large synthetic libraries.

### 12. P2 — Torrent completion checks repeatedly scan all pieces

Evidence: `packages/torrent-engine/src/swarm.ts:117,447–467`, `packages/torrent-engine/src/piece-manager.ts:770–775`.

Each active swarm runs queue maintenance every 50 ms. Maintenance and peer-interest refresh call `isComplete`, which scans piece status until it finds an incomplete piece. Near completion, with the remaining gap late in the piece array, this repeatedly scans almost the entire array and can repeat for each peer. This is a concrete avoidable hot-loop cost; its percentage of real CPU needs profiling.

Repair: maintain an invariant-backed remaining-piece counter for constant-time completion and invalidate peer interest when relevant piece state changes. Test resets, verification failures, selective downloads, and completion transitions before trusting the counter.

### 13. P2 — Optimisation history and queue polling grow unnecessarily expensive

Evidence: `apps/server/src/tools/video-engine/queue.ts:183–190,250–276,392,586`, `client/src/modules/settings/index.tsx:3293`.

The worker rereads and parses all queued job JSON every second even when entries are already cached. Completed jobs remain in the in-memory map during the process lifetime. History reads parse up to 2,000 jobs and sort them again; queue statistics derive counts from that bounded history. Consequently, sufficiently old queued work outside the history cap can be omitted from counts, and long sessions accumulate unnecessary memory and traversal work.

Repair: query aggregates directly by status, page history independently, retain only active/recent in-memory jobs, and load changed queue rows or atomically select the next candidate instead of rereading the backlog.

### 14. P2 — SSE ignores slow-client backpressure

Evidence: `apps/server/src/system/sse.ts:58–74`.

Broadcast serialises the same event separately for every client and ignores the boolean result of `res.write`. A connected client that consumes data slowly can keep accumulating buffered writes. Catching exceptions does not handle this condition.

Repair: serialise each frame once and enforce bounded buffering, drain handling, or slow-client disconnection with a recoverable refresh path. Test a client that stops reading during a sustained event stream.

### 15. P2 — Processing path containment is lexical, not filesystem-aware

Evidence: `apps/server/src/tools/video-engine/routes.ts:30–38,110–125`.

The helper checks `resolve` plus a path prefix and existence. It does not resolve symlinks or require a regular file. An in-library symlink can resolve outside the allowed tree while passing this check. The item-ID enqueue branch uses its stored path directly. Existing file-metadata containment tests exercise other routes, so they do not establish this route's safety.

Repair: use the established canonical managed-root containment boundary, including realpath and regular-file validation, and revalidate before mutation. Add processing-route tests for symlink escapes and directories. Do not test this against actual user media.

### 16. P2 — Invalid generic encode concurrency can silently stall the queue

Evidence: `apps/server/src/services/media-processor.ts:270–290,339`.

`MAX_CONCURRENT_ENCODES` is parsed directly into the queue without validation. A value such as `0`, a negative number, or a non-number makes the admission comparison false, leaving submitted promises pending indefinitely. Excessively large values are also unbounded at this configuration boundary.

Repair: validate a finite positive integer within a documented bound through the typed configuration layer; fail startup clearly on invalid settings. Test invalid, minimum, and maximum values.

### 17. P2 — Release verification is currently red and guidance is stale

Evidence: root `package.json`, `.github/workflows/verify.yml`, `AGENT.md`, and verification results below.

Lint actually reports 1,903 errors in this checkout. No tracked Biome configuration was found. Documentation drift fails because three documents still describe migration 54 while implementation expects 55. Server typechecking cannot resolve the installed `yaml` module. This dependency is declared, so the observed failure does not establish a manifest defect.

The manual also says local Biome configuration exists and describes older typecheck/test coverage; the observed checkout and current scripts differ. Player has existing timing telemetry, and server performance tracing includes event-loop instrumentation, but the inspected verification workflow does not establish a mixed-workload performance acceptance gate.

Repair: make a clean frozen installation and documented verification command reproducible; reconcile the intended lint configuration without blindly rewriting thousands of source lines; update migration documentation. Extend existing telemetry into reproducible workload tests and release budgets.

## Repair order and acceptance criteria

1. **Make media outcomes trustworthy:** cancellation ownership, replacement recovery, strict quality validation, and canonical path containment. Require isolated two-process and failure-injection tests before enabling automatic replacement with confidence.
2. **Keep request handling responsive:** asynchronous cached probes, asynchronous cross-filesystem copying, and shared admission/thread budgets with playback priority.
3. **Bound work by what the user can see:** incremental virtualised library views, single-flight visibility-aware refresh, independent download widgets, and cached Catalogue summaries.
4. **Make long-running work scale:** normalised scan results, indexed batched acquisition lookup, constant-time torrent completion, bounded history/cache retention, and SSE backpressure.
5. **Enforce repeatable release checks:** restore green verification and add performance acceptance workloads using existing instrumentation.

Suggested initial performance targets, to calibrate against the minimum supported hardware rather than treat as measured results:

- Cached browse/search API p95 below 200 ms; no multi-second API stalls during probes or media copies.
- Visible UI interactions below 100 ms; keyboard/remote focus movement within a frame where feasible.
- Direct-play start p95 below two seconds on local storage, measured separately from software transcoding.
- Background work leaves measured CPU headroom for playback; playback remains uninterrupted during scan/import/torrent activity.
- No overlapping refresh for one resource and no whole-library reload to update a few progress fields.
- Stable memory and bounded queue/control latency during a multi-hour mixed-workload soak.

Run the workload matrix with empty, modest, and large synthetic libraries; cold and warm caches; fast and deliberately slow storage; hidden and visible tabs; multiple viewers; downloads, imports, and optimisation together. Capture route p50/p95/p99, event-loop lag, worker heartbeat age, CPU per process including FFmpeg, memory, SQLite statement counts and query plans, request counts, browser long tasks, and playback startup/stalls. Use realistic fake fixtures rather than exporting the live databases.

## Verification and limits

Executed using installed binaries because `corepack` is absent:

| Check | Result |
| --- | --- |
| Player Vitest unit/component suite | 56 tests passed across 9 files |
| Database schema and statement-counter tests | 24 tests passed |
| Admin TypeScript, no emit | Passed; empty diagnostics log |
| Player TypeScript, no emit | Passed; empty diagnostics log |
| Catalogue TypeScript, no emit | Passed; empty diagnostics log |
| Server TypeScript, no emit | Blocked by TS2307 for `yaml` in `apps/server/src/lists/yaml.ts:9` |
| Repository Biome lint | Failed: 1,903 errors across the checked scope; no fixes applied |
| Documentation drift check | Failed: migration documentation mismatches in AGENT.md, ARCHIVIST_CORE.md, and data-model.md |
| Markdown metadata check | Failed on three pre-existing root files: SERVER_TASK_QUEUE_REVIEW.md, TIER_TEMPLATE.md, archivist-player.md; no diagnostics for this assessment |
| Working-tree whitespace check | Passed after adding this report and its index entry |

The full application verification suite, production builds, browser end-to-end tests, live profiling, and failure-injection reproductions were not run. Passing typechecks and unit tests do not prove performance under load. Existing uncommitted application changes were preserved.

Primary coverage was Admin, Player, Catalogue, API request handling, database access, media optimisation/import helpers, worker scheduling, and torrent request scheduling. Control, Kodi, acquisition/list services, authentication, and deployment received lighter inspection. Authentication uses synchronous scrypt behind a login rate limiter, a lower-priority blocking path worth moving to the asynchronous implementation. Control/Kodi and provider-specific matching need dedicated follow-up coverage before an exhaustive product-wide sign-off. This report does not claim that every possible defect has been found.

## Implementation addendum — 2026-09-05

The review above records the original observations. The following remediation was
subsequently implemented in the working tree at the user's request. Existing
uncommitted product changes were preserved; no live database or media was used as
verification input. This addendum records code delivery and local validation, not
production deployment or a minimum-hardware performance certification.

| Finding | Delivered change | Main evidence |
| --- | --- | --- |
| 1 | Async, deadline-bound FFprobe; two-probe pool with bounded waiting, shared in-flight work, identity-based memory/SQLite caching; chapters in the same probe; async capability detection and scrypt | `apps/server/src/shared/media-probe.ts`, `shared/media-organizer.ts`, `player/media.ts`, `middleware/auth.ts` |
| 2 | Durable API controls, immediate SQLite claims and enqueue deduplication; abortable analysis/encoding/quality work; controls serialized with replacement commit | `apps/server/src/tools/video-engine/queue.ts`, `test/performance-safety.test.ts` |
| 3 | Journalled replacement phases, strict primary/edition pointer updates, durable recovery action, retryable quarantine restore; unresolved work cannot enter retention | `apps/server/src/tools/video-engine/queue.ts`, `services/media-processing-jobs.ts` |
| 4 | Enabled VMAF requires a finite passing measurement; unavailable, failed, timed-out and cancelled results cannot pass; subprocess deadline and cancellation | `apps/server/src/tools/video-engine/vmaf.ts`, `queue.ts` |
| 5 | Async exclusive file moves; cross-device temporary copy, file-identity/size checks and destination flush before source removal | `apps/server/src/shared/verified-move.ts` |
| 6 | Shared SQLite media leases across worker processing and Player; software thread caps; CPU affinity/CFS quota-aware admission; active playback defers new background work | `apps/server/src/shared/media-resources.ts`, `player/loudness.ts`, `services/media-processor.ts` |
| 7 | First film page renders independently, server-side filters/sort, bounded viewport mounting, explicit additional pages and loaded-film selection; visible-ID background refresh | `client/src/modules/films/index.tsx`, `components/VirtualGrid.tsx`, `apps/server/src/modules/films/routes.ts` |
| 8 | Completion-based single-flight scheduling, burst coalescing, visibility pause and AbortSignal support; Settings and Flow Studio timers migrated | `client/src/lib/refresh-loop.ts`, `useLiveRefresh.ts`, `apps/player/test/performance-refresh.test.tsx` |
| 9 | 15-second per-API overview snapshot and visibility-aware Catalogue polling | `apps/server/src/catalogue-routes.ts`, `apps/catalogue/src/App.tsx` |
| 10 | Configured hub download widgets refresh independently, slow down when empty, and preserve other widgets; batched indexed acquisition matching | `apps/player/src/pages/Home.tsx`, `apps/server/src/player/hub-service.ts` |
| 11 | Individual scan-result rows, small progress snapshots, paged reads, bounded analysis cache, retained loaded UI pages | `apps/server/src/tools/video-engine/scanner.ts`, `client/src/modules/settings/index.tsx` |
| 12 | Remaining-needed-piece invariant makes completion checks constant-time across resume and selective-download transitions | `packages/torrent-engine/src/piece-manager.ts` |
| 13 | SQL claims/counts, bounded history reads and active-first page navigation; only executing jobs remain in worker memory between recovery and execution | `apps/server/src/tools/video-engine/queue.ts`, `client/src/modules/settings/index.tsx` |
| 14 | Slow SSE consumers disconnect on backpressure instead of accumulating application writes | `apps/server/src/system/sse.ts` |
| 15 | Canonical realpath containment and regular-file checks at enqueue and execution | `apps/server/src/shared/managed-media.ts` |
| 16 | Typed `workers.encodes`, integer 1–8, including legacy `MAX_CONCURRENT_ENCODES` override; invalid values fail configuration | `apps/server/src/config.ts` |
| 17 | Reproducible lint rule/baseline gate, migration 56 documentation, full verification, explicit CI FFmpeg install, current browser fixtures/references, synthetic latency budget | `biome.json`, `scripts/lint.mjs`, `.github/workflows/verify.yml`, `apps/server/test/performance-workload.ts` |

Validation completed:

- `pnpm verify`: passed documentation checks, lint gate, all configured typechecks
  and builds, database tests, all 64 server suites, Control/Control Agent tests,
  58 Player unit/component tests, and 48 Kodi tests.
- Safety suite: 18 passing tests, including real API/worker process separation
  before claim and during a running encode; original preservation after database
  failures; retryable restore; actual cross-device copy with concurrent timer
  callbacks; probe deadlines/deduplication/health responsiveness; symlink rejection;
  quality-gate failures; SQL query plans; and configuration validation.
- Film endpoint: 10,000 synthetic rows, deterministic ordering, filtering,
  non-overlapping pages and visible-ID reads passed. UI tests cover 10,000 records,
  bounded mounting, slow refreshes, event bursts, hidden tabs and cleanup.
- Chromium: six browser tests passed against the current authenticated UI, including
  remote navigation/playback and visual references at 1080p, 4K and tablet sizes.
  Fixtures previously assumed unauthenticated bootstrap, sidebar navigation,
  the old root hub and obsolete detail labels. References were reviewed and updated
  for the current top navigation/item view; production layouts were not changed to
  satisfy the old images.
- `git diff --check`: passed.

The synthetic workload uses disposable databases with 0, 100 and 10,000 films while
slow subprocesses run alongside browse requests. One five-second sample recorded
153 warm requests, overall p50 **5.1 ms**, p95 **11.0 ms**, p99 **13.4 ms**, event-loop
p99 **14.6 ms**, and peak API RSS **201 MiB**. The 10,000-film case had p95 **11.8 ms**.
These are local results, not before/after production measurements. The executable
budget is warm browse p95 below 200 ms and is separately exercised in CI.

Reproduce with `pnpm test:performance`. For longer disposable runs, set
`ARCHIVIST_PERF_SECONDS` (1–86400), `ARCHIVIST_PERF_API_P95_MS` (default 200), and
optionally `ARCHIVIST_PERF_REPORT` to a JSON output path, then run
`pnpm --filter archivist-server exec tsx test/performance-workload.ts`.

Limits remain explicit: the lint gate accepts 1,187 counted legacy diagnostics and
rejects new ones; `pnpm lint:all` displays the debt. A multi-hour mixed workload with
real downloads, imports, multiple viewers and deployed FFmpeg/GPU/storage still
requires deployment-specific acceptance. The synthetic harness does not measure
playback startup, GPU saturation, child-process aggregate CPU, or real storage
stalls. On one CPU, playback and one already-running background task may coexist;
admission is not an OS CPU limit. Interrupted filesystem states that are ambiguous
remain recoverable/operator-visible rather than being guessed into completion.
