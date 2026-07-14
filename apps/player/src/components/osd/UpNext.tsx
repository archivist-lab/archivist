import { useEffect, useRef, useState } from 'react'
import type { PlayTarget } from '../Player.js'

export function shouldShowUpNext(currentTime: number, duration: number): boolean {
  if (!Number.isFinite(duration) || duration <= 60 || currentTime < 60) return false
  return currentTime >= Math.max(duration - 45, duration * 0.9)
}

export function UpNext({ currentTime, duration, next, cancelled, onPlay, onCancel }: {
  currentTime: number
  duration: number
  next: PlayTarget | null
  cancelled: boolean
  onPlay: () => void
  onCancel: () => void
}) {
  const visible = !!next && !cancelled && shouldShowUpNext(currentTime, duration)
  const deadline = useRef(0)
  const [remaining, setRemaining] = useState(15)
  useEffect(() => {
    if (!visible) { deadline.current = 0; setRemaining(15); return }
    if (!deadline.current) deadline.current = performance.now() + 15_000
    const tick = () => {
      const value = Math.max(0, Math.ceil((deadline.current - performance.now()) / 1000))
      setRemaining(value)
      if (value === 0) onPlay()
    }
    tick()
    const interval = window.setInterval(tick, 250)
    return () => clearInterval(interval)
  }, [visible, onPlay])
  useEffect(() => {
    if (!visible) return
    const cancel = (event: KeyboardEvent) => {
      if (!['Escape', 'BrowserBack', 'Backspace'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation(); onCancel()
    }
    window.addEventListener('keydown', cancel, true)
    return () => window.removeEventListener('keydown', cancel, true)
  }, [visible, onCancel])
  if (!visible || !next) return null
  return <aside className="absolute bottom-28 right-10 z-30 w-[28rem] overflow-hidden rounded-2xl bg-noir-900/95 p-5 shadow-2xl ring-1 ring-white/15" aria-live="polite">
    {(next.backdropUrl || next.posterUrl) && <img src={next.backdropUrl || next.posterUrl || ''} alt="" className="mb-4 h-28 w-full rounded-xl object-cover" />}
    <p className="text-[10px] font-mono uppercase tracking-[.25em] text-white/40">Up next in {remaining}</p>
    <h2 className="mt-2 text-xl font-semibold">{next.seriesTitle ?? next.title}</h2>
    {next.seriesTitle && <p className="mt-1 text-sm text-white/50">{next.title}</p>}
    <div className="mt-5 flex gap-3"><button autoFocus onClick={onPlay} className="player-focusable rounded-full bg-white px-5 py-2 font-bold text-black">Play now</button><button onClick={onCancel} className="player-focusable rounded-full bg-white/10 px-5 py-2">Cancel</button></div>
  </aside>
}
