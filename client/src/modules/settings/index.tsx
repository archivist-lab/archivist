import { useState, useEffect, useMemo } from 'react'
import { sharedApi, type QualityProfile, type RootFolder, type FlareSolverrConfig, type ApiKeysConfig, type TierConfig, type TierTerm, type TierMediaType, type AcquisitionDefaults, type TrackCleanerConfig, type SubtitleConfig, type SystemOverview, type SystemJob, type MaintenanceConfig, type BackupConfig, type IntegrityReport, type IntegrityConfig, type StoredPolicy, type ProcessingPreset, type OptimisationPolicy, type VideoPolicy, type AudioPolicy, type ProcessingVideoCodec, type ProcessingScanState, type RecommendationAction, type OptimiseJob, type QuarantineEntry, type ExecutionResponse, type SystemStats, type SearchMissingResponse, type ScheduleRun, type MonitoringResponse, type FeedStatus, type AcquisitionDecision, type SegmentStatus, type SegmentSettings, type AuthDevice } from '../../lib/shared.api.js'
import { filmsApi } from '../../lib/films.api.js'
import { seriesApi } from '../../lib/series.api.js'
import { musicApi } from '../../lib/music.api.js'
import { booksApi } from '../../lib/books.api.js'
import { comicsApi, gamesApi } from '../../lib/comics-games.api.js'
import { Field, Input, Toggle, Spinner, TabSelect, Modal } from '../../components/ui.js'
import { TorrentsPage } from '../torrents/TorrentsPage.js'
import { IndexersPage } from '../indexers/IndexersPage.js'
import { useTabs, type MediaType } from '../../lib/tab-context.js'
import { ImportListsTab } from './ImportListsTab.js'
import { ProcessingMonitorTab } from './ProcessingMonitorTab.js'
import { RecommendationsSystemTab } from './RecommendationsSystemTab.js'

// ── Library Tabs ─────────────────────────────────────────────────────────────

const MEDIA_TYPE_CHIPS: { key: MediaType; label: string; icon: string }[] = [
  { key: 'films', label: 'Films', icon: '🎬' }, { key: 'series', label: 'Series', icon: '📺' },
  { key: 'music', label: 'Music', icon: '🎵' }, { key: 'books', label: 'Books', icon: '📚' },
  { key: 'comics', label: 'Comics', icon: '🦸' }, { key: 'games', label: 'Games', icon: '🎮' },
]

