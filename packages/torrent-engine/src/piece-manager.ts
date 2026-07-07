// PieceManager — tracks which pieces are needed, assigns block requests to peers,
// verifies pieces via SHA1 after download.
//
// Piece selection strategy:
//   1. Rarest-first: request pieces that fewest peers have (maximises swarm availability)
//   2. End-game: when < 20 pieces remain, broadcast requests to multiple peers to finish fast
//   3. Sequential: optional in-order mode for streaming / preview

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TorrentMetainfo } from '@torrentstack/bittorrent';
import type { FilePriority } from '@torrentstack/types';

const BLOCK_SIZE = 16 * 1024; // 16 KiB — standard BitTorrent block size

export type BlockStatus  = 'needed' | 'requested' | 'received';

const STATUS_NEEDED    = 0;
const STATUS_REQUESTED = 1;
const STATUS_HAVE      = 2;
const STATUS_SKIPPED   = 3;

export interface BlockRequest {
  pieceIndex: number;
  offset:     number;   // byte offset within piece
  length:     number;   // bytes (≤ BLOCK_SIZE, last block in last piece may be smaller)
}

export interface BlockKey {
  pieceIndex: number;
  offset:     number;
}

export interface PieceManagerEvents {
  'piece-complete':  [pieceIndex: number, data: Buffer];
  'piece-failed':    [pieceIndex: number, reason: string];
  'download-complete': [];
}

export interface ReceiveBlockResult {
  accepted:     boolean;  // block was new, in-range, and stored
  duplicate:    boolean;  // already received this block (or piece is HAVE)
  outOfRange:   boolean;  // blockIndex out of range for the piece
  alreadyHave:  boolean;  // piece is already HAVE / SKIPPED / VERIFYING
  bytesUseful:  number;   // bytes that should count toward the useful-download counter
  pieceFilled:  boolean;  // this block was the last one — verification triggered
  canceled:     CanceledBlock[];
}

export interface PeerStats {
  acceptedBlocks:      number;  // blocks that were new and in-range
  duplicateBlocks:     number;  // blocks already 'received' or for HAVE pieces
  outOfRangeBlocks:    number;  // malformed blocks
  totalBytesReceived:  number;  // raw bytes counted across all messages
  totalUsefulBytes:    number;  // bytes from accepted blocks
  lastBlockReceivedAt: number;  // ms timestamp
  outstandingRequests: number;  // blocks marked 'requested' for this peer
  blockLatencies:      number[]; // sliding window of request→receive latency in ms
}

export interface CanceledBlock {
  pieceIndex: number;
  offset:     number;
  length:     number;
  peerId?:    string;
}

interface BlockRequestRecord {
  peerId:      string;
  requestedAt: number;
}

export interface PieceRequestDiagnostics {
  endGame: boolean;
  missingPieces: number;
  partialPieces: number;
  outstandingBlocks: number;
  staleBlocks: number;
  duplicateOutstandingBlocks: number;
}

// Worker pool for SHA-1 verification — shared across all PieceManager instances in this process.
const VERIFIER_WORKER_COUNT = Math.max(2, Math.min(4, cpus().length - 1));
let _verifierWorkers: Worker[] | null = null;
let _verifierNext = 0;
let _verifierJobId = 0;
const _verifierPending = new Map<number, (ok: boolean) => void>();

function getVerifierWorkers(): Worker[] {
  if (_verifierWorkers) return _verifierWorkers;
  const here = dirname(fileURLToPath(import.meta.url));
  const workerPath = join(here, 'piece-verifier.worker.js');
  _verifierWorkers = [];
  for (let i = 0; i < VERIFIER_WORKER_COUNT; i++) {
    const w = new Worker(workerPath);
    w.on('message', (msg: { id: number; ok: boolean }) => {
      const cb = _verifierPending.get(msg.id);
      if (cb) {
        _verifierPending.delete(msg.id);
        cb(msg.ok);
      }
    });
    w.on('error', err => {
      // Best-effort: log and rely on subsequent jobs falling back to in-process verify.
      console.error('[piece-verifier] worker error:', err);
    });
    w.unref();
    _verifierWorkers.push(w);
  }
  return _verifierWorkers;
}

