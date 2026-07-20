import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type {
  PlayerBrowseFilter,
  PlayerBrowsePage,
  PlayerFilterableContentType,
  PlayerPreferencesV1,
  PlayerSavedFilter,
  PlayerSortOrder,
  PlayerView,
  PlayerWidget,
  PlayerWidgetSort,
} from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { playerStore, usePlayerSelector } from '../lib/store.js'
import { BrowseOptionsDrawer } from '../components/BrowseOptions.js'
import { WidgetRail } from '../components/Rail.js'

type BrowseSort = Exclude<PlayerWidgetSort, 'source'>
const EMPTY: PlayerBrowseFilter = { query: '', genres: [], yearFrom: null, yearTo: null, studios: [], ratingMin: null, availability: 'available', watched: 'all', alphabet: null, collectionId: null }

function slug(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'view'
}

function uniqueId(prefix: string, ids: string[]): string {
  for (let index = 1; index < 100; index++) {
    const id = `${prefix}-${index}`
    if (!ids.includes(id)) return id
  }
  return `${prefix}-${Date.now().toString(36)}`
}

export function BrowsePage({ sdk, requestedType }: { sdk: ArchivistSdk; requestedType: PlayerFilterableContentType | 'saved' }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const envelope = usePlayerSelector(state => state.preferences)
  const initialSavedId = params.get('savedFilter')
  const [activeSavedId, setActiveSavedId] = useState<string | null>(initialSavedId)
  const saved = envelope?.preferences.browsing.savedFilters.find(entry => entry.id === activeSavedId) ?? null
  const mediaType = (requestedType === 'saved' ? saved?.mediaType : requestedType) ?? 'films'
  const library = mediaType === 'films' || mediaType === 'series' ? envelope?.preferences.libraries[mediaType] : null
  const source = params.get('source')
  const collectionId = params.get('collectionId')
  const sourceFilters = source === 'unwatched-series' ? { watched: 'unwatched' as const }
    : source === 'unwatched-episodes' ? { watched: 'unwatched' as const, availability: 'available' as const }
      : source === 'top-rated-films' || source === 'random-films' ? { availability: 'available' as const }
        : {}
  const initialFilters = useMemo(() => saved?.filters ?? {
    ...EMPTY,
    ...(library?.hideUnavailable ? { availability: 'available' as const } : {}),
    ...sourceFilters,
    collectionId: collectionId ? Number(collectionId) : null,
  }, [saved?.id, collectionId, library?.hideUnavailable, source])
  const [filters, setFilters] = useState<PlayerBrowseFilter>(initialFilters)
  const [view, setView] = useState<PlayerView>(saved?.view ?? envelope?.preferences.browsing.defaultViews[mediaType] ?? library?.view ?? (mediaType === 'episodes' ? 'landscape' : 'poster'))
  const [sort, setSort] = useState<BrowseSort>(saved?.sort ?? library?.sort ?? (source?.startsWith('top-rated') ? 'rating' : 'title'))
  const [sortOrder, setSortOrder] = useState<PlayerSortOrder>(saved?.sortOrder ?? library?.sortOrder ?? (source?.startsWith('top-rated') ? 'desc' : 'asc'))
  const [page, setPage] = useState<PlayerBrowsePage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    if (saved) {
      setFilters(saved.filters); setView(saved.view); setSort(saved.sort); setSortOrder(saved.sortOrder)
    }
  }, [saved?.id])

  useEffect(() => {
    const controller = new AbortController()
    setPage(null); setError(null)
    sdk.browse(activeSavedId ? 'saved' : mediaType, {
      savedFilter: activeSavedId,
      source: activeSavedId ? null : source,
      filters: activeSavedId ? undefined : filters,
      sort: activeSavedId ? undefined : sort,
      direction: activeSavedId ? undefined : sortOrder,
      limit: view === 'list' ? 60 : 36,
    }, controller.signal).then(setPage).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => controller.abort()
  }, [sdk, mediaType, activeSavedId, source, filters, sort, sortOrder, view])

  if (!envelope) return <div className="player-safe player-skeleton">Loading browser</div>
  const preferences = envelope.preferences
  const savedForType = preferences.browsing.savedFilters.filter(entry => entry.mediaType === mediaType)
  const persist = async (next: PlayerPreferencesV1) => {
    const updated = await sdk.updatePreferences({ profileId: envelope.profileId, expectedRevision: envelope.revision, preferences: next })
    playerStore.dispatch({ type: 'PREFERENCES_SAVED', envelope: updated })
  }
  const asSaved = (id: string, name: string, nextFilters: PlayerBrowseFilter, nextView: PlayerView, nextSort: BrowseSort, nextOrder: PlayerSortOrder): PlayerSavedFilter => ({
    id, name, mediaType, filters: nextFilters, view: nextView, sort: nextSort, sortOrder: nextOrder,
  })
  const saveView = async (name: string, nextFilters: PlayerBrowseFilter, nextView: PlayerView, nextSort: BrowseSort, nextOrder: PlayerSortOrder) => {
    const ids = preferences.browsing.savedFilters.map(entry => entry.id)
    const id = activeSavedId ?? uniqueId(slug(name), ids)
    const nextSaved = asSaved(id, name, nextFilters, nextView, nextSort, nextOrder)
    await persist({ ...preferences, browsing: { ...preferences.browsing, savedFilters: [...preferences.browsing.savedFilters.filter(entry => entry.id !== id), nextSaved] } })
    setActiveSavedId(id)
  }
  const pinView = async (hubId: string, name: string, nextFilters: PlayerBrowseFilter, nextView: PlayerView, nextSort: BrowseSort, nextOrder: PlayerSortOrder) => {
    const ids = preferences.browsing.savedFilters.map(entry => entry.id)
    const id = activeSavedId ?? uniqueId(slug(name), ids)
    const nextSaved = asSaved(id, name, nextFilters, nextView, nextSort, nextOrder)
    const hub = preferences.home.hubs.find(entry => entry.id === hubId)
    if (!hub) throw new Error('Hub not found')
    if (hub.widgets.length >= 12) throw new Error(`${hub.name} already has 12 widgets`)
    const widgetId = uniqueId('saved', hub.widgets.map(entry => entry.id))
    const homes = preferences.home.hubs.map(entry => entry.id === hubId ? {
      ...entry,
      widgets: [...entry.widgets, {
        id: widgetId, title: name, source: 'saved-filter' as const, savedFilterId: id, view: nextView,
        sort: 'source' as const, sortOrder: nextOrder, limit: 18 as const, autoscrollSeconds: 0 as const, downloadMediaTypes: [], enabled: true,
      }],
    } : entry)
    await persist({
      ...preferences,
      home: { hubs: homes },
      browsing: { ...preferences.browsing, savedFilters: [...preferences.browsing.savedFilters.filter(entry => entry.id !== id), nextSaved] },
    })
    setActiveSavedId(id)
  }
  const setDefault = async (nextView: PlayerView) => {
    const next = { ...preferences, browsing: { ...preferences.browsing, defaultViews: { ...preferences.browsing.defaultViews, [mediaType]: nextView } } }
    if (mediaType === 'films' || mediaType === 'series') next.libraries = { ...next.libraries, [mediaType]: { ...next.libraries[mediaType], view: nextView } }
    await persist(next)
  }
  const loadMore = (widget: PlayerWidget) => {
    if (!widget.nextCursor || loadingMore) return
    setLoadingMore(true)
    void sdk.browse(activeSavedId ? 'saved' : mediaType, {
      savedFilter: activeSavedId, source: activeSavedId ? null : source, filters: activeSavedId ? undefined : filters,
      sort: activeSavedId ? undefined : sort, direction: activeSavedId ? undefined : sortOrder, cursor: widget.nextCursor,
      limit: view === 'list' ? 60 : 36,
    }).then(next => setPage(current => current ? {
      ...next,
      items: [...current.items, ...next.items.filter(item => !current.items.some(existing => existing.key === item.key))],
    } : next)).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setLoadingMore(false))
  }
  const apply = (nextFilters: PlayerBrowseFilter, nextView: PlayerView, nextSort: BrowseSort, nextOrder: PlayerSortOrder) => {
    setActiveSavedId(null); setFilters(nextFilters); setView(nextView); setSort(nextSort); setSortOrder(nextOrder)
  }
  const widget: PlayerWidget | null = page ? {
    id: 'browse-results', title: page.title, source: mediaType === 'films' ? 'films-az' : mediaType === 'series' ? 'series-az' : mediaType === 'collections' ? 'collections' : 'unwatched-episodes',
    view, sort, sortOrder, autoscrollSeconds: 0, items: page.items, nextCursor: page.nextCursor, total: page.total, showMoreRoute: null,
  } : null
  const title = saved?.name ?? (source ? source.split('-').map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ') : mediaType[0].toUpperCase() + mediaType.slice(1))

  return <div data-route-scroll className="h-full overflow-y-auto no-scrollbar pb-20">
    <header className="mb-8 flex items-start gap-3"><div><h1 className={`font-display text-5xl uppercase tracking-widest ${mediaType === 'series' || mediaType === 'episodes' ? 'text-violet' : 'text-cyan'}`}>{title}</h1><p className="mt-1 font-mono text-sm uppercase text-white/30">{mediaType}</p></div><div className="ml-auto flex items-center gap-2"><button onClick={() => setOptionsOpen(true)} className="player-focusable rounded-lg border border-white/10 bg-noir-800 px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-white/60 hover:bg-white/5 hover:text-white">Filter and sort</button></div></header>
    <nav aria-label="Jump to title" className="mb-6 flex flex-wrap gap-1">{['#',...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => <button key={letter} aria-pressed={filters.alphabet === letter} onClick={() => { setActiveSavedId(null); setFilters(current => ({ ...current, alphabet: current.alphabet === letter ? null : letter })) }} className={`player-focusable h-8 min-w-8 rounded-lg px-2 text-xs font-semibold ${filters.alphabet === letter ? 'bg-white text-black' : 'bg-white/6 text-white/45'}`}>{letter}</button>)}</nav>
    {error && <div role="alert" className="rounded-2xl bg-pink/10 p-5 text-pink">{error}</div>}
    {!page && !error && <div className="player-skeleton mt-16 h-64 rounded-2xl bg-white/8" />}
    {widget && <WidgetRail widget={widget} hubLayout={view === 'wall' ? 'wall' : 'standard'} sdk={sdk} onItemFocused={item => playerStore.dispatch({ type: 'MEDIA_CONTEXT_CHANGED', item })} onActivate={item => navigate(item.route)} onLoadMore={loadMore} />}
    {page && page.items.length === 0 && <div className="mt-20 rounded-2xl border border-dashed border-white/15 p-12 text-center text-white/45">No items match these filters.</div>}
    {loadingMore && <p className="mt-4 text-center text-sm text-white/35">Loading more…</p>}
    <BrowseOptionsDrawer mediaType={mediaType} open={optionsOpen} filters={filters} facets={page?.facets ?? { genres: [], studios: [], yearMin: null, yearMax: null }} view={view} sort={sort} sortOrder={sortOrder} onClose={() => setOptionsOpen(false)} onApply={apply} />
  </div>
}
