/** The port Archivist's single-port gateway listens on out of the box. */
export const DEFAULT_PORT = 2424

export type Normalized = { url: string } | { error: string }

/**
 * Turns what someone typed with a TV remote into a server base URL.
 *
 * Typing on a remote is slow, so the scheme and port are optional:
 *
 *   192.168.1.10              → http://192.168.1.10:2424
 *   nas.local                 → http://nas.local:2424
 *   archivist.example.com     → https://archivist.example.com
 *   http://10.0.0.5:8080/     → http://10.0.0.5:8080
 *
 * A local-looking host (an IP, `localhost`, a bare name, or a home-network
 * suffix) gets plain HTTP on the default port; anything with a public-looking
 * domain is assumed to be behind a TLS reverse proxy on 443. A pasted Player
 * URL (`…/player/`) is trimmed back to the server.
 *
 * Returns null for an empty field, which is valid for the optional away address.
 */
export function normalizeAddress(raw: string): Normalized | null {
  const typed = raw.trim()
  if (!typed) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed)
  let candidate = typed
  if (!hasScheme) {
    const authority = typed.split(/[/?#]/, 1)[0]
    const hasPort = /:\d+$/.test(authority)
    const host = authority.replace(/:\d+$/, '').toLowerCase()
    const local = isLocalHost(host)
    const scheme = local || hasPort ? 'http' : 'https'
    const port = local && !hasPort ? `:${DEFAULT_PORT}` : ''
    candidate = `${scheme}://${authority}${port}${typed.slice(authority.length)}`
  }
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { error: 'That does not look like an address' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'Use an http:// or https:// address' }
  if (!parsed.hostname) return { error: 'That does not look like an address' }
  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/player$/i, '')
  return { url: `${parsed.protocol}//${parsed.host}${path}` }
}

function isLocalHost(host: string): boolean {
  if (host === 'localhost') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  if (host.startsWith('[')) return true
  if (!host.includes('.')) return true
  return /\.(local|lan|home|internal|localdomain|home\.arpa)$/.test(host)
}

/** A readable default name for a server nobody named. */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
