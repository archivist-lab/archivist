import '@fontsource-variable/dm-sans'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/bebas-neue'
import '@archivist/design-system/tokens.css'
import React, { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type View = 'overview' | 'performance' | 'files' | 'services' | 'storage' | 'recovery' | 'logs' | 'roadmap'
type ServiceAction = 'start' | 'stop' | 'restart'

interface HistoryPoint {
  at: string
  load1: number
  memoryPercent: number
  serviceMemoryBytes: number | null
  endpointsUp: number
  endpointsTotal: number
  volumes: Record<string, number>
}

interface RecoverySnapshot {
  releaseRoot: string
  current: string | null
  previous: string | null
  rollbackReady: boolean
  warning: string
  releases: Array<{
    id: string
    path: string
    role: 'current' | 'previous' | 'retained'
    createdAt: string | null
    revision: string | null
    complete: boolean
    missingArtifacts: string[]
  }>
}

interface Snapshot {
  generatedAt: string
  host: {
    hostname: string
    platform: string
    release: string
    uptimeSeconds: number
    cpuModel: string
    cpuCount: number
    load: number[]
    memoryTotalBytes: number
    memoryUsedBytes: number
  }
  services: Array<{
    id: string
    unit: string
    label: string
    state: string
    subState: string
    enabled: boolean
    pid: number | null
    memoryBytes: number | null
    startedAt: string | null
  }>
  volumes: Array<{
    id: string
    label: string
    path: string
    totalBytes: number
    usedBytes: number
    availableBytes: number
    usedPercent: number
    filesystem: string
  }>
  temperatures: Array<{ label: string; celsius: number }>
  endpoints: Array<{ label: string; port: number; path: string; reachable: boolean; latencyMs: number | null }>
  backup: {
    status: 'healthy' | 'stale' | 'invalid' | 'missing' | 'disabled' | 'unavailable'
    enabled: boolean
    backupCount: number
    retentionCount: number
    intervalHours: number
    latest: null | { id: string; createdAt: string; ageHours: number; files: number; bytes: number }
    verifiedAt: string | null
    sqliteIntegrity: 'ok' | 'failed' | 'not-checked'
    reason: string | null
  }
  capabilities: Record<string, boolean>
}

const nav: Array<{ id: View; icon: string; label: string; accent: string }> = [
  { id: 'overview', icon: '⌁', label: 'Overview', accent: 'cyan' },
  { id: 'performance', icon: '⌇', label: 'Performance', accent: 'cyan' },
  { id: 'files', icon: '▱', label: 'Files', accent: 'yellow' },
  { id: 'services', icon: '◫', label: 'Services', accent: 'violet' },
  { id: 'storage', icon: '◉', label: 'Storage', accent: 'pink' },
  { id: 'recovery', icon: '↶', label: 'Recovery', accent: 'violet' },
  { id: 'logs', icon: '≡', label: 'Journal', accent: 'yellow' },
  { id: 'roadmap', icon: '◇', label: 'Capabilities', accent: 'green' },
]

function bytes(value: number | null): string {
  if (value == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

function Sparkline({ values, ceiling, tone }: { values: number[]; ceiling: number; tone: string }) {
  const safeValues = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0]
  const points = safeValues
    .map((value, index) => `${(index / (safeValues.length - 1)) * 100},${38 - (Math.min(ceiling, Math.max(0, value)) / ceiling) * 36}`)
    .join(' ')
  return (
    <svg className={`sparkline ${tone}`} viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Historical trend">
      <line x1="0" y1="38" x2="100" y2="38" />
      <polyline points={points} />
    </svg>
  )
}

function Performance({ token, cpuCount }: { token: string; cpuCount: number }) {
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [hours, setHours] = useState(24)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/history?hours=${hours}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      const result = (await response.json()) as { points?: HistoryPoint[]; error?: string }
      if (!response.ok) throw new Error(result.error || 'Telemetry history unavailable')
      setPoints(result.points || [])
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Telemetry history unavailable')
    }
  }, [hours, token])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    return () => window.clearInterval(timer)
  }, [load])
  const latest = points.at(-1)
  const range = points.length ? `${new Date(points[0].at).toLocaleString()} — ${new Date(points.at(-1)!.at).toLocaleString()}` : 'Collecting the first sample…'
  const cards = [
    { label: 'Host memory', value: latest ? `${latest.memoryPercent.toFixed(1)}%` : '—', values: points.map(point => point.memoryPercent), ceiling: 100, tone: 'cyan' },
    { label: 'Load average', value: latest ? latest.load1.toFixed(2) : '—', values: points.map(point => point.load1), ceiling: Math.max(1, cpuCount), tone: 'violet' },
    { label: 'Runtime memory', value: bytes(latest?.serviceMemoryBytes ?? null), values: points.map(point => (point.serviceMemoryBytes ?? 0) / 1_048_576), ceiling: Math.max(256, ...points.map(point => (point.serviceMemoryBytes ?? 0) / 1_048_576)), tone: 'pink' },
    { label: 'Media volume', value: latest?.volumes.media != null ? `${latest.volumes.media}%` : '—', values: points.map(point => point.volumes.media ?? 0), ceiling: 100, tone: 'yellow' },
  ]
  return (
    <>
      <section className="panel performance-head">
        <div>
          <span className="eyebrow">One-minute samples · seven-day retention</span>
          <h3>Host flight recorder</h3>
          <p>{range}</p>
        </div>
        <div className="range-switcher">
          {[1, 6, 24, 168].map(value => <button className={hours === value ? 'active' : ''} key={value} onClick={() => setHours(value)}>{value === 168 ? '7d' : `${value}h`}</button>)}
        </div>
      </section>
      {error && <div className="error-banner">{error}</div>}
      <section className="performance-grid">
        {cards.map(card => (
          <article className="panel performance-card" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <Sparkline values={card.values} ceiling={card.ceiling} tone={card.tone} />
          </article>
        ))}
      </section>
      <section className="panel availability-strip">
        <span>Endpoint availability</span>
        <strong>{latest ? `${latest.endpointsUp}/${latest.endpointsTotal} online` : 'Awaiting sample'}</strong>
        <div>{points.slice(-120).map((point, index) => <i className={point.endpointsUp === point.endpointsTotal ? 'up' : 'down'} key={`${point.at}-${index}`} />)}</div>
      </section>
    </>
  )
}

