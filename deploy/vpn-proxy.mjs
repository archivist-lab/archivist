#!/usr/bin/env node
/**
 * Archivist egress proxy (network-egress-control-spec §4.2).
 *
 * An HTTP proxy whose only distinction is *who runs it*: it executes as the
 * egress user, whose outbound traffic `vpn-routing.sh` policy-routes into the
 * WireGuard tunnel. Anything that speaks to this proxy therefore leaves by the
 * tunnel; everything else on the host keeps the direct link.
 *
 * Two consumers, both already able to use it:
 *   - the indexer engine's per-indexer `proxyUrl` (phase 1)
 *   - Cloudflare Bypass's `PROXY_URL`, so solves share the same egress
 *
 * Deliberately dependency-free — it runs from a systemd unit as a user with no
 * package tree of its own.
 *
 * Supports both proxy forms: CONNECT tunnelling (used for https, and by undici
 * for everything) and absolute-form plain HTTP requests.
 */

import http from 'node:http';
import net from 'node:net';

const bind = process.env.ARCHIVIST_EGRESS_PROXY_BIND ?? '127.0.0.1';
const port = Number(process.env.ARCHIVIST_EGRESS_PROXY_PORT ?? 8890);
const idleTimeoutMs = Number(process.env.ARCHIVIST_EGRESS_PROXY_IDLE_MS ?? 120_000);
const allowRaw = (process.env.ARCHIVIST_EGRESS_PROXY_ALLOW ?? '').trim();

const loopbackOnly = bind === '127.0.0.1' || bind === '::1' || bind === 'localhost';
const allowList = allowRaw ? allowRaw.split(',').map(entry => entry.trim()).filter(Boolean) : [];

// Binding beyond loopback publishes a general-purpose forward proxy onto the
// network. Refusing to start without an explicit allow list makes that a
// decision rather than an accident.
if (!loopbackOnly && allowList.length === 0) {
  console.error(
    `[egress-proxy] refusing to listen on ${bind} without ARCHIVIST_EGRESS_PROXY_ALLOW. `
    + 'Set it to the addresses permitted to use the tunnel, e.g. the Cloudflare Bypass host.',
  );
  process.exit(78); // EX_CONFIG
}

/** Exact address, or a CIDR whose network bits match. IPv4 prefixes only. */
function permitted(remote) {
  if (!remote) return false;
  const address = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  if (address === '127.0.0.1' || address === '::1') return true;
  for (const entry of allowList) {
    if (entry === address) return true;
    if (!entry.includes('/')) continue;
    const [network, bitsRaw] = entry.split('/');
    const bits = Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const toInt = value => value.split('.').reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address) || !/^\d+\.\d+\.\d+\.\d+$/.test(network)) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((toInt(address) & mask) === (toInt(network) & mask)) return true;
  }
  return false;
}

/** `host:port`, tolerating bracketed IPv6 and a missing port. */
function splitAuthority(authority, fallbackPort) {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end > 0) {
      const host = authority.slice(1, end);
      const rest = authority.slice(end + 1);
      return { host, port: rest.startsWith(':') ? Number(rest.slice(1)) : fallbackPort };
    }
  }
  const index = authority.lastIndexOf(':');
  if (index < 0) return { host: authority, port: fallbackPort };
  const port = Number(authority.slice(index + 1));
  return { host: authority.slice(0, index), port: Number.isFinite(port) ? port : fallbackPort };
}

const server = http.createServer();

// Absolute-form HTTP, e.g. `GET http://host/path HTTP/1.1`.
server.on('request', (req, res) => {
  if (!permitted(req.socket.remoteAddress)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Not permitted to use this proxy\n');
    return;
  }

  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Absolute-form request URI required\n');
    return;
  }
  if (target.protocol !== 'http:') {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Only http:// is proxied directly; use CONNECT for https\n');
    return;
  }

  const headers = { ...req.headers };
  delete headers['proxy-connection'];

  const upstream = http.request(
    {
      host: target.hostname,
      port: Number(target.port) || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.setTimeout(idleTimeoutMs, () => upstream.destroy(new Error('upstream idle timeout')));
  upstream.on('error', err => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`Upstream failure: ${err.message}\n`);
  });
  req.pipe(upstream);
});

// CONNECT tunnelling — the path https traffic and undici's ProxyAgent take.
server.on('connect', (req, clientSocket, head) => {
  if (!permitted(clientSocket.remoteAddress)) {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  const { host, port: targetPort } = splitAuthority(req.url ?? '', 443);
  if (!host || !Number.isFinite(targetPort)) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const upstream = net.connect(targetPort, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
  clientSocket.setTimeout(idleTimeoutMs, () => clientSocket.destroy());

  upstream.on('error', err => {
    // The tunnel is not yet HTTP once established, so a failure after the 200
    // can only be reported by closing.
    if (!clientSocket.destroyed) {
      clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nX-Egress-Error: ${err.code ?? 'failed'}\r\n\r\n`);
    }
    upstream.destroy();
  });
  clientSocket.on('error', () => upstream.destroy());
});

server.on('clientError', (_err, socket) => {
  if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(port, bind, () => {
  const scope = loopbackOnly ? 'loopback only' : `allow: ${allowList.join(', ')}`;
  console.log(`[egress-proxy] listening on ${bind}:${port} (${scope})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
