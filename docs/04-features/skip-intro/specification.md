---
title: "Archivist Skip Intro & Skip Credits — Feature Specification"
document_type: feature-specification
status: historical
classified: 2026-08-16
---
# Archivist Skip Intro & Skip Credits — Feature Specification

Status: revised implementation specification. Production rollout is gated by the detector spike and acceptance thresholds in sections 17 and 39.
Revision: 2 (corrected after repository viability review, 2026-07-14).
Reference feature: [intro-skipper for Jellyfin](https://github.com/intro-skipper/intro-skipper).
Repository state observed: 2026-07-14.

---

## 1 Feature Summary

Detect intro and credits segments for collected TV episodes, persist the resulting timestamps and the expensive audio fingerprints, and expose manual Skip Intro and Skip Credits controls in both Archivist playback paths. Optional automatic skipping is off by default and is allowed only for high-confidence markers.

The durable unit is the **media content**, not an `episodes.id`, file path, series row, or logical episode number. An unchanged media file can move, lose its series row, be restored from backup, or be linked from another library without repeating FFmpeg or Chromaprint work. A different encode or cut receives a different signature and is analysed separately.

Analysis is multi-signal:

1. Named embedded chapters are the fastest and most precise source.
2. Chromaprint finds recurring audio across episodes and is the primary fallback for intros and recurring ending themes.
3. Black-frame and silence detection may refine a suspected credits boundary, but neither may create a credits marker by itself.

## 2 Viability and Delivery Gate

The feature is architecturally viable in Archivist. The repository already has SQLite migrations, chapter probing, FFmpeg/FFprobe, bounded media-analysis queues, import completion hooks, Player track metadata, direct and compatibility seeking, Channels playback, and an Up Next state machine.

The detector is the only research-sensitive component. Before the database, API, and UI implementation proceeds beyond scaffolding, a bounded spike MUST demonstrate the matcher against generated fixtures and a private representative corpus. The spike must establish:

- no naive all-offset `O(frames²)` comparison;
- intro precision of at least 95% on the evaluation corpus;
- no black-frame-only credits markers;
- deterministic timestamps within one second across repeated runs;
- the performance budgets in section 36 on a two-core container.

If the spike misses a gate, ship chapter-based markers and manual Skip Intro first; keep Chromaprint credits and automatic skipping disabled until the gate is met.

## 3 Resolved Product Decisions

- TV episodes and Channels items backed by TV episodes are in scope. Films are out of scope.
- Analysis is grouped by current season because cross-episode matching needs a comparison set.
- Durable storage is keyed by a versioned sampled media signature. Logical series and episode identities are descriptive metadata, not uniqueness keys.
- Episode linkage is stored separately and may cascade with `episodes`; durable timestamps and fingerprints never cascade with a library, series, season, or episode.
- Same-signature re-import restores timestamps without FFmpeg, FFprobe, or fpcalc. A different file signature intentionally triggers analysis.
- Fingerprints are cached durably so matcher/configuration changes can re-match without decoding the media again.
- Manual controls ship before operators are encouraged to enable automatic skipping.
- Credits use chapters or recurring tail audio, optionally refined by black/silence candidates. The last black frame is not a valid credits start.
- Initial detection is opt-in (`ARCHIVIST_SKIP_INTRO_ENABLED=false` by default) to avoid an unexpected CPU sweep on existing installations.

## 4 Goals

1. Produce `introStart`/`introEnd` and, when confidently detectable, `creditsStart` for collected TV episodes.
2. Persist markers, confidence, method, matcher version, media signature, and reusable audio fingerprints in the unified SQLite database.
3. Restore same-signature markers after a path change, series deletion, media loss, database restore, or cross-library re-link with zero FFmpeg/fpcalc calls.
4. Retain separate analysis for different cuts/releases of the same logical episode.
5. Decode each `(media_signature, fingerprint_algorithm, window)` at most once unless an administrator explicitly chooses **Re-fingerprint**.
6. Re-run the cheap in-process matcher when a season's file set or matcher configuration changes, reusing cached fingerprints.
7. Keep all analysis bounded, deduplicated, cancellable, restart-safe, and non-blocking to playback routes.
8. Add segments to the existing tracks response and support both `Player.tsx` and `SessionPlayer.tsx` without altering stream timestamps.
9. Preserve loudness, transcode, subtitle, progress, Channels scheduling, and Up Next behavior except for explicitly defined additive integration.

## 5 Non-Goals

- Films, music, books, comics, and games.
- Recap, preview, advertisement, or commercial detection.
- Crowd-sourced or external segment databases.
- A manual timestamp editor in the first release.
- Replacing Archivist's transcode, loudness, import, or durable job systems.
- A message bus, external analysis service, or cron dependency.
- Guaranteeing restoration for a different encode merely because its title, episode number, or file size matches.
- Copying source code from the reference project; implementation may reproduce the behavior and documented algorithm under Archivist's GPL-3.0 license.

## 6 Existing Repository Behavior

### 6.1 Database and identities

Before this feature, `packages/db/src/schema.ts` ended at migration v3; segment storage is therefore migration v4 in this checkout. `series` is unique by `(library_id, tvdb_id)`, so the same show can exist in multiple libraries. `episodes` cascades from `series` and is unique by `(series_id, season_number, episode_number)`. `episodes` already records `file_path`, `file_size`, `tvdb_episode_id`, and current release metadata.

### 6.2 Media analysis

`apps/server/src/player/loudness.ts` provides a proven dedicated in-process queue with bounded concurrency, priority, deduplication, cached reads, and a deferred startup sweep. It is a structural model only; segment analysis remains a separate service.

`apps/server/src/services/media-processor.ts` already exposes `probeChapters()` and preserves chapter metadata through processing. The runtime image already installs system FFmpeg and also carries `ffmpeg-static`/`ffprobe-static` dependencies.

### 6.3 Player

The server route is `GET /api/v1/player/stream/:type/:id/tracks`, where `type` is plural: `films | episodes`. It returns `MediaTracks` with duration, tracks, direct-play capability, and loudness.

`Player.tsx` and `SessionPlayer.tsx` own their inline transport overlays, absolute displayed time, and direct/compatibility seek behavior. They MUST both be modified for skip actions, auto-skip guards, bounded marker refresh, and SessionPlayer's existing inline Up Next behavior.

### 6.4 Preferences

Player preferences are localStorage-backed and loaded by shallow-merging persisted values over `DEFAULTS`. Adding both new booleans to `Settings` and `DEFAULTS` therefore normalizes old documents to `false` without a server preference migration.

## 7 Proposed Architecture

```text
 episode import / sweep / first play
                │
                ▼
     bounded content signature (12 MiB maximum read)
                │
       ┌────────┴─────────┐
       │ signature exists │──► link episode ──► reuse markers (no FFmpeg/fpcalc)
       └────────┬─────────┘
                │ new signature
                ▼
     media_segments placeholder + episode link
                │
                ▼
     season queue (dedup, priority, cancellation)
                │
       ┌────────┴─────────────────────────┐
       │ named chapters                   │
       │ cached/generate head fingerprint │
       │ cached/generate tail fingerprint │
       │ indexed cross-episode matcher    │
       │ black/silence boundary refinement│
       └────────┬─────────────────────────┘
                ▼
 media_segments + media_segment_fingerprints
                │
                ▼
 MediaTracks.segments ──► Player / SessionPlayer ──► SkipSegmentButton
```

## 8 Architectural Decisions

- **SD-001 — Content signature is the durable key.** Use `sampled-sha256-v1:<hex>` over file size plus deterministic head/middle/tail samples. A path is mutable metadata only.
- **SD-002 — Separate durable data from row linkage.** `media_segment_links.episode_id` may cascade; `media_segments` and `media_segment_fingerprints` have no foreign key to series/episode tables.
- **SD-003 — Multiple releases are retained.** One logical episode may have several durable signatures over time. Re-link selects only the current signature.
- **SD-004 — Cache fingerprints, not only timestamps.** Threshold or matcher changes re-run matching without media decode. Fingerprint window/algorithm changes may require an explicit new fingerprint.
- **SD-005 — Chapter-first, multi-signal detection.** Chapters may directly produce markers. Chromaprint supplies recurring-audio candidates. Black/silence only refine credits candidates.
- **SD-006 — No global hard-coded Chromaprint frame rate.** Persist algorithm/version-specific `seconds_per_frame`; obtain it through a versioned extractor adapter and validate it against generated timing fixtures in the detector spike.
- **SD-007 — File-set idempotency.** `analysis_set_hash` is a hash of sorted current media signatures plus detector/matcher configuration. An unchanged set is not re-matched.
- **SD-008 — Dedicated queue with process cancellation.** Do not mix season work into the loudness queue or single-slot durable job runner.
- **SD-009 — Existing tracks response, bounded refresh.** Segments arrive with `MediaTracks`; if analysis is queued, the player may make at most three delayed refreshes. There is no OSD-frame fetch.
- **SD-010 — Both playback owners change.** `Player.tsx` and `SessionPlayer.tsx` own seek/advance and must implement the behavior; a shared `SkipSegmentButton` renders the independent overlay.
- **SD-011 — Backward-compatible preference normalization.** Add both booleans to local `DEFAULTS`; the existing shallow merge reads missing values as `false` and the next settings write persists the normalized shape.
- **SD-012 — Safe rollout.** Detection defaults off, concurrency defaults to one, startup backfill is capped, and auto-skip defaults off.

## 9 Content Signature

`computeMediaSignature(filePath)` performs bounded read-only I/O:

1. Read file size.
2. For files up to 12 MiB, hash the entire file.
3. For larger files, hash a version tag, file size, and three 4 MiB regions: start, centered middle, and end.
4. Return `sampled-sha256-v1:<lowercase hex>`.

Requirements:

- use `open/read/close`; never load a whole large file into memory;
- cap concurrent signature work with the segment queue;
- identical bytes at a new path produce the same signature;
- a signature hit is sufficient to re-link markers because the marker timestamps describe that same sampled media content;
- the algorithm name/version is part of the value so a future stronger signature can coexist;
- do not describe this as a cryptographic proof of whole-file equality. It is a versioned media cache key with a negligible accidental-collision risk for this use.

## 10 Database Design — Migration v4

Add all three tables to `SCHEMA` and migration v4 with identical `CREATE TABLE IF NOT EXISTS` definitions:

```sql
CREATE TABLE IF NOT EXISTS media_segments (
  media_signature       TEXT PRIMARY KEY,
  signature_algorithm   TEXT NOT NULL DEFAULT 'sampled-sha256-v1',
  file_size             INTEGER NOT NULL,
  intro_start_seconds   REAL,
  intro_end_seconds     REAL,
  intro_method          TEXT,
  intro_confidence      REAL,
  credits_start_seconds REAL,
  credits_end_seconds   REAL,
  credits_method        TEXT,
  credits_confidence    REAL,
  analysis_set_hash     TEXT,
  detector_version      TEXT NOT NULL,
  analysis_state        TEXT NOT NULL DEFAULT 'pending'
    CHECK (analysis_state IN (
      'pending','queued','analysing','detected','partial',
      'no_match','failed','cancelled'
    )),
  attempts              INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  analysed_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_segment_fingerprints (
  media_signature  TEXT NOT NULL
                   REFERENCES media_segments(media_signature) ON DELETE CASCADE,
  window_kind      TEXT NOT NULL CHECK (window_kind IN ('head','tail')),
  algorithm        TEXT NOT NULL,
  encoding         TEXT NOT NULL DEFAULT 'zlib-int32le-v1',
  fingerprint      BLOB NOT NULL,
  frame_count      INTEGER NOT NULL,
  seconds_per_frame REAL NOT NULL,
  processed_start  REAL NOT NULL,
  processed_duration REAL NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (media_signature, window_kind, algorithm)
);

CREATE TABLE IF NOT EXISTS media_segment_links (
  episode_id       INTEGER PRIMARY KEY
                   REFERENCES episodes(id) ON DELETE CASCADE,
  media_signature  TEXT NOT NULL
                   REFERENCES media_segments(media_signature) ON DELETE RESTRICT,
  file_path        TEXT NOT NULL,
  file_size        INTEGER NOT NULL,
  linked_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_media_segments_state
  ON media_segments(analysis_state, updated_at);
CREATE INDEX IF NOT EXISTS idx_media_segment_links_signature
  ON media_segment_links(media_signature);
```

Durability semantics:

- deleting a series cascades through episodes and removes only `media_segment_links`;
- the segment and fingerprint rows remain;
- re-import computes the signature and recreates the link;
- two libraries can link different releases without collision;
- two libraries containing the same exact media may link the same durable segment;
- orphan cleanup may delete only segment rows with no links and only when the explicit retention is non-zero;
- database backup already captures all three tables, including the potentially material fingerprint BLOBs.

## 11 Series Metadata

Series and season identifiers are queue/grouping inputs only and are not copied into the durable segment key. The detector selects episodes through the existing `series_id` and `season_number` columns, then persists only the content signature and episode link. Provider IDs never decide that timestamps from one encode are safe for another encode.

## 12 State Model

State is persisted per media signature:

| State | Meaning | Normal exit |
|---|---|---|
| `pending` | linked media needs evaluation | `queued` |
| `queued` | season job is queued | `analysing`, `cancelled` |
| `analysing` | one or more child processes/matcher work active | result state, `failed`, `cancelled` |
| `detected` | intro and credits found | re-match only if set/config changes |
| `partial` | one supported segment found | re-match only if set/config changes |
| `no_match` | analysed successfully but no safe marker found | re-match only if set/config changes |
| `failed` | processing failed with diagnostic | manual retry or eligible sweep |
| `cancelled` | user/shutdown cancellation completed | manual retry |

On startup, any `analysing` row from an interrupted process becomes `pending`; persisted `queued` rows are re-enqueued only when detection is enabled. `no_match` is terminal for the same `analysis_set_hash`, preventing endless re-analysis.

## 13 Detection Pipeline

### 13.1 Chapter candidates

Reuse `probeChapters()` and normalize chapter titles. Configured case-insensitive patterns recognize conservative names such as `intro`, `opening`, `op`, `credits`, `end credits`, `ending`, and `ed`. Generic `Chapter 01` names do not qualify.

- A named intro chapter supplies its start/end directly.
- A named credits chapter supplies `creditsStart` directly.
- Validate every boundary against duration and configured segment length limits.
- Chapter-derived markers receive method `chapter` and high confidence, but still fail closed on invalid or overlapping boundaries.

### 13.2 Fingerprint extraction

Head fingerprints cover the smaller of the configured intro window, the first 25% of duration, or the available media. Tail fingerprints cover the configured credits window.

- For a head window beginning at zero, invoke `fpcalc` directly with raw output and a bounded length.
- For a non-zero tail window, spawn FFmpeg and fpcalc without a shell, pipe a bounded decoded audio slice between them, and propagate cancellation to both processes.
- Use argument arrays only; never interpolate a media path into a shell command.
- Include extractor version, fpcalc/Chromaprint version, algorithm number, sample parameters, and requested window specification in the `algorithm` cache key.
- Store the raw `Int32Array` as a versioned compressed BLOB with frame count, algorithm-specific seconds per frame, processed start, and processed duration.
- Resolve seconds per frame through the versioned extractor adapter and verify it against generated media with known offsets; do not infer one universal rate from an unrelated build.
- A cache hit skips both child processes.
- No-audio and too-short-audio outcomes are typed `no_match`, not process crashes.

### 13.3 Intro matcher

The matcher MUST use an indexed candidate-offset strategy, such as short rolling anchors plus an offset histogram, followed by contiguous Hamming-similarity verification. It MUST NOT compare every frame in one episode with every frame in another.

Rules:

- search only within the bounded head window;
- accept segments between 15 and 120 seconds;
- require support from at least `max(2, ceil(0.5 * eligibleEpisodes))` episodes;
- verify each candidate with the configured median Hamming similarity;
- cluster per-episode offsets rather than assuming the intro starts at the same timestamp;
- choose the longest supported candidate after removing contained duplicates;
- convert frame positions with the persisted `seconds_per_frame` value for that exact extractor algorithm/version;
- confidence combines consensus fraction, median similarity, and duration stability;
- return no marker when candidates are ambiguous or below threshold.

### 13.4 Credits matcher and boundary refinement

Credits detection uses this precedence:

1. Valid named credits chapter.
2. Recurring tail-audio candidate between 15 and 300 seconds, found with the same indexed matcher principles.
3. Optional boundary refinement using black-frame and silence candidates near the beginning of the recurring tail candidate.

Black/silence rules:

- scan only the bounded tail window;
- treat results as candidate transition points, not proof of credits;
- a refinement point must fall within the configured tolerance around a chapter/audio candidate;
- choose the earliest supported boundary near the candidate, not the final black run in the file;
- never create `creditsStart` from black frames or silence alone;
- if credits differ too much between episodes and chapters are absent, store `creditsStart=null`.

## 14 Season Analysis and Idempotency

`analyseSeason(seriesId, seasonNumber)`:

1. Load currently collected episodes for the season and create missing signature/link rows before matching (needed for pre-v4 libraries and first-play lazy enqueue).
2. Compute `analysis_set_hash = sha256(sorted(mediaSignatures) + detectorVersion + matcherConfig)`.
3. If every linked row already has that hash and a terminal success/no-match state, return without work.
4. Resolve chapter candidates.
5. Load cached fingerprints and generate only missing `(signature, algorithm, window)` entries.
6. Match intros and credits across eligible episodes.
7. Write all marker results and states in one transaction.

When a new episode or release changes the season set, the matcher runs again but unchanged files retain their fingerprints. A force **Re-fingerprint** action deletes only the selected cached fingerprint algorithm/window before enqueueing; it never deletes unrelated historical signatures.

Seasons with fewer than two eligible episode fingerprints still use named chapters. They do not use cross-episode Chromaprint matching.

## 15 Queue, Cancellation, and Shutdown

Create `apps/server/src/segments/queue.ts` with a dedicated queue keyed by `seriesId:seasonNumber`:

- default concurrency one;
- high priority for an episode currently opened in Player;
- normal priority for import and sweep;
- deduplicate queued and active seasons;
- cap each sweep before enqueueing;
- expose queued/active/current subject status;
- keep an `AbortController` and child-process handles for every active season;
- queued cancellation removes the job and marks affected pending rows `cancelled`;
- active cancellation sends `SIGTERM`, waits up to five seconds, then uses `SIGKILL` if necessary;
- shutdown performs the same cancellation and awaits process exit;
- cancelled/failed jobs do not stop queue draining.

No undocumented retry timer is introduced. `failed` rows are retried by an explicit manager action or a later sweep only when their backoff age is eligible. Backoff eligibility is calculated from `attempts`/`failed_at`; the sweep itself remains manually triggered or startup-triggered, not cron-based.

## 16 Import and Re-link Flow

After an episode is successfully marked collected, the import path enqueues its season and returns without waiting. Season/series-pack imports enqueue each affected season once after its pack loop. The queue deduplicates those requests.

The bounded worker computes signatures, upserts durable placeholders and episode links, reuses current cached results where possible, and generates only missing fingerprints. Signature, chapter, FFmpeg, and fpcalc work therefore cannot extend an import request or a Player tracks request. Analysis failures are recorded but never fail the media import.

The startup/manager sweep applies the same worker flow to already-collected episodes that predate migration v4; it never performs signature work in the tracks request.

Changing file path alone does not invalidate markers. A changed signature changes the link to a new durable row; the old segment remains as orphan history. There is no `stale` state because staleness belongs to a mutable episode link, not immutable analysed content.

## 17 Detector Spike

Implement and approve this step before production rollout:

1. Generated fixtures with known repeated tones/noise, offsets, recaps, short logos, silence, and black transitions.
2. Private local corpus covering at least eight series and including short/long intros, variable offsets, cold opens, streaming logos, anime opening/ending patterns, recap-before-intro, and episodes with no recurring intro.
3. Record precision, recall, false positives, analysis time, matcher time, and memory.
4. Confirm seconds/frame derivation using the installed fpcalc build.
5. Confirm cancellation terminates both sides of the tail-audio pipeline.
6. Store the benchmark report under `docs/` without media, fingerprints, titles, or paths from the private corpus.

Release gates are section 2 plus the performance limits in section 36. Recall may be lower than precision; failing closed is preferred.

## 18 Player Contract

Add to the active Player client contract in `apps/player/src/lib/sdk.ts` (the current checkout has no shared `packages/contracts/src/player.ts`):

```ts
export interface MediaSegments {
  intro?: { start: number; end: number; confidence: number; method: string }
  credits?: { start: number; end: number; confidence: number; method: string }
}

export interface SegmentAnalysis {
  state: 'pending' | 'queued' | 'analysing' | 'detected' | 'partial' |
         'no_match' | 'failed' | 'cancelled' | string
  analysedAt: string | null
  detectorVersion: string | null
}

// Additive optional fields on the existing MediaTracks interface.
segments?: MediaSegments | null
segmentAnalysis?: SegmentAnalysis | null
```

The fields are optional in the contract for old-server compatibility. The revised server returns them for episodes only while the server feature gate is enabled; films and disabled servers retain the pre-feature response shape.

## 19 Player API

Modify `GET /api/v1/player/stream/:type/:id/tracks`:

- only `req.params.type === 'episodes'` resolves episode segment links;
- return one indexed join by `episode_id`;
- when missing and enabled, enqueue the season at high priority and return immediately with queued/pending state;
- never compute a signature, probe chapters, or run analysis in the request;
- never return file paths, signatures, fingerprints, provider IDs, or analysis errors to Player.

When `segmentAnalysis` is pending/queued/analysing, Player may re-request tracks at most three times per playback target, respecting a server hint clamped to 15–120 seconds. Stop refreshing when ready/no-match/failed/cancelled/disabled or when the component unmounts. This is background metadata refresh, not work on the OSD render path.

There is no promise that a newly discovered season will have Skip Intro during its first playback. Import and manager sweeps are the primary preparation paths; delayed refresh can still make credits available in the active session.

## 20 Player UX

### 20.1 Skip Intro

- Available for episode playback in both Player and SessionPlayer.
- Visible whenever `introStart <= current < introEnd`.
- Render as an independent bottom-right overlay even when the base transport OSD is hidden.
- Activating it calls the owning player's existing absolute `seek(introEnd)` function, which already handles direct and compatibility modes.
- Keyboard shortcut `s` activates the currently visible skip action.
- It disappears immediately after activation or when outside the window.

### 20.2 Skip Credits

- Visible whenever `current >= creditsStart` and Up Next is not already visible.
- If a playable next item exists, activation immediately calls the owning player's existing advance action.
- If no next item exists, seek to `max(0, duration - 0.25)` and allow normal `ended` handling.
- Do not start a second countdown or duplicate the Up Next state machine.

### 20.3 Focus and accessibility

- `aria-label` equals visible text; use a native button.
- The overlay remains pointer/focus enabled while the transport is hidden.
- In remote modality, focus the skip button only if no dialog/panel is open and focus is not already within another active overlay.
- Do not steal focus in pointer modality.
- Announce appearance through an `aria-live="polite"` region.
- Back/Escape dismisses transport/panels according to existing behavior; it does not accidentally trigger skip.

### 20.4 Automatic skipping

Preferences default false. Auto-skip is allowed only when the relevant confidence is at least the Player's `AUTO_SKIP_MIN_CONFIDENCE` constant (currently `0.90`) and the marker method is accepted by the detector.

- Guard once per segment per playback item.
- Reset guards when `target.id` or SessionPlayer queue index changes.
- Seeking backward into a segment does not auto-trigger again in the same play session.
- Auto-skip credits uses the same immediate advance/end action as the button.

## 21 Up Next Integration

`SessionPlayer.tsx` owns the existing inline final-15-seconds Up Next state. It keeps that state machine unchanged and suppresses the credits button while Up Next is visible. No forced-open prop or duplicate timer is needed. Standalone `Player.tsx` has no next-item contract and seeks to the marker end.

Skip Credits is hidden once Up Next is visible. This avoids overlapping controls and makes its semantics unambiguous: before Up Next, Skip Credits advances immediately; once Up Next appears, its existing Play now/Cancel/countdown behavior owns the transition.

## 22 Player Preference Compatibility

Extend the local `Settings` interface and `DEFAULTS` with normalized booleans:

```ts
autoSkipIntro: boolean
autoSkipCredits: boolean
```

The existing localStorage loader shallow-merges stored values over `DEFAULTS`, so old settings automatically receive both values as `false`. The next settings write serializes the complete normalized object. This is a local additive read migration, not a database schema-version bump.

## 23 Manager API

All endpoints remain on authenticated port 2424 under `/api/v1/system/segments`:

- `GET /status` → enabled, fpcalc availability/version, counts by state, analysed seasons, queued, active, current subject, fingerprint bytes.
- `GET /settings` → current normalized detector settings.
- `PUT /settings` body with any supported settings subset → persist validated `skipIntro` settings in global `app_settings`.
- `POST /analyse` with an empty body → capped library sweep; body `{seriesId,seasonNumber}` → enqueue that season at high priority.
- `POST /cancel` with an empty body → cancel all queued/active work; body `{key:'seriesId:seasonNumber'}` → cancel one season.

Unknown series returns 404. Invalid bodies return 400 through the existing error envelope. Unavailable fpcalc does not block chapter-only analysis; status explains that audio detection is unavailable.

## 24 Manager UX

Settings → System gains a Skip Intro & Credits panel:

- enabled toggle;
- availability/version status;
- counts for ready/no-match/failed/queued/active;
- fingerprint storage size;
- Analyse Library and Cancel Queue actions;
- clear warning that first backfill is CPU-intensive;

Do not label a black-frame-only result as credits. Failed/no-match seasons remain inspectable without exposing file paths to Player.

## 25 Configuration

| Key | Default | Validation | Restart |
|---|---:|---|---|
| `ARCHIVIST_SKIP_INTRO_ENABLED` | `false` | boolean; boot default when no app setting exists | no after Manager override |
| `ARCHIVIST_SEGMENT_CONCURRENCY` / `skipIntro.concurrency` | `1` | integer 1–4, additionally capped by host CPUs | env yes; setting no |
| `skipIntro.introWindowSeconds` | `720` | integer 120–1800 | no |
| `skipIntro.creditsWindowSeconds` | `600` | integer 120–1800 | no |
| `skipIntro.minimumMatchSeconds` | `15` | number 6–60 | no |
| `skipIntro.confidenceThreshold` | `0.72` | float 0.50–0.98 | no |
| Player auto-skip confidence | `0.90` | implementation constant; auto-skip preferences still default false | build-time |
| `ARCHIVIST_SEGMENT_SWEEP_MAX` | `50` | integer 1–500 | no |
| `ARCHIVIST_SEGMENT_CHILD_TIMEOUT_MS` | `90000` | integer 10000–300000 | no |
| `skipIntro.maxAttempts` | `3` | integer 1–10 | no |
| `ARCHIVIST_FPCALC_PATH` | `/usr/bin/fpcalc` in Docker, otherwise `fpcalc` | non-empty executable path | yes |

Parsing and clamping are centralized in `apps/server/src/segments/settings.ts`. `ARCHIVIST_SKIP_INTRO_ENABLED` is only the boot default; once Manager stores `skipIntro.enabled`, the persisted choice is authoritative. Runtime tuning is range-clamped, and Manager exposes the feature gate and bounded worker count without a restart.

## 26 Docker

In the runtime stage, install `libchromaprint-tools` alongside the existing FFmpeg packages and run `fpcalc -version` during image construction. Do not rely on `ffmpeg-static` having the chromaprint muxer.

Use the existing configured/system FFmpeg path for audio slicing. Add `ARCHIVIST_FPCALC_PATH=/usr/bin/fpcalc`. Compose may pass `ARCHIVIST_SKIP_INTRO_ENABLED`, but its default remains false.

At startup, probe fpcalc once. If unavailable, report chapter-only capability; do not pretend credits-only black-frame analysis is safe.

## 27 Logging and Events

Structured category `segments`:

- queue/start/done/no-match/failure/cancel;
- cache hit/miss by media signature prefix only;
- re-link hit;
- fpcalc unavailable;
- duration, matcher time, and fingerprints reused/generated.

Server logs may include a path only under existing server logging policy. Player JSON/logs never include paths, signatures, raw fingerprints, series identifiers, or detector errors.

Record local `system_events` for analysis completion/failure/cancellation and re-link. No external telemetry is added.

## 28 Security

- Spawn `ffmpeg` and `fpcalc` directly with argument arrays; never use a shell.
- Treat file paths as single opaque arguments.
- Restrict analysis to paths already attached to collected episode rows.
- Read media only; scratch streams/pipes do not modify media volumes.
- Bound stdout/stderr buffers and parse strictly.
- Apply timeout and cancellation to every child process.
- Manager mutation endpoints use existing admin authentication; Player receives read-only markers.

## 29 Validation

- `season_number >= 0`; season zero specials are valid but require the same minimum episode count for cross-episode matching.
- `episode_number >= 0`.
- `0 <= introStart < introEnd <= duration`.
- `0 <= creditsStart < duration`.
- Intro duration 15–120 seconds unless supplied by a valid named chapter and explicitly accepted by validation.
- Credits duration-to-end 15–300 seconds unless supplied by a valid named chapter.
- Confidence is in `[0,1]`.
- Intro and credits may not overlap.
- Invalid detector output is discarded and logged as no-match/partial; never clamp it into a plausible-looking marker.

## 30 Error Handling

- Missing fpcalc → chapter-only analysis, explicit availability status.
- Fingerprint timeout/non-zero exit → that window fails; chapter markers and other episode results continue where safe.
- Black/silence failure → no refinement; never destroys a valid chapter/audio candidate.
- Signature read failure → link step logs and import succeeds; later sweep may retry.
- DB transaction failure → transaction rolls back and queue continues; startup/manual sweep recovers pending work.
- Malformed cached BLOB → delete only that cache entry, regenerate once, then fail if still invalid.
- Player treats absent/malformed optional fields as no markers.

## 31 Resource Coordination

Total host load also includes loudness analysis, compatibility transcodes, and the Video Optimisation Engine—not only the segment queue. The manager panel and README must state this explicitly.

Initial safeguards:

- opt-in detection;
- segment concurrency one;
- startup sweep maximum 50 seasons;
- no automatic orphan cleanup;
- manual cancel;
- no new analysis work inside an HTTP request.

A future shared CPU coordinator is deferred. Do not claim that segment concurrency alone caps total Archivist media CPU.

## 32 Repository File Map

Legend: `[N]` new, `[M]` modify, `[V]` verify/regression only.

```text
docs/04-features/skip-intro/specification.md                      [M]
docs/archivist-skip-intro-detector-benchmark.md                [N, spike output]
archivist/Dockerfile                                           [M]
archivist/.env.example                                         [M]
archivist/packages/db/src/schema.ts                            [M]
archivist/packages/db/test/schema.test.ts                      [M]
archivist/apps/server/src/segments/signature.ts                [N]
archivist/apps/server/src/segments/fingerprint.ts              [N]
archivist/apps/server/src/segments/matcher.ts                  [N]
archivist/apps/server/src/segments/detector.ts                 [N]
archivist/apps/server/src/segments/queue.ts                    [N]
archivist/apps/server/src/segments/settings.ts                 [N]
archivist/apps/server/src/player/routes.ts                     [M]
archivist/apps/server/src/services/media-imports.ts            [M]
archivist/apps/server/src/services/media-processor.ts          [V, reuse probeChapters]
archivist/apps/server/src/shared/settings.ts                   [V, reuse app settings]
archivist/apps/server/src/system/admin-routes.ts               [M]
archivist/apps/server/src/routes.ts                            [M, startup/shutdown sweep]
archivist/apps/server/test/segments.test.ts                    [N]
archivist/apps/player/src/lib/sdk.ts                           [M]
archivist/apps/player/src/lib/store.ts                         [M]
archivist/apps/player/src/components/Player.tsx                [M]
archivist/apps/player/src/components/SessionPlayer.tsx         [M]
archivist/apps/player/src/components/SkipSegmentButton.tsx     [N]
archivist/apps/player/src/pages/Settings.tsx                   [M]
archivist/client/src/lib/shared.api.ts                         [M]
archivist/client/src/modules/settings/index.tsx                [M]
archivist/README.md                                            [M]
```

## 33 Component Responsibilities

### `segments/signature.ts`

Pure/bounded file signature helper. Exports `computeMediaSignature`, signature parser/version types, and typed I/O errors. No SQL or queue state.

### `segments/detector.ts`, `fingerprint.ts`, `matcher.ts`, and `queue.ts`

Chapter pattern matching, fingerprint process orchestration, compressed BLOB encode/decode, indexed intro/tail matching, black/silence parsing, confidence calculation, validation, and typed cancellation/errors. No SQL or Express.

### `segments.ts`

Signature store/link operations, cached fingerprint access, season grouping, configuration-aware analysis-set hash, indexed matching, bounded queue, cancellation, status, sweep, and system events.

### `routes.ts` bootstrap

Start the segment service in `startBackgroundServices()` beside the existing loudness sweep, defer an enabled capped sweep by 30 seconds, and call async segment shutdown in the returned cleanup function. Do not target a nonexistent `apps/server/src/index.ts`.

## 34 Backward Compatibility

- `MediaTracks` fields are optional/additive.
- Old Player clients ignore them.
- Old saved preference documents normalize missing booleans to false.
- Previous server versions ignore migration v4 tables on rollback.
- Disable retains timestamps and fingerprints.
- Stream URLs, progress, subtitles, transcode, loudness, and Up Next endpoints remain unchanged.

## 35 Storage and Backup

Timestamp/link rows are small; cached fingerprints are not. A 600-second raw fingerprint is roughly tens of kilobytes before compression. Head and tail caches for 10,000 episodes can add hundreds of megabytes to the unified database.

Requirements:

- compress fingerprint BLOBs;
- expose total fingerprint bytes in manager status;
- include all tables in backup/restore tests;
- document backup growth and time;
- retain fingerprints by default because avoiding repeated decode is a defining feature;
- orphan retention, when enabled, deletes unlinked segment rows and cascades only their fingerprint cache.

Do not retain the former 1.2 MB/10,000-episode estimate; it counted timestamps but omitted fingerprints.

## 36 Performance Budgets

Measured on a two-core container with concurrency one:

- bounded content signature reads at most 12 MiB per large file;
- tracks-route segment lookup: <=5 ms p95 excluding the existing media probe;
- OSD decision: in-memory numeric comparisons only;
- matcher for ten 600-second fingerprints: <=2 seconds p95 and no `O(frames²)` all-offset scan;
- full ten-episode season, cold cache: target <=180 seconds p95;
- full ten-episode season, warm fingerprint cache: target <=5 seconds p95;
- cancellation: child processes exit within seven seconds p95;
- memory: matcher peak <=256 MiB for a 20-episode season at configured maximum windows.

The detector benchmark records actual values. Targets are release gates, not unsupported claims.

## 37 Testing Strategy

### Unit

- sampled signature stable across path move and changes when a sampled region/size changes;
- chapter pattern positive/negative cases;
- indexed matcher positive, offset, threshold, ambiguity, and no-match cases;
- seconds/frame comes from the versioned extractor adapter, is persisted, and matches generated timing fixtures;
- black/silence cannot create credits without chapter/audio candidate;
- cancellation and timeout parse behavior;
- compressed fingerprint round trip and corrupt cache handling.

### Database/E2E

- migration tables, indexes, constraints, and idempotency;
- store/link/read through plural `episodes` tracks route;
- delete series: links disappear, segments/fingerprints remain;
- re-import same signature at a new path: zero FFmpeg/fpcalc and markers restored;
- different release of same episode creates a second durable signature;
- identical show in two libraries does not collide;
- same exact media in two libraries can share a segment with two links;
- season set change reuses old fingerprints and only fingerprints new media;
- backup/restore includes markers and fingerprint BLOBs;
- disabled detection performs no analysis.

### Player

- manual Skip Intro in direct and compatibility mode;
- button remains visible while transport OSD is hidden;
- SessionPlayer resets guards per item;
- bounded tracks refresh stops after three attempts or terminal state;
- Skip Credits immediately advances when next is playable;
- Skip Credits seeks to end without a next item;
- no overlap with visible Up Next;
- auto-skip confidence threshold and once-per-item guard;
- legacy preference document normalizes auto-skip keys to false.

### Regression

Existing player, player-media, Channels, loudness, media import, metadata/chapter, backup/system, and preference tests remain green.

## 38 Rollout

1. Ship migration and disabled code paths.
2. Complete detector spike and benchmark report.
3. Enable on a small test library; run Analyse missing manually.
4. Validate markers through manual controls with auto-skip off.
5. Enable automatic skipping only after confidence gates hold.
6. Consider changing the default in a future release only after operational CPU/storage data is known.

Rollback: disable in Manager or deploy the prior image. Migration tables remain and are ignored; data is preserved for a later re-upgrade.

## 39 Acceptance Criteria

1. Detector spike satisfies section 2 and section 36.
2. Named chapters work for a single episode without season comparison.
3. A season with enough comparable episodes produces per-episode intro offsets with no hard-coded frame rate.
4. Credits are never produced from the last black frame alone.
5. Media producing the same versioned signature at a different path restores markers with zero FFmpeg/fpcalc calls.
6. Different releases of one logical episode retain separate rows and never overwrite one another.
7. Deleting series/episodes deletes only links; durable markers/fingerprints survive backup and restore.
8. Re-matching after a threshold/config change reuses cached fingerprints.
9. Both Player and SessionPlayer show/activate controls correctly in direct and compatibility modes.
10. Missing markers never block tracks or playback; delayed refresh is bounded.
11. Old preference documents remain valid with auto-skip false.
12. Cancellation terminates queued and active work and leaves the queue usable.
13. Disabled installs perform no sweep or media decoding.
14. Existing playback/import/loudness/chapter/backup tests pass.

## 40 Deferred Work

- Manual timestamp editor/correction workflow.
- Recap, preview, and commercial detection.
- Films.
- External/community segment import/export.
- Cross-season matching as an optimization.
- Full-file or decoded-audio signatures for operators requiring stronger equivalence.
- Shared CPU arbitration across loudness, transcode, segment analysis, and video optimization.

## 41 Implementation Order

0. Detector/signature spike and benchmark gate.
1. Migration v4, Player contract, and legacy local preference normalization.
2. Signature/link store and durability tests.
3. Cached fingerprint extraction and indexed matcher.
4. Season service, queue, cancellation, and startup cleanup.
5. Import re-link and pack-level season enqueue.
6. Tracks response and bounded Player refresh.
7. Player/SessionPlayer controls and Up Next conflict handling.
8. Manager settings/status/analyse/cancel surfaces.
9. Docker/config/docs, backup/storage checks, and full regression.

## 42 Implementation Contract

The implementation MUST:

- key durable analysis by versioned media signature;
- keep episode links separate and cascade only links;
- retain separate signatures for separate releases;
- cache fingerprints durably;
- use chapter-first and indexed Chromaprint matching;
- treat black/silence only as credits boundary refinement;
- update both playback owners;
- normalize legacy preferences;
- use direct child processes with cancellation and no shell;
- default detection and auto-skip off;
- pass the detector benchmark before production rollout.

The implementation MUST NOT:

- key uniqueness only by series/season/episode;
- use file path plus size as content identity;
- overwrite old-release markers when a file changes;
- return the last black frame as credits start;
- run an all-offset quadratic frame matcher;
- hard-code 7.8 fps;
- analyse media inside the tracks request;
- promise first-play intro detection;
- invalidate existing preference documents;
- hide changes to `Player.tsx` or `SessionPlayer.tsx` behind an “unchanged” claim;
- gate the feature by licence or add an external service.

If repository reality contradicts this specification, stop and report the exact requirement, evidence, and decision needed before changing scope.
