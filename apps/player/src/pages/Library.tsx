import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ArchivistSdk, FilmSummary, SeriesSummary, PlayerLibrary } from '../lib/sdk.js'
import { useSettings, updateSettings, useProgress, type LibraryView } from '../lib/store.js'
import { PosterCard } from '../components/Cards.js'

type Item = FilmSummary | SeriesSummary

/** Films/Series browser with Arctic Fuse-style view modes: poster / wall / list. */
export function Library({ sdk, kind }: { sdk: ArchivistSdk; kind: 'films' | 'series' }) {
  const settings = useSettings()
  const progress = useProgress()
  const [items, setItems] = useState<Item[] | null>(null)
  const [libs, setLibs] = useState<PlayerLibrary[]>([])
  const [libFilter, setLibFilter] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setItems(null)
    const req = kind === 'films' ? sdk.films(libFilter ?? undefined) : sdk.series(libFilter ?? undefined)
    req.then((d: any) => setItems(d.films ?? d.series)).catch(e => setError(String(e)))
    sdk.libraries().then(d => setLibs(d.libraries.filter(l => l.mediaType === kind))).catch(() => {})
  }, [sdk, kind, libFilter])

  const visible = useMemo(() => {
    let list = items ?? []
    if (settings.hideUnavailable) list = list.filter(i => i.status === 'available')
    return list
  }, [items, settings.hideUnavailable])

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>

  const view = settings.libraryView
  const setView = (v: LibraryView) => updateSettings({ libraryView: v })

  return (
    <div className="px-5 pb-12 animate-fade-in">
      <div className="flex items-center gap-3 py-4 flex-wrap">
        <h1 className="text-2xl font-semibold tracking-tight text-white capitalize">{kind}</h1>
        {libs.length > 1 && (
          <div className="flex gap-1.5 ml-2">
            <Chip label="All" active={libFilter === null} onClick={() => setLibFilter(null)} />
            {libs.map(l => <Chip key={l.id} label={l.name} active={libFilter === l.id} onClick={() => setLibFilter(l.id)} />)}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {(['poster', 'wall', 'list'] as LibraryView[]).map(v => (
            <Chip key={v} label={v} active={view === v} onClick={() => setView(v)} />
          ))}
        </div>
      </div>

      {!items ? (
        <div className="p-16 text-center text-white/25 text-[11px] font-mono uppercase tracking-[0.3em] animate-pulse">Loading…</div>
      ) : visible.length === 0 ? (
        <p className="p-16 text-center text-white/30 text-sm">Nothing here{settings.hideUnavailable ? ' (unavailable items are hidden in Settings)' : ''}.</p>
      ) : view === 'list' ? (
        <div className="space-y-1 max-w-3xl">
          {visible.map(i => (
            <Link key={i.id} to={i.type === 'film' ? `/film/${i.id}` : `/series/${i.id}`}
              className="flex items-center gap-4 px-4 py-2.5 rounded-xl hover:bg-white/[0.06] transition-colors outline-none focus-visible:bg-white/[0.06]">
              <span className="flex-1 text-sm text-white/85 truncate">{i.title}</span>
              {i.year && <span className="text-[11px] font-mono text-white/30">{i.year}</span>}
              <span className={`text-[10px] font-mono tracking-wide ${i.status === 'available' ? 'text-white/60' : 'text-white/20'}`}>
                {i.type === 'series' ? `${(i as SeriesSummary).availableEpisodeCount}/${(i as SeriesSummary).episodeCount}` : (i.status === 'available' ? 'Available' : '—')}
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <div className={`grid gap-x-3.5 gap-y-6 ${view === 'wall'
          ? 'grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10'
          : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8'}`}>
          {visible.map(i => (
            <div key={i.id} className="[&>a]:w-full [&_p]:text-center">
              <PosterCard sdk={sdk} item={{
                key: `${i.type}:${i.id}`,
                to: i.type === 'film' ? `/film/${i.id}` : `/series/${i.id}`,
                title: i.title,
                subtitle: view === 'wall' ? null : (i.year ? String(i.year) : null),
                posterUrl: i.posterUrl, backdropUrl: i.backdropUrl,
                watched: i.type === 'film' && progress[`film:${i.id}`]?.completed,
                badge: i.status === 'available' ? null : '·',
              }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`px-3.5 py-1 rounded-full text-[11px] font-semibold tracking-wide capitalize transition-colors ${
        active ? 'bg-white text-noir-950' : 'bg-white/[0.06] text-white/50 hover:text-white hover:bg-white/10'}`}>
      {label}
    </button>
  )
}
