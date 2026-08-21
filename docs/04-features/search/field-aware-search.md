---
title: "Archivist Feature Build: Intelligent Field-Aware Library Search"
document_type: feature-specification
status: historical
classified: 2026-08-16
---
# Archivist Feature Build: Intelligent Field-Aware Library Search

## Purpose

Build a production-ready field-aware search capability for Archivist.

The feature must allow users to search Films and Series using structured metadata rather than title alone, including:

- Title
- Genre
- Year
- Cast
- Starring cast
- Director
- Writer
- Producer
- Composer
- Studio
- Network
- Collection
- Other normalized metadata fields

The feature must integrate into the existing Archivist search bar and existing Archivist architecture.

The initial implementation must focus on searching items already present in the Archivist library.

The architecture must also be designed so Archivist can later support:

- Multiple simultaneous search conditions
- Natural-language search
- Remote discovery
- Searching for Films and Series not yet in the library
- Adding discovery results directly to Archivist

Remote discovery and library addition are described later in this document as a proposed extension requiring further product decisions.

---

# 1. Mandatory Repository Analysis

Before editing code:

1. Inspect the complete repository structure.
2. Read all existing:
   - Architecture documentation
   - Development instructions
   - Agent instructions
   - Coding standards
   - Database documentation
   - API documentation
   - Frontend documentation
   - Metadata-provider documentation
   - Testing documentation
   - Migration guidance
3. Identify:
   - Current Film and Series data models
   - Current library-item model
   - Existing search implementation
   - Existing metadata-provider interfaces
   - TMDB integration
   - TVDB integration
   - Database technology
   - ORM or query-builder implementation
   - API framework
   - Frontend framework
   - State-management conventions
   - Existing dropdown components
   - Existing tree-style dropdown components
   - Existing search components
   - Existing background-job system
   - Existing metadata refresh process
   - Existing acquisition or add-to-library workflow
   - Existing duplicate-detection logic
   - Existing test infrastructure
4. Produce a concise implementation plan before modifying code.
5. Reuse existing abstractions and patterns where they are sound.
6. Do not guess:
   - File paths
   - Schemas
   - Component APIs
   - Framework conventions
   - Provider capabilities
   - Acquisition behaviour
7. Preserve backward compatibility unless a database migration or API change is explicitly required.

Do not build an isolated demonstration, parallel search system, or replacement application.

Implement the feature within the existing Archivist architecture.

---

# 2. Product Definition

Archivist library pages currently provide search functionality for media items such as Films and Series.

Enhance the existing search bar with a query-field selector positioned on the far-right side of the search control.

The selector determines which structured metadata field the search text applies to.

Conceptual layout:

```text
[ Search films…                                  ][ Title ▾ ]
```

The default field must be:

```text
Film → Title
```

or:

```text
Series → Title
```

depending on the active library.

The field selector must use the same tree-style dropdown behaviour and visual design already used elsewhere in Archivist.

Do not introduce a visually inconsistent dropdown implementation.

---

# 3. Core Design Principle

Archivist must search its own normalized local metadata.

TMDB, TVDB, and future metadata providers are enrichment sources.

They must not be called every time the user enters or changes a local-library search query.

The normal search flow must be:

```text
TMDB / TVDB / metadata providers
              ↓
Archivist metadata ingestion
              ↓
Normalized Archivist database
              ↓
Indexed structured search
              ↓
Library results
```

This ensures:

- Fast results
- Offline resilience
- Provider independence
- No search-time provider rate-limit dependency
- Consistent role classification
- Stable pagination
- Searches limited to the user’s actual library
- Future support for additional metadata providers

A provider outage must not prevent searches against metadata already stored in Archivist.

---

# 4. Query Selector Hierarchy

## 4.1 Film Library

For the Films library, implement the following query tree:

```text
Film
├── Title
├── Original Title
├── Alternative Title
├── Genre
├── Year
├── Decade
├── Keyword
├── Certification
├── Country
├── Original Language
└── Runtime

People
├── Starring
├── Supporting Cast
├── Any Cast
├── Director
├── Writer
├── Producer
├── Executive Producer
├── Composer
├── Cinematographer
├── Editor
└── Any Credit

Studio
└── Studio

Collection
└── Collection
```

## 4.2 Series Library

For the Series library, implement:

```text
Series
├── Title
├── Original Title
├── Alternative Title
├── Genre
├── First Air Year
├── Decade
├── Keyword
├── Certification
├── Country
├── Original Language
└── Status

People
├── Starring
├── Supporting Cast
├── Any Cast
├── Creator
├── Director
├── Writer
├── Producer
├── Executive Producer
├── Composer
└── Any Credit

Studio
├── Studio
└── Network

Collection
└── Collection
```

Only show fields valid for the active media type.

Do not show Film-specific fields while browsing Series.

Do not show Series-specific fields while browsing Films.

The first group heading must dynamically reflect the current media type.

---

# 5. Stable Query Field Definitions

Represent search fields using stable internal identifiers.

Do not pass user-facing labels directly into database query construction.

