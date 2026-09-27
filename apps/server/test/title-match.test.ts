import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseTitleContains, releaseTitleTokens, trackerSafeQuery } from '../src/release-pipeline/title-match.js'

test('film release matching tokenizes periods consistently', () => {
  assert.deepEqual(releaseTitleTokens('Kill Bill Vol. 1'), ['kill', 'bill', 'vol', '1'])
  assert.equal(releaseTitleContains('kill bill vol. 1', 'kill.bill.vol.1.2003.1080p.bluray'), true)
})

test('film release matching accepts punctuation variants of common abbreviations', () => {
  for (const [target, release] of [
    ['Dr. No', 'Dr.No.1962.1080p.BluRay'],
    ['St: Vincent', 'St-Vincent.2014.1080p.WEB-DL'],
    ['Mr—Nobody', 'Mr.Nobody.2009.2160p.BluRay'],
    ['A Nightmare on Elm St…', 'A.Nightmare.on.Elm.St.1984.1080p.BluRay'],
    ['Kill Bill Vol: 2', 'Kill.Bill.Vol-2.2004.1080p.BluRay'],
    ['Godfather Pt. II', 'Godfather.Pt-II.1974.1080p.BluRay'],
  ]) {
    assert.equal(releaseTitleContains(target, release), true, target)
  }
})

test('film release matching folds umlauts, accents, and non-decomposing Latin letters', () => {
  for (const [target, release] of [
    ['Amélie', 'Amelie.2001.1080p.BluRay'],
    ['Léon: The Professional', 'Leon.The.Professional.1994.2160p.BluRay'],
    ['El niño', 'El.Nino.2014.1080p.WEB-DL'],
    ['Männer', 'Manner.1985.1080p.BluRay'],
    ['Tōkyō!', 'Tokyo.2008.1080p.BluRay'],
    ['Straße', 'Strasse.2010.1080p.WEB-DL'],
    ['Æon Flux', 'Aeon.Flux.2005.1080p.BluRay'],
    ['Łódź', 'Lodz.2010.1080p.WEB-DL'],
  ]) {
    assert.equal(releaseTitleContains(target, release), true, target)
  }
})

test('film release matching handles apostrophes and ampersands consistently', () => {
  assert.equal(releaseTitleContains("Schindler's List", 'Schindlers.List.1993.1080p.BluRay'), true)
  assert.equal(releaseTitleContains('Me & You', 'Me.and.You.2012.1080p.WEB-DL'), true)
})

test('film release matching preserves non-Latin scripts', () => {
  assert.equal(releaseTitleContains('七人の侍', '七人の侍.1954.1080p.BluRay'), true)
  assert.equal(releaseTitleContains('Паразиты', 'Паразиты.2019.1080p.BluRay'), true)
  assert.equal(releaseTitleContains('기생충', '기생충.2019.1080p.BluRay'), true)
})

test('film release matching still rejects candidates missing a title token', () => {
  assert.equal(releaseTitleContains('kill bill vol. 2', 'kill.bill.vol.1.2003.1080p.bluray'), false)
})

test('tracker-safe queries drop the punctuation release names do not carry', () => {
  for (const [catalogue, expected] of [
    // The case that started this: the apostrophe alone took the query from
    // dozens of matches to none.
    ["A Bug's Life 1998", 'A Bugs Life 1998'],
    ['Monsters, Inc. 2001', 'Monsters Inc 2001'],
    ['Kill Bill: Vol. 2 2004', 'Kill Bill Vol 2 2004'],
    ['Once Upon a Time... in Hollywood 2019', 'Once Upon a Time in Hollywood 2019'],
    ['Birds of Prey (and the Fantabulous Emancipation) 2020', 'Birds of Prey and the Fantabulous Emancipation 2020'],
    ['M*A*S*H 1970', 'M A S H 1970'],
    ['WALL·E 2008', 'WALL E 2008'],
    // `&` becomes the word uploaders write.
    ['Fast & Furious 2009', 'Fast and Furious 2009'],
    // Diacritics and non-decomposing Latin letters fold, keeping their case.
    ['Amélie 2001', 'Amelie 2001'],
    ['Léon: The Professional 1994', 'Leon The Professional 1994'],
    ['Æon Flux 2005', 'Aeon Flux 2005'],
    ['Straße 2010', 'Strasse 2010'],
  ] as Array<[string, string]>) {
    assert.equal(trackerSafeQuery(catalogue), expected, catalogue)
  }
})

test('tracker-safe queries keep the hyphens release names do carry', () => {
  assert.equal(trackerSafeQuery('Spider-Man: No Way Home 2021'), 'Spider-Man No Way Home 2021')
  assert.equal(trackerSafeQuery("X-Men '97 S02E05"), 'X-Men 97 S02E05')
  // A dash used as punctuation is not part of a word, so it goes.
  assert.equal(trackerSafeQuery('Alien - Resurrection 1997'), 'Alien Resurrection 1997')
  assert.equal(trackerSafeQuery('Star Wars: Episode IV – A New Hope 1977'), 'Star Wars Episode IV A New Hope 1977')
})

test('tracker-safe queries leave non-Latin scripts and bare titles alone', () => {
  assert.equal(trackerSafeQuery('七人の侍 1954'), '七人の侍 1954')
  assert.equal(trackerSafeQuery('Паразиты 2019'), 'Паразиты 2019')
  // Nothing to fix: the query must come back byte-identical so callers can tell
  // there is no second variant worth issuing.
  assert.equal(trackerSafeQuery('Requiem for a Dream 2000'), 'Requiem for a Dream 2000')
  assert.equal(trackerSafeQuery('Se7en 1995'), 'Se7en 1995')
})

test('tracker-safe queries do not glue a fraction onto the preceding digit', () => {
  assert.equal(trackerSafeQuery('9½ Weeks 1986'), '9 1 2 Weeks 1986')
  // A superscript still folds into the number, which is how Alien 3 is named.
  assert.equal(trackerSafeQuery('Alien³ 1992'), 'Alien3 1992')
})
