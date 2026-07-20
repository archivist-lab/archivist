import { expect, test, type Page, type Route } from '@playwright/test'

type HubLayout = 'standard' | 'combined' | 'wall'

const card = (index: number) => ({
  key: `film:${index}`, mediaType: 'film', id: index, route: `/film/${index}`, title: ['Midnight Archive', 'Signal Fire', 'Northbound', 'Paper Moons', 'The Long Room', 'Afterlight'][index - 1],
  subtitle: `202${index} · Drama`, plot: 'A carefully composed fixture used to protect the living-room hub presentation.', year: 2020 + index,
  posterUrl: `/fixture/poster-${index}.svg`, landscapeUrl: `/fixture/backdrop-${index}.svg`, backdropUrl: `/fixture/backdrop-${index}.svg`, logoUrl: index === 1 ? '/fixture/logo.svg' : null,
  progress: index === 2 ? { percent: 42, positionSeconds: 1800, durationSeconds: 4200, updatedAt: '2026-07-18' } : null,
  badges: [{ label: '4K', tone: 'neutral' }, { label: 'HDR', tone: 'neutral' }], available: true, primaryAction: index === 2 ? 'resume' : 'play',
})

const items = Array.from({ length: 6 }, (_, index) => card(index + 1))

function fixture(layout: HubLayout) {
  const widgets = layout === 'combined'
    ? [
        { id: 'films', title: 'New films', source: 'recent-films', view: 'poster', sort: 'source', sortOrder: 'desc', autoscrollSeconds: 0, items, nextCursor: null, total: 6, showMoreRoute: '/films' },
        { id: 'series', title: 'Series', source: 'series-az', view: 'poster', sort: 'title', sortOrder: 'asc', autoscrollSeconds: 0, items: items.slice(0, 4), nextCursor: null, total: 4, showMoreRoute: '/series' },
      ]
    : [{ id: 'films', title: layout === 'wall' ? 'The collection' : 'Recently added', source: 'recent-films', view: 'poster', sort: 'source', sortOrder: 'desc', autoscrollSeconds: 0, items, nextCursor: null, total: 6, showMoreRoute: '/films' }]
  const hub = {
    id: 'home', title: layout === 'wall' ? 'Library Wall' : 'Home', icon: 'H', layout, showSpotlight: layout !== 'wall', spotlight: items[0],
    categories: layout === 'combined' ? [{ id: 'films', label: 'New films', active: true }, { id: 'series', label: 'Series', active: false }] : [], widgets,
  }
  const preferences = {
    schemaVersion: 4, preset: layout === 'combined' ? 'combined' : 'categories', navigation: { edgeRail: 'minimized', showClock: false },
    home: { hubs: [{ id: 'home', name: hub.title, icon: 'H', enabled: true, layout, showSpotlight: hub.showSpotlight, spotlightWidgetId: null, widgets: widgets.map(widget => ({ id: widget.id, title: widget.title, source: widget.source, view: widget.view, sort: widget.sort, sortOrder: widget.sortOrder, limit: 12, autoscrollSeconds: 0, savedFilterId: null, enabled: true })) }] },
    libraries: { films: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false }, series: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false } },
    browsing: { defaultViews: { films: 'poster', series: 'poster', seasons: 'poster', episodes: 'landscape', collections: 'poster', people: 'poster' }, savedFilters: [] },
    playback: { normalizeVolume: false, targetLufs: -16, preferredAudioLanguage: null, preferredSubtitleLanguage: null, subtitles: 'forced', osdTimeoutSeconds: 3, pauseBehavior: 'after-delay', timeDisplay: 'elapsed-total', stillWatchingMinutes: 0 },
    appearance: { accentColor: '#a78bfa', artworkBlur: 0, dialogTint: 'artwork', backdropCycleSeconds: 0 },
    details: { rows: ['cast', 'crew', 'collection', 'gallery', 'recommendations', 'seasons', 'episodes'], ratingSlots: ['tmdb', 'imdb'], primaryActions: ['play', 'trailer', 'mark-watched', 'information'] },
    accessibility: { reducedMotion: 'off', highContrast: false, textScale: 1 }, migration: { legacyLocalStorageImported: true },
  }
  return { server: { status: 'ok', serverName: 'Archivist', version: '2', capabilities: {} }, featureFlags: { uiV2Enabled: true, telemetryEnabled: false }, configuration: { defaultPreset: 'categories', maxWidgetItems: 36 }, preferences: { profileId: 'default', revision: 1, updatedAt: '2026-07-18', preferences }, libraries: [], progress: [], initialHub: hub }
}

const svg = (path: string) => {
  const portrait = path.includes('poster')
  const palette = Number(path.match(/\d+/)?.[0] ?? 1) % 3
  const colors = [['#352a5f', '#8f5f91'], ['#123a4e', '#3a7b73'], ['#4b253b', '#9a5c52']][palette]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? 600 : 1600}" height="900"><defs><linearGradient id="g"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="70%" cy="28%" r="160" fill="white" opacity=".1"/><path d="M0 760 Q300 590 650 770 T1600 700 V900 H0Z" fill="black" opacity=".24"/></svg>`
}

async function mockHub(page: Page, layout: HubLayout) {
  await page.route('**/fixture/*.svg', async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    const body = path.includes('logo') ? '<svg xmlns="http://www.w3.org/2000/svg" width="740" height="170"><text x="8" y="118" fill="white" font-family="sans-serif" font-weight="700" font-size="82">MIDNIGHT ARCHIVE</text></svg>' : svg(path)
    await route.fulfill({ body, contentType: 'image/svg+xml' })
  })
  await page.route('**/api/v1/player/**', route => new URL(route.request().url()).pathname.endsWith('/ui/bootstrap') ? route.fulfill({ json: fixture(layout) }) : route.fulfill({ status: 204 }))
}

test.describe('hub composition visual regression', () => {
  test.use({ viewport: { width: 1920, height: 1080 }, colorScheme: 'dark' })

  test('canonical server-mirror composition', async ({ page }) => {
    await mockHub(page, 'standard')
    await page.goto('/')
    const root = page.locator('[data-hub-layout="standard"]')
    await expect(root).toBeVisible()
    await expect(page.locator('[data-hub-layout="combined"], [data-hub-layout="wall"]')).toHaveCount(0)
    await root.locator('.player-card').first().focus()
    await expect(page.locator('.player-v2')).toHaveScreenshot('hub-standard-1080p.png', { animations: 'disabled' })
    await page.setViewportSize({ width: 3840, height: 2160 })
    await expect(page.locator('.player-v2')).toHaveScreenshot('hub-standard-4k.png', { animations: 'disabled' })
  })
})
