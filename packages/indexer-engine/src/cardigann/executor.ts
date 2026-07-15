// Cardigann executor
// Takes a definition + user config, runs searches, parses results.
// Supports HTML scraping (Cheerio), JSON path queries, XML parsing.

import nunjucks from 'nunjucks';
import * as cheerio from 'cheerio';
import type { CardigannDefinition, DefinitionEntry } from './loader.js';
import type { SearchQuery, SearchResult } from '@torrentstack/types';

// ─── Executor config ──────────────────────────────────────────────────────────

export interface ExecutorConfig {
  /** User-provided settings (API key, username, etc.) */
  settings: Record<string, string | number | boolean>;
  /** Which base URL to use (index 0 = default) */
  baseUrlIndex?: number;
  /** HTTP proxy URL */
  proxyUrl?: string;
  /** FlareSolverr base URL (e.g. http://192.168.1.1:8191) */
  flareSolverrUrl?: string;
  /** If true, route ALL requests through FlareSolverr instead of only on CF challenge */
  forceFlareSolverr?: boolean;
  /** Cookie jar (maintained across requests) */
  cookies?: Record<string, string>;
  /** Request timeout ms */
  timeoutMs?: number;
}

// ─── Nunjucks environment (no file system access) ─────────────────────────────

const njEnv = nunjucks.configure({ autoescape: false });

// Helper for filter/global dual registration
function addFunc(name: string, fn: (...args: any[]) => any) {
  njEnv.addFilter(name, fn);
  njEnv.addGlobal(name, fn);
}

// Custom filters matching Cardigann template spec
addFunc('replace', (str: string, find: string, replace: string) =>
  str?.replace(new RegExp(escapeRegex(find), 'g'), replace) ?? str,
);
addFunc('trim', (str: string) => str?.trim() ?? str);
addFunc('tolower', (str: string) => str?.toLowerCase() ?? str);
addFunc('toupper', (str: string) => str?.toUpperCase() ?? str);
addFunc('urlencode', (str: string) => encodeURIComponent(str ?? ''));
addFunc('join', (arr: any[], sep: string) => (Array.isArray(arr) ? arr.join(sep) : arr));
addFunc('dateadd', (date: string, count: number, unit: string) => date);
addFunc('timeago', (date: string) => date);
addFunc('default', (val: any, def: any) => (val !== undefined && val !== null && val !== '') ? val : def);
addFunc('re_replace', (str: string, pattern: string, replace: string) => {
  try {
    const flags = pattern.includes('\\p{') ? 'gu' : 'g';
    return str?.replace(new RegExp(pattern, flags), replace) ?? str;
  } catch { return str; }
});

// Go-style prefix functions for complex templates
njEnv.addGlobal('and', (...args: any[]) => args.every(Boolean));
njEnv.addGlobal('or', (...args: any[]) => args.some(Boolean));
njEnv.addGlobal('eq', (a: any, b: any) => a == b);
njEnv.addGlobal('ne', (a: any, b: any) => a != b);
njEnv.addGlobal('gt', (a: any, b: any) => a > b);
njEnv.addGlobal('lt', (a: any, b: any) => a < b);
njEnv.addGlobal('ge', (a: any, b: any) => a >= b);
njEnv.addGlobal('le', (a: any, b: any) => a <= b);
njEnv.addGlobal('not', (a: any) => !a);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TORZNAB_CATEGORIES: Record<number, string> = {
  0: "Other",
  10: "Other/Misc",
  20: "Other/Hashed",
  1000: "Console",
  1010: "Console/NDS",
  1020: "Console/PSP",
  1030: "Console/Wii",
  1040: "Console/XBox",
  1050: "Console/XBox 360",
  1060: "Console/Wiiware",
  1070: "Console/XBox 360 DLC",
  1080: "Console/PS3",
  1090: "Console/Other",
  1110: "Console/3DS",
  1120: "Console/PS Vita",
  1130: "Console/WiiU",
  1140: "Console/XBox One",
  1180: "Console/PS4",
  2000: "Movies",
  2010: "Movies/Foreign",
  2020: "Movies/Other",
  2030: "Movies/SD",
  2040: "Movies/HD",
  2045: "Movies/UHD",
  2050: "Movies/BluRay",
  2060: "Movies/3D",
  2070: "Movies/DVD",
  2080: "Movies/WEB-DL",
  2090: "Movies/x265",
  3000: "Audio",
  3010: "Audio/MP3",
  3020: "Audio/Video",
  3030: "Audio/Audiobook",
  3040: "Audio/Lossless",
  3050: "Audio/Other",
  3060: "Audio/Foreign",
  4000: "PC",
  4010: "PC/0day",
  4020: "PC/ISO",
  4030: "PC/Mac",
  4040: "PC/Mobile-Other",
  4050: "PC/Games",
  4060: "PC/Mobile-iOS",
  4070: "PC/Mobile-Android",
  5000: "TV",
  5010: "TV/WEB-DL",
  5020: "TV/Foreign",
  5030: "TV/SD",
  5040: "TV/HD",
  5045: "TV/UHD",
  5050: "TV/Other",
  5060: "TV/Sport",
  5070: "TV/Anime",
  5080: "TV/Documentary",
  5090: "TV/x265",
  6000: "XXX",
  6010: "XXX/DVD",
  6020: "XXX/WMV",
  6030: "XXX/XviD",
  6040: "XXX/x264",
  6045: "XXX/UHD",
  6050: "XXX/Pack",
  6060: "XXX/ImageSet",
  6070: "XXX/Other",
  6080: "XXX/SD",
  6090: "XXX/WEB-DL",
  7000: "Books",
  7010: "Books/Mags",
  7020: "Books/EBook",
  7030: "Books/Comics",
  7040: "Books/Technical",
  7050: "Books/Other",
  7060: "Books/Foreign",
  8000: "Other",
  8010: "Other/Misc",
  8020: "Other/Hashed"
};

