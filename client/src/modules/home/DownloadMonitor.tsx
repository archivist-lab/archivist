import { useState, useEffect } from 'react'
import { toast, confirmDialog } from '../../lib/notify.js'
import { request } from '../../lib/api.js'
import { formatSize } from '../../lib/api.js'

type TorrentStatus = 'stopped' | 'queued-check' | 'checking' | 'fetching-metadata' | 'queued-download' | 'downloading' | 'queued-seed' | 'seeding' | 'error'

interface Torrent {
  id: string
  name: string
  status: TorrentStatus
  progress: number
  downloadSpeed: number
  uploadSpeed: number
  sizeBytes: number
  eta: number
  peersConnected: number
  seedsConnected: number
  error: string | null
}

const STATUS_MAP: Record<TorrentStatus, { label: string; color: string }> = {
  'stopped':          { label: 'PAUSED',           color: 'text-white/40' },
  'queued-check':     { label: 'QUEUED',            color: 'text-cyan-500' },
  'checking':         { label: 'CHECKING',          color: 'text-yellow-500' },
  'fetching-metadata':{ label: 'METADATA',          color: 'text-cyan-500' },
  'queued-download':  { label: 'QUEUED',            color: 'text-cyan-500' },
  'downloading':      { label: 'DOWNLOADING',       color: 'text-emerald-500' },
  'queued-seed':      { label: 'QUEUED SEED',       color: 'text-cyan-500' },
  'seeding':          { label: 'SEEDING',           color: 'text-emerald-500' },
  'error':            { label: 'ERROR',             color: 'text-red-500' },
}

export function DownloadMonitor() {
  const [torrents, setTorrents] = useState<Torrent[]>([])
  const [loading, setLoading] = useState(true)

  const fetchTorrents = async () => {
    try {
      const res = await request<{ torrents: Torrent[] }>('/dashboard/downloads')
      setTorrents(res.torrents)
    } catch (err) {
      console.error('Failed to fetch torrents:', err)
    } finally {
      setLoading(false)
    }
  }

  const performAction = async (id: string, action: string, deleteData = false) => {
    const removing = action === 'remove' || action === 'delete'
    if (removing && !await confirmDialog(`Are you sure you want to ${action} this torrent?`)) return
    // Reflect the removal in the UI immediately; the backend catches up in the
    // background and we reconcile against the truth if the request fails.
    if (removing) setTorrents(list => list.filter(t => t.id !== id))
    try {
      await request(`/dashboard/downloads/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: action === 'delete' ? 'remove' : action, deleteData: action === 'delete' })
      })
      if (!removing) fetchTorrents()
    } catch (err) {
      toast.error('Action failed')
      fetchTorrents()
    }
  }

  useEffect(() => {
    fetchTorrents()
    const id = setInterval(fetchTorrents, 5000)
    return () => clearInterval(id)
  }, [])

  if (!loading && torrents.length === 0) return null

  return (
    <div className="space-y-4 mt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-mono text-white/20 uppercase tracking-[0.3em]">Download Monitor</h2>
        <div className="h-px flex-1 bg-white/5 ml-6" />
        <span className="text-[10px] font-mono text-[#00D4FF] uppercase tracking-widest ml-6">{torrents.length} ACTIVE</span>
      </div>

      <div className="bg-noir-900/50 border border-white/5 rounded-3xl overflow-hidden backdrop-blur-sm">
        <div className="divide-y divide-white/5 max-h-[400px] overflow-y-auto custom-scrollbar">
        {torrents.map(t => {
          const status = STATUS_MAP[t.status] ?? { label: t.status.toUpperCase(), color: 'text-white/20' }
          const pct = Math.round(t.progress * 100)
          const isPaused = t.status === 'stopped' || t.status === 'queued-download'

          return (
            <div key={t.id} className="p-4 flex flex-col md:flex-row md:items-center gap-4 hover:bg-white/[0.02] transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1">
                  <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded border border-current ${status.color} bg-white/5`}>
                    {status.label}
                  </span>
                  <h3 className="text-xs font-medium text-white/80 truncate">{t.name}</h3>
                </div>
                <div className="flex items-center gap-4 text-[10px] font-mono text-white/30">
                  <span>{formatSize(t.sizeBytes)}</span>
                  <span className={`text-emerald-500/60 ${t.downloadSpeed === 0 ? 'opacity-50' : ''}`}>↓ {formatSize(t.downloadSpeed)}/s</span>
                  <span className={`text-cyan-500/60 ${t.uploadSpeed === 0 ? 'opacity-50' : ''}`}>↑ {formatSize(t.uploadSpeed)}/s</span>
                  <span className="text-white/20">P: {t.peersConnected || 0} / S: {t.seedsConnected || 0}</span>
                  {t.error && <span className="text-red-400/60 truncate max-w-xs">{t.error}</span>}
                </div>
              </div>

              <div className="w-full md:w-48 space-y-1.5">
                <div className="flex justify-between text-[9px] font-mono">
                  <span className="text-white/40">{pct}%</span>
                  <span className="text-white/20">{t.eta > 0 ? `ETA: ${Math.round(t.eta / 60)}m` : ''}</span>
                </div>
                <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full bg-[#00D4FF] transition-all duration-500" style={{ width: `${pct}%` }} />
                </div>
              </div>

              <div className="flex items-center gap-1">
                {isPaused ? (
                  <button onClick={() => performAction(t.id, 'resume')} title="Resume" className="p-2 hover:bg-emerald-500/10 text-emerald-500/40 hover:text-emerald-500 rounded-lg transition-all text-sm">▶</button>
                ) : (
                  <button onClick={() => performAction(t.id, 'pause')} title="Pause" className="p-2 hover:bg-white/10 text-white/20 hover:text-white rounded-lg transition-all text-sm">⏸</button>
                )}
                <button onClick={() => performAction(t.id, 'remove')} title="Remove" className="p-2 hover:bg-red-500/10 text-red-500/40 hover:text-red-500 rounded-lg transition-all text-sm">✕</button>
                <button onClick={() => performAction(t.id, 'delete')} title="Delete Files" className="p-2 hover:bg-red-500/20 text-red-500/60 hover:text-red-500 rounded-lg transition-all text-sm">🗑</button>
              </div>
            </div>
          )
        })}
        </div>
      </div>
    </div>
  )
}
