import { Router } from 'express'
import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type Database from 'better-sqlite3'
import { catalogueArtworkRoot, cataloguePath, quoteIdentifier } from './catalogue-database.js'
import type { CatalogueFlowRunner } from './catalogue-runner.js'

type Json = Record<string, any>
type Column = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }

const INTERNAL_FTS_SUFFIX = /_(data|idx|content|docsize|config)$/

function tableNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE 'catalog_%' ORDER BY name`).all() as Array<{ name: string }>)
    .map(row => row.name)
    .filter(name => !INTERNAL_FTS_SUFFIX.test(name))
}

function requireTable(db: Database.Database, requested: string): string {
  if (!tableNames(db).includes(requested)) throw new Error('Unknown catalogue table')
  return requested
}

function columns(db: Database.Database, table: string): Column[] {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Column[]
}

function asInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback
}

export function createCatalogueRouter(db: Database.Database, runner: CatalogueFlowRunner): Router {
  const router = Router()

  router.get('/overview', (_req, res) => {
    const metadata = db.prepare(`SELECT * FROM catalog_metadata WHERE dataset_id IN ('archivist-catalogue','archivist-films') ORDER BY schema_version DESC LIMIT 1`).get() as Json
    const itemCounts = db.prepare(`SELECT media_type,completeness_status,count(*) count FROM catalog_items WHERE deleted_at IS NULL GROUP BY media_type,completeness_status`).all()
    const queues = {
      movies: db.prepare(`SELECT status,count(*) count FROM catalog_movie_queue GROUP BY status`).all(),
      artwork: db.prepare(`SELECT status,count(*) count FROM catalog_artwork_queue GROUP BY status`).all(),
    }
    const latestRun = db.prepare(`SELECT r.*,d.name FROM catalog_flow_runs r JOIN catalog_flow_definitions d USING(flow_key) ORDER BY run_id DESC LIMIT 1`).get() ?? null
    let databaseBytes = 0
    try { databaseBytes = statSync(cataloguePath()).size } catch {}
    res.json({
      metadata,
      itemCounts,
      queues,
      latestRun,
      database: { path: cataloguePath(), bytes: databaseBytes },
      artwork: { path: catalogueArtworkRoot() },
      tmdbConfigured: Boolean(process.env.TMDB_READ_TOKEN?.trim() || process.env.TMDB_API_TOKEN?.trim() || process.env.TMDB_API_KEY?.trim()),
      providers: {
        imdb: true,
        omdb: Boolean(process.env.OMDB_API_KEY?.trim()),
        tvdb: Boolean(process.env.TVDB_API_KEY?.trim()),
        tmdb: Boolean(process.env.TMDB_READ_TOKEN?.trim() || process.env.TMDB_API_TOKEN?.trim() || process.env.TMDB_API_KEY?.trim()),
      },
      port: Number(process.env.CATALOGUE_PORT ?? 2428),
    })
  })

  router.get('/flows', (_req, res) => res.json({ flows: runner.listFlows() }))
  router.get('/flows/:key/graph', (req, res) => {
    try { res.json(runner.flowGraph(req.params.key)) }
    catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  router.put('/flows/:key/graph', (req, res) => {
    try { res.json(runner.saveDraft(req.params.key, req.body?.graph ?? req.body)) }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  router.post('/flows/:key/publish', (req, res) => {
    try { res.json(runner.publishDraft(req.params.key)) }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  router.get('/runs', (req, res) => res.json({ runs: runner.listRuns(asInteger(req.query.limit, 100, 1, 500)) }))
  router.get('/runs/:id/logs', (req, res) => res.json({ logs: runner.logs(Number(req.params.id), asInteger(req.query.limit, 500, 1, 2000)) }))
  router.get('/runs/:id/nodes', (req, res) => res.json({ nodes: runner.nodeRuns(Number(req.params.id)) }))
  router.get('/mapping-issues', (req, res) => res.json({ issues: runner.mappingIssues(asInteger(req.query.limit, 200, 1, 500)) }))
  router.post('/flows/:key/run', (req, res) => {
    try {
      const options = {
        limit: req.body?.limit === undefined ? undefined : asInteger(req.body.limit, 100, 1, 5000),
        date: typeof req.body?.date === 'string' ? req.body.date : undefined,
        allArtwork: req.body?.allArtwork === true,
        mediaTypes: Array.isArray(req.body?.mediaTypes) ? req.body.mediaTypes.filter((value: unknown) => typeof value === 'string') : undefined,
        minYear: req.body?.minYear === undefined ? undefined : asInteger(req.body.minYear, 0, 0, 9999),
        includeAdult: req.body?.includeAdult === true,
      }
      const runId = runner.run(req.params.key, 'manual', options)
      res.status(202).json({ runId })
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })
  router.post('/runs/:id/cancel', (req, res) => {
    const cancelled = runner.cancel(Number(req.params.id))
    res.status(cancelled ? 202 : 409).json(cancelled ? { status: 'cancelling' } : { error: 'Run is not active' })
  })

  router.get('/items', (req, res) => {
    const limit = asInteger(req.query.limit, 60, 1, 200)
    const offset = asInteger(req.query.offset, 0, 0, 10_000_000)
    const mediaType = typeof req.query.mediaType === 'string' ? req.query.mediaType : ''
    const status = typeof req.query.status === 'string' ? req.query.status : ''
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
    const clauses = ['i.deleted_at IS NULL']
    const args: unknown[] = []
    if (mediaType) { clauses.push('i.media_type=?'); args.push(mediaType) }
    if (status) { clauses.push('i.completeness_status=?'); args.push(status) }
    if (search) { clauses.push('(i.canonical_title LIKE ? OR i.original_title LIKE ?)'); args.push(`%${search}%`, `%${search}%`) }
    const where = clauses.join(' AND ')
    const total = Number((db.prepare(`SELECT count(*) count FROM catalog_items i WHERE ${where}`).get(...args) as Json).count)
    const items = db.prepare(`SELECT i.*,
      (SELECT a.asset_id FROM catalog_artwork_assets a WHERE a.owner_type='item' AND a.owner_id=i.item_id AND a.artwork_type='poster' AND a.deleted_at IS NULL ORDER BY a.is_selected DESC,a.billing_order LIMIT 1) poster_asset_id,
      (SELECT a.asset_id FROM catalog_artwork_assets a WHERE a.owner_type='item' AND a.owner_id=i.item_id AND a.artwork_type='backdrop' AND a.deleted_at IS NULL ORDER BY a.is_selected DESC,a.billing_order LIMIT 1) backdrop_asset_id,
      (SELECT count(*) FROM catalog_credits c WHERE c.item_id=i.item_id) credit_count
      FROM catalog_items i WHERE ${where}
      ORDER BY CASE i.completeness_status WHEN 'complete' THEN 0 WHEN 'partial' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
      COALESCE(i.first_release_date,'') DESC,i.canonical_title COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args, limit, offset)
    res.json({ items, total, limit, offset })
  })

  router.get('/items/:id', (req, res) => {
    const itemId = Number(req.params.id)
    const item = db.prepare('SELECT * FROM catalog_items WHERE item_id=?').get(itemId) as Json | undefined
    if (!item) { res.status(404).json({ error: 'Catalogue item not found' }); return }
    const credits = db.prepare(`SELECT c.*,p.name person_name,o.name organisation_name
      FROM catalog_credits c LEFT JOIN catalog_people p ON p.person_id=c.person_id
      LEFT JOIN catalog_organisations o ON o.organisation_id=c.organisation_id
      WHERE c.item_id=? ORDER BY c.credit_type,c.billing_order`).all(itemId)
    const organisations = db.prepare(`SELECT io.*,o.name,o.organisation_type FROM catalog_item_organisations io JOIN catalog_organisations o USING(organisation_id) WHERE io.item_id=? ORDER BY io.billing_order`).all(itemId)
    const externalIds = db.prepare('SELECT * FROM catalog_item_external_ids WHERE item_id=? ORDER BY is_primary DESC,source').all(itemId)
    const titles = db.prepare('SELECT * FROM catalog_item_titles WHERE item_id=? ORDER BY billing_order').all(itemId)
    const artwork = db.prepare(`SELECT asset_id,artwork_type,source,source_url,local_path,width,height,is_selected FROM catalog_artwork_assets WHERE owner_type='item' AND owner_id=? AND deleted_at IS NULL ORDER BY artwork_type,is_selected DESC,billing_order`).all(itemId)
    let details: unknown = null
    if (item.media_type === 'film') details = db.prepare('SELECT * FROM catalog_film_details WHERE item_id=?').get(itemId) ?? null
    if (item.media_type === 'series') details = { ...((db.prepare('SELECT * FROM catalog_series_details WHERE item_id=?').get(itemId) as Json | undefined) ?? {}), seasons: db.prepare(`SELECT i.*,s.season_number,s.episode_count,s.air_date FROM catalog_seasons s JOIN catalog_items i ON i.item_id=s.item_id WHERE s.series_item_id=? ORDER BY s.season_number`).all(itemId) }
    if (item.media_type === 'book') details = { work: db.prepare('SELECT * FROM catalog_book_works WHERE item_id=?').get(itemId) ?? null, editions: db.prepare('SELECT * FROM catalog_book_editions WHERE work_item_id=? ORDER BY publication_date').all(itemId), series: db.prepare(`SELECT s.*,e.position_text,e.position_number FROM catalog_book_series_entries e JOIN catalog_book_series s USING(series_id) WHERE e.work_item_id=?`).all(itemId) }
    if (item.media_type === 'music_release_group') details = { group: db.prepare('SELECT * FROM catalog_music_release_groups WHERE item_id=?').get(itemId) ?? null, releases: db.prepare('SELECT * FROM catalog_music_releases WHERE release_group_item_id=? ORDER BY release_date').all(itemId) }
    res.json({ item, details, credits, organisations, externalIds, titles, artwork })
  })

  router.get('/people', (req, res) => {
    const limit = asInteger(req.query.limit, 100, 1, 250)
    const offset = asInteger(req.query.offset, 0, 0, 10_000_000)
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
    const args = search ? [`%${search}%`, `%${search}%`] : []
    const where = search ? 'WHERE p.deleted_at IS NULL AND (p.name LIKE ? OR p.normalized_name LIKE ?)' : 'WHERE p.deleted_at IS NULL'
    const total = Number((db.prepare(`SELECT count(*) count FROM catalog_people p ${where}`).get(...args) as Json).count)
    const people = db.prepare(`SELECT p.*,count(DISTINCT c.item_id) credit_count,count(DISTINCT e.source) identity_sources,
      (SELECT a.asset_id FROM catalog_artwork_assets a WHERE a.owner_type='person' AND a.owner_id=p.person_id AND a.artwork_type='profile' AND a.deleted_at IS NULL ORDER BY a.is_selected DESC LIMIT 1) profile_asset_id_resolved
      FROM catalog_people p LEFT JOIN catalog_credits c USING(person_id) LEFT JOIN catalog_person_external_ids e USING(person_id)
      ${where} GROUP BY p.person_id ORDER BY credit_count DESC,p.name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...args, limit, offset)
    res.json({ people, total, limit, offset })
  })

  router.get('/identity-matches', (_req, res) => {
    const matches = db.prepare(`SELECT m.*,p.name person_name,c.name candidate_name FROM catalog_person_matches m JOIN catalog_people p ON p.person_id=m.person_id JOIN catalog_people c ON c.person_id=m.candidate_person_id WHERE m.status='suggested' ORDER BY m.match_score DESC,m.match_id DESC LIMIT 500`).all()
    res.json({ matches })
  })

  router.get('/artwork/:id', (req, res) => {
    const row = db.prepare(`SELECT local_path,mime_type FROM catalog_artwork_assets WHERE asset_id=? AND local_path IS NOT NULL AND deleted_at IS NULL`).get(Number(req.params.id)) as { local_path: string; mime_type: string | null } | undefined
    if (!row) { res.status(404).end(); return }
    const root = resolve(catalogueArtworkRoot())
    const path = resolve(row.local_path)
    if (!(path === root || path.startsWith(`${root}${sep}`)) || !existsSync(path)) { res.status(404).end(); return }
    if (row.mime_type) res.type(row.mime_type)
    res.sendFile(path)
  })

  router.get('/tables', (_req, res) => {
    const tables = tableNames(db).map(name => {
      let count: number | null = null
      try { count = Number((db.prepare(`SELECT count(*) count FROM ${quoteIdentifier(name)}`).get() as Json).count) } catch {}
      return { name, count, columns: columns(db, name).length }
    })
    res.json({ tables })
  })

  router.get('/tables/:table', (req, res) => {
    try {
      const table = requireTable(db, req.params.table)
      const tableColumns = columns(db, table)
      const names = new Set(tableColumns.map(column => column.name))
      const limit = asInteger(req.query.limit, 50, 1, 200)
      const offset = asInteger(req.query.offset, 0, 0, 10_000_000)
      const requestedOrder = typeof req.query.orderBy === 'string' ? req.query.orderBy : ''
      const orderBy = names.has(requestedOrder) ? requestedOrder : tableColumns.find(column => column.pk)?.name ?? tableColumns[0]?.name
      const direction = String(req.query.direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC'
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
      const searchable = tableColumns.filter(column => /TEXT|CHAR|CLOB/i.test(column.type)).slice(0, 12)
      const where = search && searchable.length
        ? `WHERE ${searchable.map(column => `CAST(${quoteIdentifier(column.name)} AS TEXT) LIKE ?`).join(' OR ')}`
        : ''
      const args = where ? searchable.map(() => `%${search}%`) : []
      const total = Number((db.prepare(`SELECT count(*) count FROM ${quoteIdentifier(table)} ${where}`).get(...args) as Json).count)
      const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} ${where} ORDER BY ${quoteIdentifier(orderBy)} ${direction} LIMIT ? OFFSET ?`).all(...args, limit, offset)
      res.json({ table, columns: tableColumns, primaryKey: tableColumns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name), rows, total, limit, offset })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/tables/:table/rows', (req, res) => {
    try {
      const table = requireTable(db, req.params.table)
      const allowed = new Set(columns(db, table).map(column => column.name))
      const values = Object.entries(req.body?.values ?? {}).filter(([key]) => allowed.has(key))
      if (!values.length) throw new Error('No valid values supplied')
      const statement = db.prepare(`INSERT INTO ${quoteIdentifier(table)}(${values.map(([key]) => quoteIdentifier(key)).join(',')}) VALUES(${values.map(() => '?').join(',')})`)
      const result = statement.run(...values.map(([, value]) => value))
      res.status(201).json({ changes: result.changes, rowid: Number(result.lastInsertRowid) })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.patch('/tables/:table/rows', (req, res) => {
    try {
      const table = requireTable(db, req.params.table)
      const tableColumns = columns(db, table)
      const allowed = new Set(tableColumns.map(column => column.name))
      const keyValues = Object.entries(req.body?.keys ?? {}).filter(([key]) => allowed.has(key))
      const changes = Object.entries(req.body?.changes ?? {}).filter(([key]) => allowed.has(key) && !keyValues.some(([primary]) => primary === key))
      if (!keyValues.length) throw new Error('Primary key values are required')
      if (!changes.length) throw new Error('No valid changes supplied')
      const result = db.prepare(`UPDATE ${quoteIdentifier(table)} SET ${changes.map(([key]) => `${quoteIdentifier(key)}=?`).join(',')} WHERE ${keyValues.map(([key]) => `${quoteIdentifier(key)} IS ?`).join(' AND ')}`)
        .run(...changes.map(([, value]) => value), ...keyValues.map(([, value]) => value))
      res.json({ changes: result.changes })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.delete('/tables/:table/rows', (req, res) => {
    try {
      const table = requireTable(db, req.params.table)
      const allowed = new Set(columns(db, table).map(column => column.name))
      const keyValues = Object.entries(req.body?.keys ?? {}).filter(([key]) => allowed.has(key))
      if (!keyValues.length) throw new Error('Primary key values are required')
      const result = db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE ${keyValues.map(([key]) => `${quoteIdentifier(key)} IS ?`).join(' AND ')}`)
        .run(...keyValues.map(([, value]) => value))
      res.json({ changes: result.changes })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/maintenance/checkpoint', (_req, res) => {
    const result = db.pragma('wal_checkpoint(TRUNCATE)')
    res.json({ result })
  })

  return router
}
