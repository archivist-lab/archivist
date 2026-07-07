import { createHash } from 'node:crypto';
import { decode, getString, getNumber, getBuffer, getList, getDict, type BencodeDict, type BencodeValue } from './bencode/index.js';

// ─── Parsed torrent metadata ──────────────────────────────────────────────────

export interface TorrentMetainfo {
  infoHash: string;                 // 40-char hex
  infoHashBuffer: Buffer;           // raw 20-byte SHA1
  name: string;
  comment: string | null;
  createdBy: string | null;
  creationDate: number | null;      // unix seconds
  encoding: string | null;
  isPrivate: boolean;

  // Size
  pieceLength: number;
  pieces: Buffer[];                 // array of 20-byte SHA1 hashes, one per piece
  totalSize: number;

  // Files
  isSingleFile: boolean;
  files: MetainfoFile[];

  // Trackers (announce-list takes precedence over announce)
  trackers: string[][];             // outer = tiers, inner = URLs per tier

  // Web seeds (BEP 19)
  webSeeds: string[];

  // DHT nodes (for trackerless)
  nodes: Array<[host: string, port: number]>;

  // Raw info dict bytes (used to verify infoHash and for magnet links)
  rawInfoBytes: Buffer;
}

export interface MetainfoFile {
  path: string;                     // relative path, using '/' separator
  sizeBytes: number;
  md5sum: string | null;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

export class TorrentParseError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TorrentParseError';
  }
}

export function parseTorrentFile(data: Buffer): TorrentMetainfo {
  let root: BencodeDict;
  try {
    const decoded = decode(data);
    if (Array.isArray(decoded) || Buffer.isBuffer(decoded) || typeof decoded !== 'object') {
      throw new TorrentParseError('Root is not a dictionary');
    }
    root = decoded as BencodeDict;
  } catch (e) {
    throw new TorrentParseError(`Failed to decode bencode: ${String(e)}`);
  }

  const info = getDict(root, 'info');
  if (!info) throw new TorrentParseError('Missing info dict');

  // ── Info hash ──────────────────────────────────────────────────────────────
  // Extract the raw bencoded info dict bytes directly from the buffer for
  // accurate SHA1 hashing (re-encoding would risk key order differences).
  const rawInfoBytes = extractInfoBytes(data);
  const infoHashBuffer = createHash('sha1').update(rawInfoBytes).digest();
  const infoHash = infoHashBuffer.toString('hex');

  // ── Name ───────────────────────────────────────────────────────────────────
  const name = getString(info, 'name') ?? getString(info, 'name.utf-8') ?? infoHash;

  // ── Piece data ─────────────────────────────────────────────────────────────
  const pieceLength = getNumber(info, 'piece length');
  if (!pieceLength) throw new TorrentParseError('Missing piece length');

  const piecesBuf = getBuffer(info, 'pieces');
  if (!piecesBuf || piecesBuf.length % 20 !== 0) {
    throw new TorrentParseError('Invalid pieces field');
  }
  const pieces: Buffer[] = [];
  for (let i = 0; i < piecesBuf.length; i += 20) {
    pieces.push(piecesBuf.subarray(i, i + 20));
  }

  // ── Private flag ───────────────────────────────────────────────────────────
  const isPrivate = getNumber(info, 'private') === 1;

  // ── Files ──────────────────────────────────────────────────────────────────
  let files: MetainfoFile[];
  let totalSize = 0;
  let isSingleFile = false;

  const filesList = getList(info, 'files');
  if (filesList) {
    // Multi-file torrent
    files = filesList.map((f, i) => {
      const fd = f as BencodeDict;
      const length = getNumber(fd, 'length') ?? 0;
      totalSize += length;

      const pathList = getList(fd, 'path.utf-8') ?? getList(fd, 'path') ?? [];
      const pathStr = pathList
        .map(p => (Buffer.isBuffer(p) ? p.toString('utf8') : String(p)))
        .join('/');

      return {
        path: pathStr || `file${i}`,
        sizeBytes: length,
        md5sum: getString(fd, 'md5sum'),
      };
    });
  } else {
    // Single-file torrent
    isSingleFile = true;
    const length = getNumber(info, 'length');
    if (length === null) throw new TorrentParseError('Missing length in single-file torrent');
    totalSize = length;
    files = [{
      path: name,
      sizeBytes: length,
      md5sum: getString(info, 'md5sum'),
    }];
  }

  // ── Trackers ───────────────────────────────────────────────────────────────
  const trackers: string[][] = [];
  const announceList = getList(root, 'announce-list');
  if (announceList) {
    for (const tier of announceList) {
      if (Array.isArray(tier)) {
        const urls = tier
          .map(u => (Buffer.isBuffer(u) ? u.toString('utf8') : String(u)))
          .filter(u => u.startsWith('http') || u.startsWith('udp'));
        if (urls.length > 0) trackers.push(urls);
      }
    }
  }
  // Fall back to single announce
  if (trackers.length === 0) {
    const announce = getString(root, 'announce');
    if (announce) trackers.push([announce]);
  }

  // ── Web seeds ──────────────────────────────────────────────────────────────
  const webSeeds: string[] = [];
  const urlList = getList(root, 'url-list');
  if (urlList) {
    for (const u of urlList) {
      const url = Buffer.isBuffer(u) ? u.toString('utf8') : String(u);
      if (url) webSeeds.push(url);
    }
  }

  // ── DHT nodes ─────────────────────────────────────────────────────────────
  const nodes: Array<[string, number]> = [];
  const nodeList = getList(root, 'nodes');
  if (nodeList) {
    for (const n of nodeList) {
      if (Array.isArray(n) && n.length === 2) {
        const host = Buffer.isBuffer(n[0]) ? n[0].toString('utf8') : String(n[0]);
        const port = typeof n[1] === 'number' ? n[1] : 0;
        nodes.push([host, port]);
      }
    }
  }

  return {
    infoHash,
    infoHashBuffer,
    name,
    comment: getString(root, 'comment'),
    createdBy: getString(root, 'created by'),
    creationDate: getNumber(root, 'creation date'),
    encoding: getString(root, 'encoding'),
    isPrivate,
    pieceLength,
    pieces,
    totalSize,
    isSingleFile,
    files,
    trackers,
    webSeeds,
    nodes,
    rawInfoBytes,
  };
}

