import { useEffect, useState } from 'react'
import { toast } from '../../lib/notify.js'
import { sharedApi, type LibraryScanStatus, type LibraryScanCandidate, type LibraryScanMatch, type ManualImportCandidate, type ScanReviewSeriesGroup, type ScanGroupSuggestion } from '../../lib/shared.api.js'
import { filmsApi } from '../../lib/films.api.js'
import { seriesApi } from '../../lib/series.api.js'
import { Modal, SearchInput, Spinner } from '../../components/ui.js'

type AdoptChoice = { itemId?: number; tmdbId?: number; tvdbId?: number; mediaType?: string; tabId?: number }
type GroupChoice = { seriesId?: number; tmdbId?: number; tvdbId?: number }

const scanMatchKey = (c: LibraryScanMatch) => (c.kind === 'item' ? `i${c.itemId}` : `t${c.tmdbId}`)
const groupSuggestionKey = (s: ScanGroupSuggestion) => (s.kind === 'series' ? `s${s.seriesId}` : `t${s.tmdbId ?? s.tvdbId}`)

/**
 * "Import Files" — scans the library folders on disk for untracked video files
 * and adopts them into Archivist (the on-disk counterpart to Import Lists).
 * Loose films are reviewed individually; loose episodes are grouped by series
 * so the whole show can be matched in one action.
 */
