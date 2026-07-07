# Archivist V2 Migration Strategy: The "Great Migration" Blueprint

> **Architect's Foreword:**
> The biggest barrier to entry for the V2 "Mega App" is the "Sunk Cost" of existing setups. Users have spent years refining their Sonarr/Radarr/Lidarr databases. To succeed, Archivist must provide a "Zero-Effort" migration path that feels like an upgrade, not a rebuild.

---

## 1. The Universal Importer (The "Harvester")

Archivist ships with a specialized migration engine designed to ingest legacy formats with 100% fidelity.

### 1.1. Direct API Harvesting
- **Mechanism:** User provides the URL and API Key for their existing *arr instances.
- **Scope:** 
  - **Library Items:** Series, Movies, Artists, Books, etc.
  - **Monitoring Status:** Which items are wanted, unmonitored, or ended.
  - **Quality Profiles:** Mapping legacy "Any" or "1080p" profiles to Archivist's **Contextual Tiers**.
  - **History:** Import the last 30–90 days of grabs and failures to prevent immediate re-downloading of items that just failed.

### 1.2. Database Side-loading (Offline Mode)
- **Mechanism:** Direct parsing of `*.db` (SQLite) files from legacy installations.
- **Advantage:** Faster than API calls for large libraries (10k+ movies) and works even if the legacy app is no longer running.

---

## 2. Structural Mapping & Reconciliation

### 2.1. The "Ambiguity Resolver"
When importing from multiple sources, conflicts will arise. Archivist uses the following precedence:
1. **The Vault (Reality):** If the file is already on disk, that is the source of truth.
2. **Metadata Merging:** If Sonarr and Lidarr both track a "Cross-over" event differently, the **Curator** merges them into a single unified record.

### 2.2. Indexer & Download Client Porting
- **Prowlarr Integration:** If the user has Prowlarr, Archivist simply "inherits" the entire indexer set.
- **Native Client Takeover:** Migration of download client settings (Transmission, qBit, SABnzbd) to ensure the **Loading Dock** continues to function without interruption.

---

## 3. The "Silent Sync" Phase (Safe Adoption)

To prevent a "Search Storm" (where the new app immediately starts searching for thousands of missing items), Archivists adopts a phased rollout:
- **Phase 1: Metadata Only.** Build the library view without starting any searches.
- **Phase 2: The "Difference Report".** Show the user what Archivist would do differently (e.g., "I found 50 items you're missing that Sonarr missed").
- **Phase 3: Gradual Monitoring.** Enable monitoring in batches or "By Domain" (e.g., "Migrate my Music first, then my Films").

---

## 4. Cleanup & Legacy Decommissioning

### 4.1. "Sidecar" Mode
Archivist can run alongside existing apps, acting as a "Read-Only Observer" until the user is ready to flip the switch.

### 4.2. Hardlink Preservation
The migration engine ensures that existing hardlinks between the **Vault** and the **Loading Dock** are preserved, preventing data duplication or broken seed ratios.
