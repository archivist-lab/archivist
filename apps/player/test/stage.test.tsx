import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useStage } from '../src/components/stage.js'

function Probe({ onStage }: { onStage: (compact: boolean) => void }) {
  const { rootRef, compact } = useStage()
  onStage(compact)
  return <div ref={rootRef} />
}

/** A TV viewport whose WebView calls the remote a coarse pointer. */
function coarseTelevision() {
  // The shared setup measures every element at 100x44; this stage fills a 1080p screen.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1920, 1080))
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)', addEventListener: () => {}, removeEventListener: () => {} }))
}

describe('stage', () => {
  it('keeps the television stage for a remote at 1080p', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1920, 1080))
    let compact = true
    render(<Probe onStage={value => { compact = value }} />)
    expect(compact).toBe(false)
  })

  it('treats a coarse pointer as touch in a browser', () => {
    coarseTelevision()
    let compact = false
    render(<Probe onStage={value => { compact = value }} />)
    expect(compact).toBe(true)
  })

  it('keeps the television stage inside the Android TV app on a TV', () => {
    coarseTelevision()
    vi.stubGlobal('ArchivistAndroid', { switchServer: vi.fn(), exitApp: vi.fn(), serverInfo: () => 'null', isTelevision: () => true })
    let compact = true
    render(<Probe onStage={value => { compact = value }} />)
    expect(compact).toBe(false)
  })
})
