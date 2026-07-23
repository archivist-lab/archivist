import { useState, useEffect, useCallback, useRef } from 'react'
import { toast, confirmDialog } from '../../lib/notify.js'
import { sharedApi, type ImportPlan, type ManualImportCandidate, type ManualImportItem, type NetworkDiagnostics } from '../../lib/shared.api.js'

type TorrentStatus = 'stopped' | 'queued-check' | 'checking' | 'fetching-metadata' | 'queued-download' | 'downloading' | 'queued-seed' | 'seeding' | 'error' | 'orphaned'

interface TorrentFile {
  index: number
  name: string
  sizeBytes: number
  downloadedBytes: number
  wanted: boolean
  priority: string
}

interface TrackerInfo {
  id: number
  announce: string
  tier: number
  lastAnnounceTime: number
  lastAnnounceSucceeded: boolean
  lastAnnounceResult: string
  lastAnnouncePeerCount: number
  nextAnnounceTime: number
  isAnnouncing: boolean
  seederCount: number
  leecherCount: number
  healthScore?: number
  failureCategory?: string | null
  augmented?: boolean
}

interface PeerInfo {
  address: string
  port: number
  clientName: string
  progress: number
  rateToPeer: number
  rateToClient: number
  isDownloadingFrom: boolean
  isUploadingTo: boolean
  isChoked: boolean
  isPeerChoked: boolean
  isInterested: boolean
  isPeerInterested: boolean
  hasNeededPieces?: boolean
  chokedForMs?: number
  usefulBlocks?: number
  relation?: 'useful' | 'ready' | 'choked' | 'no-needed-pieces'
  source: string
  flagStr: string
}

interface TorrentDiagnosticsInfo {
  connected: number
  connecting: number
  known: number
  seen: number
  failed: number
  connectionAttempts: number
  recentCloseReasons?: Record<string, number>
  failureBuckets?: Record<string, number>
  peerStates?: Record<string, number>
  peerSources?: Record<string, { discovered: number; connecting: number; connected: number; failed: number; useful: number }>
  recentFailures?: Array<{ peer: string; source: string; reason: string; bucket: string; failures: number; lastFailedAt: number; retryAfter: number }>
  availability?: {
    explanation: string
    hasConnectedSeed: boolean
    peersWithNeededPieces: number
    peersWithUsefulBlocks: number
    chokedByPeers: number
    longestChokedMs: number
  }
  requests?: {
    endGame: boolean
    missingPieces: number
    partialPieces: number
    outstandingBlocks: number
    staleBlocks: number
    duplicateOutstandingBlocks: number
  }
}

type BandwidthPriority = 'low' | 'normal' | 'high'
type MatchTargetType = 'films' | 'series' | 'series-season' | 'series-episode' | 'music-discography' | 'music-album' | 'games' | 'comics-volume' | 'comics-issue'

