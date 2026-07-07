import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'
import { z } from 'zod'

// ─────────────────────────────────────────────────────────────────────────────
// Permissive Zod schema — accepts all v11 Cardigann variations
// ─────────────────────────────────────────────────────────────────────────────

const AnyValue = z.union([z.string(), z.number(), z.boolean(), z.null()])

const FilterSchema = z.object({
  name: z.string(),
  args: z.any().optional(),
}).passthrough()

const FieldSchema = z.object({
  selector: z.string().optional(),
  attribute: z.string().optional(),
  filters: z.array(FilterSchema).optional(),
  text: z.union([z.string(), z.number()]).optional(),
  optional: z.boolean().optional(),
}).passthrough()

const RowsSchema = z.object({
  selector: z.string(),
}).passthrough()

const SearchPathSchema = z.object({
  path: z.string().optional(),
  method: z.string().optional(),
  inputs: z.record(AnyValue).optional(),
  categories: z.array(z.union([z.string(), z.number()])).optional(),
}).passthrough()

const SearchSchema = z.object({
  paths: z.array(SearchPathSchema).optional(),
  rows: RowsSchema.optional(),
  fields: z.record(FieldSchema).optional(),
  headers: z.record(z.union([z.string(), z.array(z.string())])).optional(),
}).passthrough()

const LoginSchema = z.object({
  path: z.string().optional(),
  method: z.string().optional(),
  inputs: z.record(AnyValue).optional(),
  error: z.array(z.object({
    selector: z.string(),
    message: z.any().optional(),
  })).optional(),
  test: z.object({ path: z.string() }).optional(),
}).passthrough()

const CapsSchema = z.object({
  categorymappings: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    cat: z.string(),
    desc: z.string().optional(),
  })).default([]),
  modes: z.record(z.any()).default({}),
}).passthrough()

const DefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  language: z.string().default('en-us'),
  type: z.string().default('public'),
  encoding: z.string().optional(),
  urls: z.array(z.string()).optional(),
  links: z.array(z.string()).optional(),
  caps: CapsSchema,
  login: LoginSchema.optional(),
  search: SearchSchema.optional(),
}).passthrough()

// ─────────────────────────────────────────────────────────────────────────────

export interface IndexerDefinition {
  id: string
  name: string
  description?: string
  language: string
  type: string
  urls: string[]
  caps: {
    categorymappings: Array<{ id: string | number; cat: string; desc?: string }>
    modes: Record<string, unknown>
  }
  login?: unknown
  search?: unknown
  protocol: string
  _raw: string
  _version: number
  [key: string]: unknown
}

export class DefinitionLoader {
  private definitions = new Map<string, IndexerDefinition>()
  private errors: Array<{ file: string; error: string }> = []

  loadFromDirectory(rootPath: string): void {
    if (!existsSync(rootPath)) {
      console.warn(`[DefinitionLoader] Path does not exist: ${rootPath}`)
      return
    }

    const entries = readdirSync(rootPath, { withFileTypes: true })
    const versionDirs = entries
      .filter(e => e.isDirectory() && /^v\d+$/.test(e.name))
      .map(e => ({ name: e.name, version: parseInt(e.name.slice(1), 10) }))
      .sort((a, b) => b.version - a.version)

    const loadedIds = new Set<string>()

    if (versionDirs.length > 0) {
      for (const { name, version } of versionDirs) {
        this.loadDir(join(rootPath, name), version, loadedIds)
      }
    } else {
      this.loadDir(rootPath, 1, loadedIds)
    }

    console.log(
      `[DefinitionLoader] Loaded ${this.definitions.size} definitions` +
      (this.errors.length > 0 ? `, ${this.errors.length} errors` : '')
    )
  }

  private loadDir(dir: string, version: number, loadedIds: Set<string>): void {
    if (!existsSync(dir)) return
    const files = readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    for (const file of files) {
      const filePath = join(dir, file)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const parsed = yaml.load(raw)
        const result = DefinitionSchema.safeParse(parsed)

        if (!result.success) {
          const msg = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
          this.errors.push({ file: filePath, error: msg })
          continue
        }

        const data = result.data as any
        const id: string = data.id

        if (loadedIds.has(id)) continue
        loadedIds.add(id)

        // Normalise: links → urls
        if (data.links && !data.urls) data.urls = data.links

        this.definitions.set(id, {
          ...data,
          urls: data.urls ?? data.links ?? [],
          protocol: data.protocol ?? 'torrent',
          _raw: raw,
          _version: version,
        } as IndexerDefinition)
      } catch (err) {
        this.errors.push({ file: filePath, error: String(err) })
      }
    }
  }

  get(id: string): IndexerDefinition | undefined {
    return this.definitions.get(id)
  }

  getAll(): IndexerDefinition[] {
    return Array.from(this.definitions.values())
  }

  count(): number {
    return this.definitions.size
  }

  getErrors(): typeof this.errors {
    return this.errors
  }

  clear(): void {
    this.definitions.clear()
    this.errors = []
  }
}

export const definitionLoader = new DefinitionLoader()
