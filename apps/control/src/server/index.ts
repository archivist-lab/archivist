import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { controlService, getSnapshot, resolveService, serviceLogs, type ServiceAction } from './host.js'
import { readHistory, recordHistory } from './history.js'
import { getRecoverySnapshot } from './releases.js'
import { AgentError, agentJson, proxyAgentContent, proxyAgentUpload } from './agent.js'

const port = Number(process.env.ARCHIVIST_CONTROL_PORT || 2429)
const host = process.env.ARCHIVIST_CONTROL_HOST || '127.0.0.1'
const token = process.env.ARCHIVIST_CONTROL_TOKEN || ''
const loopbackHost = host === '127.0.0.1' || host === '::1' || host === 'localhost'
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')
const auditDir = path.resolve(process.env.ARCHIVIST_CONTROL_DATA_DIR || path.join(process.cwd(), 'data/control'))
const downloadTickets = new Map<string, { root: string; path: string; expiresAt: number }>()

if (!loopbackHost && !token) throw new Error('ARCHIVIST_CONTROL_TOKEN is required when binding beyond localhost')

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

function authenticated(request: IncomingMessage): boolean {
  if (!token) return false
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  const expectedBuffer = Buffer.from(token)
  const suppliedBuffer = Buffer.from(supplied)
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let value = ''
  for await (const chunk of request) {
    value += chunk
    if (value.length > 8_192) throw new Error('Request body is too large')
  }
  return value ? (JSON.parse(value) as Record<string, unknown>) : {}
}

