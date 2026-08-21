import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

function request(socketPath: string, requestPath: string, method = 'GET', body?: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = http.request({ socketPath, path: requestPath, method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks) }))
    })
    client.on('error', reject)
    client.end(body)
  })
}

test('agent serves approved content over its Unix socket and rejects traversal', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'archivist-agent-integration-'))
  const media = path.join(fixture, 'media')
  const downloads = path.join(fixture, 'downloads')
  const socket = path.join(fixture, 'agent.sock')
  await mkdir(media)
  await mkdir(downloads)
  await writeFile(path.join(media, 'fixture.txt'), 'archivist-agent-fixture')
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/control-agent/src/index.ts'], {
    cwd: path.resolve(import.meta.dirname, '../../..'),
    env: { ...process.env, ARCHIVIST_CONTROL_AGENT_SOCKET: socket, ARCHIVIST_FILESYSTEM_ROOT: fixture, ARCHIVIST_FILE_WRITE_PATHS: fixture, ARCHIVIST_FILE_TRASH_DIR: path.join(fixture, 'trash') },
    stdio: 'ignore',
  })
  try {
    for (let attempt = 0; attempt < 50 && !existsSync(socket); attempt += 1) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(existsSync(socket), true)
    const listing = await request(socket, '/v1/files?root=filesystem&path=media')
    assert.equal(listing.status, 200)
    assert.equal(JSON.parse(listing.body.toString()).entries[0].name, 'fixture.txt')
    const content = await request(socket, '/v1/content?root=filesystem&path=media%2Ffixture.txt')
    assert.equal(content.status, 200)
    assert.equal(content.body.toString(), 'archivist-agent-fixture')
    assert.equal((await request(socket, '/v1/directories', 'POST', JSON.stringify({ root: 'filesystem', path: 'media/new-folder' }))).status, 201)
    assert.equal((await request(socket, '/v1/content?root=filesystem&path=media%2Fnew-folder%2Fupload.txt', 'PUT', 'uploaded')).status, 201)
    assert.equal((await request(socket, '/v1/move', 'POST', JSON.stringify({ root: 'filesystem', source: 'media/new-folder/upload.txt', destination: 'media/new-folder/renamed.txt' }))).status, 200)
    const trashed = await request(socket, '/v1/trash', 'POST', JSON.stringify({ root: 'filesystem', path: 'media/new-folder/renamed.txt' }))
    assert.equal(trashed.status, 200)
    const trashId = JSON.parse(trashed.body.toString()).trashId
    assert.equal(JSON.parse((await request(socket, '/v1/trash')).body.toString()).entries[0].id, trashId)
    assert.equal((await request(socket, '/v1/trash/restore', 'POST', JSON.stringify({ id: trashId }))).status, 200)
    assert.equal((await request(socket, '/v1/content?root=filesystem&path=media%2Fnew-folder%2Frenamed.txt')).body.toString(), 'uploaded')
    assert.equal((await request(socket, '/v1/files?root=filesystem&path=..%2F..%2Fetc')).status, 403)
  } finally {
    if (child.exitCode == null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
  }
})
