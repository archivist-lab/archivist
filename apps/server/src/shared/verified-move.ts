import { constants } from 'node:fs'
import { copyFile, mkdir, open, link, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Exclusive destination; original is retained until the copied file is flushed. */
export async function verifiedMove(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  try { await stat(to); throw new Error('Move destination already exists') }
  catch (error: any) { if (error.code !== 'ENOENT') throw error }
  try { await link(from, to); await unlink(from); return } catch (error: any) { if (!['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP'].includes(error.code)) throw error }
  const temporary = `${to}.copy-${randomUUID()}`
  try {
    const before = await stat(from)
    await copyFile(from, temporary, constants.COPYFILE_EXCL)
    const copied = await stat(temporary)
    const after = await stat(from)
    if (copied.size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Source changed during media copy')
    const handle = await open(temporary, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    try { await link(temporary, to) } catch (error: any) {
      if (!['EPERM', 'EOPNOTSUPP', 'ENOTSUP'].includes(error.code)) throw error
      await copyFile(temporary, to, constants.COPYFILE_EXCL)
    }
    const destination = await open(to, 'r+')
    try { await destination.sync() } finally { await destination.close() }
    await unlink(temporary)
    await unlink(from)
  } catch (error) { await unlink(temporary).catch(() => {}); throw error }
}
