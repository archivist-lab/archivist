import type Database from 'better-sqlite3'

export interface DownloadClient {
  id: number
  name: string
  type: 'transmission' | 'qbittorrent' | 'deluge' | 'sabnzbd' | 'nzbget' | 'built-in'
  host: string
  port: number
  useSsl: boolean
  urlBase: string
  username?: string
  password?: string
  category: string
  enabled: boolean
  priority: number
  tags: string[]
  createdAt: Date
  updatedAt: Date
}

/** Synthetic built-in client — always available, represents the embedded TorrentStack engine */
const BUILT_IN_CLIENT: DownloadClient = {
  id: -1,
  name: 'Built-in Torrent Engine',
  type: 'built-in',
  host: 'localhost',
  port: 0,
  useSsl: false,
  urlBase: '',
  category: 'archivist',
  enabled: true,
  priority: 1,
  tags: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

type CreateInput = Omit<DownloadClient, 'id' | 'createdAt' | 'updatedAt'>

export class DownloadClientStore {
  constructor(private db: Database.Database) {
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS download_clients (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL,
        host       TEXT NOT NULL,
        port       INTEGER NOT NULL,
        use_ssl    INTEGER NOT NULL DEFAULT 0,
        url_base   TEXT NOT NULL DEFAULT '',
        username   TEXT,
        password   TEXT,
        category   TEXT NOT NULL DEFAULT 'archivist',
        enabled    INTEGER NOT NULL DEFAULT 1,
        priority   INTEGER NOT NULL DEFAULT 1,
        tags       TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
  }

  private d(row: Record<string, unknown>): DownloadClient {
    return {
      id: row.id as number,
      name: row.name as string,
      type: row.type as DownloadClient['type'],
      host: row.host as string,
      port: row.port as number,
      useSsl: Boolean(row.use_ssl),
      urlBase: row.url_base as string,
      username: row.username as string | undefined,
      password: row.password as string | undefined,
      category: row.category as string,
      enabled: Boolean(row.enabled),
      priority: row.priority as number,
      tags: JSON.parse(row.tags as string ?? '[]'),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    }
  }

  getAll(): DownloadClient[] {
    return (this.db.prepare('SELECT * FROM download_clients ORDER BY priority ASC').all() as Record<string, unknown>[]).map(r => this.d(r))
  }

  getEnabled(): DownloadClient[] {
    const real = this.getAll().filter(c => c.enabled)
    // Always fall back to the built-in engine so routes never see an empty list
    return real.length > 0 ? real : [BUILT_IN_CLIENT]
  }

  getById(id: number): DownloadClient | undefined {
    const row = this.db.prepare('SELECT * FROM download_clients WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.d(row) : undefined
  }

  create(input: CreateInput): DownloadClient {
    const result = this.db.prepare(`
      INSERT INTO download_clients (name, type, host, port, use_ssl, url_base, username, password, category, enabled, priority, tags)
      VALUES (@name, @type, @host, @port, @useSsl, @urlBase, @username, @password, @category, @enabled, @priority, @tags)
    `).run({
      name: input.name,
      type: input.type,
      host: input.host,
      port: input.port,
      useSsl: input.useSsl ? 1 : 0,
      urlBase: input.urlBase ?? '',
      username: input.username ?? null,
      password: input.password ?? null,
      category: input.category ?? 'archivist',
      enabled: input.enabled ? 1 : 0,
      priority: input.priority ?? 1,
      tags: JSON.stringify(input.tags ?? []),
    })
    return this.getById(result.lastInsertRowid as number)!
  }

  update(id: number, input: Partial<CreateInput>): DownloadClient {
    const existing = this.getById(id)
    if (!existing) throw new Error(`Download client ${id} not found`)
    const m = { ...existing, ...input }
    this.db.prepare(`
      UPDATE download_clients SET
        name=@name, type=@type, host=@host, port=@port, use_ssl=@useSsl,
        url_base=@urlBase, username=@username, password=@password,
        category=@category, enabled=@enabled, priority=@priority, tags=@tags,
        updated_at=datetime('now')
      WHERE id=@id
    `).run({
      id, name: m.name, type: m.type, host: m.host, port: m.port,
      useSsl: m.useSsl ? 1 : 0, urlBase: m.urlBase, username: m.username ?? null,
      password: m.password ?? null, category: m.category,
      enabled: m.enabled ? 1 : 0, priority: m.priority, tags: JSON.stringify(m.tags),
    })
    return this.getById(id)!
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM download_clients WHERE id = ?').run(id)
  }
}