/** Run SHA-1 verification on a worker. Falls back to in-process if pool spawn fails. */
function verifyOnWorker(data: Buffer, expected: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    let workers: Worker[];
    try {
      workers = getVerifierWorkers();
    } catch {
      // Fallback: in-process synchronous verification.
      const h = createHash('sha1').update(data).digest();
      resolve(h.equals(expected));
      return;
    }
    const id = ++_verifierJobId;
    const worker = workers[_verifierNext++ % workers.length]!;
    _verifierPending.set(id, resolve);
    // Copy the buffer to avoid sharing memory with main thread.
    const copy = Buffer.from(data);
    worker.postMessage({ id, data: copy, expected: Buffer.from(expected) });
  });
}

export class PieceManager extends EventEmitter {
  readonly pieceCount:  number;
  readonly pieceLength: number;
  readonly totalSize:   number;
  readonly hashes:      Buffer[];       // 20-byte SHA1 per piece

  /** Per-piece status: 0=needed, 1=requested, 2=have, 3=skipped */
  readonly status:      Uint8Array;
  private neededBf:     Buffer;
  private blocks:       Map<number, BlockStatus[]>;  // pieceIndex → block statuses
  private blockData:    Map<string, Buffer>;          // "pi:offset" → data
  private peerBitfields = new Map<string, Buffer>();  // peerId → bitfield
  private peerAllowedFast = new Map<string, Set<number>>(); // peerId → set of piece indices
  
  private pieceAvailability: number[];                // pieceIndex → count
  private availabilityBuckets: Set<number>[];         // count → set of piece indices

  // Per-piece priority tier derived from overlapping file priorities.
  // -1 = skipped (no wanted file overlaps), 0 = low, 1 = normal, 2 = high.
  // Picker walks buckets in tier order high → normal → low, rarest-first within each tier.
  private pieceTier: Int8Array;

  private sequential:   boolean;
  private endGame:      boolean = false;
  private rarestCache:  number[] | null = null;
  private blockRequests = new Map<string, BlockRequestRecord[]>(); // "pi:bi" → peers requested + when
  private peerStats = new Map<string, PeerStats>();
  private verifyingPieces = new Set<number>(); // pieces with SHA-1 verification in flight
  private static readonly LATENCY_SAMPLES = 20;
  private static readonly ENDGAME_DUPLICATE_AFTER_MS = 8_000;
  private static readonly ENDGAME_MAX_DUPLICATES = 3;

  constructor(meta: TorrentMetainfo, sequential = false) {
    super();
    this.pieceCount  = meta.pieces.length;
    this.pieceLength = meta.pieceLength;
    this.totalSize   = meta.totalSize;
    this.hashes      = meta.pieces;
    this.sequential  = sequential;

    this.status    = new Uint8Array(this.pieceCount).fill(STATUS_NEEDED);
    this.neededBf  = Buffer.alloc(Math.ceil(this.pieceCount / 8)).fill(0xff);
    this.blocks    = new Map();
    this.blockData = new Map();
    
    this.pieceAvailability = new Array(this.pieceCount).fill(0);
    // Initialize buckets (max availability is roughly peer count, but we'll support up to 200)
    this.availabilityBuckets = Array.from({ length: 201 }, () => new Set());
    for (let i = 0; i < this.pieceCount; i++) {
      this.availabilityBuckets[0]!.add(i);
    }

    this.pieceTier = new Int8Array(this.pieceCount).fill(1); // default: normal
  }

