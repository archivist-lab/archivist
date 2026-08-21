import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { Storage } from '@torrentstack/torrent-engine'

// A torrent whose middle file was deselected: it is never written to disk, so
// finalise() has nothing to move for it. The files after it must still reach
// the download directory.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'archivist-finalise-'))
  const downloadDir = join(root, 'complete')
  const incompleteDir = join(root, 'incomplete')
  mkdirSync(downloadDir, { recursive: true })
  mkdirSync(incompleteDir, { recursive: true })

  const name = 'Some Artist - Discography [FLAC]'
  const files = [
    { path: '01 - first.flac', sizeBytes: 8 },
    { path: 'deselected/02 - skipped.flac', sizeBytes: 8 },
    { path: '03 - last.flac', sizeBytes: 8 },
  ]
  const meta = {
    infoHash: 'a'.repeat(40),
    name,
    pieceLength: 8,
    pieces: [],
    totalSize: 24,
    files,
    announce: [],
    private: false,
  } as any

  // Only the wanted files exist on disk, each still carrying its .part suffix.
  for (const path of ['01 - first.flac', '03 - last.flac']) {
    const target = join(incompleteDir, name, path + '.part')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'abcdefgh')
  }

  const storage = new Storage(meta, {
    downloadDir,
    incompleteDir,
    renamePartial: true,
    preallocation: 'none',
    cacheSize: 0,
  })
  return { root, name, downloadDir, incompleteDir, storage }
}

test('finalise moves every present file past a deselected one', async () => {
  const { root, name, downloadDir, storage } = fixture()
  try {
    const result = await storage.finalise()
    assert.equal(result.moved, 2)
    assert.equal(result.absent, 1)
    assert.deepEqual(result.failed, [])
    assert.ok(existsSync(join(downloadDir, name, '01 - first.flac')), 'first file moved')
    assert.ok(existsSync(join(downloadDir, name, '03 - last.flac')), 'file after the deselected one moved')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('finalise strips the .part suffix and clears the incomplete folder', async () => {
  const { root, name, downloadDir, incompleteDir, storage } = fixture()
  try {
    await storage.finalise()
    assert.ok(!existsSync(join(downloadDir, name, '01 - first.flac.part')), '.part suffix removed')
    assert.ok(!existsSync(join(incompleteDir, name)), 'incomplete folder swept')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('finalise is safe to re-run after an interrupted move', async () => {
  const { root, name, downloadDir, incompleteDir, storage } = fixture()
  try {
    // Simulate the stranded state the old finalise left behind: one file made
    // it across, the rest are still sitting in incomplete/ as .part.
    const first = join(downloadDir, name, '01 - first.flac')
    mkdirSync(dirname(first), { recursive: true })
    writeFileSync(first, 'abcdefgh')
    rmSync(join(incompleteDir, name, '01 - first.flac.part'))

    const result = await storage.finalise()
    assert.equal(result.moved, 1, 'only the stranded file needed moving')
    assert.equal(result.absent, 2)
    assert.ok(existsSync(join(downloadDir, name, '03 - last.flac')), 'stranded file recovered')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
