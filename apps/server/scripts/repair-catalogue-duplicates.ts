/**
 * Repair: collapse duplicated catalogue titles and credits.
 *
 * catalog_item_titles and catalog_credits had UNIQUE keys over nullable
 * columns, which SQLite never treats as equal, so every IMDb snapshot and TMDB
 * refresh re-inserted every aka without a language/region and every person
 * credit. A long-running catalogue ends up with >90% duplicate rows in both
 * tables. Startup repairs small catalogues itself; this is for the large ones.
 *
 * Usage (with the catalogue API and worker stopped):
 *   npx tsx scripts/repair-catalogue-duplicates.ts [--db path] [--apply] [--vacuum-into path]
 *
 * Without --apply it only reports what would be repaired. --apply needs free
 * space for the surviving rows plus WAL on the database's disk. Deleted rows
 * only become free pages, so pass --vacuum-into to write a compacted copy
 * (ideally on another disk) and swap it in once it checks out.
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureCatalogueIdentityIndexes } from '@archivist/catalogue'

const args = process.argv.slice(2)
const option = (name: string) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1] }
const apply = args.includes('--apply')
const dbPath = resolve(option('--db') ?? process.env.ARCHIVIST_CATALOGUE_DB ?? './data/catalogue/catalogue.sqlite')
const vacuumInto = option('--vacuum-into')

if (!existsSync(dbPath)) throw new Error(`No catalogue at ${dbPath}`)
if (vacuumInto && existsSync(vacuumInto)) throw new Error(`${vacuumInto} already exists`)

const db = new Database(dbPath, { readonly: !apply })
db.pragma('busy_timeout = 5000')
const indexes = ['uq_catalog_item_titles_identity', 'uq_catalog_credits_identity']
const missing = indexes.filter(name => !db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(name))
const pages = db.pragma('page_count', { simple: true }) as number
const pageSize = db.pragma('page_size', { simple: true }) as number
const freePages = db.pragma('freelist_count', { simple: true }) as number
const gib = (value: number) => `${(value / 1024 ** 3).toFixed(1)} GiB`
console.log(`${dbPath}: ${gib(pages * pageSize)}, ${gib(freePages * pageSize)} free pages`)
for (const [table, id] of [['catalog_item_titles', 'title_id'], ['catalog_credits', 'credit_id']]) {
  console.log(`  ${table}: highest ${id} ${(db.prepare(`SELECT MAX(${id}) highest FROM ${table}`).get() as { highest: number | null }).highest ?? 0}`)
}
console.log(missing.length ? `  missing: ${missing.join(', ')}` : '  identity indexes already present')

if (!apply) {
  console.log('Dry run; pass --apply to repair.')
} else {
  // Large sort/index builds: keep temp b-trees on disk and give the page cache ~2 GiB.
  db.pragma('temp_store = FILE')
  db.pragma('cache_size = -2000000')
  const started = Date.now()
  ensureCatalogueIdentityIndexes(db, { log: message => console.log(`  ${message} (${Math.round((Date.now() - started) / 1000)}s)`) })
  db.pragma('wal_checkpoint(TRUNCATE)')
  if (vacuumInto) {
    console.log(`Writing compacted copy to ${vacuumInto}…`)
    db.prepare('VACUUM INTO ?').run(resolve(vacuumInto))
    console.log(`Done in ${Math.round((Date.now() - started) / 1000)}s. Check it, then replace ${dbPath} with it.`)
  } else {
    console.log(`Done. ${gib((db.pragma('freelist_count', { simple: true }) as number) * pageSize)} is now free pages inside the file; VACUUM or --vacuum-into to return it to the disk.`)
  }
}
db.close()
