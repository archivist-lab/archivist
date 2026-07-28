import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Level } from '@archivist/design-system'

const none = { value: null, source: 'none' as const, inheritedFrom: null, scaleMax: 5 as const }

describe('The Level', () => {
  it('is an accessible slider and commits keyboard changes without a confirm step', async () => {
    const commit = vi.fn()
    render(<Level title="The Archive" rating={none} onCommit={commit} />)
    const slider = screen.getByRole('slider', { name: 'Rating for The Archive' })
    expect(slider.getAttribute('aria-valuemin')).toBe('0')
    expect(slider.getAttribute('aria-valuemax')).toBe('5')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    await waitFor(() => expect(commit).toHaveBeenCalledWith(1))
    fireEvent.keyDown(slider, { key: 'Backspace' })
    await waitFor(() => expect(commit).toHaveBeenLastCalledWith(null))
  })

  it('commits once on pointer release and tapping the current value clears it', async () => {
    const commit = vi.fn()
    render(<Level title="Film" rating={{ value: 4, source: 'own', inheritedFrom: null, scaleMax: 5 }} onCommit={commit} />)
    const slider = screen.getByRole('slider')
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30, toJSON: () => ({}) })
    Object.assign(slider, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() })
    const pointer = (type: string) => { const event = new Event(type, { bubbles: true }); Object.assign(event, { pointerId: 1, clientX: 150, pointerType: 'mouse' }); fireEvent(slider, event) }
    pointer('pointerdown')
    pointer('pointerup')
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
    expect(commit).toHaveBeenCalledWith(null)
  })

  it('identifies inherited state independently of its accent colour', () => {
    render(<Level title="Episode" rating={{ value: 3, source: 'inherited', inheritedFrom: { type: 'series', id: 1 }, scaleMax: 5 }} onCommit={() => {}} showSource />)
    expect(screen.getByRole('slider').getAttribute('data-source')).toBe('inherited')
    expect(screen.getByText('from series')).toBeTruthy()
  })
})
