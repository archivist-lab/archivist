---
# 🤖 AI SYSTEM PROMPT & ENGINEERING DIRECTIVES
> **ATTENTION AI AGENT:** You are operating as a **Principal Software Architect and Senior Engineer (160+ IQ)**. Your task is to execute a Greenfield rebuild of the "Archivist" application strictly following the blueprint below. 
> 
> ### Your Persona & Cognitive Directives
> 1. **360-Degree Vision:** Before writing any function, consider its impact across the entire stack. Anticipate edge cases, race conditions, and memory leaks before they occur. Do not write "naive" code.
> 2. **Ruthless Efficiency:** Write code that is mathematically sound and brutally fast. Avoid nested loops, unnecessary deep cloning, and heavy dependencies. Prioritize O(1) lookups and bitwise operations where applicable.
> 3. **Absolute Robustness:** Assume external systems (TMDB, torrent clients, file systems) will fail constantly. Every external call must have a timeout, a fallback, and a graceful failure path. Do not let one stalled HTTP request crash the event loop.
> 4. **Modular Purity:** Strictly adhere to the Domain-Driven Design outlined below. Do not bleed business logic into the API layer. Do not let database ORM types leak into the presentation layer. Use clear boundaries, interfaces, and Dependency Injection.
> 5. **Type Safety Absolutism:** Leverage TypeScript to its absolute limits. Define strict Zod schemas for all boundaries. Do not use `any`. If a state is impossible, make it unrepresentable in the type system.
> 
> **Your Goal:** Build a system that feels like a masterpiece of software engineering. It must be blindingly fast, infinitely maintainable, and mathematically beautiful. Read the blueprint below, absorb the Museum Metaphor, and execute with absolute precision.
---

# Archivist V2 Architecture Blueprint

## 1. Executive Summary & Architectural Tenets

**The North Star:** 
Archivist V2 is a Greenfield rebuild designed for absolute resilience, complete observability, and zero-friction extensibility. It aims to completely decouple business logic from framework choices, ensuring long-term maintainability.

**Core Principles:**
1. **Modular Monolith:** The system is divided into strict bounded contexts. Departments do not share databases directly; they communicate via well-defined interfaces and an internal Event Bus.
2. **Domain-Driven (The Museum Metaphor):** We use ubiquitous language based on a physical Museum to instantly clarify the exact responsibility of every module, class, and function.
3. **Interface-Driven Logistics:** External tools (qBittorrent, TMDB, Prowlarr) are treated as interchangeable plugins. The core domain knows nothing about their specific implementations.
4. **Type Safety & Determinism:** End-to-end type safety from the database to the UI. If it compiles, the domain contracts are respected.

---

## 2. Domain Boundaries (The Museum Metaphor)

Archivist is architected as a Digital Museum. The codebase is physically structured around these departments. Each department has a strict set of responsibilities and rules for how it interacts with the others.

### Glossary (Ubiquitous Language)
*   **Artifacts:** The actual physical media files (MKV, FLAC, CBZ, ISO).
*   **Exhibits:** The normalized metadata representation of the media (e.g., The TMDB entry for *The Matrix*).
*   **Leads:** A potential acquisition source (a magnet link or torrent file).

### The Departments (Bounded Contexts)

#### 1. `src/acquisitions` (The Sourcing Department)
*   **Responsibility:** Sourcing leads for missing exhibits.
*   **Domain:** Native Cardigann YAML Execution, Indexer bridges (Prowlarr, Jackett), RSS Firehose monitoring, targeted search algorithms, and Anti-Bot Circumvention.
*   **Architectural Rule:** This department knows nothing about files or TMDB metadata. It only knows how to talk to external trackers, run search queries, and return a standardized list of `Leads`.
*   **Self-Contained Sourcing (Native Cardigann):** While V2 supports Prowlarr and Jackett bridges, it does not rely on them as external crutches. The Sourcing department possesses a native execution engine capable of parsing and running industry-standard Cardigann YAML indexer definitions. This makes Archivist a fully self-contained proxy capable of scraping thousands of trackers directly.
*   **Cloudflare Bypass (FlareSolverr):** The Sourcing department natively integrates with a local FlareSolverr instance. This ensures that when querying private indexers hidden behind Cloudflare/DDoS protection, the department can transparently bypass captchas and return raw `.torrent` files or magnet links without failing.

