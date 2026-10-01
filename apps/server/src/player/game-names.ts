/**
 * How a game's names are compared: a ROM's set name, a LaunchBox title, a
 * libretro thumbnail and a Games library entry each spell the same game
 * differently, so all are reduced to a key and matched on that, with a few
 * looser readings for the names sets and people get wrong.
 */

/** `Legend of Zelda, The - A Link to the Past (USA)` → `The Legend of Zelda - A Link to the Past`. */
export function displayTitle(romName: string): string {
  let title = romName.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+/g, ' ').trim()
  // No-Intro moves a leading article behind the first part of the title.
  title = title.replace(/^(.+?), (The|A|An)(\s-\s.*|$)/, '$2 $1$3')
  return title || romName
}

/** A name reduced to what identifies the game: no region or revision tags, no punctuation. */
export const matchKey = (name: string) => name
  .toLowerCase()
  .replace(/\s*[([][^)\]]*[)\]]/g, '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  // libretro writes `&` as `_`, and sets disagree on "The X" and "X, The":
  // neither word says which game it is.
  .replace(/\b(and|the)\b/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

/** Edit distance, for a set name typed by hand; stops early once past `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, current[j])
    }
    if (best > limit) return limit + 1
    previous = current
  }
  return previous[b.length]
}

export const regionsOf = (name: string) => new Set(
  [...name.matchAll(/\(([^)]*)\)/g)].flatMap(([, inner]) => inner.split(',').map(part => part.trim().toLowerCase())),
)

/**
 * The names a ROM could be, from a list keyed by [matchKey]: the same game by
 * key first, then the looser readings a hand-named or lock-on ROM needs.
 */
export function nameCandidates(romName: string, keyed: Array<{ name: string; key: string }>): string[] {
  const key = matchKey(romName)
  let candidates = keyed.filter(entry => entry.key === key).map(entry => entry.name)
  // A lock-on cartridge is boxed as its first game: `Sonic & Knuckles + Sonic 3`.
  if (!candidates.length && romName.includes(' + ')) {
    const first = matchKey(romName.split(' + ')[0])
    candidates = keyed.filter(entry => entry.key === first).map(entry => entry.name)
  }
  // A name typed by hand: `Castelvania - Symphony of Night`.
  if (!candidates.length && key.length >= 12) {
    const near = keyed.map(entry => ({ ...entry, d: distance(key, entry.key, 2) })).filter(entry => entry.d <= 2)
    const closest = Math.min(...near.map(entry => entry.d))
    candidates = near.filter(entry => entry.d === closest).map(entry => entry.name)
  }
  // Two titles for one game: `Enduro Racer ~ Super Cross`.
  if (!candidates.length && romName.includes(' ~ ')) {
    const first = matchKey(romName.split(' ~ ')[0])
    candidates = keyed.filter(entry => entry.key === first).map(entry => entry.name)
  }
  // A title cut short: `David Crane's The Rescue of Princess Blobette`, which
  // goes on "Starring A Boy and his Blob". Only for a name long enough to be sure.
  if (!candidates.length && key.split(' ').length >= 4) {
    const longer = keyed.filter(entry => entry.key.startsWith(`${key} `)).sort((a, b) => a.key.length - b.key.length)
    if (longer.length) candidates = longer.filter(entry => entry.key === longer[0].key).map(entry => entry.name)
  }
  // A set that adds the Japanese title as a subtitle, when the tags agree
  // exactly: `Streets of Rage - Bare Knuckle - Ikari no Tekken (World) (Rev A)`.
  if (!candidates.length && romName.includes(' - ')) {
    const tags = romName.match(/\s*[([].*$/)?.[0].trim() ?? ''
    const head = matchKey(romName.split(' - ')[0])
    // LaunchBox names carry no region tags, so there the subtitle is simply dropped.
    const wantTags = keyed.some(entry => /[([]/.test(entry.name))
    if (tags || !wantTags) candidates = keyed.filter(entry => entry.key === head && (!wantTags || entry.name.endsWith(tags))).map(entry => entry.name)
    // A franchise put before the title: `The Matrix - Enter the Matrix`. Only
    // where names carry no tags, and only a title long enough to be its own.
    if (!candidates.length && !wantTags) {
      const tail = matchKey(romName.split(' - ').slice(1).join(' - '))
      if (tail.split(' ').length >= 2) candidates = keyed.filter(entry => entry.key === tail).map(entry => entry.name)
    }
  }
  return candidates
}