Suggested conceptual identifiers:

```text
title
original_title
alternative_title
genre
year
first_air_year
decade
keyword
certification
country
original_language
runtime
status

starring
supporting_cast
any_cast
creator
director
writer
producer
executive_producer
composer
cinematographer
editor
any_credit

studio
network
collection
```

Adapt these names to existing Archivist naming conventions where appropriate.

Create a centralized field registry containing at least:

```ts
type QueryFieldDefinition = {
  id: QueryField;
  label: string;
  group: QueryFieldGroup;
  supportedMediaTypes: MediaType[];
  searchStrategy: SearchStrategy;
  placeholder?: string;
  icon?: string;
  valueType?: QueryValueType;
  supportsAutocomplete?: boolean;
  supportsExactEntitySelection?: boolean;
};
```

Both frontend and backend should derive behaviour from shared definitions where the architecture supports shared types.

Avoid maintaining multiple unrelated hard-coded field lists.

---

# 6. Search Behaviour

## 6.1 General Rules

All search modes must:

- Be case-insensitive
- Trim leading and trailing whitespace
- Normalize repeated whitespace
- Support partial matching
- Preserve Unicode
- Handle common punctuation differences
- Search normalized aliases where available
- Return only items in the current library scope
- Respect user permissions
- Respect library permissions
- Respect media-type scope
- Preserve existing pagination
- Preserve existing sort behaviour
- Work with keyboard navigation
- Work on responsive layouts
- Be accessible to screen readers

Use existing normalization functions where available.

Do not introduce a second normalization implementation unless required.

## 6.2 Default Title Search

Title must remain the default search field.

The default behaviour should preserve existing Archivist search behaviour as closely as possible.

General Title search may search:

1. Display title
2. Original title
3. Alternative titles

However:

- `Original Title` must restrict searching to the original-title field.
- `Alternative Title` must restrict searching to known alternative-title records.
- Explicit fields must not silently behave as broad Title search.

## 6.3 Year Search

Year search must support a four-digit year.

Examples:

```text
1999
2004
2026
```

Validate malformed input using existing validation patterns.

The Series equivalent must use first-air year.

## 6.4 Decade Search

Decade search should accept common forms where practical:

```text
1980
1980s
80s
1990s
```

Normalize these values into a bounded year range.

Examples:

```text
1980s → 1980 through 1989
90s   → 1990 through 1999
```

Avoid ambiguous interpretation where a deterministic result cannot be produced.

## 6.5 Genre Search

Genre search must query normalized genre relationships.

It must not rely on a string search against raw provider JSON.

Examples:

```text
Science Fiction
Horror
Comedy
Documentary
```

Use provider genre identifiers internally where available, while preserving Archivist’s provider-neutral genre model.

## 6.6 Keyword Search

Keyword search must query normalized metadata keywords or themes where these are available.

Examples:

```text
time travel
haunted house
space exploration
cold war
```

Do not claim keyword coverage for items where the provider has not supplied keyword metadata.

## 6.7 Studio and Network Search

Studio search must return media associated with a matching normalized production company or studio.

For Series, Network search must query normalized network relationships separately from production studios.

Examples:

```text
Warner Bros.
A24
Universal Pictures
HBO
Netflix
AMC
```

Do not merge studio and network concepts in the data model.

## 6.8 Collection Search

Collection search must return media belonging to a normalized collection or franchise entity.

Movie collections sourced from TMDB may be used where available.

The Archivist collection model must remain provider-neutral.

Do not assume all Series franchises will have a provider-backed collection.

The schema should allow future support for:

- Provider-backed collections
- User-created collections
- Archivist-managed franchises
- Inferred franchises

Only provider-backed or existing collection data is required for the initial implementation.

---

# 7. People Search

People search is a core requirement.

A People query accepts a person name and returns matching Films or Series.

The result of a People search is a media-item list.

Do not return standalone person pages as the primary search result for this feature.

Examples:

```text
People → Starring → Harrison Ford
People → Director → Kathryn Bigelow
People → Writer → Phoebe Waller-Bridge
People → Composer → John Williams
People → Any Credit → John Carpenter
```

Where multiple people have identical or similar names, include media connected to all matching people unless the user has selected an exact person identity.

Preserve provider identifiers internally so exact-person selection and autocomplete can be added later.

---

# 8. Starring and Cast Classification

## 8.1 Films

For Films:

- `Starring` means cast billing positions 1 through 5.
- `Supporting Cast` means cast billing positions 6 onward.
- `Any Cast` includes all cast credits.

Use provider credit order where present.

Store billing order as structured metadata.

Do not repeatedly derive starring status from raw provider JSON during every search.

Starring status may be:

- Stored during metadata normalization
- Derived in a reusable query layer

Whichever approach is chosen must be deterministic and centralized.

## 8.2 Series

Series cast classification is more complicated because billing may vary across seasons and episodes.

Use whole-series aggregate credits where supported.

Do not classify Series starring roles using only the latest season.

Recommended ranking order:

1. Provider aggregate billing order
2. Number of credited episodes
3. Earliest provider order
4. Stable deterministic tie-breaker