  // ─── File priorities → per-piece tiers ───────────────────────────────────────
  //
  // Recomputes pieceTier from current file selection. A piece's tier is the
  // highest tier of any wanted file overlapping it. If no wanted file overlaps,
  // the piece is marked skipped (status STATUS_SKIPPED, neededBf bit cleared).
  // Already-HAVE pieces are left untouched.
  setPiecePriorities(meta: TorrentMetainfo, wantedFiles: boolean[], filePriorities: FilePriority[]): void {
    const tierMap: Record<FilePriority, number> = { skip: -1, low: 0, normal: 1, high: 2 };
    const fileCount = meta.files.length;

    // Walk pieces in offset order, advancing the file cursor as we go.
    let fIdx = 0;
    let fStart = 0;
    let fEnd = fileCount > 0 ? meta.files[0]!.sizeBytes - 1 : -1;
    let pieceStart = 0;

    for (let p = 0; p < this.pieceCount; p++) {
      const pSize = this.pieceSize(p);
      const pieceEnd = pieceStart + pSize - 1;

      let maxTier = -1;
      // Scan files overlapping [pieceStart, pieceEnd]. Restart from current cursor.
      let scanIdx = fIdx;
      let scanStart = fStart;
      let scanEnd = fEnd;
      while (scanIdx < fileCount && scanStart <= pieceEnd) {
        if (scanEnd >= pieceStart) {
          const wanted = wantedFiles[scanIdx] ?? true;
          const prioName = filePriorities[scanIdx] ?? 'normal';
          const t = wanted ? (tierMap[prioName] ?? 1) : -1;
          if (t > maxTier) maxTier = t;
        }
        scanIdx++;
        if (scanIdx < fileCount) {
          scanStart = scanEnd + 1;
          scanEnd = scanStart + meta.files[scanIdx]!.sizeBytes - 1;
        }
      }

      this.pieceTier[p] = maxTier;

      // Sync status / neededBf with the new tier — but never disturb a HAVE piece.
      if (this.status[p] !== STATUS_HAVE) {
        const byteIdx = Math.floor(p / 8);
        const bitIdx  = 7 - (p % 8);
        if (maxTier === -1) {
          if (this.status[p] !== STATUS_SKIPPED) this.status[p] = STATUS_SKIPPED;
          this.neededBf[byteIdx]! &= ~(1 << bitIdx);
        } else {
          if (this.status[p] === STATUS_SKIPPED) this.status[p] = STATUS_NEEDED;
          this.neededBf[byteIdx]! |= (1 << bitIdx);
        }
      }

      // Advance the cursor to the file containing pieceEnd+1.
      while (fIdx < fileCount && fEnd <= pieceEnd) {
        fIdx++;
        if (fIdx < fileCount) {
          fStart = fEnd + 1;
          fEnd = fStart + meta.files[fIdx]!.sizeBytes - 1;
        }
      }
      pieceStart += pSize;
    }

    this.rarestCache = null;
  }

  // ─── Peer availability ────────────────────────────────────────────────────────

  updateBitfield(peerId: string, bitfield: Buffer): void {
    const oldBf = this.peerBitfields.get(peerId);
    if (oldBf) {
      for (let i = 0; i < this.pieceCount; i++) {
        if (this.peerHasPiece(oldBf, i)) this.decrementAvailability(i);
      }
    }

    this.peerBitfields.set(peerId, bitfield);
    for (let i = 0; i < this.pieceCount; i++) {
      if (this.peerHasPiece(bitfield, i)) this.incrementAvailability(i);
    }
  }

  setPeerHave(peerId: string, pieceIndex: number): void {
    let bf = this.peerBitfields.get(peerId);
    if (!bf) {
      bf = Buffer.allocUnsafe(Math.ceil(this.pieceCount / 8)).fill(0);
      this.peerBitfields.set(peerId, bf);
    }
    const byteIdx = Math.floor(pieceIndex / 8);
    const bitIdx  = 7 - (pieceIndex % 8);
    
    if (!((bf[byteIdx] ?? 0) & (1 << bitIdx))) {
      bf[byteIdx]! |= (1 << bitIdx);
      this.incrementAvailability(pieceIndex);
    }
  }

  private incrementAvailability(idx: number): void {
    if (idx >= this.pieceCount) return;
    const current = this.pieceAvailability[idx]!;
    this.availabilityBuckets[current]?.delete(idx);
    const next = Math.min(current + 1, 200);
    this.pieceAvailability[idx] = next;
    this.availabilityBuckets[next]!.add(idx);
  }

  private decrementAvailability(idx: number): void {
    if (idx >= this.pieceCount) return;
    const current = this.pieceAvailability[idx]!;
    this.availabilityBuckets[current]?.delete(idx);
    const next = Math.max(current - 1, 0);
    this.pieceAvailability[idx] = next;
    this.availabilityBuckets[next]!.add(idx);
  }

  addAllowedFast(peerId: string, pieceIndex: number): void {
    let set = this.peerAllowedFast.get(peerId);
    if (!set) {
      set = new Set();
      this.peerAllowedFast.set(peerId, set);
    }
    set.add(pieceIndex);
  }

  getPeerBitfield(peerId: string): Buffer | undefined {
    return this.peerBitfields.get(peerId);
  }

