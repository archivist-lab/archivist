import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'

/**
 * Typed configuration boundary for the Archivist backend.
 *
 * Precedence: environment variables > config.toml > defaults.
 * Metadata provider keys are additionally mirrored into process.env so the
 * ported provider clients (which read env directly, like their legacy
 * counterparts) see the same values regardless of config source.
 */

const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().int().min(1).max(65535).default(2424),
  }).default({}),
  auth: z.object({
    api_key: z.string().default(''),
  }).default({}),
  database: z.object({
    path: z.string().default('./data/archivist.sqlite'),
  }).default({}),
  media: z.object({
    base_dir: z.string().default('./media'),
  }).default({}),
  definitions: z.object({
    path: z.string().default('./data/indexer-definitions'),
    offline: z.boolean().default(false),
  }).default({}),
  downloads: z.object({
    download_dir: z.string().default('./downloads/complete'),
    incomplete_dir: z.string().default('./downloads/incomplete'),
    resume_dir: z.string().default('./data/resume'),
    torrents_dir: z.string().default('./data/torrents'),
    embedded_engine: z.boolean().default(true),
  }).default({}),
  workers: z.object({
    imports: z.number().int().min(1).max(32).default(1),
    metadata: z.number().int().min(1).max(32).default(4),
    lists: z.number().int().min(1).max(32).default(2),
    maintenance: z.number().int().min(1).max(32).default(1),
    default: z.number().int().min(1).max(32).default(1),
    loudness: z.number().int().min(1).max(16).default(2),
    segments: z.number().int().min(1).max(16).default(1),
    segment_sweep_max: z.number().int().min(1).max(10000).default(50),
    transcodes: z.number().int().min(1).max(16).default(2),
    catalogue_enrichment_batch: z.number().int().min(1).max(5000).default(250),
    catalogue_artwork_batch: z.number().int().min(1).max(2000).default(100),
    catalogue_backlog_interval_seconds: z.number().int().min(15).max(3600).default(60),
  }).default({}),
  provider_limits: z.object({
    tmdb: z.object({ concurrency: z.number().int().min(1).max(20).default(4), min_interval_ms: z.number().int().min(0).max(60000).default(25) }).default({}),
    tvdb: z.object({ concurrency: z.number().int().min(1).max(20).default(2), min_interval_ms: z.number().int().min(0).max(60000).default(100) }).default({}),
    fanart: z.object({ concurrency: z.number().int().min(1).max(20).default(2), min_interval_ms: z.number().int().min(0).max(60000).default(100) }).default({}),
    skyhook: z.object({ concurrency: z.number().int().min(1).max(20).default(2), min_interval_ms: z.number().int().min(0).max(60000).default(100) }).default({}),
    circuit_open_ms: z.number().int().min(1000).max(900000).default(30000),
  }).default({}),
  metadata: z.object({
    tmdb: z.object({ api_key: z.string().default(''), base_url: z.string().default('https://api.themoviedb.org/3') }).default({}),
    tvdb: z.object({ api_key: z.string().default(''), pin: z.string().default('') }).default({}),
    google_books: z.object({ api_key: z.string().default('') }).default({}),
    comicvine: z.object({ api_key: z.string().default('') }).default({}),
    igdb: z.object({ client_id: z.string().default(''), client_secret: z.string().default('') }).default({}),
    fanart: z.object({ api_key: z.string().default('') }).default({}),
  }).default({}),
})

export type AppConfig = z.infer<typeof ConfigSchema>

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function envBool(name: string): boolean | undefined {
  const value = process.env[name]
  if (value === undefined || value === '') return undefined
  return value === 'true' || value === '1'
}

