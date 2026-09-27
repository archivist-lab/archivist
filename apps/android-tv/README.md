---
title: "Archivist for Android TV and Fire TV"
document_type: application-guide
status: draft
classified: 2026-09-24
---
# Archivist for Android TV and Fire TV

A native TV app for Google TV / Android TV and Amazon Fire TV. Pick (or find)
a server once and sign in; from then on the app opens straight into it.

Browsing, item pages and playback are native: Jetpack Compose for TV draws
the screens, and ExoPlayer (Media3) plays the library's files as they are on
disk — Matroska and MP4, HEVC, AV1, Dolby Digital, with surround passed
through to a receiver. Only when the television cannot decode the chosen
audio or video does it fall back to the server's HLS compatibility stream,
and there the picture is copied unless the TV cannot decode it either.

```txt
┌─ Android app (Kotlin) ───────────────────────────────────────────────┐
│  MainActivity        Compose for TV: servers, sign-in, Home, Films,   │
│                      Series, Search, item pages, Settings             │
│  PlaybackActivity    ExoPlayer: direct play, HLS fallback, skip       │
│                      intro, next episode, progress sync               │
│  WebPlayerActivity   the server's web Player at /player/, opened from │
│                      Settings for music, books and games              │
└───────────────────────────────────────────────────────────────────────┘
```

The app signs in once per server and registers itself as a device
(`POST /api/v1/auth/devices`); the year-long token it is issued goes on every
request as `Authorization: Bearer`, artwork and streams included. It appears
in the server's device list, where it can be revoked.

## Servers, home and away

Each server has up to two addresses:

- **Home** — its address on your network, e.g. `192.168.1.10`. Scheme and
  port are optional; `http://…:2424` is assumed for local-looking hosts.
- **Away** (optional) — how to reach it from anywhere else: a reverse proxy
  with a real certificate (`archivist.example.com` → `https://`), or a
  Tailscale / VPN address.

Connecting tries home first (2.5 s), then away (8 s), and says which one
answered. The Add screen scans the TV's local subnet for Archivist on port
2424 and lists what it finds. Any number of servers can be saved; the last
one used opens automatically at launch.

Sign-in is the Player's usual one. Sessions last 30 days and are kept per
address, so home and away each ask once.

## Remote control

| Button | Does |
| --- | --- |
| D-pad / OK | Move and select — the Player's own focus system |
| Back | Back in the Player; on Home, a *Leave Archivist?* dialog with **Switch server** |
| Play/Pause, ⏩, ⏪ | Play/pause, +30 s, −10 s during playback |
| Stop | Closes the player |

**Settings → About** also shows the connected server and has **Switch server**.

## Installing on a TV

Build the APK (below), or use one from `dist/`. Then either:

**Downloader app** (easiest; works on both Fire TV and Google TV). Serve
`dist/` from the machine that built it — `python3 -m http.server 8000 -d apps/android-tv/dist` —
and open `http://<that-machine>:8000/archivist-tv-0.1.0.apk` in Downloader.
Allow Downloader to install unknown apps when asked.

**adb over the network**:

- *Fire TV*: Settings → My Fire TV → About → click the device name seven times
  to unlock Developer options; then Developer options → ADB debugging **On**.
  Run `bash scripts/install.sh <tv-ip>` and accept the prompt on the TV.
- *Google TV*: Settings → System → About → click *Android TV OS build* seven
  times; then Settings → System → Developer options → Wireless debugging
  **On** → *Pair device with pairing code*. Once:
  `adb pair <ip>:<pairing-port> <code>`. Then `bash scripts/install.sh <ip>:<port>`,
  using the port shown on the Wireless debugging screen.

Updates install over the top as long as they are signed with the same key
(see below).

## Building

```sh
pnpm install
pnpm --filter archivist-android-tv apk      # → apps/android-tv/dist/archivist-tv-<version>.apk
```

The first build installs a JDK 17, the Android SDK and Gradle into
`~/.cache/archivist-android` (no root; `scripts/setup-toolchain.sh`), and
creates the release signing key in `keystore/` with its passwords in
`keystore.properties`. Neither is committed. **Back them up**: Android will
only install an update over an app signed with the same key. Without them the
old app has to be uninstalled first, which loses its saved servers.

Android Studio opens this directory as an ordinary Gradle project (Gradle 9.8,
Android Gradle Plugin 9.4; any JDK from 17 to 27 runs it, including Studio's
bundled one). The
`:app:buildSetupWeb` task builds the picker into the APK's assets before each
build.

The version is `versionCode` / `versionName` in `app/build.gradle.kts`.

## Working on the picker

```sh
pnpm --filter archivist-android-tv dev:web    # http://localhost:4343 with an in-browser stand-in bridge
pnpm --filter archivist-android-tv test       # address parsing, D-pad movement, screen flow
pnpm --filter archivist-android-tv typecheck
./gradlew testDebugUnitTest                  # server probe and origin checks (JVM), after sourcing ~/.cache/archivist-android/env.sh
```

The picker's rem is 1/120 of the screen width, so it looks the same at the
960×540 CSS viewport a 1080p TV reports and at 1920×1080 in a desktop browser.

`node scripts/render-art.mjs` regenerates the launcher icons and banner from
`client/src/icon.svg` and the Bebas Neue wordmark.

## Requirements and limits

- **WebView**: the Player uses modern CSS such as `color-mix()`, which needs
  Android System WebView / Amazon WebView 111 or newer. Google TV updates
  WebView through Play; on Fire TV it comes with Fire OS updates. The picker
  itself runs on much older WebViews.
- **Playback** is the Player's own `<video>` path. It asks the device what it
  can decode, direct-plays what it can, and uses Archivist's transcode for the
  rest.
- **Certificates**: the away address needs a certificate the TV trusts. A
  self-signed one fails with *Certificate not trusted*; use Let's Encrypt, or
  Tailscale over plain HTTP.
- Links out of Archivist (IMDb and the like) open in another app when the TV
  has one. They never load inside the app, next to the bridge.
- Minimum Android 5.1 (Fire OS 5), target Android 15.
