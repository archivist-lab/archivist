import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { tmdbImage } from '../../lib/api.js'
import { librarySlug, useTabs, type Tab } from '../../lib/tab-context.js'
import { recommendationsApi, type RecommendationFeedback, type RecommendationItem, type RecommendationMediaType, type RecommendationPage } from '../../lib/recommendations.api.js'
import { EmptyState, LibraryCard, PosterSkeleton } from '../../components/ui.js'
import { SearchDetailModal } from '../../components/SearchDetailModal.js'
import { RecommendationFeedbackBar } from '../../components/RecommendationFeedbackBar.js'
import { toast } from '../../lib/notify.js'

/** Items shown inline on a library row before the "show more" tile. */
const ROW_LIMIT = 10

const STYLES: Record<string, { mediaType: RecommendationMediaType; accent: string; icon: string; label: string }> = {
  films: { mediaType: 'film', accent: '#00D4FF', icon: '🎬', label: 'Films' },
  series: { mediaType: 'series', accent: '#9B59B6', icon: '📺', label: 'Series' },
}

interface Feed {
  page: RecommendationPage | null
  loading: boolean
  error: string
}

/** Flatten a page's groups into a single de-duplicated item list. */
function flatten(page: RecommendationPage | null): RecommendationItem[] {
  if (!page) return []
  const seen = new Set<number>()
  const items: RecommendationItem[] = []
  for (const group of page.groups) {
    for (const item of group.items) {
      if (seen.has(item.providerId)) continue
      seen.add(item.providerId)
      items.push(item)
    }
  }
  return items
}