function mapCategories(torznabCats: number[], mappings: Array<{ id: number | string; cat: string }>): Array<number | string> {
  if (torznabCats.length === 0) return [];
  const result = new Set<number | string>();

  for (const tCat of torznabCats) {
    const name = TORZNAB_CATEGORIES[tCat];
    if (!name) {
      // Unknown Torznab ID — try direct ID match in mappings
      const match = mappings.filter(m => String(m.cat) === String(tCat));
      if (match.length > 0) {
        match.forEach(m => result.add(m.id));
        continue;
      }
      // Try parent category
      const parentId = Math.floor(tCat / 1000) * 1000;
      if (parentId !== tCat) {
        const parentName = TORZNAB_CATEGORIES[parentId];
        if (parentName) {
          mappings
            .filter(m => m.cat === parentName || m.cat.startsWith(parentName + '/'))
            .forEach(m => result.add(m.id));
        }
      }
      continue;
    }

    // Parent category (e.g. 2000=Movies, 5000=TV): include exact + all subcategories
    const isParent = tCat % 1000 === 0;
    if (isParent) {
      mappings
        .filter(m => m.cat === name || m.cat.startsWith(name + '/'))
        .forEach(m => result.add(m.id));
    } else {
      // Specific subcategory (e.g. 2040=Movies/HD): exact match first
      const match = mappings.filter(m => m.cat === name);
      if (match.length > 0) {
        match.forEach(m => result.add(m.id));
      } else {
        // Fall back to parent and all its subcategories
        const parentName = name.split('/')[0];
        if (parentName && parentName !== name) {
          mappings
            .filter(m => m.cat === parentName || m.cat.startsWith(parentName + '/'))
            .forEach(m => result.add(m.id));
        }
      }
    }
  }

  if (result.size === 0 && torznabCats.length > 0) return torznabCats;
  return [...result];
}

// ─── Template context builder ─────────────────────────────────────────────────

function buildContext(query: SearchQuery, config: ExecutorConfig, entry?: DefinitionEntry, result?: any): Record<string, unknown> {
  let cats: Array<number | string> = (query.categories ?? []).filter(c => c > 0);

  // If no categories but we have a search type, infer Torznab category
  if (cats.length === 0) {
    if (query.type === 'movie') cats = [2000];
    else if (query.type === 'tvsearch') cats = [5000];
    else if (query.type === 'music') cats = [3000];
    else if (query.type === 'book') cats = [7000];
  }

  // Map Torznab IDs to indexer-specific IDs using definition mappings
  if (entry && cats.length > 0) {
    cats = mapCategories(cats as number[], entry.categories);
  }

  return {
    'Keywords':   query.q ?? '',
    'Categories': cats,
    'RawCategories': query.categories ?? [],
    'Query': {
      Type:   query.type ?? 'search',
      Q:      query.q ?? '',
      Season: query.season ?? '',
      Ep:     query.episode ?? '',
      Year:   query.year ?? '',
      Limit:  query.limit ?? '',
      IMDBID: query.imdbId ?? '',
      TMDBID: query.tmdbId ?? '',
      TvdbID: query.tvdbId ?? '',
      Artist: query.artist ?? '',
      Album:  query.album ?? '',
      Author: query.author ?? '',
      Title:  query.title ?? '',
      Categories: cats,
    },
    'Config': config.settings,
    'Result': result ?? {},
    'True':  'True',
    'False': null,
    'Today': { Year: new Date().getFullYear().toString() },
  };
}

