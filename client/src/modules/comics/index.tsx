import { useState, useEffect, useRef, useMemo } from 'react'
import { Routes, Route, Link, useNavigate, useSearchParams, useLocation, useParams } from 'react-router-dom'
import { comicsApi, type ComicSeries, type ComicIssue } from '../../lib/comics-games.api.js'
import { tmdbImage } from '../../lib/api.js'
import { SearchInput, PosterSkeleton, EmptyState, StatusBadge, DetailPage, DetailHeader, DetailPoster, DetailMain, DetailStoryline, DetailMetaItem, LibraryCard, CollectionFilterBar, SelectionBar, Modal, ReleaseList, type Release, Spinner, QualityPolicyPanel } from '../../components/ui.js'
import { MissingSearchModal } from '../../components/MissingSearchModal.js'
import { MetadataEditorModal } from '../../components/MetadataEditorModal.js'
import { SearchDetailModal } from '../../components/SearchDetailModal.js'
import { ItemActionsBar } from '../../components/ItemActions.js'
import { useTabs } from '../../lib/tab-context.js'

// ── Comic Detail Page ───────────────────────────────────────────────────────

function ComicSeriesDetailPage({ onDelete }: { onDelete: (id: number) => void }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [series, setSeries] = useState<(ComicSeries & { issues: ComicIssue[] }) | null>(null)
  const [expandedIssue, setExpandedIssue] = useState<number | null>(null)
  const [grabbing, setGrabbing] = useState<number | null>(null)
  const [showMetadataModal, setShowMetadataModal] = useState(false)

  const loadData = async () => {
    if (!id) return
    setLoading(true)
    try {
      const data = await comicsApi.series.get(parseInt(id))
      setSeries(data)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [id])

  const handleGetIssue = async (issueId: number) => {
    setGrabbing(issueId)
    try {
      const res = await comicsApi.issues.autoGrab(issueId)
      if (res.success) {
        alert(res.message)
        if (series) {
          setSeries({
            ...series,
            issues: series.issues.map(i => i.id === issueId ? { ...i, status: 'downloading' } : i)
          })
        }
      } else {
        alert(res.message || 'No release found')
      }
    } catch (err) {
      alert(String(err))
    } finally {
      setGrabbing(null)
    }
  }

  const updateIssuePolicy = async (issue: ComicIssue, patch: Partial<ComicIssue>) => {
    try {
      const updated = await comicsApi.issues.update(issue.id, patch as any)
      if (series) setSeries({ ...series, issues: series.issues.map(i => i.id === issue.id ? { ...i, ...updated } : i) })
    } catch (err) {
      alert(String(err))
    }
  }

  if (loading) return (
    <div className="animate-pulse space-y-8">
      <div className="h-[400px] bg-noir-800 rounded-3xl" />
      <div className="h-64 bg-noir-800 rounded-3xl" />
    </div>
  )

  if (!series) return <EmptyState icon="❓" title="SERIES NOT FOUND" />

  return (
    <DetailPage>
      <DetailHeader backdrop={series.image_url} backTo="/comics" backLabel="Library">
        <DetailPoster src={series.image_url} icon="📚" />
        
        <div className="flex-1 min-w-0 pb-4">
          <div className="flex items-center gap-4 mb-6">
            <p className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">
              Comic Series
            </p>
          </div>

          <h1 className="font-display text-4xl lg:text-6xl tracking-tighter mb-8 text-orange-400 uppercase leading-none drop-shadow-2xl">
            {series.title}
          </h1>

          <div className="flex flex-wrap gap-8 items-center text-xs font-bold text-white/60 uppercase tracking-[0.2em]">
            <DetailMetaItem label="YEAR" value={series.start_year || 'TBA'} />
            <DetailMetaItem label="PUBLISHER" value={series.publisher || 'UNKNOWN'} />
            <DetailMetaItem label="ISSUES" value={series.issue_count || 0} />
          </div>
        </div>

      </DetailHeader>

      {showMetadataModal && (
        <MetadataEditorModal
          title={series.title}
          initial={series as any}
          fields={[
            { key: 'title', label: 'Title' },
            { key: 'publisher', label: 'Publisher' },
            { key: 'start_year', label: 'Start Year', type: 'number' },
            { key: 'genres', label: 'Genres (comma separated)', type: 'csv' },
            { key: 'overview', label: 'Overview', type: 'textarea' },
          ]}
          onSave={async data => { await comicsApi.series.updateMetadata(series.id, data) }}
          images={{
            types: ['poster'],
            search: () => comicsApi.series.searchImages(series.id),
            save: (type, url) => comicsApi.series.saveImage(series.id, type, url),
          }}
          onClose={() => { setShowMetadataModal(false); loadData() }}
        />
      )}

      <DetailMain>
        <div className="space-y-16">
          <DetailStoryline overview={(series as any).overview ?? series.description} />

          <section className="space-y-8">
            <div className="flex items-center gap-6 mb-8">
              <h2 className="text-[10px] font-bold text-orange-400 uppercase tracking-[0.3em] whitespace-nowrap">Issue List</h2>
              <div className="h-px w-full bg-white/[0.03]" />
            </div>

            <div className="space-y-3">
              {series.issues?.map(issue => (
                <div key={issue.id} className="bg-noir-900/40 border border-white/[0.03] rounded-2xl overflow-hidden transition-all group/issue">
                  <button onClick={() => setExpandedIssue(expandedIssue === issue.id ? null : issue.id)}
                    className="w-full flex items-center justify-between p-3 hover:bg-white/[0.03] transition-colors text-left relative overflow-hidden">
                    <div className="flex items-center gap-5 relative z-10">
                      <div className="w-10 h-14 rounded-lg overflow-hidden bg-noir-800 flex-shrink-0 border border-white/5 shadow-lg transition-transform">
                        {issue.image_url ? <img src={issue.image_url} className="w-full h-full object-cover" alt="" /> : <div className="w-full h-full flex items-center justify-center text-[10px] opacity-20 text-white uppercase font-mono">#{issue.issue_number}</div>}
                      </div>
                      <div className="space-y-1">
                        <div className="text-sm font-bold text-white uppercase tracking-wider">#{issue.issue_number} {issue.name || 'Untitled'}</div>
                        <div className="text-[9px] font-bold text-white/20 uppercase tracking-[0.15em]">
                          {issue.cover_date || 'Unknown Date'}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 relative z-10">
                      <StatusBadge status={issue.status} />
                      <span className={`text-white/10 text-lg transition-transform duration-500 ${expandedIssue === issue.id ? 'rotate-180' : ''}`}>▾</span>
                    </div>
                  </button>

                  {expandedIssue === issue.id && (
                    <div className="border-t border-white/[0.03] animate-slide-down bg-noir-950/40 p-6">
                      <div className="flex flex-col md:flex-row gap-8">
                        <div className="w-32 h-48 rounded-xl overflow-hidden shadow-2xl flex-shrink-0 border border-white/10">
                          {issue.image_url ? <img src={issue.image_url} className="w-full h-full object-cover" /> : <div className="aspect-[2/3] bg-noir-800" />}
                        </div>
                        <div className="flex-1 space-y-6">
                          <QualityPolicyPanel compact value={issue as any} onChange={patch => updateIssuePolicy(issue, patch as Partial<ComicIssue>)} />
                          <div className="space-y-2">
                            <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-[0.3em] font-bold">Issue Summary</h3>
                            <p className="text-sm text-white/60 leading-relaxed line-clamp-6 font-light italic">
                              {issue.overview || 'No description available for this issue.'}
                            </p>
                          </div>
                          
                          <div className="pt-6 border-t border-white/5 flex gap-3">
                            <button 
                              onClick={(e) => { e.stopPropagation(); handleGetIssue(issue.id); }}
                              disabled={grabbing === issue.id || issue.status === 'downloaded' || issue.status === 'downloading'}
                              className={`flex-1 py-3 rounded-xl font-bold tracking-widest text-xs uppercase transition-all shadow-xl disabled:opacity-50 ${
                                issue.status === 'downloaded' ? 'bg-green-500/10 border-green-500/30 text-green-500' :
                                'bg-orange-400 text-noir-950'
                              }`}
                            >
                              {grabbing === issue.id ? 'Searching Indexers...' : issue.status === 'downloaded' ? '✓ COLLECTED' : '⚡ GET ISSUE'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-8">
          <div className="bg-noir-900/50 border border-white/5 rounded-3xl p-6 space-y-6 sticky top-8 shadow-xl">
            <div>
              <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-[0.2em] mb-4 font-bold">Series Metadata</h3>
              <div className="space-y-3 text-xs">
                <div className="flex justify-between py-2 border-b border-white/5">
                  <span className="text-white/30">ComicVine ID</span>
                  <span className="font-mono text-white/60">{series.comicvine_id}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-white/5">
                  <span className="text-white/30">Start Year</span>
                  <span className="font-mono text-white/60">{series.start_year}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-white/5">
                  <span className="text-white/30">Collected</span>
                  <span className="font-mono text-green-500">{series.downloaded_issues || 0} / {series.issue_count}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DetailMain>

      <ItemActionsBar
        accent="#E67E22"
        containerClass="max-w-[1600px] mx-auto px-8 w-full"
        reacquire={{
          mode: 'select',
          title: 'Select issues to reacquire',
          items: (series.issues || []).map(i => ({ id: i.id, label: `#${i.issue_number}${i.name ? ` ${i.name}` : ''}`, sublabel: i.cover_date || undefined })),
          runSelected: async (ids) => { for (const iid of ids) await comicsApi.issues.repair(iid, {}); loadData() },
        }}
        loadHistory={() => comicsApi.series.acquisitionHistory(series.id)}
        onRemove={async () => { if (confirm('Remove this series from the library? Files on disk are kept.')) { await comicsApi.series.delete(series.id, false); onDelete(series.id); navigate('/comics') } }}
        onDelete={async () => { if (confirm('Delete this series AND all its files from disk? This permanently removes the folder and cannot be undone.')) { await comicsApi.series.delete(series.id, true); onDelete(series.id); navigate('/comics') } }}
        onEdit={() => setShowMetadataModal(true)}
      />
    </DetailPage>
  )
}

// ── Comics Library ────────────────────────────────────────────────────────────

type ComicCollectionFilter = 'all' | 'missing' | 'collected' | 'acquiring'

function ComicsLibrary() {
  const [series, setSeries] = useState<ComicSeries[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [collectionFilter, setCollectionFilter] = useState<ComicCollectionFilter>('all')
  const [lastRedirect, setLastRedirect] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [showMissingModal, setShowMissingModal] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { activeTabId, tabs, getActiveTabForMedia, setActiveTabForMedia } = useTabs()

  useEffect(() => {
    if (!tabs.length) return
    const comicsTab = getActiveTabForMedia('comics')
    if (comicsTab && comicsTab.id !== activeTabId) {
      setActiveTabForMedia('comics', comicsTab.id)
    }
  }, [tabs])

  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId])
  const activeName = activeTab ? activeTab.name.replace(/Comics/i, '').trim() : ''

  const refresh = () => {
    setLoading(true)
    comicsApi.series.list()
      .then(setSeries)
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!activeTabId) { setSeries([]); setLoading(false); return }
    const current = tabs.find(t => t.id === activeTabId)
    if (current && current.media_type !== 'comics') return
    setSeries([])
    refresh()
    const interval = setInterval(() => refresh(), 5000)
    return () => clearInterval(interval)
  }, [activeTabId, tabs])

  const filtered = series.filter(s => {
    const matchesSearch = !search || s.title.toLowerCase().includes(search.toLowerCase())
    if (!matchesSearch) return false

    const isCollected = s.downloaded_issues && s.issue_count && s.downloaded_issues >= s.issue_count
    const isMissing = !s.downloaded_issues || s.downloaded_issues === 0
    const isAcquiring = !isCollected && !isMissing

    if (collectionFilter === 'missing' && !isMissing) return false
    if (collectionFilter === 'collected' && !isCollected) return false
    if (collectionFilter === 'acquiring' && !isAcquiring) return false

    return true
  })

  // Auto-redirect to Add page if no local matches
  useEffect(() => {
    const cooldown = Date.now() - lastRedirect
    if (!loading && search.trim().length > 2 && filtered.length === 0 && !location.pathname.endsWith('/add') && cooldown > 5000) {
      const timer = setTimeout(() => {
        setLastRedirect(Date.now())
        const term = search
        setSearch('')
        navigate(`add?q=${encodeURIComponent(term)}`)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [search, filtered.length, loading, navigate, location.pathname, lastRedirect])

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex justify-between items-end">
        <div>
          <h1 className="font-display text-5xl tracking-widest text-orange-400">
            COMICS{activeName && activeName.toLowerCase() !== 'main' ? <span className="text-white/20 ml-4">({activeName.toUpperCase()})</span> : ''}
          </h1>
          <p className="text-orange-400 text-[12.5px] mt-1 font-mono uppercase tracking-widest">
            <span className="text-white">{series.length}</span> {series.length === 1 ? 'series' : 'series'} in library
            {series.length > 0 && (() => {
              const collected = series.filter(s => s.downloaded_issues && s.issue_count && s.downloaded_issues >= s.issue_count).length
              const missing = series.filter(s => !s.downloaded_issues || s.downloaded_issues === 0).length
              const acquiring = series.length - collected - missing
              return <> | <span className="text-white">{collected}</span> {collected === 1 ? 'series' : 'series'} Collected | <span className="text-white">{missing}</span> {missing === 1 ? 'series' : 'series'} Missing{acquiring > 0 ? <> | <span className="text-white">{acquiring}</span> {acquiring === 1 ? 'series' : 'series'} Acquiring</> : ''}</>
            })()}
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => setShowMissingModal(true)}
            className="px-6 py-2 rounded-xl bg-orange-500/10 border border-orange-500/30 text-orange-500 text-xs font-bold tracking-widest hover:bg-orange-500/20 transition-all uppercase"
          >
            Search Missing
          </button>
          <button onClick={() => { setEditMode(!editMode); if (editMode) setSelected(new Set()) }}
            className={`px-6 py-2 rounded-xl border text-xs font-bold tracking-widest transition-all uppercase ${editMode ? 'bg-orange-400/10 border-orange-400/30 text-orange-400' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
            {editMode ? 'Done' : 'Edit Series'}
          </button>
          <Link to="add" className="px-6 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold tracking-widest hover:bg-white/10 transition-all uppercase">
            Add Series
          </Link>
        </div>
      </div>
      
      <div className="flex flex-col gap-4 mb-8">
        <div className="flex flex-col md:flex-row gap-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search library..." className="max-w-sm" />
          <CollectionFilterBar value={collectionFilter} onChange={setCollectionFilter} accentColor="[#FB923C]" />
        </div>
        {editMode && (
          <SelectionBar
            totalCount={filtered.length}
            selectedCount={selected.size}
            onSelectAll={() => setSelected(new Set(filtered.map(s => s.id)))}
            onSelectNone={() => setSelected(new Set())}
            deleting={deleting}
            onDelete={async () => {
              if (!confirm(`Delete ${selected.size} comic series and all associated files?`)) return
              setDeleting(true)
              try {
                await Promise.all([...selected].map(id => comicsApi.series.delete(id)))
                setSeries(prev => prev.filter(s => !selected.has(s.id)))
                setSelected(new Set())
              } catch (err) { alert(String(err)) }
              finally { setDeleting(false) }
            }}
            onDone={() => { setEditMode(false); setSelected(new Set()) }}
          />
        )}
      </div>

      {loading ? <PosterSkeleton /> : filtered.length === 0 ? (
        <EmptyState icon="📚" title="NO SERIES FOUND" subtitle="Add your first series to begin" />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((s, i) => (
            <div key={s.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i * 25, 300)}ms`, animationFillMode: 'both' }}>
              <LibraryCard
                onClick={() => navigate(`/comics/${s.id}`)}
                image={s.image_url}
                title={`${s.title}${s.start_year ? ` (${s.start_year})` : ''}`}
                subtitle={`${s.downloaded_issues || 0}/${s.issue_count || 0} ISSUES`}
                status={s.downloaded_issues && s.issue_count && s.downloaded_issues >= s.issue_count ? 'collected' : 'missing'}
                accentColor="#E67E22"
                fallbackIcon="📚"
                selectionMode={editMode}
                selected={selected.has(s.id)}
                onSelect={() => setSelected(prev => {
                  const next = new Set(prev)
                  if (next.has(s.id)) next.delete(s.id)
                  else next.add(s.id)
                  return next
                })}
              />
            </div>
          ))}
        </div>
      )}

      {showMissingModal && (
        <MissingSearchModal
          mediaType="comics"
          onClose={() => setShowMissingModal(false)}
          onStart={async (overrides) => {
            setShowMissingModal(false)
            try {
              const res = await fetch('/api/v1/release-pipeline/missing-search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tabId: activeTabId, overrides })
              })
              const data = await res.json()
              if (data.success) alert('Missing search started in background')
              else alert(data.error || 'Failed to start search')
            } catch (err) { alert(String(err)) }
          }}
        />
      )}
    </div>
  )
}

