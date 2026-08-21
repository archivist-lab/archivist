#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PREFIX='/opt/archivist'
STATE_DIR='/var/lib/archivist'
MEDIA_DIR='/srv/archivist/media'
DOWNLOADS_DIR='/srv/archivist/downloads'
RUNTIME_USER='archivist'
CONTROL_USER='archivist-control'
APPLY=0
START_SERVICES=1
ALLOW_UPDATE=0

usage() {
  printf '%s\n' 'Usage: sudo ./deploy/install-bare-metal.sh [options]'
  printf '%s\n' '' 'Options:'
  printf '%s\n' '  --apply                 Perform the installation (otherwise print the plan)'
  printf '%s\n' '  --source PATH           Source checkout to install'
  printf '%s\n' '  --prefix PATH           Release root (default: /opt/archivist)'
  printf '%s\n' '  --state-dir PATH        Persistent data root (default: /var/lib/archivist)'
  printf '%s\n' '  --media-dir PATH        Persistent media root (default: /srv/archivist/media)'
  printf '%s\n' '  --downloads-dir PATH    Persistent downloads root'
  printf '%s\n' '  --runtime-user NAME     Runtime account (default: archivist)'
  printf '%s\n' '  --control-user NAME     Control account (default: archivist-control)'
  printf '%s\n' '  --no-start              Install without enabling or starting services'
  printf '%s\n' '  --allow-update          Permit replacing an existing current release'
}

