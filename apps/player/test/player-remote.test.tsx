import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Player, type PlayTarget } from '../src/components/Player.js'
import { removeProgress, saveProgress } from '../src/lib/store.js'
import type { ArchivistSdk } from '../src/lib/sdk.js'

const tracks = { container: 'mp4', durationSec: 5400, video: null, audio: [], subtitles: [], directPlayable: true, loudness: null, targetLufs: -16, chapters: [] }

function stubSdk() {
  return {
    mediaTracks: vi.fn(async () => tracks),
    playbackPlan: vi.fn(async () => ({ mode: 'direct', reasons: [] })),
    bookmarks: vi.fn(async () => ({ bookmarks: [] })),
    rating: vi.fn(async () => ({ value: null, source: 'none', inheritedFrom: null, scaleMax: 5 })),
    saveProgress: vi.fn(async () => {}),
    deleteProgress: vi.fn(async () => {}),
    asset: (path: string | null) => path ?? '',
    transcodeUrl: () => '/transcode',
    hlsUrl: () => '/hls.m3u8',
    subtitleUrl: () => '/sub.vtt',
  } as unknown as ArchivistSdk
}

const film: PlayTarget = { key: 'film:7', type: 'film', id: 7, title: 'Harbour Lights', posterUrl: null, backdropUrl: null, streamUrl: '/stream/films/7' }

function partWatched() {
  saveProgress({ ...film, positionSeconds: 1200, durationSeconds: 5400, completed: false })
}

describe('the player and the remote', () => {
  it('asks to resume with focus on Resume, and Start Over is reachable', async () => {
    partWatched()
    render(<Player target={film} sdk={stubSdk()} onClose={vi.fn()} />)
    const prompt = screen.getByRole('dialog', { name: 'Resume or start over' })
    expect(prompt.getAttribute('aria-modal')).toBe('true')
    await waitFor(() => expect(document.activeElement?.textContent).toMatch(/^Resume/))
    expect(screen.getByRole('button', { name: 'Start Over' }).classList.contains('player-focusable')).toBe(true)
    removeProgress(film.key)
  })

  it('does not ask again when the page already chose', () => {
    partWatched()
    render(<Player target={{ ...film, startFrom: 'resume' }} sdk={stubSdk()} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog', { name: 'Resume or start over' })).toBeNull()
    removeProgress(film.key)
  })

  it('closes on Back at the resume prompt, and the key goes no further', () => {
    partWatched()
    const onClose = vi.fn()
    const beneath = vi.fn()
    document.addEventListener('keydown', beneath)
    try {
      render(<Player target={film} sdk={stubSdk()} onClose={onClose} />)
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledOnce()
      // The page under the video must not also read it as a Back.
      expect(beneath).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', beneath)
      removeProgress(film.key)
    }
  })

  it('holds the remote while playing: the root is a modal the page cannot be reached past', () => {
    render(<Player target={film} sdk={stubSdk()} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Playing Harbour Lights' }).getAttribute('aria-modal')).toBe('true')
  })

  it('asks the server to copy a picture this device decodes', () => {
    const sdk = stubSdk()
    const transcodeUrl = vi.fn(() => '/transcode')
    Object.assign(sdk, { transcodeUrl })
    const canPlay = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation(mime => (/hvc1|avc1|mp4a/.test(mime) ? 'probably' : ''))
    try {
      const view = render(<Player target={film} sdk={sdk} onClose={vi.fn()} />)
      // A direct-play failure falls back to the compatibility stream.
      fireEvent.error(view.container.querySelector('video')!)
      const options = (transcodeUrl.mock.calls.at(-1) as unknown[] | undefined)?.[2] as { copyVideo?: string[] } | undefined
      expect(options?.copyVideo).toEqual(expect.arrayContaining(['h264', 'hevc']))
    } finally { canPlay.mockRestore() }
  })
})