function renderTemplate(tmpl: any, ctx: Record<string, unknown>): string {
  if (tmpl === undefined || tmpl === null) return '';
  const s = String(tmpl);
  if (!s || (!s.includes('{{') && !s.includes('{%') && !s.includes('[['))) return s;
  try {
    // 1. Convert [[ ... ]] and ${{ ... }} to {{ ... }}
    let converted = s.replace(/\[\[\s*(.*?)\s*\]\]/g, '{{ $1 }}');
    converted = converted.replace(/\$\{\{\s*(.*?)\s*\}\}/g, '{{ $1 }}');

    // 2. Convert {{ if ... }} to {% if ... %}
    converted = converted
      .replace(/\{\{\s*if\s+(.*?)\s*\}\}/g, '{% if $1 %}')
      .replace(/\{\{\s*else\s*\}\}/g, '{% else %}')
      .replace(/\{\{\s*end\s*\}\}/g, '{% endif %}');

    // 3. Process expressions in ALL tags
    converted = converted.replace(/(\{\{|\{\%)([\s\S]*?)(\}\}|\%\})/g, (_, start, content, end) => {
      let c = content.trim();

      // a. Remove leading dots from variables
      c = c.replace(/(^|[^a-zA-Z0-9_])\.([a-zA-Z][a-zA-Z0-9_.]*)/g, '$1$2');

      // Keywords are handled by the HTTP client encoding

      // c. Handle prefix functions: and (A) (B) -> and(A, B)
      // We repeat this to handle nested functions
      const prefixFuncs = 'and|or|eq|ne|gt|lt|ge|le|join|replace|re_replace|urlencode|trim|tolower|toupper|default';
      for (let i = 0; i < 5; i++) {
        // Match: func (arg1) (arg2)
        c = c.replace(new RegExp(`\\b(${prefixFuncs})\\s*\\((.*?)\\)\\s*\\((.*?)\\)`, 'g'), '$1($2, $3)');
        // Match: func arg1 arg2 (handling quotes with spaces)
        c = c.replace(new RegExp(`\\b(${prefixFuncs})\\s+((?:(?:"[^"]*")|(?:'[^']*')|[^\\s\\(\\)]+))\\s+((?:(?:"[^"]*")|(?:'[^']*')|[^\\s\\(\\)]+))`, 'g'), '$1($2, $3)');
        // Match: func arg1 (arg2)
        c = c.replace(new RegExp(`\\b(${prefixFuncs})\\s+((?:(?:"[^"]*")|(?:'[^']*')|[^\\s\\(\\)]+))\\s*\\((.*?)\\)`, 'g'), '$1($2, $3)');
        // Match: func (arg1) arg2
        c = c.replace(new RegExp(`\\b(${prefixFuncs})\\s*\\((.*?)\\)\\s+((?:(?:"[^"]*")|(?:'[^']*')|[^\\s\\(\\)]+))`, 'g'), '$1($2, $3)');
        // Match: func (arg1) or func arg1
        c = c.replace(new RegExp(`\\b(${prefixFuncs})\\s*\\(([^,)]*)\\)(?!\\s*[,\\)])`, 'g'), '$1($2)');
        c = c.replace(new RegExp(`\\b(${prefixFuncs})\\s+((?:(?:"[^"]*")|(?:'[^']*')|[^\\s\\(\\)]+))(?!\\s*[,\\)])`, 'g'), '$1($2)');
      }

      return start + c + end;
    });

    return njEnv.renderString(converted, ctx);
  } catch (e) {
    console.error(`[Cardigann] Template render failed: "${tmpl}"`, e);
    return tmpl;
  }
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

interface HttpOptions {
  method:    'GET' | 'POST';
  url:       string;
  params?:   Record<string, string>;
  body?:     Record<string, string> | string;
  headers?:  Record<string, string>;
  cookies?:  Record<string, string>;
  timeoutMs: number;
  proxyUrl?: string;
  flareSolverrUrl?: string;
  forceFlareSolverr?: boolean;
}

interface HttpResponse {
  status:  number;
  body:    string;
  headers: Record<string, string>;
}

async function httpRequestDirect(opts: HttpOptions): Promise<HttpResponse> {
  let url: URL;
  try {
    const encodedUrl = opts.url.replace(/ /g, '%20');
    url = new URL(encodedUrl);
  } catch (e) {
    throw new Error(`Invalid search URL: ${opts.url}`);
  }

  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...opts.headers,
  };

  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    headers['Cookie'] = Object.entries(opts.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  let bodyStr: string | undefined;
  if (opts.method === 'POST' && opts.body) {
    if (typeof opts.body === 'string') {
      bodyStr = opts.body;
    } else {
      const fd = new URLSearchParams(opts.body);
      bodyStr = fd.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method:  opts.method,
      headers,
      body:    bodyStr,
      signal:  controller.signal,
    });

    const body = await res.text();
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });

    return { status: res.status, body, headers: respHeaders };
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${opts.timeoutMs}ms`);
    throw new Error(`Fetch failed for ${url.origin}: ${err.message}${err.cause ? ' (' + err.cause.message + ')' : ''}`);
  } finally {
    clearTimeout(timer);
  }
}

async function httpRequestViaFlareSolverr(opts: HttpOptions): Promise<HttpResponse> {
  const flareUrl = opts.flareSolverrUrl!.replace(/\/$/, '');

  let url: URL;
  try {
    const encodedUrl = opts.url.replace(/ /g, '%20');
    url = new URL(encodedUrl);
  } catch (e) {
    throw new Error(`Invalid search URL: ${opts.url}`);
  }

  if (opts.params && opts.method === 'GET') {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  let postData: string | undefined;
  if (opts.method === 'POST' && opts.body) {
    postData = typeof opts.body === 'string' ? opts.body : new URLSearchParams(opts.body).toString();
  }

  const payload: Record<string, unknown> = {
    cmd: opts.method === 'POST' ? 'request.post' : 'request.get',
    url: url.toString(),
    maxTimeout: Math.max(opts.timeoutMs, 30_000),
  };
  if (postData) payload.postData = postData;
  if (opts.cookies && Object.keys(opts.cookies).length > 0) {
    // FlareSolverr 3.4.x passes supplied cookies directly to Chrome, which
    // requires a domain and path. Omitting them raises KeyError('domain')
    // before the challenge can be solved (notably for EZTV's filter cookies).
    payload.cookies = Object.entries(opts.cookies).map(([name, value]) => ({
      name,
      value,
      domain: url.hostname,
      path: '/',
    }));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (opts.timeoutMs) + 15_000);

  console.log(`[FlareSolverr] Routing ${url.hostname} through ${flareUrl}`);

  try {
    const res = await fetch(`${flareUrl}/v1`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });

    const data = await res.json() as any;

    if (data.status !== 'ok' || !data.solution) {
      throw new Error(`FlareSolverr: ${data.message ?? 'unknown error'} (status: ${data.status})`);
    }

    const solution = data.solution;
    const respHeaders: Record<string, string> = { 'content-type': 'text/html' };
    if (solution.headers) {
      for (const [k, v] of Object.entries(solution.headers as Record<string, unknown>)) {
        respHeaders[k.toLowerCase()] = String(v);
      }
    }

    return {
      status:  solution.status ?? 200,
      body:    solution.response ?? '',
      headers: respHeaders,
    };
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(`FlareSolverr timed out`);
    throw new Error(`FlareSolverr request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function isCloudflareChallenged(resp: HttpResponse): boolean {
  if (resp.status !== 403 && resp.status !== 503) return false;
  if (resp.headers['cf-ray'] || resp.headers['cf-mitigated']) return true;
  const body = resp.body.slice(0, 2000);
  return body.includes('cf-browser-verification') ||
    body.includes('Checking your browser') ||
    body.includes('jschl-answer') ||
    body.includes('__cf_chl');
}

