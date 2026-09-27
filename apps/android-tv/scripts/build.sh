#!/usr/bin/env bash
# Builds a signed release APK into dist/.
#
#   pnpm --filter archivist-android-tv apk      (or: bash scripts/build.sh)
#
# First run installs the toolchain (scripts/setup-toolchain.sh) and creates a
# release signing key in keystore/. Keep that key: Android only installs an
# update over an app signed with the same one.
set -euo pipefail
cd "$(dirname "$0")/.."

TOOLCHAIN="${ARCHIVIST_ANDROID_HOME:-$HOME/.cache/archivist-android}"
[ -f "$TOOLCHAIN/env.sh" ] || bash scripts/setup-toolchain.sh
# shellcheck disable=SC1091
source "$TOOLCHAIN/env.sh"
echo "sdk.dir=$ANDROID_HOME" > local.properties

if [ ! -f keystore.properties ]; then
  echo "→ Creating release signing key (keystore/archivist-release.jks)"
  mkdir -p keystore
  PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  keytool -genkeypair -v -keystore keystore/archivist-release.jks -storetype PKCS12 \
    -alias archivist -keyalg RSA -keysize 4096 -validity 10000 \
    -storepass "$PASSWORD" -keypass "$PASSWORD" \
    -dname "CN=Archivist Android TV" >/dev/null 2>&1
  cat > keystore.properties <<PROPS
storeFile=keystore/archivist-release.jks
storePassword=$PASSWORD
keyAlias=archivist
keyPassword=$PASSWORD
PROPS
  chmod 600 keystore.properties keystore/archivist-release.jks
fi

./gradlew --no-daemon assembleRelease

VERSION="$(sed -n 's/.*versionName = "\(.*\)".*/\1/p' app/build.gradle.kts)"
mkdir -p dist
cp app/build/outputs/apk/release/app-release.apk "dist/archivist-tv-$VERSION.apk"
echo "Built dist/archivist-tv-$VERSION.apk"
