// PeerConnection: manages the full lifecycle of a single peer connection.
// Handles TCP connect → MSE negotiation → BT handshake → LTEP handshake → message loop.

import { createConnection, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
  encodeHandshake, decodeHandshake,
  encodeLtepHandshake, parseLtepHandshake,
  type ParsedHandshake, type ParsedLtepHandshake,
} from './handshake.js';
import { encodeMessage, MessageStream, type WireMessage } from './wire.js';
import { msHandshakeInitiator, type MseResult } from './mse.js';

// ─── Connection configuration ─────────────────────────────────────────────────

export interface PeerConnectionOptions {
  host: string;
  port: number;
  infoHash: Buffer;
  peerId: Buffer;
  ourPeerId: Buffer;
  encryption: 'preferred' | 'required' | 'disabled';
  connectTimeoutMs?: number;
  downloadLimit?: number;
  uploadLimit?: number;
  socket?: Socket; // existing socket for incoming conns
}

// ─── Peer state ───────────────────────────────────────────────────────────────

export interface PeerState {
  amChoking:      boolean;
  amInterested:   boolean;
  peerChoking:    boolean;
  peerInterested: boolean;
  bitfield:       Buffer | null;
  extensionIds:   Record<string, number>;
  clientName:     string | null;
  listenPort:     number | null;
  metadataSize:   number | null;
  requestsOut:    number;
  bytesDown:      number;
  bytesUp:        number;
  lastActivity:   number;
}

// ─── PeerConnection ───────────────────────────────────────────────────────────

export class PeerConnection extends EventEmitter {
  readonly host: string;
  readonly port: number;
  readonly infoHash: Buffer;
  readonly peerId: Buffer;
  readonly isIncoming: boolean;

  private socket:  Socket | null = null;
  private mse:     MseResult | null = null;
  private stream:  MessageStream = new MessageStream();
  private closed   = false;
  private readQueue: Buffer[] = [];
  private readQueueLen = 0;
  private handshakeDone = false;
  private pendingReads: Array<{ resolve: (chunk: Buffer) => void; reject: (err: Error) => void }> = [];
  private pendingWaiters: Array<{ predicate: (m: WireMessage) => boolean; resolve: (m: any) => void; timer: ReturnType<typeof setTimeout> }> = [];

  // Reconnect tracking: set true before reconnecting so destroy() suppresses the 'close' event
  private _reconnecting = false;

  state: PeerState = {
    amChoking:      true,
    amInterested:   false,
    peerChoking:    true,
    peerInterested: false,
    bitfield:       null,
    extensionIds:   {},
    clientName:     null,
    listenPort:     null,
    metadataSize:   null,
    requestsOut:    0,
    bytesDown:      0,
    bytesUp:        0,
    lastActivity:   Date.now(),
  };

  constructor(private opts: PeerConnectionOptions) {
    super();
    this.host       = opts.host;
    this.port       = opts.port;
    this.infoHash   = opts.infoHash;
    this.peerId     = opts.peerId;
    this.isIncoming = !!opts.socket;
  }

  connect(): void {
    if (this.opts.socket) {
      this.socket = this.opts.socket;
      this._setupSocket(this.socket, false);
      this.doHandshake(false).catch(err => this.destroy(`Handshake failed: ${err.message}`));
    } else {
      this._startSocket(false);
    }
  }

  private _startSocket(skipMse: boolean): void {
    const timeout = this.opts.connectTimeoutMs ?? 15_000;
    const socket  = createConnection({
      host: this.host,
      port: this.port,
    });
    this.socket   = socket;

    const timer = setTimeout(() => this.destroy('connect timeout'), timeout);

    socket.once('connect', () => {
      clearTimeout(timer);
      this._setupSocket(socket, skipMse);
      this.doHandshake(skipMse).catch(err => {
        if (err.message === '__NEED_PLAINTEXT__' && !skipMse) {
          this._reconnecting = true;
          this.closed = false;
          this.socket = null;
          this.readQueue = [];
          this.readQueueLen = 0;
          this.mse = null;
          this.stream = new MessageStream();
          this.pendingReads = [];
          this.pendingWaiters = [];
          this.handshakeDone = false;
          this._startSocket(true);
        } else {
          this.destroy(`Handshake failed: ${err.message}`);
        }
      });
    });

    socket.on('error', (err) => {
      console.warn(`[PeerConnection] Socket error ${this.host}:${this.port}: ${err.message}`);
      this.destroy(`socket error: ${err.message}`);
    });
    socket.on('close', () => this.destroy('socket closed'));
  }

  private _setupSocket(socket: Socket, _skipMse: boolean): void {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);

