// BitTorrent wire protocol message encoder / decoder
// Spec: https://wiki.theory.org/BitTorrentSpecification#Messages
//
// Frame format (all messages except keep-alive):
//   [4 bytes: length prefix (big-endian uint32)] [1 byte: message id] [payload]
// Keep-alive:
//   [4 bytes: 0x00000000]

// ─── Message ID constants ─────────────────────────────────────────────────────

export const MsgId = {
  Choke:          0,
  Unchoke:        1,
  Interested:     2,
  NotInterested:  3,
  Have:           4,
  Bitfield:       5,
  Request:        6,
  Piece:          7,
  Cancel:         8,
  Port:           9,   // DHT port (BEP 5)
  // Fast extension (BEP 6)
  SuggestPiece:   13,
  HaveAll:        14,
  HaveNone:       15,
  RejectRequest:  16,
  AllowedFast:    17,
  // Extension protocol (BEP 10)
  Extended:       20,
} as const;

export type MsgIdValue = typeof MsgId[keyof typeof MsgId];

// ─── Message types ────────────────────────────────────────────────────────────

export type WireMessage =
  | { type: 'keep-alive' }
  | { type: 'choke' }
  | { type: 'unchoke' }
  | { type: 'interested' }
  | { type: 'not-interested' }
  | { type: 'have';           pieceIndex: number }
  | { type: 'bitfield';       bitfield: Buffer }
  | { type: 'request';        pieceIndex: number; offset: number; length: number }
  | { type: 'piece';          pieceIndex: number; offset: number; data: Buffer }
  | { type: 'cancel';         pieceIndex: number; offset: number; length: number }
  | { type: 'port';           port: number }
  | { type: 'suggest-piece';  pieceIndex: number }
  | { type: 'have-all' }
  | { type: 'have-none' }
  | { type: 'reject-request'; pieceIndex: number; offset: number; length: number }
  | { type: 'allowed-fast';   pieceIndex: number }
  | { type: 'extended';       extId: number; payload: Buffer };

// ─── Encoder ─────────────────────────────────────────────────────────────────

export function encodeMessage(msg: WireMessage): Buffer {
  switch (msg.type) {
    case 'keep-alive':
      return Buffer.alloc(4); // 4 zero bytes

    case 'choke':         return simple(MsgId.Choke);
    case 'unchoke':       return simple(MsgId.Unchoke);
    case 'interested':    return simple(MsgId.Interested);
    case 'not-interested':return simple(MsgId.NotInterested);
    case 'have-all':      return simple(MsgId.HaveAll);
    case 'have-none':     return simple(MsgId.HaveNone);

    case 'have':
    case 'suggest-piece':
    case 'allowed-fast': {
      const id = msg.type === 'have' ? MsgId.Have
               : msg.type === 'suggest-piece' ? MsgId.SuggestPiece
               : MsgId.AllowedFast;
      const buf = Buffer.allocUnsafe(9);
      buf.writeUInt32BE(5, 0);
      buf[4] = id;
      buf.writeUInt32BE(msg.pieceIndex, 5);
      return buf;
    }

    case 'bitfield': {
      const buf = Buffer.allocUnsafe(5 + msg.bitfield.length);
      buf.writeUInt32BE(1 + msg.bitfield.length, 0);
      buf[4] = MsgId.Bitfield;
      msg.bitfield.copy(buf, 5);
      return buf;
    }

    case 'request':
    case 'cancel':
    case 'reject-request': {
      const id = msg.type === 'request' ? MsgId.Request
               : msg.type === 'cancel' ? MsgId.Cancel
               : MsgId.RejectRequest;
      const buf = Buffer.allocUnsafe(17);
      buf.writeUInt32BE(13, 0);
      buf[4] = id;
      buf.writeUInt32BE(msg.pieceIndex, 5);
      buf.writeUInt32BE(msg.offset, 9);
      buf.writeUInt32BE(msg.length, 13);
      return buf;
    }

    case 'piece': {
      const buf = Buffer.allocUnsafe(13 + msg.data.length);
      buf.writeUInt32BE(9 + msg.data.length, 0);
      buf[4] = MsgId.Piece;
      buf.writeUInt32BE(msg.pieceIndex, 5);
      buf.writeUInt32BE(msg.offset, 9);
      msg.data.copy(buf, 13);
      return buf;
    }

    case 'port': {
      const buf = Buffer.allocUnsafe(7);
      buf.writeUInt32BE(3, 0);
      buf[4] = MsgId.Port;
      buf.writeUInt16BE(msg.port, 5);
      return buf;
    }

    case 'extended': {
      const buf = Buffer.allocUnsafe(6 + msg.payload.length);
      buf.writeUInt32BE(2 + msg.payload.length, 0);
      buf[4] = MsgId.Extended;
      buf[5] = msg.extId;
      msg.payload.copy(buf, 6);
      return buf;
    }
  }
}

function simple(id: number): Buffer {
  const buf = Buffer.allocUnsafe(5);
  buf.writeUInt32BE(1, 0);
  buf[4] = id;
  return buf;
}

// ─── Decoder ──────────────────────────────────────────────────────────────────

export class WireProtocolError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'WireProtocolError';
  }
}

