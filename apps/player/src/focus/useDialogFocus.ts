import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'

type ScrollPosition = { element: HTMLElement; top: number; left: number }

function scrollAncestors(origin: HTMLElement | null): ScrollPosition[] {
  const positions: ScrollPosition[] = []
  let element = origin?.parentElement ?? null
  while (element) {
    if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) positions.push({ element, top: element.scrollTop, left: element.scrollLeft })
    element = element.parentElement
  }
  return positions
}

/** Focus trap, topmost Back handling, and exact origin/scroll restoration for living-room dialogs. */
export function useDialogFocus<T extends HTMLElement>(open: boolean, onClose: () => void): RefObject<T> {
  const dialogRef = useRef<T>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const origin = document.activeElement as HTMLElement | null
    const originId = origin?.dataset.focusId
    const positions = scrollAncestors(origin)
    const topmost = () => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'))
      return dialogs.at(-1) === dialogRef.current
    }
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
    const frame = requestAnimationFrame(() => (dialogRef.current?.querySelector<HTMLElement>('[data-dialog-initial]') ?? focusable()[0])?.focus({ preventScroll: true }))
    const keydown = (event: KeyboardEvent) => {
      if (!topmost()) return
      if (event.key === 'Escape' || event.key === 'BrowserBack' || event.key === 'Backspace' && !(event.target as HTMLElement | null)?.matches('input,textarea')) {
        event.preventDefault(); event.stopPropagation(); closeRef.current(); return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) { event.preventDefault(); return }
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus({ preventScroll: true }) }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus({ preventScroll: true }) }
    }
    window.addEventListener('keydown', keydown, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown, true)
      requestAnimationFrame(() => {
        const escapedId = originId ? globalThis.CSS?.escape ? globalThis.CSS.escape(originId) : originId.replace(/["\\]/g, '\\$&') : null
        const target = origin?.isConnected ? origin : escapedId ? document.querySelector<HTMLElement>(`[data-focus-id="${escapedId}"]`) : null
        target?.focus({ preventScroll: true })
        for (const position of positions) {
          if (typeof position.element.scrollTo === 'function') position.element.scrollTo({ top: position.top, left: position.left, behavior: 'auto' })
          else { position.element.scrollTop = position.top; position.element.scrollLeft = position.left }
        }
      })
    }
  }, [open])

  return dialogRef
}
