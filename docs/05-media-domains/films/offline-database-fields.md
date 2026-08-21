---
title: "Archivist Films Offline Database Field Specification"
document_type: domain-specification
status: historical
classified: 2026-08-16
---
# Archivist Films Offline Database Field Specification

## Purpose

This document specifies the data required to run Archivist's film features without making TMDB API or TMDB image-CDN requests. It is based on the film code and database schema at repository revision `1f9fd9d96dba`.

The replacement is larger than the current `films` table. Archivist currently asks TMDB for movie details, search results, people and credits, companies, collections, regional release events, alternative titles, videos, images, keywords, watch-provider availability, recommendations, and ordered discovery feeds. Those relationships and their ordering must be stored, not flattened into a single movie row, if behavior is to remain the same.

Two meanings of "no dependency on TMDB" should be kept separate:

1. **No TMDB network dependency:** retain old numeric TMDB IDs as inert external identifiers, but serve all metadata and artwork locally. This is the compatible approach and requires the least application change.
2. **No TMDB identity dependency:** remove TMDB IDs from routes, uniqueness rules, list membership, recommendations, imports, indexer searches, subtitles, and NFO generation. This requires a broad application refactor. An offline dataset alone cannot make that change transparent.

The schema below therefore uses an internal `film_id` while preserving `tmdb_id`. The legacy ID is data, not a live API dependency.

## Requirements that apply to every table

- Use stable internal integer or UUID primary keys. Never use a title/year pair as identity.
- Store dates as ISO `YYYY-MM-DD`, timestamps as UTC ISO-8601, booleans as native booleans or constrained `0/1`, and country/language codes using ISO standards.
- Preserve source ordering with explicit `billing_order`, `ordinal`, or `rank` fields. Array order is functional data in Archivist.
- Use foreign keys and prevent orphaned credits, artwork, feed entries, and recommendation edges.
- Use tombstones (`deleted_at`) or versioned imports so an incremental catalog update can remove stale data.
- Store artwork and any trailer intended to work offline as local files or blobs. A TMDB, Fanart.tv, or YouTube URL is not offline data.
- Keep the original external identifier namespace. The integer `123` is ambiguous unless accompanied by `id_type = 'tmdb'`.
- Treat cached/derived fields as rebuildable from normalized canonical tables.

## Part I — Canonical offline film catalog

The following tables replace the information currently obtained from TMDB and its image CDN.

### 1. `catalog_metadata`

One row describes the installed offline dataset.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `dataset_id` | text/UUID | yes | Stable identity for this catalog distribution. |
| `schema_version` | integer | yes | Database schema compatibility version. |
| `dataset_version` | text | yes | Content release/version identifier. |
| `source_name` | text | yes | Provenance of the imported catalog. |
| `generated_at` | timestamp | yes | When the dataset was built. |
| `imported_at` | timestamp | yes | When this installation imported it. |
| `default_language` | text | yes | Default ISO-639 language used for display text. |
| `default_region` | text | yes | Default ISO-3166-1 region, currently normally `US`. |
| `artwork_root` | text | yes | Absolute or application-relative root for local assets. |
| `checksum_algorithm` | text | yes | Algorithm used by asset checksums, for example `sha256`. |
| `film_count` | integer | yes | Import integrity check. |
| `person_count` | integer | yes | Import integrity check. |
| `asset_count` | integer | yes | Import integrity check. |
| `manifest_checksum` | text | yes | Checksum of the dataset manifest. |

### 2. `catalog_films`

The canonical movie record. One row per distinct film, not per edition or file.

| Field | Type | Required | Purpose / current consumer |
|---|---|---:|---|
| `film_id` | integer/UUID PK | yes | Internal catalog identity. |
| `tmdb_id` | integer unique | compatible mode | Existing routes, list items, recommendations, imports, NFO, indexers, and subtitle lookups. |
| `imdb_id` | text unique nullable | no | IMDb interoperability, indexers, NFO, imports, and subtitles. |
| `title` | text | yes | Display title and search. |
| `original_title` | text | no | Detail display, search, matching, and NFO. |
| `sort_title` | text | yes | Library sorting; may be generated but should be materialized for parity. |
| `original_language` | text | no | List/discover language filtering. |
| `overview` | text | no | Details, calendar, recommendations, and NFO. |
| `runtime_minutes` | integer | no | Details and list runtime filters. |
| `primary_release_date` | date | no | Display, year, calendar, search, and discovery filters. |
| `primary_release_year` | integer | no | Materialized year used throughout the UI and matching. |
| `video` | boolean | yes | TMDB result compatibility. |
| `release_status` | text | no | Provider movie state where supplied; preserve for result compatibility. |
| `popularity` | real | no | Result ordering, recommendation scoring, and discovery feeds. |
| `vote_average` | real | no | Display and rating filters/recommendation scoring. |
| `vote_count` | integer | no | Minimum-vote discovery rules and recommendation scoring. |
| `collection_id` | FK nullable | no | Link to `catalog_collections`. |
| `primary_studio_company_id` | FK nullable | no | Reproduces current first-production-company `studio` behavior. |
| `primary_country_code` | FK nullable | no | Reproduces current first-production-country `country` behavior. |
| `default_poster_asset_id` | FK nullable | no | Selected poster. |
| `default_backdrop_asset_id` | FK nullable | no | Selected backdrop. |
| `default_logo_asset_id` | FK nullable | no | Selected English-first logo. |
| `default_banner_asset_id` | FK nullable | no | Selected banner; current fallback is second then first backdrop. |
| `default_trailer_video_id` | FK nullable | no | Selected YouTube-style trailer or local equivalent. |
| `source_created_at` | timestamp nullable | no | Original catalog creation time if available. |
| `metadata_updated_at` | timestamp | yes | Last metadata change at source/catalog level. |
| `ingested_at` | timestamp | yes | Local import time. |
| `deleted_at` | timestamp nullable | no | Catalog tombstone. |

Constraints and indexes:

- Unique partial indexes on `tmdb_id` and `imdb_id`.
- Index `title`, normalized title, `original_title`, `primary_release_year`, `primary_release_date`, `runtime_minutes`, `original_language`, `vote_average`, `vote_count`, and `popularity`.
- Check `runtime_minutes >= 0`, `vote_count >= 0`, and `vote_average` within the provider's supported range.

### 3. `catalog_external_ids`

Stores all provider identities without adding a new column for each provider.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `film_id` | FK | yes | Owning film. |
| `id_type` | text | yes | Namespace such as `tmdb`, `imdb`, or another catalog. |
| `external_id` | text | yes | Identifier in that namespace. |
| `is_primary` | boolean | yes | Preferred ID within a namespace. |
| `verified_at` | timestamp nullable | no | Last identity verification. |

Primary/unique key: (`film_id`, `id_type`, `external_id`). Also uniquely index (`id_type`, `external_id`) where the provider guarantees uniqueness.

### 4. `catalog_genres`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `genre_id` | integer PK | yes | Stable genre identity; retaining legacy values eases query translation. |
| `name` | text | yes | Display/filter name. |
| `normalized_name` | text | yes | Case-insensitive lookup. |
| `sort_order` | integer | yes | Stable UI order. |
| `active` | boolean | yes | Allows retired genres without breaking old rows. |

### 5. `catalog_genre_aliases`

Preserves compiler aliases such as `sci-fi` → `Science Fiction`.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `alias` | text | yes | User/template input. |
| `normalized_alias` | text | yes | Case/spacing-normalized input. |
| `genre_id` | FK | yes | Canonical genre. |
| `media_type` | text | yes | `film`; prevents collisions with TV genre maps. |
| `active` | boolean | yes | Enables controlled changes. |

Unique key: (`media_type`, `normalized_alias`).

### 6. `catalog_film_genres`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `film_id` | FK | yes | Film. |
| `genre_id` | FK | yes | Genre. |
| `billing_order` | integer | yes | Preserves provider order for display/serialization. |

Primary key: (`film_id`, `genre_id`); unique (`film_id`, `billing_order`).

### 7. `catalog_countries`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `country_code` | text PK | yes | ISO-3166-1 alpha-2 code. |
| `name` | text | yes | Display name. |

### 8. `catalog_film_countries`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `film_id` | FK | yes | Film. |
| `country_code` | FK | yes | Production country. |
| `billing_order` | integer | yes | Preserves source ordering. |
| `is_primary` | boolean | yes | Identifies the value projected to `films.country`. |

Primary key: (`film_id`, `country_code`).

### 9. `catalog_companies`

Required for Studio list templates, company search, and `with_companies` discovery.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `company_id` | integer/UUID PK | yes | Internal identity. |
| `tmdb_id` | integer unique nullable | compatible mode | Existing discovery query compatibility. |
| `name` | text | yes | Search and display. |
| `normalized_name` | text | yes | Case-insensitive company lookup. |
| `origin_country` | text FK nullable | no | Company search result. |
| `logo_asset_id` | FK nullable | no | Local company logo. |
| `metadata_updated_at` | timestamp | yes | Incremental refresh. |
| `ingested_at` | timestamp | yes | Local import time. |
| `deleted_at` | timestamp nullable | no | Tombstone. |

