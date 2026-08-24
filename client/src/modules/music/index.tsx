import { useState, useEffect, useRef, useMemo } from 'react'
import { toast, confirmDialog } from '../../lib/notify.js'
import { Routes, Route, useNavigate, useSearchParams, useLocation, useParams } from 'react-router-dom'
import { musicApi, type Artist, type Album, type AlbumRelease, type ReleaseCandidate, type Track, type MusicRelease } from '../../lib/music.api.js'
import { tmdbImage, formatDuration, isAbortError } from '../../lib/api.js'
import { useAbortController } from '../../lib/useAbortable.js'
import { SearchInput, PosterSkeleton, EmptyState, StatusBadge, LibraryCard, SelectionBar, Modal, Spinner, ReleaseList } from '../../components/ui.js'
import { PageHeader, mediaSectionTabs } from '../../components/PageHeader.js'
import { MusicQualityPanel } from '../../components/MusicQualityPanel.js'
import { LibraryStatusDropdown } from '../../components/LibraryStatusDropdown.js'
import { MetadataEditorModal } from '../../components/MetadataEditorModal.js'
import { SearchDetailModal } from '../../components/SearchDetailModal.js'
import { ItemActionsBar } from '../../components/ItemActions.js'
import { useTabs } from '../../lib/tab-context.js'
import { subscribeActivity } from '../../lib/useLiveRefresh.js'
import { Icon as PackIcon, Level } from '@archivist/design-system'
import type { ArtistRatingTree, RatingSubjectType, ResolvedRating } from '@archivist/contracts'
import { ratingsApi } from '../../lib/ratings.api.js'

/**
 * Album status is written by two vocabularies: the public API uses
 * downloading/downloaded, storage and the import pipeline use
 * acquiring/collected. New writes are normalised server-side, but rows predating
 * that carry either spelling, so reads accept both.
 */
function isCollectedAlbum(album: Album): boolean {
  return album.status === 'collected' || album.status === 'downloaded'
}

function isAcquiringAlbum(album: Album): boolean {
  return album.status === 'acquiring' || album.status === 'downloading'
}

function discographySearchTerms(artistName: string): string[] {
  return [`${artistName} discography`]
}

/** Human-readable torrent phase; acquisition state alone cannot distinguish a
 * healthy accepted magnet from one that is still waiting for its file list. */
function torrentPhase(status?: string | null): string {
  switch (status) {
    case 'fetching-metadata':
      return 'Fetching torrent metadata'
    case 'checking':
      return 'Verifying files'
    case 'queued':
      return 'Queued in torrent engine'
    case 'downloading':
      return 'Downloading'
    case 'seeding':
    case 'queued-seed':
      return 'Download complete'
    case 'error':
      return 'Torrent error'
    default:
      return 'Submitted to torrent engine'
  }
}

/**
 * MusicBrainz returns genre tags lowercased ("alternative rock", "hip hop").
 * Title-casing is presentation only — the tag itself stays untouched so library
 * search still matches what is stored.
 */
function titleCase(value: string): string {
  return value.replace(/\S+/g, word => word[0]!.toUpperCase() + word.slice(1))
}

/** MusicBrainz does not expose one universal "edition name" field. Prefer its
 * release disambiguation, then a meaningful release-title qualifier, and keep
 * dates as supporting metadata rather than presenting a year as the name. */
function albumReleaseName(release: AlbumRelease, album: Pick<Album, 'title' | 'year'>): string {
  const disambiguation = release.disambiguation?.trim()
  if (disambiguation) return titleCase(disambiguation)

  const releaseTitle = release.title.trim()
  const albumTitle = album.title.trim()
  if (releaseTitle && releaseTitle.localeCompare(albumTitle, undefined, { sensitivity: 'base' }) !== 0) {
    if (releaseTitle.toLocaleLowerCase().startsWith(albumTitle.toLocaleLowerCase())) {
      const qualifier = releaseTitle
        .slice(albumTitle.length)
        .replace(/^[\s:;,.\-–—()[\]]+|[()[\]]+$/g, '')
        .trim()
      if (qualifier) return titleCase(qualifier)
    }
    return releaseTitle
  }

  const format = release.mediaFormats.find(value => value.trim())?.trim()
  const releaseYear = Number.parseInt(release.date?.slice(0, 4) ?? '', 10)
  if (release.status === 'Official' && album.year && releaseYear === album.year) return 'Original Release'
  if (format) return `${format} Release`
  return release.status ? `${release.status} Release` : 'Standard Release'
}

function albumReleaseMatches(release: AlbumRelease, album: Pick<Album, 'title' | 'year'>, query: string): boolean {
  const key = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/\p{Mark}/gu, '')
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  const terms = key(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const searchable = key(
    [
      albumReleaseName(release, album),
      release.title,
      release.date,
      release.country,
      release.status,
      release.disambiguation,
      release.packaging,
      release.barcode,
      release.label,
      ...release.mediaFormats,
    ]
      .filter(Boolean)
      .join(' '),
  )
  return terms.every(term => searchable.includes(term))
}