#### 2. `src/intake` (The Loading Dock)
*   **Responsibility:** Transporting artifacts from the outside world into the facility.
*   **Domain:** Torrent client adapters (qBittorrent, Transmission), download progress tracking, bandwidth metrics, queue management, and Manual "Holding Pen" Imports.
*   **Architectural Rule:** Intake doesn't care what it is downloading. It only cares about bytes, bandwidth, and completion states. When a payload arrives, it emits an `ArtifactArrivedEvent`.
*   **Remote Path Mapping:** The Intake department natively supports cross-device remote path mapping. This allows the backend to run on a physically separate filesystem or Docker container from the Sidecar Torrent Engine, automatically rewriting incoming `/downloads` paths to `/data/torrents` before notifying the rest of the museum.
*   **Manual "Holding Pen" Imports:** Not all artifacts come from automated Indexers. The Loading Dock includes a specialized "Holding Pen" (watch folder). Users can drop physical files directly into this directory. The system scans the files and presents them in a UI queue, allowing the user to manually appraise them, assign an Edition label, and link them to a specific Exhibit in the Vault, completely bypassing the automated Sourcing department.

#### 3. `src/appraisal` (Authentication & Identification)
*   **Responsibility:** Inspecting incoming raw data, determining what it is, and verifying its quality against established profiles.
*   **Domain:** Torrent Name Parsers, Metadata lookups (TMDB/TVDB/IGDB), Quality Profiling (Tier, Resolution, Codec scoring).
*   **Architectural Rule:** The brain of the operation. It takes a raw string (e.g., `The.Matrix.1999.2160p.REMUX`), appraises it, and returns a strictly typed `AppraisedArtifact`. It rejects fakes, duplicates, or low-quality items based on the Curator's rules.

#### 4. `src/restoration` (The Conservation Laboratory)
*   **Responsibility:** Post-processing, refining, and repairing artifacts before they go on display.
*   **Domain:** Subtitle scraping (OpenSubtitles), File conversion/transcoding (FFmpeg, MKV to MP4), Audio normalization, fetching TMDB/TVDB posters and fanart, generating `.nfo` metadata files, and Automated Track Cleaning.
*   **Architectural Rule:** Restoration performs asynchronous, potentially long-running operations on an `AppraisedArtifact`. It must never block the main event loop. Upon completion, it emits a `RestorationCompleteEvent` indicating the artifact is pristine.
*   **Automated Track Cleaning & Metadata Safety:** Upon artifact arrival, Restoration utilizes `ffprobe` to analyze embedded audio and subtitle tracks. Based on user-defined language profiles and the Exhibit's TMDB origin language, it leverages `ffmpeg` (via fast stream-copying, no re-encoding) to violently strip unwanted foreign dubs and subtitle tracks, significantly reducing file size before final archiving. Crucially, V2 implements strict metadata safety: it explicitly extracts and counts chapters via `ffmetadata` before modifying the file. If the post-processing chapter count drops, the operation is aborted and the original file is preserved to prevent corruption.
*   **Semantic Subtitle Sourcing:** Subtitle scraping is not blind. The engine supports semantic filtering for "Forced Only" (foreign-parts-only) or "Hearing Impaired" sub-tracks to ensure perfectly tailored localization matches.
*   **Resource Sandboxing:** Because operations like `ffmpeg` track manipulation are heavily CPU-bound, the Restoration environment must be strictly sandboxed (e.g., via Docker `cpus: '0.80'` limits or OS-level niceness) to prevent transcoding tasks from starving the host OS or the main Node/Bun event loop.

