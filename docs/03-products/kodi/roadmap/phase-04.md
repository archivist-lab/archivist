---
title: "Kodi media add-on — Phase 4.1 to 4.3"
document_type: plan
status: historical
classified: 2026-08-16
---
# Kodi media add-on — Phase 4.1 to 4.3

## Outcome

This delivery removes routine ZIP upgrades, makes the native Kodi mirror react to Archivist library changes and keeps the dynamic add-on browsable through temporary server outages. Kodi's periodic full reconciliation remains in place as a recovery mechanism.

## Repository and updates

`pnpm build:kodi` now builds both the video add-on and a standard Kodi repository. The publishable repository files live under `apps/kodi/repository/public`:

- `repository.archivist-1.0.0.zip` is the one-time repository installer.
- `plugin.video.archivist-<version>.zip` is the current client package.
- `addons.xml` describes both add-ons.
- `addons.xml.md5` is Kodi's repository checksum.

The repository URLs use the raw `main` branch of `archivist-lab/archivist`. Generated public artifacts must therefore be committed and pushed with each Kodi release. Once the repository is installed, Kodi discovers later versions through its normal add-on update flow.

## Durable library change feed

Database migration 17 adds `player_sync_changes` and triggers for films, film editions, series, seasons and episodes. Every insert, update or deletion advances a monotonic cursor, including changes made by import workers, metadata refresh jobs and administrative routes.

Kodi long-polls the authenticated `/api/v1/player/sync/changes` endpoint from a daemon thread. The server responds immediately when the cursor advances or returns a quiet response after the bounded wait. The Kodi service then downloads the authoritative manifest and runs the existing managed-library synchronizer.

The detected cursor is acknowledged only after synchronization succeeds. A failed manifest or Kodi library update retains the pending cursor and follows the existing bounded retry schedule, preventing lost notifications and request storms. The last acknowledged cursor is stored in `sync-status.json`.

## Recovery model

- Event-driven synchronization is enabled by default and can be disabled independently.
- The configured periodic synchronization remains authoritative and repairs missed events.
- A first connection or an unknown cursor causes a full synchronization.
- Native progress reconciliation remains on its existing lightweight schedule; playback updates do not trigger full library scans.
- Repair continues to modify only Archivist's marked managed-library tree.

## Offline browse cache

Kodi stores successful dynamic browse responses in a bounded, atomic last-known-good cache scoped to the configured Archivist server and Player profile. Films, series, seasons, continue watching, recently added, recommendations, collections and previously executed searches can therefore remain visible during a temporary network or server outage. The synchronized manifest is also accepted as a fallback source when native-library synchronization has populated it.

Offline fallback is enabled by default with a configurable 30-day retention period. Kodi displays a warning when cached data is being shown and exposes entry counts and cache dates through **Offline Cache Status**. Cached artwork remains available when an attempted refresh fails.

The cache does not contain credentials, media bytes or server filesystem paths. It never masks authentication, authorization, validation or missing-item responses. Playback, watched-state mutations, new searches and any screen without a matching cached response continue to require a reachable Archivist server.

## Acceptance criteria

- A film, edition, series, season or episode mutation advances the server cursor.
- An authenticated Kodi client detects the cursor without waiting for the periodic interval.
- The cursor advances locally only after a successful manifest application.
- Failed synchronization retries without losing the pending change.
- `pnpm build:kodi` emits valid add-on and repository ZIPs plus matching repository metadata.
- Kodi can update the video add-on after the repository has been installed once.
- A previously visited browse screen remains visible during a connectivity or server failure.
- Authentication errors are surfaced and never replaced by cached data.
- Cached responses are isolated by server and Player profile and expire according to the configured retention period.
- Expired artwork remains usable when its network refresh fails.
