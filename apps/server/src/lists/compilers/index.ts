import { TmdbDiscoverCompiler } from './tmdb.js'

const tmdb = new TmdbDiscoverCompiler()

export function activeListCompiler(): TmdbDiscoverCompiler {
  return tmdb
}

export { TmdbDiscoverCompiler }
