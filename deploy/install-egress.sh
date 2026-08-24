#!/usr/bin/env bash
#
# Installs the egress stack: Trawl, the WireGuard tunnel, and the egress proxy
# (network-egress-control-spec §3, §4.2).
#
#   ./deploy/install-egress.sh            # print the plan, change nothing
#   sudo ./deploy/install-egress.sh --apply
#
# Plan-then-apply, matching install-bare-metal.sh. Nothing is started: this
# places files and creates the egress user, then tells you what to fill in.
# Secrets are never written here — you supply the WireGuard config yourself.

set -euo pipefail

cd "$(dirname "$0")/.."
SOURCE_DIR="$(pwd)"

APPLY=0
EGRESS_USER="${ARCHIVIST_EGRESS_USER:-archivist-egress}"
LIB_DIR=/usr/local/lib/archivist
UNIT_DIR=/etc/systemd/system
POLKIT_DIR=/etc/polkit-1/rules.d
CONFIG_DIR=/etc/archivist

while (($#)); do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --user) EGRESS_USER="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$1"; }

# ─── Preflight ───────────────────────────────────────────────────────────────

step 'Preflight'
missing=0
for command in systemctl docker node ip; do
  if command -v "$command" >/dev/null 2>&1; then
    echo "  [ok] $command is available"
  else
    echo "  [error] $command is missing"; missing=1
  fi
done

if command -v wg-quick >/dev/null 2>&1; then
  echo "  [ok] wg-quick is available"
else
  echo "  [error] wg-quick is missing — install wireguard-tools"; missing=1
fi

if docker compose version >/dev/null 2>&1; then
  echo "  [ok] docker compose plugin is available"
else
  echo "  [error] the docker compose plugin is missing"; missing=1
fi

if [[ -e /sys/module/wireguard ]] || modinfo wireguard >/dev/null 2>&1; then
  echo "  [ok] the wireguard kernel module is present"
else
  echo "  [warn] the wireguard module was not found; the tunnel will fail to start"
fi

((missing == 0)) || die 'preflight failed; resolve the errors above first'

# ─── Plan ────────────────────────────────────────────────────────────────────

step 'Installation plan'
cat <<PLAN
  Source:        $SOURCE_DIR
  Egress user:   $EGRESS_USER (system account, no shell, no home)
  Helpers:       $LIB_DIR/vpn-routing.sh, $LIB_DIR/vpn-proxy.mjs
  Units:         $UNIT_DIR/archivist-trawl.service
                 $UNIT_DIR/archivist-vpn.service
                 $UNIT_DIR/archivist-vpn-proxy.service
  Control:       $UNIT_DIR/archivist-control.service.d/repository.conf
  Authority:     $POLKIT_DIR/50-archivist-control.rules  (adds the three units)
  Config:        $CONFIG_DIR/trawl/docker-compose.yml
                 $CONFIG_DIR/vpn.env          (from vpn.env.example, if absent)
                 $CONFIG_DIR/vpn/archivist.conf   NOT installed — you supply it
PLAN

if ((APPLY == 0)); then
  printf '\nPlan only; no changes were made. Re-run as root with --apply.\n'
  exit 0
fi

((EUID == 0)) || die '--apply must run as root'

# ─── Apply ───────────────────────────────────────────────────────────────────

step "Creating the egress user"
if id -u "$EGRESS_USER" >/dev/null 2>&1; then
  echo "  $EGRESS_USER already exists"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin "$EGRESS_USER"
  echo "  created $EGRESS_USER"
fi

step 'Installing helpers'
install -d -o root -g root -m 0755 "$LIB_DIR"
install -o root -g root -m 0755 "$SOURCE_DIR/deploy/vpn-routing.sh" "$LIB_DIR/vpn-routing.sh"
install -o root -g root -m 0755 "$SOURCE_DIR/deploy/vpn-proxy.mjs" "$LIB_DIR/vpn-proxy.mjs"

step 'Installing units'
for unit in archivist-trawl archivist-vpn archivist-vpn-proxy; do
  install -o root -g root -m 0644 "$SOURCE_DIR/deploy/systemd/$unit.service" "$UNIT_DIR/$unit.service"
  echo "  $unit.service"
done
install -d -o root -g root -m 0755 "$UNIT_DIR/archivist-control.service.d"
install -o root -g root -m 0644 \
  "$SOURCE_DIR/deploy/systemd/archivist-control.service.d/repository.conf" \
  "$UNIT_DIR/archivist-control.service.d/repository.conf"
echo '  archivist-control drop-in'

step 'Extending Control authority'
install -d -o root -g root -m 0755 "$POLKIT_DIR"
install -o root -g root -m 0644 "$SOURCE_DIR/deploy/polkit/50-archivist-control.rules" \
  "$POLKIT_DIR/50-archivist-control.rules"

step 'Installing configuration'
install -d -o root -g root -m 0755 "$CONFIG_DIR/trawl"
install -o root -g root -m 0644 "$SOURCE_DIR/deploy/trawl/docker-compose.yml" \
  "$CONFIG_DIR/trawl/docker-compose.yml"

# Never overwrite settings already in place.
if [[ -f "$CONFIG_DIR/vpn.env" ]]; then
  echo "  $CONFIG_DIR/vpn.env exists; left unchanged"
else
  install -o root -g root -m 0640 "$SOURCE_DIR/deploy/vpn/vpn.env.example" "$CONFIG_DIR/vpn.env"
  echo "  installed vpn.env from the example"
fi

# 0700: this directory holds the tunnel's private key (spec §3.4).
install -d -o root -g root -m 0700 "$CONFIG_DIR/vpn"

step 'Reloading systemd'
systemctl daemon-reload

cat <<'NEXT'

==> Installed. Nothing has been started.

Remaining steps, in order:

  1. Place your WireGuard config (it holds a private key):
       sudo install -o root -g root -m 0600 \
         deploy/vpn/archivist.conf.example /etc/archivist/vpn/archivist.conf
       sudo editor /etc/archivist/vpn/archivist.conf
     It MUST keep `Table = off`.

  2. Review /etc/archivist/vpn.env — especially PROXY_URL and, if Trawl or any
     other host must reach the proxy, ARCHIVIST_EGRESS_PROXY_BIND together with
     ARCHIVIST_EGRESS_PROXY_ALLOW.

  3. Start the tunnel and confirm the egress address actually changed:
       sudo systemctl start archivist-vpn archivist-vpn-proxy
       sudo -u archivist-egress curl -s https://api.ipify.org; echo
       curl -s https://api.ipify.org; echo
     The first must differ from the second. If they match, the tunnel is not
     carrying the egress user's traffic and nothing below will help.

  4. Start Trawl and restart Control so it picks up the new units:
       sudo systemctl start archivist-trawl
       sudo systemctl restart archivist-control

     Trawl runs without the tunnel. Steps 1-3 are only needed to change where
     its traffic leaves from, so this step is worth doing on its own.

  5. Only once step 3 confirmed a changed egress address, send Trawl through
     the tunnel by uncommenting PROXY_URL in /etc/archivist/vpn.env, then:
       sudo systemctl restart archivist-trawl
     Pointing Trawl at a proxy that is not listening breaks every solve, which
     is why it ships commented out.

  6. Point Archivist at the local solver (Settings, or the cloudflareBypass
     app setting) and re-probe the blocked endpoints.

NEXT
