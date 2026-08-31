import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { catalogueRating, Level, LevelStatic } from '@archivist/design-system'

const none = { value: null, source: 'none' as const, inheritedFrom: null, scaleMax: 5 as const }

describe('The Level', () => {
  it('is an accessible slider and commits keyboard changes without a confirm step', async () => {
    const commit = vi.fn()
    render(<Level title="The Archive" rating={none} onCommit={commit} />)
    const slider = screen.getByRole('slider', { name: 'Rating for The Archive' })
    expect(slider.getAttribute('aria-valuemin')).toBe('0')
    expect(slider.getAttribute('aria-valuemax')).toBe('5')
    // Half a point a press, so every value a pointer can set is reachable from
    // a keyboard and a remote too.
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    await waitFor(() => expect(commit).toHaveBeenCalledWith(0.5))
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    await waitFor(() => expect(commit).toHaveBeenLastCalledWith(1))
    fireEvent.keyDown(slider, { key: 'Backspace' })
    await waitFor(() => expect(commit).toHaveBeenLastCalledWith(null))
  })

  it('sets a half point from the pointer and half-fills the segment it lands in', async () => {
    const commit = vi.fn()
    render(<Level title="Film" rating={none} onCommit={commit} />)
    const slider = screen.getByRole('slider')
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 212, bottom: 30, width: 212, height: 30, toJSON: () => ({}) })
    Object.assign(slider, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() })
    // 6px of padding each side leaves 200 of track; 130 across it is 3.25 of
    // five, which rounds up to the half point the cursor is inside of.
    const pointer = (type: string) => { const event = new Event(type, { bubbles: true }); Object.assign(event, { pointerId: 1, clientX: 136, pointerType: 'mouse' }); fireEvent(slider, event) }
    pointer('pointerdown')
    pointer('pointerup')
    await waitFor(() => expect(commit).toHaveBeenCalledWith(3.5))
    expect(slider.getAttribute('aria-valuenow')).toBe('3.5')
    const segments = Array.from(slider.querySelectorAll('.archivist-level-segment'))
    expect(segments.filter(segment => segment.classList.contains('on'))).toHaveLength(4)
    expect(segments.filter(segment => segment.classList.contains('half'))).toHaveLength(1)
    expect(segments[3].classList.contains('half')).toBe(true)
  })

  it('stands the catalogue score in until a rating of the viewer\'s own exists', () => {
    const { rerender } = render(<Level title="Film" rating={none} onCommit={() => {}} catalogue={catalogueRating(7.4)} showSource />)
    const slider = screen.getByRole('slider')
    // 7.4 out of ten is 3.7 out of five, which is 3.5 at half-point precision.
    expect(slider.getAttribute('data-source')).toBe('catalogue')
    expect(slider.getAttribute('aria-valuenow')).toBe('3.5')
    expect(screen.getByText('catalogue')).toBeTruthy()

    // A rating of their own replaces it outright rather than sitting beside it.
    rerender(<Level title="Film" rating={{ value: 2, source: 'own', inheritedFrom: null, scaleMax: 5 }} onCommit={() => {}} catalogue={catalogueRating(7.4)} showSource />)
    expect(slider.getAttribute('data-source')).toBe('own')
    expect(slider.getAttribute('aria-valuenow')).toBe('2')
  })

  it('reads a rating without offering to take one, and stays out of the focus order', () => {
    render(<LevelStatic value={4.5} source="catalogue" />)
    const readout = screen.getByRole('img', { name: '4.5 out of 5, from the catalogue' })
    expect(readout.getAttribute('data-source')).toBe('catalogue')
    expect(readout.getAttribute('tabindex')).toBeNull()
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.getByText('04.5 / 05')).toBeTruthy()
  })

  it('drops a vote count that arrived where a score belongs', () => {
    expect(catalogueRating(22813)).toBeNull()
    expect(catalogueRating(0)).toBeNull()
    expect(catalogueRating(null)).toBeNull()
    expect(catalogueRating(9)).toBe(4.5)
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
