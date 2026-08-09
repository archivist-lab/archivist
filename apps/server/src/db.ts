import { openUnifiedDb, type UnifiedDb } from '@archivist/db'

/**
 * Module-level handle to the unified database. Mirrors the legacy
 * `getSharedDb()` convention so ported services keep their call shape, but
 * there is exactly one database in Archivist.
 */

let _db: UnifiedDb | null = null

export function initDb(path: string): UnifiedDb {
  _db = openUnifiedDb(path)
  // Keep the server safe when it is run directly against an older built copy
  // of @archivist/db during rolling upgrades. The package migration owns these
  // changes; these idempotent guards close the gap before any worker can claim.
  const jobColumns = _db.prepare("PRAGMA table_info('system_jobs')").all() as Array<{ name: string }>
  if (!jobColumns.some(column => column.name === 'priority')) {
    _db.exec('ALTER TABLE system_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 50')
  }
  if (!jobColumns.some(column => column.name === 'lease_owner')) {
    _db.exec('ALTER TABLE system_jobs ADD COLUMN lease_owner TEXT')
  }
  _db.exec(`
    DROP INDEX IF EXISTS idx_system_jobs_claim;
    CREATE INDEX idx_system_jobs_claim
      ON system_jobs(status, type, priority DESC, available_at, id);
    CREATE INDEX IF NOT EXISTS idx_system_jobs_lane_order
      ON system_jobs(status, priority DESC, available_at, id, type);
    CREATE INDEX IF NOT EXISTS idx_system_jobs_lease
      ON system_jobs(status, lease_owner, locked_at);
    CREATE TABLE IF NOT EXISTS runtime_processes (
      instance_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('api','worker')),
      hostname TEXT NOT NULL,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      stopping_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_processes_role_heartbeat
      ON runtime_processes(role, heartbeat_at DESC);
    CREATE TABLE IF NOT EXISTS runtime_leases (
      lease_name TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS torrent_runtime_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      snapshot TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS torrent_runtime_commands (
      command_id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_torrent_runtime_commands_claim
      ON torrent_runtime_commands(status, command_id);
  `)
  try {
    _db.exec(`
      CREATE INDEX IF NOT EXISTS idx_series_metadata_due
        ON series(monitored, next_metadata_refresh_at, id);
      CREATE INDEX IF NOT EXISTS idx_episodes_series_air_at
        ON episodes(series_id, air_at);
      DROP INDEX IF EXISTS idx_films_library_sort_cursor;
      CREATE INDEX idx_films_library_sort_cursor
        ON films(library_id, COALESCE(sort_title, '') COLLATE NOCASE, id);
      DROP INDEX IF EXISTS idx_series_library_sort_cursor;
      CREATE INDEX idx_series_library_sort_cursor
        ON series(library_id, COALESCE(sort_title, '') COLLATE NOCASE, id);
      CREATE TABLE IF NOT EXISTS video_optimisation_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('queued','encoding','validating','replacing','complete','failed','cancelled')),
        priority INTEGER NOT NULL DEFAULT 0,
        job_json TEXT NOT NULL,
        control_requested TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_video_optimisation_jobs_claim
        ON video_optimisation_jobs(status, priority DESC, updated_at, id);
    `)
  } catch {
    // The versioned package migrations add legacy metadata columns first.
  }
  const videoColumns = _db.prepare("PRAGMA table_info('video_optimisation_jobs')").all() as Array<{ name: string }>
  if (videoColumns.length > 0 && !videoColumns.some(column => column.name === 'control_requested')) {
    _db.exec('ALTER TABLE video_optimisation_jobs ADD COLUMN control_requested TEXT')
  }
  return _db
}

export function getDb(): UnifiedDb {
  if (!_db) throw new Error('Archivist database not initialised — call initDb() first')
  return _db
}

export function isDbInitialised(): boolean {
  return _db !== null
}

export function resetDbForTests(): void {
  _db = null
}
