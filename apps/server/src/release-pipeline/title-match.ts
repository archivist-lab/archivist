const LATIN_FOLD: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
}

/**
 * Spellings a catalogue and a release name disagree on. Folding each pair to a
 * single token on both sides is what lets the catalogue's "Kill Bill: Vol. 2"
 * match a release named "Kill.Bill.Volume.2.2004.2160p...".
 */
const TOKEN_ALIASES: Readonly<Record<string, string>> = { volume: 'vol', pt: 'part' }

/**
 * Tokenize catalogue titles and release names through the same Unicode-aware
 * path. Diacritics and punctuation vary widely between indexers, while
 * letters from non-Latin scripts must remain meaningful match tokens.
 */
export function releaseTitleTokens(title: string): string[] {
  const folded = title
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘`´ʼ]/g, '')
    .replace(/[ßæœøłđðþı]/g, letter => LATIN_FOLD[letter] ?? letter)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC')
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim()

  return folded ? folded.split(/\s+/).map(token => TOKEN_ALIASES[token] ?? token) : []
}

export function releaseTitleContains(targetTitle: string, candidateTitle: string): boolean {
  const candidateWords = releaseTitleTokens(candidateTitle)
  return releaseTitleTokens(targetTitle).every(word => candidateWords.includes(word))
}
