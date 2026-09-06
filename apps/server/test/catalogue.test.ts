import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { closeCatalogueDb, initCatalogueDb, resetCatalogueData } from '../src/catalogue-database.js'
import { CatalogueFlowRunner } from '../src/catalogue-runner.js'
import { importImdbDatasets, shouldImportImdbTitle } from '../src/catalogue-imdb.js'
import { migrateLegacyCatalogue } from '@archivist/catalogue'

const root = mkdtempSync(join(tmpdir(), 'archivist-catalogue-'))
process.env.ARCHIVIST_CATALOGUE_DB = join(root, 'films.sqlite')
process.env.ARCHIVIST_CATALOGUE_ARTWORK = join(root, 'artwork')
process.env.ARCHIVIST_CATALOGUE_IMDB_CACHE = join(root, 'imdb')

try {
  const db = initCatalogueDb()
  const runner = new CatalogueFlowRunner(db)

  const imdbTypes = new Set(['movie', 'short', 'tvShort', 'tvSeries', 'tvEpisode'])
  const imdbRow = (titleType: string, startYear: string, genres: string, isAdult = '0') => ({ titleType, startYear, genres, isAdult })
  assert.equal(shouldImportImdbTitle(imdbRow('movie', '1929', 'Drama'), imdbTypes), false, 'pre-1930 titles are excluded')
  assert.equal(shouldImportImdbTitle(imdbRow('movie', '1930', 'Drama'), imdbTypes), true, '1930 is included')
  assert.equal(shouldImportImdbTitle(imdbRow('short', '2026', 'Drama'), imdbTypes), false, 'shorts are excluded')
  assert.equal(shouldImportImdbTitle(imdbRow('tvShort', '2026', 'Drama'), imdbTypes), false, 'TV shorts are excluded')
  assert.equal(shouldImportImdbTitle(imdbRow('tvSeries', '2026', 'Talk-Show'), imdbTypes), false, 'TV talk shows are excluded')
  assert.equal(shouldImportImdbTitle(imdbRow('tvEpisode', '2026', 'Comedy,Talk-Show'), imdbTypes), false, 'talk-show episodes are excluded')
  assert.equal(shouldImportImdbTitle(imdbRow('tvSeries', '2026', 'Documentary'), imdbTypes), true, 'other factual television remains eligible')

  const canonical = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (
    'catalog_metadata','catalog_films','catalog_external_ids','catalog_genres','catalog_genre_aliases',
    'catalog_film_genres','catalog_countries','catalog_film_countries','catalog_companies','catalog_film_companies',
    'catalog_collections','catalog_people','catalog_film_cast','catalog_film_crew','catalog_role_aliases',
    'catalog_person_known_for','catalog_release_type_codes','catalog_release_events','catalog_alternative_titles',
    'catalog_edition_labels','catalog_videos','catalog_keywords','catalog_film_keywords','catalog_watch_providers',
    'catalog_film_watch_availability','catalog_artwork_assets','catalog_artwork_variants',
    'catalog_film_recommendations','catalog_discovery_feeds','catalog_discovery_feed_items','catalog_sync_state'
  )`).all()
  assert.equal(canonical.length, 31, 'all canonical catalogue tables are created')
  assert.equal(runner.listFlows().length, 6)
  for (const indexName of ['idx_catalog_ingest_queue_claim', 'idx_catalog_movie_queue_claim']) {
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(indexName), `${indexName} exists`)
  }
  const graph = runner.flowGraph('integrity-check') as any
  assert.equal(graph.published.version_number, 1)
  assert.deepEqual(graph.published.graph.nodes.map((node: any) => node.type), ['trigger', 'integrity-check'])
  graph.published.graph.nodes[1].label = 'Verify catalogue storage'
  const draft = runner.saveDraft('integrity-check', graph.published.graph) as any
  assert.equal(draft.draft.version_number, 2)
  const published = runner.publishDraft('integrity-check') as any
  assert.equal(published.published.version_number, 2)

  ;(runner as any).ingestMovie({
    id: 101, imdb_id: 'tt0000101', title: 'Catalogue Fixture', original_title: 'Catalogue Fixture',
    release_date: '2026-01-31', adult: false, video: false,
    genres: [{ id: 18, name: 'Drama' }],
    production_countries: [{ iso_3166_1: 'GB', name: 'United Kingdom' }],
    production_companies: [{ id: 77, name: 'Fixture Studio', origin_country: 'GB' }],
    credits: {
      cast: [{ id: 201, name: 'Fixture Actor', order: 0, character: 'Lead' }],
      crew: [
        { id: 202, name: 'Fixture Director', job: 'Director', department: 'Directing' },
        { id: 203, name: 'Fixture Producer', job: 'Executive Producer', department: 'Production' },
      ],
    },
    release_dates: { results: [] }, alternative_titles: { titles: [] }, videos: { results: [] },
    keywords: { keywords: [] }, recommendations: { results: [] }, 'watch/providers': { results: {} },
    images: { posters: [{ file_path: '/fixture.jpg', width: 500, height: 750 }], backdrops: [], logos: [] },
  })

  const film = db.prepare('SELECT * FROM catalog_films WHERE legacy_tmdb_id=101').get() as any
  assert.equal(film.title, 'Catalogue Fixture')
  assert.ok(film.primary_studio_company_id)
  const roles = (db.prepare('SELECT normalized_role FROM catalog_film_crew ORDER BY normalized_role').all() as any[]).map(row => row.normalized_role)
  assert.deepEqual(roles, ['director', 'executive_producer'])
  assert.ok((db.prepare(`SELECT count(*) count FROM catalog_artwork_queue WHERE status='pending'`).get() as any).count >= 1)

  const universalFilm = db.prepare(`SELECT * FROM catalog_items WHERE source='tmdb' AND source_id='101' AND media_type='film'`).get() as any
  assert.equal(universalFilm.canonical_title, 'Catalogue Fixture')
  assert.equal(universalFilm.completeness_status, 'partial')
  assert.equal((db.prepare(`SELECT count(*) count FROM catalog_credits WHERE item_id=? AND role='director'`).get(universalFilm.item_id) as any).count, 1)
  assert.equal((db.prepare(`SELECT count(*) count FROM catalog_credits WHERE item_id=? AND role='executive_producer'`).get(universalFilm.item_id) as any).count, 1)
  assert.equal((db.prepare(`SELECT count(*) count FROM catalog_people WHERE legacy_tmdb_id IN (201,202,203)`).get() as any).count, 3, 'provider identities do not create duplicate people')

  const currentArtwork = db.prepare(`SELECT asset_id FROM catalog_artwork_assets WHERE owner_type='item' AND owner_id=? AND artwork_type='poster'`).get(universalFilm.item_id) as any
  assert.equal((db.prepare(`SELECT count(*) count FROM catalog_artwork_assets WHERE owner_type='film' AND owner_id=?`).get(film.film_id) as any).count, 0, 'film enrichment does not dual-write legacy artwork')
  const legacyArtworkId = Number(db.prepare(`INSERT INTO catalog_artwork_assets(owner_type,owner_id,artwork_type,source,source_asset_id,source_url,language_code,width,height,aspect_ratio,vote_average,vote_count,billing_order,is_selected,selection_reason,file_extension,mime_type,byte_size,local_path,fetched_at)
    SELECT 'film',?,artwork_type,source,source_asset_id,source_url,language_code,width,height,aspect_ratio,vote_average,vote_count,billing_order,is_selected,selection_reason,file_extension,mime_type,321,'/catalogue/legacy-poster.jpg',CURRENT_TIMESTAMP
    FROM catalog_artwork_assets WHERE asset_id=?`).run(film.film_id, currentArtwork.asset_id).lastInsertRowid)
  db.prepare(`INSERT INTO catalog_artwork_queue(asset_id,status) VALUES(?,'pending')`).run(legacyArtworkId)
  db.prepare(`INSERT INTO catalog_artwork_variants(asset_id,variant_name,mime_type,file_extension,byte_size,local_path) VALUES(?,'original','image/jpeg','jpg',321,'/catalogue/legacy-poster.jpg')`).run(legacyArtworkId)
  migrateLegacyCatalogue(db)
  const changesAfterMigration = Number((db.prepare('SELECT total_changes() changes').get() as any).changes)
  const schemaVersionAfterMigration = Number(db.pragma('schema_version', { simple: true }))
  migrateLegacyCatalogue(db)
  assert.equal(Number((db.prepare('SELECT total_changes() changes').get() as any).changes), changesAfterMigration, 'completed catalogue migration performs no repeat writes')
  assert.equal(Number(db.pragma('schema_version', { simple: true })), schemaVersionAfterMigration, 'completed catalogue migration does not rebuild indexes')
  assert.equal((db.prepare(`SELECT count(*) count FROM catalog_artwork_assets WHERE owner_type='film' AND owner_id=?`).get(film.film_id) as any).count, 0, 'legacy artwork ownership is fully migrated')
  const mergedArtwork = db.prepare(`SELECT local_path,byte_size FROM catalog_artwork_assets WHERE asset_id=?`).get(currentArtwork.asset_id) as any
  assert.deepEqual(mergedArtwork, { local_path: '/catalogue/legacy-poster.jpg', byte_size: 321 }, 'downloaded legacy artwork metadata is preserved')
  assert.equal((db.prepare(`SELECT count(*) count FROM catalog_artwork_variants WHERE asset_id=? AND variant_name='original'`).get(currentArtwork.asset_id) as any).count, 1, 'legacy artwork variants are moved to the current asset')
  assert.equal((db.prepare(`SELECT count(*) count FROM catalog_artwork_assets WHERE owner_type='item' AND owner_id=? AND artwork_type='poster' AND source='tmdb' AND source_asset_id='/fixture.jpg'`).get(universalFilm.item_id) as any).count, 1, 'repeated migration does not duplicate artwork')

  ;(runner as any).ingestSeries({
    id: 301, name: 'Catalogue Series', original_name: 'Catalogue Series', first_air_date: '2025-02-01',
    status: 'Returning Series', overview: 'A TV fixture.', poster_path: '/series.jpg', genres: [{ id: 18, name: 'Drama' }],
    production_companies: [{ id: 77, name: 'Fixture Studio', origin_country: 'GB' }], networks: [{ id: 88, name: 'Fixture Network', origin_country: 'GB' }],
    created_by: [{ id: 202, name: 'Fixture Director' }], aggregate_credits: { cast: [{ id: 201, name: 'Fixture Actor', order: 0, roles: [{ character: 'Lead' }] }], crew: [] },
    external_ids: { tvdb_id: 9301, imdb_id: 'tt0000301' }, images: { posters: [], backdrops: [], logos: [] },
    seasons: [], _seasonDetails: [{ show_id: 301, id: 401, name: 'Season 1', season_number: 1, air_date: '2025-02-01', episode_count: 1, episodes: [{ id: 501, name: 'Pilot', overview: 'First episode', season_number: 1, episode_number: 1, air_date: '2025-02-01', runtime: 45 }] }],
  })
  const series = db.prepare(`SELECT * FROM catalog_items WHERE source='tmdb' AND source_id='301' AND media_type='series'`).get() as any
  assert.equal(series.canonical_title, 'Catalogue Series')
  assert.equal((db.prepare(`SELECT count(*) count FROM catalog_seasons WHERE series_item_id=?`).get(series.item_id) as any).count, 1)
  assert.equal((db.prepare(`SELECT count(*) count FROM catalog_episodes WHERE series_item_id=?`).get(series.item_id) as any).count, 1)

  const structural = ['catalog_book_works','catalog_book_editions','catalog_book_series','catalog_book_contributions','catalog_music_artists','catalog_music_artist_members','catalog_music_release_groups','catalog_music_releases','catalog_music_recordings','catalog_music_tracks','catalog_music_works','catalog_music_credits']
  for (const table of structural) assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table), `${table} exists`)
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_imdb_intake_titles'`).get(), 'IMDb intake checkpoint table exists')

  const datasets: Record<string, string> = {
    'title.basics': 'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres\ntt9000001\tmovie\tIntake Fixture\tIntake Fixture\t0\t2026\t\\N\t91\tDrama\n',
    'title.ratings': 'tconst\taverageRating\tnumVotes\ntt9000001\t7.4\t100\n',
    'title.akas': 'titleId\tordering\ttitle\tregion\tlanguage\ttypes\tattributes\tisOriginalTitle\n',
    'title.episode': 'tconst\tparentTconst\tseasonNumber\tepisodeNumber\n',
    'title.principals': 'tconst\tordering\tnconst\tcategory\tjob\tcharacters\n',
    'title.crew': 'tconst\tdirectors\twriters\n',
    'name.basics': 'nconst\tprimaryName\tbirthYear\tdeathYear\tprimaryProfession\tknownForTitles\n',
  }
  const originalFetch = globalThis.fetch
  let datasetFetches = 0
  globalThis.fetch = (async input => {
    datasetFetches++
    const dataset = String(input).split('/').pop()?.replace('.tsv.gz', '') ?? ''
    return new Response(gzipSync(datasets[dataset] ?? ''), { status: 200 })
  }) as typeof fetch
  try {
    const hooks = { progress: () => {}, log: () => {} }
    const firstImport = await importImdbDatasets(db, { mediaTypes: ['movie'], minYear: 1930 }, new AbortController().signal, hooks)
    assert.equal(firstImport.rows, 2)
    assert.equal(datasetFetches, 7, 'each IMDb dataset is downloaded once')
    const secondImport = await importImdbDatasets(db, { mediaTypes: ['movie'], minYear: 1930 }, new AbortController().signal, hooks)
    assert.deepEqual(secondImport, firstImport)
    assert.equal(datasetFetches, 7, 'same-day completed datasets resume without another download')
    db.prepare(`UPDATE catalog_ingest_queue SET status='done',done_at=CURRENT_TIMESTAMP WHERE source='enrichment' AND source_id='tt9000001'`).run()
    db.prepare(`UPDATE catalog_imdb_snapshots SET snapshot_date=date('now','-1 day')`).run()
    await importImdbDatasets(db, { mediaTypes: ['movie'], minYear: 1930 }, new AbortController().signal, hooks)
    const retained = db.prepare(`SELECT status FROM catalog_ingest_queue WHERE source='enrichment' AND source_id='tt9000001'`).get() as any
    assert.equal(retained.status, 'done', 'a later IMDb snapshot does not reopen completed provider enrichment')
  } finally {
    globalThis.fetch = originalFetch
  }

  const runId = runner.run('integrity-check', 'test')
  for (let attempt = 0; attempt < 100; attempt++) {
    const run = db.prepare('SELECT status FROM catalog_flow_runs WHERE run_id=?').get(runId) as any
    if (['completed', 'failed', 'cancelled'].includes(run.status)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const run = db.prepare('SELECT status,processed,total FROM catalog_flow_runs WHERE run_id=?').get(runId) as any
  assert.deepEqual(run, { status: 'completed', processed: 4, total: 4 })
  const nodeRuns = runner.nodeRuns(runId)
  assert.equal(nodeRuns.length, 2)
  assert.ok(nodeRuns.every(node => node.status === 'completed'))
  assert.ok(runner.logs(runId).length >= 2)
  const apiRunner = new CatalogueFlowRunner(db, { execute: false, recover: false })
  const queuedOnlyRunId = apiRunner.run('resolve-identities', 'api-test')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal((db.prepare('SELECT status FROM catalog_flow_runs WHERE run_id=?').get(queuedOnlyRunId) as any).status, 'queued', 'API-owned Catalogue runners only enqueue work')
  assert.equal(apiRunner.cancel(queuedOnlyRunId), true)
  assert.equal((db.prepare('SELECT status FROM catalog_flow_runs WHERE run_id=?').get(queuedOnlyRunId) as any).status, 'cancelled')
  await apiRunner.stop()
  await runner.stop()
  const interruptedId = Number(db.prepare(`INSERT INTO catalog_flow_runs(flow_key,trigger_type,status) VALUES('integrity-check','test','running')`).run().lastInsertRowid)
  db.prepare(`INSERT INTO catalog_provider_enrichment(item_id,provider,status,attempts,last_error) VALUES(?,'tmdb','failed',1,'temporary provider failure')`).run(universalFilm.item_id)
  db.prepare(`INSERT INTO catalog_ingest_queue(source,entity_type,source_id,reason,status,attempts,done_at) VALUES('enrichment','film','tt0000101','test','done',1,CURRENT_TIMESTAMP)`).run()
  db.prepare(`UPDATE catalog_ingest_queue SET status='processing',locked_at=CURRENT_TIMESTAMP WHERE source='enrichment' AND source_id='tt9000001'`).run()
  db.prepare(`UPDATE catalog_artwork_queue SET status='processing',locked_at=CURRENT_TIMESTAMP WHERE asset_id=(SELECT asset_id FROM catalog_artwork_queue LIMIT 1)`).run()
  const recoveredRunner = new CatalogueFlowRunner(db)
  const recovered = db.prepare('SELECT status,message FROM catalog_flow_runs WHERE run_id=?').get(interruptedId) as any
  assert.equal(recovered.status, 'failed')
  assert.match(recovered.message, /safe to run again/)
  assert.equal((db.prepare(`SELECT status FROM catalog_ingest_queue WHERE source_id='tt9000001'`).get() as any).status, 'failed')
  assert.equal((db.prepare(`SELECT status FROM catalog_ingest_queue WHERE source_id='tt0000101'`).get() as any).status, 'failed', 'partial provider failures are reopened for retry')
  assert.equal((db.prepare(`SELECT status FROM catalog_artwork_queue LIMIT 1`).get() as any).status, 'failed')
  await recoveredRunner.stop()

  // ── Start / Stop / Clear controls ───────────────────────────────────────
  const controlRunner = new CatalogueFlowRunner(db, { execute: false, recover: false })
  assert.equal(controlRunner.isSuspended(), false, 'a fresh catalogue is not suspended')
  controlRunner.setSuspended(true)
  assert.equal(controlRunner.isSuspended(), true, 'suspension is persisted in catalog_settings')
  assert.throws(() => controlRunner.run('integrity-check', 'test'), /stopped/, 'a stopped catalogue refuses new runs')
  const stoppableId = Number(db.prepare(`INSERT INTO catalog_flow_runs(flow_key,trigger_type,status) VALUES('integrity-check','test','queued')`).run().lastInsertRowid)
  assert.equal(controlRunner.activeRunCount(), 1)
  const cancelledAll = await controlRunner.cancelAll(0)
  assert.equal(cancelledAll.cancelled, 1)
  assert.equal(cancelledAll.drained, true)
  assert.equal((db.prepare('SELECT status FROM catalog_flow_runs WHERE run_id=?').get(stoppableId) as any).status, 'cancelled')
  controlRunner.setSuspended(false)
  assert.equal(controlRunner.isSuspended(), false, 'Start lifts the persisted suspension')

  const itemsBefore = Number((db.prepare('SELECT count(*) count FROM catalog_items').get() as any).count)
  assert.ok(itemsBefore > 0, 'the fixture catalogue has rows to clear')
  const customDraft = controlRunner.saveDraft('integrity-check', { nodes: [{ id: 'trigger-1', type: 'trigger', label: 'T', x: 10, y: 10 }], edges: [] })
  assert.ok(customDraft.draft, 'a draft exists before the reset')
  controlRunner.setSuspended(true)
  const summary = resetCatalogueData(db, { deleteArtwork: true })
  controlRunner.ensureFlowGraphs()
  assert.ok(summary.rowsDeleted >= itemsBefore, 'every catalogue row is deleted')
  assert.equal((db.prepare('SELECT count(*) count FROM catalog_items').get() as any).count, 0)
  assert.equal((db.prepare('SELECT count(*) count FROM catalog_people').get() as any).count, 0)
  assert.equal((db.prepare('SELECT count(*) count FROM catalog_flow_runs').get() as any).count, 0, 'run history is cleared')
  assert.equal(controlRunner.isSuspended(), true, 'catalog_settings survives the reset')
  assert.ok(controlRunner.flowGraph('integrity-check').draft, 'flow designs are preserved by default')
  assert.equal(controlRunner.listFlows().length, 6, 'flow definitions are re-seeded')
  assert.ok((db.prepare(`SELECT count(*) count FROM catalog_release_type_codes`).get() as any).count > 0, 'reference seed data is restored')
  resetCatalogueData(db, { resetFlows: true })
  controlRunner.ensureFlowGraphs()
  assert.equal(controlRunner.flowGraph('integrity-check').draft, null, 'resetFlows discards drafts')
  assert.equal(controlRunner.listFlows().length, 6, 'flow definitions come back after a full flow reset')
  await controlRunner.stop()

  console.log('catalogue tests passed')
} finally {
  closeCatalogueDb()
  rmSync(root, { recursive: true, force: true })
}
