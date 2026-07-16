import { useState, useEffect, useRef, useMemo } from 'react'
import { Routes, Route, useParams, useNavigate, Link, useSearchParams, useLocation } from 'react-router-dom'
import { seriesApi, type Series, type Season, type Episode, type SeriesSearchResult, type SeriesRelease, type ScanMode } from '../../lib/series.api.js'
import { tmdbImage, formatSize, requestWithTab } from '../../lib/api.js'
import { useTabs } from '../../lib/tab-context.js'
import {
  SearchInput, PosterSkeleton, EmptyState, StatusBadge, Modal, ReleaseList, Select,
  DetailPage, DetailHeader, DetailPoster, DetailMain, DetailStoryline, DetailMetaItem,
  LibraryCard, CollectionFilterBar, SelectionBar, Spinner, QualityPolicyPanel
} from '../../components/ui.js'
import { MetadataEditorModal } from '../../components/MetadataEditorModal.js'
import { FileMetadataEditorModal } from '../../components/FileMetadataEditorModal.js'
import { SearchDetailModal } from '../../components/SearchDetailModal.js'
import { ItemActionsBar } from '../../components/ItemActions.js'
import { AcquisitionAddModal, type AcquisitionPreferences } from '../../components/AcquisitionAddModal.js'

function episodeAirLabel(episode: Episode): string {
  if (episode.air_at) {
    return new Date(episode.air_at).toLocaleString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  }
  return episode.air_date || 'TBA'
}

// ── Series Detail Page ───────────────────────────────────────────────────────

// ── Series Detail Page ───────────────────────────────────────────────────────

function CertificationBadge({ cert }: { cert?: string }) {
  if (!cert) return null
  const c = cert.toUpperCase()
  const styles: Record<string, string> = {
    'G': 'bg-green-500/20 text-green-500 border-green-500/20',
    'TV-G': 'bg-green-500/20 text-green-500 border-green-500/20',
    'PG': 'bg-blue-500/20 text-blue-500 border-blue-500/20',
    'TV-PG': 'bg-blue-500/20 text-blue-500 border-blue-500/20',
    'TV-14': 'bg-yellow-500/20 text-yellow-500 border-yellow-500/20',
    'PG-13': 'bg-yellow-500/20 text-yellow-500 border-yellow-500/20',
    'R': 'bg-red-500/20 text-red-500 border-red-500/20',
    'TV-MA': 'bg-red-500/20 text-red-500 border-red-500/20',
  }
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-black tracking-tighter ${styles[c] || 'bg-white/5 text-white/40 border-white/10'}`}>
      {c}
    </span>
  )
}

function CountryFlag({ country }: { country?: string }) {
  if (!country) return null
  if (country.length > 3) return <span className="text-lg leading-none">{country}</span>
  const code = country.toLowerCase()
  return (
    <img 
      src={`https://flagcdn.com/w40/${code}.png`} 
      className="h-3 w-auto object-contain rounded-sm opacity-80" 
      alt={country}
      onError={(e) => { (e.target as any).style.display = 'none' }}
    />
  )
}

