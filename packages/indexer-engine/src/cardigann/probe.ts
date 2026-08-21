// Indexer Endpoint Resolver — probe engine.
//
// Spec: docs/11-new-feature-briefs/indexer-endpoint-resolver-spec.md §6.
//
// `probeEndpoint` is a pure measurement function. It takes no scheduling
// decisions, writes nothing to the database, and mutates no selection state.
// Scoring, persistence and scheduling sit above it. That separation is what
// makes the whole thing testable.

import type { SearchQuery } from '@torrentstack/types';
import type { DefinitionEntry } from './loader.js';
import {
  executeSearch, looksLikeChallenge, TransportError,
  type ExecutorConfig, type ExecutorDiagnostics,
} from './executor.js';

export type FailureClass =
  | 'dns' | 'connect' | 'timeout' | 'challenge' | 'rate_limited'
  | 'auth' | 'http_error' | 'parse' | 'empty' | 'unknown';

export interface ProbeResult {
  outcome: 'ok' | 'fail';
  viaCloudflareBypass: boolean;
  failureClass?: FailureClass;
  httpStatus?: number;
  latencyMs: number;
  rowCount?: number;
  errorDetail?: string;
  /** Seconds the server asked us to wait, parsed from Retry-After. */
  retryAfterSec?: number;
}

export interface ProbeOptions {
  allowCloudflareBypass: boolean;
  /** Default 15s direct, 45s through CloudflareBypass. */
  timeoutMs?: number;
  mode: 'browse' | 'search';
  /** Only meaningful when mode is 'search'. */
  probeTerm?: string;
  cloudflareBypassUrl?: string;
  proxyUrl?: string;
  cookies?: Record<string, string>;
  settings?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  now?: () => number;
}

/** Definitions that cannot browse make `empty` ambiguous — see chooseProbeQuery. */
export type ProbeConfidence = 'high' | 'low';

export interface ProbePlan {
  mode: 'browse' | 'search';
  term?: string;
  confidence: ProbeConfidence;
}

const GENERIC_TERMS: Array<{ match: RegExp; term: string }> = [
  { match: /music|audio|flac|mp3/i, term: 'flac' },
  { match: /book|ebook|comic|magazine/i, term: 'epub' },
];

/**
 * Probe query selection (spec §6.2). This choice is load-bearing: probing with
 * a keyword conflates "site blocked", "definition drifted" and "query
 * legitimately empty", and all three look like zero results.
 *
 * Preference order: a browse mode that accepts no keyword, then a
 * definition-declared test query, then a high-yield generic term.
 */
export function chooseProbeQuery(entry: DefinitionEntry): ProbePlan {
  const modes = entry.raw.caps?.modes as Record<string, string[]> | undefined;
  const search = entry.raw.search as Record<string, unknown> | undefined;

  // A definition supports browse when its search mode takes no required
  // keyword — the standard Cardigann signal is a 'search' mode declaring 'q'
  // as optional, which every definition expresses by simply listing it.
  const hasSearchMode = Boolean(modes?.search) || entry.searchModes.includes('search');
  const allowsEmptyQuery = hasSearchMode && !definitionRequiresKeyword(search);
  if (allowsEmptyQuery) return { mode: 'browse', confidence: 'high' };

  const declaredTest = readDeclaredTestQuery(search);
  if (declaredTest) return { mode: 'search', term: declaredTest, confidence: 'low' };

  const haystack = `${entry.id} ${entry.name} ${entry.description}`;
  for (const candidate of GENERIC_TERMS) {
    if (candidate.match.test(haystack)) return { mode: 'search', term: candidate.term, confidence: 'low' };
  }
  return { mode: 'search', term: '1080p', confidence: 'low' };
}

function definitionRequiresKeyword(search: Record<string, unknown> | undefined): boolean {
  if (!search) return true;
  const inputs = search.inputs as Record<string, unknown> | undefined;
  if (!inputs) return false;
  // A definition that hard-codes the keyword into a required field cannot be
  // browsed with an empty query.
  const raw = JSON.stringify(inputs);
  return /\{\{\s*\.Query\.Keywords\s*\}\}/.test(raw) && /required/i.test(raw);
}

function readDeclaredTestQuery(search: Record<string, unknown> | undefined): string | undefined {
  const test = search?.test as Record<string, unknown> | undefined;
  const term = test?.query ?? test?.keywords;
  return typeof term === 'string' && term.trim() ? term.trim() : undefined;
}

const LOGIN_MARKERS = [
  'name="password"', "name='password'", 'type="password"', "type='password'",
  'id="login"', 'action="/login', 'action="login', 'Please login', 'Sign in to continue',
];

/** True when a 200 response is actually the site's login page. */
export function looksLikeLoginPage(body: string): boolean {
  const sample = body.slice(0, 4096).toLowerCase();
  return LOGIN_MARKERS.some(marker => sample.includes(marker.toLowerCase()));
}

