import test from 'node:test'
import assert from 'node:assert/strict'
import { startTmdbMock } from './helpers.js'
import { discoverMoviesByFilters } from '../src/modules/films/tmdb.js'
import { discoverSeriesByFilters } from '../src/modules/series/tvdb.js'

test('compound film discovery applies title as an AND filter', async () => {
  const mock = await startTmdbMock()
  process.env.TMDB_BASE_URL = mock.url
  process.env.TMDB_API_KEY = 'test-key'
  try {
    const matches = await discoverMoviesByFilters([
      { field: 'title', q: 'Matrix' },
      { field: 'genre', q: 'Science Fiction' },
    ])
    assert.deepEqual(matches.map(item => item.tmdbId), [603])
  } finally {
    delete process.env.TMDB_BASE_URL
    delete process.env.TMDB_API_KEY
    await mock.close()
  }
})

test('compound series discovery applies title as an AND filter using TMDB ids', async () => {
  const mock = await startTmdbMock()
  process.env.TMDB_BASE_URL = mock.url
  process.env.TMDB_API_KEY = 'test-key'
  try {
    const matches = await discoverSeriesByFilters([
      { field: 'title', q: 'Breaking' },
      { field: 'genre', q: 'Drama' },
    ])
    assert.deepEqual(matches.map(item => item.tmdbId), [1396])
  } finally {
    delete process.env.TMDB_BASE_URL
    delete process.env.TMDB_API_KEY
    await mock.close()
  }
})