// ─── Extract raw info dict bytes from the original buffer ────────────────────
// We scan for "4:info" (or "info") and extract the bencoded value that follows.
// This avoids re-encoding which could theoretically change byte order.

function extractInfoBytes(data: Buffer): Buffer {
  const marker = Buffer.from('4:info');
  const idx = data.indexOf(marker);
  if (idx === -1) throw new TorrentParseError('Cannot find info key in torrent');

  // The value starts right after the marker
  const valueStart = idx + marker.length;
  const valueLen = measureBencodeLength(data, valueStart);
  return data.subarray(valueStart, valueStart + valueLen);
}

/** Return the byte length of a single bencoded value starting at pos */
function measureBencodeLength(buf: Buffer, pos: number): number {
  const ch = buf[pos];
  if (ch === undefined) throw new TorrentParseError('Out of bounds in measureBencodeLength');

  // Integer
  if (ch === 0x69 /* i */) {
    const end = buf.indexOf(0x65 /* e */, pos + 1);
    if (end === -1) throw new TorrentParseError('Unterminated integer');
    return end - pos + 1;
  }

  // List
  if (ch === 0x6c /* l */) {
    let p = pos + 1;
    while (buf[p] !== 0x65 /* e */) p += measureBencodeLength(buf, p);
    return p - pos + 1;
  }

  // Dict
  if (ch === 0x64 /* d */) {
    let p = pos + 1;
    while (buf[p] !== 0x65 /* e */) {
      p += measureBencodeLength(buf, p); // key
      p += measureBencodeLength(buf, p); // value
    }
    return p - pos + 1;
  }

  // String
  if (ch >= 0x30 && ch <= 0x39 /* 0-9 */) {
    const colon = buf.indexOf(0x3a /* : */, pos);
    if (colon === -1) throw new TorrentParseError('Missing colon in string');
    const len = parseInt(buf.subarray(pos, colon).toString('ascii'), 10);
    return colon - pos + 1 + len;
  }

  throw new TorrentParseError(`Unknown bencode type at pos ${pos}: ${ch}`);
}

// ─── Magnet link parser ───────────────────────────────────────────────────────

export interface MagnetLink {
  infoHash: string;
  infoHashBuffer: Buffer;
  name: string | null;
  trackers: string[];
  webSeeds: string[];
}

export function parseMagnetLink(magnet: string): MagnetLink {
  if (!magnet.startsWith('magnet:?')) {
    throw new TorrentParseError('Not a magnet link');
  }

  const params = new URLSearchParams(magnet.slice(8));
  const xt = params.get('xt');
  if (!xt) throw new TorrentParseError('Missing xt parameter');

  let infoHash: string;
  if (xt.startsWith('urn:btih:')) {
    const raw = xt.slice(9);
    // May be hex (40 chars) or base32 (32 chars)
    if (raw.length === 40) {
      infoHash = raw.toLowerCase();
    } else if (raw.length === 32) {
      infoHash = base32ToHex(raw);
    } else {
      throw new TorrentParseError(`Invalid info hash length: ${raw.length}`);
    }
  } else {
    throw new TorrentParseError(`Unsupported xt: ${xt}`);
  }

  const infoHashBuffer = Buffer.from(infoHash, 'hex');

  const trackers: string[] = [];
  for (const tr of params.getAll('tr')) {
    if (tr) trackers.push(tr);
  }

  const webSeeds: string[] = [];
  for (const ws of params.getAll('ws')) {
    if (ws) webSeeds.push(ws);
  }

  return {
    infoHash,
    infoHashBuffer,
    name: params.get('dn'),
    trackers,
    webSeeds,
  };
}

// ─── Base32 → hex ─────────────────────────────────────────────────────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(b32: string): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const char of b32.toUpperCase()) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new TorrentParseError(`Invalid base32 char: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output += ((value >>> (bits - 8)) & 0xff).toString(16).padStart(2, '0');
      bits -= 8;
    }
  }

  return output;
}
