import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { Request, Response } from 'express'
import { createLogger } from '@archivist/core'
import { acquireMediaSlot } from '../shared/media-resources.js'
import { buildTranscodeArgs, copiesVideo, type TranscodeOptions } from './media.js'

/**
 * HLS delivery for the compatibility transcode.
 *
 * The progressive transcode — one fragmented-MP4 response piped straight from
 * ffmpeg — plays in Chromium and Firefox and cannot play in Safari. Safari
 * opens a progressive `<video>` by asking for a byte range and expecting a 206;
 * a chunked reply with no `Content-Length` and no `Accept-Ranges` is refused
 * before a frame is decoded, and `empty_moov` fragmented MP4 is an MSE format
 * rather than a progressive one in any case. Since Safari is also the only
 * engine on iOS and iPadOS, that made every transcode on a phone an error.
 *
 * HLS is the way in: Safari plays it natively from a plain `<video src>`, and
 * it is served as ordinary files over ordinary range requests. ffmpeg writes an
 * `event` playlist plus fMP4 segments into a session directory, and the
 * playlist grows as the encode runs. A session is keyed by the file and the
 * exact transcode options, so two viewers on the same stream share one encode.
 *
 * Seeking keeps the shape the progressive path established: the client asks for
 * a manifest at a new `startSec`, which is a different session. Inside the part
 * already encoded, the player seeks natively without touching the server.
 */

const logger = createLogger('PlayerHls')

/** Segment length. Four seconds is Apple's recommendation for VOD-ish content. */
const SEGMENT_SECONDS = 4
/** How long a session with no requests survives before it is torn down. */
const IDLE_TIMEOUT_MS = 60_000
/** How long to wait for ffmpeg to publish a playlist worth returning. */
const MANIFEST_TIMEOUT_MS = 30_000
/** Sessions live under one root so a crash leaves a single directory to clear. */
const ROOT = join(tmpdir(), 'archivist-player-hls')

const configuredSessions = Number(process.env.ARCHIVIST_HLS_SESSIONS ?? 4)
const MAX_SESSIONS = Number.isInteger(configuredSessions) && configuredSessions > 0 ? configuredSessions : 4

interface Session {
  id: string
  key: string
  dir: string
  proc: ChildProcess | null
  release: (() => void) | null
  lastTouched: number
  /** Resolves once the playlist exists and lists at least one segment. */
  ready: Promise<void>
  failed: string | null
  closed: boolean
}

const sessions = new Map<string, Session>()
const byId = new Map<string, Session>()

/** Identifies a session by everything that changes its output. */
function sessionKey(filePath: string, opts: TranscodeOptions): string {
  const parts = [
    filePath, opts.audioIndex ?? '', opts.subtitleIndex ?? '',
    opts.startSec ? Math.floor(opts.startSec) : 0, opts.videoCodec ?? '', opts.audioFilter ?? '',
    copiesVideo(opts) ? 'copy' : 'encode',
  ]
  return createHash('sha1').update(parts.join('\u0000')).digest('hex')
}

/**
 * ffmpeg arguments for an HLS session.
 *
 * The encode itself is whatever the progressive path already decided — the same
 * copy-or-encode choice, the same rate control, the same audio handling — with
 * only the muxer swapped. `buildTranscodeArgs` ends with the output flags, so
 * those are dropped and replaced rather than rebuilt from scratch, which keeps
 * one decision about how to encode instead of two that drift.
 */
function hlsArgs(filePath: string, opts: TranscodeOptions, encode: Parameters<typeof buildTranscodeArgs>[2], dir: string): string[] {
  const base = buildTranscodeArgs(filePath, opts, encode)
  const cut = base.indexOf('-movflags')
  const args = cut === -1 ? base.slice(0, -2) : base.slice(0, cut)
  // Segments have to split on keyframes, so an encode is told to emit one per
  // segment. A stream copy keeps whatever GOP the source already has, and
  // ffmpeg splits on the keyframes it finds.
  if (!args.includes('copy')) {
    args.push('-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`)
  }
  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    // `event` because the playlist grows as the encode runs: a VOD playlist has
    // to be complete before the first byte, which would mean transcoding the
    // whole file before playback could start.
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_flags', 'independent_segments',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(dir, 'seg%05d.m4s'),
    // The transcode always starts at `startSec`, so the playlist's own timeline
    // starts at zero and the client adds the offset back, exactly as the
    // progressive path does.
    '-start_number', '0',
    join(dir, 'index.m3u8'),
  )
  return args
}

