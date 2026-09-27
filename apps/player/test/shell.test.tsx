import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { PlayerBootstrap, PlayerPreferencesV1 } from '@archivist/contracts'
import { PlayerShell } from '../src/components/Shell.js'
import type { ArchivistSdk } from '../src/lib/sdk.js'
import { playerStore } from '../src/lib/store.js'

const preferences: PlayerPreferencesV1 = {
  schemaVersion: 3, preset: 'categories', navigation: { edgeRail: 'visible', showClock: true },
  home: { hubs: [
    { id: 'home', name: 'Home', icon: '⌂', enabled: true, layout: 'standard', showSpotlight: true, spotlightWidgetId: null, widgets: [{ id: 'recent-films', title: 'Films', source: 'recent-films', view: 'poster', sort: 'source', sortOrder: 'desc', limit: 12, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true }] },
    { id: 'family', name: 'Family', icon: '★', enabled: true, layout: 'wall', showSpotlight: false, spotlightWidgetId: null, widgets: [{ id: 'films', title: 'Family Films', source: 'films-az', view: 'poster', sort: 'title', sortOrder: 'asc', limit: 18, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true }] },
  ] },
  libraries: { films: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false }, series: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false } },
  browsing: { defaultViews: { films: 'poster', series: 'poster', seasons: 'poster', episodes: 'landscape', collections: 'poster', people: 'poster' }, savedFilters: [] },
  playback: { normalizeVolume: true, targetLufs: -16, preferredAudioLanguage: null, preferredSubtitleLanguage: null, subtitles: 'forced' },
  accessibility: { reducedMotion: 'system', highContrast: false, textScale: 1 }, migration: { legacyLocalStorageImported: true },
}
const bootstrap = {
  server: { status: 'ok', serverName: 'Archivist', version: '2', capabilities: {} },
  featureFlags: { uiV2Enabled: true, telemetryEnabled: false }, configuration: { defaultPreset: 'categories', maxWidgetItems: 36 },
  preferences: { profileId: 'default', revision: 1, updatedAt: '2026-01-01', preferences }, libraries: [], progress: [],
  initialHub: { id: 'home', title: 'Home', icon: '⌂', layout: 'standard', showSpotlight: true, categories: [], spotlight: null, widgets: [{ id: 'recent-films', title: 'Films', source: 'recent-films', view: 'poster', sort: 'source', sortOrder: 'desc', autoscrollSeconds: 0, items: [], nextCursor: null, total: 0, showMoreRoute: '/films' }] },
} satisfies PlayerBootstrap

/** The series rows resolve on the server; these tests exercise the film side. */
const emptyShelves = { rows: [] }

/** Row configuration as the server ships it, so tests see the stock layout. */
const row = (id: string, label: string, over: Record<string, unknown> = {}) => ({
  id, label, source: id.startsWith('films') ? 'films' : id === 'series-all' ? 'series' : id === 'series-next-up' ? 'next-up' : 'episodes',
  enabled: true, windowField: 'none', windowDays: 90, watchState: 'all', genres: [],
  minRating: null, yearFrom: null, yearTo: null, sort: 'added', sortOrder: 'desc',
  limit: 18, view: 'poster', dedupeAgainst: [], ...over,
})
const shelfSettings = {
  settings: {
    films: { enabled: true, label: 'Films', rows: [
      row('films-recently-added', 'Recently Added', { windowField: 'added', watchState: 'unwatched', dedupeAgainst: ['films-recently-released'] }),
      row('films-recently-released', 'Recently Released', { windowField: 'released', watchState: 'unwatched' }),
      row('films-all', 'All films', { limit: 100, sort: 'title', sortOrder: 'asc' }),
    ] },
    series: { enabled: true, label: 'Series', rows: [
      row('series-next-up', 'Next Up', { watchState: 'unwatched' }),
      row('series-recently-added', 'Recently Added', { windowField: 'added' }),
      row('series-recently-aired', 'Recently Aired', { windowField: 'aired' }),
      row('series-all', 'All series', { limit: 100 }),
    ] },
  },
}

