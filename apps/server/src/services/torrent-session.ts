/**
 * TorrentStack Session singleton for Archivist.
 * Built-in download engine.
 */

import { resolve } from 'node:path'
import { Session, PieceManager } from '@torrentstack/torrent-engine'
import { type TorrentMetainfo } from '@torrentstack/bittorrent'
import type { SessionSettings } from '@torrentstack/types'
import { registerSessionSendFn } from '@archivist/core'
import { createLogger } from '@archivist/core'
import { recordEvent } from '../system/event-store.js'
import { getDb, isDbInitialised } from '../db.js'
import { signalJobQueued, watchJobQueue } from '../system/job-signal.js'
import { recordMusicSwarmOutcome } from './music-swarm.js'
import { handleTorrentMetadataFailure } from './metadata-fallback.js'

const logger = createLogger('TorrentSession')
const MUSIC_METADATA_TIMEOUT_MS = Math.max(60_000,
  (parseInt(process.env.MUSIC_TORRENT_METADATA_TIMEOUT_MINUTES ?? '5', 10) || 5) * 60_000)

let _session: Session | null = null
let _proxy: Session | null = null
let rpcTimer: ReturnType<typeof setInterval> | null = null
let rpcWakeStop: (() => void) | null = null
let rpcActive = false

function torrentSnapshot(): any[] {
  if (_session) return _session.getAllTorrents() as any[]
  if (!isDbInitialised()) return []
  const row = getDb().prepare('SELECT snapshot FROM torrent_runtime_state WHERE singleton_id=1').get() as { snapshot: string } | undefined
  try { return row ? JSON.parse(row.snapshot) as any[] : [] } catch { return [] }
}

function publishTorrentSnapshot(): void {
  if (!_session || !isDbInitialised()) return
  try {
    getDb().prepare(`
      INSERT INTO torrent_runtime_state(singleton_id,snapshot,updated_at) VALUES(1,?,datetime('now'))
      ON CONFLICT(singleton_id) DO UPDATE SET snapshot=excluded.snapshot,updated_at=excluded.updated_at
    `).run(JSON.stringify(_session.getAllTorrents()))
  } catch (err) {
    logger.warn('Could not publish torrent runtime snapshot:', err instanceof Error ? err.message : String(err))
  }
}

async function executeTorrentCommand(action: string, args: any[]): Promise<unknown> {
  if (!_session) throw new Error('Torrent worker is not ready')
  const session = _session as any
  if (action === 'addTorrent') return session.addTorrent(...args)
  if (action === 'removeTorrent') return session.removeTorrent(...args)
  if (action === 'startTorrent') return session.startTorrent(...args)
  if (action === 'stopTorrent') return session.stopTorrent(...args)
  if (action === 'verifyTorrent') return session.verifyTorrent(...args)
  if (action === 'reannounceTorrent') return session.reannounceTorrent(...args)
  if (action === 'setTorrentPriority') return session.setTorrentPriority(...args)
  if (action === 'setFilePriorities') return session.setFilePriorities(...args)
  if (action === 'finaliseFiles') return session.finaliseFiles(...args)
  if (action === 'reorderTorrents') return session.reorderTorrents(...args)
  throw new Error(`Unsupported torrent worker command: ${action}`)
}

