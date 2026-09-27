#!/usr/bin/env bash
# Installs the built APK on a TV over the network with adb.
#
#   bash scripts/install.sh 192.168.1.50            # Fire TV: port 5555
#   bash scripts/install.sh 192.168.1.51:39147      # Google TV: the port from
#                                                   # Wireless debugging
#
# Enable developer options on the TV first (see README.md). Google TV asks
# for a one-time `adb pair` before the first connect.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:?usage: install.sh <tv-ip>[:port]}"
[[ "$TARGET" == *:* ]] || TARGET="$TARGET:5555"

TOOLCHAIN="${ARCHIVIST_ANDROID_HOME:-$HOME/.cache/archivist-android}"
# shellcheck disable=SC1091
source "$TOOLCHAIN/env.sh"

APK="$(ls -t dist/archivist-tv-*.apk 2>/dev/null | head -1)"
[ -n "$APK" ] || { echo "No APK in dist/ — run scripts/build.sh first." >&2; exit 1; }

adb connect "$TARGET"
echo "Accept the debugging prompt on the TV if one appears…"
adb -s "$TARGET" wait-for-device
adb -s "$TARGET" install -r "$APK"
adb -s "$TARGET" shell am start -n app.archivist.tv/.MainActivity >/dev/null
echo "Installed $APK on $TARGET"
