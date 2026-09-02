---
title: "Feature Spec — Lists"
document_type: feature-specification
status: historical
classified: 2026-08-16
---
# Feature Spec — Lists

**Target:** `archivist-lab/archivist`
**Status:** ready to implement
**Prereqs:** none — additive. Replaces the stateless `list-imports` preview with a stateful engine.

---

## 1. Goal

A user-generated library of **Lists**. A List is a saved set of filter criteria —
"horror, 1978–1989, rated above 6.5, runtime under 110 minutes" — that Archivist
re-evaluates on a schedule against its metadata sources.

When a List gains a member Archivist doesn't hold, the List does one of two things
depending on how it's configured:

| Mode | Behaviour |
|------|-----------|
| **Approval** | The new item queues for review. A badge appears on the dashboard. The user adds or dismisses. |
| **Auto-add** | The item is added to the target library as monitored, and the release pipeline takes it from there. |

Everything is built in-house. **No third-party list services.** Phase 1 evaluates
filters against TMDB; phase 2 swaps in Archivist's own metadata service with no
change to saved Lists (§4).

### Non-goals

- No MDBList, Trakt or Letterboxd API integration. The existing `list-imports`
  connectors are superseded (§10).
- No hosted sharing or publishing service. Portable YAML import/export is supported.
- No per-item quality overrides. A List has one target profile.

---

## 2. Architecture — two boundaries that matter

Get these two seams right and everything else is mechanical.

### 2.1 Filter definition vs filter execution

**A saved List must never store provider query parameters.**

If a List persists `{ with_genres: "27", "vote_average.gte": 6.5 }`, TMDB's API has
been serialised into the database and every saved List breaks when the backend
changes. Instead, store a provider-agnostic **filter AST**, and treat each metadata
source as a **compiler target**.

```
FilterAST  ──►  TmdbDiscoverCompiler   (phase 1)
           └─►  LocalCatalogCompiler   (phase 2, own metadata service)
```

Phase 2 then adds a compiler, not a migration.

### 2.2 Membership vs reconciliation

The **reconciliation engine** — fetch members, diff against last known, classify new
arrivals, notify or add — is entirely source-agnostic. Filters are one membership
provider. Keep the engine ignorant of where members came from.

---

## 3. Data model

Add to `packages/db/src/schema.ts`; register additive migrations in
`packages/db/src/migrations.ts`.

```sql
-- A saved, user-defined List. Membership is recomputed on a schedule; the filter
-- itself is stored as a provider-agnostic AST (see FilterAST) so the execution
-- backend can change without touching saved lists.
CREATE TABLE IF NOT EXISTS lists (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id          INTEGER NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  media_type          TEXT NOT NULL CHECK (media_type IN ('film', 'series')),
  filter              TEXT NOT NULL DEFAULT '{}',   -- FilterAST as JSON
  mode                TEXT NOT NULL DEFAULT 'approval' CHECK (mode IN ('approval', 'auto')),
  enabled             INTEGER NOT NULL DEFAULT 1,
  -- add targets, resolved against the library's scoped config
  root_folder_id      INTEGER,
  quality_profile_id  INTEGER,
  monitored           INTEGER NOT NULL DEFAULT 1,
  -- guardrails (see §7)
  max_adds_per_run    INTEGER NOT NULL DEFAULT 10,
  member_cap          INTEGER NOT NULL DEFAULT 500,
  -- scheduling
  refresh_interval_hours INTEGER NOT NULL DEFAULT 24,
  last_refreshed_at   TEXT,
  last_error          TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (library_id, name)
);

-- Known membership. One row per (list, item) ever seen. Rows are never deleted on
-- a member leaving the list — status moves to 'departed' instead, so history and
-- prior decisions survive.
CREATE TABLE IF NOT EXISTS list_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id       INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  media_type    TEXT NOT NULL CHECK (media_type IN ('film', 'series')),
  tmdb_id       INTEGER,
  tvdb_id       INTEGER,
  imdb_id       TEXT,
  title         TEXT NOT NULL,
  year          INTEGER,
  poster_path   TEXT,
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'added', 'dismissed', 'in_library', 'departed', 'failed')),
  status_reason TEXT,
  library_item_id INTEGER,          -- films.id / series.id once added
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT,
  UNIQUE (list_id, media_type, tmdb_id)
);

CREATE INDEX IF NOT EXISTS idx_list_items_pending
  ON list_items(list_id, status, first_seen_at DESC);

-- Per-run audit. Mirrors the philosophy of acquisition_decisions: automation
-- should be inspectable, not mysterious.
CREATE TABLE IF NOT EXISTS list_refresh_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id       INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  fetched       INTEGER NOT NULL DEFAULT 0,
  new_items     INTEGER NOT NULL DEFAULT 0,
  auto_added    INTEGER NOT NULL DEFAULT 0,
  departed      INTEGER NOT NULL DEFAULT 0,
  capped        INTEGER NOT NULL DEFAULT 0,   -- adds withheld by max_adds_per_run
  error         TEXT
);
```

