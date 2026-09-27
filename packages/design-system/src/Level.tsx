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
   * The Archivist Rating out of ten is halved by `catalogueRating`.
   */
  catalogue?: number | null
}

/**
 * Whole points keep the padded "04" the app uses; anything finer shows the
 * places it actually has, so 3.5 reads "03.5" and 3.75 reads "03.75" rather
 * than either gaining a meaningless zero or losing a real digit.
 */
const displayValue = (value: number) => {
  if (value <= 0) return '——'
  if (value % 1 === 0) return String(value).padStart(2, '0')
  const places = Math.round(value * 100) % 10 === 0 ? 1 : 2
  return value.toFixed(places).padStart(places + 3, '0')
}

/** Rounds to the nearest half point, which is the smallest step the slider has. */
const toHalf = (value: number) => Math.round(value * 2) / 2

/** Two decimal places, which is the finest a typed score may be. */
const toHundredth = (value: number) => Math.round(value * 100) / 100

/**
 * How far each of `scaleMax` segments is filled by `value`, from 0 to 1.
 *
 * A partial segment is drawn by narrowing the fill's own box, so it keeps the
 * border and the glow a whole segment gets instead of becoming a
 * different-looking thing. The slider only ever produces halves; a typed score
 * can land anywhere, and the same mechanism draws both.
 */
function segmentFills(value: number, scaleMax: number): number[] {
  return Array.from({ length: scaleMax }, (_, index) => {
    // Rounded because the fill reaches the DOM as a CSS variable, and
    // `4.37 - 4` is 0.3700000000000001 in binary floating point.
    const fill = Math.max(0, Math.min(1, value - index))
    return Math.round(fill * 10_000) / 10_000
  })
}

/** One segment. `--fill` is how much of its width the accent covers. */
function Segment({ fill, preview }: { fill: number; preview: number }) {
  return <span
    aria-hidden
    className={`archivist-level-segment ${fill > 0 ? 'on' : ''} ${fill > 0 && fill < 1 ? 'partial' : ''} ${preview > 0 ? 'preview' : ''}`}
    style={{ '--fill': fill, '--preview-fill': preview } as React.CSSProperties}
  />
}

/**
 * The Archivist Rating (0-10, as `films.rating` / `series.rating` carry it) on
 * the rating's own 0-5 scale. Kept to two decimal places rather than snapped to
 * a half point, because the segments can draw a partial fill and rounding a
 * weighted score to the nearest half throws away most of what distinguishes
 * one title from another. Anything outside 0-10 is a vote count rather than a
 * score and resolves to nothing.
 */
export function catalogueRating(providerScore: number | null | undefined): number | null {
  const value = Number(providerScore)
  if (!Number.isFinite(value) || value <= 0 || value > 10) return null
  return toHundredth(value / 2)
}

