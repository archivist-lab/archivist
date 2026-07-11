import axios from 'axios'
import type { DownloadClient } from './store.js'
import { TIMEOUT_DEFAULT, TIMEOUT_LONG } from '../utils/constants.js'

export interface Torrent {
  id: number
  name: string
  status: number
  percentDone: number
  rateDownload: number
  rateUpload: number
  sizeWhenDone: number
  eta: number
  error: number
  errorString: string
  isFinished: boolean
  hashString: string
  downloadDir: string
  labels?: string[]
  files?: Array<{ name: string; length: number; bytesCompleted: number }>
  fileStats?: Array<{ wanted: boolean; priority: number; bytesCompleted: number }>
}

export class TransmissionClient {
  private sessionId = ''
  private rpcUrl: string
  private auth: Record<string, string>

  constructor(private config: DownloadClient) {
    const urlBase = (config.urlBase ?? '').replace(/\/$/, '')
    const base = `http${config.useSsl ? 's' : ''}://${config.host}:${config.port}${urlBase}`
    this.rpcUrl = urlBase.endsWith('/rpc') ? base : `${base}/rpc`
    this.auth = config.username
      ? { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password ?? ''}`).toString('base64')}` }
      : {}
  }

  private async request(method: string, args: any = {}): Promise<any> {
    const makeReq = async (sid: string) => {
      return axios.post(
        this.rpcUrl,
        { method, arguments: args },
        { 
          headers: { ...this.auth, 'X-Transmission-Session-Id': sid },
          timeout: TIMEOUT_LONG 
        }
      )
    }

    try {
      const res = await makeReq(this.sessionId)
      return res.data
    } catch (err: any) {
      if (err.response?.status === 409) {
        this.sessionId = err.response.headers['x-transmission-session-id'] ?? ''
        const res = await makeReq(this.sessionId)
        return res.data
      }
      throw err
    }
  }

  async getAllTorrents(): Promise<Torrent[]> {
    const data = await this.request('torrent-get', {
      fields: [
        'id', 'name', 'status', 'percentDone', 'rateDownload', 'rateUpload', 'sizeWhenDone', 'eta', 'error', 'errorString', 'isFinished', 'hashString', 'downloadDir', 'labels', 'files', 'fileStats', 'peersConnected', 'peersGettingFromUs', 'peersSendingToUs'
      ]
    })
    return data.arguments?.torrents || []
  }

  async pauseTorrent(id: number): Promise<void> {
    await this.request('torrent-stop', { ids: [id] })
  }

  async resumeTorrent(id: number): Promise<void> {
    await this.request('torrent-start', { ids: [id] })
  }

  async removeTorrent(id: number, deleteData: boolean): Promise<void> {
    await this.request('torrent-remove', { ids: [id], 'delete-local-data': deleteData })
  }

  async recheckTorrent(id: number): Promise<void> {
    await this.request('torrent-verify', { ids: [id] })
  }
}
