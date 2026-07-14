import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { getSeekStep, VideoOsd } from '../src/components/osd/VideoOsd.js'
import { shouldShowUpNext, UpNext } from '../src/components/osd/UpNext.js'
import { preferredTrackSelection } from '../src/components/Player.js'
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

  it('seeks while hidden and supports Up Next cancellation', () => {
    const input = props()
    const { rerender } = render(<VideoOsd {...input} visible={false} />)
    fireEvent.keyDown(window, { key: 'ArrowRight' }); fireEvent.keyUp(window, { key: 'ArrowRight' })
    expect(input.onSeek).toHaveBeenCalledWith(110)
    const next = { key: 'episode:2', type: 'episode' as const, id: 2, title: 'Next', posterUrl: null, backdropUrl: null, streamUrl: '/stream' }
    const cancel = vi.fn()
    rerender(<UpNext currentTime={560} duration={600} next={next} cancelled={false} onPlay={vi.fn()} onCancel={cancel} />)
    expect(screen.getByText('Next')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(cancel).toHaveBeenCalledOnce()
  })
})