#### 5. `src/vault` (Archives & Preservation)
*   **Responsibility:** Permanent, safe storage of the Artifacts, their Exhibit records, and localized assets.
*   **Domain:** Database ORM mappings, strict File System manipulation (moving files to `/media`), saving downloaded posters, fanart, and `.nfo` files directly alongside the media files in their respective item folders, and orphan cleanup.
*   **Architectural Rule:** **Only** The Vault is allowed to execute write operations to the database or move permanent physical files. Other departments must dispatch commands to The Vault to persist state.
*   **Atomic Hardlinking:** To preserve disk space and maintain seeding ratios for private trackers, The Vault strictly enforces atomic hardlinking (rather than deep copying) when migrating a finished artifact from the `Intake` temp folder to the final `/media` exhibition gallery.

#### 6. `src/galleries` (The Exhibition Halls)
*   **Responsibility:** Displaying the collection to the end-user.
*   **Domain:** The API layer (REST/tRPC/GraphQL), organizing and filtering data into Films, Series, Music, Books, Comics, and Games wings.
*   **Architectural Rule:** The Galleries are highly optimized, read-heavy boundary layers. They query The Vault to show what is currently on display, what is in transit, or what is missing.
*   **On-The-Fly Artifact Analysis (ffmetadata):** The Galleries do not just read database rows. When a user inspects an Exhibit, the API dynamically utilizes `ffmpeg -f ffmetadata` (rather than standard `ffprobe`) to extract perfectly timed chapters using exact `TIMEBASE` calculations, alongside standard stream probing, returning live data directly to the UI without permanently caching massive metadata structures in the DB.
*   **The Command Center (Global Dashboard & Telemetry):** The Galleries include a centralized telemetry module. It queries the host machine's live hardware metrics (CPU load, RAM, Disk usage) and seamlessly aggregates active downloads from *all* connected Sourcing engines (the internal Sidecar + any external qBittorrent/Transmission instances on the network) into a single, unified view.
*   **The Global Calendar:** The Dashboard features an aggregated chronological view of the entire museum. It scans all specialized Vaults (Films, Series, etc.) and presents a unified timeline of upcoming events—such as Theatrical, Digital, and Physical release dates for Films, and scheduled airdates for TV Episodes.
*   **Omni-Search (Unified Cross-Tab Dispatcher):** Because the museum features isolated wings (e.g., "Main Films" vs "4K Films"), the Galleries provide a universal Omni-Search interface. A user can search "Spider-Man" once, simultaneously querying TMDB, TVDB, IGDB, and ComicVine. Upon selecting a result, the dispatcher explicitly asks the user *which* specialized Library Tab the Exhibit should be injected into, routing the data dynamically across the boundary.
*   **API Gateway & Zero-Trust Security:** The Galleries operate as an API-first Headless server. All POST/PUT mutations pass through strict Zod schema validation, ensuring corrupted data cannot reach the core domain. Furthermore, the API employs strict Rate Limiting to prevent brute-force attacks and requires Bearer Token / API Key authentication, allowing the system to safely accept commands from authorized 3rd-party networks (like LunaSea or custom Discord bots) over the open internet.

#### 7. `src/curator` (The Director's Office / Orchestration)
*   **Responsibility:** Coordinating the entire museum's operations and lifecycle states.
*   **Domain:** The central Event Bus, Cron jobs, state machines, user settings, the "Missing Search" scheduler, chronological triggers (Calendar tracking for upcoming airdates), upgrade logic, and Data Integrity Scanning.
*   **Architectural Rule:** The Curator listens to the Museum. 
    *   *Example Flow:* Curator notices a missing exhibit -> Asks `Acquisitions` for Leads -> Hands best Lead to `Intake` -> Tells `Appraisal` to verify it upon arrival -> Sends to `Restoration` for subtitles -> Tells `Vault` to archive it -> `Galleries` updates the UI automatically.
*   **Data Integrity & Auto-Repair:** The Curator runs routine background audits across the entire museum. It scans for missing files, orphaned downloads, stale acquisitions, and broken symlinks/hardlinks. If it finds a discrepancy between the Vault's database and the physical file system, it generates a report and offers automated 1-click bulk repair solutions.

---

## 3. Technology Stack & Tooling Selection

To achieve maximum **speed, lightweightness, responsiveness, and flexibility**, the V2 stack completely avoids heavy enterprise frameworks and standalone infrastructure dependencies. It focuses on pure Type Safety and High-Performance Edge-Ready runtimes.

