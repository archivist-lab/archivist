import { useEffect, useState } from 'react'
import type { ArchivistSdk, LeavingSoonItem, SweepNotification, SweepSettings } from '../lib/sdk.js'

export function LeavingSoonPage({ sdk }: { sdk: ArchivistSdk }) {
  const [items, setItems] = useState<LeavingSoonItem[] | null>(null)
  const [settings, setSettings] = useState<SweepSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keeping, setKeeping] = useState<number | null>(null)
  const [requested, setRequested] = useState<Set<number>>(new Set())
  const [notifications, setNotifications] = useState<SweepNotification[]>([])
  const load = () => Promise.all([sdk.leavingSoon(), sdk.leavingSoonNotifications()]).then(([result, notices]) => { setItems(result.items); setSettings(result.settings); setNotifications(notices.notifications) }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  useEffect(() => { void load(); const timer = window.setInterval(load, 60_000); return () => clearInterval(timer) }, [sdk])
  const keep = async (item: LeavingSoonItem) => {
    setKeeping(item.id)
    try {
      const result = await sdk.keepLeavingSoon(item.targetType, item.targetId)
      if (result.pending) setRequested(current => new Set(current).add(item.id))
      else setItems(current => current?.filter(value => value.id !== item.id) ?? [])
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setKeeping(null) }
  }
  return <div data-route-scroll className="motion-fade h-full overflow-y-auto no-scrollbar pb-20">
    <header className="mb-8"><p className="archivist-section-label text-pink">{settings?.graceDays ?? 30}-day grace period</p><h1 className="archivist-page-title mt-2">Leaving Soon</h1><p className="mt-3 max-w-2xl text-sm text-white/45">Watched items selected for automatic removal. Choose Keep before the date shown to cancel deletion.</p></header>
    {error && <p role="alert" className="mb-5 rounded-xl border border-pink/30 bg-pink/10 p-4 text-sm text-pink">{error}</p>}
    {notifications[0] && <div className="mb-6 rounded-xl border border-white/10 bg-white/5 p-4"><p className="text-sm font-semibold">{notifications[0].title}</p><p className="mt-1 text-xs text-white/45">{notifications[0].message}</p></div>}
    {!items ? <p className="py-16 text-center font-mono text-xs uppercase tracking-widest text-white/30">Loading</p>
      : items.length === 0 ? <div className="player-panel p-12 text-center"><p className="font-display text-2xl uppercase tracking-wide">Nothing is leaving soon</p><p className="mt-2 text-sm text-white/40">Items appear here after they are watched.</p></div>
      : <>{(settings?.collectionsEnabled ? [{ name: settings.movieCollectionName, items: items.filter(item => item.targetType === 'film_edition') }, { name: settings.tvCollectionName, items: items.filter(item => item.targetType !== 'film_edition') }] : [{ name: '', items }]).map(group => group.items.length > 0 && <section key={group.name || 'all'} className="mb-10">{group.name && <h2 className="mb-4 font-display text-xl uppercase tracking-wide">{group.name}</h2>}<div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{group.items.map(item => <article key={item.id} className="player-panel relative min-h-56 overflow-hidden p-6">
        {item.backdropUrl && <img src={sdk.asset(item.backdropUrl)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-20" />}
        <div className="absolute inset-0 bg-gradient-to-r from-noir-950 via-noir-950/90 to-noir-950/55" />
        <div className="relative flex h-full flex-col"><p className="font-mono text-[10px] font-bold uppercase tracking-[.2em] text-pink">{item.daysRemaining} day{item.daysRemaining === 1 ? '' : 's'} remaining</p><h2 className="mt-3 font-display text-2xl uppercase tracking-wide">{item.title}</h2>{item.subtitle && <p className="mt-1 text-xs text-white/45">{item.subtitle}</p>}<p className="mt-5 text-xs text-white/55">Deletes {new Date(item.deleteAfter).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</p><button disabled={keeping === item.id || requested.has(item.id)} onClick={() => void keep(item)} className="player-focusable mt-auto self-start rounded-lg bg-white px-5 py-2.5 font-mono text-[10px] font-bold uppercase tracking-widest text-black disabled:opacity-50">{keeping === item.id ? 'Keeping…' : requested.has(item.id) ? 'Keep requested' : 'Keep this item'}</button></div>
      </article>)}</div></section>)}</>}
  </div>
}