The five highest-ranked aggregate cast members should be classified as `Starring`.

Remaining cast members should be classified as `Supporting Cast`.

`Any Cast` must include both.

Document the exact ranking algorithm.

---

# 9. Crew Role Normalization

Normalize provider-specific job names into Archivist credit roles.

At minimum support:

```text
creator
director
writer
producer
executive_producer
composer
cinematographer
editor
```

Preserve original provider values where the existing architecture allows it.

A credit record should retain:

- Provider department
- Provider job
- Archivist normalized role

Create a centralized role-mapping layer.

Do not scatter raw string comparisons across:

- Controllers
- API handlers
- Database queries
- Frontend components
- Metadata jobs

Example provider roles that may require normalization include:

```text
Director
Series Director
Writer
Screenplay
Teleplay
Story
Creator
Original Series Creator
Producer
Executive Producer
Co-Executive Producer
Original Music Composer
Music
Director of Photography
Cinematography
Editor
Film Editor
```

Inspect real provider payloads and existing fixtures before finalizing mappings.

`Any Credit` must search all normalized cast and crew relationships.

---

# 10. Metadata Data Model

Inspect whether Archivist already models:

- People
- Cast credits
- Crew credits
- Studios
- Networks
- Genres
- Keywords
- Collections
- Alternative titles

Reuse existing normalized entities where possible.

If metadata currently exists only inside provider JSON, introduce the minimum normalized relational model required for reliable search.

Conceptually, the schema may require entities equivalent to:

```text
people
media_people_credits
studios
media_studios
networks
media_networks
collections
media_collections
genres
media_genres
keywords
media_keywords
media_alternative_titles
```

Adapt these concepts to existing Archivist architecture.

## 10.1 Person Entity

A person record should be capable of storing:

```text
id
canonical_name
normalized_name
known_for_department
profile_image
tmdb_id
tvdb_id
imdb_id
provider_aliases
created_at
updated_at
```

Do not create a new person record for every appearance of the same person.

Reconcile people using provider identifiers where available.

Handle provider-ID conflicts explicitly.

Do not merge people based only on name.

## 10.2 Credit Relationship

A normalized credit relationship should be capable of storing:

```text
media_item_id
person_id
media_type
credit_type
normalized_role
provider_job
provider_department
character_name
billing_order
episode_count
is_starring
provider
provider_credit_id
```

`credit_type` should distinguish at least:

```text
cast
crew
```

The data model must support one person having multiple roles on the same media item.

Example:

```text
John Carpenter
├── Director
├── Writer
├── Producer
└── Composer
```

Do not collapse those into one vague credit record.

---

# 11. Metadata Ingestion

Extend the existing metadata ingestion flow so searchable metadata is populated whenever:

- A Film is added
- A Series is added
- Metadata is refreshed
- A provider match changes
- An item is reindexed
- A library rescan occurs
- A metadata repair job runs

Provider-specific payload models must remain inside provider adapters.

The rest of Archivist must consume provider-neutral domain models.

## 11.1 TMDB Film Metadata

For TMDB-backed Films, ingest or normalize where available:

- Film details
- Display title
- Original title
- Alternative titles
- Release year
- Cast
- Crew
- Production companies
- Collection
- Genres
- Keywords
- Certification
- Production countries
- Original language
- Runtime

## 11.2 TMDB Series Metadata

For TMDB-backed Series, ingest or normalize where available:

- Series details
- Display name
- Original name
- Alternative titles
- First-air year
- Aggregate cast credits
- Aggregate crew credits
- Creators
- Production companies
- Networks
- Genres
- Keywords
- Content rating
- Origin countries
- Original language
- Status

## 11.3 TVDB Metadata

For TVDB-backed items, map equivalent available metadata through the existing metadata-provider abstraction.

TVDB should remain a metadata provider.

Do not make the rest of Archivist depend directly on TVDB-specific response structures.

Where TVDB does not supply equivalent data, record the absence instead of fabricating it.

---

# 12. Existing-Library Backfill

Implement an idempotent backfill or reindex process for existing Archivist media.

The process must:

- Populate missing normalized people
- Populate missing credits
- Populate studios
- Populate networks
- Populate genres
- Populate collections
- Populate alternative titles
- Populate keywords where available
- Reuse stored provider metadata where sufficient
- Request remote metadata only where required
- Respect provider rate limits
- Process records in bounded batches
- Report progress
- Be restartable
- Avoid duplicate entities
- Avoid duplicate relationships
- Record per-item failures
- Continue processing after individual failures
- Avoid one long-running database transaction
- Integrate with the existing background-job system
- Be safe to run repeatedly

Provide an administrator-visible or documented way to trigger this backfill through an existing pattern such as:

- Maintenance command
- CLI command
- Admin action
- Job invocation
- Settings action

Do not create a second background-job framework.

---

# 13. Search API

Extend the existing library-search API.

Do not create an unrelated endpoint unless repository architecture clearly requires one.

The request must support a stable search-field identifier.

