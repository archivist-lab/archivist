// Bencode encoder / decoder
// Spec: https://wiki.theory.org/BitTorrentSpecification#Bencoding
//
// Types:
//   Integer  → i<digits>e          e.g.  i42e
//   String   → <len>:<bytes>       e.g.  4:spam
//   List     → l<items>e           e.g.  li1ei2ee
//   Dict     → d<key-value pairs>e e.g.  d3:fooi1ee   (keys MUST be sorted)

export type BencodeValue =
  | number
  | Buffer
  | BencodeValue[]
  | BencodeDict;

export type BencodeDict = { [key: string]: BencodeValue };

// ─── Decode ───────────────────────────────────────────────────────────────────

class DecodeState {
  buf: Buffer;
  pos: number;

  constructor(buf: Buffer) {
    this.buf = buf;
    this.pos = 0;
  }

  peek(): number {
    const ch = this.buf[this.pos];
    if (ch === undefined) throw new BencodeError('Unexpected end of input');
    return ch;
  }

  read(): number {
    const ch = this.buf[this.pos++];
    if (ch === undefined) throw new BencodeError('Unexpected end of input');
    return ch;
  }

  readSlice(len: number): Buffer {
    if (this.pos + len > this.buf.length) {
      throw new BencodeError(`Need ${len} bytes at pos ${this.pos}, only ${this.buf.length - this.pos} available`);
    }
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  readWhile(pred: (ch: number) => boolean): string {
    const start = this.pos;
    while (this.pos < this.buf.length && pred(this.buf[this.pos]!)) this.pos++;
    return this.buf.subarray(start, this.pos).toString('ascii');
  }

  expect(char: string): void {
    const ch = this.read();
    if (ch !== char.charCodeAt(0)) {
      throw new BencodeError(`Expected '${char}' got '${String.fromCharCode(ch)}' at pos ${this.pos - 1}`);
    }
  }
}

export class BencodeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BencodeError';
  }
}

function decodeValue(s: DecodeState): BencodeValue {
  const ch = s.peek();

  // Integer: i<digits>e
  if (ch === 0x69 /* 'i' */) {
    s.read(); // consume 'i'
    const negative = s.peek() === 0x2d /* '-' */;
    if (negative) s.read();
    const digits = s.readWhile(c => c >= 0x30 && c <= 0x39);
    if (digits.length === 0) throw new BencodeError('Empty integer');
    s.expect('e');
    const n = parseInt(digits, 10);
    return negative ? -n : n;
  }

  // List: l<items>e
  if (ch === 0x6c /* 'l' */) {
    s.read();
    const list: BencodeValue[] = [];
    while (s.peek() !== 0x65 /* 'e' */) list.push(decodeValue(s));
    s.read(); // consume 'e'
    return list;
  }

  // Dict: d<key-value>e
  if (ch === 0x64 /* 'd' */) {
    s.read();
    const dict: BencodeDict = {};
    while (s.peek() !== 0x65 /* 'e' */) {
      const keyBuf = decodeString(s);
      const key = keyBuf.toString('utf8');
      dict[key] = decodeValue(s);
    }
    s.read(); // consume 'e'
    return dict;
  }

  // String: <len>:<bytes>
  if (ch >= 0x30 && ch <= 0x39 /* '0'-'9' */) {
    return decodeString(s);
  }

  throw new BencodeError(`Unexpected character '${String.fromCharCode(ch)}' at pos ${s.pos}`);
}

function decodeString(s: DecodeState): Buffer {
  const lenStr = s.readWhile(c => c >= 0x30 && c <= 0x39);
  if (lenStr.length === 0) throw new BencodeError('String without length');
  s.expect(':');
  const len = parseInt(lenStr, 10);
  return Buffer.from(s.readSlice(len));
}

export function decode(input: Buffer | Uint8Array): BencodeValue {
  const { value, bytesConsumed } = decodePartial(input);
  if (bytesConsumed !== (Buffer.isBuffer(input) ? input.length : input.byteLength)) {
    throw new BencodeError(`Trailing bytes at pos ${bytesConsumed}`);
  }
  return value;
}

/** Decode a bencode value and return the value and the number of bytes consumed.
 *  Useful for protocols where bencode is followed by raw binary data. */
export function decodePartial(input: Buffer | Uint8Array): { value: BencodeValue; bytesConsumed: number } {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const state = new DecodeState(buf);
  const value = decodeValue(state);
  return { value, bytesConsumed: state.pos };
}

// ─── Encode ───────────────────────────────────────────────────────────────────

export function encode(value: BencodeValue): Buffer {
  if (typeof value === 'number') {
    return Buffer.from(`i${Math.trunc(value)}e`, 'ascii');
  }

  if (Buffer.isBuffer(value)) {
    const prefix = Buffer.from(`${value.length}:`, 'ascii');
    return Buffer.concat([prefix, value]);
  }

  if (typeof value === 'string') {
    // Convenience: encode strings as UTF-8 buffers
    const buf = Buffer.from(value, 'utf8');
    const prefix = Buffer.from(`${buf.length}:`, 'ascii');
    return Buffer.concat([prefix, buf]);
  }

  if (Array.isArray(value)) {
    const parts = value.map(encode);
    return Buffer.concat([Buffer.from('l'), ...parts, Buffer.from('e')]);
  }

  if (value !== null && typeof value === 'object') {
    // Keys must be sorted lexicographically
    const keys = Object.keys(value).sort();
    const parts = keys.flatMap(k => [
      encode(Buffer.from(k, 'utf8')),
      encode(value[k]!),
    ]);
    return Buffer.concat([Buffer.from('d'), ...parts, Buffer.from('e')]);
  }

  throw new BencodeError(`Cannot encode value: ${String(value)}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Safely read a string value from a decoded dict */
export function getString(dict: BencodeDict, key: string): string | null {
  const v = dict[key];
  if (v === undefined) return null;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'string') return v;
  return null;
}

/** Safely read a number from a decoded dict */
export function getNumber(dict: BencodeDict, key: string): number | null {
  const v = dict[key];
  if (v === undefined) return null;
  if (typeof v === 'number') return v;
  return null;
}

/** Safely read a Buffer from a decoded dict */
export function getBuffer(dict: BencodeDict, key: string): Buffer | null {
  const v = dict[key];
  if (v === undefined) return null;
  if (Buffer.isBuffer(v)) return v;
  return null;
}

/** Safely read a list from a decoded dict */
export function getList(dict: BencodeDict, key: string): BencodeValue[] | null {
  const v = dict[key];
  if (v === undefined) return null;
  if (Array.isArray(v)) return v;
  return null;
}

/** Safely read a nested dict */
export function getDict(dict: BencodeDict, key: string): BencodeDict | null {
  const v = dict[key];
  if (v === undefined) return null;
  if (!Array.isArray(v) && typeof v === 'object' && !Buffer.isBuffer(v)) {
    return v as BencodeDict;
  }
  return null;
}
