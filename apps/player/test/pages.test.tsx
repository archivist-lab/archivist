import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { FocusProvider } from '../src/focus/FocusProvider.js'
import { SearchPage } from '../src/pages/SearchPage.js'
import type { ArchivistSdk } from '../src/lib/sdk.js'
import type { PlayerBootstrap, PlayerHub, PlayerMediaCard, PlayerPreferencesV1 } from '@archivist/contracts'
import { Hub } from '../src/components/Hub.js'
import { playerStore } from '../src/lib/store.js'
import { SeriesDetailPage } from '../src/pages/SeriesDetail.js'

describe('Player pages', () => {
  it('debounces normalized search and renders film, series, and episode groups', async () => {
    const search = vi.fn(async () => ({ results: [], groups: {
      films: [{ id: 1, type: 'film', title: 'Synthetic Film', year: 2026, overview: null, posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available' }],
      series: [{ id: 2, type: 'series', title: 'Synthetic Series', year: 2025, overview: null, posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available' }],
      episodes: [{ id: 3, type: 'episode', seriesId: 2, seriesTitle: 'Synthetic Series', seasonNumber: 1, episodeNumber: 2, title: 'Arrival', overview: null, stillUrl: null, status: 'available' }],
    } }))
    const sdk = { search, asset: (path: string | null) => path ?? '' } as unknown as ArchivistSdk
    render(<MemoryRouter><FocusProvider onBack={() => {}}><SearchPage sdk={sdk} v2 /></FocusProvider></MemoryRouter>)
    fireEvent.change(screen.getByPlaceholderText('Search films, series and episodes'), { target: { value: '  Café  ' } })
    expect(await screen.findByText('Synthetic Film')).toBeTruthy()
    expect(screen.getAllByText('Synthetic Series').length).toBeGreaterThan(0)
    expect(screen.getByText(/S01E02/)).toBeTruthy()
    expect(search).toHaveBeenCalledWith('Café', expect.any(AbortSignal))
  })

  it('filters Home categories and keeps focused wall information visible', () => {
    const preferences: PlayerPreferencesV1 = {
      schemaVersion: 1, preset: 'categories', navigation: { edgeRail: 'visible', showClock: false },
      home: { widgetMode: 'stacked', showSpotlight: true, widgets: [{ id: 'films', title: 'Film shelf', source: 'recent-films', view: 'poster', limit: 12, enabled: true }, { id: 'series', title: 'Series shelf', source: 'series-az', view: 'wall', limit: 12, enabled: true }] },
      libraries: { films: { view: 'poster', sort: 'title', hideUnavailable: false }, series: { view: 'wall', sort: 'title', hideUnavailable: false } },
      playback: { normalizeVolume: true, targetLufs: -16, preferredAudioLanguage: null, preferredSubtitleLanguage: null, subtitles: 'forced' },
      accessibility: { reducedMotion: 'system', highContrast: false, textScale: 1 }, migration: { legacyLocalStorageImported: true },
    }
    const card = (key: string, title: string, mediaType: 'film' | 'series'): PlayerMediaCard => ({
      key, mediaType, id: mediaType === 'film' ? 1 : 2, route: mediaType === 'film' ? '/film/1' : '/series/2', title, subtitle: '2026',
      plot: `${title} plot`, year: 2026, posterUrl: null, landscapeUrl: null, backdropUrl: null, logoUrl: null, progress: null,
      badges: [{ label: '1080p', tone: 'neutral' }], available: true, primaryAction: 'play',
    })
    const film = card('film:1', 'Synthetic Film', 'film')
    const series = card('series:2', 'Synthetic Series', 'series')
    const hub: PlayerHub = {
      id: 'home', title: 'Home', spotlight: film,
      categories: [{ id: 'all', label: 'All', active: true }, { id: 'films', label: 'Films', active: false }, { id: 'series', label: 'Series', active: false }],
      widgets: [
        { id: 'films', title: 'Film shelf', source: 'recent-films', view: 'poster', items: [film], nextCursor: null, total: 1 },
        { id: 'series', title: 'Series shelf', source: 'series-az', view: 'wall', items: [series], nextCursor: null, total: 1 },
      ],
    }
    const bootstrap = {
      server: { status: 'ok', serverName: 'Archivist', version: '2', capabilities: {} }, featureFlags: { uiV2Enabled: true, telemetryEnabled: false },
      configuration: { defaultPreset: 'categories', maxWidgetItems: 36 }, preferences: { profileId: 'default', revision: 1, updatedAt: '2026-01-01', preferences },
      libraries: [], progress: [], initialHub: hub,
    } satisfies PlayerBootstrap
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    const sdk = { asset: (path: string | null) => path ?? '' } as ArchivistSdk
    render(<MemoryRouter><FocusProvider onBack={() => {}}><Hub hub={hub} sdk={sdk} /></FocusProvider></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Film shelf' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Series shelf' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Series' }))
    expect(screen.queryByRole('heading', { name: 'Film shelf' })).toBeNull()
    expect(screen.getAllByRole('heading', { name: 'Synthetic Series' })).toHaveLength(2)
    expect(screen.getByRole('complementary').textContent).toContain('Synthetic Series plot')
  })

  it('opens episode information with Right and restores the exact episode focus on Back', async () => {
    const episode = {
      id: 11, type: 'episode', seriesId: 2, seasonNumber: 1, episodeNumber: 2, title: 'Arrival',
      overview: 'A complete episode fixture.', airDate: '2026-01-02', runtimeSeconds: 2700, stillUrl: null,
      hasFile: true, status: 'available', quality: { resolution: '1080p', source: 'WEB', codec: 'x265', tier: 1 },
      playback: { directPlay: true, streamUrl: '/api/v1/player/stream/episodes/11' }, progress: null,
    }
    const detail = {
      id: 2, type: 'series', libraryId: 2, title: 'Synthetic Series', sortTitle: 'Synthetic Series', year: 2026,
      overview: 'Series fixture.', posterUrl: null, backdropUrl: null, logoUrl: null, network: 'Archive',
      seriesStatus: 'Continuing', rating: 8, certification: 'TV-14', genres: ['Drama'], episodeCount: 1,
      availableEpisodeCount: 1, status: 'available', addedAt: '2026-01-01', cast: [], crew: [],
      seasons: [{ id: 21, seasonNumber: 1, title: 'Season 1', posterUrl: null, episodes: [episode] }],
      nextAvailable: episode, primaryAction: 'resume-next',
    }
    const sdk = { seriesDetail: vi.fn(async () => detail), asset: (path: string | null) => path ?? '' } as unknown as ArchivistSdk
    render(<MemoryRouter initialEntries={['/series/2']}><FocusProvider onBack={() => {}}><Routes><Route path="/series/:id" element={<SeriesDetailPage sdk={sdk} v2 />} /></Routes></FocusProvider></MemoryRouter>)
    const row = await screen.findByRole('button', { name: /S01E02.*Arrival/ })
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    expect(screen.getByRole('dialog', { name: 'Arrival' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close episode information' })).toBe(document.activeElement))
    fireEvent.keyDown(window, { key: 'Escape' })
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(screen.queryByRole('dialog', { name: 'Arrival' })).toBeNull()
    expect(document.activeElement).toBe(row)
  })
})
