import { expect, test, type Page } from '@playwright/test'

const preferences = {
  schemaVersion: 3, preset: 'categories', navigation: { edgeRail: 'visible', showClock: false },
  home: { hubs: [{ id: 'home', name: 'Home', icon: '⌂', enabled: true, layout: 'standard', showSpotlight: true, spotlightWidgetId: null, widgets: [{ id: 'films', title: 'Films', source: 'recent-films', view: 'poster', sort: 'source', sortOrder: 'desc', limit: 12, autoscrollSeconds: 0, savedFilterId: null, enabled: true }] }] },
  libraries: { films: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false }, series: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false } },
  browsing: { defaultViews: { films: 'poster', series: 'poster', seasons: 'poster', episodes: 'landscape', collections: 'poster', people: 'poster' }, savedFilters: [] },
  playback: { normalizeVolume: false, targetLufs: -16, preferredAudioLanguage: null, preferredSubtitleLanguage: null, subtitles: 'forced' },
  accessibility: { reducedMotion: 'off', highContrast: false, textScale: 1 }, migration: { legacyLocalStorageImported: true },
} as const

const film = {
  id: 1, type: 'film', libraryId: 1, title: 'Synthetic Film', sortTitle: 'Synthetic Film', year: 2026, overview: 'An original test fixture.',
  posterUrl: null, backdropUrl: null, logoUrl: null, runtimeSeconds: 600, rating: 8, certification: 'PG', genres: ['Drama'], status: 'available', hasFile: true,
  quality: { resolution: '1080p', source: 'WEB', codec: 'x265', tier: 1 }, addedAt: '2026-01-01', acquiredAt: '2026-01-01',
  playback: { directPlay: true, streamUrl: '/api/v1/player/stream/films/1' }, progress: null, primaryAction: 'play', displayMetadata: { primary: ['2026'], technical: ['1080p'] },
} as const
const card = { key: 'film:1', mediaType: 'film', id: 1, route: '/film/1', title: film.title, subtitle: '2026', plot: film.overview, year: 2026, posterUrl: null, landscapeUrl: null, backdropUrl: null, logoUrl: null, progress: null, badges: [], available: true, primaryAction: 'play' }
const hub = { id: 'home', title: 'Home', icon: '⌂', layout: 'standard', showSpotlight: true, categories: [], spotlight: card, widgets: [{ id: 'films', title: 'Films', source: 'recent-films', view: 'poster', sort: 'source', sortOrder: 'desc', autoscrollSeconds: 0, items: [card], nextCursor: null, total: 1, showMoreRoute: '/films' }] }

async function focused(page: Page) {
  return page.evaluate(() => ({ id: (document.activeElement as HTMLElement | null)?.dataset.focusId ?? '', label: document.activeElement?.getAttribute('aria-label') ?? '', text: (document.activeElement?.textContent ?? '').trim() }))
}
async function press(page: Page, key: string) { await page.keyboard.press(key); await page.waitForTimeout(80) }
async function moveUntil(page: Page, predicate: (value: { id: string; label: string; text: string }) => boolean, keys: string[]) {
  for (let index = 0; index < 30; index++) {
    const value = await focused(page); if (predicate(value)) return value
    await press(page, keys[index % keys.length])
  }
  const targets = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-focus-id]')).map(element => {
    const rect = element.getBoundingClientRect()
    return { id: element.dataset.focusId, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
  }))
  throw new Error(`Could not reach requested focus target; focused=${JSON.stringify(await focused(page))} targets=${JSON.stringify(targets)}`)
}

test('remote-only Home, film, OSD, Back, and Settings journey', async ({ page }) => {
  const unhandled: string[] = []
  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.addInitScript(() => {
    const setAttribute = Element.prototype.setAttribute
    Element.prototype.setAttribute = function (name: string, value: string) {
      if (this instanceof HTMLMediaElement && name.toLowerCase() === 'src') { this.dataset.fixtureSrc = value; return }
      setAttribute.call(this, name, value)
    }
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => 600 })
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return this.dataset.playing !== 'true' } })
    HTMLMediaElement.prototype.play = async function () { this.dataset.playing = 'true'; this.dispatchEvent(new Event('play')) }
    HTMLMediaElement.prototype.pause = function () { this.dataset.playing = 'false'; this.dispatchEvent(new Event('pause')) }
  })
  await page.route('**/api/v1/player/**', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path.endsWith('/ui/bootstrap')) return route.fulfill({ json: { server: { status: 'ok', serverName: 'Archivist', version: '2', capabilities: {} }, featureFlags: { uiV2Enabled: true, telemetryEnabled: false }, configuration: { defaultPreset: 'categories', maxWidgetItems: 36 }, preferences: { profileId: 'default', revision: 1, updatedAt: '2026-01-01', preferences }, libraries: [], progress: [], initialHub: hub } })
    if (path.endsWith('/films/1')) return route.fulfill({ json: { ...film, originalTitle: null, studio: null, country: null, releaseDate: null, cast: [], crew: [] } })
    if (path.endsWith('/stream/films/1/tracks')) return route.fulfill({ json: { container: 'mp4', durationSec: 600, video: { codec: 'h264', profile: null, pixFmt: 'yuv420p', browserFriendly: true }, audio: [], subtitles: [], directPlayable: true, loudness: null, targetLufs: -16 } })
    if (path.endsWith('/bookmarks/film/1')) return route.fulfill({ json: { bookmarks: [] } })
    if (path.endsWith('/progress') && route.request().method() === 'POST') return route.fulfill({ status: 204 })
    if (path.endsWith('/stream/films/1')) return route.fulfill({ status: 200, contentType: 'video/mp4', body: '' })
    unhandled.push(`${route.request().method()} ${path}`); return route.fulfill({ status: 404, json: { error: { code: 'TEST_UNHANDLED', message: 'Unhandled fixture', requestId: 'test' } } })
  })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: 'Player' }), `body=${await page.locator('body').innerText()} errors=${browserErrors.join(' | ')}`).toBeVisible()
  await moveUntil(page, value => value.id === 'card-film:1' || value.text === 'View', ['ArrowRight'])
  await press(page, 'Enter')
  await expect(page).toHaveURL(/\/film\/1$/)
  await moveUntil(page, value => /play/i.test(value.text), ['ArrowRight', 'ArrowDown'])
  await press(page, 'Enter')
  await expect(page.locator('[data-osd-control="true"][aria-label="Play"]')).toBeVisible()
  await press(page, 'a')
  await expect(page.getByRole('dialog', { name: 'audio options' })).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByRole('dialog', { name: 'audio options' })).toHaveCount(0)
  await press(page, 'Escape')
  await expect(page.getByRole('button', { name: /Play|Resume/ })).toBeFocused()
  await press(page, 'Escape')
  await expect(page).toHaveURL(/\/$/)
  await press(page, 'ArrowLeft')
  await moveUntil(page, value => value.label === 'Settings', ['ArrowDown'])
  await press(page, 'Enter')
  await expect(page).toHaveURL(/\/settings$/)
  await press(page, 'ArrowRight')
  await press(page, 'ArrowDown')
  await moveUntil(page, value => value.text === 'Reset', ['ArrowRight', 'ArrowDown'])
  await press(page, 'Enter')
  await expect(page.getByRole('dialog', { name: 'Reset Player settings?' })).toBeVisible()
  await press(page, 'Escape')
  await expect(page.getByRole('dialog', { name: 'Reset Player settings?' })).toHaveCount(0)
  expect(unhandled).toEqual([])
})