Conceptual example:

```http
GET /api/library/items?mediaType=film&query=Harrison%20Ford&queryField=starring
```

Adapt to the existing API style.

Validate:

- Media type
- Query field
- Query-field compatibility
- Query length
- Pagination
- Sorting
- Library scope
- User permissions

Invalid field and media-type combinations must return the existing standard validation response.

Examples:

```text
network             → Series only
first_air_year      → Series only
runtime             → Film only initially
cinematographer     → Film only initially
creator             → Series only
```

Do not silently fall back to title search when an unsupported field is supplied.

---

# 14. Future-Ready Search Request Model

Although the first release exposes one selected field at a time, avoid designing the backend so it can never support compound queries.

Preferred conceptual model:

```ts
type MediaType =
  | "film"
  | "series";

type SearchFilter = {
  field: QueryField;
  operator: SearchOperator;
  value: string | number | string[] | number[];
  entityId?: string;
};

type LibrarySearchRequest = {
  mediaType: MediaType;
  filters: SearchFilter[];
  logic: "and" | "or";
  page?: number;
  pageSize?: number;
  sort?: SearchSort;
};
```

For the initial release, the frontend may send one filter:

```json
{
  "mediaType": "film",
  "filters": [
    {
      "field": "director",
      "operator": "contains",
      "value": "Steven Spielberg"
    }
  ],
  "logic": "and"
}
```

The existing query-string API may remain if it is more consistent with the codebase.

However, internal query construction should use a filter collection or equivalent extensible representation.

---

# 15. Query Construction and Security

All database search operations must use:

- Parameterized queries
- Existing ORM methods
- Existing query-builder methods
- Safely bound raw-query parameters where raw SQL is genuinely necessary

Never interpolate user input directly into SQL.

Avoid:

- N+1 queries
- Duplicate media results
- Unbounded result sets
- Loading all credits into application memory
- Searching raw JSON for every request
- Provider calls during normal local search

Use indexed joins or `EXISTS` conditions where appropriate.

A media item must appear only once even when:

- Multiple matching cast members exist
- One person has several matching crew roles
- Multiple alternative titles match
- Multiple studios match

Preserve stable pagination.

---

# 16. Database Indexing

Inspect real query plans before adding indexes.

Potential indexes may include:

```text
people.normalized_name
media_people_credits.media_item_id
media_people_credits.person_id
media_people_credits.normalized_role
media_people_credits.credit_type
media_people_credits.billing_order
media_people_credits.is_starring
studios.normalized_name
networks.normalized_name
collections.normalized_name
media_items.release_year
media_items.first_air_year
media_alternative_titles.normalized_title
```

For PostgreSQL, assess whether existing project conventions support:

- `pg_trgm`
- Full-text search
- Generated normalized columns
- Expression indexes
- GIN indexes
- GiST indexes

Do not install database extensions without checking deployment and migration compatibility.

Follow existing index naming conventions.

---

# 17. User Interface

Place the query selector at the far-right side of the current search bar.

Conceptual design:

```text
[ Search your films…                             ][ Title ▾ ]
```

The selector must visually belong to the search control.

It must:

- Default to Title
- Display the selected field
- Use the existing Archivist tree-style dropdown
- Use non-selectable group headings
- Use selectable child items
- Show the current selection
- Close after selection
- Support mouse interaction
- Support keyboard interaction
- Restore focus correctly
- Match existing spacing
- Match existing typography
- Match existing borders
- Match existing corner radius
- Match existing shadows
- Match existing animations
- Match existing iconography
- Remain usable on narrow screens
- Include correct ARIA labels
- Avoid making the search bar excessively wide

Do not introduce a new visual system.

---

# 18. Contextual Search Placeholders

Update the search placeholder based on the selected field.

Examples for Films:

```text
Title
Search film titles…

Original Title
Search original film titles…

Genre
Search films by genre…

Starring
Search films starring a person…

Supporting Cast
Search films by supporting cast…

Director
Search films by director…

Writer
Search films by writer…

Composer
Search films by composer…

Studio
Search films by studio…

Collection
Search film collections…
```

Examples for Series:

```text
Title
Search series titles…

Creator
Search series by creator…

Starring
Search series starring a person…

Network
Search series by network…

Studio
Search series by studio…

Collection
Search series collections…
```

Keep copy concise and consistent with existing Archivist tone.

---

# 19. Selector State

The selected query field should persist while the user remains within the same library view.

Assess existing preference and URL-state patterns before deciding whether selection should persist across sessions.

Changing between Films and Series must:

- Retain the selected field when it remains valid
- Reset to Title when it is not valid for the destination media type

Examples:

```text
Films → Director
Series → Director
Result: retain Director
```

```text
Films → Cinematographer
Series
Result: reset to Title
```

Changing the selected query field must immediately rerun the current query when search text is already present.

An empty query must continue to show the unfiltered library.

---

# 20. People Autocomplete Readiness

A full person-picker is not required for the initial release unless Archivist already has a suitable autocomplete component.

The first release may support free-text people search.

