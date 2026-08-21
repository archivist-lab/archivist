/**
 * HTTP gateway — the single listener for every Archivist web surface.
 *
 * Archivist used to bind three ports from this one process: 2424 (Library SPA +
 * API), 4242 (Player SPA) and 2428 (Catalogue SPA). They are now prefixes on
 * one port:
 *
 *   /library/…      Library SPA (the administration app)
 *   /player/…       Player SPA
 *   /catalogue/…    Catalogue SPA
 *   /emulatorjs/…   vendored EmulatorJS runtime for the arcade
 *   /api/v1/…       the API, /media/… protected media, /ping — all to Express
 *   /               a chooser page linking to the three apps
 *
 * The API deliberately stays at the root rather than being namespaced per app.
 * All three SPAs already request absolute `/api/v1/...` paths, as do Kodi and
 * any other API client, so nothing outside the static asset bases has to move.
 *
 * Note what this gives up. The old Player listener allowlisted three path
 * prefixes and could not reach the administration API at all — a network-level
 * restriction. On one port that is unenforceable: whoever can reach /player/
 * can reach /library/ and /api/v1/. Authentication (apiAuthMiddleware in
 * app.ts) is now the only thing separating them, which is what it was already
 * doing for the Library surface.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Express } from 'express'
import { createLogger } from '@archivist/core'

const logger = createLogger('Gateway')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  // EmulatorJS payloads (arcade).
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.mem': 'application/octet-stream',
}

const BASE_SECURITY_HEADERS = {
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
}

const STRICT_CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'"

/**
 * CSP for the arcade surface only (/player/emu.html and /emulatorjs/*).
 *
 * EmulatorJS needs three things the strict policy forbids:
 *   • WebAssembly compilation for the emulator cores,
 *   • blob: workers (`new Worker(URL.createObjectURL(...))`) for decompression,
 *   • `eval()` — the Emscripten glue in compression/extract7z.js builds its
 *     `ccall` wrappers with `eval(...)`. That call is not wrapped in try/catch,
 *     so blocking it stalls the loader at "Decompress game core" with a grey
 *     screen and no error. `'unsafe-eval'` also covers the WASM case, but
 *     `'wasm-unsafe-eval'` is kept listed to document the distinct requirement.
 *
 * SharedArrayBuffer is feature-detected by EmulatorJS and only required when
 * EJS_threads is set (we do not set it), so no COOP/COEP isolation is needed.
 */
function arcadeSecurityHeaders(): Record<string, string> {
  return {
    ...BASE_SECURITY_HEADERS,
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; child-src 'self' blob:; connect-src 'self' blob: data:; object-src 'none'; frame-ancestors 'self'; base-uri 'self'",
  }
}

function playerSecurityHeaders(): Record<string, string> {
  return { ...BASE_SECURITY_HEADERS, 'Content-Security-Policy': STRICT_CSP }
}

function catalogueSecurityHeaders(): Record<string, string> {
  return { ...BASE_SECURITY_HEADERS, 'Content-Security-Policy': STRICT_CSP }
}

/**
 * The Library app has never run under a CSP — it was served by express.static
 * on 2424, which only set the three headers in app.ts. Introducing `style-src
 * 'self'` here would block React's inline style attributes across the whole
 * Library UI, so this surface keeps exactly the headers it had. Tightening it
 * is a separate change that needs that UI audited first.
 */
function librarySecurityHeaders(): Record<string, string> {
  return { ...BASE_SECURITY_HEADERS }
}

/** Test hooks — the CSP strings are behaviour, and a silent regression here is invisible until a game refuses to boot. */
export function arcadeCspForTest(): string { return arcadeSecurityHeaders()['Content-Security-Policy'] }
export function playerCspForTest(): string { return playerSecurityHeaders()['Content-Security-Policy'] }
export function libraryHeadersForTest(): Record<string, string> { return librarySecurityHeaders() }

