import { z } from 'zod'

export type RecommendationMediaType = 'film' | 'series'
export type RecommendationAvailability =
  | 'available'
  | 'partially_available'
  | 'processing'
  | 'downloading'
  | 'queued'
  | 'wanted'
  | 'upcoming'
  | 'external'

export type RecommendationFeedback = 'more_like_this' | 'less_like_this' | 'not_interested' | 'already_seen'

export interface RecommendationContext {
  reason: string
  reasonCode: string
  availability: RecommendationAvailability
  scoreVersion: string
  snapshotId: number
  sources: string[]
  seed?: { mediaType: RecommendationMediaType; providerId: number; title: string } | null
}

export interface RecommendationResult {
  mediaType: RecommendationMediaType
  providerId: number
  tmdbId?: number
  tvdbId?: number
  localId?: number
  title: string
  year?: number
  overview?: string
  genres: string[]
  posterPath?: string
  backdropPath?: string
  rating?: number
  alreadyAdded: boolean
  status?: string
  recommendation: RecommendationContext
  [key: string]: unknown
}

export interface RecommendationGroup {
  id: 'museum' | 'discoveries' | 'coming' | 'upcoming' | 'because'
  title: string
  items: RecommendationResult[]
}

export interface RecommendationPage {
  audience: string
  mediaType: RecommendationMediaType
  generatedAt: string
  stale: boolean
  modelVersion: string
  groups: RecommendationGroup[]
}

// ── Request schemas ───────────────────────────────────────────────────────────

export const RecommendationVariety = z.enum(['focused', 'balanced', 'diverse'])
export type RecommendationVariety = z.infer<typeof RecommendationVariety>

export const RecommendationHistoryEmphasis = z.enum(['low', 'balanced', 'high'])
export type RecommendationHistoryEmphasis = z.infer<typeof RecommendationHistoryEmphasis>

/** PUT /system/recommendations/settings — every field optional (partial update). */
export const RecommendationSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  retentionDays: z.number().int().min(7).max(365).optional(),
  variety: RecommendationVariety.optional(),
  minPopularity: z.number().min(0).max(1000).optional(),
  historyEmphasis: RecommendationHistoryEmphasis.optional(),
  refreshIntervalHours: z.number().int().min(1).max(168).optional(),
}).strict()
export type RecommendationSettingsPatch = z.infer<typeof RecommendationSettingsPatch>

/** POST /recommendations/feedback */
export const RecommendationFeedbackRequest = z.object({
  profileId: z.string().min(1).max(64),
  mediaType: z.enum(['film', 'series']),
  providerId: z.number().int().positive(),
  feedback: z.enum(['more_like_this', 'less_like_this', 'not_interested', 'already_seen']),
})
export type RecommendationFeedbackRequest = z.infer<typeof RecommendationFeedbackRequest>
