export type Direction = 'left' | 'right' | 'up' | 'down'
export type InputModality = 'remote' | 'pointer' | 'touch'

export interface FocusRegistration {
  id: string
  zoneId: string
  element: HTMLElement
  disabled: boolean
  neighbors?: Partial<Record<Direction, string>>
}

export interface FocusController {
  register(input: FocusRegistration): () => void
  move(direction: Direction): boolean
  focus(id: string): boolean
  current(): FocusRegistration | null
  restore(routeKey: string, fallbackId: string): void
  remember(routeKey: string, id: string): void
  pushScope(scopeId: string): void
  popScope(scopeId: string): void
  setModality(modality: InputModality): void
  getModality(): InputModality
}

function center(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

export function scoreCandidate(current: DOMRect, candidate: DOMRect, direction: Direction, explicitNeighbor: boolean): number | null {
  const a = center(current)
  const b = center(candidate)
  const horizontal = direction === 'left' || direction === 'right'
  const primary = horizontal ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)
  const perpendicular = horizontal ? Math.abs(b.y - a.y) : Math.abs(b.x - a.x)
  if (direction === 'left' && b.x >= a.x) return null
  if (direction === 'right' && b.x <= a.x) return null
  if (direction === 'up' && b.y >= a.y) return null
  if (direction === 'down' && b.y <= a.y) return null
  const overlaps = horizontal
    ? candidate.bottom >= current.top && candidate.top <= current.bottom
    : candidate.right >= current.left && candidate.left <= current.right
  return primary + 0.35 * perpendicular + 0.002 * perpendicular * perpendicular - (overlaps ? 120 : 0) - (explicitNeighbor ? 60 : 0)
}

class SpatialFocusController implements FocusController {
  private registrations = new Map<string, FocusRegistration>()
  private order = new Map<string, number>()
  private sequence = 0
  private activeId: string | null = null
  private memory = new Map<string, string>()
  private scopes: string[] = []
  private modality: InputModality = 'remote'
  private lockedUntil = 0

  register(input: FocusRegistration): () => void {
    this.registrations.set(input.id, input)
    if (!this.order.has(input.id)) this.order.set(input.id, this.sequence++)
    return () => {
      const current = this.registrations.get(input.id)
      if (current?.element === input.element) this.registrations.delete(input.id)
      if (this.activeId === input.id) this.activeId = null
    }
  }

  current(): FocusRegistration | null {
    const element = document.activeElement as HTMLElement | null
    const id = element?.dataset.focusId
    if (id && this.registrations.has(id)) return this.registrations.get(id) ?? null
    if (this.activeId) return this.registrations.get(this.activeId) ?? null
    return null
  }

  focus(id: string): boolean {
    const target = this.registrations.get(id)
    if (!target || !this.available(target)) return false
    target.element.focus({ preventScroll: true })
    target.element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    this.activeId = id
    return true
  }

  move(direction: Direction): boolean {
    const now = performance.now()
    if (now < this.lockedUntil) return false
    const current = this.current()
    if (!current || !this.available(current)) return false
    const rect = current.element.getBoundingClientRect()
    const explicitId = current.neighbors?.[direction]
    if (explicitId && this.focus(explicitId)) { this.lockedUntil = now + 70; return true }
    let best: { target: FocusRegistration; score: number; order: number } | null = null
    for (const target of this.registrations.values()) {
      if (target.id === current.id || !this.available(target)) continue
      const score = scoreCandidate(rect, target.element.getBoundingClientRect(), direction, target.id === explicitId)
      if (score == null) continue
      const order = this.order.get(target.id) ?? Number.MAX_SAFE_INTEGER
      if (!best || score < best.score || (score === best.score && order < best.order)) best = { target, score, order }
    }
    if (!best) return false
    this.lockedUntil = now + 70
    return this.focus(best.target.id)
  }

  restore(routeKey: string, fallbackId: string): void {
    const remembered = this.memory.get(routeKey)
    requestAnimationFrame(() => { if (!remembered || !this.focus(remembered)) this.focus(fallbackId) })
  }
  remember(routeKey: string, id: string): void { this.memory.set(routeKey, id) }
  pushScope(scopeId: string): void { this.scopes.push(scopeId) }
  popScope(scopeId: string): void {
    const index = this.scopes.lastIndexOf(scopeId)
    if (index >= 0) this.scopes.splice(index, 1)
  }
  setModality(modality: InputModality): void { this.modality = modality; document.documentElement.dataset.inputModality = modality }
  getModality(): InputModality { return this.modality }

  private available(target: FocusRegistration): boolean {
    if (target.disabled || target.element.hidden || target.element.closest('[aria-hidden="true"]')) return false
    const activeModal = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')
    if (activeModal && !activeModal.contains(target.element)) return false
    const style = getComputedStyle(target.element)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const rect = target.element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const scope = this.scopes.at(-1)
    return !scope || target.zoneId === scope || target.element.closest(`[data-focus-scope="${CSS.escape(scope)}"]`) != null
  }
}

export function createFocusController(): FocusController { return new SpatialFocusController() }
