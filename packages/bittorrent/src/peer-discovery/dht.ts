// DHT — Distributed Hash Table (BEP 5)
// Spec: https://www.bittorrent.org/beps/bep_0005.html
//
// Kademlia-based DHT for trackerless peer discovery.
// Each node has a 160-bit nodeId. Distance = XOR of two node IDs.
// Routing table: k-buckets (k=8) organised by distance from our ID.
//
// Main operations:
//   get_peers(infoHash) → find peers downloading a torrent
//   announce_peer(infoHash, port) → tell the DHT we're downloading
//   find_node(targetId) → discover more nodes
//   ping(nodeId) → check if a node is alive

import { createSocket, type Socket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { encode, decode, type BencodeDict, getString, getNumber, getBuffer, getList } from '../bencode/index.js';
import type { PeerAddress } from './tracker.js';

// ─── Node identity ────────────────────────────────────────────────────────────

export type NodeId = Buffer; // 20 bytes

export interface DhtNode {
  id:   NodeId;
  host: string;
  port: number;
  lastSeen: number; // unix ms
  failCount: number;
}

export function generateNodeId(): NodeId {
  return randomBytes(20);
}

/** XOR distance between two node IDs (as Buffer, big-endian) */
export function xorDistance(a: NodeId, b: NodeId): Buffer {
  const out = Buffer.allocUnsafe(20);
  for (let i = 0; i < 20; i++) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  return out;
}

/** Compare two distance buffers: returns -1 / 0 / 1 */
export function cmpDistance(a: Buffer, b: Buffer): number {
  for (let i = 0; i < 20; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// ─── K-bucket ─────────────────────────────────────────────────────────────────

const K = 8; // bucket size

class KBucket {
  nodes: DhtNode[] = [];
  lastChanged = Date.now();

  add(node: DhtNode): void {
    const idx = this.nodes.findIndex(n => n.id.equals(node.id));
    if (idx !== -1) {
      // Move to end (most recently seen)
      this.nodes.splice(idx, 1);
      this.nodes.push({ ...node, lastSeen: Date.now() });
    } else if (this.nodes.length < K) {
      this.nodes.push(node);
    }
    // If full: in a real implementation we'd ping the oldest node and replace
    // if it doesn't respond. For now we just drop the new one.
    this.lastChanged = Date.now();
  }

  remove(id: NodeId): void {
    this.nodes = this.nodes.filter(n => !n.id.equals(id));
  }

  get size(): number { return this.nodes.length; }
}

// ─── Routing table ────────────────────────────────────────────────────────────

class RoutingTable {
  private buckets: KBucket[] = Array.from({ length: 160 }, () => new KBucket());

  constructor(private ownId: NodeId) {}

  private bucketIndex(id: NodeId): number {
    const dist = xorDistance(this.ownId, id);
    // Find the index of the most significant differing bit
    for (let i = 0; i < 20; i++) {
      const b = dist[i] ?? 0;
      if (b === 0) continue;
      return i * 8 + (7 - Math.floor(Math.log2(b)));
    }
    return 159; // same ID
  }

  add(node: DhtNode): void {
    if (node.id.equals(this.ownId)) return;
    const idx = this.bucketIndex(node.id);
    this.buckets[idx]?.add(node);
  }

  /** Return the K closest nodes to targetId */
  closest(targetId: NodeId, count = K): DhtNode[] {
    const all: DhtNode[] = this.buckets.flatMap(b => b.nodes);
    return all
      .sort((a, b) => cmpDistance(xorDistance(targetId, a.id), xorDistance(targetId, b.id)))
      .slice(0, count);
  }

  get totalNodes(): number {
    return this.buckets.reduce((s, b) => s + b.size, 0);
  }
}

// ─── DHT events ───────────────────────────────────────────────────────────────

export interface DhtEvents {
  'peers-found': [infoHash: string, peers: PeerAddress[]];
  'node-added':  [node: DhtNode];
  'ready':       [];
  'error':       [error: Error];
}

// ─── DHT class ────────────────────────────────────────────────────────────────

export interface DhtOptions {
  nodeId?:         NodeId;
  bootstrapNodes?: Array<{ host: string; port: number }>;
  port:            number;
}

const DEFAULT_BOOTSTRAP = [
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'router.bittorrent.com',  port: 6881 },
  { host: 'router.utorrent.com',    port: 6881 },
];

export class Dht extends EventEmitter {
  readonly nodeId: NodeId;
  private table:   RoutingTable;
  private socket:  Socket | null = null;
  private boundPortValue: number | null = null;
  private transactions = new Map<string, {
    resolve: (r: BencodeDict) => void;
    reject:  (e: Error) => void;
    timer:   ReturnType<typeof setTimeout>;
  }>();

  // token storage: remoteNodeId → token (needed for announce_peer)
  private tokens = new Map<string, Buffer>();

  private running = false;
  private announceIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private opts: DhtOptions) {
    super();
    this.nodeId = opts.nodeId ?? generateNodeId();
    this.table  = new RoutingTable(this.nodeId);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.socket = createSocket('udp4');
    this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo.address, rinfo.port));
    this.socket.on('error', (err) => this.emit('error', err));

    await new Promise<void>((resolve, reject) => {
      this.socket!.bind(this.opts.port, () => {
        const address = this.socket!.address();
        this.boundPortValue = typeof address === 'string' ? this.opts.port : address.port;
        resolve();
      });
      this.socket!.once('error', reject);
    });

    // Bootstrap
    const bootstrapNodes = this.opts.bootstrapNodes ?? DEFAULT_BOOTSTRAP;
    console.log(`[DHT] Bootstrapping from ${bootstrapNodes.length} nodes...`);
    for (const node of bootstrapNodes) {
      this.sendFindNode(node.host, node.port, this.nodeId).catch(() => {});
      // Also send a find_node for a random ID to discovery more of the network
      this.sendFindNode(node.host, node.port, generateNodeId()).catch(() => {});
    }

    this.emit('ready');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const interval of this.announceIntervals.values()) clearInterval(interval);
    this.announceIntervals.clear();
    this.socket?.close();
    this.socket = null;
    this.boundPortValue = null;
    for (const t of this.transactions.values()) {
      clearTimeout(t.timer);
      t.reject(new DhtError('DHT stopped'));
    }
    this.transactions.clear();
  }

  // ─── Peer discovery ───────────────────────────────────────────────────────────

  /** Look up peers for a torrent. Results emitted as 'peers-found' events. */
  async getPeers(infoHash: Buffer): Promise<void> {
    const ihHex = infoHash.toString('hex');
    console.log(`[DHT] Searching for peers for ${ihHex}. Routing table: ${this.nodeCount} nodes.`);

    const visited = new Set<string>();
    let pending = this.table.closest(infoHash, 16);

    if (pending.length === 0) {
      console.warn(`[DHT] No nodes in routing table to start search for ${ihHex}`);
      // Try to re-bootstrap if empty
      const bootstrapNodes = this.opts.bootstrapNodes ?? DEFAULT_BOOTSTRAP;
      for (const node of bootstrapNodes) {
        this.sendFindNode(node.host, node.port, this.nodeId).catch(() => {});
      }
      return;
    }

    // Iterative Kademlia lookup: run in parallel rounds of up to 8 queries each.
    // After each round, newly discovered nodes are added to the next round so the
    // lookup converges towards the target infoHash.
    const ALPHA = 8;        // parallel queries per round
    const MAX_ROUNDS = 4;   // cap total rounds to bound latency

    for (let round = 0; round < MAX_ROUNDS && pending.length > 0; round++) {
      const batch: DhtNode[] = [];
      while (batch.length < ALPHA && pending.length > 0) {
        const node = pending.shift()!;
        const key  = `${node.host}:${node.port}`;
        if (!visited.has(key)) {
          visited.add(key);
          batch.push(node);
        }
      }
      if (batch.length === 0) break;

      const results = await Promise.allSettled(
        batch.map(node =>
          this.sendGetPeers(node.host, node.port, infoHash)
            .then(resp => decodeNodes(getBuffer(resp, 'nodes') ?? Buffer.alloc(0)))
            .catch(() => [] as DhtNode[]),
        ),
      );

      const discovered: DhtNode[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') discovered.push(...r.value);
      }

      // Merge newly discovered nodes into the pending list, sorted by distance
      pending = [...pending, ...discovered.filter(n => !visited.has(`${n.host}:${n.port}`))]
        .sort((a, b) => cmpDistance(xorDistance(infoHash, a.id), xorDistance(infoHash, b.id)));
    }
  }

  /** Announce that we're downloading on `port`. Call after getPeers. */
  announcePeer(infoHash: Buffer, port: number): void {
    const key = infoHash.toString('hex');
    const doAnnounce = () => {
      const closest = this.table.closest(infoHash, 8);
      for (const node of closest) {
        const token = this.tokens.get(node.id.toString('hex'));
        if (token) {
          this.sendAnnouncePeer(node.host, node.port, infoHash, port, token).catch(() => {});
        }
      }
    };
    doAnnounce();
    // Re-announce every 28 minutes
    const interval = setInterval(doAnnounce, 28 * 60 * 1000);
    this.announceIntervals.set(key, interval);
  }

  stopAnnouncing(infoHash: Buffer): void {
    const key = infoHash.toString('hex');
    const interval = this.announceIntervals.get(key);
    if (interval) { clearInterval(interval); this.announceIntervals.delete(key); }
  }

  // ─── Message dispatch ─────────────────────────────────────────────────────────

  private handleMessage(data: Buffer, host: string, port: number): void {
    let msg: BencodeDict;
    try {
      msg = decode(data) as BencodeDict;
    } catch { return; }

    const msgType = msg['y'];
    const type = Buffer.isBuffer(msgType) ? msgType.toString('ascii') : String(msgType);

    if (type === 'r') {
      // Response to one of our queries
      const txBuf = msg['t'];
      const txId  = Buffer.isBuffer(txBuf) ? txBuf.toString('hex') : '';
      const t     = this.transactions.get(txId);
      if (t) {
        clearTimeout(t.timer);
        this.transactions.delete(txId);
        const r = msg['r'];
        if (r && !Array.isArray(r) && !Buffer.isBuffer(r)) {
          this.learnNode(r as BencodeDict, host, port);
          t.resolve(r as BencodeDict);
        }
      }
    } else if (type === 'q') {
      // Incoming query — respond to pings and find_node
      this.handleQuery(msg, host, port);
    } else if (type === 'e') {
      // Error response
      const txBuf = msg['t'];
      const txId  = Buffer.isBuffer(txBuf) ? txBuf.toString('hex') : '';
      const t     = this.transactions.get(txId);
      if (t) {
        clearTimeout(t.timer);
        this.transactions.delete(txId);
        t.reject(new DhtError('DHT error response'));
      }
    }
  }

  private handleQuery(msg: BencodeDict, host: string, port: number): void {
    const qBuf = msg['q'];
    const query = Buffer.isBuffer(qBuf) ? qBuf.toString('ascii') : '';
    const txBuf = msg['t'];
    const txId  = Buffer.isBuffer(txBuf) ? Buffer.from(txBuf) : Buffer.alloc(2);
    const args  = msg['a'] as BencodeDict | undefined;
    if (!args) return;

    if (query === 'ping') {
      this.sendResponse(host, port, txId, { id: this.nodeId });
    } else if (query === 'find_node') {
      const target = getBuffer(args, 'target');
      if (target) {
        const nodes = this.table.closest(target);
        this.sendResponse(host, port, txId, {
          id: this.nodeId,
          nodes: encodeNodes(nodes),
        });
      }
    } else if (query === 'get_peers') {
      const infoHash = getBuffer(args, 'info_hash');
      if (infoHash) {
        const token = randomBytes(4);
        const nodeKey = `${host}:${port}`;
        this.tokens.set(nodeKey, token);

        const nodes = this.table.closest(infoHash);
        this.sendResponse(host, port, txId, {
          id:    this.nodeId,
          token,
          nodes: encodeNodes(nodes),
        });
      }
    } else if (query === 'announce_peer') {
      // Accept announce, record the peer
      this.sendResponse(host, port, txId, { id: this.nodeId });
    }
  }

  private learnNode(resp: BencodeDict, host: string, port: number, infoHashHex?: string): void {
    const idBuf = getBuffer(resp, 'id');
    if (!idBuf || idBuf.length !== 20) return;
    this.table.add({ id: idBuf, host, port, lastSeen: Date.now(), failCount: 0 });

    // Parse compact nodes
    const nodesBuf = getBuffer(resp, 'nodes');
    if (nodesBuf) decodeNodes(nodesBuf).forEach(n => this.table.add(n));

    // Parse returned peers
    const valuesList = resp['values'];
    if (Array.isArray(valuesList)) {
      const peers: PeerAddress[] = [];
      for (const v of valuesList) {
        if (Buffer.isBuffer(v) && v.length === 6) {
          peers.push({
            ip:   `${v[0]}.${v[1]}.${v[2]}.${v[3]}`,
            port: v.readUInt16BE(4),
          });
        }
      }
      if (peers.length > 0 && infoHashHex) {
        console.log(`[DHT] Found ${peers.length} peers for ${infoHashHex} from ${host}:${port}`);
        this.emit('peers-found', infoHashHex, peers);
      }
    }

    // Store token for this node
    const token = getBuffer(resp, 'token');
    if (token && idBuf) this.tokens.set(idBuf.toString('hex'), token);
  }

  // ─── Send helpers ─────────────────────────────────────────────────────────────

  private send(host: string, port: number, data: Buffer): void {
    this.socket?.send(data, port, host);
  }

  private query(
    host: string,
    port: number,
    method: string,
    args: BencodeDict,
  ): Promise<BencodeDict> {
    const txId = randomBytes(2);
    const key  = txId.toString('hex');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.transactions.delete(key);
        reject(new DhtError(`DHT timeout: ${method}`));
      }, 10_000);

      this.transactions.set(key, { resolve, reject, timer });

      const msg: BencodeDict = {
        t: txId,
        y: Buffer.from('q'),
        q: Buffer.from(method),
        a: args,
      };
      this.send(host, port, encode(msg));
    });
  }

  private sendResponse(host: string, port: number, txId: Buffer, r: BencodeDict): void {
    const msg: BencodeDict = { t: txId, y: Buffer.from('r'), r };
    this.send(host, port, encode(msg));
  }

  private async sendFindNode(host: string, port: number, target: NodeId): Promise<BencodeDict> {
    const resp = await this.query(host, port, 'find_node', {
      id:     this.nodeId,
      target,
    });
    this.learnNode(resp, host, port);
    return resp;
  }

  private async sendGetPeers(host: string, port: number, infoHash: Buffer): Promise<BencodeDict> {
    const ihHex = infoHash.toString('hex');
    const resp = await this.query(host, port, 'get_peers', {
      id:        this.nodeId,
      info_hash: infoHash,
    });
    this.learnNode(resp, host, port, ihHex);
    return resp;
  }

  private async sendAnnouncePeer(
    host:     string,
    port:     number,
    infoHash: Buffer,
    listenPort: number,
    token:    Buffer,
  ): Promise<void> {
    await this.query(host, port, 'announce_peer', {
      id:         this.nodeId,
      info_hash:  infoHash,
      port:       listenPort,
      token,
      implied_port: 0,
    });
  }

  get nodeCount(): number { return this.table.totalNodes; }
  get boundPort(): number | null { return this.boundPortValue; }
}

