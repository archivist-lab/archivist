import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ArchivistSdk } from '../lib/sdk.js'
import type { CardItem } from './Cards.js'
import { PosterCard, LandscapeCard } from './Cards.js'
import type { RailStyle } from '../lib/store.js'
import type { PlayerMediaCard, PlayerWidget } from '@archivist/contracts'
import { MediaCard } from './Cards.js'

export function Rail({ title, style, items, sdk }: { title: string; style: RailStyle; items: CardItem[]; sdk: ArchivistSdk }) {
  if (items.length === 0) return null
  if (style === 'hero') return <HeroRail items={items} sdk={sdk} />
  return (
    <section className="mb-9">
      <h2 className="section-head px-5 sm:px-8 mb-3">{title}</h2>
      <div className="flex gap-3.5 px-5 sm:px-8 overflow-x-auto no-scrollbar pb-1">
        {items.map(it => style === 'poster'
          ? <PosterCard key={it.key} item={it} sdk={sdk} />
          : <LandscapeCard key={it.key} item={it} sdk={sdk} />)}
      </div>
    </section>
  )
}

export function WidgetRail({ widget, sdk, onItemFocused, onActivate, onLoadMore }: {
  widget: PlayerWidget
  sdk: ArchivistSdk
  onItemFocused: (item: PlayerMediaCard) => void
  onActivate: (item: PlayerMediaCard) => void
  onLoadMore?: (widget: PlayerWidget) => void
}) {
  const [focused, setFocused] = useState<PlayerMediaCard | null>(widget.items[0] ?? null)
  useEffect(() => {
    setFocused(current => widget.items.find(item => item.key === current?.key) ?? widget.items[0] ?? null)
  }, [widget.items])
  if (!widget.items.length || !focused) return null
  const cards = <div className={`${widget.view === 'list' ? 'flex flex-col' : 'flex'} gap-4 overflow-x-auto no-scrollbar px-2 py-3 -mx-2`}>
    {widget.items.map((item, index) => <MediaCard key={item.key} item={item} view={widget.view} zoneId={`widget-${widget.id}`} sdk={sdk}
      onFocused={next => { setFocused(next); onItemFocused(next); if (index >= widget.items.length - 3 && widget.nextCursor) onLoadMore?.(widget) }} onActivate={onActivate} />)}
  </div>
  return (
    <section className="mb-8" aria-labelledby={`widget-${widget.id}`}>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 id={`widget-${widget.id}`} className="text-xl font-semibold text-white">{widget.title}</h2>
        <span className="text-xs font-mono text-white/35">{widget.total}</span>
      </div>
      {widget.view === 'wall'
        ? <div className="flex items-stretch gap-8"><div className="min-w-0 flex-1">{cards}</div><aside className="sticky right-0 w-[32%] shrink-0 rounded-2xl bg-black/35 p-6 ring-1 ring-white/10" aria-live="polite"><h3 className="text-2xl font-semibold">{focused.title}</h3>{focused.subtitle && <p className="mt-2 text-white/55">{focused.subtitle}</p>}{focused.plot && <p className="mt-5 line-clamp-6 leading-relaxed text-white/55">{focused.plot}</p>}<div className="mt-5 flex flex-wrap gap-2">{focused.badges.slice(0, 3).map(badge => <span key={badge.label} className="rounded border border-white/15 px-2 py-1 text-sm text-white/65">{badge.label}</span>)}</div>{focused.progress && <progress aria-label={`${Math.round(focused.progress.percent)}% watched`} value={focused.progress.percent} max={100} className="player-progress mt-6 h-1 w-full" />}</aside></div>
        : cards}
    </section>
  )
}

/** Full-bleed spotlight with clearlogo and auto-rotation — the Arctic Fuse hero. */
function HeroRail({ items, sdk }: { items: CardItem[]; sdk: ArchivistSdk }) {
  const [idx, setIdx] = useState(0)
  const item = items[idx % items.length]

  useEffect(() => {
    if (items.length < 2) return
    const t = setInterval(() => setIdx(i => (i + 1) % items.length), 9000)
    return () => clearInterval(t)
  }, [items.length])

  const img = item.backdropUrl || item.posterUrl
  return (
    <section className="relative h-[52vh] min-h-[340px] mb-9 -mt-14">
      {img && (
        <img key={item.key} src={sdk.asset(img)} alt=""
          className="absolute inset-0 w-full h-full object-cover animate-fade-in" />
      )}
      <div className="absolute inset-0 scrim-b" />
      <div className="absolute inset-0 scrim-l" />
      <div className="absolute inset-x-0 top-0 h-24 scrim-t" />
      <div className="absolute bottom-9 left-5 sm:left-8 right-8 max-w-2xl">
        {item.logoUrl
          ? <img key={item.logoUrl} src={sdk.asset(item.logoUrl)} alt={item.title}
              className="max-h-24 max-w-[min(28rem,70%)] object-contain object-left mb-4 drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)] animate-fade-in" />
          : <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-white mb-3 leading-none">{item.title}</h1>}
        {item.subtitle && <p className="text-sm text-white/60 line-clamp-2 mb-5 max-w-lg leading-relaxed">{item.subtitle}</p>}
        <Link to={item.to}
          className="inline-flex items-center gap-2 px-8 py-3 rounded-full bg-white text-noir-950 font-bold tracking-wide text-[12px] hover:bg-white/90 active:scale-[0.97] transition-all shadow-lg shadow-black/30">
          <span className="text-[10px]">▶</span> View
        </Link>
      </div>
      {items.length > 1 && (
        <div className="absolute bottom-6 right-8 flex gap-2">
          {items.map((_, i) => (
            <button key={i} onClick={() => setIdx(i)} aria-label={`Slide ${i + 1}`}
              className={`h-1.5 rounded-full transition-all duration-300 ${i === idx ? 'w-6 bg-white' : 'w-1.5 bg-white/25 hover:bg-white/50'}`} />
          ))}
        </div>
      )}
    </section>
  )
}
