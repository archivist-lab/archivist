#!/usr/bin/env bash
#
# Scopes the egress tunnel to one user (network-egress-control-spec §4.2).
#
# The tunnel deliberately does not become the host default route. Instead the
# egress proxy runs as its own user, and only that user's outbound traffic is
# policy-routed into the tunnel. Everything else on the host — metadata
# lookups, torrent peers, the LAN, Control itself — keeps using the direct
# link, which is what keeps §4.4 (shared exit addresses degrading metadata
# providers) from applying.
#
# Two rules per user, in priority order:
#   1000  destinations on local networks  -> main table (direct)
#   1010  everything else                 -> tunnel table
#
# Rule 1000 matters more than it looks: without it the proxy's replies to its
# own LAN clients would be sent back through the tunnel and dropped, so the
# proxy would accept connections and then appear to hang.
#
# DNS is unaffected. Resolvers are reached over loopback or the LAN, so they
# match rule 1000 and resolve directly. That is correct for the observed block,
# which is applied to the TLS handshake rather than to DNS answers.

set -euo pipefail

action="${1:-}"
interface="${ARCHIVIST_VPN_INTERFACE:-archivist}"
table="${ARCHIVIST_VPN_TABLE:-51820}"
egress_user="${ARCHIVIST_EGRESS_USER:-archivist-egress}"
priority_direct="${ARCHIVIST_VPN_PRIORITY_DIRECT:-1000}"
priority_tunnel="${ARCHIVIST_VPN_PRIORITY_TUNNEL:-1010}"

default_direct_nets='127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16'
read -r -a direct_nets <<<"${ARCHIVIST_VPN_DIRECT_NETS:-$default_direct_nets}"

if ! uid="$(id -u "$egress_user" 2>/dev/null)"; then
  echo "egress user '$egress_user' does not exist; create it before starting the tunnel" >&2
  exit 1
fi

# `ip rule add` happily creates duplicates, so removal is always attempted
# first and is never fatal.
teardown() {
  ip rule del uidrange "$uid-$uid" lookup "$table" priority "$priority_tunnel" 2>/dev/null || true
  for net in "${direct_nets[@]}"; do
    ip rule del uidrange "$uid-$uid" to "$net" lookup main priority "$priority_direct" 2>/dev/null || true
  done
}

case "$action" in
  up)
    teardown
    ip route replace default dev "$interface" table "$table"
    for net in "${direct_nets[@]}"; do
      ip rule add uidrange "$uid-$uid" to "$net" lookup main priority "$priority_direct"
    done
    ip rule add uidrange "$uid-$uid" lookup "$table" priority "$priority_tunnel"
    ;;
  down)
    teardown
    ip route flush table "$table" 2>/dev/null || true
    ;;
  status)
    echo "user=$egress_user uid=$uid interface=$interface table=$table"
    ip rule show | grep -E "uidrange ${uid}-${uid}\b" || echo '(no rules installed)'
    ip route show table "$table" 2>/dev/null || echo '(tunnel table empty)'
    ;;
  *)
    echo "usage: $(basename "$0") up|down|status" >&2
    exit 64
    ;;
esac
