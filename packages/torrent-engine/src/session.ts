// Session — the root object. One per running process.
// Owns: all TorrentInstances, DHT, LPD, SessionBandwidth, ResumeStore.
// This is the public API surface that the Express app talks to.

import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile, readdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { exec } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import {
  parseTorrentFile, parseMagnetLink,
  Dht, Lpd, PortForwarder, UtpManager, generatePeerId,
	  announce,
	  encode,
	  decodeHandshake,
	  type TorrentMetainfo,
	  type AnnounceRequest,
	} from '@torrentstack/bittorrent';
import { Swarm, type SwarmDiagnostics } from './swarm.js';
import { PieceManager } from './piece-manager.js';
import { Storage } from './storage.js';
import { ResumeStore, type ResumeData } from './resume.js';
import { SessionBandwidth, TorrentBandwidth } from './bandwidth.js';
import type {
  Torrent, TorrentStatus, AddTorrentOptions,
  SessionSettings, SessionStats, BandwidthGroup,
} from '@torrentstack/types';
import { MetadataFetcher } from './metadata-fetcher.js';

// ─── Torrent instance ─────────────────────────────────────────────────────────

interface TorrentInstance {
  id:         string;
  meta:       TorrentMetainfo | null;   // null until metadata fetched (magnet)
  resume:     ResumeData;
  status:     TorrentStatus;
  swarm:      Swarm | null;
  pieces:     PieceManager | null;
  storage:    Storage | null;
  bw:         TorrentBandwidth | null;
  error:      string | null;

  // Tracker announce state
  announceTimer: ReturnType<typeof setInterval> | null;
  peerRefreshTimer: ReturnType<typeof setInterval> | null;
  trackerTier:   number;
  trackerId:     string | null;
	  trackerStats:  Map<string, {
	    tier: number;
	    lastAnnounceTime: number;
	    lastAnnounceSucceeded: boolean;
	    lastAnnounceResult: string;
	    lastAnnouncePeerCount: number;
	    nextAnnounceTime: number;
	    isAnnouncing: boolean;
	    seederCount: number;
	    leecherCount: number;
	    downloadCount: number;
	    healthScore: number;
	    failureCategory: string | null;
	    augmented: boolean;
	  }>;

	  metadataFetcher: MetadataFetcher | null;
	  discoveredPeers: Array<{ ip: string; port: number }>;
	  recheckProgress: number;

  // Ratio / idle tracking
  uploadedTotal:   number;
  downloadedTotal: number;
  seedingStartedAt: number | null;
	  lastActivity:    number;
	}

// ─── Session events ───────────────────────────────────────────────────────────

export interface SessionEvents {
  'torrent:added':    [id: string];
  'torrent:removed':  [id: string];
  'torrent:updated':  [id: string];
  'torrent:complete': [id: string];
  'torrent:error':    [id: string, error: string];
  'speed:update':     [dl: number, ul: number];
}

const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker1.bt.moack.co.kr:80/announce',
  'udp://tracker.bit24.org:6969/announce',
];

const DEAD_PUBLIC_TRACKER_HOSTS = new Set([
  '9.rarbg.to',
  '9.rarbg.me',
  'tracker.leechers-paradise.org',
  'coppersurfer.tk',
  'tracker.coppersurfer.tk',
]);
const MIN_PUBLIC_TRACKERS = 6;
const MAX_PARALLEL_ANNOUNCES = 8;

const STATUS_HAVE = 2;
const STATUS_SKIPPED = 3;

function bstr(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function buildTorrentFile(infoBytes: Buffer, trackers: string[], webSeeds: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from('d')];
  if (trackers.length > 0) {
    parts.push(encode(bstr('announce')), encode(bstr(trackers[0]!)));
    parts.push(encode(bstr('announce-list')), encode(trackers.map(t => [bstr(t)])));
  }
  parts.push(encode(bstr('info')), infoBytes);
  if (webSeeds.length === 1) {
    parts.push(encode(bstr('url-list')), encode(bstr(webSeeds[0]!)));
  } else if (webSeeds.length > 1) {
    parts.push(encode(bstr('url-list')), encode(webSeeds.map(bstr)));
  }
  parts.push(Buffer.from('e'));
  return Buffer.concat(parts);
}

function normalizeTrackerUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'udp:' && protocol !== 'http:' && protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (!host || DEAD_PUBLIC_TRACKER_HOSTS.has(host)) return null;
    const port = url.port ? `:${url.port}` : '';
    const path = url.pathname && url.pathname !== '/' ? url.pathname : '/announce';
    return `${protocol}//${host}${port}${path}${url.search}`;
  } catch {
    return null;
  }
}

function classifyTrackerFailure(result: string): string | null {
  const text = result.toLowerCase();
  if (!result || text === 'success') return null;
  if (text.includes('enotfound') || text.includes('eai_again') || text.includes('dns')) return 'dns';
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('http') || text.includes('status')) return 'http';
  if (text.includes('connection') || text.includes('econn') || text.includes('network')) return 'network';
  if (text.includes('failure')) return 'tracker';
  return 'unknown';
}

// ─── Session ──────────────────────────────────────────────────────────────────

export class Session extends EventEmitter {
  private torrents = new Map<string, TorrentInstance>();
  private ourPeerId: Buffer;
  private dht:       Dht;
  private lpd:       Lpd;
  private portForwarder: PortForwarder;
  private utp:       UtpManager;
  private bw:        SessionBandwidth;
  private resume:    ResumeStore;
  private settings:  SessionSettings;
  private server:    Server | null = null;
  private speedTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer:  ReturnType<typeof setInterval> | null = null;

  private static DEFAULT_SETTINGS: SessionSettings = {
    downloadDir:       './downloads',
    incompleteDir:     './incomplete',
    incompleteDirEnabled: false,
    startAddedTorrents:   true,
    trashOriginalTorrentFiles: false,
    renamePartialFiles:  true,
    preallocation:       'fast',
    cacheSize:           64,          // MiB
    defaultLabels:       [],
    watchDir:            './watch',
    watchDirEnabled:     false,
    speedLimitDown:      0,
    speedLimitDownEnabled: false,
    speedLimitUp:        0,
    speedLimitUpEnabled: false,
    altSpeedDown:        50,
    altSpeedUp:          50,
    altSpeedEnabled:     false,
    altSpeedTimeEnabled: false,
    altSpeedTimeBegin:   540,
    altSpeedTimeEnd:     1020,
    altSpeedTimeDays:    127,
    downloadQueueEnabled: true,
    downloadQueueSize:   5,
    seedQueueEnabled:    false,
    seedQueueSize:       10,
    queueStalledEnabled: true,
    queueStalledMinutes: 30,
    seedRatioLimit:      2.0,
    seedRatioLimited:    false,
    idleSeedingLimit:    30,
    idleSeedingLimitEnabled: false,
    peerLimitGlobal:     200,
    peerLimitPerTorrent: 50,
    peerPort:            51413,
    peerHost:            '0.0.0.0',
    advertisedPeerPort:  51413,
    dhtPort:             51413,
    utpPort:             51414,
    peerPortRandomOnStart: false,
    portForwardingEnabled: true,
    encryption:          'preferred',
    dhtEnabled:          true,
    pexEnabled:          true,
    lpdEnabled:          true,
    utpEnabled:          true,
    defaultPriority:     'normal',
    sequentialDownloadDefault: false,
    blocklistEnabled:    false,
    blocklistUrl:        '',
    proxyUrl:            null,
    scriptTorrentAddedEnabled:         false,
    scriptTorrentAddedFilename:        '',
    scriptTorrentDoneEnabled:          false,
    scriptTorrentDoneFilename:         '',
    scriptTorrentDoneSeedingEnabled:   false,
    scriptTorrentDoneSeedingFilename:  '',
    defaultTrackers:     PUBLIC_TRACKERS,
    announceIp:          '',
    announceIpEnabled:   false,
    torrentAddedVerifyMode:     'fast',
    torrentCompleteVerifyEnabled: false,
  };

  constructor(
    settings: Partial<SessionSettings>,
    private dirs: { resume: string; torrents: string },
  ) {
    super();
    this.settings  = { ...Session.DEFAULT_SETTINGS, ...settings };
    this.ourPeerId = generatePeerId();
    this.resume    = new ResumeStore(dirs.resume);

    this.bw = new SessionBandwidth(
      { downloadKBs: this.settings.speedLimitDownEnabled ? this.settings.speedLimitDown : 0,
        uploadKBs:   this.settings.speedLimitUpEnabled   ? this.settings.speedLimitUp   : 0 },
      { downloadKBs: this.settings.altSpeedDown,
        uploadKBs:   this.settings.altSpeedUp },
    );

    this.dht = new Dht({ port: this.settings.dhtPort });
    this.lpd = new Lpd(this.settings.peerPort);
    this.portForwarder = new PortForwarder(this.settings.peerPort);
    this.utp = new UtpManager(this.settings.utpPort);

    this.attachDhtListeners(this.dht);

    this.lpd.on('peer-found', (infoHashHex, peer) => {
      const inst = this.findByInfoHash(infoHashHex);
      if (inst?.swarm) inst.swarm.addKnownPeers([peer], 'lpd');
    });
    this.lpd.on('error', (err) => {
      console.error('[Session] LPD error:', err.message);
    });
  }