/** Paths the Express app owns, at the root, shared by every surface. */
function isApiPath(pathname: string): boolean {
  return pathname === '/ping'
    || pathname === '/api/v1'
    || pathname.startsWith('/api/v1/')
    || pathname.startsWith('/media/')
}

export interface SurfaceMount {
  /** URL prefix without trailing slash, e.g. "/player". */
  prefix: string
  /** Built SPA directory. */
  distDir: string
  headers: (path: string) => Record<string, string>
}

export interface GatewayOptions {
  libraryDir: string
  playerDir: string
  catalogueDir: string
  /** Vendored EmulatorJS runtime; defaults to <cwd>/emulatorjs. */
  emulatorDir?: string
  /** Set false to leave the catalogue prefix unmounted. */
  catalogueEnabled?: boolean
}

export function createGateway(mainApp: Express, options: GatewayOptions): Server {
  const emulatorRoot = resolve(options.emulatorDir ?? join(process.cwd(), 'emulatorjs'))

  const surfaces: SurfaceMount[] = [
    {
      prefix: '/library',
      distDir: resolve(options.libraryDir),
      headers: () => librarySecurityHeaders(),
    },
    {
      prefix: '/player',
      distDir: resolve(options.playerDir),
      // The arcade shell ships in the player's public/ directory and needs the
      // relaxed policy; everything else on this surface stays strict.
      headers: path => path.endsWith(`${sep}emu.html`) ? arcadeSecurityHeaders() : playerSecurityHeaders(),
    },
    ...(options.catalogueEnabled === false ? [] : [{
      prefix: '/catalogue',
      distDir: resolve(options.catalogueDir),
      headers: () => catalogueSecurityHeaders(),
    }]),
  ]

  for (const surface of surfaces) {
    if (!existsSync(surface.distDir)) {
      logger.warn(`No build at ${surface.distDir} — ${surface.prefix} will report 503`)
    }
  }

  /** Serves a file from a SPA build, falling back to its index.html for client-side routes. */
  async function serveSurface(req: IncomingMessage, res: ServerResponse, surface: SurfaceMount, subPath: string): Promise<void> {
    const startedAt = performance.now()
    const root = surface.distDir
    let requested: string
    try { requested = decodeURIComponent(subPath) } catch { requested = '/' }

    let path = resolve(root, `.${requested}`)
    // Prevent traversal; anything outside the build falls back to the SPA shell.
    if (path !== root && !path.startsWith(root + sep)) path = join(root, 'index.html')

    let file: Buffer
    try {
      if ((await stat(path)).isDirectory()) path = join(path, 'index.html')
      file = await readFile(path)
    } catch {
      path = join(root, 'index.html')
      try {
        file = await readFile(path)
      } catch {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', ...BASE_SECURITY_HEADERS })
        res.end(`${surface.prefix.slice(1)} UI build is not available`)
        return
      }
    }

    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': path.includes(sep + 'assets' + sep) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Server-Timing': `static;dur=${(performance.now() - startedAt).toFixed(1)}`,
      ...surface.headers(path),
    })
    res.end(req.method === 'HEAD' ? undefined : file)
  }

  /**
   * Serves the vendored EmulatorJS runtime. Deliberately does NOT fall back to
   * an SPA shell: a missing core would otherwise return 200 text/html, which
   * EmulatorJS then tries to parse as a WASM archive and fails obscurely.
   */
  async function serveEmulatorAsset(req: IncomingMessage, res: ServerResponse, subPath: string): Promise<void> {
    let requested: string
    try { requested = decodeURIComponent(subPath) } catch { requested = '' }
    const path = resolve(emulatorRoot, `.${sep}${requested}`)
    if (path !== emulatorRoot && !path.startsWith(emulatorRoot + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('forbidden')
      return
    }
    try {
      const file = await readFile(path)
      res.writeHead(200, {
        'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...arcadeSecurityHeaders(),
      })
      res.end(req.method === 'HEAD' ? undefined : file)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    }
  }

  const chooser = renderChooser(surfaces.map(surface => surface.prefix))
  function serveChooser(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...BASE_SECURITY_HEADERS,
      // Scoped to this one page, which carries its own <style> block.
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'none'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'",
    })
    res.end(req.method === 'HEAD' ? undefined : chooser)
  }

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const pathname = url.pathname

        if (pathname === '/healthz') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...BASE_SECURITY_HEADERS })
          res.end(JSON.stringify({ status: 'ok', service: 'archivist' }))
          return
        }

        if (isApiPath(pathname)) { mainApp(req, res); return }

        if (pathname === '/emulatorjs' || pathname.startsWith('/emulatorjs/')) {
          await serveEmulatorAsset(req, res, pathname.slice('/emulatorjs/'.length))
          return
        }

        for (const surface of surfaces) {
          if (pathname === surface.prefix) {
            // Without the trailing slash the SPA's relative asset URLs would
            // resolve against the parent path.
            res.writeHead(308, { Location: `${surface.prefix}/${url.search}` })
            res.end()
            return
          }
          if (pathname.startsWith(`${surface.prefix}/`)) {
            await serveSurface(req, res, surface, pathname.slice(surface.prefix.length))
            return
          }
        }

        if (pathname === '/') { serveChooser(req, res); return }

        // An unrecognised path is usually a bookmark from the old per-port
        // layout (e.g. /films, which now lives at /server/films). Send browsers
        // to the chooser and everything else a plain 404.
        if ((req.headers.accept ?? '').includes('text/html')) {
          res.writeHead(302, { Location: '/' })
          res.end()
          return
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...BASE_SECURITY_HEADERS })
        res.end('not found')
      } catch (err) {
        logger.error(`Gateway error on ${req.method} ${req.url}:`, err instanceof Error ? err.stack ?? err.message : String(err))
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('error')
      }
    })()
  })
}

