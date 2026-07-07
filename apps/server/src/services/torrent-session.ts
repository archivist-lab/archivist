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

const logger = createLogger('TorrentSession')

let _session: Session | null = null

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

/** Initialise and start the embedded torrent session. */
export async function initTorrentSession(opts?: {
  downloadDir?: string
  incompleteDir?: string
  resumeDir?: string
  torrentsDir?: string
}): Promise<Session> {
  if (_session) return _session

  const downloadDir  = resolve(opts?.downloadDir  ?? process.env.TORRENT_DOWNLOAD_DIR  ?? './data/downloads')
  const incompleteDir= resolve(opts?.incompleteDir ?? process.env.TORRENT_INCOMPLETE_DIR ?? './data/incomplete')
	  const resumeDir    = resolve(opts?.resumeDir     ?? process.env.TORRENT_RESUME_DIR    ?? './data/resume')
	  const torrentsDir  = resolve(opts?.torrentsDir   ?? process.env.TORRENT_FILES_DIR     ?? './data/torrents')
	  const peerHost     = process.env.TORRENT_PEER_HOST ?? '0.0.0.0'
	  const peerPort     = parseInt(process.env.TORRENT_TCP_PORT ?? process.env.TORRENT_PEER_PORT ?? '2425', 10)
	  const advertisedPeerPort = parseInt(process.env.TORRENT_ADVERTISE_PORT ?? String(peerPort), 10)
	  const dhtPort      = parseInt(process.env.TORRENT_DHT_PORT ?? '2426', 10)
	  const utpPort      = parseInt(process.env.TORRENT_UTP_PORT ?? '2427', 10)

  const settings: Partial<SessionSettings> = {
    downloadDir,
    incompleteDir,
    incompleteDirEnabled: false,
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
    recordEvent({ category: 'torrent', action: 'error', severity: 'error', subjectType: 'torrent', subjectId: id, message: error })
  })

  logger.info(`Torrent session started (download → ${downloadDir})`)

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
      return { success: true, message: 'Added to built-in engine', infoHash }
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
  if (!_session) throw new Error('Torrent session not initialised')
  return _session
}

/** Gracefully stop the session. */
export async function stopTorrentSession(): Promise<void> {
  if (_session) {
    await _session.stop()
    _session = null
    logger.info('Torrent session stopped')
  }
}
