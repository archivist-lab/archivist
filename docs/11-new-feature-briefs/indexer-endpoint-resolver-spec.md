---
title: "Feature specification: Indexer Endpoint Resolver"
document_type: specification
status: accepted
classified: 2026-08-19
---

# Feature Specification — Indexer Endpoint Resolver (IER)

**Project:** Archivist (`archivist-lab/archivist`)
**Subsystem:** Acquisition / Indexers
**Status:** Draft for implementation
**Depends on:** Cardigann definition loader, Cloudflare Bypass, CoreEvent spine, `@mediastack/core`

---

## 0. Assumptions

These are stated because they materially shape the design. Correct any that are wrong before implementation starts.

| # | Assumption | Impact if wrong |
|---|---|---|
| 0.1 | **Cloudflare Bypass** is Archivist's challenge-solving headless-browser proxy (the FlareSolverr equivalent) — expensive, concurrency-limited, and returns rendered HTML plus cookies. | If Cloudflare Bypass is instead a crawler/scraper, §6 and §8 change substantially. |
| 0.2 | Indexer site candidates come from the Cardigann definition's `Links` and `Legacylinks` arrays. | Candidate seeding (§5.2) changes. |
| 0.3 | Definitions and credentials are already persisted per indexer instance, and cookies/sessions are currently stored per **indexer**, not per **(indexer, endpoint)**. | §6.5 becomes a no-op if already domain-scoped. |
| 0.4 | This spec is written against the architecture as documented, not verified against current HEAD. Table names, event names and module paths must be reconciled with the repo before coding. | Naming churn only. |

---

## 1. Thesis

Indexer availability is currently a *runtime* problem discovered at *search* time. A mirror goes dark, a site adds a bot wall, a domain gets seized — and the user finds out because a search silently returns nothing. Prowlarr's answer is a manual URL field and a health check that tells you something is broken after the fact.

Archivist should treat indexer reachability as **continuously measured state**, not a config value. Every indexer has N candidate endpoints; the system knows which of them work, which require Cloudflare Bypass, how fast they are, and how reliable they've been — and it picks the best one automatically, failing over mid-search rather than mid-cron-interval.

Secondary payoff: because the probe distinguishes *site blocked* from *definition drift*, IER also becomes the early-warning system for Cardigann definitions that have broken upstream — a category of manual triage that currently doesn't exist anywhere in the ecosystem.

---

## 2. Goals and non-goals

### 2.1 Goals

- G1 — Automatically select, per indexer, the best working endpoint from its candidate set.
- G2 — Prefer direct HTTP; use Cloudflare Bypass only where the site genuinely requires it, and automatically stop using it when it no longer does.
- G3 — Detect endpoint failure reactively (within one search) as well as proactively (scheduled sweep).
- G4 — Never make a search slower in the common case. Search reads resolved state; it never probes inline.
- G5 — Classify failures precisely enough to distinguish endpoint problems from definition problems from credential problems.
- G6 — Probe without generating a traffic pattern that gets the user banned.

### 2.2 Non-goals

- Discovering *new* mirrors not present in the definition or added by the user. (Out of scope; see §16.1.)
- Replacing per-indexer rate limiting or the search scheduler.
- Health-checking download clients or metadata providers. IER is indexer-scoped, though the pattern generalises (see §16.3).
- Automatically editing Cardigann definitions when drift is detected. IER flags; a human or a separate feature fixes.

---

## 3. Concepts

| Term | Meaning |
|---|---|
| **Indexer** | A configured instance of a Cardigann definition (or native implementation). |
| **Endpoint** | One candidate base URL for an indexer. An indexer has 1..N. |
| **Active endpoint** | The single endpoint currently used for searches. Exactly one per enabled indexer, unless all are dead. |
| **Probe** | A single measurement of one endpoint, direct or via Cloudflare Bypass. |
| **Tier** | Coarse quality class of an endpoint: A (works direct), B (works via Cloudflare Bypass), C (degraded), D (dead). |
| **Failure class** | Structured reason a probe failed. Drives the retry decision (§6.3). |
| **Resolution** | The act of scoring all endpoints for an indexer and choosing the active one. |

---

## 4. User-visible behaviour

