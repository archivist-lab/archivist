---
title: "Search Missing: Scheduled Backlog Recovery"
document_type: feature-specification
status: historical
classified: 2026-08-16
---
# Search Missing: Scheduled Backlog Recovery

## Objective

Redesign **Search Missing** as an optional, low-frequency backlog-recovery process.

Search Missing must apply only to media that:

- was released before the recent-release window;
- is already known to Archivist;
- is monitored;
- is currently missing;
- is not acquiring;
- has not already been submitted to a download client;
- is not expected to be discovered through the active RSS recent-release workflow.

Search Missing must not be the normal acquisition mechanism for newly released films, episodes, albums, books, comics, or games.

The acquisition split must be:

```text
New or recently released content
        ↓
RSS / recent-release monitoring
        ↓
Optional push ingestion
        ↓
Rapid recently-aired recovery search

Older already-released missing content
        ↓
Scheduled Search Missing process
```

---

# 1. Default Behaviour

Search Missing must be:

- enabled by default;
- configured to search **one missing item per day**;
- scheduled at a low-usage default time;
- configurable globally;
- configurable by day of the week;
- configurable by time of day;
- optionally disabled entirely.

Recommended default:

```text
Enabled: Yes
Items per run: 1
Days: Every day
Time: 03:00 local server time
```

The default should deliberately make slow, steady progress through an existing backlog without generating heavy indexer traffic.

---

# 2. Recent-Release Exclusion Window

Search Missing must exclude newly released content.

Add a configurable recent-release window:

```env
SEARCH_MISSING_RECENT_RELEASE_EXCLUSION_HOURS=72
```

Recommended default:

```text
72 hours
```

Any item released or aired within the previous 72 hours must not be handled by the general Search Missing scheduler.

It should instead remain the responsibility of:

- RSS feed monitoring;
- push release ingestion;
- rapid recently-aired targeted searching;
- normal recent-release recovery logic.

Eligibility rule:

```ts
const isOlderReleasedItem =
  item.releaseDate != null &&
  item.releaseDate <= now - recentReleaseExclusionMs
```

For episodes, use the episode air date.

For films, use the earliest reliable digital, physical, theatrical, or configured availability date according to the library policy.

For other media types, use the domain-specific release date.

---

# 3. Search Missing Settings Model

Add a global configuration model.

```ts
export interface SearchMissingSettings {
  enabled: boolean

  /** Exclude recently released items handled by RSS and rapid recovery. */
  recentReleaseExclusionHours: number

  /** Default number of missing subjects searched during an eligible run. */
  defaultItemsPerRun: number

  /** Maximum permitted items in a single run. */
  maximumItemsPerRun: number

  /** Time zone used when evaluating the schedule. */
  timezone: string

  /** Per-day schedule configuration. */
  schedule: SearchMissingDaySchedule[]

  /** Selection strategy for choosing backlog items. */
  selectionStrategy:
    | 'oldest_release_first'
    | 'oldest_search_first'
    | 'highest_priority'
    | 'random'
    | 'balanced_by_media_type'

  /** Minimum delay before the same item may be searched again. */
  itemCooldownHours: number

  /** Whether manual Search Missing bypasses the schedule. */
  allowManualRun: boolean

  /** Whether manual runs bypass item cooldowns. */
  manualRunBypassesCooldown: boolean
}

export interface SearchMissingDaySchedule {
  dayOfWeek:
    | 'monday'
    | 'tuesday'
    | 'wednesday'
    | 'thursday'
    | 'friday'
    | 'saturday'
    | 'sunday'

  enabled: boolean

  /** Local time in HH:mm format. */
  time: string

  /** Overrides defaultItemsPerRun for this day. */
  itemsPerRun: number | null
}
```

Recommended defaults:

```json
{
  "enabled": true,
  "recentReleaseExclusionHours": 72,
  "defaultItemsPerRun": 1,
  "maximumItemsPerRun": 100,
  "timezone": "system",
  "selectionStrategy": "oldest_search_first",
  "itemCooldownHours": 168,
  "allowManualRun": true,
  "manualRunBypassesCooldown": true,
  "schedule": [
    {
      "dayOfWeek": "monday",
      "enabled": true,
      "time": "03:00",
      "itemsPerRun": null
    },
    {
      "dayOfWeek": "tuesday",
      "enabled": true,
      "time": "03:00",
      "itemsPerRun": null
    },
    {
      "dayOfWeek": "wednesday",
      "enabled": true,
      "time": "03:00",
      "itemsPerRun": null
    },
    {
      "dayOfWeek": "thursday",
      "enabled": true,
      "time": "03:00",
      "itemsPerRun": null
    },
    {
      "dayOfWeek": "friday",
      "enabled": true,
      "time": "03:00",
      "itemsPerRun": null
    },
    {
      "dayOfWeek": "saturday",
      "enabled": true,
      "time": "03:00",
      "itemsPerRun": null
    },
    {
      "dayOfWeek": "sunday",
      "enabled": true,
      "time": "03:00",
      "itemsPerRun": null
    }
  ]
}
```

