import { useEffect, useMemo, useState } from 'react'
import { leavingSoonApi, type LeavingSoonItem, type PublicSweepSettings } from '../../lib/leaving-soon.api.js'
import { toast } from '../../lib/notify.js'

export function LeavingSoonPage() {
  const [items, setItems] = useState<LeavingSoonItem[] | null>(null)
  const [settings, setSettings] = useState<PublicSweepSettings | null>(null)
  const [notifications, setNotifications] = useState<Array<{ id: number; title: string; message: string; created_at: string }>>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'scheduled' | 'armed' | 'failed'>('all')
  const [saving, setSaving] = useState<number | null>(null)
  const load = () => Promise.all([leavingSoonApi.list(), leavingSoonApi.notifications()]).then(([result, notices]) => {
    setItems(result.items); setSettings(result.settings); setNotifications(notices.notifications)
  }).catch(toast.error)
  useEffect(() => { void load(); const timer = window.setInterval(load, 60_000); return () => clearInterval(timer) }, [])
  const keep = async (item: LeavingSoonItem) => {
    setSaving(item.id)
    try { await leavingSoonApi.set(item.targetType, item.targetId, false); toast.success(`${item.title} will be kept`); await load() }
    catch (error) { toast.error(error) }
    finally { setSaving(null) }
  }
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return (items ?? []).filter(item => (status === 'all' || item.status === status) && (!term || `${item.title} ${item.subtitle ?? ''}`.toLowerCase().includes(term)))
  }, [items, query, status])
  const scheduled = visible.filter(item => item.status === 'scheduled')
  const armed = visible.filter(item => item.status === 'armed')
  const failed = visible.filter(item => item.status === 'failed')
  return <div className="mx-auto max-w-[1500px] animate-fade-in pb-20">
    <header className="mb-8"><div className="flex items-center gap-3"><p className="font-mono text-[10px] font-bold uppercase tracking-[.25em] text-pink-400">Automatic retention</p>{settings?.dryRun && <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-amber-300">Dry run</span>}</div><h1 className="mt-2 font-display text-4xl uppercase tracking-wide text-white">Leaving Soon</h1><p className="mt-3 max-w-3xl text-sm text-white/45">Opted-in items wait until watched, then receive a {settings?.graceDays ?? 30}-day grace period. Keep cancels deletion immediately.</p></header>
    <div className="mb-8 flex flex-wrap gap-3"><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search Leaving Soon" className="min-w-64 flex-1 rounded-xl border border-white/10 bg-noir-900 px-4 py-3 text-sm text-white outline-none focus:border-pink-400/50" /><select value={status} onChange={event => setStatus(event.target.value as typeof status)} className="rounded-xl border border-white/10 bg-noir-900 px-4 py-3 text-sm text-white"><option value="all">All statuses</option><option value="scheduled">Scheduled</option><option value="armed">Waiting to be watched</option><option value="failed">Needs attention</option></select></div>
    {failed.length > 0 && <section className="mb-8 rounded-2xl border border-red-500/30 bg-red-500/[.07] p-5"><h2 className="font-display uppercase tracking-wider text-red-300">Deletion needs attention</h2>{failed.map(item => <p key={item.id} className="mt-2 text-xs text-red-200/70"><strong>{item.title}</strong> · {item.lastError}</p>)}</section>}
    <section><div className="mb-4 flex items-center gap-4"><h2 className="font-display text-xl uppercase tracking-wider text-white">{settings?.collectionsEnabled ? `${settings.movieCollectionName} + ${settings.tvCollectionName}` : 'Scheduled'}</h2><span className="rounded-full bg-pink-500/15 px-2.5 py-1 font-mono text-[10px] text-pink-300">{scheduled.length}</span></div>
      {!items ? <p className="py-16 text-center text-white/25">Loading…</p> : scheduled.length === 0 ? <div className="rounded-2xl border border-white/5 bg-noir-900/40 p-10 text-center text-sm text-white/35">No watched items are currently scheduled for deletion.</div>
      : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{scheduled.map(item => <RetentionCard key={item.id} item={item} saving={saving === item.id} onKeep={() => void keep(item)} />)}</div>}
    </section>
    {armed.length > 0 && <section className="mt-10"><div className="mb-4 flex items-center gap-4"><h2 className="font-display text-xl uppercase tracking-wider text-white">Waiting to be watched</h2><span className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-[10px] text-white/50">{armed.length}</span></div><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{armed.map(item => <RetentionCard key={item.id} item={item} saving={saving === item.id} onKeep={() => void keep(item)} />)}</div></section>}
    {notifications.length > 0 && <section className="mt-12"><h2 className="mb-4 font-display text-xl uppercase tracking-wider text-white">Sweep notifications</h2><div className="divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/8 bg-noir-900/50">{notifications.slice(0, 20).map(note => <div key={note.id} className="flex items-start justify-between gap-5 p-4"><div><p className="text-sm font-semibold text-white/80">{note.title}</p><p className="mt-1 text-xs text-white/40">{note.message}</p></div><time className="shrink-0 font-mono text-[9px] uppercase text-white/25">{new Date(note.created_at).toLocaleDateString()}</time></div>)}</div></section>}
  </div>
}

function RetentionCard({ item, saving, onKeep }: { item: LeavingSoonItem; saving: boolean; onKeep: () => void }) {
  return <article className="relative min-h-48 overflow-hidden rounded-2xl border border-white/8 bg-noir-900/60 p-5">
    {item.backdropUrl && <img src={item.backdropUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-15" />}
    <div className="absolute inset-0 bg-gradient-to-r from-noir-950/95 to-noir-950/60" />
    <div className="relative flex h-full flex-col"><p className={`font-mono text-[9px] font-bold uppercase tracking-[.2em] ${item.status === 'scheduled' ? 'text-pink-300' : 'text-white/35'}`}>{item.status === 'scheduled' ? `${item.daysRemaining} days remaining` : 'Timer starts when watched'}</p><h3 className="mt-3 font-display text-xl uppercase tracking-wide text-white">{item.title}</h3>{item.subtitle && <p className="mt-1 text-xs text-white/40">{item.subtitle}</p>}{item.deleteAfter && <p className="mt-4 text-xs text-white/55">Deletion: {new Date(item.deleteAfter).toLocaleDateString()}</p>}<button onClick={onKeep} disabled={saving} className="mt-auto self-start rounded-lg border border-white/15 bg-white/8 px-4 py-2 font-mono text-[9px] font-bold uppercase tracking-widest text-white/70 hover:bg-white hover:text-black disabled:opacity-40">{saving ? 'Updating…' : 'Keep · cancel deletion'}</button></div>
  </article>
}
