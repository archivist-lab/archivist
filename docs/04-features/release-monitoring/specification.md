---
title: "Archivist Real-Time Release Monitoring Implementation"
document_type: feature-specification
status: historical
classified: 2026-08-16
---
# Archivist Real-Time Release Monitoring Implementation

## Objective

Implement an event-driven release monitoring system for Archivist that:

- continuously monitors enabled indexers;
- discovers newly published releases quickly;
- evaluates each release against all monitored media;
- submits accepted releases to the configured download client;
- avoids duplicate processing and duplicate downloads;
- survives restarts without losing feed position;
- respects indexer rate limits;
- uses targeted searches only as a recovery mechanism;
- supports push-based release notifications where available.

The target user experience is:

> A monitored episode or movie should normally begin downloading within a few minutes of appearing on an indexer.

---

# 1. Core Design Principle

Archivist must distinguish between two acquisition mechanisms.

## 1.1 RSS or recent-release monitoring

This is the primary mechanism for future releases.

Archivist periodically asks each indexer:

> What new releases have been published recently?

It then compares every unseen release against the complete monitored library.

```text
Indexer recent feed
        ↓
Retrieve unseen releases
        ↓
Persist release event
        ↓
Parse title
        ↓
Identify film, series, episode, album, book, comic, or game
        ↓
Check monitoring and quality rules
        ↓
Submit accepted release to download client
```

## 1.2 Targeted searching

This is a fallback and backlog mechanism.

Archivist asks indexers:

> Find releases for this specific missing item.

Targeted searching should be used for:

- items added after their original release;
- releases missed by RSS;
- indexer downtime recovery;
- manually triggered searches;
- monitored items still missing after a configurable period.

```text
Missing monitored item
        ↓
Build specific search query
        ↓
Search enabled indexers
        ↓
Evaluate returned candidates
        ↓
Select best acceptable release
```

Do not use constant targeted searches as the primary monitoring strategy. That creates unnecessary indexer load and scales poorly as the monitored library grows.

---

# 2. Required Architecture

Implement the following components:

```text
Indexer Feed Workers
        ↓
Release Ingestion Service
        ↓
Persistent Release Ledger
        ↓
Release Event Queue
        ↓
Parser
        ↓
Identifier
        ↓
Monitoring Matcher
        ↓
Quality Decision Engine
        ↓
Download Submission Service
        ↓
Download Completion Monitor
        ↓
Importer
```

The feed workers must remain lightweight. They should fetch releases, persist unseen items, and publish events. Parsing, matching, quality evaluation, and download submission must happen outside the polling loop.

---

# 3. Indexer Feed Worker

Create one logical feed worker for every enabled indexer.

Each worker must:

- run for the lifetime of the Archivist server;
- poll the indexer recent-release endpoint;
- preserve its feed position;
- support HTTP conditional requests;
- process all unseen releases;
- apply adaptive polling intervals;
- back off on errors;
- restart automatically after unexpected failure.

## 3.1 Worker interface

```ts
export interface IndexerFeedWorkerState {
  indexerId: number
  enabled: boolean
  status: 'starting' | 'healthy' | 'backing_off' | 'error' | 'stopped'

  etag: string | null
  lastModified: string | null
  lastSeenReleaseId: string | null

  lastPollStartedAt: number | null
  lastPollCompletedAt: number | null
  lastSuccessfulPollAt: number | null
  lastReleaseSeenAt: number | null

  currentIntervalSeconds: number
  consecutiveFailures: number
  lastError: string | null
}
```

## 3.2 Worker lifecycle

```ts
export async function runIndexerFeedWorker(
  indexer: IndexerConfig,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await pollIndexerFeed(indexer)

      await processPollResult(indexer, result)
      await sleep(calculateNextInterval(indexer, result), signal)
    } catch (error) {
      await recordWorkerFailure(indexer.id, error)
      await sleep(calculateBackoff(indexer.id), signal)
    }
  }
}
```

The worker must never terminate permanently because of a transient error.

---

# 4. Polling Strategy

## 4.1 Default intervals

Use the following defaults:

