// LPD — Local Peer Discovery (BEP 14)
// Spec: https://www.bittorrent.org/beps/bep_0014.html
//
// Peers announce themselves on a multicast group using HTTP-like messages.
// Multicast address: 239.192.152.143:6771 (IPv4), [ff15::efc0:988f]:6771 (IPv6)
//
// Message format:
//   BT-SEARCH * HTTP/1.1\r\n
//   Host: 239.192.152.143:6771\r\n
//   Port: <listening port>\r\n
//   Infohash: <40-char hex>\r\n
//   cookie: <random unique value>\r\n
//   \r\n
//   \r\n

import { createSocket, type Socket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PeerAddress } from './tracker.js';

const MULTICAST_ADDR_V4 = '239.192.152.143';
const MULTICAST_PORT    = 6771;

const ANNOUNCE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Events ───────────────────────────────────────────────────────────────────

export interface LpdEvents {
  'peer-found': [infoHash: string, peer: PeerAddress];
  'error':      [error: Error];
}

// ─── LPD ──────────────────────────────────────────────────────────────────────

export class Lpd extends EventEmitter {
  private socket: Socket | null = null;
  private cookie  = randomBytes(4).toString('hex');
  private intervals: ReturnType<typeof setInterval>[] = [];
  private running = false;

  constructor(private listenPort: number) {
    super();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.socket = createSocket({ type: 'udp4', reuseAddr: true });

    await new Promise<void>((resolve, reject) => {
      this.socket!.bind(MULTICAST_PORT, () => {
        try {
          this.socket!.addMembership(MULTICAST_ADDR_V4);
          this.socket!.setMulticastTTL(1); // local network only
          this.socket!.setMulticastLoopback(false);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      this.socket!.once('error', reject);
    });

    this.socket.on('message', (msg, rinfo) => {
      this.handleMessage(msg.toString('ascii'), rinfo.address, rinfo.port);
    });
    this.socket.on('error', (err) => this.emit('error', err));
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const i of this.intervals) clearInterval(i);
    this.intervals = [];
    try { this.socket?.close(); } catch {}
    this.socket = null;
  }

  /** Begin announcing for an info hash and schedule periodic re-announcements */
  announce(infoHash: string): void {
    this.sendAnnounce(infoHash);
    const i = setInterval(() => this.sendAnnounce(infoHash), ANNOUNCE_INTERVAL_MS);
    this.intervals.push(i);
  }

  private sendAnnounce(infoHash: string): void {
    if (!this.socket || !this.running) return;
    const msg = buildAnnouncement(infoHash, this.listenPort, this.cookie);
    const buf  = Buffer.from(msg, 'ascii');
    this.socket.send(buf, MULTICAST_PORT, MULTICAST_ADDR_V4);
  }

  private handleMessage(raw: string, remoteHost: string, remotePort: number): void {
    const parsed = parseAnnouncement(raw);
    if (!parsed) return;
    if (parsed.cookie === this.cookie) return; // our own message

    this.emit('peer-found', parsed.infoHash.toLowerCase(), {
      ip:   remoteHost,
      port: parsed.port,
    });
  }
}

// ─── Message format ───────────────────────────────────────────────────────────

function buildAnnouncement(infoHash: string, port: number, cookie: string): string {
  return [
    'BT-SEARCH * HTTP/1.1',
    `Host: ${MULTICAST_ADDR_V4}:${MULTICAST_PORT}`,
    `Port: ${port}`,
    `Infohash: ${infoHash.toUpperCase()}`,
    `cookie: ${cookie}`,
    '',
    '',
  ].join('\r\n');
}

interface LpdAnnouncement {
  infoHash: string;
  port:     number;
  cookie:   string | null;
}

function parseAnnouncement(raw: string): LpdAnnouncement | null {
  const lines = raw.split('\r\n');
  if (!lines[0]?.startsWith('BT-SEARCH')) return null;

  let infoHash: string | null = null;
  let port:     number | null = null;
  let cookie:   string | null = null;

  for (const line of lines.slice(1)) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const val = line.slice(sep + 1).trim();

    if (key === 'infohash') infoHash = val;
    if (key === 'port')     port     = parseInt(val, 10);
    if (key === 'cookie')   cookie   = val;
  }

  if (!infoHash || !port || !/^[0-9a-f]{40}$/i.test(infoHash)) return null;

  return { infoHash, port, cookie };
}
