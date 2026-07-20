import { useEffect, useState } from 'react'
import { Modal, Input, Select, Spinner } from './ui.js'
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
  /** Marked for permanent removal from the file on save. */
  removed?: boolean
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

/** Which section(s) the editor exposes. Save still only writes what changed. */
export type FileMetadataMode = 'chapters' | 'audio' | 'subtitles' | 'all'

const MODE_TITLE: Record<FileMetadataMode, string> = {
  chapters: 'Edit Chapters',
  audio: 'Edit Audio Streams',
  subtitles: 'Edit Subtitles',
  all: 'Edit File Metadata',
}

const LANGUAGES = [
  ['und', 'Undetermined'], ['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'],
  ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'], ['nld', 'Dutch'],
  ['ara', 'Arabic'], ['hin', 'Hindi'], ['jpn', 'Japanese'], ['kor', 'Korean'],
  ['zho', 'Chinese'], ['rus', 'Russian'], ['tur', 'Turkish'], ['pol', 'Polish'],
  ['swe', 'Swedish'], ['nor', 'Norwegian'], ['dan', 'Danish'], ['fin', 'Finnish'],
  ['ces', 'Czech'], ['ell', 'Greek'], ['heb', 'Hebrew'], ['tha', 'Thai'],
  ['vie', 'Vietnamese'], ['ind', 'Indonesian'], ['ukr', 'Ukrainian'], ['ron', 'Romanian'],
] as const

interface TrackPreviewState {
  type: 'audio' | 'subtitle'
  typeIndex: number
  loading: boolean
  url?: string
  text?: string
  startSeconds?: number
  durationSeconds?: number
  error?: string
}

/**
 * Edits metadata embedded in the media file itself: chapter titles/timestamps
 * and audio/subtitle track titles and languages. Saving performs a lossless remux on the
 * server and atomically replaces the file. `mode` limits which section shows.
 */
