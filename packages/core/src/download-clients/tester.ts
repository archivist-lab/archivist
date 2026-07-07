import axios from 'axios'
import { Agent } from 'https'
import type { DownloadClient } from './store.js'
import { TIMEOUT_DEFAULT, TIMEOUT_LONG } from '../utils/constants.js'
import { createLogger } from '../utils/logger.js'
import { getSessionSendFn } from './session-registry.js'

const logger = createLogger('DownloadClient')
const httpsAgent = new Agent({ rejectUnauthorized: false })

export interface TestResult {
  success: boolean
  message: string
  version?: string
  duration: number
}

export async function testDownloadClient(client: Pick<DownloadClient, 'type' | 'host' | 'port' | 'useSsl' | 'urlBase' | 'username' | 'password'>): Promise<TestResult> {
  const start = Date.now()
  const urlBase = (client.urlBase ?? '').replace(/\/$/, '')
  const base = `http${client.useSsl ? 's' : ''}://${client.host}:${client.port}${urlBase}`

  try {
    switch (client.type) {
      case 'built-in': {
        const fn = getSessionSendFn()
        return fn
          ? { success: true, message: 'Built-in torrent engine is running', version: '1.0.0', duration: Date.now() - start }
          : { success: false, message: 'Built-in torrent engine not initialized', duration: Date.now() - start }
      }
      case 'transmission': {
        const rpcUrl = urlBase.endsWith('/rpc') ? base : `${base}/rpc`
        return await testTransmission(rpcUrl, client, start)
      }
      case 'qbittorrent':  return await testQbittorrent(base, client, start)
      default: return { success: false, message: `Client type '${client.type}' not supported`, duration: Date.now() - start }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, message: msg, duration: Date.now() - start }
  }
}

async function testTransmission(rpcUrl: string, client: Pick<DownloadClient, 'username' | 'password'>, start: number): Promise<TestResult> {
  const auth = client.username
    ? { Authorization: `Basic ${Buffer.from(`${client.username}:${client.password ?? ''}`).toString('base64')}` }
    : {}

  // Step 1: Get session ID (Transmission returns 409 on first request)
  let sessionId = ''
  try {
    await axios.post(rpcUrl, { method: 'session-get' }, { headers: auth, timeout: TIMEOUT_DEFAULT })
  } catch (err: unknown) {
    const axiosErr = err as { response?: { status: number; headers: Record<string, string> } }
    if (axiosErr?.response?.status === 409) {
      sessionId = axiosErr.response.headers['x-transmission-session-id'] ?? ''
    } else if (axiosErr?.response?.status === 401) {
      return { success: false, message: 'Authentication failed — check username and password', duration: Date.now() - start }
    } else {
      throw err
    }
  }

  // Step 2: Actual request with session ID
  const res = await axios.post(
    rpcUrl,
    { method: 'session-get', arguments: {} },
    { headers: { ...auth, 'X-Transmission-Session-Id': sessionId }, timeout: TIMEOUT_DEFAULT }
  )

  return {
    success: true,
    message: 'Connected',
    version: res.data?.arguments?.version,
    duration: Date.now() - start,
  }
}

async function testQbittorrent(base: string, client: Pick<DownloadClient, 'username' | 'password'>, start: number): Promise<TestResult> {
  await axios.post(`${base}/api/v2/auth/login`,
    new URLSearchParams({ username: client.username ?? '', password: client.password ?? '' }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: TIMEOUT_DEFAULT }
  )
  const res = await axios.get(`${base}/api/v2/app/version`, { timeout: TIMEOUT_DEFAULT })
  return { success: true, message: 'Connected', version: res.data, duration: Date.now() - start }
}

// ── Send magnet/torrent to download client ────────────────────────────────────

