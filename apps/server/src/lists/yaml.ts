import type { Database } from 'better-sqlite3'
import {
  FilterNodeSchema,
  ListCreateRequest,
  ListYamlDocument,
  type ListMediaType,
  type ListYamlEntry,
} from '@archivist/contracts'
import { parse, stringify } from 'yaml'
import { getDb } from '../db.js'
import { createList, type ListRow } from './service.js'

interface NamedTarget {
  id: number
  name: string
}

interface RootFolderTarget {
  id: number
  path: string
}

export interface ListYamlExport {
  filename: string
  yaml: string
  count: number
}

export interface ListYamlImportResult {
  imported: Array<Record<string, unknown>>
  skipped: Array<{ name: string; reason: string }>
}

function libraryMediaType(libraryId: number, db: Database): ListMediaType {
  const row = db.prepare('SELECT media_type FROM libraries WHERE id = ?').get(libraryId) as { media_type: string } | undefined
  if (row?.media_type === 'films') return 'film'
  if (row?.media_type === 'series') return 'series'
  throw new Error('Lists YAML is available only for Films and Series libraries')
}

function exportEntry(row: ListRow, folders: Map<number, string>, profiles: Map<number, string>): ListYamlEntry {
  return {
    name: row.name,
    description: row.description,
    mediaType: row.media_type,
    filter: FilterNodeSchema.parse(JSON.parse(row.filter)),
    mode: row.mode,
    enabled: row.enabled === 1,
    monitored: row.monitored === 1,
    rootFolder: row.root_folder_id == null ? null : folders.get(row.root_folder_id) ?? null,
    qualityProfile: row.quality_profile_id == null ? null : profiles.get(row.quality_profile_id) ?? null,
    maxAddsPerRun: row.max_adds_per_run,
    memberCap: row.member_cap,
    refreshIntervalHours: row.refresh_interval_hours,
    targetTier: row.target_tier,
    targetResolution: row.target_resolution,
    targetSource: row.target_source,
    targetCodec: row.target_codec,
  }
}

export function exportListsYaml(libraryId: number, db: Database = getDb()): ListYamlExport {
  const mediaType = libraryMediaType(libraryId, db)
  const rows = db.prepare('SELECT * FROM lists WHERE library_id = ? ORDER BY name COLLATE NOCASE').all(libraryId) as ListRow[]
  const folderRows = db.prepare('SELECT id, path FROM root_folders WHERE library_id IN (0, ?)').all(libraryId) as RootFolderTarget[]
  const profileRows = db.prepare('SELECT id, name FROM quality_profiles WHERE library_id IN (0, ?)').all(libraryId) as NamedTarget[]
  const folders = new Map(folderRows.map(row => [row.id, row.path]))
  const profiles = new Map(profileRows.map(row => [row.id, row.name]))
  const document = {
    format: 'archivist-lists' as const,
    version: 1 as const,
    lists: rows.map(row => exportEntry(row, folders, profiles)),
  }
  return {
    filename: `archivist-${mediaType}-lists.yaml`,
    yaml: stringify(document, { indent: 2, lineWidth: 0 }),
    count: rows.length,
  }
}

function formatValidationError(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  return error.issues.map(issue => `${issue.path.join('.') || 'document'}: ${issue.message}`).join('; ')
}

function findFolder(path: string | null | undefined, libraryId: number, db: Database): number | null {
  if (path == null) return null
  const row = db.prepare('SELECT id FROM root_folders WHERE path = ? AND library_id IN (0, ?) ORDER BY library_id DESC LIMIT 1').get(path, libraryId) as { id: number } | undefined
  if (!row) throw new Error(`Root folder “${path}” does not exist in the selected library`)
  return row.id
}

function findProfile(name: string | null | undefined, libraryId: number, db: Database): number | null {
  if (name == null) return null
  const row = db.prepare('SELECT id FROM quality_profiles WHERE name = ? COLLATE NOCASE AND library_id IN (0, ?) ORDER BY library_id DESC LIMIT 1').get(name, libraryId) as { id: number } | undefined
  if (!row) throw new Error(`Quality profile “${name}” does not exist in the selected library`)
  return row.id
}

export function importListsYaml(libraryId: number, yaml: string, db: Database = getDb()): ListYamlImportResult {
  let raw: unknown
  try {
    raw = parse(yaml, { maxAliasCount: 50 })
  } catch (error) {
    throw new Error(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }

  const parsed = ListYamlDocument.safeParse(raw)
  if (!parsed.success) throw new Error(`Invalid Lists YAML: ${formatValidationError(parsed.error)}`)

  const expectedMediaType = libraryMediaType(libraryId, db)
  const prepared = parsed.data.lists.map((entry, index) => {
    if (entry.mediaType !== expectedMediaType) {
      throw new Error(`List ${index + 1} “${entry.name}” is for ${entry.mediaType}, but the selected library is ${expectedMediaType}`)
    }
    try {
      const { rootFolder, qualityProfile, ...portableEntry } = entry
      return ListCreateRequest.parse({
        ...portableEntry,
        rootFolderId: findFolder(rootFolder, libraryId, db),
        qualityProfileId: findProfile(qualityProfile, libraryId, db),
      })
    } catch (error) {
      throw new Error(`List ${index + 1} “${entry.name}”: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  const imported: Array<Record<string, unknown>> = []
  const skipped: Array<{ name: string; reason: string }> = []
  db.transaction(() => {
    for (const entry of prepared) {
      const exists = db.prepare('SELECT id FROM lists WHERE library_id = ? AND name = ? COLLATE NOCASE').get(libraryId, entry.name)
      if (exists) {
        skipped.push({ name: entry.name, reason: 'A List with this name already exists' })
        continue
      }
      imported.push(createList(libraryId, entry, db))
    }
  })()
  return { imported, skipped }
}
