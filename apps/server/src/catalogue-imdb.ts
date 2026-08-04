import type Database from 'better-sqlite3'
import { createGunzip } from 'node:zlib'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInterface } from 'node:readline'
import { upsertPersonIdentity } from '@archivist/catalogue'
import { cataloguePath } from './catalogue-database.js'

type Row = Record<string, string>
type Progress = { step?: string; processed?: number; total?: number | null; succeeded?: number; failed?: number; message?: string }
export type ImdbImportOptions = { mediaTypes?: string[]; minYear?: number; includeAdult?: boolean }
export type ImdbImportHooks = { progress: (value: Progress) => void; log: (message: string, context?: unknown) => void }

const NULL = '\\N'
const EARLIEST_IMDB_YEAR = 1930
const DEFAULT_TYPES = ['movie', 'tvMovie', 'tvSeries', 'tvMiniSeries']
const ALLOWED_TYPES = new Set(['movie', 'tvMovie', 'tvSpecial', 'video', 'tvSeries', 'tvMiniSeries', 'tvEpisode'])
const TV_TYPES = new Set(['tvMovie', 'tvSpecial', 'tvSeries', 'tvMiniSeries', 'tvEpisode'])
const baseUrl = () => (process.env.IMDB_DATASETS_BASE_URL ?? 'https://datasets.imdbws.com').replace(/\/$/, '')
const cacheRoot = () => resolve(process.env.ARCHIVIST_CATALOGUE_IMDB_CACHE ?? join(dirname(cataloguePath()), 'imdb'))
const value = (input: string | undefined): string | null => !input || input === NULL ? null : input
const year = (input: string | undefined): number | null => { const parsed = Number(value(input)); return Number.isInteger(parsed) ? parsed : null }
const normalize = (input: string) => input.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const dateOnly = (date = new Date()) => date.toISOString().slice(0, 10)

export function shouldImportImdbTitle(row: Row, types: ReadonlySet<string>, requestedMinYear = EARLIEST_IMDB_YEAR, includeAdult = false): boolean {
  if (!types.has(row.titleType) || row.titleType === 'short' || row.titleType === 'tvShort') return false
  const startYear = year(row.startYear)
  if (startYear == null || startYear < Math.max(EARLIEST_IMDB_YEAR, requestedMinYear)) return false
  if (!includeAdult && row.isAdult === '1') return false
  const genres = new Set((value(row.genres)?.split(',') ?? []).map(normalize))
  if (TV_TYPES.has(row.titleType) && genres.has('talk show')) return false
  return true
}

function mediaType(imdbType: string): 'film' | 'series' | 'episode' | null {
  if (['movie', 'short', 'tvMovie', 'tvShort', 'tvSpecial', 'video'].includes(imdbType)) return 'film'
  if (['tvSeries', 'tvMiniSeries'].includes(imdbType)) return 'series'
  if (imdbType === 'tvEpisode') return 'episode'
  return null
}

async function cachedDataset(dataset: string, signal: AbortSignal, log: ImdbImportHooks['log'], onDownload: (received: number, total: number | null) => void): Promise<string> {
  const root = cacheRoot()
  const target = join(root, `${dataset}.tsv.gz`)
  const partial = `${target}.part`
  mkdirSync(root, { recursive: true })
  if (existsSync(target)) {
    const details = statSync(target)
    if (details.size > 0 && dateOnly(details.mtime) === dateOnly()) {
      onDownload(details.size, details.size)
      log(`Using cached IMDb ${dataset}`, { path: target, bytes: details.size })
      return target
    }
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (signal.aborted) throw signal.reason
    try {
      const partialDetails = existsSync(partial) ? statSync(partial) : null
      const partialBytes = partialDetails && dateOnly(partialDetails.mtime) === dateOnly() ? partialDetails.size : 0
      const headers = partialBytes ? { Range: `bytes=${partialBytes}-` } : undefined
      const response = await fetch(`${baseUrl()}/${dataset}.tsv.gz`, { headers, signal })
      if (!response.ok || !response.body) throw new Error(`IMDb ${dataset} download returned HTTP ${response.status}`)
      const append = partialBytes > 0 && response.status === 206
      const responseBytes = Number(response.headers.get('content-length'))
      const totalBytes = Number.isFinite(responseBytes) && responseBytes > 0 ? responseBytes + (append ? partialBytes : 0) : null
      let received = append ? partialBytes : 0
      let lastReported = received
      onDownload(received, totalBytes)
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length
          if (received - lastReported >= 4 * 1024 * 1024 || (totalBytes !== null && received >= totalBytes)) {
            lastReported = received
            onDownload(received, totalBytes)
          }
          callback(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(partial, { flags: append ? 'a' : 'w' }), { signal })
      onDownload(received, totalBytes ?? received)
      renameSync(partial, target)
      log(`Cached IMDb ${dataset}`, { path: target, bytes: statSync(target).size, resumedBytes: append ? partialBytes : 0 })
      return target
    } catch (error) {
      if (signal.aborted) throw signal.reason
      lastError = error
      log(`IMDb ${dataset} download attempt ${attempt} failed`, { error: error instanceof Error ? error.message : String(error), partialBytes: existsSync(partial) ? statSync(partial).size : 0 })
      if (attempt < 4) await new Promise(resolveDelay => setTimeout(resolveDelay, attempt * 1_000))
    }
  }
  throw lastError
}

