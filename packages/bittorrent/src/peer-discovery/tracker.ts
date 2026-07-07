// Tracker client — HTTP (BEP 3) and UDP (BEP 15) announce + scrape
// HTTP spec:  https://wiki.theory.org/BitTorrentSpecification#Tracker_Request_Parameters
// UDP spec:   https://www.bittorrent.org/beps/bep_0015.html

import { createSocket, type Socket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { decode, type BencodeDict, getString, getNumber, getList, getBuffer } from '../bencode/index.js';
import { EventEmitter } from 'node:events';

// ─── Announce request ─────────────────────────────────────────────────────────

export type AnnounceEvent = 'started' | 'stopped' | 'completed' | '';

export interface AnnounceRequest {
  announceUrl:   string;
  infoHash:      Buffer;           // 20 bytes
  peerId:        Buffer;           // 20 bytes
  port:          number;
  uploaded:      number;
  downloaded:    number;
  left:          number;
  event:         AnnounceEvent;
  compact:       boolean;
  numWant:       number;
  ip?:           string;           // announce_ip override
  key?:          number;           // random key for reconnect correlation
  trackerId?:    string;
  timeoutMs?:     number;
}

export interface AnnounceResponse {
  interval:      number;           // seconds between announces
  minInterval:   number | null;
  trackerId:     string | null;
  complete:      number;           // seeders
  incomplete:    number;           // leechers
  peers:         PeerAddress[];
  warningMessage:string | null;
  failureReason: string | null;
}

export interface PeerAddress {
  ip:   string;
  port: number;
}

// ─── Scrape ───────────────────────────────────────────────────────────────────

export interface ScrapeResponse {
  torrents: Map<string, ScrapeEntry>; // infoHash hex → entry
}

export interface ScrapeEntry {
  seeders:    number;
  completed:  number;
  leechers:   number;
  name:       string | null;
}

// ─── Announce (HTTP) ──────────────────────────────────────────────────────────

export async function httpAnnounce(req: AnnounceRequest): Promise<AnnounceResponse> {
  const url = buildAnnounceUrl(req);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 15_000);

  let res: Response;
  try {
    res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': 'TorrentStack/0.1.0' },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new TrackerError(`HTTP ${res.status} from tracker`);

  const bytes  = Buffer.from(await res.arrayBuffer());
  return parseAnnounceResponse(bytes);
}

function buildAnnounceUrl(req: AnnounceRequest): string {
  // info_hash and peer_id are binary — build them as raw percent-encoded strings
  // and append manually. URLSearchParams would double-encode the % characters.
  const infoHashEncoded = rawUrlEncode(req.infoHash);
  const peerIdEncoded   = rawUrlEncode(req.peerId);

  const params = new URLSearchParams({
    port:       String(req.port),
    uploaded:   String(req.uploaded),
    downloaded: String(req.downloaded),
    left:       String(req.left),
    compact:    req.compact ? '1' : '0',
    numwant:    String(req.numWant),
  });

  if (req.event)     params.set('event',      req.event);
  if (req.ip)        params.set('ip',         req.ip);
  if (req.key)       params.set('key',        String(req.key));
  if (req.trackerId) params.set('trackerid',  req.trackerId);

  const sep = req.announceUrl.includes('?') ? '&' : '?';
  return `${req.announceUrl}${sep}info_hash=${infoHashEncoded}&peer_id=${peerIdEncoded}&${params}`;
}

/** URL-encode a binary buffer using %XX notation */
function rawUrlEncode(buf: Buffer): string {
  return Array.from(buf)
    .map(b => `%${b!.toString(16).padStart(2, '0')}`)
    .join('');
}

function parseAnnounceResponse(data: Buffer): AnnounceResponse {
  const dict = decode(data) as BencodeDict;

  const failure = getString(dict, 'failure reason');
  if (failure) {
    return {
      interval: 1800, minInterval: null, trackerId: null,
      complete: 0, incomplete: 0, peers: [],
      warningMessage: null, failureReason: failure,
    };
  }

  const peers = parsePeers(dict);

  return {
    interval:       getNumber(dict, 'interval') ?? 1800,
    minInterval:    getNumber(dict, 'min interval'),
    trackerId:      getString(dict, 'tracker id'),
    complete:       getNumber(dict, 'complete') ?? 0,
    incomplete:     getNumber(dict, 'incomplete') ?? 0,
    peers,
    warningMessage: getString(dict, 'warning message'),
    failureReason:  null,
  };
}

function parsePeers(dict: BencodeDict): PeerAddress[] {
  const peers: PeerAddress[] = [];
  const raw = dict['peers'];

  if (Buffer.isBuffer(raw)) {
    // Compact format: 6 bytes per peer (4 IP + 2 port)
    for (let i = 0; i + 6 <= raw.length; i += 6) {
      peers.push({
        ip:   `${raw[i]}.${raw[i+1]}.${raw[i+2]}.${raw[i+3]}`,
        port: raw.readUInt16BE(i + 4),
      });
    }
  } else if (Array.isArray(raw)) {
    // Dictionary format
    for (const p of raw) {
      const pd = p as BencodeDict;
      const ip   = getString(pd, 'ip');
      const port = getNumber(pd, 'port');
      if (ip && port) peers.push({ ip, port });
    }
  }

  // IPv6 compact peers
  const peers6 = dict['peers6'];
  if (Buffer.isBuffer(peers6)) {
    for (let i = 0; i + 18 <= peers6.length; i += 18) {
      const ipBytes = peers6.subarray(i, i + 16);
      const parts: string[] = [];
      for (let j = 0; j < 16; j += 2) {
        parts.push(ipBytes.readUInt16BE(j).toString(16));
      }
      peers.push({
        ip:   parts.join(':'),
        port: peers6.readUInt16BE(i + 16),
      });
    }
  }

  return peers;
}

// ─── Announce (UDP) ───────────────────────────────────────────────────────────

const UDP_MAGIC     = 0x41727101980n;   // BigInt
const UDP_ACTION_CONNECT  = 0;
const UDP_ACTION_ANNOUNCE = 1;
const UDP_ACTION_SCRAPE   = 2;
const UDP_ACTION_ERROR    = 3;

export async function udpAnnounce(req: AnnounceRequest): Promise<AnnounceResponse> {
  const url  = new URL(req.announceUrl);
  const host = url.hostname;
  const port = parseInt(url.port || '80', 10);

  const socket = createSocket('udp4');
  socket.unref();

  try {
    // Step 1: Connect request
    const txId1       = randomBytes(4).readUInt32BE(0);
    const connectReq  = buildUdpConnect(txId1);
    const timeoutMs = req.timeoutMs ?? 15_000;
    const connectResp = await udpTransaction(socket, host, port, connectReq, timeoutMs);
    const connId      = parseUdpConnectResponse(connectResp, txId1);

    // Step 2: Announce request
    const txId2        = randomBytes(4).readUInt32BE(0);
    const announceReq  = buildUdpAnnounce(connId, txId2, req);
    const announceResp = await udpTransaction(socket, host, port, announceReq, timeoutMs);
    return parseUdpAnnounceResponse(announceResp, txId2);

  } finally {
    socket.close();
  }
}

function buildUdpConnect(txId: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64BE(UDP_MAGIC, 0);
  buf.writeUInt32BE(UDP_ACTION_CONNECT, 8);
  buf.writeUInt32BE(txId, 12);
  return buf;
}

function parseUdpConnectResponse(buf: Buffer, txId: number): bigint {
  if (buf.length < 16) throw new TrackerError('UDP connect response too short');
  const action = buf.readUInt32BE(0);
  const respTx = buf.readUInt32BE(4);
  if (action !== UDP_ACTION_CONNECT) throw new TrackerError(`Expected connect action, got ${action}`);
  if (respTx !== txId) throw new TrackerError('Transaction ID mismatch');
  return buf.readBigUInt64BE(8);
}

function buildUdpAnnounce(connId: bigint, txId: number, req: AnnounceRequest): Buffer {
  const buf = Buffer.alloc(98);
  buf.writeBigUInt64BE(connId, 0);
  buf.writeUInt32BE(UDP_ACTION_ANNOUNCE, 8);
  buf.writeUInt32BE(txId, 12);
  req.infoHash.copy(buf, 16);
  req.peerId.copy(buf, 36);
  buf.writeBigInt64BE(BigInt(req.downloaded), 56);
  buf.writeBigInt64BE(BigInt(req.left), 64);
  buf.writeBigInt64BE(BigInt(req.uploaded), 72);

  const eventMap: Record<AnnounceEvent, number> = { '': 0, completed: 1, started: 2, stopped: 3 };
  buf.writeUInt32BE(eventMap[req.event], 80);
  buf.writeUInt32BE(0, 84);           // IP address (0 = default)
  buf.writeUInt32BE(req.key ?? 0, 88);
  buf.writeInt32BE(req.numWant, 92);
  buf.writeUInt16BE(req.port, 96);
  return buf;
}

function parseUdpAnnounceResponse(buf: Buffer, txId: number): AnnounceResponse {
  if (buf.length < 20) throw new TrackerError('UDP announce response too short');
  const action = buf.readUInt32BE(0);
  const respTx = buf.readUInt32BE(4);
  if (respTx !== txId) throw new TrackerError('Transaction ID mismatch');

  if (action === UDP_ACTION_ERROR) {
    const msg = buf.subarray(8).toString('utf8');
    return {
      interval: 1800, minInterval: null, trackerId: null,
      complete: 0, incomplete: 0, peers: [],
      warningMessage: null, failureReason: msg,
    };
  }

  if (action !== UDP_ACTION_ANNOUNCE) throw new TrackerError(`Unexpected action ${action}`);

  const interval   = buf.readUInt32BE(8);
  const incomplete = buf.readUInt32BE(12);
  const complete   = buf.readUInt32BE(16);

  const peers: PeerAddress[] = [];
  for (let i = 20; i + 6 <= buf.length; i += 6) {
    peers.push({
      ip:   `${buf[i]}.${buf[i+1]}.${buf[i+2]}.${buf[i+3]}`,
      port: buf.readUInt16BE(i + 4),
    });
  }

  return { interval, minInterval: null, trackerId: null, complete, incomplete, peers, warningMessage: null, failureReason: null };
}

function udpTransaction(
  socket: Socket,
  host: string,
  port: number,
  data: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', handler);
      reject(new TrackerError('UDP timeout'));
    }, timeoutMs);

    const handler = (msg: Buffer) => {
      clearTimeout(timer);
      socket.off('message', handler);
      resolve(msg);
    };

    socket.on('message', handler);
    socket.send(data, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.off('message', handler);
        reject(err);
      }
    });
  });
}

export class TrackerError extends Error {
  constructor(msg: string) { super(msg); this.name = 'TrackerError'; }
}

// ─── Announce dispatcher — picks HTTP or UDP ──────────────────────────────────

export async function announce(req: AnnounceRequest): Promise<AnnounceResponse> {
  const url = req.announceUrl;
  if (url.startsWith('udp://')) return udpAnnounce(req);
  if (url.startsWith('http://') || url.startsWith('https://')) return httpAnnounce(req);
  throw new TrackerError(`Unsupported tracker protocol: ${url}`);
}