```env
INDEXER_FEED_DEFAULT_INTERVAL_SECONDS=300
INDEXER_FEED_MIN_INTERVAL_SECONDS=60
INDEXER_FEED_MAX_INTERVAL_SECONDS=900
INDEXER_FEED_ERROR_BACKOFF_MAX_SECONDS=1800
```

Recommended behaviour:

| Worker state | Interval |
|---|---:|
| Monitored episode near air time | 60 seconds |
| Episode aired within last 6 hours | 90 seconds |
| Normal feed monitoring | 5 minutes |
| No useful releases for several hours | 10–15 minutes |
| Rate-limited or repeatedly failing | Exponential backoff |

The minimum interval must be configurable per indexer because some indexers impose stricter limits.

## 4.2 Adaptive polling

The worker should enter a faster polling mode when any monitored item is expected soon.

```ts
export function shouldUseRapidPolling(now: number): boolean {
  return getMonitoredUpcomingEpisodes().some(episode => {
    const rapidStart = episode.airDateUtc - 30 * 60_000
    const rapidEnd = episode.airDateUtc + 6 * 60 * 60_000

    return (
      episode.status !== 'acquiring' &&
      episode.status !== 'collected' &&
      now >= rapidStart &&
      now <= rapidEnd
    )
  })
}
```

Do not create separate polling loops for individual episodes. Increase the polling frequency of the relevant indexer feeds instead.

---

# 5. Conditional HTTP Requests

Use indexer-provided cache validators whenever available.

Store:

- `ETag`;
- `Last-Modified`.

Send them with subsequent requests:

```http
If-None-Match: "<stored-etag>"
If-Modified-Since: "<stored-last-modified>"
```

Handle:

```http
304 Not Modified
```

A `304` response should count as a successful poll.

Example:

```ts
const headers: Record<string, string> = {}

if (state.etag) {
  headers['If-None-Match'] = state.etag
}

if (state.lastModified) {
  headers['If-Modified-Since'] = state.lastModified
}

const response = await fetch(feedUrl, {
  headers,
  signal: AbortSignal.timeout(indexer.timeoutMs),
})
```

Update stored validators from every successful response.

---

# 6. Persistent Feed State

Add a table for indexer feed state.

```sql
CREATE TABLE IF NOT EXISTS indexer_feed_state (
  indexer_id INTEGER PRIMARY KEY,

  etag TEXT,
  last_modified TEXT,
  last_seen_release_id TEXT,

  last_poll_started_at INTEGER,
  last_poll_completed_at INTEGER,
  last_successful_poll_at INTEGER,
  last_release_seen_at INTEGER,

  current_interval_seconds INTEGER NOT NULL DEFAULT 300,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,

  last_error TEXT,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (indexer_id)
    REFERENCES indexers(id)
    ON DELETE CASCADE
);
```

This state must survive restarts.

A restart must not cause Archivist to reprocess the entire feed as new.

---

# 7. Release Ledger

Every release returned by an RSS feed or push provider must be persisted before evaluation.

```sql
CREATE TABLE IF NOT EXISTS indexer_release_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  indexer_id INTEGER NOT NULL,
  external_guid TEXT,
  info_hash TEXT,
  download_url_hash TEXT,

  title TEXT NOT NULL,
  description TEXT,
  download_url TEXT,

  size_bytes INTEGER,
  published_at INTEGER,
  first_seen_at INTEGER NOT NULL,

  source_type TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending',

  processed_at INTEGER,
  processing_error TEXT,

  FOREIGN KEY (indexer_id)
    REFERENCES indexers(id)
    ON DELETE CASCADE
);
```

Recommended values:

```text
source_type:
- rss
- push
- targeted_search
- manual_search

processing_status:
- pending
- processing
- accepted
- rejected
- duplicate
- failed
```

---

# 8. Deduplication

Do not rely on one identifier.

Evaluate duplicate keys in this order:

1. Indexer release GUID
2. Info hash
3. Download URL hash
4. Normalized title, size, and publish timestamp
5. Existing acquisition ledger record
6. Existing download-client hash

## 8.1 Unique indexes

