---
title: "Catalogue — Films: TMDB replacement gap analysis"
document_type: assessment
status: historical
classified: 2026-08-16
---
# Catalogue — Films: TMDB replacement gap analysis

**Date:** 2026-08-10
**Subject:** `Catalogue - Films.json` (n8n workflow) versus what Archivist actually consumes from TMDB for films.
**Scope:** Phase 1 — films only.

Short answer: **no — it's close on descriptive metadata, but it's missing the fields Archivist actually ranks, filters and sorts on.** And there's a bigger structural finding first.

---

## 1. You already have a better films schema in the repo

`apps/server/src/catalogue-database.ts` defines a 38-table film catalogue — already wired to `/api/v1/catalogue`, the flow runner (`catalogue-runner.ts`) and the Catalogue UI (`apps/catalogue`). It is a superset of the n8n workflow's schema:

| | n8n `Catalogue - Films` | in-repo `catalogue-database.ts` |
|---|---|---|
| Basics, genres, countries, companies, people, cast, crew | ✅ | ✅ |
| Release events + certifications | ✅ | ✅ |
| Artwork assets + download queue | ✅ (+ Fanart clearart/disc/banner) | ✅ (+ variants) |
| **vote_average / vote_count / popularity** | ❌ | ✅ |
| **Keywords** | ❌ | ✅ |
| **Watch providers + availability** | ❌ | ✅ |
| **Videos / trailers** | ❌ | ✅ |
| **Alternative titles + edition labels** | ❌ | ✅ |
| **Collections (franchises)** | ❌ | ✅ |
| **Film→film recommendations** | ❌ | ✅ |
| **Discovery feeds (trending/upcoming)** | ❌ | ✅ |
| tagline, budget, revenue, homepage, adult | ❌ | ✅ |
| Person biography/birthday/gender/imdb_id | ❌ | ✅ |

So the real question is probably **which of the two you're keeping**, not whether the n8n one is complete.

There is also a *third* schema — `packages/catalogue/src/schema.ts`, a multi-media variant built around `catalog_items` / `catalog_film_details` with external ids, alternative titles and item relations. **Three catalogues is the thing to resolve before phase 1 starts.**

---

## 2. What the n8n workflow does cover

From `Ensure Film Base Schema` + `Ensure Film Metadata Schema` + the `Assemble Complete Film Payload` code node:

- **Identity:** `archivist_id` (12-char generated), `imdb_id`, `tmdb_id`, universal `catalog_entities` registry
- **Titles:** title, original_title, sort_title
- **Core:** original_language, `tmdb_overview` + `omdb_overview` (kept separate — good provenance), runtime, release_date, release_year, release_status
- **Genres:** normalized vocabulary + join table with billing order
- **Countries:** join table with billing order and `is_primary`
- **Companies:** company vocabulary (tmdb_id, normalized name, origin country, logo asset) + join with role, billing order, `is_primary_studio`
- **People:** vocabulary with tmdb_id, normalized name, known_for_department, popularity, profile asset
- **Cast:** credit_id, character, billing order, `is_starring_top3` / `is_starring_top5`
- **Crew:** credit_id, department, job, `normalized_role` (director/writer/producer/executive_producer/creator/composer/cinematographer/editor/other), billing order
- **Release events:** per country + release type, with certification, note, language and descriptors JSON
- **Artwork:** TMDB + Fanart assets (poster, backdrop, logo, clearart, discart, banner, landscape) with language, dimensions, votes/likes, local_path/checksum, plus a download queue and person/company artwork joins
- **Operational:** IMDb basics intake, enrichment queue with claim/lock/attempt/stale-release machinery

Two things it does **better** than Archivist's current TMDB path:

1. **Per-country release events** — a superset of the single US certification Archivist stores today.
2. **Fanart artwork types** — clearart, discart, banner, landscape, which TMDB does not provide.

---

## 3. Gaps in the n8n schema, ranked by what breaks

