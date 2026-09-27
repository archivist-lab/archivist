---
title: Archivist Android TV and Fire TV app
document_type: product-reference
status: draft
updated: 2026-09-24
evidence:
  - apps/android-tv/app/src/main/java/app/archivist/tv
  - apps/android-tv/web/src
  - apps/android-tv/web/test
  - apps/player/src/lib/android.ts
  - apps/player/src/components/AndroidExitDialog.tsx
---

# Archivist Android TV and Fire TV app

`apps/android-tv` is a Kotlin WebView shell for Google TV / Android TV and Fire TV, at version `0.1.0`. It stores servers with home and away addresses, finds servers on the local /24 by probing `/api/v1/auth/status` on port `2424`, and then loads the server's own Player at `/player/`. The server picker is a small React page built from `apps/android-tv/web` with the shared design tokens and fonts.

The Player recognizes the shell by `window.ArchivistAndroid`. At its root, Back opens a *Leave Archivist?* dialog with **Switch server**, and **Settings → About** shows the connected server. The Player also handles the remote's transport keys (`MediaPlayPause`, `MediaFastForward`, `MediaRewind`, `MediaStop`).

Build with `pnpm --filter archivist-android-tv apk`. Verify the picker with `pnpm --filter archivist-android-tv test`. See [the app guide](../../../apps/android-tv/README.md) for installation, signing and limits. The app has not yet been exercised on physical Fire TV or Google TV hardware.
