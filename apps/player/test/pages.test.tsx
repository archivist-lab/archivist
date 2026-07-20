import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { FocusProvider } from '../src/focus/FocusProvider.js'
import { SearchPage } from '../src/pages/SearchPage.js'
import type { ArchivistSdk } from '../src/lib/sdk.js'
import type { PlayerBootstrap, PlayerHub, PlayerMediaCard, PlayerPreferencesV1 } from '@archivist/contracts'
import { Hub } from '../src/components/Hub.js'
import { playerStore, removeProgress, saveProgress } from '../src/lib/store.js'
import { SeriesDetailPage } from '../src/pages/SeriesDetail.js'
import { BrowsePage } from '../src/pages/Browse.js'

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

  it('normalizes legacy combined hubs to the canonical Home composition', () => {
    const preferences: PlayerPreferencesV1 = {
      schemaVersion: 3, preset: 'combined', navigation: { edgeRail: 'visible', showClock: false },
      home: { hubs: [{ id: 'home', name: 'Home', icon: '⌂', enabled: true, layout: 'combined', showSpotlight: true, spotlightWidgetId: null, widgets: [
        { id: 'films', title: 'Film shelf', source: 'recent-films', view: 'poster', sort: 'source', sortOrder: 'desc', limit: 12, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true },
        { id: 'series', title: 'Series shelf', source: 'series-az', view: 'wall', sort: 'source', sortOrder: 'asc', limit: 12, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true },
      ] }] },
      libraries: { films: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false }, series: { view: 'wall', sort: 'title', sortOrder: 'asc', hideUnavailable: false } },
      browsing: { defaultViews: { films: 'poster', series: 'wall', seasons: 'poster', episodes: 'landscape', collections: 'poster', people: 'poster' }, savedFilters: [] },
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
      id: 'home', title: 'Home', icon: '⌂', layout: 'combined', showSpotlight: true, spotlight: film,
      categories: [{ id: 'films', label: 'Film shelf', active: true }, { id: 'series', label: 'Series shelf', active: false }],
      widgets: [
        { id: 'films', title: 'Film shelf', source: 'recent-films', view: 'poster', sort: 'source', sortOrder: 'desc', autoscrollSeconds: 0, items: [film], nextCursor: null, total: 1, showMoreRoute: '/films' },
        { id: 'series', title: 'Series shelf', source: 'series-az', view: 'wall', sort: 'source', sortOrder: 'asc', autoscrollSeconds: 0, items: [series], nextCursor: null, total: 1, showMoreRoute: '/series' },
      ],
    }
    const bootstrap = {
      server: { status: 'ok', serverName: 'Archivist', version: '2', capabilities: {} }, featureFlags: { uiV2Enabled: true, telemetryEnabled: false },
      configuration: { defaultPreset: 'categories', maxWidgetItems: 36 }, preferences: { profileId: 'default', revision: 1, updatedAt: '2026-01-01', preferences },
      libraries: [], progress: [], initialHub: hub,
    } satisfies PlayerBootstrap
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    const sdk = { asset: (path: string | null) => path ?? '' } as ArchivistSdk
    const view = render(<MemoryRouter><FocusProvider onBack={() => {}}><Hub hub={hub} sdk={sdk} /></FocusProvider></MemoryRouter>)
    expect(view.container.querySelector('[data-hub-layout="standard"]')).toBeTruthy()
    expect(view.container.querySelectorAll('[data-widget-cards="standard"]')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'Film shelf' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Series shelf' })).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('normalizes legacy Wall hubs to the canonical horizontal composition', () => {
    const item: PlayerMediaCard = {
      key: 'film:1', mediaType: 'film', id: 1, route: '/film/1', title: 'Grid Film', subtitle: '2026', plot: 'A wall fixture.', year: 2026,
      posterUrl: null, landscapeUrl: null, backdropUrl: null, logoUrl: null, progress: null, badges: [], available: true, primaryAction: 'play',
    }
    const hub: PlayerHub = {
      id: 'wall', title: 'Wall', icon: 'W', layout: 'wall', showSpotlight: false, spotlight: null, categories: [],
      widgets: [{ id: 'films', title: 'All films', source: 'films-az', view: 'poster', sort: 'title', sortOrder: 'asc', autoscrollSeconds: 0, items: [item], nextCursor: null, total: 1, showMoreRoute: '/films' }],
    }
    const sdk = { asset: (path: string | null) => path ?? '' } as ArchivistSdk
    const view = render(<MemoryRouter><FocusProvider onBack={() => {}}><Hub hub={hub} sdk={sdk} /></FocusProvider></MemoryRouter>)
    const cards = view.container.querySelector<HTMLElement>('[data-widget-cards="standard"]')
    expect(view.container.querySelector('[data-hub-layout="standard"]')).toBeTruthy()
    expect(cards?.classList.contains('flex')).toBe(true)
    expect(view.container.querySelector('[data-card-layout="standard"]')).toBeTruthy()
  })

  it('opens episode information with Right and restores the exact episode focus on Back', async () => {
    const episode = {
      id: 11, type: 'episode', seriesId: 2, seasonNumber: 1, episodeNumber: 2, title: 'Arrival',
      overview: 'A complete episode fixture.', airDate: '2026-01-02', runtimeSeconds: 2700, stillUrl: null,
      hasFile: true, status: 'available', quality: { resolution: '1080p', source: 'WEB', codec: 'x265', tier: 1 },
      playback: { directPlay: true, streamUrl: '/api/v1/player/stream/episodes/11' }, progress: null,
    }
    const watchedEpisode = { ...episode, id: 10, episodeNumber: 1, title: 'Previously', playback: { directPlay: true, streamUrl: '/api/v1/player/stream/episodes/10' } }
    const detail = {
      id: 2, type: 'series', libraryId: 2, title: 'Synthetic Series', sortTitle: 'Synthetic Series', year: 2026,
      overview: 'Series fixture.', posterUrl: null, backdropUrl: null, logoUrl: null, network: 'Archive',
      seriesStatus: 'Continuing', rating: 8, certification: 'TV-14', genres: ['Drama'], episodeCount: 2,
      availableEpisodeCount: 2, status: 'available', addedAt: '2026-01-01', cast: [], crew: [],
      seasons: [{ id: 21, seasonNumber: 1, title: 'Season 1', posterUrl: null, episodes: [watchedEpisode, episode] }],
      nextAvailable: episode, primaryAction: 'resume-next',
    }
    const sdk = { seriesDetail: vi.fn(async () => detail), mediaTracks: vi.fn(async () => ({ container: 'mkv', durationSec: 2700, video: null, audio: [], subtitles: [], directPlayable: true, loudness: null, targetLufs: -16, chapters: [] })), asset: (path: string | null) => path ?? '' } as unknown as ArchivistSdk
    saveProgress({ key: 'episode:10', type: 'episode', id: 10, title: 'Previously', posterUrl: null, backdropUrl: null, streamUrl: '/api/v1/player/stream/episodes/10', seriesId: 2, seriesTitle: 'Synthetic Series', positionSeconds: 2700, durationSeconds: 2700, completed: true })
    render(<MemoryRouter initialEntries={['/series/2']}><FocusProvider onBack={() => {}}><Routes><Route path="/series/:id" element={<SeriesDetailPage sdk={sdk} v2 />} /></Routes></FocusProvider></MemoryRouter>)
    const row = await screen.findByRole('button', { name: /S01E02.*Arrival/ })
    expect(screen.queryByRole('button', { name: /S01E01.*Previously/ })).toBeNull()
    const watchedToggle = screen.getByRole('button', { name: 'Show watched: Off' })
    expect(watchedToggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(watchedToggle)
    expect(screen.getByRole('button', { name: /S01E01.*Previously/ })).toBeTruthy()
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    const episodeDialog = screen.getByRole('dialog', { name: 'Arrival' })
    expect(episodeDialog).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close episode information' })).toBe(document.activeElement))
    const media = within(episodeDialog).getByRole('button', { name: /Media/ })
    media.focus()
    fireEvent.click(media)
    expect(screen.getAllByRole('dialog')).toHaveLength(2)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(document.activeElement).toBe(media)
    fireEvent.keyDown(window, { key: 'Escape' })
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(screen.queryByRole('dialog', { name: 'Arrival' })).toBeNull()
    expect(document.activeElement).toBe(row)

    // The final available episode has no following item. Playing it must start
    // normally with a null Up Next target rather than dereferencing undefined.
    fireEvent.click(row)
    const finalEpisodeDialog = screen.getByRole('dialog', { name: 'Arrival' })
    fireEvent.click(within(finalEpisodeDialog).getByRole('button', { name: 'Play' }))
    expect(playerStore.getState().activePlayback?.target.id).toBe(11)
    expect(playerStore.getState().activePlayback?.nextTarget).toBeNull()
    playerStore.dispatch({ type: 'PLAYBACK_STOPPED' })
    removeProgress('episode:10')
  })

  it('applies filters without exposing saved-view or hub customization', async () => {
    const preferences: PlayerPreferencesV1 = {
      schemaVersion: 3, preset: 'categories', navigation: { edgeRail: 'visible', showClock: false },
      home: { hubs: [{ id: 'home', name: 'Home', icon: '⌂', enabled: true, layout: 'standard', showSpotlight: true, spotlightWidgetId: null, widgets: [
        { id: 'films', title: 'Films', source: 'films-az', view: 'poster', sort: 'source', sortOrder: 'asc', limit: 18, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true },
      ] }] },
      libraries: { films: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false }, series: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false } },
      browsing: { defaultViews: { films: 'poster', series: 'poster', seasons: 'poster', episodes: 'landscape', collections: 'poster', people: 'poster' }, savedFilters: [] },
      playback: { normalizeVolume: true, targetLufs: -16, preferredAudioLanguage: null, preferredSubtitleLanguage: null, subtitles: 'forced' },
      accessibility: { reducedMotion: 'system', highContrast: false, textScale: 1 }, migration: { legacyLocalStorageImported: true },
    }
    const item: PlayerMediaCard = { key: 'film:1', mediaType: 'film', id: 1, route: '/film/1', title: 'Synthetic Film', subtitle: '2026', plot: 'A film', year: 2026, posterUrl: null, landscapeUrl: null, backdropUrl: null, logoUrl: null, progress: null, badges: [], available: true, primaryAction: 'play' }
    const browse = vi.fn(async (_type, options) => ({ mediaType: 'films', title: 'Films', items: [item], total: 1, nextCursor: null, facets: { genres: ['Drama'], studios: ['North Studio'], yearMin: 2000, yearMax: 2026 }, filters: options.filters, sort: options.sort ?? 'title', sortOrder: options.direction ?? 'asc' }))
    const updatePreferences = vi.fn(async (input: any) => ({ profileId: 'default', revision: 2, updatedAt: '2026-07-18', preferences: input.preferences }))
    const sdk = { browse, updatePreferences, asset: (path: string | null) => path ?? '' } as unknown as ArchivistSdk
    const bootstrap = { server: { status: 'ok', serverName: 'Archivist', version: '2', capabilities: {} }, featureFlags: { uiV2Enabled: true, telemetryEnabled: false }, configuration: { defaultPreset: 'categories', maxWidgetItems: 36 }, preferences: { profileId: 'default', revision: 1, updatedAt: '2026-07-18', preferences }, libraries: [], progress: [], initialHub: { id: 'home', title: 'Home', icon: '⌂', layout: 'standard', showSpotlight: false, categories: [], spotlight: null, widgets: [] } } satisfies PlayerBootstrap
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<MemoryRouter initialEntries={['/films']}><FocusProvider onBack={() => {}}><BrowsePage sdk={sdk} requestedType="films" /></FocusProvider></MemoryRouter>)
    expect(await screen.findByText('Synthetic Film')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Filter and sort' }))
    fireEvent.click(screen.getByRole('button', { name: 'Drama' }))
    fireEvent.change(screen.getByLabelText('Availability'), { target: { value: 'available' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(browse.mock.calls.at(-1)?.[1]).toMatchObject({ filters: { genres: ['Drama'], availability: 'available' } }))

    fireEvent.click(screen.getByRole('button', { name: 'Filter and sort' }))
    expect(screen.queryByLabelText('Saved view name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pin to hub' })).toBeNull()
    expect(screen.queryByLabelText('View')).toBeNull()
    expect(updatePreferences).not.toHaveBeenCalled()
  })
})
