import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ArchivistSdk } from '../lib/sdk.js'
import type { CardItem } from './Cards.js'
import { PosterCard, LandscapeCard } from './Cards.js'
import type { RailStyle } from '../lib/store.js'
import type { PlayerHubLayout, PlayerMediaCard, PlayerWidget } from '@archivist/contracts'
import { MediaCard } from './Cards.js'

export function Rail({ title, style, items, sdk }: { title: string; style: RailStyle; items: CardItem[]; sdk: ArchivistSdk }) {
  if (items.length === 0) return null
  if (style === 'hero') return <HeroRail items={items} sdk={sdk} />
  return (
    <section className="mb-9">
      <h2 className="mb-3 px-5 font-mono text-[10px] font-bold uppercase tracking-[0.3em] text-white/30 sm:px-8">{title}</h2>
      <div className="flex gap-3.5 px-5 sm:px-8 overflow-x-auto no-scrollbar pb-1">
        {items.map(it => style === 'poster'
          ? <PosterCard key={it.key} item={it} sdk={sdk} />
          : <LandscapeCard key={it.key} item={it} sdk={sdk} />)}
      </div>
    </section>
  )
}

export function WidgetRail({ widget, hubLayout = 'standard', sdk, onItemFocused, onActivate, onLoadMore, onShowMore }: {
  widget: PlayerWidget
  hubLayout?: PlayerHubLayout
  sdk: ArchivistSdk
  onItemFocused: (item: PlayerMediaCard) => void
  onActivate: (item: PlayerMediaCard) => void
  onLoadMore?: (widget: PlayerWidget) => void
  onShowMore?: (route: string) => void
}) {
  const [focused, setFocused] = useState<PlayerMediaCard | null>(widget.items[0] ?? null)
  useEffect(() => {
    setFocused(current => widget.items.find(item => item.key === current?.key) ?? widget.items[0] ?? null)
  }, [widget.items])
  useEffect(() => {
    if (!widget.autoscrollSeconds || widget.items.length < 2) return
    const timer = window.setInterval(() => {
      setFocused(current => {
        const index = Math.max(0, widget.items.findIndex(item => item.key === current?.key))
        const next = widget.items[(index + 1) % widget.items.length]
        onItemFocused(next)
        const focusId = `card-${next.key}`
        document.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
        return next
      })
    }, widget.autoscrollSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [widget.autoscrollSeconds, widget.items, onItemFocused])
  const wall = hubLayout === 'wall'
  const wallColumns = widget.view === 'list' ? 'grid-cols-1' : widget.view === 'landscape' ? 'grid-cols-[repeat(auto-fill,minmax(260px,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(132px,1fr))]'
  const cards = <div data-widget-cards={hubLayout} className={`player-widget-cards ${wall ? `grid ${wallColumns}` : widget.view === 'list' ? 'flex flex-col' : 'flex'} gap-[clamp(.8rem,1.15vw,1.4rem)] ${wall ? 'overflow-visible' : 'snap-x snap-proximity overflow-x-auto no-scrollbar'} scroll-px-4 px-3 py-4 -mx-3`}>
    {widget.items.map((item, index) => <MediaCard key={item.key} item={item} view={widget.view} zoneId={`widget-${widget.id}`} sdk={sdk}
      hubLayout={hubLayout} onFocused={next => { setFocused(next); onItemFocused(next); if (index >= widget.items.length - 3 && widget.nextCursor) onLoadMore?.(widget) }} onActivate={onActivate} />)}
    {widget.showMoreRoute && !onLoadMore && widget.total > widget.items.length && <button type="button" onClick={() => onShowMore?.(widget.showMoreRoute!)} className={`${wall ? widget.view === 'list' ? 'h-[68px] w-full' : widget.view === 'landscape' ? 'aspect-video w-full' : 'aspect-[2/3] w-full' : widget.view === 'list' ? 'h-[68px] w-full' : widget.view === 'landscape' ? 'aspect-video w-[clamp(248px,18.6vw,356px)]' : widget.view === 'wall' ? 'aspect-[2/3] w-[clamp(112px,9.1vw,174px)]' : 'aspect-[2/3] w-[clamp(150px,12.7vw,244px)]'} player-focusable shrink-0 rounded-xl border border-dashed border-white/20 bg-white/5 text-sm font-semibold text-white/60 hover:bg-white/10 hover:text-white`}>Show more →</button>}
  </div>
  return (
    <section data-widget-layout={hubLayout} className={`${hubLayout === 'wall' ? 'mb-12' : 'mb-9'}`} aria-labelledby={`widget-${widget.id}`}>
      <div className="mb-3 flex items-baseline gap-3">
        <h2 id={`widget-${widget.id}`} className="font-mono text-[10px] font-bold uppercase tracking-[0.3em] text-white/30">{widget.title}</h2>
        <span className="text-xs font-mono text-white/35">{widget.total}</span>
      </div>
      {!widget.items.length || !focused
        ? <EmptyWidget />
        : hubLayout === 'combined'
          ? <div className="grid grid-cols-[minmax(0,1fr)_minmax(280px,34%)] items-stretch gap-[clamp(2rem,4vw,5rem)]"><div className="min-w-0 self-end">{cards}</div><aside key={focused.key} className="motion-context sticky right-0 top-6 flex min-h-64 flex-col justify-end border-l border-white/12 bg-gradient-to-r from-white/[.035] to-transparent px-8 py-7" aria-live="polite"><p className="text-xs font-semibold uppercase tracking-[.2em] player-accent">Focused</p>{focused.logoUrl ? <img src={sdk.asset(focused.logoUrl)} alt={focused.title} className="mt-4 max-h-20 max-w-full object-contain object-left" /> : <h3 className="mt-3 text-3xl font-semibold tracking-tight">{focused.title}</h3>}{focused.subtitle && <p className="mt-2 text-white/55">{focused.subtitle}</p>}{focused.plot && <p className="mt-5 line-clamp-5 leading-[1.65] text-white/52">{focused.plot}</p>}<div className="mt-5 flex flex-wrap gap-2">{focused.badges.slice(0, 3).map(badge => <span key={badge.label} className="rounded border border-white/15 px-2 py-1 text-xs text-white/62">{badge.label}</span>)}</div>{focused.progress && <progress aria-label={`${Math.round(focused.progress.percent)}% watched`} value={focused.progress.percent} max={100} className="player-progress mt-6 h-1 w-full" />}</aside></div>
          : cards}
    </section>
  )
}

function EmptyWidget() {
  return <div className="flex min-h-32 items-center gap-4 rounded-xl border border-dashed border-white/10 bg-noir-900/40 px-6 text-white/30"><span className="h-10 w-1 rounded-full bg-white/8" /><div><p className="font-display text-lg uppercase tracking-widest text-white/30">Nothing here yet</p><p className="mt-1 font-mono text-[10px] uppercase tracking-tight text-white/20">This source will fill automatically when matching media is available.</p></div></div>
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
