import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Modal } from './ui.js'

export interface AcquisitionHistory { decisions: any[]; blocks: any[] }

export function AcquisitionHistoryModal({ history, onClose }: { history: AcquisitionHistory | null; onClose: () => void }) {
  const decisions = history?.decisions ?? []
  const blocks = history?.blocks ?? []
  return (
    <Modal title="Acquisitions" onClose={onClose} width="max-w-3xl">
      <div className="grid md:grid-cols-2 gap-6 max-h-[65vh] overflow-y-auto custom-scrollbar pr-1">
        <div className="space-y-3">
          <p className="text-[9px] font-mono uppercase tracking-widest text-white/25">Recent Decisions ({decisions.length})</p>
          {decisions.length ? decisions.slice(0, 40).map((decision, i) => (
            <div key={decision.id ?? i} className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
              <div className="flex items-center gap-2">
                <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest ${decision.accepted ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                  {decision.accepted ? 'Accepted' : 'Rejected'}
                </span>
                {decision.grabbed ? <span className="text-[8px] px-1.5 py-0.5 rounded bg-[#00D4FF]/10 text-[#00D4FF] font-bold uppercase tracking-widest">Grabbed</span> : null}
                {decision.subject_title ? <span className="text-[8px] font-mono text-white/25 truncate">{decision.subject_title}</span> : null}
              </div>
              <p className="mt-2 text-xs text-white/70 truncate">{decision.release_title}</p>
              <p className="mt-1 text-[10px] font-mono text-white/25 truncate">{decision.rejection_reasons || decision.reasons}</p>
            </div>
          )) : <p className="text-xs text-white/25">No acquisition decisions recorded yet.</p>}
        </div>
        <div className="space-y-3">
          <p className="text-[9px] font-mono uppercase tracking-widest text-white/25">Release Blocks ({blocks.length})</p>
          {blocks.length ? blocks.slice(0, 40).map((block, i) => (
            <div key={block.id ?? i} className="rounded-xl bg-amber-500/5 border border-amber-500/10 p-3">
              <p className="text-xs text-white/70 truncate">{block.release_title}</p>
              <p className="mt-1 text-[10px] font-mono text-amber-300/70">{block.reason}</p>
            </div>
          )) : <p className="text-xs text-white/25">No blocked releases.</p>}
        </div>
      </div>
    </Modal>
  )
}

export interface ReacquireItem { id: number; label: string; sublabel?: string }

export function ReacquireSelectorModal({ title, items, accent = '#00D4FF', onConfirm, onClose }: {
  title: string
  items: ReacquireItem[]
  accent?: string
  onConfirm: (ids: number[]) => Promise<void>
  onClose: () => void
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const allSelected = items.length > 0 && selected.size === items.length
  const toggle = (id: number) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const confirm = async () => {
    if (selected.size === 0) return
    setBusy(true)
    try { await onConfirm([...selected]); onClose() }
    catch (err) { alert(String(err)) }
    finally { setBusy(false) }
  }

  return (
    <Modal title={title} onClose={onClose} width="max-w-lg">
      <div className="flex flex-col max-h-[70vh]">
        <button onClick={() => setSelected(allSelected ? new Set() : new Set(items.map(i => i.id)))}
          className="self-start mb-3 text-[10px] font-bold uppercase tracking-widest text-white/40 hover:text-white transition-all">
          {allSelected ? 'Clear all' : 'Select all'}
        </button>
        <div className="flex-1 overflow-y-auto custom-scrollbar space-y-1.5 pr-1">
          {items.length === 0 ? (
            <p className="text-xs text-white/30 py-6 text-center">Nothing to reacquire.</p>
          ) : items.map(it => {
            const on = selected.has(it.id)
            return (
              <button key={it.id} onClick={() => toggle(it.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${on ? 'border-white/20 bg-white/10' : 'border-white/5 bg-noir-900 hover:bg-white/5'}`}>
                <span className={`w-4 h-4 rounded flex items-center justify-center text-[10px] shrink-0 ${on ? 'text-noir-950' : 'text-transparent border border-white/20'}`}
                  style={on ? { background: accent } : undefined}>✓</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-white/80 truncate">{it.label}</span>
                  {it.sublabel && <span className="block text-[10px] font-mono text-white/30 truncate">{it.sublabel}</span>}
                </span>
              </button>
            )
          })}
        </div>
        <div className="flex items-center justify-between gap-3 pt-4 border-t border-white/5 mt-4">
          <span className="text-[10px] font-mono text-white/30 uppercase tracking-widest">{selected.size} selected</span>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white uppercase tracking-widest">Cancel</button>
            <button onClick={confirm} disabled={busy || selected.size === 0}
              className="px-8 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95 disabled:opacity-40"
              style={{ background: accent, color: '#0a0a0a' }}>
              {busy ? 'Reacquiring...' : 'Reacquire'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export type ReacquireConfig =
  | { mode: 'direct'; run: () => Promise<void> }
  | { mode: 'select'; title: string; items: ReacquireItem[]; runSelected: (ids: number[]) => Promise<void> }

/**
 * The standard item Actions section: Reacquire, Acquisitions, Remove, Delete,
 * Edit — styled to match the acquisition console (heading + divider, card,
 * equal-width buttons). Reacquire is either direct (single item) or opens a
 * child selector (containers). Used across every media type.
 */
export function ItemActionsBar({ accent = '#00D4FF', reacquire, loadHistory, onRemove, onDelete, onEdit, extra, containerClass = 'col-span-12 pt-8' }: {
  accent?: string
  reacquire: ReacquireConfig
  loadHistory: () => Promise<AcquisitionHistory>
  onRemove: () => void
  onDelete: () => void
  onEdit: () => void
  extra?: ReactNode
  containerClass?: string
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<AcquisitionHistory | null>(null)
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const btns = Array.from(el.querySelectorAll('button')) as HTMLButtonElement[]
    btns.forEach(b => { b.style.width = 'auto' })
    const max = btns.reduce((m, b) => Math.max(m, b.offsetWidth), 0)
    if (max > 0) btns.forEach(b => { b.style.width = `${max}px` })
  }, [])

  const openHistory = async () => {
    setBusy('history')
    try { setHistory(await loadHistory()); setHistoryOpen(true) }
    catch (err) { alert(String(err)) }
    finally { setBusy(null) }
  }
  const doReacquire = async () => {
    if (reacquire.mode === 'select') { setSelectorOpen(true); return }
    if (!confirm('Reacquire this item? It will be reset and re-searched.')) return
    setBusy('reacquire')
    try { await reacquire.run() } catch (err) { alert(String(err)) } finally { setBusy(null) }
  }

  const cls = 'px-8 py-3 rounded-2xl bg-white/5 border border-white/10 text-white/60 hover:text-white transition-all font-bold tracking-widest text-[10px] uppercase shadow-xl disabled:opacity-40'
  const delCls = 'px-8 py-3 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-500 hover:bg-red-500/20 transition-all font-bold tracking-widest text-[10px] uppercase shadow-xl'

  return (
    <div className={containerClass}>
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-6 flex-1">
          <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest whitespace-nowrap">Actions</h3>
          <div className="h-px flex-1 bg-white/5" />
        </div>
      </div>
      <div className="rounded-2xl bg-noir-900/70 border border-white/5 px-4 py-4">
        <div ref={ref} className="flex flex-wrap items-center gap-4">
          {extra}
          <button onClick={doReacquire} disabled={busy === 'reacquire'} className={cls}>{busy === 'reacquire' ? '...' : 'Reacquire'}</button>
          <button onClick={openHistory} disabled={busy === 'history'} className={cls}>{busy === 'history' ? '...' : 'Acquisitions'}</button>
          <button onClick={onRemove} className={cls}>Remove</button>
          <button onClick={onDelete} className={delCls}>Delete</button>
          <button onClick={onEdit} className={`${cls} ml-auto`}>Edit</button>
        </div>
      </div>

      {historyOpen && <AcquisitionHistoryModal history={history} onClose={() => setHistoryOpen(false)} />}
      {selectorOpen && reacquire.mode === 'select' && (
        <ReacquireSelectorModal
          title={reacquire.title}
          items={reacquire.items}
          accent={accent}
          onClose={() => setSelectorOpen(false)}
          onConfirm={reacquire.runSelected}
        />
      )}
    </div>
  )
}
