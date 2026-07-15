import { useEffect, useRef, useState } from 'react'
import type { PlayerPlaybackPreferences } from '@archivist/contracts'
import type { ArchivistSdk, MediaTracks } from '../lib/sdk.js'
import { getProgress, saveProgress, removeProgress, usePlayerSelector, useSettings, type ProgressEntry } from '../lib/store.js'
import { computeGainDb, useMediaGain } from '../lib/useMediaGain.js'
import { UpNext } from './osd/UpNext.js'
import { VideoOsd } from './osd/VideoOsd.js'
import { activeSegmentAt, SkipSegmentButton } from './SkipSegmentButton.js'

export interface PlayTarget extends Omit<ProgressEntry, 'positionSeconds' | 'durationSeconds' | 'completed' | 'updatedAt'> {
  plot?: string | null
}

interface PlayerProps {
  target: PlayTarget
  sdk: ArchivistSdk
  onClose: () => void
  nextTarget?: PlayTarget | null
  onAdvance?: (target: PlayTarget) => void
}

const AUTO_SKIP_MIN_CONFIDENCE = 0.9

export function preferredTrackSelection(tracks: MediaTracks, preferences: PlayerPlaybackPreferences): { audioIndex: number | null; subIndex: number | null; requiresCompat: boolean } {
  const matches = (actual: string | null, preferred: string | null) => {
    if (!actual || !preferred) return false
    const a = actual.toLowerCase(), p = preferred.toLowerCase()
    return a === p || a.split('-')[0] === p.split('-')[0]
  }
  const audio = preferences.preferredAudioLanguage
    ? tracks.audio.find(track => matches(track.language, preferences.preferredAudioLanguage))
    : null
  const audioIndex = audio && !audio.default ? audio.index : null
  let subtitle = null as MediaTracks['subtitles'][number] | null
  if (preferences.subtitles === 'forced') {
    subtitle = tracks.subtitles.find(track => track.forced && matches(track.language, preferences.preferredSubtitleLanguage))
      ?? tracks.subtitles.find(track => track.forced)
      ?? null
  } else if (preferences.subtitles === 'preferred') {
    subtitle = tracks.subtitles.find(track => matches(track.language, preferences.preferredSubtitleLanguage))
      ?? tracks.subtitles.find(track => track.default)
      ?? null
  }
  const subIndex = subtitle?.index ?? null
  return { audioIndex, subIndex, requiresCompat: audioIndex !== null || !!subtitle && !subtitle.textBased }
}

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
export function Player({ target, sdk, onClose, nextTarget = null, onAdvance }: PlayerProps) {
  const mediaType = target.type === 'film' ? 'films' : 'episodes'
  const settings = useSettings()
  const playerPlayback = usePlayerSelector(state => state.bootstrap?.featureFlags.uiV2Enabled ? state.preferences?.preferences.playback : undefined)
  const playbackPreferences: PlayerPlaybackPreferences = playerPlayback ?? {
    normalizeVolume: settings.normalizeVolume,
    targetLufs: settings.loudnessTarget as PlayerPlaybackPreferences['targetLufs'],
    preferredAudioLanguage: null,
    preferredSubtitleLanguage: null,
    subtitles: 'off',
  }
  const videoRef = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const saved = getProgress()[target.key]
  const resumable = saved && !saved.completed && saved.positionSeconds > 30 && saved.positionSeconds / Math.max(saved.durationSeconds, 1) < 0.95

  const [tracks, setTracks] = useState<MediaTracks | null>(null)
  const [mode, setMode] = useState<'direct' | 'compat'>('direct')
  const [audioIndex, setAudioIndex] = useState<number | null>(null)
  const [subIndex, setSubIndex] = useState<number | null>(null)
  const [baseOffset, setBaseOffset] = useState(0) // compat-mode seek origin
  const [askResume, setAskResume] = useState(!!resumable)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)  // displayed position (incl. baseOffset)
  const [duration, setDuration] = useState(0)
  const [showUi, setShowUi] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [upNextCancelled, setUpNextCancelled] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const decidedMode = useRef(false)
  const autoSkipped = useRef(new Set<string>())
  const originFocusId = useRef((document.activeElement as HTMLElement | null)?.dataset.focusId ?? null)
  const closePlayer = () => {
    const focusId = originFocusId.current
    onClose()
    if (focusId) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(focusId)}"]`)?.focus())
  }

  // Probe tracks; while server-side analysis is pending, refresh a bounded
  // three times so a marker detected during playback appears without reload.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    autoSkipped.current.clear()
    const load = () => {
      attempt++
      sdk.mediaTracks(mediaType, target.id).then(t => {
        if (cancelled) return
        setTracks(t)
        const selection = preferredTrackSelection(t, playbackPreferences)
        setAudioIndex(selection.audioIndex)
        setSubIndex(selection.subIndex)
        if (!decidedMode.current && (!t.directPlayable || selection.requiresCompat)) {
          decidedMode.current = true
          if (resumable) setBaseOffset(saved!.positionSeconds)
          setMode('compat')
        }
        const retryable = mediaType === 'episodes'
          && (!t.segmentAnalysis || ['pending', 'queued', 'analysing', 'failed', 'cancelled'].includes(t.segmentAnalysis.state))
        if (retryable && attempt < 4) timer = setTimeout(load, attempt * 5_000)
      }).catch(() => {})
    }
    load()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [sdk, mediaType, target.id])

  const totalDuration = tracks?.durationSec ?? saved?.durationSeconds ?? duration
  const displayed = (vt: number) => (mode === 'compat' ? baseOffset + vt : vt)

  const norm = playbackPreferences.normalizeVolume ? playbackPreferences.targetLufs : undefined
  const src = mode === 'compat'
    ? sdk.transcodeUrl(mediaType, target.id, { audio: audioIndex ?? undefined, subs: subIndex ?? undefined, t: baseOffset, norm })
    : sdk.asset(target.streamUrl, true)

  const vttUrl = mode === 'direct' && subIndex != null ? sdk.subtitleUrl(mediaType, target.id, subIndex) : null

  // Direct-play normalization runs client-side (transcoded playback is
  // normalized server-side). Keyed on this so toggling remounts the element.
  const gainActive = mode === 'direct' && playbackPreferences.normalizeVolume && !!tracks?.loudness
  const gainDb = gainActive ? computeGainDb(tracks!.loudness, playbackPreferences.targetLufs) : 0
  const videoKey = `${src}::${gainActive ? `n${Math.round(gainDb)}` : 'd'}::${retryNonce}`
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
    hideTimer.current = setTimeout(() => setShowUi(false), 3000)
  }
  useEffect(() => {
    if (playing) poke()
    return () => clearTimeout(hideTimer.current)
  }, [playing])

  // Seeking: direct sets currentTime; compatibility reloads the transcode from
  // the target position (the <video> is keyed on src, so it remounts).
  const seek = (toSeconds: number) => {
    const clamped = Math.max(0, Math.min(toSeconds, (totalDuration || Infinity) - 0.25))
    if (mode === 'compat') {
      setCurrent(clamped)
      setBaseOffset(clamped)
    } else {
      const v = videoRef.current
      if (v) v.currentTime = clamped
    }
  }

  const activeSegment = activeSegmentAt(tracks, current, 1.5)
  const skipActiveSegment = () => {
    const segment = activeSegmentAt(tracks, current, 1.5)
    if (segment) seek(segment.marker.end + 0.1)
  }

  useEffect(() => {
    const segment = activeSegmentAt(tracks, current)
    if (!segment) return
    const enabled = segment.kind === 'intro' ? settings.autoSkipIntro : settings.autoSkipCredits
    const key = `${segment.kind}:${segment.marker.start}:${segment.marker.end}`
    if (!enabled || segment.marker.confidence < AUTO_SKIP_MIN_CONFIDENCE || autoSkipped.current.has(key)) return
    autoSkipped.current.add(key)
    seek(segment.marker.end + 0.1)
  }, [current, tracks, settings.autoSkipIntro, settings.autoSkipCredits, mode, baseOffset])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const v = videoRef.current
      if (!v) return
      if (e.key === 'Escape') { closePlayer(); return }
      if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause() }
      if (e.key === 'f') wrapRef.current?.requestFullscreen?.()
      if (e.key === 'm') v.muted = !v.muted
      if (e.key === 'c') setSubIndex(null)
      if (e.key.toLowerCase() === 's') skipActiveSegment()
      poke()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, mode, baseOffset, totalDuration, tracks, current])

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

  return (
    <div ref={wrapRef} className="fixed inset-0 z-[100] bg-black animate-fade-in" onMouseMove={poke}>
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
          write(true)
          if (nextTarget && onAdvance) onAdvance(nextTarget)
          else closePlayer()
        }}
        onError={onVideoError}
        onClick={() => { const v = videoRef.current; if (v) v.paused ? v.play() : v.pause() }}
      >
        {vttUrl && <track kind="subtitles" src={vttUrl} srcLang="sub" label="Subtitles" default />}
      </video>

      {!askResume && !error && <SkipSegmentButton segment={activeSegment} onSkip={skipActiveSegment} />}

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
            <div className="flex justify-center gap-3">
              <button onClick={() => { setError(null); setRetryNonce(value => value + 1) }} className="player-focusable px-8 py-3 rounded-xl bg-white text-black font-bold tracking-widest text-[11px] uppercase">Retry</button>
              <button onClick={closePlayer} className="player-focusable px-8 py-3 rounded-xl bg-white/10 border border-white/15 text-white font-bold tracking-widest text-[11px] uppercase">Close</button>
            </div>
          </div>
        </div>
      )}

      {!askResume && !error && (
        <VideoOsd
          title={target.title}
          seriesTitle={target.seriesTitle}
          plot={target.plot}
          playing={playing}
          current={current}
          duration={totalDuration || duration}
          tracks={tracks}
          mode={mode}
          audioIndex={audioIndex}
          subIndex={subIndex}
          visible={showUi}
          onInteraction={poke}
          onHide={() => setShowUi(false)}
          onToggle={() => {
            const v = videoRef.current
            if (v) v.paused ? void v.play() : v.pause()
          }}
          onSeek={seek}
          onStop={() => { write(); closePlayer() }}
          onMode={switchMode}
          onAudio={index => {
            setAudioIndex(index)
            if (mode === 'direct') switchMode('compat')
          }}
          onSub={setSubIndex}
          onFullscreen={() => void wrapRef.current?.requestFullscreen?.()}
          onMute={() => {
            const v = videoRef.current
            if (v) v.muted = !v.muted
          }}
        />
      )}

      {target.type === 'episode' && !askResume && !error && (
        <UpNext
          currentTime={current}
          duration={totalDuration || duration}
          next={nextTarget}
          cancelled={upNextCancelled}
          onCancel={() => setUpNextCancelled(true)}
          onPlay={() => {
            if (!nextTarget || !onAdvance) return
            write(true)
            onAdvance(nextTarget)
          }}
        />
      )}
    </div>
  )
}