### 10. `catalog_film_companies`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `film_id` | FK | yes | Film. |
| `company_id` | FK | yes | Production company. |
| `company_role` | text | yes | Currently `production`; leaves room for distributor/studio distinctions. |
| `billing_order` | integer | yes | Preserves provider ordering. |
| `is_primary_studio` | boolean | yes | Identifies the company copied to `films.studio`. |

Primary key: (`film_id`, `company_id`, `company_role`).

### 11. `catalog_collections`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `collection_id` | integer/UUID PK | yes | Internal collection identity. |
| `tmdb_id` | integer unique nullable | compatible mode | Existing collection identity. |
| `name` | text | yes | Collection display and NFO. |
| `overview` | text nullable | no | Complete local collection metadata. |
| `poster_asset_id` | FK nullable | no | Selected local collection poster. |
| `backdrop_asset_id` | FK nullable | no | Selected local collection backdrop. |
| `metadata_updated_at` | timestamp | yes | Refresh/import state. |
| `ingested_at` | timestamp | yes | Local import time. |
| `deleted_at` | timestamp nullable | no | Tombstone. |

### 12. `catalog_people`

Required for person search, clickable person links, List templates, credits, and recommendations.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `person_id` | integer/UUID PK | yes | Internal identity. |
| `tmdb_id` | integer unique nullable | compatible mode | Existing person queries and result links. |
| `name` | text | yes | Display and search. |
| `normalized_name` | text | yes | Deterministic lookup. |
| `original_name` | text nullable | no | Preserves provider display data. |
| `known_for_department` | text nullable | no | Person search result and disambiguation. |
| `popularity` | real nullable | no | Search result ranking/disambiguation. |
| `profile_asset_id` | FK nullable | no | Selected local headshot. |
| `metadata_updated_at` | timestamp | yes | Incremental refresh. |
| `ingested_at` | timestamp | yes | Local import time. |
| `deleted_at` | timestamp nullable | no | Tombstone. |

### 13. `catalog_film_cast`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `film_id` | FK | yes | Film. |
| `person_id` | FK | yes | Performer. |
| `credit_id` | text nullable | no | Stable provider credit identity when available. |
| `character` | text nullable | no | Detail view and serialized `cast`. |
| `billing_order` | integer | yes | Cast order; functionally used by starring filters/recommendations. |
| `is_starring_top3` | boolean | yes | Materialized exact List `starring` behavior. |
| `is_starring_top5` | boolean | yes | Materialized recommendation seed behavior. |

Primary key should allow multiple characters/credits for the same person and film; use `credit_id` where present, otherwise a surrogate `film_cast_id`. Index (`person_id`, `billing_order`) and (`film_id`, `billing_order`).

### 14. `catalog_film_crew`

Store the full crew, not only director/producer/writer. Exact-role Lists need jobs that the current flattened movie response may omit.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `film_crew_id` | integer/UUID PK | yes | Handles multiple jobs per person/film. |
| `film_id` | FK | yes | Film. |
| `person_id` | FK | yes | Crew member. |
| `credit_id` | text nullable | no | Provider credit identity. |
| `department` | text nullable | no | Raw department. |
| `job` | text | yes | Raw job shown/serialized and used for exact matching. |
| `normalized_role` | text | yes | Archivist role category. |
| `billing_order` | integer | yes | Stable ordering within the credits response. |

`normalized_role` must support at least:

- `director`
- `writer` for Writer, Screenplay, Teleplay, Story, Author, and Novel jobs
- `producer` for Producer and Co-Producer
- `executive_producer` for Executive Producer and Co-Executive Producer
- `creator` for creator variants
- `composer` for Original Music Composer, Music, Composer, and Music by variants
- `cinematographer` for Cinematography and Director of Photography variants
- `editor`
- `other`

This distinction prevents a Director filter from matching a person who only executive-produced a film.

### 15. `catalog_role_aliases`

Makes the crew normalization contract explicit and portable.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `raw_job` | text | yes | Exact source job. |
| `normalized_job` | text | yes | Case/space-normalized raw job. |
| `normalized_role` | text | yes | Archivist role category above. |
| `media_type` | text | yes | `film`. |
| `active` | boolean | yes | Controlled mapping changes. |

Unique key: (`media_type`, `normalized_job`).

### 16. `catalog_person_known_for`

Person search currently displays a short "known for" list. Preserve it separately from full credits because it is ranked search metadata.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `person_id` | FK | yes | Person. |
| `media_type` | text | yes | `movie` or `tv`. |
| `film_id` | FK nullable | no | Local film when the known-for item is a catalog film. |
| `external_media_id` | text nullable | no | Identity for non-film/unimported items. |
| `display_title` | text | yes | `title` or `name` shown in person search. |
| `primary_release_year` | integer nullable | no | Disambiguation. |
| `billing_order` | integer | yes | Search-result order. |

Primary key: (`person_id`, `billing_order`).

### 17. `catalog_release_type_codes`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `release_type` | integer PK | yes | Provider-compatible release code. |
| `name` | text | yes | `Premiere`, `Limited Theatrical`, `Theatrical`, `Digital`, `Physical`, or `TV`. |
| `is_theatrical` | boolean | yes | Simplifies upcoming filters. |

Seed codes: `1` Premiere, `2` Limited Theatrical, `3` Theatrical, `4` Digital, `5` Physical, `6` TV.

### 18. `catalog_release_events`

Regional release rows are necessary for certification, theatrical/digital/physical dates, editions inferred from notes, calendar behavior, and relative-date filters.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `release_event_id` | integer/UUID PK | yes | Stable event identity. |
| `film_id` | FK | yes | Film. |
| `country_code` | FK | yes | Region, currently US-first in several consumers. |
| `release_type` | FK | yes | Code from `catalog_release_type_codes`. |
| `release_at` | timestamp | yes | Full source timestamp. |
| `release_date` | date | yes | Materialized local date for filtering. |
| `certification` | text nullable | no | Regional content rating. |
| `note` | text nullable | no | Edition labels such as Director's Cut can be inferred here. |
| `language` | text nullable | no | Language where supplied. |
| `descriptors_json` | JSON nullable | no | Future/provider descriptors without schema loss. |
| `billing_order` | integer | yes | Preserves release response ordering. |

Index (`film_id`, `country_code`, `release_type`, `release_date`) and (`country_code`, `certification`).

### 19. `catalog_alternative_titles`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `alternative_title_id` | integer/UUID PK | yes | Row identity. |
| `film_id` | FK | yes | Film. |
| `country_code` | FK nullable | no | Region associated with the title. |
| `title` | text | yes | Matching/search and edition inference. |
| `title_type` | text nullable | no | Provider title type. |
| `billing_order` | integer | yes | Stable provider order. |

### 20. `catalog_edition_labels`

A rebuildable cache of edition/version names inferred from release notes and alternative titles.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `edition_label_id` | integer/UUID PK | yes | Row identity. |
| `film_id` | FK | yes | Film. |
| `label` | text | yes | Display label. |
| `normalized_label` | text | yes | Deduplication. |
| `derived_from` | text | yes | `release_note`, `alternative_title`, or `manual`. |
| `source_row_id` | text nullable | no | Source release/title row. |
| `confidence` | real nullable | no | Optional extraction confidence. |
| `billing_order` | integer | yes | Output order. |

The current recognizer must retain at least: `Director's Cut`, `Extended`, `Unrated`, `Final Cut`, `Redux`, `Ultimate`, `Special Edition`, `International Cut`, `Workprint`, and `Remastered`.

### 21. `catalog_videos`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `video_id` | integer/UUID PK | yes | Internal video identity. |
| `film_id` | FK | yes | Film. |
| `provider_key` | text nullable | no | Existing TMDB video `key`, often a YouTube ID. |
| `site` | text nullable | no | Existing `site`, such as YouTube. |
| `video_type` | text | yes | Existing `type`, especially `Trailer`. |
| `name` | text nullable | no | Video title. |
| `official` | boolean nullable | no | Official-provider flag. |
| `language` | text nullable | no | ISO-639 language. |
| `country_code` | text FK nullable | no | ISO region. |
| `size` | integer nullable | no | Provider resolution metadata. |
| `published_at` | timestamp nullable | no | Provider publication time. |
| `billing_order` | integer | yes | Selection order. |
| `is_default_trailer` | boolean | yes | Reproduces first suitable trailer selection. |
| `local_path` | text nullable | offline playback | Path to locally mirrored trailer. |
| `mime_type` | text nullable | offline playback | Local file content type. |
| `byte_size` | integer nullable | offline playback | Integrity/serving. |
| `checksum` | text nullable | offline playback | Integrity/deduplication. |
| `original_url` | text nullable | no | Audit only; never required for offline playback. |

Archivist already prefers a local `trailer.mkv` when present. To guarantee offline trailer playback, populate the local-file fields; a YouTube key alone is insufficient.

### 22. `catalog_keywords`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `keyword_id` | integer/UUID PK | yes | Keyword identity. |
| `tmdb_id` | integer unique nullable | compatible mode | Discovery query translation. |
| `name` | text | yes | Display/query value. |
| `normalized_name` | text | yes | Lookup and deduplication. |

### 23. `catalog_film_keywords`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `film_id` | FK | yes | Film. |
| `keyword_id` | FK | yes | Keyword. |
| `billing_order` | integer | yes | Deterministic serialization. |

