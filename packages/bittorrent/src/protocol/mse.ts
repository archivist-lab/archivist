// Message Stream Encryption (MSE) / Protocol Encryption (PE)
// Spec: https://wiki.vuze.com/w/Message_Stream_Encryption

import { createDiffieHellman, createHash, randomBytes } from 'node:crypto';

// ─── DH parameters ────────────────────────────────────────────────────────────

const DH_PRIME_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A63A36210000000000090563';

const DH_GENERATOR = 2;
const DH_KEY_LENGTH = 96; // bytes (768 bits)
const CRYPTO_PLAIN = 0x01;
const CRYPTO_RC4   = 0x02;

export type CryptoMethod = 'plain' | 'rc4';

// ─── RC4 stream cipher ────────────────────────────────────────────────────────

export class RC4 {
  private s: Uint8Array;
  private i = 0;
  private j = 0;

  constructor(key: Buffer) {
    this.s = new Uint8Array(256);
    for (let k = 0; k < 256; k++) this.s[k] = k;
    let j = 0;
    for (let k = 0; k < 256; k++) {
      j = (j + (this.s[k] ?? 0) + key[k % key.length]!) & 0xff;
      this.swap(k, j);
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.s[a]!;
    this.s[a] = this.s[b]!;
    this.s[b] = tmp;
  }

  process(data: Buffer): Buffer {
    const out = Buffer.allocUnsafe(data.length);
    for (let k = 0; k < data.length; k++) {
      this.i = (this.i + 1) & 0xff;
      this.j = (this.j + (this.s[this.i] ?? 0)) & 0xff;
      this.swap(this.i, this.j);
      const keyByte = this.s[((this.s[this.i] ?? 0) + (this.s[this.j] ?? 0)) & 0xff] ?? 0;
      out[k] = (data[k]! ^ keyByte) & 0xff;
    }
    return out;
  }

  drop1024(): void {
    const dummy = Buffer.alloc(1024);
    this.process(dummy);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function sha1(...parts: Buffer[]): Buffer {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest();
}

export function deriveKeys(sharedSecret: Buffer, infoHash: Buffer): { sendKey: Buffer; recvKey: Buffer } {
  const keyA = sha1(Buffer.from('keyA'), sharedSecret, infoHash);
  const keyB = sha1(Buffer.from('keyB'), sharedSecret, infoHash);
  return { sendKey: keyB, recvKey: keyA };
}

export function randomPad(max = 512): Buffer {
  const len = Math.floor(Math.random() * max);
  return randomBytes(len);
}

export function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  return out;
}

/** Internal stateful reader to avoid losing bytes between readExact calls */
class HandshakeBuffer {
  private buf = Buffer.alloc(0);
  constructor(private read: () => Promise<Buffer>) {}

  async readExact(n: number, allowBTHandshake = false): Promise<Buffer> {
    const overallTimeout = 10_000;
    const start = Date.now();

    while (this.buf.length < n) {
      if (Date.now() - start > overallTimeout) throw new MseError(`Timeout reading ${n} bytes`);
      const chunk = await this.read();
      if (chunk.length === 0) throw new MseError('Connection closed during MSE read');
      this.buf = Buffer.concat([this.buf, chunk]);

      // Detect plaintext BitTorrent handshake early (starts with \x13BitTorrent protocol)
      if (allowBTHandshake && this.buf.length >= 20 && this.buf[0] === 0x13 && this.buf.subarray(1, 20).toString('ascii') === 'BitTorrent protocol') {
        throw new MseError('BT_HANDSHAKE');
      }
    }

    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(out);
  }

  unshift(b: Buffer): void {
    if (b.length === 0) return;
    this.buf = Buffer.concat([b, this.buf]);
  }

  get leftovers(): Buffer { return this.buf; }
}

// ─── MSE handshake ────────────────────────────────────────────────────────────

export interface MseResult {
  method: CryptoMethod;
  encrypt: (data: Buffer) => Buffer;
  decrypt: (data: Buffer) => Buffer;
  initialPayload: Buffer;
}

export async function msHandshakeInitiator(
  read: () => Promise<Buffer>,
  write: (data: Buffer) => void,
  infoHash: Buffer,
  preferred: CryptoMethod = 'rc4',
): Promise<MseResult> {
  const hb = new HandshakeBuffer(read);

  try {
    // Step 1: DH public key Ya
    const dh = createDiffieHellman(Buffer.from(DH_PRIME_HEX, 'hex'), DH_GENERATOR);
    dh.generateKeys();
    const Ya = dh.getPublicKey();
    const YaPadded = Buffer.alloc(DH_KEY_LENGTH);
    Ya.copy(YaPadded, DH_KEY_LENGTH - Ya.length);
    write(Buffer.concat([YaPadded, randomPad()]));

    // Step 2: Read Yb (96 bytes). Allow detection of BT handshake.
    const rawYb = await hb.readExact(DH_KEY_LENGTH, true);
    const sharedSecret = dh.computeSecret(rawYb);

    // Step 3: Send verification
    const req1 = sha1(Buffer.from('req1'), sharedSecret);
    const req2 = sha1(Buffer.from('req2'), infoHash);
    const req3 = sha1(Buffer.from('req3'), sharedSecret);
    const sKeyXor = xor(req2, req3);

    const cryptoProvide = Buffer.allocUnsafe(4);
    cryptoProvide.writeUInt32BE(preferred === 'rc4' ? CRYPTO_RC4 | CRYPTO_PLAIN : CRYPTO_PLAIN, 0);

    const padC    = randomPad(512);
    const padCLen = Buffer.allocUnsafe(2);
    padCLen.writeUInt16BE(padC.length, 0);

    const iaOut    = Buffer.alloc(0);
    const iaLenOut = Buffer.allocUnsafe(2);
    iaLenOut.writeUInt16BE(iaOut.length, 0);

    const { sendKey, recvKey } = deriveKeys(sharedSecret, infoHash);
    const sendRc4 = new RC4(sendKey);
    const recvRc4 = new RC4(recvKey);
    sendRc4.drop1024();
    recvRc4.drop1024();

    const vcOut = Buffer.alloc(8, 0);
    const plainPart = Buffer.concat([vcOut, cryptoProvide, padCLen, padC, iaLenOut, iaOut]);
    write(Buffer.concat([req1, sKeyXor, sendRc4.process(plainPart)]));

    // Step 4: Synchronize to find ENCRYPT(VC) in the stream.
    const syncRc4 = new RC4(recvKey);
    syncRc4.drop1024();
    const expectedEncVc = syncRc4.process(Buffer.alloc(8, 0));

    let accumulated = Buffer.alloc(0);
    let vcFoundAt = -1;

    while (accumulated.length < 512 + 8 && vcFoundAt === -1) {
      const byte = await hb.readExact(1);
      accumulated = Buffer.concat([accumulated, byte]);

      if (accumulated.length >= 20 && accumulated[0] === 0x13 &&
          accumulated.subarray(1, 20).toString('ascii') === 'BitTorrent protocol') {
        hb.unshift(accumulated);
        throw new MseError('BT_HANDSHAKE');
      }

      if (accumulated.length >= 8) {
        const tail = accumulated.subarray(accumulated.length - 8);
        if (tail.equals(expectedEncVc)) {
          vcFoundAt = accumulated.length - 8;
        }
      }
    }

    if (vcFoundAt === -1) throw new MseError('Could not sync: ENCRYPT(VC) not found');

    const afterVc = accumulated.subarray(vcFoundAt + 8);
    if (afterVc.length > 0) hb.unshift(afterVc);
    recvRc4.process(accumulated.subarray(vcFoundAt, vcFoundAt + 8));

    const cryptoSelectEnc = await hb.readExact(4);
    const cryptoSelect = recvRc4.process(cryptoSelectEnc).readUInt32BE(0);

    const padDLenEnc = await hb.readExact(2);
    const padDLen = recvRc4.process(padDLenEnc).readUInt16BE(0);
    if (padDLen > 512) throw new MseError(`Pad D too large: ${padDLen}`);
    if (padDLen > 0) {
      const padDEnc = await hb.readExact(padDLen);
      recvRc4.process(padDEnc);
    }

    const method: CryptoMethod = (cryptoSelect & CRYPTO_RC4) ? 'rc4' : 'plain';
    const initialPayload = method === 'rc4' ? recvRc4.process(hb.leftovers) : hb.leftovers;

    if (method === 'rc4') {
      return {
        method: 'rc4',
        encrypt: (d) => sendRc4.process(d),
        decrypt: (d) => recvRc4.process(d),
        initialPayload,
      };
    }

    return {
      method: 'plain',
      encrypt: (d) => d,
      decrypt: (d) => d,
      initialPayload,
    };
  } catch (e: any) {
    if (e.message === 'BT_HANDSHAKE' || hb.leftovers.length > 0) {
      return {
        method: 'plain',
        encrypt: (d) => d,
        decrypt: (d) => d,
        initialPayload: hb.leftovers,
      };
    }
    throw e;
  }
}

export class MseError extends Error {
  constructor(msg: string) { super(msg); this.name = 'MseError'; }
}