### 3.1 Ratings — the biggest hole

`films.rating` is TMDB `vote_average` (`apps/server/src/modules/films/tmdb.ts:147`). It drives:

- the Lists **rating rule** (`min` / `max` / `minVotes` → `vote_average.gte`, `vote_average.lte`, `vote_count.gte`)
- recommendation quality scoring (`recommendations/service.ts`, `for-you.ts`)
- the "top rated" discovery feed (`sort_by: vote_average.desc`, `vote_count.gte: 300`)

The workflow captures neither `vote_average` nor `vote_count`. Worse: it **calls OMDb with `tomatoes=true`** and then discards `imdbRating`, `imdbVotes`, `Metascore` and the whole `Ratings[]` array, keeping only `Plot`. That API call is currently wasted.

### 3.2 Popularity

Used for:

- search result ranking (`searchMovies` sorts by popularity after poster presence)
- the recommendation **obscurity floor** (`minPopularity` setting — external candidates below it are dropped)
- the log-scaled popularity term in recommendation scoring
- discover sorts

Captured for *people*, not for films.

### 3.3 Keywords

`keyword` is a Lists rule type compiling to `with_keywords` / `without_keywords`. No keywords table, and the TMDB call does not `append_to_response=keywords`.

### 3.4 Watch providers

`watchProvider` is a Lists rule compiling to `watch_region` + `with_watch_providers`. Entirely absent.

### 3.5 Collections / franchises

`films.collection_tmdb_id`, `collection_name`, `collection_poster_path`, `collection_backdrop_path` feed the player's collection banner (`player/serializers.ts:115`). `belongs_to_collection` is not fetched.

### 3.6 Videos / trailers

`films.trailer_url` → player `trailerUrl` (`serializers.ts:130`). Not captured.

### 3.7 Alternative titles

`getMovie` scans alternative titles **and** release-date notes to derive editions — Director's Cut, Extended, Unrated, Final Cut, Redux, Ultimate, Special Edition, International Cut, Workprint, Remastered — which populate `available_versions` and drive `film_editions`. The workflow keeps the notes but drops alternative titles, so edition detection degrades.

### 3.8 Smaller gaps

- **`adult`** — search uses `include_adult: false`; reproducing that needs the flag.
- **Spoken languages** — not used today, cheap to keep.
- **tagline / budget / revenue / homepage** — nice-to-have; present in both in-repo schemas.
- **`sort_title`** — the workflow sets it to `title`. Archivist strips leading `The`/`A`/`An` and lowercases (`modules/films/routes.ts:334`), and it is an indexed sort key (`idx_films_title`).
- **`banner_path`** — Archivist currently uses "the second backdrop"; the workflow's banner/landscape are Fanart-only, so films with no Fanart entry lose the banner entirely.
- **Per-field provenance** — beyond the `tmdb_overview` / `omdb_overview` split there is no record of which source won a given field.

---

## 4. The harder half: it is not just fields

Dropping TMDB means replacing four **query surfaces**, not just per-film rows.

### 4.1 Lists compiler

`apps/server/src/lists/compilers/tmdb.ts` is written directly against TMDB Discover semantics:

| Rule | Discover parameter | Answerable from n8n schema? |
|---|---|---|
| genre | `with_genres` / `without_genres` | ✅ |
| year | `primary_release_date.gte/.lte` | ✅ |
| **rating** | `vote_average.gte/.lte`, `vote_count.gte` | ❌ no ratings stored |
| runtime | `with_runtime.gte/.lte` | ✅ |
| language | `with_original_language` | ✅ |
| certification | `certification_country` + `certification` | ✅ (release events) |
| **keyword** | `with_keywords` / `without_keywords` | ❌ no keywords |
| title | direct id fetch | ✅ |
| person | `with_cast` / `with_crew` / `with_people` + exact-role credit verification | ✅ |
| company | `with_companies` | ✅ |
| **watchProvider** | `watch_region` + `with_watch_providers` | ❌ no availability |
| — | `sort_by`, 10,000-result provider ceiling | needs a SQL equivalent |