function SeriesDetailPage({ onDelete }: { onDelete: (id: number) => void }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [series, setSeries] = useState<Series | null>(null)
  const seriesRef = useRef<Series | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null)
  const [seasons, setSeasons] = useState<Season[]>([])
  const [episodes, setEpisodes] = useState<Record<number, Episode[]>>({})
  const [releases, setReleases] = useState<Record<number, SeriesRelease[]>>({})
  const [searchingSeason, setSearchingSeason] = useState<Record<number, boolean>>({})
  const [autoSearchingSeason, setAutoSearchingSeason] = useState<Record<number, boolean>>({})
  const [grabbing, setGrabbing] = useState<string | null>(null)
  const [grabbed, setGrabbed] = useState<Set<string>>(new Set())
  const [episodeResults, setEpisodeResults] = useState<SeriesRelease[] | null>(null)
  const [searchingEpisode, setSearchingEpisode] = useState(false)
  const [autoSearchingEpisodes, setAutoSearchingEpisodes] = useState<Set<number>>(new Set())
  const [currentSearchEpisode, setCurrentSearchEpisode] = useState<Episode | null>(null)
  const [showMetadataModal, setShowMetadataModal] = useState(false)
  const [editingFilePath, setEditingFilePath] = useState<string | null>(null)
  const [seriesResults, setSeriesResults] = useState<SeriesRelease[] | null>(null)
  const [searchingSeries, setSearchingSeries] = useState(false)
  const [autoSearchingSeries, setAutoSearchingSeries] = useState(false)
  // Inline auto-scan errors, keyed by scope: `ep:<id>`, `season:<n>`, or `series`.
  const [autoError, setAutoError] = useState<Record<string, string>>({})
  // Per-item scan mode: 'acquire' (missing) | 'upgrade' (collected, below target) | 'satisfied' (at target).
  const [scanModes, setScanModes] = useState<{ series: ScanMode; seasons: Record<number, ScanMode>; episodes: Record<number, ScanMode> } | null>(null)
  const epMode = (ep: Episode): ScanMode => scanModes?.episodes[ep.id] ?? 'acquire'
  const seasonMode = (n: number): ScanMode => scanModes?.seasons[n] ?? 'acquire'
  const seriesMode = (): ScanMode => scanModes?.series ?? 'acquire'
  // Idle label ("Manual Scan"/"Manual Upgrade") and active label ("Scanning"/"Upgrading").
  const scanLabel = (busy: boolean, mode: ScanMode, idleScan: string, idleUpgrade: string) =>
    busy ? (mode === 'upgrade' ? 'Upgrading' : 'Scanning') : (mode === 'upgrade' ? idleUpgrade : idleScan)
  // Aborts the in-flight manual (streaming) search — fired when a release is
  // grabbed or a new search starts, so the exhaustive search stops early.
  const searchAbortRef = useRef<AbortController | null>(null)
  const beginStreamingSearch = () => {
    searchAbortRef.current?.abort()
    const ctrl = new AbortController()
    searchAbortRef.current = ctrl
    return ctrl.signal
  }
  const stopStreamingSearch = () => { searchAbortRef.current?.abort(); searchAbortRef.current = null }
  const isAbort = (err: unknown) => err instanceof DOMException && err.name === 'AbortError'
  // Aborts the in-flight auto scan — fired when the active "Scanning" button is
  // clicked again. The server bails between indexer searches on request close.
  const autoAbortRef = useRef<AbortController | null>(null)
  const beginAutoScan = () => {
    autoAbortRef.current?.abort()
    const ctrl = new AbortController()
    autoAbortRef.current = ctrl
    return ctrl.signal
  }
  const stopAutoScan = () => { autoAbortRef.current?.abort(); autoAbortRef.current = null }
  useEffect(() => () => { searchAbortRef.current?.abort(); autoAbortRef.current?.abort() }, [])
  const [activeTorrents, setActiveTorrents] = useState<any[]>([])

  const fetchSeries = (showLoading = true) => {
    if (!id) return
    if (showLoading) setLoading(true)
    seriesApi.get(parseInt(id))
      .then(data => {
        if (data && typeof data === 'object' && 'id' in data) {
          setSeries(data)
          seriesRef.current = data
          const sortedSeasons = [...(data.seasons || [])].sort((a, b) => {
            return data.status === 'ended' ? a.season_number - b.season_number : b.season_number - a.season_number
          })
          setSeasons(sortedSeasons)
        }
      })
      .catch(() => navigate('/series'))
      .finally(() => { if (showLoading) setLoading(false) })
    seriesApi.scanModes(parseInt(id)).then(setScanModes).catch(() => {})
  }

  const handleSearchEpisode = async (ep: Episode) => {
    if (!series) return
    setCurrentSearchEpisode(ep)
    setSearchingEpisode(true)
    setEpisodeResults([])
    try {
      const query = `${series.title} S${String(ep.season_number).padStart(2, '0')}E${String(ep.episode_number).padStart(2, '0')}`
      await seriesApi.releases.search(query, (batch) => {
        setEpisodeResults(prev => [...(prev ?? []), ...batch])
      }, beginStreamingSearch(), { seriesId: series.id, episodeId: ep.id })
    } catch (err) {
      if (isAbort(err)) return
      console.error(err)
      alert('Search failed')
    } finally {
      setSearchingEpisode(false)
    }
  }

  useEffect(() => {
    fetchSeries(true)
    const interval = setInterval(() => {
      fetchSeries(false)
      if (selectedSeasonRef.current !== null) {
        loadEpisodes(selectedSeasonRef.current, false)
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [id, navigate])


  useEffect(() => {
    if (!series?.id) return
    let cancelled = false
    const fetchActiveTorrents = async () => {
      try {
        const [torrents, allSeasons, allEpisodes] = await Promise.all([
          fetch('/api/v1/torrents').then(response => response.json()),
          seriesApi.seasons.list(series.id),
          seriesApi.episodes.list(series.id),
        ])
        const hashes = new Set(
          [...allSeasons, ...allEpisodes]
            .map(item => item.info_hash?.toLowerCase())
            .filter((hash): hash is string => !!hash)
        )
        if (!cancelled) {
          setActiveTorrents((Array.isArray(torrents) ? torrents : []).filter((torrent: any) =>
            torrent.infoHash && hashes.has(String(torrent.infoHash).toLowerCase())
          ))
        }
      } catch {
        if (!cancelled) setActiveTorrents([])
      }
    }
    fetchActiveTorrents()
    const interval = setInterval(fetchActiveTorrents, 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [series?.id])

  const selectedSeasonRef = useRef<number | null>(null)
  useEffect(() => {
    selectedSeasonRef.current = selectedSeason
    if (selectedSeason !== null) loadEpisodes(selectedSeason, true)
  }, [selectedSeason])

  const loadEpisodes = async (seasonNum: number, showLoading = false) => {
    const s = seriesRef.current
    if (!s) return
    try {
      const data = await seriesApi.seasons.get(s.id, seasonNum)
      let epList = data.episodes || []
      epList = [...epList].sort((a, b) => s.status === 'ended' ? a.episode_number - b.episode_number : b.episode_number - a.episode_number)
      setEpisodes(prev => ({ ...prev, [seasonNum]: epList }))
    } catch (err) { console.error(err) }
  }

  const handleSearchSeries = async () => {
    if (!series) return
    setSearchingSeries(true)
    setSeriesResults([])
    try {
      await seriesApi.releases.search(series.title, (batch) => {
        setSeriesResults(prev => [...(prev ?? []), ...batch])
      }, beginStreamingSearch(), { seriesId: series.id })
    } catch (err) {
      if (isAbort(err)) return
      console.error(err)
      alert('Search failed')
    } finally {
      setSearchingSeries(false)
    }
  }


  const setScanError = (key: string, err: unknown) =>
    setAutoError(prev => ({ ...prev, [key]: err instanceof Error ? err.message : String(err) }))
  const clearScanError = (key: string) =>
    setAutoError(prev => { const next = { ...prev }; delete next[key]; return next })

  const handleAutoSeriesScan = async () => {
    if (!series) return
    clearScanError('series')
    setAutoSearchingSeries(true)
    try {
      await seriesApi.releases.auto({ seriesId: series.id }, beginAutoScan())
      if (selectedSeason !== null) await loadEpisodes(selectedSeason, false)
    } catch (err) {
      if (!isAbort(err)) setScanError('series', err)
    } finally {
      setAutoSearchingSeries(false)
    }
  }

  const handleAutoSeasonScan = async (seasonNumber: number) => {
    if (!series) return
    clearScanError(`season:${seasonNumber}`)
    setAutoSearchingSeason(prev => ({ ...prev, [seasonNumber]: true }))
    try {
      await seriesApi.releases.auto({ seriesId: series.id, seasonNumber }, beginAutoScan())
      await loadEpisodes(seasonNumber, false)
    } catch (err) {
      if (!isAbort(err)) setScanError(`season:${seasonNumber}`, err)
    } finally {
      setAutoSearchingSeason(prev => ({ ...prev, [seasonNumber]: false }))
    }
  }

  const handleAutoEpisodeScan = async (episode: Episode) => {
    if (!series) return
    clearScanError(`ep:${episode.id}`)
    setAutoSearchingEpisodes(prev => new Set([...prev, episode.id]))
    try {
      await seriesApi.releases.auto({ seriesId: series.id, episodeId: episode.id }, beginAutoScan())
      await loadEpisodes(episode.season_number, false)
    } catch (err) {
      if (!isAbort(err)) setScanError(`ep:${episode.id}`, err)
    } finally {
      setAutoSearchingEpisodes(prev => {
        const next = new Set(prev)
        next.delete(episode.id)
        return next
      })
    }
  }

  const handleDownloadSeriesRelease = async (release: SeriesRelease) => {
    if (!series) return
    stopStreamingSearch() // selecting a release ends the search
    setGrabbing(release.guid)
    try {
      const res = await seriesApi.download(release.downloadUrl, series.id)
      if (res.success) {
        setGrabbed(prev => new Set([...prev, release.guid]))
        fetchSeries(false)
      } else {
        alert(`Failed to send to client: ${res.message}`)
      }
    } catch (err) {
      alert(`Error starting download: ${String(err)}`)
    } finally {
      setGrabbing(null)
    }
  }

  const handleSearchSeason = async (seasonNum: number) => {
    if (!series) return
    setSearchingSeason(prev => ({ ...prev, [seasonNum]: true }))
    setReleases(prev => ({ ...prev, [seasonNum]: [] }))
    try {
      const query = `${series.title} S${String(seasonNum).padStart(2, '0')}`
      await seriesApi.releases.search(query, (batch) => {
        setReleases(prev => ({ ...prev, [seasonNum]: [...(prev[seasonNum] ?? []), ...batch] }))
      }, beginStreamingSearch(), { seriesId: series.id, seasonNumber: seasonNum })
    } catch (err) {
      if (isAbort(err)) return
      console.error(err)
      alert('Search failed')
    } finally {
      setSearchingSeason(prev => ({ ...prev, [seasonNum]: false }))
    }
  }

  const handleDownloadRelease = async (release: SeriesRelease, seasonNum: number, episodeId?: number) => {
    if (!series) return
    stopStreamingSearch() // selecting a release ends the search
    setGrabbing(release.guid)
    try {
      const res = await seriesApi.download(release.downloadUrl, series.id, seasonNum, episodeId)
      if (res.success) {
        setGrabbed(prev => new Set([...prev, release.guid]))
        fetchSeries(false)
      } else {
        alert(`Failed to send to client: ${res.message}`)
      }
    } catch (err) {
      alert(`Error starting download: ${String(err)}`)
    } finally {
      setGrabbing(null)
    }
  }

  const handleUpdate = async (updates: Partial<Series>) => {
    if (!series) return
    try {
      const updated = await seriesApi.update(series.id, updates)
      if (updated) setSeries(prev => prev ? { ...prev, ...updated } : null)
    } catch (err) {
      alert(String(err))
    }
  }

  if (loading && !series) return <PosterSkeleton />
  if (!series) return <EmptyState icon="📺" title="SERIES NOT FOUND" />

  const isAcquiring = series.stats?.acquiring && series.stats.acquiring > 0
  const isCollected = series.stats?.downloaded && series.stats.total > 0 && series.stats.downloaded === series.stats.total
  const status = isAcquiring ? 'downloading' : isCollected ? 'downloaded' : 'missing'

  return (
    <div className="animate-fade-in pb-20 relative min-h-screen">
      {/* Immersive Backdrop Fix */}
      <div className="fixed inset-0 pointer-events-none" style={{ zIndex: -5 }}>
        <img 
          src={series.backdrop_path} 
          className="w-full h-full object-cover opacity-50 blur-[10px] scale-110" 
          alt="" 
        />
        <div className="absolute inset-0 bg-noir-950/40" />
      </div>

      <div className="relative z-10 max-w-[1600px] mx-auto px-8 pt-4">
        {/* Main Grid: 12 Columns */}
        <div className="grid grid-cols-12 gap-x-16 gap-y-16 items-stretch">
          
          {/* Top Left: Poster (col-span-3) */}
          <div className="col-span-12 lg:col-span-3 flex flex-col items-stretch gap-4">
            <div className="aspect-[2/3] w-full rounded-3xl overflow-hidden border border-white/10 shadow-[0_0_60px_rgba(0,0,0,0.6)] group/poster relative">
              <img src={series.poster_path} className="w-full h-full object-cover" alt="" />
            </div>
            <div className="flex items-center justify-between px-1">
              <StatusBadge status={status} className="!text-[14px]" />
              <div className="flex items-center gap-3">
                <CountryFlag country={series.country} />
                <CertificationBadge cert={series.certification} />
              </div>
            </div>
          </div>

          {/* Top Center: Overview & Metadata (col-span-6) */}
          <div className="col-span-12 lg:col-span-6 flex flex-col pt-4">
            <div className="space-y-4">
              <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Overview</h3>
              <p className="text-[12.5px] text-white leading-relaxed font-medium">{series.overview}</p>
            </div>

            <div className="mt-auto space-y-8 pb-2">
              <div className="flex flex-wrap gap-x-12 gap-y-6">
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Released</span>
                  <span className="text-[12.5px] text-white font-medium">{series.year}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Network</span>
                  <span className="text-[12.5px] text-white font-medium">{series.network || 'N/A'}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Rating</span>
                  <span className="text-[12.5px] text-white font-medium">{(series.rating || 0).toFixed(1)} / 10</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Seasons</span>
                  <span className="text-[12.5px] text-white font-medium">{seasons.length}</span>
                </div>
              </div>

              <div className="flex flex-col gap-1 pt-2 border-t border-white/5">
                <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Genres</span>
                <span className="text-[12.5px] text-white font-medium">{series.genres?.join(' / ')}</span>
              </div>
            </div>
          </div>

          {/* Top Right: Logo, Profile (col-span-3) */}
          <div className="col-span-12 lg:col-span-3 flex flex-col items-end text-right">
            {/* Logo at the very top right */}
            <div className="min-h-[140px] flex items-start justify-end w-full mb-auto">
              {series.logo_path ? (
                <img src={series.logo_path} className="max-h-32 object-contain filter drop-shadow-2xl" alt={series.title} />
              ) : (
                <h1 className="font-display text-5xl tracking-tighter text-white uppercase text-right leading-none">{series.title}</h1>
              )}
            </div>

            {/* Quality Profile & Actions */}
            <div className="space-y-8 w-full pb-2">
              <div className="pt-2 border-t border-white/5">
                <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest mb-1">Status</p>
                <p className="text-[12.5px] font-bold text-white uppercase tracking-widest">{series.status}</p>
              </div>
            </div>
          </div>

          {/* Row 2: Cast & Crew (full width) */}
          <div className="col-span-12 space-y-1">
            {series.cast && series.cast.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Cast</h3>
                </div>
                <div className="flex gap-6 overflow-x-auto pb-2 custom-scrollbar snap-x">
                  {series.cast.map(person => (
                    <div key={person.id} className="flex-shrink-0 w-[87px] space-y-4 snap-start">
                      <div className="aspect-square rounded-2xl overflow-hidden border border-white/5 bg-noir-800 shadow-xl">
                        <img src={person.profilePath} className="w-full h-full object-cover" alt={person.name} />
                      </div>
                      <div className="space-y-1 px-1">
                        <p className="text-[9.5px] font-bold text-white truncate uppercase leading-tight">{person.name}</p>
                        <p className="text-[9.5px] text-white/40 truncate leading-tight italic">{person.character}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {series.crew && series.crew.length > 0 && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Crew</h3>
                </div>
                <div className="flex gap-6 overflow-x-auto pb-2 custom-scrollbar snap-x">
                  {[...series.crew].sort((a, b) => {
                    const order: Record<string, number> = { 'Director': 1, 'Screenplay': 2, 'Writer': 3, 'Producer': 4, 'Executive Producer': 5 };
                    return (order[a.job] || 99) - (order[b.job] || 99);
                  }).map(person => (
                    <div key={person.id + person.job} className="flex-shrink-0 w-[87px] space-y-4 snap-start">
                      <div className="aspect-square rounded-2xl overflow-hidden border border-white/5 bg-noir-800 shadow-xl">
                        <img src={person.profilePath} className="w-full h-full object-cover" alt={person.name} />
                      </div>
                      <div className="space-y-1 px-1">
                        <p className="text-[9.5px] font-bold text-white truncate uppercase leading-tight">{person.name}</p>
                        <p className="text-[9.5px] text-white/40 truncate leading-tight italic">{person.job}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Acquisition Console: quality profile + Scan Series */}
          <div className="col-span-12 pt-4">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-6 flex-1">
                <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest whitespace-nowrap">Acquisition Console</h3>
                <div className="h-px flex-1 bg-white/5" />
              </div>
            </div>
            <QualityPolicyPanel
              value={series as any}
              onChange={patch => handleUpdate(patch as Partial<Series>)}
              action={
                <div className="flex items-center gap-2">
                  <button onClick={() => searchingSeries ? stopStreamingSearch() : handleSearchSeries()} disabled={autoSearchingSeries || seriesMode() === 'satisfied'}
                    title={seriesMode() === 'satisfied' ? 'Already at target quality' : (searchingSeries ? 'Click to stop' : undefined)}
                    className="px-5 py-2.5 rounded-xl bg-[#9B59B6]/10 border border-[#9B59B6]/30 text-[#9B59B6] hover:bg-[#9B59B6]/20 transition-all font-bold tracking-widest text-[10px] uppercase disabled:opacity-30 whitespace-nowrap">
                    {scanLabel(searchingSeries, seriesMode(), 'Manual Series Scan', 'Manual Series Upgrade')}
                  </button>
                  <button onClick={() => autoSearchingSeries ? stopAutoScan() : handleAutoSeriesScan()} disabled={searchingSeries || seriesMode() === 'satisfied'}
                    title={seriesMode() === 'satisfied' ? 'Already at target quality' : (autoSearchingSeries ? 'Click to stop' : undefined)}
                    className="px-5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-all font-bold tracking-widest text-[10px] uppercase disabled:opacity-30 whitespace-nowrap">
                    {scanLabel(autoSearchingSeries, seriesMode(), 'Auto Series Scan', 'Auto Series Upgrade')}
                  </button>
                  {autoError['series'] && (
                    <span className="text-[10px] font-bold text-red-400/80 max-w-[240px] truncate" title={autoError['series']}>{autoError['series']}</span>
                  )}
                </div>
              }
            />

            {/* Scan results, shown inline below the console (like films). */}
            {seriesResults !== null && (
              <div className="mt-6">
                {searchingSeries && seriesResults.length === 0 ? (
                  <div className="p-8 text-center">
                    <Spinner className="w-8 h-8 mx-auto mb-3" color="text-white/20" />
                    <p className="text-[9px] font-bold text-white/10 uppercase tracking-[0.3em]">Searching Indexers...</p>
                  </div>
                ) : seriesResults.length > 0 ? (
                  <>
                    {searchingSeries && <p className="text-[9px] font-bold text-white/20 uppercase tracking-[0.3em] mb-3 animate-pulse">Still searching...</p>}
                    <ReleaseList releases={seriesResults as any} onGrab={(r) => handleDownloadSeriesRelease(r as any)} grabbing={grabbing} grabbed={grabbed} accentClass="text-white" />
                  </>
                ) : (
                  <p className="p-8 text-center text-white/20 uppercase text-[10px] tracking-widest font-bold">No releases found</p>
                )}
              </div>
            )}

            {activeTorrents.length > 0 && (
              <div className="mt-8">
                <div className="flex items-center gap-6 mb-4">
                  <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest whitespace-nowrap">Active Acquisitions</h3>
                  <div className="h-px flex-1 bg-white/5" />
                </div>
                <div className="space-y-3">
                  {activeTorrents.map(torrent => {
                    const progress = Math.round((torrent.progress ?? 0) * 100)
                    return (
                      <Link key={torrent.id ?? torrent.infoHash} to="/acquisitions"
                        className="block rounded-2xl bg-noir-900/60 border border-white/5 px-6 py-5 hover:bg-white/[0.03] transition-all">
                        <div className="flex items-center justify-between gap-6 mb-3">
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-white/70 truncate">{torrent.name}</p>
                            <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest mt-1">{torrent.status}</p>
                          </div>
                          <div className="flex items-center gap-4 flex-shrink-0">
                            {(torrent.downloadSpeed ?? 0) > 0 && (
                              <span className="text-[10px] font-mono text-emerald-400">
                                ↓ {formatSize(torrent.downloadSpeed)}/s
                              </span>
                            )}
                            <span className="text-sm font-mono font-bold text-[#9B59B6]">{progress}%</span>
                          </div>
                        </div>
                        <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full bg-[#9B59B6] rounded-full transition-all duration-1000" style={{ width: progress + '%' }} />
                        </div>
                        <div className="flex justify-between mt-2 text-[9px] font-mono text-white/20">
                          <span>{formatSize(torrent.downloadedBytes ?? 0)} of {formatSize(torrent.sizeBytes ?? 0)}</span>
                          <span>View acquisition details</span>
                        </div>
                      </Link>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Seasons & Episodes (full width, under the acquisition console) */}
          <div className="col-span-12 space-y-8 pt-4">
            <div className="flex items-center gap-6 mb-8">
              <h2 className="text-[10.5px] font-bold text-white/40 uppercase tracking-[0.3em] whitespace-nowrap">Seasons & Episodes</h2>
              <div className="h-px w-full bg-white/[0.03]" />
            </div>

            <div className="space-y-3">
              {seasons.map(s => (
                <div key={s.id} className="bg-noir-900/40 border border-white/[0.03] rounded-2xl overflow-hidden transition-all group/season">
                  <button onClick={() => setSelectedSeason(selectedSeason === s.season_number ? null : s.season_number)}
                    className="w-full flex items-center justify-between p-3 hover:bg-white/[0.03] transition-colors text-left relative overflow-hidden">
                    <div className="flex items-center gap-5 relative z-10">
                      <div className="w-10 h-14 rounded-lg overflow-hidden bg-noir-800 flex-shrink-0 border border-white/5 shadow-lg transition-transform">
                        {s.poster_path ? <img src={s.poster_path} className="w-full h-full object-cover" alt="" /> : <div className="w-full h-full flex items-center justify-center text-[10px] opacity-20 text-white uppercase font-mono">S{s.season_number}</div>}
                      </div>
                      <div className="space-y-1">
                        <div className="text-sm font-bold text-white uppercase tracking-wider">{s.title || `Season ${s.season_number}`}</div>
                        <div className="text-[9px] font-bold text-white/20 uppercase tracking-[0.15em]">
                          {s.air_date ? <span>{new Date(s.air_date).getFullYear()} • </span> : null}
                          {s.episode_count} EPISODES
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-6 relative z-10">
                      {/* Show "Acquiring" only while genuinely in flight — not for a
                          completed pack whose season row lingers at progress 1. */}
                      {((s as any).acquiring_episodes > 0 || ((s as any).downloadProgress > 0 && (s as any).downloadProgress < 1)) && (
                        <StatusBadge status="downloading" progress={(s as any).downloadProgress} />
                      )}
                      <div className="flex items-center gap-2">
                        <button onClick={(e) => { e.stopPropagation(); searchingSeason[s.season_number] ? stopStreamingSearch() : handleSearchSeason(s.season_number) }}
                          disabled={autoSearchingSeason[s.season_number] || seasonMode(s.season_number) === 'satisfied'}
                          title={seasonMode(s.season_number) === 'satisfied' ? 'Already at target quality' : (searchingSeason[s.season_number] ? 'Click to stop' : undefined)}
                          className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[9px] font-bold uppercase tracking-widest hover:bg-white/10 transition-all disabled:opacity-30">
                          {scanLabel(searchingSeason[s.season_number], seasonMode(s.season_number), 'Manual Season Scan', 'Manual Season Upgrade')}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); autoSearchingSeason[s.season_number] ? stopAutoScan() : handleAutoSeasonScan(s.season_number) }}
                          disabled={searchingSeason[s.season_number] || seasonMode(s.season_number) === 'satisfied'}
                          title={seasonMode(s.season_number) === 'satisfied' ? 'Already at target quality' : (autoSearchingSeason[s.season_number] ? 'Click to stop' : undefined)}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[9px] font-bold uppercase tracking-widest hover:bg-emerald-500/20 transition-all disabled:opacity-30">
                          {scanLabel(autoSearchingSeason[s.season_number], seasonMode(s.season_number), 'Auto Season Scan', 'Auto Season Upgrade')}
                        </button>
                        {autoError[`season:${s.season_number}`] && (
                          <span className="text-[9px] font-bold text-red-400/80 max-w-[220px] truncate" title={autoError[`season:${s.season_number}`]}>{autoError[`season:${s.season_number}`]}</span>
                        )}
                      </div>
                      <div className="text-right hidden sm:block">
                        <div className="text-[8px] font-bold text-white/10 uppercase tracking-[0.2em]">MONITORED</div>
                        <div className={`text-[9px] font-bold uppercase tracking-widest ${s.monitored ? 'text-emerald-500/60' : 'text-white/10'}`}>{s.monitored ? 'YES' : 'NO'}</div>
                      </div>
                      <span className={`text-white/10 text-lg transition-transform duration-500 ${selectedSeason === s.season_number ? 'rotate-180' : ''}`}>▾</span>
                    </div>
                  </button>

                  {selectedSeason === s.season_number && (
                    <div className="border-t border-white/[0.03] animate-slide-down bg-noir-950/40">
                      {s.overview && (
                        <div className="px-6 py-4 border-b border-white/[0.03] bg-noir-900/20">
                          <h3 className="text-[8px] font-bold text-white/20 uppercase tracking-[0.2em] mb-2">Season Overview</h3>
                          <p className="text-xs text-white/40 leading-relaxed italic">{s.overview}</p>
                        </div>
                      )}
                      <div className="divide-y divide-white/[0.02]">
                        {episodes[s.season_number]?.map(ep => (
                          <div key={ep.id} className="flex items-center gap-6 px-6 py-3.5 group/ep hover:bg-white/[0.01] transition-colors">
                            <span className="text-[10px] font-bold text-white/10 w-8 text-right group-hover/ep:text-white transition-colors">E{ep.episode_number}</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-bold text-white/70 group-hover/ep:text-white transition-colors uppercase tracking-tight">{ep.title}</div>
                              <div className="text-[8px] font-bold text-white/20 uppercase tracking-[0.1em] mt-0.5">{episodeAirLabel(ep)}</div>
                            </div>
                            <div className="flex items-center gap-4">
                              <button onClick={(e) => { e.stopPropagation(); (searchingEpisode && currentSearchEpisode?.id === ep.id) ? stopStreamingSearch() : handleSearchEpisode(ep) }}
                                disabled={autoSearchingEpisodes.has(ep.id) || epMode(ep) === 'satisfied'}
                                title={epMode(ep) === 'satisfied' ? 'Already at target quality' : (searchingEpisode && currentSearchEpisode?.id === ep.id ? 'Click to stop' : epMode(ep) === 'upgrade' ? 'Manual upgrade scan' : 'Manual episode scan')}
                                className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-[9px] font-bold uppercase tracking-widest text-white/50 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30">
                                {scanLabel(searchingEpisode && currentSearchEpisode?.id === ep.id, epMode(ep), 'Manual Scan', 'Manual Upgrade')}
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); autoSearchingEpisodes.has(ep.id) ? stopAutoScan() : handleAutoEpisodeScan(ep) }}
                                disabled={(searchingEpisode && currentSearchEpisode?.id === ep.id) || epMode(ep) === 'satisfied'}
                                title={epMode(ep) === 'satisfied' ? 'Already at target quality' : (autoSearchingEpisodes.has(ep.id) ? 'Click to stop' : epMode(ep) === 'upgrade' ? 'Automatic upgrade scan' : 'Automatic episode scan')}
                                className="px-3 py-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 text-[9px] font-bold uppercase tracking-widest hover:bg-emerald-500/20 transition-all disabled:opacity-30">
                                {scanLabel(autoSearchingEpisodes.has(ep.id), epMode(ep), 'Automatic Scan', 'Automatic Upgrade')}
                              </button>
                              {autoError[`ep:${ep.id}`] && (
                                <span className="text-[9px] font-bold text-red-400/80 max-w-[220px] truncate" title={autoError[`ep:${ep.id}`]}>{autoError[`ep:${ep.id}`]}</span>
                              )}
                              {ep.file_path && (
                                <button onClick={(e) => { e.stopPropagation(); setEditingFilePath(ep.file_path!) }}
                                  title="Edit chapters and audio/subtitle track titles inside the file"
                                  className="w-8 h-8 rounded flex items-center justify-center text-xs text-white/20 hover:text-white hover:bg-white/5 transition-all">
                                  ✎
                                </button>
                              )}
                              {ep.quality && <span className="text-[8px] font-bold text-white/10 border border-white/5 px-1.5 py-0.5 rounded uppercase">{ep.quality}</span>}
                              <StatusBadge status={ep.status} progress={ep.downloadProgress} />
                            </div>
                          </div>
                        )) || (
                          <div className="p-12 text-center">
                            <Spinner className="w-8 h-8 mx-auto mb-3" color="text-white/20" />
                            <p className="text-[9px] font-bold text-white/10 uppercase tracking-[0.3em]">Syncing Episodes...</p>
                          </div>
                        )}
                      </div>

                      {releases[s.season_number] && releases[s.season_number].length > 0 && (
                        <div className="p-6 border-t border-white/[0.03] bg-noir-900/40">
                          <div className="flex items-center gap-4 mb-6">
                            <h3 className="text-[9px] font-bold text-white/40 uppercase tracking-[0.3em] whitespace-nowrap">Season Releases</h3>
                            <div className="h-px w-full bg-white/[0.03]" />
                            <button onClick={() => setReleases(prev => ({ ...prev, [s.season_number]: [] }))} className="text-[9px] font-bold text-white/20 hover:text-white transition-all uppercase tracking-widest">Clear</button>
                          </div>
                          <ReleaseList 
                            releases={releases[s.season_number] as any} 
                            onGrab={(r) => handleDownloadRelease(r as any, s.season_number)} 
                            grabbing={grabbing} 
                            grabbed={grabbed}
                            accentClass="text-white"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          </div>

          <ItemActionsBar
            accent="#9B59B6"
            extra={
              <button
                onClick={async () => {
                  try {
                    const r = await seriesApi.refreshOne(series.id)
                    alert(`${r.message}\n\nMetadata, seasons and episodes are re-pulled; missing entries are added. Files on disk are never touched. The page updates as data lands.`)
                  } catch (err) { alert(String(err)) }
                }}
                className="px-8 py-3 rounded-2xl bg-white/5 border border-white/10 text-white/60 hover:text-white transition-all font-bold tracking-widest text-[10px] uppercase shadow-xl">
                Refresh Info
              </button>
            }
            reacquire={{
              mode: 'select',
              title: 'Select seasons to reacquire',
              items: seasons.map(s => ({ id: s.id, label: s.title || `Season ${s.season_number}`, sublabel: `${s.episode_count} episodes` })),
              runSelected: async (ids) => { for (const sid of ids) await seriesApi.seasons.repair(sid, {}); fetchSeries(false) },
            }}
            loadHistory={() => seriesApi.acquisitionHistory(series.id)}
            onRemove={async () => { if (confirm('Remove this series from the library? Files on disk are kept.')) { await seriesApi.delete(series.id, false); onDelete(series.id); navigate('/series') } }}
            onDelete={async () => { if (confirm('Delete this series AND all its files from disk? This permanently removes the folder and cannot be undone.')) { await seriesApi.delete(series.id, true); onDelete(series.id); navigate('/series') } }}
            onEdit={() => setShowMetadataModal(true)}
          />

          </div>

          {showMetadataModal && (
        <MetadataEditorModal
          title={series.title}
          initial={series as any}
          fields={[
            { key: 'title', label: 'Title' },
            { key: 'network', label: 'Network' },
            { key: 'year', label: 'Year', type: 'number' },
            { key: 'runtime', label: 'Runtime (mins)', type: 'number' },
            { key: 'certification', label: 'Certification' },
            { key: 'rating', label: 'Rating', type: 'float' },
            { key: 'country', label: 'Country (ISO Code)' },
            { key: 'genres', label: 'Genres (comma separated)', type: 'csv' },
            { key: 'overview', label: 'Overview', type: 'textarea' },
          ]}
          onSave={async data => { await seriesApi.updateMetadata(series.id, data) }}
          images={{
            types: ['poster', 'backdrop', 'logo', 'banner'],
            search: type => seriesApi.searchImages(series.id, type),
            save: (type, url) => seriesApi.saveImage(series.id, type, url),
          }}
          onClose={() => { setShowMetadataModal(false); fetchSeries(false) }}
        />
      )}

          {editingFilePath && (
        <FileMetadataEditorModal
          filePath={editingFilePath}
          onClose={() => setEditingFilePath(null)}
          onSaved={() => { if (selectedSeason !== null) loadEpisodes(selectedSeason, false) }}
        />
      )}

          {currentSearchEpisode && (
        <Modal
          onClose={() => { stopStreamingSearch(); setCurrentSearchEpisode(null) }}
          title={`RELEASES: ${currentSearchEpisode.title || `Episode ${currentSearchEpisode.episode_number}`}`}
        >
          {searchingEpisode ? (
            <div className="p-12 text-center">
              <Spinner className="w-8 h-8 mx-auto mb-3" color="text-white/20" />
              <p className="text-[9px] font-bold text-white/10 uppercase tracking-[0.3em]">Searching Indexers...</p>
            </div>
          ) : (episodeResults && episodeResults.length > 0) ? (
            <div className="p-4 max-h-[60vh] overflow-y-auto">
              <ReleaseList 
                releases={episodeResults as any} 
                onGrab={(r) => handleDownloadRelease(r as any, currentSearchEpisode.season_number, currentSearchEpisode.id)} 
                grabbing={grabbing} 
                grabbed={grabbed}
                accentClass="text-white"
              />
            </div>
          ) : (
            <div className="p-12 text-center text-white/20 uppercase text-[10px] tracking-widest font-bold">
              No releases found
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type SeriesCollectionFilter = 'all' | 'missing' | 'collected' | 'acquiring'
type SeriesAiringFilter = 'all' | 'continuing' | 'upcoming' | 'ended'

export function SeriesLibrary() {
  const [series, setSeries] = useState<Series[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [collectionFilter, setCollectionFilter] = useState<SeriesCollectionFilter>('all')
  const [airingFilter, setAiringFilter] = useState<SeriesAiringFilter>('all')
  const [lastRedirect, setLastRedirect] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()

  const { activeTabId, tabs, getActiveTabForMedia, setActiveTabForMedia } = useTabs()

  // On mount / when tabs load, ensure the active tab is a series tab
  useEffect(() => {
    if (!tabs.length) return
    const seriesTab = getActiveTabForMedia('series')
    if (seriesTab && seriesTab.id !== activeTabId) {
      setActiveTabForMedia('series', seriesTab.id)
    }
  }, [tabs])

  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId])
  const activeName = activeTab ? activeTab.name.replace(/Films|Series|Music|Books|Comics|Games/i, '').trim() : ''

  const refresh = (showLoading = true) => {
    if (showLoading) setLoading(true)
    seriesApi.list()
      .then(data => {
        const list = (Array.isArray(data) ? data : []).map(s => ({
          ...s,
          tmdbId: s.tmdbId ?? s.tmdb_id
        }))
        setSeries(list)
      })
      .catch(err => {
        console.error('Failed to load series:', err)
        setSeries([])
      })
      .finally(() => { if (showLoading) setLoading(false) })
  }

  useEffect(() => {
    if (!activeTabId) { setSeries([]); setLoading(false); return }
    // Don't fetch until the active tab is actually a series tab
    const current = tabs.find(t => t.id === activeTabId)
    if (current && current.media_type !== 'series') return
    setSeries([])
    refresh(true)
    const interval = setInterval(() => refresh(false), 5000)
    return () => clearInterval(interval)
  }, [activeTabId, tabs])

  const filtered = (Array.isArray(series) ? series : []).filter(s => {
    const title = s.title || ''
    if (search && !title.toLowerCase().includes(search.toLowerCase())) return false

    // Collection filtering
    const isAcquiring = s.stats?.acquiring && s.stats.acquiring > 0
    const isCollected = s.stats?.downloaded && s.stats.total > 0 && s.stats.downloaded === s.stats.total
    const isMissing = !isCollected && !isAcquiring

    if (collectionFilter === 'missing' && !isMissing) return false
    if (collectionFilter === 'collected' && !isCollected) return false
    if (collectionFilter === 'acquiring' && !isAcquiring) return false

    // Airing filtering
    if (airingFilter !== 'all' && s.status !== airingFilter) return false

    return true
  })

  // Auto-redirect to Add page if no local matches
  useEffect(() => {
    const cooldown = Date.now() - lastRedirect
    if (!loading && search.trim().length > 2 && filtered.length === 0 && !location.pathname.endsWith('/add') && cooldown > 5000) {
      const timer = setTimeout(() => {
        setLastRedirect(Date.now())
        const term = search
        setSearch('') // Clear search
        navigate(`add?q=${encodeURIComponent(term)}`)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [search, filtered.length, loading, navigate, location.pathname, lastRedirect])

  return (
    <>
      <div className="mb-8 flex justify-between items-end">
        <div>
          <h1 className="font-display text-5xl tracking-widest text-[#9B59B6]">
            SERIES{activeName && activeName.toLowerCase() !== 'main' ? <span className="text-white/20 ml-4">({activeName.toUpperCase()})</span> : ''}
          </h1>
          <p className="text-[#9B59B6] text-[12.5px] mt-1 font-mono uppercase tracking-widest">
            <span className="text-white">{series.length}</span> {series.length === 1 ? 'show' : 'shows'} in library
            {series.length > 0 && (() => {
              const collected = series.filter(s => s.stats?.downloaded && s.stats.total > 0 && s.stats.downloaded === s.stats.total).length
              const acquiring = series.filter(s => s.stats?.acquiring && s.stats.acquiring > 0).length
              const missing = series.length - collected - acquiring
              return <> | <span className="text-white">{collected}</span> {collected === 1 ? 'show' : 'shows'} Collected | <span className="text-white">{missing}</span> {missing === 1 ? 'show' : 'shows'} Missing{acquiring > 0 ? <> | <span className="text-white">{acquiring}</span> {acquiring === 1 ? 'show' : 'shows'} Acquiring</> : ''}</>
            })()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {!editMode && (
            <button onClick={() => setEditMode(true)}
              className="px-6 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold tracking-widest hover:bg-white/10 transition-all uppercase">
              Edit Series
            </button>
          )}
          <Link to="add" className="px-6 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold tracking-widest hover:bg-white/10 transition-all uppercase">
            Add Series
          </Link>
        </div>
      </div>

      <div className="flex flex-col gap-4 mb-8">
        <div className="flex flex-col md:flex-row gap-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search library..." className="max-w-sm flex-1" />
          <CollectionFilterBar value={collectionFilter} onChange={setCollectionFilter} accentColor="[#9B59B6]" />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] ml-1">Airing Status</span>
          <CollectionFilterBar
            value={airingFilter}
            onChange={setAiringFilter}
            filters={['all', 'continuing', 'upcoming', 'ended']}
            accentColor="[#9B59B6]"
          />
        </div>
        {editMode && (
          <SelectionBar
            totalCount={filtered.length}
            selectedCount={selected.size}
            onSelectAll={() => setSelected(new Set(filtered.map(s => s.id)))}
            onSelectNone={() => setSelected(new Set())}
            deleting={deleting}
            onDone={() => { setEditMode(false); setSelected(new Set()) }}
            onDelete={async () => {
              if (!confirm(`Delete ${selected.size} series and all associated files?`)) return
              setDeleting(true)
              try {
                await Promise.all([...selected].map(id => seriesApi.delete(id)))
                setSeries(prev => prev.filter(s => !selected.has(s.id)))
                setSelected(new Set())
              } catch (err) { alert(String(err)) }
              finally { setDeleting(false) }
            }}
          />
        )}
      </div>

      {loading && series.length === 0 ? <PosterSkeleton /> : filtered.length === 0 ? (
        <EmptyState icon="📺" title="NO SERIES FOUND" subtitle={search ? `No matches for "${search}"` : "Your library is empty"} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((s, i) => (
            <div key={s.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i * 30, 400)}ms`, animationFillMode: 'both' }}>
              <LibraryCard
                onClick={() => navigate(`/series/${s.id}`)}
                image={s.poster_path}
                title={`${s.title || 'Unknown'}${s.year ? ` (${s.year})` : ''}`}
                subtitle={`${s.stats?.downloaded || 0}/${s.stats?.total || 0} EPISODES`}
                status={s.stats?.total && s.stats.downloaded === s.stats.total ? 'collected' : (s.stats?.acquiring ? 'acquiring' : 'missing')}
                badge={(s as any).loudnessMeasured
                  ? <span title="Loudness normalized" className="px-1 py-0.5 rounded bg-black/60 backdrop-blur-sm text-[10px] leading-none opacity-80">📶</span>
                  : undefined}
                accentColor="#9B59B6"
                fallbackIcon="📺"
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

    </>
  )
}

export function SeriesPage() {
  return (
    <Routes>
      <Route index element={<SeriesLibrary />} />
      <Route path="add" element={<AddSeriesSection />} />
      <Route path=":id" element={<SeriesDetailPage onDelete={() => {}} />} />
    </Routes>
  )
}

function SeriesSearchDetail({ series, onClose, onAdd, isAdded }: { series: any; onClose: () => void; onAdd: () => void; isAdded: boolean }) {
  const [preview, setPreview] = useState<{ seasonCount?: number; episodeCount?: number; firstAired?: string; lastAired?: string; status?: string } | null>(null)

  useEffect(() => {
    let alive = true
    seriesApi.preview({ tvdbId: series.tvdbId, tmdbId: series.tmdbId })
      .then(p => { if (alive) setPreview(p) })
      .catch(() => {})
    return () => { alive = false }
  }, [series])

  const fmt = (d?: string) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : undefined
  const ended = (preview?.status ?? series.status) === 'ended'

  return (
    <SearchDetailModal
      onClose={onClose}
      onAdd={onAdd}
      isAdded={isAdded}
      accentColor="#9B59B6"
      fallbackIcon="📺"
      image={tmdbImage(series.posterPath)}
      backdrop={tmdbImage(series.backdropPath, 'w1280')}
      title={series.title || 'Unknown'}
      year={series.year}
      rating={series.rating}
      genres={series.genres || []}
      overview={series.overview}
      facts={[
        { label: 'Network', value: series.network },
        { label: 'Certification', value: series.certification },
        { label: 'Country', value: series.country },
        { label: 'Seasons', value: preview?.seasonCount },
        { label: 'Episodes', value: preview?.episodeCount },
        { label: 'Premiered', value: fmt(preview?.firstAired) },
        { label: 'Finale', value: ended ? fmt(preview?.lastAired) : undefined },
      ]}
    />
  )
}

function AddSeriesSection() {
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [results, setResults] = useState<SeriesSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [detailSeries, setDetailSeries] = useState<SeriesSearchResult | null>(null)
  const [addingSeries, setAddingSeries] = useState<SeriesSearchResult | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const timer = useRef<any>()
  const navigate = useNavigate()

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setSearching(true)
      try { 
        const data = await seriesApi.lookup(query)
        setResults(Array.isArray(data) ? data : [])
      }
      catch (err) { console.error(err) }
      finally { setSearching(false) }
    }, 500)
    return () => clearTimeout(timer.current)
  }, [query])

  const handleAdd = (series: SeriesSearchResult) => setAddingSeries(series)

  const handleConfirmAdd = async (preferences: AcquisitionPreferences) => {
    if (!addingSeries) return
    const key = String(addingSeries.tvdbId ?? addingSeries.tmdbId)
    setIsAdding(true)
    setAdded(prev => new Set(prev).add(key))
    try {
      await requestWithTab(preferences.tabId, '/series', {
        method: 'POST',
        body: JSON.stringify({
          tvdbId: addingSeries.tvdbId,
          tmdbId: addingSeries.tmdbId,
          target_tier: preferences.tier,
          target_resolution: preferences.resolution,
          target_source: preferences.source,
          target_codec: preferences.codec,
        }),
      })
      setAddingSeries(null)
      setDetailSeries(null)
    } catch (err) {
      alert(String(err))
      setAdded(prev => { const next = new Set(prev); next.delete(key); return next })
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-8 flex items-center gap-4">
        <button onClick={() => navigate('/series')} className="text-white/30 hover:text-white transition-all text-sm font-mono uppercase tracking-widest">← Back</button>
        <div className="h-4 w-px bg-white/10" />
        <h1 className="font-display text-3xl tracking-widest text-[#9B59B6]">ADD SERIES</h1>
      </div>

      <div className="max-w-xl mb-12">
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} 
          placeholder="Search metadata for a series..." autoFocus
          className="w-full px-4 py-3 rounded-xl bg-noir-800 border border-white/10 text-white focus:outline-none focus:border-[#9B59B6]/40 transition-all shadow-lg" />
      </div>

      {searching ? <PosterSkeleton /> : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {(Array.isArray(results) ? results : []).map((s, i) => {
            const isAdded = added.has(String(s.tvdbId)) || added.has(String(s.tmdbId)) || s.alreadyAdded
            return (
              <div key={s.tvdbId || s.tmdbId} className="animate-slide-up" style={{ animationDelay: `${Math.min(i * 30, 400)}ms`, animationFillMode: 'both' }}>
                <LibraryCard
                  onClick={() => setDetailSeries(s)}
                  image={tmdbImage(s.posterPath)}
                  title={`${s.title || 'Unknown'}${s.year ? ` (${s.year})` : ''}`}
                  subtitle={s.year || 'TBA'}
                  accentColor="#9B59B6"
                  fallbackIcon="📺"
                  badge={
                    <button onClick={e => { e.stopPropagation(); !isAdded && handleAdd(s) }} disabled={isAdded}
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
        <SeriesSearchDetail
          series={detailSeries}
          onClose={() => setDetailSeries(null)}
          onAdd={() => handleAdd(detailSeries)}
          isAdded={added.has(String(detailSeries.tvdbId)) || added.has(String(detailSeries.tmdbId)) || (detailSeries as any).alreadyAdded}
        />
      )}

      {addingSeries && (
        <AcquisitionAddModal
          title={addingSeries.title}
          mediaType="series"
          accentColor="#9B59B6"
          onClose={() => setAddingSeries(null)}
          onConfirm={handleConfirmAdd}
          isAdding={isAdding}
        />
      )}
    </div>
  )
}

export function AddSeriesPage() { return <AddSeriesSection /> }
export function CalendarPage() { return <AddSeriesSection /> }
