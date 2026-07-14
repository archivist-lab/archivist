import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { PlayerHub, PlayerMediaCard, PlayerWidget } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { playerStore, usePlayerSelector } from '../lib/store.js'
import { WidgetRail } from './Rail.js'

export function Hub({ hub, sdk, onLoadMore }: { hub: PlayerHub; sdk: ArchivistSdk; onLoadMore?: (widget: PlayerWidget) => void }) {
  const navigate = useNavigate()
  const mediaContext = usePlayerSelector(state => state.mediaContext)
  const preferences = usePlayerSelector(state => state.preferences)?.preferences
  const timer = useRef<number | null>(null)
  const [selectedCategory, setSelectedCategory] = useState(() => hub.categories.find(category => category.active)?.id ?? hub.categories[0]?.id ?? 'all')
  const combined = hub.id === 'home' && preferences?.home.widgetMode === 'combined'
  const sources = selectedCategory === 'films'
    ? new Set(['recent-films', 'downloading', 'unwatched-films', 'films-az'])
    : selectedCategory === 'series' ? new Set(['recent-episodes', 'series-az']) : null
  const widgets = combined
    ? hub.widgets.filter(widget => widget.id === selectedCategory)
    : sources ? hub.widgets.filter(widget => sources.has(widget.source)) : hub.widgets
  const keys = new Set(widgets.flatMap(widget => widget.items.map(item => item.key)))
  const fallback = widgets.flatMap(widget => widget.items)[0] ?? null
  const context = mediaContext && keys.has(mediaContext.key) ? mediaContext : fallback
  const showSpotlight = hub.id !== 'home' || preferences?.home.showSpotlight !== false
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  useEffect(() => {
    const selected = hub.categories.find(category => category.active)?.id ?? hub.categories[0]?.id ?? 'all'
    setSelectedCategory(selected)
  }, [hub.id, hub.categories])
  useEffect(() => {
    if (fallback) playerStore.dispatch({ type: 'MEDIA_CONTEXT_CHANGED', item: fallback })
  }, [fallback?.key, selectedCategory])
  const focusItem = (item: PlayerMediaCard) => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => playerStore.dispatch({ type: 'MEDIA_CONTEXT_CHANGED', item }), 100)
  }
  const activate = (item: PlayerMediaCard) => navigate(item.route)
  return (
    <div className="relative z-10 h-full overflow-y-auto no-scrollbar px-[var(--safe-x)] pb-20 pt-[var(--safe-y)]">
      {hub.categories.length > 0 && <div className="mb-5 flex gap-2" role="tablist" aria-label="Categories">
        {hub.categories.map(category => <button key={category.id} role="tab" aria-selected={selectedCategory === category.id} onClick={() => setSelectedCategory(category.id)}
          className={`player-focusable rounded-full px-5 py-2 text-sm font-semibold ${selectedCategory === category.id ? 'bg-white text-black' : 'bg-white/8 text-white/55'}`}>{category.label}</button>)}
      </div>}
      {showSpotlight && context && <Spotlight item={context} sdk={sdk} onActivate={() => activate(context)} />}
      <div className="relative -mt-10">
        {widgets.map(widget => <WidgetRail key={widget.id} widget={widget} sdk={sdk} onItemFocused={focusItem} onActivate={activate} onLoadMore={onLoadMore} />)}
      </div>
      {!widgets.length && <div className="mx-auto mt-[25vh] max-w-xl text-center"><h2 className="text-2xl font-semibold">Your library is quiet.</h2><p className="mt-2 text-white/45">Available media will appear here automatically.</p><button onClick={() => navigate('/settings')} className="player-focusable mt-6 rounded-full bg-white px-6 py-3 font-bold text-black">Open Settings</button></div>}
    </div>
  )
}

export function Spotlight({ item, sdk, onActivate }: { item: PlayerMediaCard; sdk: ArchivistSdk; onActivate: () => void }) {
  return (
    <section className="flex min-h-[43vh] max-w-3xl flex-col justify-center pb-16 pt-4">
      {item.logoUrl ? <img src={sdk.asset(item.logoUrl)} alt={item.title} className="mb-5 max-h-28 max-w-[32rem] object-contain object-left" />
        : <h1 className="mb-3 text-5xl font-semibold leading-none tracking-tight">{item.title}</h1>}
      <div className="mb-4 flex flex-wrap gap-3 text-sm text-white/65">{item.subtitle && <span>{item.subtitle}</span>}{item.badges.slice(0, 3).map(badge => <span key={badge.label}>{badge.label}</span>)}</div>
      {item.plot && <p className="mb-6 line-clamp-4 max-w-2xl text-lg leading-relaxed text-white/65">{item.plot}</p>}
      {item.progress && <progress aria-label={`${Math.round(item.progress.percent)}% watched`} value={item.progress.percent} max={100} className="player-progress mb-5 h-1 w-full max-w-md" />}
      <button onClick={onActivate} disabled={!item.available} className="player-focusable w-fit rounded-full bg-white px-8 py-3 font-bold text-black disabled:cursor-not-allowed disabled:opacity-40">
        {item.primaryAction === 'resume' || item.primaryAction === 'resume-next' ? 'Resume' : item.available ? 'View' : 'Not available'}
      </button>
    </section>
  )
}

export function HubSkeleton() {
  return <div className="player-safe"><div className="player-skeleton mt-16 h-32 w-1/2 rounded-2xl bg-white/10" /><div className="player-skeleton mt-24 h-56 rounded-2xl bg-white/8" /></div>
}
