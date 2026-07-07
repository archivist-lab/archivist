import { useState, useEffect, useRef, useMemo } from 'react'
import { Routes, Route, Link, useNavigate, useSearchParams, useLocation, useParams } from 'react-router-dom'
import { musicApi, type Artist, type Album, type Track } from '../../lib/music.api.js'
import { tmdbImage, formatDuration } from '../../lib/api.js'
import { SearchInput, PosterSkeleton, EmptyState, StatusBadge, DetailPage, DetailHeader, DetailPoster, DetailMain, DetailStoryline, DetailMetaItem, LibraryCard, CollectionFilterBar, SelectionBar, Modal, Spinner, QualityPolicyPanel } from '../../components/ui.js'
import { MissingSearchModal } from '../../components/MissingSearchModal.js'
import { MetadataEditorModal } from '../../components/MetadataEditorModal.js'
import { SearchDetailModal } from '../../components/SearchDetailModal.js'
import { ItemActionsBar } from '../../components/ItemActions.js'
import { useTabs } from '../../lib/tab-context.js'

// ── Artist Detail Page ───────────────────────────────────────────────────────

function ArtistDetailPage({ onDelete }: { onDelete: (id: number) => void }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [artist, setArtist] = useState<(Artist & { albums: Album[] }) | null>(null)
  const [expandedAlbum, setExpandedAlbum] = useState<number | null>(null)
  const [tracks, setTracks] = useState<Record<number, Track[]>>({})
  const [showMetadataModal, setShowMetadataModal] = useState(false)

  const loadData = async (showLoading = true) => {
    if (!id) return
    if (showLoading) setLoading(true)
    try {
      const data = await musicApi.artists.get(parseInt(id))
      setArtist(data)
      if (data.albums?.length > 0 && expandedAlbum === null) {
        setExpandedAlbum(data.albums[0].id)
      }
    } catch (err) {
      console.error(err)
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  useEffect(() => { 
    loadData(true)
    const interval = setInterval(() => loadData(false), 5000)
    return () => clearInterval(interval)
  }, [id])

  const loadTracks = async (albumId: number) => {
    if (tracks[albumId]) return
    try {
      const album = await musicApi.albums.get(albumId)
      if (album.tracks) {
        setTracks(prev => ({ ...prev, [albumId]: album.tracks! }))
      }
    } catch (err) {
      console.error(err)
    }
  }

  const updateAlbumPolicy = async (album: Album, patch: Partial<Album>) => {
    try {
      const updated = await musicApi.albums.update(album.id, patch as any)
      setArtist(prev => prev ? { ...prev, albums: prev.albums.map(a => a.id === album.id ? { ...a, ...updated } : a) } : prev)
    } catch (err) {
      alert(String(err))
    }
  }

  useEffect(() => {
    if (expandedAlbum) loadTracks(expandedAlbum)
  }, [expandedAlbum])

  if (loading) return (
    <div className="animate-pulse space-y-8">
      <div className="h-[400px] bg-noir-800 rounded-3xl" />
      <div className="h-64 bg-noir-800 rounded-3xl" />
    </div>
  )

  if (!artist) return <EmptyState icon="❓" title="ARTIST NOT FOUND" />

  const grouped = (artist.albums || []).reduce((acc, a) => {
    let type = a.album_type || 'Album'
    if (type === 'Album') type = 'Studio Album'
    if (!acc[type]) acc[type] = []
    acc[type].push(a)
    return acc
  }, {} as Record<string, Album[]>)

  const groupOrder = ['Studio Album', 'Live', 'Compilation', 'EP', 'Single']
  const sortedGroups = Object.entries(grouped).sort(([a], [b]) => {
    const ai = groupOrder.indexOf(a), bi = groupOrder.indexOf(b)
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return a.localeCompare(b)
  })

  return (
    <DetailPage>
      <DetailHeader backdrop={tmdbImage(artist.backdrop_url || artist.image_url, 'original')} backTo="/music" backLabel="Library">
        <DetailPoster src={tmdbImage(artist.image_url)} icon="🎵" aspect="aspect-square" />
        
        <div className="flex-1 min-w-0 pb-4">
          <div className="flex items-center gap-4 mb-6">
            <p className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">
              {artist.genres?.slice(0,3).join(' / ')}
            </p>
          </div>

          {artist.logo_url ? (
            <img src={tmdbImage(artist.logo_url)} alt={artist.name} className="h-20 lg:h-32 object-contain mb-8 filter drop-shadow-2xl" />
          ) : (
            <h1 className="font-display text-4xl lg:text-6xl tracking-tighter mb-8 text-[#FF2D78] uppercase leading-none drop-shadow-2xl">
              {artist.name}
            </h1>
          )}

          <div className="flex flex-wrap gap-8 items-center text-xs font-bold text-white/60 uppercase tracking-[0.2em]">
            <DetailMetaItem label="RELEASES" value={artist.album_count || 0} />
            <DetailMetaItem label="TYPE" value="ARTIST" />
          </div>
        </div>

      </DetailHeader>

      {showMetadataModal && (
        <MetadataEditorModal
          title={artist.name}
          initial={artist as any}
          fields={[
            { key: 'name', label: 'Name' },
            { key: 'disambiguation', label: 'Disambiguation' },
            { key: 'genres', label: 'Genres (comma separated)', type: 'csv', wide: true },
            { key: 'overview', label: 'Biography', type: 'textarea' },
          ]}
          onSave={async data => { await musicApi.artists.updateMetadata(artist.id, data) }}
          images={{
            types: ['poster', 'backdrop', 'logo', 'banner'],
            search: type => musicApi.artists.searchImages(artist.id, type),
            save: (type, url) => musicApi.artists.saveImage(artist.id, type, url),
          }}
          onClose={() => { setShowMetadataModal(false); loadData(false) }}
        />
      )}

      <DetailMain>
        <div className="space-y-16">
          <DetailStoryline title="Biography" overview={artist.overview} />

          <section className="space-y-12">
            {sortedGroups.map(([type, albums]) => (
              <div key={type} className="space-y-6">
                <h2 className="text-[10px] font-bold text-[#FF2D78] uppercase tracking-[0.3em]">{type}s</h2>
                <div className="space-y-4">
                  {albums.map(album => (
                    <div key={album.id} className="bg-noir-900/40 border border-white/5 rounded-2xl overflow-hidden group">
                      <button 
                        onClick={() => setExpandedAlbum(expandedAlbum === album.id ? null : album.id)}
                        className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition-colors text-left"
                      >
                        <div className="flex items-center gap-6">
                          <div className="w-12 h-12 rounded-lg overflow-hidden bg-noir-800 flex-shrink-0 border border-white/5 shadow-lg">
                            {album.cover_url ? <img src={tmdbImage(album.cover_url)} className="w-full h-full object-cover" alt="" /> : <div className="w-full h-full flex items-center justify-center text-[10px] opacity-20">💿</div>}
                          </div>
                          <div>
                            <div className="text-sm font-bold text-white group-hover:text-[#FF2D78] transition-colors uppercase tracking-tight">{album.title}</div>
                            <div className="text-[10px] font-mono text-white/30 uppercase tracking-widest mt-1">
                              {album.year || 'Unknown'} • {album.track_count || 0} Tracks
                            </div>
                          </div>
                        </div>
                        <span className={`text-white/20 transition-transform duration-300 ${expandedAlbum === album.id ? 'rotate-180' : ''}`}>▼</span>
                      </button>

                      {expandedAlbum === album.id && (
                        <div className="border-t border-white/5 animate-slide-down">
                          <div className="p-6 bg-white/[0.02] flex flex-col md:flex-row gap-8 items-center border-b border-white/5">
                            <div className="relative group/cd">
                              <div className="w-32 h-32 rounded-lg overflow-hidden shadow-2xl relative z-10 border border-white/10">
                                {album.cover_url ? <img src={tmdbImage(album.cover_url)} className="w-full h-full object-cover" alt="" /> : <div className="w-full h-full flex items-center justify-center text-4xl opacity-10">💿</div>}
                              </div>
                              {album.cdart_url && (
                                <div className="absolute top-0 left-1/2 w-32 h-32 -translate-x-1/4">
                                  <img src={tmdbImage(album.cdart_url)} className="w-full h-full object-contain animate-spin-slow" alt="" />
                                </div>
                              )}
                            </div>
                            <div className="flex-1 text-center md:text-left">
                              <h3 className="text-xl font-bold text-white uppercase tracking-tight mb-2">{album.title}</h3>
                              <p className="text-sm text-white/40 font-mono uppercase tracking-widest">{album.year} • {album.label || 'Unknown Label'}</p>
                            </div>
                          </div>
                          <div className="p-6 border-b border-white/5 bg-noir-950/30">
                            <QualityPolicyPanel compact value={album as any} onChange={patch => updateAlbumPolicy(album, patch as Partial<Album>)} />
                          </div>
                          
                          <div className="divide-y divide-white/[0.03]">
                            {tracks[album.id]?.map(track => (
                              <div key={track.id} className="flex items-center gap-4 px-6 py-3 group/track hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-mono text-white/10 w-6 text-right">{track.track_number}</span>
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm text-white/70 group-hover:track:text-white transition-colors truncate uppercase tracking-tight">{track.title}</div>
                                </div>
                                <div className="text-xs font-mono text-white/20">{formatDuration(track.duration)}</div>
                                <StatusBadge status={track.status} progress={(track as any).downloadProgress} />
                              </div>
                            )) || (
                              <div className="p-12 text-center">
                                <Spinner className="w-8 h-8 mx-auto mb-3" color="text-[#FF2D78]" />
                                <p className="text-[10px] font-mono text-white/20 uppercase tracking-[0.2em]">Syncing Tracks...</p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        </div>

        <div className="space-y-8">
          <div className="bg-noir-900/50 border border-white/5 rounded-3xl p-6 space-y-6 sticky top-8 shadow-xl">
            <div>
              <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-[0.2em] mb-4 font-bold">Artist Metadata</h3>
              <div className="space-y-3 text-xs">
                <div className="flex justify-between py-2 border-b border-white/5">
                  <span className="text-white/30">MusicBrainz ID</span>
                  <span className="font-mono text-white/60 truncate ml-4" title={artist.musicbrainz_id}>{artist.musicbrainz_id?.slice(0,8)}...</span>
                </div>
                <div className="flex justify-between py-2 border-b border-white/5">
                  <span className="text-white/30">Country</span>
                  <span className="text-white/60 uppercase">{artist.country || 'Global'}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DetailMain>

      <ItemActionsBar
        accent="#FF2D78"
        containerClass="max-w-[1600px] mx-auto px-8 w-full"
        reacquire={{
          mode: 'select',
          title: 'Select albums to reacquire',
          items: (artist.albums || []).map(a => ({ id: a.id, label: a.title, sublabel: a.year ? String(a.year) : undefined })),
          runSelected: async (ids) => { for (const aid of ids) await musicApi.albums.repair(aid, {}); loadData(false) },
        }}
        loadHistory={() => musicApi.artists.acquisitionHistory(artist.id)}
        onRemove={async () => { if (confirm('Remove this artist from the library? Files on disk are kept.')) { await musicApi.artists.delete(artist.id, false); onDelete(artist.id); navigate('/music') } }}
        onDelete={async () => { if (confirm('Delete this artist AND all their files from disk? This permanently removes the folder and cannot be undone.')) { await musicApi.artists.delete(artist.id, true); onDelete(artist.id); navigate('/music') } }}
        onEdit={() => setShowMetadataModal(true)}
      />
    </DetailPage>
  )
}

// ── Music Library ────────────────────────────────────────────────────────────

type MusicCollectionFilter = 'all' | 'missing' | 'collected' | 'acquiring'

function MusicLibrary() {
  const [artists, setArtists] = useState<Artist[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [collectionFilter, setCollectionFilter] = useState<MusicCollectionFilter>('all')
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
    const musicTab = getActiveTabForMedia('music')
    if (musicTab && musicTab.id !== activeTabId) {
      setActiveTabForMedia('music', musicTab.id)
    }
  }, [tabs])

  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId])
  const activeName = activeTab ? activeTab.name.replace(/Music/i, '').trim() : ''

  const refresh = (showLoading = true) => {
    if (showLoading) setLoading(true)
    musicApi.artists.list()
      .then(setArtists)
      .catch(console.error)
      .finally(() => { if (showLoading) setLoading(false) })
  }

  useEffect(() => {
    if (!activeTabId) { setArtists([]); setLoading(false); return }
    const current = tabs.find(t => t.id === activeTabId)
    if (current && current.media_type !== 'music') return
    setArtists([])
    refresh(true)
    const interval = setInterval(() => refresh(false), 5000)
    return () => clearInterval(interval)
  }, [activeTabId, tabs])

  const filtered = artists.filter(a => {
    const matchesSearch = !search || a.name.toLowerCase().includes(search.toLowerCase())
    if (!matchesSearch) return false

    const isCollected = a.album_count ? (a.downloaded_albums || 0) >= a.album_count : true
    const isMissing = (a.album_count || 0) > 0 && (!a.downloaded_albums || a.downloaded_albums === 0)
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
          <h1 className="font-display text-5xl tracking-widest text-[#FF2D78]">
            MUSIC{activeName && activeName.toLowerCase() !== 'main' ? <span className="text-white/20 ml-4">({activeName.toUpperCase()})</span> : ''}
          </h1>
          <p className="text-[#FF2D78] text-[12.5px] mt-1 font-mono uppercase tracking-widest">
            <span className="text-white">{artists.length}</span> {artists.length === 1 ? 'artist' : 'artists'} in library
            {artists.length > 0 && (() => {
              const collected = artists.filter(a => a.album_count ? (a.downloaded_albums || 0) >= a.album_count : true).length
              const missing = artists.filter(a => (a.album_count || 0) > 0 && (!a.downloaded_albums || a.downloaded_albums === 0)).length
              const acquiring = artists.length - collected - missing
              return <> | <span className="text-white">{collected}</span> {collected === 1 ? 'artist' : 'artists'} Collected | <span className="text-white">{missing}</span> {missing === 1 ? 'artist' : 'artists'} Missing{acquiring > 0 ? <> | <span className="text-white">{acquiring}</span> {acquiring === 1 ? 'artist' : 'artists'} Acquiring</> : ''}</>
            })()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowMissingModal(true)}
            className="px-6 py-2 rounded-xl bg-[#FF2D78]/10 border border-[#FF2D78]/30 text-[#FF2D78] text-xs font-bold tracking-widest hover:bg-[#FF2D78]/20 transition-all uppercase"
          >
            Search Missing
          </button>
          {!editMode && (
            <button onClick={() => setEditMode(true)}
              className="px-6 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold tracking-widest hover:bg-white/10 transition-all uppercase">
              Edit Artists
            </button>
          )}
          <Link to="add" className="px-6 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold tracking-widest hover:bg-white/10 transition-all uppercase">
            Add Artist
          </Link>
        </div>
      </div>
      
      <div className="flex flex-col gap-4 mb-8">
        <div className="flex flex-col md:flex-row gap-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search library..." className="max-w-sm" />
          <CollectionFilterBar value={collectionFilter} onChange={setCollectionFilter} accentColor="[#FF2D78]" />
        </div>
        {editMode && (
          <SelectionBar
            totalCount={filtered.length}
            selectedCount={selected.size}
            onSelectAll={() => setSelected(new Set(filtered.map(a => a.id)))}
            onSelectNone={() => setSelected(new Set())}
            deleting={deleting}
            onDone={() => { setEditMode(false); setSelected(new Set()) }}
            onDelete={async () => {
              if (!confirm(`Delete ${selected.size} artist(s) and all associated files?`)) return
              setDeleting(true)
              try {
                await Promise.all([...selected].map(id => musicApi.artists.delete(id)))
                setArtists(prev => prev.filter(a => !selected.has(a.id)))
                setSelected(new Set())
              } catch (err) { alert(String(err)) }
              finally { setDeleting(false) }
            }}
          />
        )}
      </div>

      {loading ? <PosterSkeleton /> : filtered.length === 0 ? (
        <EmptyState icon="🎵" title="NO ARTISTS FOUND" subtitle="Add your first artist to begin" />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((a, i) => (
            <div key={a.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i * 25, 300)}ms`, animationFillMode: 'both' }}>
              <LibraryCard
                onClick={() => navigate(`/music/${a.id}`)}
                image={tmdbImage(a.image_url)}
                title={a.name}
                subtitle={`${a.downloaded_albums || 0}/${a.album_count || 0} ALBUMS`}
                status={a.downloaded_albums && a.album_count && a.downloaded_albums >= a.album_count ? 'collected' : 'missing'}
                accentColor="#FF2D78"
                fallbackIcon="🎵"
                aspect="aspect-square"
                selectionMode={editMode}
                selected={selected.has(a.id)}
                onSelect={() => setSelected(prev => {
                  const next = new Set(prev)
                  if (next.has(a.id)) next.delete(a.id)
                  else next.add(a.id)
                  return next
                })}
              />
            </div>
          ))}
        </div>
      )}

      {showMissingModal && (
        <MissingSearchModal
          mediaType="music"
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

export function MusicPage() {
  return (
    <Routes>
      <Route index element={<MusicLibrary />} />
      <Route path="add" element={<AddMusicPage />} />
      <Route path=":id" element={<ArtistDetailPage onDelete={() => {}} />} />
    </Routes>
  )
}

// ── Add Music Page ────────────────────────────────────────────────────────────

function TypeModal({ artist, onClose, onConfirm, isAdding }: { 
  artist: any; onClose: () => void; onConfirm: (types: string[]) => void; isAdding: boolean 
}) {
  const [selectedTypes, setSelectedTypes] = useState<string[]>(['Album', 'EP'])
  const types = ['Album', 'EP', 'Single', 'Live', 'Compilation', 'Broadcast', 'Other']

  return (
    <Modal title={`Add ${artist.name}`} onClose={onClose}>
      <div className="space-y-6">
        <p className="text-sm text-white/60">Which release types should we monitor for this artist?</p>
        <div className="grid grid-cols-2 gap-2">
          {types.map(t => (
            <button key={t} 
              onClick={() => setSelectedTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])}
              className={`px-4 py-2 rounded-xl text-[10px] font-bold tracking-widest uppercase transition-all border ${
                selectedTypes.includes(t) ? 'bg-[#FF2D78]/20 border-[#FF2D78]/40 text-[#FF2D78]' : 'bg-noir-900 border-white/5 text-white/30 hover:border-white/10'
              }`}>
              {t}
            </button>
          ))}
        </div>
        <div className="flex justify-end pt-4 border-t border-white/5">
          <div className="flex gap-3">
            <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest">Cancel</button>
            <button 
              onClick={() => onConfirm(selectedTypes)}
              disabled={isAdding}
              className="px-8 py-2.5 rounded-xl bg-[#FF2D78] text-white font-bold text-xs uppercase tracking-widest transition-all shadow-xl disabled:opacity-50"
            >
              {isAdding ? 'Adding...' : 'Confirm Add'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function AddMusicPage() {
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState<any | null>(null)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [detailArtist, setDetailArtist] = useState<any | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const navigate = useNavigate()

  useEffect(() => {
    clearTimeout(timer.current)
    if (!query.trim()) { setResults([]); return }
    timer.current = setTimeout(async () => {
      setSearching(true)
      try { 
        const items = await musicApi.lookup(query)
        setResults(items)
      }
      catch {}
      finally { setSearching(false) }
    }, 400)
    return () => clearTimeout(timer.current)
  }, [query])

  const handleAdd = (types: string[]) => {
    if (!adding) return
    const artist = adding
    // Optimistic: close the picker and mark added instantly; the backend syncs
    // albums and artwork in the background.
    setAdded(prev => new Set(prev).add(artist.mbid))
    setAdding(null)
    musicApi.artists.add(artist.mbid, true, types).catch(err => {
      alert(String(err))
      setAdded(prev => { const next = new Set(prev); next.delete(artist.mbid); return next })
    })
  }

  return (
    <div className="animate-fade-in pb-20">
      <div className="mb-8 flex items-center gap-4">
        <button onClick={() => navigate('/music')} className="text-white/30 hover:text-white transition-all text-sm font-mono uppercase tracking-widest">← Back</button>
        <div className="h-4 w-px bg-white/10" />
        <h1 className="font-display text-3xl tracking-widest text-[#FF2D78]">ADD ARTIST</h1>
      </div>
      
      <div className="max-w-xl mb-12">
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} 
          placeholder="Search MusicBrainz for an artist..." autoFocus
          className="w-full px-4 py-3 rounded-xl bg-noir-800 border border-white/10 text-white focus:outline-none focus:border-[#FF2D78]/40 transition-all shadow-lg" />
      </div>

      {searching ? <PosterSkeleton count={12} /> : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {results.map((item: any) => {
            const isAdded = added.has(item.mbid) || item.alreadyAdded
            return (
              <div key={item.mbid} className="animate-slide-up" style={{ animationDelay: `${Math.min(results.indexOf(item) * 25, 300)}ms`, animationFillMode: 'both' }}>
                <LibraryCard
                  onClick={() => setDetailArtist(item)}
                  image={tmdbImage(item.imageUrl)}
                  title={item.name}
                  subtitle={item.disambiguation || 'Artist'}
                  accentColor="#FF2D78"
                  fallbackIcon="🎵"
                  aspect="aspect-square"
                  badge={
                    <button onClick={e => { e.stopPropagation(); !isAdded && setAdding(item) }} disabled={isAdded}
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

      {detailArtist && (
        <SearchDetailModal
          onClose={() => setDetailArtist(null)}
          onAdd={() => setAdding(detailArtist)}
          isAdded={added.has(detailArtist.mbid) || detailArtist.alreadyAdded}
          accentColor="#FF2D78"
          fallbackIcon="🎵"
          image={tmdbImage(detailArtist.imageUrl)}
          title={detailArtist.name}
          overview={detailArtist.overview}
          genres={detailArtist.genres || []}
          facts={[
            { label: 'Type', value: detailArtist.type || 'Artist' },
            { label: 'Disambiguation', value: detailArtist.disambiguation },
            { label: 'Country', value: detailArtist.country },
          ]}
        />
      )}

      {adding && (
        <TypeModal
          artist={adding}
          onClose={() => setAdding(null)}
          onConfirm={handleAdd}
          isAdding={false}
        />
      )}
    </div>
  )
}
