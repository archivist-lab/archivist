import { useState, useEffect, useMemo } from 'react'
import { sharedApi, type QualityProfile, type RootFolder, type FlareSolverrConfig, type ApiKeysConfig, type TierConfig, type TierTerm, type TierMediaType, type AcquisitionDefaults, type TrackCleanerConfig, type SubtitleConfig, type SystemOverview, type SystemJob, type MaintenanceConfig, type BackupConfig, type IntegrityReport, type IntegrityConfig } from '../../lib/shared.api.js'
import { filmsApi } from '../../lib/films.api.js'
import { seriesApi } from '../../lib/series.api.js'
import { musicApi } from '../../lib/music.api.js'
import { booksApi } from '../../lib/books.api.js'
import { comicsApi, gamesApi } from '../../lib/comics-games.api.js'
import { Field, Input, Toggle, Spinner, TabSelect, Modal } from '../../components/ui.js'
import { TorrentsPage } from '../torrents/TorrentsPage.js'
import { IndexersPage } from '../indexers/IndexersPage.js'
import { useTabs, type MediaType } from '../../lib/tab-context.js'

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
const TIER_DESCRIPTIONS = [
  'Best quality — encoder groups like QxR, Tigole or quality tags like BluRay, REMUX',
  'Good quality — groups like UTR, Joy or tags like WEB-DL, 1080p',
  'Acceptable — groups like YIFY or tags like 720p, HDTV',
]

const DEFAULT_TIERS_CLIENT: TierConfig = {
  tier1: [], tier2: [], tier3: [],
}

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
              placeholder="Add term (e.g. QxR, BluRay, 1080p)..."
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
  const [config, setConfig] = useState<TierConfig>(DEFAULT_TIERS_CLIENT)
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
        Search terms are appended to queries per tier. Each term can be enabled per media type — e.g. "QxR" for Films only, "BluRay" for Series only.
      </p>

      {(['tier1', 'tier2', 'tier3'] as const).map((key, i) => (
        <TierAccordion
          key={key}
          tierKey={key}
          label={TIER_LABELS[i]}
          description={TIER_DESCRIPTIONS[i]}
          terms={config[key]}
          onChange={updateTier(key)}
        />
      ))}

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

const TABS = ['Library Tabs', 'Indexers', 'Quality Profiles', 'Edition Rules', 'Root Folders', 'Acquisition Defaults', 'Quality Tiers', 'Media Processing', 'Subtitles', 'API Keys', 'System', 'Danger Zone'] as const
type Tab = typeof TABS[number]

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('Library Tabs')
  const [flareConfig, setFlareConfig] = useState<FlareSolverrConfig>({ url: '', enabled: false })

  useEffect(() => {
    sharedApi.settings.getFlareSolverr().then(setFlareConfig).catch(() => {})
  }, [])

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="font-display text-5xl tracking-widest text-white uppercase">Settings</h1>
      </div>
      <div className="flex gap-1.5 p-1 bg-noir-900 border border-white/5 rounded-xl w-fit mb-8 overflow-x-auto custom-scrollbar no-scrollbar">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-lg text-[10px] font-bold tracking-widest uppercase transition-all whitespace-nowrap ${
              tab === t ? 'bg-[#00D4FF] text-noir-950 shadow-[0_0_20px_rgba(0,212,255,0.2)]' : 'text-white/30 hover:text-white/60'
            }`}>
            {t}
          </button>
        ))}
      </div>
      <div className="w-full">
        {tab === 'Library Tabs'         && <LibraryTabsTab />}
        {tab === 'Indexers'             && <IndexersPage hideHeader={true} />}
        {tab === 'Quality Profiles'     && <QualityProfilesTab />}
        {tab === 'Edition Rules'        && <EditionRulesTab />}
        {tab === 'Root Folders'         && <RootFoldersTab />}
        {tab === 'Acquisition Defaults' && <AcquisitionDefaultsTab />}
        {tab === 'Quality Tiers'        && <QualityTiersTab />}
        {tab === 'Media Processing'     && <MediaProcessingTab />}
        {tab === 'Subtitles'            && <SubtitlesTab />}
        {tab === 'API Keys'             && <ApiKeysTab />}
        {tab === 'System'               && <SystemTab config={flareConfig} onUpdate={setFlareConfig} />}
        {tab === 'Danger Zone'          && <DangerZoneTab />}
      </div>
    </div>
  )
}
