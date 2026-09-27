import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applySchema } from '@archivist/db'
import type { FilterNode } from '@archivist/contracts'
import {
  applyArchivistRating,
  extractArchivistRating,
  withoutArchivistRating,
} from '../src/lists/archivist-rating-filter.js'
import { UnsupportedListFilterError, type ListMemberResult } from '../src/lists/types.js'

/**
 * The Archivist Rating threshold on a List.
 *
 * Every other rule narrows at TMDB; this one is applied afterwards against the
 * library's own scores, so the properties worth pinning are what happens to
 * candidates the library does not hold, and that the rule never reaches TMDB.
 */

const archivist = (min?: number, max?: number): FilterNode =>
  ({ op: 'rating', source: 'archivist', min, max })
const provider: FilterNode = { op: 'rating', source: 'provider', min: 6, minVotes: 100 }
const decade: FilterNode = { op: 'year', min: 1990, max: 1999 }

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  const library = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Films', 'films', 'list-films')").run().lastInsertRowid)
  // The threshold reads the weighted score, not the published rating, so the
  // fixture seeds composite_scores — which is where the weighting lands.
  const film = (title: string, tmdbId: number, weighted: number | null) => {
    const id = Number(db.prepare('INSERT INTO films (library_id, title, tmdb_id, rating) VALUES (?, ?, ?, ?)')
      .run(library, title, tmdbId, weighted).lastInsertRowid)
    if (weighted !== null) {
      db.prepare(`INSERT INTO composite_scores (subject_type, subject_id, score, confidence, weights_hash)
        VALUES ('film', ?, ?, 1, 'test')`).run(id, weighted * 10)
    }
    return id
  }
  film('Pantheon', 10, 9.4)
  film('Very Good', 20, 8.6)
  film('Unscored', 30, null)
  return db
}

const result = (tmdbIds: number[]): ListMemberResult => ({
  members: tmdbIds.map(tmdbId => ({ tmdbId, title: `Film ${tmdbId}`, releaseDate: '1995-01-01' } as never)),
  total: tmdbIds.length,
  capped: false,
  ceilingHit: false,
})

test('an Archivist Rating rule is found through a conjunction', () => {
  assert.deepEqual(extractArchivistRating(archivist(9)), { min: 9, max: undefined })
  assert.deepEqual(
    extractArchivistRating({ op: 'and', nodes: [decade, archivist(9), provider] }),
    { min: 9, max: undefined },
  )
  // Nothing to find is not an error; the List is simply a provider query.
  assert.equal(extractArchivistRating({ op: 'and', nodes: [decade, provider] }), null)
})

test('several thresholds narrow to the tightest', () => {
  assert.deepEqual(
    extractArchivistRating({ op: 'and', nodes: [archivist(7, 10), archivist(9, 9.8)] }),
    { min: 9, max: 9.8 },
  )
})

test('an Archivist Rating rule inside an "any of" or "none of" group is refused', () => {
  // Inside an OR it would be evaluated against candidates that mostly are not
  // in the library, and a negation would read as true for every title the
  // library has never seen. Refusing says so instead of guessing.
  assert.throws(
    () => extractArchivistRating({ op: 'or', nodes: [decade, archivist(9)] }),
    UnsupportedListFilterError,
  )
  assert.throws(
    () => extractArchivistRating({ op: 'not', node: archivist(9) }),
    UnsupportedListFilterError,
  )
  assert.throws(
    () => extractArchivistRating({ op: 'and', nodes: [decade, { op: 'or', nodes: [provider, archivist(9)] }] }),
    UnsupportedListFilterError,
  )
})

test('the rule is stripped before the provider ever sees it', () => {
  // TMDB has never heard of the Archivist Rating; sending it would either be
  // ignored or mistaken for a vote average.
  assert.deepEqual(withoutArchivistRating({ op: 'and', nodes: [decade, archivist(9)] }), decade)
  assert.deepEqual(
    withoutArchivistRating({ op: 'and', nodes: [decade, archivist(9), provider] }),
    { op: 'and', nodes: [decade, provider] },
  )
  // A rule with nothing else left tells the caller there is no provider query.
  assert.equal(withoutArchivistRating(archivist(9)), null)
})

test('only candidates that can be scored, and score in range, survive', async () => {
  const db = fixture()
  const narrowed = await applyArchivistRating(result([10, 20, 30, 40]), 'film', { min: 9 }, db)

  // 10 clears it. 20 is below. 30 is held but unscored, and 40 is not held at
  // all — an absent score satisfies no threshold, in either direction.
  assert.deepEqual(narrowed.members.map(entry => entry.tmdbId), [10])
  assert.equal(narrowed.total, 1)
  assert.match(narrowed.warning ?? '', /3 of 4 provider matches scored outside the range or could not be scored/)
  db.close()
})

test('a maximum bounds the other end', async () => {
  const db = fixture()
  const narrowed = await applyArchivistRating(result([10, 20]), 'film', { min: 8, max: 9 }, db)
  assert.deepEqual(narrowed.members.map(entry => entry.tmdbId), [20])
  db.close()
})

test('nothing is set aside when everything qualifies, and the warning stays quiet', async () => {
  const db = fixture()
  const narrowed = await applyArchivistRating(result([10, 20]), 'film', { min: 8 }, db)
  assert.deepEqual(narrowed.members.map(entry => entry.tmdbId), [10, 20])
  assert.equal(narrowed.warning, undefined)
  db.close()
})

test('the same title in two libraries is judged by its better score', async () => {
  const db = fixture()
  const second = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Kids', 'films', 'list-kids')").run().lastInsertRowid)
  const id = Number(db.prepare('INSERT INTO films (library_id, title, tmdb_id, rating) VALUES (?, ?, ?, ?)')
    .run(second, 'Very Good', 20, 9.2).lastInsertRowid)
  db.prepare(`INSERT INTO composite_scores (subject_type, subject_id, score, confidence, weights_hash)
    VALUES ('film', ?, 92, 1, 'test')`).run(id)

  const narrowed = await applyArchivistRating(result([20]), 'film', { min: 9 }, db)
  assert.deepEqual(narrowed.members.map(entry => entry.tmdbId), [20])
  db.close()
})
