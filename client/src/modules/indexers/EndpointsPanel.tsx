import { useEffect, useState } from 'react'
import { Icon as PackIcon } from '@archivist/design-system'
import { sharedApi, type IndexerEndpointView, type IndexerProbeRecordView } from '../../lib/shared.api.js'
import { toast, confirmDialog } from '../../lib/notify.js'
import { Spinner } from '../../components/ui.js'
import { formatDateTime } from '../../lib/datetime.js'

/**
 * Indexer Endpoint Resolver surface (spec §12).
 *
 * Reachability is measured state, so this table shows what was measured rather
 * than a URL field: tier, latency, a 7-day sparkline, and the last failure as a
 * sentence instead of an enum.
 */

const TIER_LABEL: Record<IndexerEndpointView['tier'], string> = {
  A: 'A · Direct',
  B: 'B · Bypass',
  C: 'C · Degraded',
  D: 'D · Dead',
  unknown: 'Not measured',
}

const TIER_TONE: Record<IndexerEndpointView['tier'], string> = {
  A: 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10',
  B: 'text-amber-400 border-amber-400/30 bg-amber-400/10',
  C: 'text-orange-400 border-orange-400/30 bg-orange-400/10',
  D: 'text-red-400 border-red-400/30 bg-red-400/10',
  unknown: 'text-white/35 border-white/10 bg-white/5',
}

