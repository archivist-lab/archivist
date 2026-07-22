import type { PlayerPreferencesV1, PlayerPreset, PlayerWidgetLimit, PlayerWidgetPreference } from '@archivist/contracts'

const LEGACY_KEY = 'archivist-player-settings'
const LIMITS: PlayerWidgetLimit[] = [6, 12, 18, 24, 36, 60]

export function readLegacySettings(): unknown | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function clearLegacySettingsAfterImport(): void {
  localStorage.removeItem(LEGACY_KEY)
}

function limit(value: unknown): PlayerWidgetLimit {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 12
  return LIMITS.find(candidate => candidate >= numeric) ?? 60
}

export function migrateLegacySettings(input: unknown, base: PlayerPreferencesV1): PlayerPreferencesV1 | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const legacy = input as Record<string, unknown>
  const rails = Array.isArray(legacy.rails) ? legacy.rails : null
  const widgets: PlayerWidgetPreference[] = rails?.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const rail = raw as Record<string, unknown>
    const sources = new Set(['continue', 'recommendations', 'recent-films', 'recent-episodes', 'downloading', 'unwatched-films', 'films-az', 'series-az'])
    if (!sources.has(String(rail.source))) return []
    const source = String(rail.source) as PlayerWidgetPreference['source']
    return [{
      id: typeof rail.id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(rail.id) ? rail.id : `legacy-${index + 1}`,
      title: typeof rail.title === 'string' && rail.title.trim() ? [...rail.title.trim()].slice(0, 48).join('') : 'Widget',
      source,
      view: rail.style === 'poster' ? 'poster' : 'landscape',
      sort: 'source',
      sortOrder: ['continue', 'recent-films', 'recent-episodes', 'downloading'].includes(source) ? 'desc' : 'asc',
      limit: limit(rail.limit),
      autoscrollSeconds: 0,
      savedFilterId: null,
      downloadMediaTypes: source === 'downloading' ? ['films', 'series'] : [],
      enabled: rail.enabled !== false,
    }]
  }) ?? []
  const homeHub = base.home.hubs.find(hub => hub.id === 'home') ?? base.home.hubs[0]
  return {
    ...structuredClone(base),
    home: {
      hubs: base.home.hubs.map(hub => hub.id === homeHub.id
        ? { ...hub, widgets: widgets.some(widget => widget.enabled) ? widgets : hub.widgets }
        : hub),
    },
    libraries: {
      films: { ...base.libraries.films, view: ['poster', 'wall', 'list'].includes(String(legacy.libraryView)) ? legacy.libraryView as any : base.libraries.films.view, hideUnavailable: typeof legacy.hideUnavailable === 'boolean' ? legacy.hideUnavailable : base.libraries.films.hideUnavailable },
      series: { ...base.libraries.series, view: ['poster', 'wall', 'list'].includes(String(legacy.libraryView)) ? legacy.libraryView as any : base.libraries.series.view, hideUnavailable: typeof legacy.hideUnavailable === 'boolean' ? legacy.hideUnavailable : base.libraries.series.hideUnavailable },
    },
    playback: {
      ...base.playback,
      normalizeVolume: typeof legacy.normalizeVolume === 'boolean' ? legacy.normalizeVolume : base.playback.normalizeVolume,
      targetLufs: [-14, -16, -18, -23].includes(Number(legacy.loudnessTarget)) ? legacy.loudnessTarget as any : base.playback.targetLufs,
    },
    migration: { legacyLocalStorageImported: true },
  }
}

export function applyPreset(current: PlayerPreferencesV1, preset: PlayerPreset): PlayerPreferencesV1 {
  const matrix = {
    classic: { edgeRail: 'visible' as const, layout: 'standard' as const, showSpotlight: false },
    categories: { edgeRail: 'visible' as const, layout: 'standard' as const, showSpotlight: true },
    compound: { edgeRail: 'minimized' as const, layout: 'standard' as const, showSpotlight: true },
    combined: { edgeRail: 'minimized' as const, layout: 'combined' as const, showSpotlight: true },
  }[preset]
  return {
    ...structuredClone(current),
    preset,
    navigation: { ...current.navigation, edgeRail: matrix.edgeRail },
    home: { hubs: current.home.hubs.map(hub => hub.id === 'home' ? { ...hub, layout: matrix.layout, showSpotlight: matrix.showSpotlight } : hub) },
  }
}

export function isPreferencesDirty(saved: PlayerPreferencesV1, draft: PlayerPreferencesV1): boolean {
  return JSON.stringify(saved) !== JSON.stringify(draft)
}
