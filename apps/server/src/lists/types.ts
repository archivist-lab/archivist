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
  execute(query: CompiledQuery, opts: { limit: number }): Promise<ListMemberResult>
}

export class UnsupportedListFilterError extends Error {
  readonly unsupported: string[]

  constructor(unsupported: string[]) {
    super(`Unsupported filter: ${unsupported.join('; ')}`)
    this.name = 'UnsupportedListFilterError'
    this.unsupported = unsupported
  }
}
