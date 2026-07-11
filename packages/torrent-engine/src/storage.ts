// Storage — handles all disk I/O for a torrent.
// Responsibilities:
//   - Map piece+offset+length to the actual files on disk
//   - In-memory write cache (batches small writes)
//   - Preallocation (none / fast-sparse / full)
//   - Incomplete directory → final directory move on completion
//   - .part suffix management

import { open, mkdir, rename, rm, unlink, statfs, type FileHandle } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type { TorrentMetainfo, MetainfoFile } from '@torrentstack/bittorrent';

export type PreallocationMode = 'none' | 'fast' | 'full';

export interface StorageOptions {
  downloadDir:     string;
  incompleteDir?:  string;          // if set, files are written here until complete
  renamePartial:   boolean;         // append .part to incomplete files
  preallocation:   PreallocationMode;
  cacheSize:       number;          // bytes
}

interface FileMap {
  file:       MetainfoFile;
  startByte:  number;               // byte offset within the torrent data
  endByte:    number;
}

interface CacheEntry {
  pieceIndex: number;
  data:       Buffer;
  dirty:      boolean;
}

export class Storage extends EventEmitter {
  private fileMap:  FileMap[];
  private handles:  Map<string, FileHandle> = new Map();
  private cache:    Map<number, CacheEntry>  = new Map();
  private cacheBytes = 0;

  constructor(
    private meta: TorrentMetainfo,
    private opts: StorageOptions,
  ) {
    super();

    // Build the file map: each file's byte range within the linear torrent data
    let offset = 0;
    this.fileMap = meta.files.map(file => {
      const entry = { file, startByte: offset, endByte: offset + file.sizeBytes };
      offset += file.sizeBytes;
      return entry;
    });
  }

  // ─── Initialise: create directories, preallocate ──────────────────────────────

  async init(): Promise<void> {
    const baseDir = this.opts.incompleteDir ?? this.opts.downloadDir;

    for (const { file } of this.fileMap) {
      const filePath = join(baseDir, this.meta.name, file.path);
      const dirPath  = dirname(filePath);
      await mkdir(dirPath, { recursive: true });

      if (this.opts.preallocation === 'full' && file.sizeBytes > 0) {
        await this.preallocateFull(filePath, file.sizeBytes);
      }
    }
  }

  private async preallocateFull(filePath: string, size: number): Promise<void> {
    if (existsSync(filePath)) return;
    const fh = await open(filePath, 'w');
    try {
      // Write a single byte at the end to allocate the full file on disk
      if (size > 0) await fh.write(Buffer.alloc(1), 0, 1, size - 1);
    } finally {
      await fh.close();
    }
  }

  // ─── Write ────────────────────────────────────────────────────────────────────

  async writePiece(pieceIndex: number, data: Buffer): Promise<void> {
    // Add to cache
    const existing = this.cache.get(pieceIndex);
    if (existing) {
      this.cacheBytes -= existing.data.length;
    }
    this.cache.set(pieceIndex, { pieceIndex, data: Buffer.from(data), dirty: true });
    this.cacheBytes += data.length;

    // Flush if over cache limit
    if (this.cacheBytes > this.opts.cacheSize) {
      await this.flushCache();
    }
  }

  async flushCache(): Promise<void> {
    const dirty = [...this.cache.values()].filter(e => e.dirty);
    
    // Write all dirty pieces in parallel
    await Promise.all(dirty.map(async (entry) => {
      await this.writePieceToDisk(entry.pieceIndex, entry.data);
      entry.dirty = false;
    }));

    // Evict clean entries until under limit
    const targetSize = this.opts.cacheSize * 0.5;
    for (const [key, entry] of this.cache) {
      if (this.cacheBytes <= targetSize) break;
      if (!entry.dirty) {
        this.cache.delete(key);
        this.cacheBytes -= entry.data.length;
      }
    }
  }

  private async writePieceToDisk(pieceIndex: number, data: Buffer): Promise<void> {
    const pieceStart = pieceIndex * this.meta.pieceLength;
    let dataOffset   = 0;

    for (const { file, startByte, endByte } of this.fileMap) {
      const pieceEnd  = pieceStart + data.length;
      const overlapStart = Math.max(pieceStart, startByte);
      const overlapEnd   = Math.min(pieceEnd, endByte);

      if (overlapStart >= overlapEnd) continue;

      const fileOffset  = overlapStart - startByte;
      const dataSlice   = data.subarray(
        overlapStart - pieceStart,
        overlapEnd   - pieceStart,
      );

      const fh = await this.getHandle(file.path, 'r+');
      await fh.write(dataSlice, 0, dataSlice.length, fileOffset);
      dataOffset += dataSlice.length;
    }
  }

