#!/usr/bin/env node
/**
 * Walks the RSS acquisition path for one episode and reports the first gate
 * that drops it.
 *
 * A release has to survive, in order: the indexer feed being polled at all, the
 * per-indexer publish-date watermark, title identification, the monitored /
 * aired / wanted checks in `decideSeries`, and finally quality scoring. Only
 * the last of those writes an `acquisition_decisions` row, so everything
 * earlier is invisible from the Acquisitions drawer — which is what this
 * script is for.
 *
 *   node scripts/diagnose-rss.mjs "Lanterns" S01E06 [path/to/archivist.sqlite]
 */

import path from 'node:path'
import { createRequire } from 'node:module'

// Resolved from the server workspace: the repo root does not depend on
// better-sqlite3 itself.
const require = createRequire(path.join(import.meta.dirname, '../apps/server/package.json'))
const Database = require('better-sqlite3')

const [, , rawTitle, rawEpisode, rawDb] = process.argv
if (!rawTitle || !rawEpisode) {
  console.error('usage: node scripts/diagnose-rss.mjs "<series title>" S01E06 [db path]')
  process.exit(2)
}
const match = /^s(\d{1,3})e(\d{1,4})$/i.exec(rawEpisode.trim())
if (!match) {
  console.error(`Not an episode reference: ${rawEpisode}`)
  process.exit(2)
}
const seasonNumber = Number(match[1])
const episodeNumber = Number(match[2])

const dbPath = path.resolve(rawDb ?? process.env.ARCHIVIST_DB ?? 'data/archivist.sqlite')
const db = new Database(dbPath, { readonly: true })

