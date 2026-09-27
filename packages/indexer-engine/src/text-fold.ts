// Shared text folding for keyword matching.
//
// Catalogue titles and release names spell the same film differently:
// `A Bug's Life` is uploaded as `A.Bugs.Life` by a scene group and as
// `A Bug's Life (1998)` by a P2P group. Anything that compares the two — the
// query we build, the `andmatch` row filter, the release-title matcher — has to
// fold them the same way, or one side strips an apostrophe while the other
// splits on it and the comparison fails on titles that plainly match.
//
// This module is that single fold. It lives in the engine because the engine
// needs it for `andmatch`, and the server imports it for the same reason: two
// copies of these rules is how they drift.

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
};

/** Straight, typographic, backtick, acute and modifier-letter apostrophes. */
const APOSTROPHES = /['’‘`´ʼ]/g;
/** Latin letters with no NFKD decomposition, in both cases. */
const UNDECOMPOSED_LATIN = /[ßæœøłđðþıẞÆŒØŁĐÐÞ]/g;
/**
 * Vulgar fractions only — `½` decomposes to `1⁄2`, which would otherwise glue
 * itself onto the preceding digit and turn `9½ Weeks` into `91 2 Weeks`.
 * Superscripts are deliberately excluded: `Alien³` folding to `Alien3` is how
 * that release is actually named.
 */
const VULGAR_FRACTIONS = /[¼-¾⅐-⅞]/g;

/**
 * Fold the writing-system differences that separate a catalogue title from the
 * same title in a release name.
 *
 * The apostrophe is *removed* rather than replaced with a separator, so
 * `Bug's` and `Bugs` fold together. Replacing it with a space instead would
 * yield `bug` + `s`, which matches neither spelling.
 *
 * Punctuation is otherwise left alone: callers differ on what to do with it,
 * and they own that decision. Case is preserved for the same reason.
 */
export function foldForMatching(text: string): string {
  return text
    .replace(/&/g, ' and ')
    .replace(APOSTROPHES, '')
    .replace(UNDECOMPOSED_LATIN, letter => {
      const lower = letter.toLowerCase();
      const folded = LATIN_FOLD[lower] ?? letter;
      // `Æon` must fold to `Aeon`, not `aeon`: a caller that wants lowercase
      // applies it itself.
      return letter === lower ? folded : folded.charAt(0).toUpperCase() + folded.slice(1);
    })
    .replace(VULGAR_FRACTIONS, fraction => ` ${fraction} `)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC');
}

/**
 * Fold, then split into lowercase alphanumeric keyword tokens.
 *
 * Both sides of a keyword comparison must go through this, never one side
 * through this and the other through a bare `split(/[^a-z0-9]+/)`.
 */
export function keywordTokens(text: string): string[] {
  return foldForMatching(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Typographic punctuation, as release names spell it in ASCII. */
const TYPOGRAPHIC: Readonly<Record<string, string>> = {
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '’': "'", '‘': "'", 'ʼ': "'", '´': "'", '`': "'",
  '“': '"', '”': '"', '„': '"', '…': '...',
};
const TYPOGRAPHIC_CHARS = /[‐‑‒–—―−’‘ʼ´`“”„…]/g;
/**
 * Compatibility forms with a plain spelling: superscript and subscript digits
 * (`Alien³` is released as `Alien3`) and fullwidth ASCII.
 */
const COMPATIBILITY_FORMS = /[²³¹⁰-₟！-～]/g;
/** One Latin letter and any combining marks written after it. */
const LATIN_CLUSTER = /\p{Script=Latin}\p{M}*/gu;

function foldLatinLetter(cluster: string): string {
  const letter = cluster.charAt(0);
  const lower = letter.toLowerCase();
  const special = LATIN_FOLD[lower];
  if (special) return letter === lower ? special : special.charAt(0).toUpperCase() + special.slice(1);
  return cluster.normalize('NFKD').replace(/\p{M}+/gu, '');
}

/**
 * A search query in the plain letters release names are written in.
 *
 * Trackers match the release name, and release names are ASCII: the catalogue's
 * `JAŸ-Z`, `Beyoncé`, `Mötley Crüe` and `Røyksopp` are uploaded as `JAY-Z`,
 * `Beyonce`, `Motley Crue` and `Royksopp`, and a keyword search for the
 * accented spelling finds nothing. This is only ever applied to what is sent;
 * the catalogue keeps its own spelling.
 *
 * Unlike [foldForMatching] it changes Latin letters alone. Marks in other
 * scripts are part of the letter — `ガ` is not `カ`, and a Devanagari vowel sign
 * is not decoration — so a Japanese or Hindi title goes out exactly as written.
 * Punctuation is kept, bar typographic dashes and quotes, which become the
 * ASCII ones release names use; callers that strip punctuation still do.
 */
export function foldQuery(text: string): string {
  return text
    .normalize('NFC')
    .replace(TYPOGRAPHIC_CHARS, mark => TYPOGRAPHIC[mark] ?? mark)
    .replace(COMPATIBILITY_FORMS, form => form.normalize('NFKD'))
    .replace(LATIN_CLUSTER, foldLatinLetter);
}
