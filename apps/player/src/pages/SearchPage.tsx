import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { EpisodeSummary, FilmSummary, PlayerMediaCard, PlayerWidget, SeriesSummary } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { PosterCard } from '../components/Cards.js'
import { WidgetRail } from '../components/Rail.js'
import { useFocusable } from '../focus/FocusProvider.js'
import { playerStore } from '../lib/store.js'

export function SearchPage({ sdk, v2 = false }: { sdk: ArchivistSdk; v2?: boolean }) {
  return v2 ? <LivingRoomSearch sdk={sdk} /> : <LegacySearch sdk={sdk} />
}

function resultCard(item: FilmSummary | SeriesSummary | EpisodeSummary): PlayerMediaCard {
  const episode = item.type === 'episode' ? item : null
  return {
    key: `${item.type}:${item.id}`,
    mediaType: item.type,
    id: item.id,
    route: item.type === 'film' ? `/film/${item.id}` : item.type === 'series' ? `/series/${item.id}` : `/series/${item.seriesId}`,
    title: episode?.seriesTitle ?? item.title ?? 'Episode',
    subtitle: item.type === 'episode' ? `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')} · ${item.title ?? 'Episode'}` : item.year ? String(item.year) : null,
    plot: item.overview,
    year: item.type === 'episode' ? null : item.year,
    posterUrl: item.type === 'episode' ? item.seriesPosterUrl ?? null : item.posterUrl,
    landscapeUrl: item.type === 'episode' ? item.stillUrl : item.backdropUrl,
    backdropUrl: item.type === 'episode' ? item.stillUrl : item.backdropUrl,
    logoUrl: item.type === 'episode' ? null : item.logoUrl,
    progress: item.progress ?? null,
    badges: [],
    available: item.status === 'available',
    primaryAction: item.primaryAction ?? (item.status === 'available' ? 'play' : 'unavailable'),
  }
}

function LivingRoomSearch({ sdk }: { sdk: ArchivistSdk }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<{ films: FilmSummary[]; series: SeriesSummary[]; episodes: EpisodeSummary[] }>({ films: [], series: [], episodes: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const normalized = query.normalize('NFC').trim().slice(0, 120)
    if ([...normalized].length < 2) { setGroups({ films: [], series: [], episodes: [] }); setLoading(false); return }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true); setError(null)
      sdk.search(normalized, controller.signal).then(result => setGroups(result.groups)).catch(reason => { if (!controller.signal.aborted) setError(String(reason)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [sdk, query])
  const widgets = useMemo<PlayerWidget[]>(() => {
    const candidates: PlayerWidget[] = [
      { id: 'search-films', title: 'Films', source: 'films-az', view: 'poster', items: groups.films.map(resultCard), nextCursor: null, total: groups.films.length },
      { id: 'search-series', title: 'Series', source: 'series-az', view: 'poster', items: groups.series.map(resultCard), nextCursor: null, total: groups.series.length },
      { id: 'search-episodes', title: 'Episodes', source: 'recent-episodes', view: 'landscape', items: groups.episodes.map(resultCard), nextCursor: null, total: groups.episodes.length },
    ]
    return candidates.filter(widget => widget.items.length)
  }, [groups])
  const keys = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'Space', '⌫', 'Clear', 'Done']
  const activate = (item: PlayerMediaCard) => navigate(item.route)
  return <div className="h-full overflow-y-auto no-scrollbar player-safe">
    <h1 className="text-4xl font-semibold">Search</h1>
    <input autoFocus value={query} onChange={event => setQuery(event.target.value)} maxLength={120} placeholder="Search films, series and episodes"
      className="player-focusable mt-6 w-full max-w-3xl rounded-2xl border border-white/15 bg-black/35 px-6 py-4 text-xl text-white outline-none focus:border-white" />
    <div className="mt-4 grid max-w-3xl grid-cols-10 gap-2" aria-label="On-screen keyboard">
      {keys.map(key => <KeyboardKey key={key} label={key} onPress={() => {
        if (key === 'Space') setQuery(value => value + ' ')
        else if (key === '⌫') setQuery(value => [...value].slice(0, -1).join(''))
        else if (key === 'Clear') setQuery('')
        else if (key !== 'Done') setQuery(value => (value + key).slice(0, 120))
      }} />)}
    </div>
    {loading && <p className="mt-10 text-sm uppercase tracking-[.25em] text-white/35 player-skeleton">Searching</p>}
    {error && <p className="mt-10 text-red-300">{error}</p>}
    {!loading && query.trim().length >= 2 && !widgets.length && !error && <p className="mt-10 text-white/45">No matches for “{query.trim()}”</p>}
    <div className="mt-12">{widgets.map(widget => <WidgetRail key={widget.id} widget={widget} sdk={sdk}
      onItemFocused={item => playerStore.dispatch({ type: 'MEDIA_CONTEXT_CHANGED', item })} onActivate={activate} />)}</div>
  </div>
}

function KeyboardKey({ label, onPress }: { label: string; onPress: () => void }) {
  const focusable = useFocusable({ id: `search-key-${label}`, zoneId: 'search-keyboard', onActivate: onPress })
  return <button {...focusable} className="player-focusable min-h-11 rounded-lg bg-white/8 px-2 text-sm text-white/70 focus:bg-white focus:text-black">{label}</button>
}

function LegacySearch({ sdk }: { sdk: ArchivistSdk }) {
  const [params] = useSearchParams()
  const q = params.get('q') ?? ''
  const [results, setResults] = useState<Array<FilmSummary | SeriesSummary> | null>(null)

  useEffect(() => {
    if (!q) { setResults([]); return }
    setResults(null)
    sdk.search(q).then(d => setResults(d.results)).catch(() => setResults([]))
  }, [sdk, q])

  return (
    <div className="px-5 pb-12 animate-fade-in">
      <h1 className="text-2xl font-semibold tracking-tight text-white py-4">
        Search {q && <span className="text-white/35 font-normal">“{q}”</span>}
      </h1>
      {!results ? (
        <div className="p-16 text-center text-white/25 text-[11px] font-mono uppercase tracking-[0.3em] animate-pulse">Searching…</div>
      ) : results.length === 0 ? (
        <p className="p-16 text-center text-white/30 text-sm">No matches in your library.</p>
      ) : (
        <div className="grid gap-x-3 gap-y-6 grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {results.map(r => (
            <div key={`${r.type}:${r.id}`} className="[&>a]:w-full">
              <PosterCard sdk={sdk} item={{
                key: `${r.type}:${r.id}`,
                to: r.type === 'film' ? `/film/${r.id}` : `/series/${r.id}`,
                title: r.title,
                subtitle: `${r.type === 'film' ? 'Film' : 'Series'}${r.year ? ` · ${r.year}` : ''}`,
                posterUrl: r.posterUrl, backdropUrl: r.backdropUrl,
              }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
