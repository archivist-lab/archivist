import { describe, expect, it } from 'vitest'
import { fireEvent, render, type RenderResult } from '@testing-library/react'
import { CombinedView, type CombinedNode } from '../src/components/CombinedView.js'
import { FocusProvider } from '../src/focus/FocusProvider.js'

/** A show with three seasons, the middle one holding the episodes under test. */
const show = (id: number, label: string): CombinedNode => ({
  id: `series-${id}`, type: 'series', label,
  children: [1, 2, 3].map(number => ({
    id: `series-${id}-season-${number}`, type: 'season', label: `Season ${number}`,
    children: Array.from({ length: number === 2 ? 7 : 2 }, (_, index) => ({
      id: `series-${id}-episode-${number}-${index}`, type: 'episode', label: `Episode ${index + 1}`,
    })),
  })),
})

const roots: CombinedNode[] = [{
  id: 'series', type: 'node', label: 'Series',
  children: [show(1, 'Harbour Lights'), show(2, 'Nightjar')],
}]

/** A tile takes the cursor on the first click and opens on the second. */
function openTile(view: RenderResult, index = 0) {
  const tile = view.container.querySelectorAll('.cv-tile')[index] as HTMLElement
  fireEvent.click(tile)
  fireEvent.click(tile)
}

/** Puts the remote's focus on the view's own anchor, where its keys are read. */
function takeRemote(view: RenderResult) {
  (view.container.querySelector('.cv-anchor') as HTMLElement).focus()
}

describe('combined view season picker', () => {
  it('switches season from the heading above the episodes, not from a strip at the top', () => {
    const view = render(<FocusProvider onBack={() => {}}><CombinedView roots={roots} /></FocusProvider>)
    // Into the series, then into its first season.
    openTile(view)
    openTile(view)

    // Nothing above the hero: the folder strip that used to carry the seasons
    // is gone, and the heading over the tiles is the only place they live.
    expect(view.container.querySelector('.cv-tabs')).toBeNull()
    const heading = view.container.querySelector('.cv-row-heading')!
    const picker = heading.querySelector('.cv-picker')!
    expect(Array.from(picker.querySelectorAll('.cv-picker-item')).map(node => node.textContent))
      .toEqual(['Season 1', 'Season 2', 'Season 3'])
    expect(picker.querySelector('[aria-selected="true"]')?.textContent).toBe('Season 1')

    // The count reads the season under the cursor, and sits below the picker
    // rather than beside a name that moves.
    expect(heading.querySelector('.cv-row-count')?.textContent).toBe('2 episodes')
    expect(heading.lastElementChild).toBe(heading.querySelector('.cv-row-count'))

    // Up puts the cursor on the picker; Right walks to the next season and the
    // episode row and its count follow.
    takeRemote(view)
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(picker.getAttribute('data-focused')).toBe('true')
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(picker.querySelector('[aria-selected="true"]')?.textContent).toBe('Season 2')
    expect(heading.querySelector('.cv-row-count')?.textContent).toBe('7 episodes')
    expect(view.container.querySelectorAll('.cv-tile')).toHaveLength(7)

    // Clicking a season is the same move for a pointer.
    fireEvent.click(picker.querySelectorAll('.cv-picker-item')[2])
    expect(picker.querySelector('[aria-selected="true"]')?.textContent).toBe('Season 3')
  })

  it('writes a show as a plain name, not a picker over the whole library', () => {
    const view = render(<FocusProvider onBack={() => {}}><CombinedView roots={roots} /></FocusProvider>)
    openTile(view)

    // A show's siblings are every other show, which is not a strip to slide
    // through, so the heading names this one and stops there.
    const heading = view.container.querySelector('.cv-row-heading')!
    expect(heading.querySelector('.cv-picker')).toBeNull()
    expect(heading.querySelector('.cv-picker-solo')?.textContent).toBe('Harbour Lights')
    expect(heading.querySelector('.cv-row-count')?.textContent).toBe('3 seasons')
  })
})