    socket.on('data', (chunk: Buffer) => {
      this.state.bytesDown  += chunk.length;
      this.state.lastActivity = Date.now();

      let processed = chunk;
      if (this.mse && this.mse.method === 'rc4') {
        processed = this.mse.decrypt(chunk);
      }
      this.readQueue.push(processed);
      this.readQueueLen += processed.length;
      this.drainReadBuf();
    });
  }

  private async doHandshake(skipMse: boolean): Promise<void> {
    const write = (data: Buffer) => this.rawWrite(data);
    const read  = () => this.readChunk();

    const overallTimeout = setTimeout(() => this.destroy('handshake timeout'), 20_000);

    try {
      // --- MSE negotiation ---
      if (!skipMse && this.opts.encryption !== 'disabled') {
        try {
          const mseResult = await msHandshakeInitiator(read, write, this.infoHash);

          const pendingEncrypted = this.readQueue.length === 1 ? this.readQueue[0]! : Buffer.concat(this.readQueue);
          this.readQueue = [];
          this.readQueueLen = 0;
          this.mse = mseResult;

          let pendingDecrypted = pendingEncrypted;
          if (this.mse.method === 'rc4' && pendingEncrypted.length > 0) {
            pendingDecrypted = this.mse.decrypt(pendingEncrypted);
          }

          const combined = Buffer.concat([this.mse.initialPayload, pendingDecrypted]);
          if (combined.length > 0) {
            this.unshiftReadBuf(combined);
          }
        } catch (e: any) {
          if (this.opts.encryption === 'required') {
            clearTimeout(overallTimeout);
            throw e;
          }
          if (this.closed) {
            clearTimeout(overallTimeout);
            throw new Error('__NEED_PLAINTEXT__');
          }
          this.mse = null;
        }
      }

      // --- BitTorrent handshake ---
      this.write(encodeHandshake({
        infoHash: this.infoHash,
        peerId:   this.opts.ourPeerId,
        dht:  true, fast: true, ltep: true,
      }));

      const hsBytes = await readExactBuffered(this, 68);
      const parsed  = decodeHandshake(hsBytes);

      if (!parsed.infoHash.equals(this.infoHash)) {
        throw new Error(`Info hash mismatch from ${this.host}:${this.port}`);
      }

      this.emit('connect');
      this.handshakeDone = true;

      // --- LTEP handshake (if supported) ---
      let ltep: ParsedLtepHandshake | null = null;
      if (parsed.ltepSupported) {
        // Prepare the waiter BEFORE sending our own LTEP or draining the buffer
        const ltepPromise = this.waitForMessage(
          (m): m is Extract<WireMessage, { type: 'extended' }> =>
            m.type === 'extended' && m.extId === 0,
          15000,
        );

        this.send({
          type: 'extended', extId: 0,
          payload: encodeLtepHandshake({
            clientVersion: 'TorrentStack 0.1.0',
            supportedExtensions: { utMetadata: 1, utPex: 2 },
          })
        });

        // NOW drain any buffered data that might contain the peer's LTEP
        this.drainReadBuf();

        const ltepMsg = await ltepPromise;
        if (ltepMsg) {
          ltep = parseLtepHandshake(ltepMsg.payload);
          this.state.extensionIds = ltep.extensions;
          this.state.clientName   = ltep.clientVersion;
          this.state.listenPort   = ltep.listenPort;
          this.state.metadataSize = ltep.metadataSize;
        }
      } else {
        this.drainReadBuf();
      }

      clearTimeout(overallTimeout);
      this.emit('handshake', parsed, ltep);
    } catch (e: any) {
      clearTimeout(overallTimeout);
      throw e;
    }
  }

  send(msg: WireMessage): void {
    const encoded = encodeMessage(msg);
    this.write(encoded);

    if (msg.type === 'choke')          this.state.amChoking    = true;
    if (msg.type === 'unchoke')        this.state.amChoking    = false;
    if (msg.type === 'interested')     this.state.amInterested = true;
    if (msg.type === 'not-interested') this.state.amInterested = false;
    if (msg.type === 'request')        this.state.requestsOut++;
  }

  sendMany(msgs: WireMessage[]): void {
    if (msgs.length === 0) return;
    const buffers: Buffer[] = [];
    for (const msg of msgs) {
      buffers.push(encodeMessage(msg));
      if (msg.type === 'choke')          this.state.amChoking    = true;
      if (msg.type === 'unchoke')        this.state.amChoking    = false;
      if (msg.type === 'interested')     this.state.amInterested = true;
      if (msg.type === 'not-interested') this.state.amInterested = false;
      if (msg.type === 'request')        this.state.requestsOut++;
    }
    this.write(Buffer.concat(buffers));
  }

  sendKeepAlive(): void {
    this.rawWrite(this.mse ? this.mse.encrypt(Buffer.alloc(4)) : Buffer.alloc(4));
  }

  private write(data: Buffer): void {
    const out = this.mse ? this.mse.encrypt(data) : data;
    this.rawWrite(out);
    this.state.bytesUp += data.length;
  }

  private rawWrite(data: Buffer): void {
    if (!this.socket || this.closed) return;
    this.socket.write(data);
  }

  private drainReadBuf(): void {
    if (this.closed) return;

    if (!this.handshakeDone) {
      while (this.pendingReads.length > 0 && this.readQueue.length > 0) {
        const { resolve } = this.pendingReads.shift()!;
        const chunk = this.readQueue.shift()!;
        this.readQueueLen -= chunk.length;
        resolve(chunk);
      }
      return;
    }

    while (this.readQueue.length > 0) {
      const chunk = this.readQueue.shift()!;
      this.readQueueLen -= chunk.length;
      
      const messages = this.stream.push(chunk);
      for (const msg of messages) {
        this.updateStateFromMessage(msg);

        // Notify waiters FIRST so they see the message before general listeners
        for (let i = 0; i < this.pendingWaiters.length; i++) {
          const waiter = this.pendingWaiters[i]!;
          if (waiter.predicate(msg)) {
            clearTimeout(waiter.timer);
            this.pendingWaiters.splice(i, 1);
            waiter.resolve(msg);
            break;
          }
        }

        this.emit('message', msg);
      }
    }
  }

  private readChunk(): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('Connection closed'));
        return;
      }
      if (this.readQueue.length > 0) {
        const chunk = this.readQueue.shift()!;
        this.readQueueLen -= chunk.length;
        resolve(chunk);
      } else {
        this.pendingReads.push({ resolve, reject });
      }
    });
  }

  private unshiftReadBuf(extra: Buffer): void {
    if (extra.length === 0) return;
    this.readQueue.unshift(extra);
    this.readQueueLen += extra.length;
  }

  private waitForMessage<T extends WireMessage>(
    predicate: (m: WireMessage) => m is T,
    timeoutMs: number,
  ): Promise<T | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const idx = this.pendingWaiters.findIndex(w => w.resolve === resolve);
        if (idx !== -1) this.pendingWaiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      this.pendingWaiters.push({ predicate, resolve, timer });
    });
  }

  private updateStateFromMessage(msg: WireMessage): void {
    this.state.lastActivity = Date.now();
    switch (msg.type) {
      case 'choke':         this.state.peerChoking    = true; this.state.requestsOut = 0; break;
      case 'unchoke':       this.state.peerChoking    = false; break;
      case 'interested':    this.state.peerInterested = true;  break;
      case 'not-interested':this.state.peerInterested = false; break;
      case 'bitfield':      this.state.bitfield       = msg.bitfield; break;
      case 'have-all':
        // Fast Extension: peer has all pieces. Ensure bitfield exists.
        if (!this.state.bitfield) this.state.bitfield = Buffer.alloc(1, 0xff);
        this.state.bitfield.fill(0xff);
        break;
      case 'have-none':
        if (!this.state.bitfield) this.state.bitfield = Buffer.alloc(1, 0);
        this.state.bitfield.fill(0);
        break;
      case 'piece':         if (this.state.requestsOut > 0) this.state.requestsOut--; break;
      case 'have':
        if (this.state.bitfield) {
          const byteIdx = Math.floor(msg.pieceIndex / 8);
          const bitIdx  = 7 - (msg.pieceIndex % 8);
          if (byteIdx < this.state.bitfield.length) {
            this.state.bitfield[byteIdx]! |= (1 << bitIdx);
          }
        }
        break;
    }
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;

    const err = new Error(`Connection closed: ${reason}`);
    while (this.pendingReads.length > 0) {
      this.pendingReads.shift()!.reject(err);
    }
    while (this.pendingWaiters.length > 0) {
      const waiter = this.pendingWaiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }

    setImmediate(() => {
      if (!this._reconnecting) {
        this.emit('close', reason);
      }
      this._reconnecting = false;
    });
  }

  get isConnected(): boolean {
    return !this.closed && this.handshakeDone;
  }

  hasPiece(index: number): boolean {
    if (!this.state.bitfield) return false;
    const byteIdx = Math.floor(index / 8);
    const bitIdx  = 7 - (index % 8);
    return ((this.state.bitfield[byteIdx] ?? 0) & (1 << bitIdx)) !== 0;
  }
}

async function readExactBuffered(conn: PeerConnection, n: number): Promise<Buffer> {
  const connAny = conn as any;
  const chunks: Buffer[] = [];
  let total = 0;

  while (total < n) {
    const chunk = await connAny.readChunk();
    if (chunk.length === 0) throw new Error('Connection closed during read');
    chunks.push(chunk);
    total += chunk.length;
  }

  const buf = Buffer.concat(chunks);
  if (buf.length > n) {
    connAny.unshiftReadBuf(buf.subarray(n));
  }

  return buf.subarray(0, n);
}