const normalize = s => s.toLowerCase()
  .replace(/[‐-―−]/g, '-')
  .replace(/['’‘`´]/g, '')
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ')

const iso = ms => (ms ? new Date(ms).toISOString() : 'never')
const fail = []
const note = []

console.log(`DB: ${dbPath}`)
console.log(`Subject: ${rawTitle} S${seasonNumber}E${episodeNumber}\n`)

// ── 1. Is the episode in the library, and does the title index carry it? ──────
const slug = normalize(rawTitle)
const series = db.prepare(`
  SELECT s.id, s.title, s.year, s.monitored, s.library_id, s.air_time, l.name AS library_name
  FROM series s JOIN libraries l ON l.id = s.library_id
`).all().find(row => normalize(row.title) === slug || normalize(row.title.replace(/\s*\(\d{4}\)\s*$/, '')) === slug)

if (!series) {
  console.log(`✗ no series in any library normalises to "${slug}" — RSS can never identify its releases`)
  process.exit(1)
}
console.log(`series #${series.id} "${series.title}" in "${series.library_name}" (monitored=${series.monitored}, air_time=${series.air_time ?? 'null'})`)
if (series.monitored !== 1) fail.push('series is not monitored — it is left out of the title index entirely')

const episode = db.prepare(`
  SELECT e.id, e.status, e.monitored, e.air_date, e.air_at, e.air_time_source, e.file_path, e.upgrade_allowed,
         se.monitored AS season_monitored
  FROM episodes e
  LEFT JOIN seasons se ON se.series_id = e.series_id AND se.season_number = e.season_number
  WHERE e.series_id = ? AND e.season_number = ? AND e.episode_number = ?
`).get(series.id, seasonNumber, episodeNumber)

if (!episode) {
  console.log(`✗ S${seasonNumber}E${episodeNumber} is not in the library — metadata refresh has not added it yet`)
  console.log('   decideSeries drops every candidate for an episode row it cannot find, silently.')
  process.exit(1)
}
console.log(`episode #${episode.id}: status=${episode.status} monitored=${episode.monitored} season_monitored=${episode.season_monitored} file=${episode.file_path ?? 'none'}`)
console.log(`  air_date=${episode.air_date ?? 'null'} air_at=${episode.air_at ?? 'null'} (${episode.air_time_source ?? 'no source'})`)

// ── 2. The gates decideSeries applies, in its own order ──────────────────────
if (episode.monitored !== 1) fail.push('episode is not monitored')
if (episode.season_monitored !== 1) fail.push(`season ${seasonNumber} is not monitored`)

const now = Date.now()
const hasAired = episode.air_at
  ? Date.parse(String(episode.air_at)) <= now
  : !episode.air_date || String(episode.air_date).slice(0, 10) <= new Date(now).toISOString().slice(0, 10)
if (!hasAired) {
  fail.push(`air time is still in the future (${episode.air_at ?? episode.air_date}) — every candidate is rejected as "not aired yet", and RSS never revisits a release it has already seen`)
}

const hasLocalFile = typeof episode.file_path === 'string' && episode.file_path.trim().length > 0
const wanted = (!hasLocalFile && (episode.status === 'wanted' || episode.status === 'missing'))
  || (episode.status === 'collected' && (episode.upgrade_allowed ?? 1) !== 0)
if (!wanted) fail.push(`status "${episode.status}" is not acquirable (wanted/missing, or collected with upgrades on)`)

// ── 3. The post-air scheduler ────────────────────────────────────────────────
const searchState = db.prepare('SELECT * FROM new_release_search_state WHERE episode_id = ?').get(episode.id)
if (!episode.air_at) {
  fail.push('air_at is NULL — the episode is excluded from new_release_search_state, so it gets no forced RSS refresh and no targeted search; only the 15-minute feed poll and the once-a-day backlog can find it')
} else if (!searchState) {
  fail.push('air_at is set but there is no new_release_search_state row — the scheduler has not synced it')
} else {
  console.log(`\nrelease window: phase=${searchState.phase} rss_attempts=${searchState.rss_attempts} targeted_attempts=${searchState.targeted_attempts}`)
  console.log(`  next_run_at=${iso(searchState.next_run_at)} last_run_at=${iso(searchState.last_run_at)}`)
  if (searchState.last_result) console.log(`  last_result: ${searchState.last_result}`)
  if (searchState.last_error) console.log(`  last_error: ${searchState.last_error}`)
  if (searchState.phase === 'backlog') note.push('the 24h targeted window has expired; this episode now waits on Search Missing (1 item/day at 03:00, and anything released in the last 72h is excluded)')
}

// ── 4. Indexer feed state — is anything actually polling? ────────────────────
console.log('\nRSS feed state per indexer:')
const indexers = db.prepare('SELECT id, name, enabled, settings FROM indexers_ts').all()
const states = new Map(db.prepare('SELECT * FROM indexer_rss_state').all().map(r => [r.indexer_id, r]))
let feedCount = 0
for (const ix of indexers) {
  let rssOn = true
  try {
    const rss = JSON.parse(ix.settings || '{}').rss
    rssOn = rss === undefined || rss === null || rss === true || rss === 'true'
  } catch { rssOn = false }
  const st = states.get(ix.id)
  const eligible = ix.enabled === 1 && rssOn
  if (eligible) feedCount++
  const ahead = st && st.highest_pub_date > now
  console.log(`  ${eligible ? '•' : '·'} ${ix.name}: enabled=${ix.enabled} rss=${rssOn} health=${st?.health ?? 'unknown'}`
    + ` last_success=${iso(st?.last_success_at)} found=${st?.last_releases_found ?? 0} grabbed=${st?.last_releases_grabbed ?? 0}`)
  if (st?.last_error) console.log(`      last_error: ${st.last_error}`)
  if (st) console.log(`      watermark=${iso(st.highest_pub_date)}${ahead ? '  ← AHEAD OF NOW' : ''}`)
  if (ahead) {
    fail.push(`indexer "${ix.name}" has a publish-date watermark in the future (${iso(st.highest_pub_date)}); filterNewReleases drops every release at or below it, so this feed is grabbing nothing until the clock catches up`)
  }
  if (eligible && st?.backoff_until > now) note.push(`"${ix.name}" is backing off until ${iso(st.backoff_until)}`)
}
if (feedCount === 0) fail.push('no enabled indexer has RSS turned on')

// ── 5. Did any candidate reach the scoring stage? ────────────────────────────
const decisions = db.prepare(`
  SELECT release_title, accepted, grabbed, reasons, rejection_reasons, source, created_at
  FROM acquisition_decisions
  WHERE subject_type = 'episode' AND subject_id = ?
  ORDER BY created_at DESC LIMIT 10
`).all(String(episode.id))
console.log(`\nacquisition decisions recorded for this episode: ${decisions.length}`)
for (const d of decisions) {
  console.log(`  [${d.created_at}] ${d.source} accepted=${d.accepted} grabbed=${d.grabbed} — ${d.release_title}`)
  const why = d.accepted ? d.reasons : d.rejection_reasons
  if (why && why !== '[]') console.log(`      ${why}`)
}
if (decisions.length === 0) note.push('no decision rows at all: nothing ever got as far as quality scoring, so the drop happened at one of the gates above, not in the scoring rules')

console.log('\n' + '─'.repeat(72))
if (fail.length === 0) console.log('No blocking gate found — the releases most likely never reached the feed window.')
for (const f of fail) console.log(`BLOCKED: ${f}`)
for (const n of note) console.log(`note: ${n}`)