describe('living-room shell', () => {
  it('keeps the fixed navigation order in the top-left menu and establishes initial remote focus', async () => {
    const sdk = { asset: (path: string | null) => path ?? '', series: async () => ({ series: [] }), films: async () => ({ films: [] }), seriesShelves: async () => emptyShelves, shelfSettings: async () => shelfSettings, boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }) } as unknown as ArchivistSdk
    const signOut = vi.fn()
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<StrictMode><MemoryRouter initialEntries={['/settings']}><PlayerShell sdk={sdk} bootstrap={bootstrap} username="archivist" onSignOut={signOut} /></MemoryRouter></StrictMode>)
    const navigation = screen.getByRole('navigation', { name: 'Player' })
    expect(Array.from(navigation.querySelectorAll('a')).map(item => item.getAttribute('aria-label')))
      .toEqual(['Home', 'Films', 'Series', 'Music', 'Books', 'Games', 'Leaving Soon', 'Settings'])
    // The side rail is gone: no aside, no collapse toggle, and nothing holding
    // a column of the screen open beside the page.
    expect(navigation.closest('aside')).toBeNull()
    expect(screen.queryByRole('button', { name: /navigation/i })).toBeNull()
    expect(navigation.closest('.player-nav')).toBeTruthy()
    // Sign out is a small utility opposite the main menu, not one of its items.
    expect(navigation.querySelector('[aria-label="Sign out"]')).toBeNull()
    const signOutButton = screen.getByRole('button', { name: 'Sign out' })
    expect(signOutButton.getAttribute('title')).toBe('Sign out archivist')
    fireEvent.click(signOutButton)
    expect(signOut).toHaveBeenCalledOnce()
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Settings')
    expect(viewRoot().dataset.edgeRail).toBeUndefined()
    expect(viewRoot().dataset.sidebarCollapsed).toBeUndefined()
    expect(viewRoot().querySelector('.motion-backdrop')).toBeNull()
  })

  it('names a type\u2019s libraries in a second row under the menu item they belong to', async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
    const film = (id: number, title: string, libraryId: number) => ({
      id, type: 'film', libraryId, title, sortTitle: title, year: 2024, overview: null,
      posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available', hasFile: true,
      rating: 7, certification: null, studio: null, genres: [], runtime: 100, quality: null,
      addedAt: iso(5), acquiredAt: iso(5), releaseDate: iso(5),
      digitalReleaseDate: null, physicalReleaseDate: null, progress: null,
    })
    const catalogue = [film(1, 'Zulu', 1), film(2, 'Alpha', 1), film(3, 'Beta', 2)]
    const asked: Array<number | undefined> = []
    const sdk = {
      asset: (path: string | null) => path ?? '',
      series: async () => ({ series: [] }),
      films: async (library?: number) => { asked.push(library); return { films: library ? catalogue.filter(item => item.libraryId === library) : catalogue } },
      seriesShelves: async () => emptyShelves,
      shelfSettings: async () => shelfSettings,
      boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }),
    } as unknown as ArchivistSdk
    // Two film libraries, one series library: only films earn the second row.
    const libraries = [
      { id: 1, name: 'Films', mediaType: 'films', itemCount: 1, availableCount: 1 },
      { id: 2, name: '4K Films', mediaType: 'films', itemCount: 1, availableCount: 1 },
      { id: 3, name: 'Series', mediaType: 'series', itemCount: 0, availableCount: 0 },
    ]
    const withLibraries = { ...bootstrap, libraries } as PlayerBootstrap
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap: withLibraries })
    const view = render(<MemoryRouter initialEntries={['/films']}><PlayerShell sdk={sdk} bootstrap={withLibraries} /></MemoryRouter>)

    const row = () => screen.queryByRole('navigation', { name: 'Film libraries' })
    await waitFor(() => expect(row()).toBeTruthy())
    // Each library, in the order the server sent, with no "everything" entry:
    // one library is always open, and the first is the one you land on.
    expect(Array.from(row()!.querySelectorAll('button')).map(node => node.textContent))
      .toEqual(['Films', '4K Films'])
    expect(row()!.querySelector('[aria-current="true"]')?.textContent).toBe('Films')
    await waitFor(() => expect(asked).toContain(1))
    await waitFor(() => expect(view.container.querySelector('.cv-shelf[aria-label="All films"]')?.textContent).toContain('ALPHA'))

    // Pressing the library you are already in opens it: everything it holds,
    // alphabetically, as one grid rather than the curated rows.
    fireEvent.click(Array.from(row()!.querySelectorAll('button'))[0])
    await waitFor(() => expect(view.container.querySelector('.cv-grid')).toBeTruthy())
    expect(Array.from(view.container.querySelectorAll('.cv-grid .cv-art .lg')).map(node => node.textContent))
      .toEqual(['ALPHA', 'ZULU'])
    // The row is still there, still saying which library is open.
    expect(row()!.querySelector('[aria-current="true"]')?.textContent).toBe('Films')

    // The grid wraps down the page, so the cursor brings its tile into view —
    // arrowing along it must not walk off the bottom of the screen.
    const reveal = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    ;(view.container.querySelector('.cv-anchor') as HTMLElement).focus()
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    const current = () => view.container.querySelector('.cv-grid .cv-tile[aria-current="true"]')
    await waitFor(() => expect(current()?.textContent).toContain('ZULU'))
    await waitFor(() => expect(reveal.mock.instances).toContain(current()))
    reveal.mockRestore()

    // Picking another narrows the page to it, by re-asking for that library.
    fireEvent.click(Array.from(row()!.querySelectorAll('button'))[1])
    await waitFor(() => expect(asked).toContain(2))
    await waitFor(() => expect(view.container.querySelector('.cv-grid')).toBeNull())
    await waitFor(() => expect(row()!.querySelector('[aria-current="true"]')?.textContent).toBe('4K Films'))
    await waitFor(() => {
      const shelf = view.container.querySelector('.cv-shelf[aria-label="All films"]')?.textContent
      expect(shelf).toContain('BETA')
      expect(shelf).not.toContain('ALPHA')
    })

    // Series holds one library, so its page carries no row at all.
    view.unmount()
    render(<MemoryRouter initialEntries={['/series']}><PlayerShell sdk={sdk} bootstrap={withLibraries} /></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Player' })).toBeTruthy())
    expect(screen.queryByRole('navigation', { name: /libraries/ })).toBeNull()
  })

  it('guards a dirty Settings draft with Cancel and Discard before navigation', async () => {
    const sdk = { asset: (path: string | null) => path ?? '', series: async () => ({ series: [] }), films: async () => ({ films: [] }), seriesShelves: async () => emptyShelves, shelfSettings: async () => shelfSettings, boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }) } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<MemoryRouter initialEntries={['/settings']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Normalize loudness: On' }))
    fireEvent.click(screen.getByRole('link', { name: 'Home' }))
    expect(screen.getByRole('dialog', { name: 'Save changes before leaving?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Save changes before leaving?' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy()

    fireEvent.click(screen.getByRole('link', { name: 'Home' }))
    fireEvent.click(screen.getByRole('dialog', { name: 'Save changes before leaving?' }).querySelectorAll('button')[1])
    // Home is the Combined view now; its empty row is the proof that Discard
    // let the navigation through.
    expect(await screen.findByText('Nothing here yet.')).toBeTruthy()
  })

  it('stacks each film folder as its own shelf instead of a folder strip', async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
    // One film per bucket: added recently but released long ago, added and
    // released recently, and an old arrival that only "All films" holds.
    const film = (id: number, title: string, added: number, released: number) => ({
      id, type: 'film', title, sortTitle: title, year: 2024, overview: `${title} overview`,
      posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available', hasFile: true,
      rating: 7, certification: null, studio: null, genres: [], runtime: 100, quality: null,
      addedAt: iso(added), acquiredAt: iso(added), releaseDate: iso(released),
      digitalReleaseDate: null, physicalReleaseDate: null, progress: null,
    })
    const films = [
      film(1, 'Back Catalogue', 10, 900),
      film(2, 'Brand New', 12, 20),
      film(3, 'Long Owned', 800, 1200),
    ]
    const sdk = {
      asset: (path: string | null) => path ?? '',
      series: async () => ({ series: [] }),
      films: async () => ({ films }),
      seriesShelves: async () => emptyShelves,
      shelfSettings: async () => shelfSettings,
      boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }),
    } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    // The curated rows live on Home; /films is the whole-library grid.
    const view = render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)

    await waitFor(() => expect(view.container.querySelectorAll('.cv-shelf')).toHaveLength(3))
    expect(Array.from(view.container.querySelectorAll('.cv-shelf-heading')).map(node => node.textContent))
      .toEqual(['Recently Added1 films', 'Recently Released1 films', 'All films3 films'])
    // The folder strip is what the shelves replace.
    expect(screen.queryByRole('tablist', { name: 'Folders' })).toBeNull()

    const shelves = Array.from(view.container.querySelectorAll('.cv-shelf'))
    const titles = (shelf: Element) => Array.from(shelf.querySelectorAll('.cv-tile')).length
    expect(shelves.map(titles)).toEqual([1, 1, 3])

    // Focus starts on the first shelf, and Down carries the column into the next.
    expect(shelves[0].querySelector('.cv-tile[aria-current="true"]')).toBeTruthy()
    // The view takes real focus on its own anchor a frame after it lands, and
    // the arrow keys only reach it once it has.
    await waitFor(() => expect(document.activeElement?.getAttribute('data-focus-id')).toBe('cv-content'))
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    await waitFor(() => expect(shelves[1].querySelector('.cv-tile[aria-current="true"]')).toBeTruthy())
    // The hero names the focused film, not the shelf heading above it.
    expect(view.container.querySelector('.cv-title')?.textContent).toBe('BRAND NEW')
  })

  it('hands the arrow keys to the main menu on Up from the top row, and takes them back on Down', async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
    const film = (id: number, title: string, added: number, released: number) => ({
      id, type: 'film', title, sortTitle: title, year: 2024, overview: null,
      posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available', hasFile: true,
      rating: 7, certification: null, studio: null, genres: [], runtime: 100, quality: null,
      addedAt: iso(added), acquiredAt: iso(added), releaseDate: iso(released),
      digitalReleaseDate: null, physicalReleaseDate: null, progress: null,
    })
    const films = [film(1, 'Back Catalogue', 10, 900), film(2, 'Brand New', 12, 20), film(3, 'Long Owned', 800, 1200)]
    const sdk = {
      asset: (path: string | null) => path ?? '',
      series: async () => ({ series: [] }),
      films: async () => ({ films }),
      seriesShelves: async () => emptyShelves,
      shelfSettings: async () => shelfSettings,
      boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }),
    } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)

    await waitFor(() => expect(document.querySelectorAll('.cv-shelf')).toHaveLength(3))
    // Landing on Home puts real keyboard focus on the Combined view's own
    // anchor, not on any menu item — arrows browse the page by default.
    await waitFor(() => expect(document.activeElement?.getAttribute('data-focus-id')).toBe('cv-content'))

    // A real keypress targets whatever element holds focus and bubbles up
    // through the document, then the window — reaching the main menu's own
    // listener first and the Combined view's listener second, exactly as
    // production relies on. Firing on the focused element itself, rather
    // than on window directly, is what makes that ordering real here too.
    // The controller briefly locks out repeat moves after each jump, so a
    // real remote's key repeats do not overshoot — a gap real key presses
    // always have is spelled out here between each simulated one.
    const press = async (key: string) => {
      await new Promise(resolve => setTimeout(resolve, 80))
      fireEvent.keyDown(document.activeElement!, { key, bubbles: true })
    }

    // Up from the top shelf reaches the matching menu item.
    await press('ArrowUp')
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Home'))

    // While the menu holds focus, the Combined view no longer reacts to arrows.
    await press('ArrowDown')
    await waitFor(() => expect(document.activeElement?.getAttribute('data-focus-id')).toBe('cv-content'))
    expect(document.querySelectorAll('.cv-shelf')[0].querySelector('.cv-tile[aria-current="true"]')).toBeTruthy()

    // And once it is back, arrows control the page again.
    await press('ArrowDown')
    await waitFor(() => expect(document.querySelectorAll('.cv-shelf')[1].querySelector('.cv-tile[aria-current="true"]')).toBeTruthy())

    // From the second shelf, Up climbs back to the first rather than jumping
    // straight to the menu — there is still a row above to reach first.
    await press('ArrowUp')
    await waitFor(() => expect(document.querySelectorAll('.cv-shelf')[0].querySelector('.cv-tile[aria-current="true"]')).toBeTruthy())
    expect(document.activeElement?.getAttribute('data-focus-id')).toBe('cv-content')

    // Only from the topmost shelf does Up finally reach the menu.
    await press('ArrowUp')
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Home'))
  })

  it('switches the page live as the main menu is arrowed across, without leaving it', async () => {
    const film = {
      id: 1, type: 'film', title: 'Beta', sortTitle: 'Beta', year: 2024, overview: null,
      posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available', hasFile: true,
      rating: 5, certification: null, studio: null, genres: [], runtime: 100, quality: null,
      addedAt: '2026-01-01', acquiredAt: '2026-01-01', releaseDate: '2026-01-01',
      digitalReleaseDate: null, physicalReleaseDate: null, progress: null,
    }
    const sdk = {
      asset: (path: string | null) => path ?? '',
      series: async () => ({ series: [] }),
      films: async () => ({ films: [film] }),
      seriesShelves: async () => emptyShelves,
      shelfSettings: async () => shelfSettings,
      boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }),
    } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)
    await waitFor(() => expect(document.activeElement?.getAttribute('data-focus-id')).toBe('cv-content'))

    // A remote's Right arrow moves real focus from one menu item to the
    // next — simulated directly here, since jsdom has no real layout for the
    // spatial engine that normally drives it — and landing is what switches
    // the page, the same way the folder strip it replaces always did.
    const filmsLink = screen.getByRole('link', { name: 'Films' })
    filmsLink.focus()
    await waitFor(() => expect(document.querySelector('.cv-shelf[aria-label="All films"]')).toBeTruthy())
    // Landing on a menu item does not dive into the page it opened — only
    // Down does that — so a viewer can keep arrowing past several menu items
    // and see each one before choosing.
    expect(document.activeElement).toBe(filmsLink)
  })

  it('stacks Films\' and Series\' curated rows together on Home, dropping empty ones', async () => {
    const episode = (id: number, seriesTitle: string, season: number, number: number) => ({
      id, type: 'episode', seriesId: id, seasonNumber: season, episodeNumber: number,
      title: `Episode ${number}`, overview: null, airDate: '2026-07-01', airTime: null, airAt: null,
      runtimeSeconds: 2700, stillUrl: null, hasFile: true, status: 'available', quality: null,
      playback: null, seriesTitle, seriesPosterUrl: null, seriesLogoUrl: '/logo.svg',
      progress: null, primaryAction: 'play',
    })
    const sdk = {
      asset: (path: string | null) => path ?? '',
      films: async () => ({ films: [] }),
      series: async () => ({ series: [] }),
      seriesShelves: async () => ({ rows: [
        { id: 'series-next-up', items: [episode(1, 'Harbour Lights', 1, 2)] },
        { id: 'series-recently-added', items: [episode(2, 'Nightjar', 2, 1)] },
        { id: 'series-recently-aired', items: [episode(3, 'Steel Harvest', 3, 4)] },
        { id: 'series-all', items: [] },
      ] }),
      shelfSettings: async () => shelfSettings,
      boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }),
    } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    const view = render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)

    // The main menu is the only navigation now — Home has no type switcher of
    // its own, so Films' (empty) and Series' (populated) rows appear together,
    // with the empty ones simply dropped rather than hidden behind a tab.
    expect(screen.queryByRole('tablist')).toBeNull()
    await waitFor(() => expect(Array.from(view.container.querySelectorAll('.cv-shelf-heading')).map(node => node.textContent))
      .toEqual(['Next Up1 episodes', 'Recently Added1 episodes', 'Recently Aired1 episodes']))
    // The hero names the show — as its logo, since this one has one — and the
    // tile caption names the episode.
    expect(view.container.querySelector('.cv-title-logo')?.getAttribute('alt')).toBe('Harbour Lights')
    expect(Array.from(view.container.querySelectorAll('.cv-lbl')).map(node => node.textContent))
      .toEqual(['S01E02 · Episode 2', 'S02E01 · Episode 1', 'S03E04 · Episode 4'])
    // The line that used to repeat the episode under the hero is gone.
    expect(view.container.querySelector('.cv-epline')).toBeNull()
    // An episode still says nothing about its show, so the landscape tile
    // carries the logo — but only where there is one to carry.
    expect(view.container.querySelectorAll('.cv-tile-logo')).toHaveLength(3)
    expect(view.container.querySelector('.cv-tile-logo')?.getAttribute('src')).toBe('/logo.svg')
  })

  it('honours the operator\'s row order, names, caps and overlap setting', async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
    const film = (id: number, title: string, added: number, released: number) => ({
      id, type: 'film', title, sortTitle: title, year: 2024, overview: null,
      posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available', hasFile: true,
      rating: 7, certification: null, studio: null, genres: [], runtime: 100, quality: null,
      addedAt: iso(added), acquiredAt: iso(added), releaseDate: iso(released),
      digitalReleaseDate: null, physicalReleaseDate: null, progress: null,
    })
    // Both are recent arrivals; only "Brand New" was also released recently.
    const films = [film(1, 'Back Catalogue', 10, 900), film(2, 'Brand New', 12, 20), film(3, 'Also New', 14, 25)]
    const settings = {
      settings: {
        films: {
          enabled: true,
          label: 'Movies',
          rows: [
            // Renamed, reordered, capped at one, and allowed to overlap.
            row('films-recently-released', 'Just Released', { limit: 1, windowField: 'released' }),
            row('films-recently-added', 'Fresh Arrivals', { limit: 5, windowField: 'added' }),
            row('films-all', 'Everything', { enabled: false }),
          ],
        },
        series: { enabled: false, label: 'Series', rows: [row('series-all', 'All series')] },
      },
    }
    const sdk = {
      asset: (path: string | null) => path ?? '',
      films: async () => ({ films }),
      series: async () => ({ series: [] }),
      seriesShelves: async () => emptyShelves,
      shelfSettings: async () => settings,
      boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }),
    } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    const view = render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)

    // Series is switched off, so the type strip collapses to the one type left.
    await waitFor(() => expect(Array.from(view.container.querySelectorAll('.cv-shelf-heading')).map(node => node.textContent))
      .toEqual(['Just Released1 films', 'Fresh Arrivals3 films']))
    expect(screen.queryByRole('tab', { name: 'Series' })).toBeNull()

    const rows = Array.from(view.container.querySelectorAll('.cv-shelf'))
    // The cap holds even though two films qualify as recently released.
    expect(rows[0].querySelectorAll('.cv-tile')).toHaveLength(1)
    // Overlap on: the arrivals row keeps the recently released ones too.
    expect(rows[1].querySelectorAll('.cv-tile')).toHaveLength(3)
  })

  it('excludes a later row\'s items even though it is displayed first', async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
    const film = (id: number, title: string, added: number, released: number) => ({
      id, type: 'film', title, sortTitle: title, year: 2024, overview: null,
      posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available', hasFile: true,
      rating: 7, certification: null, studio: null, genres: ['Drama'], runtime: 100, quality: null,
      addedAt: iso(added), acquiredAt: iso(added), releaseDate: iso(released),
      digitalReleaseDate: null, physicalReleaseDate: null, progress: null,
    })
    // Both arrived recently; only "Brand New" was also released recently.
    const films = [film(1, 'Back Catalogue', 10, 900), film(2, 'Brand New', 12, 20)]
    const settings = {
      settings: {
        films: {
          enabled: true, label: 'Films',
          rows: [
            // Displayed first, but it defers to a row further down the page.
            row('films-recently-added', 'Recently Added', { windowField: 'added', dedupeAgainst: ['films-recently-released'] }),
            row('films-recently-released', 'Recently Released', { windowField: 'released' }),
          ],
        },
        series: { enabled: false, label: 'Series', rows: [] },
      },
    }
    const sdk = {
      asset: (path: string | null) => path ?? '',
      films: async () => ({ films }),
      series: async () => ({ series: [] }),
      seriesShelves: async () => emptyShelves,
      shelfSettings: async () => settings,
      boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }),
    } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    const view = render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)

    await waitFor(() => expect(view.container.querySelectorAll('.cv-shelf')).toHaveLength(2))
    const rows = Array.from(view.container.querySelectorAll('.cv-shelf'))
    // "Brand New" belongs to the released row, so the arrivals row above it
    // shows only the back-catalogue title.
    expect(rows[0].querySelectorAll('.cv-tile')).toHaveLength(1)
    expect(rows[1].querySelectorAll('.cv-tile')).toHaveLength(1)
    expect(rows[0].textContent).toContain('BACK CATALOGUE')
    expect(rows[1].textContent).toContain('BRAND NEW')
  })

  it('runs an operator-added row with its own filters', async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
    const film = (id: number, title: string, genres: string[], rating: number, year: number) => ({
      id, type: 'film', title, sortTitle: title, year, overview: null,
      posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available', hasFile: true,
      rating, certification: null, studio: null, genres, runtime: 100, quality: null,
      addedAt: iso(5), acquiredAt: iso(5), releaseDate: iso(5),
      digitalReleaseDate: null, physicalReleaseDate: null, progress: null,
    })
    const films = [
      film(1, 'Great Horror', ['Horror'], 9, 2001),
      film(2, 'Poor Horror', ['Horror'], 3, 2002),
      film(3, 'Great Drama', ['Drama'], 9, 2003),
      film(4, 'Old Horror', ['Horror'], 9, 1970),
    ]
    const settings = {
      settings: {
        films: {
          enabled: true, label: 'Films',
          rows: [row('custom-row-1', 'Best Modern Horror', {
            genres: ['Horror'], minRating: 8, yearFrom: 2000, sort: 'title', sortOrder: 'asc',
          })],
        },
        series: { enabled: false, label: 'Series', rows: [] },
      },
    }
    const sdk = {
      asset: (path: string | null) => path ?? '',
      films: async () => ({ films }),
      series: async () => ({ series: [] }),
      seriesShelves: async () => emptyShelves,
      shelfSettings: async () => settings,
      boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }),
    } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    const view = render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)

    await waitFor(() => expect(view.container.querySelector('.cv-shelf-heading')?.textContent).toBe('Best Modern Horror1 films'))
    expect(view.container.querySelectorAll('.cv-shelf')).toHaveLength(1)
    const shelf = view.container.querySelector('.cv-shelf')!
    // Genre, rating floor and year floor each exclude one of the four.
    expect(shelf.textContent).toContain('GREAT HORROR')
    expect(shelf.textContent).not.toContain('POOR HORROR')
    expect(shelf.textContent).not.toContain('GREAT DRAMA')
    expect(shelf.textContent).not.toContain('OLD HORROR')
  })

  it('opens a type header onto that type\'s whole library, title-ascending', async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
    const film = (id: number, title: string, rating: number) => ({
      id, type: 'film', title, sortTitle: title, year: 2024, overview: null,
      posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available', hasFile: true,
      rating, certification: null, studio: null, genres: [], runtime: 100, quality: null,
      addedAt: iso(5), acquiredAt: iso(5), releaseDate: iso(5),
      digitalReleaseDate: null, physicalReleaseDate: null, progress: null,
    })
    const films = [film(1, 'Beta', 5), film(2, 'Alpha', 9), film(3, 'Gamma', 7)]
    const sdk = {
      asset: (path: string | null) => path ?? '',
      films: async () => ({ films }),
      series: async () => ({ series: [] }),
      seriesShelves: async () => emptyShelves,
      shelfSettings: async () => shelfSettings,
      boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }),
    } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    const view = render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)

    // Home stacks the curated rows and shows no grid.
    await waitFor(() => expect(view.container.querySelectorAll('.cv-shelf').length).toBeGreaterThan(0))
    expect(view.container.querySelector('.cv-grid')).toBeNull()

    // The main menu opens that type's own page — the same curated rows Home
    // shows for it, not a separate stripped-down "everything" view.
    fireEvent.click(screen.getByRole('link', { name: 'Films' }))
    await waitFor(() => expect(view.container.querySelector('.cv-shelf[aria-label="All films"]')).toBeTruthy())
    expect(view.container.querySelector('.cv-grid')).toBeNull()

    const titles = () => Array.from(view.container.querySelectorAll('.cv-shelf[aria-label="All films"] .cv-tile'))
      .map(tile => tile.getAttribute('aria-label') ?? tile.textContent)
    // Every film, title-ascending — the Player has no sort control of its own.
    expect(titles()).toHaveLength(3)
    expect(view.container.querySelector('.cv-shelf[aria-label="All films"]')?.textContent).toContain('ALPHA')
    // No pill controls above the shelf — the Player doesn't offer any.
    expect(view.container.querySelector('.cv-grid-controls')).toBeNull()
  })

  it('stacks box sets under their media type', async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
    const film = (id: number, title: string) => ({
      id, type: 'film', title, sortTitle: title, year: 1980, overview: null,
      posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available', hasFile: true,
      rating: 8, certification: null, studio: null, genres: [], runtime: 100, quality: null,
      addedAt: iso(5), acquiredAt: iso(5), releaseDate: iso(5),
      digitalReleaseDate: null, physicalReleaseDate: null, progress: null,
    })
    const sdk = {
      asset: (path: string | null) => path ?? '',
      films: async () => ({ films: [film(1, 'The Shining')] }),
      series: async () => ({ series: [] }),
      seriesShelves: async () => emptyShelves,
      shelfSettings: async () => ({
        settings: {
          films: { enabled: true, label: 'Films', rows: [row('films-all', 'All films')] },
          series: { enabled: false, label: 'Series', rows: [] },
        },
      }),
      // The server resolves box sets; the page only nests them.
      boxSets: async () => ({ rowLabel: 'Box Sets', themes: [
        {
          id: 'boxset-directed-by', label: 'Directed by', mediaType: 'films', view: 'landscape',
          imageUrl: null, overview: null,
          sets: [
            { id: 'directed-by-kubrick', label: 'Directed by Stanley Kubrick', imageUrl: null, backdropUrl: null, logoUrl: null, overview: null, items: [film(1, 'The Shining')] },
            { id: 'directed-by-varda', label: 'Directed by Agnès Varda', imageUrl: null, backdropUrl: null, logoUrl: null, overview: null, items: [film(2, 'Cléo')] },
          ],
        },
        {
          id: 'boxset-themes', label: 'Themes', mediaType: 'series', view: 'landscape',
          imageUrl: null, overview: null, sets: [],
        },
      ] }),
    } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    const view = render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)

    // One row of theme tiles after the type's own rows — not a row per set.
    await waitFor(() => expect(Array.from(view.container.querySelectorAll('.cv-shelf-heading')).map(node => node.textContent))
      .toEqual(['All films1 films', 'Box Sets1 items']))
    const boxRow = Array.from(view.container.querySelectorAll('.cv-shelf')).at(-1)!
    expect(boxRow.querySelectorAll('.cv-tile')).toHaveLength(1)
    expect(boxRow.textContent).toContain('DIRECTED BY')
    // Landscape, because the theme asked for it — a folder is a poster by default.
    expect(boxRow.querySelector('.cv-art')?.className).toContain('wide')

    // Opening the theme descends to a tile per director.
    const tile = boxRow.querySelector('.cv-tile') as HTMLElement
    fireEvent.click(tile)
    fireEvent.click(tile)
    await waitFor(() => expect(view.container.querySelector('.cv-row-heading')?.textContent).toContain('Directed by'))
    expect(Array.from(view.container.querySelectorAll('.cv-lbl')).map(node => node.textContent))
      .toEqual(['Directed by Stanley Kubrick', 'Directed by Agnès Varda'])

    // The Films page on its own is the same rows in the same order — its own
    // type's curated rows, not a separate stripped-down "everything" view.
    view.unmount()
    const library = render(<MemoryRouter initialEntries={['/films']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)
    await waitFor(() => expect(library.container.querySelectorAll('.cv-shelf')).toHaveLength(2))
    expect(Array.from(library.container.querySelectorAll('.cv-shelf-heading')).map(node => node.textContent))
      .toEqual(['All films1 films', 'Box Sets1 items'])
    expect(library.container.querySelector('.cv-shelf[aria-label="Box Sets"]')?.textContent).toContain('DIRECTED BY')
    expect(library.container.querySelector('.cv-shelf[aria-label="All films"]')?.textContent).toContain('THE SHINING')
  })

  it('leaves out a row with nothing behind it', async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
    // Added recently, but released long ago — so "Recently Released" is empty.
    const films = [{
      id: 1, type: 'film', title: 'Back Catalogue', sortTitle: 'Back Catalogue', year: 1980, overview: null,
      posterUrl: null, backdropUrl: null, logoUrl: null, status: 'available', hasFile: true,
      rating: 7, certification: null, studio: null, genres: [], runtime: 100, quality: null,
      addedAt: iso(5), acquiredAt: iso(5), releaseDate: iso(900),
      digitalReleaseDate: null, physicalReleaseDate: null, progress: null,
    }]
    const sdk = {
      asset: (path: string | null) => path ?? '',
      films: async () => ({ films }),
      series: async () => ({ series: [] }),
      seriesShelves: async () => emptyShelves,
      shelfSettings: async () => shelfSettings,
      boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }),
    } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    const view = render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)

    await waitFor(() => expect(view.container.querySelectorAll('.cv-shelf').length).toBeGreaterThan(0))
    const headings = Array.from(view.container.querySelectorAll('.cv-shelf-heading')).map(node => node.textContent)
    expect(headings).toEqual(['Recently Added1 films', 'All films1 films'])
    expect(headings.some(heading => heading?.includes('Recently Released'))).toBe(false)
  })

  it('applies retained accessibility changes without exposing appearance customization', async () => {
    const updatePreferences = vi.fn(async (input: Parameters<ArchivistSdk['updatePreferences']>[0]) => ({
      profileId: input.profileId,
      revision: input.expectedRevision + 1,
      updatedAt: '2026-01-02',
      preferences: input.preferences,
    }))
    const sdk = { asset: (path: string | null) => path ?? '', updatePreferences } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    const view = render(<MemoryRouter initialEntries={['/settings']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)

    expect(screen.queryByRole('button', { name: 'Appearance' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Accessibility' }))
    fireEvent.click(screen.getByRole('button', { name: '115%' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText('Settings saved')
    await waitFor(() => expect(view.container.querySelector<HTMLElement>('.player-v2')?.dataset.textScale).toBe('1.15'))
    expect(view.container.querySelector<HTMLElement>('.player-v2')?.dataset.accent).toBeUndefined()
    expect(view.container.querySelector<HTMLElement>('.player-v2')?.getAttribute('style')).toBeNull()
    expect(updatePreferences).toHaveBeenCalledWith(expect.objectContaining({
      preferences: expect.objectContaining({ accessibility: expect.objectContaining({ textScale: 1.15 }) }),
    }))
  })

  it('draws every menu item from the icon pack', () => {
    const sdk = { asset: (path: string | null) => path ?? '', series: async () => ({ series: [] }), films: async () => ({ films: [] }), seriesShelves: async () => emptyShelves, shelfSettings: async () => shelfSettings, boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }) } as unknown as ArchivistSdk
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<MemoryRouter initialEntries={['/settings']}><PlayerShell sdk={sdk} bootstrap={bootstrap} /></MemoryRouter>)
    const navigation = screen.getByRole('navigation', { name: 'Player' })
    const links = Array.from(navigation.querySelectorAll('a'))
    expect(links).toHaveLength(8)
    for (const link of links) {
      expect(link.querySelector('svg[viewBox="0 0 64 64"]')).toBeTruthy()
    }
  })
})

describe('inside the Android TV app', () => {
  afterEach(() => { delete window.__archivistHandlesRootBack })
  const homeSdk = () => ({ asset: (path: string | null) => path ?? '', series: async () => ({ series: [] }), films: async () => ({ films: [] }), seriesShelves: async () => emptyShelves, shelfSettings: async () => shelfSettings, boxSets: async () => ({ rowLabel: 'Box Sets', themes: [] }) }) as unknown as ArchivistSdk

  it('asks before leaving when Back is pressed on Home, in its own dialog', async () => {
    const bridge = { switchServer: vi.fn(), exitApp: vi.fn(), serverInfo: () => JSON.stringify({ name: 'Living Room', url: 'http://192.168.1.10:2424', via: 'home', appVersion: '0.1.0' }) }
    vi.stubGlobal('ArchivistAndroid', bridge)
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={homeSdk()} bootstrap={bootstrap} /></MemoryRouter>)
    expect(window.__archivistHandlesRootBack).toBe(true)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    const dialog = await screen.findByRole('dialog', { name: 'Leave Archivist?' })
    expect(dialog.textContent).toContain('Living Room')
    fireEvent.click(screen.getByRole('button', { name: 'Switch server' }))
    expect(bridge.switchServer).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }))
    expect(bridge.exitApp).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Leave Archivist?' })).toBeNull())
  })

  it('does nothing on Back at Home in a browser', () => {
    playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap })
    render(<MemoryRouter initialEntries={['/']}><PlayerShell sdk={homeSdk()} bootstrap={bootstrap} /></MemoryRouter>)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Leave Archivist?' })).toBeNull()
    expect(window.__archivistHandlesRootBack).toBeUndefined()
  })
})

function viewRoot() {
  const root = document.querySelector<HTMLElement>('.player-v2')
  if (!root) throw new Error('Player root was not rendered')
  return root
}