interface Torrent {
  id: string
  infoHash: string
  name: string
  status: TorrentStatus
  progress: number
  downloadSpeed: number
  uploadSpeed: number
  downloadedBytes: number
  uploadedBytes: number
  sizeBytes: number
  eta: number
  uploadRatio: number
  peersConnected: number
  peersSeen: number
  downloadDir: string
  addedAt: number
  completedAt: number | null
  isPrivate: boolean
  error: string | null
  labels: string[]
  queuePosition: number
  bandwidthPriority: BandwidthPriority
  stalledReason?: string | null
  sourcePath?: string
  orphaned?: boolean
  files?: TorrentFile[]
  trackers?: TrackerInfo[]
  peers?: PeerInfo[]
  diagnostics?: TorrentDiagnosticsInfo | null
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b <= 0) return '0 B'
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`
  if (b >= 1e9)  return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6)  return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3)  return `${(b / 1e3).toFixed(0)} KB`
  return `${b} B`
}

function fmtSpeed(bps: number): string {
  if (bps <= 0) return '—'
  return `${fmtBytes(bps)}/s`
}

function fmtEta(sec: number): string {
  if (sec < 0 || sec > 86400 * 365) return '∞'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

function fmtRatio(r: number): string {
  if (r < 0) return '∞'
  return r.toFixed(2)
}

function fmtDate(ms: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

const STATUS_CONFIG: Record<TorrentStatus, { label: string; pill: string; bar: string }> = {
  'stopped':           { label: 'Paused',          pill: 'bg-white/10 text-white/40 border border-white/10',             bar: 'bg-white/20' },
  'queued-check':      { label: 'Queued Check',     pill: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20',       bar: 'bg-cyan-500' },
  'checking':          { label: 'Checking',         pill: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20', bar: 'bg-yellow-500' },
  'fetching-metadata': { label: 'Metadata',         pill: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20',       bar: 'bg-cyan-500' },
  'queued-download':   { label: 'Queued',           pill: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20',       bar: 'bg-cyan-500' },
  'downloading':       { label: 'Downloading',      pill: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20', bar: 'bg-[#00D4FF]' },
  'queued-seed':       { label: 'Queued Seed',      pill: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20', bar: 'bg-emerald-400' },
  'seeding':           { label: 'Seeding',          pill: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20', bar: 'bg-emerald-400' },
  'error':             { label: 'Error',            pill: 'bg-red-500/10 text-red-400 border border-red-500/20',           bar: 'bg-red-500' },
  'orphaned':          { label: 'Leftover Files',   pill: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',     bar: 'bg-amber-500' },
}

const PRIORITY_CONFIG: Record<BandwidthPriority, { label: string; pill: string; dot: string }> = {
  high:   { label: 'High',   pill: 'bg-[#FF2D78]/10 text-[#FF2D78] border border-[#FF2D78]/30',   dot: 'bg-[#FF2D78]' },
  normal: { label: 'Normal', pill: 'bg-white/5 text-white/30 border border-white/10',               dot: 'bg-white/30' },
  low:    { label: 'Low',    pill: 'bg-white/5 text-white/20 border border-white/5',                dot: 'bg-white/15' },
}

const json = (method: string, body: unknown) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

const api = {
  list:    (): Promise<Torrent[]>  => fetch('/api/v1/torrents').then(r => r.json()),
  get:     (id: string): Promise<Torrent> => fetch(`/api/v1/torrents/${id}`).then(r => r.json()),
  add:     (body: { magnetLink?: string; torrentUrl?: string }) =>
    fetch('/api/v1/torrents', json('POST', body)).then(r => r.json()),
  start:   (id: string) => fetch(`/api/v1/torrents/${id}/start`,  { method: 'POST' }).then(r => r.json()),
  stop:    (id: string) => fetch(`/api/v1/torrents/${id}/stop`,   { method: 'POST' }).then(r => r.json()),
  remove:  (id: string, deleteData = false) =>
    fetch(`/api/v1/torrents/${id}?deleteData=${deleteData}`, { method: 'DELETE' }).then(r => r.json()),
  bulkAction: (ids: string[], action: 'remove' | 'start' | 'stop', deleteData = false) =>
    fetch('/api/v1/torrents/bulk-action', json('POST', { ids, action, deleteData })).then(r => r.json()),
  setPriority: (id: string, bandwidthPriority: BandwidthPriority) =>
    fetch(`/api/v1/torrents/${id}/priority`, json('PATCH', { bandwidthPriority })).then(r => r.json()),
  reorder: (orderedIds: string[]) =>
    fetch('/api/v1/torrents/reorder', json('POST', { orderedIds })).then(r => r.json()),
  recheck: (id: string) => fetch(`/api/v1/torrents/${id}/recheck`, { method: 'POST' }).then(r => r.json()),
  reannounce: (id: string) => fetch(`/api/v1/torrents/${id}/reannounce`, { method: 'POST' }).then(r => r.json()),
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function TorrentsPage({ hideHeader = false }: { hideHeader?: boolean }) {
  const [torrents, setTorrents] = useState<Torrent[]>([])
  const [loading,  setLoading]  = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [multiSelect, setMultiSelect] = useState<Set<string>>(new Set())
  const [showAdd,  setShowAdd]  = useState(false)
  const [filter,   setFilter]   = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'completed' | 'queue' | 'cleanup'>('all')
  const dragId    = useRef<string | null>(null)
  const dragOver  = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const list: Torrent[] = await api.list()
      // Sort real torrents by queue position and keep cleanup-only leftovers at the bottom.
      list.sort((a, b) => {
        if (!!a.orphaned !== !!b.orphaned) return a.orphaned ? 1 : -1
        return (a.queuePosition ?? 0) - (b.queuePosition ?? 0)
      })
      setTorrents(list)
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 3000)
    return () => clearInterval(id)
  }, [load])

  const toggleSelect = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    setMultiSelect(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    if (multiSelect.size === visible.length) setMultiSelect(new Set())
    else setMultiSelect(new Set(visible.map(t => t.id)))
  }

  const doBulkAction = async (action: 'start' | 'stop' | 'remove' | 'delete') => {
    if (multiSelect.size === 0) return
    const ids = Array.from(multiSelect)
    
    if (action === 'remove' || action === 'delete') {
      const msg = action === 'delete' 
        ? `Remove ${ids.length} item(s) AND delete files from disk?` 
        : `Remove ${ids.length} item(s)?`
      if (!await confirmDialog(msg)) return
      
      // Optimistic update
      setTorrents(prev => prev.filter(t => !multiSelect.has(t.id)))
    }

    try {
      if (action === 'delete') await api.bulkAction(ids, 'remove', true)
      else if (action === 'remove') await api.bulkAction(ids, 'remove', false)
      else await api.bulkAction(ids, action)
      
      setMultiSelect(new Set())
      load()
    } catch (e) {
      toast.error(String(e))
      load() // Refresh on error to restore state
    }
  }

  // ── Queue reorder helpers ──────────────────────────────────────────────────

  const reorder = useCallback(async (newOrder: Torrent[]) => {
    setTorrents(newOrder)
    await api.reorder(newOrder.filter(t => !t.orphaned).map(t => t.id))
  }, [])

  const moveUp = useCallback((id: string) => {
    setTorrents(prev => {
      const idx = prev.findIndex(t => t.id === id)
      if (idx <= 0) return prev
      const next = [...prev]
      ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
      api.reorder(next.filter(t => !t.orphaned).map(t => t.id))
      return next
    })
  }, [])

  const moveDown = useCallback((id: string) => {
    setTorrents(prev => {
      const idx = prev.findIndex(t => t.id === id)
      if (idx < 0 || idx >= prev.length - 1) return prev
      const next = [...prev]
      ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
      api.reorder(next.filter(t => !t.orphaned).map(t => t.id))
      return next
    })
  }, [])

  const onDragStart = (id: string) => { dragId.current = id }
  const onDragEnter = (id: string) => { dragOver.current = id }
  const onDrop = () => {
    const from = dragId.current
    const to   = dragOver.current
    dragId.current = null
    dragOver.current = null
    if (!from || !to || from === to) return
    setTorrents(prev => {
      const fromIdx = prev.findIndex(t => t.id === from)
      const toIdx   = prev.findIndex(t => t.id === to)
      if (fromIdx < 0 || toIdx < 0) return prev
      const next = [...prev]
      const [item] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, item)
      api.reorder(next.filter(t => !t.orphaned).map(t => t.id))
      return next
    })
  }

  const setPriority = useCallback(async (id: string, p: BandwidthPriority) => {
    setTorrents(prev => prev.map(t => t.id === id ? { ...t, bandwidthPriority: p } : t))
    await api.setPriority(id, p)
  }, [])

  const visible = torrents.filter(t => {
    const matchesSearch = !filter || (t.name ?? '').toLowerCase().includes(filter.toLowerCase())
    if (!matchesSearch) return false

    if (statusFilter === 'active') {
      return !t.orphaned && ['downloading', 'seeding', 'checking', 'fetching-metadata'].includes(t.status)
    }
    if (statusFilter === 'completed') {
      return !t.orphaned && t.progress >= 1
    }
    if (statusFilter === 'queue') {
      return !t.orphaned && t.status.startsWith('queued-')
    }
    if (statusFilter === 'cleanup') {
      return !!t.orphaned || t.status === 'orphaned'
    }
    return !t.orphaned && t.status !== 'orphaned'
  })
  const selectedTorrent = torrents.find(t => t.id === selected) ?? null

  const realTorrents = torrents.filter(t => !t.orphaned && t.status !== 'orphaned')
  const active    = realTorrents.filter(t => t.status === 'downloading' || t.status === 'fetching-metadata').length
  const seeding   = realTorrents.filter(t => t.status === 'seeding').length
  const leftovers = torrents.filter(t => t.orphaned || t.status === 'orphaned').length
  const totalDown = realTorrents.reduce((s, t) => s + t.downloadSpeed, 0)
  const totalUp   = realTorrents.reduce((s, t) => s + t.uploadSpeed, 0)

  return (
    <div className="animate-fade-in">
      {/* Header */}
      {!hideHeader && (
        <div className="flex items-center gap-4 mb-6 flex-wrap">
          <div className="flex-1">
            <h1 className="font-display text-5xl tracking-widest text-white">ACQUISITIONS</h1>
            <div className="flex items-center gap-4 mt-1 text-[10px] font-mono text-white/30">
              {active > 0   && <span className="text-emerald-400">{active} downloading</span>}
              {seeding > 0  && <span className="text-cyan-400">{seeding} seeding</span>}
              {leftovers > 0 && <span className="text-amber-400">{leftovers} cleanup</span>}
              <span className="text-emerald-400/60">↓ {fmtSpeed(totalDown)}</span>
              <span className="text-cyan-400/60">↑ {fmtSpeed(totalUp)}</span>
              <span>{realTorrents.length} downloads</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter..."
              className="px-3 py-2 rounded-lg bg-noir-900 border border-white/10 text-white/70 text-sm placeholder-white/20 focus:outline-none focus:border-white/25 w-44 transition-all font-mono"
            />
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-sm transition-all"
            >
              + Add Torrent
            </button>
          </div>
        </div>
      )}

      {hideHeader && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-4 text-[10px] font-mono text-white/30">
            {active > 0   && <span className="text-emerald-400">{active} DOWNLOADING</span>}
            {seeding > 0  && <span className="text-cyan-400">{seeding} SEEDING</span>}
            {leftovers > 0 && <span className="text-amber-400">{leftovers} CLEANUP</span>}
            <span className="text-emerald-400/60">↓ {fmtSpeed(totalDown)}</span>
            <span className="text-cyan-400/60">↑ {fmtSpeed(totalUp)}</span>
            <span>{realTorrents.length} DOWNLOADS</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter..."
              className="px-2 py-1.5 rounded-lg bg-noir-900 border border-white/10 text-white/70 text-[10px] placeholder-white/20 focus:outline-none focus:border-white/25 w-32 transition-all font-mono"
            />
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-[10px] font-mono transition-all"
            >
              + ADD
            </button>
          </div>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex gap-1.5 p-1 bg-noir-900 border border-white/5 rounded-xl w-fit">
          {(['all', 'active', 'completed', 'queue', 'cleanup'] as const).map(f => (
            <button
              key={f}
              onClick={() => { setStatusFilter(f); setMultiSelect(new Set()) }}
              className={`px-4 py-1.5 rounded-lg text-[10px] font-bold tracking-widest uppercase transition-all whitespace-nowrap ${
                statusFilter === f 
                  ? 'bg-white/10 text-[#00D4FF]' 
                  : 'text-white/30 hover:text-white/60'
              }`}
            >
              {f === 'queue' ? 'In Queue' : f === 'cleanup' ? `Cleanup${leftovers ? ` (${leftovers})` : ''}` : f}
            </button>
          ))}
        </div>

        {multiSelect.size > 0 && (
          <div className="flex items-center gap-3 px-4 py-1 bg-noir-900 border border-[#00D4FF]/20 rounded-xl animate-fade-in">
            <span className="text-[10px] font-mono text-[#00D4FF] uppercase tracking-widest">{multiSelect.size} Selected</span>
            <div className="h-4 w-px bg-white/10 mx-1" />
            <button onClick={() => doBulkAction('start')} className="text-[10px] font-mono text-white/40 hover:text-white uppercase tracking-widest transition-colors">Start</button>
            <button onClick={() => doBulkAction('stop')} className="text-[10px] font-mono text-white/40 hover:text-white uppercase tracking-widest transition-colors">Pause</button>
            <button onClick={() => doBulkAction('remove')} className="text-[10px] font-mono text-white/40 hover:text-white uppercase tracking-widest transition-colors">Remove</button>
            <button onClick={() => doBulkAction('delete')} className="text-[10px] font-mono text-red-500/60 hover:text-red-500 uppercase tracking-widest transition-colors">Delete</button>
            <div className="h-4 w-px bg-white/10 mx-1" />
            <button onClick={() => setMultiSelect(new Set())} className="text-[10px] font-mono text-white/20 hover:text-white/40 uppercase tracking-widest transition-colors">Clear</button>
          </div>
        )}
      </div>

      <div className="bg-noir-900 border border-white/5 rounded-2xl overflow-hidden min-w-[800px]">
        {/* Table header */}
        <div className="grid gap-2 px-4 py-2 border-b border-white/5 text-[9px] font-mono text-white/20 uppercase tracking-widest items-center"
          style={{ gridTemplateColumns: '40px 30px 25px 4fr 2.5fr 1fr 1.8fr 1fr' }}>
          <div className="flex justify-center">
            <input 
              type="checkbox" 
              checked={visible.length > 0 && multiSelect.size === visible.length}
              onChange={selectAll}
              className="w-3 h-3 rounded accent-[#00D4FF] cursor-pointer"
            />
          </div>
          <span></span>
          <span>#</span>
          <span>Name</span>
          <span>Progress</span>
          <span>↓ Speed</span>
          <span>Size</span>
          <span>ETA</span>
        </div>
        <div className="divide-y divide-white/[0.04]" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
          {visible.map((t, idx) => {
            const cfg  = STATUS_CONFIG[t.status] ?? STATUS_CONFIG.error
            const pct  = Math.round(t.progress * 100)
            const isSelected = selected === t.id
            const isChecked = multiSelect.has(t.id)
            return (
              <div key={t.id}>
                <div
                  draggable={!t.orphaned}
                  onDragStart={() => !t.orphaned && onDragStart(t.id)}
                  onDragEnter={() => !t.orphaned && onDragEnter(t.id)}
                  onClick={() => setSelected(isSelected ? null : t.id)}
                  className={`grid gap-2 px-2 py-3 cursor-pointer transition-colors hover:bg-white/[0.02] items-center group
                    ${isSelected ? 'bg-[#00D4FF]/5 border-l-2 border-[#00D4FF]' : 'border-l-2 border-transparent'}
                    ${isChecked ? 'bg-white/[0.03]' : ''}`}
                  style={{ gridTemplateColumns: '40px 30px 25px 4fr 2.5fr 1fr 1.8fr 1fr' }}
                >
                  {/* Bulk Checkbox */}
                  <div className="flex justify-center" onClick={e => e.stopPropagation()}>
                    <input 
                      type="checkbox" 
                      checked={isChecked}
                      onChange={() => toggleSelect(t.id)}
                      className="w-3.5 h-3.5 rounded accent-[#00D4FF] cursor-pointer opacity-40 hover:opacity-100 transition-opacity"
                    />
                  </div>

                  {/* Drag handle + move buttons */}
                  {!t.orphaned ? (
                    <div className="flex flex-col items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={e => { e.stopPropagation(); moveUp(t.id) }}
                        className="text-white/30 hover:text-white text-[8px] leading-none px-0.5"
                        title="Move up"
                      >▲</button>
                      <span className="text-white/10 text-[9px] cursor-grab active:cursor-grabbing select-none">⠿</span>
                      <button
                        onClick={e => { e.stopPropagation(); moveDown(t.id) }}
                        className="text-white/30 hover:text-white text-[8px] leading-none px-0.5"
                        title="Move down"
                      >▼</button>
                    </div>
                  ) : <span />}

                  {/* Queue position */}
                  <span className="text-[9px] font-mono text-white/20 text-center">{t.orphaned ? '—' : idx + 1}</span>

                  {/* Name + Status */}
                  <div className="min-w-0 space-y-1.5">
                    <p className="text-sm text-white/80 truncate">{t.name}</p>
                    <div className="flex items-center gap-2">
                      <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest w-fit ${cfg.pill}`}>{cfg.label}</span>
                      {t.error && <p className="text-[9px] text-red-400 font-mono truncate">{t.error}</p>}
                    </div>
                  </div>

                  {/* Progress */}
                  <div className="space-y-0.5">
                    <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                      <div className={`h-full transition-all ${cfg.bar}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[9px] font-mono text-white/30">{pct}%</span>
                  </div>
                  <span className="font-mono text-xs text-emerald-400/70">{t.downloadSpeed > 0 ? fmtSpeed(t.downloadSpeed) : '—'}</span>
                  <span className="font-mono text-[10px] text-white/30 whitespace-nowrap">{fmtBytes(t.downloadedBytes)} / {fmtBytes(t.sizeBytes)}</span>
                  <span className="font-mono text-xs text-white/20">{t.status === 'downloading' ? fmtEta(t.eta) : '—'}</span>
                </div>

                {/* Accordion Drawer */}
                {isSelected && (
                  <div className="bg-black/20 border-y border-white/5 animate-slide-down">
                    <TorrentDetail
                      torrent={t}
                      onClose={() => setSelected(null)}
                      onRefresh={load}
                      onRemoved={(id) => {
                        setTorrents(prev => prev.filter(item => item.id !== id))
                        setMultiSelect(prev => {
                          if (!prev.has(id)) return prev
                          const next = new Set(prev)
                          next.delete(id)
                          return next
                        })
                        if (selected === id) setSelected(null)
                      }}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {showAdd && <AddTorrentModal onClose={() => setShowAdd(false)} onAdded={load} />}
    </div>
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function TorrentDetail({
  torrent: t,
  onClose,
  onRefresh,
  onRemoved,
}: {
  torrent: Torrent
  onClose: () => void
  onRefresh: () => void
  onRemoved: (id: string) => void
}) {
  const [tab, setTab]       = useState<'info' | 'diagnostics' | 'files' | 'match'>('info')
  const [detail, setDetail] = useState<Torrent | null>(null)

  useEffect(() => {
    api.get(t.id).then(setDetail).catch(() => {})
    const id = setInterval(() => api.get(t.id).then(setDetail).catch(() => {}), 3000)
    return () => clearInterval(id)
  }, [t.id])

  const data = detail ?? t
  const cfg  = STATUS_CONFIG[data.status] ?? STATUS_CONFIG.error
  const isPaused = data.status === 'stopped' || data.status === 'queued-download'
  const isOrphaned = data.status === 'orphaned' || data.orphaned

  const doAction = async (action: 'start' | 'stop' | 'remove' | 'delete' | 'recheck' | 'reannounce') => {
    try {
      if (action === 'remove' || action === 'delete') {
        const withFiles = action === 'delete'
        const prompt = withFiles
          ? (isOrphaned ? 'Delete these leftover files from disk?' : 'Remove torrent AND delete files?')
          : (isOrphaned ? 'Remove this leftover folder from Archivist cleanup/import review?' : 'Remove torrent?')
        if (!await confirmDialog(prompt)) return
        // Update the UI immediately, then remove on the backend in the
        // background; if it fails we resync so nothing is silently lost.
        onRemoved(t.id)
        onClose()
        api.remove(t.id, withFiles).catch(() => { toast.error('Failed to remove torrent'); onRefresh() })
        return
      } else if (action === 'start') {
        await api.start(t.id)
      } else if (action === 'stop') {
        await api.stop(t.id)
      } else if (action === 'recheck') {
        await api.recheck(t.id)
      } else if (action === 'reannounce') {
        await api.reannounce(t.id)
      }
      onRefresh()
      api.get(t.id).then(setDetail).catch(() => {})
    } catch (e) { toast.error(String(e)) }
  }

  const infoItems = [
    ['Status',     <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest ${cfg.pill}`}>{cfg.label}</span>],
    ['Progress',   `${Math.round(data.progress * 100)}%`],
    ['Downloaded', fmtBytes(data.downloadedBytes)],
    ['Uploaded',   fmtBytes(data.uploadedBytes)],
    ['Ratio',      fmtRatio(data.uploadRatio)],
    ['Size',       fmtBytes(data.sizeBytes)],
    ['↓ Speed',    fmtSpeed(data.downloadSpeed)],
    ['↑ Speed',    fmtSpeed(data.uploadSpeed)],
    ['Peers',      `${data.peersConnected} / ${data.peersSeen} seen`],
    ['Stalled',    data.stalledReason ?? '—'],
    ['ETA',        fmtEta(data.eta)],
    ['Added',      fmtDate(data.addedAt)],
    ...(data.completedAt ? [['Completed', fmtDate(data.completedAt)]] : []),
    ['Location',   data.downloadDir],
    ['Private',    data.isPrivate ? 'Yes' : 'No'],
  ]

  return (
    <div className="flex flex-col">
      {/* Tabs */}
      <div className="flex px-14 border-b border-white/5">
        {(isOrphaned ? (['info', 'match'] as const) : (['info', 'diagnostics', 'files', 'match'] as const)).map(id => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-8 py-3 text-[10px] font-mono uppercase tracking-widest transition-colors relative
              ${tab === id ? 'text-[#00D4FF]' : 'text-white/20 hover:text-white/40'}`}>
            {id === 'info' ? (isOrphaned ? 'Cleanup' : 'Overview') : id === 'diagnostics' ? 'Diagnostics' : id === 'match' ? 'Acquisition Match' : `Files (${data.files?.length || 0})`}
            {tab === id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#00D4FF]" />}
          </button>
        ))}
        <div className="flex-1" />
        <div className="flex items-center gap-2 pr-2">
          {!isOrphaned && (isPaused ? (
            <button onClick={() => doAction('start')}
              className="px-4 py-1.5 rounded-lg bg-[#00D4FF]/10 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-[10px] font-mono uppercase tracking-widest transition-all">
              Start
            </button>
          ) : (
            <button onClick={() => doAction('stop')}
              className="px-4 py-1.5 rounded-lg bg-white/5 text-white/40 hover:text-white hover:bg-white/10 text-[10px] font-mono uppercase tracking-widest transition-all">
              Pause
            </button>
          ))}
          {!isOrphaned && (
            <>
              <button onClick={() => doAction('reannounce')}
                className="px-4 py-1.5 rounded-lg bg-white/5 text-white/40 hover:text-white hover:bg-white/10 text-[10px] font-mono uppercase tracking-widest transition-all">
                Reannounce
              </button>
              <button onClick={() => doAction('recheck')}
                className="px-4 py-1.5 rounded-lg bg-white/5 text-white/40 hover:text-white hover:bg-white/10 text-[10px] font-mono uppercase tracking-widest transition-all">
                Recheck
              </button>
            </>
          )}
          <button onClick={() => doAction('remove')}
            className="px-4 py-1.5 rounded-lg bg-white/5 text-white/40 hover:text-white hover:bg-white/10 text-[10px] font-mono uppercase tracking-widest transition-all">
            {isOrphaned ? 'Ignore' : 'Remove'}
          </button>
          <button onClick={() => doAction('delete')}
            className="px-4 py-1.5 rounded-lg bg-red-500/10 text-red-500/60 hover:text-red-500 hover:bg-red-500/20 text-[10px] font-mono uppercase tracking-widest transition-all">
            Delete
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {tab === 'info' || (isOrphaned && tab !== 'match') ? (
          <div className="px-14 py-8 space-y-8">
            <div className="grid grid-cols-3 gap-x-12 gap-y-6">
              {infoItems.map(([label, value], i) => (
                <div key={i} className="space-y-1">
                  <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest">{label as string}</p>
                  <div className="text-[11px] text-white/60 font-medium truncate">{value as any}</div>
                </div>
              ))}
              <div className="col-span-3 space-y-1">
                <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Info Hash</p>
                <p className="text-[10px] font-mono text-white/30 break-all">{data.infoHash}</p>
              </div>
            </div>
          </div>
        ) : tab === 'diagnostics' ? (
          <TorrentDiagnostics torrent={data} />
        ) : tab === 'match' ? (
          <AcquisitionMatch torrent={data} />
        ) : (
          <div className="px-14 py-4">
            <FileTree torrentId={t.id} files={data.files ?? []} />
          </div>
        )}
      </div>
    </div>
  )
}

function TorrentDiagnostics({ torrent }: { torrent: Torrent }) {
  const [network, setNetwork] = useState<NetworkDiagnostics | null>(null)
  const trackers = torrent.trackers ?? []
  const peers = torrent.peers ?? []
  const diag = torrent.diagnostics ?? null
  const requests = diag?.requests
  const availability = diag?.availability
  const peerSources = Object.entries(diag?.peerSources ?? {})
  const failureBuckets = Object.entries(diag?.failureBuckets ?? {})
  const recentFailures = diag?.recentFailures ?? []
  const activeTrackers = trackers.filter(t => t.isAnnouncing || t.lastAnnounceSucceeded).length
  const failedTrackers = trackers.filter(t => t.lastAnnounceTime > 0 && !t.lastAnnounceSucceeded).length
  const downloadingPeers = peers.filter(p => p.isDownloadingFrom).length

  useEffect(() => {
    let cancelled = false
    sharedApi.system.torrentNetwork()
      .then(result => { if (!cancelled) setNetwork(result) })
      .catch(() => { if (!cancelled) setNetwork(null) })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="px-14 py-8 space-y-8">
      {network && (
        <div className="space-y-3">
          <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-widest">Network Health</h3>
          <div className="grid grid-cols-5 gap-4">
            <DiagnosticStat label="Web/API" value={`${network.web.host}:${network.web.port}`} />
            <DiagnosticStat
              label="TCP Peer"
              value={`${network.tcp.host}:${network.tcp.boundPort ?? '—'} / ${network.tcp.configuredPort}`}
              tone={!network.tcp.listening || network.tcp.fallback ? 'warn' : 'normal'}
            />
            <DiagnosticStat
              label="Advertised"
              value={String(network.tracker.advertisedPort)}
              tone={network.tracker.matchesTcp ? 'normal' : 'warn'}
            />
            <DiagnosticStat
              label="DHT UDP"
              value={`${network.dht.boundPort ?? '—'} / ${network.dht.configuredPort}`}
              tone={network.dht.enabled && network.dht.fallback ? 'warn' : 'normal'}
            />
            <DiagnosticStat
              label="uTP UDP"
              value={`${network.utp.boundPort ?? '—'} / ${network.utp.configuredPort}`}
              tone={network.utp.enabled && network.utp.fallback ? 'warn' : 'normal'}
            />
          </div>
          {network.warnings.length > 0 && (
            <div className="border border-yellow-400/10 rounded-xl bg-yellow-400/[0.03] px-4 py-3 space-y-1">
              {network.warnings.map(warning => (
                <p key={warning} className="text-[10px] font-mono text-yellow-400/80">{warning}</p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-4 gap-4">
        <DiagnosticStat label="Stalled Reason" value={torrent.stalledReason ?? '—'} wide />
        <DiagnosticStat label="Availability" value={availability?.explanation ?? '—'} wide />
        <DiagnosticStat label="Trackers" value={`${activeTrackers}/${trackers.length}`} />
        <DiagnosticStat label="Tracker Failures" value={String(failedTrackers)} tone={failedTrackers > 0 ? 'warn' : 'normal'} />
        <DiagnosticStat label="Peers" value={`${torrent.peersConnected}/${torrent.peersSeen}`} />
        <DiagnosticStat label="Sending Data" value={String(downloadingPeers)} tone={downloadingPeers === 0 && torrent.status === 'downloading' ? 'warn' : 'normal'} />
        <DiagnosticStat label="Attempts" value={String(diag?.connectionAttempts ?? 0)} />
        <DiagnosticStat label="Failed Peers" value={String(diag?.failed ?? 0)} tone={(diag?.failed ?? 0) > 0 ? 'warn' : 'normal'} />
        <DiagnosticStat label="Longest Choke" value={availability?.longestChokedMs ? fmtEta(Math.floor(availability.longestChokedMs / 1000)) : '—'} tone={(availability?.longestChokedMs ?? 0) > 30000 ? 'warn' : 'normal'} />
      </div>

      {requests && (
        <div className="grid grid-cols-6 gap-4">
          <DiagnosticStat label="Endgame" value={requests.endGame ? 'Active' : 'No'} tone={requests.endGame ? 'warn' : 'normal'} />
          <DiagnosticStat label="Missing Pieces" value={String(requests.missingPieces)} />
          <DiagnosticStat label="Partial Pieces" value={String(requests.partialPieces)} />
          <DiagnosticStat label="Outstanding" value={String(requests.outstandingBlocks)} />
          <DiagnosticStat label="Stale Blocks" value={String(requests.staleBlocks)} tone={requests.staleBlocks > 0 ? 'warn' : 'normal'} />
          <DiagnosticStat label="Duplicates" value={String(requests.duplicateOutstandingBlocks)} />
        </div>
      )}

      {(peerSources.length > 0 || failureBuckets.length > 0) && (
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-3">
            <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-widest">Peer Sources</h3>
            <div className="border border-white/5 rounded-xl overflow-hidden">
              <div className="grid grid-cols-[90px_repeat(5,1fr)] gap-3 px-3 py-2 bg-white/[0.02] text-[9px] font-mono text-white/20 uppercase tracking-widest">
                <span>Source</span><span>Seen</span><span>Dialing</span><span>Conn</span><span>Failed</span><span>Useful</span>
              </div>
              {peerSources.map(([source, stats]) => (
                <div key={source} className="grid grid-cols-[90px_repeat(5,1fr)] gap-3 px-3 py-2 border-t border-white/5 text-[10px] font-mono">
                  <span className="text-white/40 uppercase">{source}</span>
                  <span className="text-white/35">{stats.discovered}</span>
                  <span className="text-white/35">{stats.connecting}</span>
                  <span className="text-emerald-400/70">{stats.connected}</span>
                  <span className={stats.failed > 0 ? 'text-yellow-400' : 'text-white/25'}>{stats.failed}</span>
                  <span className="text-cyan-400/70">{stats.useful}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-widest">Failure Buckets</h3>
            <div className="border border-white/5 rounded-xl overflow-hidden">
              {failureBuckets.length === 0 ? (
                <div className="px-3 py-6 text-center text-[11px] font-mono text-white/20">No peer failures</div>
              ) : failureBuckets.map(([bucket, count]) => (
                <div key={bucket} className="flex items-center justify-between px-3 py-2 border-t border-white/5 text-[10px] font-mono">
                  <span className="text-white/40 uppercase">{bucket}</span>
                  <span className="text-yellow-400">{count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-widest">Trackers</h3>
        <div className="border border-white/5 rounded-xl overflow-hidden">
          <div className="grid grid-cols-[1fr_90px_90px_90px_110px_130px] gap-3 px-3 py-2 bg-white/[0.02] text-[9px] font-mono text-white/20 uppercase tracking-widest">
            <span>Announce</span><span>Status</span><span>Health</span><span>Peers</span><span>Seed/Leech</span><span>Next</span>
          </div>
          {trackers.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] font-mono text-white/20">No tracker data</div>
          ) : trackers.map(tr => (
            <div key={`${tr.tier}-${tr.id}-${tr.announce}`} className="grid grid-cols-[1fr_90px_90px_90px_110px_130px] gap-3 px-3 py-2 border-t border-white/5 text-[10px] items-center">
	              <span className="font-mono text-white/50 truncate">{tr.announce}</span>
	              <span className={tr.isAnnouncing ? 'text-cyan-400' : tr.lastAnnounceSucceeded ? 'text-emerald-400' : 'text-red-400'}>
	                {tr.isAnnouncing ? 'Announcing' : tr.lastAnnounceSucceeded ? 'OK' : tr.lastAnnounceTime ? 'Failed' : 'Pending'}
	              </span>
	              <span className={tr.failureCategory ? 'font-mono text-yellow-400' : 'font-mono text-white/30'}>
	                {tr.failureCategory ?? (tr.augmented ? 'Public' : String(tr.healthScore ?? 0))}
	              </span>
	              <span className="font-mono text-white/40">{tr.lastAnnouncePeerCount}</span>
	              <span className="font-mono text-white/30">{tr.seederCount}/{tr.leecherCount}</span>
	              <span className="font-mono text-white/25 truncate">{fmtDate(tr.nextAnnounceTime)}</span>
	              {tr.lastAnnounceResult && tr.lastAnnounceResult !== 'Success' && (
	                <span className="col-span-6 font-mono text-[9px] text-white/25 truncate">{tr.lastAnnounceResult}</span>
	              )}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-widest">Peers</h3>
        <div className="border border-white/5 rounded-xl overflow-hidden">
          <div className="grid grid-cols-[1.2fr_1fr_80px_90px_80px_90px_70px] gap-3 px-3 py-2 bg-white/[0.02] text-[9px] font-mono text-white/20 uppercase tracking-widest">
            <span>Address</span><span>Client</span><span>Source</span><span>State</span><span>Choked</span><span>Down</span><span>Flags</span>
          </div>
          {peers.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] font-mono text-white/20">No connected peers</div>
          ) : peers.map(peer => (
            <div key={`${peer.address}:${peer.port}`} className="grid grid-cols-[1.2fr_1fr_80px_90px_80px_90px_70px] gap-3 px-3 py-2 border-t border-white/5 text-[10px] items-center">
	              <span className="font-mono text-white/50 truncate">{peer.address}:{peer.port}</span>
	              <span className="text-white/35 truncate">{peer.clientName}</span>
	              <span className="font-mono text-white/30 uppercase">{peer.source}</span>
	              <span className={peer.relation === 'choked' ? 'font-mono text-yellow-400' : peer.relation === 'useful' ? 'font-mono text-emerald-400/70' : 'font-mono text-white/30'}>
	                {peer.relation ?? '—'}
	              </span>
	              <span className="font-mono text-white/25">{peer.chokedForMs ? fmtEta(Math.floor(peer.chokedForMs / 1000)) : '—'}</span>
	              <span className={peer.rateToClient > 0 ? 'text-emerald-400/70 font-mono' : 'text-white/20 font-mono'}>{fmtSpeed(peer.rateToClient)}</span>
	              <span className="font-mono text-white/25">{peer.flagStr || '—'}</span>
	            </div>
          ))}
        </div>
      </div>

      {recentFailures.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-widest">Recent Peer Failures</h3>
          <div className="border border-white/5 rounded-xl overflow-hidden">
            <div className="grid grid-cols-[1.2fr_90px_110px_1.6fr_130px] gap-3 px-3 py-2 bg-white/[0.02] text-[9px] font-mono text-white/20 uppercase tracking-widest">
              <span>Peer</span><span>Source</span><span>Bucket</span><span>Reason</span><span>Retry</span>
            </div>
            {recentFailures.map(f => (
              <div key={`${f.peer}-${f.lastFailedAt}`} className="grid grid-cols-[1.2fr_90px_110px_1.6fr_130px] gap-3 px-3 py-2 border-t border-white/5 text-[10px] items-center">
                <span className="font-mono text-white/45 truncate">{f.peer}</span>
                <span className="font-mono text-white/30 uppercase">{f.source}</span>
                <span className="font-mono text-yellow-400/80 uppercase">{f.bucket}</span>
                <span className="font-mono text-white/25 truncate">{f.reason}</span>
                <span className="font-mono text-white/25 truncate">{fmtDate(f.retryAfter)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function DiagnosticStat({ label, value, tone = 'normal', wide = false }: { label: string; value: string; tone?: 'normal' | 'warn'; wide?: boolean }) {
  return (
    <div className={`rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 ${wide ? 'col-span-2' : ''}`}>
      <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest truncate">{label}</p>
      <p className={`mt-1 text-xs font-mono truncate ${tone === 'warn' ? 'text-yellow-400' : 'text-white/60'}`}>{value}</p>
    </div>
  )
}

// ── Acquisition match ─────────────────────────────────────────────────────────

function candidateKey(c: ManualImportCandidate) {
  return `${c.tabId}:${c.mediaType}:${c.itemId}`
}

function expectedSourcePath(torrent: Torrent) {
  if (torrent.sourcePath) return torrent.sourcePath
  const base = torrent.downloadDir.replace(/\/+$/, '')
  return `${base}/${torrent.name}`
}

function AcquisitionMatch({ torrent }: { torrent: Torrent }) {
  const [loading, setLoading] = useState(false)
  const [item, setItem] = useState<ManualImportItem | null>(null)
  const [candidateId, setCandidateId] = useState('')
  const [savedMatch, setSavedMatch] = useState<ManualImportCandidate | null>(null)
  const [mediaType, setMediaType] = useState<MatchTargetType>('films')
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<ManualImportCandidate[]>([])
  const [searching, setSearching] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [planLoading, setPlanLoading] = useState(false)

  const sourcePath = expectedSourcePath(torrent)
  const automaticCandidates = item?.candidates ?? []
  const allKnownCandidates = [savedMatch, ...automaticCandidates, ...searchResults].filter(Boolean) as ManualImportCandidate[]
  const candidates = search.trim().length >= 2
    ? searchResults
    : automaticCandidates.filter(c => c.mediaType === mediaType || (mediaType === 'series' && c.mediaType.startsWith('series')) || (mediaType === 'comics-volume' && c.mediaType === 'comics-volume'))
  const selected = allKnownCandidates.find(c => candidateKey(c) === candidateId) ?? null

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      sharedApi.system.torrentAcquisitionMatch(torrent.id).catch(() => ({ match: null })),
      sharedApi.system.manualImportCandidates().catch(() => ({ downloadDir: '', items: [] })),
    ])
      .then(([matchData, candidatesData]) => {
        if (cancelled) return
        const expected = sourcePath.toLowerCase()
        const found = candidatesData.items.find(i => i.sourcePath.toLowerCase() === expected)
          ?? candidatesData.items.find(i => i.name === torrent.name)
          ?? null
        const override = matchData.match
        setSavedMatch(override)
        setItem(found)
        const best = override ?? found?.candidates[0] ?? null
        setCandidateId(best ? candidateKey(best) : '')
        setMediaType((best?.mediaType ?? 'films') as MatchTargetType)
        setSearch(best?.title ?? torrent.name)
      })
      .catch(() => {
        if (!cancelled) setItem(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [torrent.id, torrent.name, sourcePath])

  const loadPlan = useCallback(async () => {
    setPlanLoading(true)
    try {
      const data = await sharedApi.system.torrentImportPlan(torrent.id)
      setPlan(data.plan)
    } catch {
      setPlan(null)
    } finally {
      setPlanLoading(false)
    }
  }, [torrent.id])

  useEffect(() => {
    loadPlan()
  }, [loadPlan, savedMatch?.itemId, savedMatch?.mediaType])

  useEffect(() => {
    let cancelled = false
    if (search.trim().length < 2) {
      setSearchResults([])
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      sharedApi.system.manualImportSearch({ mediaType, query: search, sourceName: torrent.name })
        .then(data => {
          if (cancelled) return
          setSearchResults(data.results)
        })
        .catch(() => {
          if (!cancelled) setSearchResults([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mediaType, search, torrent.name])

  const saveCandidate = useCallback(async (candidate: ManualImportCandidate) => {
    setCandidateId(candidateKey(candidate))
    setMediaType(candidate.mediaType as MatchTargetType)
    setSaveStatus('saving')
    try {
      const saved = await sharedApi.system.setTorrentAcquisitionMatch(torrent.id, candidate)
      setSavedMatch(saved.match)
      setCandidateId(candidateKey(saved.match))
      loadPlan()
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 1800)
    } catch {
      setSaveStatus('error')
    }
  }, [torrent.id])

  return (
    <div className="px-14 py-8 space-y-5">
      <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-4">
        <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Current Match</p>
        {selected ? (
          <div className="mt-2 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-white/75 truncate">{selected.title}</p>
              <p className="mt-1 text-[10px] font-mono text-white/35 truncate">{selected.tabName} · {selected.mediaType} · {selected.subtitle ?? selected.status ?? ''}</p>
            </div>
            <span className={`text-sm font-mono ${selected.score >= 90 ? 'text-emerald-400' : selected.score >= 70 ? 'text-[#00D4FF]' : 'text-yellow-400'}`}>
              {selected.score}%
            </span>
          </div>
        ) : (
          <p className="mt-3 text-[11px] font-mono text-white/25">{loading ? 'Scanning matches' : 'No current match'}</p>
        )}
        {saveStatus !== 'idle' && (
          <p className={`mt-2 text-[10px] font-mono ${saveStatus === 'error' ? 'text-red-400' : 'text-white/30'}`}>
            {saveStatus === 'saving' ? 'Saving match' : saveStatus === 'saved' ? 'Match saved' : 'Could not save match'}
          </p>
        )}
      </div>

      <div className="grid grid-cols-[220px_1fr] gap-4">
        <label className="space-y-2">
          <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Item Type</span>
          <select value={mediaType} onChange={e => { setMediaType(e.target.value as MatchTargetType); setCandidateId('') }}
            className="w-full bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/70 outline-none focus:border-[#00D4FF]/40">
            <option value="films">Film</option>
            <option value="series">Entire Series</option>
            <option value="series-season">Series Season</option>
            <option value="series-episode">Series Episode</option>
            <option value="music-discography">Music Discography</option>
            <option value="music-album">Music Album</option>
            <option value="games">Game</option>
            <option value="comics-volume">Comic Volume</option>
            <option value="comics-issue">Comic Issue</option>
          </select>
        </label>
        <label className="space-y-2">
          <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Search Library</span>
          <input value={search} onChange={e => setSearch(e.target.value)}
            className="w-full bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/70 outline-none focus:border-[#00D4FF]/40"
            placeholder={`Search ${mediaType}`} />
        </label>
      </div>

      <div className="rounded-xl border border-white/5 overflow-hidden">
        <div className="grid grid-cols-[1fr_170px_90px] gap-3 px-3 py-2 bg-white/[0.02] text-[9px] font-mono text-white/20 uppercase tracking-widest">
          <span>Match</span><span>Library</span><span>Score</span>
        </div>
        {loading || searching ? (
          <div className="px-3 py-8 text-center text-[11px] font-mono text-white/20">Searching</div>
        ) : candidates.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] font-mono text-white/20">No candidates</div>
        ) : candidates.map(c => {
          const key = candidateKey(c)
          return (
            <button key={key} onClick={() => saveCandidate(c)}
              className={`w-full grid grid-cols-[1fr_170px_90px] gap-3 px-3 py-2 border-t border-white/5 text-[10px] items-center text-left transition-colors ${
                candidateId === key ? 'bg-[#00D4FF]/10' : 'hover:bg-white/[0.02]'
              }`}>
              <span className="text-white/65 truncate">{c.title}<span className="text-white/25">{c.subtitle ? ` · ${c.subtitle}` : ''}</span></span>
              <span className="font-mono text-white/35 truncate">{c.tabName}</span>
              <span className={candidateId === key ? 'font-mono text-[#00D4FF]' : 'font-mono text-white/40'}>{c.score}%</span>
            </button>
          )
        })}
      </div>

      <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/5">
          <div>
            <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Import Plan</p>
            <p className="mt-1 text-[11px] font-mono text-white/30">{planLoading ? 'Planning' : plan?.summary ?? 'No saved match'}</p>
          </div>
          {plan && (
            <span className={`text-[10px] font-mono uppercase ${
              plan.status === 'ready' ? 'text-emerald-400' : plan.status === 'needs-review' ? 'text-yellow-400' : 'text-red-400'
            }`}>
              {plan.status.replace('-', ' ')}
            </span>
          )}
        </div>
        {plan && (
          <div className="max-h-72 overflow-auto">
            {plan.errors.map(error => (
              <div key={error} className="px-4 py-2 border-b border-white/5 text-[11px] text-red-300">{error}</div>
            ))}
            {plan.warnings.map(warning => (
              <div key={warning} className="px-4 py-2 border-b border-white/5 text-[11px] text-yellow-300">{warning}</div>
            ))}
            {plan.files.slice(0, 16).map(file => (
              <div key={file.path} className="grid grid-cols-[90px_1fr_150px] gap-3 px-4 py-2 border-b border-white/5 text-[10px] items-center">
                <span className="font-mono text-emerald-400/70 uppercase">{file.role}</span>
                <span className="text-white/60 truncate">{file.name}</span>
                <span className="font-mono text-white/30 truncate">{file.target ?? fmtBytes(file.sizeBytes)}</span>
              </div>
            ))}
            {plan.ignored.slice(0, 10).map(file => (
              <div key={file.path} className="grid grid-cols-[90px_1fr_150px] gap-3 px-4 py-2 border-b border-white/5 text-[10px] items-center opacity-60">
                <span className="font-mono text-white/20 uppercase">{file.role}</span>
                <span className="text-white/35 truncate">{file.name}</span>
                <span className="font-mono text-white/20 truncate">{file.reason ?? 'not mapped'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}

// ── File tree ─────────────────────────────────────────────────────────────────

type FileNode =
  | { type: 'file'; name: string; sizeBytes: number; downloadedBytes: number; index: number; wanted: boolean; priority: string }
  | { type: 'dir';  name: string; children: FileNode[] }

function buildTree(files: TorrentFile[]): FileNode[] {
  const root: FileNode[] = []
  for (const file of files) {
    const parts = file.name.split('/')
    let nodes = root
    for (let i = 0; i < parts.length - 1; i++) {
      let dir = nodes.find((n): n is Extract<FileNode, { type: 'dir' }> => n.type === 'dir' && n.name === parts[i])
      if (!dir) { dir = { type: 'dir', name: parts[i], children: [] }; nodes.push(dir) }
      nodes = dir.children
    }
    nodes.push({
      type: 'file',
      name: parts[parts.length - 1]!,
      sizeBytes: file.sizeBytes,
      downloadedBytes: file.downloadedBytes,
      index: file.index,
      wanted: file.wanted,
      priority: file.priority,
    })
  }
  return root
}

function nodeBytes(n: FileNode): [number, number] {
  if (n.type === 'file') return [n.sizeBytes, n.downloadedBytes]
  return n.children.reduce(([s, d], c) => { const [cs, cd] = nodeBytes(c); return [s + cs, d + cd] }, [0, 0])
}

/** Collect all file indices under a node */
function collectIndices(n: FileNode): number[] {
  if (n.type === 'file') return [n.index]
  return n.children.flatMap(collectIndices)
}

/** Determine wanted state of all files under a node: true=all, false=none, null=mixed */
function dirWanted(n: Extract<FileNode, { type: 'dir' }>): boolean | null {
  const leaves: boolean[] = []
  const walk = (node: FileNode) => {
    if (node.type === 'file') leaves.push(node.wanted)
    else node.children.forEach(walk)
  }
  walk(n)
  if (leaves.every(Boolean)) return true
  if (leaves.every(v => !v)) return false
  return null
}

const FILE_PRIORITY_OPTIONS = [
  { value: 'high',   label: 'High',   color: 'text-[#FF2D78]' },
  { value: 'normal', label: 'Normal', color: 'text-white/40'  },
  { value: 'low',    label: 'Low',    color: 'text-white/20'  },
  { value: 'skip',   label: 'Skip',   color: 'text-white/10'  },
]

interface FileNodeProps {
  node: FileNode
  depth: number
  onToggle: (indices: number[], wanted: boolean) => void
  onPriority: (index: number, priority: string) => void
}

function FileNodeRow({ node, depth, onToggle, onPriority }: FileNodeProps) {
  const [open, setOpen] = useState(depth === 0)
  const [total, done] = nodeBytes(node)
  
  // If a file is unwanted, we treat its progress as 0 in the UI 
  // to avoid confusion with cached pieces in the bitfield.
  const isUnwantedFile = node.type === 'file' && !node.wanted
  const pct = (total > 0 && !isUnwantedFile) ? done / total : 0

  const gridStyle = {
    display: 'grid',
    gridTemplateColumns: '1fr 100px 140px 120px',
    gap: '12px',
    alignItems: 'center'
  }

  if (node.type === 'file') {
    const priColor = FILE_PRIORITY_OPTIONS.find(o => o.value === node.priority)?.color ?? 'text-white/30'
    return (
      <div
        className="py-1 hover:bg-white/[0.02] rounded px-1 group"
        style={{ ...gridStyle, paddingLeft: `${depth * 12 + 4}px` }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <input
            type="checkbox"
            checked={node.wanted}
            onChange={e => { e.stopPropagation(); onToggle([node.index], e.target.checked) }}
            onClick={e => e.stopPropagation()}
            className="flex-shrink-0 w-3.5 h-3.5 rounded accent-[#00D4FF] cursor-pointer opacity-50 group-hover:opacity-100 transition-opacity"
          />
          <span className={`text-[11px] truncate transition-colors min-w-0 ${node.wanted ? 'text-white/60' : 'text-white/20 line-through'}`}>
            {node.name}
          </span>
        </div>

        {/* File priority control */}
        <div className="flex items-center gap-1 justify-center" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => {
              const priorities = ['low', 'normal', 'high']
              const idx = priorities.indexOf(node.priority || 'normal')
              if (idx > 0) onPriority(node.index, priorities[idx - 1]!)
            }}
            disabled={!node.wanted}
            className={`text-white/20 hover:text-white transition-colors p-0.5 ${!node.wanted ? 'opacity-0' : ''}`}
          >
            <span className="text-[7px]">▼</span>
          </button>
          <span className={`text-[9px] font-mono min-w-[35px] text-center ${priColor} ${!node.wanted ? 'opacity-30' : ''}`}>
            {(node.priority || 'normal').toUpperCase()}
          </span>
          <button
            onClick={() => {
              const priorities = ['low', 'normal', 'high']
              const idx = priorities.indexOf(node.priority || 'normal')
              if (idx < 2) onPriority(node.index, priorities[idx + 1]!)
            }}
            disabled={!node.wanted}
            className={`text-white/20 hover:text-white transition-colors p-0.5 ${!node.wanted ? 'opacity-0' : ''}`}
          >
            <span className="text-[7px]">▲</span>
          </button>
        </div>

        <span className="text-[9px] font-mono text-white/20 text-right whitespace-nowrap">
          {fmtBytes(done)} / {fmtBytes(total)}
        </span>

        <div className="flex items-center gap-2 pr-2">
          <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full bg-[#00D4FF]" style={{ width: `${pct * 100}%` }} />
          </div>
          <span className="text-[9px] font-mono text-white/20 w-6 text-right">{Math.round(pct * 100)}%</span>
        </div>
      </div>
    )
  }

  // Directory
  const wantedState = dirWanted(node)
  const allIndices  = collectIndices(node)

  return (
    <div>
      <div
        className="py-1 hover:bg-white/[0.02] rounded px-1 group"
        style={{ ...gridStyle, paddingLeft: `${depth * 12 + 4}px` }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <input
            type="checkbox"
            checked={wantedState === true}
            ref={el => { if (el) el.indeterminate = wantedState === null }}
            onChange={e => { e.stopPropagation(); onToggle(allIndices, e.target.checked) }}
            onClick={e => e.stopPropagation()}
            className="flex-shrink-0 w-3.5 h-3.5 rounded accent-[#00D4FF] cursor-pointer opacity-50 group-hover:opacity-100 transition-opacity"
          />
          <span
            className="text-white/20 text-[9px] cursor-pointer select-none flex-shrink-0"
            onClick={() => setOpen(o => !o)}
          >{open ? '▼' : '▶'}</span>
          <span
            className="text-[11px] text-white/60 font-medium truncate cursor-pointer"
            onClick={() => setOpen(o => !o)}
          >{node.name}/</span>
        </div>
        <div /> {/* Priority spacer */}
        <span className="text-[9px] font-mono text-white/20 text-right">
          {fmtBytes(done)} / {fmtBytes(total)}
        </span>
        <div className="flex items-center gap-2 pr-2">
          <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full bg-white/10" style={{ width: `${pct * 100}%` }} />
          </div>
          <span className="text-[9px] font-mono text-white/20 w-6 text-right">{Math.round(pct * 100)}%</span>
        </div>
      </div>
      {open && node.children.map((child, i) => (
        <FileNodeRow key={i} node={child} depth={depth + 1} onToggle={onToggle} onPriority={onPriority} />
      ))}
    </div>
  )
}


function FileTree({ torrentId, files }: { torrentId: string; files: TorrentFile[] }) {
  const [localFiles, setLocalFiles] = useState<TorrentFile[]>(files)
  useEffect(() => { setLocalFiles(files) }, [files])

  const patch = async (updates: Array<{ index: number; wanted?: boolean; priority?: string }>) => {
    await fetch(`/api/v1/torrents/${torrentId}/files`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    })
  }

  const handleToggle = async (indices: number[], wanted: boolean) => {
    setLocalFiles(prev => prev.map(f => indices.includes(f.index) ? { ...f, wanted } : f))
    try { await patch(indices.map(index => ({ index, wanted }))) }
    catch { setLocalFiles(files) }
  }

  const handlePriority = async (index: number, priority: string) => {
    setLocalFiles(prev => prev.map(f => f.index === index ? { ...f, priority } : f))
    try { await patch([{ index, priority }]) }
    catch { setLocalFiles(files) }
  }

  if (localFiles.length === 0) {
    return <div className="p-4 text-xs text-white/20 font-mono text-center">No file info yet</div>
  }

  const wantedCount   = localFiles.filter(f => f.wanted).length
  const unwantedCount = localFiles.length - wantedCount
  const tree = buildTree(localFiles)

  return (
    <div className="text-xs">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 sticky top-0 bg-black/20 backdrop-blur-md z-10">
        <span className="text-[9px] font-mono text-white/20">
          {wantedCount}/{localFiles.length} selected
          {unwantedCount > 0 && (
            <span className="text-white/10"> · {fmtBytes(localFiles.filter(f => !f.wanted).reduce((s, f) => s + f.sizeBytes, 0))} skipped</span>
          )}
        </span>
        <div className="flex gap-2">
          <button onClick={() => handleToggle(localFiles.map(f => f.index), true)}
            className="text-[9px] font-mono text-[#00D4FF]/60 hover:text-[#00D4FF] transition-colors">All</button>
          <span className="text-white/10">·</span>
          <button onClick={() => handleToggle(localFiles.map(f => f.index), false)}
            className="text-[9px] font-mono text-white/30 hover:text-white/60 transition-colors">None</button>
        </div>
      </div>

      {/* Header Row */}
      <div className="px-3 py-2 border-b border-white/5 text-[9px] font-mono text-white/20 uppercase tracking-widest grid"
        style={{ gridTemplateColumns: '1fr 100px 140px 120px', gap: '12px' }}>
        <span>File</span>
        <span className="text-center">Priority</span>
        <span className="text-right">Size</span>
        <span className="pl-2">Progress</span>
      </div>

      <div className="p-2">
        {tree.map((node, i) => (
          <FileNodeRow key={i} node={node} depth={0} onToggle={handleToggle} onPriority={handlePriority} />
        ))}
      </div>
    </div>
  )
}

// ── Add modal ─────────────────────────────────────────────────────────────────

function AddTorrentModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [tab,    setTab]    = useState<'magnet' | 'url'>('magnet')
  const [magnet, setMagnet] = useState('')
  const [url,    setUrl]    = useState('')
  const [busy,   setBusy]   = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      const body = tab === 'magnet' ? { magnetLink: magnet } : { torrentUrl: url }
      const res = await api.add(body)
      if (!res.success) throw new Error(res.error ?? 'Failed')
      onAdded()
      onClose()
    } catch (e) { toast.error(`Error: ${String(e)}`) }
    finally { setBusy(false) }
  }

  const valid = tab === 'magnet' ? magnet.startsWith('magnet:') : url.startsWith('http')

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-noir-900 border border-white/10 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <span className="font-mono text-sm text-white/80 uppercase tracking-widest">Add Torrent</span>
          <button onClick={onClose} className="text-white/20 hover:text-white transition-colors">✕</button>
        </div>
        <div className="p-5 space-y-4">
          {/* Tab selector */}
          <div className="flex gap-1 p-1 bg-black/20 rounded-lg">
            {(['magnet', 'url'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`flex-1 py-1.5 rounded text-xs font-mono uppercase tracking-widest transition-colors
                  ${tab === t ? 'bg-noir-900 text-white' : 'text-white/30 hover:text-white/60'}`}>
                {t}
              </button>
            ))}
          </div>

          {tab === 'magnet' ? (
            <textarea
              value={magnet}
              onChange={e => setMagnet(e.target.value)}
              placeholder="magnet:?xt=urn:btih:..."
              className="w-full px-3 py-2.5 rounded-lg bg-black/20 border border-white/10 text-white/70 text-xs font-mono placeholder-white/20 focus:outline-none focus:border-white/25 resize-none h-24 transition-all"
            />
          ) : (
            <input
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://example.com/file.torrent"
              className="w-full px-3 py-2.5 rounded-lg bg-black/20 border border-white/10 text-white/70 text-xs font-mono placeholder-white/20 focus:outline-none focus:border-white/25 transition-all"
            />
          )}
        </div>
        <div className="px-5 pb-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white text-xs font-mono transition-all">
            Cancel
          </button>
          <button onClick={submit} disabled={busy || !valid}
            className="px-5 py-2 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-xs font-mono transition-all disabled:opacity-40">
            {busy ? 'Adding...' : 'Add Torrent'}
          </button>
        </div>
      </div>
    </div>
  )
}
