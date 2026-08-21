import { access, lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'

export interface ReleaseSnapshot {
  id: string
  path: string
  role: 'current' | 'previous' | 'retained'
  createdAt: string | null
  revision: string | null
  complete: boolean
  missingArtifacts: string[]
}

export interface RecoverySnapshot {
  releaseRoot: string
  current: string | null
  previous: string | null
  rollbackReady: boolean
  releases: ReleaseSnapshot[]
  warning: string
}

const REQUIRED_ARTIFACTS = [
  'apps/server/dist/supervisor.js',
  'apps/control/dist/server/index.js',
  'apps/control/dist/public/index.html',
  'client/dist/index.html',
] as const

function releaseMetadata(id: string): { createdAt: string | null; revision: string | null } {
  const match = id.match(/^(\d{8}T\d{6}Z)-(.+)$/)
  if (!match) return { createdAt: null, revision: null }
  const stamp = match[1]
  const createdAt = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`
  return { createdAt, revision: match[2] === 'source' ? null : match[2] }
}

async function linkedReleaseId(root: string, name: 'current' | 'previous'): Promise<string | null> {
  const linkPath = path.join(root, name)
  try {
    if (!(await lstat(linkPath)).isSymbolicLink()) return null
    const target = await realpath(linkPath)
    const releasesRoot = await realpath(path.join(root, 'releases'))
    if (path.dirname(target) !== releasesRoot) return null
    return path.basename(target)
  } catch {
    return null
  }
}

export async function getRecoverySnapshot(root = process.env.ARCHIVIST_RELEASE_ROOT || '/opt/archivist'): Promise<RecoverySnapshot> {
  const releasesRoot = path.join(root, 'releases')
  const [current, previous] = await Promise.all([linkedReleaseId(root, 'current'), linkedReleaseId(root, 'previous')])
  let ids: string[] = []
  try {
    ids = (await readdir(releasesRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    // A missing release directory is represented as an empty, non-ready inventory.
  }
  const releases = await Promise.all(ids.sort().reverse().map(async id => {
    const releasePath = path.join(releasesRoot, id)
    const missingArtifacts: string[] = []
    await Promise.all(REQUIRED_ARTIFACTS.map(async artifact => {
      try { await access(path.join(releasePath, artifact)) } catch { missingArtifacts.push(artifact) }
    }))
    const metadata = releaseMetadata(id)
    return {
      id,
      path: releasePath,
      role: id === current ? 'current' as const : id === previous ? 'previous' as const : 'retained' as const,
      ...metadata,
      complete: missingArtifacts.length === 0,
      missingArtifacts: missingArtifacts.sort(),
    }
  }))
  const previousRelease = releases.find(release => release.id === previous)
  return {
    releaseRoot: root,
    current,
    previous,
    rollbackReady: Boolean(previousRelease?.complete),
    releases,
    warning: 'Binary rollback does not reverse database migrations. Take and verify a database backup before changing releases.',
  }
}
