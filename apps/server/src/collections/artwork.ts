import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'

export const COLLECTION_ARTWORK_TYPES = ['poster', 'backdrop', 'logo'] as const
export type CollectionArtworkType = typeof COLLECTION_ARTWORK_TYPES[number]

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

function hasSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (mimeType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (mimeType === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
  if (mimeType === 'image/avif') {
    if (buffer.length < 16 || buffer.toString('ascii', 4, 8) !== 'ftyp') return false
    return ['avif', 'avis'].includes(buffer.toString('ascii', 8, 12)) || buffer.toString('ascii', 8, 32).includes('avif')
  }
  return false
}

function collectionDirectory(mediaRoot: string, collectionId: number): string {
  return resolve(mediaRoot, 'collections', String(collectionId))
}

function managedFilePath(mediaRoot: string, collectionId: number, url: string | null | undefined): string | null {
  if (!url) return null
  const pathname = url.split(/[?#]/, 1)[0]
  const prefix = `/media/collections/${collectionId}/`
  if (!pathname.startsWith(prefix)) return null
  const name = basename(pathname)
  if (!name || name !== pathname.slice(prefix.length)) return null
  const directory = collectionDirectory(mediaRoot, collectionId)
  const target = resolve(directory, name)
  return target.startsWith(`${directory}${sep}`) ? target : null
}

export async function saveCollectionArtwork(
  mediaRoot: string,
  collectionId: number,
  artworkType: CollectionArtworkType,
  mimeType: string,
  buffer: Buffer,
): Promise<string> {
  const extension = MIME_EXTENSIONS[mimeType.toLowerCase()]
  if (!extension) throw new Error('Unsupported image type. Use JPEG, PNG, WebP or AVIF')
  if (!buffer.length) throw new Error('The uploaded image is empty')
  if (!hasSignature(buffer, mimeType.toLowerCase())) throw new Error('The uploaded file does not match its declared image type')

  const directory = collectionDirectory(mediaRoot, collectionId)
  await mkdir(directory, { recursive: true })
  const token = `${Date.now()}-${randomUUID()}`
  const filename = `${artworkType}-${token}.${extension}`
  const temporaryPath = join(directory, `.${filename}.upload`)
  const targetPath = join(directory, filename)
  try {
    await writeFile(temporaryPath, buffer, { flag: 'wx' })
    await rename(temporaryPath, targetPath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  return `/media/collections/${collectionId}/${filename}`
}

export async function removeManagedCollectionArtwork(mediaRoot: string, collectionId: number, url: string | null | undefined): Promise<void> {
  const target = managedFilePath(mediaRoot, collectionId, url)
  if (target) await unlink(target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
}

export async function removeCollectionArtworkDirectory(mediaRoot: string, collectionId: number): Promise<void> {
  await rm(collectionDirectory(mediaRoot, collectionId), { recursive: true, force: true })
}
