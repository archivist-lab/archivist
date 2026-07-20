import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type { PlayerHub, PlayerMediaCard, PlayerWidget } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { playerStore } from '../lib/store.js'
import { WidgetRail } from './Rail.js'

export function Hub({ hub, sdk, onLoadMore }: { hub: PlayerHub; sdk: ArchivistSdk; onLoadMore?: (widget: PlayerWidget) => void }) {
  const navigate = useNavigate()
  const timer = useRef<number | null>(null)
  const layout: PlayerHub['layout'] = 'standard'
  const widgets = hub.widgets
  const fallback = widgets.flatMap(widget => widget.items)[0] ?? null
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  useEffect(() => {
    playerStore.dispatch({ type: 'MEDIA_CONTEXT_CHANGED', item: fallback })
  }, [fallback?.key])
  const focusItem = (item: PlayerMediaCard) => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => playerStore.dispatch({ type: 'MEDIA_CONTEXT_CHANGED', item }), 100)
  }
  const activate = (item: PlayerMediaCard) => { if (item.route) navigate(item.route) }
  return (
    <div data-route-scroll data-hub-layout={layout} className="player-hub player-hub-standard relative z-10 h-full overflow-y-auto no-scrollbar pb-20">
      <header className="mb-8">
        <h1 className="font-display text-5xl uppercase tracking-widest text-cyan">{hub.title}</h1>
        <p className="mt-1 font-mono text-sm text-white/30">Available to play from your Archivist library</p>
      </header>
      <div className="relative">
        {widgets.map(widget => <WidgetRail key={widget.id} widget={widget} hubLayout={layout} sdk={sdk} onItemFocused={focusItem} onActivate={activate} onLoadMore={onLoadMore} onShowMore={route => navigate(route)} />)}
      </div>
      {!widgets.length && <div className="mx-auto mt-[25vh] max-w-xl text-center"><h2 className="font-display text-2xl uppercase tracking-widest text-white/20">Nothing is on exhibit yet</h2><p className="mt-2 font-mono text-sm text-white/20">Add and curate media in the Archivist server and it will appear here.</p></div>}
    </div>
  )
}

export function HubSkeleton() {
  return <div className="player-safe"><div className="player-skeleton mt-16 h-32 w-1/2 rounded-2xl bg-white/10" /><div className="player-skeleton mt-24 h-56 rounded-2xl bg-white/8" /></div>
}
