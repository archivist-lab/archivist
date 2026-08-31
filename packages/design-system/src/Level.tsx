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
  /**
   * The catalogue's own score for this item, on the same 0-`scaleMax` scale.
   * Shown, greyed, when nothing personal is set — so an unrated item still says
   * what the world thinks of it — and replaced the moment a rating is made.
   * A provider score out of ten is halved by `catalogueRating`.
   */
  catalogue?: number | null
}

/** Half points read as "3.5"; whole ones keep the padded "04" the app uses. */
const displayValue = (value: number) => {
  if (value <= 0) return '——'
  return value % 1 === 0 ? String(value).padStart(2, '0') : value.toFixed(1).padStart(4, '0')
}

/** Rounds to the nearest half point, which is the smallest step a rating has. */
const toHalf = (value: number) => Math.round(value * 2) / 2

/**
 * How far each of `scaleMax` segments is filled by `value`: 1, .5 or 0. A half
 * is drawn by narrowing the fill's own box, so it keeps the border and the glow
 * a whole segment gets instead of becoming a different-looking thing.
 */
function segmentFills(value: number, scaleMax: number): number[] {
  return Array.from({ length: scaleMax }, (_, index) => Math.max(0, Math.min(1, value - index)))
}

/**
 * A provider score (0-10, as TMDB and friends report it) on the rating's own
 * 0-5 scale, snapped to the nearest half point. Anything outside 0-10 is a vote
 * count rather than a score and resolves to nothing.
 */
export function catalogueRating(providerScore: number | null | undefined): number | null {
  const value = Number(providerScore)
  if (!Number.isFinite(value) || value <= 0 || value > 10) return null
  return toHalf(value / 2)
}

export function Level({ title, rating, onCommit, size = 'default', accent, className = '', disabled = false, showSource = false, catalogue = null }: LevelProps) {
  const [optimistic, setOptimistic] = useState(rating.value ?? 0)
  const [preview, setPreview] = useState<number | null>(null)
  const drag = useRef<{ pointerId: number; start: number; pending: number; moved: boolean } | null>(null)
  useEffect(() => setOptimistic(rating.value ?? 0), [rating.value, rating.source])

  const valueFromX = (element: HTMLElement, clientX: number) => {
    const box = element.getBoundingClientRect()
    const pad = 6
    const ratio = (clientX - box.left - pad) / Math.max(1, box.width - pad * 2)
    if (ratio < .04) return 0
    // Ceil to the half point the pointer is inside of, so the segment under the
    // cursor is always at least half lit rather than rounding back off it.
    return Math.max(.5, Math.min(rating.scaleMax, Math.ceil(ratio * rating.scaleMax * 2) / 2))
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
    // Half a point a press, so every value the pointer can set is reachable
    // from a keyboard and a remote too.
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(rating.scaleMax, optimistic + .5)
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, optimistic - .5)
    if (event.key === 'Home' || event.key === 'Backspace') next = 0
    if (next == null) return
    event.preventDefault()
    event.stopPropagation()
    void commit(next)
  }
  /*
   * What the segments draw. A personal rating wins; with none set the
   * catalogue's score stands in, and `source` says so — which is what colours
   * it apart, rather than passing it off as something the viewer chose.
   */
  const standIn = optimistic === 0 && catalogue != null && catalogue > 0
  const shown = preview ?? (standIn ? catalogue : optimistic)
  const source = optimistic === 0 ? (standIn ? 'catalogue' : 'none') : rating.source
  const sourceText = source === 'own' ? 'set here'
    : source === 'catalogue' ? 'catalogue'
    : source === 'inherited' && rating.inheritedFrom ? `from ${rating.inheritedFrom.type}` : ''

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
      aria-valuetext={shown ? `${shown} out of ${rating.scaleMax}${standIn && preview == null ? ', from the catalogue' : ''}` : 'Unrated'}
      onKeyDown={keyDown}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerCancel}
      onPointerLeave={() => { if (!drag.current) setPreview(null) }}
    >
      {segmentFills(shown, rating.scaleMax).map((fill, index) => {
        const previewFill = preview == null ? 0 : Math.max(0, Math.min(1, preview - index))
        return <span
          key={index}
          aria-hidden
          className={`archivist-level-segment ${fill > 0 ? 'on' : ''} ${fill === .5 ? 'half' : ''} ${previewFill > 0 ? 'preview' : ''}`}
        />
      })}
    </div>
    <span className={`archivist-level-readout ${source === 'own' ? 'own' : ''}`}>{displayValue(shown)} / {String(rating.scaleMax).padStart(2, '0')}</span>
    {showSource && <span className="archivist-level-source">{sourceText}</span>}
  </div>
}

/**
 * The same rating, read only.
 *
 * Surfaces that show a rating without offering to change it — a browse row, an
 * item page's meta line — get the identical segments rather than a second
 * vocabulary of stars beside the first. It is deliberately not focusable: the
 * slider swallows the arrow keys to move its own value, which would trap a
 * remote walking past a rating it cannot set anyway.
 */
export function LevelStatic({ value, source, scaleMax = 5, size = 'default', accent, className = '' }: {
  value: number
  /** 'own' for the viewer's own rating, 'catalogue' for the score standing in for it. */
  source: 'own' | 'catalogue' | 'inherited'
  scaleMax?: number
  size?: LevelSize
  accent?: string
  className?: string
}) {
  const shown = Math.max(0, Math.min(scaleMax, toHalf(value)))
  return <div className={'archivist-level-wrap ' + className} style={accent ? { '--accent': accent } as React.CSSProperties : undefined}>
    <div
      className={`archivist-level archivist-level-static archivist-level-${size}`}
      data-source={shown > 0 ? source : 'none'}
      role="img"
      aria-label={shown > 0 ? `${shown} out of ${scaleMax}${source === 'catalogue' ? ', from the catalogue' : ''}` : 'Unrated'}
    >
      {segmentFills(shown, scaleMax).map((fill, index) => <span
        key={index}
        aria-hidden
        className={`archivist-level-segment ${fill > 0 ? 'on' : ''} ${fill === .5 ? 'half' : ''}`}
      />)}
    </div>
    <span className={`archivist-level-readout ${source === 'own' ? 'own' : ''}`}>{displayValue(shown)} / {String(scaleMax).padStart(2, '0')}</span>
  </div>
}