1. On adding an indexer, IER probes all candidate endpoints immediately and reports which was selected and why.
2. The indexer list shows a health pill per indexer: **Direct** (green), **Via Cloudflare Bypass** (amber), **Degraded** (orange), **Down** (red).
3. Expanding an indexer shows every endpoint with tier, latency, 7-day success rate, last-good timestamp and last error.
4. A user can pin an endpoint (disables auto-selection for that indexer), disable an endpoint, or add a custom one.
5. When IER switches endpoints, a system event appears in the activity feed: *"HDBits: switched to hdbits.org (previous endpoint returned Cloudflare challenge)."*
6. When a search fails against the active endpoint, the user sees results from the failover endpoint, not an error — assuming a viable alternative exists.

---

## 5. Data model

### 5.1 Tables

```sql
CREATE TABLE IF NOT EXISTS indexer_endpoint (
  id                 INTEGER PRIMARY KEY,
  indexer_id         INTEGER NOT NULL REFERENCES indexer(id) ON DELETE CASCADE,
  url                TEXT    NOT NULL,              -- normalised, scheme + host + optional path, no trailing slash
  origin             TEXT    NOT NULL,              -- 'definition' | 'legacy' | 'user'
  ordinal            INTEGER NOT NULL DEFAULT 0,    -- position in the definition's Links array

  -- resolution state
  is_active          INTEGER NOT NULL DEFAULT 0,    -- exactly one per indexer where possible
  is_enabled         INTEGER NOT NULL DEFAULT 1,    -- user can disable a specific endpoint
  is_pinned          INTEGER NOT NULL DEFAULT 0,    -- user override: never auto-switch away

  -- measured state
  tier               TEXT    NOT NULL DEFAULT 'unknown', -- 'A' | 'B' | 'C' | 'D' | 'unknown'
  requires_cloudflare_bypass     INTEGER NOT NULL DEFAULT 0,
  score              REAL    NOT NULL DEFAULT 0,
  latency_p50_ms     INTEGER,
  success_rate_7d    REAL,
  consecutive_fails  INTEGER NOT NULL DEFAULT 0,

  last_probe_at      INTEGER,
  last_ok_at         INTEGER,
  next_probe_at      INTEGER,
  cooldown_until     INTEGER,

  last_failure_class TEXT,
  last_error         TEXT,

  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (indexer_id, url)
);

CREATE INDEX IF NOT EXISTS idx_endpoint_due
  ON indexer_endpoint (next_probe_at)
  WHERE is_enabled = 1;

CREATE INDEX IF NOT EXISTS idx_endpoint_active
  ON indexer_endpoint (indexer_id, is_active);

CREATE TABLE IF NOT EXISTS indexer_probe_result (
  id            INTEGER PRIMARY KEY,
  endpoint_id   INTEGER NOT NULL REFERENCES indexer_endpoint(id) ON DELETE CASCADE,
  probed_at     INTEGER NOT NULL,
  via_cloudflare_bypass     INTEGER NOT NULL,
  trigger       TEXT    NOT NULL,   -- 'scheduled' | 'reactive' | 'manual' | 'onboarding'
  outcome       TEXT    NOT NULL,   -- 'ok' | 'fail'
  failure_class TEXT,
  http_status   INTEGER,
  latency_ms    INTEGER,
  row_count     INTEGER,
  error_detail  TEXT
);

CREATE INDEX IF NOT EXISTS idx_probe_endpoint_time
  ON indexer_probe_result (endpoint_id, probed_at DESC);

CREATE TABLE IF NOT EXISTS indexer_endpoint_session (
  endpoint_id   INTEGER PRIMARY KEY REFERENCES indexer_endpoint(id) ON DELETE CASCADE,
  cookie_jar    TEXT,               -- serialised, encrypted at rest with the existing credential mechanism
  established_at INTEGER,
  expires_at    INTEGER,
  last_used_at  INTEGER
);
```

`indexer_probe_result` is append-only with 30-day retention, pruned by the existing housekeeping worker. It exists so §11 can render a sparkline and so "flaky" can be distinguished from "dead" — a rolling counter alone cannot do that.

### 5.2 Candidate seeding

On indexer create, and on every definition reload:

