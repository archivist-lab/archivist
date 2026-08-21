import { test } from 'node:test'
import assert from 'node:assert/strict'
import { albumProgressFromTorrent, filmMatchesRelease, isComplete, isStale, matchTitle, torrentVideoFiles } from '../src/shared/monitor.js'

// SQLite stores datetime('now') as UTC 'YYYY-MM-DD HH:MM:SS' with no zone.
const sqliteNow = () => new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
const sqliteAgo = (ms: number) => new Date(Date.now() - ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')

test('a fresh timestamp is not stale', () => {
  assert.equal(isStale(sqliteNow(), 30 * 60 * 1000), false)
})

test('a timestamp older than the grace window is stale', () => {
  assert.equal(isStale(sqliteAgo(45 * 60 * 1000), 30 * 60 * 1000), true)
})

test('a timestamp inside the grace window is not stale (no timezone drift)', () => {
  // 20 min old with a 30 min grace — must be false even though SQLite strings
  // carry no zone; a naive local-time parse could be off by hours and flip this.
  assert.equal(isStale(sqliteAgo(20 * 60 * 1000), 30 * 60 * 1000), false)
})

test('null/empty timestamps are never treated as stale', () => {
  assert.equal(isStale(null, 30 * 60 * 1000), false)
  assert.equal(isStale(undefined, 30 * 60 * 1000), false)
  assert.equal(isStale('', 30 * 60 * 1000), false)
})

// ── Torrent file selection ───────────────────────────────────────────────────
// Regression: a single-episode scene release ships extras named after the
// release ("World.War.II...S01E05...Screen0001.png" inside Screens/). Selecting
// the import source by filename alone matched a screenshot, so episodes were
// grabbed but never organised into the series folder.

const ww2Release = {
  name: 'World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE',
  files: [
    { name: 'World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE/Screens/World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE.Screen0001.png', sizeBytes: 480_000 },
    { name: 'World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE/Screens/World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE.Screen0002.png', sizeBytes: 470_000 },
    { name: 'World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE/World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE.mkv', sizeBytes: 2_400_000_000 },
    { name: 'World.War.II.with.Tom.Hanks.S01E05.1080p.x265-ELiTE/release.nfo', sizeBytes: 3_000 },
  ],
}

test('extras are excluded so a single-episode release is not treated as a pack', () => {
  const videos = torrentVideoFiles(ww2Release)
  assert.equal(videos.length, 1, 'screenshots and nfo must not count as episodes')
  assert.match(videos[0].name, /\.mkv$/)
  // files.length > 1 was the old pack test — it would have been true here.
  assert.equal(ww2Release.files.length > 1, true)
})

test('video files are returned largest first and samples dropped', () => {
  const pack = {
    files: [
      { name: 'Show.S01E01.mkv', sizeBytes: 1_000_000_000 },
      { name: 'Sample/Show.S01E01.sample.mkv', sizeBytes: 20_000_000 },
      { name: 'Show.S01E02.mkv', sizeBytes: 3_000_000_000 },
      { name: 'Screens/Show.S01E02.Screen0001.png', sizeBytes: 500_000 },
    ],
  }
  const videos = torrentVideoFiles(pack)
  assert.deepEqual(videos.map(f => f.name), ['Show.S01E02.mkv', 'Show.S01E01.mkv'])

  // The season-pack path selects by SxxEyy within videos only — never a PNG.
  const chosen = videos.find(f => f.name.toLowerCase().includes('s01e02'))
  assert.equal(chosen?.name, 'Show.S01E02.mkv')
})

test('in-progress .part files still count as video', () => {
  const videos = torrentVideoFiles({ files: [{ name: 'Show.S01E01.mkv.part', sizeBytes: 500 }] })
  assert.equal(videos.length, 1)
})

// ── Franchise disambiguation ─────────────────────────────────────────────────
// Regression: the auto-link matched a torrent to a film by naive substring on a
// separator-stripped title. One "Cars" torrent therefore linked to BOTH Cars
// (2006) and Cars 2 (2011) — they shared an info_hash and showed the same
// download progress. Two distinct faults, so both directions are covered.

test('a sequel release does not link to the base film', () => {
  const cars = { title: 'Cars', year: 2006 }
  assert.equal(filmMatchesRelease(cars, 'Cars.2.2011.1080p.BluRay.x265-RARBG'), false)
  assert.equal(filmMatchesRelease(cars, 'Cars.3.2017.1080p.WEB-DL'), false)
})

test('a base-film release does not link to the sequel', () => {
  // "Cars.2006" normalised to "cars2006", which contains "cars2" — so Cars 2
  // claimed a Cars (2006) torrent.
  const cars2 = { title: 'Cars 2', year: 2011 }
  assert.equal(filmMatchesRelease(cars2, 'Cars.2006.1080p.BluRay.x265-RARBG'), false)
  assert.equal(filmMatchesRelease(cars2, 'Cars.2006.REMASTERED.1080p.BluRay'), false)
})

test('each film still links to its own release', () => {
  assert.equal(filmMatchesRelease({ title: 'Cars', year: 2006 }, 'Cars.2006.1080p.BluRay.x265-RARBG'), true)
  assert.equal(filmMatchesRelease({ title: 'Cars 2', year: 2011 }, 'Cars.2.2011.1080p.BluRay.x265-RARBG'), true)
  assert.equal(filmMatchesRelease({ title: 'Cars 3', year: 2017 }, 'Cars 3 (2017) [1080p]'), true)
})

test('a distributor prefix is tolerated when the year pins it down', () => {
  assert.equal(filmMatchesRelease({ title: 'Cars', year: 2006 }, 'Disney.Cars.2006.1080p.BluRay'), true)
  // ...but the same leniency must not admit a sequel.
  assert.equal(filmMatchesRelease({ title: 'Cars', year: 2006 }, 'Disney.Cars.2.2011.1080p.BluRay'), false)
})

test('a one-year drift between metadata and the release tag is tolerated', () => {
  // TMDB festival date vs the scene's release year.
  assert.equal(filmMatchesRelease({ title: 'Parasite', year: 2019 }, 'Parasite.2020.1080p.BluRay'), true)
  assert.equal(filmMatchesRelease({ title: 'Parasite', year: 2019 }, 'Parasite.2023.1080p.BluRay'), false)
})

test('titles containing digits survive the token boundary fix', () => {
  assert.equal(filmMatchesRelease({ title: 'Blade Runner 2049', year: 2017 }, 'Blade.Runner.2049.2017.2160p.UHD'), true)
  assert.equal(filmMatchesRelease({ title: 'Blade Runner', year: 1982 }, 'Blade.Runner.2049.2017.2160p.UHD'), false)
})

test('whole-word matching no longer merges a title into an adjacent year', () => {
  assert.equal(matchTitle('Cars 2', 'Cars 2006 1080p'), false)
  assert.equal(matchTitle('Cars', 'Cars 2006 1080p'), true)
})

test('a film whose title ends in a year links to its own release', () => {
  // parseRelease claims the first 4-digit token as the year, so
  // "Blade.Runner.2049.2017" parses as title "Blade Runner" / year 2049.
  // Without recovery, Blade Runner 2049 would never match its own torrent.
  assert.equal(filmMatchesRelease({ title: 'Blade Runner 2049', year: 2017 }, 'Blade.Runner.2049.2017.2160p.UHD'), true)
})

test('a title that is itself a bare year links correctly', () => {
  // parseRelease used to take the *first* 4-digit token as the year, so
  // "1917.2019.1080p" parsed as title "1917 2019 1080p" / year 1917 and the film
  // never matched. It now takes the last year before the first quality marker.
  assert.equal(filmMatchesRelease({ title: '1917', year: 2019 }, '1917.2019.1080p.BluRay'), true)
  assert.equal(filmMatchesRelease({ title: '2012', year: 2009 }, '2012.2009.1080p.BluRay'), true)
  assert.equal(filmMatchesRelease({ title: '2001 A Space Odyssey', year: 1968 }, '2001.A.Space.Odyssey.1968.1080p'), true)
  // ...and the year still discriminates: 1917 must not claim a 2012 release.
  assert.equal(filmMatchesRelease({ title: '1917', year: 2019 }, '2012.2009.1080p.BluRay'), false)
})

test('a finished download with no per-file detail still counts as complete', () => {
  // A torrent resumed from disk before its metadata rehydrates reports an empty
  // files array. getWantedProgress falls back to overall progress; isComplete
  // used to return false regardless, which stranded finished downloads in the
  // staging folder with the item stuck on "acquiring" and 100% progress.
  const noFileDetail = { status: 'downloading', progress: 1, files: [] } as never
  assert.equal(isComplete(noFileDetail), true)

  const undefinedFiles = { status: 'downloading', progress: 1 } as never
  assert.equal(isComplete(undefinedFiles), true)

  const stillGoing = { status: 'downloading', progress: 0.42, files: [] } as never
  assert.equal(isComplete(stillGoing), false)

  // Per-file detail is still authoritative when present.
  const partial = {
    status: 'downloading',
    progress: 1,
    files: [
      { wanted: true, progress: 1, downloadedBytes: 10, sizeBytes: 10 },
      { wanted: true, progress: 0.5, downloadedBytes: 5, sizeBytes: 10 },
    ],
  } as never
  assert.equal(isComplete(partial), false, 'a wanted file still downloading blocks completion')

  const skippedOnly = {
    status: 'downloading',
    progress: 1,
    files: [{ wanted: false, progress: 0, downloadedBytes: 0, sizeBytes: 10 }],
  } as never
  assert.equal(isComplete(skippedOnly), true, 'nothing wanted, and the torrent is done')

  // Seeding short-circuits, as it always did.
  assert.equal(isComplete({ status: 'seeding', progress: 0.2 } as never), true)
})

test('an album inside a multi-album torrent gets its own share of the progress', () => {
  // A discography is one torrent, so without this every album it contains
  // reports the pack's overall figure and fifty rows read identically.
  const pack = {
    status: 'downloading',
    progress: 0.5,
    files: [
      { name: 'Pack/Alpha Sessions/01 - One.mp3', wanted: true, sizeBytes: 100, downloadedBytes: 100, progress: 1 },
      { name: 'Pack/Alpha Sessions/02 - Two.mp3', wanted: true, sizeBytes: 100, downloadedBytes: 50, progress: 0.5 },
      { name: 'Pack/Beta Horizons/01 - Three.mp3', wanted: true, sizeBytes: 100, downloadedBytes: 0, progress: 0 },
      { name: 'Pack/Beta Horizons/02 - Four.mp3', wanted: true, sizeBytes: 100, downloadedBytes: 0, progress: 0 },
    ],
  } as never

  assert.equal(albumProgressFromTorrent(pack, 'Alpha Sessions'), 0.75)
  assert.equal(albumProgressFromTorrent(pack, 'Beta Horizons'), 0)

  // Punctuation and case differences between the tracklist and the folder are
  // normal, so matching ignores them.
  assert.equal(albumProgressFromTorrent(pack, 'alpha  sessions!'), 0.75)

  // Nothing matched is null, not zero — the caller falls back to the pack total
  // rather than claiming an album has not started.
  assert.equal(albumProgressFromTorrent(pack, 'Gamma Skyline'), null)

  // Deselected files are excluded from the sum.
  const partly = {
    status: 'downloading',
    files: [
      { name: 'Pack/Alpha Sessions/01 - One.mp3', wanted: true, sizeBytes: 100, downloadedBytes: 100, progress: 1 },
      { name: 'Pack/Alpha Sessions/bonus.mp3', wanted: false, sizeBytes: 900, downloadedBytes: 0, progress: 0 },
    ],
  } as never
  assert.equal(albumProgressFromTorrent(partly, 'Alpha Sessions'), 1)

  // A title too short to match safely falls back rather than borrowing another
  // album's files — "Come" would otherwise match "Welcome".
  const ambiguous = {
    status: 'downloading',
    files: [{ name: 'Pack/Welcome Home/01 - Song.mp3', wanted: true, sizeBytes: 100, downloadedBytes: 100, progress: 1 }],
  } as never
  assert.equal(albumProgressFromTorrent(ambiguous, 'Com'), null)

  // A torrent with no per-file detail cannot be split.
  assert.equal(albumProgressFromTorrent({ status: 'downloading', progress: 0.4 } as never, 'Alpha Sessions'), null)
})

test('completion trusts verified bytes over a progress figure', () => {
  // A client has been seen reporting progress 1 on a torrent that had barely
  // started. Acting on that fires an import against an all-but-empty folder,
  // which then fails and — because a failed import is sticky — blocks the real
  // one from ever being queued.
  const lying = { status: 'downloading', progress: 1, sizeBytes: 1_000_000, downloadedBytes: 4_000, files: [] } as never
  assert.equal(isComplete(lying), false, 'four thousand of a million bytes is not complete')

  const genuine = { status: 'downloading', progress: 1, sizeBytes: 1_000_000, downloadedBytes: 1_000_000, files: [] } as never
  assert.equal(isComplete(genuine), true)

  // With no byte counts to consult, progress is all there is.
  assert.equal(isComplete({ status: 'downloading', progress: 1, files: [] } as never), true)
  assert.equal(isComplete({ status: 'downloading', progress: 0.5, files: [] } as never), false)

  // Per-file detail still wins when present, and seeding still short-circuits.
  const detailed = {
    status: 'downloading', progress: 1, sizeBytes: 200, downloadedBytes: 4,
    files: [{ wanted: true, progress: 1, downloadedBytes: 100, sizeBytes: 100 }],
  } as never
  assert.equal(isComplete(detailed), true)
  assert.equal(isComplete({ status: 'seeding', progress: 0, sizeBytes: 10, downloadedBytes: 0 } as never), true)
})

test('an import is deferred while the source holds nothing worth importing', async () => {
  const { hasImportableContent } = await import('../src/services/media-imports.js')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const root = mkdtempSync(join(tmpdir(), 'import-guard-'))

  // The shape a client leaves behind while it is still fetching: folders made,
  // only a metadata file written so far.
  mkdirSync(join(root, 'Album One'), { recursive: true })
  writeFileSync(join(root, 'release.nfo'), 'notes')
  assert.equal(hasImportableContent(root), false, 'metadata alone is not worth importing')

  // Once real content lands, the import may proceed.
  writeFileSync(join(root, 'Album One', '01 - Track.flac'), 'audio')
  assert.equal(hasImportableContent(root), true)

  // A single-file source is importable on its own terms.
  const single = mkdtempSync(join(tmpdir(), 'import-single-'))
  const file = join(single, 'release.flac')
  writeFileSync(file, 'audio')
  assert.equal(hasImportableContent(file), true)

  assert.equal(hasImportableContent(join(root, 'does-not-exist')), false)
})
