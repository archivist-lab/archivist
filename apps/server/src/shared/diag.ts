import { Router } from 'express'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getDb } from '../db.js'

export function createDiagRouter(): Router {
  const router = Router()

  router.get('/diag/images', (_req, res) => {
    const db = getDb()
    const mediaRoot = join(process.cwd(), 'media')

    const sampleSeries = db.prepare('SELECT title, poster_path, logo_path FROM series LIMIT 5').all() as any[]
    const sampleFilms = db.prepare('SELECT title, poster_path, logo_path FROM films LIMIT 5').all() as any[]

    const results = {
      mediaRoot,
      cwd: process.cwd(),
      series: sampleSeries.map(s => ({
        title: s.title,
        dbPoster: s.poster_path,
        fullPath: s.poster_path?.startsWith('/media') ? join(process.cwd(), s.poster_path) : 'N/A',
        exists: s.poster_path?.startsWith('/media') ? existsSync(join(process.cwd(), s.poster_path)) : false,
      })),
      films: sampleFilms.map(f => ({
        title: f.title,
        dbPoster: f.poster_path,
        fullPath: f.poster_path?.startsWith('/media') ? join(process.cwd(), f.poster_path) : 'N/A',
        exists: f.poster_path?.startsWith('/media') ? existsSync(join(process.cwd(), f.poster_path)) : false,
      })),
    }
    res.json(results)
  })

  return router
}
