import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, type RenderResult } from '@testing-library/react'
import { CombinedView, type CombinedNode } from '../src/components/CombinedView.js'
import { FocusProvider } from '../src/focus/FocusProvider.js'

const film = (id: number): CombinedNode => ({ id: `film-${id}`, type: 'film', label: `Film ${id}` })

/** Home as it arrives: shelves of films, stacked. */
const shelves = (count: number, filmsPerShelf: number): CombinedNode[] => [{
  id: 'home', type: 'node', label: 'Home',
  children: Array.from({ length: count }, (_, shelf) => ({
    id: `shelf-${shelf}`, type: 'node' as const, label: `Shelf ${shelf}`,
    children: Array.from({ length: filmsPerShelf }, (_, index) => film(shelf * 1000 + index)),
  })),
}]

function takeRemote(view: RenderResult) {
  (view.container.querySelector('.cv-anchor') as HTMLElement).focus()
}

const cursor = (view: RenderResult) => view.container.querySelector('.cv-tile[aria-current="true"]')?.parentElement
  ?.closest('.cv-shelf')?.getAttribute('aria-label') + ' / ' + view.container.querySelector('.cv-title')?.textContent

describe('combined view performance', () => {
  it('draws only the tiles near what a shelf shows, however long the shelf', () => {
    // A television-sized box: the setup's default reads as a phone, which
    // flows and scrolls natively and so draws every tile.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1920, 1080))
    const view = render(<FocusProvider onBack={() => {}}><CombinedView roots={shelves(2, 200)} /></FocusProvider>)
    const tiles = view.container.querySelectorAll('.cv-tile').length
    expect(tiles).toBeGreaterThan(0)
    expect(tiles).toBeLessThan(40)
    // Walking a long way along the shelf keeps the cursor drawn, and the count bounded.
    takeRemote(view)
    for (let press = 0; press < 60; press++) fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(view.container.querySelector('.cv-title')?.textContent).toBe('FILM 60')
    expect(view.container.querySelectorAll('.cv-tile').length).toBeLessThan(40)
  })

  it('keeps the cursor where it is when more of the tree arrives', () => {
    const first = shelves(3, 20)
    const view = render(<FocusProvider onBack={() => {}}><CombinedView roots={first} /></FocusProvider>)
    takeRemote(view)
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(cursor(view)).toBe('Shelf 1 / FILM 1002')

    // A new tree — a shelf added ahead of this one, as a late response would.
    const arrived = shelves(3, 20)
    arrived[0].children!.unshift({ id: 'shelf-new', type: 'node', label: 'Box Sets', children: [film(9001)] })
    view.rerender(<FocusProvider onBack={() => {}}><CombinedView roots={arrived} /></FocusProvider>)
    expect(cursor(view)).toBe('Shelf 1 / FILM 1002')
  })

  it('falls back to a neighbouring tile when the one under the cursor is gone', () => {
    const view = render(<FocusProvider onBack={() => {}}><CombinedView roots={shelves(2, 10)} /></FocusProvider>)
    takeRemote(view)
    for (let press = 0; press < 4; press++) fireEvent.keyDown(window, { key: 'ArrowRight' })
    const shrunk = shelves(2, 10)
    shrunk[0].children![0].children = shrunk[0].children![0].children!.filter(node => node.id !== 'film-4')
    view.rerender(<FocusProvider onBack={() => {}}><CombinedView roots={shrunk} /></FocusProvider>)
    expect(cursor(view)).toBe('Shelf 0 / FILM 5')
  })
})
