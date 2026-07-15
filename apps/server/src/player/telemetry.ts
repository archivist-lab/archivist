import type {
  PlayerMetricAggregate,
  PlayerMetricSnapshot,
  PlayerTelemetryBatch,
  PlayerTelemetryName,
} from '@archivist/contracts'
import { createLogger } from '@archivist/core'

const logger = createLogger('PlayerTelemetry')
const startedAt = new Date().toISOString()
const approved = new Set<PlayerTelemetryName>([
  'player_bootstrap_ms', 'player_shell_ready_ms', 'player_hub_ready_ms', 'player_focus_move_ms',
  'player_backdrop_ready_ms', 'player_osd_open_ms', 'player_playback_start_ms', 'player_probe_ms',
  'player_transcode_start_ms', 'player_preference_save_ms', 'player_api_error_count',
  'player_preference_conflict_count',
])
const bucketMap: Record<PlayerTelemetryName, number[]> = {
  player_bootstrap_ms: [50, 100, 250, 500, 1000, 2000, 5000],
  player_shell_ready_ms: [50, 100, 250, 500, 1000, 2000, 5000],
  player_hub_ready_ms: [50, 100, 250, 500, 800, 1500, 3000],
  player_focus_move_ms: [1, 2, 4, 8, 16, 32, 64],
  player_backdrop_ready_ms: [16, 32, 64, 128, 300, 600, 1200],
  player_osd_open_ms: [4, 8, 16, 32, 50, 100, 250],
  player_playback_start_ms: [100, 250, 500, 1000, 2000, 5000, 10000],
  player_probe_ms: [50, 100, 250, 500, 1000, 2500, 5000],
  player_transcode_start_ms: [250, 500, 1000, 2500, 5000, 10000, 30000],
  player_preference_save_ms: [25, 50, 100, 200, 300, 600, 1200],
  player_api_error_count: [],
  player_preference_conflict_count: [],
}
const values = new Map<PlayerTelemetryName, PlayerMetricAggregate>()

export class PlayerTelemetryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlayerTelemetryValidationError'
  }
}

function empty(name: PlayerTelemetryName): PlayerMetricAggregate {
  return { count: 0, sum: 0, min: null, max: null, buckets: Object.fromEntries(bucketMap[name].map(bound => [String(bound), 0])) }
}

export function recordPlayerTelemetry(batch: PlayerTelemetryBatch): void {
  if (!batch || typeof batch !== 'object' || !/^\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b$/i.test(batch.sessionId)) {
    throw new PlayerTelemetryValidationError('sessionId must be a UUID v4')
  }
  if (!Array.isArray(batch.samples) || batch.samples.length < 1 || batch.samples.length > 50) {
    throw new PlayerTelemetryValidationError('samples must contain 1 to 50 entries')
  }
  const now = Date.now()
  for (const sample of batch.samples) {
    if (!sample || typeof sample !== 'object' || Object.keys(sample).some(key => !['name', 'valueMs', 'at'].includes(key))) throw new PlayerTelemetryValidationError('sample contains invalid fields')
    if (!approved.has(sample.name)) throw new PlayerTelemetryValidationError('sample name is not approved')
    if (!Number.isFinite(sample.valueMs) || sample.valueMs < 0 || sample.valueMs > 120_000) throw new PlayerTelemetryValidationError('sample value is outside 0..120000')
    if (!Number.isSafeInteger(sample.at) || Math.abs(sample.at - now) > 10 * 60_000) throw new PlayerTelemetryValidationError('sample timestamp is outside the accepted window')
  }
  for (const sample of batch.samples) {
    const metric = values.get(sample.name) ?? empty(sample.name)
    metric.count++
    metric.sum += sample.valueMs
    metric.min = metric.min == null ? sample.valueMs : Math.min(metric.min, sample.valueMs)
    metric.max = metric.max == null ? sample.valueMs : Math.max(metric.max, sample.valueMs)
    for (const bound of bucketMap[sample.name]) if (sample.valueMs <= bound) metric.buckets[String(bound)]++
    values.set(sample.name, metric)
  }
}

export function getPlayerMetricSnapshot(): PlayerMetricSnapshot {
  return { startedAt, metrics: Object.fromEntries([...values.entries()].map(([name, metric]) => [name, structuredClone(metric)])) }
}

export function resetPlayerTelemetryForTest(): void {
  values.clear()
  logger.debug('Player telemetry reset for test')
}