### Notes

- `UNIQUE (list_id, media_type, tmdb_id)` — TMDB ID is the join key in phase 1.
  `tvdb_id` is populated where known but is not the identity column.
- `status = 'in_library'` covers items already held when first seen. They must never
  raise a notification — a new List over an established library would otherwise fire
  hundreds of alerts on its first run.
- `library_id` scoping follows the existing convention; `root_folder_id` and
  `quality_profile_id` resolve against that library's scoped config.

---

## 4. The filter AST

New file `packages/contracts/src/lists.ts`, Zod-validated, exported from `index.ts`.

```ts
export type FilterNode =
  | { op: 'and'; nodes: FilterNode[] }
  | { op: 'or'; nodes: FilterNode[] }
  | { op: 'not'; node: FilterNode }
  | { op: 'genre'; mode: 'includes' | 'excludes'; values: string[] }
  | { op: 'year'; min?: number; max?: number }
  | { op: 'rating'; source: 'provider'; min?: number; max?: number; minVotes?: number }
  | { op: 'runtime'; min?: number; max?: number }
  | { op: 'language'; values: string[] }
  | { op: 'certification'; country: string; values: string[] }
  | { op: 'keyword'; mode: 'includes' | 'excludes'; values: string[] }
  | { op: 'person'; role: 'cast' | 'crew' | 'any'; ids: number[] }
  | { op: 'company'; ids: number[] }
  | { op: 'watchProvider'; region: string; ids: number[] }
```

Use **semantic values, not provider IDs**, wherever a stable vocabulary exists —
`genre: ['horror']`, not `with_genres: '27'`. The compiler maps to provider IDs.
Where no stable vocabulary exists (keywords, people, companies) provider IDs are
acceptable, but store the display label alongside so the UI survives a backend swap.

### 4.1 Compiler interface

```ts
export interface FilterCompiler {
  readonly id: string
  /** Which ops this backend can evaluate natively. */
  supports(op: FilterNode['op']): boolean
  /** Compile to a backend query plus any nodes needing local post-filtering. */
  compile(ast: FilterNode, mediaType: 'film' | 'series'): CompiledQuery
  execute(query: CompiledQuery, opts: { limit: number; since?: string }): Promise<ListMember[]>
}
```

Unsupported nodes are **post-filtered locally** where the data is available, and
otherwise **reported as unsupported** so the UI can grey the control out. Never
silently drop a filter clause — a List that quietly ignores half its criteria is
worse than one that refuses to save. This mirrors the capability negotiation
already used by `player/playback-plan.ts`.

---

## 5. Phase 1 — the TMDB compiler

`apps/server/src/lists/compilers/tmdb.ts`, wrapping `/discover/movie` and
`/discover/tv`.

Native mappings: genres, release-date range, `vote_average` with a `vote_count`
floor, runtime bounds, original language, certification by country, keywords,
companies, cast/crew, watch providers by region.

### 5.1 The sort-stability trap

**Never sort discover results by popularity.** Popularity shifts daily, so items
drift in and out of the result window and the diff manufactures phantom "new"
arrivals for titles that were always members.

Sort by a stable key — release date, or TMDB ID — for anything feeding the diff.

### 5.2 Watermarking

For finding *new arrivals* specifically, sort by release date descending and apply a
`primary_release_date.gte` watermark from the previous run rather than re-paging the
whole result set. This is the same watermark-plus-recent-window pattern
`release-pipeline/poller.ts` already uses for RSS.

Full re-pages should still happen periodically (weekly) to catch back-catalogue
additions and departures.

