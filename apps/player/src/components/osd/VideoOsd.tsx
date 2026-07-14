import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MediaTracks } from '../../lib/sdk.js'

type Panel = 'info' | 'audio' | 'subtitles' | 'video' | 'queue' | null

export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = Math.floor(seconds % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function getSeekStep(heldMs: number): number { return heldMs >= 5000 ? 60 : heldMs >= 2000 ? 30 : 10 }

export function VideoOsd({ title, seriesTitle, plot, playing, current, duration, tracks, mode, audioIndex, subIndex,
  visible, queue, onInteraction, onHide, onToggle, onSeek, onStop, onMode, onAudio, onSub, onFullscreen, onMute }: {
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
  queue?: ReactNode
  onInteraction: () => void
  onHide: () => void
  onToggle: () => void
  onSeek: (seconds: number) => void
  onStop: () => void
  onMode: (mode: 'direct' | 'compat') => void
  onAudio: (index: number | null) => void
  onSub: (index: number | null) => void
  onFullscreen: () => void
  onMute: () => void
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
    if (playing) { setPauseInfo(false); return }
    const timer = window.setTimeout(() => setPauseInfo(true), 600)
    return () => clearTimeout(timer)
  }, [playing])
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
  return <div ref={rootRef} data-visible={visible || !playing ? 'true' : 'false'} className={`pointer-events-none absolute inset-0 z-20 transition-opacity ${visible || panel || !playing ? 'opacity-100' : 'opacity-0'}`}>
    {seekNotice && !visible && playing && <output className="absolute left-1/2 top-1/2 -translate-x-1/2 rounded-full bg-black/75 px-5 py-3 text-xl font-semibold text-white">{seekNotice}</output>}
    <header aria-hidden={!!panel || !visible && playing} className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/85 to-transparent p-8">
      <div className="max-w-3xl"><p className="text-2xl font-semibold">{seriesTitle ?? title}</p>{seriesTitle && <p className="mt-1 text-white/55">{title}</p>}{pauseInfo && plot && <p className="mt-4 line-clamp-3 text-base leading-relaxed text-white/60">{plot}</p>}</div>
    </header>
    <footer aria-hidden={!!panel || !visible && playing} className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-8 pt-24">
      <input aria-label="Playback position" type="range" min={0} max={Math.max(1, duration)} value={Math.min(current, Math.max(1, duration))} onChange={event => onSeek(Number(event.target.value))} className="pointer-events-auto h-1 w-full accent-[#00d4ff]" />
      <div className="mt-4 flex items-center gap-3">
        <OsdButton label={playing ? 'Pause' : 'Play'} onClick={onToggle}>{playing ? 'Ⅱ' : '▶'}</OsdButton>
        <OsdButton label="Back 10 seconds" onClick={() => onSeek(current - 10)}>−10</OsdButton>
        <OsdButton label="Forward 10 seconds" onClick={() => onSeek(current + 10)}>+10</OsdButton>
        <OsdButton label="Stop" onClick={onStop}>■</OsdButton>
        <span className="ml-2 text-sm font-mono text-white/60">{formatPlaybackTime(current)} / {formatPlaybackTime(duration)}</span>
        <div className="ml-auto flex gap-2"><OsdButton label="Information" onClick={() => open('info')}>i</OsdButton><OsdButton label="Audio" onClick={() => open('audio')}>Audio</OsdButton><OsdButton label="Subtitles" onClick={() => open('subtitles')}>CC</OsdButton><OsdButton label="Video mode" onClick={() => open('video')}>Video</OsdButton>{queue && <OsdButton label="Queue" onClick={() => open('queue')}>Queue</OsdButton>}<OsdButton label="Mute" onClick={onMute}>Mute</OsdButton><OsdButton label="Fullscreen" onClick={onFullscreen}>⛶</OsdButton></div>
      </div>
    </footer>
    {panel && <div ref={dialogRef} className="pointer-events-auto absolute inset-y-0 right-0 w-[min(34rem,42vw)] overflow-y-auto bg-noir-950/97 p-8 shadow-2xl ring-1 ring-white/10" role="dialog" aria-modal="true" aria-label={`${panel} options`}>
      <button onClick={closePanel} className="player-focusable mb-8 rounded-full bg-white/8 px-4 py-2">← Back</button>
      <h2 className="mb-6 text-3xl font-semibold capitalize">{panel === 'video' ? 'Video mode' : panel}</h2>
      {panel === 'info' && <div className="space-y-4 text-white/60"><p className="text-xl text-white">{seriesTitle ?? title}</p>{seriesTitle && <p>{title}</p>}<p>{plot || 'No additional information.'}</p><p className="font-mono text-sm">{mode === 'direct' ? 'Direct play' : 'Compatibility transcode'}</p></div>}
      {panel === 'audio' && (!tracks ? <p className="text-white/50">Loading tracks</p> : <div className="space-y-2">{audio.map(track => <PanelButton key={track.index} active={audioIndex === track.index || audioIndex == null && track.default} onClick={() => onAudio(track.index)}>{[track.language || 'Audio', track.title, track.channelLayout || (track.channels ? `${track.channels}ch` : null)].filter(Boolean).join(' · ')}</PanelButton>)}</div>)}
      {panel === 'subtitles' && (!tracks ? <p className="text-white/50">Loading tracks</p> : <div className="space-y-2"><PanelButton active={subIndex == null} onClick={() => onSub(null)}>Off</PanelButton>{subtitles.map(track => <PanelButton key={track.index} active={subIndex === track.index} onClick={() => onSub(track.index)}>{[track.language || 'Subtitle', track.title, track.forced ? 'Forced' : null].filter(Boolean).join(' · ')}</PanelButton>)}</div>)}
      {panel === 'video' && <div className="space-y-2"><PanelButton active={mode === 'direct'} onClick={() => onMode('direct')}>Direct play · original file</PanelButton><PanelButton active={mode === 'compat'} onClick={() => onMode('compat')}>Compatibility mode · H.264 + AAC</PanelButton></div>}
      {panel === 'queue' && queue}
    </div>}
  </div>
}

function OsdButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button data-osd-control aria-label={label} onClick={() => { onClick() }} className="player-focusable pointer-events-auto min-h-11 min-w-11 rounded-full bg-white/10 px-3 text-sm font-semibold text-white hover:bg-white hover:text-black">{children}</button>
}
function PanelButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`player-focusable w-full rounded-xl px-4 py-3 text-left ${active ? 'bg-cyan/15 text-cyan ring-1 ring-cyan/40' : 'bg-white/5 text-white/70'}`}>{active ? '✓ ' : ''}{children}</button>
}
