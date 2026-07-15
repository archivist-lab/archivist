import { useEffect, useRef, useState } from 'react'
import type { ArchivistSdk, MediaTracks, PlaySession, SessionItem } from '../lib/sdk.js'
import type { PlayerPlaybackPreferences } from '@archivist/contracts'
import { saveProgress, usePlayerSelector, useSettings } from '../lib/store.js'
import { computeGainDb, useMediaGain } from '../lib/useMediaGain.js'
import { preferredTrackSelection, type PlayTarget } from './Player.js'
import { UpNext } from './osd/UpNext.js'
import { VideoOsd } from './osd/VideoOsd.js'
import { activeSegmentAt, SkipSegmentButton } from './SkipSegmentButton.js'

/**
 * Channel playback session player (archivist-channels.md §30). Plays a queue
 * built from the guide: auto-advances on completion, shows Up Next in the final
 * seconds, exposes the queue with skip/stop, and reports completed items back to
 * the server. Like the main player, it probes each item's tracks and falls back
 * to a server-side compatibility transcode when the file can't direct-play, with
 * audio/subtitle selection.
 */

const UP_NEXT_SECONDS = 15
const AUTO_SKIP_MIN_CONFIDENCE = 0.9

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
  const playerPlayback = usePlayerSelector(state => state.bootstrap?.featureFlags.uiV2Enabled ? state.preferences?.preferences.playback : undefined)
  const playbackPreferences: PlayerPlaybackPreferences = playerPlayback ?? {
    normalizeVolume: settings.normalizeVolume,
    targetLufs: settings.loudnessTarget as PlayerPlaybackPreferences['targetLufs'],
    preferredAudioLanguage: null,
    preferredSubtitleLanguage: null,
    subtitles: 'off',
  }
  const items = session.items
  const startIndex = Math.max(0, items.findIndex(i => i.queuePosition === session.currentPosition))
  const [index, setIndex] = useState(startIndex === -1 ? 0 : startIndex)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)  // displayed position (incl. baseOffset)
  const [duration, setDuration] = useState(0)
  const [showUi, setShowUi] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [upNextCancelled, setUpNextCancelled] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)

  const [tracks, setTracks] = useState<MediaTracks | null>(null)
  const [mode, setMode] = useState<'direct' | 'compat'>('direct')
  const [audioIndex, setAudioIndex] = useState<number | null>(null)
  const [subIndex, setSubIndex] = useState<number | null>(null)
  const [baseOffset, setBaseOffset] = useState(0)

  const videoRef = useRef<HTMLVideoElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const decidedMode = useRef(false)
  const autoSkipped = useRef(new Set<string>())
  const originFocusId = useRef((document.activeElement as HTMLElement | null)?.dataset.focusId ?? null)

  const item = items[index]
  const next = items[index + 1] ?? null
  const nextPlayable = !!next?.hasFile && !!next.streamUrl
  const mediaType = item.itemType === 'film' ? 'films' : 'episodes'
  const joinOffset = index === startIndex ? item.startOffsetSeconds : 0

  // Per-item setup: reset tracks/mode/selection, seed the join-live offset, and
  // probe. Auto-switch to compatibility mode when the file can't direct-play.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    decidedMode.current = false
    autoSkipped.current.clear()
    setTracks(null); setMode('direct'); setAudioIndex(null); setSubIndex(null); setUpNextCancelled(false)
    setBaseOffset(joinOffset); setCurrent(joinOffset); setDuration(0)
    const load = () => {
      attempt++
      sdk.mediaTracks(mediaType, item.itemId).then(t => {
        if (cancelled) return
        setTracks(t)
        const selection = preferredTrackSelection(t, playbackPreferences)
        setAudioIndex(selection.audioIndex)
        setSubIndex(selection.subIndex)
        if (!decidedMode.current && (!t.directPlayable || selection.requiresCompat)) {
          decidedMode.current = true
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  const totalDuration = tracks?.durationSec ?? item.runtimeSeconds ?? duration
  const displayed = (vt: number) => (mode === 'compat' ? baseOffset + vt : vt)
  const remaining = totalDuration ? totalDuration - current : Infinity
  const showUpNext = !!next && remaining <= UP_NEXT_SECONDS && remaining > 0

  const norm = playbackPreferences.normalizeVolume ? playbackPreferences.targetLufs : undefined
  const src = mode === 'compat'
    ? sdk.transcodeUrl(mediaType, item.itemId, { audio: audioIndex ?? undefined, subs: subIndex ?? undefined, t: baseOffset, norm })
    : (item.streamUrl ? sdk.asset(item.streamUrl, true) : '')

  const vttUrl = mode === 'direct' && subIndex != null ? sdk.subtitleUrl(mediaType, item.itemId, subIndex) : null

  const gainActive = mode === 'direct' && playbackPreferences.normalizeVolume && !!tracks?.loudness
  const gainDb = gainActive ? computeGainDb(tracks!.loudness, playbackPreferences.targetLufs) : 0
  const videoKey = `${src}::${gainActive ? `n${Math.round(gainDb)}` : 'd'}::${retryNonce}`
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
    if (next && !nextPlayable) { setError('The next item is not available. Playback has stopped at the current end frame.'); return }
    if (next) { setError(null); setIndex(index + 1) }
    else setDone(true)
  }

  const stop = () => {
    sdk.stopPlaySession(session.sessionId).catch(() => {})
    const focusId = originFocusId.current
    onClose()
    if (focusId) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(focusId)}"]`)?.focus())
  }

  const poke = () => {
    setShowUi(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setShowUi(false), 3000)
  }
  useEffect(() => {
    if (playing) poke()
    return () => clearTimeout(hideTimer.current)
  }, [playing])

  const seek = (toSeconds: number) => {
    const clamped = Math.max(0, Math.min(toSeconds, (totalDuration || Infinity) - 0.25))
    if (mode === 'compat') { setCurrent(clamped); setBaseOffset(clamped) }
    else { const v = videoRef.current; if (v) v.currentTime = clamped }
  }

  const activeSegment = activeSegmentAt(tracks, current, 1.5)
  const skipActiveSegment = () => {
    const segment = activeSegmentAt(tracks, current, 1.5)
    if (!segment || (segment.kind === 'credits' && showUpNext)) return
    if (segment.kind === 'credits' && next?.hasFile && next.streamUrl) void advance()
    else seek(segment.marker.end + 0.1)
  }

  useEffect(() => {
    const segment = activeSegmentAt(tracks, current)
    if (!segment) return
    const enabled = segment.kind === 'intro' ? settings.autoSkipIntro : settings.autoSkipCredits
    const key = `${segment.kind}:${segment.marker.start}:${segment.marker.end}`
    if (!enabled || segment.marker.confidence < AUTO_SKIP_MIN_CONFIDENCE || autoSkipped.current.has(key)) return
    if (segment.kind === 'credits' && showUpNext) return
    autoSkipped.current.add(key)
    // Credits may advance the channel only when the next scheduled item is
    // actually playable. Otherwise seek to the marker end and let normal end
    // handling decide what happens.
    if (segment.kind === 'credits' && next?.hasFile && next.streamUrl) void advance()
    else seek(segment.marker.end + 0.1)
  }, [current, tracks, settings.autoSkipIntro, settings.autoSkipCredits, index, mode, baseOffset, next, showUpNext])

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
      if (e.defaultPrevented) return
      const v = videoRef.current
      if (!v) return
      if (e.key === 'Escape') { stop(); return }
      if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause() }
      if (e.key === 'n' && next) advance()
      if (e.key === 'c') setSubIndex(null)
      if (e.key === 'f') wrapRef.current?.requestFullscreen?.()
      if (e.key === 'm') v.muted = !v.muted
      if (e.key.toLowerCase() === 's') skipActiveSegment()
      poke()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, next, mode, baseOffset, totalDuration, tracks, current])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    for (const tt of Array.from(v.textTracks)) tt.mode = vttUrl ? 'showing' : 'disabled'
  }, [vttUrl, src])

  const seekMax = mode === 'compat' ? (totalDuration || 1) : (duration || 1)
  const visibleSegment = showUpNext && activeSegment?.kind === 'credits' ? null : activeSegment
  const nextTarget: PlayTarget | null = nextPlayable && next ? {
    key: `${next.itemType}:${next.itemId}`, type: next.itemType, id: next.itemId,
    title: next.title, posterUrl: next.posterUrl, backdropUrl: next.backdropUrl,
    streamUrl: next.streamUrl ?? '', seriesId: next.seriesId ?? undefined,
    seriesTitle: next.seriesTitle ?? undefined,
  } : null

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
    <div ref={wrapRef} className="fixed inset-0 z-[100] bg-black animate-fade-in" onMouseMove={poke}>
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

      {!error && <SkipSegmentButton segment={visibleSegment} onSkip={skipActiveSegment} />}

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
              <button onClick={() => { setError(null); setRetryNonce(value => value + 1) }}
                className="player-focusable px-8 py-3 rounded-xl bg-white text-black font-bold tracking-widest text-[11px] uppercase">Retry</button>
              {nextPlayable && (
                <button onClick={() => { setError(null); advance() }}
                  className="player-focusable px-8 py-3 rounded-xl bg-cyan text-noir-950 font-bold tracking-widest text-[11px] uppercase">Skip to next</button>
              )}
              <button onClick={stop} className="player-focusable px-8 py-3 rounded-xl bg-white/10 border border-white/15 text-white font-bold tracking-widest text-[11px] uppercase">Stop</button>
            </div>
          </div>
        </div>
      )}

      {!error && <VideoOsd
        title={item.title}
        seriesTitle={item.seriesTitle ?? undefined}
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
        onToggle={() => { const video = videoRef.current; if (video) video.paused ? void video.play() : video.pause() }}
        onSeek={seek}
        onStop={stop}
        onMode={switchMode}
        onAudio={trackIndex => { setAudioIndex(trackIndex); if (mode === 'direct') switchMode('compat') }}
        onSub={setSubIndex}
        onFullscreen={() => void wrapRef.current?.requestFullscreen?.()}
        onMute={() => { const video = videoRef.current; if (video) video.muted = !video.muted }}
        queue={<div className="space-y-2">{items.map((queueItem, queueIndex) => (
          <button key={queueItem.id} onClick={() => { if (queueIndex !== index) setIndex(queueIndex) }}
            className={`player-focusable w-full rounded-xl border px-4 py-3 text-left ${queueIndex === index ? 'border-cyan/40 bg-cyan/10' : queueItem.completedAt ? 'border-transparent bg-white/[0.02] opacity-40' : 'border-transparent bg-white/[0.05]'}`}>
            <p className="truncate text-sm font-semibold">{queueItem.queuePosition}. {itemTitle(queueItem)}</p>
            <p className="mt-1 font-mono text-[10px] text-white/40">{new Date(queueItem.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} · {fmt(queueItem.runtimeSeconds)}</p>
          </button>
        ))}</div>}
      />}

      {!error && <UpNext currentTime={current} duration={totalDuration || duration} next={nextTarget}
        cancelled={upNextCancelled} onCancel={() => setUpNextCancelled(true)} onPlay={() => void advance()} />}
    </div>
  )
}
