import { useState, useEffect, useCallback } from 'react'
import { toast, confirmDialog } from '../../lib/notify.js'
import { sharedApi } from '../../lib/shared.api.js'
import { Spinner, TabSelect } from '../../components/ui.js'

// Priorities are configured per workflow and media type. Show one number when
// uniform or a min–max range when the configured media types differ.
function effectivePriorityLabel(ix: any, key: 'priority' | 'rssPriority'): string {
  const raw = ix?.settings?.mediaTypes
  const mt = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return {} } })() : (raw || {})
  const prios = Object.values(mt).map((t: any) => t?.[key] ?? (key === 'rssPriority' ? t?.priority : undefined)).filter((p: any) => typeof p === 'number')
  if (prios.length === 0) return String(key === 'rssPriority' ? (ix?.settings?.rssPriority ?? ix?.priority ?? 25) : (ix?.priority ?? 25))
  const min = Math.min(...prios), max = Math.max(...prios)
  return min === max ? String(min) : `${min}–${max}`
}

export function IndexersPage({ hideHeader = false }: { hideHeader?: boolean }) {
  const [indexers,   setIndexers]   = useState<any[]>([])
  const [defs,       setDefs]       = useState<any[]>([])
  const [loading,    setLoading]    = useState(true)
  const [editing,    setEditing]    = useState<any | 'new' | null>(null)
  const [testing,    setTesting]    = useState<Set<string>>(new Set())
  const [testingAll, setTestingAll] = useState(false)
  const [testResult, setTestResult] = useState<Record<string, 'ok' | 'fail'>>({})

  const load = useCallback(async () => {
    try {
      const [ix, ds] = await Promise.all([sharedApi.indexers.list(), sharedApi.indexers.schema()])
      setIndexers(ix)
      setDefs(ds)
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const toggle = async (ix: any) => {
    await sharedApi.indexers.update(ix.id, { enabled: !ix.enabled })
    load()
  }

  const remove = async (id: string) => {
    if (!await confirmDialog('Remove this indexer?')) return
    const snapshot = indexers
    setIndexers(prev => prev.filter(x => x.id !== id))
    try { await sharedApi.indexers.delete(id) }
    catch (err) { toast.error(String(err)); setIndexers(snapshot) }
  }

  const test = async (id: string) => {
    setTesting(prev => new Set(prev).add(id))
    try {
      const res = await sharedApi.indexers.test(id)
      setTestResult(prev => ({ ...prev, [id]: res.success ? 'ok' : 'fail' }))
    } catch {
      setTestResult(prev => ({ ...prev, [id]: 'fail' }))
    }
    setTesting(prev => { const s = new Set(prev); s.delete(id); return s })
  }

  const testAll = async () => {
    const ids = indexers.map(ix => String(ix.id))
    setTestingAll(true)
    setTesting(new Set(ids))
    const results = await Promise.all(ids.map(async id => {
      try {
        const res = await sharedApi.indexers.test(id)
        return [id, res.success ? 'ok' : 'fail'] as const
      } catch {
        return [id, 'fail'] as const
      }
    }))
    setTestResult(prev => ({ ...prev, ...Object.fromEntries(results) }))
    setTesting(new Set())
    setTestingAll(false)
  }

  const enabled = indexers.filter(i => i.enabled).length

  return (
    <div className="animate-fade-in">
      {/* Header */}
      {!hideHeader && (
        <div className="flex items-center gap-4 mb-6">
          <div className="flex-1">
            <h1 className="font-display text-5xl tracking-widest text-white">INDEXERS</h1>
            <p className="text-[10px] font-mono text-white/30 mt-1">
              {enabled} enabled · {indexers.length} total · {defs.length} definitions loaded
            </p>
          </div>
        <div className="flex gap-4 items-center">
          <button
            onClick={testAll}
            disabled={indexers.length === 0 || testing.size > 0}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white hover:bg-white/10 text-sm transition-all uppercase tracking-widest font-bold disabled:opacity-40"
          >
            {testingAll ? 'Testing All...' : 'Test All Indexers'}
          </button>
          <button
            onClick={async () => {
              try {
                await sharedApi.system.runRss();
                toast.success('RSS Sync queued successfully.');
              } catch (e) {
                toast.error('Failed to trigger RSS Sync: ' + String(e));
              }
            }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 text-sm transition-all uppercase tracking-widest font-bold"
          >
            Force RSS Sync
          </button>
          <button
            onClick={() => setEditing('new')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-sm transition-all"
          >
            + Add Indexer
          </button>
        </div>
        </div>
      )}

      {hideHeader && (
        <div className="flex items-center justify-between mb-4">
          <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest">
            {enabled} ENABLED · {indexers.length} TOTAL · {defs.length} LOADED
          </p>
          <div className="flex gap-3">
            <button
              onClick={testAll}
              disabled={indexers.length === 0 || testing.size > 0}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/50 hover:text-white hover:bg-white/10 text-[10px] font-mono transition-all uppercase tracking-widest disabled:opacity-40"
            >
              {testingAll ? 'Testing All...' : 'Test All Indexers'}
            </button>
            <button
              onClick={async () => {
                try {
                  await sharedApi.system.runRss();
                  toast.success('RSS Sync queued successfully.');
                } catch (e) {
                  toast.error('Failed to trigger RSS Sync: ' + String(e));
                }
              }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 text-[10px] font-mono transition-all uppercase tracking-widest"
            >
              Force RSS Sync
            </button>
            <button
              onClick={() => setEditing('new')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-[10px] font-mono transition-all"
            >
              + ADD INDEXER
            </button>
          </div>
        </div>
      )}

      {/* Built-in engine info */}
      <div className="bg-[#00D4FF]/5 border border-[#00D4FF]/15 rounded-xl px-4 py-3 flex items-center gap-3 mb-5">
        <div className="w-1.5 h-1.5 rounded-full bg-[#00D4FF] animate-pulse flex-shrink-0" />
        <p className="text-xs font-mono text-[#00D4FF]/60">
          Searches fan out to all enabled indexers simultaneously via the built-in TorrentStack engine.
        </p>
      </div>

      {loading ? (
        <div className="text-center py-20 text-white/20 font-mono text-sm">Loading...</div>
      ) : indexers.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-white/10 rounded-2xl">
          <p className="text-white/20 font-mono text-sm mb-3">No indexers configured</p>
          <button onClick={() => setEditing('new')} className="text-[#00D4FF] text-xs hover:underline">
            Add your first indexer
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {indexers.map(ix => {
            const flareEnabled = ix.settings?.flaresolverr === true || ix.settings?.flaresolverr === 'true'
            return (
              <div
                key={ix.id}
                className={`bg-noir-900 border border-white/5 rounded-xl px-4 py-3 flex items-center gap-4 hover:border-white/10 transition-all ${!ix.enabled ? 'opacity-50' : ''}`}
              >
                {/* Toggle */}
                <div
                  className={`w-9 h-5 rounded-full cursor-pointer transition-colors relative flex-shrink-0 ${ix.enabled ? 'bg-[#00D4FF]/30' : 'bg-white/10'}`}
                  onClick={() => toggle(ix)}
                >
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${ix.enabled ? 'left-4 bg-[#00D4FF]' : 'left-0.5 bg-white/30'}`} />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">{ix.name}</span>
                    {ix.protocol !== 'cardigann' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-white/30 font-mono border border-white/10">
                        {ix.protocol}
                      </span>
                    )}
                    {flareEnabled && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 font-mono border border-orange-500/20">
                        FLARESOLVERR
                      </span>
                    )}
                    {ix.status?.failureCount > 0 && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#FF2D78]/10 text-[#FF2D78] font-mono border border-[#FF2D78]/20">{ix.status.failureCount} ERRORS</span>
                    )}
                    {testResult[ix.id] === 'ok'   && <span className="text-[10px] text-emerald-400 font-mono">✓ OK</span>}
                    {testResult[ix.id] === 'fail'  && <span className="text-[10px] text-red-400 font-mono">✕ Failed</span>}
                  </div>
                  <p className="text-xs font-mono text-white/30 mt-0.5 truncate">
                    {ix.baseUrl || '(no URL set)'} · Scan {effectivePriorityLabel(ix, 'priority')} · RSS {effectivePriorityLabel(ix, 'rssPriority')}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => test(ix.id)}
                    disabled={testing.has(ix.id)}
                    className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white hover:bg-white/10 text-xs font-mono transition-all disabled:opacity-40"
                  >
                    {testing.has(ix.id) ? '...' : 'Test'}
                  </button>
                  <button
                    onClick={() => setEditing(ix)}
                    className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white hover:bg-white/10 text-xs font-mono transition-all"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => remove(ix.id)}
                    className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-red-400/40 hover:text-red-400 hover:bg-red-500/10 text-xs font-mono transition-all"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <IndexerModal
          defs={defs}
          indexer={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { load(); setEditing(null) }}
        />
      )}
    </div>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

const MEDIA_TYPES = [
  { id: 'films', label: 'Films' },
  { id: 'series', label: 'Series' },
  { id: 'music', label: 'Music' },
  { id: 'books', label: 'Books' },
  { id: 'comics', label: 'Comics' },
  { id: 'games', label: 'Games' }
]

function IndexerModal({ defs, indexer, onClose, onSaved }: {
  defs: any[]
  indexer?: any
  onClose: () => void
  onSaved: () => void
}) {
  const [search,          setSearch]          = useState('')
  const [selected,        setSelected]        = useState<any | null>(null)

  const [name,            setName]            = useState('')
  const [baseUrl,         setBaseUrl]         = useState('')
  const [apiKey,          setApiKey]          = useState('')
  const [settings,        setSettings]        = useState<Record<string, string>>({})
  const [enabled,         setEnabled]         = useState(true)
  const [useFlaresolverr, setUseFlaresolverr] = useState(false)
  const [useForRss, setUseForRss] = useState(true) // whether this indexer feeds the RSS poller

  const [mediaTypes, setMediaTypes] = useState<Record<string, { enabled: boolean, priority: number, rssPriority: number }>>({})
  // Global fallbacks used when a media type has no workflow-specific override.
  const [globalPriority, setGlobalPriority] = useState(25)
  const [globalRssPriority, setGlobalRssPriority] = useState(25)

  const [busy,    setBusy]    = useState(false)
  const [testing, setTesting] = useState(false)
  const [testRes, setTestRes] = useState<{ success: boolean; message: string; resultCount?: number } | null>(null)

  useEffect(() => {
    if (indexer) {
      const def = defs.find(d => d.id === indexer.definitionId)
      if (def) setSelected(def)
      setName(indexer.name)
      setBaseUrl(indexer.baseUrl)
      setApiKey(indexer.apiKey ?? '')
      setEnabled(indexer.enabled ?? true)
      const s = indexer.settings || {}
      setUseFlaresolverr(s.flaresolverr === true || s.flaresolverr === 'true')
      setUseForRss(s.rss !== false && s.rss !== 'false') // default on when unset
      
      const tc: Record<string, { enabled: boolean, priority: number, rssPriority: number }> = {}
      const storedTypes = typeof s.mediaTypes === 'string' ? JSON.parse(s.mediaTypes) : (s.mediaTypes || {})
      MEDIA_TYPES.forEach(m => {
        const t = storedTypes[m.id]
        tc[m.id] = {
          enabled: t ? t.enabled : true,
          priority: t ? t.priority : (indexer.priority ?? 25),
          rssPriority: t?.rssPriority ?? t?.priority ?? s.rssPriority ?? indexer.priority ?? 25,
        }
      })
      setMediaTypes(tc)
      // Global = uniform per-type value if they all agree, else the stored top-level.
      const vals = Object.values(tc).map(t => t.priority)
      const uniform = vals.length > 0 && vals.every(v => v === vals[0])
      setGlobalPriority(uniform ? vals[0] : (indexer.priority ?? 25))
      const rssVals = Object.values(tc).map(t => t.rssPriority)
      const uniformRss = rssVals.length > 0 && rssVals.every(v => v === rssVals[0])
      setGlobalRssPriority(uniformRss ? rssVals[0] : (s.rssPriority ?? indexer.priority ?? 25))

      const { flaresolverr: _fs, mediaTypes: _mt, rss: _rss, rssPriority: _rp, ...rest } = s
      setSettings(Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)])))
    }
  }, [indexer, defs])

  useEffect(() => {
    if (selected && !indexer) {
      setName(selected.name)
      setBaseUrl(selected.links?.[0] ?? '')
      setApiKey('')
      setUseFlaresolverr(false)
      setUseForRss(true)
      setGlobalRssPriority(25)

      const defaults: Record<string, string> = {}
      if (selected.settings) {
        selected.settings.forEach((s: any) => {
          if (s.default !== undefined && s.type !== 'info' && s.type !== 'info_flaresolverr') {
            defaults[s.name] = String(s.default)
          }
        })
      }
      setSettings(defaults)

      const tc: Record<string, { enabled: boolean, priority: number, rssPriority: number }> = {}
      MEDIA_TYPES.forEach(m => {
        tc[m.id] = { enabled: true, priority: 25, rssPriority: 25 }
      })
      setMediaTypes(tc)
      setGlobalPriority(25)
    }
  }, [selected, indexer])

  const filtered = defs.filter(d => !search || d.name.toLowerCase().includes(search.toLowerCase()) || d.id.toLowerCase().includes(search.toLowerCase()))

  const buildSettingsPayload = () => {
    const merged: Record<string, any> = { ...settings, mediaTypes, rssPriority: globalRssPriority }
    if (useFlaresolverr) merged.flaresolverr = true
    else delete merged.flaresolverr
    merged.rss = useForRss // explicit so the RSS poller can honour the choice
    return merged
  }

  const handleTest = async () => {
    if (!selected && !indexer) return
    const cleanUrl = baseUrl?.trim().replace(/^\/+/, '')
    if (!cleanUrl) {
      setTestRes({ success: false, message: 'Base URL is required' })
      return
    }

    setTesting(true); setTestRes(null)
    try {
      const res = await sharedApi.indexers.testConfig({
        baseUrl: cleanUrl,
        apiKey,
        settings: buildSettingsPayload(),
        definitionId: selected?.id
      })
      setTestRes({ success: res.success, message: res.success ? `✓ CONNECTION SUCCESSFUL (${res.resultCount} results)` : `✕ ${res.message}`, resultCount: res.resultCount })
    } catch (err) {
      setTestRes({ success: false, message: `✕ ${String(err)}` })
    }
    setTesting(false)
  }

  const handleSave = async () => {
    if (!selected && !indexer) return
    const cleanUrl = baseUrl?.trim().replace(/^\/+/, '')
    if (!cleanUrl) {
      toast.error('Base URL is required')
      return
    }

    setBusy(true)
    try {
      const data = {
        definitionId: selected?.id ?? indexer?.definitionId,
        name, enabled, baseUrl: cleanUrl,
        apiKey: apiKey || undefined,
        settings: buildSettingsPayload(),
        priority: globalPriority, // global fallback + list display
      }
      indexer ? await sharedApi.indexers.update(indexer.id, data) : await sharedApi.indexers.create(data)
      onSaved()
    } catch (err) { toast.error(String(err)) }
    setBusy(false)
  }

  const canSave = (selected || indexer) && name && (baseUrl && baseUrl.trim().length > 0)

  // Definition settings to render (skip info/info_flaresolverr — those are just hints)
  const renderableSettings = (selected?.settings ?? []).filter((s: any) =>
    s.type !== 'info' && s.type !== 'info_flaresolverr'
  )

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-noir-900 border border-white/10 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between flex-shrink-0">
          <span className="font-mono text-sm text-white/80 uppercase tracking-widest">
            {indexer ? 'Edit Indexer' : 'Add Indexer'}
          </span>
          <button onClick={onClose} className="text-white/20 hover:text-white transition-colors">✕</button>
        </div>

        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Definition list (new only) */}
          {!indexer && (
            <div className="w-64 border-r border-white/5 flex flex-col flex-shrink-0">
              <div className="p-2 border-b border-white/5">
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={`Search ${defs.length}...`}
                  className="w-full px-2.5 py-1.5 rounded-lg bg-black/20 border border-white/10 text-white/70 text-xs font-mono placeholder-white/20 focus:outline-none focus:border-white/25 transition-all"
                />
              </div>
              <div className="flex-1 overflow-y-auto custom-scrollbar">
                {filtered.slice(0, 100).map(d => (
                  <button
                    key={d.id}
                    onClick={() => setSelected(d)}
                    className={`w-full text-left px-3 py-2 text-xs transition-colors border-b border-white/[0.03]
                      ${selected?.id === d.id ? 'bg-[#00D4FF]/10 text-[#00D4FF]' : 'text-white/50 hover:bg-white/5 hover:text-white'}`}
                  >
                    <div className="font-medium truncate">{d.name}</div>
                    <div className="text-[10px] text-white/25 capitalize font-mono mt-0.5">{d.type} · {d.language}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Config form */}
          <div className="flex-1 p-5 overflow-y-auto custom-scrollbar">
            {!selected && !indexer ? (
              <div className="flex flex-col items-center justify-center h-full text-white/20 text-sm font-mono text-center space-y-3">
                <span className="text-3xl">←</span>
                <p>Select an indexer from the list to begin configuration</p>
              </div>
            ) : (
              <div className="space-y-4">
                {selected && (
                  <div className="pb-2 flex items-start justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white">{selected.name}</p>
                      {selected.description && <p className="text-[10px] text-white/30 mt-0.5 leading-tight">{selected.description}</p>}
                    </div>
                    {!indexer && <button onClick={() => setSelected(null)} className="text-[10px] text-[#00D4FF] hover:underline font-mono">CHANGE</button>}
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3">
                  <div className="space-y-1">
                    <label className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Name</label>
                    <input value={name} onChange={e => setName(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white/80 text-sm focus:outline-none focus:border-white/25 transition-all" />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                  <div className="space-y-1">
                    <label className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Global Scan Priority</label>
                    <div className="flex items-center gap-2">
                      <input type="number" min={1} max={100} value={globalPriority}
                        onChange={e => setGlobalPriority(Number(e.target.value))}
                        className="w-24 px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white/80 text-sm focus:outline-none focus:border-white/25 transition-all" />
                      <button type="button"
                        onClick={() => setMediaTypes(p => Object.fromEntries(MEDIA_TYPES.map(m => [m.id, { enabled: p[m.id]?.enabled ?? true, priority: globalPriority, rssPriority: p[m.id]?.rssPriority ?? globalRssPriority }])))}
                        className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white/50 hover:text-white text-[10px] font-mono uppercase tracking-widest transition-all">
                        Apply to all
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Global RSS Priority</label>
                    <div className="flex items-center gap-2">
                      <input type="number" min={1} max={100} value={globalRssPriority}
                        onChange={e => setGlobalRssPriority(Number(e.target.value))}
                        className="w-24 px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white/80 text-sm focus:outline-none focus:border-white/25 transition-all" />
                      <button type="button"
                        onClick={() => setMediaTypes(p => Object.fromEntries(MEDIA_TYPES.map(m => [m.id, { enabled: p[m.id]?.enabled ?? true, priority: p[m.id]?.priority ?? globalPriority, rssPriority: globalRssPriority }])))}
                        className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white/50 hover:text-white text-[10px] font-mono uppercase tracking-widest transition-all">
                        Apply to all
                      </button>
                    </div>
                  </div>
                  <p className="md:col-span-2 text-[9px] font-mono text-white/25 leading-tight">Lower numbers are preferred. Scan applies to interactive and missing-item searches; RSS applies to feed monitoring.</p>
                </div>

                <div className="space-y-3 pt-2">
                  <p className="text-[9px] font-mono text-white/30 uppercase tracking-widest">Applicable Media Types (override the global)</p>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {MEDIA_TYPES.map(m => {
                      const active = mediaTypes[m.id]?.enabled ?? true
                      const prio = mediaTypes[m.id]?.priority ?? 25
                      const rssPrio = mediaTypes[m.id]?.rssPriority ?? prio
                      return (
                        <div key={m.id} className={`p-3 rounded-lg border transition-all ${active ? 'bg-[#00D4FF]/5 border-[#00D4FF]/20' : 'bg-black/20 border-white/5 opacity-60 hover:opacity-100'}`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className={`text-xs font-mono font-medium ${active ? 'text-[#00D4FF]' : 'text-white/40'}`}>{m.label}</span>
                            <div className={`w-6 h-3 rounded-full cursor-pointer transition-colors relative flex-shrink-0 ${active ? 'bg-[#00D4FF]/50' : 'bg-white/20'}`} onClick={() => setMediaTypes(p => ({ ...p, [m.id]: { ...p[m.id], enabled: !active } }))}>
                              <div className={`absolute top-[1px] w-2.5 h-2.5 rounded-full transition-all ${active ? 'left-[13px] bg-white' : 'left-[1px] bg-white/50'}`} />
                            </div>
                          </div>
                          <div className={`transition-all ${active ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                            <label className="flex items-center gap-2 mb-1.5">
                              <span className="text-[9px] font-mono text-white/30 w-10">Scan:</span>
                              <input type="number" min="1" max="100" value={prio} onChange={e => setMediaTypes(p => ({ ...p, [m.id]: { ...p[m.id], priority: Number(e.target.value) } }))}
                                className="w-full px-2 py-1 rounded bg-black/40 border border-white/10 text-white/80 text-xs focus:outline-none focus:border-[#00D4FF]/50" />
                            </label>
                            <label className="flex items-center gap-2">
                              <span className="text-[9px] font-mono text-white/30 w-10">RSS:</span>
                              <input type="number" min="1" max="100" value={rssPrio} onChange={e => setMediaTypes(p => ({ ...p, [m.id]: { ...p[m.id], rssPriority: Number(e.target.value) } }))}
                                className="w-full px-2 py-1 rounded bg-black/40 border border-white/10 text-white/80 text-xs focus:outline-none focus:border-[#00D4FF]/50" />
                            </label>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Base URL</label>
                  {selected?.links && selected.links.length > 1 ? (
                    <TabSelect 
                      value={baseUrl} 
                      onChange={setBaseUrl} 
                      options={selected.links}
                    />
                  ) : (
                    <input
                      value={baseUrl}
                      onChange={e => setBaseUrl(e.target.value)}
                      placeholder="https://..."
                      className="w-full px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white/80 text-sm focus:outline-none focus:border-white/25 transition-all font-mono"
                    />
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-[9px] font-mono text-white/20 uppercase tracking-widest">API Key / Token</label>
                  <input value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Optional"
                    className="w-full px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white/80 text-sm focus:outline-none focus:border-white/25 transition-all font-mono" />
                </div>

                {/* Toggles row */}
                <div className="flex flex-wrap gap-6 pt-1">
                  <Toggle
                    value={enabled}
                    onChange={setEnabled}
                    label="Enabled"
                    color="cyan"
                  />
                  <Toggle
                    value={useFlaresolverr}
                    onChange={setUseFlaresolverr}
                    label="FlareSolverr"
                    color="orange"
                    hint={useFlaresolverr ? 'All requests routed via FlareSolverr' : 'Direct fetch (auto-fallback on Cloudflare)'}
                  />
                  <Toggle
                    value={useForRss}
                    onChange={setUseForRss}
                    label="RSS Feed"
                    color="cyan"
                    hint={useForRss ? 'Polled for new releases' : 'Excluded from the RSS feed (still usable for search)'}
                  />
                </div>

                {/* Definition-specific settings */}
                {renderableSettings.length > 0 && (
                  <div className="space-y-3 pt-2 border-t border-white/5">
                    <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest">Indexer Settings</p>
                    {renderableSettings.map((s: any) => (
                      <SettingField
                        key={s.name}
                        setting={s}
                        value={settings[s.name] ?? ''}
                        onChange={v => setSettings(prev => ({ ...prev, [s.name]: v }))}
                      />
                    ))}
                  </div>
                )}

                {testRes && (
                  <div className={`px-3 py-2 rounded-lg text-xs border font-mono ${testRes.success ? 'bg-[#00D4FF]/10 border-[#00D4FF]/20 text-[#00D4FF]' : 'bg-[#FF2D78]/10 border-[#FF2D78]/20 text-[#FF2D78]'}`}>
                    {testRes.message}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-white/5 flex items-center justify-end gap-2 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white text-xs font-mono transition-all">
            Cancel
          </button>
          <button onClick={handleTest} disabled={testing || !baseUrl || (!selected && !indexer)}
            className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white text-xs font-mono transition-all disabled:opacity-40 flex items-center gap-2">
            {testing ? <Spinner className="w-3 h-3" /> : '◈'} {testing ? 'Testing...' : 'Test'}
          </button>
          <button onClick={handleSave} disabled={busy || !canSave}
            className="px-5 py-2 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 text-xs font-mono transition-all disabled:opacity-40">
            {busy ? 'Saving...' : (indexer ? 'Save Changes' : 'Add Indexer')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Reusable toggle ────────────────────────────────────────────────────────────

function Toggle({ value, onChange, label, color = 'cyan', hint }: {
  value: boolean
  onChange: (v: boolean) => void
  label: string
  color?: 'cyan' | 'orange'
  hint?: string
}) {
  const active = color === 'orange'
    ? { track: 'bg-orange-500/30', thumb: 'bg-orange-400', text: 'text-orange-400/80' }
    : { track: 'bg-[#00D4FF]/30',  thumb: 'bg-[#00D4FF]',  text: 'text-white/60' }

  return (
    <label className="flex items-center gap-2 cursor-pointer group" onClick={() => onChange(!value)}>
      <div className={`w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ${value ? active.track : 'bg-white/10'}`}>
        <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${value ? `left-4 ${active.thumb}` : 'left-0.5 bg-white/30'}`} />
      </div>
      <div>
        <span className={`text-[10px] font-mono uppercase tracking-widest transition-colors ${value ? active.text : 'text-white/30'} group-hover:text-white/60`}>
          {label}
        </span>
        {hint && <p className="text-[9px] font-mono text-white/20 leading-tight mt-0.5">{hint}</p>}
      </div>
    </label>
  )
}

// ── Setting field renderer ─────────────────────────────────────────────────────

function SettingField({ setting, value, onChange }: {
  setting: any
  value: string
  onChange: (v: string) => void
}) {
  const labelClass = 'text-[9px] font-mono text-white/20 uppercase tracking-widest'
  const inputClass = 'w-full px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-white/80 text-sm focus:outline-none focus:border-white/25 transition-all'

  if (setting.type === 'select' && setting.options) {
    const opts = Object.entries(setting.options as Record<string, string>).map(([val, label]) => ({ label, value: val }))
    return (
      <TabSelect
        label={setting.label}
        value={value}
        onChange={onChange}
        options={opts}
      />
    )
  }

  if (setting.type === 'checkbox') {
    const checked = value === 'true' || value === '1'
    return (
      <label className="flex items-center gap-3 cursor-pointer group" onClick={() => onChange(checked ? 'false' : 'true')}>
        <div className={`w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ${checked ? 'bg-[#00D4FF]/30' : 'bg-white/10'}`}>
          <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${checked ? 'left-4 bg-[#00D4FF]' : 'left-0.5 bg-white/30'}`} />
        </div>
        <span className="text-[10px] font-mono text-white/30 uppercase tracking-widest group-hover:text-white/60">{setting.label}</span>
      </label>
    )
  }

  return (
    <div className="space-y-1">
      <label className={labelClass}>{setting.label}</label>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        type={setting.type === 'password' ? 'password' : 'text'}
        placeholder={setting.default !== undefined ? String(setting.default) : ''}
        className={inputClass}
      />
    </div>
  )
}