1. Take `Links[]` in order → `origin='definition'`, `ordinal = index`.
2. Take `Legacylinks[]` → `origin='legacy'`, `ordinal = 1000 + index`.
3. Normalise: lowercase host, strip trailing slash, force `https` where the definition does not explicitly specify `http`.
4. Upsert on `(indexer_id, url)`. **Never delete** endpoints on reload — mark them `is_enabled = 0, origin unchanged` if they vanish from the definition, so their measured history survives a definition update. A URL that comes back later resumes with its history intact.
5. `origin='user'` rows are never touched by definition reloads.

### 5.3 Types

```ts
export type EndpointTier = 'A' | 'B' | 'C' | 'D' | 'unknown';

export type FailureClass =
  | 'dns'              // resolution failed
  | 'connect'          // TCP/TLS failure, refused, timeout at transport
  | 'timeout'          // request exceeded budget
  | 'challenge'        // bot wall: CF/DDoS-Guard interstitial detected
  | 'rate_limited'     // 429 or definition-declared throttle response
  | 'auth'             // 401/403 non-challenge, or login form returned
  | 'http_error'       // 5xx, unexpected 4xx
  | 'parse'            // 200 + selectors did not match definition
  | 'empty'            // 200 + selectors matched + zero rows on a browse query
  | 'unknown';

export interface ProbeResult {
  outcome: 'ok' | 'fail';
  viaCloudflareBypass: boolean;
  failureClass?: FailureClass;
  httpStatus?: number;
  latencyMs: number;
  rowCount?: number;
  errorDetail?: string;
}
```

---

## 6. Probe engine

### 6.1 Contract

```ts
export interface ProbeOptions {
  allowCloudflareBypass: boolean;
  timeoutMs: number;          // default 15_000 direct, 45_000 bypass
  mode: 'browse' | 'search';
  probeTerm?: string;         // only when mode = 'search'
  signal?: AbortSignal;
}

export async function probeEndpoint(
  endpoint: IndexerEndpoint,
  definition: CardigannDefinition,
  opts: ProbeOptions,
): Promise<ProbeResult>;
```

**`probeEndpoint` is a pure measurement function.** It takes no scheduling decisions, writes nothing to the database, and mutates no selection state. Scoring (§7), persistence and scheduling (§8) sit above it. This separation is what makes the whole thing testable — see §15.

### 6.2 Probe query selection

Ordered preference, resolved once per indexer and cached:

1. **Browse/latest with empty query**, if the definition declares a search mode that accepts no keyword. This is the correct probe: it should *always* return rows, so zero rows is unambiguous.
2. **Definition-declared test query**, if present.
3. **High-yield generic term** by indexer category: `1080p` (video), `flac` (music), `epub` (books), `2160p` fallback.

> **This choice is load-bearing.** Probing with a keyword conflates three different states — site blocked, definition drifted, and query legitimately empty — and every one of them looks like "0 results". Getting this wrong makes the entire failure taxonomy in §6.3 unreliable, and the system will start switching endpoints for no reason. If a definition supports no browse mode, mark the indexer `probeConfidence: 'low'` and require two consecutive failures before acting on an `empty` result.

### 6.3 Failure taxonomy and response

| Failure class | Detection | Retry via Cloudflare Bypass? | Endpoint verdict | Notes |
|---|---|---|---|---|
| `dns` | resolver error | No | D — dead | Fast fail, cheap |
| `connect` | ECONNREFUSED / TLS error | No | D — dead | |
| `timeout` | budget exceeded | No | C — degraded | Could be transient; needs 3 strikes |
| `challenge` | 403/503 + CF markers (`cf-mitigated` header, `__cf_chl`, DDoS-Guard body signature) | **Yes** | B if Cloudflare Bypass succeeds, else D | The only class that justifies Cloudflare Bypass |
| `rate_limited` | 429, `Retry-After`, definition throttle pattern | No | unchanged | **Do not penalise the endpoint.** Set `cooldown_until` and re-probe later |
| `auth` | 401/403 without challenge markers, or login page selectors match | No | C — degraded | Triggers §6.5 re-auth, then one retry |
| `http_error` | 5xx | No | C — degraded | 3 strikes → D |
| `parse` | 200, page fetched, row selectors do not match | No | C, **and flag the definition** | Cloudflare Bypass cannot fix a broken selector |
| `empty` | 200, selectors match, zero rows on a browse probe | No | C — degraded | Shadow-ban or empty mirror |