async function httpRequest(opts: HttpOptions): Promise<HttpResponse> {
  // Per-indexer forced mode: always use FlareSolverr, skip direct attempt
  if (opts.flareSolverrUrl && opts.forceFlareSolverr) {
    return httpRequestViaFlareSolverr(opts);
  }

  // Normal direct fetch — catch network-level failures (timeout, ECONNREFUSED, etc.)
  let resp: HttpResponse;
  try {
    resp = await httpRequestDirect(opts);
  } catch (err: any) {
    // If site is unreachable directly but FlareSolverr is available, try through it
    if (opts.flareSolverrUrl) {
      console.log(`[FlareSolverr] Direct fetch failed (${err.message}), retrying via FlareSolverr`);
      return httpRequestViaFlareSolverr(opts);
    }
    throw err;
  }

  // Auto-fallback: Cloudflare challenge detected in HTTP response
  if (opts.flareSolverrUrl && isCloudflareChallenged(resp)) {
    console.log(`[FlareSolverr] Cloudflare challenge on ${opts.url}, retrying via FlareSolverr`);
    return httpRequestViaFlareSolverr(opts);
  }

  return resp;
}

function applyFilters(value: string, filters: Array<Record<string, unknown>> | undefined): string {
  if (!filters) return value;

  for (const filter of filters) {
    const fn = (filter['name'] as string) || Object.keys(filter)[0] || '';
    const argsArr = (filter['args'] as Array<string | number>) || (filter[fn] !== undefined ? [filter[fn]] : []);
    const arg = String(argsArr[0] ?? '');

    if (fn === 'trim')      value = value.trim();
    if (fn === 'tolower')   value = value.toLowerCase();
    if (fn === 'toupper')   value = value.toUpperCase();
    if (fn === 'urldecode') try { value = decodeURIComponent(value); } catch {}
    if (fn === 'urlencode') value = encodeURIComponent(value);
    if (fn === 'split') {
      const sep = arg;
      const idx = parseInt(String(argsArr[1] ?? '0'), 10);
      const parts = value.split(sep);
      value = parts[idx] ?? '';
    }
    if (fn === 'replace')   {
      let from = arg;
      let to = String(argsArr[1] ?? '');
      if (argsArr.length === 1 && arg.includes(',')) {
        const parts = arg.split(',').map(s => s.trim());
        from = parts[0] ?? '';
        to = parts[1] ?? '';
      }
      if (from) value = value.replace(new RegExp(escapeRegex(from), 'g'), to ?? '');
    }
    if (fn === 're_replace') {
      let pattern = arg;
      let replace = String(argsArr[1] ?? '');
      if (argsArr.length === 1 && arg.includes(',')) {
        const sepIdx = arg.lastIndexOf(',');
        pattern = arg.slice(0, sepIdx).trim();
        replace = arg.slice(sepIdx + 1).trim();
      }
      try {
        // Use unicode flag when pattern contains \p{...} so Unicode property escapes work correctly
        const flags = pattern.includes('\\p{') ? 'gu' : 'g';
        value = value.replace(new RegExp(pattern, flags), replace);
      } catch {}
    }
    if (fn === 'append')    value = value + arg;
    if (fn === 'prepend')   value = arg + value;
    if (fn === 'multiply')  {
      const n = parseFloat(value);
      if (!isNaN(n)) value = String(n * parseFloat(arg));
    }
    if (fn === 'dateparse') {
      // Basic dateparse — ideally we'd use a real library here
      // For now we just return as is, parseDate will handle it later
    }
  }

  return value;
}

