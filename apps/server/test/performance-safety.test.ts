import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { EventEmitter } from 'node:events'

const dir = mkdtempSync(join(tmpdir(), 'archivist-performance-'))
const media = join(dir, 'media'), quarantine = join(dir, 'quarantine')
mkdirSync(media); mkdirSync(quarantine)
process.env.ARCHIVIST_DB = join(dir, 'test.sqlite')
process.env.ARCHIVIST_MEDIA_BASE = media
process.env.ARCHIVIST_QUARANTINE_DIR = quarantine
const probe = join(dir, 'probe.cjs'), calls = join(dir, 'calls')
writeFileSync(probe, `#!/usr/bin/env node
const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)},'x');
if(process.argv.at(-1).includes('failed'))process.exit(1);
setTimeout(()=>process.stdout.write(JSON.stringify({format:{duration:'10',format_name:'matroska'},streams:[{index:0,codec_type:'video',codec_name:'h264',width:1920,height:1080},{index:1,codec_type:'audio',codec_name:'aac',channels:2}],chapters:[]})),150);
`)
chmodSync(probe, 0o755)
process.env.ARCHIVIST_FFPROBE_PATH = probe
const { initDb } = await import('../src/db.js')
const db = initDb(process.env.ARCHIVIST_DB)
const { closeAllDatabases } = await import('@archivist/db')
const { probeMedia, runMediaCommand } = await import('../src/shared/media-probe.js')
const { managedMediaFile } = await import('../src/shared/managed-media.js')
const { verifiedMove } = await import('../src/shared/verified-move.js')
const { enqueue, cancelJob, claimOptimiseJob, queueStats, recoverReplacement } = await import('../src/tools/video-engine/queue.js')
const { SseBus } = await import('../src/system/sse.js')
const { loadConfig } = await import('../src/config.js')
const { acquireMediaSlot } = await import('../src/shared/media-resources.js')
const { PieceManager } = await import('../../../packages/torrent-engine/src/piece-manager.js')

after(() => { closeAllDatabases(); rmSync(dir, { recursive: true, force: true }) })

test('shared probe is nonblocking, deduplicated and invalidated by file identity', async () => {
  const file = join(media, 'probe.mkv'); writeFileSync(file, 'original')
  let timerFired = false
  const pending = Promise.all([probeMedia(file), probeMedia(file)])
  await new Promise<void>(resolve => setTimeout(() => { timerFired = true; resolve() }, 20))
  assert.equal(timerFired, true)
  const [a, b] = await pending
  assert.equal(a.format.duration, '10'); assert.deepEqual(a, b)
  assert.equal(readFileSync(calls, 'utf8').length, 1)
  await probeMedia(file); assert.equal(readFileSync(calls, 'utf8').length, 1)
  writeFileSync(file, 'replacement with changed size')
  await probeMedia(file); assert.equal(readFileSync(calls, 'utf8').length, 2)
})

test('subprocess timeout and cancellation terminate abandoned work', async () => {
  await assert.rejects(runMediaCommand(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], 20))
  const controller = new AbortController()
  const pending = runMediaCommand(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], 10_000, controller.signal)
  controller.abort(); await assert.rejects(pending)
})

test('processing rejects directories and symlinks outside managed roots', async () => {
  const outside = join(dir, 'outside.mkv'); writeFileSync(outside, 'original')
  const link = join(media, 'escape.mkv'); symlinkSync(outside, link)
  await assert.rejects(managedMediaFile(link), /permitted roots/)
  await assert.rejects(managedMediaFile(media), /regular file/)
  assert.ok('error' in await enqueue({ kind: 'path', inputPath: link, action: 'remux' }))
})

test('file finalisation refuses collisions and leaves the source intact', async () => {
  const source = join(media, 'source'), target = join(media, 'target')
  writeFileSync(source, 'original'); writeFileSync(target, 'existing')
  await assert.rejects(verifiedMove(source, target))
  assert.equal(readFileSync(source, 'utf8'), 'original'); assert.equal(readFileSync(target, 'utf8'), 'existing')
  const destination = join(media, 'destination')
  await verifiedMove(source, destination)
  assert.equal(existsSync(source), false); assert.equal(readFileSync(destination, 'utf8'), 'original')
})

test('a cancellation from the API prevents another process claiming the job', async () => {
  const file = join(media, 'cancel.mkv'); writeFileSync(file, 'original')
  const job = await enqueue({ kind: 'path', inputPath: file, action: 'remux' })
  assert.ok(!('error' in job)); assert.equal(cancelJob(job.id), true)
  const child = join(dir, 'claim.mts')
  writeFileSync(child, `import {initDb} from ${JSON.stringify(new URL('../src/db.ts', import.meta.url).href)};\nimport {claimOptimiseJob} from ${JSON.stringify(new URL('../src/tools/video-engine/queue.ts', import.meta.url).href)};\ninitDb(process.env.ARCHIVIST_DB!);console.log(JSON.stringify(claimOptimiseJob()));`)
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', child], { cwd: process.cwd(), env: process.env })
  assert.equal(result.stdout.trim().split('\n').at(-1), 'null')
  assert.equal(claimOptimiseJob(), null)
})