export async function sendToDownloadClient(
  client: DownloadClient,
  downloadUrl: string,
  category?: string,
): Promise<{ success: boolean; message: string; infoHash?: string }> {
  const urlBase = (client.urlBase ?? '').replace(/\/$/, '')
  const base = `http${client.useSsl ? 's' : ''}://${client.host}:${client.port}${urlBase}`
  const cat = category ?? client.category ?? 'archivist'

  logger.info(`Sending to ${client.type} client "${client.name}" at ${base}`)

  try {
    // Built-in TorrentStack engine
    if (client.type === 'built-in') {
      const sendFn = getSessionSendFn()
      if (!sendFn) {
        logger.error('Built-in torrent engine not initialized')
        return { success: false, message: 'Built-in torrent engine is not running' }
      }
      return sendFn(downloadUrl, cat)
    }

    if (client.type === 'transmission') {
      const rpcUrl = urlBase.endsWith('/rpc') ? base : `${base}/rpc`
      const auth = client.username
        ? { Authorization: `Basic ${Buffer.from(`${client.username}:${client.password ?? ''}`).toString('base64')}` }
        : {}

      let sessionId = ''
      try {
        await axios.post(rpcUrl, { method: 'session-get' }, { headers: auth, timeout: TIMEOUT_DEFAULT })
      } catch (err: unknown) {
        const axiosErr = err as { response?: { status: number; headers: Record<string, string> } }
        if (axiosErr?.response?.status === 409) {
          sessionId = axiosErr.response.headers['x-transmission-session-id'] ?? ''
          logger.debug(`Transmission session ID obtained: ${sessionId.slice(0, 8)}...`)
        } else {
          logger.warn(`Transmission session ID fetch failed: ${axiosErr?.response?.status || 'no status'}`)
        }
      }

      let payload: any
      if (downloadUrl.startsWith('magnet:')) {
        payload = {
          method: 'torrent-add',
          arguments: { filename: downloadUrl, paused: false, labels: [cat] },
        }
      } else {
        logger.info(`Fetching .torrent from ${downloadUrl.slice(0, 100)}...`)
        const fetched = await fetchTorrent(downloadUrl)
        if (!fetched.ok) {
          logger.error(`Failed to fetch torrent: ${fetched.error}`)
          return { success: false, message: `Failed to fetch torrent: ${fetched.error}` }
        }
        if (fetched.magnet) {
          downloadUrl = fetched.magnet
          payload = {
            method: 'torrent-add',
            arguments: { filename: downloadUrl, paused: false, labels: [cat] },
          }
        } else {
          payload = {
            method: 'torrent-add',
            arguments: { metainfo: fetched.metainfo, paused: false, labels: [cat] },
          }
        }
      }

      const res = await axios.post(rpcUrl, payload, {
        headers: { ...auth, 'X-Transmission-Session-Id': sessionId },
        timeout: TIMEOUT_LONG
      })

      const result = res.data?.result
      if (result && result !== 'success') {
        if (result === 'duplicate torrent') {
          logger.info(`Torrent already exists in Transmission: ${downloadUrl.slice(0, 50)}...`)
          const existingHash = res.data?.arguments?.['torrent-duplicate']?.hashString
          return { success: true, message: 'Torrent already in Transmission', infoHash: existingHash }
        }
        logger.error(`Transmission RPC error: ${result}`)
        return { success: false, message: `Transmission error: ${result}` }
      }

      const infoHash = res.data?.arguments?.['torrent-added']?.hashString
      logger.info(`Successfully sent to Transmission: ${client.name} (Hash: ${infoHash})`)
      return { success: true, message: `Sent to ${client.name}`, infoHash }
    }

    if (client.type === 'qbittorrent') {
      logger.debug(`Logging into qBittorrent...`)
      await axios.post(`${base}/api/v2/auth/login`,
        new URLSearchParams({ username: client.username ?? '', password: client.password ?? '' }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: TIMEOUT_DEFAULT }
      )

      let infoHash: string | undefined
      if (downloadUrl.startsWith('magnet:')) {
        const match = downloadUrl.match(/xt=urn:btih:([a-fA-F0-9]+)/) || downloadUrl.match(/xt=urn:btih:([a-zA-Z2-7]+)/)
        if (match) infoHash = match[1].toLowerCase()
      }

      logger.debug(`Adding torrent to qBittorrent...`)
      await axios.post(`${base}/api/v2/torrents/add`,
        new URLSearchParams({ urls: downloadUrl, category: cat }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: TIMEOUT_LONG }
      )
      logger.info(`Successfully sent to qBittorrent: ${client.name}${infoHash ? ` (Hash: ${infoHash})` : ''}`)
      return { success: true, message: `Sent to ${client.name}`, infoHash }
    }

    return { success: false, message: `Client type '${client.type}' not supported` }
  } catch (err) {
    const msg = flattenError(err)
    logger.error(`Failed to send to ${client.type} client "${client.name}": ${msg}`)
    return { success: false, message: msg }
  }
}

type FetchTorrentResult =
  | { ok: true; magnet: string; metainfo?: undefined }
  | { ok: true; magnet?: undefined; metainfo: string }
  | { ok: false; error: string }

async function fetchTorrent(url: string): Promise<FetchTorrentResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 1000))
      logger.warn(`Retrying torrent fetch (attempt ${attempt + 1})...`)
    }
    try {
      let currentUrl = url
      for (let hop = 0; hop < 5; hop++) {
        if (currentUrl.startsWith('magnet:')) return { ok: true, magnet: currentUrl }

        const tRes = await axios.get(currentUrl, {
          responseType: 'arraybuffer',
          timeout: TIMEOUT_LONG,
          maxRedirects: 0,
          httpsAgent,
          validateStatus: (status) => status >= 200 && status < 400,
        })

        if (tRes.status >= 300 && tRes.status < 400) {
          const next = tRes.headers.location
          if (!next) break
          currentUrl = next.startsWith('/') ? (() => { const u = new URL(currentUrl); return `${u.protocol}//${u.host}${next}` })() : next
          continue
        }

        return { ok: true, metainfo: Buffer.from(tRes.data).toString('base64') }
      }
    } catch (err: any) {
      const foundMagnet = err.config?.url?.startsWith('magnet:') ? err.config.url : undefined
      if (foundMagnet) return { ok: true, magnet: foundMagnet }
      if (attempt === 1) return { ok: false, error: flattenError(err) }
    }
  }
  return { ok: false, error: 'Could not fetch torrent after retries' }
}

function flattenError(err: unknown): string {
  if (!err) return 'Unknown error'
  if (err instanceof AggregateError && err.errors?.length) {
    return err.errors.map((e: unknown) => (e instanceof Error ? e.message || e.constructor.name : String(e))).join('; ')
  }
  if (err instanceof Error) {
    // Axios wraps connection errors; the real message is often in err.cause
    const cause = (err as any).cause
    if (cause) return flattenError(cause)
    const code = (err as any).code as string | undefined
    const status = (err as any).response?.status as number | undefined
    const msg = err.message
    if (msg) return status ? `HTTP ${status}: ${msg}` : msg
    if (code) return code
    return err.constructor.name
  }
  return String(err)
}