  private attachDhtListeners(dht: Dht) {
    dht.on('peers-found', (infoHashHex, peers) => {
      const inst = this.findByInfoHash(infoHashHex);
      if (inst?.swarm) inst.swarm.addKnownPeers(peers, 'dht');
    });
    dht.on('error', (err) => {
      console.error('[Session] DHT error:', err.message);
    });
  }

  private normalizeTrackerTiers(meta: TorrentMetainfo): void {
    const seen = new Set<string>();
    const normalized: string[][] = [];
    for (const tier of meta.trackers) {
      for (const raw of tier) {
        const tracker = normalizeTrackerUrl(raw);
        if (!tracker || seen.has(tracker)) continue;
        seen.add(tracker);
        normalized.push([tracker]);
      }
    }

    if (!meta.isPrivate && normalized.length < MIN_PUBLIC_TRACKERS) {
      for (const raw of this.settings.defaultTrackers) {
        const tracker = normalizeTrackerUrl(raw);
        if (!tracker || seen.has(tracker)) continue;
        seen.add(tracker);
        normalized.push([tracker]);
        if (normalized.length >= MIN_PUBLIC_TRACKERS) break;
      }
    }

    meta.trackers.splice(0, meta.trackers.length, ...normalized);
  }

  private isAugmentedTracker(url: string): boolean {
    const normalized = normalizeTrackerUrl(url);
    if (!normalized) return false;
    return this.settings.defaultTrackers.some(t => normalizeTrackerUrl(t) === normalized);
  }

  // ─── Init / shutdown ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.resume.init();
    await mkdir(this.dirs.torrents, { recursive: true });
    await mkdir(this.settings.downloadDir, { recursive: true });

    this.bw.start();

    if (this.settings.dhtEnabled) {
      try {
        await this.dht.start();
      } catch (err: any) {
        if (err.code === 'EADDRINUSE') {
	          console.warn(`[Session] DHT port ${this.settings.dhtPort} in use, trying random port...`);
          // Stop and recreate DHT with port 0 (random)
          this.dht.stop();
          const newDht = new Dht({ port: 0 });
          this.attachDhtListeners(newDht);
          this.dht = newDht;
          await this.dht.start();
        } else {
          throw err;
        }
      }
    }