### 5.3 Ceilings

TMDB `/discover` caps out around 10,000 results. A loose filter hits it. Detect the
ceiling, stop paging, record `capped` on the run, and surface a clear warning on the
List: *"This filter matches more than 10,000 titles — narrow it."*

### 5.4 Known gap — aggregated ratings

TMDB exposes only its own `vote_average`, which diverges noticeably from IMDB.
Filtering on IMDB, Rotten Tomatoes or Metacritic scores is **not possible in phase 1**
and the UI should not offer it.

The on-thesis fix, if wanted later: IMDB publishes bulk dataset files
(`title.ratings.tsv.gz` and friends, refreshed daily) which can be ingested into the
local database, giving IMDB rating and vote count for filtering with no runtime
third-party dependency. Have each instance fetch them rather than shipping them in
the image — the licence is personal/non-commercial and redistribution is a separate
question. Model this as `{ op: 'rating'; source: 'imdb'; ... }` so the AST is already
shaped for it.

### 5.5 Series identity

Discovery runs against TMDB for both media types, but series identity in the schema
is TVDB-keyed. This is already handled — `createSeriesFromMetadata(db, libraryId,
{ tvdbId?, tmdbId? }, opts)` accepts a TMDB ID directly. Store both IDs on
`list_items` where available.

---

## 6. The reconciliation engine

`apps/server/src/lists/` — new module.

```
routes.ts        API surface, mounted at /lists via routes.ts registry
service.ts       CRUD, preview, manual refresh
engine.ts        fetch → diff → classify → notify/add
scheduler.ts     due-list selection, backoff
compilers/
  tmdb.ts
  index.ts       compiler registry
```

### 6.1 Refresh run

Registered as a job handler via `registerJobHandler('list.refresh', …)` so runs are
queued, retried and observable through `system_jobs` like everything else.

```
1. Compile the List's AST for the active compiler.
2. Execute, honouring member_cap and the ceiling in §5.3.
3. Diff fetched members against list_items:
     seen before          → touch last_seen_at
     not seen before      → insert as 'new'
     previously seen, now absent → set status 'departed'
4. For each 'new' item, check whether it already exists in the target library
   (by tmdb_id within library_id). If so, set 'in_library' and do NOT notify.
5. Mode dispatch:
     approval → leave as 'new'; count toward the dashboard badge
     auto     → add up to max_adds_per_run, oldest first; remainder stays 'new'
                and is recorded as `capped`
6. Write a list_refresh_runs row.
7. If any genuinely new items resulted, write a system_events row and emit SSE.
```

### 6.2 Departures

An item leaving a List **never** removes it from the library and never un-monitors
it. Set `status = 'departed'`, surface it as information, and stop there. Silently
un-monitoring things is how automation loses trust.

### 6.3 Adding

Auto-add and approval-add share one path:

```ts
// film
await createFilmFromTmdb(db, list.library_id, item.tmdb_id, {
  monitored: list.monitored === 1,
  qualityProfileId: list.quality_profile_id,
  // per-list quality targeting — see note below
  target_tier: list.target_tier,
  target_resolution: list.target_resolution,
  target_source: list.target_source,
  target_codec: list.target_codec,
})

// series
await createSeriesFromMetadata(db, list.library_id,
  { tmdbId: item.tmdb_id, tvdbId: item.tvdb_id ?? undefined },
  { monitored: list.monitored === 1, qualityProfileId: list.quality_profile_id })
```

`CreateFilmOptions` already accepts `target_tier`, `target_resolution`,
`target_source`, `target_codec` and the matching `minimum_*` fields. Carry them as
nullable columns on `lists` so a List can specify quality intent beyond the profile
— "4K remuxes only" as a List property rather than requiring a dedicated quality
profile per List. Null means fall through to the profile. `CreateSeriesOptions` is
currently narrower (`monitored`, `qualityProfileId` only); don't add fields to it as
part of this work.

Items start as `missing`; the release pipeline picks them up from there with no
further wiring. On failure set `status = 'failed'` with `status_reason` and let the
job runner's retry classification handle transience.

### 6.4 Scheduling

`scheduler.ts` follows the existing orchestrator shape:

