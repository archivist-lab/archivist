import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const REPO_API = 'https://api.github.com/repos/Jackett/Jackett/tarball/master';
const SOURCE = 'Jackett/Jackett:src/Jackett.Common/Definitions';
const META_FILE = 'sync-meta.json';

interface SyncMeta {
  lastSync: number;
  etag:     string | null;
  count:    number;
  source?:  string;
}

export interface DefinitionSyncResult {
  downloaded: number;
  skipped: boolean;
}

export class DefinitionSync {
  private meta: SyncMeta = { lastSync: 0, etag: null, count: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;

  constructor(private dir: string) {}

  async start(
    intervalHours = 24,
    onSynced?: (result: DefinitionSyncResult) => void | Promise<void>,
  ): Promise<void> {
    this.stop();
    const controller = new AbortController();
    this.abortController = controller;
    await mkdir(this.dir, { recursive: true });
    await this.loadMeta();
    if (controller.signal.aborted) return;

    // Sync now if never done or stale
    const staleMs = intervalHours * 60 * 60 * 1000;
    if (Date.now() - this.meta.lastSync > staleMs) {
      await this.sync(controller.signal)
        .then(async result => onSynced?.(result))
        .catch(e => {
          if (!controller.signal.aborted) console.warn('[DefinitionSync] Initial sync failed:', e.message ?? e);
        });
    }
    if (controller.signal.aborted) return;

    // Schedule periodic re-sync
    this.timer = setInterval(async () => {
      await this.sync(controller.signal)
        .then(async result => onSynced?.(result))
        .catch(e => {
          if (!controller.signal.aborted) console.warn('[DefinitionSync] Scheduled sync failed:', e.message ?? e);
        });
    }, staleMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.abortController?.abort();
    this.abortController = null;
  }

  async sync(parentSignal?: AbortSignal): Promise<DefinitionSyncResult> {

    const headers: Record<string, string> = {
      'User-Agent':  'TorrentStack/0.1.0',
      'Accept':      'application/vnd.github+json',
    };
    if (this.meta.etag) headers['If-None-Match'] = this.meta.etag;

    let resp: Response;
    const timeoutSignal = AbortSignal.timeout(60_000);
    const requestSignal = parentSignal
      ? AbortSignal.any([parentSignal, timeoutSignal])
      : timeoutSignal;
    try {
      resp = await fetch(REPO_API, { headers, signal: requestSignal });
    } catch (e) {
      throw new Error(`Network error during definition sync: ${String(e)}`);
    }

    if (resp.status === 304) {
      // A successful conditional check is still a completed refresh. Persist it
      // so restarts do not repeatedly contact GitHub once the interval elapsed.
      this.meta.lastSync = Date.now();
      await this.saveMeta();
      return { downloaded: 0, skipped: true };
    }

    if (!resp.ok) {
      throw new Error(`GitHub API error: ${resp.status}`);
    }

    // GitHub returns a tarball — we extract .yml files from it
    const tarball = Buffer.from(await resp.arrayBuffer());
    if (parentSignal?.aborted) throw parentSignal.reason ?? new Error('Definition sync aborted');
    const count = await this.extractYmlFiles(tarball, parentSignal);

    this.meta = {
      lastSync: Date.now(),
      etag:     resp.headers.get('etag'),
      count,
      source: SOURCE,
    };
    await this.saveMeta();

    return { downloaded: count, skipped: false };
  }

  private async extractYmlFiles(tarball: Buffer, signal?: AbortSignal): Promise<number> {
    const extractDir = this.dir;

    // Parse tar entries manually (tar format is well-specified)
    const gunzipped = await gunzip(tarball);
    const entries   = parseTar(gunzipped);

    const definitions: Array<{ path: string[]; data: string }> = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;

      // Strip leading path component (repo root dir)
      const parts    = entry.name.split('/').slice(1);
      const definitionsIndex = parts.findIndex((part, index) =>
        part === 'src'
        && parts[index + 1] === 'Jackett.Common'
        && parts[index + 2] === 'Definitions');
      if (definitionsIndex < 0) continue;

      const targetParts = parts.slice(definitionsIndex + 3);
      const filename = targetParts[targetParts.length - 1];
      if (!filename || filename.startsWith('.')) continue;
      if (targetParts.some(part => part === '..' || part === '')) continue;
      definitions.push({ path: targetParts, data: entry.data });
    }

    if (definitions.length === 0) {
      throw new Error('Jackett archive contained no indexer definitions at src/Jackett.Common/Definitions');
    }

    if (signal?.aborted) throw signal.reason ?? new Error('Definition sync aborted');

    // Build beside the live directory so an interrupted container recreation
    // cannot expose a partial catalogue. The sibling remains on the same
    // filesystem, allowing the completed tree to be promoted with one rename.
    const stagingDir = join(dirname(extractDir), `.${basename(extractDir)}-sync`);
    const liveDir = join(extractDir, 'jackett');
    await rm(stagingDir, { recursive: true, force: true });

    try {
      // Bind mounts make thousands of serial mkdir/write round trips extremely
      // expensive. Create each directory once and write in bounded batches so
      // the refresh uses available I/O concurrency without flooding the host.
      const writes = definitions.map(definition => ({
        destPath: join(stagingDir, ...definition.path),
        data: definition.data,
      }));
      const directories = [...new Set(writes.map(write => dirname(write.destPath)))];
      const batchSize = 32;
      for (let offset = 0; offset < directories.length; offset += batchSize) {
        if (signal?.aborted) throw signal.reason ?? new Error('Definition sync aborted');
        await Promise.all(directories.slice(offset, offset + batchSize).map(dir => mkdir(dir, { recursive: true })));
      }
      for (let offset = 0; offset < writes.length; offset += batchSize) {
        if (signal?.aborted) throw signal.reason ?? new Error('Definition sync aborted');
        await Promise.all(writes.slice(offset, offset + batchSize)
          .map(write => writeFile(write.destPath, write.data, 'utf8')));
      }

      if (signal?.aborted) throw signal.reason ?? new Error('Definition sync aborted');
      await rm(liveDir, { recursive: true, force: true });
      await rename(stagingDir, liveDir);
      // The former Prowlarr tree is also upstream-managed. Custom definitions
      // live elsewhere and are never changed by synchronization.
      await rm(join(extractDir, 'definitions'), { recursive: true, force: true });
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }

    return definitions.length;
  }

  private async loadMeta(): Promise<void> {
    try {
      const raw = await readFile(join(this.dir, META_FILE), 'utf8');
      this.meta = JSON.parse(raw) as SyncMeta;
      if (this.meta.source !== SOURCE) {
        this.meta = { lastSync: 0, etag: null, count: 0, source: SOURCE };
      }
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
    const shortName = header.subarray(0, 100).toString('utf8').replace(/\0/g, '').trim();
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0/g, '').trim();
    const name = prefix ? `${prefix}/${shortName}` : shortName;
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
