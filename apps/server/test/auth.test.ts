import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness

test('boot with API key', async () => {
  h = await startTestApp({ apiKey: 'secret-key-123' })
})

after(async () => { await h?.close() })

test('/ping stays public with auth enabled', async () => {
  const res = await h.request('GET', '/ping')
  assert.equal(res.status, 200)
})

test('/api/v1/health stays public with auth enabled', async () => {
  const res = await h.request('GET', '/api/v1/health')
  assert.equal(res.status, 200)
})

test('protected route rejects missing key', async () => {
  const res = await h.request('GET', '/api/v1/tabs')
  assert.equal(res.status, 401)
})

test('protected route rejects invalid key', async () => {
  const res = await h.request('GET', '/api/v1/tabs', { headers: { 'x-api-key': 'wrong' } })
  assert.equal(res.status, 401)
})

test('protected route accepts X-API-Key', async () => {
  const res = await h.request('GET', '/api/v1/tabs', { headers: { 'x-api-key': 'secret-key-123' } })
  assert.equal(res.status, 200)
})

test('protected route accepts Authorization: Bearer', async () => {
  const res = await h.request('GET', '/api/v1/tabs', { headers: { Authorization: 'Bearer secret-key-123' } })
  assert.equal(res.status, 200)
})