/** Decode a single framed message from a buffer.
 *  Returns null if there isn't a complete message yet. */
export function decodeMessage(buf: Buffer): { msg: WireMessage; consumed: number } | null {
  if (buf.length < 4) return null;

  const length = buf.readUInt32BE(0);

  // Keep-alive
  if (length === 0) return { msg: { type: 'keep-alive' }, consumed: 4 };

  if (buf.length < 4 + length) return null; // incomplete

  const id = buf[4] as number;
  const payload = buf.subarray(5, 4 + length);
  const consumed = 4 + length;

  const msg = decodePayload(id, payload, length);
  return { msg, consumed };
}

function decodePayload(id: number, payload: Buffer, length: number): WireMessage {
  switch (id) {
    case MsgId.Choke:         return { type: 'choke' };
    case MsgId.Unchoke:       return { type: 'unchoke' };
    case MsgId.Interested:    return { type: 'interested' };
    case MsgId.NotInterested: return { type: 'not-interested' };
    case MsgId.HaveAll:       return { type: 'have-all' };
    case MsgId.HaveNone:      return { type: 'have-none' };

    case MsgId.Have:
      if (payload.length < 4) throw new WireProtocolError('have: payload too short');
      return { type: 'have', pieceIndex: payload.readUInt32BE(0) };

    case MsgId.Bitfield:
      return { type: 'bitfield', bitfield: Buffer.from(payload) };

    case MsgId.Request:
    case MsgId.Cancel:
    case MsgId.RejectRequest: {
      if (payload.length < 12) throw new WireProtocolError(`${id}: payload too short`);
      const type = id === MsgId.Request ? 'request'
                 : id === MsgId.Cancel ? 'cancel'
                 : 'reject-request';
      return {
        type,
        pieceIndex: payload.readUInt32BE(0),
        offset:     payload.readUInt32BE(4),
        length:     payload.readUInt32BE(8),
      };
    }

    case MsgId.Piece: {
      if (payload.length < 8) throw new WireProtocolError('piece: payload too short');
      return {
        type: 'piece',
        pieceIndex: payload.readUInt32BE(0),
        offset:     payload.readUInt32BE(4),
        data:       Buffer.from(payload.subarray(8)),
      };
    }

    case MsgId.Port: {
      if (payload.length < 2) throw new WireProtocolError('port: payload too short');
      return { type: 'port', port: payload.readUInt16BE(0) };
    }

    case MsgId.SuggestPiece:
    case MsgId.AllowedFast: {
      if (payload.length < 4) throw new WireProtocolError(`${id}: payload too short`);
      return {
        type: id === MsgId.SuggestPiece ? 'suggest-piece' : 'allowed-fast',
        pieceIndex: payload.readUInt32BE(0),
      };
    }

    case MsgId.Extended: {
      if (payload.length < 1) throw new WireProtocolError('extended: payload too short');
      return {
        type: 'extended',
        extId: payload[0] as number,
        payload: Buffer.from(payload.subarray(1)),
      };
    }

    default:
      throw new WireProtocolError(`Unknown message id: ${id}`);
  }
}

// ─── Streaming message parser ─────────────────────────────────────────────────
// Used by PeerConnection to parse messages as bytes arrive.

export class MessageStream {
  private chunks: Buffer[] = [];
  private totalLen = 0;

  push(chunk: Buffer): WireMessage[] {
    this.chunks.push(chunk);
    this.totalLen += chunk.length;

    const messages: WireMessage[] = [];

    while (this.totalLen >= 4) {
      // We need at least 4 bytes to read the length prefix
      const head = this.peek(4);
      const msgLen = head.readUInt32BE(0);

      if (this.totalLen < 4 + msgLen) break; // Incomplete message

      // Consume the full message
      const fullMsgBuf = this.consume(4 + msgLen);
      
      try {
        const result = decodeMessage(fullMsgBuf);
        if (result) {
          messages.push(result.msg);
        }
      } catch (e) {
        console.error(`[Wire] Decoding error: ${String(e)}`);
        this.clear();
        break;
      }
    }

    return messages;
  }

  private peek(n: number): Buffer {
    if (this.chunks[0] && this.chunks[0].length >= n) {
      return this.chunks[0];
    }
    // Fallback: combine just enough chunks to satisfy the peek
    const needed: Buffer[] = [];
    let gathered = 0;
    for (const chunk of this.chunks) {
      needed.push(chunk);
      gathered += chunk.length;
      if (gathered >= n) break;
    }
    return Buffer.concat(needed);
  }

  private consume(n: number): Buffer {
    const res = Buffer.allocUnsafe(n);
    let offset = 0;

    while (offset < n) {
      const chunk = this.chunks[0]!;
      const take = Math.min(n - offset, chunk.length);
      chunk.copy(res, offset, 0, take);
      offset += take;

      if (take < chunk.length) {
        this.chunks[0] = chunk.subarray(take);
      } else {
        this.chunks.shift();
      }
    }

    this.totalLen -= n;
    return res;
  }

  get buffered(): number {
    return this.totalLen;
  }

  clear(): void {
    this.chunks = [];
    this.totalLen = 0;
  }
}