However, design the request and state models so Archivist can later support exact-person resolution.

Future person suggestions may include:

```text
Person name
Profile image
Known-for department
Provider identifiers
Known-for titles
```

The query model should allow a future exact search such as:

```json
{
  "field": "director",
  "operator": "is",
  "value": "Steven Spielberg",
  "entityId": "archivist-person-id"
}
```

Do not permanently couple People search to unresolved display-name strings.

---

# 21. Result Relevance

Where an existing relevance system exists, use it.

Otherwise, for people searches, prioritize:

1. Exact normalized name
2. Prefix name match
3. Partial name match
4. Existing user-selected media sorting

Do not silently replace the user’s selected library sort with relevance ordering unless the UI communicates that behaviour.

Where duplicate names exist, return media connected to every matching person unless an exact person entity was selected.

---

# 22. Explainable Match Data

Design the backend result model so it can optionally explain why an item matched.

Conceptual result metadata:

```ts
type SearchMatch = {
  field: QueryField;
  label: string;
  matchedValue: string;
  entityId?: string;
};

type LibrarySearchResult = {
  item: MediaItemSummary;
  matches?: SearchMatch[];
};
```

Example:

```text
Matched Director: Steven Spielberg
Matched Starring: Tom Hanks
```

The initial UI does not have to display match reasons everywhere.

However, preserving match information will support:

- Natural-language search
- Compound filtering
- Remote discovery
- Search debugging
- Accessible result explanations

---

# 23. Performance Requirements

The feature must remain responsive for large libraries.

Requirements:

- Reuse the existing search debounce
- Do not call metadata providers during normal typing
- Do not produce N+1 database access
- Keep queries paginated
- Use indexed relationships
- Keep selector configuration static or cheaply derived
- Run backfills through the existing job system
- Keep metadata ingestion retryable
- Continue working when TMDB or TVDB is unavailable
- Avoid loading entire cast lists into frontend state

Measure representative query performance using seeded data.

Where the repository has benchmark conventions, add appropriate benchmarks.

At minimum inspect query performance for:

```text
Title
Alternative Title
Genre
Year
Starring
Any Cast
Director
Any Credit
Studio
Network
Collection
```

---

# 24. Testing Requirements

Add automated tests matching existing repository standards.

## 24.1 Backend Tests

Cover at minimum:

- Default title search
- Original-title search
- Alternative-title search
- Genre search
- Year search
- First-air-year search
- Decade normalization
- Keyword search
- Certification search
- Country search
- Original-language search
- Runtime search
- Series status search
- Film starring positions 1 through 5
- Film supporting cast positions 6 onward
- Any Cast
- Series aggregate starring classification
- Director
- Writer
- Creator
- Producer
- Executive Producer
- Composer
- Cinematographer
- Editor
- Any Credit
- Studio
- Series network
- Collection
- Duplicate person names
- One person with multiple roles
- Case-insensitive matching
- Partial matching
- Unicode names
- Punctuation normalization
- Media-field incompatibility validation
- Stable pagination
- No duplicate media items
- User and library scoping
- Search during provider outage
- Idempotent backfill
- Credit-role normalization
- Existing title-search backward compatibility

## 24.2 Frontend Tests

Cover at minimum:

- Selector appears on the right side of the search bar
- Correct Film tree renders
- Correct Series tree renders
- Title is selected by default
- Group headings are not selectable
- Child fields are selectable
- Selected state is displayed
- Placeholder changes correctly
- Existing text reruns after field change
- Invalid field resets when media type changes
- Empty query preserves unfiltered results
- Keyboard navigation
- Escape closes the selector
- Focus is returned appropriately
- Responsive layout
- Accessible labels
- Loading state
- Empty state
- Error state
- Existing search behaviour remains intact

## 24.3 Test Fixtures

Use realistic fixtures containing:

- A Film with at least ten cast members
- A Series with aggregate credits across several seasons
- One person credited as director and composer
- One person credited as writer and producer
- Two different people sharing the same name
- Unicode person names
- Multiple studios
- One or more networks
- A movie collection
- Alternative titles
- Keywords
- Multiple genres
- Provider IDs from more than one metadata provider

---

# 25. Database Migrations

Any migrations must:

- Follow existing migration conventions
- Be safe for existing installations
- Avoid deleting current metadata
- Include suitable indexes
- Include suitable uniqueness constraints
- Be reversible where required by the project
- Avoid unnecessarily blocking application startup
- Support incremental backfill
- Avoid requiring every existing media item to be refreshed synchronously

Do not perform uncontrolled metadata downloads inside a schema migration.

Schema migration and metadata backfill must remain separate concerns.

---

# 26. Documentation

Update relevant project documentation.

Document:

- Feature behaviour
- Query-field definitions
- Film starring rules
- Series aggregate-credit rules
- Crew-role mappings
- Metadata-source precedence
- Local-search architecture
- Database entities
- Database migrations
- Backfill process
- API parameters
- Validation rules
- Provider outage behaviour
- Performance considerations
- Future exact-person autocomplete
- Future compound-search support
- Future discovery-search support