/** Waits for the playlist to name at least one segment, or for the encode to fail. */
async function waitForManifest(session: Session): Promise<void> {
  const playlist = join(session.dir, 'index.m3u8')
  const deadline = Date.now() + MANIFEST_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (session.failed) throw new Error(session.failed)
    if (session.closed) throw new Error('Session closed')
    if (existsSync(playlist)) {
      const text = await readFile(playlist, 'utf8').catch(() => '')
      if (text.includes('.m4s')) return
    }
    await new Promise(done => setTimeout(done, 120))
  }
  throw new Error('Timed out waiting for the transcode to start')
}

function destroy(session: Session): void {
  if (session.closed) return
  session.closed = true
  sessions.delete(session.key)
  byId.delete(session.id)
  try { session.proc?.kill('SIGKILL') } catch { /* already gone */ }
  session.release?.()
  session.release = null
  void rm(session.dir, { recursive: true, force: true }).catch(() => {})
}

/** Tears down whatever has not been asked for recently. */
function reap(): void {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS
  for (const session of [...sessions.values()]) {
    if (session.lastTouched < cutoff) {
      logger.debug(`Reaping idle HLS session ${session.id}`)
      destroy(session)
    }
  }
}

const reaper = setInterval(reap, 15_000)
reaper.unref?.()

// Anything under the root at startup belongs to a previous run of this process
// and can never be served again, so it is only taking up disk.
void rm(ROOT, { recursive: true, force: true }).catch(() => {})

/** Every session dies with the process; a stale temp tree helps nobody. */
for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { for (const session of [...sessions.values()]) destroy(session) })
}

async function startSession(
  filePath: string,
  opts: TranscodeOptions,
  encode: Parameters<typeof buildTranscodeArgs>[2],
  ffmpeg: string,
): Promise<Session> {
  const key = sessionKey(filePath, opts)
  const existing = sessions.get(key)
  if (existing && !existing.closed) {
    existing.lastTouched = Date.now()
    return existing
  }

  // Reap before refusing: a viewer who closed a tab should not cost the next
  // one a session.
  if (sessions.size >= MAX_SESSIONS) reap()
  if (sessions.size >= MAX_SESSIONS) throw Object.assign(new Error('Transcode capacity reached'), { status: 503 })

  const id = randomUUID()
  const dir = join(ROOT, id)

  const session: Session = {
    id, key, dir, proc: null, release: null,
    lastTouched: Date.now(), ready: Promise.resolve(), failed: null, closed: false,
  }

  /*
   * `ready` is assigned before the session is published, and covers everything
   * from creating the directory to the playlist naming its first segment. A
   * second viewer arriving mid-start joins this same promise; publishing the
   * session first and filling `ready` in afterwards would hand them a promise
   * that was already resolved and a playlist that did not exist yet.
   */
  session.ready = (async () => {
    await mkdir(dir, { recursive: true })
    session.release = await acquireMediaSlot('playback').catch(() => null)
    if (session.closed) throw new Error('Session closed')

    const args = hlsArgs(filePath, opts, encode, dir)
    const proc = spawn(ffmpeg, args)
    session.proc = proc
    let stderrTail = ''
    proc.stderr.on('data', chunk => {
      stderrTail = String(chunk).slice(-400)
      logger.debug(`hls ffmpeg: ${chunk}`)
    })
    proc.on('error', err => {
      session.failed = String(err)
      logger.error(`HLS transcode failed to start: ${err}`)
    })
    proc.on('close', code => {
      // A clean exit means the encode finished; the segments stay until the
      // session goes idle so the viewer can finish watching them.
      if (code !== 0 && code !== 255) {
        session.failed = stderrTail.trim() || `ffmpeg exited ${code}`
        logger.warn(`HLS transcode ended badly (${code}): ${session.failed}`)
      }
      session.proc = null
      session.release?.()
      session.release = null
    })

    await waitForManifest(session)
  })()
  // Nothing else awaits this copy, and an unobserved rejection would take the
  // process down; every caller goes through `session.ready` itself.
  session.ready.catch(() => {})

  sessions.set(key, session)
  byId.set(id, session)
  return session
}