The two rows people get wrong: `rate_limited` must not count against the endpoint (you'll demote your *best* indexer for being used most), and `parse` must not trigger Cloudflare Bypass (you'll burn a browser instance to reproduce the same selector miss, on every endpoint, every sweep).

### 6.4 Probe ladder

```
probeEndpointResolved(endpoint, definition, allowCloudflareBypass):

  1. direct = probeEndpoint(endpoint, definition, { allowCloudflareBypass: false, mode })

  2. if direct.outcome == 'ok':
       return { tier: 'A', requiresCloudflareBypass: false, ...direct }

  3. if direct.failureClass == 'auth' and credentials exist:
       reauthenticate(endpoint)                     // §6.5
       retry = probeEndpoint(...)                   // one retry only
       if retry.outcome == 'ok': return tier A

  4. if direct.failureClass == 'challenge' and allowCloudflareBypass:
       bypass = probeEndpoint(endpoint, definition, { allowCloudflareBypass: true, mode })
       if bypass.outcome == 'ok':
         return { tier: 'B', requiresCloudflareBypass: true, ...bypass }
       return { tier: 'D', ...bypass }

  5. return { tier: tierForFailure(direct.failureClass), ...direct }
```

### 6.5 Session and credential binding

**Sessions are per-endpoint, not per-indexer.** Cookies are scoped to a domain; switching mirrors on a private tracker silently invalidates the session, and the symptom is an `auth` failure that looks like bad credentials.

Rules:

- `indexer_endpoint_session` holds the cookie jar keyed by `endpoint_id` (§5.1).
- Credentials (username/password/API key/passkey) stay on the **indexer**, since they're the same account regardless of mirror.
- On endpoint switch, the new endpoint's session is established on first use, not eagerly at switch time.
- `auth` failure on the active endpoint invalidates only that endpoint's session and triggers exactly one re-auth attempt per probe.
- **Guard:** if the same credentials produce `auth` failures on ≥2 distinct endpoints within one resolution cycle, mark the *indexer* `credentialsSuspect = true`, stop re-auth attempts, and surface to the user. Retrying bad credentials across five mirrors is how accounts get locked.

### 6.6 Cloudflare Bypass budget

- Global semaphore, default `maxConcurrentCloudflareBypassProbes = 2`, separate from the runtime Cloudflare Bypass pool so probing never starves live searches.
- Probe traffic runs at lower priority than search traffic in the Cloudflare Bypass queue.
- Cloudflare Bypass probes are skipped entirely if Cloudflare Bypass is unconfigured or unhealthy; endpoints that previously resolved tier B retain their last-known state and are marked `stale` rather than demoted.

### 6.7 Cloudflare Bypass demotion test

An endpoint at tier B must periodically re-test **direct**, because sites drop bot walls as often as they add them. Every 4th scheduled probe of a tier-B endpoint runs step 1 of the ladder only. Success promotes it to tier A and clears `requires_cloudflare_bypass`.

Without this, every indexer that ever hit a challenge stays permanently on the expensive path.

---

## 7. Scoring and selection

### 7.1 Score

```ts
const TIER_WEIGHT = { A: 1000, B: 400, C: 100, D: 0, unknown: 50 };
const INCUMBENCY_BONUS = 150;

score(e) =
    TIER_WEIGHT[e.tier]
  + (e.successRate7d ?? 0.5) * 200
  - Math.min(latencyP50Ms / 10, 150)
  - Math.min(consecutiveFails * 50, 200)
  + (e.isActive ? INCUMBENCY_BONUS : 0)
  + (e.origin === 'user' ? 50 : 0)          // explicit user intent counts for something
  - (e.origin === 'legacy' ? 100 : 0);      // legacy links are last-resort by definition
```

### 7.2 Selection rules

1. Candidates = endpoints where `is_enabled = 1` and `cooldown_until` is null or past.
2. If any endpoint has `is_pinned = 1`, it is selected unconditionally. Auto-selection is disabled for that indexer; a pinned endpoint that fails raises a user-facing warning rather than switching.
3. Otherwise select `max(score)`.
4. **Hysteresis:** switch away from the incumbent only if the challenger's score exceeds the incumbent's by more than the incumbency bonus already baked in — i.e. the raw comparison must be decisive. This prevents mirror flapping between two near-identical endpoints on every sweep.
5. **Immediate override:** if the incumbent is tier D, switch regardless of hysteresis.
6. If no candidate scores above zero, set the indexer to `unreachable`, clear `is_active`, and emit `indexer.unreachable`. Do not silently return empty search results.