  removePeer(peerId: string): void {
    const bf = this.peerBitfields.get(peerId);
    if (bf) {
      for (let i = 0; i < this.pieceCount; i++) {
        if (this.peerHasPiece(bf, i)) this.decrementAvailability(i);
      }
    }
    this.peerBitfields.delete(peerId);
    this.peerAllowedFast.delete(peerId);
    this.peerStats.delete(peerId);

    // Release only the blocks this peer was holding. Other peers' outstanding
    // requests on the same piece must be preserved.
    this.releasePeerOwnedBlocks(peerId);
  }

  /**
   * Release every block currently 'requested' by `peerId`. Returns the list of
   * canceled requests so the caller can send BitTorrent `cancel` messages.
   * Other peers' outstanding requests on the same piece are not disturbed.
   */
  releasePeerRequests(peerId: string): CanceledBlock[] {
    return this.releasePeerOwnedBlocks(peerId);
  }

  private releasePeerOwnedBlocks(peerId: string): CanceledBlock[] {
    const canceled: CanceledBlock[] = [];
    for (const [key, records] of [...this.blockRequests]) {
      const matching = records.filter(r => r.peerId === peerId);
      if (matching.length === 0) continue;
      const remaining = records.filter(r => r.peerId !== peerId);
      const [piStr, biStr] = key.split(':');
      const pi = Number(piStr);
      const bi = Number(biStr);
      const blocks = this.blocks.get(pi);
      if (blocks && blocks[bi] === 'requested' && remaining.length === 0) {
        blocks[bi] = 'needed';
      }
      for (const _rec of matching) {
        canceled.push({
          pieceIndex: pi,
          offset:     bi * BLOCK_SIZE,
          length:     this.blockLength(pi, bi),
          peerId,
        });
        const stats = this.peerStats.get(peerId);
        if (stats) stats.outstandingRequests = Math.max(0, stats.outstandingRequests - 1);
      }
      if (remaining.length > 0) this.blockRequests.set(key, remaining);
      else this.blockRequests.delete(key);
    }
    // Recompute piece status: if any block of a piece is still 'received' or 'requested',
    // status stays REQUESTED; otherwise revert to NEEDED.
    const touchedPieces = new Set(canceled.map(c => c.pieceIndex));
    for (const pi of touchedPieces) {
      if (this.status[pi] !== STATUS_REQUESTED) continue;
      const blocks = this.blocks.get(pi);
      if (!blocks) { this.status[pi] = STATUS_NEEDED; continue; }
      const stillActive = blocks.some(b => b === 'requested' || b === 'received');
      if (!stillActive) this.status[pi] = STATUS_NEEDED;
    }
    return canceled;
  }

  /**
   * Returns peers with outstanding requests older than their per-peer adaptive timeout.
   * The caller supplies a `timeoutFor(peerId)` to get each peer's threshold.
   * Each returned peer's outstanding blocks have been released (so the picker can
   * reissue them) and are returned so the caller can send `cancel` messages.
   */
  findStalePeers(timeoutFor: (peerId: string) => number): Array<{ peerId: string; canceled: CanceledBlock[]; oldestAgeMs: number }> {
    const now = Date.now();
    const oldestPerPeer = new Map<string, number>();
    for (const records of this.blockRequests.values()) {
      for (const rec of records) {
        const prev = oldestPerPeer.get(rec.peerId) ?? rec.requestedAt;
        if (rec.requestedAt < prev) oldestPerPeer.set(rec.peerId, rec.requestedAt);
        else if (!oldestPerPeer.has(rec.peerId)) oldestPerPeer.set(rec.peerId, rec.requestedAt);
      }
    }
    const out: Array<{ peerId: string; canceled: CanceledBlock[]; oldestAgeMs: number }> = [];
    for (const [peerId, oldest] of oldestPerPeer) {
      const ageMs = now - oldest;
      if (ageMs > timeoutFor(peerId)) {
        out.push({ peerId, canceled: this.releasePeerOwnedBlocks(peerId), oldestAgeMs: ageMs });
      }
    }
    return out;
  }

  getPeerStats(peerId: string): PeerStats | undefined {
    return this.peerStats.get(peerId);
  }

  private statsFor(peerId: string): PeerStats {
    let s = this.peerStats.get(peerId);
    if (!s) {
      s = {
        acceptedBlocks: 0, duplicateBlocks: 0, outOfRangeBlocks: 0,
        totalBytesReceived: 0, totalUsefulBytes: 0,
        lastBlockReceivedAt: 0, outstandingRequests: 0,
        blockLatencies: [],
      };
      this.peerStats.set(peerId, s);
    }
    return s;
  }

