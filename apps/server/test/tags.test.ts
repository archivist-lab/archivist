import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applySchema } from '@archivist/db'
import { TAG_FIELDS, matchingIds, syncAllRules, syncRule, syncSubject, tagsForSubject, validateConditions, type TagRule } from '../src/services/tags.js'
import { recomputeSubject, recordProviderScore } from '../src/services/archivist-rating.js'
import { setRating } from '../src/services/ratings.js'

/**
 * Tag rules. The properties that matter are the ones a threshold gets wrong
 * quietly: unrated titles swept in by a "below" test, a hand-applied tag
 * retracted by a sweep, and a tag that never comes off when a score falls.
 */

function fixture() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  const films = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Films', 'films', 'tag-films')").run().lastInsertRowid)
  const shows = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('TV', 'series', 'tag-tv')").run().lastInsertRowid)

  const film = (title: string, rating: number | null, year: number, genres: string[] = []) =>
    Number(db.prepare('INSERT INTO films (library_id, title, rating, year, genres) VALUES (?, ?, ?, ?, ?)')
      .run(films, title, rating, year, JSON.stringify(genres)).lastInsertRowid)

  const ids = {
    pantheon: film('The Masterpiece', 9.4, 1974, ['Drama', 'Crime']),
    nearly: film('Very Good', 8.9, 1995, ['Drama']),
    ordinary: film('Passable', 6.1, 2011, ['Comedy']),
    unrated: film('Unknown Quantity', null, 2024, ['Horror']),
  }
  const seriesId = Number(db.prepare('INSERT INTO series (library_id, title, rating, year, genres) VALUES (?, ?, ?, ?, ?)')
    .run(shows, 'The Great Show', 9.6, 2008, JSON.stringify(['Drama'])).lastInsertRowid)

  const tagId = Number(db.prepare("INSERT INTO tags (name, slug) VALUES ('Pantheon', 'pantheon')").run().lastInsertRowid)
  return { db, ids, seriesId, tagId }
}

function rule(tagId: number, conditions: TagRule['conditions'], mediaTypes: TagRule['mediaTypes'] = ['films', 'series']): TagRule {
  return { id: 1, tagId, name: 'Pantheon', mediaTypes, conditions, enabled: true }
}

test('a threshold matches only what clears it, and never what is unrated', () => {
  const f = fixture()
  const matches = matchingIds({ conditions: [{ field: 'score', operator: 'gte', value: 9 }] }, 'films', f.db)
  assert.deepEqual(matches, [f.ids.pantheon])

  // The unrated film must not be swept in by a "below" test either: it is not
  // a bad film, it is a film nobody has scored.
  const below = matchingIds({ conditions: [{ field: 'score', operator: 'lt', value: 7 }] }, 'films', f.db)
  assert.deepEqual(below, [f.ids.ordinary])
  f.db.close()
})

test('conditions are ANDed, and span media types independently', () => {
  const f = fixture()
  const both = rule(f.tagId, [
    { field: 'score', operator: 'gte', value: 9 },
    { field: 'genre', operator: 'contains', value: 'drama' },
  ])
  assert.deepEqual(matchingIds(both, 'films', f.db), [f.ids.pantheon])
  assert.deepEqual(matchingIds(both, 'series', f.db), [f.seriesId])

  // Narrowing by year excludes the film and leaves the series alone.
  const dated = rule(f.tagId, [
    { field: 'score', operator: 'gte', value: 9 },
    { field: 'year', operator: 'gte', value: 2000 },
  ])
  assert.deepEqual(matchingIds(dated, 'films', f.db), [])
  assert.deepEqual(matchingIds(dated, 'series', f.db), [f.seriesId])
  f.db.close()
})

test('a field the media type does not have matches nothing rather than erroring', () => {
  const f = fixture()
  // Network is a series field; a film rule mentioning it simply matches none.
  const conditions = [{ field: 'network', operator: 'is_set' as const }]
  assert.equal(validateConditions(conditions), null)
  assert.deepEqual(matchingIds({ conditions }, 'films', f.db), [])
  f.db.close()
})

