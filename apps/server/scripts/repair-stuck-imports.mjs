#!/usr/bin/env node
/**
 * Repair: clear import jobs whose source file is not playable media.
 *
 * A single-episode scene release ships extras named after the release —
 * `Screens/<release>.Screen0001.png`, `.nfo`, subtitle folders. The download
 * monitor used to treat "more than one file" as a season pack and then pick the
 * import source by filename alone, so a screenshot could be selected instead of
 * the video. Those imports sit in `media_imports` as `queued` forever, and
 * because `queueMediaImport` refuses to enqueue a duplicate for the same
 * item+hash, they also *block* the corrected import from ever being queued.
 *
 * The selection bug is fixed in the monitor (see `torrentVideoFiles`). This
 * clears the rows it already created so the monitor can re-queue them properly.
 *
 * Usage:
 *   node scripts/repair-stuck-imports.mjs [--db path] [--apply]
 *
 * Defaults to a dry run; pass --apply to actually delete. Safe to run with the
 * server up (SQLite WAL), but the fixed build must be running first, otherwise
 * the old code simply re-queues the same bad path.
 */
import Database from 'better-sqlite3'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const dbIndex = args.indexOf('--db')
const dbPath = resolve(dbIndex !== -1 ? args[dbIndex + 1] : process.env.ARCHIVIST_DB ?? './data/archivist.sqlite')

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.avi', '.ts', '.m4v'])
const isVideo = name => {
  const clean = String(name).replace(/\.part$/i, '')
  const dot = clean.lastIndexOf('.')
  return dot > 0 && VIDEO_EXTS.has(clean.slice(dot).toLowerCase())
}
/** A directory source is fine — the organiser picks the right file from it. */
const looksLikeFile = name => /\.[a-z0-9]{2,4}$/i.test(String(name))

const db = new Database(dbPath, { readonly: !apply })
console.log(`Database: ${dbPath}`)
console.log(apply ? 'Mode: APPLY (will delete)\n' : 'Mode: dry run (pass --apply to delete)\n')

const rows = db.prepare(`
  SELECT id, media_type, item_id, info_hash, source_path, status, error
  FROM media_imports
  WHERE status IN ('queued', 'running', 'failed')
`).all()

/** The original fault: the import source itself was a screenshot/nfo. */
const nonVideoSource = r => r.source_path && looksLikeFile(r.source_path) && !isVideo(r.source_path)
/**
 * The follow-on fault: source was corrected to the release folder, but the extras
 * inside it were classed "unmatched" and failed the whole plan. `fileRole` now
 * treats images and metadata as extras, so a re-plan succeeds.
 */
const blockedByExtras = r => r.status === 'failed' && /needs review/i.test(r.error ?? '')

const bad = rows.filter(r => nonVideoSource(r) || blockedByExtras(r))

if (bad.length === 0) {
  console.log(`Nothing to repair (${rows.length} pending import(s) checked).`)
  process.exit(0)
}

console.log(`Found ${bad.length} stuck import(s):\n`)
for (const row of bad) {
  const why = nonVideoSource(row) ? 'source is not a video file' : 'failed on unmatched extras'
  console.log(`  #${row.id}  ${row.media_type} item ${row.item_id}  [${row.status}] — ${why}`)
  console.log(`      ${row.source_path}`)
}

if (!apply) {
  console.log('\nDry run — nothing changed. Re-run with --apply to remove these,')
  console.log('then the monitor will re-queue each one from the correct video file.')
  process.exit(0)
}

const deleteImport = db.prepare('DELETE FROM media_imports WHERE id = ?')
const jobs = db.prepare("SELECT id, payload FROM system_jobs WHERE type = 'media-import' AND status IN ('queued','failed')").all()
let removedImports = 0
let removedJobs = 0

db.transaction(() => {
  const badPaths = new Set(bad.map(r => r.source_path))
  for (const row of bad) removedImports += deleteImport.run(row.id).changes
  for (const job of jobs) {
    try {
      const payload = JSON.parse(job.payload || '{}')
      if (payload.sourcePath && badPaths.has(payload.sourcePath)) {
        removedJobs += db.prepare('DELETE FROM system_jobs WHERE id = ?').run(job.id).changes
      }
    } catch { /* unparseable payload — leave it alone */ }
  }
})()

console.log(`\nRemoved ${removedImports} import record(s) and ${removedJobs} queued job(s).`)
console.log('The download monitor will re-queue these on its next pass.')
