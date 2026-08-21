---
title: Docker application deployment
document_type: architecture
status: accepted
updated: 2026-08-16
applies_to:
  - docker-application
---

# Docker application deployment

Docker packages the Archivist application runtime serving Library, Player, Catalogue, and their
API and worker dependencies. Persistent data, media, and downloads are mounted into the
application container.

Archivist Control is not part of the application image or Compose stack. A Docker deployment may
be observed or managed by host-native Control through a restricted runtime adapter, but Control
must not be made dependent on the application container it is expected to recover.