```sql
CREATE UNIQUE INDEX IF NOT EXISTS
  idx_release_indexer_guid
ON indexer_release_events(indexer_id, external_guid)
WHERE external_guid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_release_info_hash
ON indexer_release_events(info_hash)
WHERE info_hash IS NOT NULL;
```

## 8.2 Fallback fingerprint

```ts
export function releaseFingerprint(release: RawIndexerRelease): string {
  return sha256([
    normalizeReleaseTitle(release.title),
    String(release.sizeBytes ?? ''),
    String(release.publishedAt ?? ''),
  ].join('|'))
}
```

The fingerprint should be persisted if no stable GUID or info hash exists.

---

# 9. Feed Processing

For each unseen feed item:

1. Normalize the feed record.
2. Create a release ledger row.
3. Commit the row.
4. Publish a `release.discovered` event.
5. Continue processing the feed.

Do not perform full release evaluation inside the indexer worker.

```ts
for (const rawRelease of feed.items) {
  const normalized = normalizeIndexerRelease(indexer, rawRelease)

  const inserted = await releaseLedger.insertIfUnseen(normalized)

  if (!inserted) {
    continue
  }

  await eventBus.publish('release.discovered', {
    releaseEventId: inserted.id,
  })
}
```

---

# 10. Event Queue

Use the existing Archivist durable job or event framework.

Required event types:

```text
release.discovered
release.parsed
release.identified
release.evaluated
release.accepted
release.rejected
download.submission.requested
download.submitted
download.failed
download.completed
import.requested
import.completed
import.failed
```

Each event handler must be idempotent.

If a job is retried, it must not cause duplicate submissions.

---

# 11. Release Parsing

The parser should extract:

- title;
- release year;
- series title;
- season number;
- episode number;
- multi-episode ranges;
- season packs;
- multi-season packs;
- resolution;
- source;
- video codec;
- audio codec;
- audio channels;
- HDR format;
- language;
- subtitle language;
- release group;
- edition;
- repack or proper marker;
- file size;
- release type.

Example:

```text
Example.Show.S03E07.2160p.WEB-DL.DDP5.1.H.265-GROUP
```

Expected parse:

```json
{
  "mediaType": "series",
  "seriesTitle": "Example Show",
  "seasonNumber": 3,
  "episodeNumbers": [7],
  "resolution": "2160p",
  "source": "WEB-DL",
  "audioCodec": "EAC3",
  "audioChannels": "5.1",
  "videoCodec": "H265",
  "releaseGroup": "GROUP"
}
```

Malformed or unrecognized releases should be rejected with a reason, not silently discarded.

---

# 12. Monitored Subject Matching

The identification service must match parsed releases against Archivist's monitored-title index.

The title index should contain normalized aliases for:

- original title;
- localized title;
- alternative titles;
- release year;
- provider IDs;
- series aliases;
- season and episode mappings.

Example title index record:

```ts
export interface MonitoredTitleIndexEntry {
  mediaType: 'film' | 'series' | 'music' | 'books' | 'comics' | 'games'
  subjectId: number
  parentId?: number
  canonicalTitle: string
  normalizedAliases: string[]
  year?: number
  monitored: boolean
}
```

For series releases:

- confirm the series is monitored;
- confirm the season is monitored;
- confirm the episode has aired or is allowed by configuration;
- confirm the episode is missing or eligible for upgrade;
- support episode packs and season packs;
- reject releases covering only unmonitored episodes.

---

# 13. Air-Date Awareness

The metadata scheduler must ensure Archivist knows about new episodes before releases appear.

Implement:

```text
T−60 minutes:
Refresh metadata for monitored upcoming series.

T−10 minutes:
Refresh metadata again.

T+0 to T+6 hours:
Use rapid indexer feed polling.

T+15 minutes onward:
Allow periodic targeted searches if no suitable release has been accepted.

After successful download submission:
Stop rapid monitoring for that episode.
```

Add a scheduler for imminent episodes:

