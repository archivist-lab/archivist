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

export const FlareSolverrConfig = z.object({
  url: z.string(),
  enabled: z.boolean(),
})
export type FlareSolverrConfig = z.infer<typeof FlareSolverrConfig>

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
