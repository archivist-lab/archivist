// Cardigann definition loader
// Loads .yml indexer definition files from disk, validates structure,
// and returns parsed definitions ready for the executor.
//
// Compatible with Prowlarr/Indexers definitions (v1–v11 schemas).
// Uses permissive validation — unknown fields are ignored so new schema
// versions don't break the loader.

import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ─── Schema (permissive — extra keys pass through) ────────────────────────────

const CategorySchema = z.object({
  id:   z.union([z.number(), z.string()]),
  cat:  z.string(),
  desc: z.string().optional(),
}).passthrough();

const FieldSchema = z.record(z.string(), z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.object({}).passthrough(),
]).optional());

const InputSchema = z.record(z.union([z.string(), z.number(), z.boolean()]))
  .transform(v => Object.fromEntries(
    Object.entries(v).map(([k, val]) => [k, String(val)])
  ));

const SearchSchema = z.object({
  path:   z.string().optional(),
  method: z.enum(['get', 'post']).optional(),
  inputs: InputSchema.optional(),
  rows:   z.object({}).passthrough().optional(),
  fields: FieldSchema.optional(),
}).passthrough().optional();

const CapabilitiesSchema = z.object({
  categorymappings: z.array(CategorySchema).optional(),
  modes: z.record(z.array(z.string())).optional(),
}).passthrough().optional();

const LoginSchema = z.object({
  path:   z.string().optional(),
  method: z.enum(['get', 'post', 'cookie', 'form', 'httplogin']).optional(),
  inputs: InputSchema.optional(),
  cookies: z.array(z.string()).optional(),
  test:   z.object({}).passthrough().optional(),
}).passthrough().optional();

const SettingFieldSchema = z.object({
  name:     z.string(),
  type:     z.string().optional(),
  label:    z.string().optional(),
  default:  z.union([z.string(), z.number(), z.boolean()]).optional(),
  options:  z.record(z.string()).optional(),
}).passthrough();

export const CardigannDefinitionSchema = z.object({
  id:          z.string(),
  name:        z.string(),
  description: z.string().optional(),
  language:    z.string().optional(),
  type:        z.enum(['public', 'semi-private', 'private']).optional(),
  encoding:    z.string().optional(),
  links:       z.array(z.string()).optional(),
  caps:        CapabilitiesSchema,
  settings:    z.array(SettingFieldSchema).optional(),
  login:       LoginSchema.optional(),
  search:      SearchSchema.optional(),
  download:    z.object({}).passthrough().optional(),
  ratio:       z.object({}).passthrough().optional(),
}).passthrough();

export type CardigannDefinition = z.infer<typeof CardigannDefinitionSchema>;

// ─── Registry entry ───────────────────────────────────────────────────────────

export interface DefinitionEntry {
  id:          string;
  name:        string;
  description: string;
  language:    string;
  type:        'public' | 'semi-private' | 'private';
  links:       string[];
  categories:  Array<{ id: number | string; cat: string; desc?: string }>;
  settings:    Array<{ name: string; type: string; label: string; default?: string | number | boolean; options?: Record<string, string> }>;
  searchModes: string[];        // e.g. ['search', 'tvsearch', 'movie']
  raw:         CardigannDefinition;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export class DefinitionLoader {
  private definitions = new Map<string, DefinitionEntry>();
  private loadErrors:  Array<{ file: string; error: string }> = [];

  async loadDirectory(dir: string): Promise<void> {
    let files: string[];
    try {
      files = await readdir(dir, { recursive: true }) as string[];
    } catch {
      return; // directory doesn't exist yet
    }

    const ymlFiles = files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

    await Promise.allSettled(ymlFiles.map(async (file) => {
      try {
        await this.loadFile(join(dir, file));
      } catch (e) {
        this.loadErrors.push({ file, error: String(e) });
      }
    }));
  }

  async loadFile(path: string): Promise<DefinitionEntry | null> {
    const raw = await readFile(path, 'utf8');
    return this.loadString(raw, path);
  }

  loadString(yamlText: string, sourcePath = '<inline>'): DefinitionEntry | null {
    let parsed: unknown;
    try {
      parsed = parseYaml(yamlText);
    } catch (e) {
      this.loadErrors.push({ file: sourcePath, error: `YAML parse error: ${String(e)}` });
      return null;
    }

    const result = CardigannDefinitionSchema.safeParse(parsed);
    if (!result.success) {
      // Log but don't fail — permissive mode
      const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      this.loadErrors.push({ file: sourcePath, error: `Schema warnings: ${issues}` });
      // Still try to use it if it has the required fields
      if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || !('name' in parsed)) {
        return null;
      }
    }

    const def = (result.success ? result.data : parsed) as CardigannDefinition;
    const entry = this.toEntry(def);

    // Allow custom definitions to override built-in ones
    this.definitions.set(entry.id, entry);
    return entry;
  }

  private toEntry(def: CardigannDefinition): DefinitionEntry {
    const cats = (def.caps?.categorymappings ?? []).map(c => ({
      id:   c.id,
      cat:  c.cat,
      desc: c.desc,
    }));

    const modes = Object.keys(def.caps?.modes ?? {});

    return {
      id:          def.id,
      name:        def.name,
      description: def.description ?? '',
      language:    def.language ?? 'en-us',
      type:        (def.type ?? 'public') as DefinitionEntry['type'],
      links:       def.links ?? [],
      categories:  cats,
      settings:    (def.settings ?? []).map(s => ({
        name:     s.name,
        type:     s.type ?? 'text',
        label:    s.label ?? s.name,
        default:  s.default,
        options:  s.options,
      })),
      searchModes: modes.length > 0 ? modes : ['search'],
      raw:         def,
    };
  }

  get(id: string): DefinitionEntry | undefined {
    return this.definitions.get(id);
  }

  getAll(): DefinitionEntry[] {
    return [...this.definitions.values()];
  }

  get count(): number { return this.definitions.size; }
  get errors(): Array<{ file: string; error: string }> { return this.loadErrors; }
}
