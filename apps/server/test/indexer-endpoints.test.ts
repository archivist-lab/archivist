import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IndexerEndpoint } from '@archivist/contracts'
import {
  classifyDiagnostics, chooseProbeQuery, looksLikeLoginPage, parseRetryAfter,
} from '@torrentstack/indexer-engine'
import type { DefinitionEntry } from '@torrentstack/indexer-engine'
import {
  INCUMBENCY_BONUS, scoreEndpoint, selectEndpoint, tierForFailure,
} from '../src/indexers/endpoints/scoring.js'
import { nextProbeDelayMs, type Prober } from '../src/indexers/endpoints/resolver.js'
import { hostOf, planProbeBatch } from '../src/indexers/endpoints/scheduler.js'
import { normaliseEndpointUrl } from '../src/indexers/endpoints/store.js'
import { DEFAULT_IER_CONFIG } from '@archivist/contracts'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function endpoint(patch: Partial<IndexerEndpoint> = {}): IndexerEndpoint {
  return {
    id: 1, indexerId: 'ix', url: 'https://site.org', origin: 'definition', ordinal: 0,
    isActive: false, isEnabled: true, isPinned: false,
    tier: 'A', requiresCloudflareBypass: false, score: 0,
    latencyP50Ms: 100, successRate7d: 1, consecutiveFails: 0,
    lastProbeAt: null, lastOkAt: null, nextProbeAt: null, cooldownUntil: null,
    lastFailureClass: null, lastError: null,
    createdAt: 0, updatedAt: 0,
    ...patch,
  }
}

const CF_BODY = '<html><head><title>Just a moment...</title></head><body>'
  + '<div class="cf-browser-verification"></div><script>__cf_chl_opt</script></body></html>'

// ─── Failure classification (spec §6.3) ──────────────────────────────────────

test('classifier separates every failure class the spec names', () => {
  assert.equal(classifyDiagnostics({ transportCode: 'ENOTFOUND' }).failureClass, 'dns')
  assert.equal(classifyDiagnostics({ transportCode: 'ECONNREFUSED' }).failureClass, 'connect')
  assert.equal(classifyDiagnostics({ transportCode: 'ETIMEDOUT' }).failureClass, 'timeout')

  assert.equal(
    classifyDiagnostics({ httpStatus: 503, headers: { 'cf-ray': 'abc' }, bodySample: CF_BODY }).failureClass,
    'challenge',
  )
  assert.equal(
    classifyDiagnostics({ httpStatus: 403, headers: {}, bodySample: '<html>ddos-guard check</html>' }).failureClass,
    'challenge',
  )

  const limited = classifyDiagnostics({ httpStatus: 429, headers: { 'retry-after': '120' }, bodySample: 'slow down' })
  assert.equal(limited.failureClass, 'rate_limited')
  assert.equal(limited.retryAfterSec, 120)

  assert.equal(classifyDiagnostics({ httpStatus: 401, headers: {}, bodySample: 'nope' }).failureClass, 'auth')
  assert.equal(
    classifyDiagnostics({ httpStatus: 200, headers: {}, bodySample: '<form><input type="password"></form>' }).failureClass,
    'auth',
  )
  assert.equal(classifyDiagnostics({ httpStatus: 502, headers: {}, bodySample: '' }).failureClass, 'http_error')

  // 200, page fetched, selectors matched nothing → the definition drifted.
  assert.equal(
    classifyDiagnostics({ httpStatus: 200, headers: {}, bodySample: '<table></table>', rowsMatched: 0 }).failureClass,
    'parse',
  )
  // 200, selectors matched, but every row filtered away → empty, not parse.
  assert.equal(
    classifyDiagnostics({ httpStatus: 200, headers: {}, bodySample: '<tr>', rowsMatched: 5, rowCount: 0 }).failureClass,
    'empty',
  )
  // A healthy browse returns no failure class at all.
  assert.equal(
    classifyDiagnostics({ httpStatus: 200, headers: {}, bodySample: '<tr>', rowsMatched: 5, rowCount: 5 }).failureClass,
    undefined,
  )
})

test('a challenge is recognised ahead of the status code it arrives on', () => {
  // Cloudflare commonly serves its wall as 429; classifying that as a rate
  // limit would leave the endpoint permanently unusable but never demoted.
  const diag = { httpStatus: 429, headers: { 'cf-mitigated': 'challenge' }, bodySample: CF_BODY }
  assert.equal(classifyDiagnostics(diag).failureClass, 'challenge')
})

test('Retry-After is read as seconds or as a date', () => {
  assert.equal(parseRetryAfter('90'), 90)
  assert.equal(parseRetryAfter(undefined), undefined)
  const soon = new Date(Date.now() + 60_000).toUTCString()
  const parsed = parseRetryAfter(soon)
  assert.ok(parsed !== undefined && parsed >= 55 && parsed <= 61, `got ${parsed}`)
})

test('login pages are detected so they are not mistaken for empty results', () => {
  assert.equal(looksLikeLoginPage('<form action="/login"><input type="password" /></form>'), true)
  assert.equal(looksLikeLoginPage('<table><tr><td>Ubuntu.iso</td></tr></table>'), false)
})

