// MetadataFetcher — implements BEP 9 (ut_metadata extension)
// Used when adding a magnet link: we connect to DHT peers and request pieces
// of the info dictionary until we have the complete thing, then parse it.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  PeerConnection,
  parseTorrentFile,
  encodeUtMetadata, parseUtMetadata,
  decodePex,
  type TorrentMetainfo,
  type ParsedLtepHandshake,
  type WireMessage,
} from '@torrentstack/bittorrent';

const METADATA_PIECE_SIZE = 16 * 1024; // 16 KiB
const MAX_ACTIVE_CONNS = 50;
const CONNECT_TIMEOUT_MS = 5_000;
// PeerConnection may spend up to 20 seconds negotiating MSE, reconnect in
// plaintext, and then wait up to 15 seconds for the LTEP handshake. A ten
// second outer timer used to kill that valid fallback path before it could
// complete, which was especially visible on older/smaller Music swarms.
const HANDSHAKE_STALL_TIMEOUT_MS = 45_000;
const TRANSFER_STALL_TIMEOUT_MS = 20_000;
const PEER_RETRY_COOLDOWN_MS = 45_000;
const MAX_PEER_ATTEMPTS = 5;
const REANNOUNCE_INITIAL_MS = 10_000;
const REANNOUNCE_MAX_MS = 60_000;

export interface MetadataFetcherEvents {
  'metadata': [meta: TorrentMetainfo, infoBytes: Buffer];
  'error': [error: Error];
  'progress': [received: number, total: number];
  'need-peers': [];
  'exhausted': [error: Error];
}

export class MetadataFetcher extends EventEmitter {
  private infoHash: Buffer;
  private ourPeerId: Buffer;
  private pieces: Map<number, Buffer> = new Map();
  private totalPieces = 0;
  private metaSize = 0;
  private done = false;
  
  private activePeers: Map<string, { conn: PeerConnection; timer: ReturnType<typeof setTimeout> }> = new Map();
  private pendingQueue: Array<{ host: string; port: number }> = [];
  private pendingPeers = new Set<string>();
  private seenPeers = new Map<string, { host: string; port: number }>();
  private peerAttempts = new Map<string, { count: number; lastAttemptAt: number }>();
  private reannounceTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private reannounceInterval = REANNOUNCE_INITIAL_MS;

  constructor(infoHash: Buffer, ourPeerId: Buffer, deadlineMs = 15 * 60_000) {
    super();
    this.infoHash = infoHash;
    this.ourPeerId = ourPeerId;

    // Start discovery immediately
    this.scheduleReannounce(0);
    this.deadlineTimer = setTimeout(() => {
      if (this.done) return;
      const error = new Error(`Metadata fetch timed out after ${Math.round(deadlineMs / 60_000)} minute(s)`);
      this.stop();
      this.emit('exhausted', error);
    }, Math.max(1_000, deadlineMs));
    this.deadlineTimer.unref?.();
  }

  private scheduleReannounce(ms: number): void {
    if (this.done) return;
    this.reannounceTimer = setTimeout(() => {
      if (this.done) return;
      console.log(`[MetadataFetcher] Re-announcing for peers (Queue: ${this.pendingQueue.length}, Active: ${this.activePeers.size})`);
      this.emit('need-peers');
      
      // Exponential backoff for re-announcing
      this.reannounceInterval = Math.min(this.reannounceInterval * 2, REANNOUNCE_MAX_MS);
      this.scheduleReannounce(this.reannounceInterval);
    }, ms);
  }

  addPeer(host: string, port: number): void {
    if (this.done) return;
    const key = `${host}:${port}`;
    if (!this.seenPeers.has(key)) this.seenPeers.set(key, { host, port });
    if (this.activePeers.has(key) || this.pendingPeers.has(key)) return;

    const previous = this.peerAttempts.get(key);
    if (previous) {
      if (previous.count >= MAX_PEER_ATTEMPTS) return;
      if (Date.now() - previous.lastAttemptAt < PEER_RETRY_COOLDOWN_MS) return;
    }

    this.pendingQueue.push({ host, port });
    this.pendingPeers.add(key);
    this.processQueue();
  }