### 7.3 Switch throttle

An indexer may switch active endpoints at most once every 10 minutes, except when the incumbent is tier D. Prevents pathological oscillation during a partial outage.

---

## 8. Scheduling

### 8.1 Model

Not a monolithic cron sweep. A **due-time queue** (`next_probe_at`) drained by a single worker on the existing job runner.

```
every 60s:
  claim up to N endpoints where next_probe_at <= now
    and is_enabled = 1
    and (cooldown_until IS NULL OR cooldown_until <= now)
  order by next_probe_at asc
  probe each (respecting §8.3 limits)
  persist result, recompute score, run resolution for affected indexers
```

### 8.2 Cadence

| State | Base interval | Notes |
|---|---|---|
| Tier A, active | 12h | |
| Tier A, standby | 24h | Standby endpoints need less attention |
| Tier B (Cloudflare Bypass) | 6h | Every 4th probe is a demotion test (§6.7) |
| Tier C (degraded) | 1h, ×2 backoff per consecutive failure, capped 6h | |
| Tier D (dead) | 24h, → 72h after 7 days dead | Domains do come back |
| Unknown / new | immediate | |

All intervals get **±25% jitter**. Non-negotiable — see §8.3.

### 8.3 Rate limiting and ban avoidance

Probing is the single highest-risk part of this feature. A naive implementation hits every mirror of every indexer on a synchronised schedule, which is a distinctive fingerprint and a plausible route to an account or IP ban on private trackers.

Controls:

- `maxConcurrentProbes` global, default 4.
- `maxConcurrentProbesPerHost` = 1.
- Per-indexer minimum interval between *any* two probes of *any* of its endpoints: 60s. Never probe five mirrors of the same tracker back to back — from the tracker's perspective that is one client scanning its infrastructure.
- Probe requests reuse the indexer's normal user-agent, headers and rate-limit bucket. A probe must be indistinguishable from a search.
- **Private tracker policy:** if a definition is flagged private and has more than one endpoint, probe only the active endpoint on the normal cadence; probe standby endpoints only reactively (on active failure) or manually. Ratio-tracking sites do not need Archivist touching four mirrors a day.
- Respect `Retry-After` absolutely.

---

## 9. Runtime integration

### 9.1 Search path

Search resolves the base URL from `indexer_endpoint WHERE is_active = 1`. It never probes inline and never blocks on IER. If no active endpoint exists, the search fails fast for that indexer with a typed error and the rest of the search continues.

### 9.2 Circuit breaker

```
on search failure against active endpoint:
  classify failure (§6.3, same classifier — shared code path)
  if class in {rate_limited}: back off, do not count
  else: consecutive_fails += 1

  if consecutive_fails >= BREAKER_THRESHOLD (default 3):
     mark endpoint degraded (tier C)
     enqueue urgent probe (next_probe_at = now)
     run resolution immediately
     if a viable alternative exists:
        switch active endpoint
        RETRY THE CURRENT SEARCH ONCE against the new endpoint
```

The in-search retry is the point of the whole feature. Everything else is bookkeeping; G3 is delivered here.

Half-open behaviour: an endpoint demoted by the breaker returns to candidacy only after a successful scheduled probe, not on a timer.

### 9.3 Events

Emitted on the `CoreEvent` spine:

| Event | Payload | Consumers |
|---|---|---|
| `indexer.endpoint.probed` | endpointId, outcome, tier, latency, viaCloudflareBypass | health UI, metrics |
| `indexer.endpoint.switched` | indexerId, fromUrl, toUrl, reason | activity feed, notifications |
| `indexer.endpoint.failed` | endpointId, failureClass | breaker, UI |
| `indexer.unreachable` | indexerId, endpointCount | notifications — this one is user-actionable |
| `indexer.definition.drift_suspected` | indexerId, definitionId, endpointIds[] | definition triage (§10.2) |
| `indexer.credentials_suspect` | indexerId | notifications |