test('queue counts include jobs outside the history display limit', () => {
  const insert = db.prepare('INSERT INTO video_optimisation_jobs(id,status,priority,job_json) VALUES(?,?,?,?)')
  db.transaction(() => { for (let i = 0; i < 2100; i++) insert.run(`history-${i}`, 'complete', 0, '{}') })()
  assert.equal(queueStats().queued, 1)
})

test('replacement recovery never reports complete after a failed library pointer update', async () => {
  const id = 'recovery', original = join(media, 'original.mp4'), output = join(media, 'original.mkv')
  const saved = join(quarantine, `${id}-original.mp4`)
  writeFileSync(saved, 'original'); writeFileSync(output, 'encoded')
  const job: any = { id, kind: 'film', itemId: 999999, action: 'remux', inputPath: original, outputPath: output, status: 'replacing', priority: 0,
    replacement: { quarantinePath: saved, phase: 'installed' }, createdAt: Date.now(), sizeBefore: 8 }
  await recoverReplacement(job)
  assert.equal(job.status, 'replacing'); assert.match(job.error, /Library path/); assert.equal(readFileSync(saved, 'utf8'), 'original')
  job.kind = 'path'; job.itemId = null
  await recoverReplacement(job)
  assert.equal(job.status, 'complete'); assert.equal(existsSync(saved), true)
})

test('slow SSE consumers are disconnected instead of accumulating writes', () => {
  const bus = new SseBus()
  const response: any = new EventEmitter()
  response.setHeader = () => {}; response.flushHeaders = () => {}; response.write = () => false
  response.destroy = () => { response.destroyed = true; response.emit('close') }
  bus.addClient(response)
  assert.equal(response.destroyed, true); assert.equal(bus.clientCount, 0)
  bus.closeAll()
})

test('invalid legacy encode concurrency fails config validation', () => {
  const old = process.env.MAX_CONCURRENT_ENCODES
  try {
    for (const value of ['0', '-1', 'abc', '1.5', '999']) {
      process.env.MAX_CONCURRENT_ENCODES = value
      assert.throws(() => loadConfig(join(dir, 'absent.toml')), /configuration/)
    }
  } finally { if (old == null) delete process.env.MAX_CONCURRENT_ENCODES; else process.env.MAX_CONCURRENT_ENCODES = old }
})

test('playback admission defers new background work and waiting can be cancelled', async () => {
  const release = await acquireMediaSlot('playback')
  const controller = new AbortController()
  const waiting = acquireMediaSlot('background', controller.signal)
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(waiting)
  release()
  const background = await acquireMediaSlot('background'); background()
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM media_resource_leases').get() as any).n, 0)
})

test('completion counter preserves selective-download and resume transitions', () => {
  const meta: any = { pieces: [Buffer.alloc(20), Buffer.alloc(20)], pieceLength: 16, totalSize: 32, files: [{ sizeBytes: 16 }, { sizeBytes: 16 }] }
  const manager = new PieceManager(meta)
  assert.equal(manager.isComplete(), false)
  manager.restoreFromBitfield(Buffer.from([0x80])); assert.equal(manager.isComplete(), false)
  manager.setPiecePriorities(meta, [true, false], ['normal', 'skip']); assert.equal(manager.isComplete(), true)
  manager.setPiecePriorities(meta, [true, true], ['normal', 'normal']); assert.equal(manager.isComplete(), false)
  manager.restoreFromBitfield(Buffer.from([0xc0])); assert.equal(manager.isComplete(), true)
  manager.restoreFromBitfield(Buffer.from([0xc0])); assert.equal(manager.isComplete(), true)
})

test('simultaneous requests cannot enqueue the same original twice', async () => {
  const file = join(media, 'duplicate.mkv'); writeFileSync(file, 'original')
  const results = await Promise.all(Array.from({ length: 8 }, () => enqueue({ kind: 'path', inputPath: file, action: 'convert' })))
  assert.equal(results.filter(result => !('error' in result)).length, 1)
  db.prepare("DELETE FROM video_optimisation_jobs WHERE json_extract(job_json,'$.inputPath')=?").run(file)
})

test('quality gate rejects missing, failed, timed-out, cancelled and non-finite measurements', async () => {
  const { passesVmaf } = await import('../src/tools/video-engine/vmaf.js')
  for (const status of ['unavailable', 'failed', 'timed-out', 'cancelled'] as const) {
    assert.equal(passesVmaf({ status, score: null }, 90), false)
    assert.equal(passesVmaf({ status, score: 100 }, 90), false)
  }
  for (const score of [null, NaN, Infinity, 89]) assert.equal(passesVmaf({ status: 'measured', score }, 90), false)
  assert.equal(passesVmaf({ status: 'measured', score: 90 }, 90), true)
})