export function Level({ title, rating, onCommit, size = 'default', accent, className = '', disabled = false, showSource = false, catalogue = null }: LevelProps) {
  const [optimistic, setOptimistic] = useState(rating.value ?? 0)
  const [preview, setPreview] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  /** Rating with the arrows, entered with OK. Until then the arrows walk past. */
  const [adjusting, setAdjusting] = useState(false)
  const [focused, setFocused] = useState(false)
  const editor = useRef<HTMLInputElement | null>(null)
  const drag = useRef<{ pointerId: number; start: number; pending: number; moved: boolean } | null>(null)
  /** A value stepped to from the keyboard, saved once the presses stop. */
  const keyed = useRef<{ value: number; previous: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  useEffect(() => { if (!keyed.current) setOptimistic(rating.value ?? 0) }, [rating.value, rating.source])
  useEffect(() => { if (editing) editor.current?.select() }, [editing])

  const valueFromX = (element: HTMLElement, clientX: number) => {
    const box = element.getBoundingClientRect()
    const pad = 6
    const ratio = (clientX - box.left - pad) / Math.max(1, box.width - pad * 2)
    if (ratio < .04) return 0
    // Ceil to the half point the pointer is inside of, so the segment under the
    // cursor is always at least half lit rather than rounding back off it.
    return Math.max(.5, Math.min(rating.scaleMax, Math.ceil(ratio * rating.scaleMax * 2) / 2))
  }
  /**
   * Saves whatever the arrows last stepped to. Run when the presses rest, on
   * blur and on unmount, so a value left on screen is always a value saved.
   */
  const flushKeyed = async () => {
    const pending = keyed.current
    if (!pending) return
    clearTimeout(pending.timer)
    keyed.current = null
    if (pending.value === pending.previous) return
    try { await commitRef.current(pending.value === 0 ? null : pending.value) }
    catch { setOptimistic(pending.previous) }
  }
  useEffect(() => () => { void flushKeyed() }, [])
  const commit = async (next: number) => {
    const previous = optimistic
    setOptimistic(next)
    setPreview(null)
    try { await onCommit(next === 0 ? null : next) }
    catch { setOptimistic(previous) }
  }
  /**
   * A typed score, to two decimal places.
   *
   * The slider can only aim at half points; this is how the places between them
   * are reached. An empty box clears the score rather than setting zero, which
   * is what returns the title to its weighted rating.
   */
  const commitTyped = (raw: string) => {
    setEditing(false)
    const text = raw.trim()
    if (text === '') { if (optimistic !== 0) void commit(0); return }
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return
    const next = toHundredth(Math.max(0, Math.min(rating.scaleMax, parsed)))
    if (next !== optimistic) void commit(next)
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
  /**
   * The remote's two modes, the way a television rates.
   *
   * Passing over the rating does nothing to it: all four arrows move on to the
   * next control, as they would off any button. It used to take the arrows the
   * moment it had focus, so walking an episode's screen towards Play changed
   * the score on the way past and left no way off it.
   *
   * OK starts rating. Left and Right then move half a point a press — every
   * value the pointer can set — Delete or Home clear it, OK keeps it, and Back
   * puts back what was there before. Up and Down keep it too and move on.
   */
  const finishAdjusting = (keep: boolean) => {
    setAdjusting(false)
    const pending = keyed.current
    if (!pending) return
    if (keep) { void flushKeyed(); return }
    clearTimeout(pending.timer)
    keyed.current = null
    setOptimistic(pending.previous)
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const consume = () => { event.preventDefault(); event.stopPropagation() }
    if (!adjusting) {
      if (event.key === 'Enter' || event.key === ' ') { consume(); setAdjusting(true) }
      return
    }
    if (event.key === 'Enter' || event.key === ' ') { consume(); finishAdjusting(true); return }
    if (event.key === 'Escape' || event.key === 'BrowserBack' || event.key === 'Backspace') { consume(); finishAdjusting(false); return }
    // Leaves with the value kept; not consumed, so focus moves on in one press.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { finishAdjusting(true); return }
    const current = keyed.current?.value ?? optimistic
    let next: number | null = null
    if (event.key === 'ArrowRight') next = Math.min(rating.scaleMax, toHalf(current) + (toHalf(current) > current ? 0 : .5))
    if (event.key === 'ArrowLeft') next = Math.max(0, toHalf(current) - (toHalf(current) < current ? 0 : .5))
    if (event.key === 'Home' || event.key === 'Delete') next = 0
    if (next == null) return
    // Consumed even at either end: while rating, Left and Right are the rating's.
    consume()
    setOptimistic(next)
    setPreview(null)
    // The value moves at once; the save waits for the presses to stop.
    if (keyed.current) clearTimeout(keyed.current.timer)
    keyed.current = { value: next, previous: keyed.current?.previous ?? optimistic, timer: setTimeout(() => { void flushKeyed() }, 650) }
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
      data-adjusting={adjusting ? 'true' : 'false'}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={`Rating for ${title}`}
      aria-valuemin={0}
      aria-valuemax={rating.scaleMax}
      aria-valuenow={shown}
      aria-valuetext={shown ? `${shown} out of ${rating.scaleMax}${standIn && preview == null ? ', from the catalogue' : ''}` : 'Unrated'}
      onKeyDown={keyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); setAdjusting(false); void flushKeyed() }}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerCancel}
      onPointerLeave={() => { if (!drag.current) setPreview(null) }}
    >
      {segmentFills(shown, rating.scaleMax).map((fill, index) => (
        <Segment key={index} fill={fill} preview={preview == null ? 0 : Math.max(0, Math.min(1, preview - index))} />
      ))}
    </div>
    {editing ? (
      <input
        ref={editor}
        type="number"
        min={0}
        max={rating.scaleMax}
        step={0.01}
        defaultValue={optimistic === 0 ? '' : String(optimistic)}
        aria-label={`Archivist Score for ${title}, out of ${rating.scaleMax}`}
        className="archivist-level-editor"
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Enter') commitTyped(event.currentTarget.value)
          if (event.key === 'Escape') setEditing(false)
        }}
        onBlur={event => commitTyped(event.currentTarget.value)}
      />
    ) : (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        title="Type an Archivist Score to two decimal places"
        className={`archivist-level-readout archivist-level-readout-editable ${source === 'own' ? 'own' : ''}`}
      >
        {displayValue(shown)} / {String(rating.scaleMax).padStart(2, '0')}
      </button>
    )}
    {showSource && <span className="archivist-level-source">{sourceText}</span>}
    {focused && !disabled && <span aria-hidden className="archivist-level-hint">{adjusting ? '◀ ▶ to rate · OK to keep' : 'OK to rate'}</span>}
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
  const shown = Math.max(0, Math.min(scaleMax, toHundredth(value)))
  return <div className={'archivist-level-wrap ' + className} style={accent ? { '--accent': accent } as React.CSSProperties : undefined}>
    <div
      className={`archivist-level archivist-level-static archivist-level-${size}`}
      data-source={shown > 0 ? source : 'none'}
      role="img"
      aria-label={shown > 0 ? `${shown} out of ${scaleMax}${source === 'catalogue' ? ', from the catalogue' : ''}` : 'Unrated'}
    >
      {segmentFills(shown, scaleMax).map((fill, index) => <Segment key={index} fill={fill} preview={0} />)}
    </div>
    <span className={`archivist-level-readout ${source === 'own' ? 'own' : ''}`}>{displayValue(shown)} / {String(scaleMax).padStart(2, '0')}</span>
  </div>
}
