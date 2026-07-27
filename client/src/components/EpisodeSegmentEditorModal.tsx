import { useEffect, useState } from 'react'
import { confirmDialog, toast } from '../lib/notify.js'
import { sharedApi } from '../lib/shared.api.js'
import { Input, Modal, Select, Spinner } from './ui.js'

type SegmentKind = 'intro' | 'credits'
interface SegmentRow { kind: SegmentKind; start: string; end: string; method?: string; confidence?: number }

const LABELS: Record<SegmentKind, string> = { intro: 'Intro', credits: 'Credits' }

function secondsToStamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = (seconds % 60).toFixed(3).replace(/\.?0+$/, '')
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function stampToSeconds(value: string): number | null {
  const text = value.trim()
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text)
  const parts = text.split(':').map(Number)
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isFinite(part))) return null
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0], parts[1]]
  if (minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null
  return hours * 3600 + minutes * 60 + seconds
}

export function EpisodeSegmentEditorModal({ episodeId, title, onClose, onSaved }: {
  episodeId: number
  title: string
  onClose: () => void
  onSaved?: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<SegmentRow[]>([])
  const [newKind, setNewKind] = useState<SegmentKind>('intro')
  const [analysis, setAnalysis] = useState<{ state: string; analysedAt: string | null; manuallyLocked: boolean } | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    sharedApi.system.episodeSegments(episodeId)
      .then(result => {
        const next: SegmentRow[] = []
        if (result.segments?.intro) next.push({ kind: 'intro', start: secondsToStamp(result.segments.intro.start), end: secondsToStamp(result.segments.intro.end), method: result.segments.intro.method, confidence: result.segments.intro.confidence })
        if (result.segments?.credits) next.push({ kind: 'credits', start: secondsToStamp(result.segments.credits.start), end: secondsToStamp(result.segments.credits.end), method: result.segments.credits.method, confidence: result.segments.credits.confidence })
        setRows(next)
        setAnalysis(result.segmentAnalysis)
        const missing = (['intro', 'credits'] as SegmentKind[]).find(kind => !next.some(row => row.kind === kind))
        if (missing) setNewKind(missing)
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [episodeId])

  const addSegment = () => {
    const kind = rows.some(row => row.kind === newKind)
      ? (['intro', 'credits'] as SegmentKind[]).find(candidate => !rows.some(row => row.kind === candidate))
      : newKind
    if (!kind) return
    setRows(current => [...current, { kind, start: '', end: '' }])
    const nextMissing = (['intro', 'credits'] as SegmentKind[]).find(candidate => candidate !== kind && !rows.some(row => row.kind === candidate))
    if (nextMissing) setNewKind(nextMissing)
  }

  const save = async () => {
    const parsed = new Map<SegmentKind, { start: number; end: number }>()
    for (const row of rows) {
      const start = stampToSeconds(row.start)
      const end = stampToSeconds(row.end)
      if (start === null || end === null || end <= start) {
        toast.error(`${LABELS[row.kind]} needs valid start and end markers, with the end after the start.`)
        return
      }
      parsed.set(row.kind, { start, end })
    }
    setSaving(true)
    try {
      const intro = parsed.get('intro')
      const credits = parsed.get('credits')
      await sharedApi.system.updateEpisodeSegments(episodeId, {
        introStart: intro?.start ?? null, introEnd: intro?.end ?? null,
        creditsStart: credits?.start ?? null, creditsEnd: credits?.end ?? null,
        locked: true,
      })
      toast.success('Episode segments updated')
      onSaved?.()
      onClose()
    } catch (err) { toast.error(err instanceof Error ? err.message : String(err)) }
    finally { setSaving(false) }
  }

  const reset = async () => {
    if (!await confirmDialog('Reset these markers to Archivist’s detected scan values? Manual edits will be discarded.')) return
    setResetting(true)
    try {
      const result = await sharedApi.system.resetEpisodeSegments(episodeId)
      if (result.restored) {
        toast.success('Scan values restored')
        load()
      } else {
        toast.info('No saved scan baseline existed, so a fresh season analysis was queued.')
        onSaved?.()
        onClose()
      }
    } catch (err) { toast.error(err instanceof Error ? err.message : String(err)) }
    finally { setResetting(false) }
  }

  const availableKinds = (['intro', 'credits'] as SegmentKind[]).filter(kind => !rows.some(row => row.kind === kind))

  return (
    <Modal title={`Edit Segments: ${title}`} onClose={onClose} width="max-w-3xl">
      <div className="space-y-6 max-h-[72vh] overflow-y-auto custom-scrollbar pr-2">
        {loading ? (
          <div className="py-20 flex items-center justify-center gap-3 text-white/30"><Spinner className="w-6 h-6" /> Loading detected markers…</div>
        ) : error ? (
          <p className="py-16 text-center text-xs font-mono text-red-400">{error}</p>
        ) : (
          <>
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[9px] font-mono uppercase tracking-widest text-white/25">Analysis state</p>
                <p className="text-xs text-white/70 mt-1 uppercase">{analysis?.state ?? 'Not analysed'}{analysis?.manuallyLocked ? ' · Manual override locked' : ''}</p>
              </div>
              {analysis?.analysedAt && <span className="text-[9px] font-mono text-white/25">Scanned {new Date(analysis.analysedAt).toLocaleString()}</span>}
            </div>

            <div className="space-y-3">
              {rows.length === 0 && <p className="py-8 text-center text-[10px] font-mono uppercase tracking-widest text-white/25">No intro or credit markers detected. Add one below.</p>}
              {rows.map((row, index) => (
                <div key={row.kind} className="rounded-xl border border-white/5 bg-noir-900/50 p-4 space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-[#00D4FF]">{LABELS[row.kind]}</p>
                      {row.method && <p className="text-[9px] font-mono text-white/25 mt-1">{row.method}{row.confidence != null ? ` · ${Math.round(row.confidence * 100)}% confidence` : ''}</p>}
                    </div>
                    <button onClick={() => setRows(current => current.filter(item => item.kind !== row.kind))} className="w-8 h-8 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-all">✕</button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="space-y-1"><span className="text-[9px] font-mono uppercase tracking-widest text-white/25">Start</span><Input value={row.start} placeholder="0:00:00" className="font-mono" onChange={event => setRows(current => current.map((item, i) => i === index ? { ...item, start: event.target.value } : item))} /></label>
                    <label className="space-y-1"><span className="text-[9px] font-mono uppercase tracking-widest text-white/25">End</span><Input value={row.end} placeholder="0:01:30" className="font-mono" onChange={event => setRows(current => current.map((item, i) => i === index ? { ...item, end: event.target.value } : item))} /></label>
                  </div>
                </div>
              ))}
            </div>

            {availableKinds.length > 0 && (
              <div className="flex items-center gap-3">
                <div className="w-48"><Select value={availableKinds.includes(newKind) ? newKind : availableKinds[0]} onChange={event => setNewKind(event.target.value as SegmentKind)}>{availableKinds.map(kind => <option key={kind} value={kind}>{LABELS[kind]}</option>)}</Select></div>
                <button onClick={addSegment} className="px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-[10px] font-bold uppercase tracking-widest text-white/50 hover:text-white transition-all">+ Add Segment</button>
              </div>
            )}

            <div className="flex flex-wrap justify-between gap-3 pt-5 border-t border-white/5">
              <button onClick={reset} disabled={resetting || saving} className="px-5 py-2.5 rounded-xl border border-amber-500/25 bg-amber-500/10 text-amber-400 text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">{resetting ? 'Resetting…' : 'Reset to Scan Values'}</button>
              <div className="flex gap-3"><button onClick={onClose} className="px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-white/40 hover:text-white">Cancel</button><button onClick={save} disabled={saving || resetting} className="px-7 py-2.5 rounded-xl bg-[#00D4FF] text-noir-950 text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">{saving ? 'Saving…' : 'Save Segments'}</button></div>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
