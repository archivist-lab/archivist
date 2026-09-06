import { realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { getDb } from '../db.js'
import { loadConfig } from '../config.js'

/** Resolve symlinks before checking the configured media and library roots. */
export async function managedMediaFile(input: string): Promise<string> {
  if (!input || input.includes('\0')) throw new Error('Invalid media path')
  const config = loadConfig()
  const roots = [config.media.base_dir, ...(getDb().prepare('SELECT path FROM root_folders').all() as Array<{ path: string }>).map(row => row.path)]
  const path = await realpath(resolve(config.media.base_dir, input))
  if (!(await stat(path)).isFile()) throw new Error('Media path must be a regular file')
  for (const root of roots) {
    try { const canonical = await realpath(resolve(root)); if (path.startsWith(canonical + sep)) return path } catch { /* unavailable root */ }
  }
  throw new Error('Media path is outside the permitted roots')
}
