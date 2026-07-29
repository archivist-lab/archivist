import { z } from 'zod'

export type ListMediaType = 'film' | 'series'
export type ListMode = 'approval' | 'auto'

export type FilterNode =
  | { op: 'and'; nodes: FilterNode[] }
  | { op: 'or'; nodes: FilterNode[] }
  | { op: 'not'; node: FilterNode }
  | { op: 'genre'; mode: 'includes' | 'excludes'; values: string[] }
  | { op: 'year'; min?: number; max?: number }
  | { op: 'rating'; source: 'provider'; min?: number; max?: number; minVotes?: number }
  | { op: 'runtime'; min?: number; max?: number }
  | { op: 'language'; values: string[] }
  | { op: 'certification'; country: string; values: string[] }
  | { op: 'keyword'; mode: 'includes' | 'excludes'; values: string[]; labels?: Record<string, string> }
  | { op: 'person'; role: 'cast' | 'crew' | 'any'; ids: number[]; labels?: Record<string, string> }
  | { op: 'company'; ids: number[]; labels?: Record<string, string> }
  | { op: 'watchProvider'; region: string; ids: number[]; labels?: Record<string, string> }

const boundedYear = z.number().int().min(1870).max(2200)
const boundedRating = z.number().min(0).max(10)
const positiveIds = z.array(z.number().int().positive()).min(1).max(100)
const semanticValues = z.array(z.string().trim().min(1).max(100)).min(1).max(100)
const labels = z.record(z.string().max(200)).optional()

export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() => z.union([
  z.object({ op: z.literal('and'), nodes: z.array(FilterNodeSchema).min(1).max(50) }).strict(),
  z.object({ op: z.literal('or'), nodes: z.array(FilterNodeSchema).min(2).max(50) }).strict(),
  z.object({ op: z.literal('not'), node: FilterNodeSchema }).strict(),
  z.object({ op: z.literal('genre'), mode: z.enum(['includes', 'excludes']), values: semanticValues }).strict(),
  z.object({ op: z.literal('year'), min: boundedYear.optional(), max: boundedYear.optional() }).strict()
    .refine(value => value.min != null || value.max != null, 'At least one year bound is required')
    .refine(value => value.min == null || value.max == null || value.min <= value.max, 'Minimum year must not exceed maximum year'),
  z.object({
    op: z.literal('rating'), source: z.literal('provider'), min: boundedRating.optional(),
    max: boundedRating.optional(), minVotes: z.number().int().min(0).max(10_000_000).optional(),
  }).strict()
    .refine(value => value.min != null || value.max != null || value.minVotes != null, 'At least one rating constraint is required')
    .refine(value => value.min == null || value.max == null || value.min <= value.max, 'Minimum rating must not exceed maximum rating'),
  z.object({ op: z.literal('runtime'), min: z.number().int().min(1).max(1_000).optional(), max: z.number().int().min(1).max(1_000).optional() }).strict()
    .refine(value => value.min != null || value.max != null, 'At least one runtime bound is required')
    .refine(value => value.min == null || value.max == null || value.min <= value.max, 'Minimum runtime must not exceed maximum runtime'),
  z.object({ op: z.literal('language'), values: semanticValues }).strict(),
  z.object({ op: z.literal('certification'), country: z.string().trim().length(2), values: semanticValues }).strict(),
  z.object({ op: z.literal('keyword'), mode: z.enum(['includes', 'excludes']), values: semanticValues, labels }).strict(),
  z.object({ op: z.literal('person'), role: z.enum(['cast', 'crew', 'any']), ids: positiveIds, labels }).strict(),
  z.object({ op: z.literal('company'), ids: positiveIds, labels }).strict(),
  z.object({ op: z.literal('watchProvider'), region: z.string().trim().length(2), ids: positiveIds, labels }).strict(),
])) as z.ZodType<FilterNode>

export const ListPreviewRequest = z.object({
  mediaType: z.enum(['film', 'series']),
  filter: FilterNodeSchema,
  memberCap: z.number().int().min(1).max(10_000).default(500),
}).strict()
export type ListPreviewRequest = z.infer<typeof ListPreviewRequest>

const listMutableFields = {
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).nullable().optional(),
  filter: FilterNodeSchema,
  mode: z.enum(['approval', 'auto']).default('approval'),
  enabled: z.boolean().default(true),
  rootFolderId: z.number().int().positive().nullable().optional(),
  qualityProfileId: z.number().int().positive().nullable().optional(),
  monitored: z.boolean().default(true),
  maxAddsPerRun: z.number().int().min(1).max(100).default(10),
  memberCap: z.number().int().min(1).max(10_000).default(500),
  refreshIntervalHours: z.number().int().min(1).max(720).default(24),
  targetTier: z.string().trim().max(50).nullable().optional(),
  targetResolution: z.string().trim().max(50).nullable().optional(),
  targetSource: z.string().trim().max(50).nullable().optional(),
  targetCodec: z.string().trim().max(50).nullable().optional(),
}

export const ListCreateRequest = z.object({
  mediaType: z.enum(['film', 'series']),
  ...listMutableFields,
}).strict()
export type ListCreateRequest = z.infer<typeof ListCreateRequest>

export const ListPatchRequest = z.object(listMutableFields).partial().strict()
export type ListPatchRequest = z.infer<typeof ListPatchRequest>

export const ListItemsQuery = z.object({
  status: z.enum(['new', 'added', 'dismissed', 'in_library', 'departed', 'failed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict()
export type ListItemsQuery = z.infer<typeof ListItemsQuery>

export const ListBulkActionRequest = z.object({
  action: z.enum(['add', 'dismiss']),
  itemIds: z.array(z.number().int().positive()).min(1).max(200),
}).strict()
export type ListBulkActionRequest = z.infer<typeof ListBulkActionRequest>