export function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, Math.round((at - Date.now()) / 1000));
  return undefined;
}

/**
 * Turns one observed request into a failure class (spec §6.3).
 *
 * Exported and pure so the search-path circuit breaker classifies failures
 * through exactly the same code as the scheduled probe. Two classifiers would
 * drift, and the breaker would start demoting endpoints the prober considers
 * healthy.
 */
export function classifyDiagnostics(diag: ExecutorDiagnostics): {
  failureClass?: FailureClass; retryAfterSec?: number;
} {
  if (diag.transportCode || diag.transportMessage) {
    const code = diag.transportCode ?? '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { failureClass: 'dns' };
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
      return { failureClass: 'timeout' };
    }
    if (code) return { failureClass: 'connect' };
    return /timed out/i.test(diag.transportMessage ?? '')
      ? { failureClass: 'timeout' }
      : { failureClass: 'connect' };
  }

  const status = diag.httpStatus;
  const headers = diag.headers ?? {};
  const body = diag.bodySample ?? '';
  if (status === undefined) return { failureClass: 'unknown' };

  // Challenge is checked before rate_limited and auth: a bot wall commonly
  // arrives as 403, 503 or even 429, and it is the only class Trawl can fix.
  if (looksLikeChallenge(status, headers, body)) return { failureClass: 'challenge' };

  const retryAfterSec = parseRetryAfter(headers['retry-after']);
  if (status === 429) return { failureClass: 'rate_limited', retryAfterSec };

  if (status === 401 || status === 403) return { failureClass: 'auth', retryAfterSec };
  if (status >= 500) return { failureClass: 'http_error', retryAfterSec };
  if (status >= 400) return { failureClass: 'http_error', retryAfterSec };

  if (status === 200 && looksLikeLoginPage(body)) return { failureClass: 'auth' };

  // 200 with the definition's row selector matching nothing is definition
  // drift, not a site problem — and no amount of browser rendering fixes it.
  if (status === 200 && (diag.rowsMatched ?? 0) === 0) return { failureClass: 'parse' };
  if (status === 200 && (diag.rowCount ?? 0) === 0) return { failureClass: 'empty' };

  return {};
}

/**
 * Measures one endpoint once. Never throws for an expected failure: an
 * unreachable site is a result, not an exception.
 */
export async function probeEndpoint(
  endpointUrl: string,
  entry: DefinitionEntry,
  opts: ProbeOptions,
): Promise<ProbeResult> {
  const clock = opts.now ?? Date.now;
  const started = clock();
  const plan: ProbePlan = opts.mode === 'browse'
    ? { mode: 'browse', confidence: 'high' }
    : { mode: 'search', term: opts.probeTerm, confidence: 'low' };

  const diagnostics: ExecutorDiagnostics = {};
  const query: SearchQuery = {
    q: plan.mode === 'browse' ? '' : (plan.term ?? ''),
    categories: [],
    limit: 25,
    offset: 0,
  } as SearchQuery;

  const config: ExecutorConfig = {
    // sitelink pins the executor to the endpoint under test rather than the
    // definition's first link.
    settings: { ...(opts.settings ?? {}), sitelink: endpointUrl },
    cookies: opts.cookies,
    proxyUrl: opts.proxyUrl,
    timeoutMs: opts.timeoutMs ?? (opts.allowCloudflareBypass ? 45_000 : 15_000),
    cloudflareBypassUrl: opts.allowCloudflareBypass ? opts.cloudflareBypassUrl : undefined,
    forceCloudflareBypass: opts.allowCloudflareBypass && Boolean(opts.cloudflareBypassUrl),
    diagnostics,
  };

  let threw: unknown;
  try {
    await executeSearch(entry, query, config);
  } catch (err) {
    threw = err;
    if (err instanceof TransportError) {
      diagnostics.transportCode = err.code;
      diagnostics.transportMessage = err.message;
    } else if (!diagnostics.transportMessage) {
      diagnostics.transportMessage = err instanceof Error ? err.message : String(err);
    }
  }

  const latencyMs = Math.max(0, clock() - started);
  const viaCloudflareBypass = Boolean(diagnostics.viaCloudflareBypass) ||
    (config.forceCloudflareBypass === true && Boolean(config.cloudflareBypassUrl));
  const { failureClass, retryAfterSec } = classifyDiagnostics(diagnostics);

  if (!failureClass && !threw) {
    return {
      outcome: 'ok',
      viaCloudflareBypass,
      httpStatus: diagnostics.httpStatus,
      latencyMs,
      rowCount: diagnostics.rowCount ?? 0,
    };
  }

  return {
    outcome: 'fail',
    viaCloudflareBypass,
    failureClass: failureClass ?? 'unknown',
    httpStatus: diagnostics.httpStatus,
    latencyMs,
    rowCount: diagnostics.rowCount,
    errorDetail: diagnostics.transportMessage
      ?? (threw instanceof Error ? threw.message : undefined),
    retryAfterSec,
  };
}
