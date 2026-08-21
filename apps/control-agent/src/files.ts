import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface FileRoot { id: string; label: string; path: string }
export interface FileEntry {
  name: string
  path: string
  type: 'directory' | 'file' | 'symlink' | 'other'
  size: number
  modifiedAt: string
  mode: string
  writable: boolean
}
export interface TrashEntry { id: string; name: string; originalPath: string; deletedAt: string; type: 'directory' | 'file' | 'other'; size: number }

export const configuredRoots = (): FileRoot[] => [
  { id: 'filesystem', label: 'Filesystem', path: process.env.ARCHIVIST_FILESYSTEM_ROOT || '/' },
  { id: 'cardigann', label: 'Cardigann', path: process.env.ARCHIVIST_DEFINITIONS_PATH || '/var/lib/archivist/data/indexer-definitions' },
]

const blockedPaths = ['/etc/archivist', '/proc', '/sys', '/dev', '/run']
const writablePaths = (process.env.ARCHIVIST_FILE_WRITE_PATHS || '/home,/mnt,/media,/srv,/tmp,/var/tmp')
  .split(',').map(value => path.resolve(value.trim())).filter(Boolean)
const trashRoot = process.env.ARCHIVIST_FILE_TRASH_DIR || '/var/lib/archivist-control-agent/trash'

function within(parent: string, candidate: string): boolean {
  const relation = path.relative(parent, candidate)
  return relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation))
}

function assertVisible(candidate: string): void {
  if (blockedPaths.some(blocked => within(blocked, candidate))) throw new Error('This protected system path is not available')
}

export function isWritablePath(candidate: string): boolean {
  return writablePaths.some(root => within(root, candidate))
}

export function safeRelativePath(value: string): string {
  if (value.includes('\0') || path.isAbsolute(value)) throw new Error('Path must be relative')
  const parts = value.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) throw new Error('Parent traversal is not allowed')
  return parts.join('/')
}

export async function resolveFile(rootId: string, relativePath: string, roots = configuredRoots()): Promise<{ root: FileRoot; relativePath: string; absolutePath: string }> {
  const root = roots.find(candidate => candidate.id === rootId)
  if (!root) throw new Error('Unknown file root')
  const safePath = safeRelativePath(relativePath)
  const canonicalRoot = await realpath(root.path)
  const target = await realpath(path.join(canonicalRoot, safePath))
  if (!within(canonicalRoot, target)) throw new Error('Path leaves its approved root')
  assertVisible(target)
  return { root: { ...root, path: canonicalRoot }, relativePath: safePath, absolutePath: target }
}

export async function resolveNewFile(rootId: string, relativePath: string, roots = configuredRoots()): Promise<{ root: FileRoot; relativePath: string; absolutePath: string }> {
  const safePath = safeRelativePath(relativePath)
  if (!safePath) throw new Error('The filesystem root cannot be changed')
  const parentPath = safePath.split('/').slice(0, -1).join('/')
  const parent = await resolveFile(rootId, parentPath, roots)
  const absolutePath = path.join(parent.absolutePath, path.basename(safePath))
  assertVisible(absolutePath)
  if (!isWritablePath(absolutePath)) throw new Error('This system path is read-only')
  return { root: parent.root, relativePath: safePath, absolutePath }
}

export async function listFiles(rootId: string, relativePath: string, roots = configuredRoots()): Promise<{ root: Omit<FileRoot, 'path'>; path: string; parent: string | null; writable: boolean; entries: FileEntry[] }> {
  const resolved = await resolveFile(rootId, relativePath, roots)
  if (!(await stat(resolved.absolutePath)).isDirectory()) throw new Error('Path is not a directory')
  const values = await readdir(resolved.absolutePath, { withFileTypes: true })
  const entries = (await Promise.all(values.map(async entry => {
    const entryPath = path.join(resolved.absolutePath, entry.name)
    try {
      const info = await lstat(entryPath)
      const type: FileEntry['type'] = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'
      return { name: entry.name, path: [resolved.relativePath, entry.name].filter(Boolean).join('/'), type, size: info.size, modifiedAt: info.mtime.toISOString(), mode: (info.mode & 0o777).toString(8).padStart(3, '0'), writable: isWritablePath(entryPath) }
    } catch { return null }
  }))).filter((entry): entry is FileEntry => entry !== null)
  entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name))
  const parent = resolved.relativePath ? resolved.relativePath.split('/').slice(0, -1).join('/') : null
  return { root: { id: resolved.root.id, label: resolved.root.label }, path: resolved.relativePath, parent, writable: isWritablePath(resolved.absolutePath), entries }
}

export async function createDirectory(rootId: string, relativePath: string): Promise<void> {
  const target = await resolveNewFile(rootId, relativePath)
  await mkdir(target.absolutePath, { mode: 0o750 })
}

export async function moveFile(rootId: string, sourcePath: string, destinationPath: string): Promise<void> {
  const source = await resolveFile(rootId, sourcePath)
  const destination = await resolveNewFile(rootId, destinationPath)
  if (!isWritablePath(source.absolutePath)) throw new Error('This system path is read-only')
  try { await lstat(destination.absolutePath); throw new Error('Destination already exists') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await rename(source.absolutePath, destination.absolutePath)
}

export async function trashFile(rootId: string, relativePath: string): Promise<string> {
  const source = await resolveFile(rootId, relativePath)
  if (!isWritablePath(source.absolutePath)) throw new Error('This system path is read-only')
  await mkdir(trashRoot, { recursive: true, mode: 0o700 })
  const id = `${Date.now()}-${randomUUID()}`
  const stored = path.join(trashRoot, id)
  try { await rename(source.absolutePath, stored) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await cp(source.absolutePath, stored, { recursive: true, errorOnExist: true })
    await rm(source.absolutePath, { recursive: true })
  }
  await writeFile(`${stored}.json`, JSON.stringify({ id, originalPath: source.absolutePath, deletedAt: new Date().toISOString() }), { mode: 0o600 })
  return id
}

export async function listTrash(): Promise<TrashEntry[]> {
  await mkdir(trashRoot, { recursive: true, mode: 0o700 })
  const names = await readdir(trashRoot)
  const entries = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
    try {
      const manifest = JSON.parse(await readFile(path.join(trashRoot, name), 'utf8')) as { id: string; originalPath: string; deletedAt: string }
      if (!/^[\w-]+$/.test(manifest.id)) return null
      const info = await lstat(path.join(trashRoot, manifest.id))
      return { id: manifest.id, name: path.basename(manifest.originalPath), originalPath: manifest.originalPath, deletedAt: manifest.deletedAt, type: info.isDirectory() ? 'directory' as const : info.isFile() ? 'file' as const : 'other' as const, size: info.size }
    } catch { return null }
  }))
  return entries.filter((entry): entry is TrashEntry => entry !== null).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

export async function restoreTrash(id: string): Promise<string> {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid trash item')
  const stored = path.join(trashRoot, id)
  const manifestPath = `${stored}.json`
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { originalPath: string }
  const destination = path.resolve(manifest.originalPath)
  if (!isWritablePath(destination)) throw new Error('Original path is no longer writable')
  try { await lstat(destination); throw new Error('Original path already exists') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 })
  try { await rename(stored, destination) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await cp(stored, destination, { recursive: true, errorOnExist: true })
    await rm(stored, { recursive: true })
  }
  await unlink(manifestPath)
  return destination
}
