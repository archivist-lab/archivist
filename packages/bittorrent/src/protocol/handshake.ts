// BitTorrent handshake protocol
// Spec: https://wiki.theory.org/BitTorrentSpecification#Handshake

import { randomBytes } from 'node:crypto';
import { 
  encode, decode, decodePartial, 
  getString, getNumber, getDict, 
  type BencodeDict 
} from '../bencode/index.js';

// ─── Reserved bits (extension flags) ─────────────────────────────────────────

export const ExtBit = {
  DHT:      { byte: 7, bit: 0 },
  Fast:     { byte: 7, bit: 2 },
  LTEP:     { byte: 5, bit: 4 },
} as const;

const PSTR = Buffer.from('BitTorrent protocol');

// ─── Peer ID generation ───────────────────────────────────────────────────────

export function generatePeerId(): Buffer {
  const prefix = Buffer.from('-TS0100-');
  const random = randomBytes(12);
  return Buffer.concat([prefix, random]);
}

// ─── Handshake frame ──────────────────────────────────────────────────────────

export interface HandshakeOptions {
  infoHash: Buffer;
  peerId: Buffer;
  dht?: boolean;
  fast?: boolean;
  ltep?: boolean;
}

export interface ParsedHandshake {
  infoHash: Buffer;
  peerId: Buffer;
  reserved: Buffer;
  dhtSupported: boolean;
  fastSupported: boolean;
  ltepSupported: boolean;
}

export function encodeHandshake(opts: HandshakeOptions): Buffer {
  const reserved = Buffer.alloc(8);
  if (opts.dht  !== false) setBit(reserved, ExtBit.DHT);
  if (opts.fast !== false) setBit(reserved, ExtBit.Fast);
  if (opts.ltep !== false) setBit(reserved, ExtBit.LTEP);

  return Buffer.concat([
    Buffer.from([PSTR.length]),
    PSTR,
    reserved,
    opts.infoHash,
    opts.peerId,
  ]);
}

export function decodeHandshake(buf: Buffer): ParsedHandshake {
  if (buf.length < 68) {
    throw new HandshakeError(`Handshake too short: ${buf.length} bytes`);
  }
  const pstrLen = buf[0] as number;
  if (pstrLen !== 19) throw new HandshakeError(`Unexpected pstrlen: ${pstrLen}`);
  const pstr = buf.subarray(1, 20);
  if (!pstr.equals(PSTR)) throw new HandshakeError(`Unexpected protocol: ${pstr.toString('ascii')}`);

  const reserved  = buf.subarray(20, 28);
  const infoHash  = Buffer.from(buf.subarray(28, 48));
  const peerId    = Buffer.from(buf.subarray(48, 68));

  return {
    infoHash, peerId, reserved,
    dhtSupported:  hasBit(reserved, ExtBit.DHT),
    fastSupported: hasBit(reserved, ExtBit.Fast),
    ltepSupported: hasBit(reserved, ExtBit.LTEP),
  };
}

export class HandshakeError extends Error {
  constructor(msg: string) { super(msg); this.name = 'HandshakeError'; }
}

function setBit(buf: Buffer, ext: { byte: number; bit: number }): void {
  buf[ext.byte] = (buf[ext.byte] ?? 0) | (1 << ext.bit);
}

function hasBit(buf: Buffer, ext: { byte: number; bit: number }): boolean {
  return ((buf[ext.byte] ?? 0) & (1 << ext.bit)) !== 0;
}

// ─── LTEP extension handshake (BEP 10) ───────────────────────────────────────

export interface LtepHandshakeOptions {
  clientVersion?: string;
  listenPort?: number;
  requestQueue?: number;
  supportedExtensions: LtepExtensions;
  metadataSize?: number;
}

export interface LtepExtensions {
  utMetadata?: number;
  utPex?: number;
}

export interface ParsedLtepHandshake {
  clientVersion: string | null;
  listenPort: number | null;
  requestQueue: number | null;
  extensions: Record<string, number>;
  metadataSize: number | null;
}

export function encodeLtepHandshake(opts: LtepHandshakeOptions): Buffer {
  const m: BencodeDict = {};
  if (opts.supportedExtensions.utMetadata !== undefined) m['ut_metadata'] = opts.supportedExtensions.utMetadata;
  if (opts.supportedExtensions.utPex !== undefined) m['ut_pex'] = opts.supportedExtensions.utPex;

  const dict: BencodeDict = { m };
  if (opts.clientVersion) dict['v'] = Buffer.from(opts.clientVersion, 'utf8');
  if (opts.listenPort)    dict['p'] = opts.listenPort;
  if (opts.requestQueue)  dict['reqq'] = opts.requestQueue;
  if (opts.metadataSize !== undefined) dict['metadata_size'] = opts.metadataSize;

  return encode(dict);
}

export function parseLtepHandshake(payload: Buffer): ParsedLtepHandshake {
  let root: BencodeDict;
  try {
    const decoded = decode(payload);
    if (Array.isArray(decoded) || Buffer.isBuffer(decoded)) throw new Error('not a dict');
    root = decoded as BencodeDict;
  } catch {
    return { clientVersion: null, listenPort: null, requestQueue: null, extensions: {}, metadataSize: null };
  }

  const mDict = getDict(root, 'm') ?? {};
  const extensions: Record<string, number> = {};
  for (const [name, val] of Object.entries(mDict)) {
    if (typeof val === 'number') extensions[name] = val;
  }

  return {
    clientVersion: getString(root, 'v'),
    listenPort:    getNumber(root, 'p'),
    requestQueue:  getNumber(root, 'reqq'),
    extensions,
    metadataSize:  getNumber(root, 'metadata_size'),
  };
}

// ─── ut_metadata extension (BEP 9) ───────────────────────────────────────────

export type UtMetadataMsg =
  | { type: 'request'; piece: number }
  | { type: 'data';    piece: number; totalSize: number; data: Buffer }
  | { type: 'reject';  piece: number };

export function encodeUtMetadata(msg: UtMetadataMsg): Buffer {
  const dict: BencodeDict = { msg_type: msgTypeToInt(msg.type), piece: msg.piece };
  if (msg.type === 'data') dict['total_size'] = msg.totalSize;
  const header = encode(dict);
  if (msg.type === 'data') return Buffer.concat([header, msg.data]);
  return header;
}

export function parseUtMetadata(payload: Buffer): UtMetadataMsg {
  const { value: dict, bytesConsumed } = decodeFirst(payload);
  const msgType = (dict as BencodeDict)['msg_type'];
  const piece   = (dict as BencodeDict)['piece'] as number ?? 0;

  if (msgType === 0) return { type: 'request', piece };
  if (msgType === 2) return { type: 'reject', piece };
  if (msgType === 1) {
    const totalSize = (dict as BencodeDict)['total_size'] as number ?? 0;
    const data = payload.subarray(bytesConsumed);
    return { type: 'data', piece, totalSize, data };
  }
  throw new HandshakeError(`Unknown ut_metadata msg_type: ${String(msgType)}`);
}

function msgTypeToInt(t: string): number {
  return t === 'request' ? 0 : t === 'data' ? 1 : 2;
}

function decodeFirst(buf: Buffer): { value: unknown; bytesConsumed: number } {
  try {
    return decodePartial(buf);
  } catch (e) {
    throw new HandshakeError(`Could not decode ut_metadata header: ${String(e)}`);
  }
}
