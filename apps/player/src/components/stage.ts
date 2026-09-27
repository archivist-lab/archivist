import { useEffect, useRef, useState } from 'react'
import { onAndroidTelevision } from '../lib/android.js'

export interface Stage {
  /** Factor the 1920x1080 design canvas is drawn at. */
  scale: number
  /** The canvas widened to the viewport's aspect ratio, in design units. */
  width: number
}

/**
 * Fits a fixed 1920x1080 design canvas to whatever box it is rendered in.
 *
 * Scale uniformly from the height, then widen the canvas to the viewport's
 * aspect ratio. That reaches both horizontal edges without stretching type,
 * artwork, focus rings or anything else.
 *
 * The app sets `html { zoom: .85 }` above 1024px, so the CSS-pixel box of a
 * fixed element is about 1.18x the reported window size. Measuring the window
 * scaled the stage to 85% of the screen and left a dead margin, and
 * getBoundingClientRect is already zoom-adjusted, so the element is measured
 * instead — which is also immune to any chrome that may sit around it later.
 *
 * Below 900px wide, or taller than it is wide, the stage is abandoned for a
 * flowing layout: a phone cannot usefully show a television screen shrunk.
 *
 * A coarse pointer abandons it too, whatever the size. The stage does not
 * scroll — its rows move by a cursor the arrow keys drive — so on a touch
 * screen there is simply nothing to drag, and a landscape tablet at 1024x768
 * passed both size tests and arrived at a screen that could not be moved at
 * all. `pointer: coarse` is true for touch and stylus, false for a mouse or
 * trackpad (including on a touchscreen laptop, where the trackpad is primary),
 * and false for a television remote, which reports `pointer: none` and drives
 * the stage perfectly well with its arrows.
 */
export function useStage() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const [stage, setStage] = useState<Stage>({ scale: 1, width: 1920 })
  useEffect(() => {
    const fit = () => {
      const box = rootRef.current?.getBoundingClientRect()
      const w = box?.width || window.innerWidth
      const h = box?.height || window.innerHeight
      // Some TV WebViews call the remote a coarse pointer; inside the Android
      // TV app on a television it never means a touch screen.
      const touch = !onAndroidTelevision() && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
      const isCompact = w < 900 || h / w > 1.05 || touch
      setCompact(isCompact)
      const factor = isCompact ? 1 : h / 1080
      setStage(isCompact ? { scale: 1, width: w } : { scale: factor, width: w / factor })
    }
    fit()
    /*
     * The stage never scrolls: its hero is fixed and its rows scroll inside
     * their own region. The stylesheet makes it unscrollable with
     * `overflow: clip`; an engine too old for that still lets code scroll an
     * `overflow: hidden` box, and anything scrolling it into view would slide
     * the spotlight off the top — so it is put straight back.
     */
    const root = rootRef.current
    const pin = () => {
      if (!root || root.classList.contains('compact')) return
      if (root.scrollTop || root.scrollLeft) { root.scrollTop = 0; root.scrollLeft = 0 }
    }
    root?.addEventListener('scroll', pin, { passive: true })
    // Guarded: jsdom has no ResizeObserver, and the resize listener alone is
    // enough there.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null
    if (observer && rootRef.current) observer.observe(rootRef.current)
    window.addEventListener('resize', fit)
    // Attaching a mouse to a tablet changes which layout is right, and fires no
    // resize on its own.
    const pointer = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null
    pointer?.addEventListener?.('change', fit)
    return () => {
      root?.removeEventListener('scroll', pin)
      observer?.disconnect()
      window.removeEventListener('resize', fit)
      pointer?.removeEventListener?.('change', fit)
    }
  }, [])
  return { rootRef, compact, stage }
}

/** An accent hex split into the rgb parts the stage's CSS variables take. */
export function accentParts(hex: string): [number, number, number] {
  const raw = hex.replace('#', '')
  const full = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw
  const n = Number.parseInt(full, 16)
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [125, 133, 144]
}

/**
 * Backdrop paint. Only explicit CSS gradients are treated as paint; artwork may
 * be an absolute URL, a root-relative endpoint or a relative media path, and
 * JSON quoting keeps spaces and parentheses valid inside CSS url(), which is
 * stricter than an <img src> attribute.
 */
export function fanartStyle(fanart: string): { background: string } | { backgroundImage: string } {
  return /^(?:linear|radial|conic)-gradient\(/i.test(fanart.trim())
    ? { background: fanart }
    : { backgroundImage: `url(${JSON.stringify(fanart)})` }
}