---

# 4. Per-Day Configuration

Each day of the week must support:

- enabled or disabled;
- its own execution time;
- its own items-per-run limit.

Example configuration:

| Day | Enabled | Time | Items searched |
|---|---:|---:|---:|
| Monday | Yes | 03:00 | 1 |
| Tuesday | No | — | 0 |
| Wednesday | Yes | 03:00 | 1 |
| Thursday | No | — | 0 |
| Friday | Yes | 02:00 | 2 |
| Saturday | Yes | 04:00 | 10 |
| Sunday | Yes | 04:00 | 10 |

This allows users to perform very light weekday searching and larger backlog runs during off-peak periods.

A `null` daily value must inherit the global `defaultItemsPerRun`.

A daily value of `0` should not be used. Disable that day instead.

---

# 5. Multiple Time Windows per Day

The first implementation may support one run per day.

However, the model should be designed so a later migration can support multiple windows without redesigning the scheduler.

Preferred extensible model:

```ts
export interface SearchMissingDaySchedule {
  dayOfWeek: DayOfWeek
  enabled: boolean
  windows: SearchMissingScheduleWindow[]
}

export interface SearchMissingScheduleWindow {
  id: string
  enabled: boolean
  time: string
  itemsPerRun: number | null
}
```

Example:

```json
{
  "dayOfWeek": "saturday",
  "enabled": true,
  "windows": [
    {
      "id": "sat-early",
      "enabled": true,
      "time": "02:00",
      "itemsPerRun": 5
    },
    {
      "id": "sat-late",
      "enabled": true,
      "time": "14:00",
      "itemsPerRun": 2
    }
  ]
}
```

Implementing the multiple-window structure from the start is preferable, even if the initial UI exposes only one window per day.

---

# 6. Scheduler Behaviour

Create a persistent scheduler that evaluates due Search Missing windows.

Do not use a fixed `setInterval` that assumes the process will always be running at the exact scheduled minute.

The scheduler must:

1. Persist scheduled-run state.
2. Periodically evaluate whether a window is due.
3. Ensure each scheduled window runs at most once.
4. Recover missed schedules after a short server outage.
5. Avoid replaying stale schedules after a long outage.
6. respect the configured time zone.
7. prevent overlapping Search Missing runs.

Recommended evaluation cadence:

```text
Every 60 seconds
```

Example:

```ts
export async function evaluateSearchMissingSchedule(
  now: Date,
): Promise<void> {
  const settings = getSearchMissingSettings()

  if (!settings.enabled) {
    return
  }

  const localNow = convertToTimezone(now, settings.timezone)
  const windows = getScheduledWindowsForDay(
    settings.schedule,
    localNow,
  )

  for (const window of windows) {
    if (!isWindowDue(window, localNow)) {
      continue
    }

    if (await hasWindowAlreadyRun(window, localNow)) {
      continue
    }

    await enqueueSearchMissingRun({
      source: 'scheduled',
      scheduleWindowId: window.id,
      scheduledDate: formatLocalDate(localNow),
      itemLimit:
        window.itemsPerRun ??
        settings.defaultItemsPerRun,
    })
  }
}
```

---

# 7. Missed Schedule Recovery

If Archivist was offline at the scheduled time, allow a short recovery period.

Recommended default:

```env
SEARCH_MISSING_SCHEDULE_GRACE_MINUTES=120
```

Example:

```text
Configured run: 03:00
Archivist starts: 03:45
Result: Run the missed schedule

Archivist starts: 11:00
Result: Do not replay the missed schedule
```

This avoids unexpected high-load runs many hours after the intended window.

Persist each completed or skipped schedule occurrence.

