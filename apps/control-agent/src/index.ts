import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, stat, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { extname } from 'node:path'
import { configuredRoots, createDirectory, listFiles, listTrash, moveFile, resolveFile, resolveNewFile, restoreTrash, trashFile } from './files.js'

const socketPath = process.env.ARCHIVIST_CONTROL_AGENT_SOCKET || '/run/archivist-control/agent.sock'
const mimeTypes: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.log': 'text/plain; charset=utf-8', '.nfo': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt' }

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let value = ''
  for await (const chunk of request) {
    value += chunk
    if (value.length > 64_000) throw new Error('Request body is too large')
  }
  return value ? JSON.parse(value) as Record<string, unknown> : {}
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://agent')
    if (request.method === 'GET' && url.pathname === '/v1/health') return json(response, 200, { ok: true })
    if (request.method === 'GET' && url.pathname === '/v1/roots') {
      const roots = await Promise.all(configuredRoots().map(async root => {
        try { const resolved = await resolveFile(root.id, ''); return { id: root.id, label: root.label, available: true, path: resolved.root.path } }
        catch { return { id: root.id, label: root.label, available: false, path: null } }
      }))
      return json(response, 200, { roots })
    }
    if (request.method === 'GET' && url.pathname === '/v1/files') {
      return json(response, 200, await listFiles(url.searchParams.get('root') || '', url.searchParams.get('path') || ''))
    }
    if (request.method === 'GET' && url.pathname === '/v1/trash') return json(response, 200, { entries: await listTrash() })
    if (request.method === 'GET' && url.pathname === '/v1/content') {
      const resolved = await resolveFile(url.searchParams.get('root') || '', url.searchParams.get('path') || '')
      const info = await stat(resolved.absolutePath)
      if (!info.isFile()) return json(response, 400, { error: 'Path is not a regular file' })
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(resolved.absolutePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': String(info.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(resolved.relativePath.split('/').at(-1) || 'download')}`,
        'X-Content-Type-Options': 'nosniff',
      })
      createReadStream(resolved.absolutePath).on('error', () => response.destroy()).pipe(response)
      return
    }
    if (request.method === 'PUT' && url.pathname === '/v1/content') {
      const target = await resolveNewFile(url.searchParams.get('root') || '', url.searchParams.get('path') || '')
      await pipeline(request, createWriteStream(target.absolutePath, { flags: 'wx', mode: 0o640 }))
      return json(response, 201, { ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/v1/directories') {
      const payload = await body(request)
      if (typeof payload.root !== 'string' || typeof payload.path !== 'string') return json(response, 400, { error: 'root and path are required' })
      await createDirectory(payload.root, payload.path)
      return json(response, 201, { ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/v1/move') {
      const payload = await body(request)
      if (typeof payload.root !== 'string' || typeof payload.source !== 'string' || typeof payload.destination !== 'string') return json(response, 400, { error: 'root, source, and destination are required' })
      await moveFile(payload.root, payload.source, payload.destination)
      return json(response, 200, { ok: true })
    }
    if (request.method === 'POST' && url.pathname === '/v1/trash') {
      const payload = await body(request)
      if (typeof payload.root !== 'string' || typeof payload.path !== 'string') return json(response, 400, { error: 'root and path are required' })
      return json(response, 200, { ok: true, trashId: await trashFile(payload.root, payload.path) })
    }
    if (request.method === 'POST' && url.pathname === '/v1/trash/restore') {
      const payload = await body(request)
      if (typeof payload.id !== 'string') return json(response, 400, { error: 'id is required' })
      return json(response, 200, { ok: true, path: await restoreTrash(payload.id) })
    }
    json(response, 404, { error: 'Not found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Agent request failed'
    const status = message.includes('Unknown') ? 404 : ['Path is not a directory', 'Path is not a regular file'].includes(message) ? 400 : 403
    json(response, status, { error: message })
  }
})

try { await unlink(socketPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660)
  process.stdout.write(`Archivist Control Agent listening on ${socketPath}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)))