  // ... (nextRequestBatch remains mostly same but uses buckets)

  nextRequestBatch(peerId: string, count: number, isChoked: boolean): BlockRequest[] {
    const requests: BlockRequest[] = [];
    const bitfield = this.peerBitfields.get(peerId);
    if (!bitfield) return [];

    // Optimization: check if peer has ANY piece we need before scanning buckets
    let hasAny = false;
    for (let i = 0; i < this.neededBf.length; i++) {
      if ((this.neededBf[i]! & bitfield[i]!) !== 0) {
        hasAny = true;
        break;
      }
    }
    if (!hasAny) return [];

    const allowedFast = this.peerAllowedFast.get(peerId);

    // 1. END GAME — broadcast requests for all unreceived blocks to every peer that has the piece
    if (this.endGame) {
      const candidates = this.endGameCandidates(bitfield);
      for (const pieceIndex of candidates) {
        while (requests.length < count) {
          const block = this.nextEndGameBlock(peerId, pieceIndex);
          if (block === null) break;
          this.markBlockRequested(peerId, pieceIndex, block);
          requests.push({ pieceIndex, offset: block * BLOCK_SIZE, length: this.blockLength(pieceIndex, block) });
        }
        if (requests.length >= count) return requests;
      }
      return requests;
    }

    // 2. PARTIAL PIECES
    for (const pieceIndex of this.blocks.keys()) {
      if (this.status[pieceIndex] >= STATUS_HAVE) continue;
      if (isChoked && (!allowedFast || !allowedFast.has(pieceIndex))) continue;
      if (!this.peerHasPiece(bitfield, pieceIndex)) continue;

      while (requests.length < count) {
        const block = this.nextNeededBlock(pieceIndex);
        if (block === null) break;
        this.markBlockRequested(peerId, pieceIndex, block);
        requests.push({ pieceIndex, offset: block * BLOCK_SIZE, length: this.blockLength(pieceIndex, block) });
      }
      if (requests.length >= count) return requests;
    }

    // 3. BUCKET PICKING (tier-aware turbo rarest-first)
    //    Outer loop: priority tier high → normal → low.
    //    Inner: rarest-first walk over availability buckets, restricted to the current tier.
    for (let tier = 2; tier >= 0; tier--) {
      for (let b = 0; b < this.availabilityBuckets.length; b++) {
        const bucket = this.availabilityBuckets[b]!;
        if (bucket.size === 0) continue;

        for (const pieceIndex of bucket) {
          if (this.pieceTier[pieceIndex] !== tier) continue;
          if (this.status[pieceIndex] >= STATUS_HAVE) continue;
          if (isChoked && (!allowedFast || !allowedFast.has(pieceIndex))) continue;
          if (!this.peerHasPiece(bitfield, pieceIndex)) continue;

          while (requests.length < count) {
            const block = this.nextNeededBlock(pieceIndex);
            if (block === null) break;
            this.markBlockRequested(peerId, pieceIndex, block);
            requests.push({ pieceIndex, offset: block * BLOCK_SIZE, length: this.blockLength(pieceIndex, block) });
          }
          if (requests.length >= count) return requests;
        }
      }
    }

    return requests;
  }

  private rarestFirstCandidates(): number[] {
    if (this.sequential) {
      const needed: number[] = [];
      for (let i = 0; i < this.pieceCount; i++) {
        if (this.status[i] < STATUS_HAVE) needed.push(i);
      }
      return needed;
    }

    if (this.rarestCache) return this.rarestCache;

    const eligible: number[] = [];
    for (let i = 0; i < this.pieceCount; i++) {
      if (this.status[i] < STATUS_HAVE) {
        eligible.push(i);
      }
    }

    this.rarestCache = eligible.sort((a, b) => this.pieceAvailability[a] - this.pieceAvailability[b]);
    return this.rarestCache;
  }

  private endGameCandidates(bitfield: Buffer): number[] {
    const candidates: number[] = [];
    for (let i = 0; i < this.pieceCount; i++) {
      if (this.status[i] < STATUS_HAVE && this.peerHasPiece(bitfield, i)) {
        candidates.push(i);
      }
    }
    return candidates;
  }

  private peerHasPiece(bitfield: Buffer, index: number): boolean {
    const byteIdx = Math.floor(index / 8);
    const bitIdx  = 7 - (index % 8);
    return ((bitfield[byteIdx] ?? 0) & (1 << bitIdx)) !== 0;
  }