// ─── Result field extractor ───────────────────────────────────────────────────

function extractField(
  entry: DefinitionEntry,
  el: any,
  fieldDef: Record<string, unknown>,
  $: cheerio.CheerioAPI | null,
  baseUrl: string,
  query: SearchQuery,
  config: ExecutorConfig,
  currentResult: Record<string, string>,
): string {
  const selector = fieldDef['selector'] as string | undefined;
  const text     = fieldDef['text'] as string | undefined;
  const attr     = fieldDef['attribute'] as string | undefined;
  const remove   = fieldDef['remove'] as string | undefined;
  const filters  = fieldDef['filters'] as Array<Record<string, unknown>> | undefined;

  let value = '';

  if (text !== undefined) {
    value = renderTemplate(text, buildContext(query, config, entry, currentResult));
  } else {
    if ($ && el) {
      const target = selector ? el.find(selector) : el;
      if (remove) target.find(remove).remove();
      if (attr) {
        value = target.attr(attr) ?? '';
        // Only resolve relative URLs when there are no filters — filters like
        // split("/", 2) need the raw path (e.g. "/sub/42/0/"), not the full URL.
        if ((attr === 'href' || attr === 'src') && value && !value.startsWith('http') && !filters?.length) {
          try { value = new URL(value, baseUrl).toString(); } catch {}
        }
      } else {
        value = target.text().trim();
      }
    } else if (el && selector) {
      value = String(selector.split('.').reduce((obj, key) => obj?.[key], el) ?? '');
    }
  }

  return applyFilters(value, filters);
}

// ─── HTML search executor ─────────────────────────────────────────────────────