```ts
export async function refreshImminentSeries(): Promise<void> {
  const seriesIds = getSeriesWithEpisodesAiringBetween(
    Date.now() - 15 * 60_000,
    Date.now() + 90 * 60_000,
  )

  for (const seriesId of seriesIds) {
    await enqueueSeriesMetadataRefresh(seriesId, {
      reason: 'imminent_episode',
    })
  }
}
```

---

# 14. Quality Decision Engine

Every identified release must pass through the existing quality and monitoring rules.

Required decisions:

```text
ACCEPT
REJECT_NOT_MONITORED
REJECT_ALREADY_COLLECTED
REJECT_EXISTING_DOWNLOAD
REJECT_QUALITY_TOO_LOW
REJECT_QUALITY_NOT_ALLOWED
REJECT_LANGUAGE
REJECT_SIZE
REJECT_RELEASE_GROUP
REJECT_DELAY_PROFILE
REJECT_DUPLICATE
REJECT_EPISODE_NOT_AIRED
REJECT_INDEXER_DISABLED
REJECT_DOWNLOAD_CLIENT_UNAVAILABLE
```

The decision engine should return a complete audit record.

```ts
export interface ReleaseDecision {
  accepted: boolean
  reasonCode: string
  reasonText: string
  score: number
  preferredWordScore: number
  qualityScore: number
  upgrade: boolean
}
```

Persist both accepted and rejected decisions.

This is essential for debugging why Archivist did or did not grab a release.

---

# 15. Download Submission

A release must only enter `acquiring` status after the download client confirms acceptance.

Correct sequence:

```text
Release accepted by quality engine
        ↓
Submit to download client
        ↓
Client returns success and download identifier
        ↓
Persist download identifier or hash
        ↓
Mark subject as acquiring
```

Incorrect sequence:

```text
Mark acquiring
        ↓
Attempt download submission
        ↓
Submission fails
```

Use a unique acquisition lock per subject:

```ts
const lockKey = `${mediaType}:${subjectId}`

await acquisitionLock.runExclusive(lockKey, async () => {
  if (await subjectAlreadyAcquiring(subjectId)) {
    return
  }

  const result = await downloadClient.addRelease(release)

  if (!result.accepted) {
    throw new DownloadSubmissionError(result.reason)
  }

  await markSubjectAcquiring(subjectId, result.downloadId)
})
```

---

# 16. Push-Based Release Ingestion

RSS remains the universal fallback.

Add an optional push-provider interface for indexers or external systems that support:

- webhooks;
- WebSub;
- IRC announcement bridges;
- WebSockets;
- server-sent events;
- external indexer-manager notifications.

```ts
export interface ReleasePushProvider {
  id: string

  start(
    onRelease: (release: RawIndexerRelease) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>

  getHealth(): Promise<PushProviderHealth>
}
```

Push events must enter the same release ingestion path:

```text
Push notification
        ↓
Normalize release
        ↓
Deduplicate
        ↓
Persist ledger row
        ↓
Publish release.discovered
```

Do not create a separate quality or download pipeline for push events.

RSS polling must stay enabled even when push is active because push delivery can fail silently.

---

# 17. Targeted Search Recovery

Keep the existing hourly missing-item search, but refine it.

Recommended configuration:

```env
MISSING_SEARCH_INTERVAL_MINUTES=60
MISSING_SEARCH_COOLDOWN_HOURS=4
MISSING_SEARCH_BATCH_SIZE_PER_LIBRARY=5
RECENTLY_AIRED_SEARCH_INTERVAL_MINUTES=15
RECENTLY_AIRED_RAPID_WINDOW_HOURS=6
```

Use a separate high-priority search path for recently aired episodes.

```text
Recently aired episode not acquired
        ↓
Wait 15 minutes
        ↓
Targeted episode search
        ↓
Repeat every 15 minutes during rapid window
        ↓
Return to hourly missing search afterward
```

Manual searches must bypass the automatic cooldown.

---

# 18. Rate-Limit Handling

Explicitly handle:

- `429 Too Many Requests`;
- `Retry-After`;
- request timeouts;
- DNS failures;
- connection failures;
- `5xx` responses;
- malformed feed responses;
- authentication failures.

## 18.1 Retry-After

