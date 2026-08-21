---
title: "Archivist DB — local metadata store (planning)"
document_type: architecture
status: historical
classified: 2026-08-16
---
# Archivist DB — local metadata store (planning)

> Goal: a local database where metadata lives and is pulled from, instead of
> calling TMDB/TVDB/MusicBrainz/etc. on every request. Treated as its own app /
> architecture. This doc is the initial exploration — no code yet.

---

## 1. Where Archivist stands today

Metadata provider modules (one per domain):

- TMDB — films
- TVDB — series
- MusicBrainz — music
- Fanart — music/general artwork
- Google Books — books
- ComicVine — comics
- IGDB — games

Current behaviour:

- **No response caching at all.** Every lookup, detail view, and add flow hits
  the provider live via `axios`. No cache table, no TTL, no ETags.
- **Per-item metadata *is* already persisted** — adding a film/series writes it
  to the DB, and posters are downloaded locally.
- **Series already has the bones of a refresh system**: `/series/refresh`
  re-fetches and stamps `last_metadata_refresh_at` / `next_metadata_refresh_at`
  / `refresh_interval_hours`. Films/music/books/comics/games do **not** yet.

So we're missing two things: a **cache layer**, and a **consistent
scheduled-refresh** across all domains. The series refresh + job runner are
patterns to copy.

---

## 2. How Sonarr/Radarr actually do it

Key realisation: they **don't talk to TVDB/TMDB directly, and they don't mirror
the whole database.** Three layers:

1. **A central proxy they host** — Sonarr's **SkyHook** (`skyhook.sonarr.tv`),
   Radarr's `api.radarr.video`. Your install talks to *that*, not to the raw
   providers. The proxy aggregates/normalises/caches provider data centrally,
   hides API-key hassle and rate limits, and absorbs provider API changes. A lot
   of the "it just works" is because the *arr team runs one big shared cache for
   everyone.
2. **A local per-item cache** — monitored movies/shows live in the app's SQLite
   DB (title, overview, runtime, episode list, air dates, image URLs). Day-to-day
   ops (calendar, monitoring, renaming) never hit the network.
3. **Local image cache** — posters/fanart downloaded once into a `MediaCover`
   folder, served locally.

Refresh is a scheduled task (`RefreshSeries`/`RefreshMovie`) using
"updated-since" endpoints so it's incremental.

**Net:** search/add is a live lookup (through the proxy); everything after is
local + scheduled refresh. No full mirror.

---

## 3. The key reframe: cache vs mirror

Two distinct goals are bundled together:

- **Goal 1 — stop *re-calling* providers for data we already have** (library
  items, repeated detail popups, searches). This is a **caching layer**, where
  ~90% of API traffic goes. High value, very automatable, modest effort.
- **Goal 2 — a standalone local metadata source queryable offline** (our own
  SkyHook, or a true mirror). Bigger, and only *fully* achievable where bulk
  data exists.

### Whether a real mirror is possible depends on the provider

| Provider (domain) | Bulk data available? | Realistic strategy |
|---|---|---|
| **MusicBrainz** (music) | ✅ Full DB download **+ hourly replication**, officially supported | True offline mirror, fully automatable |
| **OpenLibrary** (books) | ✅ Full monthly dumps | True mirror (switch/augment away from Google Books, which has no dump) |
| **IMDb datasets** (films/series supplement) | ✅ Downloadable TSVs (titles, ratings, episodes) | Seed basics + ratings; no images/rich data; non-commercial only |
| **TMDB** (films/series) | ❌ Only daily *ID export* lists, no full data | Cache-on-demand + scheduled refresh |
| **TVDB** (series) | ❌ API only (has "updated-since") | Cache-on-demand + incremental refresh |
| **IGDB** (games) | ❌ API only (Twitch, rate-limited) | Cache-on-demand |
| **ComicVine** (comics) | ❌ API only, **200 requests/hour** | Cache-on-demand — caching matters *most* here |

So "a local DB for everything" isn't one thing: **music and books can be genuine
offline mirrors; films/series/games/comics can only be caches** (populated as
used, then refreshed), because there are no bulk exports and ToS forbids a
redistributable scraped copy.

---

## 4. Architecture options (increasing effort)

