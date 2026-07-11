import { useState, useEffect, useRef, useMemo } from 'react'
import { Routes, Route, Link, useNavigate, useSearchParams, useLocation, useParams } from 'react-router-dom'
import { gamesApi, type Game } from '../../lib/comics-games.api.js'
import { SearchInput, PosterSkeleton, EmptyState, StatusBadge, Select, DetailPage, DetailHeader, DetailPoster, DetailMain, DetailStoryline, DetailMetaItem, LibraryCard, CollectionFilterBar, SelectionBar, Modal, QualityPolicyPanel } from '../../components/ui.js'
import { MetadataEditorModal } from '../../components/MetadataEditorModal.js'
import { ItemActionsBar } from '../../components/ItemActions.js'
import { SearchDetailModal } from '../../components/SearchDetailModal.js'
import { useTabs } from '../../lib/tab-context.js'

const GAME_PLATFORMS = [
  { id: 6,   name: 'Steam', brand: 'PC', icon: '💻' },
  { id: 167, name: 'PlayStation 5', brand: 'Sony', icon: '🎮' },
  { id: 48,  name: 'PlayStation 4', brand: 'Sony', icon: '🎮' },
  { id: 9,   name: 'PlayStation 3', brand: 'Sony', icon: '🎮' },
  { id: 8,   name: 'PlayStation 2', brand: 'Sony', icon: '🎮' },
  { id: 7,   name: 'PlayStation 1', brand: 'Sony', icon: '🎮' },
  { id: 46,  name: 'PlayStation Vita', brand: 'Sony', icon: '📟' },
  { id: 38,  name: 'PlayStation Portable', brand: 'Sony', icon: '📟' },
  { id: 169, name: 'Xbox Series X|S', brand: 'Microsoft', icon: '💚' },
  { id: 49,  name: 'Xbox One', brand: 'Microsoft', icon: '💚' },
  { id: 12,  name: 'Xbox 360', brand: 'Microsoft', icon: '💚' },
  { id: 130, name: 'Nintendo Switch', brand: 'Nintendo', icon: '🔴' },
  { id: 37,  name: 'Nintendo 3DS', brand: 'Nintendo', icon: '🕹️' },
  { id: 41,  name: 'Wii U', brand: 'Nintendo', icon: '🕹️' },
  { id: 5,   name: 'Wii', brand: 'Nintendo', icon: '🕹️' },
  { id: 4,   name: 'Nintendo 64', brand: 'Nintendo', icon: '🕹️' },
  { id: 19,  name: 'Super Nintendo (SNES)', brand: 'Nintendo', icon: '🕹️' },
  { id: 18,  name: 'Nintendo (NES)', brand: 'Nintendo', icon: '🕹️' },
  { id: 29,  name: 'Sega Dreamcast', brand: 'Sega', icon: '🌀' },
  { id: 32,  name: 'Sega Saturn', brand: 'Sega', icon: '🌀' },
  { id: 23,  name: 'Sega Mega Drive / Genesis', brand: 'Sega', icon: '🌀' },
  { id: 33,  name: 'Sega Master System', brand: 'Sega', icon: '🌀' },
  { id: 35,  name: 'Sega Game Gear', brand: 'Sega', icon: '🌀' },
]

// ── Game Detail Page ───────────────────────────────────────────────────────

