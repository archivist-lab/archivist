import { useEffect, useRef, useState } from 'react'
import type { PlayerBookmark, PlayerMediaCard, PlayerPlaybackPreferences, PlayerSubtitleSearchResult } from '@archivist/contracts'
import type { ArchivistSdk, MediaTracks } from '../lib/sdk.js'
import { getProgress, saveProgress, removeProgress, usePlayerSelector, useSettings, type PlayerPlaybackTarget } from '../lib/store.js'
import { computeGainDb, useMediaGain } from '../lib/useMediaGain.js'
import { UpNext } from './osd/UpNext.js'
import { VideoOsd } from './osd/VideoOsd.js'
import { activeSegmentAt, SkipSegmentButton } from './SkipSegmentButton.js'

export type PlayTarget = PlayerPlaybackTarget

interface PlayerProps {
  target: PlayTarget
  sdk: ArchivistSdk
  onClose: () => void
  nextTarget?: PlayTarget | null
  onAdvance?: (target: PlayTarget) => void
  minimized?: boolean
  onMinimize?: () => void
  onRecommendation?: (item: PlayerMediaCard) => void
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

export function startingTrackSelection(tracks: MediaTracks, preferences: PlayerPlaybackPreferences, target: Pick<PlayerPlaybackTarget, 'initialAudioIndex' | 'initialSubtitleIndex'>): { audioIndex: number | null; subIndex: number | null; requiresCompat: boolean } {
  const preferred = preferredTrackSelection(tracks, preferences)
  const audioIndex = target.initialAudioIndex ?? preferred.audioIndex
  const subIndex = Object.prototype.hasOwnProperty.call(target, 'initialSubtitleIndex') ? target.initialSubtitleIndex ?? null : preferred.subIndex
  const subtitle = subIndex == null ? null : tracks.subtitles.find(track => track.index === subIndex)
  return {
    audioIndex,
    subIndex,
    requiresCompat: preferred.requiresCompat || target.initialAudioIndex !== undefined || !!subtitle && !subtitle.textBased,
  }
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
export function Player({ target, sdk, onClose, nextTarget = null, onAdvance, minimized = false, onMinimize, onRecommendation }: PlayerProps) {
  const mediaType = target.type === 'film' ? 'films' : 'episodes'
  const settings = useSettings()
  const playerPlayback = usePlayerSelector(state => state.bootstrap?.featureFlags.uiV2Enabled ? state.preferences?.preferences.playback : undefined)
  const playbackPreferences: PlayerPlaybackPreferences = playerPlayback ?? {
    normalizeVolume: settings.normalizeVolume,
    targetLufs: settings.loudnessTarget as PlayerPlaybackPreferences['targetLufs'],
    preferredAudioLanguage: null,
    preferredSubtitleLanguage: null,
    subtitles: 'off',
    osdTimeoutSeconds: 3,
    pauseBehavior: 'after-delay',
    timeDisplay: 'elapsed-total',
    stillWatchingMinutes: 0,
  }
  const videoRef = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const saved = getProgress()[target.key]
  const resumable = saved && !saved.completed && saved.positionSeconds > 30 && saved.positionSeconds / Math.max(saved.durationSeconds, 1) < 0.95

  const [tracks, setTracks] = useState<MediaTracks | null>(null)
  const [mode, setMode] = useState<'direct' | 'compat'>('direct')
  const [audioIndex, setAudioIndex] = useState<number | null>(target.initialAudioIndex ?? null)
  const [subIndex, setSubIndex] = useState<number | null>(target.initialSubtitleIndex ?? null)
  const [baseOffset, setBaseOffset] = useState(0) // compat-mode seek origin
  const [askResume, setAskResume] = useState(!!resumable)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)  // displayed position (incl. baseOffset)
  const [duration, setDuration] = useState(0)
  const [showUi, setShowUi] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [upNextCancelled, setUpNextCancelled] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [audioDelayMs, setAudioDelayMs] = useState(0)
  const [subtitleDelayMs, setSubtitleDelayMs] = useState(0)
  const [bookmarks, setBookmarks] = useState<PlayerBookmark[]>([])
  const [subtitleResults, setSubtitleResults] = useState<PlayerSubtitleSearchResult[]>([])
  const [subtitleMessage, setSubtitleMessage] = useState<string | null>(null)
  const [stillWatching, setStillWatching] = useState(false)
  const [postPlay, setPostPlay] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const decidedMode = useRef(false)
  const autoSkipped = useRef(new Set<string>())
  const originalCueTimes = useRef(new Map<TextTrackCue, { start: number; end: number }>())
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
        const selection = startingTrackSelection(t, playbackPreferences, target)
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

  useEffect(() => { sdk.bookmarks(target.type, target.id).then(result => setBookmarks(result.bookmarks)).catch(() => {}) }, [sdk, target.type, target.id])

  const totalDuration = tracks?.durationSec ?? saved?.durationSeconds ?? duration
  const displayed = (vt: number) => (mode === 'compat' ? baseOffset + vt : vt)

  const norm = playbackPreferences.normalizeVolume ? playbackPreferences.targetLufs : undefined
  const src = mode === 'compat'
    ? sdk.transcodeUrl(mediaType, target.id, { audio: audioIndex ?? undefined, subs: subIndex != null && subIndex >= 0 ? subIndex : undefined, t: baseOffset, norm, audioDelayMs })
    : sdk.asset(target.streamUrl, true)

  const selectedSubtitle = tracks?.subtitles.find(track => track.index === subIndex)
  const vttUrl = subIndex != null && selectedSubtitle?.textBased ? sdk.subtitleUrl(mediaType, target.id, subIndex) : null

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
    if (playbackPreferences.osdTimeoutSeconds > 0) hideTimer.current = setTimeout(() => setShowUi(false), playbackPreferences.osdTimeoutSeconds * 1000)
  }
  useEffect(() => {
    if (playing) poke()
    return () => clearTimeout(hideTimer.current)
  }, [playing, playbackPreferences.osdTimeoutSeconds])