Also note the new per-rule And/Or support maps to `,` versus `|` joins — a local SQL compiler needs the same two semantics (`ALL` vs `ANY` over a join table).

### 4.2 Recommendations

The engine calls `/movie/{id}/recommendations` per seed, `/discover/movie`, `/trending/movie/week` and `/movie/upcoming`. Title→title similarity is a **dataset, not a field** — either materialise it (the in-repo `catalog_film_recommendations` does exactly this) or compute similarity locally from genres + cast/crew + keywords.

### 4.3 Search

`searchMovies` needs free-text matching with popularity ranking and a poster-presence tie-break. Requires popularity plus a text index.

### 4.4 Discovery feeds

Trending / upcoming / top-rated power the dashboard and the Add page categories. Needs popularity, ratings, release dates and a time-window ranking (the in-repo `catalog_discovery_feeds` / `catalog_discovery_feed_items` cover this).

---

## 5. Identity and migration notes

- Archivist keys films on `tmdb_id`: `films.UNIQUE(library_id, tmdb_id)`.
- **Lists** store `list_items.tmdb_id`; **recommendation snapshots** store `provider_id` (a TMDB id); recommendation feedback is keyed on `provider_id` too.
- The n8n flow anchors on `imdb_id` and mints a 12-char `archivist_id`; TMDB is matched via `/find/{imdb_id}`.
- Migration therefore means adding `archivist_id` to `films` **and** to those provider-id columns, demoting `tmdb_id` to an external id rather than the key. Worth deciding before the catalogue fills up, because retro-fitting identity across snapshots and list items is the expensive part.

---

## 6. Checklist to call phase 1 covered

Against whichever schema wins:

1. `vote_average`, `vote_count`, `popularity`, `adult` on the film row.
2. **Keywords** vocabulary + film join.
3. **Watch provider** vocabulary + per-country availability (with `observed_at` / `expires_at`, since availability rots).
4. **Videos** table (trailer selection).
5. **Alternative titles** + edition-label derivation.
6. **Collections** (franchise) table + film reference.
7. **Film→film recommendations** relation, or a local similarity computation.
8. **Discovery feeds** (trending / upcoming / top rated) as materialised, dated lists.
9. **External ratings** table — IMDb rating/votes, Rotten Tomatoes, Metacritic. Missing from *all three* schemas today, and OMDb is already being called for it.
10. `sort_title` computed with article stripping, to match `idx_films_title` behaviour.
11. A **SQL Lists compiler** answering every rule type in §4.1, including per-rule ALL/ANY, before cutover.
12. A projection for `digital_release_date` / `physical_release_date` (release types 4 and 5) — derivable from the release-events table, but Archivist reads them as columns.

---

## 7. Sources consulted

- `Catalogue - Films.json` — nodes `Ensure Film Base Schema`, `Ensure Film Metadata Schema`, `Assemble Complete Film Payload`, `Persist Complete Film Metadata`
- `packages/db/src/schema.ts` — `films`, `film_editions`
- `apps/server/src/modules/films/tmdb.ts` — `TmdbMovie`, `getMovie`, `searchMovies`, `discoverMoviesWith`, trending/upcoming
- `apps/server/src/lists/compilers/tmdb.ts` — Discover compilation and provider ceiling
- `apps/server/src/recommendations/{service,for-you}.ts` — scoring inputs
- `apps/server/src/player/serializers.ts`, `apps/server/src/player/routes.ts` — player-facing film fields
- `apps/server/src/catalogue-database.ts` — in-repo film catalogue schema
- `packages/catalogue/src/schema.ts` — multi-media catalogue schema
- `client/src/lib/librarySearch.ts` — field-search and discovery field vocabulary