die() { printf 'error: %s\n' "$1" >&2; exit 1; }
step() { printf '\n==> %s\n' "$1"; }
require_value() { [[ $# -ge 2 && -n "$2" ]] || die "$1 requires a value"; }
validate_path() {
  [[ "$2" == /* && "$2" != '/' && "$2" != *$'\n'* && "$2" =~ ^[A-Za-z0-9_./-]+$ ]] || die "$1 must be a safe absolute path other than /"
}
validate_user() { [[ "$2" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "$1 is not a safe system user name"; }

while (($#)); do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --source) require_value "$@"; SOURCE_DIR="$2"; shift 2 ;;
    --prefix) require_value "$@"; PREFIX="$2"; shift 2 ;;
    --state-dir) require_value "$@"; STATE_DIR="$2"; shift 2 ;;
    --media-dir) require_value "$@"; MEDIA_DIR="$2"; shift 2 ;;
    --downloads-dir) require_value "$@"; DOWNLOADS_DIR="$2"; shift 2 ;;
    --runtime-user) require_value "$@"; RUNTIME_USER="$2"; shift 2 ;;
    --control-user) require_value "$@"; CONTROL_USER="$2"; shift 2 ;;
    --no-start) START_SERVICES=0; shift ;;
    --allow-update) ALLOW_UPDATE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

SOURCE_DIR="$(cd "$SOURCE_DIR" 2>/dev/null && pwd)" || die 'source directory does not exist'
validate_path --source "$SOURCE_DIR"
validate_path --prefix "$PREFIX"
validate_path --state-dir "$STATE_DIR"
validate_path --media-dir "$MEDIA_DIR"
validate_path --downloads-dir "$DOWNLOADS_DIR"
validate_user --runtime-user "$RUNTIME_USER"
validate_user --control-user "$CONTROL_USER"
[[ "$RUNTIME_USER" != "$CONTROL_USER" ]] || die 'runtime and control users must be different'
for protected_path in "$PREFIX" "$STATE_DIR" "$MEDIA_DIR" "$DOWNLOADS_DIR"; do
  case "$protected_path" in /home/*|/root/*|/run/user/*) die "deployment paths cannot be under ProtectHome directories: $protected_path" ;; esac
done

"$SOURCE_DIR/deploy/preflight-bare-metal.sh" "$SOURCE_DIR" || die 'preflight failed'

release_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
revision='source'
if command -v git >/dev/null 2>&1; then revision="$(git -c safe.directory="$SOURCE_DIR" -C "$SOURCE_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf 'source')"; fi
RELEASE_ID="${release_stamp}-${revision}"
RELEASE_DIR="$PREFIX/releases/$RELEASE_ID"
DATA_DIR="$STATE_DIR/data"
CONTROL_STATE_DIR='/var/lib/archivist-control'
CONFIG_DIR='/etc/archivist'

step 'Installation plan'
printf '  Source:          %s\n' "$SOURCE_DIR"
printf '  Release:         %s\n' "$RELEASE_DIR"
printf '  Persistent data: %s\n' "$DATA_DIR"
printf '  Media:           %s\n' "$MEDIA_DIR"
printf '  Downloads:       %s\n' "$DOWNLOADS_DIR"
printf '  Runtime user:    %s\n' "$RUNTIME_USER"
printf '  Control user:    %s (unprivileged)\n' "$CONTROL_USER"
printf '  Authorization:   polkit limited to start/stop/restart archivist.service\n'

if (( ! APPLY )); then
  printf '\nPlan only; no changes were made. Re-run as root with --apply.\n'
  exit 0
fi
(( EUID == 0 )) || die '--apply must run as root'
[[ ! -e "$RELEASE_DIR" ]] || die "release already exists: $RELEASE_DIR"
if [[ -e "$PREFIX/current" && ! -L "$PREFIX/current" ]]; then die "$PREFIX/current exists but is not a release symlink"; fi
if [[ -L "$PREFIX/current" && "$ALLOW_UPDATE" != '1' ]]; then
  die 'an installation already exists; review database compatibility and pass --allow-update explicitly'
fi
if [[ ! -L "$PREFIX/current" && "$START_SERVICES" == '1' ]] && command -v ss >/dev/null 2>&1; then
  for port in 2424 2428 4242 2429; do
    if ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .; then die "TCP port $port is already in use; stop Docker/other listeners or install with --no-start"; fi
  done
fi

step 'Creating locked system accounts'
NOLOGIN_SHELL="$(command -v nologin)"
if ! getent passwd "$RUNTIME_USER" >/dev/null; then useradd --system --home-dir "$STATE_DIR" --shell "$NOLOGIN_SHELL" --user-group "$RUNTIME_USER"; fi
if ! getent passwd "$CONTROL_USER" >/dev/null; then useradd --system --home-dir "$CONTROL_STATE_DIR" --shell "$NOLOGIN_SHELL" --user-group "$CONTROL_USER"; fi
getent group systemd-journal >/dev/null || die 'systemd-journal group is required for bounded journal access'

step 'Preparing persistent paths'
install -d -m 0755 "$PREFIX" "$PREFIX/releases"
for runtime_path in "$STATE_DIR" "$DATA_DIR" "$MEDIA_DIR" "$DOWNLOADS_DIR"; do
  runtime_parent="$(dirname "$runtime_path")"
  if [[ ! -e "$runtime_parent" ]]; then
    # Explicitly make newly-created parent chains traversable. The leaf remains
    # private to the runtime account below.
    install -d -m 0755 "$runtime_parent"
  fi
  if [[ ! -e "$runtime_path" ]]; then
    install -d -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 0750 "$runtime_path"
  else
    [[ -d "$runtime_path" && ! -L "$runtime_path" ]] || die "persistent path must be a real directory: $runtime_path"
  fi
  runuser -u "$RUNTIME_USER" -- test -r "$runtime_path" -a -w "$runtime_path" -a -x "$runtime_path" \
    || die "persistent path is not accessible to $RUNTIME_USER: $runtime_path (check parent traversal and leaf permissions)"
done
install -d -o "$CONTROL_USER" -g "$CONTROL_USER" -m 0750 "$CONTROL_STATE_DIR"
install -d -o root -g "$RUNTIME_USER" -m 0750 "$CONFIG_DIR"
if [[ ! -d "$DATA_DIR/indexer-definitions/definitions" && -d "$SOURCE_DIR/data/indexer-definitions/definitions" ]]; then
  install -d -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 0750 "$DATA_DIR/indexer-definitions"
  rsync -a "$SOURCE_DIR/data/indexer-definitions/" "$DATA_DIR/indexer-definitions/"
  chown -R "$RUNTIME_USER:$RUNTIME_USER" "$DATA_DIR/indexer-definitions"
fi

step 'Copying source into an immutable release directory'
install -d -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 0755 "$RELEASE_DIR"
rsync -a --delete \
  --exclude='.git/' --exclude='.agents/' --exclude='.codex/' --exclude='node_modules/' \
  --exclude='**/dist/' --exclude='.env' --exclude='config.toml' \
  --exclude='data/' --exclude='media/' --exclude='downloads/' \
  "$SOURCE_DIR/" "$RELEASE_DIR/"
chown -R "$RUNTIME_USER:$RUNTIME_USER" "$RELEASE_DIR"

step 'Installing dependencies and building the release'
runuser -u "$RUNTIME_USER" -- corepack pnpm --dir "$RELEASE_DIR" install --frozen-lockfile
for build_script in build:packages build:server build:client build:player build:catalogue build:control-agent build:control; do
  runuser -u "$RUNTIME_USER" -- corepack pnpm --dir "$RELEASE_DIR" "$build_script"
done
chown -R root:root "$RELEASE_DIR"
# The build runs with the invoking root shell's umask. Normalize the immutable
# release so the unprivileged runtime and control users can traverse and read it,
# while retaining execute bits only on directories and files already executable.
chmod -R a+rX,u+w,go-w "$RELEASE_DIR"

step 'Linking persistent state and configuration'
ln -s "$DATA_DIR" "$RELEASE_DIR/data"
ln -s "$MEDIA_DIR" "$RELEASE_DIR/media"
ln -s "$DOWNLOADS_DIR" "$RELEASE_DIR/downloads"
if [[ ! -e "$CONFIG_DIR/config.toml" ]]; then
  if [[ -f "$SOURCE_DIR/config.toml" ]]; then install -o root -g "$RUNTIME_USER" -m 0640 "$SOURCE_DIR/config.toml" "$CONFIG_DIR/config.toml"
  else install -o root -g "$RUNTIME_USER" -m 0640 "$SOURCE_DIR/apps/server/config.example.toml" "$CONFIG_DIR/config.toml"; fi
fi
if [[ ! -e "$CONFIG_DIR/archivist.env" ]]; then
  if [[ -f "$SOURCE_DIR/.env" ]]; then install -o root -g "$RUNTIME_USER" -m 0660 "$SOURCE_DIR/.env" "$CONFIG_DIR/archivist.env"
  else install -o root -g "$RUNTIME_USER" -m 0660 /dev/null "$CONFIG_DIR/archivist.env"; fi
fi
chown root:"$RUNTIME_USER" "$CONFIG_DIR/archivist.env"
chmod 0660 "$CONFIG_DIR/archivist.env"
if ! grep -q '^ARCHIVIST_MEDIA_BASE=' "$CONFIG_DIR/archivist.env"; then printf 'ARCHIVIST_MEDIA_BASE=%s\n' "$MEDIA_DIR" >> "$CONFIG_DIR/archivist.env"; fi
if [[ ! -e "$CONFIG_DIR/control.env" ]]; then
  control_token="$(openssl rand -hex 32)"
  install -o root -g root -m 0600 /dev/null "$CONFIG_DIR/control.env"
  printf 'ARCHIVIST_CONTROL_TOKEN=%s\n' "$control_token" > "$CONFIG_DIR/control.env"
  unset control_token
fi
chown root:root "$CONFIG_DIR/control.env"
chmod 0600 "$CONFIG_DIR/control.env"
ln -s "$CONFIG_DIR/config.toml" "$RELEASE_DIR/config.toml"
ln -s "$CONFIG_DIR/archivist.env" "$RELEASE_DIR/.env"

step 'Installing systemd and polkit policy'
install -d -o root -g root -m 0755 /etc/polkit-1/rules.d
RENDER_DIR="$(mktemp -d /tmp/archivist-install.XXXXXX)"
trap 'rm -rf -- "$RENDER_DIR"' EXIT
BACKUP_DIR="$CONFIG_DIR/install-backups/$RELEASE_ID"
install -d -o root -g root -m 0700 "$BACKUP_DIR"
for existing_file in /etc/systemd/system/archivist.service /etc/systemd/system/archivist-control-agent.service /etc/systemd/system/archivist-control.service /etc/polkit-1/rules.d/50-archivist-control.rules; do
  if [[ -f "$existing_file" ]]; then install -o root -g root -m 0600 "$existing_file" "$BACKUP_DIR/$(basename "$existing_file")"; fi
done
sed -e "s|/opt/archivist|$PREFIX|g" -e "s|^User=archivist$|User=$RUNTIME_USER|" -e "s|^Group=archivist$|Group=$RUNTIME_USER|" \
  "$SOURCE_DIR/deploy/systemd/archivist.service" > "$RENDER_DIR/archivist.service"
install -o root -g root -m 0644 "$RENDER_DIR/archivist.service" /etc/systemd/system/archivist.service
sed -e "s|/opt/archivist|$PREFIX|g" -e "s|^Group=archivist-control$|Group=$CONTROL_USER|" -e "s|^SupplementaryGroups=archivist$|SupplementaryGroups=$RUNTIME_USER|" \
  -e "s|^Environment=ARCHIVIST_MEDIA_DIR=.*|Environment=ARCHIVIST_MEDIA_DIR=$MEDIA_DIR|" -e "s|^Environment=ARCHIVIST_DOWNLOADS_DIR=.*|Environment=ARCHIVIST_DOWNLOADS_DIR=$DOWNLOADS_DIR|" \
  "$SOURCE_DIR/deploy/systemd/archivist-control-agent.service" > "$RENDER_DIR/archivist-control-agent.service"
install -o root -g root -m 0644 "$RENDER_DIR/archivist-control-agent.service" /etc/systemd/system/archivist-control-agent.service
sed -e "s|/opt/archivist|$PREFIX|g" -e "s|^User=archivist-control$|User=$CONTROL_USER|" -e "s|^Group=archivist-control$|Group=$CONTROL_USER|" \
  "$SOURCE_DIR/deploy/systemd/archivist-control.service" > "$RENDER_DIR/archivist-control.service"
install -o root -g root -m 0644 "$RENDER_DIR/archivist-control.service" /etc/systemd/system/archivist-control.service
sed -e "s|subject.user === 'archivist-control'|subject.user === '$CONTROL_USER'|" \
  "$SOURCE_DIR/deploy/polkit/50-archivist-control.rules" > "$RENDER_DIR/50-archivist-control.rules"
install -o root -g root -m 0644 "$RENDER_DIR/50-archivist-control.rules" /etc/polkit-1/rules.d/50-archivist-control.rules

if [[ -L "$PREFIX/current" ]]; then
  systemctl stop archivist-control.service archivist-control-agent.service archivist.service 2>/dev/null || true
  ln -sfnT "$(readlink -f "$PREFIX/current")" "$PREFIX/previous"
fi
ln -sfnT "$RELEASE_DIR" "$PREFIX/current"
systemctl daemon-reload

if (( START_SERVICES )); then
  step 'Starting Archivist'
  systemctl enable --now archivist.service archivist-control-agent.service archivist-control.service
  if command -v curl >/dev/null 2>&1; then
    healthy=0
    for _ in {1..30}; do
      if curl -fsS --max-time 2 http://127.0.0.1:2424/api/v1/health >/dev/null; then healthy=1; break; fi
      sleep 1
    done
    (( healthy == 1 )) || die 'Archivist did not become healthy; inspect journalctl -u archivist.service'
  fi
fi

step 'Installation complete'
printf '  Control URL: http://127.0.0.1:2429\n'
printf '  Control token: %s/control.env (root-readable only)\n' "$CONFIG_DIR"
printf '  Release: %s\n' "$RELEASE_ID"