test('a delayed media probe does not delay an unrelated HTTP health request', async () => {
  const { createServer } = await import('node:http')
  const file = join(media, 'http-probe.mkv'); writeFileSync(file, 'original')
  let finished = false
  const server = createServer(async (req, res) => {
    if (req.url === '/probe') { await probeMedia(file); finished = true }
    res.end('ok')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  try {
    const slow = fetch(`${base}/probe`)
    await new Promise(resolve => setTimeout(resolve, 20))
    const health = await fetch(`${base}/health`)
    assert.equal(await health.text(), 'ok'); assert.equal(finished, false)
    await (await slow).text()
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('normalised acquisition hash lookup uses expression indexes', () => {
  for (const table of ['films', 'episodes']) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM ${table} WHERE LOWER(info_hash) IN (?,?)`).all('abc', 'def') as Array<{ detail: string }>
    assert.ok(plan.some(row => row.detail.includes(`idx_${table}_normalized_hash`)))
  }
})

test('API cancellation stops an encoding subprocess owned by another process', async () => {
  const { spawn } = await import('node:child_process')
  const file = join(media, 'active-cancel.mp4'); writeFileSync(file, 'original')
  const marker = join(dir, 'encoding-started')
  const encoder = join(dir, 'encoder.cjs')
  writeFileSync(encoder, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('-encoders')) { console.log('V..... h264_nvenc'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
setInterval(()=>process.stdout.write('out_time_ms=1000000\\n'),100);
`)
  chmodSync(encoder, 0o755)
  const job = await enqueue({ kind: 'path', inputPath: file, action: 'remux' })
  assert.ok(!('error' in job))
  const childFile = join(dir, 'worker.mts')
  writeFileSync(childFile, `import {initDb} from ${JSON.stringify(new URL('../src/db.ts', import.meta.url).href)};
import {startExecutionEngine,stopExecutionEngine} from ${JSON.stringify(new URL('../src/tools/video-engine/queue.ts', import.meta.url).href)};
initDb(process.env.ARCHIVIST_DB!);
process.on('SIGTERM',async()=>{await stopExecutionEngine();process.exit(0)});
await startExecutionEngine();setInterval(()=>{},1000);`)
  const child = spawn(process.execPath, ['--import', 'tsx', childFile], { env: { ...process.env, ARCHIVIST_FFMPEG_PATH: encoder }, stdio: 'ignore' })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000
    while (!predicate()) { assert.ok(Date.now() < deadline, 'worker did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 25)) }
  }
  try {
    await waitFor(() => existsSync(marker))
    assert.equal(cancelJob(job.id), true)
    await waitFor(() => (db.prepare('SELECT status FROM video_optimisation_jobs WHERE id=?').get(job.id) as any)?.status === 'cancelled')
    assert.equal(readFileSync(file, 'utf8'), 'original')
    const pid = Number(readFileSync(marker, 'utf8'))
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally { child.kill('SIGTERM'); await exited }
})

test('cross-filesystem replacement keeps the event loop responsive and verifies bytes', async context => {
  const { stat, writeFile, readFile } = await import('node:fs/promises')
  const destinationDir = mkdtempSync(resolve('.performance-copy-'))
  try {
    if ((await stat(destinationDir)).dev === (await stat(media)).dev) { context.skip('workspace and temporary media share a filesystem'); return }
    const file = join(media, 'cross-device.bin'), destination = join(destinationDir, 'copied.bin')
    const payload = Buffer.alloc(32 * 1024 * 1024, 0xa5)
    await writeFile(file, payload)
    let ticks = 0
    const heartbeat = setInterval(() => { ticks++ }, 1)
    try { await verifiedMove(file, destination) } finally { clearInterval(heartbeat) }
    assert.ok(ticks > 0, 'worker heartbeat must run during cross-device copy')
    assert.deepEqual(await readFile(destination), payload)
    assert.equal(existsSync(file), false)
  } finally { rmSync(destinationDir, { recursive: true, force: true }) }
})

test('quarantine restore retries the pointer commit without losing the restored original', async () => {
  const { listQuarantine, restoreQuarantine } = await import('../src/tools/video-engine/queue.js')
  const entry = listQuarantine().find(item => item.jobId === 'recovery')!
  assert.ok(entry)
  const stored = JSON.parse((db.prepare('SELECT job_json FROM video_optimisation_jobs WHERE id=?').get('recovery') as any).job_json)
  stored.kind = 'film'; stored.itemId = 999999
  db.prepare('UPDATE video_optimisation_jobs SET job_json=? WHERE id=?').run(JSON.stringify(stored), 'recovery')
  await assert.rejects(restoreQuarantine(entry.id), /pointer/)
  assert.equal(readFileSync(entry.originalPath, 'utf8'), 'original')
  assert.ok(listQuarantine().some(item => item.id === entry.id))
  stored.kind = 'path'; stored.itemId = null
  db.prepare('UPDATE video_optimisation_jobs SET job_json=? WHERE id=?').run(JSON.stringify(stored), 'recovery')
  assert.equal(await restoreQuarantine(entry.id), true)
  assert.equal(readFileSync(entry.originalPath, 'utf8'), 'original')
  assert.equal(listQuarantine().some(item => item.id === entry.id), false)
})
