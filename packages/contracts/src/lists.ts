import { z } from 'zod'

export type ListMediaType = 'film' | 'series'
export type ListMode = 'approval' | 'auto'

/**
 * How the several values inside a single rule combine. `all` requires every
 * value to be present on a title (the historic behaviour); `any` matches a title
 * carrying at least one of them. Rules are still combined with each other by the
 * list's own and/or combinator.
 */
export type FilterValueMatch = 'all' | 'any'

export type FilterNode =
  | { op: 'and'; nodes: FilterNode[] }
  | { op: 'or'; nodes: FilterNode[] }
  | { op: 'not'; node: FilterNode }
  | { op: 'genre'; mode: 'includes' | 'excludes'; values: string[]; match?: FilterValueMatch }
  | { op: 'year'; min?: number; max?: number; relative?: 'this_year' | 'next_year' | 'future' }
  /**
   * A score threshold. `provider` is TMDB's own vote average, filtered at the
   * provider; `archivist` is the Archivist Rating this library publishes, which
   * only exists for titles the library holds — see the note on its evaluation.
   */
  | { op: 'rating'; source: 'provider' | 'archivist'; min?: number; max?: number; minVotes?: number }
  | { op: 'runtime'; min?: number; max?: number }
  | { op: 'language'; values: string[] }
  | { op: 'certification'; country: string; values: string[] }
  | { op: 'keyword'; mode: 'includes' | 'excludes'; values: string[]; match?: FilterValueMatch; labels?: Record<string, string> }
  | { op: 'title'; mode: 'includes' | 'excludes'; ids: number[]; labels?: Record<string, string> }
  /**
   * Free-text title matching — "Star Wars", "Mission: Impossible" — rather than
   * the fixed provider ids `title` carries. Punctuation and case are ignored on
   * both sides, so "Mission Impossible" finds "Mission: Impossible".
   */
  | { op: 'titleText'; mode: 'includes' | 'excludes'; values: string[]; match?: FilterValueMatch }
  | { op: 'person'; role: 'starring' | 'cast' | 'director' | 'producer' | 'executive_producer' | 'writer' | 'creator' | 'composer' | 'cinematographer' | 'editor' | 'crew' | 'any'; ids: number[]; match?: FilterValueMatch; labels?: Record<string, string> }
  | { op: 'company'; ids: number[]; match?: FilterValueMatch; labels?: Record<string, string> }
  | { op: 'network'; ids: number[]; match?: FilterValueMatch; labels?: Record<string, string> }
  | { op: 'watchProvider'; region: string; ids: number[]; match?: FilterValueMatch; labels?: Record<string, string> }

const boundedYear = z.number().int().min(1870).max(2200)
const boundedRating = z.number().min(0).max(10)
const positiveIds = z.array(z.number().int().positive()).min(1).max(100)
const semanticValues = z.array(z.string().trim().min(1).max(100)).min(1).max(100)
/** Title phrases are searched one query at a time, so the list is kept short. */
const phraseValues = z.array(z.string().trim().min(2).max(100)).min(1).max(10)
const labels = z.record(z.string().max(200)).optional()
const valueMatch = z.enum(['all', 'any']).optional()

