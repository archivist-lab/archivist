import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseTitleContains, releaseTitleTokens } from '../src/release-pipeline/title-match.js'

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

test('film release matching folds "Volume" onto the catalogue\'s "Vol."', () => {
  for (const [target, release] of [
    ['Kill Bill: Vol. 1', 'Kill.Bill.Volume.1.2003.2160p.UHD.BluRay.REMUX.HDR.HEVC.DTS-HD.MA.5.1-SARTRE'],
    ['Kill Bill: Vol. 2', 'Kill Bill Volume 2 2004 2160p UHD BluRay Remux HEVC TrueHD-TAoE'],
    ['Kill Bill: Vol. 1', 'Kill Bill: Volume 1 (2003) [1080p] [BluRay] [YTS.MX]'],
    ['The Godfather Part II', 'The.Godfather.Pt.II.1974.1080p.BluRay'],
  ]) {
    assert.equal(releaseTitleContains(target, release), true, target)
  }
})

test('folding "Volume" still keeps the volumes apart', () => {
  assert.equal(releaseTitleContains('Kill Bill: Vol. 2', 'Kill.Bill.Volume.1.2003.2160p.UHD.BluRay.REMUX-SARTRE'), false)
  assert.equal(releaseTitleContains('Kill Bill: Vol. 1', 'Kill Bill Volume 2 2004 2160p UHD BluRay Remux-TAoE'), false)
  assert.equal(releaseTitleContains('Kill Bill: Vol. 1', 'Kill.Bill.The.Whole.Bloody.Affair.2011.1080p.WEB-DL'), false)
})
