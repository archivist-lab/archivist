// Torznab client + server
//
// CLIENT: query any Torznab-compatible endpoint (Jackett, Prowlarr, etc.)
// SERVER: expose our configured indexers as a Torznab endpoint so *arr apps
//         (Sonarr, Radarr, etc.) can point at torrentstack directly.
//
// Torznab is an extension of Newznab for torrents.
// Spec: https://torznab.github.io/spec-1.3-draft/

import * as cheerio from 'cheerio';
import type { SearchQuery, SearchResult, IndexerCapabilities } from '@torrentstack/types';

// ─── Torznab client ───────────────────────────────────────────────────────────

export interface TorznabClientConfig {
  baseUrl:   string;
  apiKey?:   string;
  apiPath?:  string;          // default: /api
  timeoutMs?: number;
}

export async function torznabSearch(
  config: TorznabClientConfig,
  query: SearchQuery,
): Promise<SearchResult[]> {
  const url    = buildTorznabUrl(config, query.type ?? 'search', query);
  try {
    const resp   = await fetch(url, {
      headers: { 'User-Agent': 'TorrentStack/0.1.0' },
      signal:  AbortSignal.timeout(config.timeoutMs ?? 15_000),
    });
    if (!resp.ok) throw new TorznabError(`HTTP ${resp.status}`);
    const xml = await resp.text();
    return parseTorznabXml(xml, config.baseUrl);
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new TorznabError('Request timed out');
    throw new TorznabError(`Fetch failed for ${new URL(url).origin}: ${e.message}${e.cause ? ' (' + e.cause.message + ')' : ''}`);
  }
}

export async function torznabCaps(config: TorznabClientConfig): Promise<IndexerCapabilities> {
  const url    = buildTorznabUrl(config, 'caps', {});
  try {
    const resp   = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs ?? 10_000) });
    if (!resp.ok) throw new TorznabError(`HTTP ${resp.status}`);
    const xml = await resp.text();
    return parseCaps(xml);
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new TorznabError('Request timed out');
    throw new TorznabError(`Fetch failed for ${new URL(url).origin}: ${e.message}${e.cause ? ' (' + e.cause.message + ')' : ''}`);
  }
}

function buildTorznabUrl(
  config: TorznabClientConfig,
  t: string,
  query: Partial<SearchQuery>,
): string {
  const base   = config.baseUrl.replace(/\/$/, '');
  let path     = config.apiPath ?? '/api';

  // If baseUrl already looks like a full Torznab/Newznab API endpoint, don't append /api
  if (base.endsWith('/api') || base.endsWith('/torznab') || base.includes('/api/v2.0/indexers/')) {
    path = '';
  }

  const params = new URLSearchParams({ t });

  if (config.apiKey) params.set('apikey', config.apiKey);

  if (query.q)          params.set('q',        query.q);
  if (query.categories?.length) params.set('cat', query.categories.join(','));
  if (query.season)     params.set('season',   String(query.season));
  if (query.episode)    params.set('ep',       String(query.episode));
  if (query.imdbId)     params.set('imdbid',   query.imdbId);
  if (query.tmdbId)     params.set('tmdbid',   String(query.tmdbId));
  if (query.tvdbId)     params.set('tvdbid',   String(query.tvdbId));
  if (query.limit)      params.set('limit',    String(query.limit));
  if (query.offset)     params.set('offset',   String(query.offset));

  return `${base}${path}?${params}`;
}

function parseTorznabXml(xml: string, baseUrl: string): SearchResult[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const results: SearchResult[] = [];

  $('item').each((_, el) => {
    const item     = $(el);
    const attr     = (name: string) =>
      item.find(`torznab\\:attr[name="${name}"]`).attr('value') ??
      item.find(`newznab\\:attr[name="${name}"]`).attr('value') ?? '';

    const title    = item.find('title').first().text();
    const link     = (item.find('link').first().text()
                  || item.find('enclosure').attr('url') || '');
    const guid     = item.find('guid').text() || link;
    const size     = parseInt((item.find('size').text() || item.find('enclosure').attr('length') || '0'), 10);
    const pubDate  = item.find('pubDate').text();
    const seeders  = parseInt(attr('seeders') || '0', 10);
    const leechers = parseInt(attr('leechers') || '0', 10);
    const grabs    = parseInt(attr('grabs') || '0', 10);
    const infoHash = attr('infohash');
    const magnet   = attr('magneturl');
    const cats     = item.find('torznab\\:attr[name="category"], newznab\\:attr[name="category"]')
      .map((_, e) => parseInt($(e).attr('value') ?? '0', 10)).get()
      .filter(n => n > 0);

    if (!title || !link) return;

    results.push({
      guid,
      title,
      indexerId:   baseUrl,
      indexerName: baseUrl,
      type:        'torrent',
      category:    cats[0] ?? 0,
      categories:  cats,
      publishDate: pubDate ? new Date(pubDate).getTime() : Date.now(),
      size:        isNaN(size) ? 0 : size,
      files:       null,
      grabs:       isNaN(grabs) ? null : grabs,
      seeders:     isNaN(seeders) ? null : seeders,
      leechers:    isNaN(leechers) ? null : leechers,
      infoHash:    infoHash || null,
      magnetUrl:   magnet || null,
      downloadUrl: link,
      infoUrl:     item.find('comments').text() || null,
      nzbUrl:      null,
      usenetDate:  null,
      age:         null,
      imdbId:      item.find('torznab\\:attr[name="imdb"]').attr('value') ?? null,
      tmdbId:      null,
      tvdbId:      null,
      indexerFlags:[],
    });
  });

  return results;
}

