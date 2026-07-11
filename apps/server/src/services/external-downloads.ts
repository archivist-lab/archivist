import axios from 'axios'
import { createLogger, TransmissionClient, type DownloadClient } from '@archivist/core'
import { getDb } from '../db.js'
import { ScopedDownloadClientStore } from '../shared/download-clients.js'

export interface MonitorTorrent {
  id: string
  infoHash: string
  name: string
  status: string
  progress: number
  downloadDir: string
  sourcePath: string
  files: Array<{
    name: string
    sizeBytes: number
    downloadedBytes: number
    progress: number
    wanted: boolean
  }>
}

const logger = createLogger('ExternalDownloads')
const externalFiles = new Map<string, MonitorTorrent['files']>()

function allExternalClients(): DownloadClient[] {
  const db = getDb()
  const scopes = [0, ...(db.prepare('SELECT id FROM libraries').all() as Array<{ id: number }>).map(r => r.id)]
  const byId = new Map<number, DownloadClient>()
  for (const scope of scopes) {
    for (const client of new ScopedDownloadClientStore(db, scope).getAll()) {
      if (client.enabled && (client.type === 'transmission' || client.type === 'qbittorrent')) byId.set(client.id, client)
    }
  }
  return [...byId.values()]
}

function qbitBase(client: DownloadClient): string {
  const urlBase = (client.urlBase ?? '').replace(/\/$/, '')
  return `http${client.useSsl ? 's' : ''}://${client.host}:${client.port}${urlBase}`
}

async function qbitSession(client: DownloadClient): Promise<{ base: string; cookie?: string }> {
  const base = qbitBase(client)
  const response = await axios.post(
    `${base}/api/v2/auth/login`,
    new URLSearchParams({ username: client.username ?? '', password: client.password ?? '' }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
  )
  return { base, cookie: response.headers['set-cookie']?.[0]?.split(';')[0] }
}

async function loadQbit(client: DownloadClient): Promise<MonitorTorrent[]> {
  const { base, cookie } = await qbitSession(client)
  const headers = cookie ? { Cookie: cookie } : undefined
  const response = await axios.get(`${base}/api/v2/torrents/info`, { headers, timeout: 10_000 })
  const out: MonitorTorrent[] = []

  for (const torrent of response.data ?? []) {
    let rawFiles: any[] = []
    try {
      const files = await axios.get(`${base}/api/v2/torrents/files`, {
        params: { hash: torrent.hash },
        headers,
        timeout: 10_000,
      })
      rawFiles = files.data ?? []
    } catch {
      // Single-file torrents still expose enough aggregate data to import.
    }

    const files = rawFiles.map(file => ({
      name: String(file.name),
      sizeBytes: Number(file.size ?? 0),
      downloadedBytes: Math.round(Number(file.size ?? 0) * Number(file.progress ?? 0)),
      progress: Number(file.progress ?? 0),
      wanted: Number(file.priority ?? 1) !== 0,
    }))
    const id = `qbit:${client.id}:${torrent.hash}`
    externalFiles.set(id, files)
    out.push({
      id,
      infoHash: String(torrent.hash).toLowerCase(),
      name: String(torrent.name),
      status: Number(torrent.progress) >= 0.999 || /UP|uploading/i.test(String(torrent.state)) ? 'seeding' : String(torrent.state),
      progress: Number(torrent.progress ?? 0),
      downloadDir: String(torrent.save_path ?? ''),
      sourcePath: String(torrent.content_path || `${torrent.save_path ?? ''}/${torrent.name}`),
      files,
    })
  }
  return out
}

async function loadTransmission(client: DownloadClient): Promise<MonitorTorrent[]> {
  const torrents = await new TransmissionClient(client).getAllTorrents()
  return torrents.map(torrent => {
    const files = (torrent.files ?? []).map((file, index) => ({
      name: file.name,
      sizeBytes: file.length,
      downloadedBytes: file.bytesCompleted,
      progress: file.length > 0 ? file.bytesCompleted / file.length : 0,
      wanted: torrent.fileStats?.[index]?.wanted !== false,
    }))
    const id = `trans:${client.id}:${torrent.id}`
    externalFiles.set(id, files)
    return {
      id,
      infoHash: torrent.hashString.toLowerCase(),
      name: torrent.name,
      status: torrent.percentDone >= 0.999 || torrent.status === 6 || torrent.isFinished ? 'seeding' : 'downloading',
      progress: torrent.percentDone,
      downloadDir: torrent.downloadDir,
      sourcePath: `${torrent.downloadDir.replace(/\/$/, '')}/${torrent.name}`,
      files,
    }
  })
}

export async function loadExternalTorrents(): Promise<MonitorTorrent[]> {
  const snapshots = await Promise.all(allExternalClients().map(async client => {
    try {
      return client.type === 'qbittorrent' ? await loadQbit(client) : await loadTransmission(client)
    } catch (err) {
      logger.warn(
        `Could not poll ${client.type} client "${client.name}":`,
        err instanceof Error ? err.message : String(err),
      )
      return []
    }
  }))
  return snapshots.flat()
}

function externalClient(clientId: number): DownloadClient | undefined {
  return allExternalClients().find(client => client.id === clientId)
}

export function getExternalTorrentFiles(torrentId: string): MonitorTorrent['files'] | undefined {
  return externalFiles.get(torrentId)
}

export function getExternalTorrentController(torrentId: string): {
  stopTorrent: (id: string) => Promise<void>
  removeTorrent: (id: string, deleteData: boolean) => Promise<void>
} | null {
  const match = torrentId.match(/^(qbit|trans):(\d+):(.+)$/)
  if (!match) return null
  const [, type, clientIdText, remoteId] = match
  const client = externalClient(Number(clientIdText))
  if (!client) return null

  if (type === 'trans') {
    const transmission = new TransmissionClient(client)
    const id = Number(remoteId)
    return {
      stopTorrent: async () => transmission.pauseTorrent(id),
      removeTorrent: async (_id, deleteData) => transmission.removeTorrent(id, deleteData),
    }
  }

  return {
    stopTorrent: async () => {
      const { base, cookie } = await qbitSession(client)
      const request = (action: 'stop' | 'pause') => axios.post(
        `${base}/api/v2/torrents/${action}`,
        new URLSearchParams({ hashes: remoteId }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
          timeout: 10_000,
        },
      )
      try { await request('stop') } catch { await request('pause') }
    },
    removeTorrent: async (_id, deleteData) => {
      const { base, cookie } = await qbitSession(client)
      await axios.post(`${base}/api/v2/torrents/delete`, new URLSearchParams({
        hashes: remoteId,
        deleteFiles: String(deleteData),
      }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
        timeout: 10_000,
      })
    },
  }
}