    if (this.settings.lpdEnabled) {
      try {
        await this.lpd.start();
      } catch (err: any) {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[Session] LPD port ${this.settings.peerPort} in use, LPD disabled for this session.`);
        } else {
          throw err;
        }
      }
    }

    if (this.settings.portForwardingEnabled) {
      this.portForwarder.start();
    }

    if (this.settings.utpEnabled) {
      this.utp.start();
    }

    // Restore torrents from resume files
    const saved = await this.resume.loadAll();
    for (const data of saved) {
      await this.restoreTorrent(data);
    }

    // Speed update broadcast
    this.speedTimer = setInterval(() => {
      this.emit('speed:update', this.bw.downloadSpeed, this.bw.uploadSpeed);
    }, 1000);

    // Session maintenance tick (queue, ratio, etc.)
    this.tickTimer = setInterval(() => this.tick(), 2000);

    // Start TCP server for incoming peer connections
    this.server = createServer((socket) => this.onIncomingConnection(socket));
    this.server.listen(this.settings.peerPort, this.settings.peerHost, () => {
      console.log(`[Session] Listening for peer connections on ${this.settings.peerHost}:${this.settings.peerPort}`);
    });
    this.server.on('error', (err) => {
      console.error(`[Session] TCP server error:`, err.message);
    });
  }

  private onIncomingConnection(socket: Socket): void {
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    
    // For incoming connections, we wait for the BitTorrent handshake
    // before we know which swarm to route it to.
    let hsBuf = Buffer.alloc(0);
    
    const onData = (chunk: Buffer) => {
      hsBuf = Buffer.concat([hsBuf, chunk]);
      if (hsBuf.length >= 68) {
        socket.removeListener('data', onData);
        try {
          const parsed = decodeHandshake(hsBuf);
          const ihHex = parsed.infoHash.toString('hex');
          const inst = this.findByInfoHash(ihHex);
          
          if (inst?.swarm) {
            // We need to pass the remaining buffer (if any) to the PeerConnection
            const remaining = hsBuf.subarray(68);
            if (remaining.length > 0) {
              socket.pause(); // Pause while routing
              socket.unshift(remaining);
            }
            
            inst.swarm.onIncomingConnection(socket, parsed.peerId);
            if (remaining.length > 0) socket.resume();
          } else {
            console.log(`[Session] Incoming connection for unknown infohash ${ihHex} from ${remoteAddr}`);
            socket.destroy();
          }
        } catch (err: any) {
          console.warn(`[Session] Failed to decode handshake from ${remoteAddr}: ${err.message}`);
          socket.destroy();
        }
      }
    };

    socket.on('data', onData);
    socket.setTimeout(10000, () => {
      if (hsBuf.length < 68) {
        console.log(`[Session] Incoming connection from ${remoteAddr} timed out waiting for handshake`);
        socket.destroy();
      }
    });
    socket.on('error', () => socket.destroy());
  }

  async stop(): Promise<void> {
    if (this.speedTimer) { clearInterval(this.speedTimer); this.speedTimer = null; }
    if (this.tickTimer)  { clearInterval(this.tickTimer);  this.tickTimer = null; }

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Announce 'stopped' to all trackers
    const announcePromises = [...this.torrents.values()].map(inst =>
      this.announceStop(inst).catch(() => {}),
    );
    await Promise.allSettled(announcePromises);

    // Stop all swarms and flush storage
    for (const inst of this.torrents.values()) {
      inst.swarm?.stop();
      await inst.storage?.flushCache().catch(() => {});
      await inst.storage?.closeHandles().catch(() => {});
      if (inst.announceTimer) clearInterval(inst.announceTimer);
    }

    this.dht.stop();
    this.lpd.stop();
    this.portForwarder.stop();
    this.utp.stop();
    this.bw.stop();
  }

  private tick(): void {
    // Update stats from bandwidth manager
    for (const inst of this.torrents.values()) {
      if (inst.bw) {
        inst.uploadedTotal = inst.bw.totalUp;
      }
    }

    this.checkSeedingLimits();
    this.processQueue();
    this.processWatchDir();
  }

  private async processWatchDir(): Promise<void> {
    if (!this.settings.watchDirEnabled) return;

    try {
      const files = await readdir(this.settings.watchDir);
      for (const file of files) {
        if (!file.toLowerCase().endsWith('.torrent')) continue;

        const fullPath = join(this.settings.watchDir, file);
        console.log(`[Session] Found new torrent in watch directory: ${file}`);

        try {
          const bytes = await readFile(fullPath);
          await this.addTorrent({ torrentFile: bytes, addedVia: 'watch-dir' });
          
          if (this.settings.trashOriginalTorrentFiles) {
            await unlink(fullPath);
          } else {
            // Rename to .added to prevent re-processing
            await writeFile(fullPath + '.added', bytes);
            await unlink(fullPath);
          }
        } catch (err) {
          console.error(`[Session] Failed to add torrent from watch dir ${file}:`, err);
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error(`[Session] Watch directory error:`, err);
      }
    }
  }

  private runScript(type: 'added' | 'done' | 'done-seeding', inst: TorrentInstance): void {
    let enabled = false;
    let filename = '';

    if (type === 'added') {
      enabled  = this.settings.scriptTorrentAddedEnabled;
      filename = this.settings.scriptTorrentAddedFilename;
    } else if (type === 'done') {
      enabled  = this.settings.scriptTorrentDoneEnabled;
      filename = this.settings.scriptTorrentDoneFilename;
    } else if (type === 'done-seeding') {
      enabled  = this.settings.scriptTorrentDoneSeedingEnabled;
      filename = this.settings.scriptTorrentDoneSeedingFilename;
    }

    if (!enabled || !filename) return;

    const env = {
      ...process.env,
      TR_APP_VERSION: '0.1.0',
      TR_TIME_LOCALTIME: new Date().toString(),
      TR_TORRENT_DIR: inst.resume.downloadDir,
      TR_TORRENT_HASH: inst.resume.infoHash,
      TR_TORRENT_ID: inst.id,
      TR_TORRENT_NAME: inst.resume.name,
    };

    console.log(`[Session] Running ${type} script: ${filename} for ${inst.resume.name}`);
    exec(filename, { env }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[Session] Script ${filename} failed:`, err);
      }
      if (stdout) console.log(`[Session] Script stdout: ${stdout}`);
      if (stderr) console.warn(`[Session] Script stderr: ${stderr}`);
    });
  }

  /** Enforce seed ratio and idle limits */
  private checkSeedingLimits(): void {
    const now = Date.now();

    for (const inst of this.torrents.values()) {
      if (inst.status !== 'seeding') continue;

      // Update activity timestamp from bandwidth if active
      if (inst.bw && inst.bw.downloadSpeed > 0 || (inst.bw?.uploadSpeed ?? 0) > 0) {
        inst.resume.activityAt = inst.bw?.lastActivity ?? now;
      }

      // 1. Seed Ratio Limit
      const ratioMode  = inst.resume.seedRatioMode;
      const ratioLimit = ratioMode === 0 ? this.settings.seedRatioLimit : inst.resume.seedRatioLimit;
      const ratioEnabled = ratioMode === 0 ? this.settings.seedRatioLimited : ratioMode === 1;

      if (ratioEnabled && ratioLimit > 0) {
        const total      = inst.meta?.totalSize ?? 0;
        const progress   = inst.pieces?.progress ?? 0;
        const verified   = Math.round(progress * total);
        
        // Ratio = uploaded / totalSize (or uploaded / verified if partial)
        const currentRatio = verified > 0 ? inst.uploadedTotal / verified : 0;

        if (currentRatio >= ratioLimit) {
          console.log(`[Session] Torrent ${inst.id} reached seed ratio limit (${currentRatio.toFixed(2)} >= ${ratioLimit})`);
          this.runScript('done-seeding', inst);
          this.stopTorrent(inst.id).catch(() => {});
          continue;
        }
      }

      // 2. Idle Seeding Limit
      const idleMode  = inst.resume.seedIdleMode;
      const idleLimit = idleMode === 0 ? this.settings.idleSeedingLimit : inst.resume.seedIdleLimit;
      const idleEnabled = idleMode === 0 ? this.settings.idleSeedingLimitEnabled : idleMode === 1;

      if (idleEnabled && idleLimit > 0) {
        const idleMs = now - (inst.resume.activityAt ?? inst.seedingStartedAt ?? now);
        if (idleMs > idleLimit * 60 * 1000) {
          console.log(`[Session] Torrent ${inst.id} reached idle limit (${Math.round(idleMs / 60000)}m > ${idleLimit}m)`);
          this.runScript('done-seeding', inst);
          this.stopTorrent(inst.id).catch(() => {});
          continue;
        }
      }
    }
  }

  private markTorrentError(inst: TorrentInstance, operation: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    inst.status = 'error';
    inst.error = message;
    console.error(`[Session] ${operation} failed for ${inst.id}: ${message}`);
    this.emit('torrent:error', inst.id, message);
  }

  /** Promote queued torrents to active if slots are available */
	  private processQueue(): void {
	    const all = [...this.torrents.values()].sort((a, b) => a.resume.queuePosition - b.resume.queuePosition);
	    const now = Date.now();

	    const nextCheck = all.find(i => i.status === 'queued-check' && i.meta);
	    if (nextCheck) {
	      this.verifyTorrent(nextCheck.id).catch(err => this.markTorrentError(nextCheck, 'Verification', err));
	      return;
	    }

	    const activeDownloading = all.filter(i => {
      if (i.status !== 'downloading' && i.status !== 'checking') return false;
      
      // Check if stalled
      if (this.settings.queueStalledEnabled) {
        const speed = i.bw?.downloadSpeed ?? 0;
        const idleMs = now - (i.resume.activityAt ?? i.resume.addedAt);
        if (speed < 5000 && idleMs > this.settings.queueStalledMinutes * 60 * 1000) {
          return false; // Stalled torrent doesn't count against the queue limit
        }
      }
      return true;
    });

    const activeSeeding = all.filter(i => i.status === 'seeding');

    // 1. Promote to downloading
	    const downloadSlots = this.settings.downloadQueueEnabled
	      ? Math.max(0, this.settings.downloadQueueSize - activeDownloading.length)
	      : Number.POSITIVE_INFINITY;
	    if (downloadSlots > 0) {
	      const next = all.find(i => i.status === 'queued-download' && i.meta);
	      if (next) {
	        console.log(`[Session] Promoting ${next.id} from queue to download`);
	        this.startTorrent(next, next.discoveredPeers, true).catch(err => this.markTorrentError(next, 'Download start', err));
	        next.discoveredPeers = []; // clear them once passed
	      }
	    }

	    // 2. Promote to seeding
	    const seedSlots = this.settings.seedQueueEnabled
	      ? Math.max(0, this.settings.seedQueueSize - activeSeeding.length)
	      : Number.POSITIVE_INFINITY;
	    if (seedSlots > 0) {
	      const next = all.find(i => i.status === 'queued-seed');
	      if (next) {
        console.log(`[Session] Promoting ${next.id} from queue to seed`);
        this.startTorrent(next, next.discoveredPeers, true).catch(err => this.markTorrentError(next, 'Seed start', err));
        next.discoveredPeers = []; // clear them once passed
      }
    }
  }

  // ─── Add torrent ──────────────────────────────────────────────────────────────

  async addTorrent(opts: AddTorrentOptions): Promise<string> {
    let meta: TorrentMetainfo | null = null;
    let magnetLink: string | null = null;
    let torrentFilePath: string | null = null;
    let magnetDisplayName: string | null = null;

    if (opts.torrentFile) {
      meta = parseTorrentFile(opts.torrentFile);
      // Save .torrent file for future restarts
      torrentFilePath = join(this.dirs.torrents, `${meta.infoHash}.torrent`);
      await writeFile(torrentFilePath, opts.torrentFile);
    } else if (opts.magnetLink) {
      const parsed = parseMagnetLink(opts.magnetLink);
      magnetLink = opts.magnetLink;
      magnetDisplayName = parsed.name ?? null;
      // meta will be fetched from swarm via ut_metadata
      meta = null;
    } else if (opts.torrentUrl) {
      const res = await fetch(opts.torrentUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TorrentStack/0.1.0)' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new SessionError(`Failed to fetch torrent from ${opts.torrentUrl}: HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      meta        = parseTorrentFile(bytes);
      torrentFilePath = join(this.dirs.torrents, `${meta.infoHash}.torrent`);
      await writeFile(torrentFilePath, bytes);
    } else {
      throw new SessionError('One of torrentFile, magnetLink, or torrentUrl is required');
    }

    const infoHash = meta?.infoHash ?? parseMagnetLink(magnetLink!).infoHash;

    // Deduplicate
    const existing = this.findByInfoHash(infoHash);
    if (existing) return existing.id;

    const id = randomUUID();
    const now = Date.now();

    const resumeData: ResumeData = {
      infoHash,
      name:            meta?.name ?? magnetDisplayName ?? 'Downloading metadata...',
      addedAt:         now,
      addedVia:        opts.torrentFile ? 'file' : opts.magnetLink ? 'magnet' : 'url',
      downloadDir:     opts.downloadDir ?? this.settings.downloadDir,
      incompleteDir:   opts.incompleteDir ?? (this.settings.incompleteDirEnabled ? this.settings.incompleteDir : null),
      torrentFile:     torrentFilePath,
      magnetLink,
      bitfield:        null,
      uploadedBytes:   0,
      corruptBytes:    0,
      stopped:         !(opts.paused === true ? false : this.settings.startAddedTorrents),
      sequentialDownload: opts.sequentialDownload ?? this.settings.sequentialDownloadDefault,
      queuePosition:   this.torrents.size,
      bandwidthPriority: opts.priority ?? this.settings.defaultPriority,
      downloadLimit:   0,
      uploadLimit:     0,
      seedRatioLimit:  opts.seedRatioLimit ?? -1,
      seedRatioMode:   opts.seedRatioLimit !== undefined ? 1 : 0,
      seedIdleLimit:   opts.seedIdleLimit ?? -1,
      seedIdleMode:    opts.seedIdleLimit !== undefined ? 1 : 0,
      filePriorities:  opts.filePriorities ?? [],
      wantedFiles:     opts.wantedFiles ?? [],
      labels:          opts.labels ?? [],
      group:           opts.bandwidthGroup ?? null,
      activityAt:      null,
      completedAt:     null,
    };

    await this.resume.save(resumeData);
    await this.instantiate(id, meta, resumeData);

    const inst = this.torrents.get(id);
    if (inst) this.runScript('added', inst);

    this.emit('torrent:added', id);
    return id;
  }

	  private async instantiate(id: string, meta: TorrentMetainfo | null, resumeData: ResumeData): Promise<void> {
	    if (meta) this.normalizeTrackerTiers(meta);
	    const bw = this.bw.createTorrentBandwidth(id, {
      downloadKBs: resumeData.downloadLimit,
      uploadKBs:   resumeData.uploadLimit,
    });

    const inst: TorrentInstance = {
      id,
      meta,
      resume: resumeData,
      status: resumeData.stopped ? 'stopped' : 'queued-download',
      swarm:  null,
      pieces: null,
      storage: null,
      bw,
      error:  null,
      announceTimer: null,
      peerRefreshTimer: null,
      trackerTier:   0,
	      trackerId:     null,
      trackerStats:  new Map(),
	      metadataFetcher: null,
	      discoveredPeers: [],
	      recheckProgress: 0,
	      uploadedTotal:   resumeData.uploadedBytes,
      downloadedTotal: 0,
      seedingStartedAt: null,
      lastActivity:  Date.now(),
    };

    this.torrents.set(id, inst);

	    if (!resumeData.stopped) {
	      if (meta) {
	        // Transmission restores saved torrents through the check queue before
	        // trusting resume state. Fresh torrents without a bitfield can download immediately.
	        inst.status = inst.resume.bitfield ? 'queued-check' : 'queued-download';
	      } else if (resumeData.magnetLink) {
	        // No metadata yet — start the fetch process (metadata is always high priority)
	        this.startMetadataFetch(inst);
      }
    }
  }

  // ─── Magnet / ut_metadata fetch ───────────────────────────────────────────────

  private startMetadataFetch(inst: TorrentInstance): void {
    const infoHashBuf = Buffer.from(inst.resume.infoHash, 'hex');
    inst.status = 'fetching-metadata';

    const fetcher = new MetadataFetcher(infoHashBuf, this.ourPeerId);
    inst.metadataFetcher = fetcher;

	    fetcher.on('metadata', async (meta, infoBytes) => {
	      inst.discoveredPeers = fetcher.getDiscoveredPeers();
	      inst.metadataFetcher = null;
	      inst.meta            = meta;
	      inst.resume.name     = meta.name;

	      // Persist the .torrent file so we don't need to re-fetch on restart
	      const torrentPath = join(this.dirs.torrents, `${meta.infoHash}.torrent`);
	      try {
	        const parsedMagnet = inst.resume.magnetLink ? parseMagnetLink(inst.resume.magnetLink) : null;
	        const torrentBytes = buildTorrentFile(infoBytes, parsedMagnet?.trackers ?? [], parsedMagnet?.webSeeds ?? []);
	        await writeFile(torrentPath, torrentBytes);
		        const persistedMeta = parseTorrentFile(torrentBytes);
		        inst.meta = persistedMeta;
		        this.normalizeTrackerTiers(inst.meta);
		        inst.resume.torrentFile = torrentPath;
	      } catch (err) {
	        console.warn(`[session] Failed to persist fetched metadata for ${meta.infoHash}:`, err);
	      }

      await this.resume.save(inst.resume).catch(() => {});

      // Queue the actual download now that we have the metadata
      if (!inst.resume.stopped) {
        inst.status = 'queued-download';
      }

      // Notify listeners that this torrent now has full metadata (name, size, etc.)
      this.emit('torrent:updated', inst.id);
    });

    fetcher.on('error', (err) => {
      console.warn(`[session] Metadata fetch error for ${inst.resume.infoHash}:`, err.message);
      // Non-fatal — keep trying via new peers discovered through DHT
    });

    // Determine which trackers to use for peer discovery
	    const trackerSet = new Set<string>();
	    if (inst.resume.magnetLink) {
	      try {
	        const parsed = parseMagnetLink(inst.resume.magnetLink);
	        parsed.trackers.forEach(t => {
	          const normalized = normalizeTrackerUrl(t);
	          if (normalized) trackerSet.add(normalized);
	        });
	      } catch {}
	    }

    // If no trackers in magnet, or very few, add some public ones
	    if (trackerSet.size < 3) {
	      PUBLIC_TRACKERS.slice(0, 5).forEach(t => {
	        const normalized = normalizeTrackerUrl(t);
	        if (normalized) trackerSet.add(normalized);
	      });
	    }
    const trackerList = [...trackerSet].slice(0, 8);

    fetcher.on('need-peers', () => {
      console.log(`[Session] Metadata fetcher needs peers for ${inst.resume.infoHash}. Triggering DHT and ${trackerList.length} trackers.`);
      
      if (this.settings.dhtEnabled) {
        this.dht.getPeers(infoHashBuf).catch(() => {});
      }

      for (const trackerUrl of trackerList) {
        this.fetchPeersFromTracker(trackerUrl, infoHashBuf)
          .then(peers => {
            if (peers.length > 0) {
              console.log(`[Session] Found ${peers.length} peers from tracker ${trackerUrl} for metadata fetch`);
              peers.forEach(p => fetcher.addPeer(p.ip, p.port));
            }
          })
          .catch(() => {});
      }
    });

    // Seed the fetcher with any DHT peers we find
    if (this.settings.dhtEnabled) {
      // Wire DHT peer-found events to the fetcher for this info hash
      const dhtHandler = (ihHex: string, peers: Array<{ ip: string; port: number }>) => {
        if (ihHex !== inst.resume.infoHash) return;
        if (fetcher.isComplete) {
          this.dht.off('peers-found', dhtHandler);
          return;
        }
        if (peers.length > 0) {
          console.log(`[Session] Found ${peers.length} DHT peers for metadata fetch: ${ihHex}`);
          for (const p of peers) fetcher.addPeer(p.ip, p.port);
        }
      };
      this.dht.on('peers-found', dhtHandler);
    }
  }

	  private async fetchPeersFromTracker(
	    url: string,
	    infoHash: Buffer,
	  ): Promise<Array<{ ip: string; port: number }>> {
	    const announceUrl = normalizeTrackerUrl(url);
	    if (!announceUrl) return [];
	    const resp = await announce({
	      announceUrl,
      infoHash,
      peerId:      this.ourPeerId,
      port:        this.settings.advertisedPeerPort,
      uploaded:    0,
      downloaded:  0,
      left:        1,
      event:       'started',
      compact:     true,
      numWant:     30,
      timeoutMs:    8_000,
    });
    return resp.peers;
  }

  private async restoreTorrent(data: ResumeData): Promise<void> {
    let meta: TorrentMetainfo | null = null;
    if (data.torrentFile) {
      try {
        const bytes = await readFile(data.torrentFile);
        meta = parseTorrentFile(bytes);
      } catch {}
    }

    const id = randomUUID();
    await this.instantiate(id, meta, data);
  }

  // ─── Start / stop ─────────────────────────────────────────────────────────────

  async startTorrent(instOrId: TorrentInstance | string, initialPeers: Array<{ ip: string; port: number }> = [], bypassQueue = false): Promise<void> {
	    const inst = typeof instOrId === 'string' ? this.torrents.get(instOrId) : instOrId;
	    if (!inst) throw new SessionError('Torrent not found');
	    if (inst.swarm && (inst.status === 'downloading' || inst.status === 'seeding')) return;
	    if (inst.status === 'checking') return;

    inst.resume.stopped = false;
    await this.resume.save(inst.resume).catch(() => {});

	    if (!inst.meta) {
	      if (inst.resume.magnetLink && !inst.metadataFetcher) {
	        this.startMetadataFetch(inst);
	      } else {
	        inst.status = 'fetching-metadata';
	      }
	      return;
	    }

    const isComplete = inst.pieces?.isComplete() ?? false;

    // Queue check
    if (!bypassQueue) {
      if (isComplete && this.settings.seedQueueEnabled) {
        const seedingCount = [...this.torrents.values()].filter(i => i.status === 'seeding').length;
        if (seedingCount >= this.settings.seedQueueSize) {
          inst.status = 'queued-seed';
          return;
        }
      } else if (!isComplete && this.settings.downloadQueueEnabled) {
        const downloadingCount = [...this.torrents.values()].filter(i => i.status === 'downloading' || i.status === 'checking').length;
        if (downloadingCount >= this.settings.downloadQueueSize) {
          inst.status = 'queued-download';
          return;
        }
      }
    }

    inst.status = 'checking';

    // Create subsystems
    inst.pieces = new PieceManager(inst.meta, inst.resume.sequentialDownload);

	    // Restore progress from bitfield
	    if (inst.resume.bitfield) {
	      const bf = Buffer.from(inst.resume.bitfield, 'base64');
	      inst.pieces.restoreFromBitfield(bf);
	    }
	    inst.downloadedTotal = this.completedBytes(inst);

    // Apply file priorities so the picker walks high → normal → low and
    // skipped pieces are marked STATUS_SKIPPED with their neededBf bits cleared.
    {
      const fileCount = inst.meta.files.length;
      const wantedFiles = (inst.resume.wantedFiles && inst.resume.wantedFiles.length === fileCount)
        ? inst.resume.wantedFiles
        : Array(fileCount).fill(true);
      const filePriorities = (inst.resume.filePriorities && inst.resume.filePriorities.length === fileCount)
        ? inst.resume.filePriorities
        : Array(fileCount).fill('normal' as import('@torrentstack/types').FilePriority);
      inst.pieces.setPiecePriorities(inst.meta, wantedFiles, filePriorities);
    }

    inst.storage = new Storage(inst.meta, {
      downloadDir:    inst.resume.downloadDir,
      incompleteDir:  inst.resume.incompleteDir ?? undefined,
      renamePartial:  this.settings.renamePartialFiles,
      preallocation:  this.settings.preallocation,
      cacheSize:      this.settings.cacheSize * 1024 * 1024,
    });
    try {
      await inst.storage.init();
    } catch (err) {
      await inst.storage.closeHandles().catch(() => {});
      inst.storage = null;
      inst.pieces = null;
      this.markTorrentError(inst, 'Storage initialization', err);
      throw err;
    }
    inst.error = null;

	    inst.swarm = new Swarm(
	      Buffer.from(inst.meta.infoHash, 'hex'),
	      inst.pieces,
	      inst.bw!,
	      this.ourPeerId,
	      this.settings.peerLimitPerTorrent,
	    );

	    inst.pieces.on('piece-complete', async (pieceIndex, pieceData) => {
      // Write verified piece data to disk first, then persist progress.
      // The data is passed directly from the verifier — do NOT read it back
      // from storage, the cache may have already evicted it.
	      try {
	        await inst.storage!.writePiece(pieceIndex, pieceData);
	        await inst.storage!.flushCache();
	      } catch (err) {
	        console.error(`[session] Failed to write piece ${pieceIndex}:`, err);
	        inst.status = 'error';
	        inst.error = err instanceof Error ? err.message : String(err);
	        this.emit('torrent:error', inst.id, inst.error);
	        return;
	      }

      // Persist bitfield so we can resume after a restart.
      inst.resume.bitfield   = inst.pieces!.haveBitfield.toString('base64');
      inst.resume.activityAt = Date.now();
      inst.lastActivity      = Date.now();
      await this.resume.save(inst.resume).catch(() => {});

	      // Broadcast progress to WebSocket clients via the speed:update tick —
	      // the session already fires that every second, no extra emit needed here.
	    });

	    inst.pieces.on('piece-failed', async (pieceIndex) => {
	      inst.resume.corruptBytes += inst.pieces?.pieceSize(pieceIndex) ?? 0;
	      inst.resume.activityAt = Date.now();
	      inst.lastActivity = Date.now();
	      await this.resume.save(inst.resume).catch(() => {});
	      this.emit('torrent:updated', inst.id);
	    });

	    inst.pieces.on('download-complete', async () => {
      inst.status = 'seeding';
      // If seeding queue is enabled and full, move to queued-seed
      if (this.settings.seedQueueEnabled) {
        const seedingCount = [...this.torrents.values()].filter(i => i.status === 'seeding').length;
        if (seedingCount > this.settings.seedQueueSize) {
          inst.status = 'queued-seed';
          inst.swarm?.stop();
          if (inst.announceTimer) clearInterval(inst.announceTimer);
        }
      }

      inst.resume.completedAt = Date.now();
      inst.seedingStartedAt = Date.now();
      await this.resume.save(inst.resume);
      if (this.settings.torrentCompleteVerifyEnabled) {
        // TODO: trigger full re-verify
      }
      await inst.storage!.finalise();
      this.runScript('done', inst);
      this.emit('torrent:complete', inst.id);
    });

    inst.swarm.start();
    if (initialPeers.length > 0) {
      console.log(`[Session] Seeding swarm for ${inst.meta.infoHash} with ${initialPeers.length} peers from discovery`);
      inst.swarm.addKnownPeers(initialPeers, 'tracker');
    }

    inst.status = inst.pieces.isComplete() ? 'seeding' : 'downloading';

	    // Transmission's default-trackers are a fallback for public torrents, not
	    // a reason to replace the torrent's own tiering on every start.
	    if (!inst.meta.isPrivate && inst.meta.trackers.length === 0 && this.settings.defaultTrackers.length > 0) {
	      inst.meta.trackers.push([...this.settings.defaultTrackers]);
	    }

    // Start tracker announces
    if (inst.announceTimer) { clearInterval(inst.announceTimer); inst.announceTimer = null; }
    if (inst.peerRefreshTimer) { clearInterval(inst.peerRefreshTimer); inst.peerRefreshTimer = null; }
    await this.doAnnounce(inst, 'started');
    inst.announceTimer = setInterval(async () => {
      await this.doAnnounce(inst, '');
    }, 30 * 60 * 1000); // 30 min default, overridden by tracker interval
    inst.peerRefreshTimer = setInterval(() => {
      this.refreshPeerSources(inst).catch(() => {});
    }, 60_000);

    // Start DHT + LPD for non-private torrents
    if (!inst.meta.isPrivate && this.settings.dhtEnabled) {
      const infoHash = Buffer.from(inst.meta.infoHash, 'hex');
      this.dht.getPeers(infoHash).catch(() => {});
      this.dht.stopAnnouncing(infoHash);
      this.dht.announcePeer(infoHash, this.settings.advertisedPeerPort);
    }
    if (!inst.meta.isPrivate && this.settings.lpdEnabled) {
      this.lpd.announce(inst.meta.infoHash);
    }
  }

  async stopTorrent(id: string): Promise<void> {
    const inst = this.torrents.get(id);
    if (!inst) throw new SessionError('Torrent not found');

    // Stop metadata fetch if one is running (magnet link in progress)
    if (inst.metadataFetcher) {
      inst.metadataFetcher.stop();
      inst.metadataFetcher = null;
    }

    await this.announceStop(inst);
    inst.swarm?.stop();
    inst.swarm = null;
    await inst.storage?.flushCache();
    await inst.storage?.closeHandles();
    inst.storage = null;

    if (inst.announceTimer) { clearInterval(inst.announceTimer); inst.announceTimer = null; }
    if (inst.peerRefreshTimer) { clearInterval(inst.peerRefreshTimer); inst.peerRefreshTimer = null; }
    if (inst.meta && !inst.meta.isPrivate) {
      this.dht.stopAnnouncing(Buffer.from(inst.meta.infoHash, 'hex'));
    }

    inst.status = 'stopped';
    inst.resume.stopped = true;
    await this.resume.save(inst.resume);
  }

  // ─── Remove ───────────────────────────────────────────────────────────────────

  async removeTorrent(id: string, deleteData = false): Promise<void> {
    const inst = this.torrents.get(id);
    if (!inst) return;

    await this.stopTorrent(id).catch(() => {});
    this.bw.removeTorrentBandwidth(id);
    this.torrents.delete(id);
    await this.resume.delete(inst.resume.infoHash);

    if (inst.resume.torrentFile) {
      await unlink(inst.resume.torrentFile).catch(() => {});
    }

    if (deleteData && inst.resume.name) {
      const dirs = [
        join(inst.resume.downloadDir, inst.resume.name),
        ...(inst.resume.incompleteDir ? [join(inst.resume.incompleteDir, inst.resume.name)] : []),
      ];
      for (const dir of dirs) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }

    this.emit('torrent:removed', id);
  }

  // ─── Tracker announces ────────────────────────────────────────────────────────

  private trackerHealthScore(url: string, previous: TorrentInstance['trackerStats'] extends Map<string, infer T> ? T | undefined : never): number {
    if (!previous || previous.lastAnnounceTime === 0) return this.isAugmentedTracker(url) ? 12 : 10;
    let score = previous.lastAnnounceSucceeded ? 50 : -20;
    score += Math.min(50, Math.max(0, previous.lastAnnouncePeerCount) * 5);
    if (previous.failureCategory === 'dns') score -= 40;
    else if (previous.failureCategory === 'timeout') score -= 25;
    else if (previous.failureCategory === 'http') score -= 15;
    if (this.isAugmentedTracker(url)) score += 5;
    return score;
  }

  private trackerStat(
    url: string,
    tier: number,
    overrides: Partial<TorrentInstance['trackerStats'] extends Map<string, infer T> ? T : never>,
  ): TorrentInstance['trackerStats'] extends Map<string, infer T> ? T : never {
    const previous = overrides;
    const result = previous.lastAnnounceResult ?? 'Not announced yet';
    return {
      tier,
      lastAnnounceTime: previous.lastAnnounceTime ?? 0,
      lastAnnounceSucceeded: previous.lastAnnounceSucceeded ?? false,
      lastAnnounceResult: result,
      lastAnnouncePeerCount: previous.lastAnnouncePeerCount ?? 0,
      nextAnnounceTime: previous.nextAnnounceTime ?? 0,
      isAnnouncing: previous.isAnnouncing ?? false,
      seederCount: previous.seederCount ?? -1,
      leecherCount: previous.leecherCount ?? -1,
      downloadCount: previous.downloadCount ?? -1,
      healthScore: previous.healthScore ?? 0,
      failureCategory: previous.failureCategory ?? classifyTrackerFailure(result),
      augmented: previous.augmented ?? this.isAugmentedTracker(url),
    } as TorrentInstance['trackerStats'] extends Map<string, infer T> ? T : never;
  }

  private async doAnnounce(inst: TorrentInstance, event: '' | 'started' | 'stopped' | 'completed', force = false): Promise<void> {
    if (!inst.meta || inst.meta.trackers.length === 0) return;
    this.normalizeTrackerTiers(inst.meta);

		    const total    = inst.meta.totalSize;
	    const progress = inst.pieces?.progress ?? 0;
	    const dlBytes  = Math.round(progress * total);
	    const transferred = this.transferredBytes(inst, dlBytes);

	    // Announce to a bounded set of the healthiest due trackers. Sequential UDP
	    // timeouts make reannounce look hung and delay usable peers from healthy trackers.
    let bestInterval = 30 * 60; // default 30 min
    let totalPeers = 0;
    const now = Date.now();
    const candidates: Array<{ url: string; tierIndex: number; score: number }> = [];
    for (let tierIndex = 0; tierIndex < inst.meta.trackers.length; tierIndex++) {
	      const tier = inst.meta.trackers[tierIndex]!;
	      if (!tier || tier.length === 0) continue;
	      const url = tier[0]!;
	      const previous = inst.trackerStats.get(url);
	      const due = event !== '' || force || !previous?.nextAnnounceTime || previous.nextAnnounceTime <= now;
	      if (!due) continue;
	      candidates.push({ url, tierIndex, score: this.trackerHealthScore(url, previous) });
    }
    candidates.sort((a, b) => b.score - a.score);
    const selected = candidates.slice(0, MAX_PARALLEL_ANNOUNCES);
    const announces: Promise<void>[] = [];
    for (const { url, tierIndex } of selected) {
	      const previous = inst.trackerStats.get(url);
	      inst.trackerStats.set(url, {
	        ...this.trackerStat(url, tierIndex, previous ?? {}),
	        lastAnnounceResult: 'Announcing',
	        isAnnouncing: true,
	        healthScore: this.trackerHealthScore(url, previous),
	        failureCategory: null,
	      });

      const req: AnnounceRequest = {
        announceUrl: url,
        infoHash:    Buffer.from(inst.meta.infoHash, 'hex'),
        peerId:      this.ourPeerId,
	        port:        this.settings.advertisedPeerPort,
        uploaded:    inst.uploadedTotal,
	        downloaded:  transferred,
        left:        Math.max(0, total - dlBytes),
        event,
        compact:     true,
        numWant:     50,
        trackerId:   inst.trackerId ?? undefined,
        timeoutMs:    8_000,
      };

      announces.push((async () => {
      try {
	        const resp = await announce(req);
	        totalPeers += resp.peers.length;
	        if (resp.peers.length > 0 && inst.swarm) {
	          inst.swarm.addKnownPeers(resp.peers, 'tracker');
        }
        if (resp.trackerId) inst.trackerId = resp.trackerId;
        if (resp.interval > 0) bestInterval = Math.min(bestInterval, resp.interval);
	        const result = resp.failureReason ?? resp.warningMessage ?? (resp.peers.length === 0 ? 'Success (zero peers)' : 'Success');
	        const succeeded = !resp.failureReason;
	        inst.trackerStats.set(url, this.trackerStat(url, tierIndex, {
	          lastAnnounceTime: Date.now(),
	          lastAnnounceSucceeded: succeeded,
	          lastAnnounceResult: result,
	          lastAnnouncePeerCount: resp.peers.length,
	          nextAnnounceTime: Date.now() + (resp.interval > 0 ? resp.interval : bestInterval) * 1000,
	          isAnnouncing: false,
	          seederCount: resp.complete,
	          leecherCount: resp.incomplete,
	          downloadCount: -1,
	          healthScore: succeeded ? this.trackerHealthScore(url, previous) + Math.min(50, resp.peers.length * 5) : -20,
	          failureCategory: succeeded && resp.peers.length === 0 ? 'zero-peers' : classifyTrackerFailure(result),
	        }));
	      } catch (err) {
	        const result = err instanceof Error ? err.message : 'Announce failed';
	        const category = classifyTrackerFailure(result);
	        const cooldown = category === 'dns' ? 6 * 60 * 60 : category === 'timeout' ? 45 * 60 : bestInterval;
	        inst.trackerStats.set(url, this.trackerStat(url, tierIndex, {
	          lastAnnounceTime: Date.now(),
	          lastAnnounceSucceeded: false,
	          lastAnnounceResult: result,
	          lastAnnouncePeerCount: 0,
	          nextAnnounceTime: Date.now() + cooldown * 1000,
	          isAnnouncing: false,
	          seederCount: previous?.seederCount ?? -1,
	          leecherCount: previous?.leecherCount ?? -1,
	          downloadCount: previous?.downloadCount ?? -1,
	          healthScore: this.trackerHealthScore(url, previous) - (category === 'dns' ? 50 : category === 'timeout' ? 30 : 20),
	          failureCategory: category,
	        }));
	      }
	      })());
	    }

	    await Promise.allSettled(announces);

	    if (totalPeers === 0 && !inst.meta.isPrivate && this.settings.dhtEnabled && event !== 'stopped') {
	      this.dht.getPeers(Buffer.from(inst.meta.infoHash, 'hex')).catch(() => {});
	    }

    // Reschedule using the shortest tracker interval
    if (inst.announceTimer && event !== 'stopped') {
      clearInterval(inst.announceTimer);
      inst.announceTimer = setInterval(
        () => this.doAnnounce(inst, '').catch(() => {}),
        bestInterval * 1000,
      );
    }
  }

	  private async announceStop(inst: TorrentInstance): Promise<void> {
	    if (inst.status !== 'stopped') {
	      await this.doAnnounce(inst, 'stopped').catch(() => {});
	    }
	  }

	  private async refreshPeerSources(inst: TorrentInstance): Promise<void> {
	    if (!inst.meta || inst.status !== 'downloading' || !inst.swarm) return;
	    const connected = inst.swarm.connectedCount;
	    const connecting = inst.swarm.connectingCount;
	    const known = inst.swarm.knownCount;
	    if (connected > 0 && known >= 20) return;

	    const infoHash = Buffer.from(inst.meta.infoHash, 'hex');
	    if (!inst.meta.isPrivate && this.settings.dhtEnabled) {
	      this.dht.getPeers(infoHash).catch(() => {});
	    }

	    if (connected === 0 && connecting === 0) {
	      await this.doAnnounce(inst, '', true).catch(() => {});
	    }
	  }

	  private completedBytes(inst: TorrentInstance): number {
	    if (!inst.meta || !inst.pieces) return 0;
	    let bytes = 0;
	    for (let i = 0; i < inst.pieces.pieceCount; i++) {
	      if (inst.pieces.status[i] >= STATUS_HAVE) {
	        bytes += inst.pieces.pieceSize(i);
	      }
	    }
	    return Math.min(bytes, inst.meta.totalSize);
	  }

	  private transferredBytes(inst: TorrentInstance, verifiedBytes = this.completedBytes(inst)): number {
	    const sessionUseful = inst.bw?.totalUseful ?? 0;
	    return Math.min(inst.meta?.totalSize ?? 0, Math.max(verifiedBytes, inst.downloadedTotal + sessionUseful));
	  }

	  private bitfieldHasPiece(bitfield: Buffer | null, pieceIndex: number): boolean {
	    if (!bitfield) return false;
	    const byteIdx = Math.floor(pieceIndex / 8);
	    const bitIdx = 7 - (pieceIndex % 8);
	    return ((bitfield[byteIdx] ?? 0) & (1 << bitIdx)) !== 0;
	  }

	  async reannounceTorrent(id: string): Promise<void> {
	    const inst = this.torrents.get(id);
	    if (!inst) throw new SessionError('Torrent not found');
	    await this.doAnnounce(inst, '');
	  }

	  async verifyTorrent(id: string): Promise<void> {
	    const inst = this.torrents.get(id);
	    if (!inst) throw new SessionError('Torrent not found');

	    if (!inst.meta) {
	      if (inst.resume.magnetLink) this.startMetadataFetch(inst);
	      return;
	    }

	    const shouldRestart = !inst.resume.stopped;
	    inst.status = 'checking';
	    inst.recheckProgress = 0;
	    this.emit('torrent:updated', id);

	    inst.swarm?.stop();
	    inst.swarm = null;
	    if (inst.announceTimer) { clearInterval(inst.announceTimer); inst.announceTimer = null; }
	    await inst.storage?.flushCache().catch(() => {});
	    await inst.storage?.closeHandles().catch(() => {});

	    const pieces = new PieceManager(inst.meta, inst.resume.sequentialDownload);
	    const fileCount = inst.meta.files.length;
	    const wantedFiles = (inst.resume.wantedFiles && inst.resume.wantedFiles.length === fileCount)
	      ? inst.resume.wantedFiles
	      : Array(fileCount).fill(true);
	    const filePriorities = (inst.resume.filePriorities && inst.resume.filePriorities.length === fileCount)
	      ? inst.resume.filePriorities
	      : Array(fileCount).fill('normal' as import('@torrentstack/types').FilePriority);
	    pieces.setPiecePriorities(inst.meta, wantedFiles, filePriorities);

	    const storage = new Storage(inst.meta, {
	      downloadDir:    inst.resume.downloadDir,
	      incompleteDir:  inst.resume.incompleteDir ?? undefined,
	      renamePartial:  this.settings.renamePartialFiles,
	      preallocation:  this.settings.preallocation,
	      cacheSize:      this.settings.cacheSize * 1024 * 1024,
	    });
    try {
      await storage.init();
    } catch (err) {
      await storage.closeHandles().catch(() => {});
      this.markTorrentError(inst, 'Verification storage initialization', err);
      throw err;
    }

	    const claimed = inst.resume.bitfield ? Buffer.from(inst.resume.bitfield, 'base64') : null;
	    const verified = Buffer.alloc(Math.ceil(pieces.pieceCount / 8));
	    let corruptBytes = 0;
	    for (let pieceIndex = 0; pieceIndex < pieces.pieceCount; pieceIndex++) {
	      if (pieces.status[pieceIndex] === STATUS_SKIPPED) {
	        inst.recheckProgress = (pieceIndex + 1) / pieces.pieceCount;
	        continue;
	      }

	      try {
	        const data = await storage.readPiece(pieceIndex, pieces.pieceSize(pieceIndex));
	        const ok = createHash('sha1').update(data).digest().equals(pieces.hashes[pieceIndex]!);
	        if (ok) {
	          const byteIdx = Math.floor(pieceIndex / 8);
	          const bitIdx = 7 - (pieceIndex % 8);
	          verified[byteIdx]! |= (1 << bitIdx);
	        } else if (this.bitfieldHasPiece(claimed, pieceIndex)) {
	          corruptBytes += pieces.pieceSize(pieceIndex);
	        }
	      } catch {
	        // Missing or short data is normal for partial torrents.
	      }

	      inst.recheckProgress = (pieceIndex + 1) / pieces.pieceCount;
	    }

	    pieces.restoreFromBitfield(verified);
	    inst.pieces = pieces;
	    inst.storage = storage;
	    inst.downloadedTotal = this.completedBytes(inst);
	    inst.resume.corruptBytes = corruptBytes;
	    inst.resume.bitfield = pieces.haveBitfield.toString('base64');
	    inst.resume.activityAt = Date.now();
	    await this.resume.save(inst.resume, true).catch(() => {});

	    if (pieces.isComplete()) {
	      inst.status = shouldRestart ? 'queued-seed' : 'stopped';
	      if (!inst.resume.completedAt) inst.resume.completedAt = Date.now();
	    } else {
	      inst.status = shouldRestart ? 'queued-download' : 'stopped';
	    }

	    inst.recheckProgress = 0;
	    await this.resume.save(inst.resume, true).catch(() => {});
	    await inst.storage?.closeHandles().catch(() => {});
	    this.emit('torrent:updated', id);
	    if (shouldRestart) this.processQueue();
	  }

	  async reorderTorrents(orderedIds: string[]): Promise<void> {
	    const ordered = orderedIds
	      .map(id => this.torrents.get(id))
	      .filter((inst): inst is TorrentInstance => Boolean(inst));
	    const seen = new Set(ordered.map(i => i.id));
	    const tail = [...this.torrents.values()]
	      .filter(i => !seen.has(i.id))
	      .sort((a, b) => a.resume.queuePosition - b.resume.queuePosition);

	    let pos = 0;
	    for (const inst of [...ordered, ...tail]) {
	      inst.resume.queuePosition = pos++;
	      await this.resume.save(inst.resume).catch(() => {});
	      this.emit('torrent:updated', inst.id);
	    }
	    this.processQueue();
	  }

	  async moveTorrentInQueue(id: string, where: 'top' | 'up' | 'down' | 'bottom'): Promise<void> {
	    const ordered = [...this.torrents.values()].sort((a, b) => a.resume.queuePosition - b.resume.queuePosition);
	    const index = ordered.findIndex(i => i.id === id);
	    if (index === -1) throw new SessionError('Torrent not found');

	    const [inst] = ordered.splice(index, 1);
	    if (!inst) return;
	    if (where === 'top') ordered.unshift(inst);
	    else if (where === 'bottom') ordered.push(inst);
	    else if (where === 'up') ordered.splice(Math.max(0, index - 1), 0, inst);
	    else ordered.splice(Math.min(ordered.length, index + 1), 0, inst);

	    await this.reorderTorrents(ordered.map(i => i.id));
	  }

	  async setTorrentPriority(id: string, priority: import('@torrentstack/types').TorrentPriority): Promise<void> {
	    const inst = this.torrents.get(id);
	    if (!inst) throw new SessionError('Torrent not found');
	    inst.resume.bandwidthPriority = priority;
	    await this.resume.save(inst.resume).catch(() => {});
	    this.emit('torrent:updated', id);
	  }

	  // ─── Public query API ─────────────────────────────────────────────────────────

  getTorrent(id: string): Torrent | null {
    const inst = this.torrents.get(id);
    if (!inst) return null;
    return this.toTorrentView(inst);
  }

  getAllTorrents(): Torrent[] {
    return [...this.torrents.values()].map(i => this.toTorrentView(i));
  }

  getStats(): SessionStats {
    const all     = [...this.torrents.values()];
    const active  = all.filter(i => i.status !== 'stopped').length;
    const paused  = all.filter(i => i.status === 'stopped').length;
    return {
      activeTorrentCount: active,
      pausedTorrentCount: paused,
      totalTorrentCount:  all.length,
      downloadSpeed:      this.bw.downloadSpeed,
      uploadSpeed:        this.bw.uploadSpeed,
      currentStats:  { uploadedBytes: 0, downloadedBytes: 0, filesAdded: all.length, sessionCount: 1, secondsActive: 0 },
      cumulativeStats:{ uploadedBytes: 0, downloadedBytes: 0, filesAdded: all.length, sessionCount: 1, secondsActive: 0 },
    };
  }

	  getSettings(): SessionSettings { return { ...this.settings }; }

  getNetworkDiagnostics(): {
    tcp: { host: string; configuredPort: number; boundPort: number | null; listening: boolean; fallback: boolean };
    tracker: { advertisedPort: number; matchesTcp: boolean };
    dht: { configuredPort: number; boundPort: number | null; enabled: boolean; fallback: boolean };
    utp: { configuredPort: number; boundPort: number | null; enabled: boolean; fallback: boolean };
    lpd: { enabled: boolean; multicastPort: number; advertisedPort: number };
    warnings: string[];
  } {
    const address = this.server?.address();
    const tcpBoundPort = typeof address === 'object' && address ? address.port : null;
    const dhtBoundPort = (this.dht as any).boundPort ?? null;
    const utpBoundPort = (this.utp as any).boundPort ?? null;
    const warnings: string[] = [];
    if (tcpBoundPort !== null && tcpBoundPort !== this.settings.peerPort) {
      warnings.push(`TCP peer listener bound to ${tcpBoundPort}, expected ${this.settings.peerPort}`);
    }
    if (this.settings.advertisedPeerPort !== this.settings.peerPort) {
      warnings.push(`Trackers/DHT advertise ${this.settings.advertisedPeerPort}, but TCP listens on ${this.settings.peerPort}`);
    }
    if (this.settings.dhtEnabled && dhtBoundPort !== null && dhtBoundPort !== this.settings.dhtPort) {
      warnings.push(`DHT fell back to UDP ${dhtBoundPort}, expected ${this.settings.dhtPort}`);
    }
    if (this.settings.utpEnabled && utpBoundPort !== null && utpBoundPort !== this.settings.utpPort) {
      warnings.push(`uTP fell back to UDP ${utpBoundPort}, expected ${this.settings.utpPort}`);
    }

    return {
      tcp: {
        host: this.settings.peerHost,
        configuredPort: this.settings.peerPort,
        boundPort: tcpBoundPort,
        listening: !!this.server?.listening,
        fallback: tcpBoundPort !== null && tcpBoundPort !== this.settings.peerPort,
      },
      tracker: {
        advertisedPort: this.settings.advertisedPeerPort,
        matchesTcp: this.settings.advertisedPeerPort === this.settings.peerPort,
      },
      dht: {
        configuredPort: this.settings.dhtPort,
        boundPort: dhtBoundPort,
        enabled: this.settings.dhtEnabled,
        fallback: dhtBoundPort !== null && dhtBoundPort !== this.settings.dhtPort,
      },
      utp: {
        configuredPort: this.settings.utpPort,
        boundPort: utpBoundPort,
        enabled: this.settings.utpEnabled,
        fallback: utpBoundPort !== null && utpBoundPort !== this.settings.utpPort,
      },
      lpd: {
        enabled: this.settings.lpdEnabled,
        multicastPort: 6771,
        advertisedPort: this.settings.advertisedPeerPort,
      },
      warnings,
    };
  }

	  async updateSettings(partial: Partial<SessionSettings>): Promise<void> {
    this.settings = { ...this.settings, ...partial };
    // Apply relevant changes immediately
    if ('speedLimitDown' in partial || 'speedLimitDownEnabled' in partial) {
      this.bw.setNormalLimits({
        downloadKBs: this.settings.speedLimitDownEnabled ? this.settings.speedLimitDown : 0,
        uploadKBs:   this.settings.speedLimitUpEnabled   ? this.settings.speedLimitUp   : 0,
      });
    }
    if ('altSpeedEnabled' in partial) {
      this.bw.setAltMode(this.settings.altSpeedEnabled);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private findByInfoHash(infoHashHex: string): TorrentInstance | undefined {
    return [...this.torrents.values()].find(i => i.resume.infoHash === infoHashHex);
  }

  private stalledReason(inst: TorrentInstance, swarmDiagnostics: SwarmDiagnostics | null = null): string | null {
    if (inst.status === 'stopped') return 'paused';
    if (inst.status === 'fetching-metadata') {
      const peers = inst.metadataFetcher?.activePeerCount ?? 0;
      return peers > 0 ? 'fetching metadata from peers' : 'waiting for metadata peers';
    }
    if (inst.status !== 'downloading') return null;
    if ((inst.bw?.downloadSpeed ?? 0) > 0) return null;
    if (swarmDiagnostics?.availability?.explanation) {
      return swarmDiagnostics.availability.explanation;
    }
    const connected = inst.swarm?.connectedCount ?? 0;
    if (connected === 0) {
      const announced = [...inst.trackerStats.values()].filter(t => t.lastAnnounceTime > 0);
      const successes = announced.filter(t => t.lastAnnounceSucceeded);
      const returnedPeers = announced.reduce((sum, t) => sum + Math.max(0, t.lastAnnouncePeerCount), 0);
      const known = inst.swarm?.knownCount ?? 0;
      const failed = inst.swarm?.failedCount ?? 0;
      if (successes.length > 0 && (returnedPeers > 0 || known > 0 || failed > 0)) {
        return 'trackers returned peers, but peer connections are failing';
      }
      const trackerFailures = announced.filter(t => !t.lastAnnounceSucceeded).length;
      if (trackerFailures > 0) return 'tracker announces are failing';
      return 'no connected peers';
    }
    if (inst.pieces && inst.pieces.progress >= 0.999) return 'finishing final pieces';
    return 'connected peers are not currently sending data';
  }

  private toTorrentView(inst: TorrentInstance): Torrent {
	    const total      = inst.meta?.totalSize ?? 0;
	    // Use progress ratio × total bytes for accuracy (last piece is often smaller
	    // than pieceLength, so downloadedPieces × pieceLength over-counts slightly).
	    const progress   = inst.pieces?.progress ?? 0;
	    const verifiedDownloaded = this.completedBytes(inst);
	    const downloaded = this.transferredBytes(inst, verifiedDownloaded);

    // Compute per-file downloaded bytes by intersecting completed pieces with file byte ranges
    let fileDownloaded: number[] | undefined;
    if (inst.pieces && inst.meta) {
      fileDownloaded = new Array(inst.meta.files.length).fill(0);
      let byteOffset = 0;
      const fileRanges = inst.meta.files.map(f => {
        const range = { start: byteOffset, end: byteOffset + f.sizeBytes };
        byteOffset += f.sizeBytes;
        return range;
      });
      for (let pi = 0; pi < inst.pieces.pieceCount; pi++) {
        if (inst.pieces.status[pi] < 2) continue; // STATUS_HAVE = 2
        const pieceStart = pi * inst.meta.pieceLength;
        const pieceEnd   = pieceStart + inst.pieces.pieceSize(pi);
        for (let fi = 0; fi < fileRanges.length; fi++) {
          const { start, end } = fileRanges[fi]!;
          const overlapStart = Math.max(pieceStart, start);
          const overlapEnd   = Math.min(pieceEnd, end);
          if (overlapStart < overlapEnd) fileDownloaded[fi]! += overlapEnd - overlapStart;
        }
      }
    }

    const trackers = inst.meta?.trackers.flatMap((tier, tierIndex) => tier.map((announceUrl, idx) => {
      const stat = inst.trackerStats.get(announceUrl);
      return {
        id: tierIndex * 1000 + idx,
        announce: announceUrl,
        scrape: '',
        sitename: '',
        tier: Math.min(3, tierIndex) as 0 | 1 | 2 | 3,
        lastAnnounceTime: stat?.lastAnnounceTime ?? 0,
        lastAnnounceSucceeded: stat?.lastAnnounceSucceeded ?? false,
        lastAnnounceResult: stat?.lastAnnounceResult ?? 'Not announced yet',
        lastAnnouncePeerCount: stat?.lastAnnouncePeerCount ?? 0,
        nextAnnounceTime: stat?.nextAnnounceTime ?? 0,
        isAnnouncing: stat?.isAnnouncing ?? false,
        lastScrapeTime: 0,
        lastScrapeSucceeded: false,
        lastScrapeResult: 'Scrape not implemented',
        isScraping: false,
        nextScrapeTime: 0,
	        seederCount: stat?.seederCount ?? -1,
	        leecherCount: stat?.leecherCount ?? -1,
	        downloadCount: stat?.downloadCount ?? -1,
	        healthScore: stat?.healthScore ?? 0,
	        failureCategory: stat?.failureCategory ?? null,
	        augmented: stat?.augmented ?? this.isAugmentedTracker(announceUrl),
	      };
	    })) ?? [];
    const peers = inst.swarm?.getPeerInfos() ?? [];
	    const swarmDiagnostics = inst.swarm?.getDiagnostics() ?? null;
	    const stalledReason = this.stalledReason(inst, swarmDiagnostics);

    return {
      id:             inst.id,
      infoHash:       inst.resume.infoHash,
      name:           inst.resume.name,
      comment:        inst.meta?.comment ?? '',
      creator:        inst.meta?.createdBy ?? '',
      createdAt:      (inst.meta?.creationDate ?? 0) * 1000,
      addedAt:        inst.resume.addedAt,
      isPrivate:      inst.meta?.isPrivate ?? false,
      status:         inst.status,
      error:          inst.error,
      errorCode:      null,
      sizeBytes:      total,
      downloadedBytes:downloaded,
      uploadedBytes:  inst.uploadedTotal,
      corruptBytes:   inst.resume.corruptBytes,
	      leftBytes:      Math.max(0, total - verifiedDownloaded),
      progress,
	      recheckProgress:inst.recheckProgress,
      pieceCount:     inst.meta?.pieces.length ?? 0,
      pieceSize:      inst.meta?.pieceLength ?? 0,
      pieces:         inst.pieces ? inst.pieces.haveBitfield.toString('base64') : null,
      downloadSpeed:  inst.bw?.downloadSpeed ?? 0,
      uploadSpeed:    inst.bw?.uploadSpeed ?? 0,
	      eta:            inst.bw && inst.bw.downloadSpeed > 0
	        ? Math.ceil((total - verifiedDownloaded) / inst.bw.downloadSpeed)
	        : -1,
      peersConnected: inst.metadataFetcher ? inst.metadataFetcher.activePeerCount : (inst.swarm?.connectedCount ?? 0),
      peersGettingFromUs: peers.filter(p => p.isUploadingTo).length,
      peersSendingToUs:   peers.filter(p => p.isDownloadingFrom).length,
      peersSeen:          inst.metadataFetcher ? inst.metadataFetcher.seenPeerCount : (inst.swarm?.totalSeenCount ?? 0),
      seedsConnected:     peers.filter(p => p.progress >= 0.999).length,
      webSeedsPendingCount: 0,
      stalledReason,
	      uploadRatio:    verifiedDownloaded > 0 ? inst.uploadedTotal / verifiedDownloaded : 0,
      seedRatioLimit:  inst.resume.seedRatioLimit,
      seedRatioMode:   inst.resume.seedRatioMode,
      seedIdleLimit:   inst.resume.seedIdleLimit,
      seedIdleMode:    inst.resume.seedIdleMode,
      downloadDir:     inst.resume.downloadDir,
      incompleteDir:   inst.resume.incompleteDir,
      magnetLink:      inst.resume.magnetLink,
      torrentFile:     inst.resume.torrentFile,
      addedVia:        inst.resume.addedVia,
      queuePosition:   inst.resume.queuePosition,
      bandwidthPriority: inst.resume.bandwidthPriority,
      downloadLimit:   inst.resume.downloadLimit,
      downloadLimitEnabled: inst.resume.downloadLimit > 0,
      uploadLimit:     inst.resume.uploadLimit,
      uploadLimitEnabled:   inst.resume.uploadLimit > 0,
      sequentialDownload:   inst.resume.sequentialDownload,
      honorsSessionLimits:  true,
      startedAt:       inst.seedingStartedAt,
      activityAt:      inst.resume.activityAt,
      completedAt:     inst.resume.completedAt,
      labels:          inst.resume.labels,
      group:           inst.resume.group,
      trackers,
      peers,
      diagnostics: swarmDiagnostics,
      files: inst.meta?.files.map((f, i) => {
        const dl = fileDownloaded?.[i] ?? 0;
        return {
          index:          i,
          name:           f.path,
          sizeBytes:      f.sizeBytes,
          downloadedBytes: dl,
          progress:       f.sizeBytes > 0 ? dl / f.sizeBytes : 0,
          priority:       (inst.resume.filePriorities?.[i] ?? 'normal') as import('@torrentstack/types').FilePriority,
          wanted:         inst.resume.wantedFiles?.[i] !== false,
        };
      }),
    };
  }

  async setFilePriorities(id: string, updates: Array<{ index: number; wanted?: boolean; priority?: string }>): Promise<void> {
    const inst = this.torrents.get(id);
    if (!inst) return;
    const fileCount = inst.meta?.files.length ?? 0;
    if (!inst.resume.filePriorities || inst.resume.filePriorities.length < fileCount) {
      inst.resume.filePriorities = Array(fileCount).fill('normal');
    }
    if (!inst.resume.wantedFiles || inst.resume.wantedFiles.length < fileCount) {
      inst.resume.wantedFiles = Array(fileCount).fill(true);
    }
    for (const u of updates) {
      if (u.index < 0 || u.index >= fileCount) continue;
      if (u.wanted !== undefined) inst.resume.wantedFiles[u.index] = u.wanted;
      if (u.priority !== undefined) inst.resume.filePriorities[u.index] = u.priority as import('@torrentstack/types').FilePriority;
    }
    if (inst.pieces && inst.meta) {
      inst.pieces.setPiecePriorities(inst.meta, inst.resume.wantedFiles, inst.resume.filePriorities);
    }
    await this.resume.save(inst.resume).catch(() => {});
    this.emit('torrent:updated', id);
  }
}

export class SessionError extends Error {
  constructor(msg: string) { super(msg); this.name = 'SessionError'; }
}
