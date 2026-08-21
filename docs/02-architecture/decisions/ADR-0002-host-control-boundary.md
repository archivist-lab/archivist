---
title: ADR-0002 — Host-native Control boundary
document_type: decision
status: accepted
updated: 2026-08-16
---

# ADR-0002: Host-native Control boundary

## Context

Control needs to inspect and manage services, containers, storage, mounts, SMB, updates, logs,
and terminals. A normal container cannot perform these operations, while broad host mounts or an
unrestricted Docker socket effectively grant the web process root-equivalent access.

## Decision

Control remains host-native. Its web service is unprivileged and delegates approved host actions
to a separately hardened, authenticated, audited agent with explicit operation contracts.

## Consequences

- Control is not shipped inside the Archivist application container.
- Docker management is mediated by the host agent through a constrained adapter.
- Raw shell execution and raw Docker socket access are not exposed to the web process.
- New privileged capabilities require a threat review, containment checks, authorization, and
  an audit event.

