import { expect, test, type Page, type Route } from '@playwright/test'

const preferences = {
  schemaVersion: 4, preset: 'categories', navigation: { edgeRail: 'visible', showClock: false },
  home: { hubs: [{ id: 'home', name: 'Home', icon: 'H', enabled: true, layout: 'standard', showSpotlight: true, spotlightWidgetId: null, widgets: [{ id: 'films', title: 'Films', source: 'recent-films', view: 'poster', sort: 'source', sortOrder: 'desc', limit: 12, autoscrollSeconds: 0, savedFilterId: null, enabled: true }] }] },
  libraries: { films: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false }, series: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false } },
  browsing: { defaultViews: { films: 'poster', series: 'poster', seasons: 'poster', episodes: 'landscape', collections: 'poster', people: 'poster' }, savedFilters: [] },
  playback: { normalizeVolume: false, targetLufs: -16, preferredAudioLanguage: null, preferredSubtitleLanguage: null, subtitles: 'forced', osdTimeoutSeconds: 3, pauseBehavior: 'after-delay', timeDisplay: 'elapsed-total', stillWatchingMinutes: 0 },
  appearance: { accentColor: '#a78bfa', artworkBlur: 0, dialogTint: 'artwork', backdropCycleSeconds: 0 },
  details: { rows: ['cast','crew','collection','gallery','recommendations','seasons','episodes'], ratingSlots: ['tmdb','imdb'], primaryActions: ['play','trailer','mark-watched','information'] },
  accessibility: { reducedMotion: 'off', highContrast: false, textScale: 1 }, migration: { legacyLocalStorageImported: true },
} as const

const emptyHub = { id: 'home', title: 'Home', icon: 'H', layout: 'standard', showSpotlight: false, categories: [], spotlight: null, widgets: [] }
const bootstrap = { server: { status: 'ok', serverName: 'Archivist', version: '2', capabilities: {} }, featureFlags: { uiV2Enabled: true, telemetryEnabled: false }, configuration: { defaultPreset: 'categories', maxWidgetItems: 36 }, preferences: { profileId: 'default', revision: 1, updatedAt: '2026-07-18', preferences }, libraries: [], progress: [], initialHub: emptyHub }

const svg = (from: string, to: string, label: string, portrait = false) => `<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? 600 : 1600}" height="${portrait ? 900 : 900}" viewBox="0 0 ${portrait ? 600 : 1600} 900"><defs><linearGradient id="g"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="75%" cy="28%" r="180" fill="white" opacity=".12"/><text x="8%" y="82%" fill="white" opacity=".28" font-family="sans-serif" font-size="58">${label}</text></svg>`

async function artwork(route: Route, pathname: string) {
  const portrait = pathname.includes('poster')
  const body = pathname.includes('logo')
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="180"><text x="10" y="125" fill="white" font-family="sans-serif" font-weight="700" font-size="94">THE ARCHIVE</text></svg>'
    : svg(pathname.includes('still') ? '#25204b' : '#17132f', pathname.includes('poster') ? '#744782' : '#243e68', pathname.includes('poster') ? 'POSTER' : 'BACKDROP', portrait)
  await route.fulfill({ body, contentType: 'image/svg+xml' })
}

async function mockPlayer(page: Page, detail: unknown, detailPath: string) {
  await page.route('**/fixture/*.svg', route => artwork(route, new URL(route.request().url()).pathname))
  await page.route('**/api/v1/player/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/ui/bootstrap')) return route.fulfill({ json: bootstrap })
    if (path.endsWith(detailPath)) return route.fulfill({ json: detail })
    if (path.includes('/tracks')) return route.fulfill({ json: { container: 'matroska', durationSec: 6420, video: { codec: 'hevc', profile: 'Main 10', pixFmt: 'yuv420p10le', browserFriendly: false }, audio: [], subtitles: [], directPlayable: false, loudness: null, targetLufs: -16, chapters: [] } })
    return route.fulfill({ status: 204 })
  })
}