```ts
if (response.status === 429) {
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'))

  await updateIndexerBackoff(indexer.id, {
    until: retryAfter ?? Date.now() + 15 * 60_000,
    reason: 'rate_limited',
  })

  return
}
```

## 18.2 Exponential backoff

```ts
export function calculateBackoff(
  failures: number,
  maximumSeconds: number,
): number {
  const base = Math.min(30 * 2 ** failures, maximumSeconds)
  const jitter = Math.floor(Math.random() * Math.max(base * 0.2, 1))

  return base + jitter
}
```

Reset failure count after any successful response, including `304`.

Authentication errors should disable the worker and surface a persistent alert rather than retrying indefinitely.

---

# 19. Worker Supervision

Add a supervisor responsible for:

- starting workers for enabled indexers;
- stopping workers when indexers are disabled;
- restarting failed workers;
- responding to configuration changes;
- exposing worker health;
- shutting workers down cleanly.

```ts
export class IndexerFeedSupervisor {
  private workers = new Map<number, AbortController>()

  async reconcile(indexers: IndexerConfig[]): Promise<void> {
    const enabledIds = new Set(
      indexers.filter(indexer => indexer.enabled).map(indexer => indexer.id),
    )

    for (const [indexerId, controller] of this.workers) {
      if (!enabledIds.has(indexerId)) {
        controller.abort()
        this.workers.delete(indexerId)
      }
    }

    for (const indexer of indexers) {
      if (!indexer.enabled || this.workers.has(indexer.id)) {
        continue
      }

      const controller = new AbortController()
      this.workers.set(indexer.id, controller)

      void this.supervise(indexer, controller.signal)
    }
  }

  private async supervise(
    indexer: IndexerConfig,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await runIndexerFeedWorker(indexer, signal)
      } catch (error) {
        logger.error(
          { indexerId: indexer.id, error },
          'Indexer feed worker crashed',
        )

        await sleep(5_000, signal)
      }
    }
  }
}
```

---

# 20. Administration UI

Add an Indexer Monitoring panel.

For each indexer display:

- enabled status;
- worker status;
- current mode;
- current polling interval;
- last successful poll;
- last feed response;
- last new release seen;
- number of unseen releases found;
- number of accepted releases;
- number of rejected releases;
- consecutive failures;
- rate-limit state;
- next scheduled poll;
- push-provider status.

Example:

```text
Example Indexer

Status: Healthy
Mode: Rapid
Polling interval: 60 seconds
Last successful poll: 18 seconds ago
Last release seen: 2 minutes ago
Feed response: 304 Not Modified
Consecutive failures: 0
Push connection: Not supported
```

Provide controls for:

- Run feed sync now
- Test indexer
- View recent releases
- View rejected releases
- Reset feed cursor
- Pause worker
- Resume worker

Resetting the feed cursor must require confirmation because it can cause old releases to be reprocessed.

---

# 21. Global Settings

Add settings:

```ts
export interface ReleaseMonitoringSettings {
  enabled: boolean

  defaultPollIntervalSeconds: number
  minimumPollIntervalSeconds: number
  maximumPollIntervalSeconds: number

  rapidPollingEnabled: boolean
  rapidPollIntervalSeconds: number
  rapidWindowBeforeAirMinutes: number
  rapidWindowAfterAirHours: number

  targetedSearchEnabled: boolean
  targetedSearchIntervalMinutes: number
  recentlyAiredSearchIntervalMinutes: number

  pushProvidersEnabled: boolean
}
```

Suggested defaults:

```json
{
  "enabled": true,
  "defaultPollIntervalSeconds": 300,
  "minimumPollIntervalSeconds": 60,
  "maximumPollIntervalSeconds": 900,
  "rapidPollingEnabled": true,
  "rapidPollIntervalSeconds": 60,
  "rapidWindowBeforeAirMinutes": 30,
  "rapidWindowAfterAirHours": 6,
  "targetedSearchEnabled": true,
  "targetedSearchIntervalMinutes": 60,
  "recentlyAiredSearchIntervalMinutes": 15,
  "pushProvidersEnabled": true
}
```

Allow per-indexer overrides.