---

## 10. Derived capabilities

### 10.1 Auto-disable

An indexer whose endpoints are all tier D for 14 consecutive days is auto-disabled with a notification, not deleted. Stops dead indexers from adding latency and log noise to every search indefinitely.

### 10.2 Definition drift detection

If `parse` failures occur on **≥2 distinct endpoints** of the same definition, the problem is the definition, not the sites. Emit `indexer.definition.drift_suspected`.

This is the highest-leverage side effect of the design and it costs almost nothing to add. Nothing in the current ecosystem tells a user "this Cardigann definition broke upstream" — they just get silent empty results. Two failing endpoints of the same definition is a near-conclusive signal.

Optional phase 3: aggregate anonymised drift signals to prioritise definition maintenance upstream. Out of scope here.

### 10.3 Health surface

`GET /api/v1/health/indexers` returns per-indexer tier, active endpoint, and last-good timestamp. Feeds the dashboard health widget and gives external monitoring something to scrape.

---

## 11. API surface

```
GET    /api/v1/indexers/:id/endpoints
         → endpoint list with full measured state

POST   /api/v1/indexers/:id/endpoints
         body: { url }
         → adds origin='user' endpoint, probes immediately

DELETE /api/v1/indexers/:id/endpoints/:endpointId
         → only permitted for origin='user'

PATCH  /api/v1/indexers/:id/endpoints/:endpointId
         body: { isEnabled?, isPinned? }

POST   /api/v1/indexers/:id/endpoints/resolve
         → force full probe of all endpoints + resolution; returns the decision

POST   /api/v1/indexers/:id/endpoints/:endpointId/probe
         body: { allowCloudflareBypass?: boolean }
         → single probe, returns ProbeResult, does not alter selection unless it changes tier

GET    /api/v1/indexers/:id/endpoints/:endpointId/history?days=7
         → probe results for the sparkline
```

All request and response bodies validated with Zod schemas exported from `@mediastack/core` so the frontend consumes the same types.

---

## 12. UI

Neon-noir, consistent with the existing indexer screens.

**Indexer list row** — health pill right of the indexer name:

- `DIRECT` — accent green
- `CLOUDFLARE-BYPASS` — amber, with a small browser glyph
- `DEGRADED` — orange, pulsing
- `DOWN` — red
- `PINNED` — outline pill, overrides the above

**Indexer detail → Endpoints tab** — table:

| | URL | Tier | Latency | 7d | Last good | |
|---|---|---|---|---|---|---|
| ● | `https://site.org` | A · Direct | 340ms | ▁▃▅█▇█ 96% | 4m ago | ⋯ |
| ○ | `https://site.me` | B · Cloudflare Bypass | 2.1s | ▅▁▃▂▅▃ 61% | 3h ago | ⋯ |
| ○ | `https://old.site` | D · Dead | — | ▁▁▁▁▁▁ 0% | 21d ago | ⋯ |

- Active endpoint marked with a filled indicator; radio-style click to pin.
- Row menu: Probe now · Pin · Disable · Remove (user endpoints only).
- Sparkline is the 7-day probe history from `indexer_probe_result` — 14 buckets, height = success rate.
- Failure classes render as human sentences, not enum values: *"Cloudflare challenge — solved via Cloudflare Bypass"*, *"Page loaded but no results matched the definition — the definition may be out of date."*

Header action: **Re-resolve all** — forces a full sweep, with a confirmation noting it will generate traffic to every configured indexer.

---

## 13. Configuration

| Setting | Default | Scope |
|---|---|---|
| `ier.enabled` | true | global |
| `ier.probeIntervalTierA` | 12h | global |
| `ier.probeIntervalTierB` | 6h | global |
| `ier.probeIntervalDegraded` | 1h | global |
| `ier.probeIntervalDead` | 24h | global |
| `ier.maxConcurrentProbes` | 4 | global |
| `ier.maxConcurrentCloudflareBypassProbes` | 2 | global |
| `ier.perIndexerMinIntervalSec` | 60 | global |
| `ier.breakerThreshold` | 3 | global |
| `ier.switchThrottleMin` | 10 | global |
| `ier.allowCloudflareBypassProbes` | true | global |
| `ier.probeStandbyOnPrivate` | false | global |
| `ier.autoDisableAfterDays` | 14 | global |
| `ier.mode` | `auto` \| `manual` | per-indexer |

