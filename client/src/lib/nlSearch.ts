// Deterministic natural-language → structured-filter compiler.
//
// Compiles phrases like "horror films from the 1980s directed by Carpenter"
// into the same {field, q}[] compound filters the library search already runs.
// No LLM: a small, ordered set of trigger phrases + genre/year/decade extraction.
// Anything it can't classify falls back to a title filter.

import type { LibraryMediaType } from './librarySearch.js'

export interface ParsedNL {
  filters: Array<{ field: string; q: string }>
  /** True when at least one structured field was recognised. */
  recognized: boolean
}

// Genre words the parser recognises, mapped to the substring stored on items.
const GENRE_ALIASES: Record<string, string> = {
  'sci-fi': 'science fiction', 'scifi': 'science fiction', 'science fiction': 'science fiction',
  'rom com': 'romance', 'romcom': 'romance', 'docu': 'documentary', 'docs': 'documentary',
  'kids': 'kids', 'animated': 'animation',
}
const GENRES = [
  'science fiction', 'sci-fi', 'scifi', 'action', 'adventure', 'animation', 'animated', 'comedy', 'crime',
  'documentary', 'drama', 'family', 'fantasy', 'history', 'horror', 'music', 'musical', 'mystery',
  'romance', 'thriller', 'war', 'western', 'kids',
]

// Genres whose "+s" plural is collision-prone or unnatural, so we only match the
// singular (e.g. "war" → not "wars", which would hit the title "Star Wars").
const NO_PLURAL = new Set(['war', 'music', 'sci-fi', 'scifi', 'science fiction', 'animation', 'animated', 'action', 'history', 'kids'])

// Surface forms a genre may appear as: singular + a sensible plural
// (comedy→comedies, thriller→thrillers, western→westerns, family→families).
function genreForms(g: string): string[] {
  if (NO_PLURAL.has(g)) return [g]
  return g.endsWith('y') ? [g, `${g.slice(0, -1)}ies`] : [g, `${g}s`]
}

// Noise words stripped from an extracted value (e.g. "…directed by nolan films").
const NOISE = /\b(films?|movies?|series|shows?|tv|the|a|an)\b/gi

// Trigger phrases → field. Longer/more-specific phrases MUST precede shorter
// ones (e.g. "directed by" before "by") so the alternation matches them first.
const TRIGGER_ALT = [
  'directed by', 'director', 'written by', 'screenplay', 'writer', 'created by', 'creator',
  'produced by', 'producer', 'music by', 'composed by', 'score by', 'composer',
  'starring', 'featuring', 'stars', 'with', 'by',
]
const TRIGGER_RE = new RegExp(`\\b(${TRIGGER_ALT.join('|')})\\b`, 'gi')

function triggerToField(trigger: string, media: LibraryMediaType): string {
  const t = trigger.toLowerCase()
  if (/direct/.test(t)) return 'director'
  if (/writ|screenplay/.test(t)) return 'writer'
  if (/creat/.test(t)) return media === 'series' ? 'creator' : 'director'
  if (/produc/.test(t)) return 'producer'
  if (/music|composed|composer|score/.test(t)) return 'composer'
  if (/starring|featuring|stars|with/.test(t)) return 'starring'
  if (t === 'by') return 'studio'
  return 'any_credit'
}

const clean = (s: string) => s.replace(NOISE, ' ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()

export function parseNaturalQuery(input: string, media: LibraryMediaType): ParsedNL {
  let text = ` ${input.toLowerCase()} `
  const filters: Array<{ field: string; q: string }> = []

  // 1) Decade ("1980s", "the 90s") — before year so "1980s" isn't read as 1980.
  //    Consume any leading connector ("in the 2010s", "from the 90s") so it
  //    doesn't cling to the preceding value.
  const decade = text.match(/\b(?:in|from|during|of|around)?\s*(?:the\s+)?(\d{4}|\d{2})s\b/)
  if (decade) { filters.push({ field: 'decade', q: decade[1] + 's' }); text = text.replace(decade[0], ' ') }

  // 2) Year (4-digit), likewise swallowing a leading "in/from/during …".
  const year = text.match(/\b(?:in|from|during|of|released\s+in|around)?\s*((?:19|20)\d{2})\b/)
  if (year) { filters.push({ field: media === 'series' ? 'first_air_year' : 'year', q: year[1] }); text = text.replace(year[0], ' ') }

  // 3) People / studio: split on trigger phrases FIRST (so a composer trigger
  //    like "music by" isn't mistaken for the "music" genre). Each value runs to
  //    the next trigger and is split on and/comma/& into one filter per person
  //    ("starring Tom Hanks and Tim Allen" → two Starring filters, matched AND).
  const parts = text.split(TRIGGER_RE)
  for (let i = 1; i < parts.length; i += 2) {
    const field = triggerToField(parts[i], media)
    // Split on and/comma/& BEFORE cleaning (clean() strips commas), then tidy
    // each name individually.
    for (const raw of (parts[i + 1] ?? '').split(/\s*,\s*|\s+and\s+|\s*&\s*/)) {
      const q = clean(raw)
      if (q.length >= 2) filters.push({ field, q })
    }
  }

  // 4) Genre — only in the leading segment (before the first trigger), where
  //    genre modifiers naturally sit ("horror films directed by …"). Matches
  //    singular and plural forms.
  const lead = parts[0] ?? text
  outer:
  for (const g of [...GENRES].sort((a, b) => b.length - a.length)) {
    for (const form of genreForms(g)) {
      const re = new RegExp(`\\b${form.replace(/[-\s]/g, '[-\\s]')}\\b`, 'i')
      if (re.test(lead)) { filters.push({ field: 'genre', q: GENRE_ALIASES[g] ?? g }); break outer }
    }
  }

  // 5) Fallback: if nothing structured matched, treat the whole thing as a title.
  if (filters.length === 0) {
    const title = clean(input)
    return title ? { filters: [{ field: 'title', q: title }], recognized: false } : { filters: [], recognized: false }
  }
  return { filters, recognized: true }
}
