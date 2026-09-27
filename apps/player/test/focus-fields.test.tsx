import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { FocusProvider } from '../src/focus/FocusProvider.js'

/**
 * A search box above a result and a select, laid out as a column: the setup
 * gives every element the same box, which no direction can travel between.
 */
function layOut() {
  const rows: Record<string, number> = { Search: 0, Result: 100, Sort: 200 }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const label = this.getAttribute('aria-label') ?? this.textContent ?? ''
    const top = rows[label] ?? 0
    return new DOMRect(0, top, 300, 44)
  })
}

async function renderPage() {
  layOut()
  const view = render(<FocusProvider onBack={vi.fn()}>
    <input aria-label="Search" defaultValue="alien" />
    <button className="player-focusable">Result</button>
    <select aria-label="Sort" defaultValue="a"><option value="a">A</option><option value="b">B</option></select>
  </FocusProvider>)
  // Registration of the fields happens on mount; give the observer a turn.
  await Promise.resolve()
  return view
}

describe('fields and the remote', () => {
  it('reaches a field and leaves it with Up and Down', async () => {
    await renderPage()
    const search = screen.getByRole('textbox', { name: 'Search' }) as HTMLInputElement
    const result = screen.getByRole('button', { name: 'Result' })
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(result)
    // The engine drops a second move within 70ms, which is key repeat.
    await new Promise(resolve => setTimeout(resolve, 80))
    fireEvent.keyDown(result, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(search)
  })

  it('keeps Left and Right for the caret until it reaches an end', async () => {
    await renderPage()
    const search = screen.getByRole('textbox', { name: 'Search' }) as HTMLInputElement
    search.focus()
    search.setSelectionRange(2, 2)
    // Mid-text: the caret moves, nothing else does, and the key is not consumed.
    expect(fireEvent.keyDown(search, { key: 'ArrowLeft' })).toBe(true)
    expect(document.activeElement).toBe(search)
  })

  it('never lets an arrow change a select, and Backspace in a field is not Back', async () => {
    const back = vi.fn()
    layOut()
    render(<FocusProvider onBack={back}>
      <input aria-label="Search" defaultValue="alien" />
      <button className="player-focusable">Result</button>
      <select aria-label="Sort" defaultValue="a"><option value="a">A</option><option value="b">B</option></select>
    </FocusProvider>)
    await Promise.resolve()
    const sort = screen.getByRole('combobox', { name: 'Sort' }) as HTMLSelectElement
    sort.focus()
    expect(fireEvent.keyDown(sort, { key: 'ArrowDown' })).toBe(false)
    expect(sort.value).toBe('a')
    fireEvent.keyDown(sort, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Result' }))
    const search = screen.getByRole('textbox', { name: 'Search' })
    search.focus()
    fireEvent.keyDown(search, { key: 'Backspace' })
    expect(back).not.toHaveBeenCalled()
  })
})
