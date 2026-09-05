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
  /** Include endpoint-recovery hooks in timeoutMs. Used by workflows with a
   * hard overall deadline; legacy callers retain the existing unbounded hook. */
  boundHooksToTimeout?: boolean;
  /** Called as each indexer finishes, after any endpoint-recovery retry and
   * after the same category/seeder filters used by the final aggregate. */
  onIndexerResults?(results: SearchResult[], indexer: { id: string; name: string }): void | Promise<void>;
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

    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      results = await Promise.race([
        runIndexerSearch(ix, query, diagnostics),
        new Promise<SearchResult[]>((_, reject) => {
          searchTimer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
    } catch (e) {
      error = e;
    } finally {
      // The loser of the race must not stay pending. Left uncleared, a search
      // that answered in a second still holds a live timer for the full
      // timeout — one per indexer per query, so a tier escalation leaves
      // hundreds — which keeps the event loop busy and stalls shutdown until
      // the last one fires.
      clearTimeout(searchTimer);
    }

    if (opts.hooks?.onIndexerOutcome) {
      try {
        const hook = opts.hooks.onIndexerOutcome({ instance: ix, query, results, diagnostics, error });
        const remaining = Math.max(1, timeoutMs - (Date.now() - indexerStart));
        let hookTimer: ReturnType<typeof setTimeout> | undefined;
        const replacement = opts.boundHooksToTimeout
          ? await Promise.race([
              hook,
              new Promise<null>((resolve) => { hookTimer = setTimeout(() => resolve(null), remaining); }),
            ]).finally(() => clearTimeout(hookTimer))
          : await hook;
        if (replacement) {
          results = replacement;
          error = null;
        }
      } catch {
        // A failing hook must never lose the results we already have.
      }
    }

    const filteredResults = filterResults(results, query, minSeeders);
    if (opts.onIndexerResults) {
      try {
        await opts.onIndexerResults(filteredResults, { id: ix.config.id, name: ix.config.name });
      } catch {
        // Progressive delivery is observational. A consumer failure must not
        // discard this indexer's contribution to the completed search.
      }
    }

    return {
      indexerId:   ix.config.id,
      indexerName: ix.config.name,
      results: filteredResults,
      rawResultCount: results.length,
      responseMs:  Date.now() - indexerStart,
      error:       error === null ? null : String(error),
    };
  });

  const settled = await Promise.allSettled(searchPromises);
  const allResults: SearchResult[] = [];
  const stats: AggregatorResult['indexerStats'] = [];

  for (const s of settled) {
    if (s.status === 'rejected') continue;
    const { indexerId, indexerName, results, rawResultCount, responseMs, error } = s.value;

    stats.push({ indexerId, indexerName, resultCount: rawResultCount, responseMs, error });

    allResults.push(...results);
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

function filterResults(results: SearchResult[], query: SearchQuery, minSeeders: number): SearchResult[] {
  return results.filter(r => {
    if (minSeeders > 0 && (r.seeders ?? 0) < minSeeders) return false;
    if (!query.categories?.length) return true;
    return r.categories.map(Number).filter(Number.isFinite).some(category =>
      query.categories!.some(requested =>
        requested === category || (requested % 1000 === 0 && category >= requested && category < requested + 1000),
      ),
    );
  });
}

export async function runIndexerSearch(
  ix: IndexerInstance,
  query: SearchQuery,
  diagnostics?: ExecutorDiagnostics,
): Promise<SearchResult[]> {
  if (ix.type === 'torznab') {
    return torznabSearch(
      { baseUrl: ix.config.baseUrl, apiKey: ix.config.apiKey ?? undefined, apiPath: ix.config.apiPath },
      query,
      diagnostics,
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