function LibraryTabsTab() {
  const { tabs, createTab, deleteTab, clearTab, enabledMediaTypes, saveEnabledMediaTypes, relaunchOnboarding } = useTabs()
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState('films')
  const [newRootFolder, setNewRootFolder] = useState('')
  const [creating, setCreating] = useState(false)
  const [mediaBase, setMediaBase] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const grouped = useMemo(() => {
    const g: Record<string, typeof tabs> = {}
    for (const t of Array.isArray(tabs) ? tabs : []) (g[t.media_type] ??= []).push(t)
    return g
  }, [tabs])
  const toggleGroup = (type: string) => setExpanded(prev => {
    const n = new Set(prev); n.has(type) ? n.delete(type) : n.add(type); return n
  })

  useEffect(() => {
    sharedApi.settings.getMediaBaseDir().then(({ path }) => setMediaBase(path)).catch(() => {})
  }, [])

  useEffect(() => {
    if (newName && mediaBase) {
      const slug = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      setNewRootFolder(`${mediaBase}/${newType}/${slug}`)
    } else {
      setNewRootFolder('')
    }
  }, [newName, newType, mediaBase])

  const handleAdd = async () => {
    setCreating(true)
    try {
      const sanitizedName = newName.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      const dbPath = `./data/${newType}-${sanitizedName}.db`
      
      const newTab = await createTab({ name: newName, mediaType: newType, dbPath })
      
      if (newRootFolder) {
        await sharedApi.rootFolders.add(newRootFolder, newTab.id)
      }

      setShowAdd(false)
      setNewName('')
      setNewRootFolder('')
    } catch (err) {
      alert(String(err))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-noir-900 border border-white/5 p-5">
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-[10px] font-mono text-white/40 uppercase tracking-widest">Media Types</h4>
          <button onClick={relaunchOnboarding} className="text-[10px] font-bold uppercase tracking-widest text-[#00D4FF]/70 hover:text-[#00D4FF] transition-all">Launch setup wizard →</button>
        </div>
        <p className="text-xs text-white/30 mb-4">Toggle which media types appear in Archivist. Disabling one hides it everywhere; its data is kept and returns when you re-enable it.</p>
        <div className="flex flex-wrap gap-2">
          {MEDIA_TYPE_CHIPS.map(m => {
            const on = enabledMediaTypes.includes(m.key)
            return (
              <button key={m.key} onClick={() => {
                const next = on ? enabledMediaTypes.filter(t => t !== m.key) : [...enabledMediaTypes, m.key]
                if (next.length === 0) return
                saveEnabledMediaTypes(next)
              }}
                className={`px-4 py-2 rounded-xl border text-xs font-bold transition-all flex items-center gap-2 ${on ? 'border-white/20 bg-white/10 text-white' : 'border-white/5 bg-noir-950 text-white/30 hover:text-white/60'}`}>
                <span>{m.icon}</span>{m.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex justify-between items-center mb-4">
        <p className="text-xs text-white/30 font-mono italic">
          Isolated library instances. Each tab has its own database and settings.
        </p>
        <button onClick={() => setShowAdd(true)}
          className="px-4 py-2 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-[10px] font-bold uppercase tracking-widest transition-all">
          + Create New Tab
        </button>
      </div>

      <div className="space-y-3">
        {MEDIA_TYPE_CHIPS.filter(m => (grouped[m.key]?.length ?? 0) > 0).map(m => {
          const group = grouped[m.key]
          const open = expanded.has(m.key)
          return (
            <div key={m.key} className="rounded-2xl bg-noir-900 border border-white/5 overflow-hidden">
              <button onClick={() => toggleGroup(m.key)}
                className="w-full flex items-center gap-3 px-5 py-4 hover:bg-white/[0.02] transition-all">
                <span className="text-xl">{m.icon}</span>
                <span className="text-sm font-bold text-white tracking-tight">{m.label}</span>
                <span className="text-[10px] font-mono text-white/25 uppercase tracking-widest">{group.length} {group.length === 1 ? 'library' : 'libraries'}</span>
                <span className={`ml-auto text-white/30 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▾</span>
              </button>
              {open && (
                <div className="px-3 pb-3 space-y-2">
                  {group.map(t => (
                    <div key={t.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 rounded-xl bg-noir-950 border border-white/5">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white font-semibold truncate">{t.name}</p>
                        <p className="text-[10px] font-mono text-white/25 truncate">{t.db_path}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={async () => {
                            if (!confirm(`Clear all items from library "${t.name}"? The library itself is kept.`)) return
                            const alsoFiles = confirm(`Also DELETE the media files and folder for "${t.name}" from disk?\n\nOK = delete files.   Cancel = keep files on disk.`)
                            try {
                              const res = await clearTab(t.id, alsoFiles)
                              alert(`Cleared ${res.cleared} item(s) from "${t.name}"${alsoFiles ? ' and deleted the media files.' : '. Files on disk were kept.'}`)
                            } catch (err) { alert(String(err)) }
                          }}
                          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white hover:bg-white/10 text-[9px] font-bold uppercase tracking-widest transition-all">
                          Clear
                        </button>
                        <button
                          onClick={() => { if (confirm(`Remove library "${t.name}"? Media files on disk are kept.`)) deleteTab(t.id, false) }}
                          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white hover:bg-white/10 text-[9px] font-bold uppercase tracking-widest transition-all">
                          Remove
                        </button>
                        <button
                          onClick={() => { if (confirm(`PERMANENTLY DELETE library "${t.name}" and ALL its media files on disk?\n\nThis action cannot be undone.`)) deleteTab(t.id, true) }}
                          className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500/60 hover:text-red-500 hover:bg-red-500/20 text-[9px] font-bold uppercase tracking-widest transition-all">
                          Delete + Files
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {showAdd && (
        <Modal title="CREATE NEW TAB" onClose={() => setShowAdd(false)}>
          <div className="space-y-5 p-2">
            <Field label="Tab Name" hint="e.g. Anime Films, Kids TV">
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="My Library" />
            </Field>
            
            <div className="space-y-2">
              <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest">Media Type</p>
              <div className="grid grid-cols-3 gap-2">
                {['films', 'series', 'music', 'games', 'books', 'comics'].map(type => (
                  <button key={type} onClick={() => setNewType(type)}
                    className={`px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all border ${
                      newType === type ? 'bg-[#00D4FF] text-noir-950 border-[#00D4FF]' : 'bg-white/5 text-white/30 border-white/5 hover:border-white/10'
                    }`}>
                    {type}
                  </button>
                ))}
              </div>
            </div>

            <Field label="Root Folder" hint="Base directory for this library's media">
              <Input value={newRootFolder} onChange={e => setNewRootFolder(e.target.value)} placeholder="./media/films/kids" />
            </Field>

            <button onClick={handleAdd} disabled={creating || !newName}
              className="w-full mt-4 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#00D4FF] text-noir-950 text-[10px] font-bold uppercase tracking-widest hover:bg-[#00D4FF]/80 transition-all disabled:opacity-40">
              {creating ? <Spinner className="w-4 h-4" /> : null} Create Isolated Tab
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Quality Profiles ──────────────────────────────────────────────────────────

function QualityProfilesTab() {
  const [profiles, setProfiles] = useState<QualityProfile[]>([])
  useEffect(() => { sharedApi.qualityProfiles.list().then(setProfiles) }, [])

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {profiles.map(p => (
          <div key={p.id} className="px-4 py-3 rounded-xl bg-noir-900 border border-white/5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-sm font-medium text-white">{p.name}</p>
              <button onClick={() => { sharedApi.qualityProfiles.delete(p.id).then(() => setProfiles(prev => prev.filter(x => x.id !== p.id))) }}
                className="text-white/15 hover:text-[#FF2D78] transition-colors text-xs">✕</button>
            </div>
            <p className="text-xs font-mono text-white/30">Cutoff: {p.cutoff}</p>
            <div className="flex gap-1 mt-2 flex-wrap">
              {p.items?.map(item => <span key={item} className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-white/30 font-mono">{item}</span>)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Root Folders ──────────────────────────────────────────────────────────────

function RootFoldersTab() {
  const { activeTabId } = useTabs()
  const [folders, setFolders] = useState<RootFolder[]>([])
  const [allTabFolders, setAllTabFolders] = useState<Array<{ tabId: number; tabName: string; path: string }>>([])
  const [newPath, setNewPath] = useState('')

  useEffect(() => {
    sharedApi.rootFolders.list(activeTabId ?? undefined).then(setFolders)
    fetch('/api/v1/tabs/root-folders').then(r => r.json()).then(setAllTabFolders).catch(() => {})
  }, [activeTabId])

  const conflict = useMemo(() => {
    if (!newPath) return null
    return allTabFolders.find(f => f.path.toLowerCase() === newPath.toLowerCase() && f.tabId !== activeTabId)
  }, [newPath, allTabFolders, activeTabId])

  const formatSpace = (b: number) => b > 1e12 ? `${(b/1e12).toFixed(1)}TB` : `${(b/1e9).toFixed(0)}GB`

  return (
    <div>
      <div className="space-y-4 mb-6">
        <div className="flex gap-3">
          <Input value={newPath} onChange={e => setNewPath(e.target.value)} placeholder="/media/movies" className="flex-1" />
          <button onClick={async () => { const f = await sharedApi.rootFolders.add(newPath, activeTabId ?? undefined); setFolders(prev => [...prev, f]); setNewPath('') }}
            disabled={!newPath}
            className="px-4 py-2 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-sm transition-all disabled:opacity-40">
            + Add
          </button>
        </div>
        
        {conflict && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-3">
            <span className="text-amber-500 text-lg">⚠️</span>
            <div className="space-y-1">
              <p className="text-sm font-bold text-amber-500">Conflict Warning</p>
              <p className="text-xs text-white/60 font-mono">
                This root folder is already registered in tab: <span className="text-white font-bold">{conflict.tabName}</span>.
                Isolated folders are recommended to prevent cross-tab file locking.
              </p>
            </div>
          </div>
        )}
      </div>
      <div className="space-y-2">
        {folders.map(f => (
          <div key={f.id} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-noir-900 border border-white/5">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${f.accessible ? 'bg-[#00D4FF]' : 'bg-[#FF2D78]'}`} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono text-white truncate">{f.path}</p>
              {f.accessible && <p className="text-xs text-white/30 font-mono">{formatSpace(f.freeSpace)} free / {formatSpace(f.totalSpace)}</p>}
            </div>
            <button onClick={() => { sharedApi.rootFolders.delete(f.id, activeTabId ?? undefined).then(() => setFolders(prev => prev.filter(x => x.id !== f.id))) }}
              className="text-white/20 hover:text-[#FF2D78] transition-colors text-sm">✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── System Tab ────────────────────────────────────────────────────────────────

function SystemTab({ config, onUpdate }: { config: FlareSolverrConfig; onUpdate: (c: FlareSolverrConfig) => void }) {
  const [url, setUrl] = useState(config.url)
  const [enabled, setEnabled] = useState(config.enabled)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [overview, setOverview] = useState<SystemOverview | null>(null)
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null)
  const [integrityConfig, setIntegrityConfig] = useState<IntegrityConfig | null>(null)
  const [integritySaving, setIntegritySaving] = useState(false)
  const [integrityRunning, setIntegrityRunning] = useState(false)
  const [jobs, setJobs] = useState<SystemJob[]>([])
  const [imports, setImports] = useState<any[]>([])
  const [loadingOps, setLoadingOps] = useState(true)
  const [checkpointing, setCheckpointing] = useState(false)
  const [maintenanceSaving, setMaintenanceSaving] = useState(false)
  const [maintenanceRunning, setMaintenanceRunning] = useState(false)
  const [backupSaving, setBackupSaving] = useState(false)
  const [backupRunning, setBackupRunning] = useState(false)
  const [repairingProblemId, setRepairingProblemId] = useState<string | null>(null)

  const refreshOps = async () => {
    setLoadingOps(true)
    try {
      const [nextOverview, nextIntegrity, nextJobs, nextImports] = await Promise.all([
        sharedApi.system.overview(),
        sharedApi.system.integrity(),
        sharedApi.system.jobs(25),
        sharedApi.system.mediaImports(25),
      ])
      setOverview(nextOverview)
      setIntegrity(nextIntegrity.current)
      setIntegrityConfig(nextIntegrity.config)
      setJobs(nextJobs.jobs)
      setImports(nextImports.imports)
    } finally {
      setLoadingOps(false)
    }
  }

  useEffect(() => {
    refreshOps().catch(console.error)
    const id = setInterval(() => refreshOps().catch(() => {}), 15000)
    return () => clearInterval(id)
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await sharedApi.settings.setFlareSolverr({ url, enabled })
      onUpdate(updated)
    } finally { setSaving(false) }
  }

  const handleRefresh = async (type: string, api: any) => {
    setRefreshing(type)
    try {
      const res = await api.refresh()
      alert(res.message || `Successfully started refresh for ${type}.`)
    } catch (err) {
      alert(String(err))
    } finally { setRefreshing(null) }
  }

  const TOOLS = [
    { label: 'Films',  api: filmsApi },
    { label: 'Series', api: seriesApi },
    { label: 'Music',  api: musicApi.artists },
    { label: 'Books',  api: booksApi.authors },
    { label: 'Comics', api: comicsApi.series },
    { label: 'Games',  api: gamesApi },
  ]

  const fmtBytes = (bytes?: number) => {
    if (!bytes) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit++
    }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
  }

  const fmtRate = (bytes?: number) => `${fmtBytes(bytes)}/s`

  const checkpoint = async () => {
    setCheckpointing(true)
    try {
      await sharedApi.system.checkpointDb()
      await refreshOps()
    } catch (err) {
      alert(String(err))
    } finally {
      setCheckpointing(false)
    }
  }

  const retryJob = async (id: number) => {
    await sharedApi.system.retryJob(id)
    await refreshOps()
  }

  const cancelJob = async (id: number) => {
    await sharedApi.system.cancelJob(id)
    await refreshOps()
  }

  const jobCounts = overview?.jobs.byStatus ?? {}
  const importCounts = overview?.imports.byStatus ?? {}
  const integrityCounts = integrity?.summary.bySeverity ?? overview?.integrity.bySeverity
  const dbProblems = overview?.databases.filter(d => !d.status.exists || !!d.status.error) ?? []
  const maintenance = overview?.maintenance
  const backups = overview?.backups

  const updateMaintenance = async (patch: Partial<MaintenanceConfig>) => {
    setMaintenanceSaving(true)
    try {
      await sharedApi.system.setMaintenance(patch)
      await refreshOps()
    } catch (err) {
      alert(String(err))
    } finally {
      setMaintenanceSaving(false)
    }
  }

  const runMaintenance = async () => {
    setMaintenanceRunning(true)
    try {
      await sharedApi.system.runMaintenance()
      await refreshOps()
    } catch (err) {
      alert(String(err))
    } finally {
      setMaintenanceRunning(false)
    }
  }

  const updateBackups = async (patch: Partial<BackupConfig>) => {
    setBackupSaving(true)
    try {
      await sharedApi.system.setBackups(patch)
      await refreshOps()
    } catch (err) {
      alert(String(err))
    } finally {
      setBackupSaving(false)
    }
  }

  const runBackup = async () => {
    setBackupRunning(true)
    try {
      await sharedApi.system.runBackup()
      await refreshOps()
    } catch (err) {
      alert(String(err))
    } finally {
      setBackupRunning(false)
    }
  }

  const repairProblem = async (problem: IntegrityReport['problems'][number]) => {
    const label = problem.category === 'stale-acquisition'
      ? 'Clear this stale acquisition?'
      : problem.category === 'missing-import-source'
        ? 'Remove this missing import record?'
        : problem.category === 'orphaned-download'
          ? 'Remove this orphaned download from disk?'
          : 'Repair this integrity problem?'
    if (!confirm(label)) return
    setRepairingProblemId(problem.id)
    try {
      const res = await sharedApi.system.repairIntegrity(problem)
      setIntegrity(res.integrity)
      await refreshOps()
    } catch (err) {
      alert(String(err))
    } finally {
      setRepairingProblemId(null)
    }
  }

  const runIntegrity = async () => {
    setIntegrityRunning(true)
    try {
      const res = await sharedApi.system.runIntegrity()
      setIntegrity(res.report)
      await refreshOps()
    } catch (err) {
      alert(String(err))
    } finally {
      setIntegrityRunning(false)
    }
  }

  const updateIntegrity = async (patch: Partial<IntegrityConfig>) => {
    setIntegritySaving(true)
    try {
      const res = await sharedApi.system.setIntegrity(patch)
      setIntegrityConfig(res.config)
      await refreshOps()
    } catch (err) {
      alert(String(err))
    } finally {
      setIntegritySaving(false)
    }
  }

  const resetStuckAcquisitions = async () => {
    setRepairingProblemId('stuck')
    try {
      // Fresh scan so we catch anything stuck right now, then reset just the
      // stale acquisitions (grabbed but the torrent has left the client).
      const scan = await sharedApi.system.runIntegrity()
      setIntegrity(scan.report)
      const stuck = scan.report.problems.filter(p => p.category === 'stale-acquisition')
      if (stuck.length === 0) { alert('No stuck acquisitions found — nothing to reset.'); return }
      if (!confirm(`Reset ${stuck.length} stuck acquisition${stuck.length === 1 ? '' : 's'}? Each returns to "missing" and its dead release is blocklisted, so the next search won't re-grab it.`)) return
      const res = await sharedApi.system.repairIntegrityBulk(stuck)
      setIntegrity(res.integrity)
      await refreshOps()
    } catch (err) {
      alert(String(err))
    } finally {
      setRepairingProblemId(null)
    }
  }

  const bulkRepairSafe = async () => {
    const repairable = (integrity?.problems ?? []).filter(problem => problem.category === 'stale-acquisition' || problem.category === 'missing-import-source' || problem.category === 'orphaned-download')
    if (repairable.length === 0) return
    if (!confirm(`Repair ${repairable.length} safe integrity problem${repairable.length === 1 ? '' : 's'}?`)) return
    setRepairingProblemId('bulk')
    try {
      const res = await sharedApi.system.repairIntegrityBulk(repairable)
      setIntegrity(res.integrity)
      await refreshOps()
    } catch (err) {
      alert(String(err))
    } finally {
      setRepairingProblemId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
          <p className="text-[9px] font-mono text-white/25 uppercase tracking-widest">Torrents</p>
          <p className="mt-2 text-2xl font-display text-white">{overview?.torrents.total ?? 0}</p>
          <p className="mt-1 text-[10px] font-mono text-white/30">
            ↓ {fmtRate(overview?.torrents.downloadSpeed)} · ↑ {fmtRate(overview?.torrents.uploadSpeed)}
          </p>
        </div>
        <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
          <p className="text-[9px] font-mono text-white/25 uppercase tracking-widest">Jobs</p>
          <p className="mt-2 text-2xl font-display text-white">{jobCounts.queued ?? 0}</p>
          <p className="mt-1 text-[10px] font-mono text-white/30">{jobCounts.running ?? 0} running · {jobCounts.failed ?? 0} failed</p>
        </div>
        <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
          <p className="text-[9px] font-mono text-white/25 uppercase tracking-widest">Imports</p>
          <p className="mt-2 text-2xl font-display text-white">{importCounts.queued ?? 0}</p>
          <p className="mt-1 text-[10px] font-mono text-white/30">{importCounts.running ?? 0} running · {importCounts.failed ?? 0} failed</p>
        </div>
        <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
          <p className="text-[9px] font-mono text-white/25 uppercase tracking-widest">Integrity</p>
          <p className="mt-2 text-2xl font-display text-white">{integrity?.summary.total ?? overview?.integrity.total ?? 0}</p>
          <p className="mt-1 text-[10px] font-mono text-white/30">{integrityCounts?.error ?? 0} errors · {integrityCounts?.warn ?? 0} warnings</p>
        </div>
      </div>

      <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h3 className="text-sm font-medium text-white uppercase tracking-widest">Data Integrity</h3>
            <p className="mt-1 text-[10px] font-mono text-white/30">
              {integrity ? `Scanned ${new Date(integrity.generatedAt).toLocaleString()}` : 'Integrity scan has not completed yet'}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-3 text-[10px] font-mono mr-2">
              <span className="text-[#FF2D78]">{integrity?.summary.bySeverity.error ?? 0} error</span>
              <span className="text-yellow-400">{integrity?.summary.bySeverity.warn ?? 0} warning</span>
              <span className="text-white/30">{integrity?.summary.bySeverity.info ?? 0} info</span>
            </div>
            <button onClick={() => integrityConfig && updateIntegrity({ enabled: !integrityConfig.enabled })} disabled={!integrityConfig || integritySaving}
              className={`px-2.5 py-1.5 rounded-lg border text-[9px] font-bold uppercase tracking-widest transition-all disabled:opacity-40 ${
                integrityConfig?.enabled ? 'bg-emerald-400/10 border-emerald-400/30 text-emerald-400' : 'bg-white/5 border-white/10 text-white/35'
              }`}>
              {integrityConfig?.enabled ? 'Scheduled On' : 'Scheduled Off'}
            </button>
            <button onClick={runIntegrity} disabled={integrityRunning}
              className="px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/45 hover:text-white text-[9px] font-bold uppercase tracking-widest disabled:opacity-40">
              {integrityRunning ? 'Scanning' : 'Scan Now'}
            </button>
            <button onClick={resetStuckAcquisitions} disabled={repairingProblemId === 'stuck' || integrityRunning}
              title="Scan for items stuck 'acquiring' whose torrent has left the download client, then reset them to missing and blocklist the dead release."
              className="px-2.5 py-1.5 rounded-lg bg-yellow-400/10 border border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/20 text-[9px] font-bold uppercase tracking-widest disabled:opacity-40">
              {repairingProblemId === 'stuck' ? 'Resetting' : 'Reset Stuck'}
            </button>
            <button onClick={bulkRepairSafe} disabled={repairingProblemId === 'bulk' || !(integrity?.problems ?? []).some(p => p.category === 'stale-acquisition' || p.category === 'missing-import-source' || p.category === 'orphaned-download')}
              className="px-2.5 py-1.5 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-[9px] font-bold uppercase tracking-widest disabled:opacity-40">
              {repairingProblemId === 'bulk' ? 'Repairing' : 'Repair Safe'}
            </button>
          </div>
        </div>

        {integrityConfig && (
          <div className="mb-4 grid grid-cols-1 sm:grid-cols-[160px_1fr_1fr] gap-3">
            <Field label="Scan Interval" hint="hours">
              <Input
                type="number"
                min={1}
                value={integrityConfig.intervalHours}
                onChange={e => updateIntegrity({ intervalHours: Number(e.target.value) })}
              />
            </Field>
            <div className="flex items-end pb-6">
              <Toggle
                checked={integrityConfig.recordCleanScans}
                onChange={v => updateIntegrity({ recordCleanScans: v })}
                label="Record clean scans in event history"
              />
            </div>
            <div className="flex items-end pb-6">
              <Toggle
                checked={integrityConfig.backupBeforeRepair}
                onChange={v => updateIntegrity({ backupBeforeRepair: v })}
                label="Back up before repairs"
              />
            </div>
          </div>
        )}

        {(integrity?.problems ?? []).length === 0 ? (
          <p className="text-xs text-white/25 font-mono py-6 text-center">No integrity problems detected</p>
        ) : (
          <div className="space-y-2 max-h-[360px] overflow-y-auto custom-scrollbar pr-1">
            {integrity!.problems.slice(0, 50).map(problem => {
              const repairable = problem.category === 'stale-acquisition' || problem.category === 'missing-import-source' || problem.category === 'orphaned-download'
              return (
              <div key={problem.id} className="px-3 py-2 rounded-lg bg-white/[0.02] border border-white/5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-white/70 truncate">{problem.message}</p>
                    <p className="mt-0.5 text-[9px] font-mono text-white/25 truncate">
                      {problem.category} · {problem.tabName ?? problem.scope}{problem.path ? ` · ${problem.path}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-[9px] font-bold uppercase tracking-widest ${
                      problem.severity === 'error' ? 'text-[#FF2D78]' : problem.severity === 'warn' ? 'text-yellow-400' : 'text-white/35'
                    }`}>{problem.severity}</span>
                    {repairable && (
                      <button
                        onClick={() => repairProblem(problem)}
                        disabled={repairingProblemId === problem.id}
                        className="px-2 py-1 rounded bg-[#00D4FF]/10 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-[9px] font-bold uppercase tracking-widest disabled:opacity-40"
                      >
                        {repairingProblemId === problem.id ? 'Repairing' : 'Repair'}
                      </button>
                    )}
                  </div>
                </div>
                {problem.action && <p className="mt-1 text-[10px] font-mono text-[#00D4FF]/50">{problem.action}</p>}
              </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
        <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-white uppercase tracking-widest">Operations</h3>
            <div className="flex gap-2">
              <button onClick={() => refreshOps().catch(console.error)} disabled={loadingOps}
                className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white/50 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40">
                {loadingOps ? 'Refreshing' : 'Refresh'}
              </button>
              <button onClick={checkpoint} disabled={checkpointing}
                className="px-3 py-2 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40">
                {checkpointing ? 'Checkpointing' : 'Checkpoint DBs'}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/5 text-[9px] font-mono text-white/25 uppercase tracking-widest">
                  <th className="text-left py-2 pr-3">Database</th>
                  <th className="text-left py-2 pr-3">Type</th>
                  <th className="text-right py-2 pr-3">Size</th>
                  <th className="text-right py-2 pr-3">WAL</th>
                  <th className="text-right py-2">Pages</th>
                </tr>
              </thead>
              <tbody>
                {(overview?.databases ?? []).map(db => (
                  <tr key={`${db.scope}-${db.name}`} className="border-b border-white/[0.03]">
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${db.status.exists && !db.status.error ? 'bg-emerald-400' : 'bg-[#FF2D78]'}`} />
                        <span className="text-white/70">{db.name}</span>
                      </div>
                      <p className="mt-0.5 text-[9px] font-mono text-white/20 truncate max-w-md">{db.dbPath}</p>
                    </td>
                    <td className="py-2 pr-3 font-mono text-white/35">{db.mediaType}</td>
                    <td className="py-2 pr-3 text-right font-mono text-white/35">{fmtBytes(db.status.databaseBytes)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-white/35">{fmtBytes(db.status.walBytes)}</td>
                    <td className="py-2 text-right font-mono text-white/35">{db.status.pageCount ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {dbProblems.length > 0 && (
            <div className="mt-4 rounded-xl bg-[#FF2D78]/10 border border-[#FF2D78]/20 px-4 py-3 text-xs text-[#FF2D78]/80 font-mono">
              {dbProblems.length} database issue{dbProblems.length === 1 ? '' : 's'} detected
            </div>
          )}
        </div>

        <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
          <h3 className="text-sm font-medium text-white uppercase tracking-widest mb-4">Recent Problems</h3>
          <div className="space-y-2 max-h-[360px] overflow-y-auto custom-scrollbar pr-1">
            {(overview?.events.recentProblems ?? []).length === 0 ? (
              <p className="text-xs text-white/25 font-mono py-6 text-center">No warnings or errors</p>
            ) : overview!.events.recentProblems.map(event => (
              <div key={event.id} className="px-3 py-2 rounded-lg bg-white/[0.02] border border-white/5">
                <div className="flex items-center justify-between gap-3">
                  <span className={`text-[9px] font-bold uppercase tracking-widest ${event.severity === 'error' ? 'text-[#FF2D78]' : 'text-yellow-400'}`}>
                    {event.category}.{event.action}
                  </span>
                  <span className="text-[9px] font-mono text-white/20 whitespace-nowrap">{new Date(event.ts).toLocaleTimeString()}</span>
                </div>
                <p className="mt-1 text-xs text-white/55 line-clamp-2">{event.message}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5">
          <div>
            <h3 className="text-sm font-medium text-white uppercase tracking-widest">Maintenance</h3>
            <p className="mt-1 text-[10px] font-mono text-white/30">
              {maintenance?.lastResult
                ? `Last run ${new Date(maintenance.lastResult.finishedAt).toLocaleString()}`
                : 'No completed maintenance run yet'}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => maintenance && updateMaintenance({ enabled: !maintenance.config.enabled })} disabled={!maintenance || maintenanceSaving}
              className={`px-3 py-2 rounded-lg border text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40 ${
                maintenance?.config.enabled
                  ? 'bg-emerald-400/10 border-emerald-400/30 text-emerald-400'
                  : 'bg-white/5 border-white/10 text-white/35'
              }`}>
              {maintenance?.config.enabled ? 'Scheduled On' : 'Scheduled Off'}
            </button>
            <button onClick={runMaintenance} disabled={maintenanceRunning}
              className="px-3 py-2 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40">
              {maintenanceRunning ? 'Running' : 'Run Now'}
            </button>
          </div>
        </div>

        {maintenance && (
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            {([
              ['intervalHours', 'Interval', 'hours'],
              ['jobRetentionDays', 'Jobs', 'days'],
              ['eventRetentionDays', 'Events', 'days'],
              ['importRetentionDays', 'Imports', 'days'],
              ['acquisitionRetentionDays', 'Decisions', 'days'],
              ['staleRunningJobMinutes', 'Stale Jobs', 'min'],
            ] as const).map(([key, label, unit]) => (
              <Field key={key} label={label} hint={unit}>
                <Input
                  type="number"
                  min={1}
                  value={maintenance.config[key]}
                  onChange={e => updateMaintenance({ [key]: Number(e.target.value) } as Partial<MaintenanceConfig>)}
                />
              </Field>
            ))}
            <div className="flex items-end pb-6">
              <Toggle
                checked={maintenance.config.checkpointDatabases}
                onChange={v => updateMaintenance({ checkpointDatabases: v })}
                label="Checkpoint"
              />
            </div>
          </div>
        )}

        {maintenance?.lastResult && (
          <div className="mt-5 grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="px-3 py-3 rounded-lg bg-white/[0.02] border border-white/5">
              <p className="text-[9px] font-mono text-white/25 uppercase tracking-widest">Recovered</p>
              <p className="mt-1 text-lg font-display text-white">{maintenance.lastResult.recoveredJobs}</p>
            </div>
            <div className="px-3 py-3 rounded-lg bg-white/[0.02] border border-white/5">
              <p className="text-[9px] font-mono text-white/25 uppercase tracking-widest">Jobs Pruned</p>
              <p className="mt-1 text-lg font-display text-white">{maintenance.lastResult.deletedJobs}</p>
            </div>
            <div className="px-3 py-3 rounded-lg bg-white/[0.02] border border-white/5">
              <p className="text-[9px] font-mono text-white/25 uppercase tracking-widest">Events Pruned</p>
              <p className="mt-1 text-lg font-display text-white">{maintenance.lastResult.deletedEvents}</p>
            </div>
            <div className="px-3 py-3 rounded-lg bg-white/[0.02] border border-white/5">
              <p className="text-[9px] font-mono text-white/25 uppercase tracking-widest">Imports Pruned</p>
              <p className="mt-1 text-lg font-display text-white">{maintenance.lastResult.deletedImports}</p>
            </div>
            <div className="px-3 py-3 rounded-lg bg-white/[0.02] border border-white/5">
              <p className="text-[9px] font-mono text-white/25 uppercase tracking-widest">DBs Checked</p>
              <p className="mt-1 text-lg font-display text-white">{maintenance.lastResult.checkpointedDatabases.filter(d => d.ok).length}</p>
            </div>
          </div>
        )}
      </div>

      <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5">
          <div>
            <h3 className="text-sm font-medium text-white uppercase tracking-widest">Backups</h3>
            <p className="mt-1 text-[10px] font-mono text-white/30">
              {backups?.lastBackup
                ? `Last backup ${new Date(backups.lastBackup.createdAt).toLocaleString()}`
                : 'No backup has completed yet'}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => backups && updateBackups({ enabled: !backups.config.enabled })} disabled={!backups || backupSaving}
              className={`px-3 py-2 rounded-lg border text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40 ${
                backups?.config.enabled
                  ? 'bg-emerald-400/10 border-emerald-400/30 text-emerald-400'
                  : 'bg-white/5 border-white/10 text-white/35'
              }`}>
              {backups?.config.enabled ? 'Scheduled On' : 'Scheduled Off'}
            </button>
            <button onClick={runBackup} disabled={backupRunning}
              className="px-3 py-2 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40">
              {backupRunning ? 'Creating' : 'Back Up Now'}
            </button>
          </div>
        </div>

        {backups && (
          <div className="grid grid-cols-1 md:grid-cols-[160px_160px_1fr] gap-3 mb-5">
            <Field label="Interval" hint="hours">
              <Input
                type="number"
                min={1}
                value={backups.config.intervalHours}
                onChange={e => updateBackups({ intervalHours: Number(e.target.value) })}
              />
            </Field>
            <Field label="Retention" hint="backups">
              <Input
                type="number"
                min={1}
                value={backups.config.retentionCount}
                onChange={e => updateBackups({ retentionCount: Number(e.target.value) })}
              />
            </Field>
            <div className="flex items-end pb-6">
              <Toggle
                checked={backups.config.includeTorrentState}
                onChange={v => updateBackups({ includeTorrentState: v })}
                label="Include torrent resume and .torrent state"
              />
            </div>
          </div>
        )}

        <div className="space-y-2 max-h-[320px] overflow-y-auto custom-scrollbar pr-1">
          {(backups?.backups ?? []).length === 0 ? (
            <p className="text-xs text-white/25 font-mono py-6 text-center">No backups</p>
          ) : backups!.backups.map(backup => {
            const totalBytes = backup.files.reduce((sum, f) => sum + f.bytes, 0)
            return (
              <div key={backup.id} className="px-3 py-2 rounded-lg bg-white/[0.02] border border-white/5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-white/70 truncate">{backup.id}</p>
                    <p className="text-[9px] font-mono text-white/25 truncate">{backup.backupPath}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-[10px] font-mono text-white/45">{fmtBytes(totalBytes)}</p>
                    <p className="text-[9px] font-mono text-white/25">{backup.files.length} files</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
          <h3 className="text-sm font-medium text-white uppercase tracking-widest mb-4">Jobs</h3>
          <div className="space-y-2 max-h-[420px] overflow-y-auto custom-scrollbar pr-1">
            {jobs.length === 0 ? <p className="text-xs text-white/25 font-mono py-6 text-center">No jobs</p> : jobs.map(job => (
              <div key={job.id} className="px-3 py-2 rounded-lg bg-white/[0.02] border border-white/5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-white/70 truncate">#{job.id} {job.type}</p>
                    <p className="text-[9px] font-mono text-white/25">{job.attempts}/{job.maxAttempts} attempts · {job.subjectType ?? 'system'} {job.subjectId ?? ''}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[9px] font-bold uppercase tracking-widest ${
                      job.status === 'failed' ? 'text-[#FF2D78]' : job.status === 'running' ? 'text-[#00D4FF]' : job.status === 'succeeded' ? 'text-emerald-400' : 'text-white/35'
                    }`}>{job.status}</span>
                    {job.status === 'failed' && (
                      <button onClick={() => retryJob(job.id)} className="px-2 py-1 rounded bg-[#00D4FF]/10 text-[#00D4FF] text-[9px] font-bold uppercase tracking-widest">Retry</button>
                    )}
                    {(job.status === 'queued' || job.status === 'running') && (
                      <button onClick={() => cancelJob(job.id)} className="px-2 py-1 rounded bg-white/5 text-white/35 hover:text-white text-[9px] font-bold uppercase tracking-widest">Cancel</button>
                    )}
                  </div>
                </div>
                {job.lastError && <p className="mt-2 text-[10px] font-mono text-[#FF2D78]/70 line-clamp-2">{job.lastError}</p>}
              </div>
            ))}
          </div>
        </div>

        <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
          <h3 className="text-sm font-medium text-white uppercase tracking-widest mb-4">Import History</h3>
          <div className="space-y-2 max-h-[420px] overflow-y-auto custom-scrollbar pr-1">
            {imports.length === 0 ? <p className="text-xs text-white/25 font-mono py-6 text-center">No imports</p> : imports.map(row => (
              <div key={row.id} className="px-3 py-2 rounded-lg bg-white/[0.02] border border-white/5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-white/70 truncate">{row.media_type} #{row.item_id}</p>
                    <p className="text-[9px] font-mono text-white/25 truncate">{row.tab_name ?? 'unknown'} · {row.source_path}</p>
                  </div>
                  <span className={`text-[9px] font-bold uppercase tracking-widest ${
                    row.status === 'failed' ? 'text-[#FF2D78]' : row.status === 'running' ? 'text-[#00D4FF]' : row.status === 'succeeded' ? 'text-emerald-400' : 'text-white/35'
                  }`}>{row.status}</span>
                </div>
                {row.error && <p className="mt-2 text-[10px] font-mono text-[#FF2D78]/70 line-clamp-2">{row.error}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
        <h3 className="text-sm font-medium text-white mb-4">FlareSolverr Configuration</h3>
        <p className="text-xs text-white/30 mb-4 leading-relaxed">
          FlareSolverr is a proxy server to bypass Cloudflare and DDoS protection. 
          If you are getting 403 Forbidden errors on indexers, install FlareSolverr and provide the URL here.
        </p>
        <div className="space-y-4">
          <Field label="FlareSolverr URL" hint="Usually http://localhost:8191">
            <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:8191" />
          </Field>
          <Toggle checked={enabled} onChange={setEnabled} label="Enable FlareSolverr integration" />
          <button onClick={handleSave} disabled={saving || !url}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-sm transition-all disabled:opacity-40">
            {saving ? <Spinner className="w-4 h-4" /> : null} Save System Settings
          </button>
        </div>
      </div>

      <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl">
        <h3 className="text-sm font-medium text-white mb-6 uppercase tracking-widest text-gradient-cyan">Metadata Tools</h3>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {TOOLS.map(tool => (
            <button 
              key={tool.label}
              onClick={() => handleRefresh(tool.label, tool.api)} 
              disabled={!!refreshing}
              className="flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white/70 hover:text-white hover:border-white/20 text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40"
            >
              {refreshing === tool.label ? <Spinner className="w-4 h-4" /> : '↻'} 
              Refresh {tool.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── API Keys Tab ──────────────────────────────────────────────────────────────

function ApiKeysTab() {
  const [config, setConfig] = useState<ApiKeysConfig>({
    tmdbApiKey: '',
    tvdbApiKey: '',
    tvdbPin: '',
    googleBooksApiKey: '',
    comicvineApiKey: '',
    igdbClientId: '',
    igdbClientSecret: '',
    fanartApiKey: '',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    sharedApi.settings.getApiKeys().then(setConfig).catch(console.error)
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await sharedApi.settings.setApiKeys(config)
      alert('API keys saved and written to .env')
    } catch (err) {
      alert(String(err))
    } finally {
      setSaving(false)
    }
  }

  const update = (key: keyof ApiKeysConfig, value: string) => {
    setConfig(prev => ({ ...prev, [key]: value }))
  }

  return (
    <div className="space-y-6">
      <div className="px-4 py-4 rounded-xl bg-noir-900 border border-white/5">
        <h3 className="text-sm font-medium text-white mb-4 text-gradient-cyan">External Service API Keys</h3>
        <p className="text-xs text-white/30 mb-6 leading-relaxed font-mono">
          These keys are required for metadata fetching and search. Saving will update the current session and write to your .env file.
        </p>
        
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="TMDB API Key" hint="For Movies metadata">
              <Input value={config.tmdbApiKey} onChange={e => update('tmdbApiKey', e.target.value)} placeholder="API Key" />
            </Field>
            <div className="space-y-4">
              <Field label="TVDB API Key" hint="For TV Series metadata">
                <Input value={config.tvdbApiKey} onChange={e => update('tvdbApiKey', e.target.value)} placeholder="API Key" />
              </Field>
              <Field label="TVDB PIN" hint="Required for some TVDB accounts">
                <Input value={config.tvdbPin} onChange={e => update('tvdbPin', e.target.value)} placeholder="PIN" />
              </Field>
            </div>
          </div>

          <hr className="border-white/5" />

          <Field label="Google Books API Key" hint="Optional for Books (OpenLibrary fallback)">
            <Input value={config.googleBooksApiKey} onChange={e => update('googleBooksApiKey', e.target.value)} placeholder="API Key" />
          </Field>

          <Field label="ComicVine API Key" hint="Required for Comics metadata">
            <Input value={config.comicvineApiKey} onChange={e => update('comicvineApiKey', e.target.value)} placeholder="API Key" />
          </Field>

          <Field label="Fanart.tv API Key" hint="For high-quality Music backdrops and logos">
            <Input value={config.fanartApiKey} onChange={e => update('fanartApiKey', e.target.value)} placeholder="API Key" />
          </Field>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="IGDB Client ID" hint="Required for Games metadata">
              <Input value={config.igdbClientId} onChange={e => update('igdbClientId', e.target.value)} placeholder="Client ID" />
            </Field>
            <Field label="IGDB Client Secret" hint="Required for Games metadata">
              <Input value={config.igdbClientSecret} onChange={e => update('igdbClientSecret', e.target.value)} placeholder="Client Secret" type="password" />
            </Field>
          </div>

          <button onClick={handleSave} disabled={saving}
            className="w-full mt-4 flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-sm font-medium transition-all disabled:opacity-40">
            {saving ? <Spinner className="w-4 h-4" /> : '💾'} Save & Update .env
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Quality Tiers Tab ─────────────────────────────────────────────────────────

const MEDIA_TYPES: { key: TierMediaType; label: string }[] = [
  { key: 'films',  label: 'Films'  },
  { key: 'series', label: 'Series' },
  { key: 'music',  label: 'Music'  },
  { key: 'games',  label: 'Games'  },
  { key: 'comics', label: 'Comics' },
]

const TIER_LABELS = ['Tier 1', 'Tier 2', 'Tier 3'] as const
// Description prefixes only — the term lists shown to the user are derived from
// the loaded config so they always reflect the server's DEFAULT_TIERS.
const TIER_DESCRIPTIONS = ['Best quality', 'Good quality', 'Acceptable'] as const

function TierAccordion({
  tierKey, label, description, terms, onChange,
}: {
  tierKey: 'tier1' | 'tier2' | 'tier3'
  label: string
  description: string
  terms: TierTerm[]
  onChange: (terms: TierTerm[]) => void
}) {
  const [open, setOpen] = useState(tierKey === 'tier1')
  const [newTerm, setNewTerm] = useState('')

  const toggleMedia = (termIdx: number, media: TierMediaType) => {
    const updated = terms.map((t, i) => {
      if (i !== termIdx) return t
      const has = t.mediaTypes.includes(media)
      return { ...t, mediaTypes: has ? t.mediaTypes.filter(m => m !== media) : [...t.mediaTypes, media] }
    })
    onChange(updated)
  }

  const addTerm = () => {
    const t = newTerm.trim()
    if (!t || terms.some(x => x.term.toLowerCase() === t.toLowerCase())) return
    onChange([...terms, { term: t, mediaTypes: ['films'] }])
    setNewTerm('')
  }

  const deleteTerm = (idx: number) => onChange(terms.filter((_, i) => i !== idx))

  const moveTerm = (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= terms.length) return
    const updated = [...terms]
    const [moved] = updated.splice(idx, 1)
    updated.splice(newIdx, 0, moved)
    onChange(updated)
  }

  const accentColor = tierKey === 'tier1' ? '#00D4FF' : tierKey === 'tier2' ? '#A78BFA' : '#FB923C'

  return (
    <div className="border border-white/10 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-white/[0.02] transition-all"
      >
        <div className="flex items-center gap-4">
          <span className="text-xs font-bold uppercase tracking-[0.2em]" style={{ color: accentColor }}>{label}</span>
          <span className="text-[10px] text-white/30 font-mono">{terms.length} terms</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-white/20 hidden sm:block max-w-xs truncate">{description}</span>
          <span className="text-white/40 text-xs">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-white/5 p-6 space-y-4">
          {terms.length === 0 ? (
            <p className="text-white/20 text-xs font-mono text-center py-4">No terms yet — add one below</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/5">
                    <th className="text-left pb-3 text-white/30 font-mono uppercase tracking-widest text-[10px] w-32 pr-4">Term</th>
                    {MEDIA_TYPES.map(m => (
                      <th key={m.key} className="pb-3 text-white/30 font-mono uppercase tracking-widest text-[10px] text-center px-2">{m.label}</th>
                    ))}
                    <th className="pb-3 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {terms.map((t, i) => (
                    <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02] group">
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <div className="flex flex-col opacity-0 group-hover:opacity-100 transition-opacity">
                            <button 
                              onClick={() => moveTerm(i, -1)} 
                              disabled={i === 0}
                              className="text-[8px] text-white/20 hover:text-[#00D4FF] disabled:opacity-0 leading-none p-0.5"
                            >▲</button>
                            <button 
                              onClick={() => moveTerm(i, 1)} 
                              disabled={i === terms.length - 1}
                              className="text-[8px] text-white/20 hover:text-[#00D4FF] disabled:opacity-0 leading-none p-0.5"
                            >▼</button>
                          </div>
                          <span className="font-mono text-white/80">{t.term}</span>
                        </div>
                      </td>
                      {MEDIA_TYPES.map(m => (
                        <td key={m.key} className="py-3 text-center px-2">
                          <input
                            type="checkbox"
                            checked={t.mediaTypes.includes(m.key)}
                            onChange={() => toggleMedia(i, m.key)}
                            className="w-4 h-4 rounded accent-current cursor-pointer"
                            style={{ accentColor }}
                          />
                        </td>
                      ))}
                      <td className="py-3 text-right">
                        <button
                          onClick={() => deleteTerm(i)}
                          className="opacity-0 group-hover:opacity-100 text-red-500/60 hover:text-red-500 transition-all text-xs px-2"
                        >✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <input
              type="text"
              value={newTerm}
              onChange={e => setNewTerm(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addTerm()}
              placeholder="Add release group (e.g. QxR, SARTRE, YIFY)..."
              className="flex-1 px-3 py-2 rounded-xl bg-noir-800 border border-white/10 text-white text-xs focus:outline-none focus:border-white/30 transition-all font-mono"
            />
            <button
              onClick={addTerm}
              className="px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all border"
              style={{ backgroundColor: `${accentColor}20`, borderColor: `${accentColor}40`, color: accentColor }}
            >Add</button>
          </div>
        </div>
      )}
    </div>
  )
}

function QualityTiersTab() {
  // Empty placeholder until the fetch resolves; the real defaults come from the
  // server (getQualityTiers falls back to DEFAULT_TIERS when nothing is saved).
  const [config, setConfig] = useState<TierConfig>({ tier1: [], tier2: [], tier3: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    sharedApi.settings.getQualityTiers().then(setConfig).finally(() => setLoading(false))
  }, [])

  const updateTier = (key: 'tier1' | 'tier2' | 'tier3') => (terms: TierTerm[]) => {
    setConfig(c => ({ ...c, [key]: terms }))
    setSaved(false)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await sharedApi.settings.setQualityTiers(config)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      alert('Failed to save: ' + String(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-white/30 text-sm font-mono">Loading...</div>

  return (
    <div className="space-y-4">
      <p className="text-white/30 text-xs font-mono leading-relaxed">
        Tiers are release groups, ranked best to acceptable. Each group is appended to indexer searches (per tier, per media type) to surface that encode, and ranks a returned release when its group matches. Resolution, source and codec aren't set here — they're guardrails under Acquisition Defaults.
      </p>

      {(['tier1', 'tier2', 'tier3'] as const).map((key, i) => {
        const terms = config[key].map(t => t.term).join(', ')
        return (
        <TierAccordion
          key={key}
          tierKey={key}
          label={TIER_LABELS[i]}
          description={terms ? `${TIER_DESCRIPTIONS[i]} — ${terms}` : TIER_DESCRIPTIONS[i]}
          terms={config[key]}
          onChange={updateTier(key)}
        />
        )
      })}

      <div className="flex items-center justify-end gap-4 pt-2">
        {saved && <span className="text-green-400 text-xs font-mono">Saved</span>}
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] text-xs font-bold uppercase tracking-widest hover:bg-[#00D4FF]/20 transition-all disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  )
}

// ── Acquisition Defaults Tab ──────────────────────────────────────────────────

function AcquisitionDefaultsTab() {
  const { tabs } = useTabs()
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null)

  const [config, setConfig] = useState<AcquisitionDefaults>({
    tier: 'Any',
    resolution: 'Any',
    source: 'Any',
    codec: 'Any',
    missingSearchBatchSize: 5,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setLoading(true)
    sharedApi.settings.getAcquisitionDefaults(selectedTabId || undefined)
      .then(setConfig)
      .finally(() => setLoading(false))
  }, [selectedTabId])

  const handleSave = async () => {
    setSaving(true)
    try {
      await sharedApi.settings.setAcquisitionDefaults(config, selectedTabId || undefined)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      alert('Failed to save: ' + String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2 overflow-x-auto custom-scrollbar pb-2">
        <button onClick={() => setSelectedTabId(null)}
          className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all whitespace-nowrap ${
            selectedTabId === null ? 'bg-[#00D4FF] text-noir-950 shadow-lg' : 'bg-white/5 text-white/40 hover:bg-white/10'
          }`}>
          Global Defaults
        </button>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setSelectedTabId(t.id)}
            className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all whitespace-nowrap ${
              selectedTabId === t.id ? 'bg-[#00D4FF] text-noir-950 shadow-lg' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}>
            {t.name}
          </button>
        ))}
      </div>

      <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl relative min-h-[400px]">
        {loading && (
          <div className="absolute inset-0 bg-noir-900/50 backdrop-blur-sm z-10 flex items-center justify-center rounded-2xl">
            <Spinner className="w-8 h-8" />
          </div>
        )}
        <h3 className="text-sm font-medium text-white mb-6 uppercase tracking-widest">
          {selectedTabId === null ? 'Global Acquisition Defaults' : `${tabs.find(t => t.id === selectedTabId)?.name} Defaults`}
        </h3>
        
        <div className="grid grid-cols-1 gap-8">
          <TabSelect label="Tier" value={config.tier} options={['Any', 'Tier 1', 'Tier 2', 'Tier 3']} onChange={v => setConfig({ ...config, tier: v })} />
          <TabSelect label="Resolution" value={config.resolution} options={['Any', '2160p', '1080p', '720p']} onChange={v => setConfig({ ...config, resolution: v })} />
          <TabSelect label="Source" value={config.source} options={['Any', 'BluRay', 'Web', 'DVD']} onChange={v => setConfig({ ...config, source: v })} />
          <TabSelect label="Codec" value={config.codec} options={['Any', 'Remux', 'AV1', 'x265', 'x264']} onChange={v => setConfig({ ...config, codec: v })} />

          <div className="space-y-2">
            <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Missing Search Batch Size</label>
            <input
              type="number"
              min={1}
              max={100}
              value={config.missingSearchBatchSize ?? 5}
              onChange={e => {
                const n = parseInt(e.target.value, 10)
                setConfig({ ...config, missingSearchBatchSize: Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 5 })
              }}
              className="w-32 bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/60 outline-none focus:border-white/20 transition-all"
            />
            <p className="text-[10px] font-mono text-white/25 tracking-tight">
              Items searched per library each time "Search Missing" runs (and per automatic hourly cycle).
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-4 pt-8 mt-8 border-t border-white/5">
          {saved && <span className="text-green-400 text-xs font-mono">Saved Successfully</span>}
          <button onClick={handleSave} disabled={saving}
            className="px-10 py-3 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] text-xs font-bold uppercase tracking-widest hover:bg-[#00D4FF]/20 transition-all disabled:opacity-50">
            {saving ? <Spinner className="w-4 h-4" /> : '💾'} Save Settings
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Media Processing Tab ─────────────────────────────────────────────────

function MediaProcessingTab() {
  const [config, setConfig] = useState<TrackCleanerConfig>({
    enabled: true,
    preferredLanguage: 'en',
    keepOriginalLanguage: true,
    keepPreferredAudio: true,
    keepPreferredSubs: true,
    keepCommentary: true,
    additionalLanguages: [],
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [ffmpegStatus, setFfmpegStatus] = useState<{ available: boolean; version: string } | null>(null)
  const [newLang, setNewLang] = useState('')

  useEffect(() => {
    Promise.all([
      sharedApi.settings.getTrackCleaner().then(setConfig),
      sharedApi.settings.getTrackCleanerStatus().then(setFfmpegStatus),
    ]).finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await sharedApi.settings.setTrackCleaner(config)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      alert('Failed to save: ' + String(err))
    } finally {
      setSaving(false)
    }
  }

  const addLang = () => {
    const code = newLang.trim().toLowerCase()
    if (code && code.length >= 2 && code.length <= 3 && !config.additionalLanguages.includes(code)) {
      setConfig({ ...config, additionalLanguages: [...config.additionalLanguages, code] })
      setNewLang('')
    }
  }

  const removeLang = (lang: string) => {
    setConfig({ ...config, additionalLanguages: config.additionalLanguages.filter(l => l !== lang) })
  }

  if (loading) return <div className="text-white/30 text-sm font-mono">Loading...</div>

  return (
    <div className="space-y-6">
      {/* ffmpeg status */}
      <div className="px-6 py-4 rounded-2xl bg-noir-900 border border-white/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${ffmpegStatus?.available ? 'bg-emerald-400' : 'bg-[#FF2D78]'}`} />
            <span className="text-xs font-mono text-white/50">
              {ffmpegStatus?.available
                ? `ffmpeg ${ffmpegStatus.version}`
                : 'ffmpeg not found'}
            </span>
          </div>
          {!ffmpegStatus?.available && (
            <span className="text-[10px] font-mono text-[#FF2D78]/60">Required for track cleaning</span>
          )}
        </div>
      </div>

      <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-sm font-medium text-white uppercase tracking-widest">Track Cleaner</h3>
            <p className="text-[10px] font-mono text-white/30 mt-1">
              Automatically keep original/preferred-language tracks after download. No re-encoding — streams are copied losslessly.
            </p>
          </div>
          <Toggle checked={config.enabled} onChange={v => setConfig({ ...config, enabled: v })} label="" />
        </div>

        <div className={`space-y-6 ${!config.enabled ? 'opacity-30 pointer-events-none' : ''}`}>
          {/* Preferred Language */}
          <div>
            <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Preferred Language</span>
            <p className="text-[10px] font-mono text-white/20 mt-1 mb-3">
              Your primary language. For films in this language, all matching audio and subtitle variants are kept. For foreign films, original-language tracks and preferred-language tracks are kept.
            </p>
            <select
              value={config.preferredLanguage}
              onChange={e => setConfig({ ...config, preferredLanguage: e.target.value })}
              className="px-3 py-2 rounded-lg bg-noir-800 border border-white/10 text-white text-xs focus:outline-none focus:border-white/30 transition-all"
            >
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
              <option value="nl">Dutch</option>
              <option value="sv">Swedish</option>
              <option value="no">Norwegian</option>
              <option value="da">Danish</option>
              <option value="fi">Finnish</option>
              <option value="pl">Polish</option>
              <option value="ru">Russian</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="zh">Chinese</option>
              <option value="ar">Arabic</option>
              <option value="hi">Hindi</option>
              <option value="tr">Turkish</option>
              <option value="th">Thai</option>
              <option value="vi">Vietnamese</option>
              <option value="cs">Czech</option>
              <option value="hu">Hungarian</option>
              <option value="ro">Romanian</option>
              <option value="el">Greek</option>
              <option value="he">Hebrew</option>
            </select>
          </div>

          <hr className="border-white/5" />

          {/* Audio settings */}
          <div>
            <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Audio Tracks</span>
            <div className="mt-3 space-y-3">
              <Toggle
                checked={config.keepOriginalLanguage}
                onChange={v => setConfig({ ...config, keepOriginalLanguage: v })}
                label="Keep original language audio"
              />
              <p className="text-[10px] font-mono text-white/20 ml-12 -mt-1">
                Detects the film/show's original language from TMDB metadata
              </p>
              <Toggle
                checked={config.keepPreferredAudio}
                onChange={v => setConfig({ ...config, keepPreferredAudio: v })}
                label="Keep preferred language audio"
              />
              <Toggle
                checked={config.keepCommentary}
                onChange={v => setConfig({ ...config, keepCommentary: v })}
                label="Keep untagged commentary and music-only tracks"
              />
            </div>
          </div>

          <hr className="border-white/5" />

          {/* Subtitle settings */}
          <div>
            <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Subtitle Tracks</span>
            <div className="mt-3 space-y-3">
              <Toggle
                checked={config.keepPreferredSubs}
                onChange={v => setConfig({ ...config, keepPreferredSubs: v })}
                label="Keep preferred language subtitles"
              />
              <p className="text-[10px] font-mono text-white/20 ml-12 -mt-1">
                Keeps subtitles in your preferred language. Original-language subtitles are kept with original-language audio.
              </p>
            </div>
          </div>

          <hr className="border-white/5" />

          {/* Additional languages */}
          <div>
            <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Additional Languages</span>
            <p className="text-[10px] font-mono text-white/20 mt-1 mb-3">
              Keep audio and subtitle tracks in these languages too (ISO 639-1 codes, e.g. es, fr, de, ja)
            </p>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={newLang}
                onChange={e => setNewLang(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addLang()}
                placeholder="e.g. es"
                maxLength={3}
                className="w-24 px-3 py-2 rounded-xl bg-noir-800 border border-white/10 text-white text-xs focus:outline-none focus:border-white/30 transition-all font-mono"
              />
              <button onClick={addLang} disabled={!newLang.trim()}
                className="px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 disabled:opacity-40">
                Add
              </button>
            </div>
            {config.additionalLanguages.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {config.additionalLanguages.map(lang => (
                  <span key={lang} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs font-mono text-white/60">
                    {lang}
                    <button onClick={() => removeLang(lang)} className="text-white/20 hover:text-[#FF2D78] transition-colors">x</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-4 pt-8 mt-8 border-t border-white/5">
          {saved && <span className="text-green-400 text-xs font-mono">Saved Successfully</span>}
          <button onClick={handleSave} disabled={saving}
            className="px-10 py-3 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] text-xs font-bold uppercase tracking-widest hover:bg-[#00D4FF]/20 transition-all disabled:opacity-50">
            {saving ? <Spinner className="w-4 h-4" /> : null} Save Settings
          </button>
        </div>
      </div>
      <ProcessingMonitorTab nodeIds={['track-cleaning']} title="Media Track Cleaning Queue" />
    </div>
  )
}

function IntroCreditDetectionTab() {
  const [status, setStatus] = useState<SegmentStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [editing, setEditing] = useState<SegmentStatus['queue']['database']['results'][number] | null>(null)
  const [draft, setDraft] = useState({ introStart: '', introEnd: '', creditsStart: '', creditsEnd: '', locked: true })
  const [seasonTuning, setSeasonTuning] = useState<SegmentSettings | null>(null)
  const load = () => sharedApi.system.segments().then(setStatus).catch(() => {})

  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])

  const save = async (patch: Partial<SegmentSettings>) => {
    if (!status) return
    setBusy(true)
    try {
      const { settings } = await sharedApi.system.setSegments(patch)
      setStatus({ ...status, settings })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      await load()
    } catch (err) { alert(String(err)) }
    finally { setBusy(false) }
  }

  const analyse = async () => {
    setBusy(true)
    try {
      const result = await sharedApi.system.analyseSegments()
      await load()
      alert(result.enqueued > 0
        ? `Queued ${result.enqueued} season${result.enqueued === 1 ? '' : 's'} for segment analysis.`
        : 'No new, changed, interrupted, or retryable seasons need analysis.')
    } catch (err) { alert(String(err)) }
    finally { setBusy(false) }
  }

  const cancel = async () => {
    setBusy(true)
    try { await sharedApi.system.cancelSegments(); await load() }
    catch (err) { alert(String(err)) }
    finally { setBusy(false) }
  }

  const openEditor = (result: SegmentStatus['queue']['database']['results'][number]) => {
    const text = (value: number | null) => value == null ? '' : String(Math.round(value * 1000) / 1000)
    setEditing(result)
    setDraft({ introStart: text(result.introStart), introEnd: text(result.introEnd), creditsStart: text(result.creditsStart), creditsEnd: text(result.creditsEnd), locked: true })
    setSeasonTuning(null)
    sharedApi.system.seasonSegmentSettings(result.seriesId, result.seasonNumber).then(response => setSeasonTuning(response.settings)).catch(error => alert(String(error)))
  }
  const saveMarkers = async () => {
    if (!editing) return
    const value = (text: string) => text.trim() === '' ? null : Number(text)
    setBusy(true)
    try {
      if (seasonTuning) await sharedApi.system.setSeasonSegmentSettings(editing.seriesId, editing.seasonNumber, seasonTuning)
      await sharedApi.system.updateEpisodeSegments(editing.episodeId, {
        introStart: value(draft.introStart), introEnd: value(draft.introEnd),
        creditsStart: value(draft.creditsStart), creditsEnd: value(draft.creditsEnd), locked: draft.locked,
      })
      setEditing(null)
      await load()
    } catch (err) { alert(String(err)) }
    finally { setBusy(false) }
  }
  const reanalyse = async (episodeId: number) => {
    setBusy(true)
    try { await sharedApi.system.reanalyseEpisodeSegments(episodeId); setEditing(null); await load() }
    catch (err) { alert(String(err)) }
    finally { setBusy(false) }
  }

  if (!status) return <div className="text-xs font-mono text-white/35">Loading intro and credit detection…</div>
  const settings = status.settings
  const fingerprintBytes = status.queue.database.fingerprintBytes
  const fingerprintSize = fingerprintBytes >= 1024 * 1024 ? `${(fingerprintBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(fingerprintBytes / 1024)} KB`
  const formatMarker = (start: number | null, end: number | null, method: string | null) => {
    if (start == null || end == null) return '—'
    const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
    return `${clock(start)}–${clock(end)}${method ? ` · ${method}` : ''}`
  }
  const stateClass = (state: string) => state === 'detected'
    ? 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20'
    : state === 'partial' ? 'bg-amber-400/10 text-amber-300 border-amber-400/20'
      : state === 'no_match' ? 'bg-white/5 text-white/35 border-white/10'
        : state === 'failed' ? 'bg-red-400/10 text-red-300 border-red-400/20'
          : 'bg-[#00D4FF]/10 text-[#00D4FF] border-[#00D4FF]/20'

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-noir-900 border border-white/5 shadow-2xl px-6 py-6 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><h3 className="text-sm font-medium text-white uppercase tracking-widest">Intro &amp; Credit Detection</h3><p className="mt-1 text-[10px] font-mono text-white/30">Chapter-first and recurring-audio analysis for television episodes.</p></div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => save({ enabled: !settings.enabled })} disabled={busy} className={`px-3 py-2 rounded-lg border text-[10px] font-bold uppercase tracking-widest disabled:opacity-40 ${settings.enabled ? 'bg-emerald-400/10 border-emerald-400/30 text-emerald-400' : 'bg-white/5 border-white/10 text-white/35'}`}>{settings.enabled ? 'Feature On' : 'Feature Off'}</button>
            <button onClick={analyse} disabled={busy || !settings.enabled} className="px-3 py-2 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">Start Analysis</button>
            <button onClick={cancel} disabled={busy || status.queue.active + status.queue.queued === 0} className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white/40 text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">Cancel Queue</button>
          </div>
        </div>
        <div className={`grid grid-cols-1 md:grid-cols-3 gap-5 ${settings.enabled ? '' : 'opacity-40'}`}>
          <NumField label="Workers" value={settings.concurrency} min={1} max={4} onChange={value => save({ concurrency: value })} />
          <NumField label="Intro Search Window" value={settings.introWindowSeconds} min={120} max={1800} suffix="sec" onChange={value => save({ introWindowSeconds: value })} />
          <NumField label="Credits Search Window" value={settings.creditsWindowSeconds} min={120} max={1800} suffix="sec" onChange={value => save({ creditsWindowSeconds: value })} />
          <NumField label="Minimum Match" value={settings.minimumMatchSeconds} min={6} max={60} suffix="sec" onChange={value => save({ minimumMatchSeconds: value })} />
          <NumField label="Confidence" value={Math.round(settings.confidenceThreshold * 100)} min={50} max={98} suffix="%" onChange={value => save({ confidenceThreshold: value / 100 })} />
          <NumField label="Maximum Attempts" value={settings.maxAttempts} min={1} max={10} onChange={value => save({ maxAttempts: value })} />
          <NumField label="Season Consensus" value={Math.round(settings.seasonSupportRatio * 100)} min={30} max={100} suffix="%" onChange={value => save({ seasonSupportRatio: value / 100 })} />
          <Field label="Preferred Audio Language" hint="ISO 639 code used when no original/default programme track is available."><Input value={settings.preferredLanguage} maxLength={3} onChange={event => save({ preferredLanguage: event.target.value })} /></Field>
          <div className="space-y-3"><PolToggle label="Refine with silence" value={settings.refineWithSilence} onChange={value => save({ refineWithSilence: value })} /><PolToggle label="Refine with black frames" value={settings.refineWithBlackFrames} onChange={value => save({ refineWithBlackFrames: value })} /></div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-[10px] font-mono">
          <div className="rounded-xl bg-black/25 border border-white/5 p-3"><span className="text-white/25 uppercase">Queue</span><p className="mt-1 text-white/65">{status.queue.active} active · {status.queue.queued} waiting</p></div>
          <div className="rounded-xl bg-black/25 border border-white/5 p-3"><span className="text-white/25 uppercase">Episode Links</span><p className="mt-1 text-white/65">{status.queue.database.links}</p></div>
          <div className="rounded-xl bg-black/25 border border-white/5 p-3"><span className="text-white/25 uppercase">Fingerprints</span><p className="mt-1 text-white/65">{status.queue.database.fingerprints} · {fingerprintSize}</p></div>
          <div className="rounded-xl bg-black/25 border border-white/5 p-3"><span className="text-white/25 uppercase">Tools</span><p className={status.queue.tools.fpcalc && status.queue.tools.ffmpeg ? 'mt-1 text-emerald-400' : 'mt-1 text-[#FF2D78]'}>ffmpeg {status.queue.tools.ffmpeg ? '✓' : '✕'} · fpcalc {status.queue.tools.fpcalc ? '✓' : '✕'}</p></div>
        </div>
        {saved && <p className="text-xs font-mono text-emerald-400">Settings saved</p>}
      </div>
      <ProcessingMonitorTab nodeIds={['segments']} title="Intro & Credit Detection Queue" />
      <div className="rounded-2xl bg-noir-900 border border-white/5 shadow-2xl overflow-hidden">
        <div className="px-6 py-5 border-b border-white/5">
          <h3 className="text-sm font-medium text-white uppercase tracking-widest">Analysis Results</h3>
          <p className="mt-1 text-[10px] font-mono text-white/30">The latest 250 linked episodes. Completed work remains visible after it leaves the queue.</p>
        </div>
        <div className="max-h-[560px] overflow-auto custom-scrollbar">
          <table className="w-full min-w-[1420px] text-left text-xs">
            <thead className="sticky top-0 z-10 bg-noir-900 text-[9px] font-mono uppercase tracking-widest text-white/30">
              <tr><th className="px-5 py-3 font-normal">Series</th><th className="px-3 py-3 font-normal">Episode</th><th className="px-3 py-3 font-normal">State</th><th className="px-3 py-3 font-normal">Audio Analysed</th><th className="px-3 py-3 font-normal">Fingerprints</th><th className="px-3 py-3 font-normal">Intro</th><th className="px-3 py-3 font-normal">Credits</th><th className="px-3 py-3 font-normal">Analysed</th><th className="px-5 py-3 font-normal"></th></tr>
            </thead>
            <tbody>
              {status.queue.database.results.map(result => (
                <tr key={result.episodeId} className="border-t border-white/5 align-middle" title={result.lastError ?? undefined}>
                  <td className="px-5 py-3 text-white/70"><span className="block max-w-[220px] truncate">{result.seriesTitle}</span></td>
                  <td className="px-3 py-3"><span className="font-mono text-[10px] text-white/45">S{String(result.seasonNumber).padStart(2, '0')}E{String(result.episodeNumber).padStart(2, '0')}</span><span className="ml-2 text-white/65">{result.episodeTitle || 'Untitled'}</span></td>
                  <td className="px-3 py-3"><span className={`inline-flex rounded-lg border px-2 py-1 text-[9px] font-bold uppercase tracking-widest ${stateClass(result.state)}`}>{result.state.replace('_', ' ')}</span></td>
                  <td className="px-3 py-3 font-mono text-[10px] text-white/50"><span className="block text-white/65">{result.audioTitle || result.audioLanguage || 'Unknown track'}</span><span className="text-white/30">stream {result.audioStreamIndex ?? '—'} · {result.audioCodec?.toUpperCase() || 'unknown'}{result.audioChannels ? ` · ${result.audioChannels}ch` : ''}</span></td>
                  <td className="px-3 py-3 font-mono text-[10px] text-white/50">{result.fingerprintCount}</td>
                  <td className="px-3 py-3 font-mono text-[10px] text-white/50">{formatMarker(result.introStart, result.introEnd, result.introMethod)}{result.introConfidence != null && <span className="block text-white/25">{Math.round(result.introConfidence * 100)}% confidence</span>}</td>
                  <td className="px-3 py-3 font-mono text-[10px] text-white/50">{formatMarker(result.creditsStart, result.creditsEnd, result.creditsMethod)}{result.creditsConfidence != null && <span className="block text-white/25">{Math.round(result.creditsConfidence * 100)}% confidence</span>}</td>
                  <td className="px-3 py-3 font-mono text-[10px] text-white/35 whitespace-nowrap">{result.analysedAt ? new Date(`${result.analysedAt}Z`).toLocaleString() : 'Pending'}{Boolean(result.manuallyLocked) && <span className="block mt-1 text-amber-300">Manual lock</span>}</td>
                  <td className="px-5 py-3"><button onClick={() => openEditor(result)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest text-white/50 hover:text-white">Edit</button></td>
                </tr>
              ))}
              {status.queue.database.results.length === 0 && <tr><td colSpan={9} className="px-5 py-8 text-center font-mono text-[10px] text-white/25">No episode analysis results yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {editing && <Modal title={`Edit S${String(editing.seasonNumber).padStart(2, '0')}E${String(editing.episodeNumber).padStart(2, '0')} Segments`} onClose={() => setEditing(null)} width="max-w-2xl">
        <div className="space-y-5">
          <p className="text-xs text-white/40">Enter seconds from the start of the episode. Leave both fields in a segment blank to remove that marker.</p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Intro start"><Input type="number" min="0" step="0.1" value={draft.introStart} onChange={event => setDraft(value => ({ ...value, introStart: event.target.value }))} /></Field>
            <Field label="Intro end"><Input type="number" min="0" step="0.1" value={draft.introEnd} onChange={event => setDraft(value => ({ ...value, introEnd: event.target.value }))} /></Field>
            <Field label="Credits start"><Input type="number" min="0" step="0.1" value={draft.creditsStart} onChange={event => setDraft(value => ({ ...value, creditsStart: event.target.value }))} /></Field>
            <Field label="Credits end"><Input type="number" min="0" step="0.1" value={draft.creditsEnd} onChange={event => setDraft(value => ({ ...value, creditsEnd: event.target.value }))} /></Field>
          </div>
          <Toggle checked={draft.locked} onChange={locked => setDraft(value => ({ ...value, locked }))} label="Lock these markers against automatic analysis" />
          {seasonTuning && <div className="space-y-4 rounded-xl border border-white/5 bg-black/25 p-4">
            <div><h4 className="text-[10px] font-bold uppercase tracking-widest text-white/60">Season Detection Tuning</h4><p className="mt-1 text-[10px] font-mono text-white/25">Applied to every episode in this season on its next analysis.</p></div>
            <div className="grid grid-cols-2 gap-4">
              <NumField label="Intro window" value={seasonTuning.introWindowSeconds} min={120} max={1800} suffix="sec" onChange={introWindowSeconds => setSeasonTuning(value => value && ({ ...value, introWindowSeconds }))} />
              <NumField label="Credits window" value={seasonTuning.creditsWindowSeconds} min={120} max={1800} suffix="sec" onChange={creditsWindowSeconds => setSeasonTuning(value => value && ({ ...value, creditsWindowSeconds }))} />
              <NumField label="Minimum match" value={seasonTuning.minimumMatchSeconds} min={6} max={60} suffix="sec" onChange={minimumMatchSeconds => setSeasonTuning(value => value && ({ ...value, minimumMatchSeconds }))} />
              <NumField label="Season consensus" value={Math.round(seasonTuning.seasonSupportRatio * 100)} min={30} max={100} suffix="%" onChange={seasonSupportRatio => setSeasonTuning(value => value && ({ ...value, seasonSupportRatio: seasonSupportRatio / 100 }))} />
              <Field label="Audio language"><Input value={seasonTuning.preferredLanguage} maxLength={3} onChange={event => setSeasonTuning(value => value && ({ ...value, preferredLanguage: event.target.value }))} /></Field>
              <div className="space-y-2"><PolToggle label="Silence refinement" value={seasonTuning.refineWithSilence} onChange={refineWithSilence => setSeasonTuning(value => value && ({ ...value, refineWithSilence }))} /><PolToggle label="Black-frame refinement" value={seasonTuning.refineWithBlackFrames} onChange={refineWithBlackFrames => setSeasonTuning(value => value && ({ ...value, refineWithBlackFrames }))} /></div>
            </div>
          </div>}
          <div className="flex flex-wrap justify-between gap-3 border-t border-white/5 pt-5">
            <button onClick={() => reanalyse(editing.episodeId)} disabled={busy} className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-amber-300 disabled:opacity-40">Unlock &amp; Reanalyse Season</button>
            <div className="flex gap-3"><button onClick={() => setEditing(null)} className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-white/40">Cancel</button><button onClick={saveMarkers} disabled={busy} className="rounded-xl border border-[#00D4FF]/30 bg-[#00D4FF]/10 px-5 py-2 text-[10px] font-bold uppercase tracking-widest text-[#00D4FF] disabled:opacity-40">Save Markers</button></div>
          </div>
        </div>
      </Modal>}
    </div>
  )
}

function VolumeNormalisationTab() {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-noir-900 border border-white/5 shadow-2xl px-6 py-6">
        <h3 className="text-sm font-medium text-white uppercase tracking-widest">Volume Normalisation</h3>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-white/40">Archivist automatically analyses imported films and episodes against a −16 LUFS playback target. Analysis is non-destructive: the source file is retained and the measured value is applied during compatible playback or transcoding.</p>
      </div>
      <ProcessingMonitorTab nodeIds={['loudness']} title="Volume Normalisation Queue" />
    </div>
  )
}

// ── Subtitles Tab ────────────────────────────────────────────────────────────

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ru', name: 'Russian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'sv', name: 'Swedish' },
  { code: 'no', name: 'Norwegian' },
  { code: 'da', name: 'Danish' },
  { code: 'fi', name: 'Finnish' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'cs', name: 'Czech' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'ro', name: 'Romanian' },
  { code: 'el', name: 'Greek' },
  { code: 'he', name: 'Hebrew' },
  { code: 'th', name: 'Thai' },
  { code: 'vi', name: 'Vietnamese' },
]

function SubtitlesTab() {
  const [config, setConfig] = useState<SubtitleConfig>({
    enabled: false,
    provider: 'opensubtitles',
    apiKey: '',
    appName: '',
    username: '',
    password: '',
    defaultLanguage: 'en',
    autoAcquire: false,
    hearingImpaired: false,
    forcedOnly: false,
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    sharedApi.settings.getSubtitles().then(setConfig).finally(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await sharedApi.settings.setSubtitles(config)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      alert('Failed to save: ' + String(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-white/30 text-sm font-mono">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-sm font-medium text-white uppercase tracking-widest">Subtitle Acquisition</h3>
            <p className="text-[10px] font-mono text-white/30 mt-1">
              Automatically or manually fetch subtitles from OpenSubtitles for your media files.
            </p>
          </div>
          <Toggle checked={config.enabled} onChange={v => setConfig({ ...config, enabled: v })} label="" />
        </div>

        <div className={`space-y-6 ${!config.enabled ? 'opacity-30 pointer-events-none' : ''}`}>
          {/* Provider */}
          <div>
            <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Provider</span>
            <div className="mt-3">
              <div className="flex gap-1 bg-noir-950/50 p-1 rounded-xl border border-white/5 w-fit">
                {['opensubtitles'].map(opt => (
                  <button key={opt} onClick={() => setConfig({ ...config, provider: opt })}
                    className={`px-4 py-2 rounded-lg text-[10px] font-bold tracking-widest uppercase transition-all ${
                      config.provider === opt ? 'bg-white/10 text-[#00D4FF]' : 'text-white/30 hover:text-white/60'
                    }`}>
                    {opt === 'opensubtitles' ? 'OpenSubtitles' : opt}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <hr className="border-white/5" />

          {/* API Key & App Name */}
          <div>
            <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">API Key</span>
            <p className="text-[10px] font-mono text-white/20 mt-1 mb-3">
              Get a free API key from opensubtitles.com — required for search and download.
            </p>
            <div className="space-y-3 max-w-xs">
              <Input
                value={config.apiKey}
                onChange={e => setConfig({ ...config, apiKey: e.target.value })}
                placeholder="Your OpenSubtitles API key"
                type="password"
              />
              <Input
                value={config.appName}
                onChange={e => setConfig({ ...config, appName: e.target.value })}
                placeholder="Registered app name (used as User-Agent)"
              />
            </div>
            <p className="text-[10px] font-mono text-white/20 mt-2">
              The app name must match the name you used when registering for the API key.
            </p>
          </div>

          <hr className="border-white/5" />

          {/* Credentials */}
          <div>
            <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Account Credentials</span>
            <p className="text-[10px] font-mono text-white/20 mt-1 mb-3">
              Your OpenSubtitles username and password — required for downloading.
            </p>
            <div className="space-y-3 max-w-xs">
              <Input
                value={config.username}
                onChange={e => setConfig({ ...config, username: e.target.value })}
                placeholder="Username"
              />
              <Input
                value={config.password}
                onChange={e => setConfig({ ...config, password: e.target.value })}
                placeholder="Password"
                type="password"
              />
            </div>
          </div>

          <hr className="border-white/5" />

          {/* Default Language */}
          <div>
            <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Default Language</span>
            <div className="mt-3">
              <select
                value={config.defaultLanguage}
                onChange={e => setConfig({ ...config, defaultLanguage: e.target.value })}
                className="px-4 py-2.5 rounded-xl bg-noir-800 border border-white/10 text-white text-xs focus:outline-none focus:border-white/30 transition-all font-mono appearance-none cursor-pointer w-full max-w-xs"
              >
                {LANGUAGES.map(l => (
                  <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
                ))}
              </select>
            </div>
          </div>

          <hr className="border-white/5" />

          {/* Toggles */}
          <div>
            <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Behaviour</span>
            <div className="mt-3 space-y-3">
              <Toggle
                checked={config.autoAcquire}
                onChange={v => setConfig({ ...config, autoAcquire: v })}
                label="Auto-acquire subtitles after download"
              />
              <p className="text-[10px] font-mono text-white/20 ml-12 -mt-1">
                Automatically fetch subtitles when media is organized — uses the default language
              </p>
              <Toggle
                checked={config.hearingImpaired}
                onChange={v => setConfig({ ...config, hearingImpaired: v })}
                label="Include hearing-impaired subtitles"
              />
              <Toggle
                checked={config.forcedOnly}
                onChange={v => setConfig({ ...config, forcedOnly: v })}
                label="Prefer forced subtitles only"
              />
              <p className="text-[10px] font-mono text-white/20 ml-12 -mt-1">
                Only fetch subtitles for foreign-language dialogue in the media
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-4 pt-8 mt-8 border-t border-white/5">
          {saved && <span className="text-green-400 text-xs font-mono">Saved Successfully</span>}
          <button onClick={handleSave} disabled={saving}
            className="px-10 py-3 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] text-xs font-bold uppercase tracking-widest hover:bg-[#00D4FF]/20 transition-all disabled:opacity-50">
            {saving ? <Spinner className="w-4 h-4" /> : null} Save Settings
          </button>
        </div>
      </div>
    </div>
  )
}


// ── Edition Rules ─────────────────────────────────────────────────────────────

import { filmsApi } from '../../lib/films.api.js';

function EditionRulesTab() {
  const [rules, setRules] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>(null);

  const fetchRules = () => filmsApi.editionRules.list().then(setRules);
  useEffect(() => { fetchRules(); }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editing.id) {
        await filmsApi.editionRules.update(editing.id, editing);
      } else {
        await filmsApi.editionRules.add(editing);
      }
      setEditing(null);
      fetchRules();
    } catch (err) {
      alert(String(err));
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this rule?')) return;
    try {
      await filmsApi.editionRules.delete(id);
      fetchRules();
    } catch (err) {
      alert(String(err));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-display uppercase tracking-widest text-white">Edition Parsing Rules</h2>
        <button onClick={() => setEditing({ rule_name: '', regex_pattern: '(?i)()', output_label: '', priority: 10, active: 1 })}
          className="px-4 py-2 bg-[#00D4FF]/10 text-[#00D4FF] rounded border border-[#00D4FF]/20 text-[10px] uppercase font-bold tracking-widest hover:bg-[#00D4FF]/20 transition-colors">
          Add Rule
        </button>
      </div>

      <p className="text-white/40 text-sm">
        Archivist uses these regex patterns to automatically assign Editions (like "Director's Cut") when parsing release titles.
      </p>

      <div className="grid grid-cols-1 gap-4">
        {rules.map(r => (
          <div key={r.id} className="bg-white/5 border border-white/5 rounded-xl p-4 flex items-center justify-between group">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <span className="font-bold text-white text-sm">{r.rule_name}</span>
                <span className="text-[#00D4FF] text-[10px] font-mono border border-[#00D4FF]/20 px-2 py-0.5 rounded bg-[#00D4FF]/10">{r.output_label}</span>
                {!r.active && <span className="text-red-400 text-[10px] font-mono border border-red-500/20 px-2 py-0.5 rounded bg-red-500/10">DISABLED</span>}
              </div>
              <p className="text-white/40 font-mono text-[10px]">Regex: {r.regex_pattern} | Priority: {r.priority}</p>
            </div>
            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={() => setEditing(r)} className="px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded text-[10px] uppercase tracking-widest text-white/60">Edit</button>
              <button onClick={() => handleDelete(r.id)} className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded text-[10px] uppercase tracking-widest">Delete</button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <form onSubmit={handleSave} className="w-[500px] p-6 bg-noir-900 border border-white/10 rounded-2xl space-y-6">
            <h3 className="font-display text-xl uppercase tracking-widest text-white">{editing.id ? 'Edit Rule' : 'New Rule'}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-mono text-white/40 mb-1">Rule Name</label>
                <Input value={editing.rule_name} onChange={(e: any) => setEditing({ ...editing, rule_name: e.target.value })} required autoFocus />
              </div>
              <div>
                <label className="block text-[10px] font-mono text-white/40 mb-1">Regex Pattern</label>
                <Input value={editing.regex_pattern} onChange={(e: any) => setEditing({ ...editing, regex_pattern: e.target.value })} required className="font-mono text-[12px]" />
                <p className="text-[10px] text-white/30 mt-1">Use <code>(?i)</code> for case-insensitive. Example: <code>(?i)(director'?s\s*cut)</code></p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-mono text-white/40 mb-1">Output Label (Edition Name)</label>
                  <Input value={editing.output_label} onChange={(e: any) => setEditing({ ...editing, output_label: e.target.value })} required />
                </div>
                <div>
                  <label className="block text-[10px] font-mono text-white/40 mb-1">Priority (Higher matches first)</label>
                  <Input type="number" value={editing.priority} onChange={(e: any) => setEditing({ ...editing, priority: parseInt(e.target.value) })} required />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={!!editing.active} onChange={(e: any) => setEditing({ ...editing, active: e.target.checked ? 1 : 0 })} className="rounded bg-white/5 border-white/10 accent-[#00D4FF]" />
                <span className="text-[12px] text-white/60">Rule Active</span>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-4 border-t border-white/5">
              <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 text-[10px] uppercase font-bold tracking-widest text-white/40 hover:text-white transition-colors">Cancel</button>
              <button type="submit" className="px-6 py-2 bg-[#00D4FF] text-noir-950 rounded text-[10px] uppercase font-bold tracking-widest shadow-[0_0_20px_rgba(0,212,255,0.2)]">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ── Settings Page ─────────────────────────────────────────────────────────────

function DangerZoneTab() {
  const { relaunchOnboarding } = useTabs()
  const [open, setOpen] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [fileConfirm, setFileConfirm] = useState(false)
  const [resetting, setResetting] = useState(false)

  const close = () => {
    if (resetting) return
    setOpen(false); setDeleteFiles(false); setConfirmText(''); setFileConfirm(false)
  }

  const runReset = async () => {
    setResetting(true)
    try {
      await sharedApi.settings.factoryReset(deleteFiles)
    } catch {
      // The server drops the connection as it restarts — expected; keep polling.
    }
    // Wait for the server to come back up, then reload into first-run state.
    const start = Date.now()
    const poll = async () => {
      try {
        const r = await fetch('/ping', { cache: 'no-store' })
        if (r.ok) { window.location.href = '/'; return }
      } catch { /* still restarting */ }
      if (Date.now() - start < 90_000) setTimeout(poll, 1500)
      else window.location.href = '/'
    }
    setTimeout(poll, 3000)
  }

  const onConfirmClick = () => {
    if (confirmText !== 'RESET') return
    // Deleting files always requires a second, explicit confirmation.
    if (deleteFiles && !fileConfirm) { setFileConfirm(true); return }
    runReset()
  }

  const launchWizard = () => {
    if (confirm('Re-run the setup wizard?\n\nThe choices you make will overwrite your current media-type and API-key settings. Your libraries, items and files are not touched.')) {
      relaunchOnboarding()
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.03] p-6">
        <h3 className="text-sm font-bold text-amber-400 uppercase tracking-widest mb-2">Setup Wizard</h3>
        <p className="text-xs text-white/50 leading-relaxed mb-5">
          Re-runs the first-run setup guide. The choices you make (which media types are enabled, and any
          API keys you enter) <span className="text-white/70">overwrite your current settings</span>. Your
          libraries, items and files are left untouched — this only reconfigures settings.
        </p>
        <button onClick={launchWizard}
          className="px-6 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition-all font-bold tracking-widest text-[10px] uppercase">
          Run Setup Wizard…
        </button>
      </div>

      <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.03] p-6">
        <h3 className="text-sm font-bold text-red-400 uppercase tracking-widest mb-2">Factory Reset</h3>
        <p className="text-xs text-white/50 leading-relaxed mb-5">
          Restores Archivist to a clean install: removes every library and item, all quality profiles,
          tiers, custom formats, indexers, download clients, API keys and settings — then re-seeds the
          defaults. The database is snapshotted to a backup first. This cannot be undone from the app.
        </p>
        <button onClick={() => setOpen(true)}
          className="px-6 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-all font-bold tracking-widest text-[10px] uppercase">
          Factory Reset…
        </button>
      </div>

      {open && (
        <Modal title="Factory Reset" onClose={close} width="max-w-lg">
          {resetting ? (
            <div className="p-8 text-center">
              <Spinner className="w-8 h-8 mx-auto mb-4" color="text-red-400" />
              <p className="text-sm text-white/70">Resetting and restarting Archivist…</p>
              <p className="text-[10px] font-mono text-white/30 mt-2">This page will reload automatically once it’s back.</p>
            </div>
          ) : fileConfirm ? (
            <div className="space-y-5">
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
                <p className="text-sm text-red-300 font-bold mb-1">Permanently delete all media files?</p>
                <p className="text-xs text-white/60 leading-relaxed">
                  You chose to also delete media files. This erases everything under your media folder and
                  the download folders from disk. There is no undo — the pre-reset backup only restores the
                  database, not files.
                </p>
              </div>
              <div className="flex justify-end gap-3">
                <button onClick={() => setFileConfirm(false)} className="px-5 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white uppercase tracking-widest">Back</button>
                <button onClick={runReset} className="px-6 py-2.5 rounded-xl bg-red-500 text-white text-xs font-bold uppercase tracking-widest hover:bg-red-600 transition-all">Delete everything &amp; reset</button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <p className="text-xs text-white/60 leading-relaxed">
                This wipes all libraries, items, profiles, tiers, indexers, download clients, API keys and
                settings, then restarts. The database is backed up first.
              </p>
              <label className="flex items-start gap-3 p-3 rounded-xl border border-white/10 bg-noir-900 cursor-pointer">
                <input type="checkbox" checked={deleteFiles} onChange={e => setDeleteFiles(e.target.checked)} className="mt-0.5 accent-red-500" />
                <span>
                  <span className="block text-sm text-white/80">Also delete all media files from disk</span>
                  <span className="block text-[11px] text-white/40 mt-0.5">Leave unchecked to keep your downloaded files and only reset the app’s data.</span>
                </span>
              </label>
              <div>
                <label className="block text-[10px] font-mono uppercase tracking-widest text-white/40 mb-2">Type <span className="text-red-400">RESET</span> to confirm</label>
                <input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="RESET"
                  className="w-full px-4 py-2.5 rounded-xl bg-noir-900 border border-white/10 text-white text-sm focus:border-red-500/50 focus:outline-none" />
              </div>
              <div className="flex justify-end gap-3">
                <button onClick={close} className="px-5 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white uppercase tracking-widest">Cancel</button>
                <button onClick={onConfirmClick} disabled={confirmText !== 'RESET'}
                  className="px-6 py-2.5 rounded-xl bg-red-500/90 text-white text-xs font-bold uppercase tracking-widest hover:bg-red-500 transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                  {deleteFiles ? 'Continue' : 'Reset Archivist'}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}

// ── Processing Tab (Video Optimisation Engine) ───────────────────────────────

const ALL_VIDEO_CODECS: ProcessingVideoCodec[] = ['h264', 'hevc', 'av1', 'vc1', 'mpeg2video', 'vp9', 'h266']
const AUDIO_TARGETS = ['aac', 'opus', 'ac3', 'eac3', 'flac'] as const

function PolToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!value)}
      className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-left ${value ? 'bg-[#00D4FF]/10 border-[#00D4FF]/30' : 'bg-black/40 border-white/5'}`}>
      <span className="text-[11px] font-mono uppercase tracking-widest text-white/60">{label}</span>
      <span className={`w-9 h-5 rounded-full flex items-center px-0.5 transition-all ${value ? 'bg-[#00D4FF] justify-end' : 'bg-white/10 justify-start'}`}>
        <span className="w-4 h-4 rounded-full bg-noir-950" />
      </span>
    </button>
  )
}

function NumField({ label, value, min, max, suffix, onChange }: { label: string; value: number; min?: number; max?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <div className="space-y-2">
      <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">{label}</label>
      <div className="flex items-center gap-2">
        <input type="number" min={min} max={max} value={value}
          onChange={e => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) onChange(n) }}
          className="w-28 bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/70 outline-none focus:border-white/20" />
        {suffix && <span className="text-[10px] font-mono text-white/30 uppercase">{suffix}</span>}
      </div>
    </div>
  )
}

function fmtBytes(n: number): string {
  if (!n || n <= 0) return '0'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
  return `${(n / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${u[i]}`
}

const ACTION_STYLE: Record<RecommendationAction, string> = {
  convert: 'bg-[#00D4FF]/15 text-[#00D4FF]',
  remux: 'bg-[#9B59B6]/15 text-[#9B59B6]',
  keep: 'bg-white/5 text-white/40',
  skip: 'bg-white/5 text-white/25',
}

function StatBar({ label, value, pct }: { label: string; value: string; pct: number | null }) {
  return (
    <div className="flex-1 min-w-[110px]">
      <div className="flex justify-between text-[9px] font-mono uppercase tracking-widest text-white/30 mb-1"><span>{label}</span><span className="text-white/60">{value}</span></div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full bg-[#00D4FF] transition-all" style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
      </div>
    </div>
  )
}

function ExecutionPanel() {
  const [exec, setExec] = useState<ExecutionResponse | null>(null)
  const [stats, setStats] = useState<SystemStats | null>(null)
  useEffect(() => { sharedApi.processing.getExecution().then(setExec).catch(() => {}) }, [])
  useEffect(() => {
    const load = () => sharedApi.processing.getStats().then(setStats).catch(() => {})
    load()
    const t = setInterval(load, 2500)
    return () => clearInterval(t)
  }, [])
  if (!exec) return null
  const { config, hardware, vmafAvailable } = exec
  const save = (patch: Partial<ExecutionResponse['config']>) => sharedApi.processing.setExecution(patch).then(setExec).catch(() => {})
  const hwOptions = ['auto', 'off', ...hardware.available.filter(a => a !== 'software')]

  return (
    <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-white uppercase tracking-widest">Execution</h3>
          <p className="text-[10px] font-mono text-white/30 mt-1">
            {(hardware as any).gpus?.length ? `GPU: ${(hardware as any).gpus.map((g: any) => g.vendor).join(', ')} · ` : ''}
            HW encoders: {hardware.available.filter(a => a !== 'software').map(a => a.toUpperCase()).join(', ') || 'none (software only)'}
          </p>
        </div>
        <button onClick={() => save({ paused: !config.paused })}
          className={`px-5 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all ${config.paused ? 'bg-amber-400/15 border border-amber-400/30 text-amber-300' : 'bg-white/5 border border-white/10 text-white/50 hover:bg-white/10'}`}>
          {config.paused ? '▶ Resume Queue' : '⏸ Pause Queue'}
        </button>
      </div>

      {/* Live utilisation */}
      {stats && (
        <div className="flex flex-wrap gap-5 px-4 py-3 rounded-xl bg-black/40 border border-white/5">
          <StatBar label={`CPU (${stats.cpuCount})`} value={`${stats.cpuPercent}%`} pct={stats.cpuPercent} />
          <StatBar label="Memory" value={`${stats.memPercent}%`} pct={stats.memPercent} />
          <StatBar label="GPU" value={stats.gpuPercent == null ? 'n/a' : `${stats.gpuPercent}%`} pct={stats.gpuPercent} />
          <div className="flex flex-col justify-center min-w-[120px]">
            <span className="text-[9px] font-mono uppercase tracking-widest text-white/30">Encoding</span>
            <span className="text-sm font-display text-white">{stats.encoding} active{stats.aggregateSpeed ? ` · ${stats.aggregateSpeed.toFixed(1)}×` : ''}{stats.queued ? ` · ${stats.queued} queued` : ''}</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="space-y-2">
          <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Hardware Acceleration</label>
          <select value={config.hwAccel} onChange={e => save({ hwAccel: e.target.value as any })}
            className="w-full bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/70 outline-none focus:border-white/20">
            {hwOptions.map(o => <option key={o} value={o}>{o === 'auto' ? 'Auto (prefer GPU)' : o === 'off' ? 'Off (software)' : o.toUpperCase()}</option>)}
          </select>
        </div>
        <NumField label="Worker Concurrency" value={config.workerConcurrency} min={1} max={8} onChange={v => save({ workerConcurrency: v })} />
        <NumField label="Quarantine Retention" value={config.quarantineRetentionDays} min={0} suffix="days" onChange={v => save({ quarantineRetentionDays: v })} />
      </div>

      {/* VMAF quality gate */}
      <div className="flex flex-wrap items-end gap-6">
        <PolToggle label={`VMAF Quality Gate${vmafAvailable ? '' : ' (ffmpeg lacks libvmaf)'}`} value={config.vmaf.enabled && vmafAvailable}
          onChange={v => vmafAvailable && save({ vmaf: { ...config.vmaf, enabled: v } })} />
        {config.vmaf.enabled && vmafAvailable && (
          <div className="flex items-end gap-3">
            <NumField label="Min VMAF" value={config.vmaf.minScore} min={0} max={100} onChange={v => save({ vmaf: { ...config.vmaf, minScore: v } })} />
            <span className="text-[10px] font-mono text-white/30 pb-3">transcodes scoring below this are rejected; original kept</span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-6">
        <PolToggle label="Scheduled Encode Window" value={config.encodeWindow.enabled} onChange={v => save({ encodeWindow: { ...config.encodeWindow, enabled: v } })} />
        {config.encodeWindow.enabled && (
          <div className="flex items-end gap-3">
            <NumField label="From (hour)" value={config.encodeWindow.startHour} min={0} max={23} onChange={v => save({ encodeWindow: { ...config.encodeWindow, startHour: v } })} />
            <NumField label="To (hour)" value={config.encodeWindow.endHour} min={0} max={23} onChange={v => save({ encodeWindow: { ...config.encodeWindow, endHour: v } })} />
            <span className="text-[10px] font-mono text-white/30 pb-3">encodes only {config.encodeWindow.startHour}:00–{config.encodeWindow.endHour}:00</span>
          </div>
        )}
      </div>

      {(hardware as any).note && (
        <p className="text-[10px] font-mono text-amber-300/70 leading-relaxed bg-amber-400/5 border border-amber-400/15 rounded-xl px-4 py-3">
          ⚠ {(hardware as any).note}
        </p>
      )}
    </div>
  )
}

const ACTIVE_JOB = new Set(['queued', 'encoding', 'validating', 'replacing'])

function RecommendationsPanel() {
  const [scan, setScan] = useState<ProcessingScanState | null>(null)
  const [jobs, setJobs] = useState<OptimiseJob[]>([])
  const [quarantine, setQuarantine] = useState<QuarantineEntry[]>([])
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const load = () => sharedApi.processing.getScan().then(setScan).catch(() => {})
  const loadJobs = () => sharedApi.processing.getJobs().then(r => { setJobs(r.jobs); setQuarantine(r.quarantine) }).catch(() => {})
  useEffect(() => { load(); loadJobs() }, [])
  useEffect(() => {
    const active = scan?.status === 'scanning' || jobs.some(j => ACTIVE_JOB.has(j.status))
    if (!active) return
    const t = setInterval(() => { load(); loadJobs() }, 1000)
    return () => clearInterval(t)
  }, [scan?.status, jobs])

  const start = async () => { await sharedApi.processing.startScan().catch(() => {}); load() }
  const optimise = async (kind: 'film' | 'episode', itemId: number, action: 'remux' | 'convert') => {
    setBusy(prev => new Set(prev).add(`${kind}-${itemId}`))
    try { await sharedApi.processing.enqueueJob({ kind, itemId, action }); await loadJobs() }
    catch (err) { alert('Failed to queue: ' + String(err)) }
    finally { setBusy(prev => { const n = new Set(prev); n.delete(`${kind}-${itemId}`); return n }) }
  }
  const restore = async (id: string) => { await sharedApi.processing.restoreQuarantine(id).catch(() => {}); loadJobs() }
  const cancel = async (id: string) => { await sharedApi.processing.cancelJob(id).catch(() => {}); loadJobs() }

  const agg = scan?.aggregate
  const scanning = scan?.status === 'scanning'
  const items = (scan?.items ?? []).slice().sort((a, b) => (b.recommendation.estimatedSavingBytes ?? 0) - (a.recommendation.estimatedSavingBytes ?? 0))
  const queuedPaths = new Set(jobs.filter(j => ACTIVE_JOB.has(j.status)).map(j => `${j.kind}-${j.itemId}`))

  const Stat = ({ label, value, accent }: { label: string; value: string; accent?: string }) => (
    <div className="px-4 py-3 rounded-xl bg-black/40 border border-white/5">
      <div className="text-[10px] font-mono text-white/30 uppercase tracking-widest">{label}</div>
      <div className={`text-lg font-display tracking-wide mt-1 ${accent ?? 'text-white'}`}>{value}</div>
    </div>
  )

  return (
    <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-white uppercase tracking-widest">Library Recommendations</h3>
          <p className="text-[10px] font-mono text-white/30 mt-1">
            {scan?.status === 'complete' ? `Analysed ${agg?.filesAnalysed ?? 0} file(s)${agg?.filesFailed ? ` · ${agg.filesFailed} unreadable` : ''}`
              : scanning ? `Scanning ${scan?.scanned}/${scan?.total}…`
              : 'Scan the library to see what would be optimised — nothing is changed.'}
          </p>
        </div>
        <button onClick={start} disabled={scanning}
          className="px-6 py-2 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] text-xs font-bold uppercase tracking-widest hover:bg-[#00D4FF]/20 transition-all disabled:opacity-50">
          {scanning ? <Spinner className="w-4 h-4" /> : '🔍'} {scanning ? 'Scanning' : 'Scan Library'}
        </button>
      </div>

      {agg && (agg.filesAnalysed > 0 || scanning) && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Library Size" value={fmtBytes(agg.libraryBytes)} />
          <Stat label="Optimisable" value={fmtBytes(agg.optimisableBytes)} accent="text-[#00D4FF]" />
          <Stat label="Est. Saving" value={fmtBytes(agg.estimatedSavingBytes)} accent="text-green-400" />
          <Stat label="To Convert / Remux" value={`${agg.counts.convert} / ${agg.counts.remux}`} accent="text-[#9B59B6]" />
        </div>
      )}

      {items.length > 0 && (
        <div className="rounded-xl border border-white/5 overflow-hidden">
          <div className="max-h-80 overflow-y-auto custom-scrollbar">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-noir-900">
                <tr className="text-[9px] font-mono text-white/30 uppercase tracking-widest">
                  <th className="px-4 py-2 font-normal">Title</th>
                  <th className="px-3 py-2 font-normal">Codec</th>
                  <th className="px-3 py-2 font-normal">Size</th>
                  <th className="px-3 py-2 font-normal">Action</th>
                  <th className="px-3 py-2 font-normal">Est. Saving</th>
                  <th className="px-3 py-2 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={`${it.kind}-${it.id}`} className="border-t border-white/5 text-xs" title={it.recommendation.reason}>
                    <td className="px-4 py-2 text-white/70 max-w-[260px] truncate">{it.title}</td>
                    <td className="px-3 py-2 text-white/40 font-mono text-[11px] whitespace-nowrap">
                      {(it.codec ?? '—').toUpperCase()} {it.resolution ?? ''} {it.hdr ? <span className="text-amber-300">{it.hdr}</span> : ''}
                    </td>
                    <td className="px-3 py-2 text-white/40 font-mono text-[11px]">{fmtBytes(it.sizeBytes)}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest ${ACTION_STYLE[it.recommendation.action]}`}>{it.recommendation.action}</span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-green-400/80 whitespace-nowrap">
                      {it.recommendation.estimatedSavingBytes ? `${fmtBytes(it.recommendation.estimatedSavingBytes)} (${it.recommendation.estimatedSavingPercent}%)` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {(it.recommendation.action === 'convert' || it.recommendation.action === 'remux') && it.kind !== 'path' && (
                        queuedPaths.has(`${it.kind}-${it.id}`)
                          ? <span className="text-[9px] font-mono text-white/30 uppercase">Queued</span>
                          : <button onClick={() => optimise(it.kind as 'film' | 'episode', it.id, it.recommendation.action as 'remux' | 'convert')}
                              disabled={busy.has(`${it.kind}-${it.id}`)}
                              className="px-2.5 py-1 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] text-[9px] font-bold uppercase tracking-widest hover:bg-[#00D4FF]/20 disabled:opacity-40">
                              Optimise
                            </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="space-y-2">
          <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Optimisation Jobs</label>
          {jobs.slice(0, 8).map(j => (
            <div key={j.id} className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-black/40 border border-white/5">
              <span className="text-xs text-white/70 flex-1 truncate">{j.title}</span>
              <span className="text-[9px] font-mono text-white/30 uppercase">{j.action}</span>
              {ACTIVE_JOB.has(j.status) ? (
                <>
                  <div className="w-32 h-1.5 rounded-full bg-white/10 overflow-hidden">
                    <div className="h-full bg-[#00D4FF] transition-all" style={{ width: `${Math.round((j.status === 'encoding' ? j.progress : j.status === 'queued' ? 0 : 1) * 100)}%` }} />
                  </div>
                  <span className="text-[9px] font-mono text-[#00D4FF] uppercase w-24 text-right">
                    {j.status === 'encoding' ? `${Math.round(j.progress * 100)}%${j.speed ? ` · ${j.speed.toFixed(1)}×` : ''}` : j.status}
                  </span>
                  <button onClick={() => cancel(j.id)} className="text-[9px] font-mono text-white/30 hover:text-red-400 uppercase">Cancel</button>
                </>
              ) : (
                <span className={`text-[9px] font-mono uppercase w-52 text-right ${j.status === 'complete' ? 'text-green-400' : j.status === 'failed' ? 'text-red-400' : 'text-white/30'}`}>
                  {j.status === 'complete' && j.sizeBefore && j.sizeAfter ? `${fmtBytes(j.sizeBefore)} → ${fmtBytes(j.sizeAfter)}` : j.status}
                  {j.vmaf != null ? ` · VMAF ${j.vmaf}` : ''}{j.error ? ` · ${j.error.slice(0, 40)}` : ''}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {quarantine.length > 0 && (
        <div className="space-y-2">
          <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Quarantine (originals kept until retention expires — restore to undo)</label>
          {quarantine.map(q => (
            <div key={q.id} className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-black/40 border border-white/5">
              <span className="text-xs text-white/60 flex-1 truncate">{q.title}</span>
              <span className="text-[9px] font-mono text-white/25 uppercase">{fmtBytes(q.sizeBytes)}</span>
              <span className="text-[9px] font-mono text-white/25 uppercase">deletes in {Math.max(0, Math.round((q.deleteAfter - Date.now()) / 86400000))}d</span>
              <button onClick={() => restore(q.id)} className="px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-[9px] font-bold uppercase tracking-widest text-white/60 hover:bg-white/10">Restore</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ProcessingTab({ mode }: { mode: 'video' | 'audio' }) {
  const [presets, setPresets] = useState<ProcessingPreset[]>([])
  const [stored, setStored] = useState<StoredPolicy | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    Promise.all([sharedApi.processing.getPresets(), sharedApi.processing.getPolicy()])
      .then(([p, s]) => { setPresets(p.presets); setStored(s) })
      .finally(() => setLoading(false))
  }, [])

  if (loading || !stored) {
    return <div className="min-h-[400px] flex items-center justify-center"><Spinner className="w-8 h-8" /></div>
  }

  const policy = stored.policy
  const applyPreset = (preset: ProcessingPreset) =>
    setStored({ presetId: preset.id, policy: { name: preset.name, description: preset.description, video: preset.video, audio: preset.audio } })
  const editVideo = (patch: Partial<VideoPolicy>) =>
    setStored({ presetId: 'custom', policy: { ...policy, name: 'Custom', video: { ...policy.video, ...patch } } })
  const editAudio = (patch: Partial<AudioPolicy>) =>
    setStored({ presetId: 'custom', policy: { ...policy, name: 'Custom', audio: { ...policy.audio, ...patch } } })
  const toggleConvert = (codec: ProcessingVideoCodec) => {
    const inConvert = policy.video.convertCodecs.includes(codec)
    editVideo({
      convertCodecs: inConvert ? policy.video.convertCodecs.filter(c => c !== codec) : [...policy.video.convertCodecs, codec],
      skipCodecs: inConvert ? [...policy.video.skipCodecs.filter(c => c !== codec), codec] : policy.video.skipCodecs.filter(c => c !== codec),
    })
  }

  const save = async () => {
    setSaving(true)
    try { setStored(await sharedApi.processing.setPolicy(stored)); setSaved(true); setTimeout(() => setSaved(false), 2000) }
    catch (err) { alert('Failed to save: ' + String(err)) }
    finally { setSaving(false) }
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-white/40 max-w-2xl leading-relaxed">
        The Video Optimisation Engine analyses your library and recommends conversions based on the active policy —
        it never transcodes without a policy and always explains why. Pick a preset or customise below.
      </p>

      {/* Preset chips */}
      <div className="flex flex-wrap gap-2">
        {presets.map(preset => (
          <button key={preset.id} onClick={() => applyPreset(preset)} title={preset.description}
            className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all ${
              stored.presetId === preset.id ? 'bg-[#00D4FF] text-noir-950 shadow-lg' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}>
            {preset.name}
          </button>
        ))}
        {stored.presetId === 'custom' && (
          <span className="px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest bg-[#9B59B6]/20 text-[#9B59B6]">Custom</span>
        )}
      </div>

      <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl space-y-8">
        {mode === 'video' ? (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Target Codec</label>
                <select value={policy.video.targetCodec} onChange={e => editVideo({ targetCodec: e.target.value as ProcessingVideoCodec })}
                  className="w-full bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/70 outline-none focus:border-white/20">
                  {ALL_VIDEO_CODECS.map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Quality Mode</label>
                <select value={policy.video.qualityMode} onChange={e => editVideo({ qualityMode: e.target.value as VideoPolicy['qualityMode'] })}
                  className="w-full bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/70 outline-none focus:border-white/20">
                  <option value="constant_quality">Constant Quality (CRF)</option>
                  <option value="target_bitrate">Target Bitrate</option>
                </select>
              </div>
              <NumField label="CRF" value={policy.video.crf} min={0} max={51} onChange={v => editVideo({ crf: v })} />
            </div>

            <div>
              <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block mb-3">Convert These Codecs (click to toggle vs. skip)</label>
              <div className="flex flex-wrap gap-2">
                {ALL_VIDEO_CODECS.map(c => {
                  const on = policy.video.convertCodecs.includes(c)
                  return (
                    <button key={c} onClick={() => toggleConvert(c)}
                      className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${on ? 'bg-[#00D4FF]/15 text-[#00D4FF] border border-[#00D4FF]/30' : 'bg-white/5 text-white/25 border border-white/5'}`}>
                      {c}{c === policy.video.targetCodec ? ' (target)' : ''}
                    </button>
                  )
                })}
              </div>
              <p className="text-[10px] font-mono text-white/25 mt-2">Highlighted = converted to target. Dimmed = skipped (treated as already efficient).</p>
            </div>

            <div>
              <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block mb-3">Preserve</label>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <PolToggle label="Resolution" value={policy.video.preserve.resolution} onChange={v => editVideo({ preserve: { ...policy.video.preserve, resolution: v } })} />
                <PolToggle label="HDR" value={policy.video.preserve.hdr} onChange={v => editVideo({ preserve: { ...policy.video.preserve, hdr: v } })} />
                <PolToggle label="Dolby Vision" value={policy.video.preserve.dolbyVision} onChange={v => editVideo({ preserve: { ...policy.video.preserve, dolbyVision: v } })} />
                <PolToggle label="Frame Rate" value={policy.video.preserve.frameRate} onChange={v => editVideo({ preserve: { ...policy.video.preserve, frameRate: v } })} />
                <PolToggle label="Chapters" value={policy.video.preserve.chapters} onChange={v => editVideo({ preserve: { ...policy.video.preserve, chapters: v } })} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6 max-w-md">
              <NumField label="Min Saving %" value={policy.video.minimumSavingPercent} min={0} max={100} suffix="%" onChange={v => editVideo({ minimumSavingPercent: v })} />
              <NumField label="Min Saving" value={policy.video.minimumSavingGb} min={0} suffix="GB" onChange={v => editVideo({ minimumSavingGb: v })} />
            </div>
          </>
        ) : (
          <>
            <PolToggle label="Enable Audio Transcoding" value={policy.audio.enabled} onChange={v => editAudio({ enabled: v })} />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Target Codec</label>
                <select value={policy.audio.targetCodec} onChange={e => editAudio({ targetCodec: e.target.value as AudioPolicy['targetCodec'] })}
                  className="w-full bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/70 outline-none focus:border-white/20">
                  {AUDIO_TARGETS.map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}
                </select>
              </div>
              <NumField label="Stereo Bitrate" value={policy.audio.stereoBitrateKbps} min={64} max={512} suffix="kbps" onChange={v => editAudio({ stereoBitrateKbps: v })} />
            </div>
            <PolToggle label="Preserve Lossless Masters (TrueHD, DTS-HD MA, FLAC, PCM)" value={policy.audio.preserveLossless} onChange={v => editAudio({ preserveLossless: v })} />
          </>
        )}

        <div className="flex items-center justify-end gap-4 pt-6 border-t border-white/5">
          {saved && <span className="text-green-400 text-xs font-mono">Saved</span>}
          <button onClick={save} disabled={saving}
            className="px-10 py-3 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] text-xs font-bold uppercase tracking-widest hover:bg-[#00D4FF]/20 transition-all disabled:opacity-50">
            {saving ? <Spinner className="w-4 h-4" /> : '💾'} Save Policy
          </button>
        </div>
      </div>

      {mode === 'video' && <><ExecutionPanel /><RecommendationsPanel /></>}
      <ProcessingMonitorTab nodeIds={[mode]} title={`${mode === 'video' ? 'Video' : 'Audio'} Encoding Queue`} />
    </div>
  )
}

// ── Monitoring Tab (feed health + release decisions) ─────────────────────────

function ago(ms: number | null): string {
  if (!ms) return '—'
  const d = Date.now() - ms
  if (d < 0) return `in ${Math.round(-d / 1000)}s`
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`
  return `${Math.round(d / 86_400_000)}d ago`
}
const HEALTH_COLOR: Record<string, string> = { healthy: 'text-green-400', degraded: 'text-amber-300', unhealthy: 'text-red-400', disabled: 'text-white/25', unknown: 'text-white/40' }

function MonitoringTab() {
  const [feed, setFeed] = useState<FeedStatus | null>(null)
  const [decisions, setDecisions] = useState<AcquisitionDecision[]>([])
  const [filter, setFilter] = useState<'all' | 'accepted' | 'rejected' | 'grabbed'>('all')
  const load = () => {
    sharedApi.searchMissing.getFeedStatus().then(setFeed).catch(() => {})
    sharedApi.searchMissing.getDecisions(filter, 100).then(r => setDecisions(r.decisions)).catch(() => {})
  }
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [filter])

  return (
    <div className="space-y-6">
      {/* Feed status */}
      <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-white uppercase tracking-widest">Indexer Feed Status</h3>
          {feed?.summary.rapidActive && <span className="px-3 py-1 rounded-lg bg-[#00D4FF]/15 text-[#00D4FF] text-[9px] font-bold uppercase tracking-widest">● Rapid mode</span>}
        </div>
        {feed && (
          <div className="rounded-xl border border-white/5 overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-black/30 text-[9px] font-mono text-white/30 uppercase tracking-widest">
                <tr>
                  <th className="px-3 py-2 font-normal">Indexer</th><th className="px-3 py-2 font-normal">Health</th><th className="px-3 py-2 font-normal">Mode</th>
                  <th className="px-3 py-2 font-normal">Last poll</th><th className="px-3 py-2 font-normal">Next</th><th className="px-3 py-2 font-normal">Found/Grab</th><th className="px-3 py-2 font-normal">Fails</th>
                </tr>
              </thead>
              <tbody>
                {feed.indexers.map(ix => (
                  <tr key={ix.id} className="border-t border-white/5" title={ix.lastError ?? ''}>
                    <td className="px-3 py-2 text-white/70 max-w-[200px] truncate">{ix.name}{ix.inFlight ? ' ⟳' : ''}</td>
                    <td className={`px-3 py-2 font-mono text-[11px] uppercase ${HEALTH_COLOR[ix.health] ?? 'text-white/40'}`}>{ix.health}</td>
                    <td className="px-3 py-2 text-white/40 font-mono text-[11px]">{ix.mode}</td>
                    <td className="px-3 py-2 text-white/40 font-mono text-[11px]">{ago(ix.lastPolledAt)}</td>
                    <td className="px-3 py-2 text-white/40 font-mono text-[11px]">{ix.enabled ? ago(ix.nextPollAt) : '—'}</td>
                    <td className="px-3 py-2 text-white/40 font-mono text-[11px]">{ix.lastReleasesFound}/{ix.lastReleasesGrabbed}</td>
                    <td className={`px-3 py-2 font-mono text-[11px] ${ix.consecutiveFailures ? 'text-red-400/80' : 'text-white/25'}`}>{ix.consecutiveFailures}</td>
                  </tr>
                ))}
                {feed.indexers.length === 0 && <tr><td colSpan={7} className="px-3 py-4 text-white/25 text-center">No indexers configured</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Release decisions */}
      <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-white uppercase tracking-widest">Release Decisions</h3>
            <p className="text-[10px] font-mono text-white/30 mt-1">Why Archivist did or didn't grab each release the pipeline evaluated.</p>
          </div>
          <div className="flex gap-1.5 p-1 bg-black/40 rounded-xl border border-white/5">
            {(['all', 'accepted', 'grabbed', 'rejected'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-widest ${filter === f ? 'bg-white/10 text-[#00D4FF]' : 'text-white/30 hover:text-white/60'}`}>{f}</button>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-white/5 overflow-hidden max-h-96 overflow-y-auto custom-scrollbar">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-noir-900 text-[9px] font-mono text-white/30 uppercase tracking-widest">
              <tr><th className="px-3 py-2 font-normal">Release</th><th className="px-3 py-2 font-normal">Type</th><th className="px-3 py-2 font-normal">Decision</th><th className="px-3 py-2 font-normal">Reason</th><th className="px-3 py-2 font-normal">When</th></tr>
            </thead>
            <tbody>
              {decisions.map(d => {
                const reason = d.accepted ? (JSON.parse(d.reasons || '[]')[0] ?? 'accepted') : (JSON.parse(d.rejection_reasons || '[]')[0] ?? 'rejected')
                return (
                  <tr key={d.id} className="border-t border-white/5" title={d.release_title}>
                    <td className="px-3 py-2 text-white/60 max-w-[280px] truncate font-mono text-[11px]">{d.release_title}</td>
                    <td className="px-3 py-2 text-white/30 font-mono text-[10px] uppercase">{d.media_type}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest ${d.grabbed ? 'bg-green-400/15 text-green-400' : d.accepted ? 'bg-[#00D4FF]/15 text-[#00D4FF]' : 'bg-white/5 text-white/30'}`}>
                        {d.grabbed ? 'grabbed' : d.accepted ? 'accepted' : 'rejected'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-white/40 max-w-[260px] truncate">{reason}</td>
                    <td className="px-3 py-2 text-white/30 font-mono text-[10px] whitespace-nowrap">{d.created_at?.slice(5, 16)}</td>
                  </tr>
                )
              })}
              {decisions.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-white/25 text-center">No decisions recorded yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── Search Missing (scheduled backlog) Tab ───────────────────────────────────

const SM_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const SM_STRATEGIES: [string, string][] = [
  ['oldest_search_first', 'Oldest search first'],
  ['oldest_release_first', 'Oldest release first'],
  ['balanced_by_media_type', 'Balanced by media type'],
  ['highest_priority', 'Highest priority'],
  ['random', 'Random'],
]

function RssTab() {
  const [mon, setMon] = useState<MonitoringResponse | null>(null)
  useEffect(() => { sharedApi.searchMissing.getMonitoring().then(setMon).catch(() => {}) }, [])
  if (!mon) return <div className="min-h-[300px] flex items-center justify-center"><Spinner className="w-8 h-8" /></div>
  const m = mon.settings
  const save = (p: Partial<MonitoringResponse['settings']>) => sharedApi.searchMissing.setMonitoring(p).then(setMon).catch(() => {})
  return (
    <div className="space-y-6">
      <p className="text-xs text-white/40 max-w-2xl leading-relaxed">
        RSS polls your indexer feeds for newly released items and grabs anything matching a monitored, wanted item. Pick which indexers feed the RSS in the <span className="text-white/60">Indexers</span> tab; older backlog is handled by <span className="text-white/60">Search Missing</span>.
      </p>

      {/* Normal RSS */}
      <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl space-y-5">
        <div>
          <h3 className="text-sm font-medium text-white uppercase tracking-widest">Normal RSS</h3>
          <p className="text-[10px] font-mono text-white/30 mt-1">The steady poll cadence used whenever no monitored episode is airing soon.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <NumField label="Feed poll interval" value={m.pollIntervalMinutes} min={1} max={1440} suffix="min" onChange={v => save({ pollIntervalMinutes: v })} />
          <p className="text-[10px] font-mono text-white/30 self-center leading-relaxed">How often each RSS-enabled indexer is polled. Lower = faster grabs but more indexer/FlareSolverr load.</p>
        </div>
      </div>

      {/* Rapid Polling RSS */}
      <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-white uppercase tracking-widest">Rapid Polling RSS</h3>
            <p className="text-[10px] font-mono text-white/30 mt-1">Starts shortly after a monitored episode's exact air time, then hands unresolved episodes to hourly targeted searches.</p>
          </div>
          {mon.rapidActive && <span className="px-3 py-1 rounded-lg bg-[#00D4FF]/15 text-[#00D4FF] text-[9px] font-bold uppercase tracking-widest">● Rapid active</span>}
        </div>
        <PolToggle label="Enable rapid polling around air times" value={m.rapidPollingEnabled} onChange={v => save({ rapidPollingEnabled: v })} />
        {m.rapidPollingEnabled && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <NumField label="Start after air time" value={m.rapidStartDelayMinutes} min={0} max={120} suffix="min" onChange={v => save({ rapidStartDelayMinutes: v })} />
            <NumField label="RSS poll interval" value={m.rapidPollIntervalMinutes} min={1} max={60} suffix="min" onChange={v => save({ rapidPollIntervalMinutes: v })} />
            <NumField label="RSS search window" value={m.rapidWindowAfterAirHours} min={1} max={24} suffix="hrs" onChange={v => save({ rapidWindowAfterAirHours: v })} />
            <NumField label="Targeted search interval" value={m.targetedSearchIntervalMinutes} min={15} max={360} suffix="min" onChange={v => save({ targetedSearchIntervalMinutes: v })} />
            <NumField label="Total release window" value={m.targetedSearchWindowHours} min={m.rapidWindowAfterAirHours} max={168} suffix="hrs" onChange={v => save({ targetedSearchWindowHours: v })} />
          </div>
        )}
      </div>
    </div>
  )
}

function SearchMissingTab() {
  const [data, setData] = useState<SearchMissingResponse | null>(null)
  const [runs, setRuns] = useState<ScheduleRun[]>([])
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)

  const loadRuns = () => sharedApi.searchMissing.getRuns().then(r => setRuns(r.runs)).catch(() => {})
  useEffect(() => { sharedApi.searchMissing.getSettings().then(setData).catch(() => {}); loadRuns() }, [])
  if (!data) return <div className="min-h-[400px] flex items-center justify-center"><Spinner className="w-8 h-8" /></div>

  const s = data.settings
  const patch = async (p: Partial<SearchMissingResponse['settings']>) => {
    setSaving(true)
    try { setData(await sharedApi.searchMissing.setSettings(p)) } finally { setSaving(false) }
  }
  const setDay = (day: string, dp: any) => patch({ schedule: s.schedule.map(d => d.dayOfWeek === day ? { ...d, ...dp } : d) })
  const setWindow = (day: string, wp: any) => {
    const d = s.schedule.find(x => x.dayOfWeek === day)
    const w0 = d?.windows[0] ?? { id: `${day}-1`, enabled: true, time: '03:00', itemsPerRun: null }
    setDay(day, { windows: [{ ...w0, ...wp }] })
  }
  const runNow = async () => {
    setRunning(true)
    try { await sharedApi.searchMissing.run({ itemLimit: s.defaultItemsPerRun }); setTimeout(() => { loadRuns(); setRunning(false) }, 1500) }
    catch { setRunning(false) }
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-white/40 max-w-2xl leading-relaxed">
        Search Missing is the <span className="text-white/60">backlog</span> recovery process for older, already-released content.
        New and recently-released items are handled by RSS monitoring (see the <span className="text-white/60">RSS</span> tab) — anything released within the exclusion window is skipped here.
        It runs slowly and steadily on a schedule.
      </p>

      <div className="flex flex-wrap gap-3">
        <div className="px-4 py-3 rounded-xl bg-black/40 border border-white/5">
          <div className="text-[10px] font-mono text-white/30 uppercase tracking-widest">Next run</div>
          <div className="text-sm text-white mt-1">{s.enabled ? (data.nextRun ?? '—') : 'Disabled'}</div>
        </div>
        <div className="px-4 py-3 rounded-xl bg-black/40 border border-white/5">
          <div className="text-[10px] font-mono text-white/30 uppercase tracking-widest">Eligible backlog</div>
          <div className="text-sm text-[#00D4FF] mt-1">{data.eligibleBacklog} items</div>
        </div>
        <button onClick={runNow} disabled={running || !s.allowManualRun}
          className="px-5 py-2 self-center rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] text-xs font-bold uppercase tracking-widest hover:bg-[#00D4FF]/20 disabled:opacity-40">
          {running ? <Spinner className="w-4 h-4" /> : '▶'} Run Now
        </button>
      </div>

      {/* Global controls */}
      <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl space-y-6">
        <PolToggle label="Enable Scheduled Search Missing" value={s.enabled} onChange={v => patch({ enabled: v })} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <NumField label="Recent-release exclusion" value={s.recentReleaseExclusionHours} min={0} suffix="hours" onChange={v => patch({ recentReleaseExclusionHours: v })} />
          <NumField label="Default items / run" value={s.defaultItemsPerRun} min={1} max={s.maximumItemsPerRun} onChange={v => patch({ defaultItemsPerRun: v })} />
          <NumField label="Item cooldown" value={Math.round(s.itemCooldownHours / 24)} min={0} suffix="days" onChange={v => patch({ itemCooldownHours: v * 24 })} />
          <div className="space-y-2">
            <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Selection strategy</label>
            <select value={s.selectionStrategy} onChange={e => patch({ selectionStrategy: e.target.value as any })}
              className="w-full bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/70 outline-none focus:border-white/20">
              {SM_STRATEGIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Time zone</label>
            <input value={s.timezone} onChange={e => setData({ ...data, settings: { ...s, timezone: e.target.value } })} onBlur={e => patch({ timezone: e.target.value })}
              placeholder="system or Asia/Dubai"
              className="w-full bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/70 outline-none focus:border-white/20" />
          </div>
          <NumField label="Missed-run grace" value={s.scheduleGraceMinutes} min={0} suffix="min" onChange={v => patch({ scheduleGraceMinutes: v })} />
        </div>
      </div>

      {/* Weekly schedule editor */}
      <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl">
        <h3 className="text-sm font-medium text-white uppercase tracking-widest mb-4">Weekly Schedule</h3>
        <div className="space-y-2">
          {SM_DAYS.map(day => {
            const d = s.schedule.find(x => x.dayOfWeek === day)
            const w = d?.windows[0]
            return (
              <div key={day} className="flex items-center gap-4 px-4 py-2.5 rounded-xl bg-black/40 border border-white/5">
                <span className="w-24 text-xs text-white/60 capitalize">{day}</span>
                <button onClick={() => setDay(day, { enabled: !d?.enabled })}
                  className={`px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-widest ${d?.enabled ? 'bg-[#00D4FF]/15 text-[#00D4FF]' : 'bg-white/5 text-white/25'}`}>
                  {d?.enabled ? 'On' : 'Off'}
                </button>
                <input type="time" value={w?.time ?? '03:00'} disabled={!d?.enabled} onChange={e => setWindow(day, { time: e.target.value })}
                  className="bg-black/40 border border-white/5 rounded-lg px-2 py-1 text-xs text-white/70 outline-none disabled:opacity-30" />
                <input type="number" min={1} max={s.maximumItemsPerRun} placeholder={`inherit (${s.defaultItemsPerRun})`} value={w?.itemsPerRun ?? ''} disabled={!d?.enabled}
                  onChange={e => setWindow(day, { itemsPerRun: e.target.value === '' ? null : Math.max(1, parseInt(e.target.value, 10) || 1) })}
                  className="w-36 bg-black/40 border border-white/5 rounded-lg px-2 py-1 text-xs text-white/70 outline-none disabled:opacity-30" />
                <span className="text-[9px] font-mono text-white/25 uppercase">items</span>
              </div>
            )
          })}
        </div>
        {saving && <p className="text-[10px] font-mono text-white/30 mt-3">saving…</p>}
      </div>

      {/* Run history */}
      {runs.length > 0 && (
        <div className="px-6 py-6 rounded-2xl bg-noir-900 border border-white/5 shadow-2xl">
          <h3 className="text-sm font-medium text-white uppercase tracking-widest mb-4">Run History</h3>
          <div className="rounded-xl border border-white/5 overflow-hidden max-h-72 overflow-y-auto custom-scrollbar">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-noir-900 text-[9px] font-mono text-white/30 uppercase tracking-widest">
                <tr><th className="px-3 py-2 font-normal">Scheduled</th><th className="px-3 py-2 font-normal">Status</th><th className="px-3 py-2 font-normal">Searched</th><th className="px-3 py-2 font-normal">Grabbed</th></tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} className="border-t border-white/5" title={r.error ?? ''}>
                    <td className="px-3 py-2 text-white/60 font-mono text-[11px]">{r.scheduled_local_date} {r.scheduled_local_time}</td>
                    <td className="px-3 py-2"><span className={`text-[9px] font-mono uppercase ${r.status.startsWith('completed') ? 'text-green-400/80' : r.status === 'failed' ? 'text-red-400' : 'text-white/40'}`}>{r.status.replace(/_/g, ' ')}</span></td>
                    <td className="px-3 py-2 text-white/40">{r.searched_item_count}</td>
                    <td className="px-3 py-2 text-white/40">{r.accepted_release_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function DevicesTab() {
  const [devices, setDevices] = useState<AuthDevice[]>([])
  const [loading, setLoading] = useState(true)
  const load = () => sharedApi.devices.list().then(result => setDevices(result.devices)).finally(() => setLoading(false))
  useEffect(() => { load().catch(console.error) }, [])
  const date = (value: number | null) => value ? new Date(value).toLocaleString() : 'Never'

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-display text-white uppercase tracking-widest">Connected Devices</h3>
        <p className="mt-1 text-xs text-white/35">Kodi receives a separate revocable credential when it signs in. Revoking a device does not change your password or disconnect other players.</p>
      </div>
      {loading ? <Spinner className="w-6 h-6" /> : devices.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-noir-900 p-6 text-sm text-white/30">No device credentials have been registered.</div>
      ) : (
        <div className="space-y-2">
          {devices.map(device => (
            <div key={device.id} className="flex items-center gap-4 rounded-2xl border border-white/5 bg-noir-900 px-5 py-4">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">{device.name}</p>
                <p className="mt-1 text-[10px] font-mono text-white/30">Last seen: {date(device.lastSeenAt)} · Expires: {date(device.expiresAt)}</p>
              </div>
              <button onClick={async () => {
                if (!confirm(`Revoke access for ${device.name}?`)) return
                await sharedApi.devices.revoke(device.id)
                setDevices(current => current.filter(item => item.id !== device.id))
              }} className="shrink-0 px-3 py-1.5 rounded-lg border border-red-500/20 bg-red-500/10 text-[9px] font-bold uppercase tracking-widest text-red-400 hover:bg-red-500/20">
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Two-level settings nav: major sections, each with its own sub-tabs.
const SETTINGS_NAV = [
  { group: 'Libraries',   tabs: ['Library Tabs', 'Root Folders', 'Import Lists'] },
  { group: 'Downloads',   tabs: ['Indexers', 'RSS', 'Monitoring', 'Search Missing', 'Subtitles'] },
  { group: 'Definitions', tabs: ['Quality Tiers', 'Edition Rules', 'Quality Profiles', 'Acquisition Defaults'] },
  { group: 'Processing',  tabs: ['Queue', 'Media Track Cleaning', 'Intro & Credit Detection', 'Volume Normalisation', 'Video Encoding', 'Audio Encoding'] },
  { group: 'System',      tabs: ['System', 'Recommendations', 'Devices', 'API Keys', 'Danger Zone'] },
] as const

type Group = typeof SETTINGS_NAV[number]['group']
type Tab = typeof SETTINGS_NAV[number]['tabs'][number]

export function SettingsPage() {
  const [group, setGroup] = useState<Group>('Libraries')
  const [tab, setTab] = useState<Tab>('Library Tabs')
  const [flareConfig, setFlareConfig] = useState<FlareSolverrConfig>({ url: '', enabled: false })

  useEffect(() => {
    sharedApi.settings.getFlareSolverr().then(setFlareConfig).catch(() => {})
  }, [])

  const activeGroup = SETTINGS_NAV.find(g => g.group === group) ?? SETTINGS_NAV[0]

  const selectGroup = (g: Group) => {
    setGroup(g)
    setTab(SETTINGS_NAV.find(x => x.group === g)!.tabs[0])
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="font-display text-5xl tracking-widest text-white uppercase">Settings</h1>
      </div>
      {/* Major sections */}
      <div className="flex gap-1.5 p-1 bg-noir-900 border border-white/5 rounded-xl w-fit mb-3 overflow-x-auto custom-scrollbar no-scrollbar">
        {SETTINGS_NAV.map(g => (
          <button key={g.group} onClick={() => selectGroup(g.group)}
            className={`px-5 py-2.5 rounded-lg text-xs font-bold tracking-widest uppercase transition-all whitespace-nowrap ${
              group === g.group ? 'bg-[#00D4FF] text-noir-950 shadow-[0_0_20px_rgba(0,212,255,0.2)]' : 'text-white/30 hover:text-white/60'
            }`}>
            {g.group}
          </button>
        ))}
      </div>
      {/* Sub-tabs within the active section */}
      <div className="flex gap-1 w-fit mb-8 overflow-x-auto custom-scrollbar no-scrollbar">
        {activeGroup.tabs.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3.5 py-1.5 rounded-lg text-[10px] font-bold tracking-widest uppercase transition-all whitespace-nowrap ${
              tab === t ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
            }`}>
            {t}
          </button>
        ))}
      </div>
      <div className="w-full">
        {tab === 'Library Tabs'         && <LibraryTabsTab />}
        {tab === 'Indexers'             && <IndexersPage hideHeader={true} />}
        {tab === 'RSS'                  && <RssTab />}
        {tab === 'Monitoring'           && <MonitoringTab />}
        {tab === 'Quality Profiles'     && <QualityProfilesTab />}
        {tab === 'Edition Rules'        && <EditionRulesTab />}
        {tab === 'Root Folders'         && <RootFoldersTab />}
        {tab === 'Import Lists'         && <ImportListsTab />}
        {tab === 'Acquisition Defaults' && <AcquisitionDefaultsTab />}
        {tab === 'Quality Tiers'        && <QualityTiersTab />}
        {tab === 'Queue'                && <ProcessingMonitorTab />}
        {tab === 'Search Missing'       && <SearchMissingTab />}
        {tab === 'Media Track Cleaning' && <MediaProcessingTab />}
        {tab === 'Intro & Credit Detection' && <IntroCreditDetectionTab />}
        {tab === 'Volume Normalisation' && <VolumeNormalisationTab />}
        {tab === 'Video Encoding'       && <ProcessingTab mode="video" />}
        {tab === 'Audio Encoding'       && <ProcessingTab mode="audio" />}
        {tab === 'Subtitles'            && <SubtitlesTab />}
        {tab === 'API Keys'             && <ApiKeysTab />}
        {tab === 'System'               && <SystemTab config={flareConfig} onUpdate={setFlareConfig} />}
        {tab === 'Recommendations'      && <RecommendationsSystemTab />}
        {tab === 'Devices'              && <DevicesTab />}
        {tab === 'Danger Zone'          && <DangerZoneTab />}
      </div>
    </div>
  )
}
