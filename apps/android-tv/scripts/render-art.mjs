// Renders the launcher icons and the Android TV / Fire TV banner from the
// Archivist icon and wordmark, with the real fonts, using the Playwright
// Chromium the Player's e2e tests already install. Output is committed; rerun
// after changing the art:  node scripts/render-art.mjs
//
// Chromium needs a working fontconfig to decode web fonts; on a bare host
// without one the banner renders with its text missing (FontFace status
// "error").
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const require = createRequire(resolve(repo, 'apps/player/package.json'))
const { chromium } = require('@playwright/test')

const res = resolve(here, '../app/src/main/res')
const icon = readFileSync(resolve(repo, 'client/src/icon.svg'), 'utf8')
const bebas = readFileSync(require.resolve('@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2'))

const iconPage = size => `<!doctype html><html><body style="margin:0;background:transparent">
  <div style="width:${size}px;height:${size}px;border-radius:${size * 0.22}px;overflow:hidden;
    background:radial-gradient(circle at 50% 30%,#1b152b,#07070a 70%);display:grid;place-items:center">
    <div style="width:${size * 0.86}px;height:${size * 0.86}px">${icon.replace('width="200" height="200"', 'width="100%" height="100%"')}</div>
  </div></body></html>`

const bannerPage = `<!doctype html><html><head><style>
  @font-face { font-family: 'Bebas Neue'; src: url('/bebas.woff2') format('woff2'); }
  body { margin: 0; }
  .b { width: 320px; height: 180px; box-sizing: border-box; display: flex; align-items: center; gap: 12px; padding: 0 16px 0 16px;
       background: radial-gradient(circle at 30% 35%, #1b152b, #07070a 70%); font-family: 'Bebas Neue'; }
  .i { width: 100px; height: 100px; flex: none; }
  h1, h2 { margin: 0; font-weight: 400; line-height: .9; letter-spacing: .055em; }
  h1 { color: #f4f4f6; font-size: 42px; }
  h2 { color: #00d4ff; font-size: 22px; text-shadow: 0 0 14px rgba(0,212,255,.45); }
</style></head><body><div class="b"><div class="i">${icon.replace('width="200" height="200"', 'width="100%" height="100%"')}</div>
  <div><h1>Archivist</h1><h2>Player</h2></div></div></body></html>`

const browser = await chromium.launch()
const page = await browser.newPage()
for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
  const dir = resolve(res, `mipmap-${density}`)
  mkdirSync(dir, { recursive: true })
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(iconPage(size))
  await page.screenshot({ path: resolve(dir, 'ic_launcher.png'), omitBackground: true })
}
for (const [density, scale] of Object.entries({ xhdpi: 1, xxhdpi: 1.5 })) {
  const dir = resolve(res, `drawable-${density}`)
  mkdirSync(dir, { recursive: true })
  const banner = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: scale })
  // The page and its font are served from memory under a throwaway origin.
  await banner.route('http://art.invalid/**', route => route.request().url().endsWith('.woff2')
    ? route.fulfill({ body: bebas, contentType: 'font/woff2' })
    : route.fulfill({ body: bannerPage, contentType: 'text/html' }))
  await banner.goto('http://art.invalid/banner.html')
  await banner.waitForFunction(() => document.fonts.check("42px 'Bebas Neue'"))
  await banner.screenshot({ path: resolve(dir, 'banner.png') })
  await banner.close()
}
await browser.close()
console.log('Rendered launcher icons and banner into', res)
