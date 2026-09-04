#!/usr/bin/env bash
#
# Fire TV / Android TV capability probe.
#
# Answers the three questions that decide the Player's television architecture
# (see docs/03-products/player/native-shell-architecture.md, Phase 0):
#
#   1. Does the device decode AV1 and HEVC in hardware?
#   2. Is the system WebView new enough for color-mix() (Chromium 111+)?
#   3. What audio formats does the connected receiver accept?
#
# Usage:
#   adb connect <fire-tv-ip>:5555     # enable ADB debugging on the device first
#   ./scripts/probe-firetv.sh
#
# Requires adb on PATH and exactly one connected device.

set -uo pipefail

say() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
adbsh() { adb shell "$@" 2>/dev/null; }

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found on PATH." >&2
  exit 1
fi
if [ "$(adb devices | grep -c 'device$')" -ne 1 ]; then
  echo "Expected exactly one connected device. 'adb devices' reports:" >&2
  adb devices >&2
  echo >&2
  echo "If ADB debugging is enabled and the device still refuses to connect, the" >&2
  echo "device may be running Vega OS rather than Android-based Fire OS. Vega does" >&2
  echo "not accept Android APKs at all — see section 3.4 of" >&2
  echo "docs/03-products/player/native-shell-architecture.md." >&2
  exit 1
fi

say "Device"
for prop in ro.product.model ro.product.device ro.product.manufacturer \
            ro.build.version.release ro.build.version.sdk ro.build.version.fireos; do
  printf '%-32s %s\n' "$prop" "$(adbsh getprop "$prop")"
done
printf '%-32s %s kB\n' "MemTotal" "$(adbsh cat /proc/meminfo | awk '/MemTotal/{print $2}')"

say "WebView provider and version"
# Fire OS ships an Amazon Chromium build rather than Google's Android System
# WebView. Below Chromium 111 the 24 color-mix() declarations in the design
# system fail, which eliminates the WebView UI option outright.
webviews=$(adbsh pm list packages | grep -i webview | sed 's/^package://')
if [ -z "$webviews" ]; then
  echo "No WebView package found by name; check 'adb shell dumpsys webviewupdate'."
else
  for pkg in $webviews; do
    version=$(adbsh dumpsys package "$pkg" | awk -F= '/versionName=/{print $2; exit}')
    printf '%-44s %s\n' "$pkg" "${version:-unknown}"
  done
fi
echo
echo "Verdict: major version >= 111 keeps the WebView option alive."

say "Hardware video decoders"
# OMX./c2. entries without ".sw." or "google" are vendor hardware decoders.
codecs=$(adbsh cat /vendor/etc/media_codecs.xml /etc/media_codecs.xml 2>/dev/null)
if [ -z "$codecs" ]; then
  echo "media_codecs.xml unreadable; run the Kotlin probe (MediaCodecList) instead."
else
  for fmt in "av01:AV1" "hevc:HEVC" "avc:H.264" "vp9:VP9"; do
    name=${fmt%%:*}; label=${fmt##*:}
    hits=$(printf '%s' "$codecs" | grep -i "video/$name" | grep -vi "sw\|google" | wc -l | tr -d ' ')
    if [ "$hits" -gt 0 ]; then
      printf '%-10s hardware decoder present (%s entries)\n' "$label" "$hits"
    else
      printf '%-10s NO hardware decoder\n' "$label"
    fi
  done
fi
echo
echo "Verdict: AV1 without a hardware decoder means software dav1d — adequate"
echo "at 1080p, unreliable at 4K on this class of silicon. HEVC stays the safe"
echo "archival codec if AV1 is absent."

say "Audio passthrough"
# What the connected receiver accepts decides whether TrueHD/DTS-HD survive
# intact or the server keeps transcoding to stereo AAC.
adbsh dumpsys audio | grep -iE "surround|encoded|passthrough|ac3|dts|truehd|atmos" | head -20
echo
echo "Verdict: formats listed here can be passed through untouched."

say "Display modes"
adbsh dumpsys display | grep -iE "^\s*mode |refreshRate|activeMode" | head -20
echo
echo "Verdict: a 24Hz or 23.976Hz mode enables frame-rate matching (judder fix)."

say "Next"
cat <<'NEXT'
Record these results in the Phase 0 section of
docs/03-products/player/native-shell-architecture.md.

They decide:
  - OS family        -> Android-based Fire OS, or Vega (which this script cannot
                        reach at all, and on which only React Native applies)
  - AV1 hardware     -> whether "AV1 native" is real on this device
  - Audio formats    -> the capability profile sent to playback-plan.ts
  - WebView version  -> only relevant if Vega is ruled out of scope
NEXT