export function ImportFilesTab() {
  const [status, setStatus] = useState<LibraryScanStatus | null>(null)
  const [films, setFilms] = useState<LibraryScanCandidate[]>([])
  const [series, setSeries] = useState<ScanReviewSeriesGroup[]>([])
  const [normalise, setNormalise] = useState(false)
  const [autoAdopt, setAutoAdopt] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const loadReview = () => sharedApi.system.libraryScanReview().then(r => { setFilms(r.films); setSeries(r.series) }).catch(() => {})

  useEffect(() => {
    sharedApi.system.libraryScanStatus().then(setStatus).catch(() => {})
    sharedApi.system.libraryScanSettings().then(s => setAutoAdopt(s.autoAdopt)).catch(() => {})
    loadReview()
  }, [])

  const toggleAutoAdopt = async () => {
    const next = !autoAdopt
    setAutoAdopt(next)
    try { await sharedApi.system.libraryScanSetSettings({ autoAdopt: next }) }
    catch (err) { setAutoAdopt(!next); toast.error(String(err)) }
  }

  // Poll while a scan is running, then refresh the review list.
  useEffect(() => {
    if (!status?.running) return
    const id = setInterval(async () => {
      const next = await sharedApi.system.libraryScanStatus().catch(() => null)
      if (next) { setStatus(next); if (!next.running) loadReview() }
    }, 1500)
    return () => clearInterval(id)
  }, [status?.running])

  const runScan = async () => {
    try { setStatus(await sharedApi.system.libraryScanRun({ normalise })) }
    catch (err) { toast.error(String(err)) }
  }

  const adopt = async (item: LibraryScanCandidate, choice: AdoptChoice) => {
    setBusy(`f${item.id}`)
    setFilms(prev => prev.filter(i => i.id !== item.id))
    try { await sharedApi.system.libraryScanResolve({ id: item.id, ...choice, normalise }); toast.success('Adopting into your library…') }
    catch (err) { toast.error(String(err)); loadReview() }
    finally { setBusy(null) }
  }

  const ignore = async (item: LibraryScanCandidate) => {
    setFilms(prev => prev.filter(i => i.id !== item.id))
    try { await sharedApi.system.libraryScanIgnore(item.id) } catch { loadReview() }
  }

  const adoptGroup = async (group: ScanReviewSeriesGroup, choice: GroupChoice) => {
    setBusy(group.key)
    setSeries(prev => prev.filter(g => g.key !== group.key))
    try {
      const res = await sharedApi.system.libraryScanResolveGroup({ candidateIds: group.candidateIds, ...choice, normalise })
      if (res.failed > 0) toast.info(`Adopting ${res.adopted} episode${res.adopted === 1 ? '' : 's'} · ${res.failed} couldn't be matched`)
      else toast.success(`Adopting ${res.adopted} episode${res.adopted === 1 ? '' : 's'} into ${group.title}…`)
      if (res.failed > 0) loadReview()
    } catch (err) { toast.error(String(err)); loadReview() }
    finally { setBusy(null) }
  }

  const ignoreGroup = async (group: ScanReviewSeriesGroup) => {
    setSeries(prev => prev.filter(g => g.key !== group.key))
    try { await Promise.all(group.candidateIds.map(id => sharedApi.system.libraryScanIgnore(id))) } catch { loadReview() }
  }

  const nothing = films.length === 0 && series.length === 0

  return (
    <div className="space-y-6">
      <div className="bg-noir-900/50 border border-white/5 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <p className="text-sm text-white/80 font-semibold">Import existing files</p>
          <p className="text-[11px] text-white/35 font-mono mt-1">Scans your film &amp; series library folders for untracked video files and brings them into Archivist. {autoAdopt ? 'High-confidence matches are adopted automatically; the rest wait below for review.' : 'Every match is parked below for review before anything is imported.'}</p>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-white/50" title="When on, high-confidence matches (new or existing, films or series) are adopted automatically during a scan. When off, every match waits for review.">
            <input type="checkbox" checked={autoAdopt} onChange={toggleAutoAdopt} className="accent-[#00D4FF]" />
            Auto-adopt
          </label>
          <label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-white/50" title="Re-organise adopted files into the canonical Title (Year) layout instead of linking them in place.">
            <input type="checkbox" checked={normalise} onChange={e => setNormalise(e.target.checked)} className="accent-[#00D4FF]" />
            Normalise layout
          </label>
          <button onClick={runScan} disabled={status?.running}
            className="px-5 py-2 rounded-xl bg-[#00D4FF] text-noir-950 text-[10px] font-bold uppercase tracking-widest disabled:opacity-50">
            {status?.running ? 'Scanning…' : 'Scan now'}
          </button>
        </div>
      </div>

      {status && (
        <div className="flex flex-wrap gap-4 text-[11px] font-mono text-white/40">
          <span><span className="text-white">{status.scanned}</span> scanned</span>
          <span><span className="text-emerald-400">{status.adopted}</span> adopted</span>
          <span><span className="text-[#00D4FF]">{status.pendingReview}</span> need review</span>
          <span><span className="text-white/60">{status.owned}</span> already tracked</span>
          {status.failed > 0 && <span><span className="text-red-400">{status.failed}</span> failed</span>}
        </div>
      )}

      {nothing ? (
        <div className="text-center py-16 text-white/25 text-xs font-mono uppercase tracking-widest">Nothing waiting for review</div>
      ) : (
        <div className="space-y-8">
          {series.length > 0 && (
            <div className="space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-white/30">Series · {series.length} show{series.length === 1 ? '' : 's'}</p>
              {series.map(group => (
                <ScanSeriesGroupRow key={group.key} group={group} busy={busy === group.key} onAdopt={adoptGroup} onIgnore={ignoreGroup} />
              ))}
            </div>
          )}
          {films.length > 0 && (
            <div className="space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-white/30">Films · {films.length}</p>
              {films.map(item => <ScanReviewRow key={item.id} item={item} busy={busy === `f${item.id}`} onAdopt={adopt} onIgnore={ignore} />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ScanReviewRow({ item, busy, onAdopt, onIgnore }: {
  item: LibraryScanCandidate; busy: boolean
  onAdopt: (item: LibraryScanCandidate, choice: AdoptChoice) => void
  onIgnore: (item: LibraryScanCandidate) => void
}) {
  const cands = item.candidates ?? []
  const [choiceKey, setChoiceKey] = useState(cands[0] ? scanMatchKey(cands[0]) : '')
  const [matching, setMatching] = useState(false)
  const chosen = cands.find(c => scanMatchKey(c) === choiceKey)
  const parsedLabel = item.parsed?.title
    ? `${item.parsed.title}${item.parsed.year ? ` (${item.parsed.year})` : ''}`
    : (item.source_path.split('/').pop() ?? item.source_path)

  return (
    <div className="bg-noir-900/40 border border-white/5 rounded-xl p-4 flex flex-col md:flex-row md:items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-white/80 truncate">{parsedLabel}</p>
        <p className="text-[10px] text-white/25 font-mono truncate">{item.source_path}</p>
      </div>
      <select value={choiceKey} onChange={e => setChoiceKey(e.target.value)}
        className="bg-noir-950 border border-white/10 rounded-lg px-3 py-2 text-xs text-white/80 md:min-w-[240px]">
        {cands.length === 0 && <option value="">No match found</option>}
        {cands.map(c => (
          <option key={scanMatchKey(c)} value={scanMatchKey(c)}>
            {c.kind === 'item' ? '📚 ' : '＋ '}{c.title}{c.year ? ` (${c.year})` : ''} · {Math.round(c.score * 100)}%
          </option>
        ))}
      </select>
      <div className="flex items-center gap-2 shrink-0">
        <button disabled={busy || !chosen} onClick={() => chosen && onAdopt(item, { itemId: chosen.itemId, tmdbId: chosen.tmdbId, tvdbId: chosen.tvdbId })}
          className="px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">
          {busy ? '…' : 'Adopt'}
        </button>
        <button onClick={() => setMatching(true)}
          className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white/45 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-colors">Match…</button>
        <button onClick={() => onIgnore(item)}
          className="px-3 py-2 rounded-lg text-white/30 hover:text-white/70 text-[10px] font-bold uppercase tracking-widest transition-colors">Ignore</button>
      </div>
      {matching && <ScanMatchModal item={item} onClose={() => setMatching(false)} onMatch={choice => { setMatching(false); onAdopt(item, choice) }} />}
    </div>
  )
}

function ScanSeriesGroupRow({ group, busy, onAdopt, onIgnore }: {
  group: ScanReviewSeriesGroup; busy: boolean
  onAdopt: (group: ScanReviewSeriesGroup, choice: GroupChoice) => void
  onIgnore: (group: ScanReviewSeriesGroup) => void
}) {
  const [choiceKey, setChoiceKey] = useState(group.suggestions[0] ? groupSuggestionKey(group.suggestions[0]) : '')
  const [matching, setMatching] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const chosen = group.suggestions.find(s => groupSuggestionKey(s) === choiceKey)
  const seasonLabel = group.seasons.length
    ? `${group.seasons.length} season${group.seasons.length === 1 ? '' : 's'} (${group.seasons.map(n => `S${n}`).join(', ')})`
    : 'seasons unknown'

  const submit = (choice: GroupChoice) => onAdopt(group, choice)

  return (
    <div className="bg-noir-900/40 border border-white/5 rounded-xl p-4 space-y-3">
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-white/80 truncate">📺 {group.title}{group.year ? ` (${group.year})` : ''}</span>
          </div>
          <button onClick={() => setExpanded(v => !v)} className="text-[10px] text-white/30 font-mono hover:text-white/60 transition-colors">
            {group.fileCount} file{group.fileCount === 1 ? '' : 's'} · {seasonLabel} · {expanded ? 'hide' : 'show'} files
          </button>
        </div>
        <select value={choiceKey} onChange={e => setChoiceKey(e.target.value)}
          className="bg-noir-950 border border-white/10 rounded-lg px-3 py-2 text-xs text-white/80 md:min-w-[240px]">
          {group.suggestions.length === 0 && <option value="">No match found</option>}
          {group.suggestions.map(s => (
            <option key={groupSuggestionKey(s)} value={groupSuggestionKey(s)}>
              {s.kind === 'series' ? '📺 ' : '＋ '}{s.title}{s.year ? ` (${s.year})` : ''} · {Math.round(s.score * 100)}%
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2 shrink-0">
          <button disabled={busy || !chosen} onClick={() => chosen && submit({ seriesId: chosen.seriesId, tmdbId: chosen.tmdbId, tvdbId: chosen.tvdbId })}
            className="px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">
            {busy ? '…' : `Match ${group.fileCount}`}
          </button>
          <button onClick={() => setMatching(true)}
            className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white/45 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-colors">Match…</button>
          <button onClick={() => onIgnore(group)}
            className="px-3 py-2 rounded-lg text-white/30 hover:text-white/70 text-[10px] font-bold uppercase tracking-widest transition-colors">Ignore</button>
        </div>
      </div>

      {expanded && (
        <div className="pl-1 space-y-1 border-t border-white/5 pt-2">
          {group.files.map(f => {
            const slot = f.parsed?.season != null || f.parsed?.episode != null
              ? `S${String(f.parsed?.season ?? 0).padStart(2, '0')}E${String(f.parsed?.episode ?? 0).padStart(2, '0')}`
              : '—'
            return (
              <div key={f.id} className="flex items-center gap-3 text-[10px] font-mono text-white/30">
                <span className="text-white/50 w-14 shrink-0">{slot}</span>
                <span className="truncate">{f.source_path.split('/').pop()}</span>
              </div>
            )
          })}
        </div>
      )}

      {matching && (
        <ScanSeriesGroupModal group={group}
          onClose={() => setMatching(false)}
          onMatch={choice => { setMatching(false); submit(choice) }} />
      )}
    </div>
  )
}

function ScanSeriesGroupModal({ group, onClose, onMatch }: {
  group: ScanReviewSeriesGroup
  onClose: () => void
  onMatch: (choice: GroupChoice) => void
}) {
  const [mode, setMode] = useState<'library' | 'tmdb'>('library')
  const [query, setQuery] = useState(group.title)
  const [libResults, setLibResults] = useState<ManualImportCandidate[]>([])
  const [tmdbResults, setTmdbResults] = useState<TmdbHit[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (query.trim().length < 2) { setLibResults([]); setTmdbResults([]); return }
    let alive = true
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        if (mode === 'library') {
          const data = await sharedApi.system.manualImportSearch({ mediaType: 'series', query })
          if (alive) { setTmdbResults([]); setLibResults(data.results.filter(r => r.tabId === group.library_id && r.mediaType === 'series')) }
        } else {
          const data = await seriesApi.lookup(query)
          if (alive) { setLibResults([]); setTmdbResults(data.map(s => ({ key: `s${s.tvdbId ?? s.tmdbId}`, tmdbId: s.tmdbId, tvdbId: s.tvdbId, title: s.title, year: s.year, subtitle: s.network, inLibrary: s.alreadyAdded }))) }
        }
      } catch { if (alive) { setLibResults([]); setTmdbResults([]) } }
      finally { if (alive) setSearching(false) }
    }, 400)
    return () => { alive = false; clearTimeout(timer) }
  }, [query, mode, group.library_id])

  return (
    <Modal title={`Match ${group.fileCount} file${group.fileCount === 1 ? '' : 's'} to a series`} onClose={onClose} width="max-w-2xl">
      <div className="space-y-4">
        <div className="rounded-xl bg-white/[0.02] border border-white/5 px-4 py-3">
          <p className="text-sm text-white/70 truncate">{group.title}{group.year ? ` (${group.year})` : ''}</p>
          <p className="text-[10px] text-white/25 font-mono">{group.fileCount} episode files · every match resolves by its SxxEyy</p>
        </div>

        <div className="flex gap-2">
          {(['library', 'tmdb'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all ${
                mode === m ? 'bg-[#00D4FF]/10 border-[#00D4FF]/20 text-[#00D4FF]' : 'border-white/10 text-white/40 hover:text-white'
              }`}>
              {m === 'library' ? 'In library' : 'New from TMDB'}
            </button>
          ))}
        </div>

        <SearchInput value={query} onChange={setQuery} placeholder={mode === 'tmdb' ? 'Search TMDB series…' : 'Search your series…'} autoFocus />

        <div className="max-h-[45vh] overflow-y-auto custom-scrollbar space-y-2">
          {searching ? (
            <div className="py-10 flex justify-center"><Spinner className="w-6 h-6" /></div>
          ) : mode === 'library' ? (
            libResults.length === 0 ? (
              <p className="py-10 text-center text-xs font-mono text-white/25">{query.trim().length < 2 ? 'Type to search your series' : 'No matches in this library'}</p>
            ) : libResults.map(r => (
              <button key={`${r.tabId}:${r.itemId}`} onClick={() => onMatch({ seriesId: r.itemId })}
                className="w-full text-left rounded-xl bg-white/[0.02] border border-white/5 px-4 py-3 hover:bg-[#00D4FF]/10 hover:border-[#00D4FF]/20 transition-all">
                <p className="text-sm text-white/80 truncate">{r.title}</p>
                <p className="mt-0.5 text-[10px] font-mono text-white/30 truncate">{r.tabName} · {r.subtitle ?? r.status ?? ''}</p>
              </button>
            ))
          ) : (
            tmdbResults.length === 0 ? (
              <p className="py-10 text-center text-xs font-mono text-white/25">{query.trim().length < 2 ? 'Type to search TMDB' : 'No matches'}</p>
            ) : tmdbResults.map(r => (
              <button key={r.key} onClick={() => onMatch({ tmdbId: r.tmdbId, tvdbId: r.tvdbId })}
                className="w-full text-left rounded-xl bg-white/[0.02] border border-white/5 px-4 py-3 hover:bg-emerald-500/10 hover:border-emerald-500/20 transition-all flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-white/80 truncate">{r.title}{r.year ? ` (${r.year})` : ''}</p>
                  {r.subtitle && <p className="mt-0.5 text-[10px] font-mono text-white/30 truncate">{r.subtitle}</p>}
                </div>
                {r.inLibrary && <span className="shrink-0 text-[9px] font-bold uppercase tracking-widest text-white/30">In library</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  )
}

const MATCH_LEVELS: Record<'film' | 'episode', Array<{ value: string; label: string }>> = {
  film: [{ value: 'films', label: 'Film' }],
  episode: [
    { value: 'series-episode', label: 'Episode' },
    { value: 'series-season', label: 'Season' },
    { value: 'series', label: 'Series' },
  ],
}

type TmdbHit = { key: string; tmdbId?: number; tvdbId?: number; title: string; year?: number; subtitle?: string; inLibrary?: boolean }

function ScanMatchModal({ item, onClose, onMatch }: {
  item: LibraryScanCandidate
  onClose: () => void
  onMatch: (choice: AdoptChoice) => void
}) {
  const isEpisode = item.media_type === 'episode'
  const levels = MATCH_LEVELS[isEpisode ? 'episode' : 'film']
  const [mode, setMode] = useState<'library' | 'tmdb'>('library')
  const [mediaType, setMediaType] = useState(levels[0].value)
  const [query, setQuery] = useState(item.parsed?.title ?? '')
  const [libResults, setLibResults] = useState<ManualImportCandidate[]>([])
  const [tmdbResults, setTmdbResults] = useState<TmdbHit[]>([])
  const [searching, setSearching] = useState(false)
  const sourceName = item.source_path.split('/').pop() ?? item.source_path

  const parsedSlot = isEpisode && (item.parsed?.season != null || item.parsed?.episode != null)
    ? ` · S${String(item.parsed?.season ?? 0).padStart(2, '0')}E${String(item.parsed?.episode ?? 0).padStart(2, '0')}`
    : ''

  useEffect(() => {
    if (query.trim().length < 2) { setLibResults([]); setTmdbResults([]); return }
    let alive = true
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        if (mode === 'library') {
          const data = await sharedApi.system.manualImportSearch({ mediaType, query, sourceName })
          if (alive) setTmdbResults([])
          if (alive) setLibResults(data.results)
        } else if (isEpisode) {
          const data = await seriesApi.lookup(query)
          if (alive) { setLibResults([]); setTmdbResults(data.map(s => ({ key: `s${s.tvdbId ?? s.tmdbId}`, tmdbId: s.tmdbId, tvdbId: s.tvdbId, title: s.title, year: s.year, subtitle: s.network, inLibrary: s.alreadyAdded }))) }
        } else {
          const data = await filmsApi.lookup(query)
          if (alive) { setLibResults([]); setTmdbResults(data.map(f => ({ key: `f${f.tmdbId}`, tmdbId: f.tmdbId, title: f.title, year: f.year, subtitle: f.studio, inLibrary: f.alreadyAdded }))) }
        }
      } catch { if (alive) { setLibResults([]); setTmdbResults([]) } }
      finally { if (alive) setSearching(false) }
    }, 400)
    return () => { alive = false; clearTimeout(timer) }
  }, [query, mode, mediaType, isEpisode, sourceName])

  const showLevels = mode === 'library' && levels.length > 1
  const placeholder = mode === 'tmdb'
    ? `Search TMDB ${isEpisode ? 'series' : 'films'}…`
    : `Search ${levels.find(l => l.value === mediaType)?.label.toLowerCase() ?? 'library'}…`

  return (
    <Modal title="Match manually" onClose={onClose} width="max-w-2xl">
      <div className="space-y-4">
        <div className="rounded-xl bg-white/[0.02] border border-white/5 px-4 py-3">
          <p className="text-[10px] text-white/25 font-mono truncate">{item.source_path}{parsedSlot}</p>
        </div>

        <div className="flex gap-2">
          {(['library', 'tmdb'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all ${
                mode === m ? 'bg-[#00D4FF]/10 border-[#00D4FF]/20 text-[#00D4FF]' : 'border-white/10 text-white/40 hover:text-white'
              }`}>
              {m === 'library' ? 'In library' : 'New from TMDB'}
            </button>
          ))}
        </div>

        {showLevels && (
          <div className="flex gap-2">
            {levels.map(level => (
              <button key={level.value} onClick={() => setMediaType(level.value)}
                className={`px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all ${
                  mediaType === level.value ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'border-white/10 text-white/40 hover:text-white'
                }`}>
                {level.label}
              </button>
            ))}
          </div>
        )}

        {mode === 'tmdb' && isEpisode && (
          <p className="text-[10px] text-white/30 font-mono">Adds the whole series if missing, then files this episode into{parsedSlot ? parsedSlot.replace(' · ', ' ') : ' its matching episode'}.</p>
        )}

        <SearchInput value={query} onChange={setQuery} placeholder={placeholder} autoFocus />

        <div className="max-h-[45vh] overflow-y-auto custom-scrollbar space-y-2">
          {searching ? (
            <div className="py-10 flex justify-center"><Spinner className="w-6 h-6" /></div>
          ) : mode === 'library' ? (
            libResults.length === 0 ? (
              <p className="py-10 text-center text-xs font-mono text-white/25">{query.trim().length < 2 ? 'Type to search your library' : 'No matches'}</p>
            ) : libResults.map(r => (
              <button key={`${r.tabId}:${r.mediaType}:${r.itemId}`}
                onClick={() => onMatch({ tabId: r.tabId, mediaType: r.mediaType, itemId: r.itemId })}
                className="w-full text-left rounded-xl bg-white/[0.02] border border-white/5 px-4 py-3 hover:bg-[#00D4FF]/10 hover:border-[#00D4FF]/20 transition-all">
                <p className="text-sm text-white/80 truncate">{r.title}</p>
                <p className="mt-0.5 text-[10px] font-mono text-white/30 truncate">{r.tabName} · {r.mediaType} · {r.subtitle ?? r.status ?? ''}</p>
              </button>
            ))
          ) : (
            tmdbResults.length === 0 ? (
              <p className="py-10 text-center text-xs font-mono text-white/25">{query.trim().length < 2 ? 'Type to search TMDB' : 'No matches'}</p>
            ) : tmdbResults.map(r => (
              <button key={r.key}
                onClick={() => onMatch({ tmdbId: r.tmdbId, tvdbId: r.tvdbId })}
                className="w-full text-left rounded-xl bg-white/[0.02] border border-white/5 px-4 py-3 hover:bg-emerald-500/10 hover:border-emerald-500/20 transition-all flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-white/80 truncate">{r.title}{r.year ? ` (${r.year})` : ''}</p>
                  {r.subtitle && <p className="mt-0.5 text-[10px] font-mono text-white/30 truncate">{r.subtitle}</p>}
                </div>
                {r.inLibrary && <span className="shrink-0 text-[9px] font-bold uppercase tracking-widest text-white/30">In library</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  )
}
