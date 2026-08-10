import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { leavingSoonApi, type LeavingSoonItem, type PublicSweepSettings } from '../../lib/leaving-soon.api.js'
import { confirmDialog, toast } from '../../lib/notify.js'
import { PageHeader } from '../../components/PageHeader.js'
import { LeavingSoonPolicyTab } from '../settings/index.js'
import { LeavingSoonHowItWorks } from './HowItWorks.js'

type PageTab = 'queue' | 'policy' | 'how'
type QueueStatus = 'all' | 'scheduled' | 'armed' | 'failed'

// The Queue tab owns the section root — "/leaving-soon/queue" would only repeat
// the parent, so it stays at the bare path.
const PAGE_TABS = [
  { id: 'queue', label: 'Queue', to: '/leaving-soon' },
  { id: 'policy', label: 'Retention Policy', to: '/leaving-soon/policy' },
  { id: 'how', label: 'How It Works', to: '/leaving-soon/how' },
]

export function LeavingSoonPage() {
  const location = useLocation()
  // Legacy deep links used ?tab=policy; forward them to the owned route.
  const [searchParams] = useSearchParams()
  const legacyTab = searchParams.get('tab')
  const segment = location.pathname.replace(/^\/leaving-soon\/?/, '').split('/')[0]
  const tab: PageTab = segment === 'policy' || segment === 'how' ? segment : 'queue'
  const [items, setItems] = useState<LeavingSoonItem[] | null>(null)
  const [settings, setSettings] = useState<PublicSweepSettings | null>(null)
  const [notifications, setNotifications] = useState<Array<{ id: number; title: string; message: string; created_at: string }>>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<QueueStatus>('all')
  const [working, setWorking] = useState<string | null>(null)

  const load = () => Promise.all([leavingSoonApi.list(), leavingSoonApi.notifications()]).then(([result, notices]) => {
    setItems(result.items); setSettings(result.settings); setNotifications(notices.notifications)
  }).catch(toast.error)

  useEffect(() => { void load(); const timer = window.setInterval(load, 60_000); return () => clearInterval(timer) }, [])

  const keep = async (item: LeavingSoonItem) => {
    if (!await confirmDialog({
      title: `Keep ${item.title}?`,
      message: 'This removes the item from Leaving Soon and permanently excludes it from automatic Leaving Soon selection. You can still add it manually later.',
      confirmLabel: 'Keep item',
    })) return
    setWorking(`keep:${item.id}`)
    try { await leavingSoonApi.set(item.targetType, item.targetId, false); toast.success(`${item.title} will be kept and excluded from future automatic selection`); await load() }
    catch (error) { toast.error(error) }
    finally { setWorking(null) }
  }

  const sweep = async (item: LeavingSoonItem) => {
    if (!await confirmDialog({
      title: `Sweep ${item.title} now?`,
      message: settings?.dryRun
        ? 'Dry run is enabled. Archivist will validate and report this deletion without removing files.'
        : 'This immediately removes the selected media files using the configured Leaving Soon safety rules. This cannot be undone.',
      confirmLabel: settings?.dryRun ? 'Run test sweep' : 'Sweep now',
    })) return
    setWorking(`sweep:${item.id}`)
    try {
      const result = await leavingSoonApi.sweepItem(item.targetType, item.targetId)
      if (result.dryRun) toast.success('Dry run completed; no files were removed')
      else if (result.deleted > 0) toast.success(`${item.title} was swept`)
      else if (result.failed > 0) toast.error(result.item?.lastError ?? 'Sweep failed')
      else if (result.protected > 0) toast.error('The item is protected by the current Leaving Soon policy')
      else toast.error('No media was removed')
      await load()
    } catch (error) { toast.error(error) }
    finally { setWorking(null) }
  }

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return (items ?? []).filter(item => (status === 'all' || item.status === status) && (!term || `${item.title} ${item.subtitle ?? ''}`.toLowerCase().includes(term)))
  }, [items, query, status])

  if (legacyTab === 'policy' || legacyTab === 'how') return <Navigate to={`/leaving-soon/${legacyTab}`} replace />

  return <div className="mx-auto max-w-[1500px] animate-fade-in pb-20">
    <PageHeader title="Leaving Soon" subtitle="Retention queue and policy" tabs={PAGE_TABS}>
      {settings?.dryRun && <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-amber-300">Dry run</span>}
    </PageHeader>

    {tab === 'how' ? <LeavingSoonHowItWorks /> : tab === 'policy' ? <LeavingSoonPolicyTab /> : <>
      <p className="mb-6 max-w-3xl text-sm text-white/45">Items selected for Leaving Soon appear here with their planned deletion date. Sweep removes one item now; Keep cancels it and prevents future automatic selection.</p>
      <div className="mb-6 flex flex-wrap gap-3"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search Leaving Soon" className="min-w-64 flex-1 rounded-xl border border-white/10 bg-noir-900 px-4 py-3 text-sm text-white outline-none focus:border-white/35" /><select value={status} onChange={event => setStatus(event.target.value as QueueStatus)} className="rounded-xl border border-white/10 bg-noir-900 px-4 py-3 text-sm text-white"><option value="all">All statuses</option><option value="scheduled">Scheduled</option><option value="armed">Waiting to be watched</option><option value="failed">Needs attention</option></select></div>

      {!items ? <p className="py-16 text-center text-white/25">Loading…</p> : visible.length === 0 ? <div className="rounded-2xl border border-white/5 bg-noir-900/40 p-10 text-center text-sm text-white/35">No items match this Leaving Soon view.</div> : <div className="overflow-hidden rounded-2xl border border-white/8 bg-noir-900/50">
        <div className="hidden grid-cols-[minmax(0,1fr)_150px_170px_220px] gap-4 border-b border-white/8 px-5 py-3 font-mono text-[9px] uppercase tracking-widest text-white/30 md:grid"><span>Item</span><span>Status</span><span>Deletion date</span><span className="text-right">Actions</span></div>
        <div className="divide-y divide-white/5">{visible.map(item => <QueueRow key={item.id} item={item} working={working} onKeep={() => void keep(item)} onSweep={() => void sweep(item)} />)}</div>
      </div>}

      {notifications.length > 0 && <section className="mt-12"><h2 className="mb-4 font-display text-xl uppercase tracking-wider text-white/70">Recent activity</h2><div className="divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/8 bg-noir-900/50">{notifications.slice(0, 20).map(note => <div key={note.id} className="flex items-start justify-between gap-5 p-4"><div><p className="text-sm font-semibold text-white/80">{note.title}</p><p className="mt-1 text-xs text-white/40">{note.message}</p></div><time className="shrink-0 font-mono text-[9px] uppercase text-white/25">{new Date(note.created_at).toLocaleDateString()}</time></div>)}</div></section>}
    </>}
  </div>
}

