import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FilmSummary, PlayerShelfRow } from '@archivist/contracts'
import { runFilmRow } from '../src/player/type-rows.js'

const now = Date.parse('2026-09-26T12:00:00Z')
const day = 86_400_000
const film = (id: number, over: Partial<FilmSummary> = {}): FilmSummary => ({
  id, type: 'film', libraryId: 1, title: `Film ${id}`, sortTitle: `Film ${id}`, year: 2020, overview: null, posterUrl: null, backdropUrl: null, logoUrl: null,
  runtimeSeconds: null, rating: 7, certification: null, studio: null, releaseDate: null, digitalReleaseDate: null, physicalReleaseDate: null, genres: [],
  status: 'available', hasFile: true, quality: null, addedAt: new Date(now - 10 * day).toISOString(), acquiredAt: null, playback: null, progress: null, ...over,
})
const row = (over: Partial<PlayerShelfRow>): PlayerShelfRow => ({
  id: 'r', source: 'films', label: 'Row', enabled: true, windowField: 'none', windowDays: 90, watchState: 'all', genres: [], minRating: null,
  yearFrom: null, yearTo: null, sort: 'added', sortOrder: 'desc', limit: 18, view: 'poster', dedupeAgainst: [], ...over,
})

test('a recently-added row windows, filters watch state, sorts newest first and caps', () => {
  const films = [
    film(1, { addedAt: new Date(now - 5 * day).toISOString() }),
    film(2, { addedAt: new Date(now - 200 * day).toISOString() }),
    film(3, { addedAt: new Date(now - 1 * day).toISOString(), progress: { positionSeconds: 1, durationSeconds: 1, completed: true, percent: 100, updatedAt: null } }),
    film(4, { addedAt: new Date(now - 2 * day).toISOString() }),
  ]
  const result = runFilmRow(row({ windowField: 'added', watchState: 'unwatched' }), films, now)
  assert.deepEqual(result.map(f => f.id), [4, 1])
  assert.deepEqual(runFilmRow(row({ limit: 1 }), films, now).map(f => f.id), [3])
})

test('an A-Z row sorts by sort title', () => {
  const films = [film(1, { sortTitle: 'Zulu' }), film(2, { sortTitle: 'Alien' })]
  assert.deepEqual(runFilmRow(row({ sort: 'title', sortOrder: 'asc' }), films, now).map(f => f.id), [2, 1])
})
