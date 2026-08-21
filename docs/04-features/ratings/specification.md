---
title: "Feature Spec — Personal Ratings"
document_type: feature-specification
status: historical
classified: 2026-08-16
---
# Feature Spec — Personal Ratings

**Target:** `archivist-lab/archivist`
**Status:** ready to implement
**Prereqs:** none — additive only

---

## 1. Goal

Let a viewer record how much they liked something on a five-step scale, and feed
that signal into the recommender. Ratings apply at four levels — **film, series,
season, episode** — and the most specific rating wins.

A viewer who finishes something and hasn't rated it gets a nudge: in the Player at
the natural end of playback, and as a queue on the admin dashboard.

### Non-goals for this pass

- Public/shared ratings, or any social layer. Ratings are per-profile and private.
- Review text.
- Half-steps. The scale is integer 1–5, but see §3 on how it's stored.
- Deriving a series rating upward from episode ratings. See §5.4 — deliberately deferred.

---

## 2. Terminology

| Term | Meaning |
|------|---------|
| **Explicit rating** | A rating a user set on that exact subject. Stored. |
| **Inherited rating** | The effective value a subject gets from its nearest rated ancestor. Never stored. |
| **Effective rating** | Explicit if present, else inherited, else none. What's displayed. |
| **Subject** | A film, series, season or episode. |

---

## 3. Data model

Add to `packages/db/src/schema.ts`, following the existing raw-SQL style. Register
an additive migration in `packages/db/src/migrations.ts`.

```sql
-- Personal ratings, stored sparsely at whatever level the user set them.
--
-- Deliberately NOT propagated to children on write: rating a series writes one
-- row, not 86. Storing the expansion would destroy the distinction between "the
-- user rated this episode" and "this episode inherited a series rating", which is
-- the information needed to decide what a later series-rating change should touch.
-- Resolution happens at read time (see resolveRating).
--
-- Distinct from films.rating / series.rating / games.rating, which are provider
-- (TMDB/TVDB) ratings and remain untouched.
CREATE TABLE IF NOT EXISTS media_ratings (
  profile_id    TEXT NOT NULL DEFAULT 'default',
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('film', 'series', 'season', 'episode')),
  subject_id    INTEGER NOT NULL,
  value         INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
  rated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (profile_id, subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_media_ratings_recent
  ON media_ratings(profile_id, updated_at DESC);

-- Dismissals from the "rate what you finished" queue. Distinct from having no
-- rating: an unrated item is a valid permanent state, but a dismissed one must
-- never be re-surfaced.
CREATE TABLE IF NOT EXISTS media_rating_dismissals (
  profile_id    TEXT NOT NULL DEFAULT 'default',
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('film', 'series', 'season', 'episode')),
  subject_id    INTEGER NOT NULL,
  dismissed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (profile_id, subject_type, subject_id)
);
```

### Notes

- `profile_id TEXT NOT NULL DEFAULT 'default'` matches the existing convention in
  `playback_progress`, `player_bookmarks` and `player_preferences`. **Ratings are
  per-profile, not per-library** — two people share a library but not a taste.
- Scale is stored as integer 1–5. If half-steps are ever wanted, migrate to 1–10
  and divide at the presentation layer; the API contract in §4 should therefore
  expose `value` and `scaleMax` rather than hardcoding 5 on the client.
- Clearing a rating **deletes the row**. There is no zero value.
- No `library_id`. Subject IDs are already unique per table, and a rating is a
  property of the person, not the library.

---

## 4. Resolution semantics

**The single rule: specificity wins. Episode > season > series. Film stands alone.**

```
effective(episode) = COALESCE(episode rating, season rating, series rating)
effective(season)  = COALESCE(season rating, series rating)
effective(series)  = series rating
effective(film)    = film rating
```

Implement in `apps/server/src/services/ratings.ts`:

