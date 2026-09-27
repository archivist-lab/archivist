import { Router } from 'express'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getDb } from '../db.js'
import { stripMediaVersion } from './library-paths.js'

export function createDiagRouter(): Router {
  const router = Router()

  router.get('/diag/images', (_req, res) => {
    const db = getDb()
    const mediaRoot = join(process.cwd(), 'media')

    const sampleSeries = db.prepare('SELECT title, poster_path, logo_path FROM series LIMIT 5').all() as any[]
    const sampleFilms = db.prepare('SELECT title, poster_path, logo_path FROM films LIMIT 5').all() as any[]

    // Stored artwork URLs carry a cache-busting `?v=` that is not part of the
    // filename, so strip it before touching the disk.
    const onDisk = (dbPath: string | null) => {
      const path = stripMediaVersion(dbPath)
      if (!path?.startsWith('/media')) return { fullPath: 'N/A', exists: false }
      const fullPath = join(process.cwd(), path)
      return { fullPath, exists: existsSync(fullPath) }
    }

    const results = {
      mediaRoot,
      cwd: process.cwd(),
      series: sampleSeries.map(s => ({ title: s.title, dbPoster: s.poster_path, ...onDisk(s.poster_path) })),
      films: sampleFilms.map(f => ({ title: f.title, dbPoster: f.poster_path, ...onDisk(f.poster_path) })),
    }
    res.json(results)
  })

  return router
}
