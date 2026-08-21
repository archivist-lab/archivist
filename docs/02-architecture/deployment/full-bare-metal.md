---
title: Full bare-metal deployment
document_type: architecture
status: accepted
updated: 2026-08-16
applies_to:
  - full-bare-metal
---

# Full bare-metal deployment

The Archivist API, worker, Library, Player, Catalogue, Control, and Control Agent run as
host services. Application-owned files use a unified `/archivist` namespace, while operating
system integration remains in standard system locations.

```text
/archivist/app        immutable releases and current/previous links
/archivist/config     Archivist configuration and credentials
/archivist/state      application, Control, and agent state
/archivist/downloads  incomplete and completed acquisition workspace
/archivist/media      stable library mount points
```

systemd units and polkit rules remain under `/etc`; runtime sockets remain under `/run`; logs
remain in journald. Media subdirectories may be separate filesystems and must fail safely when
unmounted instead of accepting writes on the system disk.

The unified-root installer work is an accepted target architecture and must not be described as
delivered until the installer, units, migration, rollback, and tests all use it consistently.