async function streamTsv(
  path: string,
  signal: AbortSignal,
  onRows: (rows: Row[]) => void,
  onProgress: (count: number) => void,
): Promise<number> {
  const compressed = createReadStream(path)
  const gunzip = createGunzip()
  const lines = createInterface({ input: compressed.pipe(gunzip), crlfDelay: Infinity })
  let headers: string[] | null = null
  let count = 0
  let batch: Row[] = []
  try {
    for await (const line of lines) {
      if (signal.aborted) throw signal.reason
      if (!headers) { headers = line.replace(/^\uFEFF/, '').split('\t'); continue }
      const fields = line.split('\t')
      const row: Row = {}
      for (let index = 0; index < headers.length; index++) row[headers[index]] = fields[index] ?? ''
      batch.push(row)
      count++
      if (batch.length >= 2_000) {
        onRows(batch)
        batch = []
        if (count % 20_000 === 0) onProgress(count)
      }
    }
  } finally {
    lines.close()
    compressed.destroy()
    gunzip.destroy()
  }
  if (batch.length) onRows(batch)
  onProgress(count)
  return count
}

function claimItem(db: Database.Database, imdbId: string, type: 'film' | 'series' | 'episode', title: string, originalTitle: string | null, releaseYear: number | null, adult: boolean): number {
  const linked = db.prepare(`SELECT item_id FROM catalog_item_external_ids WHERE source='imdb' AND external_id=?`).get(imdbId) as { item_id: number } | undefined
  let itemId = linked?.item_id
  if (itemId) {
    const collision = db.prepare(`SELECT item_id FROM catalog_items WHERE source='imdb' AND source_id=? AND media_type=? AND item_id<>?`).get(imdbId, type, itemId)
    db.prepare(`UPDATE catalog_items SET canonical_title=?,original_title=COALESCE(?,original_title),sort_title=?,release_year=COALESCE(?,release_year),first_release_date=COALESCE(first_release_date,?),adult=?,metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL WHERE item_id=?`)
      .run(title, originalTitle, title, releaseYear, releaseYear ? String(releaseYear) : null, adult ? 1 : 0, itemId)
    if (!collision) db.prepare(`UPDATE catalog_items SET source='imdb',source_id=?,media_type=? WHERE item_id=?`).run(imdbId, type, itemId)
  } else {
    const existing = db.prepare(`SELECT item_id FROM catalog_items WHERE source='imdb' AND source_id=? AND media_type=?`).get(imdbId, type) as { item_id: number } | undefined
    if (existing) itemId = existing.item_id
    else itemId = Number(db.prepare(`INSERT INTO catalog_items(media_type,source,source_id,canonical_title,original_title,sort_title,first_release_date,release_year,adult,completeness_status,completeness_score) VALUES(?,'imdb',?,?,?,?,?,?,?,'partial',0.35)`).run(type, imdbId, title, originalTitle, title, releaseYear ? String(releaseYear) : null, releaseYear, adult ? 1 : 0).lastInsertRowid)
  }
  db.prepare(`UPDATE catalog_item_external_ids SET is_primary=0 WHERE item_id=?`).run(itemId)
  db.prepare(`INSERT INTO catalog_item_external_ids(item_id,source,external_id,is_primary,verified_at) VALUES(?,'imdb',?,1,CURRENT_TIMESTAMP) ON CONFLICT(source,external_id) DO UPDATE SET is_primary=1,verified_at=CURRENT_TIMESTAMP`).run(itemId, imdbId)
  if (type === 'film') db.prepare(`INSERT OR IGNORE INTO catalog_film_details(item_id) VALUES(?)`).run(itemId)
  if (type === 'series') db.prepare(`INSERT OR IGNORE INTO catalog_series_details(item_id) VALUES(?)`).run(itemId)
  db.prepare(`INSERT INTO catalog_ingest_queue(source,entity_type,source_id,reason,priority,status,available_at,done_at,last_error) VALUES('enrichment',?,?,'imdb-snapshot',50,'pending',CURRENT_TIMESTAMP,NULL,NULL) ON CONFLICT(source,entity_type,source_id) DO UPDATE SET status=CASE WHEN status='processing' THEN status ELSE 'pending' END,available_at=CURRENT_TIMESTAMP,done_at=NULL,last_error=NULL`).run(type, imdbId)
  return itemId
}

