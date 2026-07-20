import { useEffect, useMemo, useState } from 'react'
import { sharedApi, type ProcessingMonitorItem, type ProcessingMonitorNode, type ProcessingMonitorStatus } from '../../lib/shared.api.js'

const NODE_ACCENT: Record<ProcessingMonitorNode['id'], string> = {
  segments: '#9B59B6', loudness: '#F59E0B', video: '#00D4FF', audio: '#22C55E', 'track-cleaning': '#FF2D78',
}

const formatElapsed = (startedAt?: number | null) => {
  if (!startedAt) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

const formatEta = (seconds: number | null) => {
  if (seconds == null) return 'Calculating…'
  if (seconds < 60) return `~${Math.max(1, seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `~${minutes}m ${seconds % 60}s`
  return `~${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

type ItemAction = 'pause' | 'resume' | 'cancel' | 'skip'

function Progress({ item, accent }: { item: ProcessingMonitorItem; accent: string }) {
  const pct = item.progress == null ? null : Math.round(item.progress * 100)
  return (
    <div className="min-w-40 space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-[10px] font-mono">
        <span className="text-white/70">{pct == null ? 'Working…' : `${pct}%`}</span>
        <span className="text-white/35">{item.speed ? `${item.speed.toFixed(1)}×` : item.startedAt ? formatElapsed(item.startedAt) : ''}</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden bg-white/8" role="progressbar" aria-label={`${item.title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        {pct == null ? (
          <div className="h-full w-1/3 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
        ) : (
          <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, backgroundColor: accent }} />
        )}
      </div>
    </div>
  )
}

function ItemControls({ node, item, busy, onControl }: { node: ProcessingMonitorNode; item: ProcessingMonitorItem; busy: boolean; onControl: (node: ProcessingMonitorNode, item: ProcessingMonitorItem, action: ItemAction) => void }) {
  return (
    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
      {item.canPause && (
        <button disabled={busy} onClick={() => onControl(node, item, item.status === 'paused' ? 'resume' : 'pause')}
          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[9px] font-bold uppercase tracking-widest text-white/55 hover:text-white">
          {item.status === 'paused' ? 'Resume' : 'Pause'}
        </button>
      )}
      {item.canCancel && (
        <button disabled={busy} onClick={() => onControl(node, item, 'cancel')}
          className="px-3 py-1.5 rounded-lg bg-red-500/5 border border-red-400/15 text-[9px] font-bold uppercase tracking-widest text-red-300/60 hover:text-red-300">
          Cancel
        </button>
      )}
      {item.canSkip && (
        <button disabled={busy} onClick={() => onControl(node, item, 'skip')}
          className="px-3 py-1.5 rounded-lg bg-amber-400/5 border border-amber-300/15 text-[9px] font-bold uppercase tracking-widest text-amber-200/65 hover:text-amber-200 disabled:opacity-35">
          Skip
        </button>
      )}
    </div>
  )
}

