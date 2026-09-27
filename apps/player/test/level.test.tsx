import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { catalogueRating, Level, LevelStatic } from '@archivist/design-system'

const none = { value: null, source: 'none' as const, inheritedFrom: null, scaleMax: 5 as const }

describe('The Level', () => {
  it('rates from a remote with OK, the arrows, then OK, saving once', () => {
    vi.useFakeTimers()
    try {
      const commit = vi.fn()
      render(<Level title="The Archive" rating={none} onCommit={commit} />)
      const slider = screen.getByRole('slider', { name: 'Rating for The Archive' })
      expect(slider.getAttribute('aria-valuemin')).toBe('0')
      expect(slider.getAttribute('aria-valuemax')).toBe('5')
      // Passing over it changes nothing, and every arrow is left to move on.
      for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) expect(fireEvent.keyDown(slider, { key })).toBe(true)
      expect(slider.getAttribute('aria-valuenow')).toBe('0')
      // OK starts rating; half a point a press, shown at once.
      expect(fireEvent.keyDown(slider, { key: 'Enter' })).toBe(false)
      expect(slider.getAttribute('data-adjusting')).toBe('true')
      fireEvent.keyDown(slider, { key: 'ArrowRight' })
      fireEvent.keyDown(slider, { key: 'ArrowRight' })
      expect(slider.getAttribute('aria-valuenow')).toBe('1')
      expect(commit).not.toHaveBeenCalled()
      // OK keeps it, in one save.
      fireEvent.keyDown(slider, { key: 'Enter' })
      expect(slider.getAttribute('data-adjusting')).toBe('false')
      expect(commit).toHaveBeenCalledOnce()
      expect(commit).toHaveBeenLastCalledWith(1)
      act(() => { vi.advanceTimersByTime(700) })
      expect(commit).toHaveBeenCalledOnce()
      fireEvent.keyDown(slider, { key: 'Enter' })
      fireEvent.keyDown(slider, { key: 'Delete' })
      fireEvent.keyDown(slider, { key: 'Enter' })
      expect(commit).toHaveBeenLastCalledWith(null)
    } finally { vi.useRealTimers() }
  })

  it('puts the score back on Back, and never takes Back to leave the screen', () => {
    const commit = vi.fn()
    render(<Level title="Episode" rating={{ ...none, value: 3, source: 'own' }} onCommit={commit} />)
    const slider = screen.getByRole('slider')
    // Not rating: Backspace (Back on some remotes) is left alone entirely.
    expect(fireEvent.keyDown(slider, { key: 'Backspace' })).toBe(true)
    fireEvent.keyDown(slider, { key: 'Enter' })
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(slider.getAttribute('aria-valuenow')).toBe('2.5')
    expect(fireEvent.keyDown(slider, { key: 'Escape' })).toBe(false)
    expect(slider.getAttribute('aria-valuenow')).toBe('3')
    expect(slider.getAttribute('data-adjusting')).toBe('false')
    expect(commit).not.toHaveBeenCalled()
  })

  it('keeps the score and moves on when Up or Down leaves mid-rating', () => {
    const commit = vi.fn()
    render(<Level title="Film" rating={none} onCommit={commit} />)
    const slider = screen.getByRole('slider')
    fireEvent.keyDown(slider, { key: 'Enter' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    // Not consumed, so the same press moves focus on.
    expect(fireEvent.keyDown(slider, { key: 'ArrowDown' })).toBe(true)
    expect(commit).toHaveBeenCalledWith(0.5)
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
    // The fourth segment is partly lit. Its width comes from the value rather
    // than a half-specific class, so a typed score fills it the same way.
    expect(segments.filter(segment => segment.classList.contains('partial'))).toHaveLength(1)
    expect(segments[3].classList.contains('partial')).toBe(true)
    expect((segments[3] as HTMLElement).style.getPropertyValue('--fill')).toBe('0.5')
  })

  it('stands the catalogue score in until a rating of the viewer\'s own exists', () => {
    const { rerender } = render(<Level title="Film" rating={none} onCommit={() => {}} catalogue={catalogueRating(7.4)} showSource />)
    const slider = screen.getByRole('slider')
    // 7.4 out of ten is 3.7 out of five, and is shown as that rather than
    // rounded to a half point — the segments can draw the part.
    expect(slider.getAttribute('data-source')).toBe('catalogue')
    expect(slider.getAttribute('aria-valuenow')).toBe('3.7')
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

  it('takes a typed Archivist Score to two decimal places, and an empty box clears it', async () => {
    const commit = vi.fn()
    const { rerender } = render(
      <Level title="Film" rating={{ value: 3, source: 'own', inheritedFrom: null, scaleMax: 5 }} onCommit={commit} />,
    )
    // The readout is the way in: the slider can only aim at half points.
    fireEvent.click(screen.getByRole('button', { name: '03 / 05' }))
    const editor = screen.getByRole('spinbutton', { name: /Archivist Score for Film/ })
    fireEvent.change(editor, { target: { value: '4.37' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(commit).toHaveBeenCalledWith(4.37))

    const slider = screen.getByRole('slider')
    expect(slider.getAttribute('aria-valuenow')).toBe('4.37')
    const segments = Array.from(slider.querySelectorAll('.archivist-level-segment'))
    expect((segments[4] as HTMLElement).style.getPropertyValue('--fill')).toBe('0.37')
    expect(screen.getByRole('button', { name: '04.37 / 05' })).toBeTruthy()

    // Emptying the box hands the title back to its weighted rating.
    commit.mockClear()
    rerender(<Level title="Film" rating={{ value: 4.37, source: 'own', inheritedFrom: null, scaleMax: 5 }} onCommit={commit} />)
    fireEvent.click(screen.getByRole('button', { name: '04.37 / 05' }))
    const cleared = screen.getByRole('spinbutton', { name: /Archivist Score for Film/ })
    fireEvent.change(cleared, { target: { value: '' } })
    fireEvent.keyDown(cleared, { key: 'Enter' })
    await waitFor(() => expect(commit).toHaveBeenCalledWith(null))
  })

  it('clamps a typed score to the scale', async () => {
    const commit = vi.fn()
    render(<Level title="Film" rating={{ value: 3, source: 'own', inheritedFrom: null, scaleMax: 5 }} onCommit={commit} />)
    fireEvent.click(screen.getByRole('button', { name: '03 / 05' }))
    const editor = screen.getByRole('spinbutton', { name: /Archivist Score for Film/ })
    fireEvent.change(editor, { target: { value: '9.9' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    await waitFor(() => expect(commit).toHaveBeenCalledWith(5))
  })
})
