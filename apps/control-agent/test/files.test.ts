import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { listFiles, resolveFile, safeRelativePath, type FileRoot } from '../src/files.js'

test('safe paths reject absolute and parent traversal', () => {
  assert.equal(safeRelativePath('films/./Arrival'), 'films/Arrival')
  for (const unsafe of ['/etc/passwd', '../secret', 'films/../../secret']) assert.throws(() => safeRelativePath(unsafe))
})

test('file roots list entries but contain symlink traversal', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'archivist-agent-root-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'archivist-agent-outside-'))
  await mkdir(path.join(rootPath, 'films'))
  await writeFile(path.join(rootPath, 'readme.txt'), 'fixture')
  await symlink(outside, path.join(rootPath, 'escape'))
  const roots: FileRoot[] = [{ id: 'media', label: 'Media', path: rootPath }]
  const listing = await listFiles('media', '', roots)
  assert.deepEqual(listing.entries.map(entry => entry.name), ['films', 'escape', 'readme.txt'])
  await assert.rejects(resolveFile('media', 'escape', roots), /leaves its approved root/)
})
