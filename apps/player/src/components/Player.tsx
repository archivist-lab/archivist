import { useEffect, useRef, useState } from 'react'
import type { ArchivistSdk, MediaTracks } from '../lib/sdk.js'
import { getProgress, saveProgress, removeProgress, useSettings, updateSettings, type ProgressEntry } from '../lib/store.js'
import { computeGainDb, useMediaGain } from '../lib/useMediaGain.js'
import { TrackMenu } from './TrackMenu.js'

export interface PlayTarget extends Omit<ProgressEntry, 'positionSeconds' | 'durationSeconds' | 'completed' | 'updatedAt'> {}

/**
 * Fullscreen direct-play video overlay with track selection and a server-side
 * compatibility transcode fallback (see server player/media.ts).
 *
 * Direct play uses the original file. Many library files are HEVC + E-AC3/DTS,
 * which browsers can't decode — so when the file isn't directly playable we
 * fall back to a transcoded H.264 + stereo AAC stream. Text subtitles load as
 * WebVTT tracks; in compatibility mode any subtitle can be burned in. Seeking in
 * compatibility mode reloads the transcode from the target position.
 *
 * Keyboard: space, ←/→ (±10s), f (fullscreen), m (mute), c (subs off), Esc.
 */
export function Player({ target, sdk, onClose }: { target: PlayTarget; sdk: ArchivistSdk; onClose: () => void }) {
  const mediaType = target.type === 'film' ? 'films' : 'episodes'
  const settings = useSettings()
  const videoRef = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const saved = getProgress()[target.key]
  const resumable = saved && !saved.completed && saved.positionSeconds > 30 && saved.positionSeconds / Math.max(saved.durationSeconds, 1) < 0.95

  const [tracks, setTracks] = useState<MediaTracks | null>(null)
  const [mode, setMode] = useState<'direct' | 'compat'>('direct')
  const [audioIndex, setAudioIndex] = useState<number | null>(null)
  const [subIndex, setSubIndex] = useState<number | null>(null)
  const [baseOffset, setBaseOffset] = useState(0) // compat-mode seek origin
  const [showMenu, setShowMenu] = useState(false)
  const [askResume, setAskResume] = useState(!!resumable)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)  // displayed position (incl. baseOffset)
  const [duration, setDuration] = useState(0)
  const [showUi, setShowUi] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const decidedMode = useRef(false)

  // Probe tracks; auto-pick compatibility mode when the file isn't directly playable.
  useEffect(() => {
    sdk.mediaTracks(mediaType, target.id).then(t => {
      setTracks(t)
      if (!decidedMode.current && !t.directPlayable) {
        decidedMode.current = true
        if (resumable) setBaseOffset(saved!.positionSeconds)
        setMode('compat')
      }
    }).catch(() => {})
  }, [sdk, mediaType, target.id])

  const totalDuration = tracks?.durationSec ?? saved?.durationSeconds ?? duration
  const displayed = (vt: number) => (mode === 'compat' ? baseOffset + vt : vt)

  const norm = settings.normalizeVolume ? settings.loudnessTarget : undefined
  const src = mode === 'compat'
    ? sdk.transcodeUrl(mediaType, target.id, { audio: audioIndex ?? undefined, subs: subIndex ?? undefined, t: baseOffset, norm })
    : sdk.asset(target.streamUrl, true)

  const vttUrl = mode === 'direct' && subIndex != null ? sdk.subtitleUrl(mediaType, target.id, subIndex) : null

  // Direct-play normalization runs client-side (transcoded playback is
  // normalized server-side). Keyed on this so toggling remounts the element.
  const gainActive = mode === 'direct' && settings.normalizeVolume && !!tracks?.loudness
  const gainDb = gainActive ? computeGainDb(tracks!.loudness, settings.loudnessTarget) : 0
  const videoKey = `${src}::${gainActive ? `n${Math.round(gainDb)}` : 'd'}`
  useMediaGain(videoRef, gainActive, gainDb, videoKey)

  const write = (completed = false) => {
    const v = videoRef.current
    if (!v || !v.duration) return
    const pos = displayed(v.currentTime)
    const total = totalDuration || v.duration
    if (completed || pos / Math.max(total, 1) >= 0.95) {
      saveProgress({ ...target, positionSeconds: total, durationSeconds: total, completed: true })
      void sdk.saveProgress({ type: target.type, id: target.id, positionSeconds: total, durationSeconds: total, completed: true }).catch(() => {})
    } else if (pos > 5) {
      saveProgress({ ...target, positionSeconds: pos, durationSeconds: total, completed: false })
      void sdk.saveProgress({ type: target.type, id: target.id, positionSeconds: pos, durationSeconds: total, completed: false }).catch(() => {})
    }
  }

  useEffect(() => {
    const t = setInterval(() => write(), 5000)
    return () => { clearInterval(t); write() }
  }, [mode, baseOffset])

  const poke = () => {
    setShowUi(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setShowUi(false), 2500)
  }

  // Seeking: direct sets currentTime; compatibility reloads the transcode from
  // the target position (the <video> is keyed on src, so it remounts).
  const seek = (toSeconds: number) => {
    const clamped = Math.max(0, Math.min(toSeconds, (totalDuration || Infinity) - 1))
    if (mode === 'compat') {
      setCurrent(clamped)
      setBaseOffset(clamped)
    } else {
      const v = videoRef.current
      if (v) v.currentTime = clamped
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = videoRef.current
      if (!v) return
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause() }
      if (e.key === 'ArrowLeft') seek(displayed(v.currentTime) - 10)
      if (e.key === 'ArrowRight') seek(displayed(v.currentTime) + 10)
      if (e.key === 'f') wrapRef.current?.requestFullscreen?.()
      if (e.key === 'm') v.muted = !v.muted
      if (e.key === 'c') setSubIndex(null)
      poke()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, mode, baseOffset, totalDuration])

  // Force any attached WebVTT track visible (the `default` attr alone is flaky).
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    for (const tt of Array.from(v.textTracks)) tt.mode = vttUrl ? 'showing' : 'disabled'
  }, [vttUrl, src])

  const startPlayback = (fromSaved: boolean) => {
    setAskResume(false)
    const v = videoRef.current
    if (!v) return
    if (fromSaved && saved) {
      if (mode === 'compat') setBaseOffset(saved.positionSeconds)
      else v.currentTime = saved.positionSeconds
    } else if (mode === 'compat' && baseOffset) {
      setBaseOffset(0)
    }
    v.play().catch(() => {})
  }

  const onVideoError = () => {
    // Direct play failed (codec/container). Fall back to transcoding rather than
    // erroring — the common HEVC / E-AC3 case.
    if (mode === 'direct') {
      const at = displayed(videoRef.current?.currentTime ?? 0)
      if (at > 1) setBaseOffset(at)
      setMode('compat')
      return
    }
    setError('This file could not be played, even after transcoding. It may be corrupt or an unsupported format.')
  }

  const switchMode = (m: 'direct' | 'compat') => {
    if (m === mode) return
    const at = displayed(videoRef.current?.currentTime ?? 0)
    if (m === 'compat' && at > 1) setBaseOffset(at)
    setMode(m)
  }

  const fmt = (s: number) => {
    if (!Number.isFinite(s)) return '0:00'
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
  }

  const seekMax = mode === 'compat' ? (totalDuration || 1) : (duration || 1)

  return (
    <div ref={wrapRef} className="fixed inset-0 z-[100] bg-black animate-fade-in" onMouseMove={poke} onClick={() => showMenu && setShowMenu(false)}>
      <video
        key={videoKey}
        ref={videoRef}
        src={src}
        autoPlay={!askResume}
        crossOrigin="anonymous"
        className="w-full h-full"
        onPlay={() => setPlaying(true)}
        onPause={() => { setPlaying(false); write() }}
        onTimeUpdate={e => setCurrent(displayed(e.currentTarget.currentTime))}
        onDurationChange={e => setDuration(e.currentTarget.duration || 0)}
        onLoadedMetadata={() => setError(null)}
        onEnded={() => {
          // In compatibility mode, the current fragment ending mid-film isn't the
          // real end — only finish when we're near the true duration.
          if (mode === 'compat' && baseOffset + (videoRef.current?.currentTime ?? 0) < totalDuration - 5) return
          write(true); onClose()
        }}
        onError={onVideoError}
        onClick={() => { const v = videoRef.current; if (v) v.paused ? v.play() : v.pause() }}
      >
        {vttUrl && <track kind="subtitles" src={vttUrl} srcLang="sub" label="Subtitles" default />}
      </video>

      {mode === 'compat' && !error && !askResume && (
        <div className="absolute top-5 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-cyan/15 border border-cyan/30 text-[10px] font-mono uppercase tracking-widest text-cyan pointer-events-none">
          Compatibility mode
        </div>
      )}

      {askResume && (
        <div className="absolute inset-0 bg-black/80 flex items-center justify-center">
          <div className="text-center animate-slide-up">
            <p className="text-[10px] font-mono text-white/40 uppercase tracking-[0.3em] mb-2">Resume</p>
            <h2 className="font-display text-4xl text-white tracking-wide mb-6">{target.title}</h2>
            <div className="flex gap-3 justify-center">
              <button onClick={() => startPlayback(true)}
                className="px-8 py-3 rounded-xl bg-cyan text-noir-950 font-bold tracking-widest text-[11px] uppercase hover:scale-105 transition-all">
                Resume {fmt(saved!.positionSeconds)}
              </button>
              <button onClick={() => { removeProgress(target.key); void sdk.deleteProgress(target.type, target.id).catch(() => {}); startPlayback(false) }}
                className="px-8 py-3 rounded-xl bg-white/10 border border-white/15 text-white font-bold tracking-widest text-[11px] uppercase hover:bg-white/15 transition-all">
                Start Over
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 bg-black/85 flex items-center justify-center">
          <div className="text-center max-w-md px-6">
            <p className="text-sm text-red-400 mb-6">{error}</p>
            <button onClick={onClose} className="px-8 py-3 rounded-xl bg-white/10 border border-white/15 text-white font-bold tracking-widest text-[11px] uppercase">Close</button>
          </div>
        </div>
      )}

      <div className={`absolute inset-x-0 top-0 p-5 flex items-center gap-4 bg-gradient-to-b from-black/80 to-transparent transition-opacity ${showUi ? 'opacity-100' : 'opacity-0'}`}>
        <button onClick={onClose} className="text-white/60 hover:text-white text-xl leading-none">←</button>
        <div>
          <p className="text-sm font-semibold text-white">{target.title}</p>
          {target.seriesTitle && <p className="text-[10px] font-mono text-white/40 uppercase tracking-widest">{target.seriesTitle}</p>}
        </div>
      </div>

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
              onAudio={i => {
                setAudioIndex(i)
                // Switching audio track requires the transcoder (browsers can't
                // switch tracks inside an MKV), so move to compatibility mode.
                if (mode === 'direct') switchMode('compat')
              }}
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