```
TICK_INTERVAL_MS        60_000
STARTUP_DELAY_MS        15_000
MAX_CONCURRENT_REFRESH       2
DEFAULT_REFRESH_HOURS       24
```

Select Lists where `enabled = 1` and
`last_refreshed_at + refresh_interval_hours <= now`, respecting backoff. On failure
increment `consecutive_failures` and back off exponentially, mirroring
`release-pipeline/health.ts`.

Cache compiled query results with a TTL, following the
`recommendation_source_candidates` / `expires_at` pattern already in the schema, so
several Lists sharing a filter shape don't each re-page TMDB.

---

## 7. Guardrails — read before implementing auto-add

A filter like "rated above 6, since 2020" matches several thousand titles. Enabling
auto-add on it queues thousands of items into the release pipeline and points them
at the user's indexers. This is the highest-risk part of the feature.

Required:

1. **Auto-add cannot be enabled blind.** The UI must run a preview and show the match
   count, and the count must be confirmed before `mode` can be set to `auto`.
2. **`max_adds_per_run`**, default 10. The remainder stays `new` and drains over
   subsequent runs. A List with 400 pending items adds them over 40 runs, not at once.
3. **`member_cap`**, default 500. A List that would exceed it stops fetching and
   warns rather than silently truncating.
4. **First run of a new List never auto-adds.** Regardless of mode, the first
   reconciliation classifies everything and notifies. Auto-add engages from the
   second run. This makes "I built a filter and it grabbed 3,000 films" structurally
   impossible.
5. **A global kill switch** in settings that disables auto-add across all Lists.
6. **A cross-List ceiling per refresh cycle**, default 25. `max_adds_per_run` is
   per-List, so ten auto-add Lists at ten each is still a hundred adds in one cycle.
   The scheduler must hold a cycle-wide budget and stop adding once it's spent,
   leaving the remainder `new` to drain on subsequent cycles. Record the withheld
   count on the run alongside `capped`.

The missing-search scheduler is already deliberately conservative at one item a day,
which cushions the backlog — but the initial add burst and RSS matching are not
cushioned. These guardrails are the cushion.

---

## 8. API

Mounted at `/lists` via the `routes.ts` registry.

```
GET    /lists                       list all (scoped by library context)
POST   /lists                       create
GET    /lists/:id                   detail + counts by status
PATCH  /lists/:id                   update (name, filter, mode, targets, guardrails)
DELETE /lists/:id                   delete (cascades list_items)

POST   /lists/preview               { filter, mediaType } → match count + first page
                                    Does not persist. Powers the builder UI.
POST   /lists/:id/refresh           queue an immediate refresh run
GET    /lists/:id/items?status=new  paged membership
GET    /lists/:id/runs              refresh history

POST   /lists/:id/items/:itemId/add        approve → add to library
POST   /lists/:id/items/:itemId/dismiss    dismiss → never resurface
POST   /lists/:id/items/bulk               { action: 'add'|'dismiss', itemIds: [] }

GET    /lists/pending-count         dashboard badge across all lists
```

Validate with `middleware/validate.ts`. Apply `middleware/library-context.ts` for
scoping.

---

## 9. UI

### 9.1 Filter builder

`client/src/modules/lists/`. The most opinion-heavy piece — build it last.

- Rows of filter clauses combining with AND by default; explicit OR grouping available
  but not the default
- **Live match count** as clauses change, debounced, against `POST /lists/preview`.
  This is the single most important affordance: it's what stops someone building a
  filter matching 8,000 titles and it's the confirmation gate in §7.1
- Unsupported clauses (per §4.1) rendered disabled with an explanation, never hidden
- Sample results shown beneath the builder so the filter's effect is visible

### 9.2 Review queue

- Dashboard widget with the pending count, driven by `/lists/pending-count`, live via SSE
- Poster grid per List with add / dismiss on each item and bulk selection
- Reuse the visual language of `RecommendationFeedbackBar` — this is the same
  accept/dismiss gesture and should not look like a second system

### 9.3 Mode switch

The approval/auto toggle needs to communicate consequence. When switching to auto,
show the current pending count and the effective drain rate: *"47 pending · adds up
to 10 per run · about 5 days."*

### 9.4 Aesthetic

Domain accent from `packages/design-system/tokens.css` — cyan for film Lists, violet
for series. Mono for counts and run history, `font-variant-numeric: tabular-nums`.