### 3.1. Backend Runtime & Framework
*   **Choice:** **Bun** (or Node.js) + **Hono**
*   **Rationale:** Bun provides an incredibly fast JavaScript/TypeScript runtime with no build step required. Hono is an ultra-fast, edge-ready web framework that natively supports Remote Procedure Calls (RPC). This ensures the backend remains incredibly lightweight while handling high-throughput API requests effortlessly.

### 3.2. Database & ORM (The Vault)
*   **Choice:** **SQLite** (WAL mode) + **Drizzle ORM**
*   **Rationale:**
    *   *SQLite:* Prevents the user from having to run and manage a separate PostgreSQL Docker container. When configured correctly with Write-Ahead Logging (WAL) and `PRAGMA synchronous=NORMAL`, SQLite easily handles thousands of concurrent read/writes—more than enough for a personal media archivist.
    *   *Drizzle ORM:* A modern, lightweight TypeScript ORM. Unlike Prisma (which requires a heavy Rust engine), Drizzle executes as pure SQL builders, giving us maximum performance, full schema control, and 100% end-to-end type safety.

### 3.3. Frontend (The Galleries)
*   **Choice:** **React** + **Vite** + **TanStack Query** + **Tailwind CSS**
*   **Rationale:**
    *   *Vite:* Lightning-fast builds and Hot Module Replacement (HMR) for optimal developer experience.
    *   *TanStack Query:* Provides aggressive client-side caching. When navigating between library tabs, data loads instantly from cache while re-validating in the background, yielding a native-app level of responsiveness.
    *   *Tailwind CSS:* Ensures consistent, utility-first styling without massive CSS bundle bloat.

### 3.4. Communication Protocol (The Paperwork)
*   **Choice:** **Hono RPC** (or tRPC)
*   **Rationale:** Replaces traditional, disconnected REST APIs. With RPC, the frontend directly imports the TypeScript types of the backend routes. If a database schema or API response changes, the frontend will immediately throw a compile-time error, preventing runtime bugs and drastically speeding up development.

### 3.5. Asynchronous Engine (The Curator's Event Bus)
*   **Choice:** **In-Memory Event Emitter** + **SQLite Job Queue**
*   **Rationale:** Archivist performs heavy asynchronous tasks (RSS firehose parsing, torrent downloads, metadata scraping). Instead of installing Redis for queues (which adds bloat), we use a simple Node.js/Bun `EventEmitter` for instant cross-department communication. To ensure tasks survive crashes, they are persisted to a lightweight `jobs` table in SQLite.

---

## 4. Data & State Architecture (The Vault Design)

Moving from V1 to V2 requires a significant shift in how we store data. In V1, databases were physically fragmented (`films.db`, `series.db`, etc.). In V2, we unify the storage engine while maintaining strict typing and schema cleanliness.

### 4.1. Single Database File
We will migrate to a **single `archivist.sqlite` file**. This allows us to execute cross-media transactions, create unified foreign keys (like tagging a user or a collection across different media types), and drastically reduces connection overhead.

### 4.2. Schema Strategy: Specialized Vaults (Strict Tables)
We explicitly reject the "Single Table Inheritance" pattern (where everything lives in one massive `exhibits` table). Putting Films, Books, and Games in one table leads to a messy schema where half the columns are null at any given time (e.g., a Book has no `video_resolution` column).

Instead, we use **Specialized Vaults**.
*   The `films` table strictly contains film data.
*   The `series` table strictly contains TV series data.
*   The `music` table strictly contains music album/track data.
*   The `podcasts` table strictly contains podcast data.
*   The `books` table strictly contains book data.
*   The `comics` table strictly contains comic data.
*   The `magazines` table strictly contains magazine data.
*   The `games` table strictly contains video game data.

**Why this matters:** This guarantees 100% type safety in Drizzle ORM. When you query the `films` table, TypeScript knows you are getting a `Film` object, not an abstract `Media` object that you have to type-cast.

