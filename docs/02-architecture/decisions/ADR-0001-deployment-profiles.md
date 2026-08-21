---
title: ADR-0001 — Canonical deployment profiles
document_type: decision
status: accepted
updated: 2026-08-16
---

# ADR-0001: Canonical deployment profiles

## Context

Archivist supports both host-native and containerized application operation, while Control needs
host visibility and recovery capabilities. Treating all components as one deployment unit makes
permissions, documentation, upgrades, and failure recovery ambiguous.

## Decision

All architecture and delivery work recognizes three targets:

1. The entire Archivist ecosystem on bare metal.
2. Library, Player, Catalogue, and required application runtime components in Docker.
3. Archivist Control and its restricted agent on bare metal.

## Consequences

- Compose packages the application runtime but never silently adds Control.
- Full bare-metal installation includes the application runtime and Control host services.
- Control supports lifecycle adapters instead of assuming one runtime backend.
- Documentation and tests state which targets they apply to.