/**
 * Starts (or joins) a session and serves its playlist.
 *
 * Segment URIs are rewritten to the public route so the client never learns a
 * path on disk, matching how the direct and progressive endpoints behave.
 */
export async function serveHlsManifest(
  filePath: string,
  opts: TranscodeOptions,
  segmentBaseUrl: string,
  res: Response,
  encode: Parameters<typeof buildTranscodeArgs>[2],
  ffmpeg: string,
): Promise<void> {
  let session: Session
  try {
    session = await startSession(filePath, opts, encode, ffmpeg)
  } catch (err: any) {
    const status = err?.status === 503 ? 503 : 500
    if (status === 503) res.setHeader('Retry-After', '5')
    res.status(status).json({ error: err?.message ?? 'Could not start transcode' })
    return
  }

  try {
    await session.ready
  } catch (err: any) {
    destroy(session)
    res.status(500).json({ error: String(err?.message ?? err) })
    return
  }
  if (res.destroyed) return

  session.lastTouched = Date.now()
  const raw = await readFile(join(session.dir, 'index.m3u8'), 'utf8').catch(() => null)
  if (raw == null) { res.status(500).json({ error: 'Playlist unavailable' }); return }

  const base = `${segmentBaseUrl}/${session.id}`
  const body = raw
    .split('\n')
    .map(line => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) {
        // The init segment is named inside an attribute rather than on its own line.
        return line.replace(/URI="([^"]+)"/, (_m, uri: string) => `URI="${base}/${uri.split('/').pop()}"`)
      }
      return `${base}/${trimmed.split('/').pop()}`
    })
    .join('\n')

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
  res.setHeader('Cache-Control', 'no-store')
  res.send(body)
}

/**
 * Serves one segment (or the init fragment) from a live session.
 *
 * Range support is the point of this endpoint existing: Safari asks for ranges
 * and will not play a reply that cannot give them, which is exactly how the
 * progressive path fails there.
 */
export async function serveHlsSegment(sessionId: string, file: string, req: Request, res: Response): Promise<void> {
  const session = byId.get(sessionId)
  if (!session || session.closed) { res.status(404).json({ error: 'Session expired' }); return }
  // The file name comes off the URL, so it is treated as hostile: only the
  // shapes ffmpeg actually writes are served, and the resolved path must still
  // be inside the session directory.
  if (!/^(init\.mp4|seg\d{5}\.m4s)$/.test(file)) { res.status(400).json({ error: 'Bad segment' }); return }
  const target = resolve(session.dir, file)
  if (target !== join(session.dir, file) || !target.startsWith(session.dir + sep)) {
    res.status(400).json({ error: 'Bad segment' })
    return
  }

  session.lastTouched = Date.now()

  // A segment the playlist names can still be mid-write; ffmpeg publishes the
  // playlist entry only once the segment is complete, so a brief miss means the
  // client raced the encoder rather than asked for something that will never
  // exist.
  let info = await stat(target).catch(() => null)
  for (let attempt = 0; !info && attempt < 25; attempt++) {
    await new Promise(done => setTimeout(done, 120))
    info = await stat(target).catch(() => null)
  }
  if (!info) { res.status(404).json({ error: 'Segment unavailable' }); return }

  res.setHeader('Content-Type', file.endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-store')

  const range = req.headers.range
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
  if (match) {
    const size = info.size
    const start = match[1] ? Number(match[1]) : null
    const end = match[2] ? Number(match[2]) : null
    // A suffix range ("bytes=-500") asks for the last N bytes.
    const from = start ?? Math.max(0, size - (end ?? 0))
    const to = start == null ? size - 1 : Math.min(end ?? size - 1, size - 1)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || from >= size) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`)
      res.end()
      return
    }
    res.status(206)
    res.setHeader('Content-Range', `bytes ${from}-${to}/${size}`)
    res.setHeader('Content-Length', String(to - from + 1))
    createReadStream(target, { start: from, end: to }).pipe(res)
    return
  }

  res.setHeader('Content-Length', String(info.size))
  createReadStream(target).pipe(res)
}

/** Test seam: drops every session without waiting for the reaper. */
export function resetHlsSessions(): void {
  for (const session of [...sessions.values()]) destroy(session)
}
