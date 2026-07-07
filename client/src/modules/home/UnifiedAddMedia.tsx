import { useState, useRef, useEffect, useMemo } from 'react'
import { filmsApi } from '../../lib/films.api.js'
import { seriesApi } from '../../lib/series.api.js'
import { musicApi } from '../../lib/music.api.js'
import { booksApi } from '../../lib/books.api.js'
import { comicsApi, gamesApi } from '../../lib/comics-games.api.js'
import { sharedApi } from '../../lib/shared.api.js'
import { tmdbImage, requestWithTab } from '../../lib/api.js'
import { LibraryCard, PosterSkeleton, Modal, Spinner, TabSelect } from '../../components/ui.js'
import { SearchDetailModal } from '../../components/SearchDetailModal.js'
import { useTabs } from '../../lib/tab-context.js'

type MediaType = 'movie' | 'tv' | 'music' | 'book' | 'comic' | 'game'

const MEDIA_TYPES: { type: MediaType; label: string; icon: string; color: string }[] = [
  { type: 'movie', label: 'Films',  icon: '🎬', color: '#00D4FF' },
  { type: 'tv',    label: 'Series', icon: '📺', color: '#9B59B6' },
  { type: 'music', label: 'Music',  icon: '🎵', color: '#FF2D78' },
  { type: 'book',  label: 'Books',  icon: '📚', color: '#F1C40F' },
  { type: 'comic', label: 'Comics', icon: '🦸', color: '#E67E22' },
  { type: 'game',  label: 'Games',  icon: '🎮', color: '#2ECC71' },
]

