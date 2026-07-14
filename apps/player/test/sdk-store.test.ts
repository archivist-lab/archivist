import { describe, expect, it, vi } from 'vitest'
import { ArchivistSdk, clearSdkCache, PlayerSdkError } from '../src/lib/sdk.js'
import { playerStore } from '../src/lib/store.js'

const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Conflict',
  headers: new Headers({ 'x-request-id': 'request-header' }),
  json: async () => body,
}) as Response

describe('SDK and store', () => {
  it('deduplicates concurrent reads and clears its bounded cache', async () => {
    clearSdkCache()
    const fetch = vi.fn(async () => response({ status: 'ok' }))
    vi.stubGlobal('fetch', fetch)
    const sdk = new ArchivistSdk({ url: '', apiKey: '' })
    await Promise.all([sdk.health(), sdk.health()])
    expect(fetch).toHaveBeenCalledOnce()
    clearSdkCache()
    await sdk.health()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a request whose only subscriber was aborted', async () => {
    clearSdkCache()
    const fetch = vi.fn((_url: string, options?: RequestInit) => new Promise<Response>((resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      window.setTimeout(() => resolve(response({ status: 'ok' })), 5)
    }))
    vi.stubGlobal('fetch', fetch)
    const sdk = new ArchivistSdk({ url: '', apiKey: '' })
    const first = new AbortController()
    const cancelled = sdk.bootstrap('default', first.signal)
    first.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    const second = await sdk.bootstrap('default', new AbortController().signal)
    expect(second).toEqual({ status: 'ok' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('maps typed API errors and preserves conflict context', async () => {
    clearSdkCache()
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code: 'PLAYER_PREFERENCES_CONFLICT', message: 'Changed', requestId: 'request-body' }, current: { revision: 2 } }, 409)))
    const sdk = new ArchivistSdk({ url: '', apiKey: '' })
    await expect(sdk.updatePreferences({} as never)).rejects.toMatchObject<PlayerSdkError>({ status: 409, code: 'PLAYER_PREFERENCES_CONFLICT', requestId: 'request-body' })
  })

  it('updates modal state deterministically', () => {
    playerStore.dispatch({ type: 'MODAL_OPENED', id: 'audio' })
    playerStore.dispatch({ type: 'MODAL_OPENED', id: 'subtitles' })
    expect(playerStore.getState().modalStack.slice(-2)).toEqual(['audio', 'subtitles'])
    playerStore.dispatch({ type: 'MODAL_CLOSED' })
    expect(playerStore.getState().modalStack.at(-1)).toBe('audio')
    playerStore.dispatch({ type: 'MODAL_CLOSED', id: 'audio' })
  })
})
