---
title: Deployment architecture
document_type: architecture
status: canonical
updated: 2026-08-16
---

# Deployment architecture

Archivist recognizes three deployment targets:

1. [`full-bare-metal.md`](full-bare-metal.md) — the entire ecosystem runs as host services.
2. [`docker-application.md`](docker-application.md) — Library, Player, Catalogue, and their application dependencies run in Docker.
3. [`host-control.md`](host-control.md) — Control and the restricted Control Agent always run on bare metal.

The application runtime and Control do not share a required packaging boundary. Control uses
runtime adapters for systemd or Docker workloads while privileged host actions remain behind
the audited host agent.

See [`ADR-0001`](../decisions/ADR-0001-deployment-profiles.md) and
[`ADR-0002`](../decisions/ADR-0002-host-control-boundary.md).