---

# 22. API Endpoints

Add:

```http
GET /api/v1/indexers/feed-status
GET /api/v1/indexers/:id/feed-status
POST /api/v1/indexers/:id/feed-sync
POST /api/v1/indexers/:id/feed-pause
POST /api/v1/indexers/:id/feed-resume
POST /api/v1/indexers/:id/feed-reset-cursor

GET /api/v1/releases/recent
GET /api/v1/releases/:id
GET /api/v1/releases/:id/decision
POST /api/v1/releases/:id/reprocess

GET /api/v1/acquisition/status
GET /api/v1/acquisition/events
```

The Player API must not expose these endpoints.

They belong only to the admin API on port `2424`.

---

# 23. Logging

Use structured logging.

Required fields:

```json
{
  "component": "IndexerFeedWorker",
  "indexerId": 4,
  "indexerName": "Example Indexer",
  "pollMode": "rapid",
  "intervalSeconds": 60,
  "responseStatus": 200,
  "feedItemCount": 100,
  "unseenItemCount": 3,
  "durationMs": 684
}
```

Log major lifecycle events:

```text
Indexer worker started
Indexer feed poll started
Indexer feed unchanged
Indexer feed releases discovered
Indexer worker entered rapid mode
Indexer worker exited rapid mode
Indexer rate limited
Indexer authentication failed
Release deduplicated
Release matched monitored subject
Release rejected
Release accepted
Download submitted
Download submission failed
```

Do not log API keys, passkeys, authenticated feed URLs, cookies, or download credentials.

---

# 24. Metrics

Track:

```text
archivist_indexer_poll_total
archivist_indexer_poll_success_total
archivist_indexer_poll_failure_total
archivist_indexer_poll_304_total
archivist_indexer_poll_429_total

archivist_release_discovered_total
archivist_release_duplicate_total
archivist_release_accepted_total
archivist_release_rejected_total

archivist_release_processing_duration_ms
archivist_release_to_download_latency_ms
archivist_download_submission_failure_total

archivist_indexer_worker_restarts_total
```

The most important user-facing metric is:

```text
Release first seen
        →
Download client accepted
```

This should normally be below one polling interval.

---

# 25. Database Migration Requirements

The implementation must include versioned migrations for:

- `indexer_feed_state`;
- `indexer_release_events`;
- release fingerprints;
- worker backoff state;
- acquisition audit fields;
- push-provider state if implemented.

Migrations must:

- be transactional;
- be safe on existing installations;
- preserve current indexer and acquisition data;
- include rollback notes;
- be covered by migration tests.

---

# 26. Testing Requirements

## 26.1 Feed parsing

Test:

- valid RSS;
- valid Atom;
- Torznab extensions;
- empty feeds;
- malformed XML;
- missing GUID;
- duplicate GUID;
- duplicate info hash;
- changed ETag;
- `304 Not Modified`.

## 26.2 Worker behaviour

Test:

- startup polling;
- normal polling interval;
- rapid mode;
- adaptive interval changes;
- shutdown;
- crash restart;
- configuration reload;
- indexer disable;
- indexer re-enable;
- exponential backoff;
- `Retry-After`.

## 26.3 Release processing

Test:

- monitored episode accepted;
- unmonitored series rejected;
- unmonitored season rejected;
- unaired episode rejected;
- already collected episode rejected;
- eligible upgrade accepted;
- duplicate release rejected;
- season pack matching;
- multi-episode release matching;
- quality rejection;
- preferred release scoring.

## 26.4 Download submission

Test:

- successful client acceptance;
- client rejection;
- timeout;
- duplicate submission prevention;
- acquiring state only after acceptance;
- restart after submission;
- download hash persistence.

## 26.5 Restart recovery

Test:

1. Poll feed.
2. Persist release.
3. Stop Archivist before processing.
4. Restart Archivist.
5. Confirm pending release resumes processing.
6. Confirm feed item is not duplicated.
7. Confirm download is submitted at most once.

---

# 27. Security Requirements

