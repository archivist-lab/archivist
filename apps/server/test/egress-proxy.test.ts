import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

const PROXY_SCRIPT = path.resolve(import.meta.dirname, '../../../deploy/vpn-proxy.mjs')

// ─── Fixtures ────────────────────────────────────────────────────────────────

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise<void>(resolve => { probe.close(() => resolve()) })
  return port
}

async function originServer(body: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  }
}

/** Starts the real deploy script, so the test exercises what ships. */
async function startProxy(env: Record<string, string>): Promise<{
  port: number; stop: () => void; child: ChildProcessWithoutNullStreams
}> {
  const port = env.ARCHIVIST_EGRESS_PROXY_PORT ? Number(env.ARCHIVIST_EGRESS_PROXY_PORT) : await freePort()
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    env: { ...process.env, ARCHIVIST_EGRESS_PROXY_PORT: String(port), ...env },
    stdio: 'pipe',
  }) as ChildProcessWithoutNullStreams

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not report listening')), 10_000)
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('listening')) { clearTimeout(timer); resolve() }
    })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`proxy exited early with ${code}`)) })
  })

  return { port, stop: () => child.kill('SIGTERM'), child }
}

// ─── Behaviour ───────────────────────────────────────────────────────────────

test('the egress proxy forwards an absolute-form http request', async () => {
  const origin = await originServer('through-the-proxy')
  const proxy = await startProxy({ ARCHIVIST_EGRESS_PROXY_BIND: '127.0.0.1' })

  try {
    // Absolute-form request URI is the plain-HTTP proxy convention.
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxy.port,
        method: 'GET',
        path: `http://127.0.0.1:${origin.port}/`,
        headers: { host: `127.0.0.1:${origin.port}` },
      }, res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => resolve(data))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(body, 'through-the-proxy')
  } finally {
    proxy.stop()
    await origin.close()
  }
})

test('the egress proxy tunnels CONNECT, which is what the indexer engine uses', async () => {
  const origin = await originServer('tunnelled-via-connect')
  const proxy = await startProxy({ ARCHIVIST_EGRESS_PROXY_BIND: '127.0.0.1' })

  try {
    // undici's ProxyAgent always issues CONNECT, so this is the exact path a
    // configured per-indexer proxyUrl takes in production.
    const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })
    const res = await undiciFetch(`http://127.0.0.1:${origin.port}/`, { dispatcher: agent })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'tunnelled-via-connect')
    await agent.close()
  } finally {
    proxy.stop()
    await origin.close()
  }
})

test('binding beyond loopback without an allow list is refused, not published', async () => {
  const port = await freePort()
  // Publishing an unrestricted forward proxy onto the network must be a
  // decision, never a default.
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    env: {
      ...process.env,
      ARCHIVIST_EGRESS_PROXY_BIND: '0.0.0.0',
      ARCHIVIST_EGRESS_PROXY_PORT: String(port),
      ARCHIVIST_EGRESS_PROXY_ALLOW: '',
    },
    stdio: 'pipe',
  })

  const [code, stderr] = await new Promise<[number | null, string]>(resolve => {
    let err = ''
    child.stderr.on('data', chunk => { err += chunk })
    child.once('exit', exitCode => resolve([exitCode, err]))
  })

  assert.equal(code, 78, 'should exit EX_CONFIG')
  assert.match(stderr, /ARCHIVIST_EGRESS_PROXY_ALLOW/)
})