Add code comments only where behaviour is not self-evident.

Do not narrate obvious implementation details.

---

# 27. Initial Non-Goals

Do not include the following in the first implementation unless the repository already supports them and integration is trivial:

- Natural-language query parsing
- Multiple simultaneous filters in the UI
- Boolean query-builder UI
- Remote internet discovery
- Adding remote results to the library
- Person biography pages
- Person-following
- Person notifications
- User-created collections
- Automatic franchise inference
- Facial recognition
- Credit editing
- New metadata-provider framework
- New job framework
- New design system
- LLM dependency for basic search

The architecture must leave room for these features without making them part of the initial implementation.

---

# 28. Proposed Future Extension: Compound Structured Search

This is a recommended follow-on feature.

It is not required for the first implementation.

Once Archivist supports a filter-array query model, the interface can allow multiple structured criteria.

Example:

```text
[Director: Steven Spielberg]
[Starring: Tom Hanks]
```

Equivalent query:

```json
{
  "mediaType": "film",
  "filters": [
    {
      "field": "director",
      "operator": "is",
      "value": "Steven Spielberg"
    },
    {
      "field": "starring",
      "operator": "is",
      "value": "Tom Hanks"
    }
  ],
  "logic": "and"
}
```

Potential UI behaviour:

```text
[ Director ] [ Steven Spielberg ] AND
[ Starring ] [ Tom Hanks ]
```

or:

```text
[Director: Steven Spielberg] [Starring: Tom Hanks] [+ Add filter]
```

Potential searches:

```text
Director is Steven Spielberg
AND
Starring is Tom Hanks
```

```text
Genre is Horror
AND
Decade is 1980s
```

```text
Writer is John Carpenter
AND
Director is John Carpenter
```

```text
Studio is Warner Bros.
AND
Year is 1999
```

The query engine should support this later without replacing the first-release field-aware search architecture.

---

# 29. Proposed Future Extension: Natural-Language Search

This is a recommended follow-on feature.

It is not required for the initial implementation.

Natural-language search should act as an input method that compiles into Archivist’s deterministic structured-filter model.

Example input:

```text
Films directed by Spielberg starring Tom Hanks
```

Parsed result:

```json
{
  "mediaType": "film",
  "filters": [
    {
      "field": "director",
      "operator": "is",
      "value": "Steven Spielberg"
    },
    {
      "field": "starring",
      "operator": "is",
      "value": "Tom Hanks"
    }
  ],
  "logic": "and"
}
```

Other viable examples:

```text
Horror films from the 1980s
```

```text
Films written and directed by John Carpenter
```

```text
Series created by Vince Gilligan
```

```text
Films starring Harrison Ford but not directed by Spielberg
```

```text
Warner Bros films from 1999
```

```text
Films with music by Hans Zimmer
```

```text
British crime series from the 2010s
```

The first parser should be constrained and deterministic.

It does not require an LLM.

Potential supported patterns:

```text
films directed by <person>
films starring <person>
films written by <person>
films produced by <person>
films with music by <person>
films from <year>
films from the <decade>
films by <studio>
series created by <person>
series on <network>
<genre> films from <year>
<genre> series from the <decade>
```

An LLM may later be used as an optional interpretation layer, but it must compile into validated structured filters before query execution.

Never execute unvalidated model-generated query instructions directly.

---

# 30. Proposed Future Extension: Search and Add to Archivist

## Status

This section is a product and architecture suggestion.

It requires further product decisions before implementation.

Do not fully implement this extension until the required decisions listed later in this section have been resolved.

## 30.1 Product Concept

Extend Archivist search so users can search both:

```text
My Library
Add to Archivist
```

The same intelligent search concepts would then support:

- Finding items already in the user’s library
- Discovering items not yet present
- Comparing local and remote results
- Adding remote results to Archivist
- Explaining why a remote item matched

Potential search-scope selector:

```text
Search Scope
├── My Library
├── Add to Archivist
└── Everywhere
```

Conceptual search bar:

```text
[ Search films…                   ][ Title ▾ ][ My Library ▾ ]
```

Recommended defaults:

- Library pages default to `My Library`
- Dedicated acquisition pages may default to `Add to Archivist`
- `Everywhere` combines local and remote results

## 30.2 Combined Results

A query such as:

```text
Films directed by Spielberg starring Tom Hanks
```

could display:

```text
MY LIBRARY

Saving Private Ryan
Catch Me If You Can

DISCOVER

The Terminal                         [Add]
Bridge of Spies                      [Add]
The Post                             [Add]
```

Remote and local results must be visually distinct.

A remote result already in the library must not appear as a separate addable duplicate.

Possible result states:

```text
Add to Archivist
Already in Library
Already Monitored
Pending
Acquiring
Unavailable
```

Use Archivist’s real existing states and terminology after inspecting the repository.

## 30.3 Local Versus Remote Search

Local-library search must continue to use Archivist’s indexed database.

Remote discovery must use metadata-provider adapters.

Conceptual flow:

