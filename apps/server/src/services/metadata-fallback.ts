import { recordEvent } from '../system/event-store.js'
import { blockRelease } from './acquisition-decisions.js'
import { resetAcquisitionsForHash } from './acquisition-state.js'
import { enqueueItemSearch } from './item-searches.js'
import { recordMusicSwarmOutcome } from './music-swarm.js'

const MUSIC_METADATA_FALLBACK_LIMIT = 3

export interface MetadataFallbackResult {
  reset: number
  fallbackQueued: boolean
  itemSearchId: number | null
}

/** Retire a metadata-dead torrent and durably advance a Music subject. */
export function handleTorrentMetadataFailure(input: {
  infoHash: string
  releaseTitle: string
  torrentId: string
  error: string
}): MetadataFallbackResult {
  const fallback = recordMusicSwarmOutcome(input.infoHash, 'metadata-failed')
  blockRelease({
    infoHash: input.infoHash,
    releaseTitle: input.releaseTitle,
    reason: 'magnet metadata could not be retrieved before timeout',
    tabId: fallback?.libraryId,
    mediaType: fallback ? 'music' : null,
    subjectType: fallback?.subjectType,
    subjectId: fallback?.subjectId,
  })
  const reset = resetAcquisitionsForHash(input.infoHash)
  recordEvent({
    category: 'acquisition',
    action: 'release-retired',
    severity: 'warn',
    subjectType: 'torrent',
    subjectId: input.torrentId,
    message: `Retired stalled metadata release and reset ${reset} acquisition record(s)`,
    data: { infoHash: input.infoHash, reason: input.error, reset },
  })

  if (!fallback || fallback.failedAttempts > MUSIC_METADATA_FALLBACK_LIMIT) {
    return { reset, fallbackQueued: false, itemSearchId: null }
  }
  const search = enqueueItemSearch({
    libraryId: fallback.libraryId,
    mediaType: 'music',
    subjectType: fallback.subjectType,
    subjectId: fallback.subjectId,
    mode: 'auto',
  })
  recordEvent({
    category: 'acquisition',
    action: 'music-metadata-fallback-queued',
    severity: 'warn',
    subjectType: fallback.subjectType,
    subjectId: String(fallback.subjectId),
    message: `Queued Music fallback ${fallback.failedAttempts} of ${MUSIC_METADATA_FALLBACK_LIMIT} after metadata timeout`,
    data: { failedInfoHash: input.infoHash, itemSearchId: search.id },
  })
  return { reset, fallbackQueued: true, itemSearchId: search.id }
}
