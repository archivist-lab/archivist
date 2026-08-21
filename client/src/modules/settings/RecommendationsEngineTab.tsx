import { useEffect, useState, type ReactNode } from 'react'
import { request } from '../../lib/api.js'
import { Spinner } from '../../components/ui.js'
import { confirmDialog, toast } from '../../lib/notify.js'
import { formatDateTime } from '../../lib/datetime.js'

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

/** Mirrors the server's genre dominance cap so the UI can state the real effect. */
const dominanceCap = (variety: RecommendationSettings['variety']) => variety === 'focused' ? 8 : variety === 'diverse' ? 2 : 4
const historyMultiplier = (emphasis: RecommendationSettings['historyEmphasis']) => emphasis === 'high' ? '1.5×' : emphasis === 'low' ? '0.6×' : '1×'

const PIPELINE: Array<{ step: string; title: string; body: string }> = [
  { step: '1', title: 'Seeds', body: 'Everything you finished, abandoned or rated becomes a seed. A 5★ rating pushes hard in one direction, a 1★ pushes the other way, and recent viewing counts for more than something you watched a year ago.' },
  { step: '2', title: 'Candidates', body: 'Two pools are collected: titles already in the library, and titles fetched from TMDB — weekly discovery plus "people who liked this" lists for your strongest seeds. External candidates are cached for 24 hours.' },
  { step: '3', title: 'Ranking', body: 'Each candidate is scored on shared genres, shared cast and crew, the same studio or network, its rating and popularity, and your feedback. Anything you already finished, or marked "not interested", is dropped.' },
  { step: '4', title: 'Rows', body: 'The shortlist is capped so one genre cannot swamp it, split into the rows you see, and saved as a snapshot. Snapshots are reused for six hours, then quietly rebuilt in the background.' },
]

const GLOSSARY: Array<{ term: string; body: string }> = [
  { term: 'Seed', body: 'A title of yours that the engine reasons from. Watching, abandoning and rating all create seeds — that is what "Because you finished…" refers to.' },
  { term: 'Candidate', body: 'A title under consideration. It may already be in your library or come from TMDB; either can end up in a row.' },
  { term: 'Snapshot', body: 'The saved result of one ranking run, per library and per viewer. Rebuilding clears it so the next visit recomputes from scratch.' },
  { term: 'Viewer / audience', body: 'Recommendations exist per player profile, plus a shared "household" set blended from everyone. Feedback always belongs to a specific profile.' },
  { term: 'Availability', body: '"In library" means you own it, "wanted" and "downloading" mean it is on its way, "upcoming" is unreleased, and anything else is an external suggestion.' },
  { term: 'Popularity floor', body: 'TMDB\'s popularity score for a title. The obscurity filter drops external suggestions below the floor; titles you already own are never filtered out.' },
  { term: 'Feedback', body: '"More/less like this" also writes a 5★ or 2★ rating when you own the title, so one signal drives both. "Not interested" and "Already seen" hide it outright.' },
  { term: 'Model version', body: 'The scoring algorithm that produced a snapshot. When it changes, older snapshots are regenerated rather than trusted.' },
]

const ROWS: Array<{ title: string; body: string }> = [
  { title: 'Because You Finished…', body: 'Directly traced to one of your seeds — TMDB\'s own "similar to this" list for something you watched.' },
  { title: 'In Your Museum', body: 'Already on disk and ready to play. The engine surfaces things you own but have not got to yet.' },
  { title: 'New Discoveries', body: 'Not in the library at all. These are the suggestions to add.' },
  { title: 'Coming to the Museum', body: 'Wanted, queued, downloading or processing — already requested, not yet playable.' },
  { title: 'Upcoming', body: 'Not released yet, but a good match for your taste when it lands.' },
]

/**
 * The engine tab: what the recommender does, in plain language, alongside the
 * controls that change it.
 */
