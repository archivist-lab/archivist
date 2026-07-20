import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MediaTracks } from '../../lib/sdk.js'
import type { PersonCredit, PlayerBookmark, PlayerSubtitleSearchResult } from '@archivist/contracts'

type Panel = 'more' | 'info' | 'cast' | 'audio' | 'subtitles' | 'video' | 'speed' | 'chapters' | 'bookmarks' | 'queue' | null

export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = Math.floor(seconds % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function getSeekStep(heldMs: number): number { return heldMs >= 5000 ? 60 : heldMs >= 2000 ? 30 : 10 }

export function VideoOsd({ title, seriesTitle, plot, playing, current, duration, tracks, mode, audioIndex, subIndex,
  visible, queue, cast = [], playbackRate, audioDelayMs, subtitleDelayMs, bookmarks, subtitleResults, subtitleMessage,
  pauseBehavior, timeDisplay, onInteraction, onHide, onToggle, onSeek, onStop, onMode, onAudio, onSub,
  onRate, onAudioDelay, onSubtitleDelay, onAddBookmark, onDeleteBookmark, onSearchSubtitles, onDownloadSubtitle, onFullscreen, onMute, onMinimize }: {
  title: string
  seriesTitle?: string
  plot?: string | null
  playing: boolean
  current: number
  duration: number
  tracks: MediaTracks | null
  mode: 'direct' | 'compat'
  audioIndex: number | null
  subIndex: number | null
  visible: boolean
  playbackRate: number
  audioDelayMs: number
  subtitleDelayMs: number
  bookmarks: PlayerBookmark[]
  subtitleResults: PlayerSubtitleSearchResult[]
  subtitleMessage: string | null
  pauseBehavior: 'minimal' | 'after-delay' | 'always'
  timeDisplay: 'elapsed-total' | 'elapsed-remaining'
  queue?: ReactNode
  cast?: PersonCredit[]
  onInteraction: () => void
  onHide: () => void
  onToggle: () => void
  onSeek: (seconds: number) => void
  onStop: () => void
  onMode: (mode: 'direct' | 'compat') => void
  onAudio: (index: number | null) => void
  onSub: (index: number | null) => void
  onRate: (rate: number) => void
  onAudioDelay: (milliseconds: number) => void
  onSubtitleDelay: (milliseconds: number) => void
  onAddBookmark: () => void
  onDeleteBookmark: (id: number) => void
  onSearchSubtitles: () => void
  onDownloadSubtitle: (result: PlayerSubtitleSearchResult) => void
  onFullscreen: () => void
  onMute: () => void
  onMinimize?: () => void
}) {
  const [panel, setPanel] = useState<Panel>(null)
  const [pauseInfo, setPauseInfo] = useState(false)
  const [seekNotice, setSeekNotice] = useState<string | null>(null)
  const held = useRef<{ key: string; started: number; interval: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const seekNoticeTimer = useRef<number | null>(null)
  const currentRef = useRef(current)
  const panelValueRef = useRef<Panel>(panel)
  const seekRef = useRef(onSeek)
  const interactionRef = useRef(onInteraction)
  const hideRef = useRef(onHide)
  const toggleRef = useRef(onToggle)
  const stopRef = useRef(onStop)
  const fullscreenRef = useRef(onFullscreen)
  const muteRef = useRef(onMute)
  const dialogRef = useRef<HTMLDivElement>(null)
  const panelOrigin = useRef<HTMLElement | null>(null)
  currentRef.current = current
  panelValueRef.current = panel
  seekRef.current = onSeek
  interactionRef.current = onInteraction
  hideRef.current = onHide
  toggleRef.current = onToggle
  stopRef.current = onStop
  fullscreenRef.current = onFullscreen
  muteRef.current = onMute
  const open = (next: Panel) => { panelOrigin.current = document.activeElement as HTMLElement | null; setPanel(next); onInteraction() }
  useEffect(() => {
    if (playing || pauseBehavior === 'minimal') { setPauseInfo(false); return }
    if (pauseBehavior === 'always') { setPauseInfo(true); return }
    const timer = window.setTimeout(() => setPauseInfo(true), 600)
    return () => clearTimeout(timer)
  }, [playing, pauseBehavior])
  useEffect(() => {
    const stopHeld = () => { if (held.current) { clearInterval(held.current.interval); held.current = null } }
    const controls = () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-osd-control]') ?? [])
    const moveControl = (direction: -1 | 1) => {
      const items = controls()
      if (!items.length) return
      const index = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
      items[Math.max(0, Math.min(items.length - 1, index + direction))].focus()
    }
    const showSeekNotice = (direction: number, step: number) => {
      setSeekNotice(`${direction < 0 ? '−' : '+'}${step}s`)
      if (seekNoticeTimer.current) clearTimeout(seekNoticeTimer.current)
      seekNoticeTimer.current = window.setTimeout(() => setSeekNotice(null), 650)
    }
    const down = (event: KeyboardEvent) => {
      if (panelValueRef.current) return
      const key = event.key.toLowerCase()
      if (key === 'arrowup') { event.preventDefault(); event.stopPropagation(); interactionRef.current(); return }
      if (key === 'arrowdown') { event.preventDefault(); event.stopPropagation(); hideRef.current(); return }
      if (key === 'a' || key === 'c' || key === 'i') {
        event.preventDefault(); event.stopPropagation()
        panelOrigin.current = document.activeElement as HTMLElement | null
        setPanel(key === 'a' ? 'audio' : key === 'c' ? 'subtitles' : 'info')
        interactionRef.current(); return
      }
      if (key === 'escape') { event.preventDefault(); event.stopPropagation(); stopRef.current(); return }
      if (key === 'enter') {
        const active = document.activeElement as HTMLElement | null
        if (rootRef.current?.contains(active)) { event.preventDefault(); event.stopPropagation(); active?.click() }
        return
      }
      if (key === ' ' || key === 'mediaplaypause') { event.preventDefault(); event.stopPropagation(); toggleRef.current(); return }
      if (key === 'f') { event.preventDefault(); event.stopPropagation(); fullscreenRef.current(); return }
      if (key === 'm') { event.preventDefault(); event.stopPropagation(); muteRef.current(); return }
      if (!['arrowleft', 'arrowright'].includes(key)) return
      event.preventDefault(); event.stopPropagation()
      const seekBarFocused = (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') === 'Playback position'
      if (rootRef.current?.dataset.visible === 'true' && !seekBarFocused) {
        stopHeld(); moveControl(key === 'arrowleft' ? -1 : 1); interactionRef.current(); return
      }
      if (held.current) return
      const started = performance.now()
      const direction = key === 'arrowleft' ? -1 : 1
      const seek = () => {
        const step = getSeekStep(performance.now() - started)
        seekRef.current(currentRef.current + direction * step)
        showSeekNotice(direction, step)
      }
      seek()
      const interval = window.setInterval(seek, 250)
      held.current = { key: event.key, started, interval }
    }
    const up = (event: KeyboardEvent) => { if (held.current?.key === event.key) stopHeld() }
    window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', stopHeld)
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', stopHeld); stopHeld(); if (seekNoticeTimer.current) clearTimeout(seekNoticeTimer.current) }
  }, [])

  useEffect(() => {
    if (!visible || panel) return
    const active = document.activeElement as HTMLElement | null
    if (!rootRef.current?.contains(active)) rootRef.current?.querySelector<HTMLButtonElement>('[data-osd-control]')?.focus()
  }, [visible, panel])

  useEffect(() => {
    if (!panel) return
    const dialog = dialogRef.current
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])') ?? [])
    focusable()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setPanel(null); panelOrigin.current?.focus(); return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) { event.preventDefault(); return }
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [panel])

  const closePanel = () => { setPanel(null); requestAnimationFrame(() => panelOrigin.current?.focus()) }
  const audio = tracks?.audio ?? []
  const subtitles = mode === 'compat' ? tracks?.subtitles ?? [] : (tracks?.subtitles ?? []).filter(track => track.textBased)
  return <div ref={rootRef} data-visible={visible || !playing ? 'true' : 'false'} className={`pointer-events-none absolute inset-0 z-20 [contain:layout_paint] transition-opacity ${visible || panel || !playing ? 'opacity-100' : 'opacity-0'}`}>
    {seekNotice && !visible && playing && <output className="absolute left-1/2 top-1/2 -translate-x-1/2 rounded-full bg-black/75 px-5 py-3 text-xl font-semibold text-white">{seekNotice}</output>}
    <header aria-hidden={!!panel || !visible && playing} className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/85 to-transparent p-8">
      <div className="max-w-3xl"><p className="text-2xl font-semibold">{seriesTitle ?? title}</p>{seriesTitle && <p className="mt-1 text-white/55">{title}</p>}{pauseInfo && plot && <p className="mt-4 line-clamp-3 text-base leading-relaxed text-white/60">{plot}</p>}</div>
    </header>
    <footer aria-hidden={!!panel || !visible && playing} className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-8 pt-24">
      <input aria-label="Playback position" type="range" min={0} max={Math.max(1, duration)} value={Math.min(current, Math.max(1, duration))} onChange={event => onSeek(Number(event.target.value))} className="pointer-events-auto h-1 w-full [accent-color:var(--player-accent)]" />
      <div data-osd-layer="primary" className="mt-4 flex items-center gap-3">
        <OsdButton label={playing ? 'Pause' : 'Play'} onClick={onToggle}>{playing ? 'Ⅱ' : '▶'}</OsdButton>
        <OsdButton label="Back 10 seconds" onClick={() => onSeek(current - 10)}>−10</OsdButton>
        <OsdButton label="Forward 10 seconds" onClick={() => onSeek(current + 10)}>+10</OsdButton>
        <OsdButton label="Stop" onClick={onStop}>■</OsdButton>
        <span className="ml-2 text-sm font-mono text-white/60">{formatPlaybackTime(current)} / {timeDisplay === 'elapsed-remaining' ? `−${formatPlaybackTime(Math.max(0, duration - current))}` : formatPlaybackTime(duration)}</span>
        <div className="ml-auto flex gap-2">{onMinimize && <OsdButton label="Minimize player" onClick={onMinimize}>Minimize</OsdButton>}<OsdButton label="Audio" onClick={() => open('audio')}>Audio</OsdButton><OsdButton label="Subtitles" onClick={() => open('subtitles')}>CC</OsdButton><OsdButton label="More controls" onClick={() => open('more')}>More</OsdButton></div>
      </div>
    </footer>
    {panel && <div ref={dialogRef} data-osd-panel={panel} className="pointer-events-auto absolute inset-y-0 right-0 w-[min(34rem,42vw)] overflow-y-auto bg-noir-950/97 p-8 shadow-2xl ring-1 ring-white/10 [contain:layout_paint]" role="dialog" aria-modal="true" aria-label={`${panel} options`}>
      <button onClick={closePanel} className="player-focusable mb-8 rounded-full bg-white/8 px-4 py-2">← Back</button>
      <h2 className="mb-6 text-3xl font-semibold capitalize">{panel === 'video' ? 'Video mode' : panel === 'more' ? 'More controls' : panel}</h2>
      {panel === 'more' && <div className="space-y-2"><PanelButton active={false} onClick={() => setPanel('info')}>Information</PanelButton>{cast.length > 0 && <PanelButton active={false} onClick={() => setPanel('cast')}>Cast</PanelButton>}<PanelButton active={playbackRate !== 1} onClick={() => setPanel('speed')}>Playback speed · {playbackRate}×</PanelButton>{!!tracks?.chapters.length && <PanelButton active={false} onClick={() => setPanel('chapters')}>Chapters</PanelButton>}<PanelButton active={false} onClick={() => setPanel('bookmarks')}>Bookmarks</PanelButton><PanelButton active={mode === 'compat'} onClick={() => setPanel('video')}>Video mode · {mode === 'direct' ? 'Direct play' : 'Compatibility'}</PanelButton>{queue && <PanelButton active={false} onClick={() => setPanel('queue')}>Queue</PanelButton>}<PanelButton active={false} onClick={() => { onMute(); closePanel() }}>Mute</PanelButton><PanelButton active={false} onClick={() => { onFullscreen(); closePanel() }}>Fullscreen</PanelButton></div>}
      {panel === 'info' && <div className="space-y-4 text-white/60"><p className="text-xl text-white">{seriesTitle ?? title}</p>{seriesTitle && <p>{title}</p>}<p>{plot || 'No additional information.'}</p><div className="grid grid-cols-2 gap-3 rounded-2xl bg-white/5 p-4 font-mono text-sm"><span>Process</span><strong className="text-white">{mode === 'direct' ? 'Direct play' : 'Compatibility transcode'}</strong><span>Container</span><strong className="text-white">{tracks?.container ?? 'Unknown'}</strong><span>Video</span><strong className="text-white">{[tracks?.video?.codec, tracks?.video?.profile].filter(Boolean).join(' · ') || 'Unknown'}</strong><span>Audio</span><strong className="text-white">{audio.find(track => track.index === audioIndex)?.codec ?? audio.find(track => track.default)?.codec ?? audio[0]?.codec ?? 'Unknown'}</strong><span>Speed</span><strong className="text-white">{playbackRate}×</strong></div></div>}
      {panel === 'cast' && <div className="space-y-2">{cast.slice(0, 30).map((person, index) => <div key={`${person.id ?? person.name}-${index}`} className="flex items-center gap-4 rounded-xl bg-white/5 p-3">{person.profileUrl ? <img src={person.profileUrl} alt="" className="h-14 w-14 rounded-full object-cover" /> : <span className="grid h-14 w-14 place-items-center rounded-full bg-white/8 text-lg">{person.name.slice(0, 1)}</span>}<div className="min-w-0"><p className="truncate font-semibold">{person.name}</p><p className="truncate text-sm text-white/45">{person.role ?? 'Cast'}</p></div></div>)}</div>}
      {panel === 'audio' && (!tracks ? <p className="text-white/50">Loading tracks</p> : <div className="space-y-2">{audio.map(track => <PanelButton key={track.index} active={audioIndex === track.index || audioIndex == null && track.default} onClick={() => onAudio(track.index)}>{[track.language || 'Audio', track.title, track.channelLayout || (track.channels ? `${track.channels}ch` : null)].filter(Boolean).join(' · ')}</PanelButton>)}<h3 className="pt-5 font-semibold">Audio delay</h3><p className="text-sm text-white/45">Compatibility mode · {audioDelayMs > 0 ? '+' : ''}{audioDelayMs} ms</p><div className="flex gap-2"><PanelButton active={false} onClick={() => onAudioDelay(audioDelayMs - 100)}>−100</PanelButton><PanelButton active={audioDelayMs === 0} onClick={() => onAudioDelay(0)}>Reset</PanelButton><PanelButton active={false} onClick={() => onAudioDelay(audioDelayMs + 100)}>+100</PanelButton></div></div>)}
      {panel === 'subtitles' && (!tracks ? <p className="text-white/50">Loading tracks</p> : <div className="space-y-2"><PanelButton active={subIndex == null} onClick={() => onSub(null)}>Off</PanelButton>{subtitles.map(track => <PanelButton key={track.index} active={subIndex === track.index} onClick={() => onSub(track.index)}>{[track.language || 'Subtitle', track.title, track.forced ? 'Forced' : null].filter(Boolean).join(' · ')}</PanelButton>)}<h3 className="pt-5 font-semibold">Subtitle delay</h3><p className="text-sm text-white/45">{subtitleDelayMs > 0 ? '+' : ''}{subtitleDelayMs} ms</p><div className="flex gap-2"><PanelButton active={false} onClick={() => onSubtitleDelay(subtitleDelayMs - 100)}>−100</PanelButton><PanelButton active={subtitleDelayMs === 0} onClick={() => onSubtitleDelay(0)}>Reset</PanelButton><PanelButton active={false} onClick={() => onSubtitleDelay(subtitleDelayMs + 100)}>+100</PanelButton></div><h3 className="pt-5 font-semibold">OpenSubtitles</h3><PanelButton active={false} onClick={onSearchSubtitles}>Search online</PanelButton>{subtitleMessage && <p className="text-sm text-white/55">{subtitleMessage}</p>}{subtitleResults.slice(0, 12).map(result => <PanelButton key={result.id} active={false} onClick={() => onDownloadSubtitle(result)}>{result.language.toUpperCase()} · {result.fileName} · ★ {result.rating}</PanelButton>)}</div>)}
      {panel === 'video' && <div className="space-y-2"><PanelButton active={mode === 'direct'} onClick={() => onMode('direct')}>Direct play · original file</PanelButton><PanelButton active={mode === 'compat'} onClick={() => onMode('compat')}>Compatibility mode · H.264 + AAC</PanelButton></div>}
      {panel === 'speed' && <div className="space-y-2">{[.5,.75,1,1.25,1.5,1.75,2].map(rate => <PanelButton key={rate} active={playbackRate === rate} onClick={() => onRate(rate)}>{rate}×</PanelButton>)}</div>}
      {panel === 'chapters' && <div className="space-y-2">{tracks?.chapters.map(chapter => <PanelButton key={`${chapter.index}-${chapter.start}`} active={current >= chapter.start && (chapter.end == null || current < chapter.end)} onClick={() => { onSeek(chapter.start); closePanel() }}>{formatPlaybackTime(chapter.start)} · {chapter.title}</PanelButton>)}</div>}
      {panel === 'bookmarks' && <div className="space-y-2"><PanelButton active={false} onClick={onAddBookmark}>+ Add at {formatPlaybackTime(current)}</PanelButton>{bookmarks.map(bookmark => <div key={bookmark.id} className="flex gap-2"><button onClick={() => { onSeek(bookmark.positionSeconds); closePanel() }} className="player-focusable flex-1 rounded-xl bg-white/5 px-4 py-3 text-left">{formatPlaybackTime(bookmark.positionSeconds)} · {bookmark.label}</button><button aria-label={`Delete ${bookmark.label}`} onClick={() => onDeleteBookmark(bookmark.id)} className="player-focusable rounded-xl px-4 text-pink">×</button></div>)}</div>}
      {panel === 'queue' && queue}
    </div>}
  </div>
}

function OsdButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button data-osd-control aria-label={label} onClick={() => { onClick() }} className="player-focusable pointer-events-auto min-h-11 min-w-11 rounded-full bg-white/10 px-3 text-sm font-semibold text-white hover:bg-white hover:text-black">{children}</button>
}
function PanelButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`player-focusable w-full rounded-xl px-4 py-3 text-left ${active ? 'player-accent-soft ring-1 player-accent-border' : 'bg-white/5 text-white/70'}`}>{active ? '✓ ' : ''}{children}</button>
}