```ts
export type RatingSource = 'own' | 'inherited' | 'none'

export interface ResolvedRating {
  value: number | null          // 1..5, or null
  source: RatingSource
  /** When inherited, the subject the value came from. Null otherwise. */
  inheritedFrom: { type: 'series' | 'season'; id: number } | null
}
```

Requirements:

- `resolveRating(profileId, subjectType, subjectId): ResolvedRating`
- `resolveRatingsBulk(...)` for list views — a per-row query in a 40-episode season
  view is unacceptable. Resolve a whole series in one pass: fetch the series
  rating, all season ratings for that series, and all episode ratings for those
  seasons, then compose in memory.
- Walking the ancestor chain requires `episodes.season_id` → `seasons.series_id`.
  Confirm the actual column names in `schema.ts` before writing the joins.

### Setting and clearing

- `setRating(profileId, subjectType, subjectId, value)` — upsert one row. **Never
  writes to descendants.**
- `clearRating(profileId, subjectType, subjectId)` — delete one row. The subject
  immediately falls back to whatever it was inheriting; if nothing, it becomes
  unrated.

---

## 5. Server work

### 5.1 Contracts

New file `packages/contracts/src/ratings.ts`, exported from `index.ts`. Zod
schemas following the existing style in `player.ts`:

- `RatingSubjectSchema` — `{ type: 'film'|'series'|'season'|'episode', id: number }`
- `RatingValueSchema` — int 1–5
- `ResolvedRatingSchema` — `{ value, source, inheritedFrom, scaleMax }`
- `SetRatingRequestSchema`, `UnratedQueueItemSchema`

`apps/player` already consumes `@archivist/contracts` as a workspace dependency, so
this keeps server and Player in compile-time agreement.

### 5.2 Player API

Add to `apps/server/src/player/routes.ts`, under the existing `/api/v1/player`
namespace:

```
GET    /ratings/:type/:id          → ResolvedRating
PUT    /ratings/:type/:id          → { value } — set, returns ResolvedRating
DELETE /ratings/:type/:id          → clear, returns ResolvedRating (post-fallback)
GET    /ratings/series/:id/tree    → series + all seasons + all episodes, resolved
GET    /ratings/unrated            → the queue (§5.3)
POST   /ratings/unrated/:type/:id/dismiss
```

Validate with the existing `middleware/validate.ts`. Rate-limit writes with
`middleware/rate-limit.ts` — a drag gesture that fires on every segment would
otherwise hammer the endpoint, though the client commits on release (§6.3).

Mirror read-only endpoints on the admin surface where the dashboard needs them.

### 5.3 The unrated queue

Source of truth is `playback_progress`. An item qualifies when:

- `completed = 1`, **or** `position_seconds / duration_seconds >= 0.85`
- and it has **no explicit rating** at its own level
- and it has **no dismissal row**
- and `updated_at` is within a configurable lookback (default 30 days)

Order by `updated_at DESC`, cap at a configurable limit (default 20).

An item with an *inherited* rating still qualifies — someone who rated the series
may still want to rate a standout episode. Show the inherited value pre-filled in
its inherited styling so it's clear nothing has been set yet.

Episodes should be **collapsed by series** in the queue: showing eleven Sopranos
episodes as eleven rows is hostile. Show one row per series with a count, and offer
the season/episode tree behind it.

### 5.4 Recommender integration — read this before touching `for-you.ts`

`apps/server/src/recommendations/for-you.ts` builds a weighted taste profile,
weighting each library item by its rating. Two changes:

**1. Use personal ratings where present, provider ratings as fallback.** A personal
rating is a far stronger signal and should dominate. Suggest weighting personal ≈3×
provider, tunable.

**2. Aggregate at the level the rating was set — this is the trap.** Do **not**
walk episodes reading effective ratings. One series rated 4 would become 86
identical data points and swamp every other signal in the profile.

> **Inheritance flows down for display only. It must never flow down into taste
> aggregation.**

One series rating is one signal about one series. If a user has rated individual
episodes, use those as episode-level signals *and* count the series once — don't
double-count the parent through its children.

