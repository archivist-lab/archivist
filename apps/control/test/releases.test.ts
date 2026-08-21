import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getRecoverySnapshot } from '../src/server/releases.js'

const artifacts = [
  'apps/server/dist/supervisor.js',
  'apps/control/dist/server/index.js',
  'apps/control/dist/public/index.html',
  'client/dist/index.html',
]

async function completeRelease(root: string, id: string): Promise<string> {
  const release = path.join(root, 'releases', id)
  for (const artifact of artifacts) {
    const target = path.join(release, artifact)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'fixture')
  }
  return release
}

test('recovery inventory verifies current and previous immutable releases', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archivist-releases-'))
  const current = await completeRelease(root, '20260814T010203Z-abc123')
  const previous = await completeRelease(root, '20260813T010203Z-def456')
  await symlink(current, path.join(root, 'current'))
  await symlink(previous, path.join(root, 'previous'))
  const result = await getRecoverySnapshot(root)
  assert.equal(result.current, path.basename(current))
  assert.equal(result.previous, path.basename(previous))
  assert.equal(result.rollbackReady, true)
  assert.deepEqual(result.releases.map(release => release.role).sort(), ['current', 'previous'])
  assert.ok(result.releases.every(release => release.complete))
})

test('external rollback links and incomplete releases are never marked ready', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archivist-releases-'))
  await completeRelease(root, '20260814T010203Z-current')
  const incomplete = path.join(root, 'releases', '20260813T010203Z-incomplete')
  await mkdir(incomplete, { recursive: true })
  await symlink(incomplete, path.join(root, 'current'))
  await symlink(os.tmpdir(), path.join(root, 'previous'))
  const result = await getRecoverySnapshot(root)
  assert.equal(result.previous, null)
  assert.equal(result.rollbackReady, false)
  assert.equal(result.releases.find(release => release.id.endsWith('incomplete'))?.complete, false)
})