async function audit(entry: Record<string, unknown>): Promise<void> {
  await mkdir(auditDir, { recursive: true, mode: 0o750 })
  await appendFile(path.join(auditDir, 'actions.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o640 })
}

async function api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false
  if (url.pathname === '/api/v1/health') {
    json(response, 200, { ok: true, authenticated: Boolean(token) })
    return true
  }
  if (!loopbackHost && !authenticated(request)) {
    json(response, 401, { error: 'A valid control token is required' })
    return true
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/overview') {
    json(response, 200, await getSnapshot())
    return true
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/history') {
    json(response, 200, { points: await readHistory(auditDir, Number(url.searchParams.get('hours') || 24)) })
    return true
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/releases') {
    json(response, 200, await getRecoverySnapshot())
    return true
  }
  if (url.pathname === '/api/v1/files/content' && request.method === 'GET') {
    const ticketValue = url.searchParams.get('ticket') || ''
    const ticket = downloadTickets.get(ticketValue)
    if (ticketValue) downloadTickets.delete(ticketValue)
    if (!ticket || ticket.expiresAt < Date.now()) {
      json(response, 401, { error: 'A valid one-time download ticket is required' })
      return true
    }
    const agentPath = `/v1/content?root=${encodeURIComponent(ticket.root)}&path=${encodeURIComponent(ticket.path)}`
    await proxyAgentContent(request, response, agentPath)
    return true
  }
  if (url.pathname.startsWith('/api/v1/files')) {
    if (!token || !authenticated(request)) {
      json(response, 401, { error: 'Unlock File Browser with the control token' })
      return true
    }
    try {
      if (request.method === 'GET' && url.pathname === '/api/v1/files/roots') {
        json(response, 200, await agentJson('/v1/roots'))
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/files') {
        const agentPath = `/v1/files?root=${encodeURIComponent(url.searchParams.get('root') || '')}&path=${encodeURIComponent(url.searchParams.get('path') || '')}`
        json(response, 200, await agentJson(agentPath))
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/files/trash') {
        json(response, 200, await agentJson('/v1/trash'))
        return true
      }
      if (request.method === 'PUT' && url.pathname === '/api/v1/files/content') {
        const root = url.searchParams.get('root') || ''
        const filePath = url.searchParams.get('path') || ''
        if (!root || !filePath) { json(response, 400, { error: 'root and path are required' }); return true }
        const result = await proxyAgentUpload(request, `/v1/content?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}`)
        await audit({ action: 'upload', root, path: filePath, result: result.status < 400 ? 'accepted' : 'failed', remote: request.socket.remoteAddress })
        json(response, result.status, result.value)
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/files/directories') {
        const payload = await body(request)
        const result = await agentJson('/v1/directories', 'POST', payload)
        await audit({ action: 'mkdir', ...payload, result: 'accepted', remote: request.socket.remoteAddress })
        json(response, 201, result)
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/files/move') {
        const payload = await body(request)
        const result = await agentJson('/v1/move', 'POST', payload)
        await audit({ action: 'move', ...payload, result: 'accepted', remote: request.socket.remoteAddress })
        json(response, 200, result)
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/files/trash') {
        const payload = await body(request)
        const result = await agentJson('/v1/trash', 'POST', payload)
        await audit({ action: 'trash', ...payload, result: 'accepted', remote: request.socket.remoteAddress })
        json(response, 200, result)
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/files/trash/restore') {
        const payload = await body(request)
        const result = await agentJson('/v1/trash/restore', 'POST', payload)
        await audit({ action: 'restore', ...payload, result: 'accepted', remote: request.socket.remoteAddress })
        json(response, 200, result)
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/files/tickets') {
        const payload = await body(request)
        if (typeof payload.root !== 'string' || typeof payload.path !== 'string') {
          json(response, 400, { error: 'root and path are required' })
          return true
        }
        // Validate containment and existence before issuing a bearer URL.
        const agentPath = `/v1/files?root=${encodeURIComponent(payload.root)}&path=${encodeURIComponent(payload.path.split('/').slice(0, -1).join('/'))}`
        await agentJson(agentPath)
        for (const [ticket, value] of downloadTickets) if (value.expiresAt < Date.now()) downloadTickets.delete(ticket)
        if (downloadTickets.size >= 1_000) {
          json(response, 429, { error: 'Too many pending downloads' })
          return true
        }
        const value = randomBytes(24).toString('base64url')
        downloadTickets.set(value, { root: payload.root, path: payload.path, expiresAt: Date.now() + 30_000 })
        json(response, 201, { ticket: value, expiresInSeconds: 30 })
        return true
      }
    } catch (error) {
      const status = error instanceof AgentError && [400, 403, 404].includes(error.status) ? error.status : 503
      json(response, status, { error: error instanceof Error ? error.message : 'Control agent unavailable' })
      return true
    }
  }

  const logsMatch = url.pathname.match(/^\/api\/v1\/services\/([^/]+)\/logs$/)
  if (request.method === 'GET' && logsMatch) {
    if (!resolveService(logsMatch[1])) {
      json(response, 404, { error: 'Unknown service' })
      return true
    }
    try {
      json(response, 200, { lines: await serviceLogs(logsMatch[1], Number(url.searchParams.get('lines') || 160)) })
    } catch {
      json(response, 503, { error: 'The system journal is unavailable' })
    }
    return true
  }

  const actionMatch = url.pathname.match(/^\/api\/v1\/services\/([^/]+)\/actions$/)
  if (request.method === 'POST' && actionMatch) {
    if (!token) {
      json(response, 503, { error: 'Set ARCHIVIST_CONTROL_TOKEN before enabling service actions' })
      return true
    }
    if (!authenticated(request)) {
      json(response, 401, { error: 'A valid control token is required' })
      return true
    }
    const service = resolveService(actionMatch[1])
    if (!service) {
      json(response, 404, { error: 'Unknown service' })
      return true
    }
    const payload = await body(request)
    const action = payload.action
    if (action !== 'start' && action !== 'stop' && action !== 'restart') {
      json(response, 400, { error: 'Action must be start, stop, or restart' })
      return true
    }
    try {
      await controlService(service.id, action as ServiceAction)
      await audit({ service: service.id, unit: service.unit, action, result: 'accepted', remote: request.socket.remoteAddress })
      json(response, 202, { ok: true })
    } catch {
      await audit({ service: service.id, unit: service.unit, action, result: 'failed', remote: request.socket.remoteAddress })
      json(response, 503, { error: `Unable to ${action} ${service.label}` })
    }
    return true
  }
  json(response, 404, { error: 'Not found' })
  return true
}

async function staticFile(response: ServerResponse, url: URL): Promise<void> {
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')
  const candidate = path.resolve(publicDir, requested)
  const safeCandidate = candidate.startsWith(`${publicDir}${path.sep}`) ? candidate : path.join(publicDir, 'index.html')
  let finalPath = safeCandidate
  try {
    const info = await stat(finalPath)
    if (!info.isFile()) finalPath = path.join(publicDir, 'index.html')
  } catch {
    finalPath = path.join(publicDir, 'index.html')
  }
  try {
    const contents = await readFile(finalPath)
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(finalPath)] || 'application/octet-stream',
      'Cache-Control': finalPath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    })
    response.end(contents)
  } catch {
    json(response, 503, { error: 'Control UI has not been built' })
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    if (!(await api(request, response, url))) await staticFile(response, url)
  } catch (error) {
    const message = error instanceof SyntaxError ? 'Invalid JSON body' : 'Request failed'
    json(response, 400, { error: message })
  }
})

server.listen(port, host, () => {
  process.stdout.write(`Archivist Control listening on http://${host}:${port}${token ? '' : ' (read-only: no control token configured)'}\n`)
})

async function sampleTelemetry(): Promise<void> {
  try {
    await recordHistory(auditDir, await getSnapshot())
  } catch (error) {
    process.stderr.write(`Unable to record control telemetry: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

void sampleTelemetry()
const telemetryTimer = setInterval(() => void sampleTelemetry(), 60_000)
telemetryTimer.unref?.()

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  clearInterval(telemetryTimer)
  server.close(() => process.exit(0))
})