  // ─── Block lifecycle ─────────────────────────────────────────────────────────

  /**
   * Process an incoming piece block. Returns a structured result so the swarm
   * can keep its bandwidth counter honest — only `accepted: true` blocks count
   * as useful download.
   */
  receiveBlock(peerId: string, pieceIndex: number, offset: number, data: Buffer): ReceiveBlockResult {
    const stats = this.statsFor(peerId);
    stats.totalBytesReceived += data.length;

    // Already HAVE / SKIPPED / verifying — anything peer sends now is wasted.
    if (this.status[pieceIndex] >= STATUS_HAVE || this.verifyingPieces.has(pieceIndex)) {
      stats.duplicateBlocks++;
      return { accepted: false, duplicate: true, outOfRange: false, alreadyHave: true, bytesUseful: 0, pieceFilled: false, canceled: [] };
    }

    const blockIndex = Math.floor(offset / BLOCK_SIZE);

    let blocks = this.blocks.get(pieceIndex);
    if (!blocks) {
      blocks = new Array(this.blocksInPiece(pieceIndex)).fill('needed');
      this.blocks.set(pieceIndex, blocks);
      if (this.status[pieceIndex] === STATUS_NEEDED) {
        this.status[pieceIndex] = STATUS_REQUESTED;
      }
    }

    if (blockIndex >= blocks.length) {
      stats.outOfRangeBlocks++;
      return { accepted: false, duplicate: false, outOfRange: true, alreadyHave: false, bytesUseful: 0, pieceFilled: false, canceled: [] };
    }
    if (blocks[blockIndex] === 'received') {
      stats.duplicateBlocks++;
      return { accepted: false, duplicate: true, outOfRange: false, alreadyHave: false, bytesUseful: 0, pieceFilled: false, canceled: [] };
    }

    // Accept the block.
    blocks[blockIndex] = 'received';
    this.blockData.set(`${pieceIndex}:${offset}`, Buffer.from(data));

    const reqKey = `${pieceIndex}:${blockIndex}`;
    const records = this.blockRequests.get(reqKey) ?? [];
    const ownerIndex = records.findIndex(r => r.peerId === peerId);
    const req = ownerIndex >= 0 ? records[ownerIndex] : records[0];
    const canceled: CanceledBlock[] = [];
    if (req) {
      const latency = Date.now() - req.requestedAt;
      const owner = this.peerStats.get(req.peerId);
      if (owner) {
        owner.outstandingRequests = Math.max(0, owner.outstandingRequests - 1);
        owner.blockLatencies.push(latency);
        if (owner.blockLatencies.length > PieceManager.LATENCY_SAMPLES) owner.blockLatencies.shift();
      }
    }
    for (const rec of records) {
      if (rec === req) continue;
      const other = this.peerStats.get(rec.peerId);
      if (other) other.outstandingRequests = Math.max(0, other.outstandingRequests - 1);
      canceled.push({ pieceIndex, offset, length: this.blockLength(pieceIndex, blockIndex), peerId: rec.peerId });
    }
    this.blockRequests.delete(reqKey);

    stats.acceptedBlocks++;
    stats.totalUsefulBytes += data.length;
    stats.lastBlockReceivedAt = Date.now();

    const pieceFilled = blocks.every(b => b === 'received');
    if (pieceFilled) {
      this.verifyingPieces.add(pieceIndex);
      // Async verify — schedule, but don't await. piece-complete fires when worker replies.
      void this.verifyPiece(pieceIndex);
    }

    return { accepted: true, duplicate: false, outOfRange: false, alreadyHave: false, bytesUseful: data.length, pieceFilled, canceled };
  }

