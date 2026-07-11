import { useEffect, useRef, useState } from 'react'
import type { ArchivistSdk, MediaTracks, PlaySession, SessionItem } from '../lib/sdk.js'
import { saveProgress, useSettings, updateSettings } from '../lib/store.js'
import { computeGainDb, useMediaGain } from '../lib/useMediaGain.js'
import { TrackMenu } from './TrackMenu.js'

/**
 * Channel playback session player (archivist-channels.md §30). Plays a queue
 * built from the guide: auto-advances on completion, shows Up Next in the final
 * seconds, exposes the queue with skip/stop, and reports completed items back to
 * the server. Like the main player, it probes each item's tracks and falls back
 * to a server-side compatibility transcode when the file can't direct-play, with
 * audio/subtitle selection.
 */

const UP_NEXT_SECONDS = 15

const fmt = (s: number) => {
  if (!Number.isFinite(s)) return '0:00'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

const itemTitle = (i: SessionItem) =>
  i.seriesTitle && i.seasonNumber != null
    ? `${i.seriesTitle} S${String(i.seasonNumber).padStart(2, '0')}E${String(i.episodeNumber).padStart(2, '0')}`
    : i.title

export function SessionPlayer({ session, sdk, onClose }: {
  session: PlaySession; sdk: ArchivistSdk; onClose: () => void
}) {
  const settings = useSettings()
  const items = session.items
  const startIndex = Math.max(0, items.findIndex(i => i.queuePosition === session.currentPosition))
  const [index, setIndex] = useState(startIndex === -1 ? 0 : startIndex)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)  // displayed position (incl. baseOffset)
  const [duration, setDuration] = useState(0)
  const [showUi, setShowUi] = useState(true)
  const [showQueue, setShowQueue] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const [tracks, setTracks] = useState<MediaTracks | null>(null)
  const [mode, setMode] = useState<'direct' | 'compat'>('direct')
  const [audioIndex, setAudioIndex] = useState<number | null>(null)
  const [subIndex, setSubIndex] = useState<number | null>(null)
  const [baseOffset, setBaseOffset] = useState(0)

  const videoRef = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const decidedMode = useRef(false)

  const item = items[index]
  const next = items[index + 1] ?? null
  const mediaType = item.itemType === 'film' ? 'films' : 'episodes'
  const joinOffset = index === startIndex ? item.startOffsetSeconds : 0

  // Per-item setup: reset tracks/mode/selection, seed the join-live offset, and
  // probe. Auto-switch to compatibility mode when the file can't direct-play.
  useEffect(() => {
    decidedMode.current = false
    setTracks(null); setMode('direct'); setAudioIndex(null); setSubIndex(null); setShowMenu(false)
    setBaseOffset(joinOffset); setCurrent(joinOffset); setDuration(0)
    sdk.mediaTracks(mediaType, item.itemId).then(t => {
      setTracks(t)
      if (!decidedMode.current && !t.directPlayable) { decidedMode.current = true; setMode('compat') }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  const totalDuration = tracks?.durationSec ?? item.runtimeSeconds ?? duration
  const displayed = (vt: number) => (mode === 'compat' ? baseOffset + vt : vt)

  const norm = settings.normalizeVolume ? settings.loudnessTarget : undefined
  const src = mode === 'compat'
    ? sdk.transcodeUrl(mediaType, item.itemId, { audio: audioIndex ?? undefined, subs: subIndex ?? undefined, t: baseOffset, norm })
    : (item.streamUrl ? sdk.asset(item.streamUrl, true) : '')

  const vttUrl = mode === 'direct' && subIndex != null ? sdk.subtitleUrl(mediaType, item.itemId, subIndex) : null

  const gainActive = mode === 'direct' && settings.normalizeVolume && !!tracks?.loudness
  const gainDb = gainActive ? computeGainDb(tracks!.loudness, settings.loudnessTarget) : 0
  const videoKey = `${src}::${gainActive ? `n${Math.round(gainDb)}` : 'd'}`
  useMediaGain(videoRef, gainActive, gainDb, videoKey)

  const writeLocalProgress = (completed = false) => {
    const v = videoRef.current
    if (!v || !v.duration || !item) return
    const pos = displayed(v.currentTime)
    const total = totalDuration || v.duration
    const isCompleted = completed || pos / Math.max(total, 1) >= 0.95
    const positionSeconds = isCompleted ? total : pos
    saveProgress({
      key: `${item.itemType}:${item.itemId}`,
      type: item.itemType,
      id: item.itemId,
      title: item.title,
      posterUrl: item.posterUrl,
      backdropUrl: item.backdropUrl,
      streamUrl: item.streamUrl ?? '',
      seriesId: item.seriesId ?? undefined,
      seriesTitle: item.seriesTitle ?? undefined,
      positionSeconds,
      durationSeconds: total,
      completed: isCompleted,
    })
    void sdk.saveProgress({
      type: item.itemType,
      id: item.itemId,
      positionSeconds,
      durationSeconds: total,
      completed: isCompleted,
    }).catch(() => {})
  }

  useEffect(() => {
    const t = setInterval(() => writeLocalProgress(), 5000)
    return () => { clearInterval(t); writeLocalProgress() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, mode, baseOffset])

  const advance = async () => {
    writeLocalProgress(true)
    sdk.completeSessionItem(session.sessionId, item.queuePosition).catch(() => {})
    if (next) { setError(null); setIndex(index + 1) }
    else setDone(true)
  }

  const stop = () => { sdk.stopPlaySession(session.sessionId).catch(() => {}); onClose() }

  const poke = () => {
    setShowUi(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setShowUi(false), 2500)
  }

  const seek = (toSeconds: number) => {
    const clamped = Math.max(0, Math.min(toSeconds, (totalDuration || Infinity) - 1))
    if (mode === 'compat') { setCurrent(clamped); setBaseOffset(clamped) }
    else { const v = videoRef.current; if (v) v.currentTime = clamped }
  }

  const switchMode = (m: 'direct' | 'compat') => {
    if (m === mode) return
    const at = displayed(videoRef.current?.currentTime ?? 0)
    if (m === 'compat' && at > 1) setBaseOffset(at)
    setMode(m)
  }

  const onVideoError = () => {
    if (mode === 'direct') {
      const at = displayed(videoRef.current?.currentTime ?? 0)
      if (at > 1) setBaseOffset(at)
      setMode('compat')
      return
    }
    setError('This file could not be played, even after transcoding.')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current
      if (!v) return
      if (e.key === 'Escape') { stop(); return }
      if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause() }
      if (e.key === 'ArrowLeft') seek(displayed(v.currentTime) - 10)
      if (e.key === 'ArrowRight') seek(displayed(v.currentTime) + 10)
      if (e.key === 'n' && next) advance()
      if (e.key === 'q') setShowQueue(s => !s)
      if (e.key === 'c') setSubIndex(null)
      if (e.key === 'f') wrapRef.current?.requestFullscreen?.()
      if (e.key === 'm') v.muted = !v.muted
      poke()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, next, mode, baseOffset, totalDuration])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    for (const tt of Array.from(v.textTracks)) tt.mode = vttUrl ? 'showing' : 'disabled'
  }, [vttUrl, src])

  const remaining = totalDuration ? totalDuration - current : Infinity
  const showUpNext = !!next && remaining <= UP_NEXT_SECONDS && remaining > 0
  const seekMax = mode === 'compat' ? (totalDuration || 1) : (duration || 1)

  if (done) {
    return (
      <div className="fixed inset-0 z-[100] bg-black flex items-center justify-center animate-fade-in">
        <div className="text-center">
          <p className="text-[10px] font-mono text-white/40 uppercase tracking-[0.3em] mb-2">End of slate</p>
          <h2 className="font-display text-3xl text-white tracking-wide mb-6">That's all for now</h2>
          <button onClick={stop}
            className="px-8 py-3 rounded-xl bg-cyan text-noir-950 font-bold tracking-widest text-[11px] uppercase hover:scale-105 transition-all">
            Back to guide
          </button>
        </div>
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="fixed inset-0 z-[100] bg-black animate-fade-in" onMouseMove={poke} onClick={() => showMenu && setShowMenu(false)}>
      <video
        key={videoKey}
        ref={videoRef}
        src={src}
        autoPlay
        crossOrigin="anonymous"
        className="w-full h-full"
        onPlay={() => setPlaying(true)}
        onPause={() => { setPlaying(false); writeLocalProgress() }}
        onLoadedMetadata={e => {
          setError(null)
          // Direct-mode join-live offset (compat bakes it into baseOffset).
          if (mode === 'direct' && joinOffset > 0 && e.currentTarget.currentTime < 1) {
            e.currentTarget.currentTime = joinOffset
          }
        }}
        onTimeUpdate={e => setCurrent(displayed(e.currentTarget.currentTime))}
        onDurationChange={e => setDuration(e.currentTarget.duration || 0)}
        onEnded={advance}
        onError={onVideoError}
        onClick={() => { const v = videoRef.current; if (v) v.paused ? v.play() : v.pause() }}
      >
        {vttUrl && <track kind="subtitles" src={vttUrl} srcLang="sub" label="Subtitles" default />}
      </video>

      {mode === 'compat' && !error && (
        <div className="absolute top-5 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-cyan/15 border border-cyan/30 text-[10px] font-mono uppercase tracking-widest text-cyan pointer-events-none">
          Compatibility mode
        </div>
      )}

      {error && (
        <div className="absolute inset-0 bg-black/85 flex items-center justify-center">
          <div className="text-center max-w-md px-6">
            <p className="text-sm text-red-400 mb-6">{error}</p>
            <div className="flex gap-3 justify-center">
              {next && (
                <button onClick={() => { setError(null); advance() }}
                  className="px-8 py-3 rounded-xl bg-cyan text-noir-950 font-bold tracking-widest text-[11px] uppercase">Skip to next</button>
              )}
              <button onClick={stop} className="px-8 py-3 rounded-xl bg-white/10 border border-white/15 text-white font-bold tracking-widest text-[11px] uppercase">Stop</button>
            </div>
          </div>
        </div>
      )}

      {showUpNext && !error && (
        <div className="absolute bottom-24 right-6 bg-noir-950/90 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3 animate-slide-up">
          <div>
            <p className="text-[9px] font-mono text-cyan uppercase tracking-[0.25em]">Up next · {Math.ceil(remaining)}s</p>
            <p className="text-sm font-semibold text-white">{itemTitle(next!)}</p>
          </div>
          <button onClick={advance}
            className="px-3 py-1.5 rounded-lg bg-cyan text-noir-950 text-[10px] font-bold uppercase tracking-widest">Play now</button>
        </div>
      )}

      {/* Top bar */}
      <div className={`absolute inset-x-0 top-0 p-5 flex items-center gap-4 bg-gradient-to-b from-black/80 to-transparent transition-opacity ${showUi ? 'opacity-100' : 'opacity-0'}`}>
        <button onClick={stop} className="text-white/60 hover:text-white text-xl leading-none" title="Stop session (Esc)">←</button>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate">{itemTitle(item)}</p>
          <p className="text-[10px] font-mono text-white/40 uppercase tracking-widest">
            {item.queuePosition} of {items.length}{item.blockName ? ` · ${item.blockName}` : ''}{session.mode === 'JOIN_LIVE' && index === startIndex ? ' · joined live' : ''}
          </p>
        </div>
        <button onClick={() => setShowQueue(s => !s)}
          className={`ml-auto px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-colors ${showQueue ? 'bg-cyan/15 border-cyan/50 text-cyan' : 'bg-white/5 border-white/15 text-white/60 hover:text-white'}`}>
          Queue
        </button>
      </div>

      {/* Queue panel */}
      {showQueue && (
        <div className="absolute right-0 top-16 bottom-20 w-80 bg-noir-950/95 border-l border-white/10 overflow-y-auto p-3 space-y-1.5">
          {items.map((q, qi) => (
            <button key={q.id} onClick={() => { if (qi !== index) setIndex(qi) }}
              className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors
                ${qi === index ? 'bg-cyan/10 border-cyan/40' : q.completedAt ? 'bg-white/[0.02] border-transparent opacity-40' : 'bg-white/[0.04] border-transparent hover:bg-white/[0.08]'}`}>
              <p className="text-xs font-semibold text-white/90 truncate">{q.queuePosition}. {itemTitle(q)}</p>
              <p className="text-[9px] font-mono text-white/35">
                {new Date(q.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} · {fmt(q.runtimeSeconds)}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* Bottom controls */}
      <div className={`absolute inset-x-0 bottom-0 p-5 bg-gradient-to-t from-black/85 to-transparent transition-opacity ${showUi ? 'opacity-100' : 'opacity-0'}`}>
        <input
          type="range" min={0} max={seekMax} step={1} value={Math.min(current, seekMax)}
          onChange={e => seek(Number(e.target.value))}
          className="w-full h-1 accent-[#00D4FF] cursor-pointer"
        />
        <div className="flex items-center gap-4 mt-2 relative">
          <button onClick={() => { const v = videoRef.current; if (v) v.paused ? v.play() : v.pause() }}
            className="text-white text-lg w-8">{playing ? '⏸' : '▶'}</button>
          <button onClick={() => seek(current - 10)} className="text-white/50 hover:text-white text-xs font-mono">-10s</button>
          <button onClick={() => seek(current + 10)} className="text-white/50 hover:text-white text-xs font-mono">+10s</button>
          {next && (
            <button onClick={advance} className="text-white/50 hover:text-white text-xs font-mono" title="Skip to next (n)">
              next ⏭ {itemTitle(next)}
            </button>
          )}
          <span className="text-[11px] font-mono text-white/50 ml-auto">{fmt(current)} / {fmt(totalDuration || duration)}</span>
          <button onClick={e => { e.stopPropagation(); setShowMenu(s => !s) }}
            className={`text-sm w-7 h-7 flex items-center justify-center rounded ${showMenu ? 'text-cyan bg-white/10' : 'text-white/50 hover:text-white'}`}
            title="Audio & subtitles">⚙</button>
          <button onClick={() => wrapRef.current?.requestFullscreen?.()} className="text-white/50 hover:text-white text-sm">⛶</button>
          {showMenu && (
            <TrackMenu
              tracks={tracks}
              mode={mode}
              audioIndex={audioIndex}
              subIndex={subIndex}
              normalizeVolume={settings.normalizeVolume}
              onMode={switchMode}
              onAudio={i => { setAudioIndex(i); if (mode === 'direct') switchMode('compat') }}
              onSub={setSubIndex}
              onNormalize={on => updateSettings({ normalizeVolume: on })}
              onClose={() => setShowMenu(false)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
