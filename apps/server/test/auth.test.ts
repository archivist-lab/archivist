import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness
let bootstrapCookie = ''
let userCookie = ''

function cookieFrom(headers: Record<string, string | string[] | undefined>): string {
  return String(headers['set-cookie']).split(';')[0]
}

test('boot with an internal service token and browser auto-auth disabled', async () => {
  h = await startTestApp({ apiKey: 'secret-key-123', autoAuth: false })
})

after(async () => { await h?.close() })

test('/ping stays public', async () => {
  assert.equal((await h.request('GET', '/ping')).status, 200)
})

test('/api/v1/health stays public', async () => {
  assert.equal((await h.request('GET', '/api/v1/health')).status, 200)
})

test('initial status requires the bootstrap login', async () => {
  const res = await h.request('GET', '/api/v1/auth/status')
  assert.deepEqual(res.json, {
    required: true,
    authenticated: false,
    bootstrapRequired: true,
    setupRequired: false,
    username: null,
  })
})

test('protected route rejects missing and invalid service credentials', async () => {
  assert.equal((await h.request('GET', '/api/v1/tabs')).status, 401)
  assert.equal((await h.request('GET', '/api/v1/tabs', { headers: { 'x-api-key': 'wrong' } })).status, 401)
})

test('protected route accepts service credentials only in headers', async () => {
  assert.equal((await h.request('GET', '/api/v1/tabs', { headers: { 'x-api-key': 'secret-key-123' } })).status, 200)
  assert.equal((await h.request('GET', '/api/v1/tabs', { headers: { Authorization: 'Bearer secret-key-123' } })).status, 200)
})

test('browser login does not accept an API key payload', async () => {
  const res = await h.request('POST', '/api/v1/auth/login', { body: { apiKey: 'secret-key-123' } })
  assert.equal(res.status, 401)
  assert.equal(res.json.error, 'Invalid username or password')
})

test('bootstrap login rejects wrong credentials', async () => {
  const res = await h.request('POST', '/api/v1/auth/login', { body: { username: 'archivist', password: 'wrong' } })
  assert.equal(res.status, 401)
})

test('archivist/archivist creates a setup-only HttpOnly session', async () => {
  const login = await h.request('POST', '/api/v1/auth/login', {
    body: { username: 'archivist', password: 'archivist' },
  })
  assert.equal(login.status, 200)
  assert.deepEqual(login.json, { setupRequired: true, username: null })
  bootstrapCookie = cookieFrom(login.headers)
  assert.match(String(login.headers['set-cookie']), /HttpOnly/)
  assert.match(String(login.headers['set-cookie']), /SameSite=Strict/)

  const status = await h.request('GET', '/api/v1/auth/status', { headers: { Cookie: bootstrapCookie } })
  assert.equal(status.json.setupRequired, true)
  assert.equal(status.json.authenticated, false)
  assert.equal((await h.request('GET', '/api/v1/tabs', { headers: { Cookie: bootstrapCookie } })).status, 403)
})

test('account setup requires the bootstrap session and validates credentials', async () => {
  const missing = await h.request('POST', '/api/v1/auth/setup', {
    body: { username: 'taylor', password: 'abc123' },
  })
  assert.equal(missing.status, 401)

  const weak = await h.request('POST', '/api/v1/auth/setup', {
    headers: { Cookie: bootstrapCookie },
    body: { username: 'taylor', password: 'short' },
  })
  assert.equal(weak.status, 400)

  const created = await h.request('POST', '/api/v1/auth/setup', {
    headers: { Cookie: bootstrapCookie },
    body: { username: 'taylor', password: 'abc123' },
  })
  assert.equal(created.status, 201)
  assert.deepEqual(created.json, { username: 'taylor' })
  userCookie = cookieFrom(created.headers)
  assert.notEqual(userCookie, bootstrapCookie)
  assert.equal((await h.request('GET', '/api/v1/tabs', { headers: { Cookie: userCookie } })).status, 200)
})

test('bootstrap credentials and session are invalid after setup', async () => {
  const status = await h.request('GET', '/api/v1/auth/status', { headers: { Cookie: bootstrapCookie } })
  assert.equal(status.json.bootstrapRequired, false)
  assert.equal(status.json.authenticated, false)
  assert.equal((await h.request('POST', '/api/v1/auth/login', {
    body: { username: 'archivist', password: 'archivist' },
  })).status, 401)
})

test('user can create, use, list and revoke a Kodi device credential', async () => {
  const created = await h.request('POST', '/api/v1/auth/devices', {
    headers: { Cookie: userCookie }, body: { name: 'Living Room Kodi' },
  })
  assert.equal(created.status, 201)
  assert.match(created.json.id, /^[a-f0-9]{32}$/)
  assert.equal(typeof created.json.token, 'string')
  const deviceHeaders = { Authorization: `Bearer ${created.json.token}` }
  assert.equal((await h.request('GET', '/api/v1/tabs', { headers: deviceHeaders })).status, 200)
  assert.equal((await h.request('POST', '/api/v1/auth/devices', { headers: deviceHeaders, body: { name: 'Nested' } })).status, 403)

  const devices = await h.request('GET', '/api/v1/auth/devices', { headers: { Cookie: userCookie } })
  assert.equal(devices.status, 200)
  assert.equal(devices.json.devices[0].name, 'Living Room Kodi')
  assert.equal(devices.text.includes(created.json.token), false, 'device token is returned only once')

  assert.equal((await h.request('DELETE', `/api/v1/auth/devices/${created.json.id}`, { headers: { Cookie: userCookie } })).status, 204)
  assert.equal((await h.request('GET', '/api/v1/tabs', { headers: deviceHeaders })).status, 401)
})

test('personal credentials establish a normal session and logout revokes it', async () => {
  assert.equal((await h.request('POST', '/api/v1/auth/login', {
    body: { username: 'taylor', password: 'wrong-password' },
  })).status, 401)

  const login = await h.request('POST', '/api/v1/auth/login', {
    body: { username: 'Taylor', password: 'abc123' },
  })
  assert.equal(login.status, 200)
  assert.deepEqual(login.json, { setupRequired: false, username: 'taylor' })
  const cookie = cookieFrom(login.headers)
  assert.equal((await h.request('GET', '/api/v1/tabs', { headers: { Cookie: cookie } })).status, 200)

  assert.equal((await h.request('POST', '/api/v1/auth/logout', { headers: { Cookie: cookie } })).status, 204)
  assert.equal((await h.request('GET', '/api/v1/tabs', { headers: { Cookie: cookie } })).status, 401)
})

test('query API keys are rejected outside Player streams', async () => {
  assert.equal((await h.request('GET', '/api/v1/tabs?apiKey=secret-key-123')).status, 401)
})

test('the media mount accepts service headers but not query keys', async () => {
  assert.equal((await h.request('GET', '/media/unknown.jpg')).status, 401)
  assert.equal((await h.request('GET', '/media/unknown.jpg?apiKey=secret-key-123')).status, 401)
  assert.equal((await h.request('GET', '/media/unknown.jpg', { headers: { 'x-api-key': 'secret-key-123' } })).status, 404)
})