async function pollTorrentCommands(): Promise<void> {
  if (rpcActive || !_session) return
  rpcActive = true
  try {
    publishTorrentSnapshot()
    while (true) {
      const claim = getDb().transaction(() => {
        const row = getDb().prepare("SELECT command_id,action,args FROM torrent_runtime_commands WHERE status='queued' ORDER BY command_id LIMIT 1")
          .get() as { command_id: number; action: string; args: string } | undefined
        if (!row) return null
        const result = getDb().prepare("UPDATE torrent_runtime_commands SET status='running',updated_at=datetime('now') WHERE command_id=? AND status='queued'").run(row.command_id)
        return result.changes === 1 ? row : null
      })
      const row = claim.immediate()
      if (!row) break
      try {
        const result = await executeTorrentCommand(row.action, JSON.parse(row.args) as any[])
        getDb().prepare("UPDATE torrent_runtime_commands SET status='succeeded',result=?,updated_at=datetime('now') WHERE command_id=?")
          .run(JSON.stringify(result ?? null), row.command_id)
      } catch (err) {
        getDb().prepare("UPDATE torrent_runtime_commands SET status='failed',error=?,updated_at=datetime('now') WHERE command_id=?")
          .run(err instanceof Error ? err.message : String(err), row.command_id)
      }
      publishTorrentSnapshot()
    }
  } finally {
    rpcActive = false
  }
}