function GameDetailPage({ onDelete }: { onDelete: (id: number) => void }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [game, setGame] = useState<Game | null>(null)
  const [grabbing, setGrabbing] = useState(false)
  const [showMetadataModal, setShowMetadataModal] = useState(false)

  const loadData = async (showLoading = true) => {
    if (!id) return
    if (showLoading) setLoading(true)
    try {
      const data = await gamesApi.get(parseInt(id))
      setGame(data)
    } catch (err) {
      console.error(err)
      navigate('/games')
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  useEffect(() => { 
    loadData(true) 
    const interval = setInterval(() => loadData(false), 5000)
    return () => clearInterval(interval)
  }, [id])

  const handleAutoGrab = async () => {
    if (!game) return
    setGrabbing(true)
    try {
      const res = await gamesApi.autoGrab(game.id)
      if (res.success) {
        alert(res.message)
        setGame({ ...game, status: 'downloading' })
      } else {
        alert(res.message || 'No release found')
      }
    } catch (err) {
      alert(String(err))
    } finally {
      setGrabbing(false)
    }
  }

  const handlePolicyUpdate = async (patch: Partial<Game>) => {
    if (!game) return
    try {
      const updated = await gamesApi.update(game.id, patch)
      setGame(updated)
    } catch (err) {
      alert(String(err))
    }
  }

  if (loading && !game) return (
    <div className="animate-pulse space-y-8">
      <div className="h-[400px] bg-noir-800 rounded-3xl" />
      <div className="h-64 bg-noir-800 rounded-3xl" />
    </div>
  )

  if (!game) return <EmptyState icon="❓" title="GAME NOT FOUND" />

  return (
    <DetailPage>
      <DetailHeader backdrop={game.screenshot_url} backTo="/games" backLabel="Library">
        <DetailPoster src={game.cover_url} icon="🎮" />
        
        <div className="flex-1 min-w-0 pb-4">
          <div className="flex items-center gap-4 mb-6">
            <StatusBadge status={game.status} progress={game.downloadProgress} />
            <div className="h-1 w-1 rounded-full bg-white/20" />
            <p className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em] truncate max-w-sm">
              {game.genres?.slice(0,3).join(' / ')}
            </p>
          </div>

          <h1 className="font-display text-4xl lg:text-6xl tracking-tighter mb-8 text-emerald-400 uppercase leading-none drop-shadow-2xl">
            {game.title}
          </h1>

          <div className="flex flex-wrap gap-8 items-center text-xs font-bold text-white/60 uppercase tracking-[0.2em]">
            <DetailMetaItem label="YEAR" value={game.year || 'TBA'} />
            <DetailMetaItem label="PLATFORM" value={game.platforms?.[0] || 'PC'} />
            {game.rating && <DetailMetaItem label="RATING" value={`★ ${game.rating.toFixed(1)}`} color="text-emerald-400" />}
            <DetailMetaItem label="DEV" value={game.developer || 'UNKNOWN'} />
          </div>
        </div>

        <div className="flex gap-4 pb-4">
          {game.status !== 'downloaded' && (
            <button 
              onClick={handleAutoGrab}
              disabled={grabbing || game.status === 'downloading'}
              className={`px-8 py-4 rounded-2xl font-bold tracking-[0.2em] text-[10px] uppercase transition-all shadow-2xl disabled:opacity-50 ${
                game.status === 'downloading' ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/30' : 'bg-emerald-400 text-noir-950 hover:bg-emerald-400/90'
              }`}
            >
              {grabbing ? 'SEARCHING...' : game.status === 'downloading' ? 'DOWNLOADING...' : '⚡ AUTO GRAB'}
            </button>
          )}
        </div>
      </DetailHeader>

      {showMetadataModal && (
        <MetadataEditorModal
          title={game.title}
          initial={game as any}
          fields={[
            { key: 'title', label: 'Title' },
            { key: 'year', label: 'Year', type: 'number' },
            { key: 'release_date', label: 'Release Date (YYYY-MM-DD)' },
            { key: 'rating', label: 'Rating', type: 'float' },
            { key: 'developer', label: 'Developer' },
            { key: 'publisher', label: 'Publisher' },
            { key: 'genres', label: 'Genres (comma separated)', type: 'csv' },
            { key: 'platforms', label: 'Platforms (comma separated)', type: 'csv' },
            { key: 'overview', label: 'Overview', type: 'textarea' },
          ]}
          onSave={async data => { await gamesApi.updateMetadata(game.id, data) }}
          images={{
            types: ['cover', 'screenshot'],
            search: type => gamesApi.searchImages(game.id, type),
            save: (type, url) => gamesApi.saveImage(game.id, type, url),
          }}
          onClose={() => { setShowMetadataModal(false); loadData(false) }}
        />
      )}

      <DetailMain>
        <div className="space-y-16">
          <DetailStoryline overview={game.overview} />

          {game.screenshot_url && (
            <section className="space-y-8">
              <div className="flex items-center gap-6">
                <h2 className="text-[10px] font-bold text-emerald-400 uppercase tracking-[0.3em] whitespace-nowrap">Media</h2>
                <div className="h-px w-full bg-white/[0.03]" />
              </div>
              <div className="rounded-3xl overflow-hidden shadow-2xl border border-white/5">
                <img src={game.screenshot_url} alt="Screenshot" className="w-full object-cover" />
              </div>
            </section>
          )}
        </div>

        <div className="space-y-8">
          <QualityPolicyPanel value={game as any} onChange={patch => handlePolicyUpdate(patch as Partial<Game>)} />
          <div className="bg-noir-900/50 border border-white/5 rounded-3xl p-6 space-y-6 sticky top-8 shadow-xl">
            <div>
              <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-[0.2em] mb-4 font-bold">Game Metadata</h3>
              <div className="space-y-3 text-xs">
                <div className="flex justify-between py-2 border-b border-white/5">
                  <span className="text-white/30">IGDB ID</span>
                  <span className="font-mono text-white/60">{game.igdb_id}</span>
                </div>
                {game.platforms && game.platforms.length > 0 && (
                  <div className="flex justify-between py-2 border-b border-white/5">
                    <span className="text-white/30">Platforms</span>
                    <span className="text-right text-white/60">{(game.platforms || []).map((p: string) => (p === 'Windows PC' || p === 'Mac' || p === 'Linux') ? 'Steam' : p).join(', ')}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </DetailMain>

      <ItemActionsBar
        accent="#2ECC71"
        containerClass="max-w-[1600px] mx-auto px-8 w-full"
        reacquire={{ mode: 'direct', run: async () => { await gamesApi.repair(game.id, {}); loadData(false) } }}
        loadHistory={() => gamesApi.acquisitionHistory(game.id)}
        onRemove={async () => { if (confirm('Remove this game from the library? Files on disk are kept.')) { await gamesApi.delete(game.id, false); onDelete(game.id); navigate('/games') } }}
        onDelete={async () => { if (confirm('Delete this game AND all its files from disk? This permanently removes the folder and cannot be undone.')) { await gamesApi.delete(game.id, true); onDelete(game.id); navigate('/games') } }}
        onEdit={() => setShowMetadataModal(true)}
      />
    </DetailPage>
  )
}

// ── Platform Games Page ──────────────────────────────────────────────────────

function PlatformGamesPage() {
  const { platform } = useParams<{ platform: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { activeTabId } = useTabs()
  const [games, setGames] = useState<Game[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState(searchParams.get('q') || '')
  const [collectionFilter, setCollectionFilter] = useState<GameCollectionFilter>('all')
  const [lastRedirect, setLastRedirect] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)

  const refresh = (showLoading = true) => {
    if (showLoading) setLoading(true)
    gamesApi.list()
      .then(all => {
        const list = (Array.isArray(all) ? all : [])
        const filteredByPlatform = list.filter(g => {
          const platforms = (g.platforms || []).map((p: string) => (p === 'Windows PC' || p === 'Mac' || p === 'Linux') ? 'Steam' : p)
          return platforms.includes(platform!)
        })
        setGames(filteredByPlatform)
      })
      .catch(console.error)
      .finally(() => { if (showLoading) setLoading(false) })
  }

  useEffect(() => { 
    setGames([])
    refresh(true) 
    const interval = setInterval(() => refresh(false), 5000)
    return () => clearInterval(interval)
  }, [platform, activeTabId])

  const filtered = games.filter(g => {
    const matchesSearch = !search || g.title.toLowerCase().includes(search.toLowerCase())
    if (!matchesSearch) return false

    if (collectionFilter === 'missing' && g.status !== 'missing' && g.status !== 'wanted') return false
    if (collectionFilter === 'collected' && g.status !== 'downloaded') return false
    if (collectionFilter === 'acquiring' && g.status !== 'downloading') return false

    return true
  })

  // Auto-redirect to Add page if no local matches
  useEffect(() => {
    const cooldown = Date.now() - lastRedirect
    const hasAnyTitleMatch = games.some(g => g.title.toLowerCase().includes(search.toLowerCase()))

    if (!loading && search.trim().length > 2 && !hasAnyTitleMatch && !location.pathname.endsWith('/add') && cooldown > 5000) {
      const timer = setTimeout(() => {
        setLastRedirect(Date.now())
        const term = search
        const platformId = GAME_PLATFORMS.find(p => p.name === platform)?.id
        setSearch('')
        navigate(`/games/add?q=${encodeURIComponent(term)}${platformId ? `&platform=${platformId}` : ''}`)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [search, games, loading, navigate, location.pathname, lastRedirect, platform])

  return (
    <div className="animate-fade-in">
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/games')} className="text-white/30 hover:text-white transition-all text-sm font-mono uppercase tracking-widest">← Back</button>
          <div className="h-4 w-px bg-white/10" />
          <h1 className="font-display text-3xl tracking-widest text-emerald-400 uppercase">{platform}</h1>
        </div>
        {!editMode && (
          <button onClick={() => setEditMode(true)}
            className="px-6 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold tracking-widest hover:bg-white/10 transition-all uppercase">
            Edit Games
          </button>
        )}
      </div>

      <div className="flex flex-col gap-4 mb-8">
        <div className="flex flex-col md:flex-row gap-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search platform..." className="max-w-sm" />
          <CollectionFilterBar value={collectionFilter} onChange={setCollectionFilter} accentColor="[#10B981]" />
        </div>
        {editMode && (
          <SelectionBar
            totalCount={filtered.length}
            selectedCount={selected.size}
            onSelectAll={() => setSelected(new Set(filtered.map(g => g.id)))}
            onSelectNone={() => setSelected(new Set())}
            deleting={deleting}
            onDone={() => { setEditMode(false); setSelected(new Set()) }}
            onDelete={async () => {
              if (!confirm(`Delete ${selected.size} game(s) and all associated files?`)) return
              setDeleting(true)
              try {
                await Promise.all([...selected].map(id => gamesApi.delete(id)))
                setGames(prev => prev.filter(g => !selected.has(g.id)))
                setSelected(new Set())
              } catch (err) { alert(String(err)) }
              finally { setDeleting(false) }
            }}
          />
        )}
      </div>

      {loading && games.length === 0 ? <PosterSkeleton /> : filtered.length === 0 ? (
        <EmptyState icon="🎮" title="NO GAMES FOUND" subtitle={`No games in your library for ${platform}`} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((g, i) => (
            <div key={g.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i * 25, 300)}ms`, animationFillMode: 'both' }}>
              <LibraryCard
                onClick={() => navigate(`/games/${g.id}`)}
                image={g.cover_url}
                title={`${g.title}${g.year ? ` (${g.year})` : ''}`}
                subtitle={`${g.year || 'TBA'}`}
                status={g.status === 'downloaded' ? 'collected' : (g.status === 'downloading' ? 'acquiring' : 'missing')}
                accentColor="#2ECC71"
                fallbackIcon="🎮"
                selectionMode={editMode}
                selected={selected.has(g.id)}
                onSelect={() => setSelected(prev => {
                  const next = new Set(prev)
                  if (next.has(g.id)) next.delete(g.id)
                  else next.add(g.id)
                  return next
                })}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Games Library ────────────────────────────────────────────────────────────

type GameCollectionFilter = 'all' | 'missing' | 'collected' | 'acquiring'

function GamesLibrary() {
  const [games, setGames] = useState<Game[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [collectionFilter, setCollectionFilter] = useState<GameCollectionFilter>('all')
  const [lastRedirect, setLastRedirect] = useState(0)
  const navigate = useNavigate()
  const location = useLocation()
  const { activeTabId, tabs, getActiveTabForMedia, setActiveTabForMedia } = useTabs()

  useEffect(() => {
    if (!tabs.length) return
    const gamesTab = getActiveTabForMedia('games')
    if (gamesTab && gamesTab.id !== activeTabId) {
      setActiveTabForMedia('games', gamesTab.id)
    }
  }, [tabs])

  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId])
  const activeName = activeTab ? activeTab.name.replace(/Games/i, '').trim() : ''

  const refresh = (showLoading = true) => {
    if (showLoading) setLoading(true)
    gamesApi.list()
      .then(data => {
        setGames(Array.isArray(data) ? data : [])
      })
      .catch(console.error)
      .finally(() => { if (showLoading) setLoading(false) })
  }

  useEffect(() => {
    if (!activeTabId) { setGames([]); setLoading(false); return }
    const current = tabs.find(t => t.id === activeTabId)
    if (current && current.media_type !== 'games') return
    setGames([])
    refresh(true)
    const interval = setInterval(() => refresh(false), 5000)
    return () => clearInterval(interval)
  }, [activeTabId, tabs])

  const filteredGames = games.filter(g => {
    const titleMatch = !search || g.title.toLowerCase().includes(search.toLowerCase())
    if (!titleMatch) return false

    if (collectionFilter === 'missing' && g.status !== 'missing' && g.status !== 'wanted') return false
    if (collectionFilter === 'collected' && g.status !== 'downloaded') return false
    if (collectionFilter === 'acquiring' && g.status !== 'downloading') return false

    return true
  })

  // Auto-redirect to Add page if no local matches
  useEffect(() => {
    const cooldown = Date.now() - lastRedirect
    const hasAnyTitleMatch = games.some(g => g.title.toLowerCase().includes(search.toLowerCase()))
    
    if (!loading && search.trim().length > 2 && !hasAnyTitleMatch && !location.pathname.endsWith('/add') && cooldown > 5000) {
      const timer = setTimeout(() => {
        setLastRedirect(Date.now())
        const term = search
        setSearch('')
        navigate(`add?q=${encodeURIComponent(term)}`)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [search, games, loading, navigate, location.pathname, lastRedirect])

  const platformsWithGames = Array.from(new Set(filteredGames.flatMap(g => (g.platforms || []).map((p: string) => (p === 'Windows PC' || p === 'Mac' || p === 'Linux') ? 'Steam' : p)))).sort()

  const getPlatformStats = (p: string) => {
    const pg = games.filter(g => {
      const platforms = (g.platforms || []).map(pl => (pl === 'Windows PC' || pl === 'Mac' || pl === 'Linux') ? 'Steam' : pl)
      return platforms.includes(p)
    })
    const total = pg.length
    const collected = pg.filter(g => g.status === 'downloaded').length
    const acquiring = pg.filter(g => g.status === 'downloading').length
    
    let status: 'collected' | 'acquiring' | 'missing' = 'missing'
    if (collected === total && total > 0) status = 'collected'
    else if (acquiring > 0) status = 'acquiring'

    return { total, collected, status }
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex justify-between items-end">
        <div>
          <h1 className="font-display text-5xl tracking-widest text-emerald-400">
            GAMES{activeName && activeName.toLowerCase() !== 'main' ? <span className="text-white/20 ml-4">({activeName.toUpperCase()})</span> : ''}
          </h1>
          <p className="text-emerald-400 text-[12.5px] mt-1 font-mono uppercase tracking-widest">
            <span className="text-white">{games.length}</span> {games.length === 1 ? 'game' : 'games'} in library
            {games.length > 0 && (() => {
              const collected = games.filter(g => g.status === 'downloaded').length
              const missing = games.filter(g => g.status === 'missing' || g.status === 'wanted').length
              const acquiring = games.filter(g => g.status === 'downloading').length
              return <> | <span className="text-white">{collected}</span> {collected === 1 ? 'game' : 'games'} Collected | <span className="text-white">{missing}</span> {missing === 1 ? 'game' : 'games'} Missing{acquiring > 0 ? <> | <span className="text-white">{acquiring}</span> {acquiring === 1 ? 'game' : 'games'} Acquiring</> : ''}</>
            })()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="add" className="px-6 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold tracking-widest hover:bg-white/10 transition-all uppercase">
            Add Game
          </Link>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-4 mb-8">
        <SearchInput value={search} onChange={setSearch} placeholder="Search all games..." className="max-w-sm" />
        <CollectionFilterBar value={collectionFilter} onChange={setCollectionFilter} accentColor="[#10B981]" />
      </div>
      
      {loading && games.length === 0 ? <PosterSkeleton /> : platformsWithGames.length === 0 ? (
        <EmptyState icon="🎮" title="NO MATCHES" subtitle={search ? `No games matching "${search}"` : "Your library is empty"} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {platformsWithGames.map((p, i) => {
            const stats = getPlatformStats(p)
            const platformInfo = GAME_PLATFORMS.find(info => info.name === p)
            return (
              <div key={p} className="animate-slide-up" style={{ animationDelay: `${Math.min(i * 25, 300)}ms`, animationFillMode: 'both' }}>
                <LibraryCard 
                  onClick={() => navigate(`platform/${encodeURIComponent(p)}${search ? `?q=${encodeURIComponent(search)}` : ''}`)}
                  title={p}
                  subtitle={`${stats.collected}/${stats.total} TITLES`}
                  status={stats.status}
                  accentColor="#2ECC71"
                  fallbackIcon={platformInfo?.icon || '🎮'}
                  aspect="aspect-square"
                />
              </div>
            )
          })}
        </div>
      )}

    </div>
  )
}

export function GamesPage() {
  return (
    <Routes>
      <Route index element={<GamesLibrary />} />
      <Route path="platform/:platform" element={<PlatformGamesPage />} />
      <Route path="add" element={<AddGamePage />} />
      <Route path=":id" element={<GameDetailPage onDelete={() => {}} />} />
    </Routes>
  )
}

// ── Add Game Page ────────────────────────────────────────────────────────────

function PlatformModal({ game, onClose, onConfirm, isAdding }: { 
  game: any; onClose: () => void; onConfirm: (platforms: string[]) => void; isAdding: boolean 
}) {
  const [selected, setSelected] = useState<string[]>([])

  const handleConfirm = () => {
    // If none selected, default to all available platforms for this game
    const finalPlatforms = selected.length === 0 ? (game.platforms || []) : selected
    onConfirm(finalPlatforms)
  }

  return (
    <Modal title={`Add ${game.title}`} onClose={onClose}>
      <div className="space-y-6">
        <p className="text-sm text-white/60">Which systems should we add this game for? (Leave all unselected to add for all systems)</p>
        
        <div className="grid grid-cols-1 gap-2 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar">
          {(game.platforms || []).map((p: string) => (
            <button key={p} 
              onClick={() => setSelected(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])}
              className={`px-4 py-3 rounded-xl text-left text-xs font-bold tracking-widest uppercase transition-all border ${
                selected.includes(p) ? 'bg-emerald-400/20 border-emerald-400/40 text-emerald-400' : 'bg-noir-900 border-white/5 text-white/30 hover:border-white/10'
              }`}>
              {(p === 'Windows PC' || p === 'Mac' || p === 'Linux') ? 'Steam' : p}
            </button>
          ))}
        </div>

        <div className="flex justify-end pt-4 border-t border-white/5">
          <div className="flex gap-3">
            <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest">Cancel</button>
            <button 
              onClick={handleConfirm}
              disabled={isAdding}
              className="px-8 py-2.5 rounded-xl bg-emerald-400 text-noir-950 font-bold text-xs uppercase tracking-widest transition-all shadow-xl disabled:opacity-50"
            >
              {isAdding ? 'Adding...' : 'Confirm Add'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function AddGamePage() {
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [platformId, setPlatformId] = useState<number>(parseInt(searchParams.get('platform') || '0'))
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<any | null>(null)
  const [added, setAdded] = useState<Set<number>>(new Set())
  const [detailGame, setDetailGame] = useState<any | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const navigate = useNavigate()

  useEffect(() => {
    clearTimeout(timer.current)
    if (!query.trim()) { setResults([]); setError(null); return }
    timer.current = setTimeout(async () => {
      setSearching(true)
      setError(null)
      try { 
        const items = await gamesApi.lookup(query, platformId > 0 ? platformId : undefined)
        
        // Deduplicate results by igdbId and aggregate platforms
        const deduped: any[] = []
        const seen = new Map<number, any>()
        
        for (const item of items) {
          const existing = seen.get(item.igdbId)
          if (existing) {
            // Add any new platforms to existing entry
            for (const p of (item.platforms || [])) {
              if (!existing.platforms.includes(p)) {
                existing.platforms.push(p)
              }
            }
          } else {
            const newItem = { ...item, platforms: [...(item.platforms || [])] }
            seen.set(item.igdbId, newItem)
            deduped.push(newItem)
          }
        }
        
        setResults(deduped)
      }
      catch (err) { 
        setError(err instanceof Error ? err.message : String(err))
        setResults([])
      }
      finally { setSearching(false) }
    }, 400)
    return () => clearTimeout(timer.current)
  }, [query, platformId])

  const handleConfirmAdd = (platforms: string[]) => {
    if (!adding) return
    const igdbId = adding.igdbId
    // Optimistic: close the picker and mark added instantly; the backend fetches
    // metadata and artwork in the background.
    setAdded(prev => new Set(prev).add(igdbId))
    setAdding(null)
    gamesApi.add(igdbId, platforms).catch(err => {
      alert(String(err))
      setAdded(prev => { const next = new Set(prev); next.delete(igdbId); return next })
    })
  }

  // Organise platforms by brand for the dropdown
  const pcPlatforms = GAME_PLATFORMS.filter(p => p.brand === 'PC' && p.id !== 6)
  const sonyPlatforms = GAME_PLATFORMS.filter(p => p.brand === 'Sony')
  const msPlatforms = GAME_PLATFORMS.filter(p => p.brand === 'Microsoft')
  const nintendoPlatforms = GAME_PLATFORMS.filter(p => p.brand === 'Nintendo')
  const segaPlatforms = GAME_PLATFORMS.filter(p => p.brand === 'Sega')

  return (
    <div className="animate-fade-in pb-20">
      <div className="mb-8 flex items-center gap-4">
        <button onClick={() => navigate('/games')} className="text-white/30 hover:text-white transition-all text-sm font-mono uppercase tracking-widest">← Back</button>
        <div className="h-4 w-px bg-white/10" />
        <h1 className="font-display text-3xl tracking-widest text-emerald-400">ADD GAME</h1>
      </div>
      
      <div className="flex flex-col md:flex-row gap-4 mb-12">
        <div className="flex-1 max-w-xl">
          <input type="text" value={query} onChange={e => setQuery(e.target.value)} 
            placeholder="Search IGDB for a game..." autoFocus
            className="w-full px-4 py-3 rounded-xl bg-noir-800 border border-white/10 text-white focus:outline-none focus:border-emerald-400/40 transition-all shadow-lg" />
        </div>
        
        <div className="w-full md:w-64">
          <Select value={platformId} onChange={e => setPlatformId(parseInt(e.target.value))} className="h-full !py-3 !bg-noir-800 !border-white/10 text-emerald-400/80 font-mono text-xs uppercase tracking-widest">
            <option value="0">All Platforms</option>
            <option value="6">Steam</option>
            <optgroup label="SONY">
              {sonyPlatforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
            <optgroup label="MICROSOFT">
              {msPlatforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
            <optgroup label="NINTENDO">
              {nintendoPlatforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
            <optgroup label="SEGA">
              {segaPlatforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
          </Select>
        </div>
      </div>

      {searching ? <PosterSkeleton /> : error ? (
        <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-8 text-center max-w-2xl mx-auto">
          <p className="text-red-500 font-bold mb-2 uppercase tracking-widest">Search Failed</p>
          <p className="text-red-500/60 text-xs font-mono">{error}</p>
        </div>
      ) : results.length === 0 && query.trim() ? (
        <EmptyState icon="🔍" title="NO RESULTS" subtitle="Try another game title" />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {results.map((item: any) => {
            const isAdded = added.has(item.igdbId) || item.alreadyAdded
            const displayPlatforms = (item.platforms || []).map((p: string) => (p === 'Windows PC' || p === 'Mac' || p === 'Linux') ? 'Steam' : p)
            return (
              <div key={item.igdbId} className="animate-slide-up" style={{ animationDelay: `${Math.min(results.indexOf(item) * 25, 300)}ms`, animationFillMode: 'both' }}>
                <LibraryCard
                  onClick={() => setDetailGame(item)}
                  image={item.coverUrl}
                  title={item.title}
                  subtitle={`${item.year || 'TBA'} • ${displayPlatforms[0] || 'PC'}`}
                  accentColor="#2ECC71"
                  fallbackIcon="🎮"
                  badge={
                    <button onClick={e => { e.stopPropagation(); !isAdded && setAdding(item) }} disabled={isAdded || (adding && adding.igdbId === item.igdbId)}
                      className={`px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-widest border transition-all ${isAdded ? 'bg-green-500/10 border-green-500/20 text-green-500' : 'bg-noir-950/60 border-white/10 text-white hover:bg-white/10'}`}>
                      {isAdded ? '✓ In Library' : (adding && adding.igdbId === item.igdbId) ? '...' : '+ Add'}
                    </button>
                  }
                />
              </div>
            )
          })}
        </div>
      )}

      {detailGame && (
        <SearchDetailModal
          onClose={() => setDetailGame(null)}
          onAdd={() => setAdding(detailGame)}
          isAdded={added.has(detailGame.igdbId) || detailGame.alreadyAdded}
          accentColor="#2ECC71"
          fallbackIcon="🎮"
          image={detailGame.coverUrl}
          backdrop={detailGame.screenshotUrl || detailGame.artworkUrl}
          title={detailGame.title}
          year={detailGame.year}
          rating={detailGame.rating}
          genres={detailGame.genres || []}
          overview={detailGame.overview || detailGame.summary}
          facts={[
            { label: 'Developer', value: detailGame.developer },
            { label: 'Publisher', value: detailGame.publisher },
            { label: 'Platforms', value: (detailGame.platforms || []).join(', ') },
          ]}
        />
      )}

      {adding && (
        <PlatformModal
          game={adding}
          onClose={() => setAdding(null)}
          onConfirm={handleConfirmAdd}
          isAdding={false}
        />
      )}
    </div>
  )
}
