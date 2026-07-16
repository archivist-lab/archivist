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

function Progress({ item, accent }: { item: ProcessingMonitorItem; accent: string }) {
  const pct = item.progress == null ? null : Math.round(item.progress * 100)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-[10px] font-mono">
        <span className="text-white/45 truncate">{item.detail}</span>
        <span className="text-white/65 shrink-0">
          {pct == null ? 'Working…' : `${pct}%`}{item.speed ? ` · ${item.speed.toFixed(1)}×` : ''}{item.startedAt ? ` · ${formatElapsed(item.startedAt)}` : ''}
        </span>
      </div>
      <div className="h-2 rounded-full overflow-hidden bg-white/8">
        {pct == null ? (
          <div className="h-full w-1/3 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
        ) : (
          <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, backgroundColor: accent }} />
        )}
      </div>
    </div>
  )
}

function ItemControls({ node, item, onControl }: { node: ProcessingMonitorNode; item: ProcessingMonitorItem; onControl: (node: ProcessingMonitorNode, item: ProcessingMonitorItem, action: 'pause' | 'resume' | 'cancel') => void }) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {item.canPause && (
        <button onClick={() => onControl(node, item, item.status === 'paused' ? 'resume' : 'pause')}
          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[9px] font-bold uppercase tracking-widest text-white/55 hover:text-white">
          {item.status === 'paused' ? 'Resume' : 'Pause'}
        </button>
      )}
      {item.canCancel && (
        <button onClick={() => onControl(node, item, 'cancel')}
          className="px-3 py-1.5 rounded-lg bg-red-500/5 border border-red-400/15 text-[9px] font-bold uppercase tracking-widest text-red-300/60 hover:text-red-300">
          Cancel
        </button>
      )}
    </div>
  )
}

function NodeCard({ node, busy, onPause, onControl }: {
  node: ProcessingMonitorNode
  busy: string | null
  onPause: (node: ProcessingMonitorNode) => void
  onControl: (node: ProcessingMonitorNode, item: ProcessingMonitorItem, action: 'pause' | 'resume' | 'cancel') => void
}) {
  const [open, setOpen] = useState(false)
  const accent = NODE_ACCENT[node.id]
  const current = node.activeItems[0]
  const queueItems = [...node.activeItems.slice(1), ...node.queuedItems]
  return (
    <section className="rounded-2xl bg-noir-900 border border-white/5 shadow-2xl overflow-hidden">
      <div className="px-5 py-5 space-y-4">
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
            <span className="px-2.5 py-1 rounded-lg bg-black/30 text-[9px] font-mono uppercase tracking-widest text-white/40">{node.activeCount} active · {node.queuedCount} queued</span>
            <button disabled={busy === node.id} onClick={() => onPause(node)}
              className={`px-4 py-2 rounded-xl border text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40 ${node.paused ? 'bg-amber-400/15 border-amber-400/30 text-amber-300' : 'bg-white/5 border-white/10 text-white/55 hover:text-white'}`}>
              {node.paused ? '▶ Resume Queue' : node.pauseBehavior === 'after-current' && node.activeCount ? '⏸ Pause After Current' : '⏸ Pause Queue'}
            </button>
          </div>
        </div>

        {current ? (
          <div className="rounded-xl bg-black/35 border border-white/5 px-4 py-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-xs text-white/80 truncate">{current.title}</div>
                <div className="text-[9px] font-mono uppercase tracking-widest mt-1" style={{ color: accent }}>{current.status}</div>
              </div>
              <ItemControls node={node} item={current} onControl={onControl} />
            </div>
            <Progress item={current} accent={accent} />
          </div>
        ) : (
          <div className="rounded-xl bg-black/20 border border-white/5 px-4 py-4 text-[10px] font-mono text-white/25">{node.paused ? 'Queue paused — no item is currently running.' : 'Idle — waiting for work.'}</div>
        )}

        <button onClick={() => setOpen(value => !value)} className="w-full flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-white/35 hover:text-white/60">
          <span>Queue ({queueItems.length})</span><span>{open ? '▲' : '▼'}</span>
        </button>
      </div>
      {open && (
        <div className="border-t border-white/5 bg-black/20 max-h-72 overflow-y-auto custom-scrollbar">
          {queueItems.length === 0 ? <div className="px-5 py-5 text-[10px] font-mono text-white/25">Queue is empty.</div> : queueItems.map((item, index) => (
            <div key={item.id} className="px-5 py-3 flex items-center justify-between gap-4 border-b border-white/5 last:border-0">
              <div className="min-w-0 flex items-center gap-3"><span className="text-[9px] font-mono text-white/20 w-5">{index + 1}</span><div className="min-w-0"><div className="text-xs text-white/60 truncate">{item.title}</div><div className="text-[9px] font-mono text-white/25 mt-0.5">{item.detail}</div></div></div>
              <ItemControls node={node} item={item} onControl={onControl} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function ProcessingMonitorTab() {
  const [data, setData] = useState<ProcessingMonitorStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const load = () => sharedApi.system.processingMonitor().then(value => { setData(value); setError('') }).catch(reason => setError(String(reason)))

  useEffect(() => {
    load()
    const timer = setInterval(load, 1500)
    return () => clearInterval(timer)
  }, [])

  const primaryNodes = useMemo(() => data?.nodes.filter(node => !node.sharedWith) ?? [], [data])
  const setNodePause = async (node: ProcessingMonitorNode) => {
    setBusy(node.id)
    try { await sharedApi.system.setProcessingNodePaused(node.id, !node.paused); await load() }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(null) }
  }
  const controlItem = async (node: ProcessingMonitorNode, item: ProcessingMonitorItem, action: 'pause' | 'resume' | 'cancel') => {
    if (action === 'cancel' && !confirm(`Cancel processing for “${item.title}”?`)) return
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
  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-noir-900 border border-white/5 shadow-2xl px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div><h2 className="text-sm font-medium text-white uppercase tracking-widest">All Processing</h2><p className="text-[10px] font-mono text-white/30 mt-1">Live state across background media workers.</p></div>
          <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono uppercase tracking-widest">
            <span className="text-[#00D4FF]">{data.summary.active} active</span><span className="text-white/35">{data.summary.queued} queued</span><span className="text-amber-300/70">{data.summary.paused} paused</span>
            <span className="text-white/25">CPU {r.cpuPercent}% · RAM {r.memPercent}% · GPU {r.gpuPercent == null ? 'n/a' : `${r.gpuPercent}%`}</span>
            <button disabled={busy === 'all'} onClick={() => setAll(true)} className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/45 hover:text-white disabled:opacity-40">Pause all</button>
            <button disabled={busy === 'all'} onClick={() => setAll(false)} className="px-3 py-1.5 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/20 text-[#00D4FF] disabled:opacity-40">Resume all</button>
          </div>
        </div>
        {error && <div className="mt-4 px-3 py-2 rounded-lg bg-red-500/5 border border-red-400/15 text-[10px] font-mono text-red-300/70">{error}</div>}
      </div>
      <div className="space-y-4">{data.nodes.map(node => <NodeCard key={node.id} node={node} busy={busy} onPause={setNodePause} onControl={controlItem} />)}</div>
    </div>
  )
}