  private async verifyPiece(pieceIndex: number): Promise<void> {
    const bCount = this.blocksInPiece(pieceIndex);
    const pieceData = this.assemblePiece(pieceIndex);
    const expected = this.hashes[pieceIndex]!;

    let ok = false;
    try {
      ok = await verifyOnWorker(pieceData, expected);
    } catch {
      // Last-resort fallback: synchronous hash if worker pool failed.
      ok = createHash('sha1').update(pieceData).digest().equals(expected);
    }

    // Defensive: piece may have been cleared (e.g. torrent stopped) while verifying.
    if (!this.verifyingPieces.has(pieceIndex)) return;
    this.verifyingPieces.delete(pieceIndex);

    if (ok) {
      this.status[pieceIndex] = STATUS_HAVE;
      this.rarestCache = null;

      const byteIdx = Math.floor(pieceIndex / 8);
      const bitIdx  = 7 - (pieceIndex % 8);
      this.neededBf[byteIdx]! &= ~(1 << bitIdx);

      this.emit('piece-complete', pieceIndex, pieceData);

      this.blocks.delete(pieceIndex);
      for (let i = 0; i < bCount; i++) {
        this.blockData.delete(`${pieceIndex}:${i * BLOCK_SIZE}`);
      }

      this.checkEndGame();
      if (this.isComplete()) this.emit('download-complete');
    } else {
      this.status[pieceIndex] = STATUS_NEEDED;
      this.blocks.delete(pieceIndex);
      for (let i = 0; i < bCount; i++) this.blockData.delete(`${pieceIndex}:${i * BLOCK_SIZE}`);
      this.emit('piece-failed', pieceIndex, 'Hash mismatch');
    }
  }

  private assemblePiece(pieceIndex: number): Buffer {
    const size = this.pieceSize(pieceIndex);
    const buf  = Buffer.allocUnsafe(size);
    const bCount = this.blocksInPiece(pieceIndex);

    for (let i = 0; i < bCount; i++) {
      const offset = i * BLOCK_SIZE;
      const block  = this.blockData.get(`${pieceIndex}:${offset}`);
      if (block) block.copy(buf, offset);
    }
    return buf;
  }

  // ─── Piece / block sizing ─────────────────────────────────────────────────────

  pieceSize(index: number): number {
    if (index === this.pieceCount - 1) {
      const rem = this.totalSize % this.pieceLength;
      return rem === 0 ? this.pieceLength : rem;
    }
    return this.pieceLength;
  }

  blocksInPiece(index: number): number {
    return Math.ceil(this.pieceSize(index) / BLOCK_SIZE);
  }

  blockLength(pieceIndex: number, blockIndex: number): number {
    const pSize = this.pieceSize(pieceIndex);
    const start = blockIndex * BLOCK_SIZE;
    return Math.min(BLOCK_SIZE, pSize - start);
  }

  private nextNeededBlock(pieceIndex: number): number | null {
    let blocks = this.blocks.get(pieceIndex);
    if (!blocks) {
      blocks = new Array(this.blocksInPiece(pieceIndex)).fill('needed');
      this.blocks.set(pieceIndex, blocks);
      if (this.status[pieceIndex] === STATUS_NEEDED) this.status[pieceIndex] = STATUS_REQUESTED;
    }
    const idx = blocks.findIndex(b => b === 'needed');
    return idx === -1 ? null : idx;
  }

