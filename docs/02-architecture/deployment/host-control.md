---
title: Host-native Control deployment
document_type: architecture
status: accepted
updated: 2026-08-16
applies_to:
  - host-control
---

# Host-native Control deployment

Archivist Control and its restricted Control Agent always run directly on the host, whether the
application runtime is bare metal or Docker-based.

The unprivileged web process owns presentation, authentication, orchestration, and audit history.
Host service, storage, mount, SMB, update, terminal, and container operations cross a narrow,
authenticated agent boundary. The agent exposes explicit operations rather than general root
command execution.

The web process must not receive unrestricted access to the Docker socket, systemd control,
devices, host filesystems, or a privileged shell.

