import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { confirmDialog, toast } from '../../lib/notify.js'
import { sharedApi, type EpisodeNumbering, type FolderListing, type ImportPlan, type ManualImportCandidate, type ManualImportItem, type ProviderTitle } from '../../lib/shared.api.js'
import { useTabs } from '../../lib/tab-context.js'
import { formatSize } from '../../lib/api.js'
import { Field, Input, Modal, Select, Spinner } from '../../components/ui.js'
import { PageHeader } from '../../components/PageHeader.js'
import { EpisodeNumberingPicker } from '../../components/EpisodeNumberingPicker.js'
import { TorrentsPage, TORRENT_STATUS_FILTERS, type TorrentStatusFilter } from '../torrents/TorrentsPage.js'
import { formatDateTime } from '../../lib/datetime.js'
import { useLiveRefresh } from '../../lib/useLiveRefresh.js'

// Downloads owns the section root — "/acquisitions/downloads" would only repeat
// the parent — and its status filters live one level down.
const ACQUISITION_TABS = [
  { id: 'downloads', label: 'Downloads', to: '/acquisitions' },
  { id: 'imports', label: 'Imports', to: '/acquisitions/imports' },
]

export function AcquisitionsPage() {
  const location = useLocation()
  const segment = location.pathname.replace(/^\/acquisitions\/?/, '').split('/')[0]
  const isImports = segment === 'imports'
  const statusFilter = TORRENT_STATUS_FILTERS.some(entry => entry.id === segment)
    ? segment as TorrentStatusFilter
    : 'all'

  return (
    <div className="space-y-6">
      <PageHeader
        title="Acquisitions"
        subtitle="Review downloads, import from any folder, and torrent state"
        tabs={ACQUISITION_TABS}
      />
      {isImports ? <ManualImportReview /> : <TorrentsPage hideHeader statusFilter={statusFilter} />}
    </div>
  )
}

const FOLDER_KEY = 'archivist.imports.folder'
const RECENT_KEY = 'archivist.imports.recent'
const COPY_KEY = 'archivist.imports.copy'

function stored<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw) as T } catch { return fallback }
}
function store(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private window: not remembered */ }
}

type MatchTargetType = 'films' | 'series-show' | 'series-season' | 'series-episode' | 'music-discography' | 'music-album' | 'games' | 'comics-volume' | 'comics-issue'

const MATCH_TYPES: Array<{ value: MatchTargetType; label: string; base: string }> = [
  { value: 'films', label: 'Film', base: 'films' },
  { value: 'series-show', label: 'Entire Series', base: 'series' },
  { value: 'series-season', label: 'Series Season', base: 'series' },
  { value: 'series-episode', label: 'Series Episode', base: 'series' },
  { value: 'music-discography', label: 'Music Discography', base: 'music' },
  { value: 'music-album', label: 'Music Album', base: 'music' },
  { value: 'games', label: 'Game', base: 'games' },
  { value: 'comics-volume', label: 'Comic Volume', base: 'comics' },
  { value: 'comics-issue', label: 'Comic Issue', base: 'comics' },
]
/** The types a title from outside the library can be added as. */
const PROVIDER_TYPES = new Set<MatchTargetType>(['films', 'series-show', 'games'])

/**
 * Imports: any folder on the server, entry by entry. Each entry is matched to
 * a library item — or to a film, series or game not in the library yet, which
 * is added — its import is previewed, and it is copied or moved into the
 * library and renamed. The downloads folder is where it starts.
 */