export async function executeSearch(
  entry: DefinitionEntry,
  query: SearchQuery,
  config: ExecutorConfig,
): Promise<SearchResult[]> {
  const def     = entry.raw;
  const search  = def.search as Record<string, any>;
  if (!search) return [];

  // Apply keywordsfilters if present — use a local copy so we don't mutate the
  // shared query object (other parallel indexers must see the original keywords)
  if (query.q && search.keywordsfilters) {
    query = { ...query, q: applyFilters(query.q, search.keywordsfilters) };
  }

  const baseUrl = (config.settings['sitelink'] as string || entry.links[config.baseUrlIndex ?? 0] || entry.links[0] || '').replace(/\/$/, '') + '/';
  const ctx = buildContext(query, config, entry);

  // DIAG: trace category mapping
  console.log(`[Cardigann:DIAG] ${entry.name} query.categories=${JSON.stringify(query.categories)} → mapped Categories=${JSON.stringify(ctx['Categories'])}`);

  // Resolve which paths to search — some definitions have multiple paths (e.g. 1337x has
  // page 1,2,3,4). We search all of them and merge results.
  let pathEntries: Array<{ rawPath: string; responseType?: string }> = [];
  if (typeof search.path === 'string') {
    pathEntries = [{ rawPath: search.path, responseType: (search['response'] as any)?.type }];
  } else if (Array.isArray(search.paths) && search.paths.length > 0) {
    pathEntries = search.paths.map((p: any) => ({
      rawPath: typeof p === 'string' ? p : (p.path ?? '/'),
      responseType: typeof p === 'object' ? p.response?.type : undefined,
    }));
  } else {
    pathEntries = [{ rawPath: '/' }];
  }

  // Top-level response type override (fallback if path doesn't specify one)
  const globalResponseType = (search['response'] as any)?.type;
  const method = (search['method'] as string ?? 'get').toUpperCase() as 'GET' | 'POST';
  const inputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(search.inputs ?? {})) {
    const val = renderTemplate(String(v), ctx);
    if (val) inputs[k] = val;
  }

  // Resolve search.headers from the definition. Jackett/Cardigann YAML uses
  // single-element arrays of templated strings, e.g. `Cookie: ["{{ .Config.x }}"]`.
  // Cookie values are merged into the cookie jar so the FlareSolverr path
  // (which only forwards cookies, not arbitrary headers) still picks them up.
  const definitionHeaders: Record<string, string> = {};
  const mergedCookies: Record<string, string> = { ...(config.cookies ?? {}) };
  if (search.headers && typeof search.headers === 'object') {
    for (const [name, raw] of Object.entries(search.headers as Record<string, unknown>)) {
      const rawStr = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
      const value = renderTemplate(rawStr, ctx);
      if (!value) continue;
      if (name.toLowerCase() === 'cookie') {
        for (const part of value.split(';')) {
          const eq = part.indexOf('=');
          if (eq <= 0) continue;
          const k = part.slice(0, eq).trim();
          const v = part.slice(eq + 1).trim();
          if (k) mergedCookies[k] = v;
        }
      } else {
        definitionHeaders[name] = value;
      }
    }
  }

  let allResults: SearchResult[] = [];
  const seen = new Set<string>();

  for (const pe of pathEntries) {
    const searchPath = renderTemplate(pe.rawPath, ctx);
    const searchUrl = searchPath.startsWith('http') ? searchPath : baseUrl + (searchPath.startsWith('/') ? searchPath.slice(1) : searchPath);

    // Skip duplicate URLs (e.g. multi-path definitions where keyword search produces identical URLs)
    if (seen.has(searchUrl)) continue;
    seen.add(searchUrl);

    console.log(`[Cardigann] ${entry.name} requesting: ${searchUrl}`);

    const resp = await httpRequest({
      method, url: searchUrl, params: method === 'GET' ? inputs : undefined,
      body: method === 'POST' ? inputs : undefined,
      headers: Object.keys(definitionHeaders).length ? definitionHeaders : undefined,
      cookies: mergedCookies,
      timeoutMs: config.timeoutMs ?? 15_000, proxyUrl: config.proxyUrl,
      flareSolverrUrl: config.flareSolverrUrl,
      forceFlareSolverr: config.forceFlareSolverr,
    });

    if (resp.status !== 200) {
      console.error(`[Cardigann] ${entry.name} HTTP ${resp.status} for ${searchUrl}`);
      continue;
    }

    const contentType = (resp.headers['content-type'] ?? '').toLowerCase();
    const typeOverride = pe.responseType ?? globalResponseType;

    // FlareSolverr wraps any response in a browser-rendered HTML page.
    // If the definition expects JSON but the body looks like HTML, try to
    // extract the raw JSON from the <pre> tag that the browser inserts for
    // non-HTML API responses (e.g. apibay.org returns JSON, browser wraps it
    // in <html><body><pre>[...]</pre></body></html>).
    let body = resp.body;
    if ((typeOverride === 'json' || contentType.includes('json')) && body.trimStart().startsWith('<')) {
      const preMatch = body.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
      if (preMatch) {
        body = preMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      }
    }

    let results: SearchResult[] = [];
    if (typeOverride === 'json' || contentType.includes('json')) {
      results = parseJsonResults(entry, body, query, baseUrl, config);
    } else if (contentType.includes('xml') || body.trimStart().startsWith('<?xml') || body.trimStart().startsWith('<rss')) {
      results = parseXmlResults(entry, body, query, baseUrl);
    } else {
      results = parseHtmlResults(entry, body, query, baseUrl, config);
    }

    allResults.push(...results);
  }

  // Deduplicate by title+size across paths
  const deduped = new Map<string, SearchResult>();
  for (const r of allResults) {
    const key = `${r.title}|${r.size}`;
    if (!deduped.has(key)) deduped.set(key, r);
  }
  const results = [...deduped.values()];

  console.log(`[Cardigann] ${entry.name} returned ${results.length} results (from ${seen.size} URL(s))`);

  return results;
}

// ─── HTML result parser ────────────────────────────────────────────────────────