function relative(ms: number | null): string {
  if (!ms) return 'never'
  const delta = Date.now() - ms
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`
  return `${Math.round(delta / 86_400_000)}d ago`
}

function latency(ms: number | null): string {
  if (ms === null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** 14 buckets over 7 days; bar height is the success rate in that bucket. */
function Sparkline({ history }: { history: IndexerProbeRecordView[] }) {
  const buckets = 14
  const span = 7 * 86_400_000
  const now = Date.now()
  const tallies = Array.from({ length: buckets }, () => ({ ok: 0, total: 0 }))

  for (const record of history) {
    const age = now - record.probedAt
    if (age < 0 || age > span) continue
    const index = Math.min(buckets - 1, buckets - 1 - Math.floor(age / (span / buckets)))
    tallies[index].total += 1
    if (record.outcome === 'ok') tallies[index].ok += 1
  }

  const measured = tallies.filter(t => t.total > 0)
  const overall = measured.length
    ? measured.reduce((sum, t) => sum + t.ok / t.total, 0) / measured.length
    : null

  return (
    <div className="flex items-end gap-2">
      <div className="flex h-5 items-end gap-[2px]" aria-hidden="true">
        {tallies.map((tally, index) => {
          const rate = tally.total > 0 ? tally.ok / tally.total : null
          const height = rate === null ? 2 : Math.max(2, Math.round(rate * 20))
          const tone = rate === null ? 'bg-white/10' : rate >= 0.9 ? 'bg-emerald-400/70' : rate >= 0.5 ? 'bg-amber-400/70' : 'bg-red-400/70'
          return <span key={index} className={`w-[3px] rounded-sm ${tone}`} style={{ height }} />
        })}
      </div>
      <span className="font-mono text-[10px] text-white/35">
        {overall === null ? '—' : `${Math.round(overall * 100)}%`}
      </span>
    </div>
  )
}

export function EndpointsPanel({ indexerId, indexerName }: { indexerId: string; indexerName: string }) {
  const [endpoints, setEndpoints] = useState<IndexerEndpointView[] | null>(null)
  const [history, setHistory] = useState<Record<number, IndexerProbeRecordView[]>>({})
  const [busy, setBusy] = useState<number | 'all' | null>(null)
  const [newUrl, setNewUrl] = useState('')

  const load = async () => {
    try {
      const res = await sharedApi.indexers.endpoints.list(indexerId)
      setEndpoints(res.endpoints)
      const histories = await Promise.all(res.endpoints.map(async endpoint => {
        try {
          const h = await sharedApi.indexers.endpoints.history(indexerId, endpoint.id)
          return [endpoint.id, h.history] as const
        } catch {
          return [endpoint.id, [] as IndexerProbeRecordView[]] as const
        }
      }))
      setHistory(Object.fromEntries(histories))
    } catch (err) {
      toast.error(String(err))
      setEndpoints([])
    }
  }

  useEffect(() => { void load() }, [indexerId])

  const resolveAll = async () => {
    const ok = await confirmDialog({
      title: 'Re-resolve every endpoint?',
      message: `This probes all of ${indexerName}'s endpoints, which generates real traffic to each of them. `
        + 'Probes are spaced out, so it runs in the background and can take a few minutes.',
      confirmLabel: 'Re-resolve',
    })
    if (!ok) return
    setBusy('all')
    try {
      const res = await sharedApi.indexers.endpoints.resolve(indexerId)
      toast.success(`Probing ${res.endpointCount} endpoint${res.endpointCount === 1 ? '' : 's'} in the background`)
      // Probes are deliberately paced, so the table fills in over the next
      // minute or two rather than all at once.
      await load()
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5_000))
        await load()
      }
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBusy(null)
    }
  }

  const act = async (endpointId: number, run: () => Promise<unknown>) => {
    setBusy(endpointId)
    try {
      await run()
      await load()
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBusy(null)
    }
  }

  const addEndpoint = async () => {
    if (!newUrl.trim()) return
    await act(-1, async () => {
      await sharedApi.indexers.endpoints.add(indexerId, newUrl.trim())
      setNewUrl('')
      toast.success('Endpoint added and probed')
    })
  }

  if (endpoints === null) {
    return <div className="grid min-h-24 place-items-center"><Spinner className="h-6 w-6" /></div>
  }

  const unhealthyPreference = endpoints.find(endpoint => endpoint.isPinned && (endpoint.tier === 'C' || endpoint.tier === 'D'))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-white/30">
          {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'} · measured continuously
        </p>
        <button
          onClick={resolveAll}
          disabled={busy !== null}
          className="flex items-center gap-2 rounded-lg border border-[#00D4FF]/30 bg-[#00D4FF]/10 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-[#00D4FF] transition-all hover:bg-[#00D4FF]/20 disabled:opacity-40"
        >
          {busy === 'all' ? <Spinner className="h-3 w-3" /> : <PackIcon name="sync" size={12} />}
          {busy === 'all' ? 'Probing…' : 'Re-resolve all'}
        </button>
      </div>

      {unhealthyPreference && (
        <div role="status" className="rounded-xl border border-amber-400/20 bg-amber-400/[.06] px-4 py-3 text-xs text-amber-200/75">
          The preferred endpoint is {unhealthyPreference.tier === 'D' ? 'down' : 'degraded'}. Archivist will use a healthier endpoint when one is available and return to this preference after it recovers.
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-white/5">
        <table className="w-full min-w-[720px] text-left">
          <thead>
            <tr className="bg-black/25 font-mono text-[9px] uppercase tracking-widest text-white/25">
              <th className="px-3 py-2 font-normal" />
              <th className="px-3 py-2 font-normal">URL</th>
              <th className="px-3 py-2 font-normal">Tier</th>
              <th className="px-3 py-2 font-normal">Latency</th>
              <th className="px-3 py-2 font-normal">7 days</th>
              <th className="px-3 py-2 font-normal">Last good</th>
              <th className="px-3 py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {endpoints.map(endpoint => (
              <tr
                key={endpoint.id}
                className={`border-t border-white/5 ${endpoint.isEnabled ? '' : 'opacity-40'}`}
              >
                <td className="px-3 py-3">
                  <button
                    type="button"
                    aria-label={endpoint.isPinned ? 'Remove endpoint preference' : 'Prefer this endpoint'}
                    title={endpoint.isPinned ? 'Preferred — unhealthy endpoints fail over automatically' : 'Prefer this endpoint while it is healthy'}
                    onClick={() => act(endpoint.id, () =>
                      sharedApi.indexers.endpoints.patch(indexerId, endpoint.id, { isPinned: !endpoint.isPinned }))}
                    className="flex h-4 w-4 items-center justify-center"
                  >
                    <span className={`block h-3 w-3 rounded-full border transition-all ${
                      endpoint.isPinned
                        ? 'border-[#00D4FF] bg-[#00D4FF] shadow-[0_0_8px_rgba(0,212,255,0.6)]'
                        : endpoint.isActive
                          ? 'border-emerald-400 bg-emerald-400'
                          : 'border-white/20'
                    }`} />
                  </button>
                </td>
                <td className="px-3 py-3">
                  <p className="truncate font-mono text-xs text-white/80">{endpoint.url}</p>
                  <p className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-white/25">
                    {endpoint.origin}
                    {endpoint.isPinned ? ' · preferred' : ''}
                    {endpoint.isActive ? ' · active' : ''}
                  </p>
                  {endpoint.lastErrorHuman && (
                    <p className="mt-1 text-[10px] text-amber-300/70">{endpoint.lastErrorHuman}</p>
                  )}
                </td>
                <td className="px-3 py-3">
                  <span className={`inline-block rounded-md border px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest ${TIER_TONE[endpoint.tier]}`}>
                    {TIER_LABEL[endpoint.tier]}
                  </span>
                </td>
                <td className="px-3 py-3 font-mono text-xs tabular-nums text-white/55">{latency(endpoint.latencyP50Ms)}</td>
                <td className="px-3 py-3"><Sparkline history={history[endpoint.id] ?? []} /></td>
                <td className="px-3 py-3 font-mono text-[10px] text-white/40" title={endpoint.lastOkAt ? formatDateTime(endpoint.lastOkAt) : undefined}>
                  {relative(endpoint.lastOkAt)}
                </td>
                <td className="px-3 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => act(endpoint.id, () => sharedApi.indexers.endpoints.probe(indexerId, endpoint.id))}
                      disabled={busy !== null}
                      title="Probe now"
                      className="rounded-lg p-1.5 text-white/30 transition-all hover:bg-white/10 hover:text-white disabled:opacity-40"
                    >
                      {busy === endpoint.id ? <Spinner className="h-3.5 w-3.5" /> : <PackIcon name="test-connection" size={14} />}
                    </button>
                    <button
                      onClick={() => act(endpoint.id, () =>
                        sharedApi.indexers.endpoints.patch(indexerId, endpoint.id, { isEnabled: !endpoint.isEnabled }))}
                      disabled={busy !== null}
                      title={endpoint.isEnabled ? 'Disable' : 'Enable'}
                      className="rounded-lg p-1.5 text-white/30 transition-all hover:bg-white/10 hover:text-white disabled:opacity-40"
                    >
                      <PackIcon name={endpoint.isEnabled ? 'hidden' : 'watched'} size={14} />
                    </button>
                    {endpoint.origin === 'user' && (
                      <button
                        onClick={() => act(endpoint.id, () => sharedApi.indexers.endpoints.remove(indexerId, endpoint.id))}
                        disabled={busy !== null}
                        title="Remove"
                        className="rounded-lg p-1.5 text-red-400/40 transition-all hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
                      >
                        <PackIcon name="delete" size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={newUrl}
          onChange={e => setNewUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void addEndpoint() }}
          placeholder="https://another-mirror.org"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-noir-950 px-3 py-2 font-mono text-xs text-white/85 placeholder-white/20 focus:border-white/30 focus:outline-none"
        />
        <button
          onClick={addEndpoint}
          disabled={!newUrl.trim() || busy !== null}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-white/50 transition-all hover:text-white disabled:opacity-40"
        >
          <PackIcon name="add" size={12} />
          Add endpoint
        </button>
      </div>
    </div>
  )
}