function ManualImportReview() {
  const [folder, setFolder] = useState<string>(() => stored(FOLDER_KEY, ''))
  const [folderInput, setFolderInput] = useState(folder)
  const [recent, setRecent] = useState<string[]>(() => stored(RECENT_KEY, []))
  const [copy, setCopy] = useState<boolean>(() => stored(COPY_KEY, true))
  const [scannedDir, setScannedDir] = useState('')
  const [items, setItems] = useState<ManualImportItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ManualImportItem | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [queued, setQueued] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await sharedApi.system.manualImportCandidates(false, folder || undefined)
      setScannedDir(data.downloadDir)
      setItems(data.items)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [folder])

  // Staged files appear when a download finishes, so this list is stale the
  // moment a torrent completes while you are looking at it.
  useLiveRefresh(load, {
    idleMs: 60_000,
    events: ['torrent:complete', 'download:added'],
    // A new folder is a new list: scanned at once, not at the next tick.
    refreshKey: folder,
  })

  const chooseFolder = (path: string) => {
    const next = path.trim()
    setFolder(next)
    setFolderInput(next)
    store(FOLDER_KEY, next)
    if (next) {
      const list = [next, ...recent.filter(entry => entry !== next)].slice(0, 6)
      setRecent(list)
      store(RECENT_KEY, list)
    }
    setQueued(new Set())
  }

  const setCopyMode = (value: boolean) => { setCopy(value); store(COPY_KEY, value) }

  const importTo = async (item: ManualImportItem, target: { candidate?: ManualImportCandidate; provider?: ProviderTitle; tabId: number }, releaseTitle?: string, force = false, episodeNumbering: EpisodeNumbering | null = null) => {
    const result = await sharedApi.system.folderImport({
      tabId: target.tabId,
      mediaType: target.candidate?.mediaType ?? target.provider?.mediaType,
      itemId: target.candidate?.itemId,
      provider: target.provider,
      sourcePath: item.sourcePath,
      copy,
      force,
      releaseTitle: releaseTitle || item.name,
      episodeNumbering,
    })
    if (result.success) setQueued(prev => new Set([...prev, item.sourcePath]))
    return result
  }

  const confident = items.filter(item => !queued.has(item.sourcePath) && (item.candidates[0]?.score ?? 0) >= 90)
  const importConfident = async () => {
    if (!await confirmDialog(`${copy ? 'Copy' : 'Move'} ${confident.length} item(s) into their matched libraries?`)) return
    setBulk(true)
    let done = 0
    for (const item of confident) {
      const best = item.candidates[0]
      try { await importTo(item, { candidate: best, tabId: best.tabId }); done++ } catch (err) {
        toast.error(`${item.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    setBulk(false)
    toast.success(`${done} import(s) queued`)
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-noir-900 border border-white/5 px-5 py-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-end gap-3">
          <label className="flex-1 min-w-0 space-y-1">
            <span className="text-[9px] font-mono text-white/25 uppercase tracking-widest">Import From</span>
            <Input value={folderInput} onChange={e => setFolderInput(e.target.value)} placeholder={scannedDir || 'The downloads folder'}
              onKeyDown={e => { if (e.key === 'Enter') chooseFolder(folderInput) }} />
          </label>
          <div className="flex gap-2">
            <button onClick={() => setBrowsing(true)}
              className="px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-all">
              Browse
            </button>
            <button onClick={() => folderInput !== folder ? chooseFolder(folderInput) : load().catch(console.error)} disabled={loading}
              className="px-4 py-2.5 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/25 text-[#00D4FF] text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40">
              {loading ? 'Scanning' : folderInput !== folder ? 'Scan' : 'Rescan'}
            </button>
            {folder && (
              <button onClick={() => chooseFolder('')} title="Back to the downloads folder"
                className="px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-all">
                Downloads
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            {recent.filter(entry => entry !== folder).map(entry => (
              <button key={entry} onClick={() => chooseFolder(entry)} title={entry}
                className="max-w-[18rem] truncate px-2.5 py-1 rounded-md bg-white/[0.03] border border-white/5 text-[10px] font-mono text-white/40 hover:text-white/80">
                {entry}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex gap-1 bg-noir-950 p-1 rounded-lg border border-white/5" title="Copy leaves the files where they are; move takes them into the library">
              {[true, false].map(value => (
                <button key={String(value)} onClick={() => setCopyMode(value)}
                  className={`px-3 py-1 rounded-md text-[9px] font-bold uppercase tracking-widest transition-all ${copy === value ? 'bg-[#00D4FF] text-noir-950' : 'text-white/35 hover:text-white/70'}`}>
                  {value ? 'Copy' : 'Move'}
                </button>
              ))}
            </div>
            {confident.length > 0 && (
              <button onClick={() => importConfident().catch(err => toast.error(String(err)))} disabled={bulk}
                className="px-3 py-1.5 rounded-lg bg-emerald-400/10 border border-emerald-400/25 text-emerald-400 text-[9px] font-bold uppercase tracking-widest disabled:opacity-40">
                {bulk ? 'Queuing' : `Import ${confident.length} confident match${confident.length === 1 ? '' : 'es'}`}
              </button>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="py-24 flex justify-center"><Spinner className="w-12 h-12" /></div>
      ) : items.length === 0 ? (
        <div className="py-24 text-center rounded-2xl bg-noir-900/50 border border-white/5">
          <p className="text-sm text-white/35 font-mono">{folder ? `Nothing to import in ${scannedDir}` : 'No staged downloads found'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {items.map(item => {
            const best = item.candidates[0]
            return (
              <div key={item.sourcePath} className="rounded-2xl bg-noir-900 border border-white/5 p-4 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm text-white/80 font-medium truncate">{item.name}</p>
                    <p className="mt-1 text-[10px] font-mono text-white/25">
                      {item.size ? formatSize(item.size) : 'folder'} · {formatDateTime(item.modifiedAt)}
                    </p>
                  </div>
                  {queued.has(item.sourcePath) && <span className="text-[9px] font-bold uppercase tracking-widest text-emerald-400">Queued</span>}
                </div>

                {best ? (
                  <div className="rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/20 px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs text-[#00D4FF] font-bold uppercase tracking-widest truncate">{best.title}</p>
                        <p className="mt-1 text-[10px] font-mono text-white/35 truncate">{best.tabName} · {best.mediaType} · {best.subtitle ?? best.status ?? ''}</p>
                      </div>
                      <span className="text-[10px] font-mono text-[#00D4FF]">{best.score}%</span>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl bg-white/[0.02] border border-white/5 px-4 py-3 text-xs text-white/30 font-mono">Not in a library yet — match it to add it</div>
                )}

                <button onClick={() => setSelected(item)}
                  className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-all">
                  Match &amp; Import
                </button>
              </div>
            )
          })}
        </div>
      )}

      {selected && (
        <ImportMatchModal item={selected} copy={copy} onClose={() => setSelected(null)}
          onImport={async (target, releaseTitle, force, episodeNumbering) => {
            const result = await importTo(selected, target, releaseTitle, force, episodeNumbering)
            toast.success(`${copy ? 'Copy' : 'Move'} queued`)
            setSelected(null)
            return result
          }} />
      )}
      {browsing && <FolderBrowser start={folderInput || scannedDir} onClose={() => setBrowsing(false)} onChoose={path => { setBrowsing(false); chooseFolder(path) }} />}
    </div>
  )
}

/** Browse the server's folders and pick the one to import from. */
function FolderBrowser({ start, onClose, onChoose }: { start: string; onClose: () => void; onChoose: (path: string) => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const open = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      setListing(await sharedApi.system.browseFolders(path))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { open(start || undefined).catch(() => {}) }, [open, start])

  const folders = listing?.entries.filter(entry => entry.isDir) ?? []
  const files = listing?.entries.filter(entry => !entry.isDir) ?? []

  return (
    <Modal title="Choose a folder" onClose={onClose} width="max-w-3xl">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {listing?.roots.map(root => (
            <button key={root.path} onClick={() => open(root.path)}
              className="px-2.5 py-1 rounded-md bg-white/[0.04] border border-white/10 text-[10px] font-bold uppercase tracking-widest text-white/50 hover:text-white">
              {root.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 rounded-xl bg-white/[0.02] border border-white/5 px-3 py-2">
          <button onClick={() => listing?.parent && open(listing.parent)} disabled={!listing?.parent || loading}
            className="px-2 py-1 rounded-md text-white/50 hover:text-white disabled:opacity-20 font-mono text-xs">↑</button>
          <p className="flex-1 min-w-0 truncate text-xs font-mono text-white/60">{listing?.path ?? start}</p>
        </div>
        {error && <p className="text-xs text-red-300 font-mono">{error}</p>}
        <div className="max-h-[50vh] overflow-auto rounded-xl border border-white/5">
          {loading && !listing ? (
            <div className="py-12 flex justify-center"><Spinner className="w-8 h-8" /></div>
          ) : (
            <>
              {folders.map(entry => (
                <button key={entry.path} onClick={() => open(entry.path)}
                  className="w-full flex items-center gap-3 px-4 py-2 border-b border-white/5 text-left text-sm text-white/70 hover:bg-white/[0.03]">
                  <span className="text-white/30">📁</span><span className="truncate">{entry.name}</span>
                </button>
              ))}
              {files.slice(0, 50).map(entry => (
                <div key={entry.path} className="flex items-center gap-3 px-4 py-1.5 border-b border-white/5 text-xs text-white/30">
                  <span>·</span><span className="flex-1 truncate">{entry.name}</span><span className="font-mono">{entry.size ? formatSize(entry.size) : ''}</span>
                </div>
              ))}
              {files.length > 50 && <p className="px-4 py-2 text-[10px] font-mono text-white/25">and {files.length - 50} more files</p>}
              {!folders.length && !files.length && <p className="px-4 py-8 text-center text-xs font-mono text-white/25">Empty folder</p>}
            </>
          )}
        </div>
        <button onClick={() => listing && onChoose(listing.path)} disabled={!listing}
          className="w-full px-4 py-3 rounded-xl bg-[#00D4FF] text-noir-950 text-[10px] font-bold uppercase tracking-widest hover:bg-[#00D4FF]/80 transition-all disabled:opacity-40">
          Import from this folder
        </button>
      </div>
    </Modal>
  )
}

/**
 * One entry's match, as a download's Acquisition Match works: pick the type,
 * search the libraries — or, for a film, series or game you do not have yet,
 * its provider — preview the import, then import it.
 */
function ImportMatchModal({ item, copy, onClose, onImport }: {
  item: ManualImportItem
  copy: boolean
  onClose: () => void
  onImport: (target: { candidate?: ManualImportCandidate; provider?: ProviderTitle; tabId: number }, releaseTitle: string, force: boolean, episodeNumbering: EpisodeNumbering | null) => Promise<unknown>
}) {
  const { tabs } = useTabs()
  const first = item.candidates[0]
  const [mediaType, setMediaType] = useState<MatchTargetType>((first?.mediaType === 'series' ? 'series-show' : first?.mediaType ?? 'films') as MatchTargetType)
  const [search, setSearch] = useState(first?.title ?? cleanName(item.name))
  const [results, setResults] = useState<ManualImportCandidate[]>([])
  const [providerResults, setProviderResults] = useState<ProviderTitle[]>([])
  const [searching, setSearching] = useState(false)
  const [chosen, setChosen] = useState<{ candidate?: ManualImportCandidate; provider?: ProviderTitle } | null>(first ? { candidate: first } : null)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [force, setForce] = useState(false)
  const [numbering, setNumbering] = useState<EpisodeNumbering | null>(null)
  const [releaseTitle, setReleaseTitle] = useState(item.name)
  const [saving, setSaving] = useState(false)

  const base = MATCH_TYPES.find(type => type.value === mediaType)?.base ?? 'films'
  const libraries = tabs.filter(tab => tab.media_type === base)
  const [libraryId, setLibraryId] = useState<number | null>(null)
  const targetLibrary = libraryId ?? libraries[0]?.id ?? null

  useEffect(() => {
    let cancelled = false
    if (search.trim().length < 2) { setResults([]); setProviderResults([]); return }
    setSearching(true)
    const timer = setTimeout(() => {
      Promise.all([
        sharedApi.system.manualImportSearch({ mediaType, query: search, sourceName: item.name }).catch(() => ({ results: [] as ManualImportCandidate[] })),
        PROVIDER_TYPES.has(mediaType) ? sharedApi.system.importProviderSearch(mediaType, search).catch(() => ({ results: [] as ProviderTitle[] })) : Promise.resolve({ results: [] as ProviderTitle[] }),
      ]).then(([library, providers]) => {
        if (cancelled) return
        setResults(library.results)
        setProviderResults(providers.results)
      }).finally(() => { if (!cancelled) setSearching(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [mediaType, search, item.name])

  // The preview is for a library match; a title still to be added is planned when it is added.
  useEffect(() => {
    let cancelled = false
    const candidate = chosen?.candidate
    if (!candidate) { setPlan(null); return }
    setPlanLoading(true)
    sharedApi.system.folderImportPlan({ tabId: candidate.tabId, mediaType: candidate.mediaType, itemId: candidate.itemId, sourcePath: item.sourcePath, force, episodeNumbering: numbering })
      .then(data => { if (!cancelled) setPlan(data.plan) })
      .catch(() => { if (!cancelled) setPlan(null) })
      .finally(() => { if (!cancelled) setPlanLoading(false) })
    return () => { cancelled = true }
  }, [chosen, item.sourcePath, force, numbering])

  const submit = async () => {
    if (!chosen) return
    const tabId = chosen.candidate?.tabId ?? targetLibrary
    if (!tabId) { toast.error(`There is no ${base} library to add this to`); return }
    setSaving(true)
    try {
      await onImport({ ...chosen, tabId }, releaseTitle, force, base === 'series' ? numbering : null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const libraryCandidates = search.trim().length >= 2 ? results : item.candidates
  const isChosen = (c: ManualImportCandidate) => chosen?.candidate && candidateKey(chosen.candidate) === candidateKey(c)
  const providerKey = (p: ProviderTitle) => `${p.provider}:${p.tmdbId ?? p.tvdbId ?? p.launchboxId}`

  return (
    <Modal title="Match & Import" onClose={onClose} width="max-w-4xl">
      <div className="space-y-5">
        <div className="rounded-xl bg-white/[0.02] border border-white/5 px-4 py-3">
          <p className="text-xs text-white/75 truncate">{item.name}</p>
          <p className="mt-1 text-[10px] font-mono text-white/25 truncate">{item.sourcePath}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
          <Field label="Item Type">
            <Select value={mediaType} onChange={e => { setMediaType(e.target.value as MatchTargetType); setChosen(null); setLibraryId(null) }}>
              {MATCH_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
            </Select>
          </Field>
          <Field label="Search">
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={`Search ${mediaType}`} />
          </Field>
        </div>

        <div className="rounded-xl border border-white/5 overflow-hidden">
          <div className="grid grid-cols-[1fr_170px_70px] gap-3 px-3 py-2 bg-white/[0.02] text-[9px] font-mono text-white/20 uppercase tracking-widest">
            <span>In your libraries</span><span>Library</span><span>Score</span>
          </div>
          {searching && !libraryCandidates.length ? (
            <div className="px-3 py-6 text-center text-[11px] font-mono text-white/20">Searching</div>
          ) : libraryCandidates.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] font-mono text-white/20">No library matches</div>
          ) : libraryCandidates.slice(0, 12).map(c => (
            <button key={candidateKey(c)} onClick={() => setChosen({ candidate: c })}
              className={`w-full grid grid-cols-[1fr_170px_70px] gap-3 px-3 py-2 border-t border-white/5 text-[11px] items-center text-left transition-colors ${isChosen(c) ? 'bg-[#00D4FF]/10' : 'hover:bg-white/[0.02]'}`}>
              <span className="text-white/70 truncate">{c.title}<span className="text-white/25">{c.subtitle ? ` · ${c.subtitle}` : ''}</span></span>
              <span className="font-mono text-white/35 truncate">{c.tabName}</span>
              <span className={isChosen(c) ? 'font-mono text-[#00D4FF]' : 'font-mono text-white/40'}>{c.score}%</span>
            </button>
          ))}
        </div>

        {PROVIDER_TYPES.has(mediaType) && (
          <div className="rounded-xl border border-white/5 overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-white/[0.02]">
              <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Not in a library yet — added, then imported</span>
              {libraries.length > 1 && (
                <select value={targetLibrary ?? ''} onChange={e => setLibraryId(Number(e.target.value))}
                  className="bg-noir-950 border border-white/10 rounded-md px-2 py-1 text-[10px] text-white/60">
                  {libraries.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}
                </select>
              )}
            </div>
            {providerResults.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] font-mono text-white/20">{searching ? 'Searching' : 'Nothing found'}</div>
            ) : providerResults.slice(0, 10).map(p => {
              const active = chosen?.provider && providerKey(chosen.provider) === providerKey(p)
              return (
                <button key={providerKey(p)} onClick={() => setChosen({ provider: p })}
                  className={`w-full flex items-center gap-3 px-3 py-2 border-t border-white/5 text-[11px] text-left transition-colors ${active ? 'bg-emerald-400/10' : 'hover:bg-white/[0.02]'}`}>
                  <span className="flex-1 min-w-0 truncate text-white/70">{p.title}{p.year ? ` (${p.year})` : ''}<span className="text-white/25">{p.subtitle ? ` · ${p.subtitle}` : ''}</span></span>
                  <span className="font-mono text-[9px] uppercase text-white/30">{p.provider}</span>
                  <span className={`font-mono text-[9px] uppercase ${active ? 'text-emerald-400' : 'text-white/25'}`}>+ Add</span>
                </button>
              )
            })}
          </div>
        )}

        {base === 'series' && <EpisodeNumberingPicker value={numbering} onChange={setNumbering} />}

        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/5">
            <div>
              <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Import Plan</p>
              <p className="mt-1 text-[11px] font-mono text-white/30">
                {chosen?.provider ? `${chosen.provider.title} is added to the library, then planned and imported`
                  : planLoading ? 'Planning' : plan?.summary ?? 'Choose a match'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-widest text-white/30" title="Replace episodes or files already in the library">
                <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} /> Replace existing
              </label>
              {plan && !chosen?.provider && (
                <span className={`text-[10px] font-mono uppercase ${plan.status === 'ready' ? 'text-emerald-400' : plan.status === 'needs-review' ? 'text-yellow-400' : 'text-red-400'}`}>
                  {plan.status.replace('-', ' ')}
                </span>
              )}
            </div>
          </div>
          {plan && !chosen?.provider && (
            <div className="max-h-64 overflow-auto">
              {plan.errors.map(error => <div key={error} className="px-4 py-2 border-b border-white/5 text-[11px] text-red-300">{error}</div>)}
              {plan.warnings.map(warning => <div key={warning} className="px-4 py-2 border-b border-white/5 text-[11px] text-yellow-300">{warning}</div>)}
              {plan.files.map(file => (
                <div key={file.path} className="grid grid-cols-[80px_1fr_1fr] gap-3 px-4 py-2 border-b border-white/5 text-[10px] items-center">
                  <span className="font-mono text-emerald-400/70 uppercase">{file.role}</span>
                  <span className="text-white/55 truncate" title={file.name}>{file.name}</span>
                  <span className="font-mono text-white/40 truncate" title={file.target ?? ''}>→ {file.target ?? formatSize(file.sizeBytes)}</span>
                </div>
              ))}
              {plan.ignored.map(file => (
                <div key={file.path} className="grid grid-cols-[80px_1fr_1fr] gap-3 px-4 py-2 border-b border-white/5 text-[10px] items-center opacity-60">
                  <span className="font-mono text-white/20 uppercase">{file.role}</span>
                  <span className="text-white/35 truncate">{file.name}</span>
                  <span className="font-mono text-white/20 truncate">{file.reason ?? 'not mapped'}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <Field label="Release Title (used to read quality and edition)">
          <Input value={releaseTitle} onChange={e => setReleaseTitle(e.target.value)} />
        </Field>

        <button onClick={submit} disabled={!chosen || saving || (plan?.status === 'blocked' && !chosen?.provider)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#00D4FF] text-noir-950 text-[10px] font-bold uppercase tracking-widest hover:bg-[#00D4FF]/80 transition-all disabled:opacity-40">
          {saving ? <Spinner className="w-4 h-4" /> : null}
          {chosen?.provider ? `Add ${chosen.provider.title} and ${copy ? 'copy' : 'move'} in` : `${copy ? 'Copy' : 'Move'} into the library`}
        </button>
      </div>
    </Modal>
  )
}

/** A folder or file name as a search: no extension, dots and underscores as spaces, release tags dropped. */
function cleanName(name: string) {
  return name
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\b(19|20)\d{2}\b.*$/, '')
    .replace(/\b(2160p|1080p|720p|480p|bluray|web[- ]?dl|webrip|hdtv|x26[45]|hevc|s\d{1,2}(e\d{1,3})?)\b.*$/i, '')
    .replace(/[([].*$/, '')
    .trim() || name
}

function candidateKey(c: ManualImportCandidate) {
  return `${c.tabId}:${c.mediaType}:${c.itemId}`
}
