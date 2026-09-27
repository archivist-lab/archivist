/**
 * The page's side of `window.ArchivistAndroid` (see ShellBridge.kt).
 *
 * Synchronous calls return JSON strings; slow ones (probing, discovery,
 * connecting) answer later through `window.__archivistNative.receive`, keyed
 * by a request id. Outside the app — `pnpm dev:web` in a desktop browser — a
 * stand-in keeps servers in localStorage so the page can be worked on.
 */

export interface ServerRecord {
  id: string
  name: string
  homeUrl: string
  awayUrl: string
  lastUsedAt: number
}

export interface ShellState {
  servers: ServerRecord[]
  lastServerId: string | null
  autoConnect: boolean
  error: { serverId: string; message: string } | null
  appVersion: string
  device: string
  fireTv: boolean
}

export interface ProbeResult { ok: boolean; latencyMs: number; error: string | null }
export interface Discovered { host: string; url: string; latencyMs: number }
export interface ConnectAttempt { via: 'home' | 'away'; url: string; error: string | null }

type Message =
  | { type: 'probe'; requestId: string; result: ProbeResult }
  | { type: 'discovered'; requestId: string; server: Discovered }
  | { type: 'discoveryDone'; requestId: string }
  | { type: 'connectProgress'; requestId: string; via: 'home' | 'away'; url: string }
  | { type: 'connectFailed'; requestId: string; attempts: ConnectAttempt[] }

export interface Bridge {
  getState(): string
  saveServer(json: string): string
  removeServer(id: string): void
  probe(requestId: string, url: string): void
  discover(requestId: string): void
  stopDiscovery(): void
  connect(requestId: string, serverId: string): void
  cancelConnect(): void
  exitApp(): void
}

declare global {
  interface Window {
    ArchivistAndroid?: Bridge
    __archivistNative?: { receive(message: Message): void }
  }
}

let counter = 0
const nextId = () => `r${Date.now().toString(36)}${(counter++).toString(36)}`

export class Shell {
  private handlers = new Map<string, (message: Message) => void>()

  constructor(private readonly bridge: Bridge) {
    window.__archivistNative = { receive: message => this.handlers.get(message.requestId)?.(message) }
  }

  state(): ShellState {
    return JSON.parse(this.bridge.getState()) as ShellState
  }

  save(server: Omit<ServerRecord, 'id' | 'lastUsedAt'> & { id?: string }): ServerRecord {
    return JSON.parse(this.bridge.saveServer(JSON.stringify({ id: '', lastUsedAt: 0, ...server }))) as ServerRecord
  }

  remove(id: string): void { this.bridge.removeServer(id) }

  probe(url: string): Promise<ProbeResult> {
    const requestId = nextId()
    return new Promise(resolve => {
      this.handlers.set(requestId, message => {
        if (message.type !== 'probe') return
        this.handlers.delete(requestId)
        resolve(message.result)
      })
      this.bridge.probe(requestId, url)
    })
  }

  /** Sweeps the local network. Returns a function that stops it. */
  discover(onFound: (server: Discovered) => void, onDone: () => void): () => void {
    const requestId = nextId()
    this.handlers.set(requestId, message => {
      if (message.type === 'discovered') onFound(message.server)
      if (message.type === 'discoveryDone') { this.handlers.delete(requestId); onDone() }
    })
    this.bridge.discover(requestId)
    return () => { this.handlers.delete(requestId); this.bridge.stopDiscovery() }
  }

  /**
   * Tries the server's addresses in turn. On success the app replaces this
   * page with the Player, so only progress and failure come back.
   */
  connect(serverId: string, onProgress: (via: 'home' | 'away', url: string) => void, onFailed: (attempts: ConnectAttempt[]) => void): () => void {
    const requestId = nextId()
    this.handlers.set(requestId, message => {
      if (message.type === 'connectProgress') onProgress(message.via, message.url)
      if (message.type === 'connectFailed') { this.handlers.delete(requestId); onFailed(message.attempts) }
    })
    this.bridge.connect(requestId, serverId)
    return () => { this.handlers.delete(requestId); this.bridge.cancelConnect() }
  }

  exit(): void { this.bridge.exitApp() }
}

/** Browser stand-in for the Android bridge, for local development only. */
export function browserBridge(): Bridge {
  const KEY = 'archivist-tv-dev-servers'
  const read = (): ServerRecord[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as ServerRecord[] } catch { return [] } }
  const write = (servers: ServerRecord[]) => { try { localStorage.setItem(KEY, JSON.stringify(servers)) } catch { /* private window */ } }
  const reply = (message: Message) => setTimeout(() => window.__archivistNative?.receive(message), 350)
  return {
    getState: () => {
      const servers = read().sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      const state: ShellState = { servers, lastServerId: servers[0]?.id ?? null, autoConnect: false, error: null, appVersion: 'dev', device: 'Browser', fireTv: false }
      return JSON.stringify(state)
    },
    saveServer: json => {
      const server = JSON.parse(json) as ServerRecord
      const saved = { ...server, id: server.id || `s${Date.now().toString(36)}` }
      write([...read().filter(entry => entry.id !== saved.id), saved])
      return JSON.stringify(saved)
    },
    removeServer: id => write(read().filter(entry => entry.id !== id)),
    probe: (requestId, url) => {
      const started = performance.now()
      fetch(`${url}/ping`, { mode: 'no-cors', cache: 'no-store' })
        .then(() => reply({ type: 'probe', requestId, result: { ok: true, latencyMs: Math.round(performance.now() - started), error: null } }))
        .catch(() => reply({ type: 'probe', requestId, result: { ok: false, latencyMs: 0, error: 'Unreachable' } }))
    },
    discover: requestId => reply({ type: 'discoveryDone', requestId }),
    stopDiscovery: () => {},
    connect: (requestId, serverId) => {
      const server = read().find(entry => entry.id === serverId)
      if (!server) return
      reply({ type: 'connectProgress', requestId, via: 'home', url: server.homeUrl })
      setTimeout(() => { if (server.homeUrl) window.location.href = `${server.homeUrl}/player/` }, 900)
    },
    cancelConnect: () => {},
    exitApp: () => {},
  }
}

export function createShell(): Shell {
  return new Shell(window.ArchivistAndroid ?? browserBridge())
}
