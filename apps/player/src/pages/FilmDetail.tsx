import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ArchivistSdk, FilmDetail } from '../lib/sdk.js'
import { playerStore, removeProgress, saveProgress, useProgress } from '../lib/store.js'
import type { PlayTarget } from '../components/Player.js'
import { DetailAction, DetailDock, DetailDrawer, DetailHero, DetailSection, MetadataPill, PeopleRow, RecommendationRow } from '../components/DetailSurface.js'
import { MediaSelector, type DetailTrackSelection } from '../components/MediaSelector.js'
import { PlayerIcon } from '../components/Icons.js'

export function FilmDetailPage({ sdk, v2 = false }: { sdk: ArchivistSdk; v2?: boolean }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [film, setFilm] = useState<FilmDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [trackSelection, setTrackSelection] = useState<DetailTrackSelection>({})
  const primaryRef = useRef<HTMLButtonElement>(null)
  const progress = useProgress()

  const load = () => sdk.film(Number(id)).then(setFilm).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  useEffect(() => { void load() }, [sdk, id])
  useEffect(() => { setTrackSelection({}) }, [id])
  useEffect(() => { if (film && v2) requestAnimationFrame(() => primaryRef.current?.focus()) }, [film?.id, v2])

  if (error) return <p role="alert" className="player-safe text-sm text-pink">{error}</p>
  if (!film) return <div className="player-safe player-skeleton text-sm uppercase tracking-[.25em] text-white/30">Opening film</div>

  const saved = progress[`film:${film.id}`]
  const resumable = !!saved && !saved.completed && saved.positionSeconds > 30 && saved.positionSeconds / Math.max(saved.durationSeconds, 1) < .95
  const rows = ['cast','crew','collection','gallery','recommendations'] as const
  const ratings = film.ratings ?? []
  const actions = ['play','trailer','mark-watched','information'] as const
  const target: PlayTarget | null = film.playback ? {
    key: `film:${film.id}`, type: 'film', id: film.id, title: film.title,
    posterUrl: film.posterUrl, backdropUrl: film.backdropUrl, streamUrl: film.playback.streamUrl, plot: film.overview, cast: film.cast ?? [], recommendations: film.recommendations ?? [],
    ...(trackSelection.audioIndex === undefined ? {} : { initialAudioIndex: trackSelection.audioIndex }),
    ...(trackSelection.subtitleIndex === undefined ? {} : { initialSubtitleIndex: trackSelection.subtitleIndex }),
  } : null
  const play = () => target && playerStore.dispatch({ type: 'PLAYBACK_STARTED', target })
  const restart = () => { removeProgress(`film:${film.id}`); void sdk.deleteProgress('film', film.id).catch(() => {}); play() }
  const toggleWatched = () => {
    if (saved?.completed) { removeProgress(`film:${film.id}`); void sdk.deleteProgress('film', film.id); return }
    const durationSeconds = film.runtimeSeconds ?? saved?.durationSeconds ?? 1
    saveProgress({ key: `film:${film.id}`, type: 'film', id: film.id, title: film.title, posterUrl: film.posterUrl, backdropUrl: film.backdropUrl, streamUrl: target?.streamUrl ?? '', positionSeconds: durationSeconds, durationSeconds, completed: true })
    void sdk.saveProgress({ type: 'film', id: film.id, positionSeconds: durationSeconds, durationSeconds, completed: true })
  }
  const selectEdition = async (editionId: number) => {
    await sdk.selectFilmEdition(film.id, editionId); setMessage('Edition selected'); await load()
  }
  const refresh = async () => { const result = await sdk.refreshFilmMetadata(film.id); setMessage(result.queued ? 'Metadata refresh queued' : 'Metadata refresh already queued'); setMoreOpen(false) }
  const meta = <><span>{film.year ?? 'Year unknown'}</span>{film.certification && <MetadataPill>{film.certification}</MetadataPill>}{film.runtimeSeconds && <span>{Math.round(film.runtimeSeconds / 60)} min</span>}{film.studio && <span>{film.studio}</span>}{film.quality?.resolution && <MetadataPill>{film.quality.resolution}</MetadataPill>}</>

  return <div data-route-scroll={v2 || undefined} className={`motion-fade pb-24 ${v2 ? 'h-full overflow-y-auto no-scrollbar' : ''}`}>
    <DetailHero sdk={sdk} title={film.title} logoUrl={film.logoUrl} posterUrl={film.posterUrl} backdropUrl={film.backdropUrl} artworkUrls={film.artworkUrls} cycleSeconds={0} eyebrow={film.originalTitle && film.originalTitle !== film.title ? film.originalTitle : 'Film'} metadata={meta} overview={film.overview} ratings={ratings}>
      {actions.includes('play') && <button ref={primaryRef} onClick={play} disabled={!target} className="player-focusable player-accent-bg inline-flex min-h-12 items-center gap-2 rounded-full px-8 py-3 text-sm font-bold disabled:opacity-35"><PlayerIcon name="play" size={18} />{resumable ? 'Resume' : 'Play'}</button>}
      {resumable && <DetailAction icon="restart" onClick={restart}>Restart</DetailAction>}
      {actions.includes('trailer') && film.trailerUrl && <DetailAction icon="trailer" onClick={() => window.open(film.trailerUrl!, '_blank', 'noopener,noreferrer')}>Trailer</DetailAction>}
      {actions.includes('mark-watched') && <DetailAction icon="watched" onClick={toggleWatched}>{saved?.completed ? 'Mark unwatched' : 'Mark watched'}</DetailAction>}
      {actions.includes('information') && <DetailAction icon="info" onClick={() => setMoreOpen(true)}>More</DetailAction>}
      {!target && <span className="text-sm text-white/42">No playable file</span>}
    </DetailHero>

    <DetailDock><div className="min-w-48"><p className="text-xs font-semibold uppercase tracking-[.18em] text-white/35">Ready to play</p><p className="mt-1 text-sm text-white/72">{film.file?.edition || film.quality?.resolution || 'Default edition'}</p></div><MediaSelector sdk={sdk} type="films" id={film.id} title={film.title} selection={trackSelection} onChange={setTrackSelection} disabled={!film.playback} /></DetailDock>

    {rows.includes('collection') && film.collection && <DetailSection title="Collection" subtitle="Part of a larger story"><button onClick={() => navigate(`/browse/films?collectionId=${film.collection!.id}`)} className="player-focusable relative flex min-h-44 w-full max-w-4xl items-end overflow-hidden rounded-3xl bg-white/5 p-7 text-left ring-1 ring-white/10">{film.collection.backdropUrl && <img src={sdk.asset(film.collection.backdropUrl)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-45" />}<div className="absolute inset-0 bg-gradient-to-r from-black/90 to-transparent" /><div className="relative flex w-full items-end"><div><p className="text-3xl font-semibold">{film.collection.name}</p><p className="mt-2 text-white/50">Browse every film in this collection</p></div><PlayerIcon name="chevron-right" size={26} className="ml-auto text-white/55" /></div></button></DetailSection>}
    {(film.editions?.length ?? 0) > 0 && <DetailSection title="Editions" subtitle="Choose the version used by Play"> <div className="flex flex-wrap gap-3">{film.editions.map(edition => <button key={edition.id} disabled={!edition.available} onClick={() => void selectEdition(edition.id)} className={`player-focusable min-w-48 rounded-2xl border p-4 text-left ${edition.isDefault ? 'player-accent-border player-accent-soft' : 'border-white/10 bg-white/5'} disabled:opacity-35`}><strong>{edition.name}</strong><p className="mt-1 text-xs text-white/45">{edition.available ? [edition.quality?.resolution, edition.runtimeSeconds ? `${Math.round(edition.runtimeSeconds / 60)} min` : null].filter(Boolean).join(' · ') || 'Available' : 'Not available'}</p></button>)}</div></DetailSection>}
    {rows.includes('cast') && (film.cast?.length ?? 0) > 0 && <DetailSection title="Cast"><PeopleRow sdk={sdk} people={film.cast} onOpen={person => person.id && navigate(`/person/${person.id}`)} /></DetailSection>}
    {rows.includes('crew') && (film.crew?.length ?? 0) > 0 && <DetailSection title="Crew"><PeopleRow sdk={sdk} people={film.crew} onOpen={person => person.id && navigate(`/person/${person.id}`)} /></DetailSection>}
    {rows.includes('gallery') && (film.backdropUrl || film.posterUrl) && <DetailSection title="Artwork"><div className="grid max-w-6xl grid-cols-[minmax(180px,1fr)_minmax(0,3fr)] gap-5">{film.posterUrl && <img src={sdk.asset(film.posterUrl)} alt="Poster" className="h-full max-h-96 w-full rounded-2xl object-cover ring-1 ring-white/10" />}{film.backdropUrl && <img src={sdk.asset(film.backdropUrl)} alt="Backdrop" className="h-full max-h-96 w-full rounded-2xl object-cover ring-1 ring-white/10" />}</div></DetailSection>}
    {rows.includes('recommendations') && (film.recommendations?.length ?? 0) > 0 && <DetailSection title="You may also like" subtitle="From your library"><RecommendationRow sdk={sdk} items={film.recommendations} /></DetailSection>}

    {moreOpen && <DetailDrawer title={film.title} eyebrow="Film information" onClose={() => setMoreOpen(false)} footer={<DetailAction onClick={() => void refresh()}>Refresh metadata</DetailAction>}><dl className="grid grid-cols-2 gap-x-8 gap-y-7 text-sm"><Info label="Release" value={film.releaseDate} /><Info label="Country" value={film.country} /><Info label="Studio" value={film.studio} /><Info label="Edition" value={film.file?.edition} /><Info label="Resolution" value={film.file?.resolution} /><Info label="Video codec" value={film.file?.videoCodec} /><Info label="File size" value={film.file?.sizeBytes ? formatBytes(film.file.sizeBytes) : null} /></dl>{film.overview && <section className="mt-9 border-t border-white/10 pt-7"><h3 className="font-semibold">Synopsis</h3><p className="mt-3 leading-relaxed text-white/55">{film.overview}</p></section>}</DetailDrawer>}
    {message && <div role="status" className="fixed bottom-8 right-8 z-[120] rounded-xl bg-white px-5 py-3 text-black shadow-2xl">{message}</div>}
  </div>
}

function Info({ label, value }: { label: string; value?: string | number | null }) { return <div><dt className="text-white/35">{label}</dt><dd className="mt-1 text-white/80">{value ?? 'Not available'}</dd></div> }
function formatBytes(bytes: number): string { const units = ['B','KB','MB','GB','TB']; let value = bytes, unit = 0; while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ } return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}` }