const SURFACE_COPY: Record<string, { name: string; blurb: string }> = {
  '/library': { name: 'Library', blurb: 'Collection, acquisition, indexers and system settings' },
  '/player': { name: 'Player', blurb: 'Browse, stream and pick up where you left off' },
  '/catalogue': { name: 'Catalogue', blurb: 'Universal metadata ingestion, flows and data maintenance' },
}

function renderChooser(prefixes: string[]): string {
  const cards = prefixes.map(prefix => {
    const copy = SURFACE_COPY[prefix] ?? { name: prefix.slice(1), blurb: '' }
    return `<a class="card" href="${prefix}/"><span class="name">${copy.name}</span><span class="blurb">${copy.blurb}</span></a>`
  }).join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Archivist</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#11151c; --muted:#5b6673; --card:#fff; --line:#e2e6eb; --accent:#00a0c6; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e8edf3; --muted:#8b98a8; --card:#161b22; --line:#242c37; --accent:#00d4ff; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:2rem;
         background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width:100%; max-width:44rem; }
  h1 { margin:0 0 .25rem; font-size:1.5rem; letter-spacing:-.01em; }
  p.sub { margin:0 0 2rem; color:var(--muted); }
  .grid { display:grid; gap:.75rem; grid-template-columns:repeat(auto-fit, minmax(13rem, 1fr)); }
  .card { display:flex; flex-direction:column; gap:.35rem; padding:1.1rem 1.2rem; border:1px solid var(--line);
          border-radius:.6rem; background:var(--card); text-decoration:none; color:inherit; transition:border-color .15s, transform .15s; }
  .card:hover, .card:focus-visible { border-color:var(--accent); transform:translateY(-1px); }
  .name { font-weight:600; }
  .blurb { color:var(--muted); font-size:.875rem; }
</style>
</head>
<body>
  <main>
    <h1>Archivist</h1>
    <p class="sub">Choose a surface.</p>
    <div class="grid">${cards}</div>
  </main>
</body>
</html>
`
}