test('a genre match is exact, not a substring of a longer genre', () => {
  const f = fixture()
  const db = f.db
  db.prepare('UPDATE films SET genres = ? WHERE id = ?').run(JSON.stringify(['Romantic Comedy']), f.ids.ordinary)
  assert.deepEqual(matchingIds({ conditions: [{ field: 'genre', operator: 'contains', value: 'Comedy' }] }, 'films', db), [])
  assert.deepEqual(matchingIds({ conditions: [{ field: 'genre', operator: 'contains', value: 'Romantic Comedy' }] }, 'films', db), [f.ids.ordinary])
  f.db.close()
})

test('a rule with no conditions matches nothing', () => {
  const f = fixture()
  // Matching everything would tag an entire library on the way to writing a rule.
  assert.deepEqual(matchingIds({ conditions: [] }, 'films', f.db), [])
  f.db.close()
})

test('a value carrying SQL characters is bound, not interpolated', () => {
  const f = fixture()
  f.db.prepare('UPDATE films SET studio = ? WHERE id = ?').run("O'Brien & Sons 100%", f.ids.ordinary)
  assert.deepEqual(
    matchingIds({ conditions: [{ field: 'studio', operator: 'contains', value: "O'Brien & Sons 100%" }] }, 'films', f.db),
    [f.ids.ordinary],
  )
  // The percent sign is a literal in a rule's value, not a wildcard.
  assert.deepEqual(matchingIds({ conditions: [{ field: 'studio', operator: 'eq', value: '100%' }] }, 'films', f.db), [])
  f.db.close()
})

test('a sweep applies and retracts as titles cross the threshold', () => {
  const f = fixture()
  const pantheon = Number(f.db.prepare(`
    INSERT INTO tag_rules (tag_id, name, media_types, conditions) VALUES (?, 'Pantheon', ?, ?)
  `).run(f.tagId, JSON.stringify(['films']), JSON.stringify([{ field: 'score', operator: 'gte', value: 9 }])).lastInsertRowid)

  assert.deepEqual(syncAllRules(f.db), { added: 1, removed: 0, rules: 1 })
  assert.deepEqual(tagsForSubject('film', f.ids.pantheon, f.db).map(tag => tag.slug), ['pantheon'])

  // It falls below and the tag comes off on the next sweep.
  f.db.prepare('UPDATE films SET rating = 8.2 WHERE id = ?').run(f.ids.pantheon)
  assert.deepEqual(syncAllRules(f.db), { added: 0, removed: 1, rules: 1 })
  assert.deepEqual(tagsForSubject('film', f.ids.pantheon, f.db), [])
  assert.ok(pantheon > 0)
  f.db.close()
})

test('a hand-applied tag survives a sweep that would retract it', () => {
  const f = fixture()
  f.db.prepare("INSERT INTO tag_rules (tag_id, media_types, conditions) VALUES (?, ?, ?)")
    .run(f.tagId, JSON.stringify(['films']), JSON.stringify([{ field: 'score', operator: 'gte', value: 9 }]))

  // Tagged by hand on a film that does not meet the rule at all.
  f.db.prepare("INSERT INTO media_tags (subject_type, subject_id, tag_id, source) VALUES ('film', ?, ?, 'manual')")
    .run(f.ids.ordinary, f.tagId)

  syncAllRules(f.db)
  assert.deepEqual(tagsForSubject('film', f.ids.ordinary, f.db).map(tag => tag.source), ['manual'])
  f.db.close()
})

test('a changed rating retags just that title', () => {
  const f = fixture()
  f.db.prepare("INSERT INTO tag_rules (tag_id, media_types, conditions) VALUES (?, ?, ?)")
    .run(f.tagId, JSON.stringify(['films']), JSON.stringify([{ field: 'score', operator: 'gte', value: 9 }]))

  // The weighted pipeline publishes a rating below the threshold...
  recordProviderScore('film', f.ids.nearly, 'imdb', 8, 500_000, f.db)
  recomputeSubject('film', f.ids.nearly, undefined, f.db)
  assert.deepEqual(tagsForSubject('film', f.ids.nearly, f.db), [])

  // ...and an Archivist Score of 4.75 out of 5 publishes 9.5, which clears it.
  setRating('default', 'film', f.ids.nearly, 4.75, f.db)
  assert.deepEqual(tagsForSubject('film', f.ids.nearly, f.db).map(tag => tag.slug), ['pantheon'])
  f.db.close()
})

