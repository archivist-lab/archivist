import { useEffect, useState } from 'react'
import { request } from '../../lib/api.js'
import { Spinner } from '../../components/ui.js'

interface RecommendationHealth {
  enabled: boolean
  modelVersion: string
  candidates: Array<{ media_type: string; count: number; refreshedAt: string | null }>
  snapshots: Array<{ audience: string; media_type: string; libraryId: number; generatedAt: string; invalidatedAt: string | null }>
  feedbackCount: number
  settings: { enabled: boolean; retentionDays: number }
}

export function RecommendationsSystemTab() {
  const [health, setHealth] = useState<RecommendationHealth | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const load = () => request<RecommendationHealth>('/system/recommendations/health').then(value => { setHealth(value); setError('') }).catch(reason => setError(String(reason)))
  useEffect(() => { load() }, [])
  const refresh = async () => {
    setRefreshing(true)
    try { await request('/recommendations/refresh-sources', { method: 'POST' }); await load() }
    catch (reason) { setError(String(reason)) }
    finally { setRefreshing(false) }
  }
  const saveSettings = async (patch: Partial<RecommendationHealth['settings']>) => {
    try { await request('/system/recommendations/settings', { method: 'PUT', body: JSON.stringify(patch) }); await load() }
    catch (reason) { setError(String(reason)) }
  }
  const fmt = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never'

  return <div className="space-y-8">
    <div className="flex items-end justify-between gap-4"><div><h2 className="font-display text-3xl tracking-widest text-white">RECOMMENDATIONS</h2><p className="mt-2 text-xs text-white/35">Candidate sources, durable snapshots and profile feedback health.</p></div><button disabled={refreshing} onClick={refresh} className="px-5 py-2.5 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/20 text-[#00D4FF] text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">{refreshing ? 'Refreshing…' : 'Refresh Sources'}</button></div>
    {error && <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">{error}</div>}
    {!health ? <Spinner className="w-10 h-10" /> : <>
      <div className="grid gap-4 md:grid-cols-3"><Metric label="Engine" value={health.enabled ? 'Enabled' : 'Disabled'} /><Metric label="Model" value={health.modelVersion} /><Metric label="Feedback Records" value={String(health.feedbackCount)} /></div>
      <section className="rounded-2xl border border-white/5 bg-noir-900/70 p-5"><h3 className="text-xs font-bold uppercase tracking-widest text-white/60">Governance</h3><div className="mt-4 flex flex-wrap items-center gap-6"><label className="flex items-center gap-3 text-sm text-white/65"><input type="checkbox" checked={health.settings.enabled} onChange={event => void saveSettings({ enabled: event.target.checked })} /> Recommendation engine enabled</label><label className="flex items-center gap-3 text-sm text-white/45">History retention<select value={health.settings.retentionDays} onChange={event => void saveSettings({ retentionDays: Number(event.target.value) })} className="rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-white"><option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option><option value={365}>365 days</option></select></label></div></section>
      <section className="rounded-2xl border border-white/5 bg-noir-900/70 overflow-hidden"><div className="px-5 py-4 border-b border-white/5"><h3 className="text-xs font-bold uppercase tracking-widest text-white/60">Candidate Sources</h3></div><div className="divide-y divide-white/5">{health.candidates.length ? health.candidates.map(row => <div key={row.media_type} className="grid grid-cols-3 gap-4 px-5 py-3 text-xs"><span className="capitalize text-white/75">{row.media_type}</span><span className="font-mono text-white/45">{row.count} candidates</span><span className="text-right text-white/30">{fmt(row.refreshedAt)}</span></div>) : <p className="p-5 text-sm text-white/25">No external candidates cached. Local recommendations continue to work offline.</p>}</div></section>
      <section className="rounded-2xl border border-white/5 bg-noir-900/70 overflow-hidden"><div className="px-5 py-4 border-b border-white/5"><h3 className="text-xs font-bold uppercase tracking-widest text-white/60">Snapshots</h3></div><div className="max-h-96 overflow-y-auto divide-y divide-white/5">{health.snapshots.length ? health.snapshots.map((row, index) => <div key={`${row.audience}:${row.media_type}:${row.libraryId}:${index}`} className="grid grid-cols-2 md:grid-cols-5 gap-3 px-5 py-3 text-xs"><span className="text-white/70">{row.audience}</span><span className="capitalize text-white/50">{row.media_type}</span><span className="font-mono text-white/35">Library {row.libraryId}</span><span className="text-white/30">{fmt(row.generatedAt)}</span><span className={row.invalidatedAt ? 'text-amber-400' : 'text-emerald-400'}>{row.invalidatedAt ? 'Rebuild pending' : 'Current'}</span></div>) : <p className="p-5 text-sm text-white/25">Snapshots are generated when recommendation views are first opened.</p>}</div></section>
    </>}
  </div>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-white/5 bg-noir-900/70 p-5"><p className="text-[9px] font-mono uppercase tracking-widest text-white/25">{label}</p><p className="mt-2 text-lg text-white/80">{value}</p></div>
}