export function ComicsPage() {
  return (
    <Routes>
      <Route index element={<ComicsLibrary />} />
      <Route path="add" element={<AddComicsPage />} />
      <Route path=":id" element={<ComicSeriesDetailPage onDelete={() => {}} />} />
    </Routes>
  )
}

// ── Add Comics Page ────────────────────────────────────────────────────────────

export function AddComicsPage() {
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [added, setAdded] = useState<Set<number>>(new Set())
  const [detailSeries, setDetailSeries] = useState<any | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const navigate = useNavigate()

  useEffect(() => {
    clearTimeout(timer.current)
    if (!query.trim()) { setResults([]); return }
    timer.current = setTimeout(async () => {
      setSearching(true)
      try { 
        const items = await comicsApi.lookup(query)
        setResults(items)
      }
      catch {}
      finally { setSearching(false) }
    }, 400)
    return () => clearTimeout(timer.current)
  }, [query])

  const handleAdd = (cvId: number) => {
    // Optimistic: mark added instantly; the backend imports issues in the background.
    setAdded(prev => new Set(prev).add(cvId))
    comicsApi.series.add(cvId).catch(err => {
      alert(String(err))
      setAdded(prev => { const next = new Set(prev); next.delete(cvId); return next })
    })
  }

  return (
    <div className="animate-fade-in pb-20">
      <div className="mb-8 flex items-center gap-4">
        <button onClick={() => navigate('/comics')} className="text-white/30 hover:text-white transition-all text-sm font-mono uppercase tracking-widest">← Back</button>
        <div className="h-4 w-px bg-white/10" />
        <h1 className="font-display text-3xl tracking-widest text-orange-400">ADD SERIES</h1>
      </div>
      
      <div className="max-w-xl mb-12">
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} 
          placeholder="Search ComicVine for a series..." autoFocus
          className="w-full px-4 py-3 rounded-xl bg-noir-800 border border-white/10 text-white focus:outline-none focus:border-orange-400/40 transition-all shadow-lg" />
      </div>

      {searching ? <PosterSkeleton /> : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {results.map((item: any) => {
            const isAdded = added.has(item.id) || item.alreadyAdded
            return (
              <div key={item.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(results.indexOf(item) * 25, 300)}ms`, animationFillMode: 'both' }}>
                <LibraryCard
                  onClick={() => setDetailSeries(item)}
                  image={item.coverUrl}
                  title={item.name}
                  subtitle={`${item.publisher || 'Independent'} (${item.startYear || '?'})`}
                  accentColor="#E67E22"
                  fallbackIcon="📚"
                  badge={
                    <button onClick={e => { e.stopPropagation(); !isAdded && handleAdd(item.id) }} disabled={isAdded}
                      className={`px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-widest border transition-all ${isAdded ? 'bg-green-500/10 border-green-500/20 text-green-500' : 'bg-noir-950/60 border-white/10 text-white hover:bg-white/10'}`}>
                      {isAdded ? '✓ In Library' : '+ Add'}
                    </button>
                  }
                />
              </div>
            )
          })}
        </div>
      )}

      {detailSeries && (
        <SearchDetailModal
          onClose={() => setDetailSeries(null)}
          onAdd={() => handleAdd(detailSeries.id)}
          isAdded={added.has(detailSeries.id) || detailSeries.alreadyAdded}
          accentColor="#E67E22"
          fallbackIcon="📚"
          image={detailSeries.coverUrl}
          title={detailSeries.name}
          year={detailSeries.startYear}
          overview={detailSeries.description || detailSeries.overview}
          facts={[
            { label: 'Publisher', value: detailSeries.publisher },
            { label: 'Issues', value: detailSeries.issueCount || detailSeries.countOfIssues },
            { label: 'Start Year', value: detailSeries.startYear },
          ]}
        />
      )}
    </div>
  )
}