const relative = (iso?: string) => {
  if (!iso) return 'Never'
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (!Number.isFinite(minutes)) return 'Never'
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * The recommendations themselves: one row per library, ten titles each, with a
 * tile that opens the full set for that library.
 */
export function RecommendationsBrowserTab() {
  const { tabs, setActiveTabForMedia } = useTabs()
  const navigate = useNavigate()
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([])
  const [profileId, setProfileId] = useState('household')
  const [feeds, setFeeds] = useState<Record<number, Feed>>({})
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [rebuilding, setRebuilding] = useState<number | null>(null)
  const [selected, setSelected] = useState<{ item: RecommendationItem; library: Tab } | null>(null)

  const libraries = useMemo(
    () => (Array.isArray(tabs) ? tabs : []).filter(tab => tab.media_type in STYLES),
    [tabs])

  const loadLibrary = useCallback(async (library: Tab) => {
    const style = STYLES[library.media_type]
    setFeeds(current => ({ ...current, [library.id]: { page: current[library.id]?.page ?? null, loading: true, error: '' } }))
    try {
      const page = await recommendationsApi.forLibrary(library.id, style.mediaType, profileId)
      setFeeds(current => ({ ...current, [library.id]: { page, loading: false, error: '' } }))
    } catch (error) {
      setFeeds(current => ({ ...current, [library.id]: { page: null, loading: false, error: String(error) } }))
    }
  }, [profileId])

  useEffect(() => {
    recommendationsApi.profiles()
      .then(result => { if (result.profiles.length) setProfileId(current => current === 'household' ? result.profiles[0].id : current); setProfiles(result.profiles) })
      .catch(() => { /* household view still works without profiles */ })
  }, [])

  useEffect(() => { void Promise.all(libraries.map(loadLibrary)) }, [libraries, loadLibrary])

  const rebuild = async (library: Tab) => {
    setRebuilding(library.id)
    try {
      const page = await recommendationsApi.rebuildLibrary(library.id, profileId)
      setFeeds(current => ({ ...current, [library.id]: { page, loading: false, error: '' } }))
      toast.success(`Rebuilt recommendations for ${library.name}`)
    } catch (error) { toast.error(String(error)) }
    finally { setRebuilding(null) }
  }

  const submitFeedback = async (library: Tab, item: RecommendationItem, feedback: RecommendationFeedback) => {
    try {
      await recommendationsApi.feedback(profileId, STYLES[library.media_type].mediaType, item.providerId, feedback)
      setSelected(null)
      await loadLibrary(library)
      toast.success('Recommendation feedback saved')
    } catch (error) { toast.error(String(error)) }
  }

  /** Hand off to the library module, which owns the real add / detail flows. */
  const openInLibrary = (library: Tab, item: RecommendationItem, mode: 'view' | 'add') => {
    setActiveTabForMedia(library.media_type, library.id)
    setSelected(null)
    if (library.media_type === 'series') {
      navigate(mode === 'view' && item.localId ? `/series/${item.localId}` : `/series/add?q=${encodeURIComponent(item.title)}&discover=1`)
      return
    }
    const base = `/films/${librarySlug(library.name)}`
    navigate(mode === 'view' && item.localId ? `${base}/${item.localId}` : `${base}/add?q=${encodeURIComponent(item.title)}&discover=1`)
  }

  const expanded = expandedId ? libraries.find(library => library.id === expandedId) ?? null : null

  const profileSelect = (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[9px] uppercase tracking-widest text-white/25">Viewer</span>
      <select
        value={profileId}
        onChange={event => setProfileId(event.target.value)}
        className="rounded-lg border border-white/10 bg-noir-800 px-3 py-2 text-xs text-white/70"
      >
        <option value="household">Household (shared)</option>
        {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
    </div>
  )

  const detail = selected && (() => {
    const { item, library } = selected
    const style = STYLES[library.media_type]
    return (
      <SearchDetailModal
        onClose={() => setSelected(null)}
        onAdd={() => openInLibrary(library, item, 'add')}
        onView={item.localId ? () => openInLibrary(library, item, 'view') : undefined}
        actions={<RecommendationFeedbackBar disabled={profileId === 'household'} onFeedback={feedback => void submitFeedback(library, item, feedback)} />}
        isAdded={item.alreadyAdded}
        accentColor={style.accent}
        fallbackIcon={style.icon}
        addLabel="Find & Add"
        image={tmdbImage(item.posterPath)}
        backdrop={tmdbImage(item.backdropPath, 'w1280')}
        title={item.title}
        year={item.year}
        rating={item.rating}
        genres={item.genres}
        overview={item.overview}
        facts={[
          { label: 'Why this', value: item.recommendation.reason },
          { label: 'Library', value: library.name },
          { label: 'Availability', value: item.recommendation.availability.split('_').join(' ') },
          { label: item.mediaType === 'film' ? 'Studio' : 'Network', value: item.studio ?? item.network },
        ]}
      />
    )
  })()

  if (!libraries.length) {
    return <EmptyState icon="✨" title="NO FILM OR SERIES LIBRARIES" subtitle="Recommendations are generated per film and series library." />
  }

  if (expanded) {
    const style = STYLES[expanded.media_type]
    const feed = feeds[expanded.id]
    return (
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => setExpandedId(null)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-white/50 hover:text-white">← All libraries</button>
          <div className="min-w-0">
            <h2 className="font-display text-2xl uppercase tracking-widest text-white/85">{style.icon} {expanded.name}</h2>
            <p className="mt-0.5 text-[11px] text-white/30">
              {flatten(feed?.page ?? null).length} recommendations · generated {relative(feed?.page?.generatedAt)}
              {feed?.page?.stale ? ' · refreshing in the background' : ''}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            {profileSelect}
            <button
              onClick={() => void rebuild(expanded)}
              disabled={rebuilding === expanded.id}
              className="rounded-xl border px-4 py-2 text-[10px] font-bold uppercase tracking-widest disabled:opacity-40"
              style={{ borderColor: `${style.accent}40`, background: `${style.accent}1a`, color: style.accent }}
            >{rebuilding === expanded.id ? 'Rebuilding…' : 'Rebuild'}</button>
          </div>
        </div>
        {feed?.loading && !feed.page ? <PosterSkeleton />
          : feed?.error ? <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">{feed.error}</div>
          : !feed?.page?.groups.length ? <EmptyState icon="✨" title="NO RECOMMENDATIONS YET" subtitle="Watch or rate a few titles, then rebuild." />
          : (
            <div className="space-y-9">
              {feed.page.groups.map(group => (
                <section key={group.id}>
                  <div className="mb-4 flex items-center gap-4">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-white/55">{group.title}</h3>
                    <span className="font-mono text-[10px] text-white/20">{group.items.length}</span>
                    <div className="h-px flex-1 bg-white/5" />
                  </div>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                    {group.items.map(item => (
                      <RecommendationTile key={`${group.id}:${item.providerId}`} item={item} accent={style.accent} icon={style.icon} onClick={() => setSelected({ item, library: expanded })} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        {detail}
      </div>
    )
  }

  return (
    <div className="animate-fade-in space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-display text-3xl tracking-widest text-white">RECOMMENDATIONS</h2>
          <p className="mt-2 text-xs text-white/35">Ten picks per library, drawn from what you have watched, rated and collected. Open a row to see everything.</p>
        </div>
        {profileSelect}
      </div>
      <div className="space-y-5">
        {libraries.map(library => (
          <LibraryRow
            key={library.id}
            library={library}
            feed={feeds[library.id]}
            rebuilding={rebuilding === library.id}
            onRebuild={() => void rebuild(library)}
            onShowMore={() => setExpandedId(library.id)}
            onSelect={item => setSelected({ item, library })}
          />
        ))}
      </div>
      {detail}
    </div>
  )
}

function LibraryRow({ library, feed, rebuilding, onRebuild, onShowMore, onSelect }: {
  library: Tab
  feed?: Feed
  rebuilding: boolean
  onRebuild: () => void
  onShowMore: () => void
  onSelect: (item: RecommendationItem) => void
}) {
  const style = STYLES[library.media_type]
  const items = flatten(feed?.page ?? null)
  const shown = items.slice(0, ROW_LIMIT)
  const remaining = Math.max(0, items.length - shown.length)

  return (
    <section className="rounded-2xl border border-white/5 bg-noir-900/60 p-5">
      <header className="flex flex-wrap items-center gap-3">
        <span className="text-lg" aria-hidden="true">{style.icon}</span>
        <h3 className="font-display text-lg uppercase tracking-widest text-white/80">{library.name}</h3>
        <span className="rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest" style={{ borderColor: `${style.accent}33`, color: style.accent }}>{style.label}</span>
        <span className="font-mono text-[10px] text-white/25">
          {feed?.loading && !feed.page ? 'Loading…' : `${items.length} recommendations · ${relative(feed?.page?.generatedAt)}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={onRebuild} disabled={rebuilding} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest text-white/40 hover:text-white disabled:opacity-40">{rebuilding ? 'Rebuilding…' : 'Rebuild'}</button>
          {items.length > 0 && <button onClick={onShowMore} className="rounded-lg border px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest" style={{ borderColor: `${style.accent}33`, color: style.accent }}>Show all →</button>}
        </div>
      </header>
      {feed?.error ? <p className="mt-4 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-300">{feed.error}</p>
        : feed?.loading && !feed.page ? (
          <div className="mt-4 flex gap-4 overflow-hidden">
            {Array.from({ length: 6 }).map((_, index) => <div key={index} className="aspect-[2/3] w-36 shrink-0 rounded-xl bg-noir-800 poster-shimmer" />)}
          </div>
        )
        : !shown.length ? <p className="mt-4 text-xs text-white/25">Nothing yet. Watch or rate a few titles in this library, then rebuild.</p>
        : (
          <div className="mt-4 flex gap-4 overflow-x-auto custom-scrollbar pb-2">
            {shown.map(item => (
              <div key={item.providerId} className="w-36 shrink-0">
                <RecommendationTile item={item} accent={style.accent} icon={style.icon} onClick={() => onSelect(item)} />
              </div>
            ))}
            <button
              onClick={onShowMore}
              className="group flex w-36 shrink-0 aspect-[2/3] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/[0.02] transition-all hover:border-white/35 hover:bg-white/[0.06]"
            >
              <span className="text-2xl opacity-40 transition-opacity group-hover:opacity-80" aria-hidden="true">→</span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-white/45 group-hover:text-white">Show more</span>
              {remaining > 0 && <span className="font-mono text-[9px] text-white/25">+{remaining} more</span>}
            </button>
          </div>
        )}
    </section>
  )
}

function RecommendationTile({ item, accent, icon, onClick }: { item: RecommendationItem; accent: string; icon: string; onClick: () => void }) {
  return (
    <LibraryCard
      onClick={onClick}
      image={tmdbImage(item.posterPath)}
      title={`${item.title}${item.year ? ` (${item.year})` : ''}`}
      subtitle={item.recommendation.reason}
      accentColor={accent}
      fallbackIcon={icon}
      badge={
        <span className={`rounded-lg border px-2 py-1 text-[9px] font-bold uppercase ${item.alreadyAdded ? 'border-green-500/20 bg-green-500/10 text-green-500' : 'border-white/10 bg-noir-950/60'}`}
          style={item.alreadyAdded ? undefined : { color: accent }}>
          {item.alreadyAdded ? 'In Library' : item.recommendation.availability.split('_').join(' ')}
        </span>
      }
    />
  )
}