function Recovery({ token, backup }: { token: string; backup: Snapshot['backup'] }) {
  const [recovery, setRecovery] = useState<RecoverySnapshot | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/releases', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      const result = (await response.json()) as RecoverySnapshot & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Release inventory unavailable')
      setRecovery(result)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Release inventory unavailable')
    }
  }, [token])
  useEffect(() => { void load() }, [load])
  if (error) return <div className="error-banner">{error}</div>
  if (!recovery) return <div className="loading"><div /><span>Inspecting immutable releases…</span></div>
  return (
    <>
      <section className={`panel backup-status ${backup.status}`}>
        <header>
          <div>
            <span className="eyebrow">Database recovery point</span>
            <h3>{backup.status === 'healthy' ? 'Latest backup verified' : `Backup ${backup.status}`}</h3>
          </div>
          <strong>{backup.sqliteIntegrity === 'ok' ? 'SQLITE OK' : backup.sqliteIntegrity.toUpperCase()}</strong>
        </header>
        {backup.latest ? (
          <dl>
            <div><dt>AGE</dt><dd>{backup.latest.ageHours < 1 ? '< 1 hour' : `${backup.latest.ageHours} hours`}</dd></div>
            <div><dt>SIZE</dt><dd>{bytes(backup.latest.bytes)}</dd></div>
            <div><dt>FILES</dt><dd>{backup.latest.files}</dd></div>
            <div><dt>RETAINED</dt><dd>{backup.backupCount} / {backup.retentionCount}</dd></div>
          </dl>
        ) : <p>No verified recovery point is available yet.</p>}
        {backup.reason && <p className="backup-reason">{backup.reason}</p>}
        {backup.verifiedAt && <small>Manifest, file sizes, and SQLite quick_check verified {new Date(backup.verifiedAt).toLocaleString()}</small>}
      </section>
      <section className={`panel recovery-status ${recovery.rollbackReady ? 'ready' : 'blocked'}`}>
        <div>
          <span className="eyebrow">Recovery posture</span>
          <h3>{recovery.rollbackReady ? 'Rollback target verified' : 'Rollback target unavailable'}</h3>
          <p>{recovery.warning}</p>
        </div>
        <strong>{recovery.rollbackReady ? 'READY' : 'CHECK REQUIRED'}</strong>
      </section>
      <section className="release-list">
        {recovery.releases.map(release => (
          <article className={`panel release-card ${release.role}`} key={release.id}>
            <header>
              <div>
                <span className="eyebrow">{release.role}</span>
                <h3>{release.id}</h3>
              </div>
              <span className={release.complete ? 'release-ok' : 'release-bad'}>{release.complete ? 'BOOTABLE' : 'INCOMPLETE'}</span>
            </header>
            <dl>
              <div><dt>DEPLOYED</dt><dd>{release.createdAt ? new Date(release.createdAt).toLocaleString() : 'Unknown'}</dd></div>
              <div><dt>REVISION</dt><dd>{release.revision || 'Working source'}</dd></div>
            </dl>
            <code>{release.path}</code>
            {!release.complete && <p className="missing-artifacts">Missing: {release.missingArtifacts.join(', ')}</p>}
          </article>
        ))}
      </section>
      <section className="panel recovery-command">
        <span className="eyebrow">Operator-gated action</span>
        <h3>Rollback remains explicit</h3>
        <code>sudo ./deploy/rollback-bare-metal.sh</code>
        <p>Review the plan, verify a compatible database backup, then re-run with <b>--apply</b>. Control deliberately cannot bypass this checkpoint.</p>
      </section>
    </>
  )
}

