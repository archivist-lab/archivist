import type { PlayerPreset, PlayerPublicConfiguration } from '@archivist/contracts'

export interface PlayerServerConfig {
  uiV2Enabled: boolean
  defaultPreset: PlayerPreset
  maxWidgetItems: number
  telemetryEnabled: boolean
  public: PlayerPublicConfiguration
}

export class PlayerConfigError extends Error {
  constructor(public readonly key: string, message: string) {
    super(`${key}: ${message}`)
    this.name = 'PlayerConfigError'
  }
}

const PRESETS = new Set<PlayerPreset>(['classic', 'categories', 'compound', 'combined'])

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw == null || raw === '') return fallback
  const value = raw.toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  throw new PlayerConfigError(key, 'must be true or false')
}

export function getPlayerConfig(env: NodeJS.ProcessEnv): Readonly<PlayerServerConfig> {
  const presetRaw = (env.PLAYER_UI_DEFAULT_PRESET || 'categories').toLowerCase()
  if (!PRESETS.has(presetRaw as PlayerPreset)) {
    throw new PlayerConfigError('PLAYER_UI_DEFAULT_PRESET', 'must be classic, categories, compound, or combined')
  }
  const maxRaw = env.PLAYER_UI_MAX_WIDGET_ITEMS || '36'
  if (!/^\d+$/.test(maxRaw)) throw new PlayerConfigError('PLAYER_UI_MAX_WIDGET_ITEMS', 'must be an integer from 12 to 60')
  const maxWidgetItems = Number(maxRaw)
  if (maxWidgetItems < 12 || maxWidgetItems > 60) {
    throw new PlayerConfigError('PLAYER_UI_MAX_WIDGET_ITEMS', 'must be an integer from 12 to 60')
  }
  const defaultPreset = presetRaw as PlayerPreset
  return Object.freeze({
    uiV2Enabled: bool(env, 'PLAYER_UI_V2_ENABLED', true),
    defaultPreset,
    maxWidgetItems,
    telemetryEnabled: bool(env, 'PLAYER_UI_TELEMETRY_ENABLED', false),
    public: Object.freeze({ defaultPreset, maxWidgetItems }),
  })
}
