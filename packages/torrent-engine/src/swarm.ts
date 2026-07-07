// Swarm — manages all peer connections for a single torrent.
// Implements the choking algorithm and coordinates block requests.

import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import {
  PeerConnection,
  type PeerConnectionOptions,
  generatePeerId,
  decodePex,
} from '@torrentstack/bittorrent';
import { PieceManager, type CanceledBlock, type PieceRequestDiagnostics } from './piece-manager.js';
import { TorrentBandwidth } from './bandwidth.js';
import type { PeerAddress } from '@torrentstack/bittorrent';
import type { PeerInfo } from '@torrentstack/types';

const DEFAULT_MAX_CONNECTIONS = 100;
const UNCHOKE_COUNT        = 14;    // how many peers to unchoke at once
const OPTIMISTIC_INTERVAL  = 30_000; // ms between optimistic unchokes
const CHOKE_INTERVAL       = 5_000;  // ms between choke recalculations
const KEEPALIVE_INTERVAL   = 90_000; // ms between keep-alives
const REQUEST_QUEUE        = 128;   // max outstanding block requests per peer
const CONNECT_MAINTENANCE_INTERVAL = 5_000;
const FAILED_PEER_BASE_COOLDOWN    = 60_000;
const FAILED_PEER_MAX_COOLDOWN     = 10 * 60_000;
const CHOKED_PEER_TIMEOUT_MS       = 90_000;
const ENDGAME_CHOKED_PEER_TIMEOUT_MS = 45_000;
const INTEREST_REFRESH_MS          = 30_000;

type PeerLifecycleState = 'known' | 'dialing' | 'handshaking' | 'connected' | 'closed' | 'failed';
type PeerFailureBucket = 'timeout' | 'refused' | 'reset' | 'duplicate-heavy' | 'unresponsive' | 'choked' | 'protocol' | 'network' | 'closed';
type PeerSource = PeerInfo['source'];

interface PeerSourceDiagnostics {
  discovered: number;
  connecting: number;
  connected: number;
  failed: number;
  useful: number;
}

interface PeerRelationState {
  connectedAt: number;
  lastInterestedAt: number;
  lastUnchokedAt: number;
  chokedSince: number | null;
}

export interface SwarmDiagnostics {
  connected: number;
  connecting: number;
  known: number;
  seen: number;
  failed: number;
  connectionAttempts: number;
  recentCloseReasons: Record<string, number>;
  failureBuckets: Record<string, number>;
  peerStates: Record<string, number>;
  peerSources: Record<string, PeerSourceDiagnostics>;
  recentFailures: Array<{ peer: string; source: PeerSource; reason: string; bucket: PeerFailureBucket; failures: number; lastFailedAt: number; retryAfter: number }>;
  availability: {
    explanation: string;
    hasConnectedSeed: boolean;
    peersWithNeededPieces: number;
    peersWithUsefulBlocks: number;
	    chokedByPeers: number;
	    longestChokedMs: number;
	  };
  requests: PieceRequestDiagnostics;
}

export interface SwarmEvents {
  'peer-connected':    [peerId: string];
  'peer-disconnected': [peerId: string];
  'block-received':    [pieceIndex: number, offset: number, length: number];
  'upload-to-peer':    [peerId: string, bytes: number];
}

export class Swarm extends EventEmitter {
  private connections = new Map<string, PeerConnection>();
  private knownPeers  = new Map<string, PeerAddress>(); // seen but not connected
  private seenPeers   = new Set<string>();              // all unique peers ever encountered
  private peerSources = new Map<string, PeerInfo['source']>();
  private failedPeers = new Map<string, { failures: number; retryAfter: number; lastReason: string; lastFailedAt: number }>();
  private peerStates = new Map<string, PeerLifecycleState>();
  private peerRelations = new Map<string, PeerRelationState>();
  private closeReasons = new Map<string, number>();
  private connectionAttempts = 0;
  private ourPeerId:  Buffer;

  private chokeTimer:    ReturnType<typeof setInterval> | null = null;
  private optimisticTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer:  ReturnType<typeof setInterval> | null = null;
  private requestTimer:    ReturnType<typeof setInterval> | null = null;
  private connectTimer:    ReturnType<typeof setInterval> | null = null;

