/**
 * Player frontend listener — the consumption UI, served in-process on its own
 * port (default 4242) by the same server that runs the admin API on 2424.
 *
 * This replaces the previously separate `archivist-player` container. It keeps
 * the same guarantees that container gave:
 *   - Only the stable `/api/v1/player` contract and protected `/media/` assets
 *     are exposed on this port; the admin API is unreachable here (any other
 *     path falls through to the player SPA), so 4242 stays a limited surface.
 *   - The service token is injected server-side, so the browser never sees it.
 *
 * Instead of proxying over HTTP to an upstream, it delegates matching requests
 * straight to the main Express app in the same process.
 */

import { createServer, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Express } from 'express'
import { createLogger } from '@archivist/core'

const _logger = createLogger('PlayerFrontend')

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

/**
 * CSP for the arcade surface only (/emu.html and /emulatorjs/*). The rest of the
 * Player — and the whole admin app — keep the strict policy below.
 *
 * EmulatorJS needs three things the default `script-src 'self'` forbids:
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
    ...playerSecurityHeaders(),
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; child-src 'self' blob:; connect-src 'self' blob: data:; object-src 'none'; frame-ancestors 'self'; base-uri 'self'",
  }
}

/** Test hooks — the CSP strings are behaviour, and a silent regression here is invisible until a game refuses to boot. */
export function arcadeCspForTest(): string { return arcadeSecurityHeaders()['Content-Security-Policy'] }
export function playerCspForTest(): string { return playerSecurityHeaders()['Content-Security-Policy'] }

function playerSecurityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  }
}

/** Is this a request the main app should handle (player API or protected media)? */
function isDelegated(pathname: string): boolean {
  return pathname === '/api/v1/player'
    || pathname.startsWith('/api/v1/player/')
    || pathname.startsWith('/media/')
}

/** Arcade assets are served here rather than by the admin app, so 2424 has no arcade surface. */
const EJS_PREFIX = '/emulatorjs/'
function ejsDir(): string {
  return resolve(process.env.ARCHIVIST_EJS_DIR ?? join(process.cwd(), 'emulatorjs'))
}

export function createPlayerFrontend(mainApp: Express, opts: { distDir: string; serviceToken: string }): Server {
  const DIST = resolve(opts.distDir)
  const token = opts.serviceToken

  async function serveStatic(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string): Promise<void> {
    const startedAt = performance.now()
    let requested: string
    try { requested = decodeURIComponent(pathname) } catch { requested = '/' }
    let path = resolve(DIST, '.' + requested)
    // Prevent path traversal; anything outside DIST falls back to the SPA shell.
    if (path !== DIST && !path.startsWith(DIST + sep)) path = join(DIST, 'index.html')

    let file: Buffer
    try {
      const metadata = await stat(path)
      if (metadata.isDirectory()) path = join(path, 'index.html')
      file = await readFile(path)
    } catch {
      path = join(DIST, 'index.html')
      file = await readFile(path)
    }

    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': path.includes(sep + 'assets' + sep) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Server-Timing': `static;dur=${(performance.now() - startedAt).toFixed(1)}`,
      ...(path.endsWith(`${sep}emu.html`) ? arcadeSecurityHeaders() : playerSecurityHeaders()),
    })
    res.end(req.method === 'HEAD' ? undefined : file)
  }

  /**
   * Serves the vendored EmulatorJS runtime. Deliberately does NOT fall back to
   * the SPA shell: a missing core would otherwise return 200 text/html, which
   * EmulatorJS then tries to parse as a WASM archive and fails obscurely.
   */
  async function serveEmulatorAsset(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string): Promise<void> {
    const root = ejsDir()
    let requested: string
    try { requested = decodeURIComponent(pathname.slice(EJS_PREFIX.length)) } catch { requested = '' }
    const path = resolve(root, '.' + sep + requested)
    if (path !== root && !path.startsWith(root + sep)) {
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

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')

        if (url.pathname === '/healthz') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ status: 'ok' }))
          return
        }

        if (url.pathname.startsWith(EJS_PREFIX)) {
          await serveEmulatorAsset(req, res, url.pathname)
          return
        }

        if (isDelegated(url.pathname)) {
          // Inject the service token so the browser never carries it and the
          // main app's auth passes, then hand the raw request to Express.
          if (token) req.headers['x-api-key'] = token
          mainApp(req, res)
          return
        }

        await serveStatic(req, res, url.pathname)
      } catch {
        if (!res.headersSent) res.writeHead(500)
        res.end('error')
      }
    })()
  })
}