test('Torznab requests expose HTTP diagnostics to the endpoint breaker', async () => {
  const { createServer } = await import('node:http')
  const { torznabSearch } = await import('@torrentstack/indexer-engine')
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/html' })
    res.end('<html>temporarily unavailable</html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const diagnostics: Parameters<typeof classifyDiagnostics>[0] = {}
    await assert.rejects(() => torznabSearch({ baseUrl }, { q: 'test' } as never, diagnostics))
    assert.equal(diagnostics.httpStatus, 503)
    assert.equal(classifyDiagnostics(diagnostics).failureClass, 'http_error')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

// ─── Tier verdicts (spec §6.3) ───────────────────────────────────────────────

test('rate limiting never demotes an endpoint', () => {
  // Penalising an endpoint for being busy demotes the indexer you use most.
  assert.equal(tierForFailure('rate_limited'), 'unknown')
  assert.equal(tierForFailure('dns'), 'D')
  assert.equal(tierForFailure('connect'), 'D')
  assert.equal(tierForFailure('timeout'), 'C')
  assert.equal(tierForFailure('parse'), 'C')
  assert.equal(tierForFailure('empty'), 'C')
})

test('a saturated Cloudflare bypass never demotes an endpoint', () => {
  // The bypass running out of browsers is our outage. The endpoint was never
  // contacted, so scoring it as dead strands every Cloudflare-fronted indexer.
  assert.equal(tierForFailure('bypass_unavailable'), 'unknown')

  // It must not fall through to the generic transport branch, which would
  // score it `connect` and therefore tier D.
  assert.equal(
    classifyDiagnostics({ transportCode: 'BYPASS_UNAVAILABLE' }).failureClass,
    'bypass_unavailable',
  )
})

// ─── Probe query selection (spec §6.2) ───────────────────────────────────────

function definition(patch: Partial<DefinitionEntry> = {}): DefinitionEntry {
  return {
    id: 'demo', name: 'Demo', description: '', language: 'en-us', type: 'public',
    links: ['https://demo.org'], legacyLinks: [], categories: [], settings: [],
    searchModes: ['search'],
    raw: { id: 'demo', name: 'Demo', caps: { modes: { search: ['q'] } }, search: {} } as never,
    ...patch,
  }
}

test('browse mode is preferred, because a keyword makes empty ambiguous', () => {
  const plan = chooseProbeQuery(definition())
  assert.equal(plan.mode, 'browse')
  assert.equal(plan.confidence, 'high')
})

test('a definition that cannot browse falls back to a term and admits low confidence', () => {
  const musicDef = definition({
    id: 'tunes', name: 'Tunes', description: 'music tracker',
    raw: {
      id: 'tunes', name: 'Tunes', caps: { modes: { search: ['q'] } },
      search: { inputs: { q: '{{ .Query.Keywords }}', required: 'true' } },
    } as never,
  })
  const plan = chooseProbeQuery(musicDef)
  assert.equal(plan.mode, 'search')
  assert.equal(plan.confidence, 'low')
  assert.equal(plan.term, 'flac')
})

test('one endpoint probe executes only one definition search path', async () => {
  const { createServer } = await import('node:http')
  const { probeEndpoint } = await import('@torrentstack/indexer-engine')
  let requests = 0
  const server = createServer((_req, res) => {
    requests += 1
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<table><tr class="r"><td class="t">Ubuntu</td><td><a class="d" href="/x.torrent">get</a></td></tr></table>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const entry = definition({
      links: [base],
      raw: {
        id: 'demo', name: 'Demo', caps: { modes: { search: ['q'] } },
        search: {
          paths: [{ path: '/one' }, { path: '/two' }, { path: '/three' }],
          rows: { selector: 'tr.r' },
          fields: {
            title: { selector: 'td.t' },
            download: { selector: 'a.d', attribute: 'href' },
          },
        },
      } as never,
    })
    const result = await probeEndpoint(base, entry, { mode: 'browse', allowCloudflareBypass: false })
    assert.equal(result.outcome, 'ok')
    assert.equal(requests, 1, 'a probe must not fan out across category/page paths')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

// ─── Scoring and selection (spec §7) ─────────────────────────────────────────

test('tier dominates: a Cloudflare-only mirror never beats a working direct one', () => {
  const direct = endpoint({ id: 1, tier: 'A', latencyP50Ms: 2000 })
  const viaBrowser = endpoint({ id: 2, tier: 'B', latencyP50Ms: 10 })
  assert.ok(scoreEndpoint(direct) > scoreEndpoint(viaBrowser))
})

test('a healthy pinned endpoint remains preferred', () => {
  const selection = selectEndpoint([
    endpoint({ id: 1, tier: 'A', isActive: true, latencyP50Ms: 50 }),
    endpoint({ id: 2, tier: 'A', isPinned: true, url: 'https://pinned.org', latencyP50Ms: 5000 }),
  ], { now: 0, switchThrottleMin: 10, autoSwitch: true })
  assert.equal(selection.reason, 'pinned')
  assert.equal(selection.winner?.id, 2)
})

test('an unhealthy pin fails over but remains available to recover later', () => {
  const selection = selectEndpoint([
    endpoint({ id: 1, tier: 'D', isActive: true, isPinned: true }),
    endpoint({ id: 2, tier: 'A', url: 'https://healthy.org' }),
  ], { now: 0, switchThrottleMin: 10, autoSwitch: true })
  assert.equal(selection.reason, 'pinned-unhealthy')
  assert.equal(selection.winner?.id, 2)
})

test('a chosen URL beats an arbitrary definition default when neither endpoint is healthy', () => {
  const selection = selectEndpoint([
    endpoint({ id: 1, tier: 'C', isActive: true, url: 'https://default.org' }),
    endpoint({ id: 2, tier: 'D', isPinned: true, url: 'https://chosen.org' }),
  ], { now: 0, switchThrottleMin: 10, autoSwitch: true })
  assert.equal(selection.reason, 'pinned')
  assert.equal(selection.winner?.id, 2)
})

test('a dead incumbent is retained when no proven replacement exists', () => {
  const dead = endpoint({
    id: 1, tier: 'D', isActive: true, origin: 'user', successRate7d: 1,
    latencyP50Ms: 0, consecutiveFails: 0,
  })
  assert.ok(scoreEndpoint(dead) > 0, 'fixture proves score bonuses would otherwise mask tier D')
  const selection = selectEndpoint([dead], { now: 0, switchThrottleMin: 0, autoSwitch: true })
  assert.equal(selection.reason, 'incumbent-retained')
  assert.equal(selection.winner?.id, 1)
})

test('hysteresis keeps two near-identical mirrors from trading places', () => {
  const incumbent = endpoint({ id: 1, tier: 'A', isActive: true, latencyP50Ms: 300 })
  const challenger = endpoint({ id: 2, tier: 'A', latencyP50Ms: 290, url: 'https://other.org' })
  const selection = selectEndpoint([incumbent, challenger], {
    now: 0, switchThrottleMin: 0, autoSwitch: true,
  })
  assert.equal(selection.changed, false)
  assert.equal(selection.winner?.id, 1)
})

test('a decisively better endpoint does take over', () => {
  const incumbent = endpoint({ id: 1, tier: 'C', isActive: true, successRate7d: 0.2, consecutiveFails: 2 })
  const challenger = endpoint({ id: 2, tier: 'A', url: 'https://better.org', successRate7d: 1 })
  const selection = selectEndpoint([incumbent, challenger], {
    now: 0, switchThrottleMin: 0, autoSwitch: true,
  })
  assert.equal(selection.changed, true)
  assert.equal(selection.winner?.id, 2)
  assert.equal(selection.reason, 'higher-score')
})

test('a dead incumbent is not replaced by an unproven or degraded mirror', () => {
  const selection = selectEndpoint([
    endpoint({ id: 1, tier: 'D', isActive: true }),
    endpoint({ id: 2, tier: 'unknown', url: 'https://unproven.org' }),
    endpoint({ id: 3, tier: 'C', url: 'https://degraded.org' }),
  ], { now: 1_000, lastSwitchAt: 999, switchThrottleMin: 10, autoSwitch: true })
  assert.equal(selection.reason, 'incumbent-retained')
  assert.equal(selection.winner?.id, 1)
})

test('a dead incumbent is replaced immediately by a proven healthy mirror', () => {
  const selection = selectEndpoint([
    endpoint({ id: 1, tier: 'D', isActive: true }),
    endpoint({ id: 2, tier: 'A', url: 'https://healthy.org' }),
  ], { now: 1_000, lastSwitchAt: 999, switchThrottleMin: 10, autoSwitch: true })
  assert.equal(selection.reason, 'incumbent-dead')
  assert.equal(selection.winner?.id, 2)
})

test('the switch throttle suppresses an otherwise valid switch', () => {
  const selection = selectEndpoint([
    endpoint({ id: 1, tier: 'C', isActive: true, successRate7d: 0.2 }),
    endpoint({ id: 2, tier: 'A', url: 'https://better.org' }),
  ], { now: 60_000, lastSwitchAt: 30_000, switchThrottleMin: 10, autoSwitch: true })
  assert.equal(selection.reason, 'throttled')
  assert.equal(selection.winner?.id, 1)
})

test('measurement-only mode reports a better endpoint but does not switch', () => {
  const selection = selectEndpoint([
    endpoint({ id: 1, tier: 'C', isActive: true }),
    endpoint({ id: 2, tier: 'A', url: 'https://better.org' }),
  ], { now: 0, switchThrottleMin: 0, autoSwitch: false })
  assert.equal(selection.changed, false)
  assert.equal(selection.winner?.id, 1)
})

test('manual mode keeps the incumbent even when a pinned probe says it is unhealthy', () => {
  const selection = selectEndpoint([
    endpoint({ id: 1, tier: 'D', isActive: true, isPinned: true }),
    endpoint({ id: 2, tier: 'A', url: 'https://healthy.org' }),
  ], { now: 0, switchThrottleMin: 0, autoSwitch: false })
  assert.equal(selection.reason, 'incumbent-retained')
  assert.equal(selection.winner?.id, 1)
})

test('an active indexer with no healthy alternative keeps its last URL', () => {
  const selection = selectEndpoint([
    endpoint({ id: 1, tier: 'D', isActive: true, successRate7d: 0, latencyP50Ms: 5000, consecutiveFails: 9 }),
  ], { now: 0, switchThrottleMin: 0, autoSwitch: true })
  assert.equal(selection.reason, 'incumbent-retained')
  assert.equal(selection.winner?.id, 1)
})

test('an endpoint in cooldown is not a candidate', () => {
  const selection = selectEndpoint([
    endpoint({ id: 1, tier: 'A', cooldownUntil: 10_000 }),
    endpoint({ id: 2, tier: 'C', url: 'https://spare.org' }),
  ], { now: 5_000, switchThrottleMin: 0, autoSwitch: true })
  assert.equal(selection.winner?.id, 2)
})

test('cooldown never clears the active endpoint or makes the indexer look down', () => {
  const selection = selectEndpoint([
    endpoint({ id: 1, tier: 'A', isActive: true, cooldownUntil: 10_000 }),
  ], { now: 5_000, switchThrottleMin: 0, autoSwitch: true })
  assert.equal(selection.reason, 'incumbent-retained')
  assert.equal(selection.winner?.id, 1)
})

test('the incumbency bonus is what the challenger has to overcome', () => {
  const base = endpoint({ tier: 'A' })
  assert.equal(scoreEndpoint({ ...base, isActive: true }) - scoreEndpoint(base), INCUMBENCY_BONUS)
})

// ─── Cadence (spec §8.2) ─────────────────────────────────────────────────────

test('cadence follows tier, backs off while degraded, and always jitters', () => {
  const config = DEFAULT_IER_CONFIG
  const hour = 3_600_000
  const noJitter = () => 0.5

  assert.equal(nextProbeDelayMs('A', { isActive: true, consecutiveFails: 0, deadSinceDays: 0, config }, noJitter), 12 * hour)
  assert.equal(nextProbeDelayMs('A', { isActive: false, consecutiveFails: 0, deadSinceDays: 0, config }, noJitter), 24 * hour)
  assert.equal(nextProbeDelayMs('B', { isActive: true, consecutiveFails: 0, deadSinceDays: 0, config }, noJitter), 6 * hour)
  assert.equal(nextProbeDelayMs('C', { isActive: true, consecutiveFails: 1, deadSinceDays: 0, config }, noJitter), 1 * hour)
  assert.equal(nextProbeDelayMs('C', { isActive: true, consecutiveFails: 3, deadSinceDays: 0, config }, noJitter), 4 * hour)
  // Backoff is capped so a degraded endpoint is never abandoned.
  assert.equal(nextProbeDelayMs('C', { isActive: true, consecutiveFails: 9, deadSinceDays: 0, config }, noJitter), 6 * hour)
  assert.equal(nextProbeDelayMs('D', { isActive: false, consecutiveFails: 5, deadSinceDays: 0, config }, noJitter), 24 * hour)
  assert.equal(nextProbeDelayMs('D', { isActive: false, consecutiveFails: 5, deadSinceDays: 9, config }, noJitter), 72 * hour)
  assert.equal(nextProbeDelayMs('unknown', { isActive: false, consecutiveFails: 0, deadSinceDays: 0, config }, noJitter), 0)
})

test('jitter stays inside +/-25%, so installs never share a clock', () => {
  const config = DEFAULT_IER_CONFIG
  const base = 12 * 3_600_000
  for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
    const delay = nextProbeDelayMs('A', { isActive: true, consecutiveFails: 0, deadSinceDays: 0, config }, () => roll)
    assert.ok(delay >= base * 0.75 && delay <= base * 1.25, `roll ${roll} gave ${delay}`)
  }
})

// ─── Batch pacing (spec §8.3) ────────────────────────────────────────────────

test('a batch never probes two mirrors of one tracker back to back', () => {
  const due = [
    endpoint({ id: 1, indexerId: 'a', url: 'https://a1.org' }),
    endpoint({ id: 2, indexerId: 'a', url: 'https://a2.org' }),
    endpoint({ id: 3, indexerId: 'b', url: 'https://b1.org' }),
  ]
  const batch = planProbeBatch(due, {
    now: 0, config: DEFAULT_IER_CONFIG,
    lastProbeByIndexer: new Map(), isPrivate: () => false,
  })
  assert.deepEqual(batch.map(e => e.id), [1, 3])
})

test('the per-indexer floor holds across ticks', () => {
  const due = [endpoint({ id: 1, indexerId: 'a', url: 'https://a1.org' })]
  const batch = planProbeBatch(due, {
    now: 30_000, config: DEFAULT_IER_CONFIG,
    lastProbeByIndexer: new Map([['a', 0]]), isPrivate: () => false,
  })
  assert.equal(batch.length, 0, 'only 30s since the last probe of this indexer')
})

test('private trackers get their standby mirrors left alone', () => {
  const due = [
    endpoint({ id: 1, indexerId: 'priv', url: 'https://m1.org', isActive: false }),
    endpoint({ id: 2, indexerId: 'pub', url: 'https://p1.org', isActive: false }),
  ]
  const batch = planProbeBatch(due, {
    now: 0, config: DEFAULT_IER_CONFIG,
    lastProbeByIndexer: new Map(), isPrivate: id => id === 'priv',
  })
  assert.deepEqual(batch.map(e => e.id), [2])
})

test('ineligible private standbys cannot hide eligible endpoints later in the due queue', () => {
  const privateStandbys = Array.from({ length: 30 }, (_, index) => endpoint({
    id: index + 1,
    indexerId: `private-${index}`,
    url: `https://private-${index}.org`,
    isActive: false,
  }))
  const eligible = endpoint({ id: 100, indexerId: 'public', url: 'https://public.org' })
  const batch = planProbeBatch([...privateStandbys, eligible], {
    now: 0,
    config: DEFAULT_IER_CONFIG,
    lastProbeByIndexer: new Map(),
    isPrivate: id => id.startsWith('private-'),
  })
  assert.deepEqual(batch.map(e => e.id), [100])
})

test('the active endpoint of a private tracker is still probed', () => {
  const due = [endpoint({ id: 1, indexerId: 'priv', url: 'https://m1.org', isActive: true })]
  const batch = planProbeBatch(due, {
    now: 0, config: DEFAULT_IER_CONFIG,
    lastProbeByIndexer: new Map(), isPrivate: () => true,
  })
  assert.equal(batch.length, 1)
})

test('concurrency is capped', () => {
  const due = Array.from({ length: 10 }, (_, i) =>
    endpoint({ id: i + 1, indexerId: `ix${i}`, url: `https://h${i}.org` }))
  const batch = planProbeBatch(due, {
    now: 0, config: { ...DEFAULT_IER_CONFIG, maxConcurrentProbes: 3 },
    lastProbeByIndexer: new Map(), isPrivate: () => false,
  })
  assert.equal(batch.length, 3)
})

// ─── URL normalisation (spec §5.2.3) ─────────────────────────────────────────

test('one mirror spelled several ways collapses to one row', () => {
  assert.equal(normaliseEndpointUrl('https://Site.ORG/'), 'https://site.org')
  assert.equal(normaliseEndpointUrl('site.org'), 'https://site.org')
  assert.equal(normaliseEndpointUrl('http://site.org/path/'), 'http://site.org/path')
  assert.equal(normaliseEndpointUrl('https://site.org/?a=b#c'), 'https://site.org')
  assert.equal(normaliseEndpointUrl('  '), null)
  assert.equal(normaliseEndpointUrl('ftp://site.org'), null)
})

test('the Base URL pins an existing definition endpoint without changing its origin', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { initDb } = await import('../src/db.js')
  const storeModule = await import('../src/indexers/endpoints/store.js')

  const db = initDb(join(mkdtempSync(join(tmpdir(), 'ier-preference-')), 'archivist.sqlite'))
  try {
    db.prepare(`
      INSERT INTO indexers_ts (id, name, protocol, definition_id, enabled, base_url, settings, status, capabilities, tags)
      VALUES ('ix1', 'Demo', 'cardigann', 'demo', 1, 'https://chosen.org/', '{}', '{}', '{}', '[]')
    `).run()
    storeModule.seedEndpoints('ix1', ['https://default.org', 'https://chosen.org'], [], db)
    const preferred = storeModule.preferEndpoint('ix1', 'https://chosen.org/', db)

    assert.equal(preferred?.url, 'https://chosen.org')
    assert.equal(preferred?.origin, 'definition')
    assert.equal(preferred?.isPinned, true)
    assert.equal(preferred?.isActive, true)
    assert.equal(storeModule.listEndpoints('ix1', db).filter(candidate => candidate.isPinned).length, 1)
  } finally {
    db.close()
  }
})

test('host extraction survives a malformed URL', () => {
  assert.equal(hostOf('https://site.org:8080/x'), 'site.org:8080')
  assert.equal(hostOf('not a url'), 'not a url')
})

// ─── The probe ladder (spec §15, "Ladder") ───────────────────────────────────

test('the browser is used for a challenge and for nothing else', async () => {
  // This is the assertion that stops a future refactor from quietly making
  // every failure class expensive.
  const { probeEndpointResolved } = await import('../src/indexers/endpoints/resolver.js')

  const classes = [
    'dns', 'connect', 'timeout', 'rate_limited', 'auth',
    'http_error', 'parse', 'empty', 'challenge',
  ] as const

  for (const failureClass of classes) {
    const attempts: boolean[] = []
    const probe = (async (_url, _entry, opts) => {
      attempts.push(opts.allowCloudflareBypass)
      return {
        outcome: 'fail' as const,
        viaCloudflareBypass: opts.allowCloudflareBypass,
        failureClass,
        latencyMs: 5,
      }
    }) as Prober

    await probeEndpointResolved(
      endpoint({ tier: 'unknown', consecutiveFails: 1 }),
      {
        config: { id: 'ix', name: 'IX', settings: {} },
        cloudflareBypassUrl: 'http://flare:8191',
        proxyUrl: undefined,
      } as never,
      definition(),
      { allowCloudflareBypass: true, config: DEFAULT_IER_CONFIG, probe },
    )

    const usedBrowser = attempts.some(allow => allow === true)
    assert.equal(
      usedBrowser,
      failureClass === 'challenge',
      `${failureClass} ${usedBrowser ? 'used' : 'did not use'} the browser`,
    )
  }
})

test('a challenge the browser clears is tier B; one it cannot is tier D', async () => {
  const { probeEndpointResolved } = await import('../src/indexers/endpoints/resolver.js')
  const instance = {
    config: { id: 'ix', name: 'IX', settings: {} },
    cloudflareBypassUrl: 'http://flare:8191', proxyUrl: undefined,
  } as never

  const solved = await probeEndpointResolved(endpoint(), instance, definition(), {
    allowCloudflareBypass: true, config: DEFAULT_IER_CONFIG,
    probe: (async (_u, _e, opts) => opts.allowCloudflareBypass
      ? { outcome: 'ok' as const, viaCloudflareBypass: true, latencyMs: 900, rowCount: 20 }
      : { outcome: 'fail' as const, viaCloudflareBypass: false, failureClass: 'challenge' as const, latencyMs: 40 }) as Prober,
  })
  assert.equal(solved.tier, 'B')
  assert.equal(solved.requiresCloudflareBypass, true)

  const unsolved = await probeEndpointResolved(endpoint(), instance, definition(), {
    allowCloudflareBypass: true, config: DEFAULT_IER_CONFIG,
    probe: (async (_u, _e, opts) => ({
      outcome: 'fail' as const, viaCloudflareBypass: opts.allowCloudflareBypass,
      failureClass: 'challenge' as const, latencyMs: 40,
    })) as Prober,
  })
  assert.equal(unsolved.tier, 'D')
})

test('a bypass that never ran leaves the endpoint tier untouched', async () => {
  const { probeEndpointResolved } = await import('../src/indexers/endpoints/resolver.js')
  const instance = {
    config: { id: 'ix', name: 'IX', settings: {} },
    cloudflareBypassUrl: 'http://flare:8191', proxyUrl: undefined,
  } as never

  // Tier C, not B, so the §6.6 rule for a previously-B endpoint cannot be what
  // preserves the tier here.
  const result = await probeEndpointResolved(endpoint({ tier: 'C' }), instance, definition(), {
    allowCloudflareBypass: true, config: DEFAULT_IER_CONFIG,
    probe: (async (_u, _e, opts) => (opts.allowCloudflareBypass
      ? { outcome: 'fail' as const, viaCloudflareBypass: true, failureClass: 'bypass_unavailable' as const, latencyMs: 5 }
      : { outcome: 'fail' as const, viaCloudflareBypass: false, failureClass: 'challenge' as const, latencyMs: 40 })) as Prober,
  })

  assert.equal(result.tier, 'C')
  assert.notEqual(result.tier, 'D')
})

test('CloudflareBypass probe concurrency obeys its dedicated limit', async () => {
  const { probeEndpointResolved } = await import('../src/indexers/endpoints/resolver.js')
  const instance = {
    config: { id: 'ix', name: 'IX', settings: {} },
    cloudflareBypassUrl: 'http://flare:8191', proxyUrl: undefined,
  } as never
  let active = 0
  let peak = 0
  const probe = (async (_u, _e, opts) => {
    if (!opts.allowCloudflareBypass) {
      return { outcome: 'fail' as const, viaCloudflareBypass: false, failureClass: 'challenge' as const, latencyMs: 1 }
    }
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active -= 1
    return { outcome: 'ok' as const, viaCloudflareBypass: true, latencyMs: 10, rowCount: 1 }
  }) as Prober

  await Promise.all([1, 2, 3].map(id => probeEndpointResolved(
    endpoint({ id }), instance, definition(), {
      allowCloudflareBypass: true,
      config: { ...DEFAULT_IER_CONFIG, maxConcurrentCloudflareBypassProbes: 1 },
      probe,
    },
  )))
  assert.equal(peak, 1)
})

test('a working direct probe is tier A and never touches the browser', async () => {
  const { probeEndpointResolved } = await import('../src/indexers/endpoints/resolver.js')
  const attempts: boolean[] = []
  const result = await probeEndpointResolved(
    endpoint(),
    { config: { id: 'ix', name: 'IX', settings: {} }, cloudflareBypassUrl: 'http://flare:8191', proxyUrl: undefined } as never,
    definition(),
    {
      allowCloudflareBypass: true, config: DEFAULT_IER_CONFIG,
      probe: (async (_u, _e, opts) => {
        attempts.push(opts.allowCloudflareBypass)
        return { outcome: 'ok' as const, viaCloudflareBypass: false, latencyMs: 120, rowCount: 30 }
      }) as Prober,
    },
  )
  assert.equal(result.tier, 'A')
  assert.equal(result.requiresCloudflareBypass, false)
  assert.deepEqual(attempts, [false])
})

test('a browser-only endpoint keeps tier B when the browser is unavailable', async () => {
  // Demoting an endpoint because a tool is missing would lose the measurement.
  const { probeEndpointResolved } = await import('../src/indexers/endpoints/resolver.js')
  const result = await probeEndpointResolved(
    endpoint({ tier: 'B', requiresCloudflareBypass: true }),
    { config: { id: 'ix', name: 'IX', settings: {} }, cloudflareBypassUrl: undefined, proxyUrl: undefined } as never,
    definition(),
    {
      allowCloudflareBypass: true, config: DEFAULT_IER_CONFIG,
      probe: (async () => ({
        outcome: 'fail' as const, viaCloudflareBypass: false,
        failureClass: 'challenge' as const, latencyMs: 30,
      })) as Prober,
    },
  )
  assert.equal(result.tier, 'B')
})

// ─── Breaker (spec §15, "Breaker (integration)") ─────────────────────────────

test('a search that hits a challenge mid-flight comes back with failover results', async () => {
  const { createServer } = await import('node:http')
  const { initDb } = await import('../src/db.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  // Two mirrors of one indexer: the first starts healthy and then begins
  // serving a Cloudflare wall; the second stays healthy throughout.
  let goodMirrorBlocked = false
  const rows = '<table><tr class="r"><td class="t">Ubuntu 24.04</td>'
    + '<td class="dl"><a href="/dl/1.torrent">get</a></td><td class="s">42</td></tr></table>'

  const primary = createServer((_req, res) => {
    if (goodMirrorBlocked) {
      res.writeHead(503, { 'content-type': 'text/html', 'cf-ray': 'test' })
      res.end('<html><title>Just a moment...</title><div class="cf-browser-verification"></div></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(rows)
  })
  const secondary = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(rows)
  })

  await new Promise<void>(r => primary.listen(0, '127.0.0.1', r))
  await new Promise<void>(r => secondary.listen(0, '127.0.0.1', r))
  const primaryUrl = `http://127.0.0.1:${(primary.address() as { port: number }).port}`
  const secondaryUrl = `http://127.0.0.1:${(secondary.address() as { port: number }).port}`

  const dir = mkdtempSync(join(tmpdir(), 'ier-breaker-'))
  const db = initDb(join(dir, 'archivist.sqlite'))

  try {
    db.prepare(`
      INSERT INTO indexers_ts (id, name, protocol, definition_id, enabled, base_url, settings, status, capabilities, tags)
      VALUES ('ix1', 'Demo', 'cardigann', 'demo', 1, ?, '{}', '{}', '{}', '[]')
    `).run(primaryUrl)

    const storeModule = await import('../src/indexers/endpoints/store.js')
    storeModule.seedEndpoints('ix1', [primaryUrl, secondaryUrl], [], db)
    const endpoints = storeModule.listEndpoints('ix1', db)
    assert.equal(endpoints.length, 2)

    // Primary is the healthy incumbent; secondary is a viable standby.
    storeModule.updateEndpointState(endpoints[0].id, { tier: 'A', successRate7d: 1, latencyP50Ms: 20 }, db)
    storeModule.updateEndpointState(endpoints[1].id, { tier: 'A', successRate7d: 1, latencyP50Ms: 20 }, db)
    storeModule.setActiveEndpoint('ix1', endpoints[0].id, db)

    const entry: DefinitionEntry = {
      id: 'demo', name: 'Demo', description: '', language: 'en-us', type: 'public',
      links: [primaryUrl, secondaryUrl], legacyLinks: [], categories: [], settings: [],
      searchModes: ['search'],
      raw: {
        id: 'demo', name: 'Demo',
        caps: { modes: { search: ['q'] } },
        search: {
          path: '/', rows: { selector: 'tr.r' },
          fields: { title: { selector: 'td.t' }, download: { selector: 'td.dl a', attribute: 'href' }, seeders: { selector: 'td.s' } },
        },
      } as never,
    }

    const instance = {
      type: 'cardigann' as const,
      config: { id: 'ix1', name: 'Demo', enabled: true, settings: { sitelink: primaryUrl }, baseUrl: primaryUrl },
      definition: entry, cookies: {}, proxyUrl: undefined, cloudflareBypassUrl: undefined,
    } as never

    const { aggregateSearch } = await import('@torrentstack/indexer-engine')
    const { searchBreakerHooks } = await import('../src/indexers/endpoints/breaker.js')

    // Healthy: results come from the primary, no switch.
    const before = await aggregateSearch([instance], { q: 'ubuntu', categories: [] } as never, {
      timeoutMs: 5_000, hooks: searchBreakerHooks(db),
    })
    assert.equal(before.results.length, 1, 'the healthy primary returns a row')
    assert.equal(storeModule.getActiveEndpoint('ix1', db)?.url, primaryUrl)

    // The primary starts serving a bot wall.
    goodMirrorBlocked = true

    // Below the threshold the breaker counts but does not act: a single blip
    // must not move an indexer off a mirror it has been happy with.
    const first = await aggregateSearch([instance], { q: 'ubuntu', categories: [] } as never, {
      timeoutMs: 5_000, hooks: searchBreakerHooks(db),
    })
    assert.equal(first.results.length, 0)
    assert.equal(storeModule.getActiveEndpoint('ix1', db)?.url, primaryUrl, 'one failure does not switch')

    await aggregateSearch([instance], { q: 'ubuntu', categories: [] } as never, {
      timeoutMs: 5_000, hooks: searchBreakerHooks(db),
    })
    assert.equal(storeModule.getActiveEndpoint('ix1', db)?.url, primaryUrl, 'two failures do not switch')

    // The third crosses the default threshold: the breaker demotes the
    // incumbent, resolves, switches, and retries this very search.
    const third = await aggregateSearch([instance], { q: 'ubuntu', categories: [] } as never, {
      timeoutMs: 5_000, hooks: searchBreakerHooks(db),
    })

    assert.equal(third.results.length, 1, 'the search still returns results, from the failover endpoint')
    assert.equal(storeModule.getActiveEndpoint('ix1', db)?.url, secondaryUrl, 'the active endpoint switched')

    // A later healthy search clears the counter rather than leaving the
    // endpoint one blip away from tripping again.
    const recovered = await aggregateSearch([instance], { q: 'ubuntu', categories: [] } as never, {
      timeoutMs: 5_000, hooks: searchBreakerHooks(db),
    })
    assert.equal(recovered.results.length, 1)
    assert.equal(storeModule.getActiveEndpoint('ix1', db)?.consecutiveFails, 0)
  } finally {
    db.close()
    await new Promise<void>(r => primary.close(() => r()))
    await new Promise<void>(r => secondary.close(() => r()))
  }
})

// ─── Migration (spec §15, "Migration") ───────────────────────────────────────

test('an existing indexer keeps its URL as the preferred endpoint after migration', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const { applySchema } = await import('@archivist/db')

  const file = join(mkdtempSync(join(tmpdir(), 'ier-migrate-')), 'archivist.sqlite')
  const db = new BetterSqlite3(file)
  try {
    applySchema(db)

    // Rewind to before the resolver migration and plant a pre-upgrade indexer.
    db.exec('DROP TABLE IF EXISTS indexer_endpoint_session')
    db.exec('DROP TABLE IF EXISTS indexer_probe_result')
    db.exec('DROP TABLE IF EXISTS indexer_endpoint')
    db.prepare('DELETE FROM _migrations WHERE version = 32').run()
    db.prepare(`
      INSERT INTO indexers_ts (id, name, protocol, definition_id, enabled, base_url, settings, status, capabilities, tags)
      VALUES ('legacy1', 'Legacy', 'cardigann', 'demo', 1, 'https://Chosen.Mirror.ORG/', '{}', '{}', '{}', '[]')
    `).run()
    db.prepare(`
      INSERT INTO indexers_ts (id, name, protocol, definition_id, enabled, base_url, settings, status, capabilities, tags)
      VALUES ('legacy2', 'ViaSettings', 'cardigann', 'demo', 1, '', '{"sitelink":"https://from-settings.org"}', '{}', '{}', '[]')
    `).run()

    applySchema(db)

    const rows = db.prepare(
      'SELECT indexer_id, url, origin, is_pinned, is_enabled FROM indexer_endpoint ORDER BY indexer_id',
    ).all() as Array<{ indexer_id: string; url: string; origin: string; is_pinned: number; is_enabled: number }>

    assert.equal(rows.length, 2)
    // Normalised the same way the resolver does, so the definition's own link
    // resolves to this row rather than seeding a duplicate.
    assert.deepEqual(rows[0], {
      indexer_id: 'legacy1', url: 'https://chosen.mirror.org', origin: 'user', is_pinned: 1, is_enabled: 1,
    })
    assert.equal(rows[1].indexer_id, 'legacy2')
    assert.equal(rows[1].url, 'https://from-settings.org')
    assert.equal(rows[1].is_pinned, 1, 'the configured URL remains preferred while healthy')
  } finally {
    db.close()
  }
})

// ─── The API surface actually exists, and answers immediately ────────────────

test('the endpoint routes are registered, and resolve is not shadowed', async () => {
  // A 404 from these paths means the running server predates the resolver, so
  // this pins the contract the UI depends on.
  const { createIndexersRouter } = await import('../src/indexers/routes.js')
  const router = createIndexersRouter() as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>
  }
  const layers = router.stack.filter(layer => layer.route)
  const registered = new Set(
    layers.flatMap(layer => Object.keys(layer.route!.methods)
      .filter(method => layer.route!.methods[method])
      .map(method => `${method.toUpperCase()} ${layer.route!.path}`)),
  )

  for (const route of [
    'GET /:id/endpoints',
    'POST /:id/endpoints',
    'DELETE /:id/endpoints/:endpointId',
    'PATCH /:id/endpoints/:endpointId',
    'POST /:id/endpoints/resolve',
    'POST /:id/endpoints/:endpointId/probe',
    'GET /:id/endpoints/:endpointId/history',
    'GET /endpoints/config',
    'PUT /endpoints/config',
  ]) {
    assert.ok(registered.has(route), `${route} is not registered`)
  }

  // Registration order matters: the specific paths must come before the
  // generic '/:id' handlers or Express never reaches them.
  const paths = layers.map(layer => layer.route!.path)
  assert.ok(
    paths.indexOf('/:id/endpoints/resolve') < paths.indexOf('/:id'),
    'the resolve route must be registered before the catch-all /:id',
  )
})

// ─── The breaker must not punish an ordinary empty search (spec §14.3) ───────

test('a search that completes but matches nothing never faults the endpoint', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { initDb } = await import('../src/db.js')
  const { searchBreakerHooks } = await import('../src/indexers/endpoints/breaker.js')
  const storeModule = await import('../src/indexers/endpoints/store.js')

  const db = initDb(join(mkdtempSync(join(tmpdir(), 'ier-empty-')), 'archivist.sqlite'))
  try {
    db.prepare(`
      INSERT INTO indexers_ts (id, name, protocol, definition_id, enabled, base_url, settings, status, capabilities, tags)
      VALUES ('ix1', 'Demo', 'cardigann', 'demo', 1, 'https://a.org', '{}', '{}', '{}', '[]')
    `).run()
    storeModule.seedEndpoints('ix1', ['https://a.org'], [], db)
    const [endpoint] = storeModule.listEndpoints('ix1', db)
    storeModule.updateEndpointState(endpoint.id, { tier: 'A', consecutiveFails: 2 }, db)
    storeModule.setActiveEndpoint('ix1', endpoint.id, db)

    const instance = {
      type: 'cardigann' as const,
      config: { id: 'ix1', name: 'Demo', enabled: true, settings: {}, baseUrl: 'https://a.org' },
      definition: null, cookies: {}, proxyUrl: undefined,
    } as never

    const hooks = searchBreakerHooks(db)
    const query = { q: 'something obscure', categories: [] } as never

    // A real successful search repairs stale probe health immediately.
    storeModule.updateEndpointState(endpoint.id, { tier: 'C', consecutiveFails: 2 }, db)
    await hooks.onIndexerOutcome!({
      instance, query, results: [{}] as never, error: null,
      diagnostics: { httpStatus: 200, headers: {}, bodySample: '<tr>', rowsMatched: 1, rowCount: 1 },
    })
    let after = storeModule.getActiveEndpoint('ix1', db)!
    assert.equal(after.tier, 'A', 'successful live traffic restores direct health')
    assert.equal(after.consecutiveFails, 0)

    // The page loaded and the selectors matched; the query simply found nothing.
    storeModule.updateEndpointState(endpoint.id, { consecutiveFails: 2 }, db)
    await hooks.onIndexerOutcome!({
      instance, query, results: [], error: null,
      diagnostics: { httpStatus: 200, headers: {}, bodySample: '<tr>', rowsMatched: 20, rowCount: 0 },
    })
    after = storeModule.getActiveEndpoint('ix1', db)!
    assert.equal(after.consecutiveFails, 0, 'an empty result clears the counter rather than raising it')
    assert.equal(after.tier, 'A', 'and never demotes the endpoint')

    // Selectors matched nothing at all. On a probe that means drift; on a
    // search it still must not take the endpoint down mid-scan.
    storeModule.updateEndpointState(endpoint.id, { consecutiveFails: 2 }, db)
    await hooks.onIndexerOutcome!({
      instance, query, results: [], error: null,
      diagnostics: { httpStatus: 200, headers: {}, bodySample: '<html></html>', rowsMatched: 0 },
    })
    after = storeModule.getActiveEndpoint('ix1', db)!
    assert.equal(after.tier, 'A')
    assert.ok(after.consecutiveFails < 3, 'a parse miss on the search path must not trip the breaker')

    // A Torznab indexer reports no diagnostics at all — no evidence, no verdict.
    storeModule.updateEndpointState(endpoint.id, { consecutiveFails: 2 }, db)
    await hooks.onIndexerOutcome!({ instance, query, results: [], error: null, diagnostics: {} })
    after = storeModule.getActiveEndpoint('ix1', db)!
    assert.equal(after.consecutiveFails, 2, 'an unobserved search changes nothing')

    // A real transport failure still counts, and still trips at the threshold.
    for (let i = 0; i < 3; i += 1) {
      await hooks.onIndexerOutcome!({
        instance, query, results: [], error: new Error('boom'),
        diagnostics: { transportCode: 'ECONNREFUSED', transportMessage: 'refused' },
      })
    }
    after = storeModule.getActiveEndpoint('ix1', db)!
    assert.equal(after.tier, 'C', 'a genuinely unreachable endpoint is still demoted')
  } finally {
    db.close()
  }
})

test('a keywordless browse that returns nothing is retried with a term before blaming the definition', async () => {
  const { probeEndpointResolved } = await import('../src/indexers/endpoints/resolver.js')
  const instance = {
    config: { id: 'ix', name: 'IX', settings: {} },
    cloudflareBypassUrl: undefined, proxyUrl: undefined,
  } as never

  // A tracker that requires a keyword: the browse probe matches no rows, the
  // keyword probe works. Concluding "drift" from the first would be wrong.
  const modes: Array<'browse' | 'search'> = []
  const working = await probeEndpointResolved(endpoint(), instance, definition(), {
    allowCloudflareBypass: false, config: DEFAULT_IER_CONFIG,
    probe: (async (_u, _e, opts) => {
      modes.push(opts.mode)
      return opts.mode === 'search'
        ? { outcome: 'ok' as const, viaCloudflareBypass: false, latencyMs: 80, rowCount: 25 }
        : { outcome: 'fail' as const, viaCloudflareBypass: false, failureClass: 'parse' as const, latencyMs: 60 }
    }) as Prober,
  })
  assert.deepEqual(modes, ['browse', 'search'])
  assert.equal(working.tier, 'A', 'a site that answers a keyword search is working')

  // Both come back empty: now the selector really is the suspect.
  const drifted = await probeEndpointResolved(endpoint(), instance, definition(), {
    allowCloudflareBypass: false, config: DEFAULT_IER_CONFIG,
    probe: (async () => ({
      outcome: 'fail' as const, viaCloudflareBypass: false,
      failureClass: 'parse' as const, latencyMs: 60,
    })) as Prober,
  })
  assert.equal(drifted.tier, 'C')
  assert.equal(drifted.failureClass, 'parse')
})

test('a hard search deadline includes endpoint recovery hooks when requested', async () => {
  const { aggregateSearch } = await import('@torrentstack/indexer-engine')
  const instance = {
    type: 'cardigann',
    config: { id: 'deadline', name: 'Deadline', enabled: true, settings: {} },
  } as never
  const started = Date.now()
  await aggregateSearch([instance], { q: 'music deadline' } as never, {
    timeoutMs: 25,
    boundHooksToTimeout: true,
    hooks: {
      onIndexerOutcome: async () => {
        await new Promise(resolve => setTimeout(resolve, 250))
        return []
      },
    },
  })
  assert.ok(Date.now() - started < 150, 'a recovery probe must not escape the caller’s overall Music budget')
})

test('indexer results are emitted progressively before the slowest indexer completes', async () => {
  const { aggregateSearch } = await import('@torrentstack/indexer-engine')
  const instances = ['fast', 'slow'].map(id => ({
    type: 'cardigann',
    config: { id, name: id, enabled: true, settings: {} },
  })) as never
  const release = (id: string) => ({
    guid: id, title: `${id} release`, indexerId: id, indexerName: id,
    type: 'torrent', category: 3000, categories: [3000], publishDate: Date.now(),
    size: 1, files: null, grabs: null, seeders: 4, leechers: 0,
    infoHash: id.padEnd(40, '0'), magnetUrl: null, downloadUrl: `https://${id}.invalid/release.torrent`,
    infoUrl: null, nzbUrl: null, usenetDate: null, age: null,
    imdbId: null, tmdbId: null, tvdbId: null, indexerFlags: [],
  }) as never

  let resolveFirst!: (titles: string[]) => void
  const firstBatch = new Promise<string[]>(resolve => { resolveFirst = resolve })
  let completed = false
  const aggregatePromise = aggregateSearch(instances, { q: 'progressive', categories: [3000] } as never, {
    hooks: {
      onIndexerOutcome: async outcome => {
        await new Promise(resolve => setTimeout(resolve, outcome.instance.config.id === 'fast' ? 5 : 100))
        return [release(outcome.instance.config.id)]
      },
    },
    onIndexerResults: results => resolveFirst(results.map(result => result.title)),
  }).then(result => {
    completed = true
    return result
  })

  assert.deepEqual(await firstBatch, ['fast release'])
  assert.equal(completed, false, 'the first batch must not wait for the slow indexer')
  const aggregate = await aggregatePromise
  assert.deepEqual(aggregate.results.map(result => result.title).sort(), ['fast release', 'slow release'])
})