export function RecommendationsEngineTab() {
  const [health, setHealth] = useState<RecommendationHealth | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const load = () => request<RecommendationHealth>('/system/recommendations/health')
    .then(value => { setHealth(value); setError('') })
    .catch(reason => setError(String(reason)))
  useEffect(() => { void load() }, [])

  const refresh = async () => {
    setRefreshing(true)
    try {
      const result = await request<{ films: number; series: number }>('/recommendations/refresh-sources', { method: 'POST' })
      await load()
      toast.success(`Pulled ${result.films + result.series} candidate titles from TMDB.`)
    } catch (reason) { setError(String(reason)) }
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

  const fmt = (value: string | null | undefined) => value ? formatDateTime(value) : 'Never'
  const candidateTotal = (health?.candidates ?? []).reduce((sum, row) => sum + Number(row.count || 0), 0)
  const refreshTimes = (health?.candidates ?? []).map(row => row.refreshedAt).filter((value): value is string => Boolean(value)).sort()
  const lastRefresh = refreshTimes.length ? refreshTimes[refreshTimes.length - 1] : null
  const pendingSnapshots = (health?.snapshots ?? []).filter(row => row.invalidatedAt).length

  return <div className="space-y-8">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h2 className="font-display text-3xl tracking-widest text-white">HOW RECOMMENDATIONS WORK</h2>
        <p className="mt-2 text-sm leading-relaxed text-white/40">
          Archivist builds suggestions from your own library — what you finished, what you rated, who made it — and tops them up
          with titles from TMDB. Nothing here leaves the server except the TMDB lookups.
        </p>
      </div>
      <button disabled={refreshing} onClick={() => void refresh()} className="px-5 py-2.5 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/20 text-[#00D4FF] text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">{refreshing ? 'Refreshing…' : 'Refresh Sources'}</button>
    </div>

    {error && <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">{error}</div>}

    {!health ? <Spinner className="w-10 h-10" /> : <>
      {!health.settings.enabled && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200/80">
          The engine is switched off. Recommendation rows stay empty everywhere until you turn it back on below.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Engine" value={health.settings.enabled ? 'Running' : 'Off'} hint={health.settings.enabled ? `Refreshes every ${health.settings.refreshIntervalHours}h` : 'No new suggestions'} />
        <Metric label="Candidate pool" value={candidateTotal.toLocaleString()} hint={`Cached from TMDB · ${fmt(lastRefresh)}`} />
        <Metric label="Saved lists" value={String(health.snapshots.length)} hint={pendingSnapshots ? `${pendingSnapshots} awaiting rebuild` : 'All current'} />
        <Metric label="Your feedback" value={String(health.feedbackCount)} hint="More / less like this votes" />
      </div>

      <section className="rounded-2xl border border-white/5 bg-noir-900/70 p-5">
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/60">From your library to a row</h3>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {PIPELINE.map(stage => (
            <div key={stage.step} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
              <span className="font-mono text-[10px] text-[#00D4FF]/70">STEP {stage.step}</span>
              <h4 className="mt-1 text-sm font-bold uppercase tracking-widest text-white/70">{stage.title}</h4>
              <p className="mt-2 text-xs leading-relaxed text-white/40">{stage.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-white/5 bg-noir-900/70 p-5">
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/60">The levers you can pull</h3>
        <p className="mt-1 text-[11px] text-white/30">Every change here invalidates the saved lists, so the next view is recomputed.</p>
        <div className="mt-5 space-y-4">
          <Lever
            label="Engine"
            what="Turns the whole recommender on or off."
            effect={health.settings.enabled ? 'On — rows are generated and TMDB is polled in the background.' : 'Off — every recommendation row is empty and no TMDB calls are made.'}
          >
            <label className="flex items-center gap-3 text-sm text-white/65">
              <input type="checkbox" checked={health.settings.enabled} onChange={event => void saveSettings({ enabled: event.target.checked })} />
              {health.settings.enabled ? 'Enabled' : 'Disabled'}
            </label>
          </Lever>

          <Lever
            label="Variety"
            what="How much one genre is allowed to take over a list. Focused leans into your strongest taste; diverse forces a spread."
            effect={`Right now a single genre can fill at most ${dominanceCap(health.settings.variety)} slots before further titles of that genre are skipped.`}
          >
            <select value={health.settings.variety} onChange={e => void saveSettings({ variety: e.target.value as RecommendationSettings['variety'] })} className="w-full rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-white">
              <option value="focused">Focused — more of what I already like</option>
              <option value="balanced">Balanced</option>
              <option value="diverse">Diverse — mix it up</option>
            </select>
          </Lever>

          <Lever
            label="Obscurity filter"
            what="A popularity floor applied to TMDB suggestions. Raising it hides long-tail titles nobody has heard of."
            effect={health.settings.minPopularity === 0
              ? 'No floor — every external suggestion is eligible, however obscure.'
              : `External suggestions below a TMDB popularity of ${health.settings.minPopularity} are dropped. Titles already in your library are never filtered.`}
          >
            <select value={health.settings.minPopularity} onChange={e => void saveSettings({ minPopularity: Number(e.target.value) })} className="w-full rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-white">
              {OBSCURITY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              {!OBSCURITY_OPTIONS.some(option => option.value === health.settings.minPopularity) && (
                <option value={health.settings.minPopularity}>Custom ({health.settings.minPopularity})</option>
              )}
            </select>
          </Lever>

          <Lever
            label="History emphasis"
            what="How loudly your viewing history and ratings speak, compared with a title simply sitting in the library unwatched."
            effect={`Signals derived from what you watched and rated are weighted ${historyMultiplier(health.settings.historyEmphasis)}.`}
          >
            <select value={health.settings.historyEmphasis} onChange={e => void saveSettings({ historyEmphasis: e.target.value as RecommendationSettings['historyEmphasis'] })} className="w-full rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-white">
              <option value="low">Low — mostly library taste</option>
              <option value="balanced">Balanced</option>
              <option value="high">High — follow my viewing closely</option>
            </select>
          </Lever>

          <Lever
            label="Refresh cadence"
            what="How often fresh candidates are pulled from TMDB in the background. More often means livelier suggestions and more API calls."
            effect={`Currently every ${health.settings.refreshIntervalHours} hour${health.settings.refreshIntervalHours === 1 ? '' : 's'}. Last pull ${fmt(lastRefresh).toLowerCase()}.`}
          >
            <select value={health.settings.refreshIntervalHours} onChange={e => void saveSettings({ refreshIntervalHours: Number(e.target.value) })} className="w-full rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-white">
              <option value={3}>Every 3 hours</option>
              <option value={6}>Every 6 hours</option>
              <option value={12}>Every 12 hours</option>
              <option value={24}>Daily</option>
              {![3, 6, 12, 24].includes(health.settings.refreshIntervalHours) && (
                <option value={health.settings.refreshIntervalHours}>Every {health.settings.refreshIntervalHours} hours</option>
              )}
            </select>
          </Lever>

          <Lever
            label="History retention"
            what="How long playback and exposure history is kept before it is pruned. Shorter means the engine forgets old habits sooner."
            effect={`Events older than ${health.settings.retentionDays} days are deleted on each source refresh.`}
          >
            <select value={health.settings.retentionDays} onChange={event => void saveSettings({ retentionDays: Number(event.target.value) })} className="w-full rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-white">
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>365 days</option>
            </select>
          </Lever>
        </div>
      </section>

      <section className="rounded-2xl border border-white/5 bg-noir-900/70 p-5">
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/60">What the rows mean</h3>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {ROWS.map(row => (
            <div key={row.title} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
              <h4 className="text-sm text-white/75">{row.title}</h4>
              <p className="mt-1 text-xs leading-relaxed text-white/40">{row.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-white/5 bg-noir-900/70 p-5">
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/60">Glossary</h3>
        <dl className="mt-4 grid gap-4 md:grid-cols-2">
          {GLOSSARY.map(entry => (
            <div key={entry.term}>
              <dt className="text-[11px] font-bold uppercase tracking-widest text-white/55">{entry.term}</dt>
              <dd className="mt-1 text-xs leading-relaxed text-white/40">{entry.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="rounded-2xl border border-white/5 bg-noir-900/70 p-5">
        <h3 className="text-xs font-bold uppercase tracking-widest text-white/60">Maintenance</h3>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Action
            title="Refresh sources"
            body="Pull a new batch of candidate titles from TMDB right now instead of waiting for the schedule."
            onClick={() => void refresh()}
            disabled={refreshing}
            label={refreshing ? 'Refreshing…' : 'Refresh Sources'}
          />
          <Action
            title="Rebuild lists"
            body="Throw away every saved snapshot. Nothing is lost — each list is recomputed the next time it is opened."
            onClick={() => void rebuildSnapshots()}
            label="Rebuild Snapshots"
          />
          <Action
            title="Clear feedback"
            body="Erase every more/less-like-this, not-interested and already-seen vote, for all profiles. Cannot be undone."
            onClick={() => void clearFeedback()}
            label="Clear Feedback"
            danger
          />
        </div>
      </section>

      <details className="rounded-2xl border border-white/5 bg-noir-900/70">
        <summary className="cursor-pointer px-5 py-4 text-xs font-bold uppercase tracking-widest text-white/60">Diagnostics · model {health.modelVersion}</summary>
        <div className="border-t border-white/5 px-5 py-4 space-y-6">
          <div>
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-white/40">Candidate sources</h4>
            <div className="mt-2 divide-y divide-white/5">
              {health.candidates.length ? health.candidates.map(row => (
                <div key={row.media_type} className="grid grid-cols-3 gap-4 py-2 text-xs">
                  <span className="capitalize text-white/75">{row.media_type}</span>
                  <span className="font-mono text-white/45">{row.count} candidates</span>
                  <span className="text-right text-white/30">{fmt(row.refreshedAt)}</span>
                </div>
              )) : <p className="py-2 text-sm text-white/25">No external candidates cached. Local recommendations continue to work offline.</p>}
            </div>
          </div>
          <div>
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-white/40">Snapshots</h4>
            <div className="mt-2 max-h-96 overflow-y-auto divide-y divide-white/5">
              {health.snapshots.length ? health.snapshots.map((row, index) => (
                <div key={`${row.audience}:${row.media_type}:${row.libraryId}:${index}`} className="grid grid-cols-2 gap-3 py-2 text-xs md:grid-cols-5">
                  <span className="text-white/70">{row.audience}</span>
                  <span className="capitalize text-white/50">{row.media_type}</span>
                  <span className="font-mono text-white/35">Library {row.libraryId}</span>
                  <span className="text-white/30">{fmt(row.generatedAt)}</span>
                  <span className={row.invalidatedAt ? 'text-amber-400' : 'text-emerald-400'}>{row.invalidatedAt ? 'Rebuild pending' : 'Current'}</span>
                </div>
              )) : <p className="py-2 text-sm text-white/25">Snapshots are generated when recommendation views are first opened.</p>}
            </div>
          </div>
        </div>
      </details>
    </>}
  </div>
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="rounded-2xl border border-white/5 bg-noir-900/70 p-5">
    <p className="text-[9px] font-mono uppercase tracking-widest text-white/25">{label}</p>
    <p className="mt-2 text-lg text-white/80">{value}</p>
    {hint && <p className="mt-1 text-[10px] text-white/25">{hint}</p>}
  </div>
}

function Lever({ label, what, effect, children }: { label: string; what: string; effect: string; children: ReactNode }) {
  return (
    <div className="grid gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-4 md:grid-cols-[1fr_16rem] md:items-center">
      <div>
        <span className="block text-[11px] font-bold uppercase tracking-widest text-white/60">{label}</span>
        <p className="mt-1 text-xs leading-relaxed text-white/40">{what}</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[#00D4FF]/60">{effect}</p>
      </div>
      <div>{children}</div>
    </div>
  )
}

function Action({ title, body, onClick, label, disabled, danger }: { title: string; body: string; onClick: () => void; label: string; disabled?: boolean; danger?: boolean }) {
  return (
    <div className="flex flex-col rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <h4 className="text-sm text-white/75">{title}</h4>
      <p className="mt-1 flex-1 text-xs leading-relaxed text-white/40">{body}</p>
      <button
        onClick={onClick}
        disabled={disabled}
        className={`mt-4 rounded-lg border px-4 py-2 text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40 ${
          danger
            ? 'border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20'
            : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white'
        }`}
      >{label}</button>
    </div>
  )
}