function envInt(...names: string[]): number | undefined {
  const value = env(...names)
  if (value === undefined) return undefined
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function loadConfig(configPath?: string): AppConfig {
  const path = configPath ?? process.env.ARCHIVIST_CONFIG ?? join(process.cwd(), 'config.toml')

  let fromFile: unknown = {}
  if (existsSync(path)) {
    try {
      fromFile = parseToml(readFileSync(path, 'utf8'))
    } catch (err) {
      throw new Error(`Invalid config file ${resolve(path)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const parsed = ConfigSchema.safeParse(fromFile)
  if (!parsed.success) {
    const issues = parsed.error.errors.map(e => `  ${e.path.join('.')}: ${e.message}`).join('\n')
    throw new Error(`Invalid configuration in ${resolve(path)}:\n${issues}`)
  }
  const config = parsed.data

  // Environment overrides
  config.server.host = env('ARCHIVIST_HOST', 'HOST') ?? config.server.host
  config.server.port = envInt('ARCHIVIST_PORT', 'PORT') ?? config.server.port
  config.auth.api_key = env('ARCHIVIST_API_TOKEN', 'ARCHIVIST_AUTH_TOKEN') ?? config.auth.api_key
  config.database.path = env('ARCHIVIST_DB') ?? config.database.path
  config.media.base_dir = env('ARCHIVIST_MEDIA_BASE') ?? config.media.base_dir
  config.definitions.path = env('ARCHIVIST_DEFINITIONS_PATH') ?? config.definitions.path
  config.definitions.offline = envBool('DEFINITIONS_OFFLINE') ?? config.definitions.offline
  config.downloads.download_dir = env('TORRENT_DOWNLOAD_DIR') ?? config.downloads.download_dir
  config.downloads.incomplete_dir = env('TORRENT_INCOMPLETE_DIR') ?? config.downloads.incomplete_dir
  config.downloads.resume_dir = env('TORRENT_RESUME_DIR') ?? config.downloads.resume_dir
  config.downloads.torrents_dir = env('TORRENT_FILES_DIR') ?? config.downloads.torrents_dir
  config.downloads.embedded_engine = envBool('ARCHIVIST_EMBEDDED_TORRENTS') ?? config.downloads.embedded_engine
  config.workers.imports = envInt('ARCHIVIST_JOB_CONCURRENCY_IMPORTS') ?? config.workers.imports
  config.workers.metadata = envInt('ARCHIVIST_JOB_CONCURRENCY_METADATA') ?? config.workers.metadata
  config.workers.lists = envInt('ARCHIVIST_JOB_CONCURRENCY_LISTS') ?? config.workers.lists
  config.workers.maintenance = envInt('ARCHIVIST_JOB_CONCURRENCY_MAINTENANCE') ?? config.workers.maintenance
  config.workers.default = envInt('ARCHIVIST_JOB_CONCURRENCY_DEFAULT') ?? config.workers.default
  config.workers.loudness = envInt('ARCHIVIST_LOUDNESS_CONCURRENCY') ?? config.workers.loudness
  config.workers.segments = envInt('ARCHIVIST_SEGMENT_CONCURRENCY') ?? config.workers.segments
  config.workers.segment_sweep_max = envInt('ARCHIVIST_SEGMENT_SWEEP_MAX') ?? config.workers.segment_sweep_max
  config.workers.transcodes = envInt('ARCHIVIST_TRANSCODE_CONCURRENCY') ?? config.workers.transcodes
  config.workers.catalogue_enrichment_batch = envInt('ARCHIVIST_CATALOGUE_ENRICHMENT_BATCH') ?? config.workers.catalogue_enrichment_batch
  config.workers.catalogue_artwork_batch = envInt('ARCHIVIST_CATALOGUE_ARTWORK_BATCH') ?? config.workers.catalogue_artwork_batch
  config.workers.catalogue_backlog_interval_seconds = envInt('ARCHIVIST_CATALOGUE_BACKLOG_INTERVAL_SECONDS') ?? config.workers.catalogue_backlog_interval_seconds
  for (const provider of ['tmdb', 'tvdb', 'fanart', 'skyhook'] as const) {
    const key = provider.toUpperCase()
    config.provider_limits[provider].concurrency = envInt(`ARCHIVIST_${key}_CONCURRENCY`) ?? config.provider_limits[provider].concurrency
    config.provider_limits[provider].min_interval_ms = envInt(`ARCHIVIST_${key}_MIN_INTERVAL_MS`) ?? config.provider_limits[provider].min_interval_ms
  }
  config.provider_limits.circuit_open_ms = envInt('ARCHIVIST_PROVIDER_CIRCUIT_OPEN_MS') ?? config.provider_limits.circuit_open_ms
  config.metadata.tmdb.api_key = env('TMDB_API_KEY') ?? config.metadata.tmdb.api_key
  config.metadata.tmdb.base_url = env('TMDB_BASE_URL') ?? config.metadata.tmdb.base_url
  config.metadata.tvdb.api_key = env('TVDB_API_KEY') ?? config.metadata.tvdb.api_key
  config.metadata.tvdb.pin = env('TVDB_PIN') ?? config.metadata.tvdb.pin
  config.metadata.google_books.api_key = env('GOOGLE_BOOKS_API_KEY') ?? config.metadata.google_books.api_key
  config.metadata.comicvine.api_key = env('COMICVINE_API_KEY') ?? config.metadata.comicvine.api_key
  config.metadata.igdb.client_id = env('IGDB_CLIENT_ID') ?? config.metadata.igdb.client_id
  config.metadata.igdb.client_secret = env('IGDB_CLIENT_SECRET') ?? config.metadata.igdb.client_secret
  config.metadata.fanart.api_key = env('FANART_API_KEY') ?? config.metadata.fanart.api_key

  const validated = ConfigSchema.safeParse(config)
  if (!validated.success) {
    const issues = validated.error.errors.map(e => `  ${e.path.join('.')}: ${e.message}`).join('\n')
    throw new Error(`Invalid configuration after environment overrides:\n${issues}`)
  }

  // Mirror provider credentials into env for the ported provider clients.
  const mirror = (key: string, value: string) => { if (value && !process.env[key]) process.env[key] = value }
  mirror('TMDB_API_KEY', config.metadata.tmdb.api_key)
  mirror('TMDB_BASE_URL', config.metadata.tmdb.base_url)
  mirror('TVDB_API_KEY', config.metadata.tvdb.api_key)
  mirror('TVDB_PIN', config.metadata.tvdb.pin)
  mirror('GOOGLE_BOOKS_API_KEY', config.metadata.google_books.api_key)
  mirror('COMICVINE_API_KEY', config.metadata.comicvine.api_key)
  mirror('IGDB_CLIENT_ID', config.metadata.igdb.client_id)
  mirror('IGDB_CLIENT_SECRET', config.metadata.igdb.client_secret)
  mirror('FANART_API_KEY', config.metadata.fanart.api_key)
  const mirrorNumber = (key: string, value: number) => { if (!process.env[key]) process.env[key] = String(value) }
  mirrorNumber('ARCHIVIST_JOB_CONCURRENCY_IMPORTS', config.workers.imports)
  mirrorNumber('ARCHIVIST_JOB_CONCURRENCY_METADATA', config.workers.metadata)
  mirrorNumber('ARCHIVIST_JOB_CONCURRENCY_LISTS', config.workers.lists)
  mirrorNumber('ARCHIVIST_JOB_CONCURRENCY_MAINTENANCE', config.workers.maintenance)
  mirrorNumber('ARCHIVIST_JOB_CONCURRENCY_DEFAULT', config.workers.default)
  mirrorNumber('ARCHIVIST_LOUDNESS_CONCURRENCY', config.workers.loudness)
  mirrorNumber('ARCHIVIST_SEGMENT_CONCURRENCY', config.workers.segments)
  mirrorNumber('ARCHIVIST_SEGMENT_SWEEP_MAX', config.workers.segment_sweep_max)
  mirrorNumber('ARCHIVIST_TRANSCODE_CONCURRENCY', config.workers.transcodes)
  mirrorNumber('ARCHIVIST_CATALOGUE_ENRICHMENT_BATCH', config.workers.catalogue_enrichment_batch)
  mirrorNumber('ARCHIVIST_CATALOGUE_ARTWORK_BATCH', config.workers.catalogue_artwork_batch)
  mirrorNumber('ARCHIVIST_CATALOGUE_BACKLOG_INTERVAL_SECONDS', config.workers.catalogue_backlog_interval_seconds)
  for (const provider of ['tmdb', 'tvdb', 'fanart', 'skyhook'] as const) {
    const key = provider.toUpperCase()
    mirrorNumber(`ARCHIVIST_${key}_CONCURRENCY`, config.provider_limits[provider].concurrency)
    mirrorNumber(`ARCHIVIST_${key}_MIN_INTERVAL_MS`, config.provider_limits[provider].min_interval_ms)
  }
  mirrorNumber('ARCHIVIST_PROVIDER_CIRCUIT_OPEN_MS', config.provider_limits.circuit_open_ms)

  return validated.data
}
