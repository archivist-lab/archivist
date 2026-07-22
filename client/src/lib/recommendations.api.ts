import { request } from './api.js'

export type RecommendationMediaType = 'film' | 'series'
export type RecommendationFeedback = 'more_like_this' | 'less_like_this' | 'not_interested' | 'already_seen'

export interface RecommendationItem {
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
  studio?: string
  network?: string
  runtime?: number
  recommendation: {
    reason: string
    reasonCode: string
    availability: string
    scoreVersion: string
    snapshotId: number
    sources: string[]
  }
  [key: string]: unknown
}

export interface RecommendationPage {
  audience: string
  mediaType: RecommendationMediaType
  generatedAt: string
  stale: boolean
  modelVersion: string
  groups: Array<{ id: string; title: string; items: RecommendationItem[] }>
}

export const recommendationsApi = {
  films: (audience = 'household') => request<RecommendationPage>(`/recommendations/films?audience=${encodeURIComponent(audience)}`),
  series: (audience = 'household') => request<RecommendationPage>(`/recommendations/series?audience=${encodeURIComponent(audience)}`),
  rebuild: (audience = 'household') => request<RecommendationPage>('/recommendations/rebuild', { method: 'POST', body: JSON.stringify({ audience }) }),
  feedback: (profileId: string, mediaType: RecommendationMediaType, providerId: number, feedback: RecommendationFeedback) =>
    request<void>('/recommendations/feedback', { method: 'POST', body: JSON.stringify({ profileId, mediaType, providerId, feedback }) }),
  profiles: () => request<{ profiles: Array<{ id: string; name: string }> }>('/player/ui/profiles'),
}
