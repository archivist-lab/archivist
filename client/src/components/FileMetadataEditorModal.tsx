import { useEffect, useState } from 'react'
import { Modal, Input, Spinner } from './ui.js'
import { sharedApi } from '../lib/shared.api.js'

interface ChapterRow {
  title: string
  start: string
}

interface StreamRow {
  typeIndex: number
  language?: string
  codec?: string
  channels?: number
  title: string
}

function secondsToStamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const secs = s.toFixed(3).replace(/\.?0+$/, '') || '0'
  const pad = (v: number | string) => String(v).padStart(2, '0')
  return `${h}:${pad(m)}:${pad(Number.isInteger(Number(secs)) ? secs : Number(secs).toFixed(3))}`
}

/** Accepts H:MM:SS(.ms), MM:SS(.ms) or plain seconds. Returns null when unparsable. */
function stampToSeconds(stamp: string): number | null {
  const trimmed = stamp.trim()
  if (!trimmed) return null
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed)
  const parts = trimmed.split(':').map(p => p.trim())
  if (parts.length < 2 || parts.length > 3 || parts.some(p => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null
  const nums = parts.map(parseFloat)
  const [h, m, s] = parts.length === 3 ? nums : [0, nums[0], nums[1]]
  if (m >= 60 || s >= 60) return null
  return h * 3600 + m * 60 + s
}

/**
 * Edits metadata embedded in the media file itself: chapter titles/timestamps
 * and audio/subtitle track titles. Saving performs a lossless remux on the
 * server and atomically replaces the file.
 */
export function FileMetadataEditorModal({ filePath, onClose, onSaved }: {
  filePath: string
  onClose: () => void
  onSaved?: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [chapters, setChapters] = useState<ChapterRow[]>([])
  const [audioTracks, setAudioTracks] = useState<StreamRow[]>([])
  const [subtitleTracks, setSubtitleTracks] = useState<StreamRow[]>([])
  const [initial, setInitial] = useState<{ chapters: ChapterRow[]; audio: string[]; subs: string[] }>({ chapters: [], audio: [], subs: [] })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    sharedApi.media.readFileMetadata(filePath)
      .then(meta => {
        const chapterRows = meta.chapters.map(ch => ({ title: ch.title, start: secondsToStamp(ch.startTime) }))
        const audioRows = meta.audioTracks.map(t => ({ ...t, title: t.title ?? '' }))
        const subRows = meta.subtitleTracks.map(t => ({ ...t, title: t.title ?? '' }))
        setChapters(chapterRows)
        setAudioTracks(audioRows)
        setSubtitleTracks(subRows)
        setDuration(meta.durationSeconds)
        setInitial({
          chapters: chapterRows.map(c => ({ ...c })),
          audio: audioRows.map(t => t.title),
          subs: subRows.map(t => t.title),
        })
      })
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false))
  }, [filePath])

  const handleSave = async () => {
    const chaptersChanged = JSON.stringify(chapters) !== JSON.stringify(initial.chapters)
    const audioTitles: Record<number, string> = {}
    audioTracks.forEach((t, i) => { if (t.title !== initial.audio[i]) audioTitles[t.typeIndex] = t.title })
    const subtitleTitles: Record<number, string> = {}
    subtitleTracks.forEach((t, i) => { if (t.title !== initial.subs[i]) subtitleTitles[t.typeIndex] = t.title })

    if (!chaptersChanged && Object.keys(audioTitles).length === 0 && Object.keys(subtitleTitles).length === 0) {
      onClose()
      return
    }

    let parsedChapters: Array<{ title: string; startTime: number }> | undefined
    if (chaptersChanged) {
      parsedChapters = []
      for (const [i, ch] of chapters.entries()) {
        const startTime = stampToSeconds(ch.start)
        if (startTime === null) {
          alert(`Chapter ${i + 1}: invalid timestamp "${ch.start}" (use H:MM:SS or seconds)`)
          return
        }
        parsedChapters.push({ title: ch.title, startTime })
      }
    }

    setSaving(true)
    try {
      const result = await sharedApi.media.writeFileMetadata(filePath, {
        chapters: parsedChapters,
        audioTitles: Object.keys(audioTitles).length ? audioTitles : undefined,
        subtitleTitles: Object.keys(subtitleTitles).length ? subtitleTitles : undefined,
      })
      if (!result.success) {
        alert(`Failed to write metadata: ${result.message}`)
        return
      }
      onSaved?.()
      onClose()
    } catch (err) {
      alert(String(err))
    } finally {
      setSaving(false)
    }
  }

  const sectionTitle = (label: string, hint?: string) => (
    <div className="flex items-center justify-between">
      <h4 className="text-[10px] font-mono text-white/40 uppercase tracking-widest">{label}</h4>
      {hint && <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">{hint}</span>}
    </div>
  )

  return (
    <Modal title="Edit File Metadata" onClose={onClose} width="max-w-3xl">
      <div className="flex flex-col max-h-[70vh]">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 space-y-4">
            <Spinner className="w-10 h-10" />
            <p className="text-[10px] font-mono text-white/20 uppercase tracking-widest animate-pulse">Probing file...</p>
          </div>
        ) : error ? (
          <div className="py-16 text-center text-red-400 text-xs font-mono">{error}</div>
        ) : (
          <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-8">
            <p className="text-[10px] font-mono text-white/20 break-all">{filePath}</p>

            <section className="space-y-3">
              {sectionTitle('Chapters', duration ? `duration ${secondsToStamp(duration)}` : undefined)}
              {chapters.length === 0 && (
                <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest">No embedded chapters — add some below.</p>
              )}
              <div className="space-y-2">
                {chapters.map((ch, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="text-[10px] font-mono text-white/20 w-6 text-right">{i + 1}</span>
                    <div className="flex-1">
                      <Input value={ch.title} placeholder={`Chapter ${i + 1}`}
                        onChange={e => setChapters(chapters.map((c, j) => j === i ? { ...c, title: e.target.value } : c))} />
                    </div>
                    <div className="w-32">
                      <Input value={ch.start} placeholder="0:00:00"
                        className="font-mono text-right"
                        onChange={e => setChapters(chapters.map((c, j) => j === i ? { ...c, start: e.target.value } : c))} />
                    </div>
                    <button onClick={() => setChapters(chapters.filter((_, j) => j !== i))}
                      className="w-8 h-8 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-all text-sm">✕</button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setChapters([...chapters, { title: `Chapter ${chapters.length + 1}`, start: chapters.length === 0 ? '0:00:00' : '' }])}
                className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-white/40 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-all">
                + Add Chapter
              </button>
            </section>

            {audioTracks.length > 0 && (
              <section className="space-y-3">
                {sectionTitle('Audio Track Titles')}
                <div className="space-y-2">
                  {audioTracks.map((t, i) => (
                    <div key={t.typeIndex} className="flex items-center gap-3">
                      <span className="text-[10px] font-mono text-white/30 uppercase w-24 shrink-0">
                        {(t.language || 'und').toUpperCase()} · {t.codec?.toUpperCase() || '?'}{t.channels ? ` ${t.channels}ch` : ''}
                      </span>
                      <div className="flex-1">
                        <Input value={t.title} placeholder="(no title)"
                          onChange={e => setAudioTracks(audioTracks.map((row, j) => j === i ? { ...row, title: e.target.value } : row))} />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {subtitleTracks.length > 0 && (
              <section className="space-y-3">
                {sectionTitle('Subtitle Track Titles')}
                <div className="space-y-2">
                  {subtitleTracks.map((t, i) => (
                    <div key={t.typeIndex} className="flex items-center gap-3">
                      <span className="text-[10px] font-mono text-white/30 uppercase w-24 shrink-0">
                        {(t.language || 'und').toUpperCase()} · {t.codec?.toUpperCase() || '?'}
                      </span>
                      <div className="flex-1">
                        <Input value={t.title} placeholder="(no title)"
                          onChange={e => setSubtitleTracks(subtitleTracks.map((row, j) => j === i ? { ...row, title: e.target.value } : row))} />
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {!loading && !error && (
          <div className="flex items-center justify-between gap-3 pt-6 border-t border-white/5 mt-6">
            <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Lossless remux — no re-encode</p>
            <div className="flex gap-3">
              <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest">Cancel</button>
              <button onClick={handleSave} disabled={saving}
                className="px-8 py-2.5 rounded-xl bg-[#00D4FF] text-noir-950 text-xs font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95 disabled:opacity-50">
                {saving ? 'Writing to file...' : 'Write to File'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