  // ─── Read ─────────────────────────────────────────────────────────────────────

  async readPiece(pieceIndex: number, length: number): Promise<Buffer> {
    // Check cache first
    const cached = this.cache.get(pieceIndex);
    if (cached) return cached.data;

    const pieceStart = pieceIndex * this.meta.pieceLength;
    const buf        = Buffer.alloc(length);
    let   bufOffset  = 0;

    for (const { file, startByte, endByte } of this.fileMap) {
      const pieceEnd     = pieceStart + length;
      const overlapStart = Math.max(pieceStart, startByte);
      const overlapEnd   = Math.min(pieceEnd, endByte);
      if (overlapStart >= overlapEnd) continue;

      const fileOffset = overlapStart - startByte;
      const readLen    = overlapEnd - overlapStart;

      const fh = await this.getHandle(file.path, 'r');
      const { bytesRead } = await fh.read(buf, bufOffset, readLen, fileOffset);
      if (bytesRead !== readLen) {
        throw new StorageError(`Cannot read full piece ${pieceIndex}: expected ${readLen} bytes, got ${bytesRead}`);
      }
      bufOffset += readLen;
    }
    return buf;
  }

  // ─── File handle management ───────────────────────────────────────────────────

  private async getHandle(relativePath: string, mode: 'r' | 'r+'): Promise<FileHandle> {
    const key = `${relativePath}:${mode}`;
    let fh    = this.handles.get(key);
    if (fh) return fh;

    const baseDir  = this.opts.incompleteDir ?? this.opts.downloadDir;
    const filePath = join(baseDir, this.meta.name, relativePath);
    const writePath = this.opts.renamePartial ? filePath + '.part' : filePath;

    await mkdir(dirname(filePath), { recursive: true });

    if (mode === 'r+') {
      // Open for read+write, creating the file if it doesn't exist.
      // 'r+' fails on missing files; 'w+' truncates existing ones.
      // We use 'r+' first (preserves existing content), falling back to 'w+' (create).
      fh = await open(writePath, 'r+').catch(() => open(writePath, 'w+'));
    } else {
      const readPath = this.opts.renamePartial && existsSync(writePath) ? writePath : filePath;
      fh = await open(readPath, 'r').catch(() => {
        throw new StorageError(`Cannot read ${readPath}: file not found`);
      });
    }

    this.handles.set(key, fh);
    return fh;
  }

  // ─── Completion: move from incompleteDir to downloadDir, strip .part ─────────

  async finalise(): Promise<void> {
    await this.flushCache();
    await this.closeHandles();

    for (const { file } of this.fileMap) {
      if (this.opts.incompleteDir) {
        // Move from incompleteDir to downloadDir, stripping .part in the process
        const src  = join(this.opts.incompleteDir, this.meta.name, file.path);
        const dest = join(this.opts.downloadDir,   this.meta.name, file.path);
        const srcWithPart = this.opts.renamePartial ? src + '.part' : src;
        await mkdir(dirname(dest), { recursive: true });
        const srcPath = existsSync(srcWithPart) ? srcWithPart : src;
        await rename(srcPath, dest);
      } else if (this.opts.renamePartial) {
        // No incompleteDir — rename in-place to strip .part
        const partPath  = join(this.opts.downloadDir, this.meta.name, file.path + '.part');
        const finalPath = join(this.opts.downloadDir, this.meta.name, file.path);
        if (existsSync(partPath)) {
          await rename(partPath, finalPath);
        }
      }
    }

    // Every file has been moved out of the incompleteDir; remove the now-empty
    // torrent directory tree left behind there so incomplete/ doesn't accumulate
    // hollow folder skeletons for each completed torrent.
    if (this.opts.incompleteDir && this.opts.incompleteDir !== this.opts.downloadDir) {
      const staleDir = join(this.opts.incompleteDir, this.meta.name);
      await rm(staleDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async closeHandles(): Promise<void> {
    for (const fh of this.handles.values()) {
      try { await fh.close(); } catch {}
    }
    this.handles.clear();
  }

  // ─── Disk space check ─────────────────────────────────────────────────────────

  async checkFreeSpace(): Promise<{ freeBytes: number; needed: number }> {
    const dir   = this.opts.incompleteDir ?? this.opts.downloadDir;
    const stats = await statfs(dir);
    const freeBytes = stats.bavail * stats.bsize;
    const needed    = this.meta.totalSize;
    return { freeBytes, needed };
  }

  get totalSize(): number { return this.meta.totalSize; }
}

export class StorageError extends Error {
  constructor(msg: string) { super(msg); this.name = 'StorageError'; }
}
