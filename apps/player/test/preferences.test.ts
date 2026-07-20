import { describe, expect, it } from 'vitest'
import type { PlayerPreferencesV1 } from '@archivist/contracts'
import { applyPreset, isPreferencesDirty, migrateLegacySettings } from '../src/lib/preferences.js'
import { createHubPreference, createWidgetPreference, removeSavedFilterPreference } from '../src/pages/Settings.js'

const base = (): PlayerPreferencesV1 => ({
  schemaVersion: 3,
  preset: 'categories',
  navigation: { edgeRail: 'visible', showClock: true },
  home: { hubs: [{ id: 'home', name: 'Home', icon: '⌂', enabled: true, layout: 'standard', showSpotlight: true, spotlightWidgetId: null, widgets: [{ id: 'continue', title: 'Continue Watching', source: 'continue', view: 'landscape', sort: 'source', sortOrder: 'desc', limit: 12, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true }] }] },
  libraries: { films: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false }, series: { view: 'poster', sort: 'title', sortOrder: 'asc', hideUnavailable: false } },
  browsing: { defaultViews: { films: 'poster', series: 'poster', seasons: 'poster', episodes: 'landscape', collections: 'poster', people: 'poster' }, savedFilters: [] },
  playback: { normalizeVolume: true, targetLufs: -16, preferredAudioLanguage: null, preferredSubtitleLanguage: null, subtitles: 'forced' },
  accessibility: { reducedMotion: 'system', highContrast: false, textScale: 1 },
  migration: { legacyLocalStorageImported: false },
})

describe('preferences', () => {
  it.each([
    ['classic', 'visible', 'standard', false],
    ['categories', 'visible', 'standard', true],
    ['compound', 'minimized', 'standard', true],
    ['combined', 'minimized', 'combined', true],
  ] as const)('applies the %s preset matrix', (preset, edgeRail, layout, showSpotlight) => {
    const result = applyPreset(base(), preset)
    expect(result.preset).toBe(preset)
    expect(result.navigation.edgeRail).toBe(edgeRail)
    expect(result.home.hubs[0]).toMatchObject({ layout, showSpotlight })
  })

  it('imports bounded legacy presentation values but ignores connection credentials', () => {
    const result = migrateLegacySettings({
      connection: { url: 'https://secret.invalid', apiKey: 'secret' },
      rails: [{ id: 'recent', title: ' Recent ', source: 'recent-films', style: 'poster', limit: 13, enabled: true }],
      libraryView: 'wall', hideUnavailable: true, normalizeVolume: false, loudnessTarget: -18,
    }, base())!
    expect(result.home.hubs[0].widgets[0]).toMatchObject({ id: 'recent', title: 'Recent', view: 'poster', sort: 'source', sortOrder: 'desc', limit: 18 })
    expect(result.libraries.films).toMatchObject({ view: 'wall', hideUnavailable: true })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result.migration.legacyLocalStorageImported).toBe(true)
  })

  it('detects complete-document draft changes', () => {
    const saved = base()
    expect(isPreferencesDirty(saved, structuredClone(saved))).toBe(false)
    expect(isPreferencesDirty(saved, { ...saved, accessibility: { ...saved.accessibility, textScale: 1.15 } })).toBe(true)
  })

  it('creates bounded hub and widget defaults with collision-free identifiers', () => {
    const first = createHubPreference(base().home.hubs)
    const second = createHubPreference([...base().home.hubs, first])
    expect([first.id, second.id]).toEqual(['hub-1', 'hub-2'])
    expect(first).toMatchObject({ layout: 'standard', showSpotlight: true, enabled: true })
    const widget = createWidgetPreference(first.widgets)
    expect(widget.id).toBe('widget-1')
    expect(widget).toMatchObject({ source: 'films-az', sort: 'source', sortOrder: 'asc', autoscrollSeconds: 0, enabled: true })
  })

  it('removes pinned saved-filter widgets without leaving an invalid empty hub', () => {
    const value = base()
    value.browsing.savedFilters.push({ id: 'drama', name: 'Drama', mediaType: 'films', filters: { query: '', genres: ['Drama'], yearFrom: null, yearTo: null, studios: [], ratingMin: null, availability: 'all', watched: 'all', alphabet: null, collectionId: null }, view: 'poster', sort: 'title', sortOrder: 'asc' })
    value.home.hubs[0].widgets = [{ ...value.home.hubs[0].widgets[0], id: 'drama', source: 'saved-filter', savedFilterId: 'drama' }]
    const result = removeSavedFilterPreference(value, 'drama')
    expect(result.browsing.savedFilters).toEqual([])
    expect(result.home.hubs[0].widgets).toHaveLength(1)
    expect(result.home.hubs[0].widgets[0]).toMatchObject({ source: 'films-az', savedFilterId: null, enabled: true })
  })
})