```text
Structured Archivist query
              ↓
Discovery query planner
              ↓
TMDB / TVDB / provider adapters
              ↓
Normalized discovery candidates
              ↓
Deduplication against local library
              ↓
Search results
```

Do not send raw natural-language sentences directly to each provider and hope for equivalent behaviour.

Archivist must first convert the user’s intent into structured filters.

## 30.4 Provider Query Strategy

Remote providers may not support every Archivist field directly.

The discovery layer must therefore support query planning.

Example:

```text
Director: Steven Spielberg
Starring: Tom Hanks
```

A valid provider strategy may be:

1. Resolve Steven Spielberg to a provider person ID.
2. Resolve Tom Hanks to a provider person ID.
3. Fetch Films associated with Spielberg as crew.
4. Fetch Films associated with Hanks as cast.
5. Intersect the provider result sets.
6. Hydrate final media details.
7. Deduplicate against the local library.
8. Return normalized Archivist discovery results.

Do not assume one provider endpoint supports every compound combination.

The query planner must declare unsupported conditions instead of silently ignoring them.

## 30.5 Search Scope Support Matrix

Not every field will apply equally to local and remote search.

Conceptual support matrix:

| Field | My Library | Add to Archivist |
|---|---:|---:|
| Title | Yes | Yes |
| Original Title | Yes | Provider-dependent |
| Alternative Title | Yes | Provider-dependent |
| Genre | Yes | Yes |
| Year | Yes | Yes |
| Decade | Yes | Yes |
| Starring | Yes | Yes |
| Any Cast | Yes | Yes |
| Director | Yes | Yes |
| Writer | Yes | Usually |
| Producer | Yes | Provider-dependent |
| Composer | Yes | Provider-dependent |
| Studio | Yes | Yes |
| Network | Yes | Yes for Series |
| Collection | Yes | Yes for Films |
| Custom Archivist Tags | Yes | No |
| File Codec | Yes | No |
| Resolution | Yes | No |
| Acquisition Status | Yes | No |

The actual matrix must be determined from provider adapters and product requirements.

Unsupported fields must be:

- Hidden
- Disabled with explanation
- Explicitly rejected

Do not silently reinterpret an unsupported field as Title.

## 30.6 Discovery Result Model

Use a normalized result model rather than leaking TMDB or TVDB payloads into the UI.

Conceptual model:

```ts
type SearchScope =
  | "library"
  | "discovery"
  | "all";

type DiscoverySearchResult = {
  source: "discovery";
  mediaType: "film" | "series";

  canonicalId?: string;

  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;

  title: string;
  originalTitle?: string;
  year?: number;

  overview?: string;
  posterUrl?: string;
  backdropUrl?: string;

  matchedFields: SearchMatch[];

  libraryState:
    | "not_added"
    | "in_library"
    | "monitored"
    | "pending"
    | "acquiring"
    | "unavailable";

  providerSources: MetadataProvider[];
};
```

Adapt this to the existing Archivist domain model.

## 30.7 Duplicate Detection

Deduplicate remote candidates against existing Archivist items using provider identifiers first.

Preferred matching order:

1. Internal canonical media ID
2. TMDB ID
3. TVDB ID
4. IMDb ID
5. Other reliable provider identifiers
6. Normalized title and year as a fallback

Do not deduplicate using title alone.

Handle provider conflicts explicitly.

A remote discovery card should clearly show when the item is already present.

## 30.8 Add-to-Library Workflow

Selecting `Add to Archivist` must use Archivist’s existing acquisition or monitoring workflow.

Do not create a separate add process.

A possible one-click model:

```text
[ Add ] [ More options ]
```

Potential behaviour:

- `Add` uses saved defaults.
- `More options` opens acquisition configuration.

Possible configuration fields may include:

- Library
- Root folder
- Quality profile
- Language profile
- Monitoring policy
- Search immediately
- Acquisition provider
- Version or edition rules
- Tags
- Upgrade policy

The actual options must be derived from the existing Archivist architecture and product decisions.

## 30.9 Required Product Input

Before implementing remote discovery and adding items, obtain decisions on the following:

### Search Placement

- Should remote discovery appear directly inside Film and Series library pages?
- Should it have a dedicated Discover page?
- Should both entry points exist?
- Should remote results appear automatically below local results?
- Should the user explicitly select `Add to Archivist`?

### Default Search Scope

- Should library pages default to `My Library`?
- Should Archivist remember the last selected scope?
- Should `Everywhere` be available from the first release?

### Result Presentation

- Separate Local and Discover sections?
- One blended result list?
- Dedicated tabs?
- Should already-owned items be hidden or labelled?

### Add Behaviour

- Should Add be one-click?
- Should Add always open a configuration modal?
- Should one-click Add use a default profile?
- What happens when no default profile exists?

### Acquisition Defaults

- Default root folder
- Default quality profile
- Default language profile
- Default monitoring policy
- Whether acquisition begins immediately
- Whether the item is only added and monitored
- Whether missing defaults block addition

### Series Behaviour

