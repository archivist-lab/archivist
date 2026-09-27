import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { getSeekStep, SCRUB_COMMIT_MS, VideoOsd } from '../src/components/osd/VideoOsd.js'
import { shouldShowUpNext, UpNext } from '../src/components/osd/UpNext.js'
import { preferredTrackSelection, startingTrackSelection } from '../src/components/Player.js'
import type { MediaTracks } from '../src/lib/sdk.js'

const props = () => ({
  title: 'Synthetic Episode', playing: true, current: 100, duration: 1200, tracks: null,
  mode: 'direct' as const, audioIndex: null, subIndex: null, visible: true,
  onInteraction: vi.fn(), onHide: vi.fn(), onToggle: vi.fn(), onSeek: vi.fn(), onStop: vi.fn(),
  onMode: vi.fn(), onAudio: vi.fn(), onSub: vi.fn(), onFullscreen: vi.fn(), onMute: vi.fn(),
})

describe('video OSD', () => {
  it('uses the exact accelerated seek steps and Up Next threshold', () => {
    expect([getSeekStep(0), getSeekStep(1999), getSeekStep(2000), getSeekStep(5000)]).toEqual([10, 10, 30, 60])
    expect(shouldShowUpNext(59, 600)).toBe(false)
    expect(shouldShowUpNext(539, 600)).toBe(false)
    expect(shouldShowUpNext(554, 600)).toBe(false)
    expect(shouldShowUpNext(555, 600)).toBe(true)
  })

  it('selects preferred non-default audio and forced subtitles deterministically', () => {
    const tracks = {
      container: 'mkv', durationSec: 600, video: null, directPlayable: true, loudness: null, targetLufs: -16,
      audio: [
        { index: 1, codec: 'aac', language: 'en', title: null, channels: 2, channelLayout: 'stereo', default: true, browserFriendly: true },
        { index: 2, codec: 'ac3', language: 'fr-FR', title: null, channels: 6, channelLayout: '5.1', default: false, browserFriendly: false },
      ],
      subtitles: [
        { index: 3, codec: 'subrip', language: 'en', title: null, default: false, forced: true, textBased: true },
        { index: 4, codec: 'pgs', language: 'fr', title: null, default: false, forced: true, textBased: false },
      ],
    } satisfies MediaTracks
    expect(preferredTrackSelection(tracks, { normalizeVolume: true, targetLufs: -16, preferredAudioLanguage: 'fr', preferredSubtitleLanguage: 'en-US', subtitles: 'forced' }))
      .toEqual({ audioIndex: 2, subIndex: 3, requiresCompat: true })
    expect(preferredTrackSelection(tracks, { normalizeVolume: true, targetLufs: -16, preferredAudioLanguage: null, preferredSubtitleLanguage: null, subtitles: 'off' }))
      .toEqual({ audioIndex: null, subIndex: null, requiresCompat: false })
    expect(startingTrackSelection(tracks, { normalizeVolume: true, targetLufs: -16, preferredAudioLanguage: 'fr', preferredSubtitleLanguage: 'en', subtitles: 'forced' }, { initialAudioIndex: 1, initialSubtitleIndex: null }))
      .toEqual({ audioIndex: 1, subIndex: null, requiresCompat: true })
  })

  it('opens without network, navigates visible controls, and restores panel focus', () => {
    const fetch = vi.fn(() => { throw new Error('OSD must not fetch') })
    vi.stubGlobal('fetch', fetch)
    const input = props()
    render(<VideoOsd {...input} />)
    const pause = screen.getByRole('button', { name: 'Pause' })
    expect(document.activeElement).toBe(pause)
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back 10 seconds' }))
    const audio = screen.getByRole('button', { name: 'Audio' })
    fireEvent.click(audio)
    expect(screen.getByRole('dialog', { name: 'audio options' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the low-cost primary layer within its television control budget', () => {
    const input = props()
    const view = render(<VideoOsd {...input} />)
    const primary = view.container.querySelector<HTMLElement>('[data-osd-layer="primary"]')
    const labels = Array.from(primary?.querySelectorAll<HTMLElement>('[data-osd-control]') ?? []).map(control => control.getAttribute('aria-label'))
    expect(labels).toEqual(['Pause', 'Back 10 seconds', 'Forward 10 seconds', 'Stop', 'Audio', 'Subtitles', 'More controls'])
    expect(labels.length).toBeLessThanOrEqual(8)
    fireEvent.click(screen.getByRole('button', { name: 'More controls' }))
    expect(screen.getByRole('dialog', { name: 'more options' })).toBeTruthy()
    expect(view.container.querySelector('[data-osd-panel="more"]')).toBeTruthy()
  })

  it('answers a TV remote\u2019s transport buttons', () => {
    vi.useFakeTimers()
    try {
      const input = props()
      const { rerender } = render(<VideoOsd {...input} visible={false} />)
      // Fast forward and rewind move one scrub, sought to once when it rests.
      fireEvent.keyDown(window, { key: 'MediaFastForward' })
      fireEvent.keyDown(window, { key: 'MediaRewind' })
      expect(input.onSeek).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(SCRUB_COMMIT_MS + 10) })
      expect(input.onSeek).toHaveBeenCalledOnce()
      expect(input.onSeek).toHaveBeenLastCalledWith(120)
      fireEvent.keyDown(window, { key: 'MediaPlay' })
      expect(input.onToggle).not.toHaveBeenCalled()
      fireEvent.keyDown(window, { key: 'MediaPause' })
      expect(input.onToggle).toHaveBeenCalledOnce()
      rerender(<VideoOsd {...input} visible={false} playing={false} />)
      fireEvent.keyDown(window, { key: 'MediaPlay' })
      expect(input.onToggle).toHaveBeenCalledTimes(2)
      fireEvent.keyDown(window, { key: 'MediaStop' })
      expect(input.onStop).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('scrubs a preview and seeks once, and Back abandons a scrub rather than the film', () => {
    vi.useFakeTimers()
    try {
      const input = props()
      render(<VideoOsd {...input} visible={false} />)
      for (let press = 0; press < 3; press++) { fireEvent.keyDown(window, { key: 'ArrowRight' }); fireEvent.keyUp(window, { key: 'ArrowRight' }) }
      // Scrubbing brings the timeline up with focus on it, showing the target.
      expect(document.activeElement).toBe(screen.getByRole('slider', { name: 'Playback position', hidden: true }))
      expect(screen.getByRole('slider', { name: 'Playback position', hidden: true }).getAttribute('value')).toBe('130')
      expect(input.onSeek).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(SCRUB_COMMIT_MS + 10) })
      expect(input.onSeek).toHaveBeenCalledOnce()
      expect(input.onSeek).toHaveBeenCalledWith(130)
      fireEvent.keyDown(window, { key: 'ArrowLeft' }); fireEvent.keyUp(window, { key: 'ArrowLeft' })
      fireEvent.keyDown(window, { key: 'Escape' })
      act(() => { vi.advanceTimersByTime(SCRUB_COMMIT_MS + 10) })
      expect(input.onSeek).toHaveBeenCalledOnce()
      expect(input.onStop).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('never presses a hidden control: OK skips what is on offer, else shows the controls', () => {
    const input = props()
    const hiddenSelect = vi.fn(() => false)
    const { rerender } = render(<VideoOsd {...input} visible={false} onHiddenSelect={hiddenSelect} />)
    screen.getByRole('button', { name: 'Stop', hidden: true }).focus()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(input.onStop).not.toHaveBeenCalled()
    expect(hiddenSelect).toHaveBeenCalledOnce()
    expect(input.onInteraction).toHaveBeenCalled()
    const skip = vi.fn(() => true)
    rerender(<VideoOsd {...input} visible={false} onHiddenSelect={skip} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(skip).toHaveBeenCalledOnce()
    expect(input.onStop).not.toHaveBeenCalled()
  })

  it('leaves the remote to a layer over the video', () => {
    const input = props()
    render(<><VideoOsd {...input} visible={false} /><div data-osd-yield><button>What next</button></div></>)
    screen.getByRole('button', { name: 'What next' }).focus()
    // Not consumed, so the spatial engine can walk that layer's own buttons.
    expect(fireEvent.keyDown(window, { key: 'ArrowRight' })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 'Escape' })).toBe(true)
    expect(input.onStop).not.toHaveBeenCalled()
    expect(input.onSeek).not.toHaveBeenCalled()
  })

  it('seeks while hidden and supports Up Next cancellation', () => {
    const input = props()
    const { rerender } = render(<VideoOsd {...input} visible={false} />)
    vi.useFakeTimers()
    try {
      fireEvent.keyDown(window, { key: 'ArrowRight' }); fireEvent.keyUp(window, { key: 'ArrowRight' })
      act(() => { vi.advanceTimersByTime(SCRUB_COMMIT_MS + 10) })
    } finally { vi.useRealTimers() }
    expect(input.onSeek).toHaveBeenCalledWith(110)
    const next = { key: 'episode:2', type: 'episode' as const, id: 2, title: 'Next', posterUrl: null, backdropUrl: null, streamUrl: '/stream' }
    const cancel = vi.fn()
    rerender(<UpNext currentTime={560} duration={600} next={next} cancelled={false} onPlay={vi.fn()} onCancel={cancel} />)
    expect(screen.getByText('Next')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