test('a disabled rule neither applies nor holds what it applied', () => {
  const f = fixture()
  const ruleRow = rule(f.tagId, [{ field: 'score', operator: 'gte', value: 9 }], ['films'])
  assert.deepEqual(syncRule({ ...ruleRow, enabled: false }, f.db), { added: 0, removed: 0 })
  assert.deepEqual(tagsForSubject('film', f.ids.pantheon, f.db), [])
  f.db.close()
})

test('an unusable comparison is refused with a reason', () => {
  assert.equal(validateConditions([{ field: 'genre', operator: 'gte', value: 3 }]), 'Genre cannot be compared with "gte"')
  assert.equal(validateConditions([{ field: 'score', operator: 'contains', value: 'x' }]), 'A number cannot be compared with "contains"')
  assert.equal(validateConditions([{ field: 'score', operator: 'gte', value: 'nine' }]), '"nine" is not a number')
  assert.equal(validateConditions([{ field: 'nonsense', operator: 'eq', value: 1 }]), 'Unknown field "nonsense"')
  assert.equal(validateConditions([{ field: 'score', operator: 'gte', value: 9 }]), null)
})

test('syncSubject leaves other titles untouched', () => {
  const f = fixture()
  f.db.prepare("INSERT INTO tag_rules (tag_id, media_types, conditions) VALUES (?, ?, ?)")
    .run(f.tagId, JSON.stringify(['films']), JSON.stringify([{ field: 'score', operator: 'gte', value: 9 }]))
  syncSubject('film', f.ids.ordinary, f.db)
  // The qualifying film was not in scope, so it is still untagged.
  assert.deepEqual(tagsForSubject('film', f.ids.pantheon, f.db), [])
  syncSubject('film', f.ids.pantheon, f.db)
  assert.deepEqual(tagsForSubject('film', f.ids.pantheon, f.db).map(tag => tag.slug), ['pantheon'])
  f.db.close()
})

test('every field actually runs against every media type it claims', () => {
  const f = fixture()
  // Compiling a condition proves the shape, not the SQL. A field naming a
  // column its table does not have only fails when someone writes a rule with
  // it, so each one is executed here instead.
  const probe: Record<string, { operator: 'gte' | 'eq' | 'contains'; value: string | number }> = {
    number: { operator: 'gte', value: 1 },
    text: { operator: 'eq', value: 'x' },
    genre: { operator: 'contains', value: 'Drama' },
    boolean: { operator: 'eq', value: 1 },
  }

  for (const [key, field] of Object.entries(TAG_FIELDS)) {
    for (const mediaType of ['films', 'series'] as const) {
      const condition = { field: key, ...probe[field.kind] }
      assert.doesNotThrow(
        () => matchingIds({ conditions: [condition as never] }, mediaType, f.db),
        `${key} on ${mediaType}`,
      )
      // And each one must also survive the is-set form, which takes a different
      // branch of the compiler.
      assert.doesNotThrow(
        () => matchingIds({ conditions: [{ field: key, operator: 'is_set' }] }, mediaType, f.db),
        `${key} is_set on ${mediaType}`,
      )
    }
  }
  f.db.close()
})

test('a series takes the best tier any of its episodes reached', () => {
  const f = fixture()
  const db = f.db
  const season = Number(db.prepare('INSERT INTO seasons (series_id, season_number) VALUES (?, 1)').run(f.seriesId).lastInsertRowid)
  const episode = (number: number, tier: number, path: string | null) =>
    db.prepare(`INSERT INTO episodes (series_id, season_id, season_number, episode_number, title, current_tier, file_path)
      VALUES (?, ?, 1, ?, ?, ?, ?)`).run(f.seriesId, season, number, `E${number}`, tier, path)

  episode(1, 3, '/media/e1.mkv')
  episode(2, 1, '/media/e2.mkv')
  // A missing episode carries no quality and must not set the series' tier.
  episode(3, 0, null)

  // 1 outranks 3, so the series reads as Tier 1.
  assert.deepEqual(matchingIds({ conditions: [{ field: 'tier', operator: 'eq', value: 1 }] }, 'series', db), [f.seriesId])
  assert.deepEqual(matchingIds({ conditions: [{ field: 'tier', operator: 'eq', value: 3 }] }, 'series', db), [])
  // "At most 2" means at least as good as tier 2.
  assert.deepEqual(matchingIds({ conditions: [{ field: 'tier', operator: 'lte', value: 2 }] }, 'series', db), [f.seriesId])
  f.db.close()
})
