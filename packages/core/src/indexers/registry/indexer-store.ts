import type Database from 'better-sqlite3'

export interface IndexerInstance {
  id: number
  definitionId: string
  name: string
  enabled: boolean
  baseUrl: string
  apiKey?: string
  username?: string
  password?: string
  categories: string[]
  priority: number
  tags: string[]
  useFlareSolverr: boolean
  createdAt: Date
  updatedAt: Date
}

type CreateInput = Omit<IndexerInstance, 'id' | 'createdAt' | 'updatedAt'>
type UpdateInput = Partial<CreateInput>

export class IndexerStore {
  constructor(private db: Database.Database) {
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexers (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        definition_id TEXT NOT NULL,
        name         TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        base_url     TEXT NOT NULL DEFAULT '',
        api_key      TEXT,
        username     TEXT,
        password     TEXT,
        categories   TEXT NOT NULL DEFAULT '[]',
        priority     INTEGER NOT NULL DEFAULT 25,
        tags         TEXT NOT NULL DEFAULT '[]',
        use_flaresolverr INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    // Ensure use_flaresolverr column exists for older databases
    try {
      this.db.exec('ALTER TABLE indexers ADD COLUMN use_flaresolverr INTEGER NOT NULL DEFAULT 0')
    } catch (err) {
      // Column likely already exists
    }
  }

  private deserialise(row: Record<string, unknown>): IndexerInstance {
    return {
      id: row.id as number,
      definitionId: row.definition_id as string,
      name: row.name as string,
      enabled: Boolean(row.enabled),
      baseUrl: row.base_url as string,
      apiKey: row.api_key as string | undefined,
      username: row.username as string | undefined,
      password: row.password as string | undefined,
      categories: JSON.parse(row.categories as string ?? '[]'),
      priority: row.priority as number,
      tags: JSON.parse(row.tags as string ?? '[]'),
      useFlareSolverr: Boolean(row.use_flaresolverr),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    }
  }

  getAll(): IndexerInstance[] {
    return (this.db.prepare('SELECT * FROM indexers ORDER BY priority ASC, name ASC').all() as Record<string, unknown>[]).map(r => this.deserialise(r))
  }

  getEnabled(): IndexerInstance[] {
    return this.getAll().filter(i => i.enabled)
  }

  getById(id: number): IndexerInstance | undefined {
    const row = this.db.prepare('SELECT * FROM indexers WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.deserialise(row) : undefined
  }

  create(input: CreateInput): IndexerInstance {
    const result = this.db.prepare(`
      INSERT INTO indexers (definition_id, name, enabled, base_url, api_key, username, password, categories, priority, tags, use_flaresolverr)
      VALUES (@definitionId, @name, @enabled, @baseUrl, @apiKey, @username, @password, @categories, @priority, @tags, @useFlareSolverr)
    `).run({
      definitionId: input.definitionId,
      name: input.name,
      enabled: input.enabled ? 1 : 0,
      baseUrl: input.baseUrl ?? '',
      apiKey: input.apiKey ?? null,
      username: input.username ?? null,
      password: input.password ?? null,
      categories: JSON.stringify(input.categories ?? []),
      priority: input.priority ?? 25,
      tags: JSON.stringify(input.tags ?? []),
      useFlareSolverr: input.useFlareSolverr ? 1 : 0,
    })
    return this.getById(result.lastInsertRowid as number)!
  }

  update(id: number, input: UpdateInput): IndexerInstance {
    const existing = this.getById(id)
    if (!existing) throw new Error(`Indexer ${id} not found`)
    const merged = { ...existing, ...input }
    this.db.prepare(`
      UPDATE indexers SET
        name = @name, enabled = @enabled, base_url = @baseUrl,
        api_key = @apiKey, username = @username, password = @password,
        categories = @categories, priority = @priority, tags = @tags,
        use_flaresolverr = @useFlareSolverr,
        updated_at = datetime('now')
      WHERE id = @id
    `).run({
      id,
      name: merged.name,
      enabled: merged.enabled ? 1 : 0,
      baseUrl: merged.baseUrl,
      apiKey: merged.apiKey ?? null,
      username: merged.username ?? null,
      password: merged.password ?? null,
      categories: JSON.stringify(merged.categories),
      priority: merged.priority,
      tags: JSON.stringify(merged.tags),
      useFlareSolverr: merged.useFlareSolverr ? 1 : 0,
    })
    return this.getById(id)!
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM indexers WHERE id = ?').run(id)
  }
}