export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() => z.union([
  z.object({ op: z.literal('and'), nodes: z.array(FilterNodeSchema).min(1).max(50) }).strict(),
  z.object({ op: z.literal('or'), nodes: z.array(FilterNodeSchema).min(2).max(50) }).strict(),
  z.object({ op: z.literal('not'), node: FilterNodeSchema }).strict(),
  z.object({ op: z.literal('genre'), mode: z.enum(['includes', 'excludes']), values: semanticValues, match: valueMatch }).strict(),
  z.object({ op: z.literal('year'), min: boundedYear.optional(), max: boundedYear.optional(), relative: z.enum(['this_year', 'next_year', 'future']).optional() }).strict()
    .refine(value => value.min != null || value.max != null || value.relative != null, 'A year or relative release date is required')
    .refine(value => value.relative == null || (value.min == null && value.max == null), 'Relative release dates cannot include fixed year bounds')
    .refine(value => value.min == null || value.max == null || value.min <= value.max, 'Minimum year must not exceed maximum year'),
  z.object({
    op: z.literal('rating'), source: z.enum(['provider', 'archivist']).default('provider'), min: boundedRating.optional(),
    max: boundedRating.optional(), minVotes: z.number().int().min(0).max(10_000_000).optional(),
  }).strict()
    .refine(value => value.min != null || value.max != null || value.minVotes != null, 'At least one rating constraint is required')
    .refine(value => value.min == null || value.max == null || value.min <= value.max, 'Minimum rating must not exceed maximum rating')
    // Only the provider publishes vote counts; the Archivist Rating carries its
    // own confidence instead, so a vote floor there would mean nothing.
    .refine(value => value.source !== 'archivist' || value.minVotes == null, 'A minimum vote count applies only to provider ratings'),
  z.object({ op: z.literal('runtime'), min: z.number().int().min(1).max(1_000).optional(), max: z.number().int().min(1).max(1_000).optional() }).strict()
    .refine(value => value.min != null || value.max != null, 'At least one runtime bound is required')
    .refine(value => value.min == null || value.max == null || value.min <= value.max, 'Minimum runtime must not exceed maximum runtime'),
  z.object({ op: z.literal('language'), values: semanticValues }).strict(),
  z.object({ op: z.literal('certification'), country: z.string().trim().length(2), values: semanticValues }).strict(),
  z.object({ op: z.literal('keyword'), mode: z.enum(['includes', 'excludes']), values: semanticValues, match: valueMatch, labels }).strict(),
  z.object({ op: z.literal('title'), mode: z.enum(['includes', 'excludes']), ids: positiveIds, labels }).strict(),
  z.object({ op: z.literal('titleText'), mode: z.enum(['includes', 'excludes']), values: phraseValues, match: valueMatch }).strict(),
  z.object({ op: z.literal('person'), role: z.enum(['starring', 'cast', 'director', 'producer', 'executive_producer', 'writer', 'creator', 'composer', 'cinematographer', 'editor', 'crew', 'any']), ids: positiveIds, match: valueMatch, labels }).strict(),
  z.object({ op: z.literal('company'), ids: positiveIds, match: valueMatch, labels }).strict(),
  z.object({ op: z.literal('network'), ids: positiveIds, match: valueMatch, labels }).strict(),
  z.object({ op: z.literal('watchProvider'), region: z.string().trim().length(2), ids: positiveIds, match: valueMatch, labels }).strict(),
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
  /**
   * Presentation for the Player. `description` is the operator's note about what
   * the list is for; these three are what a viewer sees when the list is
   * published as a box set, so they are deliberately separate fields.
   */
  imageUrl: z.string().trim().max(500).nullable().optional(),
  overview: z.string().trim().max(600).nullable().optional(),
  playerBoxSet: z.boolean().default(false),
  /** The box set type the list appears under in the Player; null for the first list-based type of its kind. */
  boxSetTemplateId: z.string().trim().min(1).max(64).nullable().optional(),
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

/** Portable representation used by Archivist Lists YAML files. */
export const ListYamlEntry = ListCreateRequest.omit({
  rootFolderId: true,
  qualityProfileId: true,
}).extend({
  rootFolder: z.string().trim().min(1).max(4_096).nullable().optional(),
  qualityProfile: z.string().trim().min(1).max(160).nullable().optional(),
}).strict()
export type ListYamlEntry = z.infer<typeof ListYamlEntry>

export const ListYamlDocument = z.object({
  format: z.literal('archivist-lists'),
  version: z.literal(1),
  lists: z.array(ListYamlEntry).max(100),
}).strict()
export type ListYamlDocument = z.infer<typeof ListYamlDocument>

export const ListYamlImportRequest = z.object({
  yaml: z.string().min(1).max(1_000_000),
}).strict()
export type ListYamlImportRequest = z.infer<typeof ListYamlImportRequest>

export const ListPatchRequest = z.object(listMutableFields).partial().strict()
export type ListPatchRequest = z.infer<typeof ListPatchRequest>

export const ListItemsQuery = z.object({
  status: z.enum(['new', 'added', 'dismissed', 'in_library', 'departed', 'failed']).optional(),
  /** Substring match on the member's title, so a review queue stays searchable. */
  q: z.string().trim().max(160).optional(),
  yearMin: z.coerce.number().int().min(1870).max(2200).optional(),
  yearMax: z.coerce.number().int().min(1870).max(2200).optional(),
  sort: z.enum(['recent', 'title', 'year_desc', 'year_asc', 'rating_desc', 'rating_asc']).default('recent'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict()
  .refine(value => value.yearMin == null || value.yearMax == null || value.yearMin <= value.yearMax, 'Minimum year must not exceed maximum year')
export type ListItemsQuery = z.infer<typeof ListItemsQuery>

export const ListAddQuality = z.object({
  target_tier: z.string().trim().min(1).max(50),
  target_resolution: z.string().trim().min(1).max(50),
  target_source: z.string().trim().min(1).max(50),
  target_codec: z.string().trim().min(1).max(50),
  minimum_tier: z.string().trim().min(1).max(50),
  minimum_resolution: z.string().trim().min(1).max(50),
  minimum_source: z.string().trim().min(1).max(50),
  minimum_codec: z.string().trim().min(1).max(50),
}).partial().strict()
export type ListAddQuality = z.infer<typeof ListAddQuality>

export const ListBulkActionRequest = z.object({
  action: z.enum(['add', 'dismiss', 'restore']),
  itemIds: z.array(z.number().int().positive()).min(1).max(200),
  quality: ListAddQuality.optional(),
}).strict()
export type ListBulkActionRequest = z.infer<typeof ListBulkActionRequest>
