import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MediaTracks } from '@archivist/contracts'
import type { ArchivistSdk } from '../src/lib/sdk.js'
import { languageFlag, MediaSelector, titleCase, type DetailTrackSelection } from '../src/components/MediaSelector.js'

const tracks: MediaTracks = {
  container: 'matroska', durationSec: 7200,
  video: { codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le', browserFriendly: false },
  audio: [
    { index: 1, codec: 'eac3', languageCode: 'eng', language: 'English', title: 'Original', channels: 6, channelLayout: '5.1', default: true, browserFriendly: false },
    { index: 2, codec: 'aac', languageCode: 'fra', language: 'French', title: 'DUB', channels: 2, channelLayout: 'stereo', default: false, browserFriendly: true },
  ],
  subtitles: [{ index: 3, codec: 'subrip', languageCode: 'eng', language: 'English', title: 'ENGLISH', default: true, forced: false, textBased: true }],
  directPlayable: false, loudness: null, targetLufs: -16, segments: null, segmentAnalysis: null, chapters: [],
}

describe('detail media selector', () => {
  it('uses an embedded country or a conventional language country for flags', () => {
    expect(languageFlag('en-US')).toBe('🇺🇸')
    expect(languageFlag('fr')).toBe('🇫🇷')
    expect(languageFlag('eng')).toBe('🇬🇧')
    expect(languageFlag('und')).toBe('🌐')
  })

  it('normalizes human-readable stream values to title case', () => {
    expect(titleCase('DIRECTOR COMMENTARY')).toBe('Director Commentary')
    expect(titleCase('stereo')).toBe('Stereo')
  })

  it('loads on demand and returns explicit audio and subtitle choices', async () => {
    const mediaTracks = vi.fn(async () => tracks)
    const sdk = { mediaTracks } as unknown as ArchivistSdk
    const update = vi.fn()
    function Harness() {
      const [selection, setSelection] = useState<DetailTrackSelection>({})
      return <MediaSelector sdk={sdk} type="films" id={7} title="Synthetic Film" selection={selection} onChange={next => { update(next); setSelection(next) }} />
    }
    render(<Harness />)
    expect(mediaTracks).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Media/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Synthetic Film' })
    await waitFor(() => expect(mediaTracks).toHaveBeenCalledWith('films', 7))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ audioIndex: 1, subtitleIndex: 3 }))
    expect(within(dialog).queryByRole('button', { name: 'Automatic' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: /Original 5.1 ㆍ EAC3/ }).getAttribute('aria-pressed')).toBe('true')
    expect(within(dialog).getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(dialog).getByRole('button', { name: /Dub Stereo ㆍ AAC/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'English' }))
    expect(update).toHaveBeenLastCalledWith({ audioIndex: 2, subtitleIndex: 3 })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(await screen.findByText(/🇫🇷 Dub · 🇬🇧 English/)).toBeTruthy()
  })
})
