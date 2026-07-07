import type { Request, Response, NextFunction } from 'express'
import type { ZodSchema } from 'zod'
import { createLogger } from '@archivist/core'

const logger = createLogger('Validation')

/**
 * Validates req.body against a contract schema from @archivist/contracts.
 * Error envelope matches the legacy validation middleware.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      logger.warn(`Validation failed for ${req.method} ${req.path}`)
      res.status(400).json({
        error: 'Validation failed',
        details: result.error.errors.map(e => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      })
      return
    }
    req.body = result.data
    next()
  }
}