interface BrowserRoot { id: string; label: string; available: boolean; path: string | null }
interface BrowserEntry { name: string; path: string; type: 'directory' | 'file' | 'symlink' | 'other'; size: number; modifiedAt: string; mode: string; writable: boolean }
interface TrashEntry { id: string; name: string; originalPath: string; deletedAt: string; type: 'directory' | 'file' | 'other'; size: number }

function FileBrowser({ token, unlock }: { token: string; unlock: () => void }) {
  const [roots, setRoots] = useState<BrowserRoot[]>([])
  const [root, setRoot] = useState('filesystem')
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<BrowserEntry[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [writable, setWritable] = useState(false)
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([])
  const [showTrash, setShowTrash] = useState(false)
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
  const loadRoots = useCallback(async () => {
    if (!token) return
    try {
      const response = await fetch('/api/v1/files/roots', { headers })
      const result = await response.json() as { roots?: BrowserRoot[]; error?: string }
      if (!response.ok) throw new Error(result.error || 'File roots unavailable')
      setRoots(result.roots || [])
      if (!(result.roots || []).some(candidate => candidate.id === root && candidate.available)) {
        const first = (result.roots || []).find(candidate => candidate.available)
        if (first) setRoot(first.id)
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'File roots unavailable') }
  }, [token, root])
  const loadDirectory = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const response = await fetch(`/api/v1/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(currentPath)}`, { headers })
      const result = await response.json() as { entries?: BrowserEntry[]; writable?: boolean; error?: string }
      if (!response.ok) throw new Error(result.error || 'Directory unavailable')
      setEntries(result.entries || [])
      setWritable(Boolean(result.writable))
      setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Directory unavailable') }
    finally { setLoading(false) }
  }, [token, root, currentPath])
  useEffect(() => { void loadRoots() }, [loadRoots])
  useEffect(() => { void loadDirectory() }, [loadDirectory])
  const loadTrash = useCallback(async () => {
    if (!token) return
    try {
      const response = await fetch('/api/v1/files/trash', { headers })
      const result = await response.json() as { entries?: TrashEntry[]; error?: string }
      if (!response.ok) throw new Error(result.error || 'Trash unavailable')
      setTrashEntries(result.entries || [])
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Trash unavailable') }
  }, [token])
  useEffect(() => { void loadTrash() }, [loadTrash])

  const openEntry = async (entry: BrowserEntry) => {
    if (entry.type === 'directory') { setCurrentPath(entry.path); return }
    if (entry.type !== 'file') return
    try {
      const response = await fetch('/api/v1/files/tickets', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ root, path: entry.path }),
      })
      const result = await response.json() as { ticket?: string; error?: string }
      if (!response.ok || !result.ticket) throw new Error(result.error || 'Unable to authorize download')
      const anchor = document.createElement('a')
      anchor.href = `/api/v1/files/content?ticket=${encodeURIComponent(result.ticket)}`
      anchor.download = entry.name
      anchor.click()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Download failed') }
  }
  const mutate = async (endpoint: string, payload: Record<string, string>) => {
    const response = await fetch(`/api/v1/files/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ root, ...payload }) })
    const result = await response.json() as { error?: string }
    if (!response.ok) throw new Error(result.error || 'File operation failed')
    await loadDirectory()
  }
  const newDirectory = async () => {
    const name = window.prompt('New folder name')?.trim()
    if (!name) return
    try { await mutate('directories', { path: [currentPath, name].filter(Boolean).join('/') }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to create folder') }
  }
  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    for (const file of files) {
      try {
        const destination = [currentPath, file.name].filter(Boolean).join('/')
        const response = await fetch(`/api/v1/files/content?root=${encodeURIComponent(root)}&path=${encodeURIComponent(destination)}`, { method: 'PUT', headers, body: file })
        const result = await response.json() as { error?: string }
        if (!response.ok) throw new Error(result.error || `Unable to upload ${file.name}`)
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'Upload failed'); break }
    }
    event.target.value = ''
    await loadDirectory()
  }
  const move = async (entry: BrowserEntry) => {
    const destination = window.prompt('Destination path from filesystem root', entry.path)?.trim()
    if (!destination || destination === entry.path) return
    try { await mutate('move', { source: entry.path, destination }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Move failed') }
  }
  const trash = async (entry: BrowserEntry) => {
    if (!window.confirm(`Move “${entry.name}” to recoverable trash?`)) return
    try { await mutate('trash', { path: entry.path }); await loadTrash() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Trash operation failed') }
  }
  const restore = async (entry: TrashEntry) => {
    try { await mutate('trash/restore', { id: entry.id }); await loadTrash() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Restore failed') }
  }
  const crumbs = currentPath ? currentPath.split('/') : []
  if (!token) return (
    <section className="panel files-locked">
      <span className="eyebrow">Protected host data</span><h3>Unlock File Browser</h3>
      <p>The host filesystem requires the control token even on localhost. The token never reaches the privileged agent.</p>
      <button onClick={unlock}>Enter control token</button>
    </section>
  )
  return (
    <section className="panel file-browser">
      <header>
        <div><span className="eyebrow">Host filesystem</span><h3>File Browser</h3></div>
        <span className={`read-only-badge ${writable ? 'write-enabled' : ''}`}>{writable ? 'WRITE ENABLED' : 'SYSTEM READ ONLY'}</span>
      </header>
      <div className="root-tabs">
        {roots.map(item => <button disabled={!item.available} className={item.id === root ? 'active' : ''} key={item.id} onClick={() => { setRoot(item.id); setCurrentPath('') }}>{item.label}</button>)}
      </div>
      <div className="breadcrumbs">
        <button onClick={() => setCurrentPath('')}>{roots.find(item => item.id === root)?.label || root}</button>
        {crumbs.map((crumb, index) => <React.Fragment key={`${crumb}-${index}`}><span>/</span><button onClick={() => setCurrentPath(crumbs.slice(0, index + 1).join('/'))}>{crumb}</button></React.Fragment>)}
      </div>
      <div className="file-toolbar">
        <button disabled={!writable} onClick={() => void newDirectory()}>New folder</button>
        <label className={!writable ? 'disabled' : ''}>Upload<input disabled={!writable} multiple type="file" onChange={event => void upload(event)} /></label>
        <button onClick={() => setShowTrash(value => !value)}>Trash ({trashEntries.length})</button>
        <span>{writable ? 'Changes are audited · deletes use recoverable trash' : 'Protected system location'}</span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {showTrash && <div className="trash-drawer">
        <header><strong>Recoverable trash</strong><span>Items return to their original path</span></header>
        {trashEntries.map(entry => <div key={entry.id}><span><b>{entry.name}</b><small>{entry.originalPath} · {new Date(entry.deletedAt).toLocaleString()}</small></span><button onClick={() => void restore(entry)}>Restore</button></div>)}
        {!trashEntries.length && <p>Trash is empty.</p>}
      </div>}
      <div className="file-table">
        <div className="file-row file-heading"><span>Name</span><span>Size</span><span>Modified</span><span>Mode</span><span>Actions</span></div>
        {currentPath && <button className="file-row" onClick={() => setCurrentPath(crumbs.slice(0, -1).join('/'))}><span className="file-name"><i>↰</i>..</span><span>—</span><span>Parent folder</span><span>—</span></button>}
        {entries.map(entry => <div className="file-row" key={entry.path}>
          <button className="file-open" disabled={entry.type === 'symlink' || entry.type === 'other'} onClick={() => void openEntry(entry)}><span className="file-name"><i>{entry.type === 'directory' ? '▰' : entry.type === 'file' ? '▤' : '↗'}</i>{entry.name}</span></button>
          <span>{entry.type === 'directory' ? '—' : bytes(entry.size)}</span><span>{new Date(entry.modifiedAt).toLocaleString()}</span><span>{entry.mode}</span>
          <span className="file-actions"><button disabled={!entry.writable} onClick={() => void move(entry)}>Move</button><button disabled={!entry.writable} onClick={() => void trash(entry)}>Trash</button></span>
        </div>)}
        {!loading && !entries.length && <div className="empty-files">This directory is empty.</div>}
        {loading && <div className="empty-files">Reading directory…</div>}
      </div>
    </section>
  )
}

function duration(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

function Metric({ label, value, detail, tone = 'cyan' }: { label: string; value: string; detail: string; tone?: string }) {
  return (
    <article className={`metric tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function Bar({ value, warning = 80 }: { value: number; warning?: number }) {
  return (
    <div className="bar" aria-label={`${Math.round(value)} percent`}>
      <span className={value >= warning ? 'hot' : ''} style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  )
}

function Overview({ snapshot }: { snapshot: Snapshot }) {
  const memoryPercent = (snapshot.host.memoryUsedBytes / snapshot.host.memoryTotalBytes) * 100
  const hottest = snapshot.temperatures.reduce((max, sensor) => Math.max(max, sensor.celsius), 0)
  const healthyEndpoints = snapshot.endpoints.filter(endpoint => endpoint.reachable).length
  const primaryVolume = snapshot.volumes.find(volume => volume.id === 'media') || snapshot.volumes[0]
  return (
    <>
      <section className="hero-grid">
        <article className="hero-status panel">
          <div className="eyebrow">Bare-metal control plane</div>
          <h2>{snapshot.host.hostname}</h2>
          <p>
            {snapshot.host.platform} {snapshot.host.release} · up {duration(snapshot.host.uptimeSeconds)}
          </p>
          <div className="pulse-line">
            <i /> SYSTEM TELEMETRY LIVE
          </div>
        </article>
        <div className="metrics-grid">
          <Metric label="Endpoints" value={`${healthyEndpoints}/${snapshot.endpoints.length}`} detail="Archivist surfaces responding" />
          <Metric
            label="Memory"
            value={`${memoryPercent.toFixed(0)}%`}
            detail={`${bytes(snapshot.host.memoryUsedBytes)} of ${bytes(snapshot.host.memoryTotalBytes)}`}
            tone="violet"
          />
          <Metric
            label="Media volume"
            value={primaryVolume ? `${primaryVolume.usedPercent}%` : '—'}
            detail={primaryVolume ? `${bytes(primaryVolume.availableBytes)} available` : 'Path unavailable'}
            tone="pink"
          />
          <Metric
            label="Thermal peak"
            value={hottest ? `${hottest.toFixed(0)}°` : '—'}
            detail={hottest ? 'Kernel thermal zones' : 'No sensor exposed'}
            tone="yellow"
          />
        </div>
      </section>

      <section className="split-grid">
        <article className="panel section-panel">
          <header>
            <div>
              <span className="eyebrow">Ecosystem</span>
              <h3>Service fabric</h3>
            </div>
            <span className="live-dot">LIVE</span>
          </header>
          <div className="endpoint-list">
            {snapshot.endpoints.map(endpoint => (
              <div className="endpoint" key={`${endpoint.port}${endpoint.path}`}>
                <i className={endpoint.reachable ? 'up' : 'down'} />
                <div>
                  <strong>{endpoint.label}</strong>
                  <small>localhost:{endpoint.port}{endpoint.path}</small>
                </div>
                <span>{endpoint.reachable ? `${endpoint.latencyMs} ms` : 'offline'}</span>
              </div>
            ))}
          </div>
        </article>
        <article className="panel section-panel">
          <header>
            <div>
              <span className="eyebrow">Host pressure</span>
              <h3>Resource envelope</h3>
            </div>
          </header>
          <div className="resource-row">
            <div>
              <strong>Memory</strong>
              <span>{memoryPercent.toFixed(1)}%</span>
            </div>
            <Bar value={memoryPercent} />
          </div>
          <div className="resource-row">
            <div>
              <strong>Load / {snapshot.host.cpuCount} threads</strong>
              <span>{snapshot.host.load.join(' · ')}</span>
            </div>
            <Bar value={(snapshot.host.load[0] / Math.max(1, snapshot.host.cpuCount)) * 100} />
          </div>
          {primaryVolume && (
            <div className="resource-row">
              <div>
                <strong>{primaryVolume.label}</strong>
                <span>{primaryVolume.usedPercent}%</span>
              </div>
              <Bar value={primaryVolume.usedPercent} />
            </div>
          )}
          <p className="processor">{snapshot.host.cpuModel}</p>
        </article>
      </section>
    </>
  )
}

function Services({ snapshot, onAction, busy }: { snapshot: Snapshot; onAction: (id: string, action: ServiceAction) => void; busy: string }) {
  return (
    <section className="panel service-panel">
      <header>
        <div>
          <span className="eyebrow">systemd</span>
          <h3>Archivist services</h3>
        </div>
        <span className="helper">Actions require a control token</span>
      </header>
      {snapshot.services.map(service => (
        <article className="service-card" key={service.id}>
          <div className={`service-orb ${service.state}`}>
            <span />
          </div>
          <div className="service-copy">
            <div>
              <h4>{service.label}</h4>
              <span className={`state ${service.state}`}>
                {service.state} / {service.subState}
              </span>
            </div>
            <code>{service.unit}</code>
            <dl>
              <div>
                <dt>PID</dt>
                <dd>{service.pid || '—'}</dd>
              </div>
              <div>
                <dt>MEMORY</dt>
                <dd>{bytes(service.memoryBytes)}</dd>
              </div>
              <div>
                <dt>BOOT</dt>
                <dd>{service.enabled ? 'enabled' : 'not enabled'}</dd>
              </div>
              <div>
                <dt>ACTIVE SINCE</dt>
                <dd>{service.startedAt || '—'}</dd>
              </div>
            </dl>
          </div>
          <div className="service-actions">
            <button disabled={Boolean(busy)} onClick={() => onAction(service.id, 'start')}>
              Start
            </button>
            <button disabled={Boolean(busy)} onClick={() => onAction(service.id, 'restart')}>
              Restart
            </button>
            <button className="danger" disabled={Boolean(busy)} onClick={() => onAction(service.id, 'stop')}>
              Stop
            </button>
          </div>
        </article>
      ))}
      <div className="architecture-note">
        <strong>One runtime, two isolated processes.</strong>
        <span>The existing supervisor remains responsible for API readiness and worker restart backoff. systemd owns the outer lifecycle.</span>
      </div>
    </section>
  )
}

function Storage({ snapshot }: { snapshot: Snapshot }) {
  return (
    <>
      <section className="volume-grid">
        {snapshot.volumes.map(volume => (
          <article className="panel volume-card" key={volume.id}>
            <header>
              <span>{volume.label}</span>
              <b className={volume.usedPercent > 85 ? 'warning' : ''}>{volume.usedPercent}%</b>
            </header>
            <h3>{bytes(volume.availableBytes)}</h3>
            <p>available of {bytes(volume.totalBytes)}</p>
            <Bar value={volume.usedPercent} warning={85} />
            <code>{volume.path}</code>
          </article>
        ))}
      </section>
      <section className="panel insight-panel">
        <header>
          <div>
            <span className="eyebrow">Disk intelligence</span>
            <h3>Health before capacity</h3>
          </div>
        </header>
        <div className="insight-grid">
          <div>
            <span>SMART tooling</span>
            <strong>{snapshot.capabilities.smart ? 'Detected' : 'Not installed'}</strong>
            <p>Detailed attributes and self-tests are the next storage adapter.</p>
          </div>
          <div>
            <span>Btrfs tooling</span>
            <strong>{snapshot.capabilities.btrfs ? 'Detected' : 'Not installed'}</strong>
            <p>Snapshots, scrub state, and device membership will be surfaced read-only first.</p>
          </div>
          <div>
            <span>ZFS tooling</span>
            <strong>{snapshot.capabilities.zfs ? 'Detected' : 'Not installed'}</strong>
            <p>Pool health and dataset pressure will use optional capability detection.</p>
          </div>
        </div>
      </section>
    </>
  )
}

function Logs({ token }: { token: string }) {
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/services/runtime/logs?lines=200', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      const result = (await response.json()) as { lines?: string[]; error?: string }
      if (!response.ok) throw new Error(result.error || 'Journal unavailable')
      setLines(result.lines || [])
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Journal unavailable')
    }
  }, [token])
  useEffect(() => {
    void load()
  }, [load])
  return (
    <section className="panel journal-panel">
      <header>
        <div>
          <span className="eyebrow">journald</span>
          <h3>Runtime journal</h3>
        </div>
        <button onClick={() => void load()}>Refresh</button>
      </header>
      {error ? <div className="error-banner">{error}</div> : <pre>{lines.length ? lines.join('\n') : 'No journal entries returned.'}</pre>}
    </section>
  )
}

