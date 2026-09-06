import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { createRefreshLoop } from '../../../client/src/lib/refresh-loop'
import { VirtualGrid } from '../../../client/src/components/VirtualGrid'

afterEach(() => { vi.useRealTimers(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }) })

describe('bounded live refresh', () => {
  it('coalesces event bursts behind one slow request, pauses hidden tabs and aborts cleanup', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    let finish: () => void = () => {}
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => { signals.push(signal); return new Promise<void>(resolve => { finish = resolve }) })
    const loop = createRefreshLoop(load, () => 1000)
    loop.start()
    await vi.advanceTimersByTimeAsync(1)
    for (let i = 0; i < 100; i++) loop.request()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(1)
    finish(); await vi.advanceTimersByTimeAsync(101)
    expect(load).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(signals[1].aborted).toBe(true)
    finish(); await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(1)
    expect(load).toHaveBeenCalledTimes(3)
    loop.stop(); expect(signals[2].aborted).toBe(true)
    finish(); await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('mounts a bounded viewport from 10,000 films and remains visible after filtering', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    let top = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, top, 1200, 1000))
    const items = Array.from({ length: 10_000 }, (_, id) => id)
    const card = (id: number) => <div key={id} data-testid="card">Film {id}</div>
    const view = render(<VirtualGrid items={items} render={card} />)
    expect(view.getAllByTestId('card').length).toBeLessThan(60)
    top = -100_000
    await act(async () => { window.dispatchEvent(new Event('scroll')); await new Promise(resolve => setTimeout(resolve, 30)) })
    view.rerender(<VirtualGrid items={[1, 2, 3]} render={card} />)
    expect(view.getAllByTestId('card').length).toBeGreaterThan(0)
    expect(view.getAllByTestId('card').length).toBeLessThanOrEqual(3)
  })
})
