import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applySchema } from '@archivist/db'
import { resolveCandidateScores } from '../src/lists/candidate-scores.js'
import type { ListMember } from '../src/lists/types.js'

/**
 * How a List candidate is scored.
 *
 * The point of the weighted score here is that it exists for titles nobody
 * owns, so these cover the cheap paths — the library, the cache — and that a
 * lookup is never repeated once it has an answer, including a negative one.
 * The network paths are exercised by the budget arithmetic rather than by
 * calling OMDb.
 */

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  const library = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Films', 'films', 'cand-films')").run().lastInsertRowid)
  return { db, library }
}

const member = (tmdbId: number, providerRating?: number, providerVotes?: number): ListMember =>
  ({ mediaType: 'film', tmdbId, title: `Film ${tmdbId}`, providerRating, providerVotes })

test('a title the library holds is scored from its computed weighting, not refetched', async () => {
  const { db, library } = fixture()
  const id = Number(db.prepare('INSERT INTO films (library_id, title, tmdb_id) VALUES (?, ?, ?)')
    .run(library, 'Held', 10).lastInsertRowid)
  db.prepare(`INSERT INTO composite_scores (subject_type, subject_id, score, confidence, weights_hash)
    VALUES ('film', ?, 94, 1, 'test')`).run(id)

  const { scores, deferred } = await resolveCandidateScores([member(10)], 'film', db)
  assert.equal(scores.get(10), 9.4)
  assert.equal(deferred, 0)
  // Nothing was written to the candidate cache: the library already knew.
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM list_candidate_ratings').get() as any).n, 0)
  db.close()
})

test('a cached candidate is scored without a lookup', async () => {
  const { db } = fixture()
  db.prepare(`INSERT INTO list_candidate_ratings (media_type, tmdb_id, imdb_id, ratings, outcome)
    VALUES ('film', 20, 'tt20', ?, 'scored')`)
    .run(JSON.stringify({ imdb: { score: 8, votes: 500_000 }, metacritic: 74, rottenTomatoes: 85 }))

  const { scores } = await resolveCandidateScores([member(20)], 'film', db)
  // (45x80 + 25x74 + 20x85) / 90 weight present, renormalised.
  const score = scores.get(20)
  assert.ok(score != null && score > 7.9 && score < 8.2, `expected ~8.0, got ${score}`)
  db.close()
})

test("TMDB's own vote rides along free and is folded in", async () => {
  const { db } = fixture()
  const ratings = JSON.stringify({ imdb: { score: 8, votes: 500_000 } })
  db.prepare("INSERT INTO list_candidate_ratings (media_type, tmdb_id, ratings, outcome) VALUES ('film', 30, ?, 'scored')").run(ratings)
  db.prepare("INSERT INTO list_candidate_ratings (media_type, tmdb_id, ratings, outcome) VALUES ('film', 31, ?, 'scored')").run(ratings)

  const withoutTmdb = await resolveCandidateScores([member(30)], 'film', db)
  const withTmdb = await resolveCandidateScores([member(31, 10, 5_000)], 'film', db)

  // IMDb alone renormalises to 8.0; a perfect TMDB score at a tenth of the
  // weight pulls it up without dominating it.
  assert.equal(withoutTmdb.scores.get(30), 8)
  const blended = withTmdb.scores.get(31)
  assert.ok(blended != null && blended > 8 && blended < 8.5, `expected between 8 and 8.5, got ${blended}`)
  db.close()
})

test('a lookup that found nothing is remembered, not retried', async () => {
  const { db } = fixture()
  for (const outcome of ['unknown-to-omdb', 'no-imdb-id', 'no-scores']) {
    db.prepare("INSERT INTO list_candidate_ratings (media_type, tmdb_id, ratings, outcome) VALUES ('film', ?, '{}', ?)")
      .run(40 + ['unknown-to-omdb', 'no-imdb-id', 'no-scores'].indexOf(outcome), outcome)
  }
  // No OMDb key is configured in the test environment, so any attempt to fetch
  // would be reported as deferred. Nothing is, because all three are answered.
  const { scores, deferred } = await resolveCandidateScores([member(40), member(41), member(42)], 'film', db)
  assert.equal(scores.size, 0)
  assert.equal(deferred, 0)
  db.close()
})

test('with no OMDb key, unknown candidates are deferred rather than dropped silently', async () => {
  const { db } = fixture()
  const previous = process.env.OMDB_API_KEY
  delete process.env.OMDB_API_KEY
  try {
    const { scores, deferred } = await resolveCandidateScores([member(50), member(51)], 'film', db)
    assert.equal(scores.size, 0)
    // Deferred, not judged: the caller reports them as pending, not excluded.
    assert.equal(deferred, 2)
  } finally {
    if (previous !== undefined) process.env.OMDB_API_KEY = previous
  }
  db.close()
})

test('only a candidate that actually cost a call is billed to the budget', () => {
  const { db } = fixture()
  // A score taken from a Catalogue payload cost nothing and must not be
  // counted, or a library with a full Catalogue would exhaust a budget it
  // never spent. This is the query spentToday() runs against the live database.
  db.prepare("INSERT INTO list_candidate_ratings (media_type, tmdb_id, ratings, outcome) VALUES ('film', 60, '{}', 'catalogue-payload')").run()
  db.prepare("INSERT INTO list_candidate_ratings (media_type, tmdb_id, ratings, outcome) VALUES ('film', 61, '{}', 'scored')").run()
  db.prepare("INSERT INTO list_candidate_ratings (media_type, tmdb_id, ratings, outcome) VALUES ('film', 62, '{}', 'unknown-to-omdb')").run()
  // A lookup from a week ago is outside the rolling day.
  db.prepare("INSERT INTO list_candidate_ratings (media_type, tmdb_id, ratings, outcome, fetched_at) VALUES ('film', 63, '{}', 'scored', datetime('now', '-7 days'))").run()

  const billed = db.prepare(`
    SELECT COUNT(*) AS n FROM list_candidate_ratings
    WHERE outcome != 'catalogue-payload' AND fetched_at > datetime('now', '-1 day')
  `).get() as { n: number }
  // The scored one and the one OMDb had never heard of; both cost a call.
  assert.equal(billed.n, 2)
  db.close()
})
