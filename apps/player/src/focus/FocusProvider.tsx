import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createFocusController, type Direction, type FocusController, type InputModality } from './navigation.js'

const FocusContext = createContext<FocusController | null>(null)

type FieldKind = 'text' | 'range' | 'select' | 'multiline'

/** What sort of form control an element is, for deciding which keys it keeps. Null for anything else. */
function fieldKind(element: HTMLElement | null): FieldKind | null {
  if (!element) return null
  if (element.matches('textarea,[contenteditable="true"]')) return 'multiline'
  if (element.matches('select')) return 'select'
  if (!element.matches('input')) return null
  const type = (element as HTMLInputElement).type
  if (type === 'range') return 'range'
  // These are buttons in all but name: the arrows move off them as off any button.
  if (['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(type)) return null
  return 'text'
}

/**
 * Whether an arrow leaves the field rather than acting inside it.
 *
 * A remote has no Tab, so a field that keeps every arrow is a dead end: this
 * provider used to ignore all four inside any input, and the search box —
 * which opens focused — left no way down to its own results. A single-line
 * field has no use for Up and Down, and Left and Right leave only from the end
 * the caret is already at, so editing text still works. A range keeps Left and
 * Right to change its value. A select never changes its value from an arrow:
 * OK opens it.
 */
function leavesField(element: HTMLElement, kind: FieldKind, direction: Direction): boolean {
  if (kind === 'select') return true
  if (kind === 'multiline') return false
  if (direction === 'up' || direction === 'down') return true
  if (kind === 'range') return false
  const input = element as HTMLInputElement
  let start: number | null = null
  let end: number | null = null
  // Number and email inputs throw rather than report a caret.
  try { start = input.selectionStart; end = input.selectionEnd } catch { /* no caret */ }
  if (start == null || end == null) return true
  const length = input.value.length
  return direction === 'left' ? start === 0 && end === 0 : start === length && end === length
}

export function FocusProvider({ children, onBack }: { children: ReactNode; onBack: () => void }) {
  const controller = useMemo(() => createFocusController(), [])
  const gamepadFrame = useRef(0)
  const gamepadHeld = useRef(false)

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const field = fieldKind(target)
      const directions: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
      const direction = directions[event.key]
      if (direction) {
        if (field && target && !leavesField(target, field, direction)) return
        controller.setModality('remote')
        if (controller.move(direction) || field === 'select') event.preventDefault()
      } else if (event.key === 'Enter' || event.key === ' ') {
        // A field keeps these: Enter opens a select or the on-screen keyboard,
        // Space types a space.
        if (field) return
        const current = controller.current()
        if (current) { event.preventDefault(); current.element.click() }
      } else if (event.key === 'Escape' || event.key === 'BrowserBack' || event.key === 'Backspace' && (!field || field === 'select' || field === 'range')) {
        event.preventDefault(); onBack()
      }
    }
    let mouseX = 0
    let mouseY = 0
    const pointer = (event: MouseEvent) => {
      if (Math.hypot(event.clientX - mouseX, event.clientY - mouseY) > 4) controller.setModality('pointer')
      mouseX = event.clientX; mouseY = event.clientY
    }
    const touch = () => controller.setModality('touch')
    document.addEventListener('keydown', keydown)
    document.addEventListener('mousemove', pointer)
    document.addEventListener('touchstart', touch, { passive: true })
    return () => {
      document.removeEventListener('keydown', keydown)
      document.removeEventListener('mousemove', pointer)
      document.removeEventListener('touchstart', touch)
    }
  }, [controller, onBack])

  useEffect(() => {
    const registrations = new Map<HTMLElement, () => void>()
    const semantic = (element: HTMLElement) => {
      const label = element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || element.tagName
      const slug = label.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || element.tagName.toLowerCase()
      return `auto-${slug}`
    }
    // Slugs are [a-z0-9-] only, so the id needs no escaping inside the selector.
    const taken = (id: string) => controller.has(id) || document.querySelector(`[data-focus-id="${id}"]`) != null
    const register = (element: HTMLElement) => {
      if (registrations.has(element)) return
      // An element with an id of its own registers itself (useFocusable). One
      // carrying an id this provider gave it was pruned while detached and has
      // been put back, and keeps that id.
      const reattached = element.dataset.autoFocusId === 'true' ? element.dataset.focusId : undefined
      if (element.dataset.focusId && !reattached) return
      let id = reattached ?? ''
      if (!reattached) {
        const base = semantic(element)
        let count = 1
        id = base
        while (taken(id)) id = `${base}-${++count}`
      }
      element.dataset.focusId = id
      element.dataset.autoFocusId = 'true'
      registrations.set(element, controller.register({ id, zoneId: element.closest('[role="dialog"]') ? 'dialog' : 'route', element, disabled: false }))
    }
    // Form controls register too, whatever their class: twenty-odd fields and
    // selects in Settings and the browse filters carried no focusable class,
    // and a remote could not reach a single one of them.
    const UNREGISTERED = [
      '.player-focusable:not([data-focus-id])', '.player-focusable[data-auto-focus-id]',
      'input:not([type="hidden"]):not([data-focus-id])', 'select:not([data-focus-id])', 'textarea:not([data-focus-id])',
      'input[data-auto-focus-id]', 'select[data-auto-focus-id]', 'textarea[data-auto-focus-id]',
    ].join(', ')
    const scan = (root: Element) => {
      if (root.matches(UNREGISTERED)) register(root as HTMLElement)
      for (const element of Array.from(root.querySelectorAll<HTMLElement>(UNREGISTERED))) register(element)
    }
    const prune = () => {
      for (const [element, unregister] of registrations) if (!element.isConnected) { unregister(); registrations.delete(element) }
    }
    /*
     * Only what changed is looked at. This used to query the whole document on
     * every mutation anywhere — a tile scrolled into a row, a clock ticking —
     * which on a television was a steady tax on every frame that changed.
     */
    const sync = (records: MutationRecord[]) => {
      let removed = false
      for (const record of records) {
        if (record.removedNodes.length) removed = true
        for (const node of Array.from(record.addedNodes)) if (node.nodeType === Node.ELEMENT_NODE) scan(node as Element)
      }
      if (removed) prune()
    }
    scan(document.body)
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const [element, unregister] of registrations) {
        unregister()
        if (element.dataset.autoFocusId === 'true') { delete element.dataset.focusId; delete element.dataset.autoFocusId }
      }
    }
  }, [controller])

  useEffect(() => {
    if (!('getGamepads' in navigator)) return
    let connected = false
    const poll = () => {
      if (!connected) return
      const pad = navigator.getGamepads()[0]
      if (pad) {
        const x = pad.axes[0] ?? 0
        const y = pad.axes[1] ?? 0
        const pressed = Math.abs(x) > 0.55 || Math.abs(y) > 0.55 || !!pad.buttons[0]?.pressed || !!pad.buttons[1]?.pressed || !!pad.buttons[9]?.pressed
        if (pressed && !gamepadHeld.current) {
          controller.setModality('remote')
          const key = pad.buttons[0]?.pressed ? 'Enter'
            : pad.buttons[1]?.pressed ? 'Escape'
            : pad.buttons[9]?.pressed ? 'MediaPlayPause'
            : Math.abs(x) > Math.abs(y) ? (x < 0 ? 'ArrowLeft' : 'ArrowRight')
            : (y < 0 ? 'ArrowUp' : 'ArrowDown')
          document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
          document.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
        }
        gamepadHeld.current = pressed && (Math.abs(x) > 0.35 || Math.abs(y) > 0.35 || !!pad.buttons[0]?.pressed || !!pad.buttons[1]?.pressed || !!pad.buttons[9]?.pressed)
      }
      gamepadFrame.current = requestAnimationFrame(poll)
    }
    const start = () => {
      if (connected) return
      connected = true
      gamepadFrame.current = requestAnimationFrame(poll)
    }
    const stop = () => {
      connected = false
      gamepadHeld.current = false
      cancelAnimationFrame(gamepadFrame.current)
    }
    const onConnected = () => start()
    const onDisconnected = () => {
      if (!navigator.getGamepads()[0]) stop()
    }
    window.addEventListener('gamepadconnected', onConnected)
    window.addEventListener('gamepaddisconnected', onDisconnected)
    if (navigator.getGamepads()[0]) start()
    return () => {
      stop()
      window.removeEventListener('gamepadconnected', onConnected)
      window.removeEventListener('gamepaddisconnected', onDisconnected)
    }
  }, [controller, onBack])

  return <FocusContext.Provider value={controller}>{children}</FocusContext.Provider>
}

