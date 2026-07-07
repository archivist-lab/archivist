// uTP — Micro Transport Protocol (BEP 29)
// UDP-based transport with Ledbat congestion control.

import { createSocket, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';

export enum UtpType {
  DATA = 0,
  FIN  = 1,
  STATE= 2,
  RESET= 3,
  SYN  = 4
}

export interface UtpHeader {
  type: UtpType;
  version: number;
  extension: number;
  connectionId: number;
  timestampMicro: number;
  timestampDiffMicro: number;
  wndSize: number;
  seqNr: number;
  ackNr: number;
}

export class UtpManager extends EventEmitter {
  private socket: Socket | null = null;
  private boundPortValue: number | null = null;

  constructor(private port: number) {
    super();
  }

  async start(): Promise<void> {
    await this._bind(this.port);
  }

  private _bind(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4');
      socket.on('message', (msg, rinfo) => this.handlePacket(msg, rinfo.address, rinfo.port));
      socket.once('error', (err: NodeJS.ErrnoException) => {
        socket.close();
        if (err.code === 'EADDRINUSE' && port !== 0) {
          console.warn(`[uTP] Port ${port} in use, trying random port...`);
          this._bind(0).then(resolve, reject);
        } else {
          reject(err);
        }
      });
      socket.bind(port, () => {
        this.socket = socket;
        const address = socket.address();
        this.boundPortValue = typeof address === 'string' ? port : address.port;
        resolve();
      });
    });
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
    this.boundPortValue = null;
  }

  get boundPort(): number | null { return this.boundPortValue; }

  private handlePacket(data: Buffer, host: string, port: number): void {
    if (data.length < 20) return;

    const firstByte = data[0]!;
    const type = (firstByte >> 4) as UtpType;
    const version = firstByte & 0xf;

    if (version !== 1) return;

    const header: UtpHeader = {
      type,
      version,
      extension: data[1]!,
      connectionId: data.readUInt16BE(2),
      timestampMicro: data.readUInt32BE(4),
      timestampDiffMicro: data.readUInt32BE(8),
      wndSize: data.readUInt32BE(12),
      seqNr: data.readUInt16BE(16),
      ackNr: data.readUInt16BE(18),
    };

    if (type === UtpType.SYN) {
      console.log(`[uTP] Incoming SYN from ${host}:${port}`);
      // In a full implementation we'd create a virtual socket here
    }
  }
}
