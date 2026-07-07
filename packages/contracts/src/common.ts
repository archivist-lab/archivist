import { z } from 'zod'

/**
 * Shared API conventions for Archivist.
 *
 * The preserved frontend consumes loose envelopes; these schemas document and
 * enforce the canonical shapes at Archivist route boundaries without changing them.
 */

/** Numeric database identifier. All Archivist entities use positive integer ids. */
export const Id = z.number().int().positive()
export type Id = z.infer<typeof Id>

/** Id supplied via route params / bodies where the legacy UI sends strings. */
export const IdLike = z.union([z.string(), z.number()]).transform(v => Number(v))
  .refine(v => Number.isSafeInteger(v) && v > 0, { message: 'must be a positive integer id' })

export const MediaType = z.enum(['films', 'series', 'music', 'games', 'books', 'comics'])
export type MediaType = z.infer<typeof MediaType>

/** Canonical media lifecycle states (legacy vocabulary preserved per domain). */
export const LifecycleState = z.enum([
  'wanted', 'missing', 'acquiring', 'downloading', 'restoring',
  'collected', 'downloaded', 'unaired', 'ignored',
])
export type LifecycleState = z.infer<typeof LifecycleState>

/** Error envelope used across the API: `{ error: string, details?: [...] }`. */
export const ErrorResponse = z.object({
  error: z.string(),
  details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
})
export type ErrorResponse = z.infer<typeof ErrorResponse>

/** Loose success envelope used by action routes: `{ success, message? }`. */
export const SuccessResponse = z.object({
  success: z.boolean(),
  message: z.string().optional(),
})
export type SuccessResponse = z.infer<typeof SuccessResponse>

/** Pagination conventions for list endpoints that support them. */
export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})
export type Pagination = z.infer<typeof Pagination>

export const downloadUrl = z.string().min(1).refine(
  v => v.startsWith('magnet:') || v.startsWith('http://') || v.startsWith('https://'),
  { message: 'downloadUrl must be a magnet link or HTTP(S) URL' },
)

export const optionalBool = z.boolean().optional()
export const optionalStr = z.string().optional()
export const optionalInt = z.number().int().positive().optional()