async function sendTorrentCommand(action: string, args: unknown[], timeoutMs = 30_000): Promise<any> {
  const result = getDb().prepare("INSERT INTO torrent_runtime_commands(action,args,status) VALUES(?,?,'queued')")
    .run(action, JSON.stringify(args))
  const commandId = Number(result.lastInsertRowid)
  // Without this, the worker only notices the queued command on its next
  // rpcTimer tick (was up to 500ms away) — every pause/start/etc. from the API
  // paid that wait even though the actual work is near-instant.
  signalJobQueued(getDb())
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = getDb().prepare('SELECT status,result,error FROM torrent_runtime_commands WHERE command_id=?')
      .get(commandId) as { status: string; result: string | null; error: string | null } | undefined
    if (row?.status === 'succeeded') {
      try { return row.result == null ? undefined : JSON.parse(row.result) } catch { return row.result }
    }
    if (row?.status === 'failed') throw new Error(row.error ?? `Torrent command ${action} failed`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Torrent worker command ${action} timed out`)
}

function torrentProxy(): Session {
  if (_proxy) return _proxy
  const proxy = {
    getAllTorrents: () => torrentSnapshot(),
    getTorrent: (id: string) => torrentSnapshot().find(torrent => torrent.id === id),
    addTorrent: (...args: unknown[]) => sendTorrentCommand('addTorrent', args),
    removeTorrent: (...args: unknown[]) => sendTorrentCommand('removeTorrent', args),
    startTorrent: (...args: unknown[]) => sendTorrentCommand('startTorrent', args),
    stopTorrent: (...args: unknown[]) => sendTorrentCommand('stopTorrent', args),
    verifyTorrent: (...args: unknown[]) => sendTorrentCommand('verifyTorrent', args),
    reannounceTorrent: (...args: unknown[]) => sendTorrentCommand('reannounceTorrent', args),
    setTorrentPriority: (...args: unknown[]) => sendTorrentCommand('setTorrentPriority', args),
    setFilePriorities: (...args: unknown[]) => sendTorrentCommand('setFilePriorities', args),
    finaliseFiles: (...args: unknown[]) => sendTorrentCommand('finaliseFiles', args),
    reorderTorrents: (...args: unknown[]) => sendTorrentCommand('reorderTorrents', args),
  }
  _proxy = proxy as unknown as Session
  return _proxy
}

export function initTorrentRpcClient(): void {
  registerSessionSendFn(async (url, label) => {
    try {
      const id = await (torrentProxy() as any).addTorrent({
        magnetLink: url.startsWith('magnet:') ? url : undefined,
        torrentUrl: url.startsWith('magnet:') ? undefined : url,
        labels: [label],
        metadataFetchTimeoutMs: label === 'archivist-music' ? MUSIC_METADATA_TIMEOUT_MS : undefined,
      })
      return { success: true, message: 'Queued in built-in engine', runtimeTorrentId: String(id), infoHash: torrentSnapshot().find(torrent => torrent.id === id)?.infoHash }
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
}

const BLOCK_SIZE = 16 * 1024;
const STATUS_NEEDED = 0;
const STATUS_HAVE = 2;
const STATUS_SKIPPED = 3;

/**
 * Enhanced PieceManager selection logic to respect file priorities.
 */
function applyPatches() {
  const originalNextRequestBatch = PieceManager.prototype.nextRequestBatch;

  PieceManager.prototype.nextRequestBatch = function(peerId: string, count: number, isChoked: boolean) {
    const self = this as any;
    
    // Check if we have the necessary metadata injected
    if (!self._meta || !self._resume) {
      return originalNextRequestBatch.apply(this, [peerId, count, isChoked]);
    }

    const meta = self._meta as TorrentMetainfo;
    const resume = self._resume;

    const bitfield = self.peerBitfields.get(peerId);
    if (!bitfield) return [];

    // Optimization: check if peer has ANY piece we need
    let hasAny = false;
    for (let i = 0; i < self.neededBf.length; i++) {
      if ((self.neededBf[i] & bitfield[i]) !== 0) {
        hasAny = true;
        break;
      }
    }
    if (!hasAny) return [];

    const allowedFast = self.peerAllowedFast.get(peerId);

    // --- A. End Game Logic ---
    if (self.endGame) {
      const requests: any[] = [];
      for (let i = 0; i < self.pieceCount; i++) {
        if (self.status[i] < STATUS_HAVE && self.peerHasPiece(bitfield, i)) {
          while (requests.length < count) {
            const block = self.nextUnreceivedBlock(i);
            if (block === null) break;
            self.markBlockRequested(i, block);
            requests.push({ pieceIndex: i, offset: block * BLOCK_SIZE, length: self.blockLength(i, block) });
          }
        }
        if (requests.length >= count) return requests;
      }
      return requests;
    }

    // --- B. Partial Pieces (Prioritize finishing what we started) ---
    const partialRequests: any[] = [];
    for (const pieceIndex of self.blocks.keys()) {
      if (self.status[pieceIndex] >= STATUS_HAVE) continue;
      if (isChoked && (!allowedFast || !allowedFast.has(pieceIndex))) continue;
      if (!self.peerHasPiece(bitfield, pieceIndex)) continue;

      while (partialRequests.length < count) {
        const block = self.nextNeededBlock(pieceIndex);
        if (block === null) break;
        self.markBlockRequested(pieceIndex, block);
        partialRequests.push({ pieceIndex, offset: block * BLOCK_SIZE, length: self.blockLength(pieceIndex, block) });
      }
      if (partialRequests.length >= count) return partialRequests;
    }

    // --- C. Prioritized Piece Selection ---
    const pieceCount = self.pieceCount;
    const pieceLength = self.pieceLength;
    const fileCount = meta.files.length;
    const wanted = (resume.wantedFiles && resume.wantedFiles.length > 0) ? resume.wantedFiles : Array(fileCount).fill(true);
    const priorities = (resume.filePriorities && resume.filePriorities.length > 0) ? resume.filePriorities : Array(fileCount).fill('normal');

    const candidates = [];
    
    // We iterate through all pieces and determine their effective priority
    // Based on the HIGHEST priority file that overlaps with this piece.
    // If multiple files overlap, and any is WANTED, the piece is WANTED.
    
    let currentOffset = 0;
    for (let pIdx = 0; pIdx < pieceCount; pIdx++) {
      // Basic piece length (last piece might be shorter)
      const pLen = (pIdx === pieceCount - 1) ? (meta.totalSize % pieceLength || pieceLength) : pieceLength;
      const pieceStart = currentOffset;
      const pieceEnd = currentOffset + pLen - 1;

      // Skip if we already have it
      if (self.status[pIdx] === STATUS_HAVE) {
        currentOffset += pLen;
        continue;
      }

      let pieceIsWanted = false;
      let pieceMaxPrio = -1; // -1=unwanted, 0=low, 1=normal, 2=high
      let pieceMaxFileSize = 0;

      // Map piece to files
      let fOffset = 0;
      for (let fIdx = 0; fIdx < fileCount; fIdx++) {
        const file = meta.files[fIdx];
        const fStart = fOffset;
        const fEnd = fOffset + file.sizeBytes - 1;

        // Check for overlap
        if (fStart <= pieceEnd && fEnd >= pieceStart) {
          if (wanted[fIdx]) {
            pieceIsWanted = true;
            const pMap: Record<string, number> = { 'low': 0, 'normal': 1, 'high': 2 };
            const pVal = pMap[priorities[fIdx]] ?? 1;
            if (pVal > pieceMaxPrio) pieceMaxPrio = pVal;
            if (file.sizeBytes > pieceMaxFileSize) pieceMaxFileSize = file.sizeBytes;
          }
        }
        fOffset += file.sizeBytes;
        if (fOffset > pieceEnd) break;
      }

      // Sync engine status with our 'wanted' logic
      if (!pieceIsWanted) {
        if (self.status[pIdx] !== STATUS_SKIPPED) self.status[pIdx] = STATUS_SKIPPED;
      } else {
        if (self.status[pIdx] === STATUS_SKIPPED) self.status[pIdx] = STATUS_NEEDED;

        // Add to candidates if peer has it and we're not choked
        if (self.peerHasPiece(bitfield, pIdx)) {
          if (!isChoked || (allowedFast && allowedFast.has(pIdx))) {
            candidates.push({ index: pIdx, priority: pieceMaxPrio, size: pieceMaxFileSize });
          }
        }
      }

      currentOffset += pLen;
    }

    // Sort by: Priority (High > Normal > Low), then File Size (Largest first), then Index
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.size !== b.size) return b.size - a.size;
      return a.index - b.index;
    });

    const requests = partialRequests;
    for (const cand of candidates) {
      while (requests.length < count) {
        const block = self.nextNeededBlock(cand.index);
        if (block === null) break;
        self.markBlockRequested(cand.index, block);
        requests.push({ pieceIndex: cand.index, offset: block * BLOCK_SIZE, length: self.blockLength(cand.index, block) });
      }
      if (requests.length >= count) break;
    }

    return requests;
  };

  // Patch Session.prototype.startTorrent to inject info into PieceManager
  const originalStartTorrent = Session.prototype.startTorrent;
  Session.prototype.startTorrent = async function(id: string | any, initialPeers?: any[], bypassQueue?: boolean) {
    const res = await originalStartTorrent.apply(this, [id, initialPeers, bypassQueue]);
    
    // Access internal torrents map (it's private in TS but public in compiled JS)
    const inst = typeof id === 'string' ? (this as any).torrents.get(id) : id;
    if (inst && inst.pieces && inst.meta) {
      inst.pieces._meta = inst.meta;
      inst.pieces._resume = inst.resume;
    }
    return res;
  };
}

// applyPatches() — disabled: the custom nextRequestBatch override prevents pieces
// from completing for some torrents (peers send blocks but no piece ever finishes).
// The engine's built-in rarest-first picker handles the all-files-wanted case fine.
// Re-enable only if per-file priority/skip behavior is required.
// applyPatches();
void applyPatches

/** Initialise and start the embedded torrent session. */
export async function initTorrentSession(opts?: {
  downloadDir?: string
  incompleteDir?: string
  resumeDir?: string
  torrentsDir?: string
}): Promise<Session> {
  if (_session) return _session

  const downloadDir  = resolve(opts?.downloadDir  ?? process.env.TORRENT_DOWNLOAD_DIR  ?? './downloads/complete')
  const incompleteDir= resolve(opts?.incompleteDir ?? process.env.TORRENT_INCOMPLETE_DIR ?? './downloads/incomplete')
	  const resumeDir    = resolve(opts?.resumeDir     ?? process.env.TORRENT_RESUME_DIR    ?? './data/resume')
	  const torrentsDir  = resolve(opts?.torrentsDir   ?? process.env.TORRENT_FILES_DIR     ?? './data/torrents')
	  const peerHost     = process.env.TORRENT_PEER_HOST ?? '0.0.0.0'
	  const peerPort     = parseInt(process.env.TORRENT_TCP_PORT ?? process.env.TORRENT_PEER_PORT ?? '2425', 10)
	  const advertisedPeerPort = parseInt(process.env.TORRENT_ADVERTISE_PORT ?? String(peerPort), 10)
	  const dhtPort      = parseInt(process.env.TORRENT_DHT_PORT ?? '2426', 10)
	  const utpPort      = parseInt(process.env.TORRENT_UTP_PORT ?? '2427', 10)

  const settings: Partial<SessionSettings> & { metadataFetchTimeoutMinutes: number } = {
    downloadDir,
    incompleteDir,
    // Transmission-style flow: torrents download into incompleteDir, then the
    // engine moves the finished payload into downloadDir (…/complete) on
    // completion, ready to be migrated into the media library.
    incompleteDirEnabled: true,
    startAddedTorrents: true,
    dhtEnabled: true,
    pexEnabled: true,
    lpdEnabled: true,
	    utpEnabled: true,
	    peerPort,
	    peerHost,
	    advertisedPeerPort,
	    dhtPort,
	    utpPort,
	    portForwardingEnabled: false, // Usually useless on public wifi/behind CGNAT
    peerLimitGlobal: 1000,
    peerLimitPerTorrent: 200,
    cacheSize: 128, 
    sequentialDownloadDefault: false, // Disable sequential to help finish rare pieces in End Game
    queueStalledEnabled: false, // Don't pause stalled torrents, keep them trying
    metadataFetchTimeoutMinutes: Math.max(1, parseInt(process.env.TORRENT_METADATA_TIMEOUT_MINUTES ?? '15', 10) || 15),
  }

	  _session = new Session(settings, { resume: resumeDir, torrents: torrentsDir })
	  await _session.start()
	  logger.info(`Torrent ports: TCP ${peerHost}:${peerPort}, DHT UDP ${dhtPort}, uTP UDP ${utpPort}, advertised ${advertisedPeerPort}`)

  _session.on('torrent:added', id => {
    const torrent = _session?.getTorrent(id)
    recordEvent({
      category: 'torrent',
      action: 'added',
      subjectType: 'torrent',
      subjectId: id,
      message: torrent ? `Torrent added: ${torrent.name}` : `Torrent added: ${id}`,
      data: torrent ? { infoHash: torrent.infoHash, labels: torrent.labels } : {},
    })
    // Direct .torrent additions already have metadata. Delay the ledger lookup
    // briefly because the web process marks the acquisition decision only
    // after addTorrent acknowledges this event.
    if (torrent?.labels?.includes('archivist-music') && torrent.status !== 'fetching-metadata') {
      setTimeout(() => recordMusicSwarmOutcome(torrent.infoHash, 'metadata-succeeded'), 1_000).unref?.()
    }
  })
  _session.on('torrent:updated', id => {
    const torrent = _session?.getTorrent(id)
    if (torrent?.labels?.includes('archivist-music')
      && !['fetching-metadata', 'error'].includes(String(torrent.status))
      && Number(torrent.sizeBytes ?? 0) > 0) {
      recordMusicSwarmOutcome(torrent.infoHash, 'metadata-succeeded')
    }
  })
  _session.on('torrent:removed', id => {
    recordEvent({ category: 'torrent', action: 'removed', subjectType: 'torrent', subjectId: id, message: `Torrent removed: ${id}` })
  })
  _session.on('torrent:complete', id => {
    const torrent = _session?.getTorrent(id)
    recordEvent({
      category: 'torrent',
      action: 'complete',
      subjectType: 'torrent',
      subjectId: id,
      message: torrent ? `Torrent completed: ${torrent.name}` : `Torrent completed: ${id}`,
      data: torrent ? { infoHash: torrent.infoHash, sizeBytes: torrent.sizeBytes } : {},
    })
  })
  _session.on('torrent:error', (id, error) => {
    const torrent = _session?.getTorrent(id)
    recordEvent({
      category: 'torrent', action: 'error', severity: 'error', subjectType: 'torrent', subjectId: id, message: error,
      data: torrent ? { infoHash: torrent.infoHash, name: torrent.name, labels: torrent.labels } : {},
    })
    if (torrent?.infoHash && /metadata fetch timed out/i.test(error)) {
      try {
        handleTorrentMetadataFailure({
        infoHash: torrent.infoHash,
        releaseTitle: torrent.name || torrent.infoHash,
          torrentId: id,
          error,
        })
      } catch (fallbackError) {
        logger.warn('Could not retire metadata failure or queue fallback:', fallbackError instanceof Error ? fallbackError.message : String(fallbackError))
      }
    }
  })

  logger.info(`Torrent session started (download → ${downloadDir})`)

  getDb().prepare("UPDATE torrent_runtime_commands SET status='queued',updated_at=datetime('now'),error=COALESCE(error,'Recovered after torrent worker restart') WHERE status='running'").run()
  getDb().prepare("DELETE FROM torrent_runtime_commands WHERE status IN ('succeeded','failed') AND unixepoch(updated_at) < unixepoch('now') - 604800").run()
  // The interval is now just the backstop (matches the job runner's own
  // poll/signal split) — the sentinel watch below is what makes commands
  // land within milliseconds instead of up to 500ms.
  rpcTimer = setInterval(() => { void pollTorrentCommands() }, 500)
  rpcTimer.unref?.()
  rpcWakeStop = watchJobQueue(getDb(), () => { void pollTorrentCommands() })
  publishTorrentSnapshot()

  registerSessionSendFn(async (url, label) => {
    try {
      const isMagnet = url.startsWith('magnet:')
      let infoHash: string | undefined
      if (isMagnet) {
        const match = url.match(/xt=urn:btih:([a-fA-F0-9]{40})/i)
        if (match) infoHash = match[1].toLowerCase()
      }

      const id = await _session!.addTorrent({
        magnetLink: isMagnet ? url : undefined,
        torrentUrl: isMagnet ? undefined : url,
        labels: [label],
        metadataFetchTimeoutMs: label === 'archivist-music' ? MUSIC_METADATA_TIMEOUT_MS : undefined,
      })

      if (!infoHash) {
        const delays = [200, 500, 1000, 2000, 3000, 5000]
        for (const delay of delays) {
          await new Promise(resolve => setTimeout(resolve, delay))
          const torrent = _session!.getTorrent(id)
          if (torrent?.infoHash) {
            infoHash = torrent.infoHash
            break
          }
        }
      }

      logger.info(`Torrent added: id=${id} infoHash=${infoHash ?? 'pending'}`)
      recordEvent({
        category: 'download',
        action: 'grab-accepted',
        subjectType: 'torrent',
        subjectId: id,
        message: 'Download accepted by built-in engine',
        data: { infoHash, label },
      })
      return { success: true, message: 'Added to built-in engine', runtimeTorrentId: String(id), infoHash }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`Failed to add torrent: ${msg}`)
      return { success: false, message: msg }
    }
  })

  return _session
}

/** Return the active session. */
export function getTorrentSession(): Session {
  if (_session) return _session
  if (isDbInitialised()) return torrentProxy()
  throw new Error('Torrent session not initialised')
}

/** Gracefully stop the session. */
export async function stopTorrentSession(): Promise<void> {
  if (rpcTimer) clearInterval(rpcTimer)
  rpcTimer = null
  if (rpcWakeStop) rpcWakeStop()
  rpcWakeStop = null
  if (_session) {
    await _session.stop()
    _session = null
    logger.info('Torrent session stopped')
  }
}
