import { useEffect, useState, type ReactNode } from 'react'
import { request } from '../../lib/api.js'
import { Spinner } from '../../components/ui.js'
import { confirmDialog, toast } from '../../lib/notify.js'

interface RecommendationSettings {
  enabled: boolean
  retentionDays: number
  variety: 'focused' | 'balanced' | 'diverse'
  minPopularity: number
  historyEmphasis: 'low' | 'balanced' | 'high'
  refreshIntervalHours: number
}

interface RecommendationHealth {
  enabled: boolean
  modelVersion: string
  candidates: Array<{ media_type: string; count: number; refreshedAt: string | null }>
  snapshots: Array<{ audience: string; media_type: string; libraryId: number; generatedAt: string; invalidatedAt: string | null }>
  feedbackCount: number
  settings: RecommendationSettings
}

const OBSCURITY_OPTIONS = [
  { label: 'None — show everything', value: 0 },
  { label: 'Light', value: 5 },
  { label: 'Moderate', value: 20 },
  { label: 'Strong — popular only', value: 60 },
]

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
  const saveSettings = async (patch: Partial<RecommendationSettings>) => {
    try { await request('/system/recommendations/settings', { method: 'PUT', body: JSON.stringify(patch) }); await load() }
    catch (reason) { setError(String(reason)) }
  }
  const rebuildSnapshots = async () => {
    try { await request('/system/recommendations/invalidate', { method: 'POST' }); await load(); toast.success('Snapshots marked for rebuild — they regenerate on next view.') }
    catch (reason) { setError(String(reason)) }
  }
  const clearFeedback = async () => {
    if (!await confirmDialog('Clear all recommendation feedback for every profile? This resets your "more/less like this" votes and cannot be undone.')) return
    try { const result = await request<{ removed: number }>('/system/recommendations/feedback', { method: 'DELETE' }); await load(); toast.success(`Cleared ${result.removed} feedback record${result.removed === 1 ? '' : 's'}.`) }
    catch (reason) { setError(String(reason)) }
  }
  const fmt = (value: string | null) => value ? new Date(value).toLocaleString() : 'Never'

  return <div className="space-y-8">
    <div className="flex items-end justify-between gap-4"><div><h2 className="font-display text-3xl tracking-widest text-white">RECOMMENDATIONS</h2><p className="mt-2 text-xs text-white/35">Candidate sources, durable snapshots and profile feedback health.</p></div><button disabled={refreshing} onClick={refresh} className="px-5 py-2.5 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/20 text-[#00D4FF] text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">{refreshing ? 'Refreshing…' : 'Refresh Sources'}</button></div>
    {error && <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">{error}</div>}
    {!health ? <Spinner className="w-10 h-10" /> : <>
      <div className="grid gap-4 md:grid-cols-3"><Metric label="Engine" value={health.enabled ? 'Enabled' : 'Disabled'} /><Metric label="Model" value={health.modelVersion} /><Metric label="Feedback Records" value={String(health.feedbackCount)} /></div>
      <section className="rounded-2xl border border-white/5 bg-noir-900/70 p-5"><h3 className="text-xs font-bold uppercase tracking-widest text-white/60">Governance</h3><div className="mt-4 flex flex-wrap items-center gap-6"><label className="flex items-center gap-3 text-sm text-white/65"><input type="checkbox" checked={health.settings.enabled} onChange={event => void saveSettings({ enabled: event.target.checked })} /> Recommendation engine enabled</label><label className="flex items-center gap-3 text-sm text-white/45">History retention<select value={health.settings.retentionDays} onChange={event => void saveSettings({ retentionDays: Number(event.target.value) })} className="rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-white"><option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option><option value={365}>365 days</option></select></label></div></section>
      <section className="rounded-2xl border border-white/5 bg-noir-900/70 p-5">
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/60">Tuning</h3>
        <p className="mt-1 text-[11px] text-white/30">Shape what the engine surfaces. Changes take effect on the next snapshot rebuild.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Knob label="Variety" hint="How much a single genre may dominate a list. Diverse mixes it up; focused leans into what you like most.">
            <select value={health.settings.variety} onChange={e => void saveSettings({ variety: e.target.value as RecommendationSettings['variety'] })} className="w-full rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-white">
              <option value="focused">Focused</option>
              <option value="balanced">Balanced</option>
              <option value="diverse">Diverse</option>
            </select>
          </Knob>
          <Knob label="Obscurity filter" hint="Hide little-known titles that fall below a popularity floor. Stronger settings show only well-known releases.">
            <select value={health.settings.minPopularity} onChange={e => void saveSettings({ minPopularity: Number(e.target.value) })} className="w-full rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-white">
              {OBSCURITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              {!OBSCURITY_OPTIONS.some(option => option.value === health.settings.minPopularity) && (
                <option value={health.settings.minPopularity}>Custom ({health.settings.minPopularity})</option>
              )}
            </select>
          </Knob>
          <Knob label="History emphasis" hint="How much your viewing history outweighs titles that merely sit in the library unwatched.">
            <select value={health.settings.historyEmphasis} onChange={e => void saveSettings({ historyEmphasis: e.target.value as RecommendationSettings['historyEmphasis'] })} className="w-full rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-white">
              <option value="low">Low</option>
              <option value="balanced">Balanced</option>
              <option value="high">High</option>
            </select>
          </Knob>
          <Knob label="Refresh cadence" hint="How often fresh candidates are pulled from TMDB in the background.">
            <select value={health.settings.refreshIntervalHours} onChange={e => void saveSettings({ refreshIntervalHours: Number(e.target.value) })} className="w-full rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-white">
              <option value={3}>Every 3 hours</option>
              <option value={6}>Every 6 hours</option>
              <option value={12}>Every 12 hours</option>
              <option value={24}>Daily</option>
              {![3, 6, 12, 24].includes(health.settings.refreshIntervalHours) && (
                <option value={health.settings.refreshIntervalHours}>Every {health.settings.refreshIntervalHours} hours</option>
              )}
            </select>
          </Knob>
        </div>
        <div className="mt-5 flex flex-wrap gap-3 pt-4 border-t border-white/5">
          <button onClick={() => void rebuildSnapshots()} className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-[10px] font-bold uppercase tracking-widest text-white/60 hover:text-white hover:bg-white/10 transition-all">Rebuild Snapshots</button>
          <button onClick={() => void clearFeedback()} className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-[10px] font-bold uppercase tracking-widest text-red-400 hover:bg-red-500/20 transition-all">Clear Feedback</button>
        </div>
      </section>
      <section className="rounded-2xl border border-white/5 bg-noir-900/70 overflow-hidden"><div className="px-5 py-4 border-b border-white/5"><h3 className="text-xs font-bold uppercase tracking-widest text-white/60">Candidate Sources</h3></div><div className="divide-y divide-white/5">{health.candidates.length ? health.candidates.map(row => <div key={row.media_type} className="grid grid-cols-3 gap-4 px-5 py-3 text-xs"><span className="capitalize text-white/75">{row.media_type}</span><span className="font-mono text-white/45">{row.count} candidates</span><span className="text-right text-white/30">{fmt(row.refreshedAt)}</span></div>) : <p className="p-5 text-sm text-white/25">No external candidates cached. Local recommendations continue to work offline.</p>}</div></section>
      <section className="rounded-2xl border border-white/5 bg-noir-900/70 overflow-hidden"><div className="px-5 py-4 border-b border-white/5"><h3 className="text-xs font-bold uppercase tracking-widest text-white/60">Snapshots</h3></div><div className="max-h-96 overflow-y-auto divide-y divide-white/5">{health.snapshots.length ? health.snapshots.map((row, index) => <div key={`${row.audience}:${row.media_type}:${row.libraryId}:${index}`} className="grid grid-cols-2 md:grid-cols-5 gap-3 px-5 py-3 text-xs"><span className="text-white/70">{row.audience}</span><span className="capitalize text-white/50">{row.media_type}</span><span className="font-mono text-white/35">Library {row.libraryId}</span><span className="text-white/30">{fmt(row.generatedAt)}</span><span className={row.invalidatedAt ? 'text-amber-400' : 'text-emerald-400'}>{row.invalidatedAt ? 'Rebuild pending' : 'Current'}</span></div>) : <p className="p-5 text-sm text-white/25">Snapshots are generated when recommendation views are first opened.</p>}</div></section>
    </>}
  </div>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-white/5 bg-noir-900/70 p-5"><p className="text-[9px] font-mono uppercase tracking-widest text-white/25">{label}</p><p className="mt-2 text-lg text-white/80">{value}</p></div>
}

function Knob({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold uppercase tracking-widest text-white/55">{label}</span>
      <span className="mt-0.5 block text-[10px] leading-snug text-white/30">{hint}</span>
      <div className="mt-2">{children}</div>
    </label>
  )
}
