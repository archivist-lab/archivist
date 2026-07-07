// Bandwidth manager — hierarchical rate limiting.
//
// Structure:
//   Session (global limits)
//     └── BandwidthGroup (named pools, e.g. "seeding", "priority")
//           └── TorrentBandwidth (per-torrent limits)
//                 └── PeerBandwidth (per-connection allocation)
//
// Algorithm: token bucket — each limiter accumulates tokens at its rate limit
// and peer connections draw from their torrent's bucket, which draws from the group,
// which draws from the session. A rate of 0 = unlimited.

const TICK_MS  = 100;          // refill interval
const MAX_BURST_FACTOR = 1.5;  // allow short bursts up to 1.5× the rate limit

export interface RateLimits {
  downloadKBs: number;   // kB/s, 0 = unlimited
  uploadKBs:   number;   // kB/s, 0 = unlimited
}

// ─── Token bucket ─────────────────────────────────────────────────────────────

class TokenBucket {
  private tokens:  number;
  private maxRate: number;  // bytes/tick

  constructor(kBs: number) {
    this.maxRate = (kBs * 1024 * TICK_MS) / 1000;
    this.tokens  = this.maxRate * MAX_BURST_FACTOR;
  }

  setRate(kBs: number): void {
    this.maxRate = (kBs * 1024 * TICK_MS) / 1000;
  }

  refill(): void {
    if (this.maxRate === 0) return; // unlimited — no tracking needed
    this.tokens = Math.min(this.tokens + this.maxRate, this.maxRate * MAX_BURST_FACTOR);
  }

  /** Try to consume `bytes` tokens. Returns actual bytes allowed (may be less). */
  consume(bytes: number): number {
    if (this.maxRate === 0) return bytes;           // unlimited
    const allowed = Math.min(bytes, Math.max(0, this.tokens));
    this.tokens -= allowed;
    return allowed;
  }

  get isUnlimited(): boolean { return this.maxRate === 0; }
}

// ─── Per-peer bandwidth slice ──────────────────────────────────────────────────

export class PeerBandwidth {
  private downloaded = 0;        // raw bytes received from peer (incl. duplicates)
  private usefulDown = 0;        // bytes that became part of a valid piece
  private uploaded   = 0;
  private dlUsefulSamples: number[] = [];   // bytes per tick — only counted when block was accepted
  private ulSamples: number[] = [];
  private currentTickUseful = 0; // accumulator drained by tick()

  constructor(
    private parent: TorrentBandwidth,
    private peerId: string,
  ) {}

  /** Called when bytes are received from this peer. Returns actually allowed bytes.
   *  This is the RAW counter — used for rate limiting. Speed display reads useful bytes only. */
  receive(bytes: number): number {
    const allowed = this.parent.consumeDown(bytes);
    this.downloaded += allowed;
    return allowed;
  }

  /** Called when a received block was accepted by the piece manager (not a duplicate / OOR / already-have). */
  recordUseful(bytes: number): void {
    this.usefulDown += bytes;
    this.currentTickUseful += bytes;
    this.parent.recordUsefulDown(bytes);
  }

  /** Called when bytes are sent to this peer. Returns actually allowed bytes. */
  send(bytes: number): number {
    const allowed = this.parent.consumeUp(bytes);
    this.uploaded += allowed;
    this.ulSamples.push(allowed);
    if (this.ulSamples.length > 10) this.ulSamples.shift();
    return allowed;
  }

  /** Called every TICK_MS by the parent torrent — drains the per-tick accumulators. */
  tick(): void {
    this.dlUsefulSamples.push(this.currentTickUseful);
    if (this.dlUsefulSamples.length > 10) this.dlUsefulSamples.shift();
    this.currentTickUseful = 0;
  }

  get downloadSpeed(): number {
    if (this.dlUsefulSamples.length === 0) return 0;
    const sum = this.dlUsefulSamples.reduce((a, b) => a + b, 0);
    return (sum / (this.dlUsefulSamples.length * TICK_MS)) * 1000;
  }

  get uploadSpeed(): number {
    const sum = this.ulSamples.reduce((a, b) => a + b, 0);
    return (sum / (this.ulSamples.length * TICK_MS)) * 1000;
  }

  get totalDown():   number { return this.downloaded; }
  get totalUseful(): number { return this.usefulDown; }
  get totalUp():     number { return this.uploaded; }
  get id():          string { return this.peerId; }
}

// ─── Per-torrent bandwidth ────────────────────────────────────────────────────

export class TorrentBandwidth {
  private downBucket: TokenBucket;
  private upBucket:   TokenBucket;
  private peers       = new Map<string, PeerBandwidth>();

  private dlSamples: number[] = [];
  private ulSamples: number[] = [];
  private lastDl = 0;
  private lastUl = 0;

  private totalDownBytes = 0;       // raw downloaded bytes (incl. duplicates)
  private totalUsefulDown = 0;      // bytes that became part of a valid piece
  private lastUsefulDl = 0;
  private totalUpBytes   = 0;
  private lastActivityAt = Date.now();

  constructor(
    private parent: SessionBandwidth,
    limits: RateLimits,
  ) {
    this.downBucket = new TokenBucket(limits.downloadKBs);
    this.upBucket   = new TokenBucket(limits.uploadKBs);
  }

  setLimits(limits: RateLimits): void {
    this.downBucket.setRate(limits.downloadKBs);
    this.upBucket.setRate(limits.uploadKBs);
  }