test.describe('detail visual regression', () => {
  test.use({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark' })

  test('artwork-rich film detail', async ({ page }) => {
    const film = {
      id: 1, type: 'film', libraryId: 1, title: 'The Archive', originalTitle: null, sortTitle: 'Archive', year: 2026,
      overview: 'A meticulous curator discovers that every restored frame changes the history stored around it.', posterUrl: '/fixture/poster.svg', backdropUrl: '/fixture/backdrop.svg', logoUrl: '/fixture/logo.svg', artworkUrls: ['/fixture/backdrop.svg'],
      runtimeSeconds: 6420, rating: 8.6, ratings: [{ provider: 'tmdb', value: 8.6 }, { provider: 'imdb', value: 8.2 }], certification: '15', genres: ['Drama'], studio: 'Archivist Pictures', country: 'GB', releaseDate: '2026-05-14', status: 'available', hasFile: true,
      quality: { resolution: '2160p', source: 'WEB', codec: 'x265', tier: 1 }, addedAt: '2026-07-01', acquiredAt: '2026-07-01', trailerUrl: null,
      playback: { directPlay: false, streamUrl: '/api/v1/player/stream/films/1' }, progress: null, primaryAction: 'play', displayMetadata: { primary: ['2026'], technical: ['2160p'] },
      cast: [], crew: [], recommendations: [], collection: null, editions: [], file: { edition: 'Restored', resolution: '2160p', videoCodec: 'HEVC', sizeBytes: 18400000000 },
    }
    await mockPlayer(page, film, '/films/1')
    await page.goto('/film/1')
    await expect(page.getByAltText('The Archive')).toBeVisible()
    await expect(page.locator('.player-v2')).toHaveScreenshot('film-detail-artwork-1080p.png', { animations: 'disabled' })
    await page.setViewportSize({ width: 3840, height: 2160 })
    await expect(page.locator('.player-v2')).toHaveScreenshot('film-detail-artwork-4k.png', { animations: 'disabled' })
  })

  test('missing-art series and episode dialog', async ({ page }) => {
    const episode = { id: 11, type: 'episode', seriesId: 2, seasonNumber: 1, episodeNumber: 1, title: 'A Beginning Without Pictures', overview: 'The layout must remain composed even when every optional image is unavailable.', airDate: '2026-07-18', airAt: '2026-07-18T18:00:00Z', runtimeSeconds: 2700, stillUrl: null, hasFile: true, status: 'available', quality: { resolution: '1080p', source: 'WEB', codec: 'x265', tier: 1 }, playback: { directPlay: true, streamUrl: '/api/v1/player/stream/episodes/11' }, progress: null }
    const series = { id: 2, type: 'series', libraryId: 2, title: 'Negative Space', sortTitle: 'Negative Space', year: 2026, overview: 'A visual regression fixture deliberately containing no poster, logo, backdrop or episode still.', posterUrl: null, backdropUrl: null, logoUrl: null, artworkUrls: [], network: 'Archive', seriesStatus: 'Continuing', rating: 8, ratings: [{ provider: 'tmdb', value: 8 }], certification: 'TV-14', genres: ['Drama'], episodeCount: 1, availableEpisodeCount: 1, status: 'available', addedAt: '2026-07-01', cast: [], crew: [], recommendations: [], trailerUrl: null, seasons: [{ id: 21, seasonNumber: 1, title: 'Season 1', overview: 'A season synopsis remains readable without supporting artwork.', posterUrl: null, episodes: [episode] }], nextAvailable: episode, primaryAction: 'play' }
    await mockPlayer(page, series, '/series/2')
    await page.goto('/series/2')
    const row = page.getByRole('button', { name: 'S01E01 A Beginning Without Pictures' })
    await expect(row).toBeVisible()
    await expect(page.locator('.player-v2')).toHaveScreenshot('series-detail-season-1080p.png', { animations: 'disabled' })
    await page.setViewportSize({ width: 3840, height: 2160 })
    await expect(page.locator('.player-v2')).toHaveScreenshot('series-detail-season-4k.png', { animations: 'disabled' })
    await page.setViewportSize({ width: 1920, height: 1080 })
    await row.click()
    await expect(page.getByRole('dialog', { name: 'A Beginning Without Pictures' })).toBeVisible()
    await expect(page.locator('.player-v2')).toHaveScreenshot('episode-dialog-missing-art-1080p.png', { animations: 'disabled' })
    await page.setViewportSize({ width: 3840, height: 2160 })
    await expect(page.locator('.player-v2')).toHaveScreenshot('episode-dialog-missing-art-4k.png', { animations: 'disabled' })
  })
})