function PlatformModal({ game, onClose, onConfirm, isAdding }: { 
  game: any; onClose: () => void; onConfirm: (platforms: string[]) => void; isAdding: boolean 
}) {
  const [selected, setSelected] = useState<string[]>([])

  const handleConfirm = () => {
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

function FilmModal({ film, onClose, onConfirm, isAdding }: {
  film: any; onClose: () => void; onConfirm: (prefs: { tier: string, resolution: string, source: string, codec: string, tabId: number }) => void; isAdding: boolean
}) {
  const { tabs, activeTabId } = useTabs()
  const filmTabs = useMemo(() => (Array.isArray(tabs) ? tabs : []).filter(t => t.media_type === 'films'), [tabs])

  const [tier, setTier] = useState('Any')
  const [resolution, setResolution] = useState('Any')
  const [source, setSource] = useState('Any')
  const [codec, setCodec] = useState('Any')
  const [targetTabId, setTargetTabId] = useState<number>(0)

  useEffect(() => {
    if (activeTabId && filmTabs.some(t => t.id === activeTabId)) {
      setTargetTabId(activeTabId)
    } else if (filmTabs.length > 0) {
      setTargetTabId(filmTabs[0].id)
    }
  }, [filmTabs, activeTabId])

  useEffect(() => {
    if (!targetTabId) return
    sharedApi.settings.getAcquisitionDefaults(targetTabId).then(defaults => {
      if (!defaults) return
      if (defaults.tier) setTier(defaults.tier)
      if (defaults.resolution) setResolution(defaults.resolution)
      if (defaults.source) setSource(defaults.source)
      if (defaults.codec) setCodec(defaults.codec)
    }).catch(() => {})
  }, [targetTabId])

  if (!film) return null

  return (
    <Modal title={`Add ${film.title}`} onClose={onClose}>
      <div className="space-y-6">
        {filmTabs.length > 1 && (
          <div className="p-4 rounded-xl bg-[#00D4FF]/5 border border-[#00D4FF]/10">
            <p className="text-[10px] font-mono text-[#00D4FF] uppercase tracking-widest mb-3">Target Library Tab</p>
            <div className="flex flex-wrap gap-2">
              {filmTabs.map(t => (
                <button key={t.id} onClick={() => setTargetTabId(t.id)}
                  className={`px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all border ${
                    targetTabId === t.id ? 'bg-[#00D4FF] text-noir-950 border-[#00D4FF]' : 'bg-white/5 text-white/40 border-white/5 hover:border-white/10'
                  }`}>
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest px-1">Acquisition Defaults</p>
        
        <div className="grid grid-cols-1 gap-6">
          <TabSelect label="Tier" value={tier} options={['Any', 'Tier 1', 'Tier 2', 'Tier 3']} onChange={setTier} />
          <TabSelect label="Resolution" value={resolution} options={['Any', '2160p', '1080p', '720p']} onChange={setResolution} />
          <TabSelect label="Source" value={source} options={['Any', 'BluRay', 'Web', 'DVD']} onChange={setSource} />
          <TabSelect label="Codec" value={codec} options={['Any', 'Remux', 'AV1', 'x265', 'x264']} onChange={setCodec} />
        </div>

        <div className="flex justify-end pt-4 border-t border-white/5">
          <div className="flex gap-3">
            <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest">Cancel</button>
            <button 
              onClick={() => onConfirm({ tier, resolution, source, codec, tabId: targetTabId })}
              disabled={isAdding || !targetTabId}
              className="px-8 py-2.5 rounded-xl bg-[#00D4FF] text-noir-950 font-bold text-xs uppercase tracking-widest transition-all shadow-xl disabled:opacity-50"
            >
              {isAdding ? 'Adding...' : 'Confirm Add to Tab'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function UnifiedAddMedia() {
  const [activeType, setActiveType] = useState<MediaType>('movie')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [added, setAdded] = useState<Set<string | number>>(new Set())
  const [addingGame, setAddingGame] = useState<any | null>(null)
  const [addingFilm, setAddingFilm] = useState<any | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [detailItem, setDetailItem] = useState<any | null>(null)
  const timer = useRef<any>()

  useEffect(() => {
    clearTimeout(timer.current)
    if (!query.trim()) { setResults([]); return }
    
    timer.current = setTimeout(async () => {
      setSearching(true)
      try {
        let items: any[] = []
        switch (activeType) {
          case 'tv':    items = await seriesApi.lookup(query); break
          case 'movie': items = await filmsApi.lookup(query); break
          case 'music': items = await musicApi.lookup(query); break
          case 'book':  items = await booksApi.lookup(query); break
          case 'comic': items = await comicsApi.lookup(query); break
          case 'game':  {
            const raw = await gamesApi.lookup(query)
            const deduped: any[] = []
            const seen = new Map<number, any>()
            for (const item of raw) {
              const existing = seen.get(item.igdbId)
              if (existing) {
                for (const p of (item.platforms || [])) {
                  if (!existing.platforms.includes(p)) existing.platforms.push(p)
                }
              } else {
                const newItem = { ...item, platforms: [...(item.platforms || [])] }
                seen.set(item.igdbId, newItem)
                deduped.push(newItem)
              }
            }
            items = deduped
            break
          }
        }
        setResults(items.slice(0, 12))
      } catch (err) {
        console.error('Lookup failed:', err)
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 500)
    return () => clearTimeout(timer.current)
  }, [query, activeType])

  const handleAdd = async (item: any) => {
    if (activeType === 'game') {
      setAddingGame(item)
      return
    }
    if (activeType === 'movie') {
      setAddingFilm(item)
      return
    }

    // Optimistic add: mark the card added instantly and let the backend create
    // folders and download artwork in the background, so the search stays snappy.
    let id: string | number = ''
    let req: Promise<unknown>
    switch (activeType) {
      case 'tv':    id = item.tmdbId || item.tvdbId; req = seriesApi.add({ tmdbId: item.tmdbId, tvdbId: item.tvdbId }); break
      case 'music': id = item.mbid; req = musicApi.artists.add(item.mbid); break
      case 'book':  id = item.name; req = booksApi.authors.add(item.name); break
      case 'comic': id = item.id; req = comicsApi.series.add(item.id); break
      default: return
    }
    setAdded(prev => new Set(prev).add(id))
    req.catch(err => {
      alert(String(err))
      setAdded(prev => { const next = new Set(prev); next.delete(id); return next })
    })
  }

  const handleConfirmAddGame = (platforms: string[]) => {
    if (!addingGame) return
    const igdbId = addingGame.igdbId
    setAdded(prev => new Set(prev).add(igdbId))
    setAddingGame(null)
    gamesApi.add(igdbId, platforms).catch(err => {
      alert(String(err))
      setAdded(prev => { const next = new Set(prev); next.delete(igdbId); return next })
    })
  }

  const handleConfirmAddFilm = (prefs: { tier: string, resolution: string, source: string, codec: string, tabId: number }) => {
    if (!addingFilm) return
    const tmdbId = addingFilm.tmdbId
    setAdded(prev => new Set(prev).add(tmdbId))
    setAddingFilm(null)
    // Use requestWithTab to avoid mutating global tab context
    requestWithTab(prefs.tabId, '/films', {
      method: 'POST',
      body: JSON.stringify({
        tmdbId,
        target_tier: prefs.tier,
        target_resolution: prefs.resolution,
        target_source: prefs.source,
        target_codec: prefs.codec
      })
    }).catch(err => {
      alert(String(err))
      setAdded(prev => { const next = new Set(prev); next.delete(tmdbId); return next })
    })
  }

  return (
    <div className="space-y-4 mt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-mono text-white/20 uppercase tracking-[0.3em]">Add Media</h2>
        <div className="h-px flex-1 bg-white/5 ml-6" />
      </div>

      <div className="bg-noir-900/50 border border-white/5 rounded-3xl overflow-hidden backdrop-blur-sm">
        <div className="p-4 border-b border-white/5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex-1 max-w-xl">
            <div className="relative group">
              <input type="text" value={query} onChange={e => setQuery(e.target.value)}
                placeholder={`Search for ${MEDIA_TYPES.find(m => m.type === activeType)?.label.toLowerCase()} to add...`}
                className="w-full bg-noir-950/50 border border-white/10 rounded-xl px-5 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/20 transition-all shadow-2xl" />
              <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
                {searching ? (
                  <Spinner className="w-4 h-4" />
                ) : (
                  <span className="text-white/10 text-base">🔍</span>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex flex-wrap gap-1 p-1 bg-noir-950/50 rounded-xl border border-white/5 h-[44px]">
            {MEDIA_TYPES.map(m => (
              <button key={m.type}
                onClick={() => { setActiveType(m.type); setResults([]); setQuery(''); setAdded(new Set()); }}
                className={`px-3 flex-1 rounded-lg text-[9px] font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2 border border-transparent
                  ${activeType === m.type 
                    ? 'text-white shadow-lg' 
                    : 'text-white/30 hover:text-white/60 hover:bg-white/5'}`}
                style={activeType === m.type ? { backgroundColor: `${m.color}20`, borderColor: `${m.color}40`, color: m.color } : {}}>
                <span className="text-sm">{m.icon}</span>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {(searching || results.length > 0) && (
          <div className="p-4 space-y-6">
            {searching ? <PosterSkeleton /> : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 min-h-[180px]">
                {results.map((item, i) => {
                  let id: any = ''; let image: any = ''; let title = ''; let subtitle = '';
                  const m = MEDIA_TYPES.find(x => x.type === activeType)!
                  
                  if (activeType === 'tv') {
                    id = item.tmdbId || item.tvdbId; image = tmdbImage(item.posterPath); title = item.title; subtitle = String(item.year || '')
                  } else if (activeType === 'movie') {
                    id = item.tmdbId; image = tmdbImage(item.posterPath); title = item.title; subtitle = String(item.year || '')
                  } else if (activeType === 'music') {
                    id = item.mbid; image = item.imageUrl; title = item.name; subtitle = item.disambiguation || 'Artist'
                  } else if (activeType === 'book') {
                    id = item.name; image = item.imageUrl; title = item.name; subtitle = 'Author'
                  } else if (activeType === 'comic') {
                    id = item.id; image = item.coverUrl; title = item.name; subtitle = `${item.publisher || 'Independent'} (${item.startYear || '?'})`
                  } else if (activeType === 'game') {
                    id = item.igdbId; image = item.coverUrl; title = item.title; subtitle = String(item.year || '')
                  }

                  const isAdded = added.has(id) || item.alreadyAdded

                  return (
                    <div key={i} className="animate-slide-up" style={{ animationDelay: `${i * 25}ms`, animationFillMode: 'both' }}>
                      <LibraryCard
                        onClick={() => setDetailItem(item)}
                        image={image}
                        title={title}
                        subtitle={subtitle}
                        accentColor={m.color}
                        fallbackIcon={m.icon}
                        badge={
                          <button 
                            onClick={e => { e.stopPropagation(); !isAdded && handleAdd(item); }}
                            disabled={isAdded || (isAdding && addingGame?.igdbId !== item.igdbId)}
                            className={`px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-widest border transition-all ${
                              isAdded ? 'bg-green-500/10 border-green-500/20 text-green-500' : 
                              'bg-noir-950/60 border-white/10 text-white hover:bg-white/10 hover:border-white/20'
                            }`}>
                            {isAdded ? '✓ In Library' : '+ Add'}
                          </button>
                        }
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {detailItem && (() => {
        const it = detailItem
        const map: Record<string, any> = {
          tv:    { image: tmdbImage(it.posterPath), backdrop: tmdbImage(it.backdropPath, 'w1280'), title: it.title, year: it.year, rating: it.rating, genres: it.genres, overview: it.overview, facts: [{ label: 'Network', value: it.network }], key: it.tmdbId || it.tvdbId },
          movie: { image: tmdbImage(it.posterPath), backdrop: tmdbImage(it.backdropPath, 'w1280'), title: it.title, year: it.year, rating: it.rating, genres: it.genres, overview: it.overview, facts: [{ label: 'Studio', value: it.studio }, { label: 'Runtime', value: it.runtime ? `${it.runtime} min` : null }], key: it.tmdbId },
          music: { image: it.imageUrl, title: it.name, overview: it.overview, genres: it.genres, facts: [{ label: 'Type', value: it.type || 'Artist' }, { label: 'Disambiguation', value: it.disambiguation }], key: it.mbid },
          book:  { image: it.imageUrl, title: it.name, overview: it.overview || it.bio, facts: [{ label: 'Works', value: it.workCount }, { label: 'Top Work', value: it.topWork }], key: it.name },
          comic: { image: it.coverUrl, title: it.name, year: it.startYear, overview: it.description || it.overview, facts: [{ label: 'Publisher', value: it.publisher }, { label: 'Issues', value: it.issueCount }], key: it.id },
          game:  { image: it.coverUrl, backdrop: it.screenshotUrl, title: it.title, year: it.year, rating: it.rating, genres: it.genres, overview: it.overview || it.summary, facts: [{ label: 'Developer', value: it.developer }, { label: 'Publisher', value: it.publisher }], key: it.igdbId },
        }
        const d = map[activeType]
        const m = MEDIA_TYPES.find(x => x.type === activeType)!
        if (!d) return null
        return (
          <SearchDetailModal
            onClose={() => setDetailItem(null)}
            onAdd={() => handleAdd(it)}
            isAdded={added.has(d.key) || it.alreadyAdded}
            accentColor={m.color}
            fallbackIcon={m.icon}
            image={d.image}
            backdrop={d.backdrop}
            title={d.title}
            year={d.year}
            rating={d.rating}
            genres={d.genres || []}
            overview={d.overview}
            facts={d.facts}
          />
        )
      })()}

      {addingGame && (
        <PlatformModal
          game={addingGame}
          onClose={() => setAddingGame(null)}
          onConfirm={handleConfirmAddGame}
          isAdding={isAdding}
        />
      )}

      {addingFilm && (
        <FilmModal 
          film={addingFilm}
          onClose={() => setAddingFilm(null)}
          onConfirm={handleConfirmAddFilm}
          isAdding={isAdding}
        />
      )}
    </div>
  )
}
