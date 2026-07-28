import { expect, test, type Page, type Route } from '@playwright/test'

const film = {
  id: 1,
  tmdb_id: 1001,
  imdb_id: 'tt0001001',
  title: 'The Archive',
  original_title: 'The Archive',
  year: 2026,
  overview: 'A meticulous curator discovers that every restored frame changes the history stored around it.',
  runtime: 107,
  genres: ['Drama'],
  poster_path: '/fixture/poster.svg',
  backdrop_path: '/fixture/backdrop.svg',
  logo_path: '/fixture/logo.svg',
  rating: 8.6,
  certification: '15',
  studio: 'Archivist Pictures',
  country: 'GB',
  status: 'collected',
  monitored: true,
  added_at: '2026-07-01T00:00:00Z',
  release_date: '2026-05-14',
  trailerPath: null,
  videos: [],
  cast: [],
  crew: [],
  current_resolution: '2160p',
  current_source: 'WEB',
  current_codec: 'x265',
  current_tier: 1,
  current_edition: 'Restored',
  current_size_bytes: 18400000000,
  current_release_title: 'The.Archive.2026.2160p.WEB.x265-ARCHIVIST',
  file_path: '/library/The Archive (2026)/The Archive.mkv',
  fileInfo: {
    path: '/library/The Archive (2026)/The Archive.mkv',
    filename: 'The Archive.mkv',
    extension: 'mkv',
    size: 18400000000,
    resolution: '2160p',
    codec: 'HEVC',
    audioChannels: '5.1',
    audio: [{ language: 'English', channels: 6, title: 'Main' }],
    subtitles: ['English'],
    chapters: [],
  },
  editions: [],
}

const svg = (from: string, to: string, label: string, portrait = false) => `<svg xmlns="http://www.w3.org/2000/svg" width="${portrait ? 600 : 1600}" height="900" viewBox="0 0 ${portrait ? 600 : 1600} 900"><defs><linearGradient id="g"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="75%" cy="28%" r="180" fill="white" opacity=".12"/><text x="8%" y="82%" fill="white" opacity=".28" font-family="sans-serif" font-size="58">${label}</text></svg>`

async function artwork(route: Route, pathname: string) {
  const portrait = pathname.includes('poster')
  const body = pathname.includes('logo')
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="180"><text x="10" y="125" fill="white" font-family="sans-serif" font-weight="700" font-size="94">THE ARCHIVE</text></svg>'
    : svg('#17132f', pathname.includes('poster') ? '#744782' : '#243e68', pathname.includes('poster') ? 'POSTER' : 'BACKDROP', portrait)
  await route.fulfill({ body, contentType: 'image/svg+xml' })
}

async function mockServer(page: Page) {
  await page.route('**/fixture/*.svg', route => artwork(route, new URL(route.request().url()).pathname))
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/auth/status')) return route.fulfill({ json: { authenticated: true, bootstrapRequired: false, setupRequired: false, username: 'archivist' } })
    if (path.endsWith('/tabs')) return route.fulfill({ json: [{ id: 1, name: 'Main', media_type: 'films', db_path: '/fixture', created_at: '2026-07-01T00:00:00Z' }] })
    if (path.endsWith('/settings/onboarding')) return route.fulfill({ json: { completed: true, enabledMediaTypes: ['films', 'series', 'music', 'books', 'comics', 'games'] } })
    if (path.endsWith('/films/1')) return route.fulfill({ json: film })
    if (path.endsWith('/quality-profiles')) return route.fulfill({ json: [] })
    if (path.endsWith('/events')) return route.fulfill({ status: 204 })
    return route.fulfill({ json: [] })
  })
}

async function contrastOfTokens(page: Page) {
  return page.evaluate(() => {
    const parse = (value: string) => {
      const match = value.match(/[\d.]+/g)?.map(Number) ?? []
      return { r: match[0] ?? 0, g: match[1] ?? 0, b: match[2] ?? 0, a: match[3] ?? 1 }
    }
    const styles = getComputedStyle(document.documentElement)
    const fg = parse(styles.getPropertyValue('--archivist-muted'))
    const bg = parse(styles.getPropertyValue('--archivist-canvas'))
    const mixed = [fg.r, fg.g, fg.b].map((channel, index) => channel * fg.a + [bg.r, bg.g, bg.b][index] * (1 - fg.a))
    const luminance = (rgb: number[]) => rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
    const light = luminance(mixed)
    const dark = luminance([bg.r, bg.g, bg.b])
    return (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05)
  })
}

for (const fixture of [
  { name: '1080p', width: 1920, height: 1080 },
  { name: 'tablet', width: 834, height: 1112 },
]) {
  test('server film detail is composed and accessible at ' + fixture.name, async ({ page }) => {
    await page.setViewportSize({ width: fixture.width, height: fixture.height })
    await mockServer(page)
    await page.goto('/films/1')
    await expect(page.getByRole('heading', { level: 1, name: 'The Archive' })).toHaveCount(1)
    await expect(page.getByText('Overview', { exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    expect(await contrastOfTokens(page)).toBeGreaterThanOrEqual(4.5)

    const edit = page.getByRole('button', { name: 'Edit metadata for The Archive' })
    await edit.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(edit).toBeFocused()
    const focus = await edit.evaluate(element => {
      const style = getComputedStyle(element)
      return { visible: element.matches(':focus-visible'), style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor }
    })
    expect(focus.visible).toBe(true)
    expect(focus.style).not.toBe('none')
    expect(focus.width).toBeGreaterThanOrEqual(1)
    const focusToken = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--archivist-focus').trim())
    expect(focusToken).toBe('#00d4ff')

    await expect(page).toHaveScreenshot('server-film-detail-' + fixture.name + '.png', { animations: 'disabled', maxDiffPixels: 20 })
  })
}