  useEffect(() => {
    if (!playing || playbackPreferences.stillWatchingMinutes === 0) return
    const timer = window.setTimeout(() => { videoRef.current?.pause(); setStillWatching(true) }, playbackPreferences.stillWatchingMinutes * 60_000)
    return () => clearTimeout(timer)
  }, [playing, playbackPreferences.stillWatchingMinutes, target.key])

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

  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = playbackRate
  }, [playbackRate, videoKey])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !vttUrl) return
    const apply = () => {
      for (const track of Array.from(video.textTracks)) for (const cue of Array.from(track.cues ?? [])) {
        const original = originalCueTimes.current.get(cue) ?? { start: cue.startTime, end: cue.endTime }
        originalCueTimes.current.set(cue, original)
        cue.startTime = Math.max(0, original.start + subtitleDelayMs / 1000)
        cue.endTime = Math.max(cue.startTime + .01, original.end + subtitleDelayMs / 1000)
      }
    }
    apply()
    const timer = window.setTimeout(apply, 300)
    return () => clearTimeout(timer)
  }, [subtitleDelayMs, vttUrl, videoKey])

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
    <div ref={wrapRef} aria-hidden={minimized} className={`${minimized ? 'pointer-events-none fixed left-0 top-0 -z-10 h-px w-px overflow-hidden opacity-0' : 'fixed inset-0 z-[100] bg-black animate-fade-in'}`} onMouseMove={poke}>
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
          else if (target.type === 'film' && target.recommendations?.length) { setPlaying(false); setPostPlay(true) }
          else closePlayer()
        }}
        onError={onVideoError}
        onClick={() => { const v = videoRef.current; if (v) v.paused ? v.play() : v.pause() }}
      >
        {vttUrl && <track kind="subtitles" src={vttUrl} srcLang="sub" label="Subtitles" default />}
      </video>

      {!askResume && !error && <SkipSegmentButton segment={activeSegment} onSkip={skipActiveSegment} />}

      {mode === 'compat' && !error && !askResume && (
        <div className="player-accent-soft player-accent-border absolute top-5 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full border text-[10px] font-mono uppercase tracking-widest pointer-events-none">
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
                className="player-focusable player-accent-bg px-8 py-3 rounded-xl font-bold tracking-widest text-[11px] uppercase hover:scale-105 transition-all">
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

      {stillWatching && <div className="absolute inset-0 z-40 grid place-items-center bg-black/82"><section className="player-dialog motion-dialog rounded-3xl p-9 text-center"><p className="text-xs uppercase tracking-[.25em] player-accent">Still watching?</p><h2 className="mt-3 text-3xl font-semibold">{target.seriesTitle ?? target.title}</h2><div className="mt-8 flex justify-center gap-3"><button onClick={() => { setStillWatching(false); void videoRef.current?.play() }} className="player-focusable player-accent-bg rounded-full px-7 py-3 font-bold">Continue</button><button onClick={() => { write(); closePlayer() }} className="player-focusable rounded-full bg-white/10 px-7 py-3 font-bold">Stop</button></div></section></div>}

      {postPlay && <div className="absolute inset-0 z-50 flex items-end bg-gradient-to-t from-black via-black/90 to-black/35 p-[var(--safe-x)]"><section className="motion-slide w-full"><p className="text-xs font-semibold uppercase tracking-[.25em] player-accent">Because you watched {target.title}</p><h2 className="mt-3 text-4xl font-semibold">What to watch next</h2><div className="mt-7 flex gap-5 overflow-x-auto pb-4">{target.recommendations?.slice(0, 6).map(item => <button key={`${item.mediaType}:${item.id}`} onClick={() => onRecommendation?.(item)} className="player-focusable group w-64 shrink-0 overflow-hidden rounded-2xl bg-white/5 text-left ring-1 ring-white/10"><div className="aspect-video overflow-hidden bg-white/5">{item.backdropUrl && <img src={sdk.asset(item.backdropUrl)} alt="" className="h-full w-full object-cover transition group-hover:scale-105" />}</div><p className="truncate p-4 font-semibold">{item.title}</p></button>)}</div><button onClick={closePlayer} className="player-focusable mt-4 rounded-full bg-white/10 px-6 py-3 font-semibold">Back to library</button></section></div>}

      {!minimized && !askResume && !error && (
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
          playbackRate={playbackRate}
          audioDelayMs={audioDelayMs}
          subtitleDelayMs={subtitleDelayMs}
          bookmarks={bookmarks}
          subtitleResults={subtitleResults}
          subtitleMessage={subtitleMessage}
          cast={target.cast}
          pauseBehavior={playbackPreferences.pauseBehavior}
          timeDisplay={playbackPreferences.timeDisplay}
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
          onRate={rate => { setPlaybackRate(rate); if (videoRef.current) videoRef.current.playbackRate = rate }}
          onAudioDelay={milliseconds => { setAudioDelayMs(Math.max(-10_000, Math.min(10_000, milliseconds))); if (mode === 'direct') switchMode('compat') }}
          onSubtitleDelay={milliseconds => setSubtitleDelayMs(Math.max(-10_000, Math.min(10_000, milliseconds)))}
          onAddBookmark={() => { void sdk.addBookmark(target.type, target.id, current).then(bookmark => setBookmarks(items => [...items, bookmark].sort((a, b) => a.positionSeconds - b.positionSeconds))) }}
          onDeleteBookmark={bookmarkId => { void sdk.deleteBookmark(bookmarkId).then(() => setBookmarks(items => items.filter(item => item.id !== bookmarkId))) }}
          onSearchSubtitles={() => { setSubtitleMessage('Searching…'); setSubtitleResults([]); void sdk.searchSubtitles(mediaType, target.id, playbackPreferences.preferredSubtitleLanguage).then(result => { setSubtitleResults(result.results); setSubtitleMessage(result.results.length ? null : 'No subtitles found') }).catch(reason => setSubtitleMessage(reason instanceof Error ? reason.message : String(reason))) }}
          onDownloadSubtitle={result => { setSubtitleMessage('Downloading…'); void sdk.downloadSubtitle(mediaType, target.id, result.fileId, result.language).then(async value => { setSubtitleMessage(value.message); const refreshed = await sdk.mediaTracks(mediaType, target.id); setTracks(refreshed); const downloaded = refreshed.subtitles.find(track => track.index < 0); if (downloaded) setSubIndex(downloaded.index) }).catch(reason => setSubtitleMessage(reason instanceof Error ? reason.message : String(reason))) }}
          onFullscreen={() => void wrapRef.current?.requestFullscreen?.()}
          onMute={() => {
            const v = videoRef.current
            if (v) v.muted = !v.muted
          }}
          onMinimize={onMinimize}
          queue={nextTarget ? <div className="space-y-3"><div className="rounded-2xl player-accent-soft p-4"><p className="text-xs uppercase tracking-[.18em] player-accent">Now playing</p><p className="mt-2 font-semibold">{target.title}</p></div><button onClick={() => { write(true); onAdvance?.(nextTarget) }} className="player-focusable w-full rounded-2xl bg-white/5 p-4 text-left"><p className="text-xs uppercase tracking-[.18em] text-white/35">Up next</p><p className="mt-2 font-semibold">{nextTarget.title}</p></button></div> : undefined}
        />
      )}

      {!minimized && target.type === 'episode' && !askResume && !error && (
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
