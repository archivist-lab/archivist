import { describe, expect, it, vi } from 'vitest'
import { createFocusController, scoreCandidate } from '../src/focus/navigation.js'

const rect = (left: number, top: number, width = 100, height = 60) => new DOMRect(left, top, width, height)

describe('spatial navigation', () => {
  it('scores only candidates in the requested half-plane and rewards overlap', () => {
    expect(scoreCandidate(rect(100, 100), rect(250, 100), 'right', false)).toBeTypeOf('number')
    expect(scoreCandidate(rect(100, 100), rect(0, 100), 'right', false)).toBeNull()
    expect(scoreCandidate(rect(100, 100), rect(250, 100), 'right', true)).toBeLessThan(scoreCandidate(rect(100, 100), rect(250, 100), 'right', false)!)
  })

  it('moves deterministically, excludes disabled targets, and restores semantic focus', async () => {
    const controller = createFocusController()
    const first = document.body.appendChild(document.createElement('button'))
    const disabled = document.body.appendChild(document.createElement('button'))
    const target = document.body.appendChild(document.createElement('button'))
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect(0, 0))
    vi.spyOn(disabled, 'getBoundingClientRect').mockReturnValue(rect(120, 0))
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect(240, 0))
    const cleanups = [
      controller.register({ id: 'first', zoneId: 'row', element: first, disabled: false }),
      controller.register({ id: 'disabled', zoneId: 'row', element: disabled, disabled: true }),
      controller.register({ id: 'target', zoneId: 'row', element: target, disabled: false }),
    ]
    expect(controller.focus('first')).toBe(true)
    expect(controller.move('right')).toBe(true)
    expect(document.activeElement).toBe(target)
    controller.remember('/films', 'target')
    first.focus()
    controller.restore('/films', 'first')
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(document.activeElement).toBe(target)
    cleanups.forEach(cleanupRegistration => cleanupRegistration())
    first.remove(); disabled.remove(); target.remove()
  })
})
