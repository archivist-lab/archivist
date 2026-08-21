import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const excludedDirectories = new Set([
  '.git', '.migration-backups', 'node_modules', 'dist', 'data', 'media', 'downloads',
  'hermes_agent_profiles',
])
const allowedStatuses = new Set([
  'canonical',
  'draft',
  'accepted',
  'active',
  'reference',
  'review-required',
  'superseded',
  'historical',
  'archived',
])
const markdownFiles = []

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(target)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) markdownFiles.push(target)
  }
}

function field(block, name) {
  return block.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim() || ''
}

walk(root)
const failures = []
for (const file of markdownFiles.sort()) {
  const relative = path.relative(root, file)
  const source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1]
  if (!frontmatter) {
    failures.push(`${relative}: missing YAML frontmatter`)
    continue
  }
  const title = field(frontmatter, 'title')
  const documentType = field(frontmatter, 'document_type')
  const status = field(frontmatter, 'status')
  const dated = field(frontmatter, 'updated') || field(frontmatter, 'classified')
  if (!title) failures.push(`${relative}: missing title`)
  if (!documentType) failures.push(`${relative}: missing document_type`)
  if (!status) failures.push(`${relative}: missing status`)
  else if (!allowedStatuses.has(status)) failures.push(`${relative}: unsupported status ${status}`)
  if (!dated) failures.push(`${relative}: missing updated or classified date`)
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(dated)) failures.push(`${relative}: invalid documentation date ${dated}`)

  for (const match of source.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+['"][^'"]*['"])?\)/g)) {
    let destination = match[1].replace(/^<|>$/g, '')
    if (/^(?:https?:|mailto:|data:|app:)/i.test(destination) || destination.startsWith('#') || destination.startsWith('/') || /[\\{}]/.test(destination)) continue
    destination = destination.split('#')[0]
    if (!destination) continue
    try { destination = decodeURIComponent(destination) } catch { /* validate the literal path */ }
    const target = path.resolve(path.dirname(file), destination)
    if (!existsSync(target)) failures.push(`${relative}: broken local link ${match[1]}`)
  }
}

if (failures.length) {
  console.error(`Markdown metadata validation failed:\n${failures.map(value => `- ${value}`).join('\n')}`)
  process.exit(1)
}

console.log(`Markdown metadata valid for ${markdownFiles.length} files.`)
