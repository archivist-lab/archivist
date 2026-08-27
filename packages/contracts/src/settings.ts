import { z } from 'zod'

export const NamingConfig = z.object({
  movieFolderFormat: z.string(),
  movieFileFormat: z.string(),
  renameMovies: z.boolean(),
  colonReplacement: z.string(),
})
export type NamingConfig = z.infer<typeof NamingConfig>

export const MediaManagementConfig = z.object({
  copyMode: z.string(),
  deleteEmptyFolders: z.boolean(),
  importExtraFiles: z.boolean(),
  extraFileExtensions: z.string(),
  recycleBin: z.string(),
})
export type MediaManagementConfig = z.infer<typeof MediaManagementConfig>

/**
 * Default address of the in-house Cloudflare Bypass service.
 *
 * Correct for a bare-metal install, where the service is published on
 * loopback by `archivist-cloudflare-bypass.service`. It is wrong under
 * Docker Compose: loopback inside the Archivist container is the Archivist
 * container, not the solver. There the runtime overrides this with
 * ARCHIVIST_CLOUDFLARE_BYPASS_URL pointing at the service name.
 *
 * This constant stays the default rather than the only value, so 'internal'
 * keeps meaning "the service this deployment runs" in both topologies.
 */
export const CLOUDFLARE_BYPASS_INTERNAL_URL = 'http://127.0.0.1:8191'

export const CloudflareBypassConfig = z.object({
  /**
   * 'internal' targets the Control-managed service on this host and ignores
   * `url`; 'external' targets `url`, which is how this setting behaved before
   * the service moved in-house.
   */
  mode: z.enum(['internal', 'external']),
  url: z.string(),
  enabled: z.boolean(),
})
export type CloudflareBypassConfig = z.infer<typeof CloudflareBypassConfig>

/**
 * The URL a config resolves to, or undefined when it resolves to nothing
 * usable. Tolerates rows written before `mode` existed: absent means the
 * external URL was the only target, so that is what they keep meaning.
 */
export function resolveCloudflareBypassUrl(
  config: Partial<CloudflareBypassConfig> | null | undefined,
  internalUrl: string = CLOUDFLARE_BYPASS_INTERNAL_URL,
): string | undefined {
  if (!config?.enabled) return undefined
  if (config.mode === 'internal') return internalUrl || CLOUDFLARE_BYPASS_INTERNAL_URL
  return config.url || undefined
}

export const AcquisitionDefaults = z.object({
  tier: z.string(),
  resolution: z.string(),
  source: z.string(),
  codec: z.string(),
})
export type AcquisitionDefaults = z.infer<typeof AcquisitionDefaults>

export const TrackCleanerConfig = z.object({
  enabled: z.boolean(),
  preferredLanguage: z.string(),
  keepOriginalLanguage: z.boolean(),
  keepPreferredAudio: z.boolean(),
  keepPreferredSubs: z.boolean(),
  keepCommentary: z.boolean(),
  additionalLanguages: z.array(z.string()),
})
export type TrackCleanerConfig = z.infer<typeof TrackCleanerConfig>

export const SubtitleConfig = z.object({
  enabled: z.boolean(),
  provider: z.string(),
  apiKey: z.string(),
  defaultLanguage: z.string(),
  autoAcquire: z.boolean(),
  hearingImpaired: z.boolean(),
  forcedOnly: z.boolean(),
})
export type SubtitleConfig = z.infer<typeof SubtitleConfig>

export const UpdateApiKeys = z.object({
  tmdbApiKey: z.string().default(''),
  tvdbApiKey: z.string().default(''),
  tvdbPin: z.string().default(''),
  googleBooksApiKey: z.string().default(''),
  comicvineApiKey: z.string().default(''),
  igdbClientId: z.string().default(''),
  igdbClientSecret: z.string().default(''),
  fanartApiKey: z.string().default(''),
})
export type UpdateApiKeys = z.infer<typeof UpdateApiKeys>
