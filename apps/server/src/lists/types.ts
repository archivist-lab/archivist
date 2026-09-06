import type { FilterNode, ListMediaType } from '@archivist/contracts'

export interface ListMember {
  mediaType: ListMediaType
  tmdbId: number
  tvdbId?: number
  imdbId?: string
  title: string
  year?: number
  posterPath?: string
  releaseDate?: string
  overview?: string
}

export interface CompiledQuery {
  compilerId: string
  mediaType: ListMediaType
  path: string
  params: Record<string, string | number | boolean>
  /**
   * A second discover query to run alongside `params` and merge in, present
   * only when the filter has a minimum-runtime rule. TMDB records an
   * unreleased/upcoming title's runtime as 0 until it's known, so a plain
   * `with_runtime.gte` silently drops every future title along with the short
   * ones it's meant to exclude. This carries the same filter with the runtime
   * bound removed and scoped to titles not yet released, so those are found
   * through a path the runtime rule never touches instead of being exempted
   * from it after the fact (which the discover API has no way to express).
   */
  unreleasedParams?: Record<string, string | number | boolean>
}

export interface ListMemberResult {
  members: ListMember[]
  total: number
  capped: boolean
  ceilingHit: boolean
  warning?: string
}

export interface FilterCompiler {
  readonly id: string
  supports(op: FilterNode['op']): boolean
  compile(ast: FilterNode, mediaType: ListMediaType): CompiledQuery
  execute(query: CompiledQuery, opts: { limit: number; signal?: AbortSignal }): Promise<ListMemberResult>
}

export class UnsupportedListFilterError extends Error {
  readonly unsupported: string[]

  constructor(unsupported: string[]) {
    super(`Unsupported filter: ${unsupported.join('; ')}`)
    this.name = 'UnsupportedListFilterError'
    this.unsupported = unsupported
  }
}
