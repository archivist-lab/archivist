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

const logger = createLogger('PlayerFrontend')

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
}

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
      ...playerSecurityHeaders(),
    })
    res.end(req.method === 'HEAD' ? undefined : file)
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
