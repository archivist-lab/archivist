# 🏛️ Archivist
🏛️ Archivist
Archivist is a next-generation, self-hosted media management suite designed to treat your digital library like a curated Digital Museum. Unlike traditional tools that rely on external download clients, Archivist features a native, built-in torrent engine and a modular architecture that manages all your media—Films, Series, Music, Books, Comics, and Games—in one unified, high-performance interface.

🌟 The Philosophy: The Digital Museum
Archivist is built on the Museum Metaphor. Instead of a simple file organizer, the system is divided into specialized "Departments," each responsible for a specific stage of an artifact's lifecycle:
·	Sourcing (Acquisitions): Native Cardigann YAML execution and indexer bridges to find high-quality leads.
·	Loading Dock (Intake): High-speed, native BitTorrent engine that handles bytes and bandwidth without external dependencies.
·	Conservation Lab (Restoration): Automated FFmpeg track cleaning, subtitle scraping, and metadata refinement.
·	The Vault (Archives): Atomic hardlinking and structured storage to ensure your artifacts are preserved safely.
·	Exhibition Halls (Galleries): A stunning, cyberpunk-inspired UI for browsing and managing your collection.
🚀 Key Features
·	Multi-Media Supremacy: Dedicated workflows for Films, Series, Music, Books, Comics, and Games.
·	Embedded Torrent Power: Powered by a native core integration—no need for qBittorrent, Transmission, or Deluge.
·	Automated Track Cleaning: Automatically strips unwanted audio dubs and subtitle tracks using FFmpeg to save space and ensure a clean experience.
·	Omni-Search: A unified search interface that queries TMDB, TVDB, IGDB, and ComicVine simultaneously.
·	Smart Lexical Parsing: A custom contextual lexer that accurately identifies titles, years, and quality without fragile regex.
·	Real-Time Telemetry: Live hardware metrics and download progress streamed directly to the UI via Server-Sent Events (SSE).
🛠️ Technology Stack
Archivist is engineered for speed, type safety, and zero-friction deployment:
·	Backend: Node.js/Express (moving toward Bun + Hono)
·	Frontend: React, Vite, Tailwind CSS, TanStack Query
·	Database: SQLite (WAL Mode) with Better-SQLite3
·	Media Engine: FFmpeg & Native BitTorrent Bindings
·	Type Safety: 100% TypeScript with Zod schema validation
🏗️ Architecture Overview
archivist/
├── client/                 # React frontend (The Galleries)
├── src/
│   ├── modules/
│   │   ├── acquisitions/   # Tracker & Indexer logic
│   │   ├── intake/         # Torrent client & Download management
│   │   ├── appraisal/      # Metadata & Quality verification
│   │   ├── restoration/    # FFmpeg processing & Subtitles
│   │   └── vault/          # DB Persistence & File organization
│   └── server.ts           # Entry point
└── data/                   # SQLite DBs, Torrents, and Resume data

🚦 Getting Started
Prerequisites
·	Node.js (v20+)
·	pnpm (recommended)
·	FFmpeg (for media restoration features)
Installation
1.	Clone the repository:
2.	git clone https://github.com/your-username/archivist.git
cd archivist

3.	Install dependencies:
4.	pnpm install

5.	Set up your environment:
6.	cp .env.example .env
# Add your TMDB/TVDB/IGDB API keys

7.	Launch the application:
8.	pnpm run dev

🔄 Lifecycle of an Artifact
1.	Search: The user finds an Exhibit (e.g., a film) via Omni-Search.
2.	Grab: The Sourcing department finds the best Lead (torrent) on trackers.
3.	Acquire: The Intake engine downloads the files to a staging area.
4.	Restore: FFmpeg strips unwanted tracks and fetches local posters/subtitles.
5.	Archive: The Vault hardlinks the cleaned file into the permanent /media library.
6.	Display: The item appears in the Galleries, ready for viewing.

“A masterpiece of software engineering for the modern media hoarder.”

