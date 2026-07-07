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
    download_dir: z.string().default('./data/downloads'),
    incomplete_dir: z.string().default('./data/incomplete'),
    resume_dir: z.string().default('./data/resume'),
    torrents_dir: z.string().default('./data/torrents'),
    embedded_engine: z.boolean().default(true),
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
  config.metadata.tmdb.api_key = env('TMDB_API_KEY') ?? config.metadata.tmdb.api_key
  config.metadata.tmdb.base_url = env('TMDB_BASE_URL') ?? config.metadata.tmdb.base_url
  config.metadata.tvdb.api_key = env('TVDB_API_KEY') ?? config.metadata.tvdb.api_key
  config.metadata.tvdb.pin = env('TVDB_PIN') ?? config.metadata.tvdb.pin
  config.metadata.google_books.api_key = env('GOOGLE_BOOKS_API_KEY') ?? config.metadata.google_books.api_key
  config.metadata.comicvine.api_key = env('COMICVINE_API_KEY') ?? config.metadata.comicvine.api_key
  config.metadata.igdb.client_id = env('IGDB_CLIENT_ID') ?? config.metadata.igdb.client_id
  config.metadata.igdb.client_secret = env('IGDB_CLIENT_SECRET') ?? config.metadata.igdb.client_secret
  config.metadata.fanart.api_key = env('FANART_API_KEY') ?? config.metadata.fanart.api_key

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

  return config
}
