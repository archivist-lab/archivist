import { timingSafeEqual } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { createLogger } from '@archivist/core'

const logger = createLogger('Auth')

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * API-key auth for protected /api/v1/* routes. `/health` stays public so
 * monitors work without credentials; `/ping` is mounted outside this router.
 * Auth is disabled entirely when no key is configured.
 */
export function apiAuthMiddleware(apiKey: string) {
  if (!apiKey) {
    logger.warn('API authentication is disabled. Configure auth.api_key (or ARCHIVIST_API_TOKEN) before exposing Archivist beyond trusted networks.')
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (!apiKey) return next()
    if (req.method === 'GET' && req.path === '/health') return next()

    const auth = req.header('authorization') ?? ''
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
    const headerKey = req.header('x-api-key') ?? ''
    const candidate = bearer || headerKey

    if (candidate && safeEqual(candidate, apiKey)) return next()
    res.status(401).json({ error: 'Unauthorized' })
  }
}
