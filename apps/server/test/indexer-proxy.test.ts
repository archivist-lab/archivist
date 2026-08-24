import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import { fetch as undiciFetch } from 'undici'
import {
  PROXY_UNAVAILABLE, assertValidProxyUrl, dispatcherForProxy, isSupportedProxyScheme,
  __resetProxyDispatchers, classifyDiagnostics,
} from '@torrentstack/indexer-engine'
import { tierForFailure } from '../src/indexers/endpoints/scoring.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A port nothing is listening on. Chosen by binding and releasing rather than
 * hardcoded: low ports such as 1 and 9 are on the fetch blocked-port list, so
 * undici rejects them before the connector is ever consulted.
 */
async function closedPort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise<void>(resolve => { probe.close(() => resolve()) })
  return port
}

/** A target the proxy is asked to reach. */
async function originServer(body: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return { port, close: () => new Promise<void>(resolve => { server.close(() => resolve()) }) }
}

/**
 * The smallest SOCKS5 server that satisfies the client: no-auth greeting, one
 * CONNECT to an IPv4 destination, then a byte pipe. Enough to prove the
 * connector negotiates and tunnels rather than merely failing politely.
 */
async function socks5Server(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer(client => {
    sockets.add(client)
    client.once('data', greeting => {
      // [ver, nmethods, ...methods] — answer "version 5, no authentication".
      if (greeting[0] !== 0x05) return client.destroy()
      client.write(Buffer.from([0x05, 0x00]))

      client.once('data', request => {
        // [ver, cmd, rsv, atyp, addr..., port(2)]
        const atyp = request[3]
        let host: string
        let offset: number
        if (atyp === 0x01) {
          host = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`
          offset = 8
        } else if (atyp === 0x03) {
          const len = request[4]
          host = request.subarray(5, 5 + len).toString()
          offset = 5 + len
        } else {
          return client.destroy()
        }
        const port = request.readUInt16BE(offset)

        const upstream = net.connect({ host, port }, () => {
          sockets.add(upstream)
          // Success, bound address 0.0.0.0:0 — clients ignore it for CONNECT.
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          client.pipe(upstream).pipe(client)
        })
        upstream.on('error', () => client.destroy())
      })
    })
    client.on('error', () => { /* torn down with the test */ })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

// ─── Configuration validation ────────────────────────────────────────────────

test('proxy URLs are validated before they are ever used', () => {
  assert.doesNotThrow(() => assertValidProxyUrl('http://127.0.0.1:8888'))
  assert.doesNotThrow(() => assertValidProxyUrl('https://user:pass@proxy.example:3128'))
  assert.doesNotThrow(() => assertValidProxyUrl('socks5://127.0.0.1:1080'))

  // A scheme we cannot honour must fail loudly at configuration time rather
  // than silently sending traffic direct.
  assert.throws(() => assertValidProxyUrl('ftp://127.0.0.1:21'), /Unsupported proxy scheme/)
  assert.throws(() => assertValidProxyUrl('not a url'), /Invalid proxy URL/)

  assert.equal(isSupportedProxyScheme('socks5:'), true)
  assert.equal(isSupportedProxyScheme('ftp:'), false)
})

test('no proxy configured leaves the default dispatcher in place', () => {
  // The unproxied path must keep using Node's global fetch untouched.
  assert.equal(dispatcherForProxy(undefined), undefined)
  assert.equal(dispatcherForProxy(''), undefined)
  assert.equal(dispatcherForProxy('   '), undefined)
})

test('dispatchers are pooled per proxy URL', async () => {
  const first = dispatcherForProxy('socks5://127.0.0.1:1080')
  const second = dispatcherForProxy('socks5://127.0.0.1:1080')
  const other = dispatcherForProxy('socks5://127.0.0.1:1081')

  // Building one per request would leak sockets under a probe sweep.
  assert.equal(first, second)
  assert.notEqual(first, other)
  await __resetProxyDispatchers()
})

// ─── Tunnelling ──────────────────────────────────────────────────────────────

test('a SOCKS5 proxy actually carries the request to the origin', async () => {
  const origin = await originServer('tunnelled-body')
  const proxy = await socks5Server()

  try {
    const dispatcher = dispatcherForProxy(`socks5://127.0.0.1:${proxy.port}`)
    assert.ok(dispatcher, 'a socks5 URL must produce a dispatcher')

    const res = await undiciFetch(`http://127.0.0.1:${origin.port}/`, { dispatcher })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'tunnelled-body')
  } finally {
    await __resetProxyDispatchers()
    await proxy.close()
    await origin.close()
  }
})

test('a proxy that cannot be reached is not the endpoint\'s fault', async () => {
  // The origin is live, so the only thing that can fail is the tunnel itself.
  const origin = await originServer('never-reached')
  const deadProxy = await closedPort()
  const dispatcher = dispatcherForProxy(`socks5://127.0.0.1:${deadProxy}`)
  assert.ok(dispatcher)

  try {
    await undiciFetch(`http://127.0.0.1:${origin.port}/`, { dispatcher })
    assert.fail('request through a dead proxy should reject')
  } catch (err: any) {
    // The code must survive undici's wrapping, or the classifier cannot see it.
    const code = err?.cause?.code ?? err?.code
    assert.equal(code, PROXY_UNAVAILABLE)
  } finally {
    await __resetProxyDispatchers()
    await origin.close()
  }
})

// ─── Verdicts ────────────────────────────────────────────────────────────────

test('an unreachable proxy never demotes an endpoint', () => {
  // Same reasoning as a saturated bypass: the endpoint was never contacted.
  assert.equal(
    classifyDiagnostics({ transportCode: PROXY_UNAVAILABLE }).failureClass,
    'proxy_unavailable',
  )
  assert.equal(tierForFailure('proxy_unavailable'), 'unknown')

  // It must not fall through to the generic transport branch, which scores
  // an unknown code `connect` and therefore tier D.
  assert.notEqual(tierForFailure('proxy_unavailable'), 'D')
})
