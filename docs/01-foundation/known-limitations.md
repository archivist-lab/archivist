---
title: Current limitations and documentation guardrails
document_type: reference
status: canonical
updated: 2026-08-22
evidence:
  - AGENT.md
  - apps/server/src/gateway.ts
  - apps/server/src/config.ts
  - deploy/install-bare-metal.sh
  - apps/control/src/ui/main.tsx
  - apps/server/src/modules/music/fanart.ts
  - apps/server/src/modules/music/routes.ts
  - client/src/modules/music/index.tsx
  - apps/server/src/indexers/endpoints/scoring.ts
---

# Current limitations and documentation guardrails

This register prevents desired or partially designed behavior from being mistaken for delivered capability.

## Known product/architecture limitations

- Control has no terminal, container management, disk format/mount workflow, SMB administration, or update engine.
- The host Control adapter manages only `archivist.service`; a Docker Engine adapter is future work.
- Bare-metal defaults are still split across `/opt`, `/var/lib`, `/srv`, and `/etc`; the unified `/archivist` hierarchy is accepted but not delivered.
- Preflight/install still reserve former Player/Catalogue ports even though production uses one application listener.
- Authentication has users/sessions/device/service principals but no roles or fine-grained authorization.
- The shared application listener removes the old network-level isolation of Player from administration APIs.
- Library does not yet run under a strict CSP because inline-style use has not been remediated.
- Catalogue’s legacy film schema and universal schema coexist; Catalogue is not the sole media database.
- Shared contracts are substantial but not universal, and there is no OpenAPI description.
- Root lint/typecheck scopes do not cover every app equivalently; Player/Catalogue rely on their own builds, and Control has separate tests.
- Provider/indexer integrations are conditional on credentials, site/API behavior, rate limits, definitions, mapping, and availability.
- Indexer endpoint failover cannot manufacture a healthy mirror: when every configured candidate is dead, definition-drifted, or rejecting credentials, the indexer is reported down rather than sending searches to a Tier D URL.
- Automatic acquisition attempts accepted matching releases; it cannot guarantee a release exists or remains downloadable.
- Exact release-time automation requires an absolute episode `air_at`; an air date alone is insufficient.
- File Browser access is constrained by Unix permissions even when the filesystem root is configured.
- Binary rollback does not roll back automatically applied SQLite migrations.
- No lyrics provider is integrated. `tracks.lyrics` is written by hand through the track
  editor and stamped `manual`; nothing fetches or synchronises lyrics.
- Album cover candidates come from Fanart.tv and the Cover Art Archive, both keyed by a
  MusicBrainz release-group id. An album created by a file scan rather than a provider
  lookup has no id, so its editor offers text fields but no artwork.
- The music "All Releases" sweep runs sequentially in the browser, not as a durable job.
  Leaving the artist page ends it; albums already grabbed continue, the remainder are
  skipped. This differs from film/series quick, deep, and auto searches, which survive
  navigation.
- MusicBrainz artist discovery still reads only the first 100 release groups. Track
  hydration now selects and persists a deterministic official release and its expected
  count, but there is no user-facing edition override or complete country/format/barcode
  policy yet.
- The unrated queue is built from playback completion, so it surfaces films and episodes
  only. Music can be rated on its pages but never appears as a nudge.

## Interpretation rules

- “Implemented” requires executable evidence in the current tree.
- “Accepted” means an architectural decision, not necessarily delivered packaging.
- “Draft” and “plan” describe possible future behavior.
- “Historical” records why or how the project evolved and cannot override canonical pages.
- Capability detection (for example SMART/Btrfs/ZFS) is not the same as operational control.
- A passing provider/indexer test is not a guarantee for all searches or feeds.
- UI labels and comments may lag behavior; verify routes, service code, schema, and tests.

Any resolved item should be removed or rewritten in the same change that delivers it. New limitations discovered during implementation belong here, with an evidence path.