```sql
CREATE TABLE IF NOT EXISTS search_missing_schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  schedule_window_id TEXT NOT NULL,
  scheduled_local_date TEXT NOT NULL,
  scheduled_local_time TEXT NOT NULL,

  timezone TEXT NOT NULL,
  status TEXT NOT NULL,

  requested_item_limit INTEGER NOT NULL,
  selected_item_count INTEGER NOT NULL DEFAULT 0,
  searched_item_count INTEGER NOT NULL DEFAULT 0,
  accepted_release_count INTEGER NOT NULL DEFAULT 0,

  started_at INTEGER,
  completed_at INTEGER,
  error TEXT,

  UNIQUE (
    schedule_window_id,
    scheduled_local_date,
    scheduled_local_time
  )
);
```

Recommended status values:

```text
queued
running
completed
completed_no_candidates
skipped_disabled
skipped_outside_grace
failed
```

---

# 8. Eligibility Rules

An item is eligible for scheduled Search Missing only when all conditions are met.

```ts
export function isEligibleForScheduledMissingSearch(
  item: MissingSearchCandidate,
  settings: SearchMissingSettings,
  now: number,
): boolean {
  if (!item.monitored) return false
  if (item.status !== 'missing' && item.status !== 'wanted') return false
  if (item.acquiring) return false
  if (item.collected) return false
  if (item.activeDownloadExists) return false
  if (item.releaseDate == null) return false
  if (item.releaseDate > now) return false

  const exclusionMs =
    settings.recentReleaseExclusionHours * 60 * 60_000

  if (item.releaseDate > now - exclusionMs) {
    return false
  }

  const cooldownMs =
    settings.itemCooldownHours * 60 * 60_000

  if (
    item.lastMissingSearchAt != null &&
    item.lastMissingSearchAt > now - cooldownMs
  ) {
    return false
  }

  return true
}
```

Additional domain-specific checks must apply.

## Series

- Series monitored.
- Season monitored.
- Episode monitored.
- Episode has aired.
- Episode lies outside the recent-release window.
- Episode is not part of an active season-pack acquisition.

## Films

- Film monitored.
- Film is considered released under the configured release-date policy.
- Film lies outside the recent-release window.

## Music

- Artist, album, or release monitored according to library policy.
- Album has been released.
- Album lies outside the recent-release window.

## Books, comics and games

- Subject monitored.
- Release date has passed.
- Item lies outside the recent-release window.
- Item is not already represented by an accepted edition or release.

---

# 9. Candidate Selection

The scheduler must not simply select arbitrary database rows.

Support configurable selection strategies.

## 9.1 Oldest search first

Recommended default:

```text
Items never searched
        ↓
Items with oldest last search
        ↓
Items with more recent searches
```

Query example:

```sql
ORDER BY
  CASE
    WHEN last_missing_search_at IS NULL THEN 0
    ELSE 1
  END ASC,
  last_missing_search_at ASC,
  release_date ASC,
  id ASC
```

This provides fair backlog coverage.

## 9.2 Oldest release first

Search the oldest missing releases first.

Useful for completing historical libraries.

## 9.3 Highest priority

Use explicit item, series, library or media-type priority.

Example priorities:

```text
Critical
High
Normal
Low
Paused
```

## 9.4 Balanced by media type

Avoid using every run on one large category.

Example for a ten-item run:

```text
Films: 2
Episodes: 2
Music: 2
Books: 2
Comics or games: 2
```

Redistribute unused category capacity to categories with remaining candidates.

## 9.5 Random

Permit random backlog exploration, but do not make this the default because it is harder to audit and predict.

---

# 10. Search Units

Define what counts as one missing item.

Recommended rules:

| Media type | One item means |
|---|---|
| Film | One film |
| Series | One episode |
| Music | One album |
| Book | One book or edition target |
| Comic | One issue |
| Game | One game |

A season pack may satisfy multiple missing episodes, but the search itself is still charged against the episode or season search unit that triggered it.

Do not count every result returned by an indexer as an item. The limit applies to missing subjects searched.

---

# 11. Search Execution

For each selected item:

1. Mark the item as selected for the current run.
2. Build media-specific targeted queries.
3. Search all eligible enabled indexers.
4. Combine and deduplicate returned releases.
5. Parse and identify candidates.
6. Apply monitoring and quality rules.
7. Rank acceptable releases.
8. Submit the best acceptable release.
9. Persist the result.
10. Continue to the next selected item.

Example:

```ts
for (const item of selectedItems) {
  await runItemSearch(item, runContext)
}
```

A failure on one item must not abort the entire daily run.

---

# 12. Per-Item Search Result

Persist the result of every missing-item search.