`ier.mode = manual` on an indexer is equivalent to pinning the current endpoint and is the escape hatch for anyone who wants Prowlarr's behaviour back.

---

## 14. Failure modes to design against

Ranked by likelihood of shipping accidentally.

1. **Probe traffic gets the user banned.** Mitigated by §8.3. The private-tracker default (standby endpoints probed reactively only) is the important half; if only one control survives review, keep that one.
2. **Endpoint flapping.** Two marginal mirrors alternate every sweep, sessions get re-established constantly, and search results become inconsistent. Mitigated by hysteresis (§7.2.4) and the switch throttle (§7.3).
3. **`empty` treated as failure when the query was just narrow.** Mitigated by browse-mode probing (§6.2). This is the single most likely source of wrong behaviour in the whole feature.
4. **Cloudflare Bypass exhaustion.** Probe traffic starves live searches of browser instances. Mitigated by a separate semaphore and lower queue priority (§6.6).
5. **Credential lockout.** Re-auth retried across every mirror. Mitigated by §6.5's two-endpoint guard.
6. **Rate limits counted as endpoint failures.** Demotes the best indexer for being the most used. Mitigated in §6.3.
7. **History lost on definition update.** A definition reload that deletes and recreates endpoint rows resets every measurement and re-probes everything. Mitigated by soft-disable in §5.2.4.
8. **Probes on a synchronised clock.** Jitter (§8.2) is what stops Archivist installs worldwide from hitting the same tracker at the same second.

---

## 15. Testing

**Unit (pure, no network)** — `probeEndpoint` against fixture responses covering every `FailureClass`: CF interstitial HTML, DDoS-Guard body, 429 with `Retry-After`, login page, valid page with mismatched selectors, valid page with zero rows, valid page with rows.

**Scoring** — table-driven tests over synthetic endpoint sets asserting: correct winner, no switch when scores are within hysteresis, immediate switch when incumbent is tier D, pinned endpoint always wins.

**Scheduler** — fake clock; assert cadence per tier, backoff growth, jitter bounds, per-indexer minimum interval respected, concurrency caps respected.

**Breaker (integration)** — mock indexer server that starts healthy, begins returning challenges mid-search; assert the search completes with results from the failover endpoint and exactly one retry occurs.

**Ladder** — assert Cloudflare Bypass is invoked for `challenge` and for **no other class**. This is the assertion that stops a future refactor from quietly making every failure expensive.

**Migration** — existing indexers with a manually configured URL migrate to an `origin='user'`, `is_pinned=1` endpoint. Behaviour is unchanged until the user opts into auto.

---

## 16. Phasing

**Phase 1 — measurement, no automation.**
Schema, `probeEndpoint`, failure classifier, scheduler, endpoints UI. IER measures and displays but never switches. Ships a health screen that's already better than Prowlarr's, and generates real-world classifier data before any automated behaviour depends on it.

**Phase 2 — resolution and breaker.**
Scoring, hysteresis, auto-switch, circuit breaker with in-search retry, `indexer.endpoint.switched` events. Default `ier.mode = auto` for new indexers; existing indexers stay pinned until the user opts in.

**Phase 3 — derived value.**
Cloudflare Bypass demotion testing, definition drift detection, auto-disable, health API.

Phase 1 is genuinely useful alone. That's the test of whether the phasing is honest.

---

## 17. Open questions

1. **17.1** Should IER endpoints be exposed via the Torznab/Newznab-compatible API for external consumers, or stay internal? *Recommendation: internal for now.*
2. **17.2** Should a tier-B (Cloudflare Bypass-required) endpoint ever beat a tier-A endpoint on latency alone? Current scoring says no — the 600-point tier gap is unbridgeable. That's deliberate but worth confirming.
3. **17.3** Mirror discovery from a site's own mirror-list page is tempting and is how users find new domains in practice. It is also how a compromised mirror page gets Archivist to send credentials to an attacker. Deliberately out of scope; revisit only with strict allowlist semantics.
4. **17.4** Should probe history feed a global reliability score shown when *adding* an indexer? Requires opt-in telemetry. Separate decision.
