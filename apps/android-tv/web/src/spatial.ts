/**
 * D-pad focus movement for the server picker.
 *
 * The Player has its own focus system; this page is small enough that plain
 * geometry does: from the focused element, the nearest focusable in the
 * pressed direction wins, with sideways offset weighed double so a press
 * stays in its row or column rather than jumping diagonally.
 */

export type Direction = 'up' | 'down' | 'left' | 'right'

export interface Box { left: number; top: number; right: number; bottom: number }

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), [data-focusable]'

export function pickNext<T>(from: Box, candidates: Array<{ item: T; box: Box }>, direction: Direction): T | null {
  const cx = (from.left + from.right) / 2
  const cy = (from.top + from.bottom) / 2
  let best: T | null = null
  let bestScore = Infinity
  for (const { item, box } of candidates) {
    const bx = (box.left + box.right) / 2
    const by = (box.top + box.bottom) / 2
    let gap: number
    let offset: number
    switch (direction) {
      case 'right': if (bx <= cx + 1) continue; gap = Math.max(0, box.left - from.right); offset = Math.abs(by - cy); break
      case 'left': if (bx >= cx - 1) continue; gap = Math.max(0, from.left - box.right); offset = Math.abs(by - cy); break
      case 'down': if (by <= cy + 1) continue; gap = Math.max(0, box.top - from.bottom); offset = Math.abs(bx - cx); break
      case 'up': if (by >= cy - 1) continue; gap = Math.max(0, from.top - box.bottom); offset = Math.abs(bx - cx); break
    }
    const score = gap + offset * 2
    if (score < bestScore) { bestScore = score; best = item }
  }
  return best
}

const KEYS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

function focusables(scope: ParentNode): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
}

export function focusFirst(scope: ParentNode): void {
  const preferred = scope.querySelector<HTMLElement>('[data-autofocus]')
  ;(preferred ?? focusables(scope)[0])?.focus()
}

/** Installs arrow-key movement on the document. Returns an uninstaller. */
export function installSpatialNavigation(): () => void {
  const keydown = (event: KeyboardEvent) => {
    const direction = KEYS[event.key]
    if (!direction) return
    const active = document.activeElement as HTMLElement | null
    // In a text field left and right move the caret; up and down leave it.
    if (active?.matches('input') && (direction === 'left' || direction === 'right')) return
    const all = focusables(document)
    if (!active || !all.includes(active)) {
      event.preventDefault()
      focusFirst(document)
      return
    }
    const next = pickNext(active.getBoundingClientRect(), all.filter(el => el !== active).map(item => ({ item, box: item.getBoundingClientRect() })), direction)
    event.preventDefault()
    if (next) {
      next.focus()
      next.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }
  }
  document.addEventListener('keydown', keydown)
  return () => document.removeEventListener('keydown', keydown)
}
