import { z } from 'zod'
import { downloadUrl, optionalBool, optionalInt, optionalStr } from './common.js'

/**
 * Request contracts for the media domain routes. These are the legacy route
 * body contracts, preserved verbatim so the locked frontend keeps working.
 */

// ── Films ─────────────────────────────────────────────────────────────────────

export const AddFilm = z.object({
  tmdbId: z.union([z.string(), z.number()]).transform(v => String(v)),
  qualityProfileId: optionalInt,
  rootFolderPath: optionalStr,
  monitored: optionalBool,
  target_tier: optionalStr,
  target_resolution: optionalStr,
  target_source: optionalStr,
  target_codec: optionalStr,
  minimum_tier: optionalStr,
  minimum_resolution: optionalStr,
  minimum_source: optionalStr,
  minimum_codec: optionalStr,
})

export const UpdateFilm = z.object({
  monitored: optionalBool,
  status: z.enum(['wanted', 'downloading', 'downloaded', 'missing', 'ignored']).optional(),
  qualityProfileId: optionalInt,
  rootFolderPath: optionalStr,
  upgrade_allowed: optionalBool,
  target_tier: optionalStr,
  target_resolution: optionalStr,
  target_source: optionalStr,
  target_codec: optionalStr,
  minimum_tier: optionalStr,
  minimum_resolution: optionalStr,
  minimum_source: optionalStr,
  minimum_codec: optionalStr,
  default_edition_id: optionalInt,
})

export const DownloadFilm = z.object({
  downloadUrl,
  filmId: z.union([z.string(), z.number()]).optional(),
  tier: z.number().int().min(1).max(3).optional(),
  version: optionalStr,
})

// ── Series ────────────────────────────────────────────────────────────────────

export const AddSeries = z.object({
  tvdbId: z.union([z.string(), z.number()]).transform(v => Number(v)).optional(),
  tmdbId: z.union([z.string(), z.number()]).transform(v => Number(v)).optional(),
  monitored: optionalBool,
  monitoredSeasons: z.enum(['all', 'latest', 'none']).optional(),
  qualityProfileId: optionalInt,
  rootFolderPath: optionalStr,
  upgrade_allowed: optionalBool,
  target_tier: optionalStr,
  target_resolution: optionalStr,
  target_source: optionalStr,
  target_codec: optionalStr,
  minimum_tier: optionalStr,
  minimum_resolution: optionalStr,
  minimum_source: optionalStr,
  minimum_codec: optionalStr,
}).refine(d => d.tvdbId || d.tmdbId, { message: 'tvdbId or tmdbId required' })

export const UpdateSeries = z.object({
  monitored: optionalBool,
  qualityProfileId: optionalInt,
  rootFolderPath: optionalStr,
  upgrade_allowed: optionalBool,
  target_tier: optionalStr,
  target_resolution: optionalStr,
  target_source: optionalStr,
  target_codec: optionalStr,
  minimum_tier: optionalStr,
  minimum_resolution: optionalStr,
  minimum_source: optionalStr,
  minimum_codec: optionalStr,
})

export const UpdateSeason = z.object({ monitored: z.boolean().optional(), upgrade_allowed: optionalBool })
export const UpdateEpisode = z.object({ monitored: z.boolean().optional(), upgrade_allowed: optionalBool })
export const DownloadSeries = z.object({ downloadUrl })

// ── Music ─────────────────────────────────────────────────────────────────────

export const AddArtist = z.object({
  mbid: z.string().min(1),
  monitored: optionalBool,
  rootFolderPath: optionalStr,
  albumTypes: z.array(z.string()).optional(),
})

export const UpdateAlbum = z.object({
  monitored: optionalBool,
  status: z.enum(['missing', 'downloading', 'downloaded', 'ignored']).optional(),
  upgrade_allowed: optionalBool,
  target_tier: optionalStr,
})

export const DownloadMusic = z.object({ downloadUrl })

// ── Books ─────────────────────────────────────────────────────────────────────

export const AddBookAuthor = z.object({
  name: z.string().min(1),
  monitored: optionalBool,
  rootFolderPath: optionalStr,
  seriesNames: z.array(z.string()).optional(),
})

export const UpdateBook = z.object({
  monitored: optionalBool,
  status: z.enum(['missing', 'downloading', 'downloaded', 'ignored']).optional(),
})

export const AddBookEdition = z.object({
  format: z.enum(['epub', 'pdf', 'mobi', 'azw3', 'cbz', 'cbr']),
})

export const DownloadBooks = z.object({ downloadUrl })

// ── Comics ────────────────────────────────────────────────────────────────────

export const AddComicSeries = z.object({
  cvId: z.union([z.string(), z.number()]).transform(v => String(v)),
  monitored: optionalBool,
  monitorAll: optionalBool,
  rootFolderPath: optionalStr,
})

export const UpdateComicSeries = z.object({ monitored: optionalBool })

export const UpdateComicIssue = z.object({
  monitored: optionalBool,
  status: z.enum(['missing', 'downloading', 'downloaded', 'unaired', 'ignored']).optional(),
  upgrade_allowed: optionalBool,
})

export const DownloadComics = z.object({ downloadUrl })

// ── Games ─────────────────────────────────────────────────────────────────────

export const AddGame = z.object({
  igdbId: z.union([z.string(), z.number()]).transform(v => String(v)),
  monitored: optionalBool,
  rootFolderPath: optionalStr,
  platforms: z.array(z.string()).optional(),
})

export const UpdateGame = z.object({
  monitored: optionalBool,
  status: z.enum(['missing', 'downloading', 'downloaded', 'ignored']).optional(),
  upgrade_allowed: optionalBool,
  target_tier: optionalStr,
})

export const DownloadGames = z.object({ downloadUrl })

// ── Download clients ──────────────────────────────────────────────────────────

export const CreateDownloadClient = z.object({
  name: z.string().min(1),
  type: z.enum(['transmission', 'qbittorrent']),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  useSsl: z.boolean().default(false),
  urlBase: z.string().default(''),
  username: optionalStr,
  password: optionalStr,
  category: z.string().default('archivist'),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(1).default(1),
  tags: z.array(z.string()).default([]),
})
