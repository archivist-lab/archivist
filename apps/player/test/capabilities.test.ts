import { describe, expect, test, vi, beforeEach } from 'vitest'

/**
 * Browser capability detection and the direct-play negotiation.
 *
 * jsdom's canPlayType answers '' for everything, so each test stubs it to
 * impersonate a real browser. The module caches its answer, hence the
 * resetModules + dynamic import.
 */

/** Impersonates a browser by deciding which MIME types it admits to. */
function stubBrowser(accept: (mime: string) => boolean) {
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation(function (mime: string) {
    return accept(mime) ? 'probably' : ''
  } as HTMLMediaElement['canPlayType'])
}

/**
 * A browser accepts a MIME type when it knows the container AND every codec
 * named in it. Matching on substrings instead would let 'video/mp4' wave
 * through an HEVC probe, which is exactly the confusion under test.
 */
const browser = (containers: string[], codecs: string[]) => (mime: string) => {
  const [container] = mime.split(';')
  if (!containers.includes(container.trim())) return false
  const named = /codecs="([^"]+)"/.exec(mime)?.[1]
  return !named || codecs.some(codec => named.startsWith(codec))
}

const safari = browser(
  ['video/mp4', 'audio/mp4', 'audio/mpeg', 'video/quicktime'],
  ['avc1', 'hvc1', 'hev1', 'mp4a', 'ac-3', 'ec-3', 'mp3'],
)
const chrome = browser(
  ['video/mp4', 'video/webm', 'video/x-matroska', 'audio/mp4', 'audio/webm', 'audio/mpeg', 'audio/ogg'],
  ['avc1', 'vp8', 'vp09', 'av01', 'mp4a', 'opus', 'vorbis', 'flac', 'mp3'],
)

async function load() {
  vi.resetModules()
  return import('../src/lib/capabilities.js')
}

beforeEach(() => { localStorage.clear() })

describe('detectCapabilities', () => {
  test('Safari reports HEVC; Chrome does not', async () => {
    stubBrowser(safari)
    const onSafari = (await load()).detectCapabilities()
    expect(onSafari?.videoCodecs).toContain('hevc')
    expect(onSafari?.videoCodecs).toContain('h264')

    stubBrowser(chrome)
    const onChrome = (await load()).detectCapabilities()
    expect(onChrome?.videoCodecs).not.toContain('hevc')
    expect(onChrome?.videoCodecs).toEqual(expect.arrayContaining(['h264', 'vp8', 'vp9', 'av1']))
  })

  test('codec names match the ones ffprobe reports, or the server cannot compare them', async () => {
    stubBrowser(chrome)
    const caps = (await load()).detectCapabilities()!
    for (const codec of [...caps.videoCodecs, ...caps.audioCodecs]) {
      expect(codec).toMatch(/^[a-z0-9]+$/)
    }
    expect(caps.audioCodecs).toContain('aac')
  })

  test('a browser that answers nothing yields no capabilities, not empty ones', async () => {
    stubBrowser(() => false)
    expect((await load()).detectCapabilities()).toBeNull()
  })

  test('the client id is stable across calls and reloads', async () => {
    stubBrowser(chrome)
    const first = (await load()).detectCapabilities()!.clientId
    const second = (await load()).detectCapabilities()!.clientId
    expect(second).toBe(first)
    expect(first.length).toBeLessThanOrEqual(120)
  })

  test('the player does not claim segmented streaming it has no client for', async () => {
    stubBrowser(chrome)
    const caps = (await load()).detectCapabilities()!
    expect(caps.supportsSegmentedStreaming).toBe(false)
    expect(caps.subtitleCodecs).toEqual(['webvtt'])
  })
})

describe('directPlayViable', () => {
  const sdkReturning = (mode: string, reasons: string[]) => ({
    playbackPlan: vi.fn().mockResolvedValue({ mode, reasons }),
  })

  test('a direct plan is viable', async () => {
    stubBrowser(safari)
    const { directPlayViable } = await load()
    const sdk = sdkReturning('direct', ['direct-compatible'])
    await expect(directPlayViable(sdk as never, 'films', 1)).resolves.toBe(true)
  })

  test('an unsupported codec is not viable', async () => {
    stubBrowser(chrome)
    const { directPlayViable } = await load()
    const sdk = sdkReturning('transcode', ['video-unsupported', 'segmented-streaming-unavailable'])
    await expect(directPlayViable(sdk as never, 'films', 1)).resolves.toBe(false)
  })

  test('an unrecognised container alone still attempts direct play', async () => {
    // Browsers under-report Matroska. Trusting that would transcode an entire
    // MKV library; attempting direct costs one recoverable failed load.
    stubBrowser(chrome)
    const { directPlayViable } = await load()
    const sdk = sdkReturning('transcode', ['container-unsupported', 'segmented-streaming-unavailable'])
    await expect(directPlayViable(sdk as never, 'films', 1)).resolves.toBe(true)
  })

  test('a container complaint alongside a codec complaint is not tolerated', async () => {
    stubBrowser(chrome)
    const { directPlayViable } = await load()
    const sdk = sdkReturning('transcode', ['container-unsupported', 'audio-codec-unsupported'])
    await expect(directPlayViable(sdk as never, 'films', 1)).resolves.toBe(false)
  })

  test('no answer is null, so the caller can fall back rather than guess', async () => {
    stubBrowser(chrome)
    const { directPlayViable } = await load()
    const failing = { playbackPlan: vi.fn().mockRejectedValue(new Error('404')) }
    await expect(directPlayViable(failing as never, 'films', 1)).resolves.toBeNull()

    stubBrowser(() => false)
    const { directPlayViable: undetectable } = await load()
    const unused = { playbackPlan: vi.fn() }
    await expect(undetectable(unused as never, 'films', 1)).resolves.toBeNull()
    expect(unused.playbackPlan).not.toHaveBeenCalled()
  })
})