export function FileMetadataEditorModal({ filePath, mode = 'all', onClose, onSaved }: {
  filePath: string
  mode?: FileMetadataMode
  onClose: () => void
  onSaved?: () => void
}) {
  const show = (s: 'chapters' | 'audio' | 'subtitles') => mode === 'all' || mode === s
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [chapters, setChapters] = useState<ChapterRow[]>([])
  const [audioTracks, setAudioTracks] = useState<StreamRow[]>([])
  const [subtitleTracks, setSubtitleTracks] = useState<StreamRow[]>([])
  const [initial, setInitial] = useState<{ chapters: ChapterRow[]; audio: string[]; subs: string[]; audioLanguages: string[]; subtitleLanguages: string[] }>({ chapters: [], audio: [], subs: [], audioLanguages: [], subtitleLanguages: [] })
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<TrackPreviewState | null>(null)

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
          audioLanguages: audioRows.map(t => t.language ?? ''),
          subtitleLanguages: subRows.map(t => t.language ?? ''),
        })
      })
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false))
  }, [filePath])

  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url) }, [preview?.url])

  const handleSave = async () => {
    const chaptersChanged = JSON.stringify(chapters) !== JSON.stringify(initial.chapters)
    const removeAudio = audioTracks.filter(t => t.removed).map(t => t.typeIndex)
    const removeSubtitles = subtitleTracks.filter(t => t.removed).map(t => t.typeIndex)
    const audioTitles: Record<number, string> = {}
    audioTracks.forEach((t, i) => { if (!t.removed && t.title !== initial.audio[i]) audioTitles[t.typeIndex] = t.title })
    const subtitleTitles: Record<number, string> = {}
    subtitleTracks.forEach((t, i) => { if (!t.removed && t.title !== initial.subs[i]) subtitleTitles[t.typeIndex] = t.title })
    const audioLanguages: Record<number, string> = {}
    audioTracks.forEach((t, i) => { if (!t.removed && (t.language ?? 'und') !== (initial.audioLanguages[i] || 'und')) audioLanguages[t.typeIndex] = t.language || 'und' })
    const subtitleLanguages: Record<number, string> = {}
    subtitleTracks.forEach((t, i) => { if (!t.removed && (t.language ?? 'und') !== (initial.subtitleLanguages[i] || 'und')) subtitleLanguages[t.typeIndex] = t.language || 'und' })

    const hasRemovals = removeAudio.length > 0 || removeSubtitles.length > 0
    if (!chaptersChanged && !hasRemovals && Object.keys(audioTitles).length === 0 && Object.keys(subtitleTitles).length === 0 && Object.keys(audioLanguages).length === 0 && Object.keys(subtitleLanguages).length === 0) {
      onClose()
      return
    }

    if (audioTracks.length > 0 && removeAudio.length === audioTracks.length) {
      alert('At least one audio track must remain in the file.')
      return
    }
    if (hasRemovals) {
      const n = removeAudio.length + removeSubtitles.length
      if (!confirm(`Permanently remove ${n} track${n === 1 ? '' : 's'} from the file?\n\nThe file is rewritten without ${n === 1 ? 'it' : 'them'} — this cannot be undone.`)) return
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
        audioLanguages: Object.keys(audioLanguages).length ? audioLanguages : undefined,
        subtitleLanguages: Object.keys(subtitleLanguages).length ? subtitleLanguages : undefined,
        removeAudio: removeAudio.length ? removeAudio : undefined,
        removeSubtitles: removeSubtitles.length ? removeSubtitles : undefined,
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

  const handlePreview = async (type: 'audio' | 'subtitle', typeIndex: number) => {
    if (preview?.url) URL.revokeObjectURL(preview.url)
    setPreview({ type, typeIndex, loading: true })
    try {
      const result = await sharedApi.media.previewTrack(filePath, type, typeIndex)
      if (type === 'audio') {
        setPreview({ type, typeIndex, loading: false, url: URL.createObjectURL(result.blob), startSeconds: result.startSeconds, durationSeconds: result.durationSeconds })
      } else {
        setPreview({ type, typeIndex, loading: false, text: await result.blob.text(), startSeconds: result.startSeconds, durationSeconds: result.durationSeconds })
      }
    } catch (err) {
      setPreview({ type, typeIndex, loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const sectionTitle = (label: string, hint?: string) => (
    <div className="flex items-center justify-between">
      <h4 className="text-[10px] font-mono text-white/40 uppercase tracking-widest">{label}</h4>
      {hint && <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">{hint}</span>}
    </div>
  )

  return (
    <Modal title={MODE_TITLE[mode]} onClose={onClose} width="max-w-3xl">
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

            {show('chapters') && (
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
            )}

            {show('audio') && audioTracks.length > 0 && (
              <section className="space-y-3">
                {sectionTitle('Audio Tracks', 'language, title, preview or remove')}
                <div className="space-y-2">
                  {audioTracks.map((t, i) => (
                    <div key={t.typeIndex} className={`flex flex-wrap sm:flex-nowrap items-center gap-2 ${t.removed ? 'opacity-45' : ''}`}>
                      <div className="w-36 shrink-0">
                        <Select value={t.language || 'und'} disabled={t.removed}
                          aria-label={`Audio track ${i + 1} language`}
                          onChange={e => setAudioTracks(audioTracks.map((row, j) => j === i ? { ...row, language: e.target.value } : row))}>
                          {t.language && !LANGUAGES.some(([code]) => code === t.language) && (
                            <option value={t.language}>{t.language.toUpperCase()} (existing)</option>
                          )}
                          {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
                        </Select>
                      </div>
                      <div className={`min-w-[12rem] flex-1 ${t.removed ? 'line-through' : ''}`}>
                        <Input value={t.title} placeholder={t.removed ? 'will be removed on save' : '(no title)'} disabled={t.removed}
                          aria-label={`Audio track ${i + 1} title`}
                          onChange={e => setAudioTracks(audioTracks.map((row, j) => j === i ? { ...row, title: e.target.value } : row))} />
                      </div>
                      <span className="text-[9px] font-mono uppercase text-white/25 shrink-0">{t.codec?.toUpperCase() || '?'}{t.channels ? ` · ${t.channels}ch` : ''}</span>
                      <button onClick={() => handlePreview('audio', t.typeIndex)} disabled={t.removed || preview?.loading}
                        className="px-3 h-9 rounded-lg bg-white/5 border border-white/10 text-[9px] font-bold uppercase tracking-widest text-white/50 hover:text-[#00D4FF] disabled:opacity-30 transition-all">
                        {preview?.loading && preview.type === 'audio' && preview.typeIndex === t.typeIndex ? 'Loading...' : 'Preview'}
                      </button>
                      <button
                        onClick={() => setAudioTracks(audioTracks.map((row, j) => j === i ? { ...row, removed: !row.removed } : row))}
                        title={t.removed ? 'Keep this track' : 'Remove this track from the file'}
                        className={`h-8 rounded-lg transition-all text-sm shrink-0 ${t.removed
                          ? 'px-3 text-[9px] font-bold uppercase tracking-widest text-white/50 hover:text-white bg-white/5 border border-white/10'
                          : 'w-8 text-white/20 hover:text-red-400 hover:bg-red-500/10'}`}>
                        {t.removed ? 'Undo' : '✕'}
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {show('subtitles') && subtitleTracks.length > 0 && (
              <section className="space-y-3">
                {sectionTitle('Subtitle Tracks', 'language, title, preview or remove')}
                <div className="space-y-2">
                  {subtitleTracks.map((t, i) => (
                    <div key={t.typeIndex} className={`flex flex-wrap sm:flex-nowrap items-center gap-2 ${t.removed ? 'opacity-45' : ''}`}>
                      <div className="w-36 shrink-0">
                        <Select value={t.language || 'und'} disabled={t.removed}
                          aria-label={`Subtitle track ${i + 1} language`}
                          onChange={e => setSubtitleTracks(subtitleTracks.map((row, j) => j === i ? { ...row, language: e.target.value } : row))}>
                          {t.language && !LANGUAGES.some(([code]) => code === t.language) && (
                            <option value={t.language}>{t.language.toUpperCase()} (existing)</option>
                          )}
                          {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
                        </Select>
                      </div>
                      <div className={`min-w-[12rem] flex-1 ${t.removed ? 'line-through' : ''}`}>
                        <Input value={t.title} placeholder={t.removed ? 'will be removed on save' : '(no title)'} disabled={t.removed}
                          aria-label={`Subtitle track ${i + 1} title`}
                          onChange={e => setSubtitleTracks(subtitleTracks.map((row, j) => j === i ? { ...row, title: e.target.value } : row))} />
                      </div>
                      <span className="text-[9px] font-mono uppercase text-white/25 shrink-0">{t.codec?.toUpperCase() || '?'}</span>
                      <button onClick={() => handlePreview('subtitle', t.typeIndex)} disabled={t.removed || preview?.loading}
                        className="px-3 h-9 rounded-lg bg-white/5 border border-white/10 text-[9px] font-bold uppercase tracking-widest text-white/50 hover:text-[#00D4FF] disabled:opacity-30 transition-all">
                        {preview?.loading && preview.type === 'subtitle' && preview.typeIndex === t.typeIndex ? 'Loading...' : 'Preview'}
                      </button>
                      <button
                        onClick={() => setSubtitleTracks(subtitleTracks.map((row, j) => j === i ? { ...row, removed: !row.removed } : row))}
                        title={t.removed ? 'Keep this track' : 'Remove this track from the file'}
                        className={`h-8 rounded-lg transition-all text-sm shrink-0 ${t.removed
                          ? 'px-3 text-[9px] font-bold uppercase tracking-widest text-white/50 hover:text-white bg-white/5 border border-white/10'
                          : 'w-8 text-white/20 hover:text-red-400 hover:bg-red-500/10'}`}>
                        {t.removed ? 'Undo' : '✕'}
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {preview && (
              <section className="rounded-xl border border-[#00D4FF]/20 bg-[#00D4FF]/5 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-[#00D4FF]">
                    {preview.type === 'audio' ? 'Audio' : 'Subtitle'} preview · track {preview.typeIndex + 1}
                  </p>
                  {!preview.loading && preview.startSeconds !== undefined && (
                    <span className="text-[9px] font-mono text-white/30">
                      {secondsToStamp(preview.startSeconds)} · {Math.round(preview.durationSeconds ?? 0)} sec
                    </span>
                  )}
                </div>
                {preview.loading && <div className="flex items-center gap-2 text-[10px] text-white/40"><Spinner className="w-4 h-4" /> Extracting middle sample...</div>}
                {preview.error && <p className="text-xs font-mono text-red-400">{preview.error}</p>}
                {preview.url && <audio src={preview.url} controls autoPlay className="w-full h-10" />}
                {preview.text && <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-xs leading-relaxed text-white/75 font-mono">{preview.text}</pre>}
              </section>
            )}
            {mode === 'audio' && audioTracks.length === 0 && (
              <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest">No audio tracks found in this file.</p>
            )}
            {mode === 'subtitles' && subtitleTracks.length === 0 && (
              <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest">No embedded subtitle tracks in this file.</p>
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
