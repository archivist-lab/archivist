import { z } from 'zod'

export const RatingSubjectTypeSchema = z.enum(['film', 'series', 'season', 'episode'])
export type RatingSubjectType = z.infer<typeof RatingSubjectTypeSchema>

export const RatingSubjectSchema = z.object({
  type: RatingSubjectTypeSchema,
  id: z.number().int().positive(),
}).strict()
export type RatingSubject = z.infer<typeof RatingSubjectSchema>

export const RatingValueSchema = z.number().int().min(1).max(5)
export type RatingValue = z.infer<typeof RatingValueSchema>

export const RatingSourceSchema = z.enum(['own', 'inherited', 'none'])
export type RatingSource = z.infer<typeof RatingSourceSchema>

export const ResolvedRatingSchema = z.object({
  value: RatingValueSchema.nullable(),
  source: RatingSourceSchema,
  inheritedFrom: z.object({ type: z.enum(['series', 'season']), id: z.number().int().positive() }).strict().nullable(),
  scaleMax: z.literal(5),
}).strict()
export type ResolvedRating = z.infer<typeof ResolvedRatingSchema>

export const SetRatingRequestSchema = z.object({
  value: RatingValueSchema,
  profileId: z.string().min(1).max(64).default('default'),
}).strict()
export type SetRatingRequest = z.infer<typeof SetRatingRequestSchema>

export const RatingProfileQuerySchema = z.object({
  profile: z.string().min(1).max(64).optional().default('default'),
}).strict()
export type RatingProfileQuery = z.infer<typeof RatingProfileQuerySchema>

export const UnratedQueueQuerySchema = RatingProfileQuerySchema.extend({
  lookbackDays: z.coerce.number().int().min(1).max(365).optional().default(30),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
})
export type UnratedQueueQuery = z.infer<typeof UnratedQueueQuerySchema>

export const DismissRatingRequestSchema = z.object({
  profileId: z.string().min(1).max(64).default('default'),
}).strict()

export const RatingTreeNodeSchema = z.object({
  subject: RatingSubjectSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  rating: ResolvedRatingSchema,
}).strict()
export type RatingTreeNode = z.infer<typeof RatingTreeNodeSchema>

export const SeriesRatingTreeSchema = z.object({
  series: RatingTreeNodeSchema,
  seasons: z.array(z.object({
    season: RatingTreeNodeSchema,
    episodes: z.array(RatingTreeNodeSchema),
  }).strict()),
}).strict()
export type SeriesRatingTree = z.infer<typeof SeriesRatingTreeSchema>

export const UnratedQueueItemSchema = z.object({
  subject: RatingSubjectSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  posterUrl: z.string().nullable(),
  completedAt: z.string(),
  rating: ResolvedRatingSchema,
  childCount: z.number().int().positive().optional(),
  children: z.array(RatingTreeNodeSchema).optional(),
}).strict()
export type UnratedQueueItem = z.infer<typeof UnratedQueueItemSchema>