- **A) Cache layer inside the current backend.** Add a `metadata_cache` table
  keyed by (provider, type, external-id) with `fetched_at`/`expires_at`, wrap
  each provider module in a fetch-through ("check cache → fresh? return : fetch,
  store, return"), and extend the series-style scheduled refresh to every domain.
  In-process, per-instance. Kills most repeat API calls. **Lowest effort, highest
  ROI.**
- **B) A separate metadata service** (own DB + API) that Archivist — and any
  future app — queries. Literally building our own self-hosted SkyHook. Clean
  separation, one place for keys/rate-limits/refresh, shareable across instances.
  More work; worth it for multiple instances or reuse. **This is the "it's its
  own app" path.**
- **C) Full local mirror.** Bulk-import where possible (MusicBrainz replica,
  OpenLibrary/IMDb dumps) and crawl the rest. Biggest effort + storage (tens of
  GB) + ToS care. Only music/books become truly offline; the rest stay caches.

---

## 5. What we'd need to build (components)

1. **Cache store / normalised entity schema** — the one genuinely design-heavy,
   manual decision.
2. **Fetch-through wrappers** around the seven provider modules.
3. **Scheduled refresh** across all domains — job runner + series pattern exist
   to copy.
4. **Image cache** — mostly done for library items; generalise to all fetched art.
5. **Cross-provider ID mapping** (tmdb ↔ imdb ↔ tvdb, etc.) for dedup and
   provider-switching — the other fiddly manual piece.
6. **Centralised rate-limiting / backoff / key management** (ComicVine's 200/hr
   is the binding constraint).
7. **Per-type TTL policy** (film basics rarely change; a running show's episode
   list changes weekly; art almost never).
8. **Optional bulk seeders** (MusicBrainz replication, OpenLibrary/IMDb importers).

---

## 6. How much can be automated

**Almost all runtime behaviour:**

- On-add caching, fetch-through caching with TTL, scheduled + incremental
  ("updated-since") refresh, image caching, cache expiry/pruning — all
  automatable; job-runner scaffolding already exists.
- MusicBrainz replication and dump imports are "download → import → schedule" —
  automatable end to end.

**Needs a human (one-time design, not automatable):**

- Cache schema + normalised entity model.
- Cross-provider ID-mapping / dedup rules.
- Per-type refresh cadences.
- Which providers to mirror vs cache; any provider swap (Google Books →
  OpenLibrary) for book mirroring.
- ToS / storage decisions.

**Ongoing manual (light):** reconciliation when a provider deletes/merges IDs;
watching quotas.

---

## 7. Gotchas

- **ToS / legal.** A *private, for-own-use* per-item cache is generally fine.
  Scraping a redistributable copy of TMDB/TVDB/IGDB/ComicVine, or exposing a
  public proxy, is not. MusicBrainz/OpenLibrary/IMDb explicitly permit dumps
  (attribution; IMDb non-commercial).
- **Cold start.** A cache doesn't help until warmed — first fetch still needed.
  Pre-warm by crawling the existing library.
- **Staleness.** Episode lists / air dates / ratings drift; use "updated-since"
  endpoints where they exist (TVDB, MusicBrainz).
- **Storage.** Per-item cache is tiny; a MusicBrainz replica or OpenLibrary dump
  is tens of GB.
- **ID drift & 404s** on refresh — handle gracefully.

---

## 8. Recommended phasing

1. **Phase 1 — cache + universal refresh in-process (Option A).** Add the
   `metadata_cache` table with TTL, wrap the provider modules, roll the series
   refresh pattern out to every domain. Modest work, no new app, eliminates most
   "calling TMDB/TVDB all the time." **Start here.**
2. **Phase 2 — extract into a metadata service (Option B).** Only when we want
   multiple instances or reuse — the standalone "own SkyHook."
3. **Phase 3 — true mirrors where free (Option C).** MusicBrainz replication
   (music), OpenLibrary/IMDb (books/basics). Leave films/series/games/comics as
   caches — which is effectively what Sonarr/Radarr do.

---

## 9. Open questions / decisions to make later

- Single shared metadata DB across all libraries, or per-library? (Cache is
  naturally global — metadata for "Inception" is the same regardless of library.)
- In-process (Phase 1) vs separate service (Phase 2) — how soon do we want reuse
  across instances/apps?
- For books: stay on Google Books (cache only) or move to OpenLibrary (mirror)?
- Do we want a pre-warm crawler for the existing library, or lazy-fill only?
- TTL defaults per entity type (basics vs episode lists vs artwork).
- Storage budget if we commit to MusicBrainz/OpenLibrary mirrors.

---

## Next step (when we pick this back up)

Sketch the Phase-1 concrete design: the `metadata_cache` schema, the
fetch-through wrapper shape, and the per-domain refresh job — still no
implementation, just the smallest high-impact blueprint.