  getDiscoveredPeers(): Array<{ ip: string; port: number }> {
    return Array.from(this.seenPeers.values()).map(p => ({ ip: p.host, port: p.port }));
  }

  private processQueue(): void {
    if (this.done) return;
    
    while (this.activePeers.size < MAX_ACTIVE_CONNS && this.pendingQueue.length > 0) {
      const peer = this.pendingQueue.shift()!;
      const key = `${peer.host}:${peer.port}`;
      this.pendingPeers.delete(key);
      const previous = this.peerAttempts.get(key);
      this.peerAttempts.set(key, { count: (previous?.count ?? 0) + 1, lastAttemptAt: Date.now() });
      this.startConnection(peer.host, peer.port);
    }
  }

  private startConnection(host: string, port: number): void {
    const key = `${host}:${port}`;
    
    const conn = new PeerConnection({
      host, port,
      infoHash: this.infoHash,
      peerId: Buffer.alloc(20),
      ourPeerId: this.ourPeerId,
      encryption: 'preferred',
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
    });

    const timeout = setTimeout(() => {
      this.removePeer(key, 'handshake stalled');
    }, HANDSHAKE_STALL_TIMEOUT_MS);

    this.activePeers.set(key, { conn, timer: timeout });

    // The TCP/BitTorrent handshake completed. Give LTEP its own bounded window
    // rather than continuing to charge it for encryption negotiation time.
    conn.on('connect', () => this.resetPeerTimer(key, TRANSFER_STALL_TIMEOUT_MS, 'extension handshake stalled'));

    conn.on('handshake', (_hs: unknown, ltep: ParsedLtepHandshake | null) => {
      if (!ltep) { this.removePeer(key, 'no LTEP'); return; }

      const extId = ltep.extensions['ut_metadata'];
      if (extId === undefined || !ltep.metadataSize) {
        // If they don't have metadata but have PEX, we keep them for a bit to get more peers
        if (ltep.extensions['ut_pex'] === undefined) {
          this.removePeer(key, 'no ut_metadata or ut_pex');
          return;
        }
        console.log(`[MetadataFetcher] Peer ${key} has no metadata but supports PEX`);
      } else {
        console.log(`[MetadataFetcher] Peer ${key} handshake success (Size: ${ltep.metadataSize})`);

        this.resetPeerTimer(key, TRANSFER_STALL_TIMEOUT_MS, 'metadata transfer stalled');

        if (this.metaSize === 0) {
          this.metaSize = ltep.metadataSize;
          this.totalPieces = Math.ceil(this.metaSize / METADATA_PIECE_SIZE);
        }

        this.requestPieces(conn, extId);
      }
    });

    conn.on('message', (msg: WireMessage) => {
      if (msg.type !== 'extended') return;
      // Incoming extended messages arrive with OUR registered IDs (we told the peer to use these).
      // We registered: ut_metadata=1, ut_pex=2 in encodeLtepHandshake.
      // conn.state.extensionIds holds the PEER's IDs — used only when sending requests TO the peer.
      if (msg.extId === 1) {
        this.handleMetadataMessage(key, conn, msg.payload);
      } else if (msg.extId === 2) {
        this.handlePexMessage(msg.payload);
      }
    });

    conn.on('close', (reason) => this.removePeer(key, reason));
    conn.on('error', () => this.removePeer(key, 'error'));
    
    conn.connect();
  }

