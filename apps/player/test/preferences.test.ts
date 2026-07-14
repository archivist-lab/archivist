import { describe, expect, it } from 'vitest'
import type { PlayerPreferencesV1 } from '@archivist/contracts'
import { applyPreset, isPreferencesDirty, migrateLegacySettings } from '../src/lib/preferences.js'

const base = (): PlayerPreferencesV1 => ({
  schemaVersion: 1,
  preset: 'categories',
  navigation: { edgeRail: 'visible', showClock: true },
  home: { widgetMode: 'stacked', showSpotlight: true, widgets: [{ id: 'continue', title: 'Continue Watching', source: 'continue', view: 'landscape', limit: 12, enabled: true }] },
  libraries: { films: { view: 'poster', sort: 'title', hideUnavailable: false }, series: { view: 'poster', sort: 'title', hideUnavailable: false } },
  playback: { normalizeVolume: true, targetLufs: -16, preferredAudioLanguage: null, preferredSubtitleLanguage: null, subtitles: 'forced' },
  accessibility: { reducedMotion: 'system', highContrast: false, textScale: 1 },
  migration: { legacyLocalStorageImported: false },
})

describe('preferences', () => {
  it.each([
    ['classic', 'visible', 'stacked', false],
    ['categories', 'visible', 'stacked', true],
    ['compound', 'minimized', 'stacked', true],
    ['combined', 'minimized', 'combined', true],
  ] as const)('applies the %s preset matrix', (preset, edgeRail, widgetMode, showSpotlight) => {
    const result = applyPreset(base(), preset)
    expect(result).toMatchObject({ preset, navigation: { edgeRail }, home: { widgetMode, showSpotlight } })
  })

  it('imports bounded legacy presentation values but ignores connection credentials', () => {
    const result = migrateLegacySettings({
      connection: { url: 'https://secret.invalid', apiKey: 'secret' },
      rails: [{ id: 'recent', title: ' Recent ', source: 'recent-films', style: 'poster', limit: 13, enabled: true }],
      libraryView: 'wall', hideUnavailable: true, normalizeVolume: false, loudnessTarget: -18,
    }, base())!
    expect(result.home.widgets[0]).toMatchObject({ id: 'recent', title: 'Recent', view: 'poster', limit: 18 })
    expect(result.libraries.films).toMatchObject({ view: 'wall', hideUnavailable: true })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result.migration.legacyLocalStorageImported).toBe(true)
  })

  it('detects complete-document draft changes', () => {
    const saved = base()
    expect(isPreferencesDirty(saved, structuredClone(saved))).toBe(false)
    expect(isPreferencesDirty(saved, { ...saved, accessibility: { ...saved.accessibility, textScale: 1.15 } })).toBe(true)
  })
})
