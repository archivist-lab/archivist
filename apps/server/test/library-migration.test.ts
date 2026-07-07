import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'archivist-libmig-'))
const mediaRoot = join(dir, 'media')
process.env.ARCHIVIST_MEDIA_BASE = mediaRoot
process.env.ARCHIVIST_DB = join(dir, 'archivist.sqlite')

// Modules are imported after the env is set so MEDIA_ROOT resolves to the temp dir.
let getDb: any, reconcileTypeAfterChange: any, resolveLibraryRoot: any, getMediaRoot: any, safeDeleteMediaPath: any

function touch(p: string, content = 'x') {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

function makeFilm(root: string, title: string) {
  const folder = join(root, title)
  mkdirSync(folder, { recursive: true })
  touch(join(folder, `${title}.mkv`), 'video')
  touch(join(folder, 'poster.jpg'), 'img')
  return folder
}

before(async () => {
  ;({ getMediaRoot } = await import('../src/shared/media-organizer.js'))
  ;({ getDb } = await import('../src/db.js'))
  const { initDb } = await import('../src/db.js')
  initDb(process.env.ARCHIVIST_DB!)
  ;({ reconcileTypeAfterChange } = await import('../src/shared/library-migration.js'))
  ;({ resolveLibraryRoot, safeDeleteMediaPath } = await import('../src/shared/library-paths.js'))
})

after(() => rmSync(dir, { recursive: true, force: true }))

test('single library resolves to the flat media/<type> root', () => {
  const db = getDb()
  const films = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Films','films','./data/f.db')").run().lastInsertRowid)

  // A film in the flat layout, with real files on disk and stored paths.
  const root = getMediaRoot()
  const folder = makeFilm(join(root, 'films'), 'The Matrix (1999)')
  const filmId = Number(db.prepare(`
    INSERT INTO films (library_id, tmdb_id, title, root_folder_path, file_path, poster_path)
    VALUES (?, 603, 'The Matrix', ?, ?, ?)
  `).run(films, folder, join(folder, 'The Matrix (1999).mkv'), '/media/films/The Matrix (1999)/poster.jpg').lastInsertRowid)
  db.prepare(`INSERT INTO film_editions (film_id, edition_name, file_path, status) VALUES (?, 'Theatrical', ?, 'collected')`)
    .run(filmId, join(folder, 'The Matrix (1999).mkv'))

  assert.equal(resolveLibraryRoot(db, films), join(root, 'films'))
})

test('adding a second library namespaces the first: files move + paths rewrite', () => {
  const db = getDb()
  const root = getMediaRoot()
  // Second films library added.
  db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Kids Films','films','./data/kf.db')").run()

  const results = reconcileTypeAfterChange(db, 'films')
  assert.equal(results.length, 1)
  assert.equal(results[0].changed, true)

  const filmsLib = db.prepare("SELECT id FROM libraries WHERE name='Films'").get() as any
  const kidsLib = db.prepare("SELECT id FROM libraries WHERE name='Kids Films'").get() as any

  // Roots now namespaced
  assert.equal(resolveLibraryRoot(db, filmsLib.id), join(root, 'films', 'films'))
  assert.equal(resolveLibraryRoot(db, kidsLib.id), join(root, 'films', 'kids films'))

  // Files physically moved
  assert.ok(existsSync(join(root, 'films', 'films', 'The Matrix (1999)', 'The Matrix (1999).mkv')))
  assert.ok(!existsSync(join(root, 'films', 'The Matrix (1999)')))

  // DB paths rewritten — filesystem + URL forms + child edition row
  const film = db.prepare("SELECT * FROM films WHERE title='The Matrix'").get() as any
  assert.equal(film.root_folder_path, join(root, 'films', 'films', 'The Matrix (1999)'))
  assert.equal(film.file_path, join(root, 'films', 'films', 'The Matrix (1999)', 'The Matrix (1999).mkv'))
  assert.equal(film.poster_path, '/media/films/films/The Matrix (1999)/poster.jpg')
  const edition = db.prepare('SELECT file_path FROM film_editions WHERE film_id = ?').get(film.id) as any
  assert.equal(edition.file_path, join(root, 'films', 'films', 'The Matrix (1999)', 'The Matrix (1999).mkv'))
})

test('a new film in the second library lands in its namespaced folder', () => {
  const db = getDb()
  const root = getMediaRoot()
  const kidsLib = db.prepare("SELECT id FROM libraries WHERE name='Kids Films'").get() as any
  // The organizer would use resolveLibraryRoot as baseDir:
  assert.equal(resolveLibraryRoot(db, kidsLib.id), join(root, 'films', 'kids films'))
})

test('deleting back to one library collapses to flat + rewrites paths', () => {
  const db = getDb()
  const root = getMediaRoot()
  const kidsLib = db.prepare("SELECT id FROM libraries WHERE name='Kids Films'").get() as any
  db.prepare('DELETE FROM libraries WHERE id = ?').run(kidsLib.id)

  const results = reconcileTypeAfterChange(db, 'films')
  assert.equal(results[0].changed, true)

  // Back to flat
  assert.ok(existsSync(join(root, 'films', 'The Matrix (1999)', 'The Matrix (1999).mkv')))
  assert.ok(!existsSync(join(root, 'films', 'films', 'The Matrix (1999)')))
  const film = db.prepare("SELECT * FROM films WHERE title='The Matrix'").get() as any
  assert.equal(film.root_folder_path, join(root, 'films', 'The Matrix (1999)'))
  assert.equal(film.poster_path, '/media/films/The Matrix (1999)/poster.jpg')

  const filmsLib = db.prepare("SELECT id FROM libraries WHERE name='Films'").get() as any
  assert.equal(resolveLibraryRoot(db, filmsLib.id), join(root, 'films'))
})

test('safeDeleteMediaPath deletes inside the media root but refuses anything outside it', () => {
  const root = getMediaRoot()
  const inside = join(root, 'films', '__delete-me')
  mkdirSync(inside, { recursive: true })
  writeFileSync(join(inside, 'f.txt'), 'x')

  // A sibling outside the media root that must never be touched.
  const outside = join(dir, 'outside-media')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'keep.txt'), 'x')

  assert.equal(safeDeleteMediaPath(inside), true)
  assert.ok(!existsSync(inside))

  assert.equal(safeDeleteMediaPath(outside), false)
  assert.ok(existsSync(outside)) // untouched
  assert.equal(safeDeleteMediaPath(root), false) // never delete the media root itself
  assert.ok(existsSync(root))
  assert.equal(safeDeleteMediaPath(null), false)
})

test('migration is scoped to the affected type only', () => {
  const db = getDb()
  const root = getMediaRoot()
  // A series library with a flat item — must be untouched by films migrations.
  const seriesLib = Number(db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Series','series','./data/s.db')").run().lastInsertRowid)
  const sFolder = join(root, 'series', 'Breaking Bad (2008)')
  mkdirSync(sFolder, { recursive: true })
  db.prepare("INSERT INTO series (library_id, tvdb_id, title, root_folder_path) VALUES (?, 1, 'Breaking Bad', ?)").run(seriesLib, sFolder)

  // Add a 2nd films library again; reconcile films.
  db.prepare("INSERT INTO libraries (name, media_type, db_path) VALUES ('Anime Films','films','./data/af.db')").run()
  reconcileTypeAfterChange(db, 'films')

  const series = db.prepare("SELECT root_folder_path FROM series WHERE title='Breaking Bad'").get() as any
  assert.equal(series.root_folder_path, sFolder) // unchanged
})
