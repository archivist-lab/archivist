import type { Request, Response, NextFunction } from 'express'
import type { ZodSchema } from 'zod'
import { createLogger } from '@archivist/core'

const logger = createLogger('Validation')

/**
 * Request validation against a zod schema from @archivist/contracts.
 *
 * Prefer these over hand-rolled `typeof req.body.x === ...` chains: the schema is
 * shared with the client types, the error envelope is consistent, and the parsed
 * (coerced, stripped) value replaces the raw input so handlers receive data that
 * already matches the declared type.
 *
 *   router.put('/thing', validateBody(ThingPatch), (req, res) => { ... })
 */

interface ZodLikeError {
  errors: Array<{ path: (string | number)[]; message: string }>
}

function reject(res: Response, where: string, error: ZodLikeError): void {
  res.status(400).json({
    error: 'Validation failed',
    details: error.errors.map(e => ({
      path: [where, ...e.path].join('.'),
      message: e.message,
    })),
  })
}

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      logger.warn(`Body validation failed for ${req.method} ${req.path}`)
      reject(res, 'body', result.error)
      return
    }
    req.body = result.data
    next()
  }
}

/**
 * Validates req.query. Query values arrive as strings, so schemas should use
 * `z.coerce.*` for numbers and booleans. The parsed result is exposed via
 * `res.locals.query` (read it with {@link validatedQuery}) rather than by
 * reassigning `req.query`, which is a getter in newer Express versions.
 */
export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query)
    if (!result.success) {
      logger.warn(`Query validation failed for ${req.method} ${req.path}`)
      reject(res, 'query', result.error)
      return
    }
    res.locals.query = result.data
    next()
  }
}

/** Typed accessor for the value stored by {@link validateQuery}. */
export function validatedQuery<T>(res: Response): T {
  return res.locals.query as T
}