  private optimisticPeer: string | null = null;
  private isSeeding      = false;
  private lastStaleCheck = 0;

  constructor(
    private infoHash: Buffer,
    private pieces:   PieceManager,
    private bw:       TorrentBandwidth,
    ourPeerId?:       Buffer,
    private maxConnections = DEFAULT_MAX_CONNECTIONS,
  ) {
    super();
    this.ourPeerId = ourPeerId ?? generatePeerId();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  start(): void {
    this.chokeTimer      = setInterval(() => this.runChokeAlgorithm(), CHOKE_INTERVAL);
    this.optimisticTimer = setInterval(() => this.rotateOptimistic(),  OPTIMISTIC_INTERVAL);
    this.keepaliveTimer  = setInterval(() => this.sendKeepalives(),    KEEPALIVE_INTERVAL);
    this.requestTimer    = setInterval(() => this.fillRequestQueues(), 50);
    this.connectTimer    = setInterval(() => this.connectToMore(), CONNECT_MAINTENANCE_INTERVAL);
  }

  stop(): void {
    if (this.chokeTimer)      { clearInterval(this.chokeTimer);      this.chokeTimer      = null; }
    if (this.optimisticTimer) { clearInterval(this.optimisticTimer); this.optimisticTimer = null; }
    if (this.keepaliveTimer)  { clearInterval(this.keepaliveTimer);  this.keepaliveTimer  = null; }
    if (this.requestTimer)    { clearInterval(this.requestTimer);    this.requestTimer    = null; }
    if (this.connectTimer)    { clearInterval(this.connectTimer);    this.connectTimer    = null; }

    for (const conn of this.connections.values()) conn.destroy('swarm stopped');
    this.connections.clear();
  }

  setSeeding(seeding: boolean): void {
    this.isSeeding = seeding;
  }

  // ─── Peer management ─────────────────────────────────────────────────────────

  addKnownPeers(peers: PeerAddress[], source: PeerInfo['source'] = 'tracker'): void {
    for (const p of peers) {
      if (!p.ip || p.port <= 0 || p.port > 65535) continue;
      const key = `${p.ip}:${p.port}`;
      this.seenPeers.add(key);
      if (!this.peerSources.has(key)) this.peerSources.set(key, source);
      if (!this.peerStates.has(key)) this.peerStates.set(key, 'known');
      if (!this.knownPeers.has(key) && !this.isTracked(key)) {
        this.knownPeers.set(key, p);
      }
    }
    this.connectToMore();
  }

  onIncomingConnection(socket: Socket, peerId: Buffer): void {
    if (this.connections.size >= this.maxConnections) {
      socket.destroy();
      return;
    }

    const host = socket.remoteAddress ?? '';
    const port = socket.remotePort ?? 0;
    const key = `${host}:${port}`;
    this.seenPeers.add(key);
    this.peerSources.set(key, 'incoming');
    this.peerStates.set(key, 'handshaking');

    if (this.isTracked(key)) {
      socket.destroy();
      return;
    }

    const conn = new PeerConnection({
      host,
      port,
      infoHash: this.infoHash,
      peerId,
      ourPeerId: this.ourPeerId,
      encryption: 'preferred',
      socket,
    });

    this.setupConnection(key, conn);
    conn.connect();
  }

  private connectToMore(): void {
    const needed = this.maxConnections - this.connections.size;
    if (needed <= 0) return;

    const now = Date.now();
    const candidates: PeerAddress[] = [];
    for (const [key, peer] of this.knownPeers) {
      const failed = this.failedPeers.get(key);
      if (failed && failed.retryAfter > now) continue;
      candidates.push(peer);
    }
    candidates.sort((a, b) => this.sourceRank(`${a.ip}:${a.port}`) - this.sourceRank(`${b.ip}:${b.port}`));
    candidates.splice(needed);
    for (const peer of candidates) {
      const key = `${peer.ip}:${peer.port}`;
      this.knownPeers.delete(key);
      this.connectTo(peer.ip, peer.port);
    }
  }

  private connectTo(host: string, port: number): void {
    if (this.connections.size >= this.maxConnections) return;

    const key = `${host}:${port}`;
    if (this.isTracked(key)) return;
    this.seenPeers.add(key);
    this.peerStates.set(key, 'dialing');
    this.connectionAttempts++;

    const conn = new PeerConnection({
      host,
      port,
      infoHash:    this.infoHash,
      peerId:      Buffer.alloc(20),  // will be filled from handshake
      ourPeerId:   this.ourPeerId,
      encryption:  'preferred',
      connectTimeoutMs: 8_000,
    });

    this.setupConnection(key, conn);
    conn.connect();
  }

  private setupConnection(key: string, conn: PeerConnection): void {
    this.connections.set(key, conn);

    conn.on('connect', () => {
      const now = Date.now();
      this.peerStates.set(key, 'handshaking');
      this.peerRelations.set(key, {
        connectedAt: now,
        lastInterestedAt: 0,
        lastUnchokedAt: 0,
        chokedSince: conn.state.peerChoking ? now : null,
      });
      // Send our bitfield
      const bf = this.pieces.haveBitfield;
      if (bf.some(b => b !== 0)) {
        conn.send({ type: 'bitfield', bitfield: bf });
      } else {
        conn.send({ type: 'have-none' });
      }
      // Express interest if we need pieces
      if (!this.pieces.isComplete()) {
        conn.send({ type: 'interested' });
        this.markInterested(key);
      }
    });

    conn.on('handshake', (_hs, _ltep) => {
      this.failedPeers.delete(key);
      this.peerStates.set(key, 'connected');
      this.emit('peer-connected', key);
    });

    conn.on('message', (msg) => {
      if (msg.type === 'piece') {
        // Always count raw bytes against the rate limiter (the bytes already
        // arrived on the wire — refusing to count them won't unsend them).
        const allowed = this.bw.getPeer(key).receive(msg.data.length);
        if (allowed > 0) {
          // Hand to piece manager. It returns whether the block was useful.
          const result = this.pieces.receiveBlock(key, msg.pieceIndex, msg.offset, msg.data);
          // Speed display only counts bytes that became part of a real piece.
          if (result.accepted) {
            this.bw.getPeer(key).recordUseful(result.bytesUseful);
            this.cancelDuplicateRequests(result.canceled);
          }
          this.emit('block-received', msg.pieceIndex, msg.offset, msg.data.length);
          if (!conn.state.peerChoking) {
            this.fillRequestQueue(key, conn);
          }
        }
      }
      if (msg.type === 'have') {
        this.pieces.setPeerHave(key, msg.pieceIndex);
        this.checkInterest(key, conn);
      }
      if (msg.type === 'bitfield') {
        this.pieces.updateBitfield(key, msg.bitfield);
        this.checkInterest(key, conn);
      }
      if (msg.type === 'have-all') {
        // Peer has every piece (Fast Extension) — create a full bitfield
        const fullBf = Buffer.alloc(Math.ceil(this.pieces.pieceCount / 8), 0xff);
        this.pieces.updateBitfield(key, fullBf);
        this.checkInterest(key, conn);
      }
      if (msg.type === 'have-none') {
        // Peer has nothing — clear their bitfield
        const emptyBf = Buffer.alloc(Math.ceil(this.pieces.pieceCount / 8), 0);
        this.pieces.updateBitfield(key, emptyBf);
        this.checkInterest(key, conn);
      }
      if (msg.type === 'allowed-fast') {
        this.pieces.addAllowedFast(key, msg.pieceIndex);
        this.fillRequestQueue(key, conn);
      }
      if (msg.type === 'suggest-piece') {
        // We could prioritize this piece for this peer, but for now just log it
        console.log(`[Swarm] Peer ${key} suggested piece ${msg.pieceIndex}`);
      }
      if (msg.type === 'unchoke' && conn.state.amInterested) {
        this.markUnchoked(key);
        this.fillRequestQueue(key, conn);
      }
      if (msg.type === 'choke') {
        this.markChoked(key);
      }

      if (msg.type === 'extended') {
        // Incoming extended messages arrive with OUR registered IDs.
        // We registered ut_pex=2 in encodeLtepHandshake.
        if (msg.extId === 2) {
          try {
            const pex = decodePex(msg.payload);
            if (pex.added.length > 0) {
              console.log(`[Swarm] PEX discovered ${pex.added.length} new peers from ${key}`);
              this.addKnownPeers(pex.added, 'pex');
            }
          } catch {}
        }
      }
    });

    conn.on('close', (reason) => {
      this.connections.delete(key);
      this.peerRelations.delete(key);
      this.pieces.removePeer(key);
      this.bw.removePeer(key);
      this.recordPeerClose(key, reason);
      this.emit('peer-disconnected', key);
      // Try connecting to more if we dropped below the limit
      this.connectToMore();
    });

    conn.on('error', () => {}); // handled via close
  }

  private isTracked(key: string): boolean {
    return this.connections.has(key);
  }

  private sourceRank(key: string): number {
    const source = this.peerSources.get(key) ?? 'tracker';
    if (source === 'tracker') return 0;
    if (source === 'dht') return 1;
    if (source === 'lpd') return 2;
    if (source === 'pex') return 3;
    return 4;
  }

  private relationFor(key: string): PeerRelationState {
    let relation = this.peerRelations.get(key);
    if (!relation) {
      const now = Date.now();
      relation = { connectedAt: now, lastInterestedAt: 0, lastUnchokedAt: 0, chokedSince: now };
      this.peerRelations.set(key, relation);
    }
    return relation;
  }

  private markInterested(key: string): void {
    this.relationFor(key).lastInterestedAt = Date.now();
  }

  private markChoked(key: string): void {
    const relation = this.relationFor(key);
    if (!relation.chokedSince) relation.chokedSince = Date.now();
  }

  private markUnchoked(key: string): void {
    const relation = this.relationFor(key);
    relation.chokedSince = null;
    relation.lastUnchokedAt = Date.now();
  }

  private recordPeerClose(key: string, reason: string): void {
    const normalized = reason || 'closed';
    const bucket = this.classifyCloseReason(normalized);
    this.closeReasons.set(normalized, (this.closeReasons.get(normalized) ?? 0) + 1);
    this.peerStates.set(key, bucket === 'closed' ? 'closed' : 'failed');
    const previous = this.failedPeers.get(key);
    const failures = (previous?.failures ?? 0) + 1;
    const base = bucket === 'refused' || bucket === 'timeout' || bucket === 'reset'
      ? FAILED_PEER_BASE_COOLDOWN
      : Math.floor(FAILED_PEER_BASE_COOLDOWN / 2);
    const cooldown = Math.min(FAILED_PEER_MAX_COOLDOWN, base * Math.min(failures, 10));
    this.failedPeers.set(key, {
      failures,
      retryAfter: Date.now() + cooldown,
      lastReason: normalized,
      lastFailedAt: Date.now(),
    });
  }

  private classifyCloseReason(reason: string): PeerFailureBucket {
    const r = reason.toLowerCase();
    if (r.includes('timeout') || r.includes('timed out')) return 'timeout';
    if (r.includes('econnrefused') || r.includes('refused')) return 'refused';
    if (r.includes('econnreset') || r.includes('reset')) return 'reset';
    if (r.includes('duplicate-heavy')) return 'duplicate-heavy';
    if (r.includes('unresponsive')) return 'unresponsive';
    if (r.includes('choked-too-long')) return 'choked';
    if (r.includes('handshake') || r.includes('protocol') || r.includes('invalid')) return 'protocol';
    if (r === 'closed' || r.includes('stopped')) return 'closed';
    return 'network';
  }

	  private checkInterest(key: string, conn: PeerConnection): void {
	    if (this.pieces.isComplete()) {
	      if (conn.state.amInterested) {
	        conn.send({ type: 'not-interested' });
	      }
      return;
    }

    // Use the PieceManager's peer bitfield (authoritative) to decide interest.
    // We are interested if the peer has any piece we still need.
    const ourBf = this.pieces.haveBitfield;
    const theirBf = this.pieces.getPeerBitfield(key);
    if (!theirBf) return;

    let interested = false;
    const len = Math.min(ourBf.length, theirBf.length);
    for (let i = 0; i < len; i++) {
      const neededBits = ~(ourBf[i] ?? 0) & (theirBf[i] ?? 0);
      if (neededBits !== 0) {
        interested = true;
        break;
      }
    }

	    if (interested && !conn.state.amInterested) {
	      conn.send({ type: 'interested' });
	      this.markInterested(key);
	    } else if (!interested && conn.state.amInterested) {
	      conn.send({ type: 'not-interested' });
	    }
	  }

  // ─── Request queue filling ────────────────────────────────────────────────────

  private fillRequestQueues(): void {
    if (this.pieces.isComplete()) return;

    // Periodic peer-health audit (every 10 s).
    const now = Date.now();
    if (now - this.lastStaleCheck > 10_000) {
      this.runPeerHealthCheck();
      this.lastStaleCheck = now;
    }

	    for (const [key, conn] of this.connections) {
	      this.refreshPeerInterest(key, conn);
	      if (conn.state.amInterested && conn.state.requestsOut < REQUEST_QUEUE) {
	        this.fillRequestQueue(key, conn);
	      }
	    }
	  }

  private refreshPeerInterest(key: string, conn: PeerConnection): void {
    if (this.pieces.isComplete() || !conn.isConnected) return;
    if (!this.peerHasNeededPiece(key)) return;
    const relation = this.relationFor(key);
    const now = Date.now();
    if (!conn.state.amInterested || now - relation.lastInterestedAt > INTEREST_REFRESH_MS) {
      try {
        conn.send({ type: 'interested' });
        this.markInterested(key);
      } catch {}
    }
  }

  /**
   * Walk connected peers and:
   *   1. Drop peers whose duplicate-arrival ratio is high (they're net-negative).
   *   2. Drop peers that have outstanding requests older than their adaptive timeout
   *      (they've gone unresponsive without closing the socket).
   * Releases the dropped peer's blocks back to the picker AND sends BitTorrent `cancel`
   * messages so the (possibly-still-live) peer stops transmitting now-redundant data.
   */
	  private runPeerHealthCheck(): void {
    const requestDiagnostics = this.pieces.getRequestDiagnostics();
    const chokedTimeout = requestDiagnostics.endGame ? ENDGAME_CHOKED_PEER_TIMEOUT_MS : CHOKED_PEER_TIMEOUT_MS;

	    // Item 4: bad-peer drop based on duplicate ratio.
	    for (const [key, conn] of [...this.connections]) {
	      const stats = this.pieces.getPeerStats(key);
      this.refreshPeerInterest(key, conn);
      if (conn.isConnected && conn.state.peerChoking && conn.state.amInterested && this.peerHasNeededPiece(key)) {
        const relation = this.relationFor(key);
        const chokedForMs = relation.chokedSince ? Date.now() - relation.chokedSince : 0;
        if (chokedForMs > chokedTimeout) {
          this.dropPeer(key, conn, `choked-too-long (${chokedForMs} ms with needed pieces)`);
          continue;
        }
      }
	      if (!stats) continue;
	      const totalBlocks = stats.acceptedBlocks + stats.duplicateBlocks + stats.outOfRangeBlocks;
      if (totalBlocks >= 20) {
        const dupRatio = (stats.duplicateBlocks + stats.outOfRangeBlocks) / totalBlocks;
        if (dupRatio > 0.5) {
          this.dropPeer(key, conn, `duplicate-heavy (${(dupRatio * 100).toFixed(0)}% wasted of ${totalBlocks} blocks)`);
          continue;
        }
      }
    }

    // Items 1 + 3 + 5: stale-peer drop using per-peer adaptive timeouts.
    const stalePeers = this.pieces.findStalePeers(peerId => this.pieces.staleTimeoutFor(peerId, 30_000));
    for (const { peerId, canceled, oldestAgeMs } of stalePeers) {
      const conn = this.connections.get(peerId);
      if (!conn) continue;
      // Send cancels first (so the peer stops transmitting blocks we no longer need),
      // then disconnect.
      for (const c of canceled) {
        this.sendCancel(conn, c);
      }
      this.dropPeer(peerId, conn, `unresponsive (oldest request ${oldestAgeMs} ms, ${canceled.length} blocks)`);
    }
  }

  private dropPeer(key: string, conn: PeerConnection, reason: string): void {
    // Release any remaining requests + send cancels.
    const remaining = this.pieces.releasePeerRequests(key);
    for (const c of remaining) {
      this.sendCancel(conn, c);
    }
    try { conn.destroy(`swarm: ${reason}`); } catch {}
    // Note: conn.on('close') in onIncomingConnection / outgoing path will run removePeer + cleanup.
  }

  private fillRequestQueue(key: string, conn: PeerConnection): void {
    const toRequest = REQUEST_QUEUE - conn.state.requestsOut;
    if (toRequest <= 0) return;

    const requests = this.pieces.nextRequestBatch(key, toRequest, conn.state.peerChoking);
    if (requests.length === 0) return;

    conn.sendMany(requests.map(req => ({
      type:       'request',
      pieceIndex: req.pieceIndex,
      offset:     req.offset,
      length:     req.length,
    })));
  }

  private cancelDuplicateRequests(canceled: CanceledBlock[]): void {
    for (const c of canceled) {
      if (!c.peerId) continue;
      const conn = this.connections.get(c.peerId);
      if (!conn?.isConnected) continue;
      this.sendCancel(conn, c);
    }
  }

  private sendCancel(conn: PeerConnection, c: CanceledBlock): void {
    try {
      conn.send({ type: 'cancel', pieceIndex: c.pieceIndex, offset: c.offset, length: c.length });
      conn.state.requestsOut = Math.max(0, conn.state.requestsOut - 1);
    } catch {}
  }

  // ─── Choking algorithm ────────────────────────────────────────────────────────

  private runChokeAlgorithm(): void {
    const connected = [...this.connections.entries()]
      .filter(([, c]) => c.isConnected);

    // Sort by upload speed to us (leeching) or download speed to them (seeding)
    const sorted = connected.sort(([keyA, connA], [keyB, connB]) => {
      const peerA = this.bw.getPeer(keyA);
      const peerB = this.bw.getPeer(keyB);
      if (this.isSeeding) {
        return peerA.uploadSpeed - peerB.uploadSpeed; // unchoke best downloaders
      }
      return peerB.downloadSpeed - peerA.downloadSpeed; // unchoke best uploaders to us
    });

    let unchoked = 0;
    for (const [key, conn] of sorted) {
      if (key === this.optimisticPeer) continue; // handled separately

      if (unchoked < UNCHOKE_COUNT) {
        if (conn.state.amChoking) {
          conn.send({ type: 'unchoke' });
        }
        unchoked++;
      } else {
        if (!conn.state.amChoking) {
          conn.send({ type: 'choke' });
        }
      }
    }

    // Optimistic unchoke — always unchoke the optimistic peer
    if (this.optimisticPeer) {
      const optConn = this.connections.get(this.optimisticPeer);
      if (optConn?.isConnected && optConn.state.amChoking) {
        optConn.send({ type: 'unchoke' });
      }
    }
  }

  private rotateOptimistic(): void {
    const interested = [...this.connections.entries()]
      .filter(([, c]) => c.isConnected && c.state.peerInterested);
    if (interested.length === 0) return;
    const idx = Math.floor(Math.random() * interested.length);
    this.optimisticPeer = interested[idx]?.[0] ?? null;
  }

  private sendKeepalives(): void {
    const now = Date.now();
    for (const conn of this.connections.values()) {
      if (conn.isConnected && now - conn.state.lastActivity > KEEPALIVE_INTERVAL) {
        conn.sendKeepAlive();
      }
    }
  }

  // ─── Stats ────────────────────────────────────────────────────────────────────

  get connectedCount(): number { return [...this.connections.values()].filter(c => c.isConnected).length; }
  get connectingCount(): number { return Math.max(0, this.connections.size - this.connectedCount); }
  get knownCount():    number { return this.knownPeers.size; }
  get totalSeenCount(): number { return this.seenPeers.size; }
  get failedCount(): number { return this.failedPeers.size; }
  get connectionAttemptCount(): number { return this.connectionAttempts; }

  getDiagnostics(): SwarmDiagnostics {
    const sourceStats = this.peerSourceDiagnostics();
    const requestDiagnostics = this.pieces.getRequestDiagnostics();
    return {
      connected: this.connectedCount,
      connecting: this.connectingCount,
      known: this.knownCount,
      seen: this.totalSeenCount,
      failed: this.failedCount,
      connectionAttempts: this.connectionAttemptCount,
      recentCloseReasons: Object.fromEntries([...this.closeReasons.entries()].slice(-12)),
      failureBuckets: this.failureBucketDiagnostics(),
      peerStates: this.peerStateDiagnostics(),
      peerSources: sourceStats,
      recentFailures: this.recentFailureDiagnostics(),
      availability: this.availabilityDiagnostics(requestDiagnostics),
      requests: requestDiagnostics,
    };
  }

  private peerStateDiagnostics(): Record<string, number> {
    const counts: Record<string, number> = {
      known: 0,
      dialing: 0,
      handshaking: 0,
      connected: 0,
      closed: 0,
      failed: 0,
    };
    for (const state of this.peerStates.values()) {
      counts[state] = (counts[state] ?? 0) + 1;
    }
    return counts;
  }

  private failureBucketDiagnostics(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const failed of this.failedPeers.values()) {
      const bucket = this.classifyCloseReason(failed.lastReason);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    return counts;
  }

  private peerSourceDiagnostics(): Record<string, PeerSourceDiagnostics> {
    const out: Record<string, PeerSourceDiagnostics> = {};
    const ensure = (source: PeerSource): PeerSourceDiagnostics => {
      out[source] ??= { discovered: 0, connecting: 0, connected: 0, failed: 0, useful: 0 };
      return out[source]!;
    };

    for (const [key, source] of this.peerSources) {
      const stats = ensure(source);
      stats.discovered++;
      if (this.failedPeers.has(key)) stats.failed++;
      const state = this.peerStates.get(key);
      if (state === 'dialing' || state === 'handshaking') stats.connecting++;
      if (state === 'connected' && this.connections.get(key)?.isConnected) stats.connected++;
      if ((this.pieces.getPeerStats(key)?.acceptedBlocks ?? 0) > 0) stats.useful++;
    }

    return out;
  }

  private recentFailureDiagnostics(): SwarmDiagnostics['recentFailures'] {
    return [...this.failedPeers.entries()]
      .sort(([, a], [, b]) => b.lastFailedAt - a.lastFailedAt)
      .slice(0, 12)
      .map(([peer, failure]) => ({
        peer,
        source: this.peerSources.get(peer) ?? 'tracker',
        reason: failure.lastReason,
        bucket: this.classifyCloseReason(failure.lastReason),
        failures: failure.failures,
        lastFailedAt: failure.lastFailedAt,
        retryAfter: failure.retryAfter,
      }));
  }

  private availabilityDiagnostics(requests: PieceRequestDiagnostics): SwarmDiagnostics['availability'] {
    const connected = [...this.connections.entries()].filter(([, c]) => c.isConnected);
    const peersWithNeededPieces = connected.filter(([key]) => this.peerHasNeededPiece(key)).length;
	    const peersWithUsefulBlocks = connected.filter(([key]) => (this.pieces.getPeerStats(key)?.acceptedBlocks ?? 0) > 0).length;
	    const hasConnectedSeed = connected.some(([key]) => this.peerProgress(key) >= 0.999);
	    const chokedByPeers = connected.filter(([, conn]) => conn.state.peerChoking && conn.state.amInterested).length;
    const longestChokedMs = connected.reduce((max, [key, conn]) => {
      if (!conn.state.peerChoking || !conn.state.amInterested) return max;
      const since = this.peerRelations.get(key)?.chokedSince;
      return since ? Math.max(max, Date.now() - since) : max;
    }, 0);

    let explanation = 'healthy swarm';
    if (this.pieces.isComplete()) {
      explanation = 'complete';
    } else if (connected.length === 0) {
      explanation = this.failedPeers.size > 0 || this.seenPeers.size > 0
        ? 'trackers returned peers, but peer connections are failing'
        : 'waiting for peers';
	    } else if (peersWithNeededPieces === 0) {
	      explanation = 'connected peers do not have the missing pieces';
	    } else if (chokedByPeers > 0 && chokedByPeers === connected.length) {
	      explanation = 'connected peers are choking us';
	    } else if (requests.endGame && requests.missingPieces <= 20) {
	      explanation = 'waiting on final pieces';
    } else if (peersWithUsefulBlocks === 0) {
      explanation = hasConnectedSeed ? 'connected seed is not currently sending data' : 'no confirmed full seed connected';
    }

    return {
      explanation,
	      hasConnectedSeed,
	      peersWithNeededPieces,
	      peersWithUsefulBlocks,
	      chokedByPeers,
      longestChokedMs,
	    };
	  }

  private peerHasNeededPiece(key: string): boolean {
    const ourBf = this.pieces.haveBitfield;
    const theirBf = this.pieces.getPeerBitfield(key);
    if (!theirBf) return false;
    const len = Math.min(ourBf.length, theirBf.length);
    for (let i = 0; i < len; i++) {
      if (((~(ourBf[i] ?? 0)) & (theirBf[i] ?? 0)) !== 0) return true;
    }
    return false;
  }

  private peerProgress(key: string): number {
    const bitfield = this.pieces.getPeerBitfield(key);
    if (!bitfield || this.pieces.pieceCount === 0) return 0;
    const have = bitfield.reduce((count, byte) => {
      let bits = byte;
      while (bits) {
        count += bits & 1;
        bits >>= 1;
      }
      return count;
    }, 0);
    return have / this.pieces.pieceCount;
  }

  getPeerInfos(): PeerInfo[] {
    return [...this.connections.entries()]
      .filter(([, c]) => c.isConnected)
      .map(([key, conn]) => {
	        const bw = this.bw.getPeer(key);
	        const bitfield = this.pieces.getPeerBitfield(key);
        const relation = this.peerRelations.get(key);
        const peerStats = this.pieces.getPeerStats(key);
        const hasNeededPieces = this.peerHasNeededPiece(key);
        const chokedForMs = conn.state.peerChoking && conn.state.amInterested && relation?.chokedSince
          ? Date.now() - relation.chokedSince
          : 0;
	        const progress = bitfield ? bitfield.reduce((count, byte) => {
          let bits = byte;
          while (bits) {
            count += bits & 1;
            bits >>= 1;
          }
          return count;
        }, 0) / this.pieces.pieceCount : 0;
        const flags = [
          conn.state.amInterested ? 'D' : '',
          conn.state.peerInterested ? 'U' : '',
          conn.state.peerChoking ? 'c' : '',
          conn.state.amChoking ? 'C' : '',
        ].join('');
        return {
          address:         conn.host,
          port:            conn.port,
          clientName:      conn.state.clientName ?? 'Unknown',
          progress:        Math.max(0, Math.min(1, progress)),
          rateToPeer:      bw.uploadSpeed,
          rateToClient:    bw.downloadSpeed,
          isEncrypted:     false, // TODO: expose from PeerConnection
          isUtp:           false,
          isIncoming:      false,
          isDownloadingFrom: !conn.state.peerChoking && conn.state.amInterested,
          isUploadingTo:   !conn.state.amChoking && conn.state.peerInterested,
          isChoked:        conn.state.amChoking,
          isPeerChoked:    conn.state.peerChoking,
          isInterested:    conn.state.amInterested,
	          isPeerInterested:conn.state.peerInterested,
          hasNeededPieces,
          chokedForMs,
          usefulBlocks:    peerStats?.acceptedBlocks ?? 0,
          relation:        !hasNeededPieces ? 'no-needed-pieces' : conn.state.peerChoking ? 'choked' : (peerStats?.acceptedBlocks ?? 0) > 0 ? 'useful' : 'ready',
	          source:          this.peerSources.get(key) ?? 'tracker',
          flagStr:         flags,
        };
      });
  }
}
