#!/usr/bin/env bash
# Installs everything needed to build the Android TV app into a user-space
# cache — no root, nothing touched outside $ARCHIVIST_ANDROID_HOME.
#
#   JDK 17 (Temurin), Android command-line tools, platform-tools (adb),
#   the compile platform and build-tools, and a Gradle distribution used once
#   to generate the wrapper.
#
# Re-running is cheap: each piece is skipped when already present.
set -euo pipefail

ROOT="${ARCHIVIST_ANDROID_HOME:-$HOME/.cache/archivist-android}"
JDK_DIR="$ROOT/jdk"
SDK_DIR="$ROOT/sdk"
GRADLE_VERSION=9.8.0
CMDLINE_TOOLS_ZIP=commandlinetools-linux-11076708_latest.zip
mkdir -p "$ROOT"

# `unzip` is not installed everywhere; Python is. Keeps the executable bits
# that sdkmanager, adb and gradle need.
extract_zip() {
  python3 - "$1" "$2" <<'PY'
import os, sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        path = z.extract(info, dest)
        mode = (info.external_attr >> 16) & 0o777
        if mode:
            os.chmod(path, mode)
PY
}

if [ ! -x "$JDK_DIR/bin/java" ]; then
  echo "→ JDK 17"
  curl -fsSL "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse" -o "$ROOT/jdk.tar.gz"
  rm -rf "$JDK_DIR" && mkdir -p "$JDK_DIR"
  tar -xzf "$ROOT/jdk.tar.gz" -C "$JDK_DIR" --strip-components=1
  rm "$ROOT/jdk.tar.gz"
fi
export JAVA_HOME="$JDK_DIR"
export PATH="$JAVA_HOME/bin:$PATH"

if [ ! -x "$SDK_DIR/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "→ Android command-line tools"
  curl -fsSL "https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP" -o "$ROOT/cmdline-tools.zip"
  rm -rf "$SDK_DIR/cmdline-tools" && mkdir -p "$SDK_DIR/cmdline-tools"
  extract_zip "$ROOT/cmdline-tools.zip" "$SDK_DIR/cmdline-tools" && mv "$SDK_DIR/cmdline-tools/cmdline-tools" "$SDK_DIR/cmdline-tools/latest"
  rm "$ROOT/cmdline-tools.zip"
fi

SDKMANAGER="$SDK_DIR/cmdline-tools/latest/bin/sdkmanager"
if [ ! -d "$SDK_DIR/platforms/android-35" ] || [ ! -d "$SDK_DIR/build-tools/35.0.0" ] || [ ! -x "$SDK_DIR/platform-tools/adb" ]; then
  echo "→ SDK packages"
  yes | "$SDKMANAGER" --sdk_root="$SDK_DIR" --licenses >/dev/null || true
  "$SDKMANAGER" --sdk_root="$SDK_DIR" "platform-tools" "platforms;android-35" "build-tools;35.0.0" >/dev/null
fi

if [ ! -x "$ROOT/gradle-$GRADLE_VERSION/bin/gradle" ]; then
  echo "→ Gradle $GRADLE_VERSION"
  curl -fsSL "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip" -o "$ROOT/gradle.zip"
  extract_zip "$ROOT/gradle.zip" "$ROOT"
  rm "$ROOT/gradle.zip"
fi

cat > "$ROOT/env.sh" <<ENV
export JAVA_HOME="$JDK_DIR"
export ANDROID_HOME="$SDK_DIR"
export ANDROID_SDK_ROOT="$SDK_DIR"
export PATH="$JDK_DIR/bin:$SDK_DIR/platform-tools:$ROOT/gradle-$GRADLE_VERSION/bin:\$PATH"
ENV
echo "Toolchain ready. Load it with: source $ROOT/env.sh"
