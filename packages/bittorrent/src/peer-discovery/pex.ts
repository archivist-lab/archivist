// PEX — Peer Exchange (BEP 11)
// Spec: https://www.bittorrent.org/beps/bep_0011.html
//
// PEX is sent as an Extended message using the ut_pex extension ID (negotiated
// in the LTEP handshake). Peers exchange lists of peers they know about.
//
// Message format (bencoded dict):
//   added:   compact IPv4 peers (6 bytes each) recently added to swarm
//   added.f: flags for each added peer (1 byte: 0x01=prefers encryption, 0x02=seeder)
//   dropped: compact IPv4 peers recently dropped from swarm
//   added6:  compact IPv6 peers (18 bytes each)
//   added6.f: flags for IPv6 peers
//   dropped6: dropped IPv6 peers

import { encode, decode, type BencodeDict, getBuffer } from '../bencode/index.js';
import type { PeerAddress } from './tracker.js';

// ─── PEX flags ────────────────────────────────────────────────────────────────

export const PexFlag = {
  PrefersEncryption: 0x01,
  IsSeeder:          0x02,
  SupportsUtp:       0x04,
  SupportsHolepunch: 0x08,
  ReachableOutbound: 0x10,
} as const;

export interface PexPeer extends PeerAddress {
  flags: number;
}

// ─── PEX message ─────────────────────────────────────────────────────────────

export interface PexMessage {
  added:    PexPeer[];
  dropped:  PeerAddress[];
  added6:   PexPeer[];
  dropped6: PeerAddress[];
}

// ─── Encode ───────────────────────────────────────────────────────────────────

export function encodePex(msg: PexMessage): Buffer {
  const dict: BencodeDict = {};

  if (msg.added.length > 0) {
    dict['added']   = encodeCompact4(msg.added);
    dict['added.f'] = encodeFlags(msg.added);
  }
  if (msg.dropped.length > 0) {
    dict['dropped'] = encodeCompact4(msg.dropped);
  }
  if (msg.added6.length > 0) {
    dict['added6']    = encodeCompact6(msg.added6);
    dict['added6.f']  = encodeFlags(msg.added6);
  }
  if (msg.dropped6.length > 0) {
    dict['dropped6'] = encodeCompact6(msg.dropped6);
  }

  return encode(dict);
}

// ─── Decode ───────────────────────────────────────────────────────────────────

export function decodePex(payload: Buffer): PexMessage {
  let dict: BencodeDict;
  try {
    dict = decode(payload) as BencodeDict;
  } catch {
    return { added: [], dropped: [], added6: [], dropped6: [] };
  }

  const addedBuf    = getBuffer(dict, 'added');
  const addedFlags  = getBuffer(dict, 'added.f');
  const droppedBuf  = getBuffer(dict, 'dropped');
  const added6Buf   = getBuffer(dict, 'added6');
  const added6Flags = getBuffer(dict, 'added6.f');
  const dropped6Buf = getBuffer(dict, 'dropped6');

  return {
    added:   decodeCompact4(addedBuf, addedFlags),
    dropped: decodeCompact4(droppedBuf),
    added6:  decodeCompact6(added6Buf, added6Flags),
    dropped6:decodeCompact6(dropped6Buf),
  };
}

// ─── Compact encoding helpers ─────────────────────────────────────────────────

function encodeCompact4(peers: PeerAddress[]): Buffer {
  const buf = Buffer.alloc(peers.length * 6);
  peers.forEach((p, i) => {
    const parts = p.ip.split('.').map(Number);
    for (let j = 0; j < 4; j++) buf[i * 6 + j] = parts[j] ?? 0;
    buf.writeUInt16BE(p.port, i * 6 + 4);
  });
  return buf;
}

function decodeCompact4(buf: Buffer | null, flagsBuf?: Buffer | null): PexPeer[] {
  if (!buf) return [];
  const peers: PexPeer[] = [];
  for (let i = 0; i + 6 <= buf.length; i += 6) {
    peers.push({
      ip:    `${buf[i]}.${buf[i+1]}.${buf[i+2]}.${buf[i+3]}`,
      port:  buf.readUInt16BE(i + 4),
      flags: flagsBuf ? (flagsBuf[i / 6] ?? 0) : 0,
    });
  }
  return peers;
}

function encodeCompact6(peers: PeerAddress[]): Buffer {
  const buf = Buffer.alloc(peers.length * 18);
  peers.forEach((p, i) => {
    // Parse IPv6 address to 16 bytes
    const parts = p.ip.split(':').map(s => parseInt(s || '0', 16));
    for (let j = 0; j < 8; j++) {
      buf.writeUInt16BE(parts[j] ?? 0, i * 18 + j * 2);
    }
    buf.writeUInt16BE(p.port, i * 18 + 16);
  });
  return buf;
}

function decodeCompact6(buf: Buffer | null, flagsBuf?: Buffer | null): PexPeer[] {
  if (!buf) return [];
  const peers: PexPeer[] = [];
  for (let i = 0; i + 18 <= buf.length; i += 18) {
    const parts: string[] = [];
    for (let j = 0; j < 8; j++) parts.push(buf.readUInt16BE(i + j * 2).toString(16));
    peers.push({
      ip:    parts.join(':'),
      port:  buf.readUInt16BE(i + 16),
      flags: flagsBuf ? (flagsBuf[i / 18] ?? 0) : 0,
    });
  }
  return peers;
}

function encodeFlags(peers: PexPeer[]): Buffer {
  return Buffer.from(peers.map(p => p.flags));
}

// ─── Rate limiter: spec says max 50 added + 50 dropped per message, once/minute ──

export class PexManager {
  private lastSent   = 0;
  private pendingAdd: Set<string>  = new Set();
  private pendingDrop: Set<string> = new Set();

  addPeer(peer: PexPeer): void {
    const key = `${peer.ip}:${peer.port}`;
    this.pendingAdd.add(key);
    this.pendingDrop.delete(key);
  }

  dropPeer(peer: PeerAddress): void {
    const key = `${peer.ip}:${peer.port}`;
    this.pendingDrop.add(key);
    this.pendingAdd.delete(key);
  }

  /** Returns a PEX message if it's time to send one (once per 60s), else null */
  flush(flags: Map<string, number> = new Map()): PexMessage | null {
    const now = Date.now();
    if (now - this.lastSent < 60_000) return null;
    this.lastSent = now;

    const addedKeys   = [...this.pendingAdd].slice(0, 50);
    const droppedKeys = [...this.pendingDrop].slice(0, 50);

    this.pendingAdd  = new Set([...this.pendingAdd].slice(50));
    this.pendingDrop = new Set([...this.pendingDrop].slice(50));

    const toPeer = (key: string): PexPeer => {
      const [ip, portStr] = key.split(':');
      return { ip: ip ?? '', port: parseInt(portStr ?? '0', 10), flags: flags.get(key) ?? 0 };
    };

    return {
      added:    addedKeys.map(toPeer),
      dropped:  droppedKeys.map(k => { const [ip, p] = k.split(':'); return { ip: ip ?? '', port: parseInt(p ?? '0', 10) }; }),
      added6:   [],
      dropped6: [],
    };
  }
}
