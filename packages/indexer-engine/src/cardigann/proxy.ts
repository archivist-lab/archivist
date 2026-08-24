/**
 * Outbound proxy support for indexer traffic (network egress control §4.3).
 *
 * `proxyUrl` was carried through every layer of the engine for a long time
 * without ever being applied. This module is where it finally takes effect:
 * it turns a proxy URL into an undici dispatcher that the direct request path
 * hands to `fetch`.
 *
 * Two schemes matter in practice, because they are what a VPN exposes:
 *
 *   http(s)://  — a CONNECT proxy (gluetun and most commercial endpoints)
 *   socks5://   — a SOCKS tunnel (wireproxy and userspace WireGuard clients)
 *
 * A proxy that cannot be reached is *our* outage, not evidence about the
 * indexer, so a failure to establish the tunnel is tagged `PROXY_UNAVAILABLE`
 * for the classifier rather than being allowed to surface as a bare connect
 * error — which would score the endpoint dead for a fault it had no part in.
 */

import { Agent, ProxyAgent, buildConnector, type Dispatcher } from 'undici';
import { SocksClient } from 'socks';

/** Thrown when the proxy itself could not be reached. */
export const PROXY_UNAVAILABLE = 'PROXY_UNAVAILABLE';

/**
 * Dispatchers hold connection pools, so they are built once per proxy URL and
 * reused. Building one per request would leak sockets under probe sweeps.
 */
const dispatchers = new Map<string, Dispatcher>();

/** Schemes understood here. Anything else is a configuration error. */
const SOCKS_SCHEMES = new Set(['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:']);
const HTTP_SCHEMES = new Set(['http:', 'https:']);

export function isSupportedProxyScheme(protocol: string): boolean {
  return SOCKS_SCHEMES.has(protocol) || HTTP_SCHEMES.has(protocol);
}

/**
 * Validates a proxy URL without building a dispatcher, so configuration can be
 * rejected at the point it is saved rather than on the first search.
 */
export function assertValidProxyUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid proxy URL: ${raw}`);
  }
  if (!isSupportedProxyScheme(url.protocol)) {
    throw new Error(
      `Unsupported proxy scheme "${url.protocol.replace(':', '')}" in ${raw}. `
      + 'Use http://, https://, or socks5://.',
    );
  }
  if (!url.hostname) throw new Error(`Proxy URL has no host: ${raw}`);
}

/**
 * The dispatcher for a proxy URL, or `undefined` when no proxy is configured —
 * in which case callers must leave `fetch` on its default dispatcher so the
 * unproxied path behaves exactly as it did before this module existed.
 */
export function dispatcherForProxy(proxyUrl: string | undefined | null): Dispatcher | undefined {
  if (!proxyUrl) return undefined;
  const key = proxyUrl.trim();
  if (!key) return undefined;

  const existing = dispatchers.get(key);
  if (existing) return existing;

  const built = buildDispatcher(key);
  dispatchers.set(key, built);
  return built;
}

function buildDispatcher(raw: string): Dispatcher {
  assertValidProxyUrl(raw);
  const url = new URL(raw);

  if (HTTP_SCHEMES.has(url.protocol)) {
    // Credentials belong in a header, not in the CONNECT line.
    const token = url.username
      ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
      : undefined;
    const uri = `${url.protocol}//${url.host}`;
    return token ? new ProxyAgent({ uri, token }) : new ProxyAgent({ uri });
  }

  return new Agent({ connect: socksConnector(url) });
}

/** SOCKS 4 and 5 differ only in the version number the client negotiates. */
function socksVersion(protocol: string): 4 | 5 {
  return protocol === 'socks4:' || protocol === 'socks4a:' ? 4 : 5;
}

/**
 * Opens the SOCKS tunnel and yields the tunnelled socket.
 *
 * For an https target the socket is handed to undici's default connector as
 * `httpSocket`, which performs the TLS upgrade against the real hostname. For
 * a plain http target it is returned as-is: undici asserts that `httpSocket`
 * is only ever supplied for a TLS upgrade, so passing it here would throw.
 */
function socksConnector(proxy: URL) {
  const base = buildConnector({});
  const version = socksVersion(proxy.protocol);
  const port = Number(proxy.port) || 1080;
  const userId = proxy.username ? decodeURIComponent(proxy.username) : undefined;
  const password = proxy.password ? decodeURIComponent(proxy.password) : undefined;

  return (options: any, callback: any) => {
    const targetPort = Number(options.port) || (options.protocol === 'https:' ? 443 : 80);

    SocksClient.createConnection({
      proxy: { host: proxy.hostname, port, type: version, userId, password },
      command: 'connect',
      destination: { host: options.hostname, port: targetPort },
      timeout: 15_000,
    }).then(
      ({ socket }) => {
        if (options.protocol !== 'https:') {
          socket.setNoDelay(true);
          return callback(null, socket);
        }
        return base({ ...options, httpSocket: socket }, callback);
      },
      (err: Error) => {
        // Distinguishable here, and only here: the tunnel never opened, so the
        // destination was never contacted.
        const failure = new Error(`SOCKS proxy ${proxy.hostname}:${port} unreachable: ${err.message}`);
        (failure as Error & { code?: string }).code = PROXY_UNAVAILABLE;
        callback(failure, null);
      },
    );
  };
}

/** Test seam: drops pooled connections so a suite does not leak sockets. */
export async function __resetProxyDispatchers(): Promise<void> {
  const open = [...dispatchers.values()];
  dispatchers.clear();
  await Promise.all(open.map(d => d.close().catch(() => undefined)));
}