### 9.5 Portable YAML

The Lists overview imports and exports a versioned `archivist-lists` YAML document.
One document may contain up to 100 complete List definitions. Definitions retain the
provider-neutral filter AST and all behaviour/target fields, but never expose database
IDs. Root folders are represented by path and quality profiles by name, then resolved
against the currently selected Films or Series library during import.

Import validates the complete document before writing. Every List must match the
selected library's media type; unknown folders/profiles and unsupported schema versions
reject the batch. Existing List names are skipped and reported rather than overwritten.

---

## 10. Migrating off `list-imports`

`apps/server/src/list-imports/routes.ts` currently stores sources of type
`sonarr | radarr | trakt | mdblist` and offers a stateless `/preview`. It has no
persistence, no schedule, no diff, no add.

Recommended: **fold it into Lists as a second membership provider.** The
reconciliation engine is source-agnostic (§2.2), so an external URL becomes another
compiler-equivalent that returns `ListMember[]`. Keeping Sonarr/Radarr import is
genuinely useful for people migrating in, even if MDBList and Trakt are dropped on
principle.

If it's dropped entirely, remove the module rather than leaving it dark.

Either way, delete the committed merge artefact `list-imports/routes.ts.orig`.

---

## 11. Phase 2 — the local catalogue

Once Archivist has its own metadata service, add `LocalCatalogCompiler`. Saved Lists
need no migration.

What it unlocks, and what to design toward now:

- **No rate limits, no pagination ceilings, arbitrary clause combinations.**
- **Library-local signals inside filters** — the real payoff. "Horror under 100
  minutes featuring someone already in my library." "Anything by a director whose
  other work I've rated 4 or above." Neither is expressible against TMDB at any
  price, and the second only becomes possible once personal ratings exist.
- Convergence with recommendations: the filter engine and `recommendations/for-you.ts`
  become queries over one catalogue with one taste profile. Keep an eye on this so
  two query layers don't get built.

Design the AST with `person`, `rating` and future `library` nodes present from the
start — even if the TMDB compiler reports some as unsupported — so phase 2 is
additive.

---

## 12. Traps

1. **Don't store provider query params in `lists.filter`.** §2.1.
2. **Don't sort by popularity.** §5.1.
3. **Don't notify for items already in the library.** §6.1 step 4.
4. **Don't auto-add on first run.** §7.4.
5. **Don't remove or un-monitor on departure.** §6.2.
6. **Don't silently drop unsupported filter clauses.** §4.1.
7. **Don't offer IMDB/RT/Metacritic filters in phase 1.** §5.4.
8. **Don't build a second review UI.** Converge with `RecommendationFeedbackBar`.

---

## 13. Acceptance criteria

- [ ] A List saves as a provider-agnostic AST; no TMDB parameter names in the DB
- [ ] Preview returns a match count before a List is saved
- [ ] First refresh of a List over an established library produces zero notifications for held items
- [ ] First refresh never auto-adds, regardless of mode
- [ ] Approval mode queues items and raises a dashboard badge via SSE
- [ ] Auto-add respects `max_adds_per_run`; the remainder drains on later runs
- [ ] Added items land as `missing` and monitored, and the release pipeline picks them up unmodified
- [ ] A departed member is marked `departed` and is neither removed nor un-monitored
- [ ] Dismissed items never resurface
- [ ] A filter exceeding the provider ceiling warns rather than silently truncating
- [ ] An unsupported filter clause is visibly disabled, never ignored
- [ ] A failing List backs off and records `last_error` without affecting other Lists
- [ ] Every run writes a `list_refresh_runs` row
- [ ] `pnpm verify` passes

---

## 14. Suggested order

1. Schema + migrations + `FilterAST` contract with unit tests
2. `FilterCompiler` interface + TMDB compiler, with sort-stability and ceiling tests
3. Reconciliation engine + diff logic + `list.refresh` job handler
4. Scheduler + backoff
5. API routes
6. Review queue UI + dashboard badge
7. Auto-add + all guardrails in §7
8. Filter builder UI with live match count
9. Fold or remove `list-imports`

Steps 1–6 are shippable as approval-only. **Ship that first and live with it before
enabling auto-add** — the guardrails are much easier to calibrate once real match
counts from real filters exist.
