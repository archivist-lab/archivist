import {
  PLAYER_CAPABILITY_SCHEMA_VERSION,
  type PlayerClientCapabilities,
  type PlayerPlaybackPlan,
  type PlayerPlaybackPlanRequest,
} from '@archivist/contracts'

/**
 * What this browser can actually decode.
 *
 * The server used to answer this with a hardcoded list that assumed no browser
 * plays HEVC. That is wrong for Safari, iOS, iPadOS and tvOS — all of which
 * decode HEVC natively — so an HEVC library was transcoded in software for
 * clients that could have direct-played every file. Asking the browser is both
 * more accurate and self-maintaining as browsers gain codecs.
 *
 * `canPlayType` is the right probe here because direct play assigns the file to
 * `video.src` as a progressive download; MediaSource support is a different
 * question and would over-report. It answers 'probably', 'maybe' or '' — only
 * the empty string is a no. 'maybe' is treated as yes deliberately: an
 * optimistic guess costs one failed load, which the player already recovers
 * from by switching to the transcode, whereas a pessimistic one costs a
 * needless transcode on every single play.
 */

/** ffprobe codec_name → the MIME types that would carry it. */
const VIDEO_PROBES: Record<string, string[]> = {
  h264: ['video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.42E01E"'],
  hevc: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
  vp8: ['video/webm; codecs="vp8"'],
  vp9: ['video/webm; codecs="vp09.00.10.08"', 'video/mp4; codecs="vp09.00.10.08"'],
  av1: ['video/mp4; codecs="av01.0.05M.08"', 'video/webm; codecs="av01.0.05M.08"'],
}

const AUDIO_PROBES: Record<string, string[]> = {
  aac: ['audio/mp4; codecs="mp4a.40.2"'],
  mp3: ['audio/mpeg', 'audio/mp4; codecs="mp3"'],
  opus: ['audio/webm; codecs="opus"', 'audio/mp4; codecs="opus"'],
  vorbis: ['audio/webm; codecs="vorbis"'],
  flac: ['audio/mp4; codecs="flac"', 'audio/ogg; codecs="flac"'],
  ac3: ['audio/mp4; codecs="ac-3"'],
  eac3: ['audio/mp4; codecs="ec-3"'],
}

/**
 * Container names as ffprobe reports them (the server splits its comma-joined
 * `format_name` and aliases mp4/mov for us, so probing 'mp4' covers both).
 */
const CONTAINER_PROBES: Record<string, string[]> = {
  mp4: ['video/mp4; codecs="avc1.640028"', 'video/mp4'],
  webm: ['video/webm; codecs="vp8"', 'video/webm'],
  matroska: ['video/x-matroska; codecs="avc1.640028"', 'video/x-matroska'],
}

const CLIENT_ID_KEY = 'archivist.player.clientId'

function clientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY)
    if (existing) return existing.slice(0, 120)
    const generated = typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `player-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    localStorage.setItem(CLIENT_ID_KEY, generated)
    return generated
  } catch {
    // Private mode, or storage disabled. A per-load id is still valid.
    return `player-${Date.now().toString(36)}`
  }
}

function supported(probe: (mime: string) => string, mimes: string[]): boolean {
  return mimes.some(mime => {
    try { return probe(mime) !== '' } catch { return false }
  })
}

let cached: PlayerClientCapabilities | null = null

/** Detects and caches this browser's capabilities. Cheap after the first call. */
export function detectCapabilities(): PlayerClientCapabilities | null {
  if (cached) return cached
  if (typeof document === 'undefined') return null
  const video = document.createElement('video')
  if (typeof video.canPlayType !== 'function') return null
  const probe = (mime: string) => video.canPlayType(mime)

  const pick = (table: Record<string, string[]>) =>
    Object.entries(table).filter(([, mimes]) => supported(probe, mimes)).map(([name]) => name)

  const videoCodecs = pick(VIDEO_PROBES)
  const audioCodecs = pick(AUDIO_PROBES)
  // A browser that reports nothing at all is one whose answers we cannot use;
  // the caller falls back to the server's own guess.
  if (!videoCodecs.length || !audioCodecs.length) return null

  cached = {
    version: PLAYER_CAPABILITY_SCHEMA_VERSION,
    clientId: clientId(),
    containers: pick(CONTAINER_PROBES),
    videoCodecs,
    audioCodecs,
    // Text subtitles are rendered as WebVTT <track>s; anything bitmap has to be
    // burned in, which the server decides from this.
    subtitleCodecs: ['webvtt'],
    hdrModes: ['sdr'],
    maxWidth: null,
    maxHeight: null,
    maxVideoBitrate: null,
    supportsRemux: false,
    // This player assigns a single URL to <video>; it has no HLS/DASH client.
    supportsSegmentedStreaming: false,
  }
  return cached
}

/**
 * Asks the server whether this browser can direct-play an item, given what it
 * just said it can decode.
 *
 * Returns null when there is no answer to be had — an older server, a network
 * blip, or a browser that would not answer the probes. Null rather than a
 * guess, so the caller falls back to the server's coarse `directPlayable` flag
 * at the moment it decides, instead of this function having to guess at what
 * the caller knows yet.
 */
export async function directPlayViable(
  sdk: { playbackPlan: (type: 'films' | 'episodes', id: number, body: PlayerPlaybackPlanRequest) => Promise<PlayerPlaybackPlan> },
  type: 'films' | 'episodes',
  id: number,
): Promise<boolean | null> {
  const capabilities = detectCapabilities()
  if (!capabilities) return null
  try {
    const plan = await sdk.playbackPlan(type, id, { capabilities })
    if (plan.mode === 'direct') return true
    return !plan.reasons.some(reason => !TOLERATED_REASONS.has(reason))
  } catch {
    return null
  }
}

/**
 * Reasons that must not, on their own, send a stream to the transcoder.
 *
 * `segmented-streaming-unavailable` is informational: this player seeks by
 * reloading, so it never wanted a manifest.
 *
 * `container-unsupported` is deliberate caution. Direct play today ignores the
 * container entirely, and browsers are vague about Matroska — `canPlayType`
 * commonly answers '' for a container it will in fact play. Trusting that
 * answer would transcode an entire MKV library. Attempting direct play costs
 * one failed load, which the player already recovers from; guessing wrong the
 * other way costs a CPU transcode on every play, forever.
 */
const TOLERATED_REASONS = new Set(['container-unsupported', 'segmented-streaming-unavailable'])
