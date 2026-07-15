import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'

export const SIGNATURE_ALGORITHM = 'sampled-sha256-v1'
const SAMPLE_BYTES = 4 * 1024 * 1024

/**
 * Stable, bounded file identity. At most 12 MiB is read: the first, middle and
 * last 4 MiB, plus the file size. Overlapping windows are de-duplicated.
 */
export async function contentSignature(filePath: string): Promise<{ signature: string; fileSize: number }> {
  const metadata = await stat(filePath)
  if (!metadata.isFile()) throw new Error('Media path is not a file')
  const fileSize = metadata.size
  const sampleLength = Math.min(SAMPLE_BYTES, fileSize)
  const offsets = [...new Set([
    0,
    Math.max(0, Math.floor((fileSize - sampleLength) / 2)),
    Math.max(0, fileSize - sampleLength),
  ])].sort((a, b) => a - b)

  const digest = createHash('sha256')
  const size = Buffer.alloc(8)
  size.writeBigUInt64BE(BigInt(fileSize))
  digest.update(SIGNATURE_ALGORITHM).update(size)

  const handle = await open(filePath, 'r')
  try {
    for (const offset of offsets) {
      const buffer = Buffer.alloc(sampleLength)
      const { bytesRead } = await handle.read(buffer, 0, sampleLength, offset)
      const position = Buffer.alloc(8)
      position.writeBigUInt64BE(BigInt(offset))
      digest.update(position).update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }

  return { signature: `${SIGNATURE_ALGORITHM}:${digest.digest('hex')}`, fileSize }
}