function NodeCard({ node, busy, onPause, onControl }: {
  node: ProcessingMonitorNode
  busy: string | null
  onPause: (node: ProcessingMonitorNode) => void
  onControl: (node: ProcessingMonitorNode, item: ProcessingMonitorItem, action: ItemAction) => void
}) {
  const accent = NODE_ACCENT[node.id]
  const rows = [
    ...node.activeItems.map(item => ({ item, lane: 'Active', active: true })),
    ...node.queuedItems.map(item => ({ item, lane: `Queue #${item.queuePosition ?? '—'}`, active: false })),
  ]
  return (
    <section className="rounded-2xl bg-noir-900 border border-white/5 shadow-2xl overflow-hidden">
      <div className="px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <span className="w-2.5 h-2.5 mt-1 rounded-full shrink-0" style={{ backgroundColor: node.state === 'idle' ? 'rgba(255,255,255,.15)' : accent, boxShadow: node.state === 'running' ? `0 0 14px ${accent}` : 'none' }} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium text-white uppercase tracking-widest">{node.label}</h3>
                {node.sharedWith && <span className="text-[8px] font-mono uppercase tracking-widest text-white/25">shares {node.sharedWith} job</span>}
              </div>
              <p className="text-[10px] font-mono text-white/30 mt-1 max-w-3xl">{node.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-lg bg-black/30 text-[9px] font-mono uppercase tracking-widest text-white/40">Active {node.activeCount} / {node.concurrency} · Queue {node.queuedCount}</span>
            <button disabled={busy === node.id} onClick={() => onPause(node)}
              className={`px-4 py-2 rounded-xl border text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40 ${node.paused ? 'bg-amber-400/15 border-amber-400/30 text-amber-300' : 'bg-white/5 border-white/10 text-white/55 hover:text-white'}`}>
              {node.paused ? '▶ Resume Queue' : node.pauseBehavior === 'after-current' && node.activeCount ? '⏸ Pause After Current' : '⏸ Pause Queue'}
            </button>
          </div>
        </div>

      </div>
      <div className="border-t border-white/5 bg-black/20 overflow-x-auto custom-scrollbar">
        <table className="w-full min-w-[1080px] table-fixed text-left">
          <thead className="border-b border-white/5 bg-black/20 text-[9px] font-mono uppercase tracking-[.18em] text-white/28">
            <tr><th className="w-28 px-5 py-3">State</th><th className="w-[24%] px-3 py-3">Item</th><th className="w-[23%] px-3 py-3">Process</th><th className="w-52 px-3 py-3">Progress</th><th className="w-28 px-3 py-3">ETA</th><th className="w-60 px-5 py-3 text-right">Controls</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={6} className="px-5 py-7 text-center text-[10px] font-mono text-white/25">{node.paused ? 'Queue paused — no active or waiting items.' : 'Queue empty — waiting for work.'}</td></tr> : rows.map(({ item, lane, active }) => (
              <tr key={`${active ? 'active' : 'queued'}:${item.id}`} className="border-b border-white/5 last:border-0 align-middle">
                <td className="px-5 py-4"><span className="block text-[9px] font-bold uppercase tracking-widest" style={{ color: active ? accent : 'rgba(255,255,255,.35)' }}>{lane}</span><span className="mt-1 block text-[9px] font-mono capitalize text-white/30">{item.status}</span></td>
                <td className="px-3 py-4"><div className="truncate text-xs font-medium text-white/80" title={item.title}>{item.title}</div></td>
                <td className="px-3 py-4"><div className="text-[11px] text-white/65">{item.process}</div>{item.detail && item.detail !== item.process && <div className="mt-1 truncate text-[9px] font-mono text-white/28">{item.detail}</div>}</td>
                <td className="px-3 py-4"><Progress item={item} accent={accent} /></td>
                <td className="px-3 py-4 text-[10px] font-mono text-white/55">{!active ? 'Waiting' : item.status === 'paused' ? 'Paused' : item.progress != null && item.progress >= 1 ? 'Finalising…' : formatEta(item.etaSeconds)}</td>
                <td className="px-5 py-4"><ItemControls node={node} item={item} busy={busy === `${node.id}:${item.id}`} onControl={onControl} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {node.sharedWith && <div className="border-t border-white/5 px-5 py-3 text-[9px] font-mono text-white/25">This flow is part of the same media job as {node.sharedWith}; stopping it stops the combined job.</div>}
      </div>
    </section>
  )
}

export function ProcessingMonitorTab({ nodeIds, title = 'Processing Queue' }: { nodeIds?: ProcessingMonitorNode['id'][]; title?: string } = {}) {
  const [data, setData] = useState<ProcessingMonitorStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => sharedApi.system.processingMonitor().then(value => { setData(value); setError('') }).catch(reason => setError(String(reason)))

  useEffect(() => {
    load()
    const timer = setInterval(load, 1500)
    return () => clearInterval(timer)
  }, [])

  const visibleNodes = useMemo(() => data?.nodes.filter(node => !nodeIds || nodeIds.includes(node.id)) ?? [], [data, nodeIds])
  const primaryNodes = useMemo(() => visibleNodes.filter(node => !node.sharedWith), [visibleNodes])
  const setNodePause = async (node: ProcessingMonitorNode) => {
    setBusy(node.id)
    try { await sharedApi.system.setProcessingNodePaused(node.id, !node.paused); await load() }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(null) }
  }
  const controlItem = async (node: ProcessingMonitorNode, item: ProcessingMonitorItem, action: ItemAction) => {
    if ((action === 'cancel' || action === 'skip') && !confirm(`${action === 'skip' ? 'Skip' : 'Cancel'} ${node.label.toLowerCase()} for “${item.title}”?`)) return
    setBusy(`${node.id}:${item.id}`)
    try { await sharedApi.system.controlProcessingItem(node.id, item.id, action); await load() }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(null) }
  }
  const setAll = async (paused: boolean) => {
    setBusy('all')
    try { await Promise.all(primaryNodes.map(node => sharedApi.system.setProcessingNodePaused(node.id, paused))); await load() }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(null) }
  }

  if (!data) return <div className="text-xs font-mono text-white/35">{error || 'Loading processing monitor…'}</div>
  const r = data.summary.resources
  const visibleActive = primaryNodes.reduce((sum, node) => sum + node.activeCount, 0)
  const visibleQueued = primaryNodes.reduce((sum, node) => sum + node.queuedCount, 0)
  const visiblePaused = primaryNodes.filter(node => node.paused).length
  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-noir-900 border border-white/5 shadow-2xl px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div><h2 className="text-sm font-medium text-white uppercase tracking-widest">{title}</h2><p className="text-[10px] font-mono text-white/30 mt-1">Live state across background media workers.</p></div>
          <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono uppercase tracking-widest">
            <span className="text-[#00D4FF]">{visibleActive} active</span><span className="text-white/35">{visibleQueued} queued</span><span className="text-amber-300/70">{visiblePaused} paused</span>
            <span className="text-white/25">CPU {r.cpuPercent}% · RAM {r.memPercent}% · GPU {r.gpuPercent == null ? 'n/a' : `${r.gpuPercent}%`}</span>
            <button disabled={busy === 'all'} onClick={() => setAll(true)} className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/45 hover:text-white disabled:opacity-40">Pause all</button>
            <button disabled={busy === 'all'} onClick={() => setAll(false)} className="px-3 py-1.5 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/20 text-[#00D4FF] disabled:opacity-40">Resume all</button>
          </div>
        </div>
        {error && <div className="mt-4 px-3 py-2 rounded-lg bg-red-500/5 border border-red-400/15 text-[10px] font-mono text-red-300/70">{error}</div>}
      </div>
      <div className="space-y-4">{visibleNodes.map(node => <NodeCard key={node.id} node={node} busy={busy} onPause={setNodePause} onControl={controlItem} />)}</div>
    </div>
  )
}
