import type { RatingSubjectType, ResolvedRating, SeriesRatingTree, UnratedQueueItem } from '@archivist/contracts'
import { request } from './api.js'

const profile = 'default'
export const ratingsApi = {
  get: (type: RatingSubjectType, id: number) => request<ResolvedRating>(`/ratings/${type}/${id}?profile=${encodeURIComponent(profile)}`),
  tree: (seriesId: number) => request<SeriesRatingTree>(`/ratings/series/${seriesId}/tree?profile=${encodeURIComponent(profile)}`),
  queue: () => request<{ items: UnratedQueueItem[] }>(`/ratings/unrated?profile=${encodeURIComponent(profile)}`),
  set: (type: RatingSubjectType, id: number, value: number) => request<ResolvedRating>(`/ratings/${type}/${id}`, { method: 'PUT', body: JSON.stringify({ value, profileId: profile }) }),
  clear: (type: RatingSubjectType, id: number) => request<ResolvedRating>(`/ratings/${type}/${id}?profile=${encodeURIComponent(profile)}`, { method: 'DELETE' }),
  dismiss: (type: RatingSubjectType, id: number) => request<void>(`/ratings/unrated/${type}/${id}/dismiss`, { method: 'POST', body: JSON.stringify({ profileId: profile }) }),
}
