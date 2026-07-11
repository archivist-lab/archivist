/**
 * Identification: given a ParsedRelease, find the monitored SubjectRef it
 * refers to (or null). Uses the in-memory title-index for O(1) slug lookup.
 *
 * Disambiguation rules:
 *   - If the parsed release has a year, prefer subjects whose year matches
 *     within ±1 (handles release-year-vs-air-year mismatch for some shows).
 *   - For ties, the first index entry wins (effectively oldest tab/subject).
 *   - Series-kind parses only consider series entries; movie-kind parses prefer
 *     films first, then fall back to games (game releases sometimes parse as
 *     movies due to year tokens, e.g. "Game.Title.2024-FLT").
 *   - Unknown-kind parses (typical of music/games) fall back to music + game
 *     entries.
 */

import { lookupBySlug, type SubjectRef } from './title-index.js'
import type { ParsedRelease } from './parser.js'

export interface Identification {
  subject: SubjectRef
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

function pickByYear(refs: SubjectRef[], parsedYear: number | null): SubjectRef[] {
  if (refs.length <= 1 || parsedYear == null) return refs
  const exact = refs.filter(r => r.year === parsedYear)
  if (exact.length > 0) return exact
  const close = refs.filter(r => r.year != null && Math.abs(r.year - parsedYear) <= 1)
  if (close.length > 0) return close
  return refs
}

function filterByMediaType(refs: SubjectRef[], mediaTypes: SubjectRef['mediaType'][]): SubjectRef[] {
  return refs.filter(r => mediaTypes.includes(r.mediaType))
}

export function identifyRelease(parsed: ParsedRelease): Identification | null {
  const slug = parsed.titleNormalized
  if (!slug) return null

  const all = lookupBySlug(slug)
  if (all.length === 0) return null

  // Series-kind: only consider series entries
  if (parsed.kind === 'series') {
    const candidates = filterByMediaType(all, ['series'])
    if (candidates.length === 0) return null
    const narrowed = pickByYear(candidates, parsed.year)
    return {
      subject: narrowed[0],
      confidence: narrowed.length === 1 ? 'high' : 'medium',
      reason: narrowed.length === 1
        ? 'unique series title match'
        : `${narrowed.length} series share this slug; picked first (year=${parsed.year ?? 'n/a'})`,
    }
  }

  // Movie-kind: prefer films, fall back to games (game releases often parse as movies)
  if (parsed.kind === 'movie') {
    const films = filterByMediaType(all, ['films'])
    if (films.length > 0) {
      const narrowed = pickByYear(films, parsed.year)
      return {
        subject: narrowed[0],
        confidence: narrowed.length === 1
          ? (parsed.year && narrowed[0].year === parsed.year ? 'high' : 'medium')
          : 'medium',
        reason: narrowed.length === 1 && parsed.year && narrowed[0].year === parsed.year
          ? 'film title + year match'
          : `${films.length} film(s) share this slug; picked best year match`,
      }
    }
    const games = filterByMediaType(all, ['games'])
    if (games.length > 0) {
      const narrowed = pickByYear(games, parsed.year)
      return { subject: narrowed[0], confidence: 'medium', reason: 'fell back to game (parsed as movie)' }
    }
    // Year-tagged music, book and comic releases also parse as movie-like.
    const music = filterByMediaType(all, ['music'])
    if (music.length > 0) return { subject: music[0], confidence: 'low', reason: 'fell back to music' }
    const books = filterByMediaType(all, ['books'])
    if (books.length > 0) return { subject: pickByYear(books, parsed.year)[0], confidence: 'medium', reason: 'book title match' }
    const comics = filterByMediaType(all, ['comics'])
    if (comics.length > 0) return { subject: pickByYear(comics, parsed.year)[0], confidence: 'medium', reason: 'comic issue match' }
    return null
  }

  // Unknown-kind: try music/games (typical for those formats), then films
  const music = filterByMediaType(all, ['music'])
  if (music.length > 0) return { subject: music[0], confidence: 'medium', reason: 'music slug match' }
  const games = filterByMediaType(all, ['games'])
  if (games.length > 0) return { subject: games[0], confidence: 'medium', reason: 'game slug match' }
  const books = filterByMediaType(all, ['books'])
  if (books.length > 0) return { subject: books[0], confidence: 'medium', reason: 'book title match' }
  const comics = filterByMediaType(all, ['comics'])
  if (comics.length > 0) return { subject: comics[0], confidence: 'medium', reason: 'comic issue match' }
  const films = filterByMediaType(all, ['films'])
  if (films.length > 0) return { subject: films[0], confidence: 'low', reason: 'film slug match (no structural cues)' }

  return null
}
