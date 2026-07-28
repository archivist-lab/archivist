import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { ResolvedRating } from '@archivist/contracts'

export type LevelSize = 'compact' | 'default' | 'large'

export interface LevelProps {
  title: string
  rating: ResolvedRating
  onCommit: (value: number | null) => void | Promise<void>
  size?: LevelSize
  accent?: string
  className?: string
  disabled?: boolean
  showSource?: boolean
}

const displayValue = (value: number) => value > 0 ? String(value).padStart(2, '0') : '——'

export function Level({ title, rating, onCommit, size = 'default', accent, className = '', disabled = false, showSource = false }: LevelProps) {
  const [optimistic, setOptimistic] = useState(rating.value ?? 0)
  const [preview, setPreview] = useState<number | null>(null)
  const drag = useRef<{ pointerId: number; start: number; pending: number; moved: boolean } | null>(null)
  useEffect(() => setOptimistic(rating.value ?? 0), [rating.value, rating.source])

  const valueFromX = (element: HTMLElement, clientX: number) => {
    const box = element.getBoundingClientRect()
    const pad = 6
    const ratio = (clientX - box.left - pad) / Math.max(1, box.width - pad * 2)
    if (ratio < .04) return 0
    return Math.max(1, Math.min(rating.scaleMax, Math.ceil(ratio * rating.scaleMax)))
  }
  const commit = async (next: number) => {
    const previous = optimistic
    setOptimistic(next)
    setPreview(null)
    try { await onCommit(next === 0 ? null : next) }
    catch { setOptimistic(previous) }
  }
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    const pending = valueFromX(event.currentTarget, event.clientX)
    drag.current = { pointerId: event.pointerId, start: pending, pending, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    setPreview(pending)
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.pointerType === 'touch' && !drag.current) return
    const pending = valueFromX(event.currentTarget, event.clientX)
    if (drag.current) {
      if (pending !== drag.current.pending) {
        drag.current.pending = pending
        drag.current.moved = true
        navigator.vibrate?.(6)
      }
    }
    setPreview(pending)
  }
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    drag.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    const next = !state.moved && state.pending === optimistic ? 0 : state.pending
    void commit(next)
  }
  const pointerCancel = () => { drag.current = null; setPreview(null) }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(rating.scaleMax, optimistic + 1)
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, optimistic - 1)
    if (event.key === 'Home' || event.key === 'Backspace') next = 0
    if (next == null) return
    event.preventDefault()
    event.stopPropagation()
    void commit(next)
  }
  const shown = preview ?? optimistic
  const source = optimistic === 0 ? 'none' : rating.source
  const sourceText = source === 'own' ? 'set here' : source === 'inherited' && rating.inheritedFrom ? `from ${rating.inheritedFrom.type}` : ''

  return <div className={'archivist-level-wrap ' + className} style={accent ? { '--accent': accent } as React.CSSProperties : undefined}>
    <div
      className={`archivist-level player-focusable archivist-level-${size}`}
      data-source={source}
      data-previewing={preview == null ? 'false' : 'true'}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={`Rating for ${title}`}
      aria-valuemin={0}
      aria-valuemax={rating.scaleMax}
      aria-valuenow={shown}
      aria-valuetext={shown ? `${shown} out of ${rating.scaleMax}` : 'Unrated'}
      onKeyDown={keyDown}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerCancel}
      onPointerLeave={() => { if (!drag.current) setPreview(null) }}
    >
      {Array.from({ length: rating.scaleMax }, (_, index) => {
        const segment = index + 1
        return <span key={segment} aria-hidden className={`archivist-level-segment ${segment <= optimistic ? 'on' : ''} ${preview != null && segment <= preview ? 'preview' : ''}`} />
      })}
    </div>
    <span className={`archivist-level-readout ${source === 'own' ? 'own' : ''}`}>{displayValue(shown)} / {String(rating.scaleMax).padStart(2, '0')}</span>
    {showSource && <span className="archivist-level-source">{sourceText}</span>}
  </div>
}