- Do not expose indexer credentials in API responses.
- Redact passkeys from logs.
- Encrypt sensitive credentials at rest where the existing Archivist secret-storage model supports it.
- Validate all feed URLs.
- Restrict supported URL schemes to HTTP and HTTPS.
- Prevent internal-network SSRF unless explicitly allowed by configuration.
- Limit feed response size.
- Set request timeouts.
- Reject compressed responses that exceed the decompressed-size limit.
- Treat RSS content as untrusted input.
- Escape all release titles displayed in the UI.
- Do not automatically execute indexer-provided scripts or HTML.

---

# 28. Failure Behaviour

The system must degrade safely.

## Indexer unavailable

- Continue monitoring other indexers.
- Back off the failing worker.
- Surface an admin alert.
- Run targeted recovery searches after recovery.

## Feed malformed

- Record the parsing failure.
- Preserve the current feed cursor.
- Do not mark the poll as successful.
- Retry later with backoff.

## Queue unavailable

- Keep persisted release rows in `pending`.
- Resume processing when the queue recovers.

## Download client unavailable

- Do not mark media as acquiring.
- Record the failed submission.
- Retry according to acquisition policy.
- Avoid retry storms.

## Archivist restart

- Restart feed workers.
- Restore ETag and cursor state.
- Resume pending release processing.
- Preserve acquisition locks and submitted download hashes.

---

# 29. Implementation Order

Implement in this sequence.

## Phase 1: Durable RSS monitoring

1. Add feed-state migration.
2. Add release-ledger migration.
3. Implement RSS and Atom normalization.
4. Implement conditional requests.
5. Implement deduplication.
6. Add persistent feed workers.
7. Add worker supervision.
8. Publish `release.discovered` events.
9. Connect events to the existing release pipeline.
10. Add admin health endpoints.

## Phase 2: Fast monitored-release acquisition

1. Add imminent-air-date detection.
2. Add rapid polling mode.
3. Add recently aired targeted searches.
4. Add metadata refresh around air time.
5. Add acquisition latency metrics.
6. Add UI status and manual sync controls.

## Phase 3: Push integration

1. Define the push-provider interface.
2. Implement webhook ingestion.
3. Add provider authentication.
4. Route push events through normal deduplication.
5. Add connection health.
6. Retain RSS as the fallback path.

## Phase 4: Operational hardening

1. Add rate-limit handling.
2. Add request-size protection.
3. Add worker-restart testing.
4. Add migration and restart recovery tests.
5. Add structured metrics.
6. Add audit and rejection explorer.

---

# 30. Acceptance Criteria

The implementation is complete when all of the following are true:

- Enabled indexers are automatically monitored after Archivist starts.
- New releases are detected without manual searches.
- The default polling interval is five minutes or less.
- Rapid mode can poll every 60 seconds around monitored episode air times.
- Feed state survives restarts.
- Existing feed entries are not repeatedly reprocessed.
- Duplicate releases do not create duplicate downloads.
- Release evaluation is handled outside the feed polling loop.
- Monitored episodes can be grabbed through RSS without a targeted search.
- Recently aired episodes receive targeted recovery searches.
- Download state changes to `acquiring` only after client acceptance.
- Rate limits trigger backoff.
- Worker crashes trigger automatic restarts.
- Administrators can see feed health and recent release decisions.
- Push events, where implemented, use the same release pipeline as RSS.
- RSS remains operational when push delivery fails.

---

# 31. Expected Result

The completed system should behave as follows:

```text
A monitored episode airs
        ↓
Archivist refreshes series metadata
        ↓
Indexer publishes a release
        ↓
Archivist sees it during the next 60–300 second feed poll
        ↓
Release is parsed and matched
        ↓
Quality rules approve it
        ↓
Download client accepts it
        ↓
Episode enters acquiring state
```

Expected normal acquisition latency:

```text
Push-capable source:
A few seconds

Rapid RSS mode:
Approximately 1–2 minutes average

Normal RSS mode:
Approximately 2–5 minutes average

Hourly targeted-search fallback:
Up to one hour
```

The RSS monitoring path must be treated as the default future-release acquisition mechanism. Targeted search remains the recovery and backlog mechanism.