/** `album_types` arrives as a JSON string from SQLite, or already parsed. */
function parseAlbumTypes(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ── Artist Detail Page ───────────────────────────────────────────────────────

function ArtistDetailPage({ onDelete }: { onDelete: (id: number) => void }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [artist, setArtist] = useState<(Artist & { albums: Album[] }) | null>(null)
  const [expandedAlbum, setExpandedAlbum] = useState<number | null>(null)
  const [tracks, setTracks] = useState<Record<number, Track[]>>({})
  const [showMetadataModal, setShowMetadataModal] = useState(false)
  const [monitorBusy, setMonitorBusy] = useState<Set<string>>(new Set())
  const [grabbing, setGrabbing] = useState<Set<number>>(new Set())
  const [showTypes, setShowTypes] = useState(false)
  const [refreshingTypes, setRefreshingTypes] = useState(false)
  const [scanning, setScanning] = useState<Record<number, 'quick' | 'deep' | null>>({})
  const [albumReleases, setAlbumReleases] = useState<Record<number, MusicRelease[]>>({})
  const [albumEditions, setAlbumEditions] = useState<Record<number, AlbumRelease[]>>({})
  const [editionLoading, setEditionLoading] = useState<Set<number>>(new Set())
  const [editionSaving, setEditionSaving] = useState<Set<number>>(new Set())
  const [releaseFilter, setReleaseFilter] = useState('')
  const [grabbingRelease, setGrabbingRelease] = useState<string | null>(null)
  const [discoScanning, setDiscoScanning] = useState(false)
  const [discoReleases, setDiscoReleases] = useState<MusicRelease[] | null>(null)
  const [grabbedReleases, setGrabbedReleases] = useState<Set<string>>(new Set())
  const [ratingTree, setRatingTree] = useState<ArtistRatingTree | null>(null)
  const [editingAlbum, setEditingAlbum] = useState<Album | null>(null)
  const [editingLyrics, setEditingLyrics] = useState<{ album: Album; track: Track } | null>(null)
  const [grabAll, setGrabAll] = useState<{ done: number; total: number; title: string } | null>(null)
  const grabAllCancelled = useRef(false)
  const albumSearchControllers = useRef(new Map<number, AbortController>())
  const discographySearchController = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      for (const controller of albumSearchControllers.current.values()) controller.abort()
      albumSearchControllers.current.clear()
      discographySearchController.current?.abort()
    },
    [],
  )

  const beginDiscographySearch = (): AbortSignal => {
    discographySearchController.current?.abort()
    const controller = new AbortController()
    discographySearchController.current = controller
    return controller.signal
  }

  const beginAlbumSearch = (albumId: number): AbortSignal => {
    albumSearchControllers.current.get(albumId)?.abort()
    const controller = new AbortController()
    albumSearchControllers.current.set(albumId, controller)
    return controller.signal
  }

  const loadData = async (showLoading = true) => {
    if (!id) return
    if (showLoading) setLoading(true)
    try {
      const data = await musicApi.artists.get(parseInt(id))
      setArtist(data)
    } catch (err) {
      console.error(err)
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  useEffect(() => {
    loadData(true)
    return subscribeActivity(() => loadData(false), 5000)
  }, [id])

  useEffect(() => {
    const artistId = Number(id)
    if (!Number.isInteger(artistId) || artistId <= 0) return
    const signal = beginDiscographySearch()
    const apply = (search: Awaited<ReturnType<typeof musicApi.artists.latestDiscographySearch>>) => {
      if (!search) return
      const active = search.status === 'queued' || search.status === 'running'
      setDiscoScanning(active && search.mode !== 'auto')
      if (search.mode !== 'auto') setDiscoReleases(search.results)
      if (active && search.mode === 'auto') setGrabbingRelease((search.options.selectedRelease as MusicRelease | undefined)?.guid ?? 'discography')
    }
    void (async () => {
      try {
        const search = await musicApi.artists.latestDiscographySearch(artistId, signal)
        apply(search)
        if (search && (search.status === 'queued' || search.status === 'running')) {
          await musicApi.artists.watchDiscographySearch(search, apply, signal)
          await loadData(false)
        }
      } catch (err) {
        if (!isAbortError(err)) console.error('Could not restore discography search:', err)
      } finally {
        if (!signal.aborted) {
          setDiscoScanning(false)
          setGrabbingRelease(null)
        }
      }
    })()
    return () => {
      if (discographySearchController.current?.signal === signal) {
        discographySearchController.current.abort()
        discographySearchController.current = null
      }
    }
  }, [id])

  // Expanding an album restores its retained results and resumes polling any
  // worker-owned search. Leaving the page aborts only this browser polling; the
  // durable item-search job continues in the search lane.
  useEffect(() => {
    if (!expandedAlbum) return
    const albumId = expandedAlbum
    const signal = beginAlbumSearch(albumId)
    const apply = (search: Awaited<ReturnType<typeof musicApi.albums.latestSearch>>) => {
      if (!search) return
      if (search.mode !== 'auto') setAlbumReleases(previous => ({ ...previous, [albumId]: search.results }))
      const active = search.status === 'queued' || search.status === 'running'
      setScanning(previous => ({
        ...previous,
        [albumId]: active && (search.mode === 'quick' || search.mode === 'deep') ? search.mode : null,
      }))
      setGrabbing(previous => {
        const next = new Set(previous)
        if (active && search.mode === 'auto') next.add(albumId)
        else next.delete(albumId)
        return next
      })
    }
    const restore = async () => {
      try {
        const search = await musicApi.albums.latestSearch(albumId, signal)
        apply(search)
        if (search && (search.status === 'queued' || search.status === 'running')) {
          await musicApi.albums.watchSearch(search, apply, signal)
          if (search.mode === 'auto') await loadData(false)
        }
      } catch (err) {
        if (!isAbortError(err)) console.error(`Could not restore album ${albumId} search:`, err)
      } finally {
        if (!signal.aborted && albumSearchControllers.current.get(albumId)?.signal === signal) {
          albumSearchControllers.current.delete(albumId)
          setScanning(previous => ({ ...previous, [albumId]: null }))
          setGrabbing(previous => {
            const next = new Set(previous)
            next.delete(albumId)
            return next
          })
        }
      }
    }
    void restore()
    return () => {
      const controller = albumSearchControllers.current.get(albumId)
      if (controller?.signal === signal) {
        controller.abort()
        albumSearchControllers.current.delete(albumId)
      }
    }
  }, [expandedAlbum])

  // Ratings mirror the series tree exactly: artist ⇢ album ⇢ track, with a
  // track inheriting its album's score and an album inheriting the artist's.
  const loadRatingTree = () =>
    id
      ? ratingsApi
          .artistTree(Number(id))
          .then(setRatingTree)
          .catch(() => {})
      : Promise.resolve()
  useEffect(() => {
    void loadRatingTree()
  }, [id])

  const commitRating = async (type: RatingSubjectType, subjectId: number, value: number | null) => {
    if (value == null) await ratingsApi.clear(type, subjectId)
    else await ratingsApi.set(type, subjectId, value)
    await loadRatingTree()
  }

  const ratingFor = (type: RatingSubjectType, subjectId: number): ResolvedRating => {
    const empty: ResolvedRating = { value: null, source: 'none', inheritedFrom: null, scaleMax: 5 }
    if (type === 'artist') return ratingTree?.artist.rating ?? empty
    if (type === 'album') return ratingTree?.albums.find(entry => entry.album.subject.id === subjectId)?.album.rating ?? empty
    return ratingTree?.albums.flatMap(entry => entry.tracks).find(entry => entry.subject.id === subjectId)?.rating ?? empty
  }

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

  const loadAlbumEditions = async (albumId: number, refresh = false) => {
    if (!refresh && albumEditions[albumId]) return
    setEditionLoading(previous => new Set(previous).add(albumId))
    try {
      const result = await musicApi.albums.releases(albumId, refresh)
      setAlbumEditions(previous => ({ ...previous, [albumId]: result.releases }))
      const selected = result.releases.find(release => release.selected) ?? null
      setArtist(previous =>
        previous
          ? {
              ...previous,
              albums: previous.albums.map(album => (album.id === albumId ? { ...album, selected_release: selected } : album)),
            }
          : previous,
      )
      setEditingAlbum(previous =>
        previous?.id === albumId
          ? { ...previous, musicbrainz_release_id: selected?.id ?? previous.musicbrainz_release_id, selected_release: selected }
          : previous,
      )
    } catch (err) {
      toast.error(`Could not load album releases: ${String(err)}`)
    } finally {
      setEditionLoading(previous => {
        const next = new Set(previous)
        next.delete(albumId)
        return next
      })
    }
  }

  const chooseAlbumEdition = async (album: Album, releaseId: string) => {
    setEditionSaving(previous => new Set(previous).add(album.id))
    try {
      const result = await musicApi.albums.selectRelease(album.id, releaseId)
      setArtist(previous =>
        previous
          ? {
              ...previous,
              albums: previous.albums.map(item => (item.id === album.id ? { ...item, ...result.album } : item)),
            }
          : previous,
      )
      if (result.album.tracks) setTracks(previous => ({ ...previous, [album.id]: result.album.tracks! }))
      setEditingAlbum(previous => (previous?.id === album.id ? { ...previous, ...result.album } : previous))
      setAlbumEditions(previous => ({
        ...previous,
        [album.id]: (previous[album.id] ?? []).map(release => ({ ...release, selected: release.id === releaseId })),
      }))
      toast.success(`Selected ${albumReleaseName(result.release, album)}`)
    } catch (err) {
      toast.error(String(err))
    } finally {
      setEditionSaving(previous => {
        const next = new Set(previous)
        next.delete(album.id)
        return next
      })
    }
  }

  const editionLabel = (release: AlbumRelease, album: Pick<Album, 'title' | 'year'>): string =>
    [
      albumReleaseName(release, album),
      release.date || 'Unknown date',
      release.country,
      release.mediaFormats.join(' / ') || null,
      release.discCount ? `${release.discCount} disc${release.discCount === 1 ? '' : 's'}` : null,
      release.trackCount ? `${release.trackCount} tracks` : null,
    ]
      .filter(Boolean)
      .join(' · ')

  /**
   * The quality profile is artist-wide. It saves on the artist and the server
   * mirrors it to every album, so the local album rows are updated too rather
   * than waiting for a reload to look right.
   */
  const updateArtistPolicy = async (patch: Record<string, unknown>) => {
    if (!artist) return
    const previous = artist
    setArtist(current => (current ? ({ ...current, ...patch, albums: current.albums.map(a => ({ ...a, ...patch })) } as typeof current) : current))
    try {
      await musicApi.artists.update(artist.id, patch as never)
    } catch (err) {
      setArtist(previous)
      toast.error(String(err))
    }
  }

  // Optimistic like the series toggles: the pill flips at once and rolls back
  // if the write fails, so automation state never looks ahead of the server.
  const toggleArtistMonitoring = async () => {
    if (!artist) return
    const previous = artist.monitored
    const monitored = !previous
    setMonitorBusy(prev => new Set([...prev, `artist:${artist.id}`]))
    setArtist(current => (current ? { ...current, monitored, albums: current.albums.map(a => ({ ...a, monitored })) } : current))
    try {
      await musicApi.artists.update(artist.id, { monitored })
    } catch (err) {
      setArtist(current => (current ? { ...current, monitored: previous } : current))
      toast.error(String(err))
      await loadData(false)
    } finally {
      setMonitorBusy(prev => {
        const next = new Set(prev)
        next.delete(`artist:${artist.id}`)
        return next
      })
    }
  }

  const removeAlbum = async (album: Album) => {
    const collected = album.status === 'collected' || album.status === 'downloaded'
    const confirmed = await confirmDialog({
      title: `Remove "${album.title}" from the library?`,
      message: collected
        ? 'Files already on disk are kept. Re-apply the release types from the artist\u2019s Releases dialog to bring the album back.'
        : 'Re-apply the release types from the artist\u2019s Releases dialog to bring it back.',
      confirmLabel: 'Remove',
    })
    if (!confirmed) return

    const previousAlbums = artist?.albums ?? []
    setArtist(prev => (prev ? { ...prev, albums: prev.albums.filter(a => a.id !== album.id) } : prev))
    try {
      await musicApi.albums.delete(album.id, false)
      toast.success(`Removed "${album.title}"`)
    } catch (err) {
      // Put it back where it was rather than leaving the list lying about state.
      setArtist(prev => (prev ? { ...prev, albums: previousAlbums } : prev))
      toast.error(String(err))
    }
  }

  const toggleAlbumMonitoring = async (album: Album) => {
    const monitored = !album.monitored
    setMonitorBusy(prev => new Set([...prev, `album:${album.id}`]))
    setArtist(prev => (prev ? { ...prev, albums: prev.albums.map(a => (a.id === album.id ? { ...a, monitored } : a)) } : prev))
    try {
      await musicApi.albums.update(album.id, { monitored })
    } catch (err) {
      setArtist(prev => (prev ? { ...prev, albums: prev.albums.map(a => (a.id === album.id ? { ...a, monitored: album.monitored } : a)) } : prev))
      toast.error(String(err))
    } finally {
      setMonitorBusy(prev => {
        const next = new Set(prev)
        next.delete(`album:${album.id}`)
        return next
      })
    }
  }

  const toggleTrackMonitoring = async (albumId: number, track: Track) => {
    const monitored = track.monitored === false
    setMonitorBusy(prev => new Set([...prev, `track:${track.id}`]))
    setTracks(prev => ({
      ...prev,
      [albumId]: (prev[albumId] ?? []).map(t => (t.id === track.id ? { ...t, monitored } : t)),
    }))
    try {
      await musicApi.tracks.update(track.id, { monitored })
    } catch (err) {
      setTracks(prev => ({
        ...prev,
        [albumId]: (prev[albumId] ?? []).map(t => (t.id === track.id ? { ...t, monitored: track.monitored } : t)),
      }))
      toast.error(String(err))
    } finally {
      setMonitorBusy(prev => {
        const next = new Set(prev)
        next.delete(`track:${track.id}`)
        return next
      })
    }
  }

  /** Re-runs the MusicBrainz sync with a new set of release types. */
  const applyReleaseTypes = async (types: string[], restoreRemoved: boolean, selectedAlbumIds?: string[]) => {
    if (!artist) return
    setRefreshingTypes(true)
    try {
      // An explicit album selection already says what to keep, so the restore
      // flag is not forwarded — it would also clear removals for types the
      // operator never looked at.
      const result = await musicApi.artists.refreshOne(
        artist.id,
        types,
        selectedAlbumIds ? false : restoreRemoved,
        selectedAlbumIds,
      )
      const parts = [
        result.added ? `${result.added} added` : null,
        result.removed ? `${result.removed} removed` : null,
        result.deselected ? `${result.deselected} deselected` : null,
        result.skipped ? `${result.skipped} kept out` : null,
      ].filter(Boolean)
      toast.success(parts.length ? `Releases updated — ${parts.join(', ')}` : 'Releases are already up to date')
      setShowTypes(false)
      await loadData(false)
    } catch (err) {
      toast.error(String(err))
    } finally {
      setRefreshingTypes(false)
    }
  }

  /**
   * Searches for a single release covering the artist's whole catalogue. The
   * importer splits it across albums, so one grab can fill many rows at once.
   */
  const scanDiscography = async () => {
    if (!artist) return
    const signal = beginDiscographySearch()
    setDiscoScanning(true)
    setDiscoReleases([])
    try {
      const result = await musicApi.artists.searchDiscography(artist.id, signal, search => {
        setDiscoReleases(search.results)
      })
      setDiscoReleases(result.releases)
      if (result.releases.length === 0) toast.error(`No discography releases found for ${artist.name}`)
    } catch (err) {
      if (isAbortError(err)) return
      toast.error(String(err))
    } finally {
      if (discographySearchController.current?.signal === signal) setDiscoScanning(false)
    }
  }

  const grabDiscography = async (release: MusicRelease) => {
    if (!artist) return
    const signal = beginDiscographySearch()
    setGrabbingRelease(release.guid)
    try {
      const result = await musicApi.artists.grabDiscography(artist.id, release, signal)
      if (result.success) {
        setGrabbedReleases(prev => new Set([...prev, release.guid]))
        toast.success('Submitted to torrent engine — fetching metadata may continue in the background')
        await loadData(false)
      } else {
        toast.error(result.message || 'The download client refused this release')
      }
    } catch (err) {
      if (isAbortError(err)) return
      toast.error(String(err))
    } finally {
      if (discographySearchController.current?.signal === signal) setGrabbingRelease(null)
    }
  }

  const scanAlbum = async (album: Album, mode: 'quick' | 'deep') => {
    const signal = beginAlbumSearch(album.id)
    setScanning(prev => ({ ...prev, [album.id]: mode }))
    setAlbumReleases(prev => ({ ...prev, [album.id]: [] }))
    try {
      const result = await musicApi.albums.search(album.id, mode, signal, search => {
        setAlbumReleases(prev => ({ ...prev, [album.id]: search.results }))
      })
      setAlbumReleases(prev => ({ ...prev, [album.id]: result.releases }))
      if (result.releases.length === 0) toast.error(`No releases found for ${album.title}`)
    } catch (err) {
      if (isAbortError(err)) return
      toast.error(String(err))
    } finally {
      if (albumSearchControllers.current.get(album.id)?.signal === signal) {
        albumSearchControllers.current.delete(album.id)
        setScanning(prev => ({ ...prev, [album.id]: null }))
      }
    }
  }

  const grabRelease = async (album: Album, release: MusicRelease) => {
    setGrabbingRelease(release.guid)
    try {
      const result = await musicApi.download(release, album.id)
      if (result.success) {
        setGrabbedReleases(prev => new Set([...prev, release.guid]))
        toast.success(`Grabbed ${release.title}`)
        await loadData(false)
      } else {
        toast.error(result.message || 'The download client refused this release')
      }
    } catch (err) {
      toast.error(String(err))
    } finally {
      setGrabbingRelease(null)
    }
  }

  const autoGrabAlbum = async (album: Album) => {
    const signal = beginAlbumSearch(album.id)
    setGrabbing(prev => new Set([...prev, album.id]))
    try {
      const result = await musicApi.albums.autoGrab(album.id, signal)
      if (result.success) toast.success(result.message || `Grabbed a release for ${album.title}`)
      else toast.error(result.message || 'No releases found')
      await loadData(false)
    } catch (err) {
      if (isAbortError(err)) return
      toast.error(String(err))
    } finally {
      if (albumSearchControllers.current.get(album.id)?.signal === signal) {
        albumSearchControllers.current.delete(album.id)
        setGrabbing(prev => {
          const next = new Set(prev)
          next.delete(album.id)
          return next
        })
      }
    }
  }

  /**
   * Walks every release this artist still needs and auto-grabs each one.
   *
   * One album at a time, because each pass queries every enabled indexer — a
   * parallel sweep would hammer them and get the account throttled. The server
   * ranks each album against its own quality and codec target, which the
   * artist-wide profile has already cascaded down, so this honours whatever is
   * set above without needing to pass it per request.
   *
   * Albums already collected or in flight are skipped, as are unmonitored ones:
   * a release the user has switched off should not come back through a bulk
   * action.
   */
  const grabAllReleases = async () => {
    if (!artist) return
    if (grabAll) {
      grabAllCancelled.current = true
      return
    }

    const targets = (artist.albums || [])
      .filter(album => album.monitored !== false && !isCollectedAlbum(album) && !isAcquiringAlbum(album))
      .sort((a, b) => (a.year ?? 0) - (b.year ?? 0))

    if (targets.length === 0) {
      toast.info('Every monitored release is already collected or in flight')
      return
    }

    grabAllCancelled.current = false
    let grabbed = 0
    let missed = 0
    let stopped = false

    for (const [index, album] of targets.entries()) {
      if (grabAllCancelled.current) {
        stopped = true
        break
      }
      setGrabAll({ done: index, total: targets.length, title: album.title })
      try {
        const result = await musicApi.albums.autoGrab(album.id)
        if (result.success) grabbed += 1
        else missed += 1
      } catch {
        missed += 1
      }
    }

    setGrabAll(null)
    await loadData(false)

    const summary = [`${grabbed} grabbed`, missed > 0 ? `${missed} with no release matching the quality target` : null].filter(Boolean).join(', ')
    if (stopped) toast.info(`Stopped — ${summary}`)
    else if (grabbed > 0) toast.success(summary)
    else toast.error(summary)
  }

  /** Jump to the artist library filtered by a clicked metadata value. */
  const searchLibrary = (field: string, value: string | number | undefined | null) => {
    if (value == null || value === '') return
    navigate(`/music?field=${field}&q=${encodeURIComponent(String(value))}`)
  }

  useEffect(() => {
    if (expandedAlbum) {
      void loadTracks(expandedAlbum)
    }
  }, [expandedAlbum])

  if (loading)
    return (
      <div className="animate-pulse space-y-8">
        <div className="h-[400px] bg-noir-800 rounded-3xl" />
        <div className="h-64 bg-noir-800 rounded-3xl" />
      </div>
    )

  if (!artist) return <EmptyState icon="unknown" title="ARTIST NOT FOUND" />

  const grouped = (artist.albums || []).reduce(
    (acc, a) => {
      let type = a.album_type || 'Album'
      if (type === 'Album') type = 'Studio Album'
      if (!acc[type]) acc[type] = []
      acc[type].push(a)
      return acc
    },
    {} as Record<string, Album[]>,
  )

  const albums = artist.albums || []
  const albumCount = albums.length
  const collectedAlbums = albums.filter(isCollectedAlbum).length
  const acquiringAlbums = albums.filter(isAcquiringAlbum).length
  const totalTracks = albums.reduce((sum, a) => sum + (a.track_count || 0), 0)

  // The artist's own collection state, shown beneath the portrait the way a
  // film or series shows its status there.
  const artistStatus =
    acquiringAlbums > 0 || artist.discography_status === 'acquiring' ? 'acquiring' : albumCount > 0 && collectedAlbums === albumCount ? 'collected' : 'missing'

  // MusicBrainz returns a long tail of tags; only the leading few say anything
  // about the artist, so the page shows three and no more.
  const topGenres = (Array.isArray(artist.genres) ? artist.genres : []).slice(0, 3)

  const groupOrder = ['Studio Album', 'Live', 'Compilation', 'EP', 'Single']
  const sortedGroups = Object.entries(grouped).sort(([a], [b]) => {
    const ai = groupOrder.indexOf(a),
      bi = groupOrder.indexOf(b)
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return a.localeCompare(b)
  })

  return (
    <div className="animate-fade-in pb-20 relative min-h-screen">
      {/* Immersive backdrop, matching films and series. */}
      <div className="fixed inset-0 pointer-events-none" style={{ zIndex: -5 }}>
        {artist.backdrop_url || artist.image_url ? (
          <img
            src={tmdbImage(artist.backdrop_url || artist.image_url, 'original')}
            className="w-full h-full object-cover opacity-50 blur-[10px] scale-110"
            alt=""
          />
        ) : null}
        <div className="absolute inset-0 bg-noir-950/40" />
      </div>

      <div className="relative z-10 max-w-[1600px] mx-auto px-8 pt-4">
        <div className="grid grid-cols-12 gap-6 lg:gap-x-16 lg:gap-y-16 items-stretch">
          {/* Top left: artist portrait. Square, because an artist image is not a poster. */}
          <div className="col-span-12 lg:col-span-3 flex flex-col items-stretch gap-4">
            <div
              role="button"
              tabIndex={0}
              onClick={() => setShowMetadataModal(true)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setShowMetadataModal(true)
                }
              }}
              className="aspect-square w-full rounded-3xl overflow-hidden border border-white/10 shadow-[0_0_60px_rgba(0,0,0,0.6)] group/poster relative cursor-pointer hover:border-[#FF2D78]/50 transition-all active:scale-[0.98]"
            >
              {artist.image_url ? (
                <img src={tmdbImage(artist.image_url)} className="w-full h-full object-cover" alt="" />
              ) : (
                <div className="w-full h-full bg-noir-800 grid place-items-center text-white/15">
                  <PackIcon name="artist" size={72} />
                </div>
              )}
              <div className="absolute inset-0 bg-[#FF2D78]/25 opacity-0 group-hover/poster:opacity-100 group-focus/poster:opacity-100 transition-opacity flex items-center justify-center">
                <div className="bg-black/60 backdrop-blur-md px-4 py-2 rounded-full border border-white/20 translate-y-4 group-hover/poster:translate-y-0 transition-transform">
                  <p className="text-[10px] font-bold text-white uppercase tracking-[0.2em]">Edit Metadata</p>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between px-1">
              <StatusBadge status={artistStatus} className="!text-[14px]" />
              {artist.country && (
                <button
                  onClick={() => searchLibrary('country', artist.country)}
                  className="text-[10px] font-mono uppercase tracking-widest text-white/40 hover:text-[#FF2D78] transition-colors"
                >
                  {artist.country}
                </button>
              )}
            </div>
          </div>

          {/* Top centre: biography and your rating, as on films and series. */}
          <div className="col-span-12 lg:col-span-6 flex flex-col pt-4">
            <div className="space-y-4">
              <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Overview</h3>
              <p className="text-[12.5px] text-white leading-relaxed font-medium">
                {artist.overview || 'No biography is currently available for this artist.'}
              </p>
              <div className="pt-4">
                <p className="archivist-section-label mb-4">Your rating</p>
                <Level
                  title={artist.name}
                  rating={ratingFor('artist', artist.id)}
                  onCommit={value => commitRating('artist', artist.id, value)}
                  accent="var(--archivist-music)"
                  showSource
                />
              </div>
            </div>

            <div className="mt-auto space-y-8 pb-2">
              <div className="flex flex-wrap gap-x-6 gap-y-4 lg:gap-x-12 lg:gap-y-6">
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Releases</span>
                  <span className="text-[12.5px] text-white font-medium tabular-nums">{albumCount}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Collected</span>
                  <span className="text-[12.5px] text-white font-medium tabular-nums">
                    {collectedAlbums} / {albumCount}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Tracks</span>
                  <span className="text-[12.5px] text-white font-medium tabular-nums">{totalTracks}</span>
                </div>
                {artist.musicbrainz_id && (
                  <div className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">MBID</span>
                    <span className="text-[12.5px] text-white/50 font-mono" title={artist.musicbrainz_id}>
                      {artist.musicbrainz_id.slice(0, 8)}
                    </span>
                  </div>
                )}
              </div>

              {/* The only genre listing on the page, capped at the three that
                  actually characterise the artist — MusicBrainz returns a long
                  tail of tags that says nothing useful. */}
              {topGenres.length > 0 && (
                <div className="flex flex-col gap-1 pt-2 border-t border-white/5">
                  <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Genres</span>
                  <span className="text-[12.5px] text-white font-medium">
                    {topGenres.map((genre, index) => (
                      <span key={genre}>
                        {index > 0 && ' / '}
                        <button onClick={() => searchLibrary('genre', genre)} className="hover:text-[#FF2D78] transition-colors">
                          {titleCase(genre)}
                        </button>
                      </span>
                    ))}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Top right: logo, then collection state and actions. */}
          <div className="col-span-12 lg:col-span-3 flex flex-col items-start text-left lg:items-end lg:text-right">
            <div className="min-h-[140px] flex items-start justify-end w-full mb-auto">
              {artist.logo_url ? (
                <img src={tmdbImage(artist.logo_url)} className="max-h-32 object-contain filter drop-shadow-2xl" alt={artist.name} />
              ) : (
                <h1 className="font-display text-5xl tracking-tighter text-white uppercase text-right leading-none">{artist.name}</h1>
              )}
            </div>

            <div className="space-y-8 w-full pb-2">
              <div className="pt-2 border-t border-white/5">
                <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest mb-1">Collection</p>
                <p className="text-[12.5px] font-bold text-white uppercase tracking-widest">
                  {acquiringAlbums > 0
                    ? `${acquiringAlbums} acquiring`
                    : collectedAlbums === albumCount && albumCount > 0
                      ? 'Complete'
                      : `${albumCount - collectedAlbums} missing`}
                </p>
                <div className="mt-4 flex flex-wrap lg:justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void scanDiscography()}
                    disabled={discoScanning}
                    title="Search for one release covering this artist's whole catalogue"
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-[9px] font-bold uppercase tracking-[0.12em] text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:opacity-40"
                  >
                    {discoScanning ? <Spinner className="h-3 w-3" /> : <PackIcon name="library" size={12} />}
                    {discoScanning ? 'Scanning' : 'Discography'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void grabAllReleases()}
                    disabled={discoScanning}
                    title={
                      grabAll
                        ? 'Stop after the release currently being searched'
                        : 'Grab every release this artist is still missing, using the quality and codec set above'
                    }
                    aria-live="polite"
                    className={`inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-[9px] font-bold uppercase tracking-[0.12em] transition-colors disabled:opacity-40 ${
                      grabAll
                        ? 'border-[#FF2D78]/40 bg-[#FF2D78]/10 text-[#FF2D78] hover:bg-[#FF2D78]/20'
                        : 'border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/[0.07] hover:text-white/80'
                    }`}
                  >
                    {grabAll ? <Spinner className="h-3 w-3" /> : <PackIcon name="auto-grab" size={12} />}
                    {grabAll ? `Stop ${grabAll.done + 1}/${grabAll.total}` : 'All Releases'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowTypes(true)}
                    title="Choose which release types to track for this artist"
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-[9px] font-bold uppercase tracking-[0.12em] text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white/80"
                  >
                    <PackIcon name="album" size={12} />
                    Releases
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleArtistMonitoring()}
                    disabled={monitorBusy.has(`artist:${artist.id}`)}
                    aria-pressed={artist.monitored}
                    title={artist.monitored ? 'Exclude this artist from system automation' : 'Include this artist in system automation'}
                    className="inline-flex w-[92px] items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-[9px] font-bold uppercase tracking-[0.12em] text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:cursor-wait"
                  >
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 shrink-0 rounded-full ${artist.monitored ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.8)]' : 'bg-white/15'}`}
                    />
                    Monitor
                  </button>
                </div>
                {grabAll && (
                  <p className="mt-3 text-[9px] font-mono uppercase tracking-[0.15em] text-white/30 truncate" title={grabAll.title}>
                    Searching · {grabAll.title}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Row 2: the lineup, where films and series carry their cast. */}
          {artist.members && artist.members.length > 0 && (
            <div className="col-span-12 space-y-1">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Members</h3>
                </div>
                <div className="flex gap-6 overflow-x-auto pb-2 custom-scrollbar snap-x">
                  {artist.members.map(member => (
                    <button
                      key={member.mbid}
                      onClick={() => searchLibrary('member', member.name)}
                      title={[member.roles.join(', '), member.current ? 'Current member' : 'Former member'].filter(Boolean).join(' · ')}
                      className={`group flex-shrink-0 w-[87px] space-y-4 snap-start text-left ${member.current ? '' : 'opacity-55'}`}
                    >
                      <div className="aspect-square rounded-2xl overflow-hidden border border-white/5 group-hover:border-[#FF2D78]/40 bg-noir-800 shadow-xl transition-colors grid place-items-center">
                        {/* MusicBrainz carries no member photography, so initials
                            stand in rather than a broken image. */}
                        <span className="font-display text-2xl tracking-widest text-white/25 group-hover:text-[#FF2D78]/70 transition-colors">
                          {member.name
                            .split(/\s+/)
                            .slice(0, 2)
                            .map(part => part[0] ?? '')
                            .join('')
                            .toUpperCase()}
                        </span>
                      </div>
                      <div className="space-y-1 px-1">
                        <p className="text-[9.5px] font-bold text-white group-hover:text-[#FF2D78] truncate uppercase leading-tight transition-colors">
                          {member.name}
                        </p>
                        <p className="text-[9.5px] text-white/40 truncate leading-tight italic">
                          {member.roles.length ? member.roles.join(', ') : member.current ? 'Member' : 'Former member'}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {showTypes && (
        <TypeModal
          artist={artist}
          initialTypes={parseAlbumTypes(artist.album_types)}
          offerRestore
          artistId={artist.id}
          title={`${artist.name} — Releases`}
          description="Which release types should Archivist track? You will pick the albums next. Removing a type deletes its albums, unless they have already been collected."
          confirmLabel="Update releases"
          isAdding={refreshingTypes}
          onClose={() => setShowTypes(false)}
          onConfirm={(types, restoreRemoved, albumIds) => void applyReleaseTypes(types, restoreRemoved, albumIds)}
        />
      )}

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
          onSave={async data => {
            await musicApi.artists.updateMetadata(artist.id, data)
          }}
          images={{
            types: ['poster', 'backdrop', 'logo', 'banner'],
            search: type => musicApi.artists.searchImages(artist.id, type),
            save: (type, url) => musicApi.artists.saveImage(artist.id, type, url),
          }}
          onClose={() => {
            setShowMetadataModal(false)
            loadData(false)
          }}
        />
      )}

      {editingAlbum && (
        <MetadataEditorModal
          title={editingAlbum.title}
          initial={editingAlbum as any}
          fields={[
            { key: 'title', label: 'Title' },
            { key: 'album_type', label: 'Release type' },
            { key: 'year', label: 'Year', type: 'number' },
            { key: 'label', label: 'Label' },
            { key: 'genres', label: 'Genres (comma separated)', type: 'csv', wide: true },
            { key: 'overview', label: 'Album notes', type: 'textarea' },
          ]}
          onSave={async data => {
            await musicApi.albums.updateMetadata(editingAlbum.id, data)
          }}
          images={{
            types: ['poster', 'cdart'],
            aspect: '1/1',
            search: type => musicApi.albums.searchImages(editingAlbum.id, type),
            save: (type, url) => musicApi.albums.saveImage(editingAlbum.id, type, url),
          }}
          extraTabs={[
            {
              id: 'releases',
              label: 'Releases',
              content: (
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-6">
                    <div>
                      <h3 className="text-[10px] font-bold uppercase tracking-[0.22em] text-white/70">MusicBrainz releases</h3>
                      <p className="mt-1 max-w-2xl text-[10px] font-mono leading-relaxed text-white/30">
                        Choose the exact edition Archivist should search for and use as this album&apos;s track listing.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void loadAlbumEditions(editingAlbum.id, true)}
                      disabled={editionLoading.has(editingAlbum.id) || editionSaving.has(editingAlbum.id)}
                      className="shrink-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-white/40 transition-colors hover:bg-white/[0.07] hover:text-white/70 disabled:opacity-30"
                    >
                      {editionLoading.has(editingAlbum.id) ? 'Refreshing…' : 'Refresh'}
                    </button>
                  </div>

                  <div className="relative">
                    <input
                      type="search"
                      value={releaseFilter}
                      onChange={event => setReleaseFilter(event.target.value)}
                      placeholder="Filter by title, edition, year, label, country or format…"
                      aria-label="Filter album releases"
                      className="w-full rounded-xl border border-white/10 bg-noir-950 py-3 pl-4 pr-24 text-sm text-white/80 outline-none transition-colors placeholder:text-white/20 focus:border-[#FF2D78]/50"
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-[9px] font-mono uppercase tracking-wider text-white/25">
                      {(albumEditions[editingAlbum.id] ?? []).filter(release => albumReleaseMatches(release, editingAlbum, releaseFilter)).length} of{' '}
                      {(albumEditions[editingAlbum.id] ?? []).length}
                    </span>
                  </div>

                  {editionLoading.has(editingAlbum.id) && !albumEditions[editingAlbum.id] ? (
                    <div className="flex min-h-48 items-center justify-center gap-3" role="status">
                      <Spinner className="h-5 w-5" color="text-[#FF2D78]" />
                      <span className="text-[10px] font-mono uppercase tracking-widest text-white/30">Loading releases…</span>
                    </div>
                  ) : (albumEditions[editingAlbum.id] ?? []).length === 0 ? (
                    <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-white/10 text-[10px] font-mono uppercase tracking-widest text-white/25">
                      No concrete releases found
                    </div>
                  ) : (albumEditions[editingAlbum.id] ?? []).filter(release => albumReleaseMatches(release, editingAlbum, releaseFilter)).length === 0 ? (
                    <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-white/10 text-[10px] font-mono uppercase tracking-widest text-white/25">
                      No releases match “{releaseFilter}”
                    </div>
                  ) : (
                    <div className="max-h-[48vh] space-y-2 overflow-y-auto pr-2 custom-scrollbar" role="list" aria-label="Album releases">
                      {(albumEditions[editingAlbum.id] ?? [])
                        .filter(release => albumReleaseMatches(release, editingAlbum, releaseFilter))
                        .map(release => {
                          const selected = release.selected
                          return (
                            <button
                              key={release.id}
                              type="button"
                              role="listitem"
                              aria-label={editionLabel(release, editingAlbum)}
                              aria-pressed={selected}
                              onClick={() => !selected && void chooseAlbumEdition(editingAlbum, release.id)}
                              disabled={editionSaving.has(editingAlbum.id)}
                              className={`w-full rounded-xl border p-4 text-left transition-all disabled:cursor-wait disabled:opacity-60 ${
                                selected
                                  ? 'border-[#FF2D78]/50 bg-[#FF2D78]/10 shadow-[0_0_24px_rgba(255,45,120,0.08)]'
                                  : 'border-white/[0.06] bg-noir-900/60 hover:border-white/15 hover:bg-white/[0.04]'
                              }`}
                            >
                              <div className="flex items-start justify-between gap-5">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-semibold text-white/85">{albumReleaseName(release, editingAlbum)}</span>
                                    {release.status && (
                                      <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider text-white/35">
                                        {release.status}
                                      </span>
                                    )}
                                  </div>
                                  <p className="mt-1 truncate text-[10px] font-mono text-white/30">
                                    {[release.date, release.country, release.label, release.packaging, release.barcode].filter(Boolean).join(' · ') ||
                                      release.title}
                                  </p>
                                  <div className="mt-3 flex flex-wrap gap-1.5">
                                    {release.mediaFormats.map(format => (
                                      <span
                                        key={format}
                                        className="rounded-md bg-white/[0.05] px-2 py-1 text-[8px] font-mono uppercase tracking-wider text-white/40"
                                      >
                                        {format}
                                      </span>
                                    ))}
                                    <span className="rounded-md bg-white/[0.05] px-2 py-1 text-[8px] font-mono uppercase tracking-wider text-white/40">
                                      {release.discCount} disc{release.discCount === 1 ? '' : 's'}
                                    </span>
                                    <span className="rounded-md bg-white/[0.05] px-2 py-1 text-[8px] font-mono uppercase tracking-wider text-white/40">
                                      {release.trackCount} tracks
                                    </span>
                                  </div>
                                </div>
                                <span className={`shrink-0 text-[9px] font-bold uppercase tracking-widest ${selected ? 'text-[#FF2D78]' : 'text-white/25'}`}>
                                  {editionSaving.has(editingAlbum.id) && !selected ? 'Saving…' : selected ? 'Selected' : 'Select'}
                                </span>
                              </div>
                            </button>
                          )
                        })}
                    </div>
                  )}
                </div>
              ),
            },
          ]}
          onClose={() => {
            setReleaseFilter('')
            setEditingAlbum(null)
            loadData(false)
          }}
        />
      )}

      {editingLyrics && (
        <LyricsModal
          album={editingLyrics.album}
          track={editingLyrics.track}
          onClose={() => setEditingLyrics(null)}
          onSaved={saved => {
            setTracks(prev => ({
              ...prev,
              [editingLyrics.album.id]: (prev[editingLyrics.album.id] ?? []).map(t => (t.id === saved.id ? { ...t, ...saved } : t)),
            }))
            setEditingLyrics(null)
          }}
        />
      )}

      <div className="max-w-[1600px] mx-auto w-full px-8 space-y-16 pt-16">
        {/* One profile for the whole artist — every release of theirs is
            acquired to the same standard, so there is nothing to set per album. */}
        <MusicQualityPanel value={artist as never} onChange={patch => void updateArtistPolicy(patch)} />

        {(discoReleases !== null || artist.discography_status === 'acquiring') && (
          <div className="rounded-2xl border border-white/5 bg-noir-900/40 p-6">
            <div className="flex items-center gap-4 mb-5">
              <h3 className="text-[9px] font-bold text-[#FF2D78] uppercase tracking-[0.3em] whitespace-nowrap">Discography</h3>
              <div className="h-px w-full bg-white/[0.03]" />
              {discoScanning && <Spinner className="w-4 h-4 shrink-0" color="text-[#FF2D78]" />}
              {discoReleases !== null && (
                <button
                  onClick={() => setDiscoReleases(null)}
                  className="text-[9px] font-bold text-white/20 hover:text-white transition-all uppercase tracking-widest"
                >
                  Clear
                </button>
              )}
            </div>

            {artist.discography_status === 'acquiring' && (
              <p className="mb-4 font-mono text-[10px] uppercase tracking-widest text-white/35">
                {torrentPhase(artist.discography_torrent_status)} · {artist.discography_title ?? 'discography'}
                {artist.discography_torrent_status === 'downloading' ? ` · ${Math.round((artist.discography_progress ?? 0) * 100)}%` : ''}. Albums are matched
                and filed as it completes.
              </p>
            )}

            {discoReleases !== null && (
              <div className="mb-5 rounded-xl border border-white/5 bg-black/10 px-4 py-3">
                <p className="mb-2 text-[8px] font-bold uppercase tracking-[0.22em] text-white/25">Search terms</p>
                <ul className="space-y-1 font-mono text-[10px] text-white/45">
                  {discographySearchTerms(artist.name).map(term => (
                    <li key={term}>{term}</li>
                  ))}
                </ul>
              </div>
            )}

            {discoReleases !== null && discoScanning && discoReleases.length === 0 && (
              <p className="py-4 text-center font-mono text-[10px] uppercase tracking-widest text-white/30" role="status" aria-live="polite">
                Waiting for the first indexer results…
              </p>
            )}

            {discoReleases !== null && discoReleases.length > 0 && (
              <div aria-live="polite">
                {discoScanning && <p className="mb-3 font-mono text-[9px] uppercase tracking-widest text-white/30">{discoReleases.length} results so far</p>}
                <ReleaseList
                  releases={discoReleases as never}
                  onGrab={release => void grabDiscography(release as never)}
                  grabbing={grabbingRelease}
                  grabbed={grabbedReleases}
                  accentClass="text-[#FF2D78]"
                />
              </div>
            )}
          </div>
        )}

        <div className="space-y-8">
          <section className="space-y-12">
            {sortedGroups.map(([type, albums]) => (
              <div key={type} className="space-y-6">
                <div className="flex items-center gap-6">
                  <h2 className="text-[10.5px] font-bold text-white/40 uppercase tracking-[0.3em] whitespace-nowrap">{type}s</h2>
                  <div className="h-px w-full bg-white/[0.03]" />
                </div>

                <div className="space-y-3">
                  {albums.map(album => {
                    const expanded = expandedAlbum === album.id
                    const collected = isCollectedAlbum(album)
                    const acquiring = isAcquiringAlbum(album)
                    const partial = album.status === 'partial'
                    const albumTracks = tracks[album.id]
                    const toggle = () => setExpandedAlbum(expanded ? null : album.id)
                    return (
                      <div key={album.id} className="bg-noir-900/40 border border-white/[0.03] rounded-2xl overflow-hidden transition-all group/album">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={toggle}
                          onKeyDown={e => {
                            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                              e.preventDefault()
                              toggle()
                            }
                          }}
                          className="w-full min-h-[80px] flex items-center justify-between p-3 hover:bg-white/[0.03] transition-colors text-left relative overflow-visible cursor-pointer"
                        >
                          {/* Cover grows on expand, exactly as the season poster does. */}
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation()
                              setReleaseFilter('')
                              setEditingAlbum(album)
                              void loadAlbumEditions(album.id)
                            }}
                            aria-label={`Edit metadata for ${album.title}`}
                            className={`absolute left-3 top-3 z-20 rounded-lg overflow-hidden bg-noir-800 border border-white/10 shadow-2xl transition-all duration-300 group/albumcover hover:border-[#FF2D78]/60 ${expanded ? 'w-[168px] h-[168px]' : 'w-14 h-14'}`}
                          >
                            {album.cover_url ? (
                              <img src={tmdbImage(album.cover_url)} className="w-full h-full object-cover" alt={`${album.title} cover`} />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-white/15">
                                <PackIcon name="album" size={expanded ? 56 : 22} />
                              </div>
                            )}
                            <span className="absolute inset-0 bg-[#FF2D78]/30 opacity-0 group-hover/albumcover:opacity-100 transition-opacity flex items-center justify-center text-[8px] font-bold uppercase tracking-widest text-white">
                              Edit
                            </span>
                          </button>

                          <div className={`flex items-center relative z-10 transition-[padding] duration-300 ${expanded ? 'pl-[184px]' : 'pl-[72px]'}`}>
                            <div className="space-y-1">
                              <div className="text-sm font-bold text-white uppercase tracking-wider">{album.title}</div>
                              <div className="text-[9px] font-bold text-white/20 uppercase tracking-[0.15em]">
                                {album.year ? <span>{album.year} • </span> : null}
                                {album.track_count || 0} TRACKS
                                {partial ? <span className="ml-2 text-amber-400">• PARTIAL · {Math.round((album.downloadProgress ?? 0) * 100)}%</span> : null}
                              </div>
                              {/* This album's own share of the download. Inside a
                                discography that is the progress of its files,
                                not the whole pack's. */}
                              {(acquiring || partial) && (
                                <div className="flex items-center gap-3 pt-1">
                                  <div className="h-1 w-40 rounded-full bg-white/5 overflow-hidden">
                                    <div
                                      className={`h-full transition-all duration-500 ${partial ? 'bg-amber-400' : 'bg-[#FF2D78]'}`}
                                      style={{ width: `${Math.round((album.downloadProgress ?? 0) * 100)}%` }}
                                    />
                                  </div>
                                  <span className="font-mono text-[9px] uppercase tracking-widest text-white/25 tabular-nums">
                                    {partial
                                      ? `${Math.round((album.downloadProgress ?? 0) * 100)}%`
                                      : album.torrent_status === 'downloading'
                                        ? `${torrentPhase(album.torrent_status)} · ${Math.round((album.downloadProgress ?? 0) * 100)}%`
                                        : torrentPhase(album.torrent_status)}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-6 relative z-10">
                            <div onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                              <Level
                                title={album.title}
                                rating={ratingFor('album', album.id)}
                                onCommit={value => commitRating('album', album.id, value)}
                                size="compact"
                                accent="var(--archivist-music)"
                                showSource
                              />
                            </div>

                            <div className="flex items-center gap-2">
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  setExpandedAlbum(album.id)
                                  void scanAlbum(album, 'quick')
                                }}
                                disabled={Boolean(scanning[album.id])}
                                title="Fast search filtered to this album's quality profile"
                                className="px-3 py-1.5 rounded-lg bg-[#00D4FF] border border-[#00D4FF] text-noir-950 text-[9px] font-bold uppercase tracking-widest hover:bg-[#00D4FF]/80 transition-all disabled:opacity-30"
                              >
                                {scanning[album.id] === 'quick' ? 'Scanning' : 'Quick Scan'}
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  setExpandedAlbum(album.id)
                                  void scanAlbum(album, 'deep')
                                }}
                                disabled={Boolean(scanning[album.id])}
                                title="Exhaustive search — every release found, unfiltered"
                                className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[9px] font-bold uppercase tracking-widest text-white/50 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30"
                              >
                                {scanning[album.id] === 'deep' ? 'Scanning' : 'Deep Scan'}
                              </button>
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  void autoGrabAlbum(album)
                                }}
                                disabled={grabbing.has(album.id) || acquiring || collected || Boolean(scanning[album.id]) || grabAll !== null}
                                title={collected ? 'Already collected' : 'Find and grab the best release for this album'}
                                className="px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[9px] font-bold uppercase tracking-widest hover:bg-emerald-500/20 transition-all disabled:opacity-30"
                              >
                                {grabbing.has(album.id) ? 'Grabbing' : 'Auto Album'}
                              </button>
                            </div>

                            <button
                              onClick={e => {
                                e.stopPropagation()
                                void toggleAlbumMonitoring(album)
                              }}
                              disabled={monitorBusy.has(`album:${album.id}`)}
                              aria-pressed={album.monitored}
                              title={album.monitored ? 'Exclude this album from system automation' : 'Include this album in system automation'}
                              className="inline-flex w-[86px] items-center justify-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/[0.03] text-[8px] font-bold uppercase tracking-[0.12em] text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:cursor-wait"
                            >
                              <span
                                aria-hidden="true"
                                className={`h-2 w-2 shrink-0 rounded-full ${album.monitored ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.8)]' : 'bg-white/15'}`}
                              />
                              Monitor
                            </button>

                            <button
                              onClick={e => {
                                e.stopPropagation()
                                void removeAlbum(album)
                              }}
                              title="Remove this album from the library. Files on disk are kept, and re-applying the artist's release types brings it back."
                              aria-label={`Remove ${album.title} from the library`}
                              className="inline-flex items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[8px] font-bold uppercase tracking-[0.12em] text-white/40 transition-colors hover:border-[#FF2D78]/30 hover:bg-[#FF2D78]/10 hover:text-[#FF2D78]"
                            >
                              Remove
                            </button>

                            <div className="w-[104px] flex justify-end shrink-0">
                              <StatusBadge
                                status={acquiring ? 'acquiring' : collected ? 'collected' : 'missing'}
                                progress={acquiring ? album.downloadProgress : undefined}
                              />
                            </div>

                            <span className={`flex text-white/10 transition-transform duration-500 ${expanded ? 'rotate-180' : ''}`}>
                              <PackIcon name="chevron-down" size={16} />
                            </span>
                          </div>
                        </div>

                        {expanded && (
                          <div className="border-t border-white/[0.03] animate-slide-down bg-noir-950/40">
                            <div className="min-h-[112px] pl-[200px] pr-6 py-4 border-b border-white/[0.03] bg-noir-900/20">
                              <h3 className="text-[8px] font-bold text-white/20 uppercase tracking-[0.2em] mb-2">Album Details</h3>
                              <p className="text-[9px] font-mono text-white/25 uppercase tracking-[0.15em] mb-2">
                                {[album.album_type, album.year, album.label].filter(Boolean).join(' · ') || 'No album details are currently available.'}
                              </p>
                              <p className="text-xs text-white/40 leading-relaxed italic">{album.overview || 'No album notes have been written yet.'}</p>
                            </div>

                            {albumReleases[album.id] !== undefined && (
                              <div className="p-6 border-b border-white/[0.03] bg-noir-900/40">
                                <div className="flex items-center gap-4 mb-5">
                                  <h3 className="text-[9px] font-bold text-[#FF2D78] uppercase tracking-[0.3em] whitespace-nowrap">Scan Results</h3>
                                  <div className="h-px w-full bg-white/[0.03]" />
                                  {scanning[album.id] && <Spinner className="w-4 h-4 shrink-0" color="text-[#FF2D78]" />}
                                  <button
                                    onClick={() =>
                                      setAlbumReleases(prev => {
                                        const next = { ...prev }
                                        delete next[album.id]
                                        return next
                                      })
                                    }
                                    className="text-[9px] font-bold text-white/20 hover:text-white transition-all uppercase tracking-widest"
                                  >
                                    Clear
                                  </button>
                                </div>
                                {scanning[album.id] && albumReleases[album.id].length === 0 ? (
                                  <p
                                    className="py-4 text-center font-mono text-[10px] uppercase tracking-widest text-white/30"
                                    role="status"
                                    aria-live="polite"
                                  >
                                    Waiting for the first indexer results…
                                  </p>
                                ) : (
                                  <div aria-live="polite">
                                    {scanning[album.id] && (
                                      <p className="mb-3 font-mono text-[9px] uppercase tracking-widest text-white/30">
                                        {albumReleases[album.id].length} results so far
                                      </p>
                                    )}
                                    <ReleaseList
                                      releases={albumReleases[album.id] as never}
                                      onGrab={release => void grabRelease(album, release as never)}
                                      grabbing={grabbingRelease}
                                      grabbed={grabbedReleases}
                                      accentClass="text-[#FF2D78]"
                                    />
                                  </div>
                                )}
                              </div>
                            )}

                            <div className="divide-y divide-white/[0.02]">
                              {albumTracks ? (
                                albumTracks.map(track => (
                                  <div key={track.id} className="flex items-center gap-4 px-6 py-3.5 group/track hover:bg-white/[0.03] transition-colors">
                                    <span className="text-[10px] font-bold text-white/10 w-8 text-right group-hover/track:text-white transition-colors">
                                      T{track.track_number ?? '—'}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-xs font-bold text-white/70 group-hover/track:text-white transition-colors uppercase tracking-tight truncate">
                                        {track.title}
                                      </div>
                                      <div className="text-[8px] font-bold text-white/20 uppercase tracking-[0.1em] mt-0.5">
                                        {track.disc_number > 1 ? `Disc ${track.disc_number} • ` : ''}
                                        {formatDuration(track.duration)}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-4">
                                      <div className="hidden xl:block" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                                        <Level
                                          title={track.title}
                                          rating={ratingFor('track', track.id)}
                                          onCommit={value => commitRating('track', track.id, value)}
                                          size="compact"
                                          accent="var(--archivist-music)"
                                        />
                                      </div>
                                      <div className="hidden md:flex items-center gap-4">
                                        <div className="w-[52px] flex justify-center shrink-0">
                                          {track.quality && (
                                            <span className="text-[8px] font-bold text-white/10 border border-white/5 px-1.5 py-0.5 rounded uppercase">
                                              {track.quality}
                                            </span>
                                          )}
                                        </div>
                                        {/* A track's metadata is its words. */}
                                        <button
                                          onClick={e => {
                                            e.stopPropagation()
                                            setEditingLyrics({ album, track })
                                          }}
                                          title={track.lyrics ? 'Edit lyrics' : 'Add lyrics'}
                                          className={`inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-[8px] font-bold uppercase tracking-[0.12em] transition-colors ${
                                            track.lyrics
                                              ? 'border-[#FF2D78]/30 bg-[#FF2D78]/10 text-[#FF2D78] hover:bg-[#FF2D78]/20'
                                              : 'border-white/10 bg-white/[0.03] text-white/40 hover:bg-white/[0.07] hover:text-white/70'
                                          }`}
                                        >
                                          <PackIcon name="lyrics" size={10} />
                                          Lyrics
                                        </button>
                                        <button
                                          onClick={e => {
                                            e.stopPropagation()
                                            void toggleTrackMonitoring(album.id, track)
                                          }}
                                          disabled={monitorBusy.has(`track:${track.id}`)}
                                          aria-pressed={track.monitored !== false}
                                          title={
                                            track.monitored !== false ? 'Exclude this track from system automation' : 'Include this track in system automation'
                                          }
                                          className="inline-flex w-[86px] items-center justify-center gap-2 px-3 py-2 rounded-lg border border-white/10 bg-white/[0.03] text-[8px] font-bold uppercase tracking-[0.12em] text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white/80 disabled:cursor-wait"
                                        >
                                          <span
                                            aria-hidden="true"
                                            className={`h-2 w-2 shrink-0 rounded-full ${track.monitored !== false ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.8)]' : 'bg-white/15'}`}
                                          />
                                          Monitor
                                        </button>
                                      </div>
                                      {/* Status pinned right at a fixed width so rows stay column-aligned. */}
                                      <div className="w-[104px] flex justify-end shrink-0">
                                        <StatusBadge status={track.status} progress={track.downloadProgress} />
                                      </div>
                                    </div>
                                  </div>
                                ))
                              ) : (
                                <div className="p-12 text-center">
                                  <Spinner className="w-8 h-8 mx-auto mb-3" color="text-[#FF2D78]" />
                                  <p className="text-[10px] font-mono text-white/20 uppercase tracking-[0.2em]">Syncing tracks…</p>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </section>
        </div>
      </div>

      <ItemActionsBar
        accent="#FF2D78"
        containerClass="max-w-[1600px] mx-auto px-8 w-full"
        reacquire={{
          mode: 'select',
          title: 'Select albums to reacquire',
          items: (artist.albums || []).map(a => ({ id: a.id, label: a.title, sublabel: a.year ? String(a.year) : undefined })),
          runSelected: async ids => {
            for (const aid of ids) await musicApi.albums.repair(aid, {})
            loadData(false)
          },
        }}
        loadHistory={() => musicApi.artists.acquisitionHistory(artist.id)}
        onRemove={async () => {
          if (!(await confirmDialog('Remove this artist from the library? Files on disk are kept.'))) return
          onDelete(artist.id)
          navigate('/music')
          musicApi.artists.delete(artist.id, false).catch(err => toast.error(String(err)))
        }}
        onDelete={async () => {
          if (!(await confirmDialog('Delete this artist AND all their files from disk? This permanently removes the folder and cannot be undone.'))) return
          onDelete(artist.id)
          navigate('/music')
          musicApi.artists.delete(artist.id, true).catch(err => toast.error(String(err)))
        }}
        onEdit={() => setShowMetadataModal(true)}
      />
    </div>
  )
}

// ── Music Library ────────────────────────────────────────────────────────────

type MusicCollectionFilter = 'all' | 'missing' | 'collected' | 'acquiring'

const MUSIC_ACCENT = '#FF2D78'
const MUSIC_TABS = mediaSectionTabs({ base: '/music', library: 'Artists', add: 'Add Artist', edit: 'Edit Artists' })

/**
 * The track editor.
 *
 * A track has no artwork and no release metadata worth editing — what belongs
 * to a track is its words. Archivist has no lyrics provider wired up yet, so
 * this writes the text by hand; when a provider arrives it fills the same
 * column and the editor gains a "fetch" action beside Save.
 */
function LyricsModal({
  album,
  track,
  onClose,
  onSaved,
}: {
  album: Album
  track: Track
  onClose: () => void
  onSaved: (track: Track) => void
}) {
  const [text, setText] = useState(track.lyrics ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const saved = await musicApi.tracks.saveLyrics(track.id, text.trim() ? text : null)
      toast.success(text.trim() ? 'Lyrics saved' : 'Lyrics cleared')
      onSaved(saved)
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={track.title} onClose={onClose} width="max-w-3xl">
      <div className="space-y-5">
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-white/30">
            {album.title}
            {track.track_number ? ` · Track ${String(track.track_number).padStart(2, '0')}` : ''}
          </p>
          {track.lyrics_source && <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-white/20">Source · {track.lyrics_source}</p>}
        </div>

        <textarea
          value={text}
          onChange={event => setText(event.target.value)}
          rows={18}
          spellCheck={false}
          placeholder={'Paste or type the lyrics for this track.'}
          className="w-full bg-noir-950/60 border border-white/10 rounded-xl px-5 py-4 text-sm text-white/90 leading-relaxed
            placeholder:text-white/20 focus:outline-none focus:border-[#FF2D78]/50 transition-colors resize-y font-mono"
        />

        <div className="flex items-center justify-between gap-4">
          <p className="text-[9px] font-mono uppercase tracking-[0.2em] text-white/20">No lyrics provider is connected yet</p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2.5 rounded-lg border border-white/10 bg-white/[0.03] text-[9px] font-bold uppercase tracking-[0.12em] text-white/50 hover:text-white/80 hover:bg-white/[0.07] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#FF2D78] text-noir-950 text-[9px] font-bold uppercase tracking-[0.12em] hover:bg-[#FF2D78]/80 transition-colors disabled:opacity-40"
            >
              {saving && <Spinner className="h-3 w-3" />}
              Save lyrics
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function MusicLibrary({ editMode = false }: { editMode?: boolean } = {}) {
  const [artists, setArtists] = useState<Artist[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [collectionFilter, setCollectionFilter] = useState<MusicCollectionFilter>('all')
  const [lastRedirect, setLastRedirect] = useState(0)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deleting, _setDeleting] = useState(false)
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

  // Cancels the previous load so a slow response from the old tab cannot land.
  const nextSignal = useAbortController()

  const refresh = (showLoading = true) => {
    if (showLoading) setLoading(true)
    musicApi.artists
      .list(nextSignal())
      .then(setArtists)
      .catch(err => {
        if (!isAbortError(err)) console.error(err)
      })
      .finally(() => {
        if (showLoading) setLoading(false)
      })
  }

  useEffect(() => {
    if (!activeTabId) {
      setArtists([])
      setLoading(false)
      return
    }
    const current = tabs.find(t => t.id === activeTabId)
    if (current && current.media_type !== 'music') return
    setArtists([])
    refresh(true)
    return subscribeActivity(() => refresh(false), 5000)
  }, [activeTabId, tabs])

  const filtered = artists.filter(a => {
    const matchesSearch = !search || a.name.toLowerCase().includes(search.toLowerCase())
    if (!matchesSearch) return false

    const isAcquiring = (a.acquiring_albums || 0) > 0
    const isCollected = !isAcquiring && (a.album_count ? (a.downloaded_albums || 0) >= a.album_count : true)
    const isMissing = !isAcquiring && (a.album_count || 0) > 0 && (!a.downloaded_albums || a.downloaded_albums === 0)

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
      <PageHeader
        accent={MUSIC_ACCENT}
        accentClass="text-[#FF2D78]"
        subtitleClass="text-[#FF2D78]"
        title={<>MUSIC{activeName && activeName.toLowerCase() !== 'main' ? <span className="text-white/20 ml-4">({activeName.toUpperCase()})</span> : ''}</>}
        subtitle={
          <>
            <span className="text-white">{artists.length}</span> {artists.length === 1 ? 'artist' : 'artists'} in library
            {artists.length > 0 &&
              (() => {
                const acquiring = artists.filter(a => (a.acquiring_albums || 0) > 0).length
                const collected = artists.filter(
                  a => (a.acquiring_albums || 0) === 0 && (a.album_count ? (a.downloaded_albums || 0) >= a.album_count : true),
                ).length
                const missing = artists.filter(
                  a => (a.acquiring_albums || 0) === 0 && (a.album_count || 0) > 0 && (!a.downloaded_albums || a.downloaded_albums === 0),
                ).length
                return (
                  <>
                    {' '}
                    | <span className="text-white">{collected}</span> {collected === 1 ? 'artist' : 'artists'} Collected |{' '}
                    <span className="text-white">{missing}</span> {missing === 1 ? 'artist' : 'artists'} Missing
                    {acquiring > 0 ? (
                      <>
                        {' '}
                        | <span className="text-white">{acquiring}</span> {acquiring === 1 ? 'artist' : 'artists'} Acquiring
                      </>
                    ) : (
                      ''
                    )}
                  </>
                )
              })()}
          </>
        }
        tabs={MUSIC_TABS}
      />

      <div className="flex flex-col gap-4 mb-8">
        <div className="bg-noir-900/50 border border-white/5 rounded-3xl overflow-hidden backdrop-blur-sm">
          <div className="p-4 flex flex-col md:flex-row items-stretch gap-3">
            <LibraryStatusDropdown value={collectionFilter} onChange={setCollectionFilter} accentColor="#FF2D78" />
            <SearchInput value={search} onChange={setSearch} placeholder="Search library..." className="min-w-0 flex-1 [&>input]:h-full" />
          </div>
        </div>
        {editMode && (
          <SelectionBar
            totalCount={filtered.length}
            selectedCount={selected.size}
            onSelectAll={() => setSelected(new Set(filtered.map(a => a.id)))}
            onSelectNone={() => setSelected(new Set())}
            deleting={deleting}
            onDone={() => navigate('/music')}
            onDelete={async () => {
              if (!(await confirmDialog(`Delete ${selected.size} artist(s) and all associated files?`))) return
              // Remove from the grid immediately; delete on the backend in the
              // background and roll back if anything fails.
              const ids = new Set(selected)
              const snapshot = artists
              setSelected(new Set())
              setArtists(prev => prev.filter(a => !ids.has(a.id)))
              try {
                await Promise.all([...ids].map(id => musicApi.artists.delete(id)))
              } catch (err) {
                toast.error(String(err))
                setArtists(snapshot)
              }
            }}
          />
        )}
      </div>

      {loading ? (
        <PosterSkeleton />
      ) : filtered.length === 0 ? (
        <EmptyState icon="artist" title="NO ARTISTS FOUND" subtitle="Add your first artist to begin" />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((a, i) => (
            <div key={a.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i * 25, 300)}ms`, animationFillMode: 'both' }}>
              <LibraryCard
                onClick={() => navigate(`/music/${a.id}`)}
                image={tmdbImage(a.image_url)}
                title={a.name}
                subtitle={
                  (a.acquiring_albums || 0) > 0
                    ? `${a.acquiring_albums} OF ${a.album_count || 0} ACQUIRING`
                    : `${a.downloaded_albums || 0}/${a.album_count || 0} ALBUMS`
                }
                status={
                  (a.acquiring_albums || 0) > 0
                    ? 'acquiring'
                    : a.downloaded_albums && a.album_count && a.downloaded_albums >= a.album_count
                      ? 'collected'
                      : 'missing'
                }
                accentColor="#FF2D78"
                fallbackIcon="artist"
                aspect="aspect-square"
                selectionMode={editMode}
                selected={selected.has(a.id)}
                onSelect={() =>
                  setSelected(prev => {
                    const next = new Set(prev)
                    if (next.has(a.id)) next.delete(a.id)
                    else next.add(a.id)
                    return next
                  })
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function MusicPage() {
  return (
    <Routes>
      <Route index element={<MusicLibrary />} />
      <Route path="add" element={<AddMusicPage />} />
      <Route path="edit" element={<MusicLibrary editMode />} />
      <Route path=":id" element={<ArtistDetailPage onDelete={() => {}} />} />
    </Routes>
  )
}

// ── Add Music Page ────────────────────────────────────────────────────────────

export const MUSIC_RELEASE_TYPES = ['Album', 'EP', 'Single', 'Live', 'Compilation', 'Broadcast', 'Other']

/**
 * Release-type picker, shared by the add flow and the artist page so the choice
 * made when adding can be revisited later.
 */
function TypeModal({
  artist,
  onClose,
  onConfirm,
  isAdding,
  initialTypes,
  title,
  confirmLabel,
  description,
  offerRestore,
  artistId,
}: {
  artist: any
  onClose: () => void
  onConfirm: (types: string[], restoreRemoved: boolean, selectedAlbumIds?: string[]) => void
  isAdding: boolean
  initialTypes?: string[]
  title?: string
  confirmLabel?: string
  description?: string
  /** Only meaningful for an artist already in the library. */
  offerRestore?: boolean
  /** Supplied for an artist already in the library; enables the album step. */
  artistId?: number
}) {
  const [selectedTypes, setSelectedTypes] = useState<string[]>(initialTypes?.length ? initialTypes : ['Album', 'EP'])
  const [restoreRemoved, setRestoreRemoved] = useState(false)
  const [step, setStep] = useState<'types' | 'albums'>('types')
  const [candidates, setCandidates] = useState<ReleaseCandidate[]>([])
  const [chosenAlbums, setChosenAlbums] = useState<Set<string>>(new Set())
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const types = MUSIC_RELEASE_TYPES

  // Only an artist already in the library has albums to choose between.
  const canPickAlbums = typeof artistId === 'number'

  const openAlbumStep = async () => {
    if (!canPickAlbums) return
    setLoadingCandidates(true)
    try {
      const { candidates: found } = await musicApi.artists.releaseCandidates(artistId, selectedTypes)
      setCandidates(found)
      // Prefill from what the library holds. "Restore all" instead starts from
      // everything, so the toggle chooses the starting point and the list has
      // the final say.
      setChosenAlbums(
        new Set(found.filter(c => c.locked || c.inLibrary || (restoreRemoved && c.removed)).map(c => c.musicbrainzId)),
      )
      setStep('albums')
    } catch (err) {
      toast.error(`Could not load albums: ${String(err)}`)
    } finally {
      setLoadingCandidates(false)
    }
  }

  return (
    <Modal title={title ?? `Add ${artist.name}`} onClose={onClose}>
      <div className="space-y-6">
        {step === 'types' ? (
          <>
            <p className="text-sm text-white/60">{description ?? 'Which release types should we monitor for this artist?'}</p>
            <div className="grid grid-cols-2 gap-2">
              {types.map(t => (
                <button
                  key={t}
                  onClick={() => setSelectedTypes(prev => (prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]))}
                  className={`px-4 py-2 rounded-xl text-[10px] font-bold tracking-widest uppercase transition-all border ${
                    selectedTypes.includes(t)
                      ? 'bg-[#FF2D78]/20 border-[#FF2D78]/40 text-[#FF2D78]'
                      : 'bg-noir-900 border-white/5 text-white/30 hover:border-white/10'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            {offerRestore && (
              <button
                type="button"
                onClick={() => setRestoreRemoved(value => !value)}
                aria-pressed={restoreRemoved}
                className="flex w-full items-start gap-3 rounded-xl border border-white/5 bg-noir-900 p-3 text-left transition-colors hover:border-white/10"
              >
                <span
                  aria-hidden="true"
                  className={`mt-0.5 h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors ${restoreRemoved ? 'bg-[#FF2D78]/70' : 'bg-white/10'}`}
                >
                  <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${restoreRemoved ? 'translate-x-3' : ''}`} />
                </span>
                <span className="space-y-1">
                  <span className="block text-[10px] font-bold uppercase tracking-widest text-white/70">
                    {restoreRemoved ? 'Start from all releases' : 'Start from current selection'}
                  </span>
                  <span className="block text-[10px] font-mono leading-relaxed text-white/30">
                    {restoreRemoved
                      ? 'Ticks every release for the selected types, including albums you removed.'
                      : 'Ticks what the library already holds. Albums you removed stay unticked.'}
                  </span>
                </span>
              </button>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-white/60">
              Which albums should Archivist keep? Unticking one removes it from the library.
            </p>
            <div className="flex items-center justify-between gap-4">
              <span className="font-mono text-[10px] uppercase tracking-widest text-white/30">
                {chosenAlbums.size} of {candidates.length} selected
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setChosenAlbums(new Set(candidates.map(c => c.musicbrainzId)))}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest text-white/40 transition-colors hover:text-white/80"
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => setChosenAlbums(new Set(candidates.filter(c => c.locked).map(c => c.musicbrainzId)))}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest text-white/40 transition-colors hover:text-white/80"
                >
                  None
                </button>
              </div>
            </div>
            {candidates.length === 0 ? (
              <p className="py-8 text-center font-mono text-[10px] uppercase tracking-widest text-white/30">
                No albums for the selected types
              </p>
            ) : (
              <div className="max-h-[48vh] space-y-2 overflow-y-auto pr-2 custom-scrollbar" role="list">
                {candidates.map(candidate => {
                  const chosen = chosenAlbums.has(candidate.musicbrainzId)
                  return (
                    <button
                      key={candidate.musicbrainzId}
                      type="button"
                      role="listitem"
                      disabled={candidate.locked}
                      aria-pressed={chosen}
                      onClick={() =>
                        setChosenAlbums(prev => {
                          const next = new Set(prev)
                          if (next.has(candidate.musicbrainzId)) next.delete(candidate.musicbrainzId)
                          else next.add(candidate.musicbrainzId)
                          return next
                        })
                      }
                      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                        chosen ? 'border-[#FF2D78]/40 bg-[#FF2D78]/10' : 'border-white/5 bg-noir-900 hover:border-white/10'
                      } ${candidate.locked ? 'cursor-not-allowed opacity-60' : ''}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`h-3.5 w-3.5 shrink-0 rounded border ${chosen ? 'border-[#FF2D78] bg-[#FF2D78]' : 'border-white/20'}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-bold text-white/80">{candidate.title}</span>
                        <span className="block font-mono text-[9px] uppercase tracking-widest text-white/30">
                          {[candidate.albumType, candidate.year ?? null].filter(Boolean).join(' \u00b7 ')}
                        </span>
                      </span>
                      {candidate.locked ? (
                        <span className="shrink-0 font-mono text-[8px] uppercase tracking-widest text-emerald-400/70">Collected</span>
                      ) : candidate.removed ? (
                        <span className="shrink-0 font-mono text-[8px] uppercase tracking-widest text-white/25">Removed</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}
        <div className="flex items-center justify-between pt-4 border-t border-white/5">
          <button
            onClick={step === 'albums' ? () => setStep('types') : onClose}
            className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest"
          >
            {step === 'albums' ? 'Back' : 'Cancel'}
          </button>
          {step === 'types' && canPickAlbums ? (
            <button
              onClick={() => void openAlbumStep()}
              disabled={loadingCandidates || selectedTypes.length === 0}
              className="px-8 py-2.5 rounded-xl bg-[#FF2D78] text-white font-bold text-xs uppercase tracking-widest transition-all shadow-xl disabled:opacity-50"
            >
              {loadingCandidates ? 'Loading\u2026' : 'Choose albums'}
            </button>
          ) : (
            <button
              onClick={() => onConfirm(selectedTypes, restoreRemoved, step === 'albums' ? [...chosenAlbums] : undefined)}
              disabled={isAdding}
              className="px-8 py-2.5 rounded-xl bg-[#FF2D78] text-white font-bold text-xs uppercase tracking-widest transition-all shadow-xl disabled:opacity-50"
            >
              {isAdding ? 'Working\u2026' : (confirmLabel ?? 'Confirm Add')}
            </button>
          )}
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
    if (!query.trim()) {
      setResults([])
      return
    }
    timer.current = setTimeout(async () => {
      setSearching(true)
      try {
        const items = await musicApi.lookup(query)
        setResults(items)
      } catch {
      } finally {
        setSearching(false)
      }
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
      toast.error(String(err))
      setAdded(prev => {
        const next = new Set(prev)
        next.delete(artist.mbid)
        return next
      })
    })
  }

  return (
    <div className="animate-fade-in pb-20">
      <div className="mb-8 flex items-center gap-4">
        <button
          onClick={() => navigate('/music')}
          className="inline-flex items-center gap-2 text-white/30 hover:text-white transition-all text-sm font-mono uppercase tracking-widest"
        >
          <PackIcon name="chevron-left" size={13} />
          Back
        </button>
        <div className="h-4 w-px bg-white/10" />
        <h1 className="font-display text-3xl tracking-widest text-[#FF2D78]">ADD ARTIST</h1>
      </div>

      <div className="max-w-xl mb-12">
        <SearchInput value={query} onChange={setQuery} placeholder="Search MusicBrainz for an artist..." autoFocus />
      </div>

      {searching ? (
        <PosterSkeleton count={12} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {results.map((item: any) => {
            const isAdded = added.has(item.mbid) || item.alreadyAdded
            return (
              <div
                key={item.mbid}
                className="animate-slide-up"
                style={{ animationDelay: `${Math.min(results.indexOf(item) * 25, 300)}ms`, animationFillMode: 'both' }}
              >
                <LibraryCard
                  onClick={() => setDetailArtist(item)}
                  image={tmdbImage(item.imageUrl)}
                  title={item.name}
                  subtitle={item.disambiguation || 'Artist'}
                  accentColor="#FF2D78"
                  fallbackIcon="artist"
                  aspect="aspect-square"
                  badge={
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        !isAdded && setAdding(item)
                      }}
                      disabled={isAdded}
                      className={`px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-widest border transition-all ${isAdded ? 'bg-green-500/10 border-green-500/20 text-green-500' : 'bg-noir-950/60 border-white/10 text-white hover:bg-white/10'}`}
                    >
                      {isAdded ? (
                        <span className="inline-flex items-center gap-1.5">
                          <PackIcon name="check" size={12} />
                          In Library
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <PackIcon name="add" size={12} />
                          Add
                        </span>
                      )}
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
          fallbackIcon="artist"
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

      {adding && <TypeModal artist={adding} onClose={() => setAdding(null)} onConfirm={handleAdd} isAdding={false} />}
    </div>
  )
}
