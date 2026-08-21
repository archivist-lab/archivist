// Search aggregator
// Fans a query out to all capable configured indexers simultaneously,
// merges results, deduplicates by info hash, and sorts by seeders.

import { executeSearch, type ExecutorDiagnostics } from './cardigann/executor.js';
import { torznabSearch } from './torznab/client.js';
import type { SearchQuery, SearchResult } from '@torrentstack/types';
import type { IndexerInstance } from './indexer-store.js';

/**
 * What one indexer's attempt produced. Handed to `onIndexerOutcome` so a caller
 * that owns endpoint state (the Indexer Endpoint Resolver) can classify the
 * failure and retry against a different endpoint, in-search.
 *
 * A blocked site usually yields zero results rather than an exception, so the
 * diagnostics — not the error — are what make the outcome legible.
 */
export interface IndexerOutcome {
  instance: IndexerInstance;
  /** The query as issued, so a retry cannot silently search for something else. */
  query: SearchQuery;
  results: SearchResult[];
  diagnostics: ExecutorDiagnostics;
  error: unknown;
}

export interface AggregatorHooks {
  /**
   * Called once per indexer after its attempt. Return a replacement result set
   * to substitute (a successful retry), or null to keep what was returned.
   */
  onIndexerOutcome?(outcome: IndexerOutcome): Promise<SearchResult[] | null>;
}

export interface AggregatorOptions {
  /** Timeout per indexer in ms */
  timeoutMs?: number;
  /** Max results per indexer */
  limitPerIndexer?: number;
  /** Minimum seeders filter (0 = no filter) */
  minimumSeeders?: number;
  hooks?: AggregatorHooks;
}

export interface AggregatorResult {
  results:    SearchResult[];
  indexerStats: Array<{
    indexerId:   string;
    indexerName: string;
    resultCount: number;
    responseMs:  number;
    error:       string | null;
  }>;
  totalMs: number;
}

export async function aggregateSearch(
  indexers:    IndexerInstance[],
  query:       SearchQuery,
  opts:        AggregatorOptions = {},
): Promise<AggregatorResult> {
  const start       = Date.now();
  const timeoutMs   = opts.timeoutMs ?? 15_000;
  const minSeeders  = opts.minimumSeeders ?? 0;

  // Filter to capable indexers
  const capable = indexers.filter(ix => {
    if (!ix.config.enabled) return false;
    if (query.indexerIds?.length && !query.indexerIds.includes(ix.config.id)) return false;
    return true;
  });

  // Fan out in parallel
  const searchPromises = capable.map(async (ix) => {
    const indexerStart = Date.now();
    const diagnostics: ExecutorDiagnostics = {};
    let results: SearchResult[] = [];
    let error: unknown = null;

    try {
      results = await Promise.race([
        runIndexerSearch(ix, query, diagnostics),
        new Promise<SearchResult[]>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);
    } catch (e) {
      error = e;
    }

    if (opts.hooks?.onIndexerOutcome) {
      try {
        const replacement = await opts.hooks.onIndexerOutcome({ instance: ix, query, results, diagnostics, error });
        if (replacement) {
          results = replacement;
          error = null;
        }
      } catch {
        // A failing hook must never lose the results we already have.
      }
    }

    return {
      indexerId:   ix.config.id,
      indexerName: ix.config.name,
      results,
      responseMs:  Date.now() - indexerStart,
      error:       error === null ? null : String(error),
    };
  });

  const settled = await Promise.allSettled(searchPromises);
  const allResults: SearchResult[] = [];
  const stats: AggregatorResult['indexerStats'] = [];

  for (const s of settled) {
    if (s.status === 'rejected') continue;
    const { indexerId, indexerName, results, responseMs, error } = s.value;

    stats.push({ indexerId, indexerName, resultCount: results.length, responseMs, error });

        for (const r of results) {
      // Apply minimum seeders filter
      if (minSeeders > 0 && (r.seeders ?? 0) < minSeeders) continue;

      // --- STRICT CATEGORY FILTER ---
      // If categories were requested, ensure the result actually matches one of them
      if (query.categories && query.categories.length > 0) {
        const matches = r.categories.some(c => {
          return query.categories!.some(qc => {
            if (qc === c) return true;
            // Support parent category matching (e.g. 2000 matches 2040)
            if (qc % 1000 === 0 && c >= qc && c < qc + 1000) return true;
            return false;
          });
        });
        if (!matches) continue;
      }
      // ------------------------------

      allResults.push(r);
    }
  }

  // Deduplicate by info hash, keeping the entry with more seeders
  const deduped = deduplicateByHash(allResults);

  // Sort: seeders desc, then publishDate desc
  deduped.sort((a, b) => {
    const seedDiff = (b.seeders ?? 0) - (a.seeders ?? 0);
    if (seedDiff !== 0) return seedDiff;
    return b.publishDate - a.publishDate;
  });

  return {
    results:      deduped,
    indexerStats: stats,
    totalMs:      Date.now() - start,
  };
}

export async function runIndexerSearch(
  ix: IndexerInstance,
  query: SearchQuery,
  diagnostics?: ExecutorDiagnostics,
): Promise<SearchResult[]> {
  if (ix.type === 'torznab') {
    return torznabSearch(
      { baseUrl: ix.config.baseUrl, apiKey: ix.config.apiKey ?? undefined },
      query,
    );
  }

  if (ix.type === 'cardigann' && ix.definition) {
    return executeSearch(ix.definition, query, {
      diagnostics,
      settings:          ix.config.settings,
      cookies:           ix.cookies,
      timeoutMs:         15_000,
      proxyUrl:          ix.proxyUrl,
      cloudflareBypassUrl:   ix.cloudflareBypassUrl,
      forceCloudflareBypass: ix.config.settings?.cloudflareBypass === true || ix.config.settings?.cloudflareBypass === 'true',
    });
  }

  return [];
}

function deduplicateByHash(results: SearchResult[]): SearchResult[] {
  const byHash = new Map<string, SearchResult>();
  const noHash: SearchResult[] = [];

  for (const r of results) {
    if (r.infoHash) {
      const existing = byHash.get(r.infoHash);
      if (!existing || (r.seeders ?? 0) > (existing.seeders ?? 0)) {
        byHash.set(r.infoHash, r);
      }
    } else {
      noHash.push(r);
    }
  }

  return [...byHash.values(), ...noHash];
}
