---
title: Archivist Control
document_type: product-reference
status: canonical
updated: 2026-08-16
applies_to:
  - full-bare-metal
  - host-control
evidence:
  - apps/control/src/server/index.ts
  - apps/control/src/ui/main.tsx
  - apps/control-agent/src/index.ts
  - apps/control-agent/src/files.ts
  - deploy/systemd/archivist-control.service
  - deploy/systemd/archivist-control-agent.service
---

# Archivist Control

Control is the host-native recovery and operations cockpit. It remains outside the application runtime so it can diagnose or restart Archivist when port `2424` is unhealthy.

## Implemented now

- Host and service overview, endpoint probes, filesystem volumes, backup health, and seven-day bounded telemetry history.
- Release/recovery inventory for immutable bare-metal releases.
- Start, stop, and restart of the one allowlisted `archivist.service`; bounded journal viewing.
- Full-filesystem browsing subject to Unix permissions and protected paths, plus a direct Cardigann definitions root.
- Token-gated download, upload, directory creation, move, recoverable trash, and restore; mutations are audit logged.
- Capability detection for SMART, lm-sensors, Btrfs, and ZFS.

The supplied agent blocks `/etc/archivist`, `/proc`, `/sys`, `/dev`, and `/run`. The filesystem is browsable from `/`, but writes are limited by `ARCHIVIST_FILE_WRITE_PATHS`. The installed default includes `/home`, `/mnt`, `/media`, `/srv`, `/tmp`, `/var/tmp`, and `/var/lib/archivist/data/indexer-definitions`. Unix ownership and parent-directory traversal still apply; “visible root” does not bypass `EACCES`.

## Not implemented

- Browser terminal or arbitrary shell
- Docker/container inventory and lifecycle
- Disk partitioning, formatting, mount creation, or fstab management
- SMB users/shares and Samba configuration
- Automated application or operating-system updates
- SMART tests, filesystem scrub/snapshot/restore actions (detection exists only)
- Docker runtime adapter for controlling the application profile

These are roadmap capabilities, not hidden or partially supported features.

## Security model

Control binds to `127.0.0.1:2429` by default. A non-loopback bind refuses to start without `ARCHIVIST_CONTROL_TOKEN`. File access always requires the token; service mutations require it as well. The unprivileged web service reads telemetry/releases/backups and uses polkit for a fixed service/action mapping. The root-owned agent listens only on its Unix socket, has no network namespace, canonicalizes paths, rejects traversal and escaping symlinks, and applies read/write/protected-path policy.

The current bearer token is a bootstrap-quality control, not multi-user authorization. Expose Control remotely only behind authenticated TLS and a deliberate network policy.

## Deployment

Control is never part of the Docker application image. In a full bare-metal deployment it is installed beside Archivist. In a Docker application deployment it still belongs on the host; container management requires a future restricted agent adapter and must not be implemented by mounting the Docker socket into the web process.

Detailed installation commands remain in [`apps/control/README.md`](../../../apps/control/README.md).
