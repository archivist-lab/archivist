// Resume — persists torrent state to disk and restores it on restart.
// Each torrent gets a JSON file at: {resumeDir}/{infoHash}.json
// This is equivalent to Transmission's .resume files.

import { readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { FilePriority, TorrentPriority } from '@torrentstack/types';

export interface ResumeData {
  // Identity
  infoHash:      string;
  name:          string;
  addedAt:       number;
  addedVia:      'file' | 'magnet' | 'url' | 'watch-dir';

  // Paths
  downloadDir:   string;
  incompleteDir: string | null;
  torrentFile:   string | null;   // path to stored .torrent file
  magnetLink:    string | null;

  // Progress — base64 bitfield of completed pieces
  bitfield:      string | null;

  // Transfer totals (persist across restarts)
  uploadedBytes: number;
  corruptBytes:  number;

  // State
  stopped:       boolean;         // was it stopped when we last ran?
  sequentialDownload: boolean;

  // Queue / priority
  queuePosition:     number;
  bandwidthPriority: TorrentPriority;
  downloadLimit:     number;
  uploadLimit:       number;

  // Seeding limits
  seedRatioLimit:  number;
  seedRatioMode:   0 | 1 | 2;
  seedIdleLimit:   number;
  seedIdleMode:    0 | 1 | 2;

  // Files
  filePriorities: FilePriority[];
  wantedFiles:    boolean[];

  // Labels / group
  labels: string[];
  group:  string | null;

  // Timestamps
  activityAt:   number | null;
  completedAt:  number | null;
}

export class ResumeStore {
  private pendingSaves = new Map<string, { data: ResumeData; timer: ReturnType<typeof setTimeout> }>();

  constructor(private dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async save(data: ResumeData, immediate = false): Promise<void> {
    if (immediate) {
      await this.flushSave(data.infoHash, data);
      return;
    }

    const existing = this.pendingSaves.get(data.infoHash);
    if (existing) {
      existing.data = data;
      return; // Already queued
    }

    const timer = setTimeout(() => {
      const pending = this.pendingSaves.get(data.infoHash);
      if (pending) {
        this.flushSave(data.infoHash, pending.data).catch(() => {});
      }
    }, 5000); // 5-second debounce

    this.pendingSaves.set(data.infoHash, { data, timer });
  }

  private async flushSave(infoHash: string, data: ResumeData): Promise<void> {
    const pending = this.pendingSaves.get(infoHash);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSaves.delete(infoHash);
    }

    const path = join(this.dir, `${infoHash}.json`);
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
  }

  async load(infoHash: string): Promise<ResumeData | null> {
    const path = join(this.dir, `${infoHash}.json`);
    try {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw) as ResumeData;
    } catch {
      return null;
    }
  }

  async loadAll(): Promise<ResumeData[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }

    const results: ResumeData[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const infoHash = file.slice(0, -5);
      const data = await this.load(infoHash);
      if (data) results.push(data);
    }
    return results;
  }

  async delete(infoHash: string): Promise<void> {
    const pending = this.pendingSaves.get(infoHash);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSaves.delete(infoHash);
    }
    const path = join(this.dir, `${infoHash}.json`);
    await unlink(path).catch(() => {});
  }
}
