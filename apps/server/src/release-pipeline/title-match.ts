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

  return folded ? folded.split(/\s+/) : []
}

export function releaseTitleContains(targetTitle: string, candidateTitle: string): boolean {
  const candidateWords = releaseTitleTokens(candidateTitle)
  return releaseTitleTokens(targetTitle).every(word => candidateWords.includes(word))
}
