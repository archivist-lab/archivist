import type Database from 'better-sqlite3'
import type { DownloadClient } from '@archivist/core'

/**
 * Library-scoped download client registry over the unified `download_clients`
 * table. Scope 0 is global (legacy shared.db clients); a library id scopes to
 * that library (legacy tab DB clients). API mirrors the legacy core store so
 * ported call sites keep working.
 */

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

export class ScopedDownloadClientStore {
  constructor(private db: Database.Database, private scope: number) {}

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
    return (this.db.prepare('SELECT * FROM download_clients WHERE library_id = ? ORDER BY priority ASC').all(this.scope) as Record<string, unknown>[]).map(r => this.d(r))
  }

  getEnabled(): DownloadClient[] {
    const real = this.getAll().filter(c => c.enabled)
    return real.length > 0 ? real : [BUILT_IN_CLIENT]
  }

  getById(id: number): DownloadClient | undefined {
    const row = this.db.prepare('SELECT * FROM download_clients WHERE id = ? AND library_id = ?').get(id, this.scope) as Record<string, unknown> | undefined
    return row ? this.d(row) : undefined
  }

  create(input: CreateInput): DownloadClient {
    const result = this.db.prepare(`
      INSERT INTO download_clients (library_id, name, type, host, port, use_ssl, url_base, username, password, category, enabled, priority, tags)
      VALUES (@scope, @name, @type, @host, @port, @useSsl, @urlBase, @username, @password, @category, @enabled, @priority, @tags)
    `).run({
      scope: this.scope,
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
      WHERE id=@id AND library_id=@scope
    `).run({
      id, scope: this.scope, name: m.name, type: m.type, host: m.host, port: m.port,
      useSsl: m.useSsl ? 1 : 0, urlBase: m.urlBase, username: m.username ?? null,
      password: m.password ?? null, category: m.category,
      enabled: m.enabled ? 1 : 0, priority: m.priority, tags: JSON.stringify(m.tags),
    })
    return this.getById(id)!
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM download_clients WHERE id = ? AND library_id = ?').run(id, this.scope)
  }
}
