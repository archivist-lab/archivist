import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keywordTokens, searchTypeAffectsRequest } from '@torrentstack/indexer-engine'
import type { IndexerInstance } from '@torrentstack/indexer-engine'

function cardigann(search: unknown): IndexerInstance {
  return {
    type: 'cardigann',
    config: { id: 'ix', name: 'Test', enabled: true } as IndexerInstance['config'],
    definition: { id: 'test', name: 'Test', raw: { search } } as unknown as IndexerInstance['definition'],
    cookies: {},
    proxyUrl: undefined,
  }
}

test('the typed-search fallback is skipped when it would refetch the same URL', () => {
  // The definitions actually installed here template only the keywords and the
  // categories, and callers pass categories explicitly — so retrying as a plain
  // `search` rebuilds a byte-identical request and pays a second full timeout
  // for the same empty page.
  const keywordOnly = cardigann({
    paths: [{ path: '{{ if .Keywords }}usearch/{{ .Keywords }}/{{ else }}new/{{ end }}' }],
  })
  assert.equal(searchTypeAffectsRequest(keywordOnly), false)
})

test('the typed-search fallback still runs where the type changes the request', () => {
  const typeAware = cardigann({
    paths: [{ path: '{{ if eq .Query.Type "movie" }}movies{{ else }}search{{ end }}/{{ .Keywords }}' }],
  })
  assert.equal(searchTypeAffectsRequest(typeAware), true)

  // Torznab carries the mode as the `t=` parameter, so it always differs.
  const torznab: IndexerInstance = {
    type: 'torznab',
    config: { id: 'tz', name: 'Torznab', enabled: true } as IndexerInstance['config'],
    definition: null,
    cookies: {},
    proxyUrl: undefined,
  }
  assert.equal(searchTypeAffectsRequest(torznab), true)
})

test('an indexer with no definition cannot be retried differently', () => {
  const orphaned: IndexerInstance = {
    type: 'cardigann',
    config: { id: 'ix', name: 'Test', enabled: true } as IndexerInstance['config'],
    definition: null,
    cookies: {},
    proxyUrl: undefined,
  }
  assert.equal(searchTypeAffectsRequest(orphaned), false)
})

// ─── andmatch row filtering ──────────────────────────────────────────────────

/** The Cardigann `andmatch` filter, as the executor applies it. */
function andmatch(query: string, title: string): boolean {
  const have = new Set(keywordTokens(title))
  return keywordTokens(query).every(term => have.has(term))
}

test('andmatch folds the query and the title the same way', () => {
  // A real release, named the way a P2P group names one: the apostrophe stays.
  const p2p = "A Bug's Life (1998) 10th Anniv (1080p BluRay x265 HEVC 10bit AAC 5.1 Tigole) [QxR]"
  // The same film from a scene group: no apostrophe, periods for spaces.
  const scene = 'A.Bugs.Life.1998.PROPER.1080p.BluRay.H264.AAC-[TGx]'

  // Both spellings of the query must match both spellings of the release.
  // The two sides used to disagree — the query dropped the apostrophe while the
  // title split on it — so `A Bugs Life` produced the term `bugs` and the title
  // produced `bug` and `s`, and the filter discarded the very release the
  // search was looking for.
  for (const query of ['A Bugs Life 1998', "A Bug's Life 1998"]) {
    assert.equal(andmatch(query, p2p), true, `${query} vs P2P name`)
    assert.equal(andmatch(query, scene), true, `${query} vs scene name`)
  }
})

test('andmatch folds diacritics and ampersands on both sides', () => {
  assert.equal(andmatch('Amelie 2001', 'Amélie.2001.1080p.BluRay'), true)
  assert.equal(andmatch('Amélie 2001', 'Amelie.2001.1080p.BluRay'), true)
  assert.equal(andmatch('Fast and Furious', 'Fast & Furious 2009 1080p'), true)
  assert.equal(andmatch('Aeon Flux', 'Æon.Flux.2005.1080p'), true)
})

test('andmatch still rejects a release missing a query term', () => {
  // The filter has to keep doing its job: this is what stops an unfiltered
  // latest-feed response leaking unrelated releases into the pipeline.
  assert.equal(andmatch('A Bugs Life 1998', 'A.Real.Bugs.Life.S01E03.720p.WEB.H264'), false)
  assert.equal(andmatch('Kill Bill Vol 2', 'Kill.Bill.Vol.1.2003.1080p.BluRay'), false)
})