function QueueRow({ item, working, onKeep, onSweep }: { item: LeavingSoonItem; working: string | null; onKeep: () => void; onSweep: () => void }) {
  const date = item.deleteAfter ? new Date(item.deleteAfter).toLocaleDateString() : 'After watched'
  const state = item.status === 'scheduled' ? `${item.daysRemaining ?? 0} days remaining` : item.status === 'armed' ? 'Waiting to be watched' : item.status === 'failed' ? 'Needs attention' : item.status
  return <article className="relative grid gap-4 px-5 py-4 md:grid-cols-[minmax(0,1fr)_150px_170px_220px] md:items-center">
    {item.backdropUrl && <img src={item.backdropUrl} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-[.06]" />}
    <div className="relative flex min-w-0 items-center gap-4">{item.posterUrl ? <img src={item.posterUrl} alt="" className="h-16 w-11 shrink-0 rounded-md object-cover" /> : <div className="flex h-16 w-11 shrink-0 items-center justify-center rounded-md bg-white/5 text-white/20">◇</div>}<div className="min-w-0"><h3 className="truncate text-sm font-semibold text-white/80">{item.title}</h3>{item.subtitle && <p className="mt-1 truncate text-xs text-white/35">{item.subtitle}</p>}{item.lastError && <p className="mt-1 truncate text-xs text-red-300/70">{item.lastError}</p>}</div></div>
    <div className={`relative font-mono text-[10px] uppercase tracking-wider ${item.status === 'failed' ? 'text-red-300' : item.status === 'scheduled' ? 'text-pink-300' : 'text-white/40'}`}>{state}</div>
    <time className="relative text-sm text-white/55">{date}</time>
    <div className="relative flex justify-end gap-2"><button onClick={onKeep} disabled={working !== null} className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-4 py-2 font-mono text-[9px] font-bold uppercase tracking-widest text-emerald-300/80 hover:bg-emerald-400/15 disabled:opacity-40">{working === `keep:${item.id}` ? 'Keeping…' : 'Keep'}</button><button onClick={onSweep} disabled={working !== null} className="rounded-lg border border-red-400/25 bg-red-400/8 px-4 py-2 font-mono text-[9px] font-bold uppercase tracking-widest text-red-300/80 hover:bg-red-400/15 disabled:opacity-40">{working === `sweep:${item.id}` ? 'Sweeping…' : 'Sweep now'}</button></div>
  </article>
}