const capabilityGroups = [
  {
    title: 'Running now',
    tone: 'green',
    items: [
      'Host CPU, load and memory telemetry',
      'systemd lifecycle with a strict unit allowlist',
      'journald viewer with bounded output',
      'Volume pressure across data, media and downloads',
      'Local-by-default listener and token-gated mutations',
      'Append-only service action audit log',
      'Unprivileged control process with unit-scoped polkit',
    ],
  },
  {
    title: 'Next adapters',
    tone: 'cyan',
    items: [
      'SMART attributes, health trends and self-tests',
      'Btrfs/ZFS pool health, scrub and snapshots',
      'GPU load, memory and temperature',
      'Package update preview and maintenance windows',
      'Native backup verification and restore drills',
      'WebAuthn/passkey administrator sessions',
    ],
  },
  {
    title: 'Safety gates',
    tone: 'pink',
    items: [
      'No arbitrary shell or terminal execution',
      'No destructive disk operation without rollback',
      'No automatic update without a preflight and recovery point',
      'No remote bind without explicit operator configuration',
      'No access to provider secrets or raw backup contents',
      'No claim of parity until each capability is verified',
    ],
  },
]

function Roadmap() {
  return (
    <section className="capability-grid">
      {capabilityGroups.map(group => (
        <article className={`panel capability-card tone-${group.tone}`} key={group.title}>
          <header>
            <span className="eyebrow">{group.tone === 'green' ? 'Available' : group.tone === 'cyan' ? 'Planned' : 'Non-negotiable'}</span>
            <h3>{group.title}</h3>
          </header>
          <ul>
            {group.items.map(item => (
              <li key={item}>
                <i />
                {item}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  )
}

function App() {
  const [view, setView] = useState<View>('overview')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [token, setToken] = useState(() => sessionStorage.getItem('archivist-control-token') || '')
  const [showToken, setShowToken] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/overview', { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      const result = (await response.json()) as Snapshot & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Control API unavailable')
      setSnapshot(result)
      setNotice('')
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Control API unavailable')
    }
  }, [token])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 5_000)
    return () => window.clearInterval(timer)
  }, [load])

  const saveToken = (value: string) => {
    setToken(value)
    if (value) sessionStorage.setItem('archivist-control-token', value)
    else sessionStorage.removeItem('archivist-control-token')
  }

  const onAction = async (id: string, action: ServiceAction) => {
    if (!window.confirm(`${action[0].toUpperCase()}${action.slice(1)} the Archivist runtime?`)) return
    setBusy(`${action}:${id}`)
    try {
      const response = await fetch(`/api/v1/services/${id}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action }),
      })
      const result = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Service action failed')
      setNotice(`${action} accepted`)
      window.setTimeout(() => void load(), 1_200)
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Service action failed')
    } finally {
      setBusy('')
    }
  }

  const title = nav.find(item => item.id === view)?.label || 'Overview'
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>ARCHIVIST</strong>
            <span>CONTROL</span>
          </div>
        </div>
        <nav>
          {nav.map(item => (
            <button key={item.id} className={view === item.id ? `active ${item.accent}` : ''} onClick={() => setView(item.id)}>
              <i>{item.icon}</i>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>CONTROL PLANE</span>
          <small>v0.1.0 · BARE METAL</small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="eyebrow">Server / {title}</span>
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            <span className={`connection ${snapshot ? 'online' : ''}`}>
              <i />
              {snapshot ? 'HOST CONNECTED' : 'CONNECTING'}
            </span>
            <button className="token-button" onClick={() => setShowToken(true)}>
              {token ? 'Token loaded' : 'Unlock actions'}
            </button>
          </div>
        </header>
        <div className="content">
          {notice && (
            <button className="notice" onClick={() => setNotice('')}>
              {notice}
              <span>×</span>
            </button>
          )}
          {!snapshot ? (
            <div className="loading">
              <div />
              <span>{notice || 'Reading host telemetry…'}</span>
            </div>
          ) : (
            <>
              {view === 'overview' && <Overview snapshot={snapshot} />}
              {view === 'performance' && <Performance token={token} cpuCount={snapshot.host.cpuCount} />}
              {view === 'files' && <FileBrowser token={token} unlock={() => setShowToken(true)} />}
              {view === 'services' && <Services snapshot={snapshot} onAction={onAction} busy={busy} />}
              {view === 'storage' && <Storage snapshot={snapshot} />}
              {view === 'recovery' && <Recovery token={token} backup={snapshot.backup} />}
              {view === 'logs' && <Logs token={token} />}
              {view === 'roadmap' && <Roadmap />}
            </>
          )}
        </div>
      </main>
      {showToken && (
        <div className="modal-backdrop" onMouseDown={() => setShowToken(false)}>
          <section className="token-modal" onMouseDown={event => event.stopPropagation()}>
            <span className="eyebrow">Privileged actions</span>
            <h2>Control token</h2>
            <p>The token stays in this browser tab and is only sent as a bearer credential for service actions.</p>
            <input autoFocus type="password" value={token} placeholder="ARCHIVIST_CONTROL_TOKEN" onChange={event => saveToken(event.target.value)} />
            <div>
              <button onClick={() => saveToken('')}>Clear</button>
              <button className="primary" onClick={() => setShowToken(false)}>
                Done
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
