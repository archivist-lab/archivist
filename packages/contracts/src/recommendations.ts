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
