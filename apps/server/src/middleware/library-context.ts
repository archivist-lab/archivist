import type { Request, Response, NextFunction } from 'express'
import { getDb } from '../db.js'

/**
 * Legacy-compatible request scoping. The preserved frontend sends
 * `x-tab-context: <tab id>`; Archivist resolves it against the unified `libraries`
 * table instead of opening a per-tab database. Error semantics (400/404 and
 * message wording) match the legacy tab-context middleware exactly.
 */

export interface LibraryContext {
  id: number
  name: string
  mediaType: string
  dbPath: string
}

declare global {
  namespace Express {
    interface Request {
      library?: LibraryContext
      requestId?: string
    }
  }
}

export function libraryContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const tabHeader = req.headers['x-tab-context']

  if (!tabHeader) return next()

  if (Array.isArray(tabHeader)) {
    return res.status(400).json({ error: 'Only one x-tab-context header is allowed' })
  }
  if (!/^\d+$/.test(tabHeader)) {
    return res.status(400).json({ error: 'x-tab-context must be a positive integer tab id' })
  }
  const libraryId = Number(tabHeader)
  if (!Number.isSafeInteger(libraryId) || libraryId <= 0) {
    return res.status(400).json({ error: 'x-tab-context must be a positive integer tab id' })
  }

  try {
    const row = getDb().prepare('SELECT * FROM libraries WHERE id = ?').get(libraryId) as any
    if (!row) {
      return res.status(404).json({ error: `Tab context ${libraryId} not found` })
    }
    req.library = {
      id: row.id,
      name: row.name,
      mediaType: row.media_type,
      dbPath: row.db_path,
    }
    next()
  } catch (err) {
    next(err)
  }
}

export function requireLibrary(req: Request, res: Response, next: NextFunction) {
  if (!req.library) {
    return res.status(400).json({ error: 'Tab context required. Set x-tab-context header.' })
  }
  next()
}

export function requireLibraryMediaType(mediaType: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.library) {
      return res.status(400).json({ error: 'Tab context required. Set x-tab-context header.' })
    }
    if (req.library.mediaType !== mediaType) {
      return res.status(409).json({ error: `Tab ${req.library.id} is ${req.library.mediaType}, expected ${mediaType}` })
    }
    next()
  }
}

/** Scope id for settings-style tables: the library id, or 0 for global. */
export function scopeId(req: Request): number {
  return req.library?.id ?? 0
}