export function useFocusController(): FocusController {
  const value = useContext(FocusContext)
  if (!value) throw new Error('useFocusController must be used inside FocusProvider')
  return value
}

export function useInputModality(): InputModality {
  const controller = useFocusController()
  const [modality, setModality] = useState(controller.getModality())
  useEffect(() => {
    const observer = new MutationObserver(() => setModality(controller.getModality()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-input-modality'] })
    return () => observer.disconnect()
  }, [controller])
  return modality
}

export interface UseFocusableOptions {
  id: string
  zoneId: string
  disabled?: boolean
  neighbors?: Partial<Record<Direction, string>>
  onActivate?: () => void
  onFocused?: () => void
}

export function useFocusable(options: UseFocusableOptions) {
  const controller = useFocusController()
  const element = useRef<HTMLElement | null>(null)
  const unregister = useRef<(() => void) | null>(null)
  const register = useCallback((target: HTMLElement) => controller.register({ id: options.id, zoneId: options.zoneId, element: target, disabled: !!options.disabled, neighbors: options.neighbors }), [controller, options.id, options.zoneId, options.disabled, options.neighbors])
  const ref = useCallback((element: HTMLElement | null) => {
    unregister.current?.()
    unregister.current = null
    if (element) {
      unregister.current = register(element)
    }
  }, [register])
  const refWithMemory = useCallback((target: HTMLElement | null) => {
    element.current = target
    ref(target)
  }, [ref])
  useEffect(() => {
    if (element.current && !unregister.current) unregister.current = register(element.current)
    return () => { unregister.current?.(); unregister.current = null }
  }, [register])
  return {
    ref: refWithMemory,
    tabIndex: options.disabled ? -1 : 0,
    'data-focus-id': options.id,
    onFocus: () => { options.onFocused?.() },
    onClick: () => { if (!options.disabled) options.onActivate?.() },
  }
}