function parseHtmlResults(
  entry: DefinitionEntry, html: string, query: SearchQuery,
  baseUrl: string, config: ExecutorConfig,
): SearchResult[] {
  const def = entry.raw;
  const search = def.search as Record<string, unknown>;
  const rows = search?.['rows'] as Record<string, unknown> | undefined;
  const fields = search?.['fields'] as Record<string, unknown> | undefined;
  if (!rows || !fields) return [];

  const $ = cheerio.load(html);
  const rawSelector = (rows['selector'] as string) ?? 'tr';
  const selector = renderTemplate(rawSelector, buildContext(query, config, entry));
  const after = (rows['after'] as number) ?? 0;
  const results: SearchResult[] = [];

  $(selector).slice(after).each((_, el) => {
    try {
      const result = extractResult(entry, $(el), fields, $ as any, baseUrl, query, config);
      if (result) results.push(result);
    } catch (e: any) {
      console.error(`[Cardigann] ${entry.name} failed to extract HTML row: ${e.message}`);
    }
  });
  return results;
}

function extractResult(
  entry: DefinitionEntry, row: any, fields: Record<string, unknown>,
  $: cheerio.CheerioAPI | null, baseUrl: string, query: SearchQuery, config: ExecutorConfig,
): SearchResult | null {
  const currentResult: Record<string, string> = {};
  const get = (name: string): string => {
    const fd = fields[name] as Record<string, unknown> | string | undefined;
    if (!fd) return '';
    if (typeof fd === 'string') return fd;
    const val = extractField(entry, row, fd, $, baseUrl, query, config, currentResult);
    currentResult[name] = val; // Store all fields for other fields to use in templates
    return val;
  };

  for (const name of Object.keys(fields)) get(name);

  const title = get('title');
  let downloadUrl = get('download');
  let magnet = get('magneturl');
  const infoHash = get('infohash');

  if (!magnet && infoHash) magnet = `magnet:?xt=urn:btih:${infoHash.toLowerCase()}&dn=${encodeURIComponent(title)}`;
  if (!downloadUrl && magnet) downloadUrl = magnet;

  if (!title || !downloadUrl) {
    return null;
  }

  const finalDownloadUrl = downloadUrl.startsWith('http') || downloadUrl.startsWith('magnet:')
    ? downloadUrl : baseUrl + (downloadUrl.startsWith('/') ? downloadUrl.slice(1) : downloadUrl);

  // Try to map the result's internal category back to Torznab IDs
  const rawCat = currentResult['category']?.trim();
  let resultCats: number[] = [];
  if (rawCat) {
    // Exact match first
    let matchedMappings = entry.categories.filter(m =>
      String(m.id) === rawCat || m.cat === rawCat
    );
    // Fuzzy fallback: try matching just the first word/token (handles "Movies    , by" → "Movies")
    if (matchedMappings.length === 0) {
      const cleaned = rawCat.replace(/\s*[,;].*$/, '').trim();
      if (cleaned && cleaned !== rawCat) {
        matchedMappings = entry.categories.filter(m =>
          String(m.id) === cleaned || m.cat === cleaned
        );
      }
    }
    if (matchedMappings.length > 0) {
      for (const m of matchedMappings) {
        // Find the Torznab ID by matching the name in our dictionary
        const catEntry = Object.entries(TORZNAB_CATEGORIES).find(([_id, name]) => name === m.cat);
        if (catEntry) resultCats.push(parseInt(catEntry[0], 10));
      }
    }
  }
  // DIAG: trace category extraction per result
  console.log(`[Cardigann:DIAG] ${entry.name} result="${title?.slice(0,50)}" rawCat="${rawCat}" resultCats=${JSON.stringify(resultCats)}`);

  // If no mapping found, mark as unknown (0) — do NOT inherit query categories,
  // that would make every result appear to match regardless of actual content type.
  if (resultCats.length === 0) {
    resultCats = [0];
  }
  return {
    guid: `${entry.id}:${finalDownloadUrl}`,
    title, indexerId: entry.id, indexerName: entry.name, type: 'torrent',
    category: resultCats[0], categories: resultCats,
    publishDate: parseDate(get('date')), size: parseSize(get('size')), files: null,
    grabs: get('grabs') ? parseInt(get('grabs'), 10) : null,
    seeders: get('seeders') ? parseInt(get('seeders'), 10) : null,
    leechers: get('leechers') ? parseInt(get('leechers'), 10) : null,
    infoHash: infoHash || null, magnetUrl: magnet && magnet.startsWith('magnet:') ? magnet : null,
    downloadUrl: finalDownloadUrl,
    infoUrl: get('details') ? (get('details').startsWith('http') ? get('details') : baseUrl + (get('details').startsWith('/') ? get('details').slice(1) : get('details'))) : null,
    nzbUrl: null, usenetDate: null, age: null, imdbId: null, tmdbId: null, tvdbId: null, indexerFlags: [],
  };
}

