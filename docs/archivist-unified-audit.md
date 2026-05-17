# Archivist V2: Unified Audit Across All `*-audit` Documents

> **Architect's Foreword:**
> The corpus now totals ~11,000 lines across `ARCHITECTURE.md`, `archivist-audit.md`, `radarr-audit.md`, `sonarr-audit.md`, `prowlarr-audit.md`, and `transmission-audit.md`. Each document was written in isolation and is internally coherent. **Together** they form a build spec — but together they also have cross-document inconsistencies, gaps in operational/quality concerns, and ambiguities that a re-implementer will hit. This document is the unified pass: diagnose the gaps, prescribe the fixes, and lock down the decisions that need to be lock-able before construction begins.
>
> **What this doc is NOT:** a summary or table of contents. It only contains content that is missing, conflicting, or under-specified across the corpus. If a topic is well-covered by an existing doc, this audit refers to it and moves on.
>
> **Read this last** — but read it in full before writing the first line of V2 code.

---

## Part I: Cross-Document Audit

---

## 1. Document Precedence Rules (LOCK)

When two audit docs disagree, follow this order. Higher number wins:

| Doc | Authority Over |
|---|---|
| ~~`ARCHITECTURE.md`~~ | **DEPRECATED.** All content folded into `archivist-audit.md`. The file may be deleted. |
| 1. `radarr-audit.md` | Film domain behaviour + Custom Formats engine. |
| 2. `sonarr-audit.md` | TV domain behaviour + 4-level data model + parser dispatch. |
| 3. `lidarr-audit.md` | Music domain behaviour + multi-source metadata + per-entity refresh patterns. |
| 4. `readarr-audit.md` | Books + audiobooks unified domain + multi-role creator credits + DRM detection. |
| 5. `kapowarr-audit.md` | Comics domain (western + manga + webtoons) + hybrid direct-download/torrent acquisition. |
| 6. `gamearr-audit.md` | Games + General Software domain; multi-platform handling + store wishlists. |
| 7. `prowlarr-audit.md` | Cardigann YAML execution + indexer protocols. |
| 8. `transmission-audit.md` | Embedded torrent engine wire protocol + state machine. |
| 9. **`archivist-audit.md`** | **Wins for any V2 cross-cutting build decision** (stack, FSM, departments). Subsumes the strategic blueprint formerly in `ARCHITECTURE.md`. |
| 10. **`unified-audit.md`** (this document) | **Wins over `archivist-audit.md` where they conflict** — this is the latest pass; later decisions supersede earlier ones. |

**Domain-specific authority:** for any media-domain decision (a films question, a music question, a comics question, etc.), the corresponding domain-specific audit (radarr/sonarr/lidarr/readarr/kapowarr) wins for that domain. Cross-cutting concerns (stack, FSM, departments, error model, deployment) defer to `archivist-audit.md` and `unified-audit.md`.

When a re-implementer encounters a conflict not resolved by the above, the rule is: **what is most consistent with `archivist-audit.md` §1's four core tenets** (Modular Monolith, Museum DDD, Interface-Driven Logistics, Type Safety & Determinism) wins.

---

## 2. Cross-Document Inconsistencies (DIAGNOSE)

