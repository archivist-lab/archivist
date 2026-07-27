import { useEffect, useState } from 'react'
import { confirmDialog, toast } from '../lib/notify.js'
import { sharedApi } from '../lib/shared.api.js'
import { Modal, Spinner } from './ui.js'

type EditorData = Awaited<ReturnType<typeof sharedApi.system.episodeLoudnessEditor>>

export function EpisodeLoudnessEditorModal({ episodeId, title, onClose, onQueued }: {
  episodeId: number
  title: string
  onClose: () => void
  onQueued?: () => void
}) {
  const [data, setData] = useState<EditorData | null>(null)
  const [target, setTarget] = useState(-16)
  const [loadedTarget, setLoadedTarget] = useState(-16)
  const [loading, setLoading] = useState(true)
  const [rewriting, setRewriting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (nextTarget: number) => {
    setLoading(true)
    setError(null)
    try {
      const result = await sharedApi.system.episodeLoudnessEditor(episodeId, nextTarget)
      setData(result)
      setLoadedTarget(result.targetLufs)
      setTarget(result.targetLufs)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load(-16) }, [episodeId])

  const rewrite = async () => {
    if (!await confirmDialog(`Rewrite the default audio track at ${target.toFixed(1)} LUFS?\n\nThis re-encodes that audio track and atomically replaces the media file after validation. Video, subtitles and chapters are preserved.`)) return
    setRewriting(true)
    try {
      const result = await sharedApi.system.rewriteEpisodeLoudness(episodeId, target)
      toast.info(result.queued ? 'Volume normalisation queued' : 'This episode is already queued for volume normalisation')
      onQueued?.()
      onClose()
    } catch (err) { toast.error(err instanceof Error ? err.message : String(err)) }
    finally { setRewriting(false) }
  }

  return (
    <Modal title={`Volume Normalisation: ${title}`} onClose={onClose} width="max-w-5xl">
      <div className="space-y-6 max-h-[76vh] overflow-y-auto custom-scrollbar pr-2">
        {loading && !data ? (
          <div className="py-24 flex flex-col items-center gap-4 text-white/30"><Spinner className="w-8 h-8" /><p className="text-[10px] font-mono uppercase tracking-widest">Measuring audio and rendering waveforms…</p></div>
        ) : error ? (
          <div className="py-16 text-center space-y-4"><p className="text-xs font-mono text-red-400">{error}</p><button onClick={() => void load(target)} className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-[10px] uppercase tracking-widest text-white/50">Retry</button></div>
        ) : data ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/5 bg-white/[0.02] p-4">
              <div><p className="text-[9px] font-mono uppercase tracking-widest text-white/25">Audio track</p><p className="text-xs text-white/70 mt-1">{data.track.title || 'Default Audio'} · {data.track.codec?.toUpperCase() || 'Unknown'}{data.track.channels ? ` · ${data.track.channels} channels` : ''}</p></div>
              <div className="grid grid-cols-3 gap-6 text-right">
                <div><p className="text-[9px] font-mono uppercase text-white/25">Measured</p><p className="text-sm font-mono text-white/70">{data.measured.integratedLufs.toFixed(1)} LUFS</p></div>
                <div><p className="text-[9px] font-mono uppercase text-white/25">True peak</p><p className="text-sm font-mono text-white/70">{data.measured.truePeak.toFixed(1)} dBTP</p></div>
                <div><p className="text-[9px] font-mono uppercase text-white/25">Range</p><p className="text-sm font-mono text-white/70">{data.measured.lra.toFixed(1)} LU</p></div>
              </div>
            </div>

            <Waveform label="Original waveform" image={data.originalWaveform} detail={`${data.measured.integratedLufs.toFixed(1)} LUFS`} />
            <Waveform label="Normalised waveform" image={data.normalizedWaveform} detail={`${loadedTarget.toFixed(1)} LUFS target · ${(loadedTarget - data.measured.integratedLufs) >= 0 ? '+' : ''}${(loadedTarget - data.measured.integratedLufs).toFixed(1)} dB estimated gain`} />

            <section className="rounded-xl border border-[#9B59B6]/20 bg-[#9B59B6]/5 p-5 space-y-4">
              <div className="flex items-center justify-between gap-4"><div><h4 className="text-[10px] font-bold uppercase tracking-widest text-[#C89BE0]">Fine tune target</h4><p className="text-[9px] font-mono text-white/30 mt-1">Quieter ← broadcast / cinema · louder → personal playback</p></div><span className="text-xl font-mono font-bold text-white">{target.toFixed(1)} LUFS</span></div>
              <input type="range" min="-24" max="-8" step="0.5" value={target} onChange={event => setTarget(Number(event.target.value))} className="w-full accent-[#9B59B6]" />
              <div className="flex justify-between text-[9px] font-mono text-white/20"><span>-24</span><span>-16 recommended</span><span>-8</span></div>
              {target !== loadedTarget && <button onClick={() => void load(target)} disabled={loading} className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-[9px] font-bold uppercase tracking-widest text-white/50 hover:text-white disabled:opacity-40">{loading ? 'Rendering…' : 'Refresh Normalised Waveform'}</button>}
            </section>

            <div className="rounded-xl border border-amber-500/15 bg-amber-500/5 p-4 text-[10px] leading-relaxed text-amber-200/60">
              Rewriting is intentionally explicit: Archivist re-encodes only the default audio stream, validates the output, atomically replaces the file, re-measures loudness, and queues fresh intro/credit fingerprints. Other tracks and the video stream are copied unchanged.
            </div>

            <div className="flex justify-end gap-3 pt-5 border-t border-white/5"><button onClick={onClose} className="px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-white/40 hover:text-white">Cancel</button><button onClick={rewrite} disabled={rewriting || loading || target !== loadedTarget} title={target !== loadedTarget ? 'Refresh the waveform for this target before rewriting' : undefined} className="px-7 py-2.5 rounded-xl bg-[#9B59B6] text-white text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">{rewriting ? 'Queuing…' : 'Rewrite Audio Track'}</button></div>
          </>
        ) : null}
      </div>
    </Modal>
  )
}

function Waveform({ label, image, detail }: { label: string; image: string; detail: string }) {
  return <section className="space-y-2"><div className="flex justify-between gap-3"><h4 className="text-[10px] font-mono uppercase tracking-widest text-white/40">{label}</h4><span className="text-[9px] font-mono text-white/25">{detail}</span></div><div className="h-[150px] rounded-xl border border-white/5 bg-black/30 overflow-hidden"><img src={image} alt={label} className="w-full h-full object-fill opacity-90" /></div></section>
}
