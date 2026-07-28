import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestHarness } from './helpers.js'

// The arcade used to live on the admin surface: /api/v1/arcade plus an
// /emulatorjs static mount on the main app, driven by a Konami listener in the
// admin client. It now belongs to the Player alone — the router is mounted under
// /api/v1/player, and the EmulatorJS assets are served by the Player frontend on
// its own port. These assertions are what stops it drifting back.

let h: TestHarness

test('boot', async () => { h = await startTestApp() })
after(async () => { await h?.close() })

test('the arcade is reachable under the player namespace', async () => {
  const res = await h.request('GET', '/api/v1/player/arcade/library')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.json.systems), 'expected a systems array')
  // The shelf is static metadata; ROM folders are created on demand and empty.
  const ids = res.json.systems.map((s: any) => s.id)
  for (const expected of ['nes', 'snes', 'gameboy', 'genesis', 'n64', 'psx']) {
    assert.ok(ids.includes(expected), `missing system ${expected}`)
  }
})

test('each system reports its core, folder and BIOS readiness', async () => {
  const res = await h.request('GET', '/api/v1/player/arcade/library')
  const psx = res.json.systems.find((s: any) => s.id === 'psx')
  assert.equal(psx.core, 'psx')
  assert.equal(psx.bios, true)
  assert.equal(psx.biosReady, false, 'no BIOS supplied in a fresh install')
  assert.equal(psx.folder, 'media/roms/psx')

  const nes = res.json.systems.find((s: any) => s.id === 'nes')
  assert.equal(nes.bios, false)
  assert.equal(nes.biosReady, true, 'systems without a BIOS requirement are always ready')
})

test('the admin API no longer exposes the arcade', async () => {
  const res = await h.request('GET', '/api/v1/arcade/library')
  assert.equal(res.status, 404, 'admin surface must not serve the arcade')
})

test('the admin app no longer serves EmulatorJS assets', async () => {
  // Previously app.use('/emulatorjs', express.static(...)) on the main app.
  // Those assets are now the Player frontend's responsibility.
  const res = await fetch(`${h.baseUrl}/emulatorjs/loader.js`, { headers: h.authHeaders })
  assert.notEqual(res.status, 200, 'admin port must not serve EmulatorJS')
})

// EmulatorJS's Emscripten decompressor (compression/extract7z.js) builds its
// ccall wrappers with eval(). Under 'wasm-unsafe-eval' alone that call throws —
// uncaught — and the loader hangs on "Decompress game core" showing a grey
// screen with nothing in the UI to indicate why. The arcade CSP must allow it.
test('the arcade CSP permits what EmulatorJS actually needs', async () => {
  const { arcadeCspForTest } = await import('../src/player-frontend.js')
  const csp = arcadeCspForTest()
  assert.match(csp, /'unsafe-eval'/, "extract7z.js calls eval() for its ccall glue")
  assert.match(csp, /'wasm-unsafe-eval'/, 'cores are WebAssembly')
  assert.match(csp, /worker-src [^;]*blob:/, 'decompression runs in a blob worker')
  // The relaxation must stay scoped — these still hold on the arcade surface.
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /frame-ancestors 'self'/)
})

test('the strict player CSP is unchanged by the arcade relaxation', async () => {
  const { playerCspForTest } = await import('../src/player-frontend.js')
  const csp = playerCspForTest()
  assert.doesNotMatch(csp, /unsafe-eval/, 'only the arcade surface may eval')
  assert.doesNotMatch(csp, /blob:.*worker|worker-src/, 'player proper needs no blob workers')
})
