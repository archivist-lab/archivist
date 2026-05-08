# 🏛️ Archivist
🏛️ Archivist
Archivist is a next-generation, self-hosted media management suite designed to treat your digital library like a curated Digital Museum.
Unlike traditional tools that rely on external download clients, Archivist features a native, built-in torrent engine and a modular architecture that manages all your media—Films, Series, Music, Books, Comics, and Games—in one unified interface.

🌟 The Philosophy: The Digital Museum
Archivist is built on the Museum Metaphor. Instead of a simple file organizer, the system is divided into specialized "Departments":
·	Acquisitions (Sourcing): Native Cardigann YAML execution to find high-quality leads.
·	Intake (Loading Dock): High-speed, native BitTorrent engine for in-house downloads.
·	Restoration (Conservation Lab): Automated FFmpeg track cleaning and metadata refinement.
·	Vault (Archives): Atomic hardlinking and structured storage for long-term preservation.
·	Galleries (Exhibition): A stunning, cyberpunk-inspired UI for browsing your collection.

🚀 Key Features
·	Multi-Media Support: Dedicated workflows for Films, Series, Music, Books, Comics, and Games.
·	Embedded Torrent Engine: Powered by @torrentstack—no external clients required.
·	Automated Track Cleaning: Strips unwanted audio dubs and subtitles automatically using FFmpeg.
·	Omni-Search: Query TMDB, TVDB, IGDB, and ComicVine simultaneously.
·	Smart Lexical Parsing: Accurate identification of titles and quality without fragile regex.
·	Real-Time Telemetry: Live hardware metrics and download progress via Server-Sent Events (SSE).

🛠️ Technology Stack
·	Backend: Node.js, Express, TypeScript
·	Frontend: React, Vite, Tailwind CSS, TanStack Query
·	Database: SQLite (WAL Mode) with Better-SQLite3
·	Media Processing: FFmpeg & ffprobe
·	Validation: Zod (Type-safe schema validation)

🏗️ Project Structure
archivist/
├── client/          # React frontend (The Galleries)
├── src/             # Backend source code
│   ├── modules/     # Domain-specific logic (Acquisitions, Vault, etc.)
│   ├── services/    # Core system services (Torrent, Media Processor)
│   └── server.ts    # Application entry point
├── data/            # SQLite DBs, Torrents, and App state
└── media/           # Your organized media library


🚦 Getting Started
Prerequisites
·	Node.js (v20 or higher)
·	pnpm (preferred) or npm
·	FFmpeg (installed and available in your PATH)
Installation
1.	Clone the repository
2.	git clone https://github.com/your-username/archivist.git
cd archivist

3.	Install dependencies
4.	pnpm install

5.	Configure Environment
6.	cp .env.example .env
# Open .env and add your TMDB/TVDB/IGDB API keys

7.	Start Development Server
8.	pnpm run dev


🔄 Lifecycle of an Artifact
1.	Search: Find an Exhibit via Omni-Search.
2.	Grab: The Sourcing department finds the best Lead (torrent).
3.	Acquire: The Intake engine downloads the files to a staging area.
4.	Restore: FFmpeg strips unwanted tracks and fetches posters.
5.	Archive: The Vault hardlinks the cleaned file into your library.
6.	Display: The item appears in the Galleries, ready for viewing.

"A masterpiece of software engineering for the modern media hoarder."