function genreId(db: Database.Database, name: string): number {
  const normalized = normalize(name)
  const existing = db.prepare(`SELECT genre_id FROM catalog_genres WHERE normalized_name=? LIMIT 1`).get(normalized) as { genre_id: number } | undefined
  if (existing) return existing.genre_id
  const next = Number((db.prepare(`SELECT COALESCE(min(genre_id),0)-1 id FROM catalog_genres`).get() as { id: number }).id)
  db.prepare(`INSERT INTO catalog_genres(genre_id,name,normalized_name,active) VALUES(?,?,?,1)`).run(next, name, normalized)
  return next
}

export async function importImdbDatasets(db: Database.Database, options: ImdbImportOptions, signal: AbortSignal, hooks: ImdbImportHooks): Promise<{ rows: number; accepted: number }> {
  const requested = options.mediaTypes?.length ? options.mediaTypes : (process.env.ARCHIVIST_CATALOGUE_IMDB_TYPES?.split(',').map(v => v.trim()).filter(Boolean) || DEFAULT_TYPES)
  const types = new Set(requested.filter(type => ALLOWED_TYPES.has(type)))
  if (!types.size) throw new Error('Select at least one supported IMDb title type')
  const configuredMinYear = Number.isInteger(options.minYear) ? Number(options.minYear) : Number(process.env.ARCHIVIST_CATALOGUE_IMDB_MIN_YEAR || EARLIEST_IMDB_YEAR)
  const minYear = Number.isInteger(configuredMinYear) ? Math.max(EARLIEST_IMDB_YEAR, configuredMinYear) : EARLIEST_IMDB_YEAR
  const includeAdult = options.includeAdult ?? process.env.ARCHIVIST_CATALOGUE_IMDB_INCLUDE_ADULT === 'true'
  const acceptedIds = new Set<string>()
  let totalRows = 0
  let accepted = 0
  const snapshotDate = dateOnly()
  const criteria = JSON.stringify({ types: [...types].sort(), minYear, includeAdult })
  const completedSnapshot = db.prepare(`SELECT row_count,accepted_count FROM catalog_imdb_snapshots WHERE dataset_key=? AND snapshot_date=? AND media_types_json=? AND status='complete'`)
  const markSnapshotRunning = db.prepare(`INSERT INTO catalog_imdb_snapshots(dataset_key,source_url,snapshot_date,imported_at,row_count,accepted_count,media_types_json,status,last_error) VALUES(?,?,?,CURRENT_TIMESTAMP,0,0,?,'running',NULL) ON CONFLICT(dataset_key) DO UPDATE SET source_url=excluded.source_url,snapshot_date=excluded.snapshot_date,imported_at=CURRENT_TIMESTAMP,row_count=0,accepted_count=0,media_types_json=excluded.media_types_json,status='running',last_error=NULL`)
  const recordSnapshot = db.prepare(`INSERT INTO catalog_imdb_snapshots(dataset_key,source_url,snapshot_date,imported_at,row_count,accepted_count,media_types_json,status,last_error) VALUES(?,?,date('now'),CURRENT_TIMESTAMP,?,?,?,'complete',NULL) ON CONFLICT(dataset_key) DO UPDATE SET source_url=excluded.source_url,snapshot_date=excluded.snapshot_date,imported_at=CURRENT_TIMESTAMP,row_count=excluded.row_count,accepted_count=excluded.accepted_count,media_types_json=excluded.media_types_json,status='complete',last_error=NULL`)
  const downloadProgress = (dataset: string) => (received: number, total: number | null) => hooks.progress({
    step: `Downloading IMDb ${dataset}`,
    processed: received,
    total,
    message: `${(received / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ''}`,
  })

  hooks.progress({ step: 'IMDb titles', processed: 0, total: null })
  let datasetAccepted = 0
  const resumedBasics = completedSnapshot.get('title.basics', snapshotDate, criteria) as { row_count: number; accepted_count: number } | undefined
  let basicsRows: number
  if (resumedBasics) {
    basicsRows = resumedBasics.row_count
    datasetAccepted = resumedBasics.accepted_count
    for (const row of db.prepare('SELECT imdb_id FROM catalog_imdb_intake_titles').iterate() as Iterable<{ imdb_id: string }>) acceptedIds.add(row.imdb_id)
    hooks.progress({ processed: basicsRows, succeeded: datasetAccepted, message: `Resumed ${datasetAccepted.toLocaleString()} accepted titles` })
    hooks.log('Resumed completed IMDb title basics', { rows: basicsRows, accepted: datasetAccepted })
  } else {
    markSnapshotRunning.run('title.basics', `${baseUrl()}/title.basics.tsv.gz`, snapshotDate, criteria)
    db.prepare('DELETE FROM catalog_imdb_intake_titles').run()
    const rememberAccepted = db.prepare('INSERT OR IGNORE INTO catalog_imdb_intake_titles(imdb_id) VALUES(?)')
    hooks.progress({ step: 'Downloading IMDb title.basics', processed: 0, total: null, message: 'Preparing local dataset cache' })
    const path = await cachedDataset('title.basics', signal, hooks.log, downloadProgress('title.basics'))
    hooks.progress({ step: 'IMDb titles', processed: 0, total: null })
    basicsRows = await streamTsv(path, signal, rows => db.transaction(() => {
      for (const row of rows) {
        if (!shouldImportImdbTitle(row, types, minYear, includeAdult)) continue
        const startYear = year(row.startYear)
        const type = mediaType(row.titleType)
        const title = value(row.primaryTitle)
        if (!type || !title) continue
        const itemId = claimItem(db, row.tconst, type, title, value(row.originalTitle), startYear, row.isAdult === '1')
        acceptedIds.add(row.tconst)
        rememberAccepted.run(row.tconst)
        datasetAccepted++
        const runtime = year(row.runtimeMinutes)
        if (type === 'film' && runtime) db.prepare(`UPDATE catalog_film_details SET runtime_minutes=COALESCE(runtime_minutes,?) WHERE item_id=?`).run(runtime, itemId)
        for (const [order, name] of (value(row.genres)?.split(',') ?? []).entries()) db.prepare(`INSERT OR IGNORE INTO catalog_item_genres(item_id,genre_id,billing_order) VALUES(?,?,?)`).run(itemId, genreId(db, name), order)
      }
    })(), count => hooks.progress({ processed: count, succeeded: datasetAccepted, message: `${datasetAccepted.toLocaleString()} accepted titles` }))
    recordSnapshot.run('title.basics', `${baseUrl()}/title.basics.tsv.gz`, basicsRows, datasetAccepted, criteria)
    hooks.log('Imported IMDb title basics', { rows: basicsRows, accepted: datasetAccepted, types: [...types], minYear, includeAdult })
  }
  totalRows += basicsRows; accepted += datasetAccepted

  const simpleDataset = async (dataset: string, handler: (row: Row) => void, idForRow: (row: Row) => string = row => row.tconst) => {
    hooks.progress({ step: `IMDb ${dataset}`, processed: totalRows, total: null })
    const completed = completedSnapshot.get(dataset, snapshotDate, criteria) as { row_count: number; accepted_count: number } | undefined
    if (completed) {
      totalRows += completed.row_count
      accepted += completed.accepted_count
      hooks.progress({ processed: totalRows, succeeded: accepted, message: `Resumed completed ${dataset}` })
      hooks.log(`Resumed completed IMDb ${dataset}`, { rows: completed.row_count, relevant: completed.accepted_count })
      return
    }
    markSnapshotRunning.run(dataset, `${baseUrl()}/${dataset}.tsv.gz`, snapshotDate, criteria)
    hooks.progress({ step: `Downloading IMDb ${dataset}`, processed: totalRows, total: null, message: 'Preparing local dataset cache' })
    const path = await cachedDataset(dataset, signal, hooks.log, downloadProgress(dataset))
    hooks.progress({ step: `IMDb ${dataset}`, processed: totalRows, total: null })
    let relevant = 0
    const rows = await streamTsv(path, signal, batch => db.transaction(() => { for (const row of batch) { if (!acceptedIds.has(idForRow(row))) continue; handler(row); relevant++ } })(), count => hooks.progress({ processed: totalRows + count, succeeded: accepted + relevant, message: `${relevant.toLocaleString()} relevant ${dataset} rows` }))
    totalRows += rows; accepted += relevant
    recordSnapshot.run(dataset, `${baseUrl()}/${dataset}.tsv.gz`, rows, relevant, criteria)
    hooks.log(`Imported IMDb ${dataset}`, { rows, relevant })
  }

  await simpleDataset('title.ratings', row => {
    db.prepare(`UPDATE catalog_items SET rating=?,rating_count=?,metadata_updated_at=CURRENT_TIMESTAMP WHERE item_id=(SELECT item_id FROM catalog_item_external_ids WHERE source='imdb' AND external_id=?)`).run(Number(row.averageRating), Number(row.numVotes), row.tconst)
  })
  await simpleDataset('title.akas', row => {
    const title = value(row.title); if (!title) return
    const item = db.prepare(`SELECT item_id FROM catalog_item_external_ids WHERE source='imdb' AND external_id=?`).get(row.titleId) as { item_id: number } | undefined
    if (item) db.prepare(`INSERT OR IGNORE INTO catalog_item_titles(item_id,title,normalized_title,title_type,language_code,country_code,source,billing_order) VALUES(?,?,?,?,?,?,?,?)`).run(item.item_id, title, normalize(title), value(row.types) ?? 'alternative', value(row.language), value(row.region), 'imdb', Number(row.ordering) || 0)
  }, row => row.titleId)
  await simpleDataset('title.episode', row => {
    const episode = db.prepare(`SELECT item_id FROM catalog_item_external_ids WHERE source='imdb' AND external_id=?`).get(row.tconst) as { item_id: number } | undefined
    const series = db.prepare(`SELECT item_id FROM catalog_item_external_ids WHERE source='imdb' AND external_id=?`).get(row.parentTconst) as { item_id: number } | undefined
    const seasonNumber = year(row.seasonNumber); const episodeNumber = year(row.episodeNumber)
    if (!episode || !series || seasonNumber == null || episodeNumber == null) return
    db.prepare(`INSERT INTO catalog_episodes(item_id,series_item_id,season_number,episode_number) VALUES(?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET series_item_id=excluded.series_item_id,season_number=excluded.season_number,episode_number=excluded.episode_number`).run(episode.item_id, series.item_id, seasonNumber, episodeNumber)
    db.prepare(`INSERT OR IGNORE INTO catalog_item_relations(source_item_id,target_item_id,relation_type,source,confidence) VALUES(?,?,'episode_of','imdb',1)`).run(episode.item_id, series.item_id)
  })
  const credit = db.prepare(`INSERT OR IGNORE INTO catalog_credits(item_id,person_id,credit_type,role,raw_role,character_name,billing_order,source,source_credit_id,is_primary) VALUES(?,?,?,?,?,?,?,'imdb',?,?)`)
  await simpleDataset('title.principals', row => {
    const item = db.prepare(`SELECT item_id FROM catalog_item_external_ids WHERE source='imdb' AND external_id=?`).get(row.tconst) as { item_id: number } | undefined
    if (!item) return
    const personId = upsertPersonIdentity(db, { source: 'imdb', externalId: row.nconst, name: row.nconst })
    const category = value(row.category) ?? 'contributor'
    const characters = value(row.characters)
    let character: string | null = null
    if (characters) { try { character = (JSON.parse(characters) as string[])[0] ?? null } catch {} }
    credit.run(item.item_id, personId, ['actor', 'actress', 'self', 'archive_footage', 'archive_sound'].includes(category) ? 'cast' : 'crew', normalize(category), value(row.job) ?? category, character, Number(row.ordering) || 0, `${row.tconst}:${row.nconst}:${row.ordering}`, Number(row.ordering) <= 5 ? 1 : 0)
  })
  await simpleDataset('title.crew', row => {
    const item = db.prepare(`SELECT item_id FROM catalog_item_external_ids WHERE source='imdb' AND external_id=?`).get(row.tconst) as { item_id: number } | undefined
    if (!item) return
    for (const [role, ids] of [['director', value(row.directors)], ['writer', value(row.writers)]] as const) for (const [order, imdbId] of (ids?.split(',') ?? []).entries()) {
      const personId = upsertPersonIdentity(db, { source: 'imdb', externalId: imdbId, name: imdbId })
      credit.run(item.item_id, personId, 'crew', role, role, null, order, `${row.tconst}:${imdbId}:${role}`, role === 'director' ? 1 : 0)
    }
  })

  hooks.progress({ step: 'IMDb names', processed: totalRows, total: null })
  let relevantNames = 0
  const resumedNames = completedSnapshot.get('name.basics', snapshotDate, criteria) as { row_count: number; accepted_count: number } | undefined
  let nameRows: number
  if (resumedNames) {
    nameRows = resumedNames.row_count
    relevantNames = resumedNames.accepted_count
    hooks.progress({ processed: totalRows + nameRows, succeeded: accepted + relevantNames, message: 'Resumed completed name.basics' })
    hooks.log('Resumed completed IMDb names', { rows: nameRows, relevant: relevantNames })
  } else {
    markSnapshotRunning.run('name.basics', `${baseUrl()}/name.basics.tsv.gz`, snapshotDate, criteria)
    hooks.progress({ step: 'Downloading IMDb name.basics', processed: totalRows, total: null, message: 'Preparing local dataset cache' })
    const path = await cachedDataset('name.basics', signal, hooks.log, downloadProgress('name.basics'))
    hooks.progress({ step: 'IMDb names', processed: totalRows, total: null })
    nameRows = await streamTsv(path, signal, batch => db.transaction(() => {
      for (const row of batch) {
        const existing = db.prepare(`SELECT person_id FROM catalog_person_external_ids WHERE source='imdb' AND external_id=?`).get(row.nconst) as { person_id: number } | undefined
        if (!existing) continue
        const name = value(row.primaryName) ?? row.nconst
        db.prepare(`UPDATE catalog_people SET name=?,normalized_name=?,birthday=COALESCE(?,birthday),deathday=COALESCE(?,deathday),known_for_department=COALESCE(?,known_for_department),imdb_id=?,metadata_updated_at=CURRENT_TIMESTAMP WHERE person_id=?`).run(name, normalize(name), year(row.birthYear)?.toString() ?? null, year(row.deathYear)?.toString() ?? null, value(row.primaryProfession)?.split(',')[0] ?? null, row.nconst, existing.person_id)
        db.prepare(`INSERT OR IGNORE INTO catalog_person_aliases(person_id,name,normalized_name,source,is_primary) VALUES(?,?,?,'imdb',1)`).run(existing.person_id, name, normalize(name))
        relevantNames++
      }
    })(), count => hooks.progress({ processed: totalRows + count, succeeded: accepted + relevantNames, message: `${relevantNames.toLocaleString()} relevant people` }))
    recordSnapshot.run('name.basics', `${baseUrl()}/name.basics.tsv.gz`, nameRows, relevantNames, criteria)
    hooks.log('Imported IMDb names', { rows: nameRows, relevant: relevantNames })
  }
  totalRows += nameRows; accepted += relevantNames
  return { rows: totalRows, accepted }
}