### 4.3. Museum Wings (Multi-Library Support)
V1 supported infinite user-defined "Tabs" (e.g., separating "Main Films", "4K Films", and "Kids Films" into physical `films.db`, `films-4k.db` files). In the unified V2 Vault, this separation is achieved logically.
*   We introduce a top-level `libraries` table (e.g., `id: 1, name: "Kids Films", media_type: "films"`).
*   Every specialized media table (`films`, `series`, etc.) requires a strict `library_id` foreign key.
*   This achieves the Plex-style multi-library separation required by power users while maintaining the performance benefits of a single unified database file.
*   **The IO Mutex:** Because multiple logical libraries might be configured to use the same physical root folder (e.g., `/media/`), the Vault employs a strict, global IO Mutex. This prevents critical race conditions and file-locking conflicts (like `EBUSY` errors) if two isolated libraries attempt to organize or move files in the same directory concurrently.

### 4.4. The Unification Layer: "Compendiums" (Franchise Mapping)
To achieve the ability to group related items across different media wings (e.g., The MCU films + Marvel Comics + Spider-Man PS5 game + Official MCU Podcast), we introduce a unifying relational concept: **The Compendium**.

We create a top-level `compendiums` table (e.g., `id: 42`, `name: "The Marvel Cinematic Universe"`).
Each specialized table (`films`, `series`, `music`, `podcasts`, `books`, `comics`, `magazines`, `games`) will have an optional `compendium_id` foreign key.

**The Compromise Achieved:**
*   You retain beautifully strict, specialized tables for each media type.
*   You gain the ability to run a single query across multiple specialized tables (e.g., fetching from `films`, `comics`, and `podcasts` where `compendium_id = 42`) to instantly build a cross-media dashboard for a specific franchise or canon.

### 4.5. Hierarchical Media (The Series Problem)
Unlike Films which are generally a 1:1 Exhibit-to-Artifact relationship, other media types are hierarchical (e.g., Series -> Seasons -> Episodes, or Comics -> Volumes -> Issues).
*   **The Schema Strategy:** We map the hierarchy strictly in the database with cascading foreign keys (e.g., the `episodes` table has a `season_id` which has a `series_id`).
*   **The Parsing Strategy:** When `Appraisal` encounters a "Season Pack" or a grouped torrent, it does not create a single artifact. It disassembles the pack logically, associating the constituent files to their respective hierarchical Exhibits in the Vault.

### 4.6. Multi-Edition Support (Alternative Versions)
V1 had highly advanced logic to scan TMDB release notes and alternative titles for keywords (e.g., "Director's Cut", "Extended Edition", "Redux", "Workprint"). 
*   **The V2 Vault Implementation:** The Vault formally supports a `1:Many` relationship between an Exhibit and its Artifacts. The `artifacts` table has a `version_label` column.
*   **The Physical Vault:** Multiple artifacts can safely co-exist within a single Exhibit's directory (e.g., `/media/films/Blade Runner (1982)/Blade Runner (1982) (Theatrical).mkv` alongside `Blade Runner (1982) (Final Cut).mkv`). The UI `Galleries` allows the user to explicitly select which version they wish to play or manage.

### 4.7. State Synchronization (Real-Time UI)
To ensure the UI is instantly responsive (e.g., showing download progress without lag):
*   The `Intake` department emits progress events over the internal Event Bus.
*   The `Galleries` API layer subscribes to these events and pushes them to the frontend using **Server-Sent Events (SSE)**.
*   SSE is much lighter than WebSockets and natively supported by browsers. It allows the backend to stream updates to the TanStack Query cache, causing the UI to re-render smoothly and efficiently.

---

## 5. The Engine Room (Core Algorithms & State Machine)

The engine room is where the chaos of external data (torrents, raw text) is converted into perfectly categorized Museum Exhibits. This relies on two foundational systems: the Lexical Parsing Pipeline and the Strict Lifecycle State Machine.

### 5.1. The Lexical Parsing Pipeline (Replacing Regex)
Legacy systems (like Radarr/Sonarr) use hundreds of massive, fragile Regular Expressions to extract titles, years, and quality metadata from torrent names. This is computationally expensive and prone to catastrophic breakage.

Archivist V2 uses a **Contextual Lexer**. It treats a release name like a line of programming code:

1.  **Tokenization:** The string is split by delimiters (periods, spaces, brackets) into an array of `Tokens`. (e.g., `[1917, (2019), 1080p, BluRay]`)
2.  **Contextual Tagging:** Single-purpose taggers scan the array. 
    *   *The "1917" Defense:* The `YearTagger` doesn't blindly grab the first 4-digit number. It uses heuristics: it scans right-to-left (as years usually anchor the metadata), and prioritizes tokens inside parentheses. Thus, in `1917 (2019) [1080p]`, `(2019)` is confidently tagged as the Year, leaving `1917` safely as the Title.
    *   The `ResolutionTagger` and `CodecTagger` operate in complete isolation, making them easily unit-testable.
3.  **Title Extraction:** Any tokens remaining untagged at the start of the string are inherently the Title.
4.  **Verification (Fallback Strategy):** The parsed result is sent to the `Appraisal` department to verify against the source of truth (e.g., TMDB). If TMDB rejects the parsed data, the Lexer is instructed to execute a fallback parsing strategy (e.g., "Assume the first number was the title, not the year") and verify again.
5.  **User-Defined Edition Rules:** A custom rules engine sits atop the lexer, allowing users to define custom string patterns that map to specific editions (e.g., "Theatrical Cut", "Director's Cut"). This allows the parser to adapt to niche labeling without requiring source code modifications.

### 5.2. The Strict Lifecycle State Machine
In V2, an Exhibit must follow a strict, mathematically sound State Machine. An Exhibit can only exist in one state at a time and can only move via predefined transitions, ensuring the UI and database are never out of sync.

**The Defined States:**
*   **`Upcoming`:** Monitored, but the official airdate/release date is in the future. The Curator's chronological calendar trigger will flip this to `Wanted` on release day.
*   **`Wanted`:** The item is monitored, released, but no leads have been acquired.
*   **`Searching`:** The Curator is actively querying Indexers for leads.
*   **`Acquiring`:** A valid lead was found, and the Loading Dock (`Intake`) is actively downloading it.
*   **`Restoring`:** Download complete. The Conservation Lab (`Restoration`) is actively fetching subtitles, transcoding, or extracting metadata.
*   **`Collected`:** The item is perfectly preserved in The Vault and currently on display in the Galleries.
*   **`Rejected` / `Blacklisted`:** A manual or automated rejection of an acquired artifact. If the user marks a collected artifact as "Bad" (e.g., hardcoded subtitles, out-of-sync audio), it is deleted from the Vault, the specific release hash is permanently blacklisted, and the state reverts to `Wanted`.
*   **`Ignored`:** The user explicitly told the Curator not to source this item.

**Transitions & Resilience:**
State transitions are triggered by Events on the Event Bus. Crucially, the State Machine defines failure paths. For example, if a torrent stalls and triggers a `DownloadFailedEvent` while in the `Acquiring` state, the machine deterministically transitions the Exhibit back to `Wanted`, blacklists the failed lead, and waits for the next automated cycle.

### 5.3. Interactive Sourcing (Manual Overrides)
While the Curator automates the standard lifecycle, the architecture must support Manual Overrides (Interactive Searches). 
*   **The Flow:** The `Galleries` (UI) can dispatch an interactive search command directly to `Acquisitions`, bypassing the Curator's scheduled queues. `Acquisitions` streams the raw `Leads` and their live `Appraisal` scores back to the user interface.
*   **The Override:** The user can explicitly select a lead, manually injecting it into the `Intake` queue. This forces the State Machine into the `Acquiring` state, overriding automated quality profiling constraints for that specific action.

### 5.4. Manual Metadata Editing (Exhibit Plaque Correction)
While the `Appraisal` and `Restoration` departments automatically fetch metadata (TMDB/TVDB) and generate `.nfo` files, the system must absolutely respect human authority. 
*   **The Editor:** The `Galleries` (UI) will feature a Metadata Editor allowing users to manually correct an Exhibit's details (Title, Year, TMDB ID, custom poster URL, tags).
*   **Database Lock-In:** When a user manually edits metadata, the `Vault` flags those specific fields as "locked." This prevents automated background tasks or future TMDB refreshes from accidentally overwriting human corrections.
*   **Asset Syncing:** Saving manual edits immediately dispatches a command to the `Restoration` department to rewrite the local `.nfo` files alongside the media and download the newly specified custom posters/fanart, ensuring the physical file system perfectly reflects the new database state.