Bump `RECOMMENDATION_MODEL_VERSION` — the model's inputs have changed, and the
existing cached snapshots must invalidate.

### 5.5 Implicit signal (cheap, do it in the same pass)

Abandonment is real signal and stronger than most explicit ratings. An item started
and dropped below ~20% is a soft negative. Capture it from `playback_progress`
where `completed = 0` and the item hasn't been resumed within the lookback.

Keep it **entirely separate from `media_ratings`** — it is inferred, not stated,
and must never render as if the user rated something. It exists only as a
recommender input, and it's what fills the cold-start gap while the ratings table
is empty.

### 5.6 Change feed

On any set or clear, insert into `player_sync_changes` with the appropriate
`scope` / `media_type` / `media_id` so clients pick it up via `/sync/changes`.
Emit an SSE event through `system/sse.ts` so the dashboard queue updates live.

---

## 6. UI — "The Level"

A five-segment meter that reads like a channel meter rather than a star row.
Reference implementations are in `rating-study.html` and `rating-study-2.html`.

Build once as a shared component. It's needed in `apps/player` and `client`, and it
must look identical in both — put it wherever shared UI currently lives, or
alongside `packages/design-system` if there's no existing shared component package.

### 6.1 Visual states

All colours from `packages/design-system/tokens.css`. **No new tokens.**

| State | Segment treatment |
|-------|-------------------|
| Unrated | `--archivist-surface-2` fill, `--archivist-faint` border |
| Explicit | Accent fill at 0.92 opacity, accent border, `box-shadow: 0 0 12px -2px <accent>` |
| Inherited | Accent fill at **0.3 opacity, no glow**, border `rgba(255,255,255,0.18)` |
| Drag preview | Accent fill at 0.18 opacity, border `rgba(255,255,255,0.4)` |

The glow axis is what distinguishes explicit from inherited. It must survive any
restyling — if the two states look alike, the whole hierarchy model becomes
unreadable.

Accent is the **domain colour**, inherited from context via `--accent`:
`--archivist-film` (cyan) for films, `--archivist-series` (violet) for
series/season/episode. Set it on the card or row, not globally.

### 6.2 Readout

A mono numeric companion in `--archivist-font-mono`, `font-variant-numeric:
tabular-nums`, format `04 / 05`, `—— / 05` when unrated. Colour `--archivist-dim`
normally, accent when explicit.

Optional small source label for hierarchy views: `from Season 2` / `set here`.

### 6.3 Input

**Pointer events throughout** — one code path for mouse, touch and pen.

- `touch-action: pan-y` on the control. Required: without it the browser eats
  horizontal gestures inside a scrolling list; with `none` vertical scrolling breaks.
- Value derives from **x-position across the whole track**, not from which segment
  was hit. Keeps it forgiving at thumb size and makes drag feel continuous.
- `setPointerCapture` on pointerdown so the drag survives leaving the element.
- **Preview on move, commit on release.** One network write per gesture.
- Dragging below ~4% of track width yields 0 — slide off the left edge to clear.
- `navigator.vibrate(6)` on segment change during drag. No-op on iOS; good on Android.
- Hover preview on non-touch pointers.
- Tapping the currently-set value clears it.

### 6.4 Keyboard and remote

Non-negotiable — the Player is remote-driven and `apps/player/src/focus/` exists
for exactly this.

- `role="slider"`, `aria-valuemin=0`, `aria-valuemax=5`, `aria-valuenow`, `aria-label`
  naming the title
- Arrow right/up increments, left/down decrements, `Home`/`Backspace` clears
- Focus ring uses `--archivist-focus-ring` verbatim
- Must be reachable by the spatial navigation in `focus/navigation.ts`
- Respect `prefers-reduced-motion` — disable transitions, keep state changes

### 6.5 Sizes

- `default` — 2.3rem × 1.5rem segments. Detail pages, the queue.
- `compact` — 1.5rem × 1.05rem. Dense episode lists.
- `large` — 3rem × 2rem. The Player OSD end-of-playback prompt.

