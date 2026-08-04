import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { closeCatalogueDb, initCatalogueDb } from '../src/catalogue-database.js'
import { CatalogueFlowRunner } from '../src/catalogue-runner.js'
import { importImdbDatasets, shouldImportImdbTitle } from '../src/catalogue-imdb.js'

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
  runner.stop()
  const interruptedId = Number(db.prepare(`INSERT INTO catalog_flow_runs(flow_key,trigger_type,status) VALUES('integrity-check','test','running')`).run().lastInsertRowid)
  const recoveredRunner = new CatalogueFlowRunner(db)
  const recovered = db.prepare('SELECT status,message FROM catalog_flow_runs WHERE run_id=?').get(interruptedId) as any
  assert.equal(recovered.status, 'failed')
  assert.match(recovered.message, /safe to run again/)
  recoveredRunner.stop()
  console.log('catalogue tests passed')
} finally {
  closeCatalogueDb()
  rmSync(root, { recursive: true, force: true })
}