---

## 6. The Intake Engine (Native Core Integration)

A major sticking point in V1 was the performance of the embedded Node.js/JavaScript torrent engine (`@torrentstack/torrent-engine`). Node.js is fundamentally unsuited for the intense UDP traffic, memory mapping, and threaded disk I/O required to match the performance of native C/C++ torrent clients.

To guarantee performance identical to dedicated daemons (like Transmission or qBittorrent) while ensuring all functions are **fully built-in** to Archivist, V2 adopts the **Native Core Integration** pattern.

### 6.1. Embedded C++ Engine (Native Bindings)
Archivist V2 does not use a "Sidecar" external process. Instead, it embeds a battle-tested C++ BitTorrent engine (e.g., `libtorrent` or `libtransmission`) directly into the backend runtime using **Native Node/Bun Addons**.

**Architectural Benefit:** This allows the "Physics" of the swarm to run at C++ wire-speed, while the "Brain" remains 100% integrated within the Archivist codebase. There is no external RPC lag, no separate binary for the user to manage, and the UI has 1:1 parity with professional torrent clients.

### 6.2. Native Feature Parity
Because the engine is a core part of Archivist, the UI provides native, built-in control over every aspect of the download lifecycle:
*   **Sequential Downloading:** Native "stream-while-download" support for previewing media.
*   **Micro-Manageable Piece Selection:** Prioritizing specific files within a multi-file torrent.
*   **Dynamic Bandwidth Scheduling:** Scheduled throttling (Turtle Mode) and global/per-torrent limits.
*   **Ratio & Idle Management:** Automatically stopping or pausing torrents based on seeding ratio or inactivity.
*   **Permission Control (Umask):** The engine natively enforces file permissions, ensuring the Vault can always access artifacts.
*   **Network Binding (VPN Lock):** Native support for binding the engine to a specific network interface, providing a hardware-level kill-switch if a VPN drops.
*   **Native Incomplete Staging:** The engine utilizes a hidden staging directory for active downloads, ensuring that only 100% verified artifacts are visible to the Vault's organization logic.

### 6.3. Partial Downloads & "Wanted" Progress Calculation
Because torrents often contain unwanted "extra" files (e.g., sample videos, `.txt` files, executables), the Intake Engine supports sophisticated partial downloading.
*   **File Deselection:** Intake tells the native core to set the priority of unwanted files to `0` (Do Not Download).
*   **Advanced Piece Selection:** The engine is configured to prioritize in-progress blocks, highest priority files, and sequentially streamable blocks before finishing rare end-game pieces.
*   **Advanced Byte-Check (True Progress):** Progress reported to the UI is calculated *exclusively* against the "Wanted" bytes. If a 10GB torrent contains 2GB of extras, the UI will report 100% completion as soon as the 8GB of wanted files are finished, rather than stalling at 80%.

**Result:** Archivist V2 becomes a **Single-Process Powerhouse**. It is both the Media Manager and a world-class BitTorrent client, sharing the same memory space and state for maximum responsiveness and a unified "Built-In" user experience.

---

## 7. User Interface & The Transition Strategy

### 7.1. Design System & Thematic Guidelines
The visual identity of Archivist V1—its distinct, dark, cyberpunk/neon aesthetic—is a core defining feature. V2 will strictly preserve this exact visual aesthetic, including specific typography, color palettes, and structural DOM layouts.

**Typography:**
*   **Display / Headers:** `Bebas Neue` (Used for massive, tracking-widest section titles)
*   **Monospace / Data:** `JetBrains Mono` (Used for technical data, file paths, IDs, and secondary subtitles)
*   **Sans-serif / Body:** `DM Sans` (Used for standard readable text)

