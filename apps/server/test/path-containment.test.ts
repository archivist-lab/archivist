import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestHarness } from './helpers.js'

// The file-editing routes take an absolute path from the caller. They used to
// pass it straight to ffprobe/ffmpeg: the containment helper existed but was
// wired to exactly one call site, and it treated an unset ARCHIVIST_ALLOWED_ROOTS
// as "anywhere on the filesystem". An authenticated session could therefore read
// or remux any media file the container could see, well outside the library.

let h: TestHarness

test('boot', async () => { h = await startTestApp() })
after(async () => { await h?.close() })

const OUTSIDE = [
  '/etc/passwd',
  '/etc/shadow',
  '/root/secret.mkv',
  '/var/lib/other-app/movie.mp4',
]

test('file-metadata read rejects paths outside the managed roots', async () => {
  for (const filePath of OUTSIDE) {
    const res = await h.request('POST', '/api/v1/media/file-metadata/read', { body: { filePath } })
    assert.equal(res.status, 400, `${filePath} should be rejected`)
    assert.match(String(res.json.error), /permitted roots/i)
  }
})

test('file-metadata write rejects paths outside the managed roots', async () => {
  const res = await h.request('PUT', '/api/v1/media/file-metadata', {
    body: { filePath: '/etc/hosts', chapters: [{ title: 'x', startTime: 0 }] },
  })
  assert.equal(res.status, 400)
  assert.match(String(res.json.error), /permitted roots/i)
})

test('track cleaning rejects paths outside the managed roots', async () => {
  const res = await h.request('POST', '/api/v1/media/clean-tracks', { body: { filePath: '/root/anything.mkv' } })
  assert.equal(res.status, 400)
  assert.match(String(res.json.error), /permitted roots/i)
})

test('track preview rejects paths outside the managed roots', async () => {
  const res = await h.request('POST', '/api/v1/media/file-metadata/preview', {
    body: { filePath: '/root/anything.mkv', type: 'audio', typeIndex: 0 },
  })
  assert.equal(res.status, 400)
  assert.match(String(res.json.error), /permitted roots/i)
})

test('relative and null-byte paths are rejected', async () => {
  for (const filePath of ['relative/path.mkv', '../../etc/passwd', '/media/films/ok.mkv\0.png']) {
    const res = await h.request('POST', '/api/v1/media/file-metadata/read', { body: { filePath } })
    assert.equal(res.status, 400, `${filePath} should be rejected`)
  }
})

test('declaring a root folder is still allowed outside existing roots', async () => {
  // Configuration differs from operation: you must be able to add a root folder
  // that is not yet inside any root, otherwise the first one can never be created.
  const res = await h.request('POST', '/api/v1/root-folders', { body: { path: `${h.dir}/new-root` } })
  assert.equal(res.status, 201, JSON.stringify(res.json))
})
