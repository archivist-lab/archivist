import type { Express } from 'express'
import { createServer, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN',
}

function delegated(pathname: string): boolean {
  return pathname === '/ping' || pathname === '/api/v1/auth' || pathname.startsWith('/api/v1/auth/') || pathname === '/api/v1/catalogue' || pathname.startsWith('/api/v1/catalogue/')
}

export function createCatalogueSpaFrontend(mainApp: Express, options: { distDir: string }): Server {
  const root = resolve(options.distDir)
  async function serve(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) {
    let requested: string
    try { requested = decodeURIComponent(pathname) } catch { requested = '/' }
    let path = resolve(root, `.${requested}`)
    if (path !== root && !path.startsWith(`${root}${sep}`)) path = join(root, 'index.html')
    try { if ((await stat(path)).isDirectory()) path = join(path, 'index.html') } catch { path = join(root, 'index.html') }
    try {
      const file = await readFile(path)
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache', ...SECURITY_HEADERS })
      res.end(req.method === 'HEAD' ? undefined : file)
    } catch {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
      res.end('Catalogue UI build is not available')
    }
  }
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(JSON.stringify({ status: 'ok', service: 'archivist-catalogue' })); return }
        if (delegated(url.pathname)) { mainApp(req, res); return }
        await serve(req, res, url.pathname)
      } catch {
        if (!res.headersSent) res.writeHead(500)
        res.end('error')
      }
    })()
  })
}
