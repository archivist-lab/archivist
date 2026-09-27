import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PlayerBookmark, PlayerMediaCard, PlayerPlaybackPreferences, PlayerSubtitleSearchResult, ResolvedRating } from '@archivist/contracts'
import { Level } from '@archivist/design-system'
import type { ArchivistSdk, MediaTracks } from '../lib/sdk.js'
import { getProgress, saveProgress, removeProgress, usePlayerSelector, useSettings, type PlayerPlaybackTarget } from '../lib/store.js'
import { computeGainDb, useMediaGain } from '../lib/useMediaGain.js'
import { detectCapabilities, directPlayViable, nativeHlsSupported } from '../lib/capabilities.js'
import { useDialogFocus } from '../focus/useDialogFocus.js'
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
  // A page that already asked Resume or Start over says which; asking again
  // here would put the same question to the viewer twice.
  const promptResume = !!resumable && target.startFrom === undefined

  const [tracks, setTracks] = useState<MediaTracks | null>(null)
  const [mode, setMode] = useState<'direct' | 'compat'>('direct')
  const [audioIndex, setAudioIndex] = useState<number | null>(target.initialAudioIndex ?? null)
  const [subIndex, setSubIndex] = useState<number | null>(target.initialSubtitleIndex ?? null)
  const [baseOffset, setBaseOffset] = useState(0) // compat-mode seek origin
  const [askResume, setAskResume] = useState(promptResume)
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
  const [personalRating, setPersonalRating] = useState<ResolvedRating>({ value: null, source: 'none', inheritedFrom: null, scaleMax: 5 })
  const [ratingPromptEligible, setRatingPromptEligible] = useState(false)
  const ratingPromptChecked = useRef(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const decidedMode = useRef(false)
  const autoSkipped = useRef(new Set<string>())
  const originalCueTimes = useRef(new Map<TextTrackCue, { start: number; end: number }>())
  const originFocusId = useRef((document.activeElement as HTMLElement | null)?.dataset.focusId ?? null)
  /**
   * Where playback is meant to start, in title time. Everything that has to
   * (re)start the stream reads it — the switch to the compatibility transcode
   * above all, which used to reach for the saved position even after the viewer
   * had chosen Start over, and to restart from zero when a resumed direct play
   * failed before its first frame.
   */
  const startAt = useRef(resumable && target.startFrom !== 'beginning' ? saved!.positionSeconds : 0)
  /** A direct-play start position waiting for the element to know its duration. */
  const pendingDirectSeek = useRef<number | null>(!promptResume && startAt.current > 0 ? startAt.current : null)
  /** Early ends of a compatibility stream restarted in place, bounded so a broken file cannot loop. */
  const compatRestarts = useRef(0)
  // Copy the picture when this device decodes it, and convert only the audio.
  // Cleared once if a copied stream fails, which falls back to a full encode.
  const [copyVideo, setCopyVideo] = useState(true)
  /**
   * The position right now. A compatibility stream always knows it — it was
   * started at `baseOffset` — while direct play that has not begun falls back
   * to where playback is meant to start.
   */
  const positionNow = () => {
    const v = videoRef.current
    if (mode === 'compat') return baseOffset + (v?.currentTime ?? 0)
    return v && v.currentTime > 1 ? v.currentTime : startAt.current
  }
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
    // Negotiated in parallel with the probe so its answer is usually already in
    // hand by the time we need it, rather than adding a round trip before play.
    const negotiated = directPlayViable(sdk, mediaType, target.id)
    const toCompat = () => {
      if (cancelled || decidedMode.current) return
      decidedMode.current = true
      const v = videoRef.current
      setBaseOffset(v && v.currentTime > 1 ? v.currentTime : startAt.current)
      pendingDirectSeek.current = null
      setMode('compat')
    }
    const load = () => {
      attempt++
      sdk.mediaTracks(mediaType, target.id).then(t => {
        if (cancelled) return
        setTracks(t)
        const selection = startingTrackSelection(t, playbackPreferences, target)
        setAudioIndex(selection.audioIndex)
        setSubIndex(selection.subIndex)
        // Switching audio track or burning in a bitmap subtitle needs the server
        // to remux either way — the codec negotiation cannot speak to that.
        if (selection.requiresCompat) toCompat()
        // null means the negotiation could not run; fall back to the server's
        // own coarse guess, which is what this used to rely on alone.
        else void negotiated.then(viable => { if (viable === false || (viable === null && !t.directPlayable)) toCompat() })
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


  useEffect(() => {
    ratingPromptChecked.current = false
    setRatingPromptEligible(false)
    setPostPlay(false)
    if (typeof sdk.rating !== 'function') return
    void sdk.rating(target.type, target.id).then(setPersonalRating).catch(() => {})
  }, [sdk, target.type, target.id])

  const totalDuration = tracks?.durationSec ?? saved?.durationSeconds ?? duration
  useEffect(() => {
    if (ratingPromptChecked.current || !totalDuration || current / totalDuration < .85) return
    if (typeof sdk.rating !== 'function' || typeof sdk.unratedRatings !== 'function') return
    ratingPromptChecked.current = true
    // Persist the threshold-crossing position before asking for queue eligibility;
    // otherwise the five-second progress cadence can leave the server just below 85%.
    const progressReady = typeof sdk.saveProgress === 'function'
      ? sdk.saveProgress({ type: target.type, id: target.id, editionId: target.editionId, positionSeconds: current, durationSeconds: totalDuration, completed: false }).catch(() => {})
      : Promise.resolve()
    void progressReady.then(() => Promise.all([sdk.rating(target.type, target.id), sdk.unratedRatings()])).then(([rating, queue]) => {
      const queued = queue.items.some(item => item.subject.type === target.type && item.subject.id === target.id
        || item.children?.some(child => child.subject.type === target.type && child.subject.id === target.id))
      setPersonalRating(rating)
      setRatingPromptEligible(rating.source !== 'own' && Boolean(queued))
    }).catch(() => {})
  }, [current, totalDuration, sdk, target.type, target.id])
  const displayed = (vt: number) => (mode === 'compat' ? baseOffset + vt : vt)

  const norm = playbackPreferences.normalizeVolume ? playbackPreferences.targetLufs : undefined
  // Safari cannot play the progressive transcode — it wants byte ranges the
  // piped ffmpeg response has no way to serve — but it plays HLS natively, so
  // the compatibility stream is requested in whichever form this engine can
  // actually open. Everything else keeps the progressive one it already plays.
  const usesHls = nativeHlsSupported()
  const compatUrl = usesHls ? sdk.hlsUrl : sdk.transcodeUrl
  const copyCodecs = copyVideo ? detectCapabilities()?.videoCodecs : undefined
  const src = mode === 'compat'
    ? compatUrl.call(sdk, mediaType, target.id, { audio: audioIndex ?? undefined, subs: subIndex != null && subIndex >= 0 ? subIndex : undefined, t: baseOffset, norm, audioDelayMs, copyVideo: copyCodecs })
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
      void sdk.saveProgress({ type: target.type, id: target.id, editionId: target.editionId, positionSeconds: total, durationSeconds: total, completed: true }).catch(() => {})
    } else if (pos > 5) {
      saveProgress({ ...target, positionSeconds: pos, durationSeconds: total, completed: false })
      void sdk.saveProgress({ type: target.type, id: target.id, editionId: target.editionId, positionSeconds: pos, durationSeconds: total, completed: false }).catch(() => {})
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
  //
  // The playlist is the exception. It describes everything encoded so far, so a
  // seek inside that range is an ordinary seek the engine serves from segments
  // it already has — no new session, no re-encode, no wait. Only a seek past
  // the encoded edge has to restart the transcode, as the progressive stream
  // always does.
  const seek = (toSeconds: number) => {
    const clamped = Math.max(0, Math.min(toSeconds, (totalDuration || Infinity) - 0.25))
    const v = videoRef.current
    if (mode === 'compat') {
      const withinPlaylist = usesHls && v && clamped >= baseOffset
        && Array.from({ length: v.seekable.length }, (_, i) => v.seekable.end(i))
          .some(end => clamped - baseOffset <= end)
      if (withinPlaylist) {
        v.currentTime = clamped - baseOffset
        setCurrent(clamped)
        return
      }
      setCurrent(clamped)
      setBaseOffset(clamped)
    } else if (v) {
      v.currentTime = clamped
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
      // Transport, Back and the arrows belong to the OSD and the overlays, which
      // listen in the capture phase; only the keyboard skip is left here.
      if (e.key.toLowerCase() === 's') { skipActiveSegment(); poke() }
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
    startAt.current = fromSaved && saved ? saved.positionSeconds : 0
    if (mode === 'compat') {
      if (baseOffset !== startAt.current) setBaseOffset(startAt.current)
    } else if (v.readyState >= 1) {
      v.currentTime = startAt.current
    } else {
      pendingDirectSeek.current = startAt.current
    }
    v.play().catch(() => {})
  }

  const onVideoError = () => {
    // Direct play failed (codec/container). Fall back to transcoding rather than
    // erroring — the common HEVC / E-AC3 case.
    if (mode === 'direct') {
      decidedMode.current = true
      setBaseOffset(positionNow())
      pendingDirectSeek.current = null
      setMode('compat')
      return
    }
    // A copied picture this device turned out not to decode: encode it instead.
    if (copyCodecs?.length) {
      setBaseOffset(positionNow())
      setCopyVideo(false)
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

  const ratingPrompt = ratingPromptEligible ? <div className="rounded-2xl border border-white/10 bg-black/35 p-5">
    <p className="text-[10px] font-mono uppercase tracking-[.24em] text-white/40">How was it?</p>
    <div className="mt-4 flex flex-wrap items-center gap-4">
      <Level
        title={target.title}
        rating={personalRating}
        size="large"
        accent={target.type === 'film' ? '#00D4FF' : '#9B59B6'}
        showSource
        onCommit={async value => {
          if (typeof sdk.setRating !== 'function' || typeof sdk.clearRating !== 'function') return
          const resolved = value == null
            ? await sdk.clearRating(target.type, target.id)
            : await sdk.setRating(target.type, target.id, value)
          setPersonalRating(resolved)
          if (resolved.source === 'own') setRatingPromptEligible(false)
        }}
      />
      <button type="button" onClick={() => {
        setRatingPromptEligible(false)
        if (typeof sdk.dismissRatingPrompt === 'function') void sdk.dismissRatingPrompt(target.type, target.id).catch(() => {})
        if (postPlay && !target.recommendations?.length) closePlayer()
      }} className="player-focusable rounded-full bg-white/5 px-4 py-2 text-xs text-white/45 hover:bg-white/10 hover:text-white/75">Not now</button>
    </div>
  </div> : null

  return (
    <div ref={wrapRef} aria-hidden={minimized}
      {...(minimized ? {} : { role: 'dialog', 'aria-modal': true, 'aria-label': `Playing ${target.seriesTitle ?? target.title}` })}
      className={`${minimized ? 'pointer-events-none fixed left-0 top-0 -z-10 h-px w-px overflow-hidden opacity-0' : 'fixed inset-0 z-[100] bg-black animate-fade-in'}`} onMouseMove={poke}>
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
        onLoadedMetadata={e => {
          setError(null)
          const at = pendingDirectSeek.current
          if (mode === 'direct' && at != null) { pendingDirectSeek.current = null; e.currentTarget.currentTime = at }
        }}
        onEnded={() => {
          // In compatibility mode, the current fragment ending mid-film isn't the
          // real end — only finish when we're near the true duration.
          // A progressive transcode that ends early is a dropped connection or a
          // killed encoder; pick up from where it stopped rather than sit on a
          // black screen.
          const reached = baseOffset + (videoRef.current?.currentTime ?? 0)
          if (mode === 'compat' && reached < totalDuration - 5) {
            if (compatRestarts.current++ < 3) { setBaseOffset(reached); setRetryNonce(value => value + 1) }
            else setError('The stream kept stopping early. The server may be overloaded.')
            return
          }
          write(true)
          if (nextTarget && onAdvance) onAdvance(nextTarget)
          else if (ratingPromptEligible || target.recommendations?.length) { setPlaying(false); setPostPlay(true) }
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
        <PlayerOverlay label="Resume or start over" onBack={closePlayer} className="bg-black/80 flex items-center justify-center">
          <div className="text-center animate-slide-up">
            <p className="text-[10px] font-mono text-white/40 uppercase tracking-[0.3em] mb-2">Resume</p>
            <h2 className="font-display text-4xl text-white tracking-wide mb-6">{target.title}</h2>
            <div className="flex gap-3 justify-center">
              <button data-dialog-initial onClick={() => startPlayback(true)}
                className="player-focusable player-accent-bg px-8 py-3 rounded-xl font-bold tracking-widest text-[11px] uppercase hover:scale-105 transition-all">
                Resume {fmt(saved!.positionSeconds)}
              </button>
              <button onClick={() => { removeProgress(target.key); void sdk.deleteProgress(target.type, target.id).catch(() => {}); startPlayback(false) }}
                className="player-focusable px-8 py-3 rounded-xl bg-white/10 border border-white/15 text-white font-bold tracking-widest text-[11px] uppercase hover:bg-white/15 transition-all">
                Start Over
              </button>
            </div>
          </div>
        </PlayerOverlay>
      )}

      {error && (
        <PlayerOverlay label="Playback error" onBack={closePlayer} className="bg-black/85 flex items-center justify-center">
          <div className="text-center max-w-md px-6">
            <p className="text-sm text-red-400 mb-6">{error}</p>
            <div className="flex justify-center gap-3">
              <button onClick={() => { setError(null); setRetryNonce(value => value + 1) }} className="player-focusable px-8 py-3 rounded-xl bg-white text-black font-bold tracking-widest text-[11px] uppercase">Retry</button>
              <button onClick={closePlayer} className="player-focusable px-8 py-3 rounded-xl bg-white/10 border border-white/15 text-white font-bold tracking-widest text-[11px] uppercase">Close</button>
            </div>
          </div>
        </PlayerOverlay>
      )}

      {stillWatching && <PlayerOverlay label="Still watching?" onBack={() => { write(); closePlayer() }} className="z-40 grid place-items-center bg-black/82"><section className="player-dialog motion-dialog rounded-3xl p-9 text-center"><p className="text-xs uppercase tracking-[.25em] player-accent">Still watching?</p><h2 className="mt-3 text-3xl font-semibold">{target.seriesTitle ?? target.title}</h2><div className="mt-8 flex justify-center gap-3"><button data-dialog-initial onClick={() => { setStillWatching(false); void videoRef.current?.play() }} className="player-focusable player-accent-bg rounded-full px-7 py-3 font-bold">Continue</button><button onClick={() => { write(); closePlayer() }} className="player-focusable rounded-full bg-white/10 px-7 py-3 font-bold">Stop</button></div></section></PlayerOverlay>}

      {postPlay && <PlayerOverlay label="What to watch next" onBack={closePlayer} className="z-50 flex items-end bg-gradient-to-t from-black via-black/90 to-black/35 p-[var(--safe-x)]"><section className="motion-slide w-full">{ratingPrompt}<div className={ratingPrompt ? 'mt-8' : ''}><p className="text-xs font-semibold uppercase tracking-[.25em] player-accent">Because you watched {target.title}</p><h2 className="mt-3 text-4xl font-semibold">What to watch next</h2><div className="mt-7 flex gap-5 overflow-x-auto pb-4">{target.recommendations?.slice(0, 6).map(item => <button key={`${item.mediaType}:${item.id}`} onClick={() => onRecommendation?.(item)} className="player-focusable group w-64 shrink-0 overflow-hidden rounded-2xl bg-white/5 text-left ring-1 ring-white/10"><div className="aspect-video overflow-hidden bg-white/5">{item.backdropUrl && <img src={sdk.asset(item.backdropUrl)} alt="" className="h-full w-full object-cover transition group-hover:scale-105" />}</div><p className="truncate p-4 font-semibold">{item.title}</p></button>)}</div><button onClick={closePlayer} className="player-focusable mt-4 rounded-full bg-white/10 px-6 py-3 font-semibold">Back to library</button></div></section></PlayerOverlay>}

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
          onHiddenSelect={() => { if (!activeSegment) return false; skipActiveSegment(); return true }}
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
          ratingPrompt={ratingPrompt}
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

/**
 * A layer over the video that asks something — resume, retry, still watching,
 * what next. A modal so the remote stays on it, with its own first focus and its
 * own Back, and marked for the OSD to leave its keys alone while it is up.
 */
function PlayerOverlay({ label, onBack, className, children }: { label: string; onBack: () => void; className: string; children: ReactNode }) {
  const ref = useDialogFocus<HTMLDivElement>(true, onBack, { restoreFocus: false })
  return <div ref={ref} role="dialog" aria-modal="true" aria-label={label} data-osd-yield className={`absolute inset-0 ${className}`}>{children}</div>
}