// ─── Compact node encoding/decoding ──────────────────────────────────────────
// 26 bytes per node: 20-byte ID + 4-byte IP + 2-byte port

function encodeNodes(nodes: DhtNode[]): Buffer {
  const buf = Buffer.alloc(nodes.length * 26);
  nodes.forEach((n, i) => {
    n.id.copy(buf, i * 26);
    const parts = n.host.split('.').map(Number);
    if (parts.length === 4) {
      for (let j = 0; j < 4; j++) buf[i * 26 + 20 + j] = parts[j]!;
    }
    buf.writeUInt16BE(n.port, i * 26 + 24);
  });
  return buf;
}

function decodeNodes(buf: Buffer): DhtNode[] {
  const nodes: DhtNode[] = [];
  for (let i = 0; i + 26 <= buf.length; i += 26) {
    const id   = Buffer.from(buf.subarray(i, i + 20));
    const ip   = `${buf[i+20]}.${buf[i+21]}.${buf[i+22]}.${buf[i+23]}`;
    const port = buf.readUInt16BE(i + 24);
    nodes.push({ id, host: ip, port, lastSeen: Date.now(), failCount: 0 });
  }
  return nodes;
}

export class DhtError extends Error {
  constructor(msg: string) { super(msg); this.name = 'DhtError'; }
}
