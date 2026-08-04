export type CatalogueItemType = 'film' | 'series' | 'season' | 'episode' | 'book' | 'music_release_group'
export type IdentitySource = 'tmdb' | 'tvdb' | 'imdb' | 'openlibrary' | 'isbn' | 'comicvine' | 'igdb' | 'musicbrainz' | 'discogs' | 'wikidata' | string

export interface PersonIdentityInput {
  source: IdentitySource
  externalId: string
  name: string
  originalName?: string | null
  birthday?: string | null
  deathday?: string | null
  placeOfBirth?: string | null
  biography?: string | null
  profilePath?: string | null
}

export interface OrganisationIdentityInput {
  source: IdentitySource
  externalId: string
  name: string
  organisationType?: string
  countryCode?: string | null
}
