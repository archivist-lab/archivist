import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createFocusController, type Direction, type FocusController, type InputModality } from './navigation.js'

const FocusContext = createContext<FocusController | null>(null)

export function FocusProvider({ children, onBack }: { children: ReactNode; onBack: () => void }) {
  const controller = useMemo(() => createFocusController(), [])
  const gamepadFrame = useRef(0)
  const gamepadHeld = useRef(false)

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input,textarea,[contenteditable=true]') && !['Escape', 'BrowserBack'].includes(event.key)) return
      const directions: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
      if (directions[event.key]) {
        controller.setModality('remote')
        if (controller.move(directions[event.key])) event.preventDefault()
      } else if (event.key === 'Enter' || event.key === ' ') {
        const current = controller.current()
        if (current) { event.preventDefault(); current.element.click() }
      } else if (event.key === 'Escape' || event.key === 'BrowserBack' || event.key === 'Backspace' && !target?.matches('input,textarea')) {
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
    const sync = () => {
      for (const [element, unregister] of registrations) if (!element.isConnected) { unregister(); registrations.delete(element) }
      const allocated = new Set(Array.from(document.querySelectorAll<HTMLElement>('[data-focus-id]'))
        .map(element => element.dataset.focusId)
        .filter((id): id is string => !!id))
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('.player-focusable:not([data-focus-id])'))) {
        if (registrations.has(element)) continue
        const base = semantic(element)
        let count = 1
        let id = base
        while (allocated.has(id)) id = `${base}-${++count}`
        allocated.add(id)
        element.dataset.focusId = id
        element.dataset.autoFocusId = 'true'
        registrations.set(element, controller.register({ id, zoneId: element.closest('[role="dialog"]') ? 'dialog' : 'route', element, disabled: element.matches(':disabled') }))
      }
    }
    sync()
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