function parseJsonResults(
  entry: DefinitionEntry, body: string, query: SearchQuery,
  baseUrl: string, config: ExecutorConfig,
): SearchResult[] {
  let data: any;
  try { data = JSON.parse(body); } catch { return []; }

  const def = entry.raw;
  const search = def.search as Record<string, any>;
  const rows = search?.['rows'] as Record<string, any> | undefined;
  const fields = search?.['fields'];
  if (!fields) return [];

  if (!Array.isArray(data)) {
    if (data && typeof data === 'object') {
      const keys = Object.keys(data);
      const possibleArray = keys.find(k => Array.isArray(data[k]));
      if (possibleArray) data = data[possibleArray];
      else return [];
    } else return [];
  }

  // Handle rows selector for JSON if present (e.g. filtering out "No results")
  const rawSelector = rows?.['selector'];
  if (rawSelector) {
    const selector = renderTemplate(rawSelector, buildContext(query, config, entry));
    // Basic support for :has(key:contains(val)) or simple key checks
    if (selector.includes(':has')) {
      const match = selector.match(/:has\((.*?):contains\((.*?)\)\)/);
      if (match) {
        const [, key, val] = match;
        const searchVal = val?.trim() ?? '';
        if (searchVal) {
          data = data.filter((item: any) => {
            const itemVal = String(item[key?.trim() ?? ''] ?? '');
            return itemVal.includes(searchVal);
          });
        }
      }
    }
  }

  const results: SearchResult[] = [];
  for (const item of data) {
    try {
      const result = extractResult(entry, item, fields, null, baseUrl, query, config);
      if (result) {
        // Special case for PirateBay "No results returned" JSON
        if (result.title === 'No results returned' && result.downloadUrl.includes('urn:btih:0000000000000000000000000000000000000000')) {
          continue;
        }
        results.push(result);
      }
    } catch (e: any) {
      console.error(`[Cardigann] ${entry.name} failed to extract JSON item: ${e.message}`);
    }
  }
  return results;
}

function parseXmlResults(
  entry: DefinitionEntry, body: string, query: SearchQuery, baseUrl: string,
): SearchResult[] {
  const $ = cheerio.load(body, { xmlMode: true });
  const results: SearchResult[] = [];
  $('item').each((_, el) => {
    const item = $(el);
    const title = item.find('title').first().text();
    const link = (item.find('link').first().text() || item.find('enclosure').attr('url') || '');
    if (!title || !link) return;
    const size = parseInt((item.find('size').text() || item.find('enclosure').attr('length') || '0'), 10);
    const seeders = parseInt(item.find('torznab\\:attr[name="seeders"]').attr('value') ?? '0', 10);
    const cats = item.find('torznab\\:attr[name="category"]').map((_, e) => parseInt($(e).attr('value') ?? '0', 10)).get();
    results.push({
      guid: item.find('guid').text() || link, title, indexerId: entry.id, indexerName: entry.name, type: 'torrent',
      category: cats[0] ?? 0, categories: cats, publishDate: parseDate(item.find('pubDate').text()),
      size: isNaN(size) ? 0 : size, files: null, grabs: null, seeders: isNaN(seeders) ? null : seeders,
      leechers: null, infoHash: null, magnetUrl: null, downloadUrl: link, infoUrl: item.find('comments').text() || null,
      nzbUrl: null, usenetDate: null, age: null, imdbId: null, tmdbId: null, tvdbId: null, indexerFlags: [],
    });
  });
  return results;
}

function parseSize(s: string): number {
  if (!s) return 0;
  const units: Record<string, number> = { b: 1, kb: 1024, mb: 1024**2, gb: 1024**3, tb: 1024**4, kib: 1024, mib: 1024**2, gib: 1024**3, tib: 1024**4 };
  const m = s.trim().match(/^([\d.,]+)\s*([a-z]+)?$/i);
  if (!m) return parseInt(s, 10) || 0;
  const num = parseFloat((m[1] ?? '0').replace(',', '.'));
  const unit = (m[2] ?? 'b').toLowerCase();
  return Math.round(num * (units[unit] ?? 1));
}

function parseDate(s: string): number {
  if (!s) return Date.now();
  if (/^\d+$/.test(s.trim())) {
    const n = parseInt(s.trim(), 10);
    return n < 10000000000 ? n * 1000 : n;
  }
  const relative = s.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (relative) {
    const n = parseInt(relative[1] ?? '0', 10);
    const ms: Record<string, number> = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 };
    return Date.now() - n * (ms[relative[2]?.toLowerCase() ?? ''] ?? 0);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

export class ExecutorError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ExecutorError'; }
}