  private handleMetadataMessage(key: string, conn: PeerConnection, payload: Buffer): void {
    let utMsg;
    try { utMsg = parseUtMetadata(payload); } catch (_e) { return; }

    if (utMsg.type !== 'data') {
      if (utMsg.type === 'reject') console.warn(`[MetadataFetcher] Peer ${key} rejected piece ${utMsg.piece}`);
      return;
    }
    
    if (this.done || this.pieces.has(utMsg.piece)) return;

    // Reset stall timer on progress
    const p = this.activePeers.get(key);
    if (p) {
      this.resetPeerTimer(key, TRANSFER_STALL_TIMEOUT_MS, 'metadata transfer stalled');
    }

    console.log(`[MetadataFetcher] Received metadata piece ${utMsg.piece + 1}/${this.totalPieces} from ${key}`);
    this.pieces.set(utMsg.piece, utMsg.data);
    this.emit('progress', this.pieces.size, this.totalPieces);

    if (this.pieces.size === this.totalPieces) {
      this.assemble();
    } else {
      const extId = conn.state.extensionIds['ut_metadata'];
      if (extId !== undefined) this.requestPieces(conn, extId);
    }
  }

  private handlePexMessage(payload: Buffer): void {
    try {
      const pex = decodePex(payload);
      if (pex.added.length > 0) {
        console.log(`[MetadataFetcher] PEX discovered ${pex.added.length} new peers`);
        for (const p of pex.added) {
          this.addPeer(p.ip, p.port);
        }
      }
    } catch (_e) {
      // Ignore PEX parse errors
    }
  }

  private requestPieces(conn: PeerConnection, extId: number): void {
    if (this.done || !this.totalPieces) return;
    for (let i = 0; i < this.totalPieces; i++) {
      if (!this.pieces.has(i)) {
        conn.send({ type: 'extended', extId, payload: encodeUtMetadata({ type: 'request', piece: i }) });
      }
    }
  }

  private removePeer(key: string, reason?: string): void {
    const p = this.activePeers.get(key);
    if (p) {
      clearTimeout(p.timer);
      p.conn.destroy(reason ?? 'removed');
      this.activePeers.delete(key);
      this.processQueue();
    }
  }

  private resetPeerTimer(key: string, timeoutMs: number, reason: string): void {
    const peer = this.activePeers.get(key);
    if (!peer) return;
    clearTimeout(peer.timer);
    peer.timer = setTimeout(() => this.removePeer(key, reason), timeoutMs);
  }

  private assemble(): void {
    if (this.done) return;

    const parts: Buffer[] = [];
    for (let i = 0; i < this.totalPieces; i++) {
      const piece = this.pieces.get(i);
      if (!piece) return;
      parts.push(piece);
    }

    const infoBytes = Buffer.concat(parts).subarray(0, this.metaSize);
    const hash = createHash('sha1').update(infoBytes).digest();
    if (!hash.equals(this.infoHash)) {
      console.warn(`[MetadataFetcher] Hash mismatch for metadata! Retrying...`);
      this.pieces.clear();
      this.emit('error', new Error('Metadata hash mismatch'));
      return;
    }

    this.done = true;
    if (this.reannounceTimer) clearTimeout(this.reannounceTimer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    console.log(`[MetadataFetcher] Successfully retrieved metadata for ${this.infoHash.toString('hex')}!`);
    
    this.stopAllPeers();

    try {
      const torrentBytes = Buffer.concat([Buffer.from(`d4:info`), infoBytes, Buffer.from(`e`)]);
      const meta = parseTorrentFile(torrentBytes);
      this.emit('metadata', meta, infoBytes);
    } catch (e) {
      this.emit('error', new Error(`Failed to parse metadata: ${String(e)}`));
    }
  }

  private stopAllPeers(): void {
    for (const key of this.activePeers.keys()) {
      this.removePeer(key, 'complete');
    }
    this.pendingQueue = [];
    this.pendingPeers.clear();
  }

  stop(): void {
    this.done = true;
    if (this.reannounceTimer) clearTimeout(this.reannounceTimer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.stopAllPeers();
  }

  get isComplete(): boolean { return this.done; }
  get activePeerCount(): number { return this.activePeers.size; }
  get seenPeerCount(): number { return this.seenPeers.size; }
}