**The "Noir" Color Palette (Backgrounds & Surfaces):**
*   `noir-950`: `#0a0a0f` (The absolute base application background)
*   `noir-900`: `#111118` (Primary cards, sidebars, and elevated surfaces)
*   `noir-800`: `#1a1a24` (Secondary elevated surfaces and hover states)
*   `noir-700`: `#242430` (Borders and dividers)

**The Media Accent Palette (Neon Glows):**
Each Wing of the Museum utilizes a strictly enforced hex code for its buttons, glows, and active states:
*   **Films / System:** Cyan (`#00D4FF`)
*   **Series:** Violet (`#9B59B6`)
*   **Music:** Pink (`#FF2D78`)
*   **Books:** Yellow (`#F1C40F`)
*   **Comics:** Orange (`#E67E22`)
*   **Games:** Emerald (`#2ECC71`)

**Structural Layout:**
*   **Global DOM:** The application operates as a Single Page Application (SPA) with a fixed, app-wide base background (`bg-noir-950`).
*   **The Sidebar:** A fixed-position left navigation drawer. It maintains a stateful collapsed/expanded width (`w-16` collapsed, `w-52` expanded on desktop).
*   **Main Content:** The central viewing pane pushes right dynamically based on the sidebar's state (`ml-16` to `ml-52`), ensuring the content never slides under the navigation layer.

**Media Detail Page Layouts (The Exhibit View):**
V1 utilizes a very specific, cinematic layout for inspecting individual media items (Films, Series, etc.), constructed from reusable headless layout primitives:
*   **`DetailHeader`:** A massive, 600px tall hero section. It features the Exhibit's backdrop image stretched full width, heavily blurred (`blur-sm opacity-40`), and overlaid with a dark bottom-to-top gradient. The title, poster, and core metadata sit in the bottom-left corner of this gradient, creating an immersive, cinematic feel.
*   **`DetailPoster`:** A floating, heavily shadowed (`shadow-[0_0_50px_rgba(0,0,0,0.5)]`) poster image that sits within the hero header, slightly offset.
*   **`DetailMain`:** The core content area below the hero header. It follows a responsive `grid-cols-1 lg:grid-cols-3` layout. The left 2/3 is dedicated to primary content (Storyline, Cast, Editions, Seasons), while the right 1/3 acts as a sidebar for technical metadata (File size, Codec, Path, TMDB Links).
*   **`DetailMetaItem`:** Standardized key-value pairs (`text-white/20` for labels, accent color for values) to display technical metrics uniformly.

### 7.2. The UI Philosophy (Headless Architecture)
To ensure maximum speed, accessibility, and reusability, the frontend will adopt a **Headless Component System** (e.g., Radix UI or React Aria) styled with **Tailwind CSS**.
* **Accessibility & Behavior:** Headless libraries provide robust, unstyled behavioral primitives (focus management, keyboard navigation, ARIA roles).
* **Styling & Aesthetics:** Tailwind CSS applies the custom neon/cyberpunk aesthetics directly to these robust primitives, utilizing the custom configuration defined above.
* **Result:** Complex components (like custom dropdowns, comboboxes, and modals) will look exactly like V1 but will be infinitely more stable, accessible, and performant.
* **The Easter Egg:** V1's beloved Konami Code (`↑ ↑ ↓ ↓ ← → ← → B A enter`) listener will be preserved, ensuring the "you retro nerd" modal continues to surprise users, proving that robust architecture does not have to be soulless.

### 7.3. The Transition Strategy (Pure Greenfield)
Because V1 operated largely as a conceptual build/prototype without mission-critical historical data, V2 does not require a complex "Strangler Pattern" migration strategy.

* **No Data Porting Required:** The legacy, fragmented SQLite databases (e.g., `films.db`, `series.db`) will be discarded rather than migrated. 
* **Fresh Vault Initialization:** V2 will initialize the unified `archivist.sqlite` database from scratch, enforcing strict schemas from day one without the technical debt of legacy migrations.
* **Clean Slate:** This true Greenfield approach allows for maximum architectural purity, enabling rapid development of the Lexical Parsing Pipeline, Sidecar Intake Engine, and Unified Vault without worrying about backwards compatibility.