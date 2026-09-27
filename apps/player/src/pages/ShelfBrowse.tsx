import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PlayerShelfSummary } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'

/**
 * Books, Games and Music share this one grid: a flat list of covers with no
 * playback surface behind them yet, so there is nothing here a filter, a sort
 * or a row grouping would earn its keep against. Films and Series keep the
 * full Combined view because they are what the Player actually plays.
 */
export function ShelfBrowsePage({ sdk, title, accent, load, routeFor }: {
  sdk: ArchivistSdk
  title: string
  accent: string
  load: (sdk: ArchivistSdk, signal: AbortSignal) => Promise<PlayerShelfSummary[]>
  routeFor: (item: PlayerShelfSummary) => string
}) {
  const [items, setItems] = useState<PlayerShelfSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setItems(null); setError(null)
    load(sdk, controller.signal)
      .then(setItems)
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => controller.abort()
  }, [sdk, load])

  return <div data-route-scroll className="motion-fade h-full overflow-y-auto no-scrollbar pb-20">
    <header className="mb-8">
      <h1 className="archivist-page-title" style={{ color: accent }}>{title}</h1>
      {items && <p className="archivist-section-label mt-2 text-white/30">{items.length} item{items.length === 1 ? '' : 's'}</p>}
    </header>
    {error && <p role="alert" className="mb-5 rounded-xl border border-pink/30 bg-pink/10 p-4 text-sm text-pink">{error}</p>}
    {!items && !error && <p className="py-16 text-center font-mono text-xs uppercase tracking-widest text-white/30">Loading</p>}
    {items && items.length === 0 && <div className="player-panel p-12 text-center"><p className="font-display text-2xl uppercase tracking-wide">Nothing here yet</p></div>}
    {items && items.length > 0 && <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-5">
      {items.map(item => <Link key={item.id} to={routeFor(item)}
        className="player-focusable group block overflow-hidden rounded-xl border border-white/5 bg-noir-800 text-left shadow-lg shadow-black/40 outline-none transition-all hover:border-white/20 focus-visible:border-cyan/60">
        <div className="relative aspect-[2/3] overflow-hidden bg-noir-700">
          {item.posterUrl
            ? <img src={sdk.asset(item.posterUrl)} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover opacity-80 transition duration-300 group-hover:scale-[1.02] group-hover:opacity-100" />
            : <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-noir-700 via-noir-900 to-noir-950 p-4 text-center font-display uppercase tracking-wide text-white/20" aria-hidden="true">{item.title.slice(0, 1)}</div>}
        </div>
        <div className="relative flex min-h-[70px] flex-col justify-center border-t border-white/5 bg-noir-900/40 p-3">
          <p className="truncate font-display text-[13px] uppercase tracking-wide text-white transition-colors group-hover:text-white/70">{item.title}</p>
          {item.attribution && <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-tight text-white/60">{item.attribution}</p>}
        </div>
      </Link>)}
    </div>}
  </div>
}