| # | Topic | Conflict | Resolution |
|---|---|---|---|
| C1 | Episode model | `archivist-audit.md` §15 introduces 4-level (`Series → Seasons → Episodes → EpisodeFiles`) but V1 codebase has only 3. The original ARCHITECTURE.md was silent on `EpisodeFile`. | **4-level wins.** Mandatory per `sonarr-audit.md` §9.4. Multi-episode files (`E01-E02.mkv`) cannot be modelled without it. |
| C2 | Library identity | V1 uses per-tab SQLite DBs (`films-4k.db`); `archivist-audit.md` §1.2 mandates unified `archivist.sqlite` with `library_id`; the term "tab" still appears in V1 frontend code. | **Unified DB wins.** UI term: rename "Tab" → "Library" in all UX copy. Internal type: `library`, not `tab`. |
| C3 | `tab-context` middleware | V1 uses the `x-tab-context` HTTP header to scope per-DB. `archivist-audit.md` §16.2 rejects this in favour of `?libraryId=` query param. | **Query param wins.** Removes header-vs-query-param duality. |
| C4 | Cardigann template engine | V1 uses Nunjucks (`packages/indexer-engine/src/cardigann/executor.ts`). `prowlarr-audit.md` §29.5 prescribes hand-rolled. | **Hand-rolled wins.** Nunjucks's whitespace + `{{ }}` semantics drift from Go templates and silently break ~5% of community definitions. |
| C5 | Custom Format spec types | `radarr-audit.md` §17.2 lists 9 types; `sonarr-audit.md` §15 adds 4 TV-specific types; `archivist-audit.md` references both but doesn't enumerate the canonical merged list. | **Canonical list locked in §3 below.** |
| C6 | Quality Tier vs Custom Format priority | V1 uses Quality Tier as primary scoring; `archivist-audit.md` §9.5 says tier is a "hard tiebreaker" over Custom Formats. Reading §9.5 carefully — it's actually saying tier is *primary* and Custom Format scores break ties within a tier. | **Locked: tier dominates, Custom Format scores break ties within a tier, seeders break Custom Format ties, indexer priority breaks seeder ties.** Re-stated in §4 below. |
| C7 | Torrent engine choice | Earlier `ARCHITECTURE.md` §6 prescribed N-API native binding as the V2 default. After validation against the engineering reality (V1's `@torrentstack` already ships ~14 of 15 subsystems in pure TS; only uTP/LEDBAT is meaningfully harder in pure-TS), the team chose pure-TS. | **LOCKED: pure-TS engine is the V2 default.** No N-API, no sidecar. Single-process "fully built-in" identity is a core product decision. uTP is V1.0-omitted (TCP-only); see §30 for the production-readiness plan that gates V1.0 ship. External download-client adapters remain the escape hatch for mandatory-uTP swarms. |
| C8 | uTP support | `transmission-audit.md` §35 makes BEP 29 a parity item; `archivist-audit.md` §8.2 marks it "ship TCP-only by default"; `ARCHITECTURE.md` is silent. | **Locked: TCP-only at v1.0 ship; uTP marked as Phase 7 hardening item.** |
| C9 | TVDB v4 OAuth | `sonarr-audit.md` §22 mandates the PIN flow; V1's `series/tvdb.ts` implements it correctly. `archivist-audit.md` §32.2 references it. | No conflict; ensure phase-2 build delivers PIN UI + token-refresh service singleton. |
| C10 | API auth model | `radarr-audit.md` §13 prescribes API-key + Forms + Basic. V1 only implements API-key. `archivist-audit.md` §35.1 lists `auth_method = none|basic|forms`. | **Locked: V1.0 ships API-key only. Forms + Basic are Phase 7+ items. Single API key, no multi-user.** |
| C11 | Hono RPC vs traditional REST | `archivist-audit.md` §16 says "Hono RPC end-to-end types" but lists traditional REST endpoints. The two are compatible only if every route is a typed Hono handler with a Zod request body. | **Locked: every route uses Hono's typed handler signature; Zod schemas at the route boundary; frontend imports `AppType` and uses `hc<AppType>()`. No traditional Express-style untyped routers.** |
| C12 | SSE vs WebSocket | `archivist-audit.md` §12.5 says SSE; `ARCHITECTURE.md` §4.7 prefers SSE; some upstream audits reference WebSocket. | **Locked: SSE one-way for server→client. No WebSocket. If two-way arrives later (file upload progress?), use chunked POST + SSE response, not WS.** |
| C13 | Configuration format | V1 uses `.env` + `config.xml`-style; `archivist-audit.md` §18.1 says `config.toml`. | **TOML wins.** First-class Bun support; cleaner than .env for nested config. |
| C14 | Frontend state | `archivist-audit.md` §17.6 lists Zustand for cross-tree state. V1 uses React Context (`tab-context.tsx`). | **Zustand wins.** Context re-renders are expensive at the scale of a 50k-episode library. |
| C15 | Migration from V1 | `ARCHITECTURE.md` §7.3 says "no data porting"; `archivist-audit.md` §19.1 confirms; V1's per-tab DBs would migrate trivially. | **Locked: greenfield. V1 DBs renamed-and-archived on first V2 boot. Re-import via Holding Pen.** |
| C16 | Notifications subset | Sonarr/Radarr audits list ~20 notification providers each. `archivist-audit.md` §14.4 names a subset. | **Locked: V1.0 ships 5 providers (Discord, Email, Webhook, Plex/Emby/Jellyfin combined, Custom Script). Rest are Phase 7+.** |
| C17 | Default theme | UI palette frozen in `ARCHITECTURE.md` §7.1 (Noir + accent neon). `archivist-audit.md` §17.2 echoes it. | No conflict. Locked. |

These 17 items resolve the contradictions. Anything else discovered during build defers to the precedence rules in §1.

---

## 3. The Canonical Custom Format Specification Catalogue (LOCK)

Distilled from `radarr-audit.md` §17.2, `sonarr-audit.md` §15, and Archivist's Quality Tier addition. **This is the complete merged list V2 must implement, *as the cross-domain base set*.**

**Per-media-domain extensions** (each adds its own specifications on top of this base):
- **Music** — `lidarr-audit.md` §14.3 adds: `FormatSpecification`, `BitDepthSpecification`, `SampleRateSpecification`, `ChannelsSpecification`, `ReleaseTypeSpecification`, `ReleaseGroupSpecification` (rip-group), `LabelSpecification`, `CountrySpecification`, `CatalogNumberSpecification`, `LosslessSpecification`, `DynamicRangeSpecification`.
- **Books / Audiobooks** — `readarr-audit.md` §14.3 adds: `BookFormatSpecification`, `FormatClassSpecification`, `EditionTypeSpecification`, `AbridgementSpecification`, `NarratorSpecification`, `TranslatorSpecification`, `SeriesSpecification`, `PublisherSpecification`, `IsbnSpecification`, `AsinSpecification`, `PageCountSpecification`, `DurationSpecification`, `IsDrmFreeSpecification`.
- **Comics / Manga** — `kapowarr-audit.md` §15.2 adds: `ScanGroupSpecification`, `SourceTypeSpecification`, `FormatSpecification`, `ImageFormatSpecification`, `ResolutionRangeSpecification`, `IsCompilationSpecification`, `IsTPBSpecification`, `IsVariantSpecification`, `LanguageSpecification`, `IsMangaSpecification`, `PageCountSpecification`, `IsDrmFreeSpecification`, `PublisherSpecification`, `JpegQualitySpecification`, `DpiSpecification`, `ScanlationGroupSpecification`.

The Custom Format engine evaluates all applicable specifications regardless of media domain — the per-domain extensions are simply additional `implementation` enum values registered with the engine. **A library row's `media_type` discriminator filters which specs are surfaced in the UI**; behind the scenes the same engine evaluates all of them.

```ts
type SpecificationImplementation =
  // Films + TV (from Radarr)
  | 'ReleaseTitleSpecification'      // value: regex
  | 'ReleaseGroupSpecification'      // value: regex
  | 'EditionSpecification'           // value: regex matching parsed edition
  | 'LanguageSpecification'          // value: language id; exceptLanguage: bool
  | 'IndexerFlagSpecification'       // value: flag bitmask (G_Freeleech, etc.)
  | 'SourceSpecification'            // value: 'BluRay'|'WEB-DL'|'WEBRip'|'HDTV'|'DVD'|'CAM'|...
  | 'ResolutionSpecification'        // value: 'R480p'|'R576p'|'R720p'|'R1080p'|'R2160p'
  | 'SizeSpecification'              // min: GB, max: GB
  | 'QualityModifierSpecification'   // value: 'Remux'|'BR-DISK'|'RawHD'|'Regional'|'Screener'|'Telecine'|'Telesync'|'Workprint'

  // TV-specific (from Sonarr)
  | 'EpisodeTitleSpecification'      // value: regex against parsed episode title
  | 'SceneNumberingSpecification'    // value: bool — release uses scene numbering
  | 'SeasonPackSpecification'        // value: bool — release is a season pack
  | 'EpisodeTypeSpecification'       // value: 'standard'|'seasonPremiere'|'midSeasonFinale'|'seasonFinale'|'seriesFinale'|'midSeasonPremiere'

  // Archivist-specific
  | 'QualityTierSpecification'       // value: 1|2|3 — matches scoreRelease().tier
  | 'CompendiumSpecification'        // value: compendium_id — release belongs to a franchise

interface Specification {
  id: number
  name: string                       // human-readable label
  implementation: SpecificationImplementation
  negate: boolean                    // invert the match
  required: boolean                  // hard-gate: format only matches if every required spec matches
  fields: Record<string, unknown>    // implementation-specific
}

interface CustomFormat {
  id: number
  name: string
  includeInRenaming: boolean         // true → emit in {Custom Formats} naming token
  specifications: Specification[]
}
```

**Evaluation rules:**
1. For each Custom Format, check every spec.
2. A format **matches** iff: every `required` spec matches **AND** at least one non-required spec matches.
3. `negate=true` flips the match result for that spec.
4. Sum the `score` values (from `quality_profile.format_items`) across all matching formats → `customFormatScore`.
5. `customFormatScore < quality_profile.minFormatScore` → release rejected.

---

## 4. The Canonical Scoring & Decision Algorithm (LOCK)

The single source of truth for "is this release better than what we have?"

```ts
function decideRelease(
  release: ParsedRelease & ScoredRelease,
  current: QualitySnapshot | null,
  profile: QualityProfile,
  context: DecisionContext,
): { accepted: boolean, score: number, customTier: number, reasons: string[], rejectionReasons: string[] }
```

**Pipeline (in order; first failing gate ends evaluation):**

1. **Hard gates** (return `accepted: false` on any failure):
   - **Size envelope:** `quality_definitions[release.quality].minSize ≤ size ≤ maxSize` (per resolution). MB-per-minute scaling per `radarr-audit.md` §16.1.
   - **Release Profile required words:** every word in `required[]` must appear in title.
   - **Release Profile ignored words:** zero words from `ignored[]` may appear in title.
   - **Custom Format `required` specs:** all required specs across all formats must match.
   - **Quality Profile cutoff:** if `current` already meets profile cutoff AND `upgrade_allowed=false`, reject.
   - **Blocklist:** info_hash, GUID, or download URL must not be in `release_blocklist`.
   - **Minimum seeders:** `seeders ≥ indexer.minimumSeeders`.
   - **Free space:** root folder must have `≥ size + 100MB` free.

2. **Tier classification:** `customTier = scoreRelease(release.title).tier` (0|1|2|3 per §28.5 of `archivist-audit.md`).

3. **Custom Format scoring:** `customFormatScore = sum(format.score for matching formats)`.

4. **Quality position:** `qualityPosition = profile.items.indexOf(release.quality)` (-1 if not in profile).

5. **Comparison vs current** (if `current != null`):
   - **Tier upgrade:** `release.customTier < current.tier` (lower tier number = better) → `isUpgrade = true`.
   - **Resolution upgrade:** `RESOLUTION_SCORE[release.resolution] > RESOLUTION_SCORE[current.resolution]`.
   - **Source upgrade:** `SOURCE_SCORE[release.source] > SOURCE_SCORE[current.source]`.
   - **Codec upgrade:** `CODEC_SCORE[release.codec] > CODEC_SCORE[current.codec]`.
   - **Format-score upgrade:** `release.customFormatScore > current.customFormatScore + 50` (margin to prevent thrashing).

6. **Final score** (used only for tiebreaking — NOT for accept/reject):
   ```
   score = SCORE_TITLE_MATCH * (titleMatch ? 1 : 0)
         + SCORE_YEAR_EXACT * (yearExact ? 1 : 0)
         + SCORE_YEAR_ADJACENT * (yearAdjacent ? 1 : 0)
         + customFormatScore
         + qualityPosition * 10
         + (titleMatch ? 0 : SCORE_NO_TITLE)
         + (yearMissing ? SCORE_NO_YEAR : 0)
   ```

**Sort order across multiple accepted releases:**
1. `customTier` ASC (1 < 2 < 3 < 0=untiered).
2. `customFormatScore` DESC.
3. `score` DESC.
4. `seeders` DESC.
5. `indexerPriority` ASC.

The first release after sorting wins.

---

## 5. The Canonical Lifecycle State Machine (LOCK)

Every Exhibit follows this state machine. **No department flips state directly** — only the Curator dispatches transitions in response to events.

```
                   user-add
                      │
                      ▼
  ┌──────────┐     ┌─────────┐     ┌──────────┐     ┌──────────┐     ┌─────────────┐     ┌───────────┐
  │ upcoming │────▶│ wanted  │────▶│searching │────▶│acquiring │────▶│  restoring  │────▶│ collected │
  └────┬─────┘     └────┬────┘     └────┬─────┘     └────┬─────┘     └──────┬──────┘     └─────┬─────┘
       │                │               │                │                  │                  │
       │ release-day    │ user-ignore   │ no-results     │ download-fail    │ restoration-fail │ user-mark-bad
       ▼                ▼               ▼                ▼                  ▼                  ▼
  ┌──────────┐    ┌──────────┐     ┌─────────┐      ┌─────────┐         ┌─────────┐        ┌──────────┐
  │  wanted  │    │ ignored  │     │ wanted  │      │ wanted  │ ←──────│ wanted  │ ←──────│ wanted   │
  └──────────┘    └──────────┘     └─────────┘      │ + block │         │ + block │        │ + block  │
                       │                            └─────────┘         └─────────┘        │ + delete │
                       │ user-monitor                                                       └──────────┘
                       ▼
                   ┌─────────┐
                   │ wanted  │
                   └─────────┘
```

### 5.1. The Allowed Transitions (Exhaustive)
| From | To | Trigger | Side Effect |
|---|---|---|---|
| (new) | `upcoming` | TMDB releaseDate > now() at add time | — |
| (new) | `wanted` | TMDB releaseDate ≤ now() at add time | Enqueue immediate search if `addOptions.searchOnAdd=true` |
| `upcoming` | `wanted` | Curator chronological tick on release-date day | Enqueue `MissingSearchCommand` for this Exhibit |
| `wanted` | `searching` | `RssSyncCommand` or `MissingSearchCommand` started search | UI badge update |
| `wanted` | `ignored` | User toggle | — |
| `wanted` | `acquiring` | `LeadAcceptedEvent` from Appraisal → Intake send-to-client succeeded | Persist `info_hash`, dispatch `ArtifactDownloadStartedEvent` |
| `searching` | `wanted` | Search completed with no acceptable results | — |
| `searching` | `acquiring` | Search yielded acceptable result + grab succeeded | Persist `info_hash` |
| `acquiring` | `wanted` | `DownloadFailedEvent` | Blocklist `info_hash`; backoff retry |
| `acquiring` | `restoring` | `ArtifactArrivedEvent` (download complete) | Dispatch Restoration pipeline |
| `restoring` | `collected` | `ArtifactArchivedEvent` from Vault | Update `current_*` quality snapshot; fire `OnDownload` notification |
| `restoring` | `wanted` | Restoration validation failed | Blocklist; raise health alert |
| `collected` | `wanted` | User clicks "Reject Current Release" or "Mark as Bad" | Blocklist; delete file (recycle bin); reset `current_*` |
| `collected` | `acquiring` | Upgrade search found better release | Old artifact moved to recycle bin on `ArtifactArchivedEvent` |
| `ignored` | `wanted` | User toggle | — |
| any | `deleted` (logical) | User removes Exhibit | DB row preserved with `status='deleted'` if `addExclusion=true`, else hard delete |

### 5.2. Per-Hierarchy State
- **Films:** state on `films.status`.
- **Series:** state on `series.status` (TVDB-sourced: `continuing | ended | upcoming | deleted`). Episode state is **derived**:
  ```ts
  if (!episode.airDate)               → 'tba'
  else if (episode.airDateUtc > now)  → 'unaired'
  else if (episode.episodeFileId > 0) → 'collected' (downloaded)
  else                                → 'wanted' (missing)
  ```
- **Music:** state on `albums.status` (tracks inherit).
- **Books:** state on `books.status`.
- **Comics:** state on `comic_issues.status`.
- **Games / Magazines:** state on the entity row.
- **Podcasts:** state on `podcast_episodes.status`.

### 5.3. Illegal Transitions
The state machine **rejects** illegal transitions and emits a `StateMachineViolationEvent` with stack trace. Health alert raised; transition does not occur. Examples:
- `collected → searching` (must go through `wanted`).
- `acquiring → collected` (must pass through `restoring`).
- `wanted → restoring` (no artifact arrived yet).

A re-implementer should encode the FSM as a typed transition table:
```ts
const ALLOWED: Record<Status, Set<Status>> = {
  upcoming:  new Set(['wanted', 'ignored']),
  wanted:    new Set(['searching', 'acquiring', 'ignored', 'upcoming']),
  searching: new Set(['wanted', 'acquiring']),
  acquiring: new Set(['wanted', 'restoring']),
  restoring: new Set(['collected', 'wanted']),
  collected: new Set(['wanted', 'acquiring']),
  ignored:   new Set(['wanted']),
}
```

---

## 6. The Series-Add MonitorTypes — Canonical List (LOCK)

`sonarr-audit.md` §11 lists 12 strategies; `archivist-audit.md` §22 references them. Locked here:

| Strategy | Effect on add |
|---|---|
| `unknown` | Default → same as `all` |
| `all` | Monitor every season + episode incl. specials |
| `future` | Only monitor episodes with `airDate ≥ today` |
| `missing` | Only monitor episodes with `hasFile=false && airDate ≤ today` |
| `existing` | Only monitor episodes with `hasFile=true` |
| `firstSeason` | Only monitor S01 |
| `latestSeason` | Only monitor most recent season |
| `pilot` | Only monitor S01E01 |
| `recent` | Only monitor latest season's last 4 episodes |
| `monitorSpecials` | Monitor specials (S00) |
| `unmonitorSpecials` | Unmonitor specials |
| `none` | Add unmonitored |
| `skip` | Don't auto-set; leave existing flags |

Re-applying via the Series Editor **must be supported** and is destructive to existing per-episode monitor flags.

---

## 7. The Indexer Test Endpoint — Canonical Response Shape (LOCK)

`prowlarr-audit.md` §32 + `archivist-audit.md` §31.4 reference this. Locked shape:

```ts
type IndexerTestResult = {
  isValid: boolean
  validationFailures: Array<{
    propertyName: string                  // 'baseUrl' | 'apiKey' | 'username' | ...
    errorMessage: string                  // human-readable
    severity: 'Error' | 'Warning'         // Error blocks save; Warning is informational
  }>
  capabilities?: {                        // populated on success
    searchModes: string[]
    categories: number[]
    supportsRss: boolean
    supportsSearch: boolean
  }
  responseTimeMs?: number
  testedAt: string                        // ISO timestamp
}
```

Cached in-memory for 5 minutes keyed by config hash. UI shows "Last tested 2 min ago" badge.

---

## Part II: Operational Concerns Missing Across All Docs

The five existing audit docs cover behaviour, data shapes, and protocols. They do not cover the operational layer that makes V2 deployable, debuggable, and supportable. The remainder of this document fills that gap.

---

## 8. Logging & Observability

### 8.1. Structured JSON Logging (LOCK)
All log lines emitted as JSON to `stdout` for production, pretty-printed for development.

```ts
type LogRecord = {
  ts: string                              // ISO 8601 with ms precision
  level: 'trace'|'debug'|'info'|'warn'|'error'|'fatal'
  category: string                         // 'acquisitions'|'intake'|'appraisal'|'restoration'|'vault'|'galleries'|'curator'|'http'|'db'|'parser'|'indexer'|'system'
  message: string
  requestId?: string                       // correlation id from request-id middleware
  subjectType?: string                     // 'film' | 'episode' | 'job' | ...
  subjectId?: string
  data?: Record<string, unknown>           // arbitrary structured data
  err?: { name: string, message: string, stack: string }
}
```

### 8.2. Log Sinks
1. **stdout** — JSON, always on.
2. **File** — rolling, `logs/archivist.txt` + `archivist.0.txt..archivist.4.txt` (5 files of 1 MB each).
3. **`logs.db`** — separate SQLite DB (separate from `archivist.sqlite` to avoid contention) with the same schema as `system_events`. UI's "Events" page reads this. Retention: 30 days.

### 8.3. Log Level Override at Runtime
`PUT /api/v1/config/host` body `{ logLevel }` — applied immediately to all loggers. Persisted to `config.toml` on next graceful shutdown.

### 8.4. Request-Id Correlation
Every HTTP request gets a UUID v4 `X-Request-Id` (or honours an inbound one from a reverse proxy). Every log line emitted during request handling includes this id. SSE events also tag their originating request id.

### 8.5. Metrics (Phase 7+, NOT in v1.0)
Optional Prometheus exporter at `GET /metrics` (auth-bypassed, IP-allowlisted via `metrics_allowlist` config). Metric families:
- `archivist_jobs_total{type, status}` counter.
- `archivist_indexer_query_duration_seconds{indexer}` histogram.
- `archivist_torrent_active_count` gauge.
- `archivist_torrent_download_speed_bytes` gauge.
- `archivist_db_writes_total` counter.
- `archivist_health_alerts_active{source, severity}` gauge.

OpenTelemetry tracing via `OTEL_EXPORTER_OTLP_ENDPOINT` env (when set) — opt-in, off by default.

---

## 9. Error Taxonomy

Across the five docs, error handling is implicit. V2 needs a typed error model.

### 9.1. The Error Hierarchy
```ts
abstract class ArchivistError extends Error {
  abstract readonly code: string                  // stable enum string for telemetry
  abstract readonly category: 'user' | 'integration' | 'internal' | 'state'
  abstract readonly httpStatus: number
  readonly cause?: Error
  readonly data?: Record<string, unknown>
}

// User errors (4xx)
class ValidationError      extends ArchivistError { code='ARC_VALIDATION';   httpStatus=400 }
class UnauthorizedError    extends ArchivistError { code='ARC_UNAUTHORIZED'; httpStatus=401 }
class ForbiddenError       extends ArchivistError { code='ARC_FORBIDDEN';    httpStatus=403 }
class NotFoundError        extends ArchivistError { code='ARC_NOT_FOUND';    httpStatus=404 }
class ConflictError        extends ArchivistError { code='ARC_CONFLICT';     httpStatus=409 }
class RateLimitedError     extends ArchivistError { code='ARC_RATE_LIMITED'; httpStatus=429 }

// Integration errors (5xx-ish)
class IndexerError         extends ArchivistError { code='ARC_INDEXER_FAIL'; httpStatus=502 }
class DownloadClientError  extends ArchivistError { code='ARC_DC_FAIL';      httpStatus=502 }
class MetadataProviderError extends ArchivistError { code='ARC_METADATA';    httpStatus=502 }
class FlareSolverrError    extends ArchivistError { code='ARC_FLARE';        httpStatus=502 }

// State errors (the FSM)
class StateMachineViolation extends ArchivistError { code='ARC_FSM_VIOLATION'; httpStatus=500 }
class IntegrityViolation   extends ArchivistError { code='ARC_INTEGRITY';      httpStatus=500 }

// Filesystem errors
class FilesystemError      extends ArchivistError { code='ARC_FS';           httpStatus=500 }
class HardlinkError        extends ArchivistError { code='ARC_HARDLINK';     httpStatus=500 }
class DiskFullError        extends ArchivistError { code='ARC_DISK_FULL';    httpStatus=507 }

// Internal
class InternalError        extends ArchivistError { code='ARC_INTERNAL';     httpStatus=500 }
```

### 9.2. HTTP Error Response Shape (LOCK)
Every error response is RFC 9457 (Problem Details for HTTP APIs):
```json
{
  "type": "https://archivist.local/errors/ARC_VALIDATION",
  "title": "Validation failed",
  "status": 400,
  "detail": "tmdbId is required",
  "instance": "/api/v1/films",
  "code": "ARC_VALIDATION",
  "requestId": "01HZ...",
  "errors": [
    { "path": "tmdbId", "message": "Required" }
  ]
}
```

A re-implementer must:
- Wrap every Hono route's handler in a try/catch that converts thrown `ArchivistError` to this shape.
- Convert generic `Error` to `ARC_INTERNAL` with `detail` redacted in production (just "Internal server error"), full stack in development.
- Emit a structured log on every 5xx with the full stack trace.

### 9.3. Health Alerts vs Errors
**Errors** are per-request failures. **Health alerts** are persistent system conditions. Examples:

| Condition | Type |
|---|---|
| User submits invalid form | Error |
| Indexer 502s on this query | Error |
| Indexer 502s on every query for 1h | Health alert (escalated) |
| FFmpeg binary missing | Health alert |
| Disk space < 5GB | Health alert |
| TVDB token expired | Health alert (until refreshed) |

Health alerts persist to `system_events` with `category='health'`; UI shows them as a red badge; they expire automatically when the underlying condition clears.

---

## 10. HTTP Conventions Across the API (LOCK)

### 10.1. Pagination Envelope
**Cursor-based**, not offset, for stability under concurrent writes:
```ts
type PaginatedResponse<T> = {
  items: T[]
  nextCursor: string | null               // base64-encoded {lastId, lastSortValue}
  total?: number                          // optional; expensive to compute, omitted for large tables
}
```
Request: `GET /endpoint?cursor=<base64>&limit=50`. `limit` capped at 200 server-side.

### 10.2. Sort Spec
Query string format: `?sort=fieldName:asc|desc[,fieldName2:asc|desc]`.
Per-endpoint sortable-fields whitelist enforced in route handler; unknown fields → 400.

### 10.3. Filter Spec
Simple equality filters via repeated query params: `?filter=status:wanted&filter=monitored:true`.
Complex filters via JSON body on a `POST /endpoint/search` variant (rare; only where needed).

### 10.4. ID Format
- Integer for DB-generated ids (sequence: `films.id`, `episodes.id`, etc.).
- UUID v4 (string) for `indexers.id` and `compendiums.id`.
- Never expose internal db rowid; only the explicit `id` column.

### 10.5. Date / Timestamp Format
- All dates in API responses: ISO 8601 with timezone (`2026-05-08T14:30:00Z`).
- All dates in DB: `TEXT` ISO 8601 OR `INTEGER` unix ms (column-specific; consistent within a table).
- Frontend converts to user locale via `Intl.DateTimeFormat` — never server-side.

### 10.6. Boolean
Always `true`/`false` in JSON; in DB stored as `INTEGER` 0/1 with explicit cast in deserialisers.

---

## 11. Security Model

### 11.1. Threat Model
Archivist is designed for **personal-use, trusted-network** deployment. Threats considered:

| Threat | Mitigation |
|---|---|
| Unauthenticated access from LAN | API key required (off by default for `127.0.0.1`) |
| Credential stuffing on exposed instance | Anti-brute-force IP ban (100 fails → 1h) |
| CSRF | Forms-auth path uses anti-CSRF token; API-key path is immune (header-based) |
| XSS in user-rendered content | React escapes by default; never `dangerouslySetInnerHTML` from user input |
| Path traversal in user-supplied paths | `sanitizePath` checks: absolute, no `\0`, no `..`, optional sandbox via `allowed_roots` |
| Command injection in ffmpeg/ffprobe args | `Bun.spawn` with array args (never shell strings); never interpolate user input into args |
| SSRF via indexer URL | Per-indexer URL validated against a deny-list of internal IPs (10/8, 172.16/12, 192.168/16, 169.254/16, 127/8) at config-save time; runtime fetch logs warn on denied URLs |
| Information leak via stack traces | Production mode redacts error `detail`; only `code` + `requestId` exposed |
| Backup file exfiltration | Backups stored in `backups_dir`; HTTP download requires API key; optional AES-256-GCM encryption with passphrase |
| Cookie / API-key extraction from DB | `IndexerStatus.cookies` + `app_settings.apiKeys` encrypted at rest with derived key from per-install secret in `config.toml`'s `auth.master_key` |

**NOT in scope:** authenticated multi-tenant operation, defence against compromised local user, hostile filesystem.

### 11.2. Secrets at Rest
- `config.toml` `auth.master_key` — 32-byte random base64 string, generated on first run.
- AES-256-GCM with `master_key` as KEK derived via HKDF-SHA256 with per-purpose info string.
- Encrypted columns: `indexers.api_key`, `indexers.password`, `indexer_status.cookies`, `download_clients.password`, `app_settings.apiKeys`, `notifications.settings.smtpPassword`, etc.
- Encryption is transparent — Drizzle layer wraps reads/writes; application code sees plaintext.

### 11.3. CSRF (Forms-Auth Only — Phase 7+)
When Forms auth is enabled:
- Issue a CSRF cookie on login: `__archivist_csrf=<32-byte random>; HttpOnly; SameSite=Strict; Secure`.
- All mutation requests must include `X-CSRF-Token: <same value>` header.
- API-key requests bypass CSRF entirely.

### 11.4. Allowed Mutations Without Auth
**None.** Even `GET /api/v1/health` is allowed unauthenticated only because it leaks zero state. `GET /ping` is allowed unauthenticated for reverse-proxy probes.

### 11.5. SSRF Defence (Detailed)
Every outbound URL goes through `validateExternalUrl`:
```ts
function validateExternalUrl(url: string, options: { allowPrivate?: boolean } = {}): URL {
  const u = new URL(url)
  if (!['http:', 'https:'].includes(u.protocol)) throw new ValidationError(`scheme not allowed: ${u.protocol}`)
  // Resolve hostname → IP; reject private ranges unless allowPrivate
  const ip = resolveSync(u.hostname)
  if (!options.allowPrivate && isPrivateIP(ip)) {
    throw new ValidationError(`private/loopback IP not allowed: ${ip}`)
  }
  return u
}
```
`allowPrivate=true` for: FlareSolverr (typically `192.168.x.x`), download clients (`localhost:9091`), built-in engine. **Never** for indexer base URLs.

### 11.6. File Operations
- Always validate paths against `config.toml` `paths.allowed_roots` (when set).
- Never use `process.cwd()`-relative paths in user-facing config; resolve to absolute at save time.
- Reject paths containing null bytes, `..`, or non-printable chars.

---

## 12. Threading & Worker Model

Bun supports `worker_threads` (Node-compatible). V2 uses workers for CPU-bound work; everything else is single-threaded async.

### 12.1. The Main Thread
- HTTP server (Hono).
- Job runner tick.
- Curator scheduler.
- All DB reads/writes (better-sqlite3 is synchronous; better to batch on main thread than thrash worker→main message passing).
- Torrent engine event loop (libuv UDP/TCP).
- SSE hub.

### 12.2. Worker Threads
| Worker | Purpose | Pool size |
|---|---|---|
| `piece-verifier.worker.ts` | SHA-1/SHA-256 piece verification | `Math.max(2, os.cpus().length - 1)` |
| `parser-worker.ts` (NEW) | Bulk parsing during RSS sync (batch 100+ titles) | 1 |
| `image-worker.ts` (NEW) | Resize TMDB images for cache (sharp) | 2 |
| `cardigann-html-worker.ts` (NEW) | HTML parsing for big indexer results | 1 |

### 12.3. Subprocess (Bun.spawn)
| Process | Purpose | Concurrency |
|---|---|---|
| `ffmpeg` | Track cleaning, transcoding | 1 (CPU-bound; serialise) |
| `ffprobe` | Stream analysis | 4 (I/O-bound) |

### 12.4. SQLite Write Contention
better-sqlite3 in WAL mode supports many readers + 1 writer. Since all writes are on the main thread and synchronous, contention is limited to:
- Job runner tick claiming a job (UPDATE).
- HTTP request inserting a row (INSERT).

Rule: any write that takes >50ms must be split into smaller transactions or moved to a job. The Curator's `IntegrityCommand` walks every library — must commit per-library, not per-scan.

### 12.5. Event Loop Saturation Guard
A process-wide watchdog: if event-loop lag exceeds 250ms for >5s, log a warn and emit a health alert. Common cause: a synchronous `JSON.parse` of a 50MB Cardigann response. Diagnose by snapshotting `--prof`.

---

## 13. Local Development

### 13.1. Prerequisites
- Bun ≥1.1
- Node.js ≥20 (for `node-gyp` dependencies that don't yet support Bun, e.g. `better-sqlite3` if a prebuilt isn't available).
- ffmpeg + ffprobe in PATH (or `ffmpeg-static`/`ffprobe-static` npm).
- Git.
- (Optional) FlareSolverr running locally on `:8191` for Cardigann development.

### 13.2. First-Run Bootstrap
```bash
git clone <repo>
cd archivist
bun install
cp config.example.toml config.toml          # creates config.toml with sane defaults + a freshly-generated api_key
bun run db:migrate                            # applies all pending Drizzle migrations
bun run dev                                   # starts backend on :2424 and Vite frontend on :5173 in parallel
```

### 13.3. Workspace Layout
```
archivist/
├── apps/
│   ├── archivist/            # the V2 server + frontend bundle target
│   │   ├── src/              # backend (Hono routes, services, departments)
│   │   ├── client/           # Vite frontend
│   │   ├── docs/             # this audit corpus
│   │   ├── data/             # runtime: archivist.sqlite, indexer-definitions/, downloads/, ...
│   │   ├── media/            # runtime: organised library
│   │   ├── logs/             # runtime: rolling logs
│   │   ├── config.toml
│   │   └── Dockerfile
│   └── archivist-cli/        # OPTIONAL: thin CLI wrapping RPC for headless ops
└── packages/
    ├── core/                 # shared utilities (logger, scoring, db helpers)
    ├── types/                # shared TypeScript types
    ├── bittorrent/           # BEP protocol implementation
    ├── torrent-engine/       # session, swarm, piece manager, storage
    └── indexer-engine/       # Cardigann executor, definition loader, search aggregator
```

### 13.4. NPM Scripts (per package.json)
```jsonc
{
  "scripts": {
    "dev":        "bun --watch src/server.ts",
    "build":      "bun build src/server.ts --target bun --outfile dist/server.js && cd client && vite build",
    "start":      "bun dist/server.js",
    "test":       "bun test",
    "test:watch": "bun test --watch",
    "typecheck":  "tsc --noEmit",
    "lint":       "eslint src/ client/src/",
    "db:migrate": "drizzle-kit migrate",
    "db:studio":  "drizzle-kit studio",
    "db:generate":"drizzle-kit generate",
    "fmt":        "prettier --write src/ client/src/"
  }
}
```

---

## 14. Testing Strategy

### 14.1. Test Pyramid
| Tier | Tool | Coverage |
|---|---|---|
| Unit | `bun test` | Pure functions: parser, scorer, naming engine, validators, FSM transitions. ~70% of total tests. |
| Integration | `bun test` with in-memory SQLite | Department surfaces wired together: e.g. "given a search result, decide → download → import → archive flows correctly." Real DB, mocked external APIs. ~25%. |
| End-to-end | Playwright | Top user flows in real browser: add film, manual search, grab, watch transition to collected. ~5%. |

### 14.2. Test Fixtures
- `test/fixtures/releases/` — 200+ real release titles (one per file, content is the raw title) for parser regression tests.
- `test/fixtures/torrents/` — 10 small `.torrent` files for engine integration tests (legal content: free-software ISOs, public-domain films).
- `test/fixtures/cardigann/` — 5 real Cardigann YAML definitions + matching HTML response samples for executor tests.
- `test/fixtures/tmdb/` — saved JSON responses from TMDB for offline integration tests.

### 14.3. Critical Test Cases to Lock
The following test names **must exist** and **must pass** before declaring V2 ready:

```
parser.contextualLexer
  ✓ "1917.2019.1080p.BluRay" parses title="1917" year=2019
  ✓ "Show.S01E01-E03.WEBDL" parses kind=series episodes=[1,2,3]
  ✓ "[SubsPlease] Show - 1054 [1080p].mkv" parses kind=unknown absoluteEpisode=1054 releaseHash=null
  ✓ "Show.2024.05.05.1080p.WEBDL" parses airDate="2024-05-05"
  ✓ "Show.S01.Complete.1080p.BluRay" parses isSeasonPack=true season=1
  ✓ "Movie (1982) Director's Cut.mkv" parses edition="Director's Cut"

scorer.tierClassification
  ✓ "Movie.2160p.x265-QxR" → tier=1
  ✓ "Movie.1080p-UTR" → tier=2
  ✓ "Movie.1080p-YIFY" → tier=3
  ✓ "Movie.1080p-RANDOMGROUP" → tier=0

decideRelease.hardGates
  ✓ rejects when size below quality definition minSize
  ✓ rejects when info_hash on blocklist
  ✓ rejects when seeders < indexer.minimumSeeders
  ✓ rejects when free space insufficient

stateMachine.transitions
  ✓ wanted → acquiring → restoring → collected sequence is allowed
  ✓ wanted → collected directly throws StateMachineViolation
  ✓ acquiring → wanted on DownloadFailedEvent blocklists info_hash

cardigann.execute
  ✓ login flow with cookie persistence works
  ✓ search with template variables renders correctly
  ✓ {{ .Categories }} emits site-specific ids not Newznab ids
  ✓ andmatch filter rejects rows missing keywords
  ✓ download.before pre-flight runs before download

trackCleaner
  ✓ keeps original-language audio when keepOriginalLanguage=true
  ✓ keeps preferred audio + commentary when configured
  ✓ rejects clean if chapter count regresses
  ✓ atomic rename on success; rollback on validation failure

namingEngine
  ✓ {Movie Title} ({Release Year}) {Quality Full} renders correctly
  ✓ illegal characters sanitised per colonReplacement mode
  ✓ MultiEpisodeStyle.Extend renders S01E01-E03

torrentEngine
  ✓ resume file written atomically (write-temp + rename)
  ✓ piece verification fails for tampered piece
  ✓ tracker tier failover advances on primary failure
```

### 14.4. Property-Based Testing
For the parser: use `fast-check` to generate 1000+ release titles and assert idempotence + monotonicity properties (parsing the canonical filename of an organised file should round-trip back to the same Exhibit).

### 14.5. Performance Budgets
Tests fail if:
- Parsing 1000 release titles takes >500ms.
- DB query "list all films in library" returns >100ms for 5000-film library.
- Search aggregation across 10 indexers takes >35s end-to-end.
- Track cleaning a 4K REMUX takes >20s (excluding I/O wait).

---

## 15. CI/CD Pipeline

### 15.1. CI Stages (GitHub Actions or equivalent)
```yaml
1. checkout
2. install (bun install)
3. typecheck (tsc --noEmit)
4. lint (eslint)
5. test (bun test)
6. build (bun build + vite build)
7. integration (boot binary against ephemeral DB, run smoke tests)
8. sbom (generate SBOM via syft)
9. scan (trivy scan dist/)
10. docker build (multi-arch: linux/amd64, linux/arm64)
11. publish (only on tag): GHCR + GitHub Release with binary artifacts
```

### 15.2. Branch Strategy
- `main` — production-ready.
- `develop` — integration branch.
- `feature/<topic>` — short-lived feature branches → PR into develop.
- Releases tagged on `main`: `v2.0.0-rc.1`, `v2.0.0`, etc.

### 15.3. Release Artefacts
On tag push:
- `archivist-${version}-linux-amd64.tar.gz` — single-binary build.
- `archivist-${version}-linux-arm64.tar.gz`.
- `archivist-${version}-darwin-amd64.tar.gz`.
- `archivist-${version}-darwin-arm64.tar.gz`.
- `archivist-${version}-windows-amd64.zip`.
- Docker images at `ghcr.io/<org>/archivist:<version>` + `:latest` + `:v2`.
- Docker images for `develop` at `:nightly`.
- SBOM (CycloneDX JSON) attached.
- SHA-256 checksums file.

---

## 16. Containerisation

### 16.1. Dockerfile (LOCK)
Multi-stage; smallest possible final image.
```dockerfile
# Stage 1: build
FROM oven/bun:1 AS builder
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build

# Stage 2: runtime
FROM oven/bun:1-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/apps/archivist/dist ./dist
COPY --from=builder /app/apps/archivist/client/dist ./client/dist
COPY --from=builder /app/node_modules ./node_modules

# Non-root user
RUN groupadd -g 1000 archivist && useradd -m -u 1000 -g archivist archivist
USER archivist

EXPOSE 2424 2425/tcp 2426/udp 2427/udp

VOLUME ["/data", "/media", "/config"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:2424/ping || exit 1

ENTRYPOINT ["bun", "dist/server.js"]
```

### 16.2. docker-compose.yml (LOCK)
```yaml
services:
  archivist:
    image: ghcr.io/archivist/archivist:latest
    container_name: archivist
    restart: unless-stopped
    ports:
      - "2424:2424"
      - "2425:2425/tcp"
      - "2426:2426/udp"
      - "2427:2427/udp"
    volumes:
      - ./config:/config
      - ./data:/data
      - /path/to/your/media:/media
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
      - ARCHIVIST_CONFIG_PATH=/config/config.toml
    depends_on:
      - flaresolverr

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    container_name: flaresolverr
    restart: unless-stopped
    environment:
      - LOG_LEVEL=info
    ports:
      - "8191:8191"
```

### 16.3. PUID/PGID Handling
Standard linuxserver.io convention: entrypoint script chowns volumes to PUID:PGID before dropping privileges. Docs must include this snippet for users with NAS setups.

### 16.4. Privilege Reduction
- Container runs as UID 1000 (non-root).
- No `CAP_NET_ADMIN`, `CAP_SYS_ADMIN` — Archivist doesn't need them.
- Read-only root filesystem mode supported (mount `/tmp` as tmpfs); document as advanced.

---

## 17. Reverse Proxy Patterns

### 17.1. Nginx
```nginx
server {
  listen 443 ssl http2;
  server_name archivist.example.com;

  ssl_certificate /etc/letsencrypt/live/archivist.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/archivist.example.com/privkey.pem;

  client_max_body_size 100M;
  proxy_read_timeout 90s;
  proxy_buffering off;          # critical for SSE
  proxy_cache off;

  location / {
    proxy_pass http://127.0.0.1:2424;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id $request_id;
  }

  # SSE endpoint — no buffering, long timeout
  location /api/v1/events {
    proxy_pass http://127.0.0.1:2424;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
    chunked_transfer_encoding off;
  }
}
```

### 17.2. Traefik (docker labels)
```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.archivist.rule=Host(`archivist.example.com`)"
  - "traefik.http.routers.archivist.tls.certresolver=letsencrypt"
  - "traefik.http.services.archivist.loadbalancer.server.port=2424"
  - "traefik.http.middlewares.sse.headers.contenttype=text/event-stream"
```

### 17.3. Caddy
```
archivist.example.com {
  reverse_proxy 127.0.0.1:2424 {
    flush_interval -1                # for SSE
  }
}
```

### 17.4. URL Base Support
For path-prefix deployments (`https://example.com/archivist/`):
- Set `config.toml` `server.url_base = "/archivist"`.
- All emitted URLs (links, redirects, image paths in NFOs, push URLs in app sync) include the prefix.
- `/ping` is **not** prefixed (root-level for proxy probes).

---

## 18. VPN Integration Patterns

A common deployment scenario: route torrent traffic through a VPN for privacy.

### 18.1. Gluetun + Archivist (LOCK Pattern)
```yaml
services:
  gluetun:
    image: qmcgaw/gluetun
    cap_add: ['NET_ADMIN']
    devices: ['/dev/net/tun:/dev/net/tun']
    environment:
      - VPN_SERVICE_PROVIDER=mullvad
      - WIREGUARD_PRIVATE_KEY=...
      - WIREGUARD_ADDRESSES=...
      - SERVER_CITIES=Stockholm
    ports:
      - "2424:2424"           # Archivist UI/API exposed via gluetun
      - "2425:2425/tcp"
      - "2426:2426/udp"
      - "2427:2427/udp"

  archivist:
    image: ghcr.io/archivist/archivist:latest
    network_mode: "service:gluetun"        # all traffic routed through VPN
    depends_on:
      - gluetun
    volumes:
      - ./config:/config
      - ./data:/data
      - /path/to/media:/media
```

Key constraint: Archivist's HTTP UI is also routed via the VPN. Users accessing the UI from the LAN must hit the gluetun container. Document this and provide an alternative: `bind_address_ipv4` set to a non-VPN interface for UI traffic only (advanced).

### 18.2. VPN-Bind Detection
Archivist must detect when its bound interface drops:
- Watch `os.networkInterfaces()` every 5s.
- If `bind_address_ipv4` no longer present → pause all torrent activity, raise `InterfaceMissingHealthAlert`.
- On reappearance → unpause, clear alert.

This is the closest TS port can get to "kill switch" semantics. True kill-switch behaviour requires `iptables`/`nftables` rules on the host.

---

## 19. Backup & Disaster Recovery

### 19.1. Backup Contents
On every `BackupCommand` (weekly default):
```
backup-2026-05-08T1230.zip
├── manifest.json                  # version, timestamp, file list, checksums
├── archivist.sqlite               # primary DB (online .backup() snapshot)
├── logs.db                        # transient logs (optional; off by default)
├── config.toml                    # excludes auth.master_key — see below
├── definitions/                   # cached Cardigann definitions
├── covers/                        # MediaCover thumbnail cache
└── torrent-state/
    ├── resume/*.resume
    └── torrents/*.torrent
```

### 19.2. The Master Key Problem
`config.toml` `auth.master_key` is the KEK for all encrypted-at-rest fields. If the backup includes the master_key, an attacker with the backup has all secrets. If it omits it, restore is impossible without manual intervention.

**Resolution (LOCK):** The master_key is **always excluded** from the backup zip. Restore procedure prompts the user for one of:
1. Original master_key (paste).
2. Old `config.toml` (uploaded — Archivist extracts the key).
3. "I lost it" — wipe all encrypted columns, force re-entry of API keys, re-login of indexers.

Document this clearly in restore docs.

### 19.3. Backup Encryption
Optional: `systemBackups.encryption=true` + `systemBackups.passphrase=<user-chosen>`. AES-256-GCM with PBKDF2-SHA256 (310k iterations) key derivation. Encrypted backups have `.zip.enc` extension.

### 19.4. Restore Procedure
**There is no "Restore" button in the UI.** Restore is intentionally manual to prevent accidents:

1. Stop Archivist.
2. Move existing `data/archivist.sqlite` and `config.toml` aside.
3. Extract backup zip to a staging directory.
4. Run `bun run restore --backup=<path-to-zip> [--passphrase=...] [--master-key=...]`.
5. The restore tool:
   - Validates manifest checksums.
   - Compares backup version against current binary version. Refuses if backup is from a future version. Warns on major version mismatch.
   - Copies files into place.
   - Re-encrypts secrets if the master_key was provided fresh.
6. Start Archivist.
7. Restore tool logs every action; surfaces a "restore complete" health alert that the user dismisses.

### 19.5. Disaster Recovery (Total Loss)
If `archivist.sqlite` is corrupt and no backup exists:
1. Archivist still boots — fresh DB initialised.
2. User adds libraries pointing at existing media folders.
3. Per-library `RescanLibraryCommand` walks the filesystem, parses every NFO, reconstructs Exhibits + Artifacts.
4. Quality snapshots reconstructed by re-probing each file.
5. Acquisition history is **lost** — there is no NFO field for `info_hash`. Document this loss explicitly.

The NFO-based recovery makes Archivist self-healing for catastrophic DB loss as long as the media files + NFOs survive.

---

## 20. Onboarding & First-Run UX

The audit corpus is silent on first-run. V2 must answer "what does a brand new user see when they hit `http://archivist.local:2424` for the first time?"

### 20.1. The First-Run Wizard
On first boot, if `config.toml` `auth.api_key` is empty, the wizard runs:

1. **Welcome** — hello, Museum metaphor introduction, "Begin" button.
2. **Network** — port + bind-address confirmation; auto-detect public IP and recommend port forwarding.
3. **Authentication** — generate API key + show ONCE with a "Copy + I've saved it" checkbox. After this screen, the key is encrypted and never displayable in cleartext again (except via env var introspection).
4. **First Library** — pick a media type, name, root folder. Validates root folder is writable.
5. **Quality Profile** — pick from 3 presets ("Quality first", "Storage first", "Custom").
6. **Indexers** — sample 3 popular public indexers (configurable per build): "Try these now? You can always change later." Or "Skip; I'll configure later."
7. **Download Client** — built-in is enabled by default; offer to add an external qBit/Transmission. If skipped, the built-in engine is the active client.
8. **External APIs** — ask for TMDB API key (mandatory for Films), TVDB API key + PIN (mandatory for Series). Skip if user wants to delay.
9. **Finish** — redirect to Dashboard.

The wizard completes by writing `config.toml` `firstRunComplete=true`. Post-completion access to `/setup` 404s.

### 20.2. Empty States
Every list view has an empty state with:
- Icon (consistent with the media type).
- Heading (e.g. "No films yet").
- One-line explanation.
- Primary action button ("+ Add Film" or "Start with Trakt").
- Secondary link ("Or import existing files via Manual Import").

### 20.3. In-App Help / Tooltips
- Every settings field has a `(?)` tooltip with one-sentence help.
- The help icon links to the relevant section of an in-app docs viewer (Markdown rendered).
- Docs source: `apps/archivist/client/src/help/*.md` — versioned with the binary.

### 20.4. Search Help
The omni-search bar's empty state shows recent searches + "Search Tips":
- Use quotes for exact match.
- Add year for movies: `Inception 2010`.
- For TV: `Show Name S01E01`.
- Press `/` to focus.

---

## 21. Internationalisation

### 21.1. Locked: V1.0 ships English-only.

i18n is Phase 8+. Architecture commitment now to enable later:

### 21.2. Architecture Hooks
- All UI strings extracted via `t('key', { interpolation })` from a single `client/src/i18n/en.json`.
- Use `react-i18next` or `lingui` (decision deferred).
- Server-emitted strings (notification messages, log lines, error messages) — **English only forever**. Never localise machine-readable output.

### 21.3. Locale-Sensitive Formatting
Always client-side via `Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.RelativeTimeFormat`. Never hardcode date/number formats. The user's browser locale determines display; the server stores ISO 8601.

### 21.4. RTL
React's `dir="rtl"` flip when a future RTL locale is added. Tailwind's `rtl:` variant used for any direction-sensitive layout.

---

## 22. Accessibility

### 22.1. WCAG 2.1 AA Target
V2 commits to WCAG 2.1 AA conformance for the primary user flows (browse library, view detail, search, grab, settings). Phase 0–6 must not regress accessibility; Phase 7 audits and fixes.

### 22.2. Concrete Requirements
- All interactive elements keyboard-reachable; focus ring always visible.
- Skip-link to main content after sidebar.
- ARIA labels on every icon-only button.
- Live-region (`aria-live="polite"`) for toast notifications.
- Live-region (`aria-live="assertive"`) for download-progress bars.
- Color contrast ≥4.5:1 for text on Noir backgrounds — **the cyan accent on `noir-950` must be tested**; if it fails, lighten cyan to `#33DDFF` for text contexts only (preserve `#00D4FF` for accents).
- `prefers-reduced-motion` respected — no Konami-code bouncing if user opts out.

### 22.3. Screen-Reader Walkthrough
Test the following with VoiceOver / NVDA quarterly:
1. Navigate from sidebar → Films grid → film detail.
2. Add a film via TMDB lookup.
3. Trigger interactive search; ensure streaming results announced.
4. Manage a download (pause/resume/remove).

### 22.4. Headless UI Library Choice
Radix UI is the foundation. Where Radix doesn't ship (calendar grid, virtualised lists), use React Aria (`react-aria-components`). Both are WCAG-compliant by default.

---

## 23. Cross-Platform Support Matrix

### 23.1. Officially Supported
| OS | Architecture | Notes |
|---|---|---|
| Linux | amd64, arm64 | Primary target. All testing here. |
| macOS | amd64, arm64 (Apple Silicon) | Dev-friendly; not optimised. ffmpeg-static ships native binaries. |
| Windows | amd64 | Best-effort. Path separators normalised; case-insensitive FS quirks documented. |
| Docker | linux/amd64, linux/arm64 | Recommended deployment. |

### 23.2. Filesystem Quirks (LOCK)
| Filesystem | Hardlinks | Cross-volume | Notes |
|---|---|---|---|
| ext4 | ✅ | EXDEV → byte-copy | Default Linux; works perfectly. |
| btrfs / ZFS | ✅ | EXDEV across pools | Reflinks (`copy_file_range`) are faster than hardlinks where supported; expose `prefer_reflink` setting. |
| NTFS | ✅ (Windows only API) | EXDEV | Bun's `link()` works on NTFS via Windows APIs. |
| exFAT | ❌ | n/a | Hardlinks unsupported. Health alert raised at root-folder add time. |
| FAT32 | ❌ | n/a | Same as exFAT. Plus 4GB file size limit — also alerted. |
| NFS | ⚠️ | varies | Hardlinks work but slow; locking semantics differ. Use with caution. |
| SMB/CIFS | ⚠️ | varies | Same as NFS. Cookie-based auth on the SMB share is the common gotcha. |

### 23.3. Symlinks vs Hardlinks (LOCK)
- **Hardlinks** (default): same filesystem, true zero-byte clone, breaks if source moves but file content survives.
- **Symlinks** (opt-in): cross-filesystem, breaks if source moves and source is the only path. Setting: `mediaManagement.copyMode = 'hardlink' | 'symlink' | 'copy' | 'move'`.
- **Reflinks** (Phase 7+): if the FS supports `FICLONE` (btrfs, XFS, APFS), use reflinks instead of hardlinks. Setting: `mediaManagement.preferReflinks = true` (auto-detects).

### 23.4. Path Encoding
- All paths internal: UTF-8 strings.
- Persisted paths: ASCII-safe basename + UTF-8 metadata in NFO. Linux+macOS handle UTF-8 paths natively; Windows requires UTF-16 conversion at FS boundary (Bun handles this).

---

## 24. Performance Budgets

### 24.1. Library-Scale Targets
At a library of 5000 films + 500 series with 50,000 episodes + 1000 albums:

| Metric | Budget |
|---|---|
| Cold start to "ready" | <5s |
| Memory steady state (idle, no active downloads) | <300 MB |
| Memory under load (10 concurrent downloads) | <800 MB |
| Films grid initial render (50 visible) | <500ms |
| Film detail page render | <300ms |
| Search aggregation across 10 indexers | <35s end-to-end (parallel) |
| RSS sync for 20 indexers | <60s |
| Calendar query for 30-day window | <200ms |
| Track cleaning a 4K REMUX (9 audio + 30 sub tracks) | <30s |

### 24.2. Watchdogs
- Event loop lag >250ms for 5s → health alert.
- DB query >500ms → log warn.
- HTTP request >5s → log warn.
- Memory > 1.5GB → graceful restart (containers handle restart).

### 24.3. Capacity Limits
| Resource | Limit |
|---|---|
| Concurrent downloads (built-in engine) | 50 active, 200 queued |
| Concurrent indexer searches | 10 |
| Open file handles | 4096 (`ulimit -n` recommended) |
| `inotify` watches (Linux) | 524288 (`fs.inotify.max_user_watches` recommended) |
| SQLite WAL size cap | 10 MB before checkpoint |
| Cardigann definition cache size | unlimited (~50 MB total for 700+ definitions) |

---

## 25. Multi-User Mode (Out of Scope for V1.0; Architecture Hook)

V2.0 ships single-API-key. V2.x may add multi-user. Architecture must not preclude this.

### 25.1. Decisions That Lock
- **All API endpoints must accept a `userId` field on the auth payload** — even if v1.0 always sets it to `1`. This way v2.x can attribute writes without schema migration.
- **`acquisition_decisions`, `history`, `system_events`** include `actor_user_id` column. v1.0 always 1.
- **Settings split:** `app_settings` (system-wide) vs. `user_settings` (per-user, future). v1.0 puts everything in `app_settings`.

### 25.2. Future v2.x Plan (Documented Intent Only)
- `users` table with `(id, username, password_hash, role, created_at)`.
- Session cookies with rotation.
- Per-user library access control (M:N `users` × `libraries`).
- Per-user notification routing.
- Audit log filtering by actor.

This is **not** v1.0 scope. Document but do not build.

---

## 26. Glossary (LOCK)

A unified vocabulary across the corpus:

### 26.1. Cross-Cutting Terms
| Term | Definition |
|---|---|
| **Archivist** | The product. |
| **Museum** | The whole-system metaphor. |
| **Department** | One of seven bounded contexts: Acquisitions, Intake, Appraisal, Restoration, Vault, Galleries, Curator. |
| **Library** | A logical collection (Main Films, 4K Films, Anime, etc.). Replaces V1's "Tab". |
| **Tab** | DEPRECATED — say "Library". |
| **Compendium** | Cross-media franchise grouping (e.g. "MCU"). |
| **Exhibit** | The metadata record for a piece of media (cross-domain abstraction). |
| **Artifact** | The physical media file on disk. |
| **Lead** | A potential acquisition source (parsed search result). |
| **Quality Profile** | User-defined set of acceptable qualities + cutoff. |
| **Quality Tier** | Archivist-specific layer: hand-curated release-group tiers (1=premium, 3=last-resort). |
| **Custom Format** | Radarr-style scoring rule with specifications. |
| **Release Profile** | Required/Ignored/Preferred word lists (legacy + alongside Custom Formats). |
| **Holding Pen** | Watch folder + manual import flow. |
| **Curator** | The orchestration department; owns scheduler, FSM, integrity scanner. |
| **Indexer** | A torrent/usenet site Archivist queries. |
| **Indexer Definition** | A Cardigann YAML file describing how to scrape an indexer. |
| **FlareSolverr** | External Cloudflare-bypass proxy. |
| **State Machine** | The 7-state lifecycle FSM (upcoming → wanted → searching → acquiring → restoring → collected, plus ignored/rejected). |
| **Source Plugin** | An acquisition-source implementation (torrent indexer, direct-download site like GetComics, MangaDex). Pluggable. |
| **Hybrid Acquisition** | The pattern of treating direct-download and torrent sources as peer search backends (introduced in `kapowarr-audit.md`; conceptually applies to all domains). |

### 26.2. Domain-Specific Terms
| Term | Domain | Definition |
|---|---|---|
| **EpisodeFile** | TV | One physical video file referenced by N Episodes (multi-episode files). |
| **Edition Rule** | Films | Regex → label mapping for naming editions (Director's Cut, etc.). |
| **Track Cleaner** | Films/TV | The ffmpeg-driven track-stripping subsystem. |
| **Release Group** (music) | Music | The MusicBrainz abstract-album entity (e.g. "OK Computer" — sits between Artist and Release). |
| **Release** (music) | Music | A specific publication of a Release Group (e.g. UK CD vs US Vinyl). |
| **Recording** | Music | The actual audio entity; one Recording can appear on N Releases. |
| **Medium** | Music | A disc or side within a Release (CD 1, CD 2, Vinyl Side A). |
| **MetadataProfile** | Music/Books | Filter on which release/album/book types to monitor (Album/EP/Single/Live for music; format-class + language for books). |
| **Artist Credit** | Music/Books | Per-track or per-edition multi-role credit (featuring artists, narrators, translators). |
| **Work** | Music | MusicBrainz classical-music entity (the composition, separate from Recording). |
| **AcoustID / Chromaprint** | Music | Audio fingerprinting protocol used for track identification. |
| **BookEdition** | Books | A specific publication of a Book (format + language + publisher tuple). |
| **Book Creator** | Books | Multi-role credit (author/translator/narrator/foreword/illustrator/editor). |
| **OPF** | Books | Open Packaging Format — Calibre's canonical metadata format (`metadata.opf`). |
| **AAX/AAXC** | Books | Audible's DRM-protected audiobook formats. |
| **Comic Series** | Comics | Top-level franchise (e.g. "Amazing Spider-Man"). |
| **Comic Volume** | Comics | A numbered run within a Series (Vol. 1: 1963-1998, Vol. 2: 1999-2003). |
| **Issue Variant** | Comics | Same issue, different cover art (Cover A, B, Sketch, 1:25 ratio). |
| **Collected Edition** | Comics | TPB / HC / Omnibus / Compendium — issues bound together. |
| **Crossover Event** | Comics | Multi-series story arc (Civil War, Crisis on Infinite Earths). |
| **Story Arc** | Comics | Multi-issue story within a single series. |
| **ComicInfo.xml** | Comics | The canonical comic metadata format (Mylar/Komga/Kavita/Calibre standard). |
| **Manga / Manhwa / Manhua** | Comics | Japanese / Korean / Chinese comic traditions; treated as distinct domain in V2. |
| **Webtoon** | Comics | Korean vertical-scroll digital format; episode-per-image, not page-split. |
| **Scanlation Group** | Comics | Manga's equivalent of a scan group (fan-translated). |
| **Tankōbon** | Comics | Japanese collected-volume manga edition (≈ TPB equivalent). |
| **Pull List** | Comics | User's "interested but not auto-grab" list, distinct from monitoring. |
| **Reading Order** | Comics | Curated traversal of issues (publication, chronological, editor's, per-character). |
| **GetComics** | Comics | The primary direct-download source; a WordPress-based comic post site. |
| **Sidecar Daemon Pattern** | Engine | OPTIONAL N-API-bound libtransmission. NOT default in v1.0. |

---

## 27. Phased Build — Acceptance Criteria & Dependencies

`archivist-audit.md` §20 lists Phases 0–7 with rough timelines. Locked here are the **acceptance criteria** and **dependency graph**.

### 27.1. Phase Acceptance Gates (LOCK)
A phase is "complete" only when ALL of its gates pass:

| Phase | Gate | Reference |
|---|---|---|
| **0 — Foundation** | `bun run dev` starts both BE+FE; `/api/v1/health` returns 200; `/ping` returns 200; SSE channel emits `system:ready` event; one Drizzle migration applied. | `archivist-audit.md` §20.1 |
| **1 — Films** | Add a film via TMDB; trigger interactive search; grab; watch state transition `wanted→acquiring→restoring→collected`; verify NFO + assets on disk; track cleaner ran; integration test ✅. | `archivist-audit.md` §20.2 + `radarr-audit.md` |
| **2 — Series** | Same flow for series with: multi-episode file, season pack, anime, daily series, TBA episode handling. Per-series refresh cadence verified (1h/12h/24h/7d). XEM sync runs daily. | `archivist-audit.md` §20.3 + `sonarr-audit.md` |
| **3a — Music (MVP)** | Add artist; album list populated from MusicBrainz; per-album search; track files organised; per-artist scheduled-time refresh queue working; basic Custom Format scoring. | `lidarr-audit.md` §§11–14 |
| **3a-Extended — Music (Full)** | Items 1–14 from `lidarr-audit.md` §25 shipped. Picard-style tag rewrite at import; search-time fingerprint validation; "filtered out" Add Artist UX; Quality Tier; multi-source metadata (no `api.lidarr.audio`). | `lidarr-audit.md` §25 |
| **3b — Books + Audiobooks** | Single unified engine for ebook + audiobook (no two-instance reality); `book_editions` per format-class; audiobook chapter atoms; AAX detection; series-add wizard with discography preview. | `readarr-audit.md` §§11–26 |
| **4a — Comics (MVP)** | Add series; volume + issue list; CBZ + ComicInfo.xml emission; ComicVine direct integration. | `kapowarr-audit.md` §§13–18 |
| **4a-Extended — Comics (Full)** | Hybrid acquisition (GetComics direct-download + torrent peer sources); crossover event monitoring with reading orders; variant + collected-edition support; Series-above-Volume derivation. | `kapowarr-audit.md` §25 |
| **4b — Comics (Manga)** | Manga as peer domain: chapter-level granularity, MangaDex / AniList sources, scanlation groups, webtoons vertical-scroll, right-to-left reading direction. | `kapowarr-audit.md` §§28–29 |
| **4 — Games** | Add game; IGDB metadata; download; multi-platform handling. | `archivist-audit.md` §20.5 |
| **5 — V2 New** | Magazines + Podcasts feature-complete; Compendium UI working with 1 cross-media franchise dashboard (e.g., MCU spanning films + comics + games). | `archivist-audit.md` §20.6 |
| **6 — Polish** | All notification providers; all import lists; all health checks; Custom Format engine UI; Edition Rules UI; bulk editors per domain. | `archivist-audit.md` §20.7 |
| **7 — Engine Hardening** | All `transmission-audit.md` §35+§59 parity items implemented OR deliberately deferred with documentation. Native Torrent Engine production-readiness milestones (§30 below) all green. | `transmission-audit.md` + §30 |

### 27.2. Phase Dependencies (UPDATED)
```
Phase 0 (foundation)
  ├─→ Phase 1 (films)
  │     ├─→ Phase 2 (series)
  │     ├─→ Phase 3a (music MVP) [parallel]
  │     │     └─→ Phase 3a-Extended (music full)
  │     ├─→ Phase 3b (books + audiobooks) [parallel after 3a MVP]
  │     ├─→ Phase 4a (comics MVP) [parallel after Phase 3a MVP — uses indexer engine]
  │     │     ├─→ Phase 4a-Extended (comics full + GetComics)
  │     │     └─→ Phase 4b (comics manga)
  │     └─→ Phase 4 (games) [parallel]
  │           └─→ Phase 5 (magazines + podcasts + compendium)
  │                 └─→ Phase 6 (polish)
  │                       └─→ Phase 7 (engine hardening)
```

Domains 3a/3b/4a/4 can parallelise heavily once foundation + films exist. Each domain's MVP must complete before its Extended phase.

### 27.2. Dependency Graph
```
Phase 0 (foundation)
  ├─→ Phase 1 (films)
  │     ├─→ Phase 2 (series)
  │     ├─→ Phase 3 (music + books)  [parallel]
  │     └─→ Phase 4 (comics + games) [parallel after 3]
  │           └─→ Phase 5 (magazines + podcasts + compendium)
  │                 └─→ Phase 6 (polish)
  │                       └─→ Phase 7 (engine hardening)
```

Phases 3+4 can parallelise if engineering capacity permits.

### 27.3. Continuous Quality Gates (every PR)
- `bun run typecheck` passes.
- `bun run lint` passes.
- `bun run test` passes; coverage ≥80% on touched files.
- No new TODO comments without an issue link.
- No new `any` types without comment justification.
- Performance benchmarks within 10% of baseline.

---

## 28. Final Diagnostic — What Is and Isn't Ready

### 28.1. The Corpus Is Ready For
- **Domain modelling.** The data model is locked, schema is concrete, FSM is canonical.
- **Indexer integration.** Cardigann + Newznab + Torznab all specified to bytes.
- **Torrent engine integration.** Wire protocol, state machine, settings all specified.
- **Quality + scoring.** Algorithm is unambiguous after §3 + §4 of this doc.
- **Naming + Vault.** Token catalogue + sanitisation is concrete.
- **API surface.** Hono RPC routes + Zod schemas defined.
- **External providers.** TMDB, TVDB, MusicBrainz, ComicVine, IGDB, Google Books, Fanart.tv, OpenSubtitles, FlareSolverr — all contract-specified.

### 28.2. The Corpus Is NOT Ready For
- **Notification provider implementations.** Only matrix listed; per-provider payloads (Discord embed, SMTP MIME, Webhook JSON shape) deferred.
- **Bazarr-style multi-provider subtitles.** Only OpenSubtitles spec'd.
- **The Sidecar Daemon Pattern.** Acknowledged as optional; no spec.
- **Multi-user mode.** Architecture hooks only; full design deferred.
- **i18n.** Architecture commitment only; no string extraction tooling.
- **Mobile/PWA.** Not addressed; web-only.
- **CLI for headless ops.** Optional; not specified.
- **Browser extension** (e.g. one-click "send to Archivist" from imdb.com pages). Not specified.

### 28.3. Decision Log Required
Before construction begins, the team must lock:
1. **Notification providers shipped at v1.0** (this doc proposes 5: Discord, Email, Webhook, Plex/Emby/Jellyfin, Custom Script — confirm or amend).
2. **Quality definition default sizes** (per-resolution MB-per-min). Sonarr/Radarr ship defaults; Archivist must seed identical or document differences.
3. **Master key recovery story** for backup encryption (this doc proposes: never bundle master_key; user choice on restore).
4. **Onboarding wizard scope** (this doc proposes 9 steps; confirm).
5. **Build target binary distribution** (single-binary via `bun build --compile`? Multi-binary? Docker only?).
6. **SBOM + CVE scanning policy** (this doc proposes Trivy in CI; confirm).
7. **Telemetry consent flow** (this doc proposes off by default + opt-in modal during onboarding; confirm).

### 28.4. Documentation Gaps to Close Before V1.0
- **`README.md`** — quick-start with `docker run` and bare-metal commands.
- **`CONTRIBUTING.md`** — how to add a new media type, a new indexer, a new notification provider.
- **`ARCHITECTURE-DECISIONS.md`** — log of every locked decision in this doc + reasoning + alternatives considered.
- **`DEPLOYMENT.md`** — reverse proxy, VPN, SSL, backup procedures.
- **`API.md`** — generated from Zod schemas via `zod-openapi` or hand-rolled OpenAPI 3.1 spec.
- **`TROUBLESHOOTING.md`** — common errors + fixes.

---

## 29. Final Verdict

**The audit corpus is ~85% ready to support a blank-slate V2 rebuild.**

The remaining 15% is the operational layer captured in this document (§§8–25): logging conventions, error taxonomy, security model, threading, dev setup, testing strategy, CI/CD, containerisation, reverse-proxy patterns, VPN integration, backup/restore, onboarding, accessibility, performance budgets, capacity limits, multi-user hooks, glossary, and phased build acceptance gates.

A re-implementer reading this corpus end-to-end (in order: `ARCHITECTURE.md` → `archivist-audit.md` → upstream audits as referenced → this `unified-audit.md`) has the complete spec needed to ship V2 in ~24 weeks per the phased plan.

**The riskiest unresolved item:** the Cardigann template engine. Allocate 6 weeks of focused engineering by a single senior developer who can read Go templates and produce a hand-rolled `{{ }}` evaluator. Don't ship Nunjucks; the community-definition breakage rate is too high.

**The most underestimated item:** track cleaning. V1 ships a working version, but the validation pipeline (chapter-regression detection, audio-track-zero-after-clean rejection, atomic rollback) is what separates "novelty feature" from "production-ready file mutation." Spend the time.

**The most-likely-to-be-skipped item:** the FSM transition table. Without explicit guard rails, departments will quietly mutate state directly and the system will drift into impossible states. Build the FSM first; refuse to merge code that bypasses it.

**The Museum is open. Build it correctly, build it once.**

---

## 30. Native Torrent Engine — Production-Readiness Plan (LOCK)

The pure-TS engine choice (§C7 LOCK) requires explicit validation gates. This section is the contract: **V1.0 cannot ship until all three milestones pass.** A failed milestone blocks release until remediated. The plan answers the question "how do we know pure-TS is robust enough?" with concrete tests, not aspiration.

### 30.1. The Premise

V1's `@torrentstack/torrent-engine` already ships:
- ✅ Bencode codec
- ✅ BEP 3 wire protocol + handshake
- ✅ Fast Extension (BEP 6)
- ✅ Extension Protocol (BEP 10) + ut_metadata (BEP 9)
- ✅ MSE/PE handshake (verify against `transmission-audit.md` §37 — including the 1024-byte RC4 burn)
- ✅ HTTP tracker (BEP 23 compact)
- ✅ UDP tracker (BEP 15)
- ✅ DHT (Mainline BEP 5) — basic
- ✅ PEX (BEP 11)
- ✅ LPD (BEP 14)
- ✅ Webseeds (BEP 19)
- ✅ Metainfo v1; v2/hybrid (BEP 52) partial
- ✅ Worker-pool piece verification
- ✅ Resume files
- ✅ Storage layer
- ✅ Swarm management
- ✅ Bandwidth (token bucket)
- ✅ Port forwarding (UPnP / NAT-PMP)
- ⚠️ uTP (BEP 29) — present but incomplete; **shipped TCP-only at V1.0 per §C7**
- ❌ BEP 42 secure node id — **TODO**
- ❌ Lazy bitfield (have_all/have_none) — **TODO**
- ❌ Hashfail peer banning (3-strikes) — **TODO**
- ❌ Stalled detection — **TODO**
- ❌ Free-space preflight — **TODO**

The protocol layer is ~85% there. Phase 7 is hardening + parity, not greenfield protocol implementation.

### 30.2. The Three Milestones

Each milestone has hard pass/fail criteria. **Failing any milestone blocks V1.0 ship.**

#### Milestone 1 — Protocol Correctness (weeks 1–4 of Phase 7)

**Goal:** prove every byte on the wire is correct.

| Test | Pass criteria |
|---|---|
| Wire-protocol oracle | Run `libtransmission` (or `qBittorrent-nox`) locally as oracle. Connect Archivist as a peer; transfer a 100 MB test torrent both ways. **Both sides report 100% complete with verified hashes.** |
| MSE handshake — strict tracker | Stand up a private-tracker test instance configured `encryption=required`. Archivist's MSE handshake succeeds; plaintext peers are rejected; **0 silent corruption** (the 1024-byte burn bug). |
| BEP 9 metadata fetch | Add 10 magnet URIs with no peers warm; metadata downloaded + verified within 30s once peers join via DHT. |
| DHT bootstrap convergence | Cold start with empty `dht.dat`. Within **60s** the routing table contains **≥100 nodes**, distributed across at least 4 k-buckets. |
| BEP 42 secure node id | Generated node id passes BEP 42 verification (CRC32C against IP + secret). |
| PEX in public swarm | Join a popular public-swarm torrent (e.g., latest Ubuntu ISO). Within **5 minutes** receive at least 3 peers via PEX (not via tracker). |
| LPD multicast | Two Archivist instances on same LAN discover each other via LPD within 60s of starting the same torrent. |
| Piece verification — false-positive guard | Verify 100 known-good torrents end-to-end. **Zero false positives** (no good piece marked corrupt). |
| Piece verification — false-negative guard | Tamper with 1 byte in 10 torrents; engine detects corruption on every one. **Zero false negatives.** |
| Resume file round-trip | 50-torrent library; clean shutdown; restart; bitfield + per-file priorities + cookie state preserved exactly. |
| Tracker tier failover (BEP 12) | Tracker tier 1 returns 503; engine moves to tier 2 within 30s; on tier 1 recovery, sticky-promotion advances tier 1 to head. |
| Lazy bitfield | A 100% seed sends `have_all` after handshake (not bitfield). Wireshark capture confirms. |
| Hashfail peer ban (3 strikes) | Mock peer sends 3 corrupt pieces; banned for the rest of the session; reconnect attempts dropped. |

**Milestone 1 gate:** all 12 tests pass. Failures get fixed before Milestone 2 starts.

#### Milestone 2 — Performance (weeks 5–8)

**Goal:** prove pure-TS is fast enough to be invisible.

| Benchmark | Pass criteria |
|---|---|
| TCP-only download throughput | Download a 5 GB Linux ISO from same swarm position as qBittorrent in **≤1.5× qBit's time**. (We don't claim parity; we claim "good enough.") |
| 50-concurrent-torrent 24h soak | 50 active torrents with mixed sizes. After 24h: **memory growth ≤10 MB**, zero open-socket leaks, zero crashed worker threads. |
| Hash verification throughput | Sustained **≥500 MB/s** on a 4-core CPU using the worker pool. |
| Piece-picker latency | <1 ms median, <10 ms p99 for "choose next piece" decisions across 100k iterations. |
| Disk I/O — SSD | Sustained write ≥**200 MB/s** with cache-aware coalescing. |
| Disk I/O — HDD | Sustained write ≥**80 MB/s** (cache-coalescing critical here per `transmission-audit.md` §24.3). |
| Memory ceiling | Steady-state memory at 50 active torrents ≤**800 MB**. |
| Event-loop lag under load | p99 lag ≤**50 ms** with 200 concurrent peers across 10 torrents. |
| Cross-platform parity | Above benchmarks within 10% of each other on Linux amd64, Linux arm64, macOS arm64. |

**Milestone 2 gate:** all 9 benchmarks pass. Performance regressions get profiled + fixed before Milestone 3.

#### Milestone 3 — Real-World Compatibility (weeks 9–12)

**Goal:** prove the engine survives in actual swarms with actual trackers.

| Test | Pass criteria |
|---|---|
| Public-tracker compatibility | Grab + complete + seed for 24h on **10 different public trackers** (rarbg-equivalents, archive.org, academictorrents, etc.). All 10 report healthy stats. |
| Private-tracker compatibility | Set up dev account on **at least 1 real private tracker** (a maintainer's account). Grab + complete + seed for **48h**. Tracker reports: announce healthy, no peer-id flag, no MSE failure, ratio counts correctly. |
| Anti-bot — peer-id whitelisting | Peer-id `-TR4060-XXXXXX` form (per `transmission-audit.md` §47) accepted by all 10 public + 1 private tracker. |
| Anti-bot — MSE-required swarm | Engine handshake succeeds against an MSE-required private peer; plaintext rejected. |
| Cookie / session persistence | After 7-day uptime, all per-tracker cookies still valid; auto-renew on expiry; re-login flow recovers from session loss. |
| Concurrent peer scale | 200 active peers across 10 torrents; sustained for 1h with no degradation in download rate or peer-list churn. |
| Free-space preflight | `torrent-add` rejects when disk free < (size + 100 MB); UI surfaces user-readable error. |
| Stalled detection | Torrent with 0 progress + ≥1 peer for `queue-stalled-minutes` flagged `isStalled=true`; UI shows; deprioritised by scheduler. |
| Atomic resume-file writes | Kill -9 the process during heavy writing; on restart, resume files are intact; no partial writes. |
| Cross-FS hardlink fallback | Move a torrent file from `/data` (ext4) to `/media` (NFS). Engine detects EXDEV; copies + verifies + unlinks; pauses torrent during copy; resumes after. |

**Milestone 3 gate:** all 10 tests pass. Failures here are blockers — the engine can't ship to real users until this passes.

### 30.3. Required Test Infrastructure

To run the milestones, the team needs:
1. **A reference oracle:** local libtransmission (or qBittorrent-nox) running on the dev machine for byte-for-byte protocol comparison.
2. **A private-tracker dev account.** Many private trackers offer maintainer/dev accounts for client developers; reach out to 1–2 community-friendly ones (e.g., a music tracker or a Linux-ISO-focused tracker).
3. **A test-swarm bootstrap:** internal qBit + Transmission instances running on the LAN, joined to controlled torrents the engine can connect to. (Ubuntu ISOs are public-domain and ideal.)
4. **A soak-test harness:** Bun script that spawns the engine, adds N torrents, monitors RSS + open-handles + event-loop lag for 24h.
5. **A protocol fuzzer (optional but recommended):** fuzz BEP 3 wire messages with malformed inputs; engine must reject without crashing.
6. **CI gate:** Milestones 1 + 2 must pass on every PR to `main` once they're green; Milestone 3 runs nightly.

### 30.4. Documentation Outputs

When the engine passes all three milestones, produce:
- **`engine-readiness.md`** — public-facing report with benchmarks, swarm-test results, known limitations (uTP), and the escape hatch (external clients).
- **`engine-architecture.md`** — internal doc: which BEPs we implement, what we defer, the threading model, the GC-aware design choices (avoiding closures-per-message etc.).
- **`engine-changelog.md`** — every protocol change between V2 versions; consumed by the upgrade-protocol-compatibility test.

### 30.5. The Escape Hatch (Always Available)

`archivist-audit.md` §8.3 already specifies the external download-client adapters (qBittorrent, Transmission, SABnzbd, NzbGet). **This is not a fallback for engine failures — it's a first-class equal partner.** Users who need:
- mandatory-uTP private trackers
- multi-gigabit throughput per torrent (rare but exists)
- features the built-in engine doesn't yet ship (encrypted incomplete dirs, sequential-streaming HLS server, etc.)

…can configure qBittorrent or Transmission alongside the built-in engine. Archivist routes per-torrent based on indexer tag or download-client priority.

This means the worst-case scenario for the built-in engine is "users opt out and use qBit." It is **never** a ship-blocker.

### 30.6. The Realistic Confidence Statement

After auditing V1's `@torrentstack` engine code state + the Transmission audit's parity items + the actual engineering effort required:

- **High confidence (>90%):** Milestone 1 passes within 4 weeks. The protocol layer is mostly there; what's missing (BEP 42, lazy bitfield, hashfail bans) is straightforward to implement.
- **High confidence (>85%):** Milestone 2 passes within 4 more weeks. Performance bottlenecks in pure-TS are well-understood; profile + fix is methodical.
- **Medium-high confidence (>70%):** Milestone 3 passes within 4 more weeks. Real-world swarm behaviour is harder to predict; budget for 1–2 weeks of "weird tracker bugs" debugging.

**Total: 12 weeks of focused engineering by 1 senior dev to take the engine from V1 state to V2 production-ready.** This is consistent with the Phase 7 estimate in `archivist-audit.md` §20.7.

If any milestone slips, the response is:
- Slippage <2 weeks → push V1.0 ship date.
- Slippage >2 weeks → escalate; consider scope-cutting Phase 6 features to free up engineering time.
- Catastrophic failure (e.g., MSE silently corrupting on real private trackers and we can't fix it) → switch to "Option C hybrid": ship pure-TS as default, document N-API binding as opt-in for users who hit the limitation. Never abandon pure-TS as the default — that would orphan the product identity.

The plan is robust against everything except a fundamental discovery that pure-TS literally cannot do BitTorrent correctly. **That discovery is unlikely**: WebTorrent ships in production for millions of users; rTorrent's protocol layer is 80% portable to TS; uTorrent's wire format is fully specified. What's hard about pure-TS BitTorrent is *speed*, not *correctness* — and the 1.5× qBit benchmark target acknowledges this honestly.

---

## 31. Documentation Cleanup Action Items

After this unified audit pass:
1. ✅ `ARCHITECTURE.md` — DEPRECATED. Safe to delete; all content folded into `archivist-audit.md`.
2. ✅ Pure-TS engine choice locked across `archivist-audit.md` §8.2 + §C7 of this doc.
3. ✅ Engine production-readiness plan added (§30 above).
4. ⏳ Once Milestones 1+2 pass: write `engine-readiness.md` summarising the benchmarks for users.
5. ⏳ Once V1.0 ships: archive the audit corpus into `docs/v1-build-bible/` and start a new `CHANGELOG.md` for V2.x evolution.

---

## 32. Audit Corpus Inventory (LOCK)

The complete audit corpus, with domain coverage and last-updated state:

### 32.1. Core Specs
| Document | Lines | Domain | Role |
|---|---|---|---|
| `archivist-audit.md` | ~4060 | All cross-cutting | The rebuild bible. V2 stack, departments, FSM, schema base, command pattern, naming engine, security model. **Subsumes `ARCHITECTURE.md`.** |
| `unified-audit.md` (this) | ~1700+ | Cross-doc resolution | Operational layer (logging, errors, deployment, testing, CI/CD), cross-doc precedence, glossary, phase gates, engine production-readiness plan. |

### 32.2. Upstream Behavioural References
| Document | Lines | Original Tool | Used For |
|---|---|---|---|
| `radarr-audit.md` | ~760 | Radarr | Custom Format engine + Quality Definitions size envelopes (inherited by all media domains). |
| `sonarr-audit.md` | ~1760 | Sonarr | Per-entity refresh cadence, command catalogue, provider matrix, parser dispatch, 4-level data model, MonitorTypes. |
| `prowlarr-audit.md` | ~2260 | Prowlarr | Cardigann YAML execution, indexer protocols (Newznab/Torznab), FlareSolverr, definition repository sync. |
| `transmission-audit.md` | ~2030 | Transmission | Embedded torrent engine — wire protocol, state machine, BEP catalogue, MSE/PE handshake, RPC. |

### 32.3. V2 Domain Modules
| Document | Lines | Domain | Replaces / Improves |
|---|---|---|---|
| `lidarr-audit.md` | ~2390 | Music | Lidarr — multi-source metadata kills the `api.lidarr.audio` SPOF; per-artist scheduled-time refresh kills the storm pathology; Picard-style re-tag at import; search-time fingerprint validation; classical music as first-class. |
| `readarr-audit.md` | ~1600 | Books + Audiobooks | Readarr — single unified engine kills the two-instance reality (`readarr` + `readarr-audio`); first-class audiobook chapters; Audible source integration; AAX detection; series-first monitoring; multi-role creator credits (translator/narrator/foreword). |
| `kapowarr-audit.md` | ~3000 | Comics + Manga | Kapowarr — hybrid acquisition (GetComics + torrents as peer sources); crossover event monitoring; variant + collected-edition modelling; manga as peer domain (chapter granularity, scanlation groups, webtoons); Mylar3 migration path. |

### 32.4. Domain Coverage Matrix
| Domain | Primary Audit | Cross-References |
|---|---|---|
| Films | `radarr-audit.md` | + `archivist-audit.md` for V2 schema |
| TV / Series | `sonarr-audit.md` | + `archivist-audit.md` |
| Music | `lidarr-audit.md` | + `radarr-audit.md` (Custom Formats) + `archivist-audit.md` |
| Books / Audiobooks | `readarr-audit.md` | + `lidarr-audit.md` (per-entity refresh) + `archivist-audit.md` |
| Comics / Manga / Webtoons | `kapowarr-audit.md` | + `readarr-audit.md` (ComicInfo.xml ≈ OPF) + `archivist-audit.md` |
| Games | (Phase 4; lighter spec in `archivist-audit.md`) | + IGDB integration from `archivist-audit.md` §32.5 |
| Magazines | (Phase 5; `archivist-audit.md` §15.5) | New domain |
| Podcasts | (Phase 5; `archivist-audit.md` §15.5) | New domain |
| Indexers | `prowlarr-audit.md` | All domains use the indexer engine |
| Torrent engine | `transmission-audit.md` | All torrent-grab domains |

---

## 33. Cross-Domain Architecture (LOCK)

V2's unified `archivist.sqlite` houses **8+ media domains** (films, series, music, books, comics, games, magazines, podcasts) in one schema. This section addresses the architectural concerns that arise from coexistence.

### 33.1. The `library_id` Discriminator

Per `archivist-audit.md` §15, every domain entity has a `library_id` foreign key. Each library has a `media_type` discriminator (`'films'|'series'|'music'|'books'|'comics'|'games'|'magazines'|'podcasts'`). UI surfaces filter by `media_type`; backend queries do too.

**Implication:** all domain queries must include `library_id` filter (or join through the parent entity that does). Cross-library queries are rare and explicit (Compendium dashboards, omni-search).

### 33.2. Naming Collisions Between Domains

Several domains use overlapping table-name candidates. Lock conventions:

| Naming Conflict | Resolution |
|---|---|
| Sonarr's `series` vs Kapowarr's `comic_series` | **Both prefixed:** `series` (TV) + `comic_series` (comics). Migration cost: rename Sonarr's table to `tv_series` if disambiguation needed. |
| Lidarr's `tracks` vs Readarr's "track files" | Lidarr: `tracks`. Readarr: `book_files`. No conflict; just be precise in casual conversation. |
| Multiple "release" entities | **Music:** `releases` (per release group). **Books:** `book_editions`. **Comics:** `comic_files` (per issue/variant/edition). **Films/TV:** no canonical "release" entity — releases are search results, not persisted. |
| "Volume" overlap | **Comics:** `comic_volumes`. **Books:** book series can have volumes; modelled as `book_series.volume_position`. Manga: `manga_chapters.volume_number` for tankōbon. **No table-name collision.** |
| "Edition" overlap | **Films:** `film_editions`. **Books:** `book_editions`. **Comics:** `comic_collected_editions` (TPB/HC). **Music:** uses `releases` (no "edition" terminology). All three film/book/comic edition tables coexist; prefixed by domain. |
| "Episode" — TV only | TV `episodes` is unique to that domain. Podcasts have `podcast_episodes`. **No collision.** |

Lock: **always prefix domain-specific tables with their domain noun** (`comic_series`, `comic_volumes`, `comic_issues`; `book_editions`; `manga_chapters`). Films/TV/games can use unprefixed names because they ship first and define the canonical singletons.

### 33.3. Compendium as Cross-Domain Glue

A Compendium spans media types (e.g., the Marvel Cinematic Universe contains films + TV series + comics + games + tie-in books). Per `archivist-audit.md` §15.5, every domain entity has an optional `compendium_id` foreign key.

**Compendium queries are the primary cross-domain queries.** UI's Compendium dashboard:
```sql
-- For a single Compendium ID, surface entities across domains
SELECT 'film' as type, id, title FROM films WHERE compendium_id = ?
UNION ALL
SELECT 'series' as type, id, title FROM series WHERE compendium_id = ?
UNION ALL
SELECT 'music_album' as type, id, title FROM albums a JOIN release_groups rg ON ... WHERE rg.compendium_id = ?
UNION ALL
SELECT 'book' as type, id, title FROM books WHERE compendium_id = ?
UNION ALL
SELECT 'comic_series' as type, id, name as title FROM comic_series WHERE compendium_id = ?
UNION ALL
SELECT 'game' as type, id, title FROM games WHERE compendium_id = ?
ORDER BY type, title
```

Performance: each domain's `compendium_id` should be indexed (per-table partial index). Compendium queries should be sub-200ms even for large Compendiums (MCU has 30+ films + 20+ TV series + 5000+ comics).

### 33.4. Shared vs Domain-Specific Tables

**Shared (singleton):** Used by all domains.
- `libraries`, `compendiums`, `tags`, `app_settings`
- `quality_definitions`, `quality_profiles`, `custom_formats`, `release_profiles`
- `quality_tiers` (per-media-type rows)
- `indexers`, `indexer_status`, `indexer_proxies`
- `download_clients`, `root_folders`
- `system_jobs`, `system_events`, `media_imports`, `history`
- `notifications`, `notification_status`, `notification_targets`
- `import_lists`, `import_list_status`, `import_exclusions`
- `acquisition_decisions`, `release_blocklist`
- `file_host_status` (NEW from `kapowarr-audit.md` §10.4)

**Domain-specific:** Each domain ships its own set of entity tables. See per-domain audit for full list.

### 33.5. Indexer Reuse Across Domains

A single indexer instance (e.g., a configured Newznab) can serve multiple domains. Tag-based routing per `archivist-audit.md` §27.8 + per-domain Newznab category mapping (§27 in this doc):

| Domain | Newznab Categories |
|---|---|
| Films | 2000 (Movies) + subs |
| TV | 5000 (TV) + 5070 (Anime) |
| Music | 3000 (Audio) + 3030 (Audiobook) + 3040 (Lossless) |
| Books | 7000 (Books) + 7020 (E-Books) + 7050 (Audio Books) |
| Comics | 7030 (Comics) + sometimes 7000 |
| Games | 1000 (Console) + 4000 (PC) |

Per-search categories filtered by media_type; per-indexer enabled-categories override.

### 33.6. Source Plugin Architecture (NEW from Comics)

Per `kapowarr-audit.md` §10, comics introduce **direct-download sources** (GetComics, MangaDex) as peer to torrent indexers. The unified abstraction:

```ts
interface AcquisitionSource {
  id: string
  name: string
  type: 'torrent' | 'usenet' | 'direct-download' | 'streaming-strip'
  domain_filter: ('films'|'series'|'music'|'books'|'comics')[]   // which domains use this source
  // ... per-implementation fields
}
```

**Other domains may want direct-download too:**
- **Books:** Project Gutenberg (public-domain ebooks) → direct download.
- **Music:** Bandcamp direct-download for paid albums.
- **Films:** Internet Archive's free public-domain film collection.

The source-plugin architecture introduced for comics generalises across all domains. **V2's Phase 4a-Extended infrastructure should be re-used by other domains in later phases.**

### 33.7. Per-Domain Engine Reuse

Domains share these engines:
- **Indexer engine** (Newznab/Torznab/Cardigann) — `prowlarr-audit.md`. Reused across films/TV/music/books/comics.
- **Torrent engine** — `transmission-audit.md`. Reused everywhere torrents are downloaded.
- **Custom Format engine** — `radarr-audit.md` §17. Reused with per-domain spec extensions (§3 above).
- **State machine** (FSM) — §5 above. Same 7-state lifecycle for every domain entity.
- **Job runner** — `archivist-audit.md` §13.2. Per-domain commands enqueue the same way.
- **Notifications** — `sonarr-audit.md` §22. Per-domain event triggers; same provider matrix.

### 33.8. Per-Domain Media Server Sync

Different domains map to different media servers:
| Domain | Media Server |
|---|---|
| Films / TV / Music | Plex / Emby / Jellyfin (refresh trigger per `sonarr-audit.md` §23.1) |
| Books / Audiobooks | Calibre Server / Audiobookshelf |
| Comics / Manga | Komga / Kavita |

V2's notification provider matrix needs per-domain target specs. Per-server health check.

---

## 34. Final Diagnostic — Updated for Expanded Scope

### 34.1. The Corpus Is Ready For
- **All cross-cutting decisions:** stack, FSM, departments, error model, deployment, security, testing, CI/CD.
- **All four primary media domains** (films, TV, music, books/audiobooks, comics/manga): full data models, parser specs, search shapes, decision algorithms, naming engines, import pipelines.
- **Indexer integration:** Newznab/Torznab/Cardigann fully spec'd via `prowlarr-audit.md`.
- **Torrent engine integration:** wire protocol + state machine + BEP catalogue via `transmission-audit.md`.
- **Hybrid acquisition pattern:** torrent + direct-download (GetComics) as peer sources via `kapowarr-audit.md`; generalises to other domains.
- **Multi-source metadata** with merge-precedence rules per domain.

### 34.2. The Corpus Is NOT Ready For
- **Games domain detail** — `archivist-audit.md` covers basics; no dedicated audit. (Possibly Phase 4-time deliverable.)
- **Magazines + Podcasts** — schema only; no behavioural depth. (Phase 5 deliverable.)
- **Multi-user / SSO / OIDC** — explicitly out-of-scope for v1.0.
- **Reading-progress sync** for any domain — out-of-scope (consumer media-server territory).
- **Streaming-strip integrations** (Marvel Unlimited, DC Universe Infinite, Audible-DRM-removal) — legally murky; never bundle.
- **Webcomic archiving** — flagged as Phase 7+ in `kapowarr-audit.md`.
- **Mobile / PWA** — web-only at v1.0.

### 34.3. The 6 Killer Features That Define V2

Across the four primary media domains, each audit identified its own "killer features." Combined, V2's identity rests on:

1. **Track Cleaner** (Films/TV) — ffmpeg-driven track-stripping; 30-60% storage savings on multi-language 4K REMUX.
2. **Search-Time Audio Fingerprinting** (Music) — mislabeled releases rejected before they enter the library.
3. **Picard-Style Tag Re-Write** (Music + Books) — every imported file has consistent canonical tags.
4. **Single Unified Books + Audiobooks Engine** (Books) — kills the Readarr two-instance reality.
5. **Hybrid Acquisition + Crossover Event Monitoring** (Comics) — GetComics + torrents in one tool with cross-source failover; "Monitor Civil War" delivers 50 issues across 15 series.
6. **The Museum Metaphor + Modular Monolith** (cross-cutting) — the architecture is itself a feature; onboarding is fast because the metaphor pays off.

If V2 ships only these 6, it's already the **best self-hosted media acquisition platform in existence** across all four primary domains.

### 34.4. Estimated Total Engineering Effort
- **Phase 0 (Foundation):** 2 weeks.
- **Phase 1 (Films):** 4 weeks.
- **Phase 2 (Series):** 4 weeks.
- **Phase 3a (Music MVP):** 3 weeks.
- **Phase 3a-Extended (Music Full):** 5–6 weeks.
- **Phase 3b (Books + Audiobooks):** 6–8 weeks.
- **Phase 4a (Comics MVP):** 3 weeks.
- **Phase 4a-Extended (Comics Full + GetComics):** 6–8 weeks.
- **Phase 4b (Manga + Webtoons):** 4 weeks.
- **Phase 4 (Games):** 2 weeks.
- **Phase 5 (Magazines + Podcasts + Compendium):** 3 weeks.
- **Phase 6 (Polish):** 4 weeks.
- **Phase 7 (Engine Hardening):** 12 weeks (per §30 production-readiness plan).

**Total (sequential):** ~62–68 weeks.

**Total (with parallelisation across domain phases 3+4):** ~40–45 weeks for a single senior dev; faster with multiple devs working different domain modules.

The Museum is fully spec'd across all primary domains. Build it.
