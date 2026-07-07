# 🏛️ Films Migration Strategy: Deconstructing the Monolith

**Author:** Principal Software Architect
**Date:** May 2026
**Target:** `src/modules/films/*` -> Domain-Driven Departments
**Goal:** Dismantle the 1000+ line `films/routes.ts` monolith and distribute its logic across the strict bounded contexts defined in the V2 Architecture Blueprint (The Museum Metaphor).

---

## 1. Executive Summary & The Core Problem

Currently, `src/modules/films/routes.ts` is an architectural bottleneck. It acts as a God Object, simultaneously handling:
*   HTTP request parsing and routing (Galleries).
*   External API calls to TMDB (Appraisal).
*   Tracker scraping and YAML indexer execution (Acquisitions).
*   Database CRUD operations and SQLite queries (Vault).
*   File system operations and path mapping (Vault/Restoration).

This violates **Modular Purity** and makes the code brittle, difficult to test, and impossible to scale across other media types without massive duplication.

**The Directive:** We will not "rewrite" the logic; we will **relocate and encapsulate** it. The Films domain will transition from a *vertical slice* (where everything happens in one file) to a *flow through the Museum's departments*.

---

## 2. Departmental Mapping (Where Does It Go?)

Here is exactly how the current `films` folder will be distributed:

### 🖼️ The Galleries (API Boundary)
*   **Current:** Top half of `routes.ts` (e.g., `router.get('/films')`).
*   **Target:** `src/galleries/films.routes.ts`
*   **Responsibility:** Only handle HTTP requests, validate input using Zod, and dispatch commands or queries to the internal Event Bus or direct Department services. **No raw SQL here. No Axios calls.**

### 🗄️ The Vault (Storage & Persistence)
*   **Current:** `db.ts` and all `db.prepare('SELECT/INSERT...')` lines in `routes.ts`.
*   **Target:** `src/vault/films.repository.ts` and `src/vault/media-organizer.ts`
*   **Responsibility:** Pure database access (the repository pattern). Atomic hardlinking, folder creation (`ensureFilmFolder`), and disk state management. It receives highly typed domain objects and persists them.

### 📡 Acquisitions (Sourcing)
*   **Current:** `searchViaIndexers` calls, scoring logic, and `autoGrab` routes inside `routes.ts`.
*   **Target:** `src/acquisitions/films.sourcer.ts`
*   **Responsibility:** Reaching out to Torznab/Cardigann, receiving raw torrents, and applying the `scoreRelease` logic to return highly typed `Leads`.

### 🔍 Appraisal (Identification)
*   **Current:** `tmdb.ts`, `searchMovies`, and title matching logic.
*   **Target:** `src/appraisal/films.appraiser.ts`
*   **Responsibility:** Connecting to TMDB, parsing raw torrent names (e.g., "The.Matrix.1999.1080p"), and returning an `AppraisedArtifact`.

### 🛠️ Restoration (Processing)
*   **Current:** Any post-download file checking or FFmpeg metadata commands (currently scattered).
*   **Target:** `src/restoration/track-cleaner.ts`
*   **Responsibility:** Strictly for post-processing the file once Intake signals it has arrived.

---

## 3. Migration Checklist (Phase 1: Encapsulation)

Do not attempt to do this all at once. Follow this strict sequence to ensure the system remains bootable during the refactor.

### Phase 1A: Establish Boundaries (The Vault)
- [ ] Create `src/vault/repositories/films.repository.ts`.
- [ ] Move all raw `better-sqlite3` queries from `films/routes.ts` into strongly-typed methods in `films.repository.ts` (e.g., `getAllFilms()`, `getFilmById(id)`, `updateFilmStatus(id, status)`).
- [ ] Refactor `films/routes.ts` to instantiate the repository and call these methods instead of writing SQL inline.
- [ ] Move `db.ts` schemas into `src/vault/schemas/films.schema.ts`.

### Phase 1B: Isolate Appraisal (TMDB)
- [ ] Create `src/appraisal/tmdb.client.ts` and `src/appraisal/films.appraiser.ts`.
- [ ] Move the contents of `src/modules/films/tmdb.ts` into the Appraisal department.
- [ ] Ensure all external API calls have strict timeout limits and error handling.
- [ ] Update `films/routes.ts` to use the new Appraisal service.

### Phase 1C: Extract Acquisitions (Sourcing)
- [ ] Create `src/acquisitions/films.sourcer.ts`.
- [ ] Extract the `autoGrab` logic, indexer searching, and `scoreRelease` implementations out of `routes.ts`.
- [ ] Define an interface `SourcingResult` that returns `Leads`, totally agnostic of how the HTTP route will format the response.

### Phase 1D: The API Diet (Galleries)
- [ ] Create `src/galleries/films.routes.ts`.
- [ ] Move the now-lightweight routing logic from `src/modules/films/routes.ts` to the Galleries.
- [ ] Delete `src/modules/films/routes.ts`.
- [ ] Implement strict `zod` schema validation for every incoming request body in the Galleries layer.

---

## 4. Shared vs. Core Functions

During migration, you will encounter functions that seem like they belong everywhere. Here is the strict heuristic for resolving them:

*   **`scoreRelease` / Quality Rules:** Belongs in **Appraisal** or **Acquisitions**. The Vault does not care about "1080p" vs "4K". It only stores what it is told to store.
*   **File Path Manipulation (`mapRemotePath`, `ensureFilmFolder`):** Strictly belongs in **The Vault**. The Galleries should never know physical disk paths; they only ask for stream URLs or logical IDs.
*   **Torrent Client Communication (`sendToDownloadClient`):** Strictly belongs in **Intake**. Sourcing finds the magnet link and hands it off. Intake handles the qBittorrent/Transmission API.
*   **Database Connections (`getSharedDb`):** Belongs purely in infrastructure bootstrapping. Only **The Vault** repositories receive database instances via Dependency Injection.

---

## 5. Architectural Directives & Rules of Engagement

As you execute this migration, adhere to the following Absolute Directives:

1.  **No Leaky Abstractions:** A database row is not a Domain Object. When The Vault queries SQLite, it must map that row `Record<string, unknown>` into a strictly typed interface (e.g., `Exhibit`) before handing it back to the Galleries.
2.  **Event-Driven Thinking:** If a film is added, the API should not directly call the Sourcing department to find a torrent. The API should tell the Vault to add the film as "Wanted", and emit an `ExhibitAddedEvent`. The **Curator** (Event Bus) listens to this and orchestrates the Sourcing.
3.  **Dependency Injection:** Stop importing `getDb()` directly inside route closures. Pass the database instance into your Repositories, and pass your Repositories into your Route Controllers.
4.  **Zero-Trust Boundaries:** Assume the UI will send garbage data. Zod schemas must sit at the edge of the Galleries and validate everything before it touches the Domain.
5.  **Ruthless Deletion:** As you move logic, you will find duplicate code or legacy fallback hacks. If it violates the Type Safety or Determinism tenets outlined in `ARCHITECTURE.md`, delete it and write it correctly in its new home.

---
*“A system's architecture is defined by its boundaries. Build strong walls, and the logic inside will flourish.”*
