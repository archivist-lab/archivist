# Mobile & Remote Specification: The "Tour Guide" Experience

> **Architect's Foreword:**
> A media manager's success is determined by its accessibility. If a user sees a trailer in a cinema and cannot "Request" it before the lights go down, the system has failed. The Archivist Mobile App is not just a dashboard; it is a **Remote Control for the Museum**.

---

## 1. Core Philosophy: "Single-Handed Control"

The mobile interface is optimized for rapid, high-impact actions:
- **The 5-Second Search:** From app-open to "Monitored" should take less than 5 seconds.
- **Contextual Actions:** Swipe gestures for "Search Now," "Pause Download," or "Approve Request."
- **Performance:** Instant scrolling across 10,000+ item libraries using virtualized lists and aggressive image caching.

---

## 2. Functional Requirements

### 2.1. Library Management
- **Universal Search:** Search across all media types (Films, TV, Music, Books, Games) from a single bar.
- **Batch Editing:** Select multiple items to move paths, change quality tiers, or delete.
- **Real-time Status:** Live progress bars for active downloads, restores, or transcodes.

### 2.2. Download Orchestration (The "Loading Dock")
- **Manual Grab:** View all releases for an item and manually pick a specific torrent/nzb based on size, group, or peer count.
- **Queue Control:** Pause/Resume/Cancel downloads across all connected clients (Transmission, qBit, etc.).

### 2.3. The "Request Room"
- **Approve/Deny:** Push notifications for admin users to approve Patron requests with a single tap.
- **Feedback Loop:** Patrons receive a notification when their request is "Vaulted" and ready to watch.

---

## 3. Connectivity & Edge Logic

### 3.1. Smart-Switching Networking
- **SSID Awareness:** Automatically switch to the internal IP when on home Wi-Fi and the Reverse Proxy URL (or VPN) when on cellular.
- **Wake-on-LAN (WOL):** Ability to wake the Archivist server directly from the mobile app if it is powered down.

### 3.2. Offline Capability
- **Queued Requests:** If the user is on a plane or in a dead-zone, requests are queued locally and synchronized the moment a connection is restored.
- **Cached Library:** View the "Recent Additions" list even when offline.

---

## 4. Platform Integration

- **Widgets:** Home-screen widgets for "Now Downloading" and "Recently Added."
- **Deep Linking:** Clicking an IMDb or Goodreads link in a browser offers an "Add to Archivist" option.
- **Sharing Extensions:** Share a URL from YouTube or a News app directly to Archivist to "Monitor" the mentioned media.

---

## 5. Security & Biometrics

- **Biometric Lock:** Optional FaceID/TouchID/Fingerprint lock to prevent unauthorized access to the "Director" controls.
- **Scoped Login:** Ability to log in as a "Patron" (requests only) to prevent accidental system misconfiguration.