  getPeer(peerId: string): PeerBandwidth {
    let pb = this.peers.get(peerId);
    if (!pb) {
      pb = new PeerBandwidth(this, peerId);
      this.peers.set(peerId, pb);
    }
    return pb;
  }

  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  consumeDown(bytes: number): number {
    const sessionAllowed = this.parent.consumeDown(bytes);
    const allowed = this.downBucket.consume(sessionAllowed);
    if (allowed > 0) {
      this.totalDownBytes += allowed;
      this.lastActivityAt = Date.now();
    }
    return allowed;
  }

  consumeUp(bytes: number): number {
    const sessionAllowed = this.parent.consumeUp(bytes);
    const allowed = this.upBucket.consume(sessionAllowed);
    if (allowed > 0) {
      this.totalUpBytes += allowed;
      this.lastActivityAt = Date.now();
    }
    return allowed;
  }

  /** Called by a peer when one of its blocks was accepted by the piece manager. */
  recordUsefulDown(bytes: number): void {
    this.totalUsefulDown += bytes;
    this.lastActivityAt = Date.now();
  }

  tick(): void {
    this.downBucket.refill();
    this.upBucket.refill();

    // Drive per-peer sample drainage
    for (const p of this.peers.values()) p.tick();

    // Sample useful (post-acceptance) download bytes — this is what downloadSpeed reports.
    const dlDelta = this.totalUsefulDown - this.lastUsefulDl;
    const ulDelta = this.totalUpBytes - this.lastUl;
    this.lastUsefulDl = this.totalUsefulDown;
    this.lastUl = this.totalUpBytes;
    // Maintain `lastDl` to keep raw-byte sampling available if a future caller needs it.
    this.lastDl = this.totalDownBytes;

    this.dlSamples.push(dlDelta);
    this.ulSamples.push(ulDelta);
    if (this.dlSamples.length > 10) this.dlSamples.shift();
    if (this.ulSamples.length > 10) this.ulSamples.shift();
  }

  get totalDown():   number { return this.totalDownBytes; }
  get totalUseful(): number { return this.totalUsefulDown; }
  get totalUp():     number { return this.totalUpBytes; }
  get lastActivity(): number { return this.lastActivityAt; }

  get downloadSpeed(): number {
    const sum = this.dlSamples.reduce((a, b) => a + b, 0);
    return (sum / (this.dlSamples.length * TICK_MS)) * 1000;
  }

  get uploadSpeed(): number {
    const sum = this.ulSamples.reduce((a, b) => a + b, 0);
    return (sum / (this.ulSamples.length * TICK_MS)) * 1000;
  }
}

// ─── Session-level bandwidth (root limiter) ───────────────────────────────────

export class SessionBandwidth {
  private downBucket: TokenBucket;
  private upBucket:   TokenBucket;
  private altDownBucket: TokenBucket;
  private altUpBucket:   TokenBucket;

  private altMode    = false;
  private torrents   = new Map<string, TorrentBandwidth>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private dlSamples: number[] = [];
  private ulSamples: number[] = [];
  private lastDl = 0;
  private lastUl = 0;

  constructor(
    normal: RateLimits,
    alt:    RateLimits,
  ) {
    this.downBucket    = new TokenBucket(normal.downloadKBs);
    this.upBucket      = new TokenBucket(normal.uploadKBs);
    this.altDownBucket = new TokenBucket(alt.downloadKBs);
    this.altUpBucket   = new TokenBucket(alt.uploadKBs);
  }

  start(): void {
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  setNormalLimits(limits: RateLimits): void {
    this.downBucket.setRate(limits.downloadKBs);
    this.upBucket.setRate(limits.uploadKBs);
  }

  setAltLimits(limits: RateLimits): void {
    this.altDownBucket.setRate(limits.downloadKBs);
    this.altUpBucket.setRate(limits.uploadKBs);
  }

  setAltMode(enabled: boolean): void {
    this.altMode = enabled;
  }

  createTorrentBandwidth(id: string, limits: RateLimits): TorrentBandwidth {
    const tb = new TorrentBandwidth(this, limits);
    this.torrents.set(id, tb);
    return tb;
  }

  removeTorrentBandwidth(id: string): void {
    this.torrents.delete(id);
  }

  consumeDown(bytes: number): number {
    const bucket = this.altMode ? this.altDownBucket : this.downBucket;
    return bucket.consume(bytes);
  }

  consumeUp(bytes: number): number {
    const bucket = this.altMode ? this.altUpBucket : this.upBucket;
    return bucket.consume(bytes);
  }

  private tick(): void {
    const active = this.altMode ? this.altDownBucket : this.downBucket;
    const activeUp = this.altMode ? this.altUpBucket : this.upBucket;
    active.refill();
    activeUp.refill();

    for (const tb of this.torrents.values()) tb.tick();

    // Session-level speed sampling
    const totalDl = [...this.torrents.values()].reduce((s, t) => s + t.downloadSpeed, 0);
    const totalUl = [...this.torrents.values()].reduce((s, t) => s + t.uploadSpeed, 0);
    this.dlSamples.push(totalDl);
    this.ulSamples.push(totalUl);
    if (this.dlSamples.length > 10) this.dlSamples.shift();
    if (this.ulSamples.length > 10) this.ulSamples.shift();
  }

  get downloadSpeed(): number {
    return this.dlSamples.reduce((a, b) => a + b, 0) / Math.max(this.dlSamples.length, 1);
  }

  get uploadSpeed(): number {
    return this.ulSamples.reduce((a, b) => a + b, 0) / Math.max(this.ulSamples.length, 1);
  }

  get isAltMode(): boolean { return this.altMode; }
}
