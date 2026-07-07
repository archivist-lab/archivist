import { z } from 'zod'

export const QualityProfile = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  cutoff: z.string(),
  min_format_score: z.number().int(),
  items: z.array(z.string()),
  upgradeAllowed: z.boolean(),
  created_at: z.string(),
})
export type QualityProfile = z.infer<typeof QualityProfile>

export const CreateQualityProfile = z.object({
  name: z.string().min(1),
  cutoff: z.string().optional(),
  items: z.array(z.string()).default([]),
  upgradeAllowed: z.boolean().default(true),
  minFormatScore: z.number().int().default(0),
})
export type CreateQualityProfile = z.infer<typeof CreateQualityProfile>

export const UpdateQualityProfile = z.object({
  name: z.string().min(1).optional(),
  cutoff: z.string().optional(),
  items: z.array(z.string()).optional(),
  upgradeAllowed: z.boolean().optional(),
  minFormatScore: z.number().int().optional(),
})
export type UpdateQualityProfile = z.infer<typeof UpdateQualityProfile>

export const QualityDefinition = z.object({
  id: z.number().int().positive(),
  library_id: z.number().int().min(0),
  title: z.string(),
  weight: z.number().int(),
  min_size: z.number().nullable(),
  max_size: z.number().nullable(),
  minSize: z.number().nullable(),
  maxSize: z.number().nullable(),
})
export type QualityDefinition = z.infer<typeof QualityDefinition>

export const CreateQualityDefinition = z.object({
  title: z.string().min(1),
  weight: z.number().int().default(0),
  minSize: z.number().nonnegative().nullable().optional(),
  maxSize: z.number().nonnegative().nullable().optional(),
}).refine(v => v.minSize == null || v.maxSize == null || v.minSize <= v.maxSize, {
  message: 'minSize must be less than or equal to maxSize',
  path: ['maxSize'],
})
export type CreateQualityDefinition = z.infer<typeof CreateQualityDefinition>

export const UpdateQualityDefinition = z.object({
  title: z.string().min(1).optional(),
  weight: z.number().int().optional(),
  minSize: z.number().nonnegative().nullable().optional(),
  maxSize: z.number().nonnegative().nullable().optional(),
})
export type UpdateQualityDefinition = z.infer<typeof UpdateQualityDefinition>

export const TierMediaType = z.enum(['films', 'series', 'music', 'games', 'comics'])
export type TierMediaType = z.infer<typeof TierMediaType>

export const TierTerm = z.object({
  term: z.string(),
  mediaTypes: z.array(TierMediaType),
})
export type TierTerm = z.infer<typeof TierTerm>

export const TierConfig = z.object({
  tier1: z.array(TierTerm),
  tier2: z.array(TierTerm),
  tier3: z.array(TierTerm),
})
export type TierConfig = z.infer<typeof TierConfig>