  // End-game variant: prefer needed blocks, then duplicate stale outstanding blocks
  // to a small number of alternate peers. This mirrors Transmission's endgame
  // behavior without flooding the swarm with immediate duplicate requests.
  private nextEndGameBlock(peerId: string, pieceIndex: number): number | null {
    let blocks = this.blocks.get(pieceIndex);
    if (!blocks) {
      blocks = new Array(this.blocksInPiece(pieceIndex)).fill('needed');
      this.blocks.set(pieceIndex, blocks);
      if (this.status[pieceIndex] === STATUS_NEEDED) this.status[pieceIndex] = STATUS_REQUESTED;
    }

    const needed = blocks.findIndex(b => b === 'needed');
    if (needed !== -1) return needed;

    const now = Date.now();
    let best: { block: number; age: number } | null = null;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i] === 'received') continue;
      const records = this.blockRequests.get(`${pieceIndex}:${i}`) ?? [];
      if (records.some(r => r.peerId === peerId)) continue;
      if (records.length >= PieceManager.ENDGAME_MAX_DUPLICATES) continue;
      const oldest = records.reduce((min, r) => Math.min(min, r.requestedAt), now);
      const age = now - oldest;
      if (age < PieceManager.ENDGAME_DUPLICATE_AFTER_MS) continue;
      if (!best || age > best.age) best = { block: i, age };
    }

    return best?.block ?? null;
  }

  private markBlockRequested(peerId: string, pieceIndex: number, blockIndex: number): void {
    this.blocks.get(pieceIndex)![blockIndex] = 'requested';
    const key = `${pieceIndex}:${blockIndex}`;
    const records = this.blockRequests.get(key) ?? [];
    if (records.some(r => r.peerId === peerId)) return;
    records.push({ peerId, requestedAt: Date.now() });
    this.blockRequests.set(key, records);
    this.statsFor(peerId).outstandingRequests++;
  }

  /**
   * Compatibility shim: kept so external callers don't break, but no longer
   * resets blocks at the per-block level — that was the source of duplicate-block
   * waste. Callers should use `findStalePeers(timeoutMs)` and drop offenders.
   */
  resetStaleRequests(_timeoutMs = 30_000): void {
    // intentional no-op; see findStalePeers + releasePeerRequests
  }

  /** Adaptive timeout for a peer based on its observed block-arrival latency. */
  staleTimeoutFor(peerId: string, defaultMs = 30_000): number {
    const s = this.peerStats.get(peerId);
    if (!s || s.blockLatencies.length < 5) return defaultMs;
    // P95 of the sliding window, multiplied by 4, clamped.
    const sorted = [...s.blockLatencies].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? defaultMs;
    return Math.max(15_000, Math.min(p95 * 4, 120_000));
  }

  // ─── Completion ───────────────────────────────────────────────────────────────

  isComplete(): boolean {
    for (let i = 0; i < this.status.length; i++) {
      if (this.status[i]! < STATUS_HAVE) return false;
    }
    return true;
  }

  get downloadedPieces(): number {
    let count = 0;
    for (let i = 0; i < this.status.length; i++) {
      if (this.status[i] === STATUS_HAVE) count++;
    }
    return count;
  }

  get progress(): number {
    // Only count actually downloaded (HAVE) pieces — not skipped ones.
    // isComplete() handles the skipped-pieces logic for the seeding transition.
    // Including skipped pieces here inflates progress to 1.0 prematurely,
    // which causes the download monitor to stop the torrent too early.
    let have = 0;
    let total = 0;
    for (let i = 0; i < this.status.length; i++) {
      if (this.status[i] === STATUS_SKIPPED) continue;
      total++;
      if (this.status[i] === STATUS_HAVE) have++;
    }
    return total > 0 ? have / total : 1;
  }

  getRequestDiagnostics(): PieceRequestDiagnostics {
    const now = Date.now();
    let missingPieces = 0;
    let partialPieces = 0;
    let outstandingBlocks = 0;
    let staleBlocks = 0;
    let duplicateOutstandingBlocks = 0;

    for (let i = 0; i < this.status.length; i++) {
      if (this.status[i]! >= STATUS_HAVE) continue;
      missingPieces++;
      const blocks = this.blocks.get(i);
      if (blocks && blocks.some(b => b === 'received' || b === 'requested')) {
        partialPieces++;
      }
    }

    for (const records of this.blockRequests.values()) {
      outstandingBlocks += records.length;
      if (records.length > 1) duplicateOutstandingBlocks += records.length - 1;
      if (records.some(r => now - r.requestedAt > 30_000)) staleBlocks++;
    }

    return {
      endGame: this.endGame,
      missingPieces,
      partialPieces,
      outstandingBlocks,
      staleBlocks,
      duplicateOutstandingBlocks,
    };
  }

  get haveBitfield(): Buffer {
    const buf = Buffer.alloc(Math.ceil(this.pieceCount / 8));
    for (let i = 0; i < this.pieceCount; i++) {
      if (this.status[i] === STATUS_HAVE) {
        const byteIdx = Math.floor(i / 8);
        const bitIdx  = 7 - (i % 8);
        buf[byteIdx]! |= (1 << bitIdx);
      }
    }
    return buf;
  }

  private checkEndGame(): void {
    if (this.endGame) return;
    let needed = 0;
    for (let i = 0; i < this.status.length; i++) {
      if (this.status[i]! < STATUS_HAVE) needed++;
    }
    if (needed <= 20) this.endGame = true;
  }

  // ─── Restore from resume data ─────────────────────────────────────────────────

  restoreFromBitfield(bitfield: Buffer): void {
    for (let i = 0; i < this.pieceCount; i++) {
      const byteIdx = Math.floor(i / 8);
      const bitIdx  = 7 - (i % 8);
      if ((bitfield[byteIdx] ?? 0) & (1 << bitIdx)) {
        this.status[i] = STATUS_HAVE;
        this.neededBf[byteIdx]! &= ~(1 << bitIdx);
      }
    }
    this.checkEndGame();
  }

}