Primary key: (`film_id`, `keyword_id`).

### 24. `catalog_watch_providers`

Required for List filters using a provider and region.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `provider_id` | integer/UUID PK | yes | Internal provider identity. |
| `tmdb_id` | integer unique nullable | compatible mode | Existing `with_watch_providers` values. |
| `name` | text | yes | Provider display/search. |
| `normalized_name` | text | yes | Lookup. |
| `logo_asset_id` | FK nullable | no | Local provider logo. |
| `global_display_priority` | integer nullable | no | Default provider order. |
| `active` | boolean | yes | Provider lifecycle. |
| `metadata_updated_at` | timestamp | yes | Incremental refresh. |

### 25. `catalog_film_watch_availability`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `film_id` | FK | yes | Film. |
| `country_code` | FK | yes | Availability region. |
| `provider_id` | FK | yes | Watch provider. |
| `monetization_type` | text | yes | `flatrate`, `free`, `ads`, `rent`, or `buy`. |
| `display_priority` | integer | yes | Regional provider ordering. |
| `provider_link` | text nullable | no | External deep link; audit/online convenience only. |
| `available_from` | timestamp nullable | no | Availability window start if known. |
| `available_until` | timestamp nullable | no | Availability window end if known. |
| `checked_at` | timestamp | yes | Freshness of availability record. |

Primary key: (`film_id`, `country_code`, `provider_id`, `monetization_type`).

### 26. `catalog_artwork_assets`

One canonical row per source artwork image. Do not store only a remote path.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `asset_id` | integer/UUID PK | yes | Internal asset identity. |
| `owner_type` | text | yes | `film`, `person`, `company`, `collection`, or `watch_provider`. |
| `owner_id` | text | yes | Internal ID in the owner table. |
| `artwork_type` | text | yes | Type enum listed below. |
| `source` | text | yes | `tmdb`, `fanart`, `local`, or import source. |
| `source_asset_id` | text nullable | no | Provider asset identity/file path. |
| `language` | text nullable | no | Source `iso_639_1`; important for English-first logo selection. |
| `country_code` | text nullable | no | Regional artwork where applicable. |
| `width` | integer | yes | Original pixel width. |
| `height` | integer | yes | Original pixel height. |
| `aspect_ratio` | real | yes | Source ratio used for validation/ranking. |
| `vote_average` | real nullable | no | Source image ranking. |
| `vote_count` | integer nullable | no | Source image ranking confidence. |
| `billing_order` | integer | yes | Exact source result order. |
| `mime_type` | text | yes | For example `image/jpeg` or `image/png`. |
| `file_extension` | text | yes | Safe local extension. |
| `byte_size` | integer | yes | Integrity and serving. |
| `checksum` | text | yes | Deduplication and corruption detection. |
| `local_path` | text nullable | one storage form required | Path under `artwork_root`. |
| `blob_data` | blob nullable | one storage form required | Alternative database storage. |
| `original_url` | text nullable | no | Provenance only; must not be needed at runtime. |
| `is_selected` | boolean | yes | Currently selected image for its usage. |
| `selected_usage` | text nullable | no | `poster`, `backdrop`, `logo`, `banner`, profile, etc. |
| `fetched_at` | timestamp | yes | When bytes were mirrored. |
| `metadata_updated_at` | timestamp | yes | Last metadata/ranking update. |
| `deleted_at` | timestamp nullable | no | Tombstone. |

Supported `artwork_type` values must cover:

- `poster`
- `backdrop`
- `logo`
- `banner`
- `profile`
- `clearart`
- `thumb`
- `disc`
- `company_logo`
- `watch_provider_logo`
- `collection_poster`
- `collection_backdrop`

The first four map to `poster.jpg`, `backdrop.jpg`, `logo.png`, and `banner.jpg` in a film folder. The image editor also writes `clearart.png`, `thumb.jpg`, and `disc.png`.

### 27. `catalog_artwork_variants`

Stores locally available renditions so the UI never needs TMDB's sizing CDN.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `asset_variant_id` | integer/UUID PK | yes | Variant identity. |
| `asset_id` | FK | yes | Canonical artwork. |
| `variant_name` | text | yes | `original`, `w185`, `w342`, `w1280`, `thumb`, or local equivalent. |
| `width` | integer | yes | Actual pixel width. |
| `height` | integer | yes | Actual pixel height. |
| `mime_type` | text | yes | Response content type. |
| `file_extension` | text | yes | File extension. |
| `byte_size` | integer | yes | Integrity/serving. |
| `checksum` | text | yes | Integrity/deduplication. |
| `local_path` | text nullable | one storage form required | Local rendition path. |
| `blob_data` | blob nullable | one storage form required | Alternative DB storage. |
| `created_at` | timestamp | yes | Rendition generation/import time. |

At minimum preserve equivalents for current consumers: person profiles around `w185`, posters/collection posters around `w342`, backdrops/collection backdrops around `w1280`, and original logos.

### 28. `catalog_film_recommendations`

`/movie/{id}/recommendations` is an ordered graph, not a movie field.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `source_film_id` | FK | yes | Seed film. |
| `recommended_film_id` | FK | yes | Candidate film. |
| `rank` | integer | yes | Exact response order. |
| `score` | real nullable | no | Provider/local recommendation score if available. |
| `algorithm_version` | text | yes | Reproducibility. |
| `generated_at` | timestamp | yes | Snapshot time. |
| `expires_at` | timestamp nullable | no | Optional refresh policy. |

Primary key: (`source_film_id`, `recommended_film_id`, `algorithm_version`); unique (`source_film_id`, `algorithm_version`, `rank`).

### 29. `catalog_discovery_feeds`

Replaces ordered endpoints such as weekly trending and US upcoming. A query engine can generate some feeds, but persisting snapshots gives exact ordering.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `feed_id` | integer/UUID PK | yes | Feed snapshot identity. |
| `feed_type` | text | yes | `trending_week`, `upcoming`, `top_rated`, `popular`, or another named feed. |
| `region` | text nullable | no | For example `US` for upcoming. |
| `language` | text nullable | no | Result language. |
| `window_start` | timestamp nullable | no | Trending/release window. |
| `window_end` | timestamp nullable | no | Trending/release window. |
| `generated_at` | timestamp | yes | Snapshot generation time. |
| `expires_at` | timestamp nullable | no | Refresh policy. |
| `algorithm_version` | text | yes | Reproducibility. |
| `total_results` | integer | yes | Endpoint-compatible count. |

### 30. `catalog_discovery_feed_items`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `feed_id` | FK | yes | Feed snapshot. |
| `film_id` | FK | yes | Film. |
| `rank` | integer | yes | Exact ordered position. |
| `page_number` | integer | yes | Endpoint pagination compatibility. |
| `score` | real nullable | no | Feed score if available. |
| `popularity_snapshot` | real nullable | no | Value at feed generation. |
| `vote_average_snapshot` | real nullable | no | Value at feed generation. |
| `vote_count_snapshot` | integer nullable | no | Value at feed generation. |
| `inserted_at` | timestamp | yes | Import time. |

Primary key: (`feed_id`, `film_id`); unique (`feed_id`, `rank`).

### 31. `catalog_sync_state`

Needed for safe incremental offline catalog updates.

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `entity_type` | text | yes | Table/entity category. |
| `entity_id` | text | yes | Internal entity identity. |
| `source_version` | text | yes | Last imported source version. |
| `source_updated_at` | timestamp nullable | no | Source change time. |
| `ingested_at` | timestamp | yes | Local import time. |
| `deleted_at` | timestamp nullable | no | Tombstone. |
| `row_checksum` | text | yes | Change/corruption detection. |

Primary key: (`entity_type`, `entity_id`).

## TMDB API source map for canonical tables 1–31

All paths below are TMDB API v3 paths relative to:

```text
https://api.themoviedb.org/3
```

Use bearer-token authentication, `language=en-US` for Archivist's current behavior, and paginate every list endpoint until `page >= total_pages`. For images, use `include_image_language=en,null`. The current Archivist detail request uses:

```http
GET /movie/{movie_id}?append_to_response=release_dates,images,credits,videos,alternative_titles&include_image_language=en,null&language=en-US
```

That combined request can populate much of tables 2, 6, 8, 10, 11, 13, 14, 18, 19, 21, and 26. The standalone endpoints below are still important for a complete importer, incremental refreshes, image browsing, and data that is not in Archivist's present append list.