- Add the full Series?
- Select seasons before adding?
- Monitor future seasons automatically?
- Allow individual season acquisition?
- Handle specials by default?

### Duplicate Handling

- What should happen when the item exists but is unmonitored?
- What should happen when another provider ID conflicts?
- What should happen when the title exists under a different edition?
- How should remakes with the same title be handled?

### Metadata Provider Priority

- Should Film discovery use TMDB first?
- Should Series discovery use TVDB first?
- Should results combine providers?
- Which provider is authoritative for matching?
- How should conflicting metadata be displayed?

### Unsupported Queries

- Should unsupported remote fields be hidden?
- Disabled?
- Shown with an explanation?
- Should Archivist fall back to a broader search?
- Should partial provider support be allowed?

### Search Result Detail

- Poster
- Year
- Overview
- Runtime
- Genres
- Director
- Starring cast
- Studio
- Collection
- Provider source
- Match explanation

### Permissions

- Can all users add items?
- Are requests sent for approval?
- Are some libraries read-only?
- Is remote discovery visible to users without add permission?

### Request Workflow

- Is there a request-and-approval state?
- Who can approve?
- Can duplicates be requested?
- Are request limits required?

Do not infer these answers.

Document unresolved decisions and pause the remote-add implementation until they are supplied.

---

# 31. Recommended Delivery Phases

Implement the feature in controlled phases.

## Phase 1: Local Field-Aware Search

Deliver:

- Query-field selector
- Title search
- Film and Series metadata fields
- People search
- Studio and network search
- Collection search
- Metadata normalization
- Existing-library backfill
- Indexed local queries
- Tests and documentation

## Phase 2: Compound Search

Deliver:

- Multiple filters
- Filter chips
- `AND` logic
- Optional `OR` logic
- Match explanations
- Exact person selection

## Phase 3: Natural-Language Interpretation

Deliver:

- Deterministic parser
- Query preview
- Structured-filter compilation
- Ambiguity handling
- Validation
- Optional LLM interpretation only as a secondary layer

## Phase 4: Remote Discovery

After product input is resolved, deliver:

- Search scopes
- Discovery query planner
- Provider entity resolution
- Remote result normalization
- Local deduplication
- Unsupported-field handling

## Phase 5: Add to Archivist

After acquisition behaviour is resolved, deliver:

- Add action
- Default add configuration
- Advanced add options
- Permission handling
- Request states
- Acquisition integration
- Progress and error states

Do not combine every phase into one uncontrolled implementation.

---

# 32. Acceptance Criteria for Initial Implementation

The initial field-aware library-search implementation is complete when:

1. Film and Series library search bars contain the tree-style query selector.
2. The selector is positioned on the far-right side of the search control.
3. Title is selected by default.
4. Existing title-search behaviour remains functional.
5. Film-specific fields appear only for Films.
6. Series-specific fields appear only for Series.
7. Users can search by starring cast.
8. Users can search by supporting cast.
9. Users can search by any cast member.
10. Users can search supported crew roles.
11. Film starring classification uses the first five billed cast credits.
12. Series starring classification uses deterministic aggregate credits.
13. Studio search works.
14. Series network search works.
15. Genre search works.
16. Year and decade searches work.
17. Collection search works where collection data exists.
18. Search uses normalized local metadata.
19. Normal local search does not call TMDB or TVDB.
20. Existing items can be safely backfilled.
21. Backfill is idempotent and restartable.
22. Queries remain scoped and paginated.
23. No duplicate media results appear from joined metadata.
24. Search remains functional during metadata-provider outages.
25. Invalid media-field combinations are rejected clearly.
26. Existing unrelated library functionality remains intact.
27. Automated tests pass.
28. Linting passes.
29. Type checking passes.
30. Database migration validation passes.
31. Production build passes.
32. Documentation is updated.
33. Future compound search remains architecturally possible.
34. Future natural-language parsing remains architecturally possible.
35. Future remote discovery remains architecturally possible.
36. Remote discovery is not implemented without the required product decisions.

---

# 33. Implementation Discipline

Work in small, coherent changes.

Do not mix unrelated refactoring into the feature.

After implementation:

1. Run the repository formatter.
2. Run linting.
3. Run type checking.
4. Validate database migrations.
5. Run backend tests.
6. Run frontend tests.
7. Run integration tests where available.
8. Run the production build.
9. Inspect database query plans where practical.
10. Review the final diff for unrelated changes.

Report:

- Architecture discovered
- Existing search behaviour found
- Files changed
- Schema changes
- Indexes added
- Metadata-provider changes
- Role-normalization approach
- Series cast-ranking approach
- Backfill mechanism
- Search-query strategy
- Tests added
- Commands executed
- Commands that failed
- Known limitations
- Unresolved product questions
- Recommended next phase

Do not claim that any command passed unless it was executed successfully.

Do not leave:

- Placeholder implementations
- Mocked production behaviour
- Disabled tests
- Broad unexplained `any` types
- Unchecked migrations
- Silent fallbacks
- Unexplained TODO comments
- Provider-specific models leaking through the application
- Search-time remote API dependencies for local search