```sql
CREATE TABLE IF NOT EXISTS search_missing_item_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  schedule_run_id INTEGER,
  media_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,

  search_started_at INTEGER NOT NULL,
  search_completed_at INTEGER,

  indexers_queried INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  acceptable_candidate_count INTEGER NOT NULL DEFAULT 0,

  result_status TEXT NOT NULL,
  accepted_release_event_id INTEGER,
  error TEXT,

  FOREIGN KEY (schedule_run_id)
    REFERENCES search_missing_schedule_runs(id)
    ON DELETE SET NULL
);
```

Recommended result statuses:

```text
accepted
no_results
results_rejected
already_acquiring
became_collected
indexers_unavailable
failed
```

---

# 13. Cooldown Behaviour

The default item cooldown should be long because this process operates on older backlog items.

Recommended default:

```text
7 days
```

Configuration:

```env
SEARCH_MISSING_ITEM_COOLDOWN_HOURS=168
```

This means a missing item that produces no acceptable result will not be automatically searched again for seven days.

The daily scheduler should move on to other missing items rather than searching the same unavailable item every day.

Manual searches may bypass this cooldown.

---

# 14. Manual Search Missing

The UI may retain a manual **Search Missing** action.

Manual execution must allow the user to choose:

- media scope;
- library;
- media type;
- number of items;
- selection strategy;
- whether to bypass cooldowns;
- whether to include recent releases.

Recommended default manual behaviour:

```text
Bypass schedule: Yes
Bypass item cooldown: Yes
Include recent releases: No
```

Including recent releases should require an explicit override because RSS and recent-release recovery normally own that workflow.

---

# 15. Interaction with RSS Monitoring

The two systems must not compete.

Before submitting a Search Missing result, re-check:

- whether RSS already accepted another release;
- whether a download is now active;
- whether the item became collected;
- whether another scheduler worker acquired the subject lock.

Use the same acquisition lock and decision pipeline as RSS.

```text
Search Missing candidate accepted
        ↓
Acquire subject lock
        ↓
Re-read current subject state
        ↓
Check release ledger and downloads
        ↓
Submit only if still missing
```

RSS discoveries must not be blocked by a Search Missing run.

RSS should retain higher queue priority for newly discovered releases.

Suggested priorities:

| Job type | Queue priority |
|---|---:|
| Push release event | 100 |
| RSS release event | 90 |
| Recently aired targeted search | 80 |
| Manual interactive search | 70 |
| Scheduled Search Missing | 20 |

---

# 16. Concurrency and Load Controls

Scheduled Search Missing must be intentionally conservative.

Recommended defaults:

```env
SEARCH_MISSING_MAX_CONCURRENT_ITEMS=1
SEARCH_MISSING_INDEXER_REQUEST_CONCURRENCY=2
```

The scheduler may select multiple items, but should process them serially by default.

Allow users to increase concurrency, but clearly warn that it increases:

- indexer requests;
- API usage;
- rate-limit risk;
- download-client activity;
- server CPU usage.

---

# 17. Time-Zone Handling

The schedule must use an explicit IANA time zone.

Examples:

```text
Asia/Dubai
Europe/London
America/New_York
Australia/Sydney
```

Do not store only a numeric UTC offset because offsets can change due to daylight-saving rules.

If the user selects “System time zone,” resolve and persist the detected IANA zone where possible.

Scheduled-run identity must use:

- schedule window ID;
- local calendar date;
- configured local time;
- configured time zone.

This prevents duplicate or missing runs across daylight-saving transitions.

---

# 18. Administration UI

Add a **Search Missing Schedule** section.

## 18.1 Global controls

Display:

```text
Enable scheduled Search Missing       [On/Off]

Recent-release exclusion              [72] hours
Default items per run                  [1]
Maximum items per run                  [100]
Item cooldown                          [7] days
Selection strategy                     [Oldest search first]
Time zone                              [Asia/Dubai]
```

## 18.2 Weekly schedule editor

Example:

| Day | Enabled | Time | Items |
|---|---:|---:|---:|
| Monday | On | 03:00 | Inherit: 1 |
| Tuesday | On | 03:00 | Inherit: 1 |
| Wednesday | On | 03:00 | Inherit: 1 |
| Thursday | On | 03:00 | Inherit: 1 |
| Friday | On | 03:00 | Inherit: 1 |
| Saturday | On | 04:00 | 5 |
| Sunday | On | 04:00 | 5 |

Include:

- copy Monday schedule to all weekdays;
- copy one day to every day;
- disable weekdays;
- disable weekends;
- reset defaults.

## 18.3 Upcoming run preview

Display:

```text
Next run:
Sunday, 12 July 2026 at 03:00 Asia/Dubai

Planned item limit:
1 missing item

Eligible backlog:
284 items

Current selection strategy:
Oldest search first
```

The eligible count may be approximate if calculating it exactly is expensive.

## 18.4 Run history

Display:

- scheduled time;
- actual start time;
- item limit;
- items selected;
- items searched;
- accepted releases;
- no-result searches;
- failed searches;
- run duration.

---

# 19. API Endpoints

Add:

```http
GET /api/v1/search-missing/settings
PUT /api/v1/search-missing/settings

GET /api/v1/search-missing/schedule
PUT /api/v1/search-missing/schedule

GET /api/v1/search-missing/eligibility-count
GET /api/v1/search-missing/next-run

GET /api/v1/search-missing/runs
GET /api/v1/search-missing/runs/:id

POST /api/v1/search-missing/run
POST /api/v1/search-missing/runs/:id/cancel
```

Manual run request:

```json
{
  "scope": {
    "libraryIds": [1],
    "mediaTypes": ["film", "series"]
  },
  "itemLimit": 10,
  "selectionStrategy": "oldest_search_first",
  "bypassCooldown": true,
  "includeRecentReleases": false
}
```

---

# 20. Logging and Metrics

Log:

```text
Search Missing scheduler evaluated
Search Missing window due
Search Missing run queued
Search Missing run started
Missing item selected
Targeted search started
No candidates found
Candidates rejected
Release accepted
Search Missing run completed
Search Missing run skipped
```

Track:

```text
archivist_search_missing_runs_total
archivist_search_missing_items_selected_total
archivist_search_missing_items_searched_total
archivist_search_missing_releases_accepted_total
archivist_search_missing_no_results_total
archivist_search_missing_failed_total
archivist_search_missing_run_duration_ms
archivist_search_missing_eligible_backlog
```

---

# 21. Testing Requirements

## Schedule tests

Test:

- daily default schedule;
- disabled global setting;
- disabled individual day;
- per-day item override;
- inherited global item count;
- different times by day;
- configured time zone;
- daylight-saving transition;
- server restart before a scheduled run;
- server restart inside the grace period;
- server restart outside the grace period;
- duplicate scheduler evaluations;
- overlapping-run prevention.

## Eligibility tests

Test:

- older missing item included;
- recent release excluded;
- future release excluded;
- unmonitored item excluded;
- acquiring item excluded;
- collected item excluded;
- active download excluded;
- item inside cooldown excluded;
- item outside cooldown included;
- episode air-date handling;
- season monitoring handling.

## Selection tests

Test:

- one item selected by default;
- daily override selects correct count;
- oldest-search-first ordering;
- oldest-release-first ordering;
- highest-priority ordering;
- balanced-media selection;
- insufficient eligible candidates;
- deterministic tie-breaking.

## Integration tests

Test:

1. RSS discovers a release while Search Missing is evaluating the same item.
2. RSS acquires the subject first.
3. Search Missing rechecks the subject state.
4. Search Missing does not submit a duplicate.

Also test the inverse ordering.

---

# 22. Revised Acceptance Criteria

The Search Missing redesign is complete when:

- it can be disabled globally;
- it defaults to one item per day;
- every day of the week can be enabled or disabled separately;
- every day can have its own execution time;
- every day can override the item count;
- recently released content is excluded by default;
- the exclusion window is configurable;
- only monitored, released and missing items are eligible;
- an item cooldown prevents repetitive searches;
- missed runs recover only within a configurable grace period;
- scheduled runs cannot overlap;
- run state survives restarts;
- candidate selection is deterministic and auditable;
- RSS and push ingestion retain priority;
- duplicate acquisitions are prevented;
- manual runs can bypass schedules and cooldowns;
- administrators can view the next run and run history.

---

# 23. Final Acquisition Model

```text
Push-supported release source
        ↓
Immediate release ingestion

RSS / recent-release polling
        ↓
New and recently released content

Recently aired recovery search
        ↓
New release not yet found through RSS

Scheduled Search Missing
        ↓
Older already-released backlog content
        ↓
Default: one item per day

Manual search
        ↓
Explicit user-requested recovery or backlog search
```

Search Missing must be treated as controlled backlog maintenance, not continuous acquisition.