function parseCaps(xml: string): IndexerCapabilities {
  const $ = cheerio.load(xml, { xmlMode: true });
  const cats: Array<{ id: number; name: string; subCategories: Array<{ id: number; name: string; subCategories: never[] }> }> = [];

  $('categories category').each((_, el) => {
    const id   = parseInt($(el).attr('id') ?? '0', 10);
    const name = $(el).attr('name') ?? '';
    const subs: Array<{ id: number; name: string; subCategories: never[] }> = [];
    $(el).find('subcat').each((__, sub) => {
      subs.push({
        id:   parseInt($(sub).attr('id') ?? '0', 10),
        name: $(sub).attr('name') ?? '',
        subCategories: [],
      });
    });
    cats.push({ id, name, subCategories: subs });
  });

  const searching = $('searching');

  return {
    searchAvailable:      searching.find('search').attr('available') === 'yes',
    tvSearchAvailable:    searching.find('tv-search').attr('available') === 'yes',
    movieSearchAvailable: searching.find('movie-search').attr('available') === 'yes',
    musicSearchAvailable: searching.find('audio-search').attr('available') === 'yes',
    bookSearchAvailable:  searching.find('book-search').attr('available') === 'yes',
    categories:           cats,
    supportsRss:          true,
    supportsSearch:       true,
  };
}

// ─── Torznab XML builder (for our server endpoint) ────────────────────────────

export function buildTorznabResponse(results: SearchResult[], queryMs: number): string {
  const items = results.map(r => {
    const cats = r.categories.map(c => `<torznab:attr name="category" value="${c}"/>`).join('\n          ');
    return `
    <item>
      <title><![CDATA[${escXml(r.title)}]]></title>
      <guid isPermaLink="false">${escXml(r.guid)}</guid>
      <link>${escXml(r.downloadUrl)}</link>
      ${r.infoUrl ? `<comments>${escXml(r.infoUrl)}</comments>` : ''}
      <pubDate>${new Date(r.publishDate).toUTCString()}</pubDate>
      <size>${r.size}</size>
      <enclosure url="${escXml(r.downloadUrl)}" length="${r.size}" type="application/x-bittorrent"/>
      ${r.magnetUrl ? `<torznab:attr name="magneturl" value="${escXml(r.magnetUrl)}"/>` : ''}
      ${r.infoHash  ? `<torznab:attr name="infohash"  value="${r.infoHash}"/>` : ''}
      <torznab:attr name="seeders"  value="${r.seeders  ?? 0}"/>
      <torznab:attr name="leechers" value="${r.leechers ?? 0}"/>
      <torznab:attr name="grabs"    value="${r.grabs    ?? 0}"/>
      <torznab:attr name="size"     value="${r.size}"/>
      ${cats}
    </item>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>TorrentStack</title>
    <description>TorrentStack Torznab Feed</description>
    <response offset="0" total="${results.length}"/>
    ${items}
  </channel>
</rss>`;
}

export function buildCapsResponse(caps: IndexerCapabilities, appName = 'TorrentStack'): string {
  const cats = caps.categories.map(c => {
    const subs = c.subCategories.map(s => `<subcat id="${s.id}" name="${escXml(s.name)}"/>`).join('');
    return `<category id="${c.id}" name="${escXml(c.name)}">${subs}</category>`;
  }).join('\n    ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="${appName}" version="0.1.0" url="http://localhost:9090"/>
  <limits max="100" default="50"/>
  <registration available="no" open="no"/>
  <searching>
    <search available="${caps.searchAvailable ? 'yes' : 'no'}" supportedParams="q,cat"/>
    <tv-search available="${caps.tvSearchAvailable ? 'yes' : 'no'}" supportedParams="q,season,ep,cat,tvdbid,imdbid"/>
    <movie-search available="${caps.movieSearchAvailable ? 'yes' : 'no'}" supportedParams="q,cat,imdbid,tmdbid"/>
    <music-search available="${caps.musicSearchAvailable ? 'yes' : 'no'}" supportedParams="q,cat"/>
    <audio-search available="${caps.musicSearchAvailable ? 'yes' : 'no'}" supportedParams="q,cat"/>
    <book-search available="${caps.bookSearchAvailable ? 'yes' : 'no'}" supportedParams="q,cat"/>
  </searching>
  <categories>
    ${cats}
  </categories>
</caps>`;
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
           .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export class TorznabError extends Error {
  constructor(msg: string) { super(msg); this.name = 'TorznabError'; }
}
