import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const REPO_API = 'https://api.github.com/repos/Prowlarr/Indexers/tarball/master';
const META_FILE = 'sync-meta.json';

interface SyncMeta {
  lastSync: number;
  etag:     string | null;
  count:    number;
}

export class DefinitionSync {
  private meta: SyncMeta = { lastSync: 0, etag: null, count: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private dir: string) {}

  async start(intervalHours = 24): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.loadMeta();

    // Sync now if never done or stale
    const staleMs = intervalHours * 60 * 60 * 1000;
    if (Date.now() - this.meta.lastSync > staleMs) {
      await this.sync().catch(e => console.warn('[DefinitionSync] Initial sync failed:', e.message ?? e));
    }

    // Schedule periodic re-sync
    this.timer = setInterval(async () => {
      await this.sync().catch(e => console.warn('[DefinitionSync] Scheduled sync failed:', e.message ?? e));
    }, staleMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async sync(): Promise<{ downloaded: number; skipped: boolean }> {

    const headers: Record<string, string> = {
      'User-Agent':  'TorrentStack/0.1.0',
      'Accept':      'application/vnd.github+json',
    };
    if (this.meta.etag) headers['If-None-Match'] = this.meta.etag;

    let resp: Response;
    try {
      resp = await fetch(REPO_API, { headers, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new Error(`Network error during definition sync: ${String(e)}`);
    }

    if (resp.status === 304) {
      return { downloaded: 0, skipped: true };
    }

    if (!resp.ok) {
      throw new Error(`GitHub API error: ${resp.status}`);
    }

    // GitHub returns a tarball — we extract .yml files from it
    const tarball = Buffer.from(await resp.arrayBuffer());
    const count   = await this.extractYmlFiles(tarball);

    this.meta = {
      lastSync: Date.now(),
      etag:     resp.headers.get('etag'),
      count,
    };
    await this.saveMeta();

    return { downloaded: count, skipped: false };
  }

  private async extractYmlFiles(tarball: Buffer): Promise<number> {
    let count = 0;
    const extractDir = this.dir;

    // Parse tar entries manually (tar format is well-specified)
    const gunzipped = await gunzip(tarball);
    const entries   = parseTar(gunzipped);

    for (const entry of entries) {
      if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;

      // Strip leading path component (repo root dir)
      const parts    = entry.name.split('/').slice(1);
      const filename = parts[parts.length - 1];
      if (!filename || filename.startsWith('.')) continue;

      // We only want definition files (files in v*/  directories)
      const isVersionedDir = parts.some(p => /^v\d+$/.test(p));
      const isRootLevel    = parts.length === 1;
      if (!isVersionedDir && !isRootLevel) continue;

      const destPath = join(extractDir, filename);
      await writeFile(destPath, entry.data, 'utf8');
      count++;
    }

    return count;
  }

  private async loadMeta(): Promise<void> {
    try {
      const raw = await readFile(join(this.dir, META_FILE), 'utf8');
      this.meta = JSON.parse(raw) as SyncMeta;
    } catch {
      // First run
    }
  }

  private async saveMeta(): Promise<void> {
    await writeFile(join(this.dir, META_FILE), JSON.stringify(this.meta, null, 2), 'utf8');
  }

  get lastSync(): number { return this.meta.lastSync; }
  get definitionCount(): number { return this.meta.count; }
}

// ─── Minimal tar parser ───────────────────────────────────────────────────────

interface TarEntry {
  name: string;
  data: string;
}

async function gunzip(buf: Buffer): Promise<Buffer> {
  const { gunzip: gzUnzip } = await import('node:zlib');
  return new Promise((resolve, reject) => {
    gzUnzip(buf, (err, result) => err ? reject(err) : resolve(result));
  });
}

function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    const name   = header.subarray(0, 100).toString('utf8').replace(/\0/g, '').trim();
    if (!name) break;

    const sizeStr = header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim();
    const size    = parseInt(sizeStr, 8);

    offset += 512;

    if (size > 0 && offset + size <= buf.length) {
      const data = buf.subarray(offset, offset + size).toString('utf8');
      entries.push({ name, data });
    }

    // Advance to next 512-byte boundary
    offset += Math.ceil(size / 512) * 512;
  }

  return entries;
}
