import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = join(fileURLToPath(new URL('.', import.meta.url)), 'dist')
const PORT = Number(process.env.PORT ?? 4242)
const UPSTREAM = process.env.ARCHIVIST_UPSTREAM ?? 'http://archivist:2424'
const SERVICE_TOKEN = process.env.ARCHIVIST_SERVICE_TOKEN ?? ''

const MIME = {
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
}

function proxy(req, res, incomingUrl) {
  const target = new URL(incomingUrl.pathname + incomingUrl.search, UPSTREAM)
  const headers = { ...req.headers, host: target.host }
  delete headers.connection
  if (SERVICE_TOKEN) headers['x-api-key'] = SERVICE_TOKEN

  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  const upstream = send(target, { method: req.method, headers }, upstreamResponse => {
    res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Archivist upstream unavailable' }))
  })
  req.on('aborted', () => upstream.destroy())
  req.pipe(upstream)
}

async function serveStatic(req, res, url) {
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  let requested
  try { requested = decodeURIComponent(url.pathname) } catch { requested = '/' }
  let path = resolve(DIST, '.' + requested)
  if (path !== DIST && !path.startsWith(DIST + sep)) path = join(DIST, 'index.html')

  let file
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
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  })
  res.end(req.method === 'HEAD' ? undefined : file)
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/v1/player' || url.pathname.startsWith('/api/v1/player/') || url.pathname.startsWith('/media/')) {
      proxy(req, res, url)
      return
    }
    await serveStatic(req, res, url)
  } catch {
    if (!res.headersSent) res.writeHead(500)
    res.end('error')
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('Archivist Player listening on http://0.0.0.0:' + PORT)
})
