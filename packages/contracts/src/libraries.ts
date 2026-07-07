import { z } from 'zod'
import { MediaType } from './common.js'

/**
 * Libraries replace the legacy per-tab physical databases. `db_path` is kept
 * as compatibility metadata only — the Settings UI displays it and the tab
 * compat layer round-trips it, but no per-library database file exists in Archivist.
 */
export const Library = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  media_type: MediaType,
  db_path: z.string(),
  created_at: z.string(),
})
export type Library = z.infer<typeof Library>

export const CreateLibrary = z.object({
  name: z.string().min(1),
  mediaType: MediaType,
  /** Legacy UI still sends a dbPath; Archivist stores it as inert compat metadata. */
  dbPath: z.string().min(1),
})
export type CreateLibrary = z.infer<typeof CreateLibrary>

export const UpdateLibrary = z.object({
  name: z.string().min(1),
})
export type UpdateLibrary = z.infer<typeof UpdateLibrary>

/** Legacy tab payload — identical to Library; tabs === libraries in Archivist. */
export const Tab = Library
export type Tab = Library

export const RootFolder = z.object({
  id: z.number().int().positive(),
  path: z.string(),
  freeSpace: z.number(),
  totalSpace: z.number(),
  accessible: z.boolean(),
})
export type RootFolder = z.infer<typeof RootFolder>

export const AddRootFolder = z.object({
  path: z.string().min(1),
})
export type AddRootFolder = z.infer<typeof AddRootFolder>