### 6.6 No confirm step

A rating is one gesture, applied immediately, instantly reversible. No save button,
no confirmation dialog, no toast.

---

## 7. Placement

| Surface | Where |
|---------|-------|
| Player, end of playback | `apps/player/src/components/osd/UpNext.tsx` — the highest-fidelity moment. A reaction captured at the credits beats one recalled three days later. Large size, dismissible, never blocks Up Next. |
| Player, detail pages | `FilmDetail.tsx`, `SeriesDetail.tsx` — series and season level. |
| Admin dashboard | New unrated-queue widget. Collapse episodes by series (§5.3). |
| Admin detail views | Film and series pages under `client/src/modules/`. |
| Series tree | Series → seasons → episodes with inheritance visible, per `rating-study-2.html`. |

### Converge with existing feedback

`RecommendationFeedbackBar` in the admin client is already doing a version of this
job. Ratings and recommendation feedback should be **one signal with two entry
points**, not two tables that disagree. Reconcile them in this pass rather than
leaving both.

---

## 8. Kodi

Kodi has native user ratings (`SetMovieDetails` / `SetEpisodeDetails` with
`userrating`, 1–10). The add-on already does bidirectional watched-state sync, so
ratings ride the same machinery.

- Push Archivist ratings to Kodi as `userrating`, mapping 1–5 → 2/4/6/8/10
- Reconcile Kodi-side rating changes back, mapping 1–10 → 1–5 by rounding up halves
- Only push **explicit** ratings. Pushing inherited values would materialise the
  expansion in Kodi's database and lose the distinction — the same mistake §3 avoids
- Extend the existing sync tests under `apps/kodi/tests`

---

## 9. Traps

1. **Never propagate on write.** Rating a series writes one row.
2. **Never let inheritance into taste aggregation.** §5.4.
3. **Don't derive a series rating upward yet.** If added later it must be a distinct
   third state, and a derived value must never inherit back down — that's circular
   and unrecoverable.
4. **Don't collide with `films.rating` / `series.rating` / `games.rating`.** Those
   are provider ratings and stay as they are.
5. **Don't add a settings toggle for stars vs thumbs vs meter.** Two users on
   different scales produce incomparable data. One affordance, one stored value.
6. **Don't nag.** One prompt per item. Dismissed means never again. Unrated is a
   valid permanent state, not a task to complete.
7. **Bulk-resolve list views.** No per-row queries.
8. **`profile_id`, not `library_id`.** Ratings belong to people.

---

## 10. Acceptance criteria

- [ ] Rating a series leaves exactly one row in `media_ratings`
- [ ] All episodes under that series report `source: 'inherited'` with the series value
- [ ] Rating a season overrides for its episodes only; the series row is unchanged
- [ ] Rating an episode overrides for that episode only
- [ ] Clearing an episode rating falls back to season, then series, then none
- [ ] Changing the series rating updates every inheriting descendant and no explicit one
- [ ] Inherited and explicit are visually distinguishable without colour alone
- [ ] Drag sets a value on touch; the page still scrolls vertically; one write per gesture
- [ ] Arrow keys set a value; focus ring visible; reachable via spatial navigation
- [ ] A 40-episode season view resolves in one bulk query
- [ ] Recommender counts one series rating as one signal, not N
- [ ] Dismissed queue items never reappear
- [ ] Ratings survive a Kodi round-trip without materialising inherited values
- [ ] `pnpm verify` passes

---

## 11. Suggested order

1. Schema + migration + `services/ratings.ts` with `resolveRating` and bulk resolve, plus unit tests for the inheritance table
2. Contracts + Player API endpoints
3. The meter component — states, drag, keyboard, a11y
4. Detail-page placement (film, series, season, episode)
5. Unrated queue: endpoint, dashboard widget, `UpNext` prompt
6. Recommender integration + `RECOMMENDATION_MODEL_VERSION` bump
7. Implicit abandonment signal
8. Kodi sync

Steps 1–4 are shippable on their own.