| Table | Primary TMDB endpoint(s) | Secondary/discovery endpoint(s) | Ingestion notes |
|---|---|---|---|
| 1. `catalog_metadata` | `GET /configuration` | `GET /configuration/primary_translations`, `/configuration/countries`, `/configuration/languages` | TMDB has no dataset-manifest endpoint. `dataset_id`, schema/version, checksums, counts, generation time, and import time are generated by the offline catalog builder. Configuration supplies image base URLs/sizes and supported locale reference data. |
| 2. `catalog_films` | `GET /movie/{movie_id}` | `GET /search/movie`, `/discover/movie`, `/movie/changes` | Details is authoritative for a film row. Search/discover/change-list endpoints find IDs and supply summary rows; do not treat summaries as complete details. |
| 3. `catalog_external_ids` | `GET /movie/{movie_id}/external_ids` | `GET /movie/{movie_id}` | Details currently supplies `imdb_id`; the external-IDs endpoint also supplies Wikidata and social IDs. The TMDB ID is the path/response ID itself. |
| 4. `catalog_genres` | `GET /genre/movie/list` | `GET /movie/{movie_id}`, `/search/movie`, `/discover/movie` | The genre-list endpoint is the vocabulary. Detail rows contain full genres; summary rows contain `genre_ids`. |
| 5. `catalog_genre_aliases` | **No TMDB endpoint** | Source: `catalog_genres` plus Archivist's alias map | `sci-fi` and other aliases are application-owned query vocabulary. Seed and version them locally. |
| 6. `catalog_film_genres` | `GET /movie/{movie_id}` | `/search/movie`, `/discover/movie`, collection `parts[]` | Use `genres[]` from details and preserve array order. Summary `genre_ids[]` can bootstrap joins but is not the preferred full-load source. |
| 7. `catalog_countries` | `GET /configuration/countries` | `GET /movie/{movie_id}` | Configuration supplies ISO country codes and display names; movie details identifies production countries. |
| 8. `catalog_film_countries` | `GET /movie/{movie_id}` | `GET /discover/movie?with_origin_country=…` | Populate from `production_countries[]`, preserving order and selecting the first as current Archivist's primary country. Discover is a query/validation endpoint, not the canonical relationship source. |
| 9. `catalog_companies` | `GET /company/{company_id}` | `GET /search/company`, `/company/{company_id}/images`, `/movie/{movie_id}` | Search supports Studio lookup. Movie details exposes production-company IDs/names/logo paths; company details and images complete the entity. |
| 10. `catalog_film_companies` | `GET /movie/{movie_id}` | `GET /discover/movie?with_companies=…` | Populate from ordered `production_companies[]`. The first company reproduces `films.studio`; retain every company for Studio Lists. |
| 11. `catalog_collections` | `GET /collection/{collection_id}` | `GET /collection/{collection_id}/images`, `/movie/{movie_id}` | Movie details exposes `belongs_to_collection`; collection details supplies collection metadata and `parts[]`; collection images supplies all artwork alternatives. |
| 12. `catalog_people` | `GET /person/{person_id}` | `GET /search/person`, `/person/{person_id}/images`, movie credits | Search supplies popularity, department, profile, and `known_for`; details and images complete the person. Credit endpoints discover people attached to films. |
| 13. `catalog_film_cast` | `GET /movie/{movie_id}/credits` | `GET /person/{person_id}/movie_credits`, movie details with `append_to_response=credits` | Movie credits are authoritative per film. Preserve `order`; Archivist Lists define starring as order 0–2, while local library search uses the first five. |
| 14. `catalog_film_crew` | `GET /movie/{movie_id}/credits` | `GET /person/{person_id}/movie_credits`, `GET /credit/{credit_id}`, appended credits | Store every crew row and raw `job`/`department`; do not retain only the four jobs projected into today's `films.crew`. Credit details are optional enrichment/debugging. |
| 15. `catalog_role_aliases` | **No TMDB endpoint** | Source: raw jobs from movie/person credit endpoints | TMDB supplies raw job strings but no Archivist role taxonomy. Seed the normalization rules locally and keep Producer separate from Executive Producer. |
| 16. `catalog_person_known_for` | `GET /search/person?query=…` | `GET /person/{person_id}/combined_credits`, `/person/{person_id}/movie_credits` | TMDB's ranked `known_for[]` is exposed in person-search results, not person details. Combined/movie credits can build a local alternative, but cannot guarantee TMDB's exact proprietary known-for ranking. |
| 17. `catalog_release_type_codes` | **No lookup endpoint** | Reference contract documented by `GET /movie/{movie_id}/release_dates` | Seed the static TMDB codes locally: 1 Premiere, 2 Limited Theatrical, 3 Theatrical, 4 Digital, 5 Physical, 6 TV. |
| 18. `catalog_release_events` | `GET /movie/{movie_id}/release_dates` | Movie details with `append_to_response=release_dates` | Store every country/event row: certification, timestamp, type, note, and descriptors. Do not save only the three dates projected onto `films`. |
| 19. `catalog_alternative_titles` | `GET /movie/{movie_id}/alternative_titles` | Movie details with `append_to_response=alternative_titles` | Preserve country, title, type, and response order. The standalone endpoint supports a `country` filter; omit it for the full load. |
| 20. `catalog_edition_labels` | **No TMDB endpoint** | Derived from tables 18 and 19 | Apply Archivist's edition phrase recognizer to release-event `note` and alternative-title `title`; retain derivation provenance. |
| 21. `catalog_videos` | `GET /movie/{movie_id}/videos` | Movie details with `append_to_response=videos` | Select the first YouTube Trailer for current parity. Download/mirror its bytes separately if playback must work with no internet. |
| 22. `catalog_keywords` | `GET /movie/{movie_id}/keywords` | `GET /search/keyword?query=…` | Movie keywords discovers IDs/names attached to films; keyword search supports editor/lookup behavior. |
| 23. `catalog_film_keywords` | `GET /movie/{movie_id}/keywords` | `GET /discover/movie?with_keywords=…` | Populate the relationship from each film's keywords response. Discover only tests/uses the relationship. |
| 24. `catalog_watch_providers` | `GET /watch/providers/movie` | `GET /movie/{movie_id}/watch/providers` | The global movie-provider list supplies IDs, names, logos, and display priorities. Repeat with `watch_region` where regional priority matters. |
| 25. `catalog_film_watch_availability` | `GET /movie/{movie_id}/watch/providers` | `GET /discover/movie?watch_region=…&with_watch_providers=…` | Store results by country and bucket: `flatrate`, `free`, `ads`, `rent`, and `buy`, plus display priority and TMDB link. JustWatch attribution requirements apply to this data. |
| 26. `catalog_artwork_assets` | `GET /movie/{movie_id}/images` | `/person/{person_id}/images`, `/company/{company_id}/images`, `/collection/{collection_id}/images`, `/watch/providers/movie` | These endpoints supply movie art, profiles, company logos, collection art, and provider logos. Download the actual bytes using TMDB image configuration; a `file_path` alone is not offline. Fanart.tv remains a separate optional source. |
| 27. `catalog_artwork_variants` | `GET /configuration` plus TMDB image CDN downloads | Source image endpoints from table 26 | Configuration supplies `secure_base_url` and supported sizes. Variants are files generated/downloaded by the importer; there is no metadata endpoint that returns all resized variants as rows. |
| 28. `catalog_film_recommendations` | `GET /movie/{movie_id}/recommendations` | `GET /movie/{movie_id}/similar` if a future feature wants similarity separately | Preserve response rank, page, language, retrieval time, and algorithm snapshot. Current Archivist uses recommendations, not similar movies. |
| 29. `catalog_discovery_feeds` | `GET /trending/movie/{day\|week}` | `/movie/upcoming`, `/movie/top_rated`, `/movie/popular`, `/movie/now_playing`, `/discover/movie` | One `catalog_discovery_feeds` row represents one endpoint/query snapshot, including locale, region, time window, query parameters, and retrieval time. |
| 30. `catalog_discovery_feed_items` | Same feed endpoint that created table 29's parent row | Search/discover/list endpoints as configured | Store every returned movie ID with exact rank and page. Never recompute rank from popularity if exact snapshot parity is required. |
| 31. `catalog_sync_state` | `GET /movie/changes` then `GET /movie/{movie_id}/changes` | `GET /person/changes`, `/person/{person_id}/changes`; periodic details refresh for companies/collections | Change lists identify recently changed IDs; per-ID changes describe fields. TMDB change windows are bounded, so persist watermarks and run frequently. Companies and collections lack equivalent complete change-list coverage and need periodic refresh or refresh through changed films. |

### Important endpoint behavior

- `append_to_response` is supported on movie and person detail methods. Archivist currently appends five movie sub-responses; an importer may also append supported namespaces such as `external_ids` and `keywords`, but standalone calls are easier to retry and audit independently.
- `/discover/movie` is a query endpoint, not a bulk-export API. Commas represent AND and pipes represent OR for supported filter parameters. Preserve the exact query alongside any feed snapshot.
- Search, discover, trending, recommendation, and named movie-list responses are paginated summaries. Fetch `/movie/{movie_id}` for canonical details.
- TMDB's API is not a legal grant to redistribute a permanent offline mirror. Review TMDB attribution, API terms, image licensing, and JustWatch attribution before distributing or sharing the resulting database.

### Official TMDB references

