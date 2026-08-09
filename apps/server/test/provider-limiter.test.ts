import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { AxiosError } from 'axios'
import { withProviderRetry } from '../src/shared/provider-limiter.js'

const originalInterval = process.env.ARCHIVIST_TMDB_MIN_INTERVAL_MS

afterEach(() => {
  if (originalInterval === undefined) delete process.env.ARCHIVIST_TMDB_MIN_INTERVAL_MS
  else process.env.ARCHIVIST_TMDB_MIN_INTERVAL_MS = originalInterval
})

function providerError(status: number, retryAfter = '0'): AxiosError {
  return new AxiosError('provider unavailable', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    statusText: String(status),
    headers: { 'retry-after': retryAfter },
    config: {} as never,
    data: null,
  })
}

test('shared provider retry retries transient responses and returns the eventual result', async () => {
  process.env.ARCHIVIST_TMDB_MIN_INTERVAL_MS = '0'
  let calls = 0
  const result = await withProviderRetry('tmdb', async () => {
    calls++
    if (calls < 3) throw providerError(503)
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
})

test('shared provider retry does not retry permanent client errors', async () => {
  process.env.ARCHIVIST_TMDB_MIN_INTERVAL_MS = '0'
  let calls = 0
  await assert.rejects(withProviderRetry('tmdb', async () => {
    calls++
    throw providerError(404)
  }), /provider unavailable/)
  assert.equal(calls, 1)
})

test('shared provider retry aborts while waiting for Retry-After', async () => {
  process.env.ARCHIVIST_TMDB_MIN_INTERVAL_MS = '0'
  const controller = new AbortController()
  const request = withProviderRetry('tmdb', async () => {
    throw providerError(429, '10')
  }, controller.signal)
  setTimeout(() => controller.abort(new Error('test cancellation')), 10)
  await assert.rejects(request, /test cancellation/)
})
