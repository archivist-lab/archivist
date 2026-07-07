import { createLogger } from '@archivist/core'
import type { BridgeSearchResult } from '../services/indexer-bridge.js'
import { recordEvent } from '../system/event-store.js'
import { parseRelease, type ParsedRelease } from '../release-pipeline/parser.js'
import { identifyRelease } from '../release-pipeline/identifier.js'
import {
  decideForSubject,
  clearTabCache,
  type IdentifiedRelease,
  type QualityOverrides,
} from '../release-pipeline/subject-decisions.js'
import type { SubjectRef } from '../release-pipeline/title-index.js'

const logger = createLogger('ReleasePipeline')

export interface BatchOutcome {
  considered: number
  parsed: number
  identified: number
  unmatched: number
  grabbed: number
  rejected: number
  errors: number
}

interface ParsedReleasePair {
  release: BridgeSearchResult
  parsed: ParsedRelease
}

/**
 * Parse-first release pipeline. For each raw release in the batch:
 *   1. Parse the title into structured form
 *   2. Identify the monitored subject via the in-memory title index
 *   3. Group identified releases by subject
 *   4. Run the per-subject decision/grab function once per subject
 *
 * O(releases) parses + O(releases) hashmap lookups + O(unique subjects) DB
 * fetches. Replaces the old O(monitored × releases) string-includes loop.
 */
export async function processReleaseBatch(results: BridgeSearchResult[], overrides?: QualityOverrides): Promise<BatchOutcome> {
  const outcome: BatchOutcome = {
    considered: results.length,
    parsed: 0,
    identified: 0,
    unmatched: 0,
    grabbed: 0,
    rejected: 0,
    errors: 0,
  }
  if (results.length === 0) return outcome


  // Step 1+2: parse every release, identify each, group by subject
  const grouped = new Map<string, { subject: SubjectRef; candidates: IdentifiedRelease[] }>()
  for (const release of results) {
    let parsed: ParsedRelease
    try {
      parsed = parseRelease(release.title)
      outcome.parsed++
    } catch (err) {
      outcome.errors++
      logger.debug(`Parse failed for "${release.title}": ${err}`)
      continue
    }

    const ident = identifyRelease(parsed)
    if (!ident) {
      outcome.unmatched++
      continue
    }
    outcome.identified++

    const key = `${ident.subject.tabId}:${ident.subject.subjectType}:${ident.subject.subjectId}`
    const group = grouped.get(key)
    const ir: IdentifiedRelease = {
      release: {
        guid: release.guid,
        title: release.title,
        downloadUrl: release.downloadUrl,
        size: release.size,
        seeders: release.seeders,
        leechers: release.leechers,
        publishDate: release.publishDate,
        indexerName: release.indexerName,
        indexerPriority: release.indexerPriority,
      },
      parsed,
    }
    if (group) group.candidates.push(ir)
    else grouped.set(key, { subject: ident.subject, candidates: [ir] })
  }

  // Step 3+4: run decisions per subject
  for (const { subject, candidates } of grouped.values()) {
    try {
      const result = await decideForSubject(subject, candidates, overrides)
      outcome.grabbed += result.grabbed
      outcome.rejected += result.rejected
    } catch (err) {
      outcome.errors++
      logger.error(`Decision error for ${subject.subjectType}#${subject.subjectId}:`, err)
      recordEvent({
        category: 'rss',
        action: 'decision-error',
        severity: 'error',
        subjectType: subject.subjectType,
        subjectId: String(subject.subjectId),
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Drop cached tab DB handles between batches; the orchestrator will get fresh
  // ones on the next poll, picking up download-client config changes.
  clearTabCache()

  return outcome
}