- [Movie details](https://developer.themoviedb.org/reference/movie-details) and [append to response](https://developer.themoviedb.org/docs/append-to-response)
- [Movie credits](https://developer.themoviedb.org/reference/movie-credits), [release dates](https://developer.themoviedb.org/reference/movie-release-dates), [images](https://developer.themoviedb.org/reference/movie-images), [keywords](https://developer.themoviedb.org/reference/movie-keywords), and [watch providers](https://developer.themoviedb.org/reference/movie-watch-providers)
- [Movie discovery](https://developer.themoviedb.org/reference/discover-movie), [trending movies](https://developer.themoviedb.org/reference/trending-movies), and [recommendations](https://developer.themoviedb.org/reference/movie-recommendations)
- [Person movie credits](https://developer.themoviedb.org/reference/person-movie-credits) and [person images](https://developer.themoviedb.org/reference/person-images)
- [Company details](https://developer.themoviedb.org/reference/company-details), [company images](https://developer.themoviedb.org/reference/company-images), [collection details](https://developer.themoviedb.org/reference/collection-details), and [collection images](https://developer.themoviedb.org/reference/collection-images)
- [Movie provider list](https://developer.themoviedb.org/reference/watch-providers-movie-list), [configuration countries](https://developer.themoviedb.org/reference/configuration-countries), and [tracking content changes](https://developer.themoviedb.org/docs/tracking-content-changes)

## Part II — Rebuildable search indexes

These are implementation tables, not additional source data, but are required for local response speed and behavior.

### 32. `catalog_films_fts`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `film_id` | unindexed key | yes | Join to film. |
| `title` | FTS text | yes | Movie search. |
| `original_title` | FTS text | no | Movie search/matching. |
| `alternative_titles` | FTS text | no | Search over all regional titles. |
| `primary_release_year` | unindexed integer | no | Disambiguation/filter. |

### 33. `catalog_people_fts`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `person_id` | unindexed key | yes | Join to person. |
| `name` | FTS text | yes | Person search/autocomplete. |
| `original_name` | FTS text | no | Alternate display form. |
| `known_for_department` | unindexed text | no | Result display/filter. |

### 34. `catalog_companies_fts`

| Field | Type | Required | Purpose |
|---|---|---:|---|
| `company_id` | unindexed key | yes | Join to company. |
| `name` | FTS text | yes | Studio/company search. |
| `origin_country` | unindexed text | no | Result display/filter. |

Rebuild these indexes after every catalog import. Search ordering must preserve Archivist's present preference for results with posters, then popularity, with textual relevance used to find the candidates.

## Part III — Projection into Archivist's existing runtime database

The canonical catalog replaces TMDB; it does not replace user/library state. Archivist should retain its operational tables and import/project catalog data into them. The following inventories the film-related runtime fields that must remain available.

### 35. Existing `films`

| Field | Source / ownership |
|---|---|
| `id` | Archivist PK. |
| `library_id` | Archivist library FK. |
| `tmdb_id` | `catalog_films.tmdb_id`; rename only as part of an identity refactor. |
| `imdb_id` | Catalog external ID. |
| `title` | Catalog. |
| `original_title` | Catalog. |
| `sort_title` | Catalog/generated locally. |
| `year` | `catalog_films.primary_release_year`. |
| `overview` | Catalog. |
| `runtime` | `runtime_minutes`. |
| `genres` | Ordered JSON array from `catalog_film_genres`. |
| `poster_path` | Selected local poster path or a local asset-serving route. |
| `backdrop_path` | Selected local backdrop path/route. |
| `logo_path` | Selected local logo path/route. |
| `banner_path` | Selected local banner path/route. |
| `trailer_url` | Prefer local trailer route; remote URL does not satisfy offline operation. |
| `cast` | Ordered JSON from `catalog_film_cast`, exact shape below. |
| `crew` | Ordered JSON from `catalog_film_crew`, exact shape below. |
| `country` | Primary production country. |
| `rating` | `vote_average`. |
| `certification` | First applicable non-empty default-region certification. |
| `studio` | Primary/first production company name. |
| `collection_tmdb_id` | Collection legacy ID; rename only with identity refactor. |
| `collection_name` | Catalog collection. |
| `collection_poster_path` | Selected local collection poster. |
| `collection_backdrop_path` | Selected local collection backdrop. |
| `collection_metadata_checked_at` | Archivist refresh state. |
| `status` | Archivist state (`wanted`, available, etc.), not provider metadata. |
| `monitored` | User state. |
| `quality_profile_id` | Archivist configuration. |
| `root_folder_path` | Archivist storage configuration. |
| `file_path` | Local media state. |
| `file_size` | Local media state. |
| `quality` | Local media state. |
| `added_at` | Archivist state. |
| `updated_at` | Archivist state. |
| `download_progress` | Acquisition state. |
| `info_hash` | Acquisition state. |
| `release_date` | Catalog primary/theatrical projection. |
| `digital_release_date` | Earliest applicable type-4 regional release. |
| `physical_release_date` | Earliest applicable type-5 regional release. |
| `last_metadata_refresh_at` | Catalog import/projection state. |
| `post_release_metadata_refreshed_at` | Archivist refresh policy. |
| `acquired_at` | Local media state. |
| `download_tier` | Acquisition state. |
| `target_tier` | User acquisition preference. |
| `target_resolution` | User acquisition preference. |
| `target_source` | User acquisition preference. |
| `target_codec` | User acquisition preference. |
| `minimum_tier` | User acquisition preference. |
| `minimum_resolution` | User acquisition preference. |
| `minimum_source` | User acquisition preference. |
| `minimum_codec` | User acquisition preference. |
| `available_versions` | Ordered JSON from `catalog_edition_labels`. |
| `expected_version` | User acquisition preference. |
| `upgrade_allowed` | User acquisition preference. |
| `current_tier` | Local file state. |
| `current_resolution` | Local file state. |
| `current_source` | Local file state. |
| `current_codec` | Local file state. |
| `current_release_group` | Local file state. |
| `current_edition` | Local file state. |
| `current_size_bytes` | Local file state. |
| `current_release_title` | Local file state. |
| `default_edition_id` | FK to local edition state. |

Exact JSON projection contracts:

```json
{
  "cast": [
    {
      "id": 123,
      "name": "Person Name",
      "character": "Character",
      "profilePath": "/local/artwork/path-or-route"
    }
  ],
  "crew": [
    {
      "id": 456,
      "name": "Person Name",
      "job": "Director",
      "profilePath": "/local/artwork/path-or-route"
    }
  ]
}
```

The `id` values presently mean TMDB person IDs. Keep the legacy values until all client links and API filters accept internal `person_id`.

### 36. Existing `film_editions`

These are user/library instances and must remain separate from catalog edition labels.

| Field | Ownership |
|---|---|
| `id` | Archivist PK. |
| `film_id` | FK to local `films`. |
| `edition_name` | Catalog suggestion or user choice. |
| `runtime` | Edition-specific metadata. |
| `release_date` | Edition-specific metadata. |
| `overview` | Edition-specific metadata. |
| `poster_path` | Local selected edition artwork. |
| `backdrop_path` | Local selected edition artwork. |
| `status` | Library/acquisition state. |
| `download_progress` | Acquisition state. |
| `info_hash` | Acquisition state. |
| `file_path` | Local media state. |
| `file_size` | Local media state. |
| `quality` | Local media state. |
| `current_tier` | Local media state. |
| `current_resolution` | Local media state. |
| `current_source` | Local media state. |
| `current_codec` | Local media state. |
| `current_release_group` | Local media state. |
| `current_edition` | Local media state. |
| `current_size_bytes` | Local media state. |
| `current_release_title` | Local media state. |
| `added_at` | Archivist state. |
| `updated_at` | Archivist state. |

### 37. Existing `people`

| Field | Source |
|---|---|
| `id` | Archivist PK. |
| `tmdb_id` | `catalog_people.tmdb_id`. |
| `name` | Catalog. |
| `normalized_name` | Catalog/generated. |
| `known_for_department` | Catalog. |
| `profile_path` | Local profile asset route/path. |
| `created_at` | Local projection state. |
| `updated_at` | Local projection state. |

### 38. Existing `media_credits`

| Field | Source |
|---|---|
| `id` | Archivist PK. |
| `media_type` | `film`. |
| `media_id` | Local `films.id`. |
| `person_id` | Local `people.id`. |
| `credit_type` | `cast` or `crew`. |
| `role` | Catalog normalized role. |
| `job` | Catalog raw job. |
| `character` | Catalog cast character. |
| `billing_order` | Catalog order. |
| `is_starring` | True for the exact starring threshold used by the feature. |

### 39. Existing Lists tables

These remain operational but depend on the catalog query engine.

`lists` fields:

- `id`
- `library_id`
- `name`
- `description`
- `media_type`
- `filter` (JSON query definition)
- `mode`
- `enabled`
- `root_folder_id`
- `quality_profile_id`
- `monitored`
- `target_tier`
- `target_resolution`
- `target_source`
- `target_codec`
- `max_adds_per_run`
- `member_cap`
- `refresh_interval_hours`
- `last_refreshed_at`
- `last_error`
- `consecutive_failures`
- `created_at`
- `updated_at`

`list_items` fields:

- `id`
- `list_id`
- `media_type`
- `tmdb_id` (catalog legacy film ID until refactored)
- `tvdb_id`
- `imdb_id`
- `title`
- `year`
- `poster_path` (local artwork)
- `status`
- `status_reason`
- `library_item_id`
- `first_seen_at`
- `last_seen_at`
- `resolved_at`

`list_refresh_runs` fields:

- `id`
- `list_id`
- `started_at`
- `finished_at`
- `fetched`
- `new_items`
- `auto_added`
- `departed`
- `capped`
- `error`

`list_query_cache` fields:

- `compiler_id`
- `media_type`
- `query_hash`
- `payload`
- `fetched_at`
- `expires_at`

### 40. Existing recommendation and engagement tables

These are local personalization state, but their film payloads must be populated from the offline catalog.

`recommendation_source_candidates`:

- `media_type`
- `provider_id` (currently the TMDB film ID; migrate to internal film ID or retain the legacy value)
- `source_key`
- `payload`
- `fetched_at`
- `expires_at`

The film candidate `payload` must include:

- `title`
- `year`
- `overview`
- `genres`
- `posterPath` (local route)
- `backdropPath` (local route)
- `rating`
- `popularity`
- `status`
- `releaseDate`
- source/seed key

`recommendation_snapshots`:

- `id`
- `audience`
- `media_type`
- `library_id`
- `model_version`
- `items`
- `generated_at`
- `invalidated_at`

`recommendation_feedback`:

- `profile_id`
- `media_type`
- `provider_id`
- `feedback`
- `created_at`
- `updated_at`

`recommendation_exposures`:

- `id`
- `profile_id`
- `snapshot_id`
- `media_type`
- `provider_id`
- `surface`
- `rank`
- `reason_code`
- `outcome`
- `exposed_at`
- `outcome_at`

`engagement_events`:

- `id`
- `profile_id`
- `media_type`
- `media_id`
- `event_type`
- `progress_percent`
- `occurred_at`

Playback progress and media ratings also remain local recommendation inputs; they are not catalog metadata.

## TMDB API source map for derived/runtime tables 32–40

These tables are either rebuildable projections or existing Archivist operational tables. The endpoint column identifies the provider data that feeds them; it does not mean TMDB owns the table.

| Table | Relevant TMDB endpoint(s) | Projection/usage |
|---|---|---|
| 32. `catalog_films_fts` | `GET /movie/{movie_id}`, `/movie/{movie_id}/alternative_titles`; behavior modelled on `/search/movie` | Rebuild locally from canonical title, original title, alternative titles, and year. Never query TMDB at offline runtime. |
| 33. `catalog_people_fts` | `GET /person/{person_id}`, `/search/person` | Rebuild from canonical person names and department. Local popularity can be retained as a secondary ranking signal. |
| 34. `catalog_companies_fts` | `GET /company/{company_id}`, `/search/company` | Rebuild from canonical company name and origin country. Current Add Films behavior takes the first matching company search result. |
| 35. Existing `films` | `GET /movie/{movie_id}` with appended `release_dates,images,credits,videos,alternative_titles`; optional separate `external_ids` | Project the normalized catalog into Archivist's flattened library row. This endpoint must be replaced by a local repository call after migration. |
| 36. Existing `film_editions` | No direct edition endpoint; source hints from `/movie/{movie_id}/release_dates` and `/alternative_titles` | Edition records are primarily local/user/file state. TMDB notes/titles only suggest labels and metadata. |
| 37. Existing `people` | `GET /person/{person_id}`, `/search/person`, `/person/{person_id}/images` | Project canonical people and local profile artwork. |
| 38. Existing `media_credits` | `GET /movie/{movie_id}/credits`, `/person/{person_id}/movie_credits` | Project normalized full credits into the local cross-media credit index. |
| 39. Existing Lists tables | `GET /discover/movie`, `/search/movie`, `/search/person`, `/search/company`, `/person/{person_id}/movie_credits` | List definitions/runs/items/cache are local. These endpoints currently resolve lookups and membership; replace them with canonical search/joins while preserving filter semantics. |
| 40. Existing recommendation/engagement tables | `GET /movie/{movie_id}/recommendations`, `/trending/movie/week`, `/movie/upcoming`, `/discover/movie` | Candidate payloads come from provider summaries/feed edges. Snapshots, feedback, exposure, engagement, playback, and personal ratings remain local. |

## Part IV — Exact query capabilities the offline layer must implement

Storing the fields is not sufficient if the local service cannot reproduce the queries. The TMDB adapter should be replaced by a catalog repository exposing these operations:

### Movie retrieval and search

- Get a film by internal ID, legacy TMDB ID, or IMDb ID.
- Search title, original title, and alternative titles.
- Return: ID, title, original title, release date/year, overview, genre IDs/names, selected poster/backdrop, vote average, vote count, and popularity.
- Sort matching search results with poster-bearing results preferred, followed by popularity, while preserving textual relevance.
- Paginate and return `page`, `total_pages`, and `total_results`.

### Discovery/List filtering

The local query compiler must support all film filters currently sent to discovery:

- title text
- include/exclude genre
- fixed year
- date range
- relative dates including this year, next year, and future
- minimum/maximum vote average
- minimum vote count
- minimum/maximum runtime
- original language
- regional certification
- include/exclude keyword
- include/exclude title/film ID
- person by exact role
- production company/studio
- watch provider plus region
- sort by popularity, rating, release date, and other currently exposed sort modes

Person semantics must be exact:

- `starring`: cast members with billing order `0..2`
- `cast`: any cast credit
- `crew`: any crew credit
- `any`: cast or crew
- `director`: only normalized director jobs
- `producer`: Producer/Co-Producer, not Executive Producer
- `executive_producer`: Executive Producer/Co-Executive Producer
- writer, creator, composer, cinematographer, and editor according to `catalog_role_aliases`

### Named feeds and recommendations

- Weekly trending movies with stable rank.
- Upcoming US theatrical movies using release types 1, 2, or 3 and dates on/after the query date.
- Top rated movies ordered by rating with the present minimum-vote rule (currently at least 300) and release cutoff.
- Per-film ordered recommendations.
- Genre/cast/crew discovery used by "For You."
- Candidate scoring data: rating, popularity, vote count, genres, top five cast IDs, and director IDs.

If exact historical TMDB ordering is required, import feed and recommendation snapshots. Recomputing from static fields can be functionally similar but cannot be guaranteed identical to TMDB's proprietary popularity/trending/recommendation algorithms.

## Part V — Artwork and file layout

### Required locally selected files per film

Where available, the catalog projection or folder synchronizer must produce:

```text
<film folder>/
  poster.jpg
  backdrop.jpg
  logo.png
  banner.jpg
  clearart.png
  thumb.jpg
  disc.png
  trailer.mkv
```

Only poster, backdrop, logo, and banner have direct columns on `films`; clearart, thumb, and disc are currently file-backed image-editor assets. They still must be catalogued in `catalog_artwork_assets` to recreate the complete film artwork experience.

### Image-selection parity

- Default logo: prefer an English (`en`) logo, then the first available logo.
- Default banner: current metadata logic uses the second backdrop when present, otherwise the first. Store an explicit selected banner so import ordering changes cannot alter it.
- Poster/backdrop/profile/company/provider/collection art must resolve to local routes.
- Preserve all alternative images, their dimensions, languages, votes, and ordering so the image picker works.
- Fanart.tv results currently add poster, background, logo, banner, clearart, thumb, and disc options. If the goal is **fully offline**, mirror those bytes and source metadata too. Removing TMDB alone does not remove Fanart.tv network dependency.

### Asset-serving contract

The application should expose an internal asset URL such as `/api/catalog/assets/{asset_id}/{variant}`. That route must:

- read only local path/blob data;
- set the correct MIME type and cache headers;
- reject traversal outside `artwork_root`;
- support the rendition sizes currently expected by the client;
- optionally fall back to `original`, never to a remote TMDB URL;
- verify checksums during import or background integrity scans.

## Part VI — Canonical-to-runtime derivations

Use deterministic rules so a rebuild produces the same application rows:

| Runtime value | Derivation |
|---|---|
| `films.year` | Year of `primary_release_date`. |
| `films.genres` | Genre names ordered by `catalog_film_genres.billing_order`. |
| `films.country` | `catalog_film_countries.is_primary`, otherwise lowest billing order. |
| `films.studio` | `is_primary_studio`, otherwise first production company. |
| `films.certification` | First non-empty certification for the configured default region, preserving release-event order. |
| `films.release_date` | Primary release date/current movie-detail projection. |
| `films.digital_release_date` | Earliest default-region type-4 release date. |
| `films.physical_release_date` | Earliest default-region type-5 release date. |
| `films.cast` | Ordered cast JSON with legacy person ID, name, character, and local profile path. |
| `films.crew` | Ordered crew JSON with legacy person ID, name, raw job, and local profile path. |
| `films.available_versions` | Deduplicated edition labels in stable order. |
| `films.trailer_url` | Local default trailer route; otherwise null in strict offline mode. |
| `poster_path` etc. | Local selected-asset route/path, never a TMDB CDN fragment. |

Keep the raw normalized source rows even when a projection exists. For example, `films.certification = 'PG-13'` cannot replace all country-specific certification rows, and `films.studio = 'Marvel Studios'` cannot replace the company join table.

## Part VII — Index and integrity checklist

Required indexes:

- film IDs: internal, legacy TMDB, IMDb
- normalized film title and FTS text
- `primary_release_date`, `primary_release_year`, `runtime_minutes`
- `popularity`, `vote_average`, `vote_count`
- film/genre in both directions
- normalized person name and person FTS
- cast and crew by (`person_id`, `film_id`, `billing_order`)
- crew by (`normalized_role`, `person_id`)
- normalized company name and company FTS
- film/company in both directions
- release event by (`country_code`, `release_type`, `release_date`)
- certification by (`country_code`, `certification`)
- alternative title by film plus FTS projection
- film/keyword and normalized keyword name
- watch availability by (`country_code`, `provider_id`, `film_id`)
- artwork by (`owner_type`, `owner_id`, `artwork_type`, `billing_order`)
- feed items by (`feed_id`, `rank`)
- recommendation edges by (`source_film_id`, `rank`)

Import validation:

- No selected artwork row may lack local bytes/path and a valid checksum.
- Every projected legacy person/film/company/collection ID must be unique within its namespace.
- Every `default_*_asset_id` must belong to the referenced film and correct artwork type.
- `is_starring_top3` must equal `billing_order <= 2`; top-five must equal `billing_order <= 4`.
- Only director jobs normalize to `director`; producer and executive producer remain distinct.
- Release events must use valid country and type codes.
- Feed and recommendation ranks must be unique and contiguous or explicitly record gaps.
- All FTS indexes and flattened `films` JSON must be rebuilt after an import.

## Part VIII — Feature coverage matrix

| Archivist film feature | Required catalog data |
|---|---|
| Add/search page | Films, alternative titles, genres, artwork, popularity, votes, pagination/search indexes. |
| Clickable person filters | People, person search, full credits, exact normalized jobs, legacy/internal ID translation. |
| Director/Starring/List templates | People, cast order, full crew jobs, role aliases, film credits, runtime, genres/documentary exclusion, dates. |
| Studio template | Companies, company search, film-company joins, primary studio. |
| List relative dates | Primary and regional release dates plus local date query evaluation. |
| Film detail modal/page | Full film row, credits, collection, videos, all selected artwork. |
| Image editor | Every artwork asset and variant, including Fanart-style clearart/thumb/disc. |
| Calendar/dashboard | Primary, digital, and physical dates; title, overview, poster/backdrop, status projection. |
| Library matching/import | Title/original/alternative titles, year, runtime, IMDb and retained legacy TMDB IDs. |
| NFO generation | IDs, titles, plot, runtime, dates, certification, studio, country, genres, credits, collection, artwork. |
| Editions/version selection | Release-event notes, alternative titles, derived edition labels, edition artwork. |
| Recommendations/"For You" | Rating, popularity, vote count, genres, cast order, directors, recommendation edges, discovery feeds. |
| Upcoming/trending/top rated | Ordered feed snapshots or an equivalent local query engine and all ranking fields. |
| Watch-provider Lists | Providers, regions, monetization types, availability joins. |
| Indexer/subtitle integration | IMDb ID, retained legacy TMDB ID, title/year, original language. |

## Part IX — External services that remain unless separately mirrored

A TMDB-free film catalog does not by itself make every film workflow offline:

- **Fanart.tv:** the image picker also searches Fanart.tv. Mirror its image records and bytes into the artwork tables or disable that source.
- **YouTube:** a `site` and `provider_key` still require internet. Mirror the selected trailer to a local file.
- **OpenSubtitles:** subtitle searching/downloading remains an external service. IMDb/TMDB IDs may still be passed to it as inert identifiers.
- **Indexers/download clients:** acquisition remains external and may use IMDb/TMDB IDs for matching.

These do not prevent eliminating TMDB calls, but they matter if the broader requirement is zero external network dependence.

## Part X — Audited provider endpoint and field ledger

This is the second-pass evidence ledger. It records every TMDB/Fanart response used by the film implementation at revision `1f9fd9d96dba` and shows where it is represented in the offline schema. A provider field not listed here is not read by the current film application and is therefore not required for exact current behavior.

### `/movie/{movie_id}`

Requested with `language=en-US`, `include_image_language=en,null`, and appended `release_dates,images,credits,videos,alternative_titles`.

| Provider field read | Offline destination |
|---|---|
| `id` | `catalog_films.tmdb_id` and `catalog_external_ids`. |
| `imdb_id` | `catalog_films.imdb_id` and `catalog_external_ids`. |
| `title` | `catalog_films.title`. |
| `original_title` | `catalog_films.original_title`. |
| `original_language` | `catalog_films.original_language`. |
| `release_date` | `catalog_films.primary_release_date`. |
| `overview` | `catalog_films.overview`. |
| `runtime` | `catalog_films.runtime_minutes`. |
| `genres[].id` | `catalog_genres.genre_id` plus `catalog_film_genres`. |
| `genres[].name` | `catalog_genres.name`. |
| `poster_path` | `catalog_artwork_assets.source_asset_id`, selected poster FK, and local variant. |
| `backdrop_path` | Artwork asset, selected backdrop FK, and local variant. |
| `vote_average` | `catalog_films.vote_average`. |
| `popularity` | `catalog_films.popularity`. |
| `production_companies[].id` | `catalog_companies.tmdb_id` plus film-company join. |
| `production_companies[].name` | `catalog_companies.name`. |
| `production_companies[].origin_country` | `catalog_companies.origin_country` when present in company/search data. |
| `production_companies[].logo_path` | Company artwork asset. |
| `production_countries[].iso_3166_1` | `catalog_film_countries.country_code`. |
| `production_countries[].name` | `catalog_countries.name`. |
| `belongs_to_collection.id` | `catalog_collections.tmdb_id`. |
| `belongs_to_collection.name` | `catalog_collections.name`. |
| `belongs_to_collection.poster_path` | Local collection poster asset. |
| `belongs_to_collection.backdrop_path` | Local collection backdrop asset. |

`vote_count`, `adult`, `video`, and provider `status` are also retained on `catalog_films`. The detail parser does not currently serialize all four, but discovery/List/recommendation parity needs the first three and retaining status avoids lossy summary/detail merging.

### Appended `release_dates`

| Provider field read | Offline destination |
|---|---|
| `results[].iso_3166_1` | `catalog_release_events.country_code`. |
| `results[].release_dates[].certification` | `catalog_release_events.certification`. |
| `results[].release_dates[].release_date` | `release_at` and materialized `release_date`. |
| `results[].release_dates[].type` | `catalog_release_events.release_type`. |
| `results[].release_dates[].note` | `catalog_release_events.note`. |

These rows derive the first non-empty US certification, earliest US theatrical type 1/2/3 date, earliest US digital type 4 date, earliest US physical type 5 date, release lifecycle, and edition labels.

### Appended `images` and standalone `/movie/{movie_id}/images`

| Provider field read | Offline destination |
|---|---|
| `posters[].file_path` | Artwork source ID/path and local poster variants. |
| `backdrops[].file_path` | Artwork source ID/path and local backdrop/thumb/banner variants. |
| `logos[].file_path` | Artwork source ID/path and local logo variants. |
| `*.iso_639_1` | `catalog_artwork_assets.language`. |
| `*.width` | `catalog_artwork_assets.width`. |
| `*.height` | `catalog_artwork_assets.height`. |

The provider also supplies `aspect_ratio`, `vote_average`, and `vote_count`; the current picker does not display them, but the artwork schema deliberately retains them so source order/ranking can be reconstructed instead of becoming lossy.

### Appended `credits`

| Provider field read | Offline destination |
|---|---|
| `cast[].id` | Person legacy ID. |
| `cast[].name` | Person name. |
| `cast[].character` | `catalog_film_cast.character`. |
| `cast[].profile_path` | Person profile artwork. |
| `cast[].order` or response position | `catalog_film_cast.billing_order`. |
| `cast[].credit_id` | `catalog_film_cast.credit_id`. |
| `crew[].id` | Person legacy ID. |
| `crew[].name` | Person name. |
| `crew[].job` | `catalog_film_crew.job`. |
| `crew[].department` | `catalog_film_crew.department`. |
| `crew[].profile_path` | Person profile artwork. |
| `crew[].credit_id` | `catalog_film_crew.credit_id`. |
| crew response position | `catalog_film_crew.billing_order`. |

The movie-detail projection currently keeps only Director, Producer, Writer, and Screenplay crew in `films.crew`. The canonical catalog must **not** apply that truncation because exact-role Lists require Executive Producer, Composer, Cinematography/Director of Photography, Editor, and other raw jobs from person movie credits.

### Appended `videos`

| Provider field read | Offline destination |
|---|---|
| `results[].key` | `catalog_videos.provider_key`. |
| `results[].site` | `catalog_videos.site`. |
| `results[].type` | `catalog_videos.video_type`. |

The schema additionally retains name, language, country, official flag, size, publication date, and ordering when available. Local path, MIME type, byte size, and checksum are required if trailer playback itself must be offline.

### Appended `alternative_titles`

| Provider field read | Offline destination |
|---|---|
| `titles[].iso_3166_1` | `catalog_alternative_titles.country_code`. |
| `titles[].title` | `catalog_alternative_titles.title`. |
| `titles[].type` | `catalog_alternative_titles.title_type`. |
| response position | `catalog_alternative_titles.billing_order`. |

The current code scans `title` for edition phrases. Country/type are retained to avoid a lossy mirror and to support deterministic regional title search.

### `/search/movie`

| Provider field read | Offline destination |
|---|---|
| `results[].id` | Film legacy ID. |
| `results[].title` | Film title. |
| `results[].original_title` | Original title. |
| `results[].release_date` | Primary release date/year. |
| `results[].overview` | Overview. |
| `results[].genre_ids[]` or `genres[]` | Film-genre joins. |
| `results[].poster_path` | Selected/local poster. |
| `results[].backdrop_path` | Selected/local backdrop. |
| `results[].vote_average` | Vote average. |
| `results[].popularity` | Popularity. |
| `page`, `total_pages`, `total_results` | Local query response, calculated from the result set. |

The request uses `include_adult=false`. `catalog_films.adult` is therefore required even though adult titles are excluded from the response.

### `/discover/movie`

The result row fields are the same movie-summary fields listed for `/search/movie`. The local engine must additionally query:

- `primary_release_year`
- `primary_release_date.gte/lte`
- genre inclusion/exclusion
- `vote_average.gte/lte`
- `vote_count.gte`
- `with_runtime.gte/lte`
- `with_original_language`
- certification country and value
- keyword inclusion/exclusion
- cast, crew, or any-person IDs
- company IDs
- watch provider IDs and region
- release types
- `include_adult=false`
- `include_video=false`
- `sort_by`

Those inputs map to canonical tables 2–25. Boolean `and`, compatible same-type `or`, supported `not`, exact title inclusion/exclusion, page limits, member caps, and provider-ceiling behavior must be reproduced in the local List compiler rather than stored as additional film fields.

### `/genre/movie/list`

| Provider field read | Offline destination |
|---|---|
| `genres[].id` | `catalog_genres.genre_id`. |
| `genres[].name` | `catalog_genres.name`. |

### `/search/person`, `/person/{person_id}`, and `/person/{person_id}/movie_credits`

| Provider field read | Offline destination |
|---|---|
| person `id` | `catalog_people.tmdb_id`. |
| person `name` | `catalog_people.name`. |
| person `original_name` when supplied | `catalog_people.original_name`. |
| person `popularity` | `catalog_people.popularity`. |
| person `known_for_department` | `catalog_people.known_for_department`. |
| person `profile_path` | Local profile artwork. |
| `known_for[].title` or `.name` | `catalog_person_known_for.display_title`. |
| `known_for[].media_type` | `catalog_person_known_for.media_type`. |
| known-for response order | `catalog_person_known_for.billing_order`. |
| movie-credit cast/crew film `id` | Film legacy ID/film join. |
| movie-credit film `title` | Film title. |
| movie-credit film `release_date` | Film primary release date. |
| movie-credit film `poster_path` | Film poster. |
| movie-credit film `overview` | Film overview. |
| movie-credit `order` | Cast billing order and starring semantics. |
| movie-credit `job` | Raw crew job and exact normalized role. |
| movie-credit `department`/`credit_id` | Crew relationship fields. |

Person lookup is popularity-ranked. Exact-person List evaluation uses the full movie-credit response and then intersects film IDs; storing only people names or the four detail-page crew jobs is insufficient.

### `/search/company` and `/company/{company_id}`

| Provider field read | Offline destination |
|---|---|
| `id` | `catalog_companies.tmdb_id`. |
| `name` | `catalog_companies.name`. |
| `origin_country` | `catalog_companies.origin_country`. |
| `logo_path` | Local company logo asset. |

Company search result order should be retained or reproduced by text relevance; field-aware Add Films presently chooses the first result.

### `/movie/{movie_id}/recommendations`

The response uses the movie-summary fields listed under `/search/movie`, plus response order. It maps to `catalog_film_recommendations` and the referenced canonical films. The application keeps up to 40 rows from page 1.

### `/trending/movie/week` and `/movie/upcoming`

Both use movie-summary result fields. Exact order, page, region, and snapshot time map to `catalog_discovery_feeds` and `catalog_discovery_feed_items`.

- Trending reads up to three pages in the Add Films category.
- General recommendation discovery combines the first trending page with `/movie/upcoming?region=US`.
- The Add Films `upcoming` category is separately computed from discovery using future `primary_release_date`, release types `1|2|3`, popularity order, and three pages.
- Top rated is computed with `vote_average.desc`, at least 300 votes, a primary-release cutoff at the end of the previous year, and three pages.

### Fanart.tv `/v3/movies/{tmdb_id}`

| Response field read | Offline destination |
|---|---|
| image collection key (`movieposter`, `moviebackground`, `hdmovielogo`, `movielogo`, `moviebanner`, `hdmovieclearart`, `movieart`, `moviethumb`, `moviedisc`) | `catalog_artwork_assets.artwork_type`. |
| `url` | `original_url` for provenance plus downloaded local bytes/path. |
| `lang` | `catalog_artwork_assets.language`. |
| response order | `catalog_artwork_assets.billing_order`. |

Fanart image IDs and likes are sensible provenance/ranking additions but are not read by the current application. They can be stored in `source_asset_id` and `vote_count`/an optional source metadata JSON without being required for current parity.

## Part XI — What was deliberately not added

TMDB returns many fields that Archivist's film code does not read. They are not necessary to continue functioning exactly as the current application does:

- budget and revenue
- homepage
- tagline
- spoken-language display rows
- production-country names beyond the ISO/name reference
- provider runtime collections
- biographies, birthdays, death dates, gender, and place of birth for people
- cast gender, cast ID, and per-credit popularity
- video thumbnails supplied by third parties
- image metadata beyond the fields retained above

If future features will expose any of these, add them before building the dataset. "Complete" in this document means complete for the audited Archivist revision, not a byte-for-byte mirror of every field TMDB could ever return.

## Part XII — Non-metadata state boundary

The following data is used by film workflows but is generated by Archivist, the user, local media analysis, download clients, or indexers—not by TMDB. It must remain in the existing application database, but it does **not** need to be captured in the offline metadata catalog:

- libraries, root folders, quality profiles/definitions, custom formats, indexers, and download clients
- system jobs/events and metadata-refresh timestamps
- acquisition decisions, release blocklists, RSS/search state, media imports, torrent matching, and staged-download state
- file paths/sizes, parsed release quality, editions, edition rules, default edition, and upgrade preferences
- playback progress, bookmarks, ratings, rating dismissals, exposures, and engagement events
- player media probes, sync changes, preferences, play sessions, and session items
- loudness measurements, track-cleaning state, media segments/fingerprints/overrides, and library scan candidates
- List definitions/items/runs/cache and recommendation snapshots/candidates/feedback

Parts III and IV list the film-facing projections and fields where provider identity/payload compatibility matters. The canonical catalog is an additional metadata source, not a replacement for these user and operational tables.

## Part XIII — Second-pass completeness result

The second audit traced:

- `apps/server/src/modules/films/{tmdb,create,metadata-refresh,routes,repo,serialize}.ts`
- `apps/server/src/lists/{lookup,service,engine,routes}.ts` and `lists/compilers/tmdb.ts`
- `apps/server/src/recommendations/{for-you,service,routes}.ts`
- dashboard, player browse/routes/serializers, library scan, media imports, credit indexing, and media organizer/NFO code
- `client/src/lib/films.api.ts`, the film UI, library field-search definitions, Lists UI/API, and player film contracts/pages
- all film, people, credit, List, recommendation, playback, rating, artwork-related, and media-analysis tables in `packages/db/src/schema.ts`

Result: every TMDB field currently read by those code paths has a canonical column, relationship row, derived projection, or explicitly documented local-query calculation above. The second pass did not find a missing currently consumed TMDB field. It did identify documentation gaps, now corrected by Parts X–XII:

1. the provider endpoint-to-field mapping was implicit rather than auditable;
2. current locale, pagination, selection, and result-order rules needed to be explicit;
3. the boundary between offline provider metadata and existing local operational state needed to be unambiguous;
4. Fanart source fields and intentionally unused TMDB fields needed an explicit disposition.

The only unavoidable qualification is algorithmic: TMDB's future popularity, trending, and recommendation rankings cannot be derived exactly from movie metadata because TMDB does not publish those algorithms. Exact parity requires importing the ordered feed/recommendation snapshots at a chosen time. The schema includes those snapshots and their ranks.

## Recommended migration sequence

1. Create the canonical catalog and asset tables.
2. Import a complete dataset, including actual artwork bytes and image variants.
3. Build local movie/person/company search and discovery repositories.
4. Replace every TMDB adapter call with the local repository while keeping its current response DTO.
5. Project metadata into existing `films`, `people`, and `media_credits` rows.
6. Replace remote image URL builders with the internal asset-serving route.
7. Populate recommendation edges and named feed snapshots.
8. Run feature-parity tests for search, person roles, Lists, Studio filters, relative dates, details, calendar, recommendations, and artwork selection.
9. Only after parity, optionally refactor `tmdb_id`/`provider_id` fields and routes to internal catalog IDs.

## Minimum conclusion

Copying the current `films` table is not sufficient. A faithful offline replacement requires the 31 canonical catalog/reference/relationship tables above, three rebuildable search indexes, local artwork/video storage, and continued use of Archivist's operational library/List/recommendation tables. The most important non-obvious requirements are full crew jobs, cast order, all regional release events, company and watch-provider joins, alternative titles and release notes, vote counts and popularity, ordered recommendation/feed rows, and locally stored artwork variants.
