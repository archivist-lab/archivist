import axios from 'axios'

export type Provider = 'tmdb' | 'tvdb' | 'fanart' | 'skyhook'

interface GateState {
  active: number
  nextAt: number
  consecutiveFailures: number
  openUntil: number
  waiters: Array<() => void>
}

const states = new Map<Provider, GateState>()

function numberEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback
}

function settings(provider: Provider): { concurrency: number; spacingMs: number } {
  const key = provider.toUpperCase()
  return {
    concurrency: numberEnv(`ARCHIVIST_${key}_CONCURRENCY`, provider === 'tmdb' ? 4 : 2, 1, 20),
    spacingMs: numberEnv(`ARCHIVIST_${key}_MIN_INTERVAL_MS`, provider === 'tmdb' ? 25 : 100, 0, 60_000),
  }
}

function state(provider: Provider): GateState {
  let current = states.get(provider)
  if (!current) {
    current = { active: 0, nextAt: 0, consecutiveFailures: 0, openUntil: 0, waiters: [] }
    states.set(provider, current)
  }
  return current
}

function abortError(provider: Provider): Error {
  return new Error(`${provider.toUpperCase()} request cancelled`)
}

async function acquire(provider: Provider, signal?: AbortSignal): Promise<() => void> {
  const current = state(provider)
  const { concurrency, spacingMs } = settings(provider)
  while (current.active >= concurrency) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal?.removeEventListener('abort', abort); resolve() }
      const abort = () => {
        const index = current.waiters.indexOf(wake)
        if (index >= 0) current.waiters.splice(index, 1)
        reject(abortError(provider))
      }
      current.waiters.push(wake)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  if (signal?.aborted) throw abortError(provider)
  current.active++
  const delay = Math.max(0, current.nextAt - Date.now())
  current.nextAt = Math.max(Date.now(), current.nextAt) + spacingMs
  if (delay > 0) {
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
        const timer = setTimeout(finish, delay)
        const abort = () => { clearTimeout(timer); reject(abortError(provider)) }
        signal?.addEventListener('abort', abort, { once: true })
      })
    } catch (error) {
      current.active = Math.max(0, current.active - 1)
      current.waiters.shift()?.()
      throw error
    }
  }
  return () => {
    current.active = Math.max(0, current.active - 1)
    current.waiters.shift()?.()
  }
}

function transient(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false
  const status = error.response?.status
  return status === 408 || status === 429 || (typeof status === 'number' && status >= 500)
    || ['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED'].includes(error.code ?? '')
}

function delay(ms: number, provider: Provider, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(provider))
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : abortError(provider))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Bounded provider concurrency, minimum request spacing, and a small circuit breaker. */
export async function withProviderLimit<T>(provider: Provider, request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const current = state(provider)
  if (current.openUntil > Date.now()) {
    throw new Error(`${provider.toUpperCase()} circuit is temporarily open after repeated transient failures`)
  }
  const release = await acquire(provider, signal)
  try {
    const result = await request()
    current.consecutiveFailures = 0
    current.openUntil = 0
    return result
  } catch (error) {
    if (transient(error)) {
      current.consecutiveFailures++
      if (current.consecutiveFailures >= 5) {
        current.openUntil = Date.now() + numberEnv('ARCHIVIST_PROVIDER_CIRCUIT_OPEN_MS', 30_000, 1_000, 15 * 60_000)
      }
    } else {
      current.consecutiveFailures = 0
    }
    throw error
  } finally {
    release()
  }
}

/** Retry-After aware exponential delay with bounded jitter. */
export function providerRetryDelay(error: unknown, attempt: number): number {
  if (axios.isAxiosError(error)) {
    const value = error.response?.headers?.['retry-after']
    if (value != null) {
      const seconds = Number(value)
      if (Number.isFinite(seconds)) return Math.min(120_000, Math.max(0, seconds * 1000))
      const date = Date.parse(String(value))
      if (Number.isFinite(date)) return Math.min(120_000, Math.max(0, date - Date.now()))
    }
  }
  const base = Math.min(30_000, 250 * 2 ** Math.max(0, attempt - 1))
  return base + Math.floor(Math.random() * Math.max(1, Math.floor(base / 4)))
}

/** Apply the shared gate and retry transient failures without multiplying retries at call sites. */
export async function withProviderRetry<T>(
  provider: Provider,
  request: () => Promise<T>,
  signal?: AbortSignal,
  attempts = 3,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      return await withProviderLimit(provider, request, signal)
    } catch (error) {
      lastError = error
      if (signal?.aborted || attempt >= attempts || !transient(error)) throw error
      await delay(providerRetryDelay(error, attempt), provider, signal)
    }
  }
  throw lastError
}


export function providerLimiterStatus(): Array<{
  provider: Provider
  active: number
  waiting: number
  consecutiveFailures: number
  circuitOpenUntil: string | null
}> {
  return (['tmdb', 'tvdb', 'fanart', 'skyhook'] as Provider[]).map(provider => {
    const current = state(provider)
    return {
      provider,
      active: current.active,
      waiting: current.waiters.length,
      consecutiveFailures: current.consecutiveFailures,
      circuitOpenUntil: current.openUntil > Date.now() ? new Date(current.openUntil).toISOString() : null,
    }
  })
}
