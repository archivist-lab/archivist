import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ArchivistSdk, EpisodeSummary, SeriesDetail } from '../lib/sdk.js'
import type { RatingSubjectType, ResolvedRating, SeriesRatingTree } from '@archivist/contracts'
import { Level } from '@archivist/design-system'
import { playerStore, removeProgress, saveProgress, useProgress } from '../lib/store.js'
import { WatchedCheck } from '../components/Cards.js'
import type { PlayTarget } from '../components/Player.js'
import { DetailAction, DetailDock, DetailHero, DetailSection, MetadataPill, PeopleRow, RecommendationRow, detailPrimaryActionClass } from '../components/DetailSurface.js'
import { MediaSelector, type DetailTrackSelection } from '../components/MediaSelector.js'
import { PlayerIcon } from '../components/Icons.js'
import { useDialogFocus } from '../focus/useDialogFocus.js'

export function SeriesDetailPage({ sdk, v2 = false }: { sdk: ArchivistSdk; v2?: boolean }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [series, setSeries] = useState<SeriesDetail | null>(null)
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null)
  const [episodeInfo, setEpisodeInfo] = useState<EpisodeSummary | null>(null)
  const [showWatched, setShowWatched] = useState(false)
  const [nextTrackSelection, setNextTrackSelection] = useState<DetailTrackSelection>({})
  const [ratingTree, setRatingTree] = useState<SeriesRatingTree | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const episodeOriginRef = useRef<HTMLElement | null>(null)
  const progress = useProgress()

  const load = () => sdk.seriesDetail(Number(id)).then(value => { setSeries(value); setSeasonNumber(current => current ?? value.seasons.find(season => season.episodes.some(episode => episode.hasFile))?.seasonNumber ?? value.seasons[0]?.seasonNumber ?? null) }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  useEffect(() => { void load() }, [sdk, id])
  const loadRatings = () => typeof sdk.ratingTree === 'function' ? sdk.ratingTree(Number(id)).then(setRatingTree).catch(() => {}) : Promise.resolve()
  useEffect(() => { void loadRatings() }, [sdk, id])
  useEffect(() => { setShowWatched(false) }, [id])
  useEffect(() => { if (series && v2) requestAnimationFrame(() => primaryRef.current?.focus()) }, [series?.id, v2])
  useEffect(() => { setNextTrackSelection({}) }, [series?.nextAvailable?.id])
  if (error) return <p role="alert" className="player-safe text-pink">{error}</p>
  if (!series) return <div className="player-safe player-skeleton text-sm uppercase tracking-[.25em] text-white/30">Opening series</div>

  const rows = ['cast','crew','seasons','episodes','recommendations'] as const
  const ratings = series.ratings ?? []
  const actions = ['play','trailer','mark-watched','information'] as const
  const seasons = series.seasons.filter(season => season.episodes.length > 0)
  const active = seasons.find(season => season.seasonNumber === seasonNumber) ?? seasons[0]
  const activeWatchedCount = active?.episodes.filter(episode => progress[`episode:${episode.id}`]?.completed).length ?? 0
  const visibleEpisodes = active?.episodes.filter(episode => showWatched || !progress[`episode:${episode.id}`]?.completed) ?? []
  const allEpisodes = seasons.flatMap(season => season.episodes)
  const playable = allEpisodes.filter(episode => episode.playback)
  const episodeTarget = (episode: EpisodeSummary | null | undefined, trackSelection: DetailTrackSelection = {}): PlayTarget | null => episode?.playback ? ({
    key: `episode:${episode.id}`, type: 'episode', id: episode.id, title: episode.title ?? `Episode ${episode.episodeNumber}`,
    posterUrl: series.posterUrl, backdropUrl: episode.stillUrl ?? series.backdropUrl, streamUrl: episode.playback.streamUrl,
    seriesId: series.id, seriesTitle: series.title, plot: episode.overview, cast: series.cast ?? [], recommendations: series.recommendations ?? [],
    ...(trackSelection.audioIndex === undefined ? {} : { initialAudioIndex: trackSelection.audioIndex }),
    ...(trackSelection.subtitleIndex === undefined ? {} : { initialSubtitleIndex: trackSelection.subtitleIndex }),
  }) : null
  const playEpisode = (episode: EpisodeSummary, trackSelection: DetailTrackSelection = {}) => { const target = episodeTarget(episode, trackSelection); if (target) { const index = playable.findIndex(item => item.id === episode.id); setEpisodeInfo(null); playerStore.dispatch({ type: 'PLAYBACK_STARTED', target, nextTarget: episodeTarget(playable[index + 1]) }) } }
  const next = series.nextAvailable
  const setWatched = (episode: EpisodeSummary, watched: boolean) => {
    const key = `episode:${episode.id}`
    if (!watched) { removeProgress(key); void sdk.deleteProgress('episode', episode.id); return }
    const durationSeconds = episode.runtimeSeconds ?? progress[key]?.durationSeconds ?? 1
    const target = episodeTarget(episode)
    saveProgress({ key, type: 'episode', id: episode.id, title: episode.title ?? 'Episode', posterUrl: series.posterUrl, backdropUrl: episode.stillUrl ?? series.backdropUrl, streamUrl: target?.streamUrl ?? '', seriesId: series.id, seriesTitle: series.title, positionSeconds: durationSeconds, durationSeconds, completed: true })
    void sdk.saveProgress({ type: 'episode', id: episode.id, positionSeconds: durationSeconds, durationSeconds, completed: true })
  }
  const setManyWatched = (episodes: EpisodeSummary[]) => { const shouldWatch = !episodes.every(episode => progress[`episode:${episode.id}`]?.completed); episodes.forEach(episode => setWatched(episode, shouldWatch)); setMessage(shouldWatch ? 'Marked watched' : 'Marked unwatched') }
  const refresh = async () => { const result = await sdk.refreshSeriesMetadata(series.id); setMessage(result.queued ? 'Metadata refresh queued' : 'Metadata refresh already queued') }
  const openEpisode = (episode: EpisodeSummary) => { episodeOriginRef.current = document.activeElement as HTMLElement | null; setEpisodeInfo(episode) }
  const closeEpisode = () => { setEpisodeInfo(null); requestAnimationFrame(() => (episodeOriginRef.current?.isConnected ? episodeOriginRef.current : document.querySelector<HTMLElement>('[data-focus-id="series-show-watched"]'))?.focus()) }
  const commitRating = async (type: RatingSubjectType, subjectId: number, value: number | null) => { if (value == null) await sdk.clearRating(type, subjectId); else await sdk.setRating(type, subjectId, value); await loadRatings() }
  const ratingFor = (type: RatingSubjectType, subjectId: number): ResolvedRating => { const empty: ResolvedRating = { value: null, source: 'none', inheritedFrom: null, scaleMax: 5 }; if (type === 'series') return ratingTree?.series.rating ?? empty; if (type === 'season') return ratingTree?.seasons.find(entry => entry.season.subject.id === subjectId)?.season.rating ?? empty; return ratingTree?.seasons.flatMap(entry => entry.episodes).find(entry => entry.subject.id === subjectId)?.rating ?? empty }
  const meta = <><span>{series.year ?? 'Year unknown'}</span>{series.certification && <MetadataPill>{series.certification}</MetadataPill>}{series.network && <span>{series.network}</span>}<span>{series.availableEpisodeCount}/{series.episodeCount} available</span>{series.seriesStatus && <MetadataPill>{series.seriesStatus}</MetadataPill>}</>

  return <div data-route-scroll={v2 || undefined} className={`motion-fade pb-24 ${v2 ? 'h-full overflow-y-auto no-scrollbar' : ''}`}>
    <DetailHero sdk={sdk} title={series.title} logoUrl={series.logoUrl} posterUrl={series.posterUrl} backdropUrl={series.backdropUrl} artworkUrls={series.artworkUrls} cycleSeconds={0} eyebrow="Series" metadata={meta} overview={series.overview} ratings={ratings}>
      {actions.includes('play') && <button ref={primaryRef} onClick={() => next && playEpisode(next, nextTrackSelection)} disabled={!next?.playback} className={detailPrimaryActionClass}><PlayerIcon name="play" size={18} />{next ? `S${String(next.seasonNumber).padStart(2,'0')}E${String(next.episodeNumber).padStart(2,'0')}` : 'Play'}</button>}
      {actions.includes('trailer') && series.trailerUrl && <DetailAction icon="trailer" onClick={() => window.open(series.trailerUrl!, '_blank', 'noopener,noreferrer')}>Trailer</DetailAction>}
      {actions.includes('mark-watched') && <DetailAction icon="watched" onClick={() => setManyWatched(allEpisodes)}>Toggle series watched</DetailAction>}
      {actions.includes('information') && <DetailAction icon="refresh" onClick={() => void refresh()}>Refresh metadata</DetailAction>}
    </DetailHero>

    {next && <DetailDock><div className="min-w-60 max-w-sm"><p className="archivist-section-label player-accent">Up next</p><p className="mt-1.5 truncate font-mono text-[10px] uppercase tracking-[.1em] text-white/68">S{String(next.seasonNumber).padStart(2,'0')}E{String(next.episodeNumber).padStart(2,'0')} · {next.title ?? 'Episode'}</p></div><MediaSelector sdk={sdk} type="episodes" id={next.id} title={`${series.title} · ${next.title ?? `Episode ${next.episodeNumber}`}`} selection={nextTrackSelection} onChange={setNextTrackSelection} disabled={!next.playback} /></DetailDock>}

    <DetailSection title="Your ratings" subtitle="Specificity wins"><div className="space-y-5 rounded-2xl border border-white/[.07] bg-black/20 p-5"><div className="flex flex-wrap items-center gap-5"><div className="min-w-40"><p className="font-bebas text-lg text-white/85">{series.title}</p><p className="archivist-section-label mt-1">Series</p></div><Level title={series.title} rating={ratingFor('series', series.id)} onCommit={value => commitRating('series', series.id, value)} accent="var(--archivist-series)" showSource /></div>{active && <div className="flex flex-wrap items-center gap-5 border-t border-white/[.07] pt-5"><div className="min-w-40"><p className="font-bebas text-lg text-white/85">{active.title}</p><p className="archivist-section-label mt-1">Season {active.seasonNumber}</p></div><Level title={active.title} rating={ratingFor('season', active.id)} onCommit={value => commitRating('season', active.id, value)} accent="var(--archivist-series)" showSource /></div>}</div></DetailSection>

    {rows.includes('seasons') && <DetailSection title="Seasons" subtitle={`${seasons.length} seasons`}><div className="no-scrollbar flex gap-5 overflow-x-auto pb-5">{seasons.map(season => { const watched = season.episodes.filter(episode => progress[`episode:${episode.id}`]?.completed).length; const selected = active?.id === season.id; return <button key={season.id} aria-pressed={selected} onClick={() => setSeasonNumber(season.seasonNumber)} className={`player-focusable group w-40 shrink-0 rounded-2xl p-2 text-left transition ${selected ? 'player-accent-soft ring-1 player-accent-border' : 'hover:bg-white/5'}`}><div className="aspect-[2/3] overflow-hidden rounded-xl bg-white/[.035] shadow-xl ring-1 ring-white/8">{season.posterUrl ? <img src={sdk.asset(season.posterUrl)} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]" /> : series.posterUrl && <img src={sdk.asset(series.posterUrl)} alt="" className="h-full w-full object-cover opacity-55" />}</div><div className="px-1 pb-1"><p className="mt-3 truncate font-bebas text-[15px] tracking-[.02em] text-white/82">{season.title}</p><div className="mt-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.08em] text-white/34"><span>{watched}/{season.episodes.length} watched</span>{watched === season.episodes.length && season.episodes.length > 0 && <WatchedCheck />}</div></div></button> })}</div></DetailSection>}

    {rows.includes('episodes') && active && <DetailSection title={active.title} subtitle={`${active.episodes.length - activeWatchedCount} unwatched · ${activeWatchedCount} watched`}>
      <div className="rounded-2xl border border-white/[.07] bg-[#0d0d13]/72 px-[clamp(1rem,2.2vw,2rem)] py-6">
        <div className="mb-7 flex flex-wrap items-start gap-6 border-b border-white/8 pb-6">
          <div className="min-w-0 max-w-4xl flex-1"><p className="archivist-section-label player-accent">Season {active.seasonNumber}</p>{active.overview && <p className="mt-3 text-sm leading-[1.7] text-white/48">{active.overview}</p>}</div>
          <div className="ml-auto flex flex-wrap gap-3"><button type="button" data-focus-id="series-show-watched" aria-pressed={showWatched} onClick={() => setShowWatched(value => !value)} className={`player-focusable rounded-xl border border-white/8 px-5 py-3 font-mono text-[10px] font-semibold uppercase tracking-[.1em] ${showWatched ? 'bg-white text-black' : 'bg-white/8 text-white/72'}`}>Show watched: {showWatched ? 'On' : 'Off'}</button><DetailAction onClick={() => setManyWatched(active.episodes)}>Toggle season watched</DetailAction></div>
        </div>
        <div className="space-y-2">{visibleEpisodes.map(episode => <EpisodeRow key={episode.id} sdk={sdk} episode={episode} progress={progress[`episode:${episode.id}`]} onPlay={() => playEpisode(episode)} onInfo={() => openEpisode(episode)} />)}
          {!visibleEpisodes.length && <div className="rounded-xl border border-dashed border-white/12 px-8 py-12 text-center"><p className="font-bebas text-xl tracking-[.02em] text-white/65">All episodes in this season are watched</p><p className="mt-2 text-sm text-white/38">Turn on Show watched to see them again.</p><button type="button" onClick={() => setShowWatched(true)} className="player-focusable mt-5 rounded-xl bg-white px-5 py-3 font-mono text-[10px] font-bold uppercase tracking-[.1em] text-black">Show watched episodes</button></div>}
        </div>
      </div>
    </DetailSection>}
    {rows.includes('cast') && (series.cast?.length ?? 0) > 0 && <DetailSection title="Cast"><PeopleRow sdk={sdk} people={series.cast} onOpen={person => person.id && navigate(`/person/${person.id}`)} /></DetailSection>}
    {rows.includes('crew') && (series.crew?.length ?? 0) > 0 && <DetailSection title="Crew"><PeopleRow sdk={sdk} people={series.crew} onOpen={person => person.id && navigate(`/person/${person.id}`)} /></DetailSection>}
    {rows.includes('recommendations') && (series.recommendations?.length ?? 0) > 0 && <DetailSection title="More like this" subtitle="From your library"><RecommendationRow sdk={sdk} items={series.recommendations} /></DetailSection>}

    {episodeInfo && <EpisodeDialog sdk={sdk} series={series} episode={episodeInfo} rating={ratingFor('episode', episodeInfo.id)} onRate={value => commitRating('episode', episodeInfo.id, value)} progress={progress[`episode:${episodeInfo.id}`]} onClose={closeEpisode} onPlay={selection => playEpisode(episodeInfo, selection)} onToggleWatched={() => setWatched(episodeInfo, !progress[`episode:${episodeInfo.id}`]?.completed)} />}
    {message && <div role="status" className="fixed bottom-8 right-8 z-[120] rounded-xl bg-white px-5 py-3 text-black shadow-2xl">{message}</div>}
  </div>
}

function EpisodeRow({ sdk, episode, progress, onPlay, onInfo }: { sdk: ArchivistSdk; episode: EpisodeSummary; progress?: { completed: boolean; positionSeconds: number; durationSeconds: number }; onPlay: () => void; onInfo: () => void }) {
  const percent = progress ? progress.completed ? 100 : progress.positionSeconds / Math.max(progress.durationSeconds, 1) * 100 : 0
  const label = `S${String(episode.seasonNumber).padStart(2,'0')}E${String(episode.episodeNumber).padStart(2,'0')} ${episode.title ?? 'Episode'}`
  return (
    <button aria-label={label} onClick={onInfo} onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); onInfo() } }}
      className="player-focusable group flex w-full items-center gap-5 rounded-xl border border-transparent p-3 text-left hover:border-white/[.07] hover:bg-white/[.035]">
      <div className="relative aspect-video w-[clamp(145px,16vw,240px)] shrink-0 overflow-hidden rounded-lg bg-white/[.035]">
        {episode.stillUrl && <img src={sdk.asset(episode.stillUrl)} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />}
        {episode.hasFile && <span onClick={event => { event.stopPropagation(); onPlay() }} className="absolute inset-0 grid place-items-center bg-black/25 opacity-0 transition group-hover:opacity-100"><span className="grid h-11 w-11 place-items-center rounded-xl bg-white text-black"><PlayerIcon name="play" size={22} /></span></span>}
        {percent > 0 && percent < 100 && <progress value={percent} max={100} className="player-progress absolute inset-x-0 bottom-0 h-1 w-full" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3"><span className="font-mono text-[9.5px] font-semibold tracking-[.1em] player-accent">{String(episode.episodeNumber).padStart(2,'0')}</span><h3 className="truncate font-bebas text-[17px] tracking-[.02em] text-white/82">{episode.title ?? `Episode ${episode.episodeNumber}`}</h3>{percent >= 100 && <WatchedCheck />}</div>
        <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-white/46">{episode.overview || 'No overview available.'}</p>
        <p className="mt-2 font-mono text-[9px] uppercase tracking-[.08em] text-white/30">{episode.airAt ? new Date(episode.airAt).toLocaleString() : episode.airDate ?? 'Airdate unknown'}{episode.runtimeSeconds ? ` · ${Math.round(episode.runtimeSeconds / 60)} min` : ''}{episode.quality?.resolution ? ` · ${episode.quality.resolution}` : ''}</p>
      </div>
    </button>
  )
}

function EpisodeDialog({ sdk, series, episode, rating, onRate, progress, onClose, onPlay, onToggleWatched }: { sdk: ArchivistSdk; series: SeriesDetail; episode: EpisodeSummary; rating: ResolvedRating; onRate: (value: number | null) => void | Promise<void>; progress?: { completed: boolean; positionSeconds: number; durationSeconds: number }; onClose: () => void; onPlay: (selection: DetailTrackSelection) => void; onToggleWatched: () => void }) {
  const [trackSelection, setTrackSelection] = useState<DetailTrackSelection>({})
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose)
  const episodeCode = 'S' + String(episode.seasonNumber).padStart(2, '0') + 'E' + String(episode.episodeNumber).padStart(2, '0')
  return (
    <div ref={dialogRef} className="fixed inset-0 z-[95] grid place-items-center bg-black/78 p-[var(--safe-x)]" role="dialog" aria-modal="true" aria-labelledby="episode-dialog-title" onClick={onClose}>
      <section className="player-dialog motion-dialog relative grid max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-2xl border-white/10 md:grid-cols-12" onClick={event => event.stopPropagation()}>
        <div className="relative min-h-64 overflow-hidden bg-white/[.025] md:col-span-5 md:min-h-[560px]">
          {(episode.stillUrl || series.backdropUrl) && <img src={sdk.asset(episode.stillUrl ?? series.backdropUrl)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" />}
          <div className="absolute inset-0 bg-gradient-to-t from-[#0d0d13] via-transparent to-black/15 md:bg-gradient-to-r md:from-transparent md:to-[#0d0d13]" />
          <div className="absolute bottom-5 left-5 rounded-lg border border-white/10 bg-black/55 px-3 py-2 font-mono text-[9.5px] uppercase tracking-[.12em] text-white/65">{episodeCode}</div>
        </div>
        <div className="no-scrollbar flex max-h-[88vh] flex-col overflow-y-auto p-[clamp(1.5rem,3vw,3rem)] md:col-span-7">
          <div className="flex items-start gap-5">
            <div className="min-w-0 flex-1">
              <p className="archivist-section-label player-accent">{series.title}</p>
              <h2 id="episode-dialog-title" className="mt-3 font-bebas text-[clamp(2rem,4vw,3.5rem)] leading-none tracking-[.02em] text-white">{episode.title ?? 'Episode'}</h2>
            </div>
            <button data-dialog-initial aria-label="Close episode information" onClick={onClose} className="player-focusable inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/8 bg-white/[.055] px-4 py-2.5 font-mono text-[9.5px] font-semibold uppercase tracking-[.1em] text-white/62"><PlayerIcon name="close" size={15} />Close</button>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3 font-mono text-[9.5px] uppercase tracking-[.08em] text-white/42"><span>{episode.airAt ? new Date(episode.airAt).toLocaleString() : episode.airDate}</span>{episode.runtimeSeconds && <span>{Math.round(episode.runtimeSeconds / 60)} min</span>}{episode.quality?.resolution && <MetadataPill>{episode.quality.resolution}</MetadataPill>}<span>{episode.hasFile ? 'Available' : 'Not available'}</span></div>
          <p className="mt-6 text-[12.5px] leading-[1.75] text-white/58">{episode.overview || 'No episode overview is available.'}</p>
          <div className="mt-7 border-t border-white/[.07] pt-6"><p className="archivist-section-label mb-4">Your rating</p><Level title={episode.title ?? episodeCode} rating={rating} onCommit={onRate} accent="var(--archivist-series)" showSource /></div>
          <div className="mt-7 border-t border-white/[.07] pt-6"><MediaSelector sdk={sdk} type="episodes" id={episode.id} title={series.title + ' · ' + (episode.title ?? 'Episode ' + episode.episodeNumber)} selection={trackSelection} onChange={setTrackSelection} disabled={!episode.playback} /></div>
          <div className="mt-auto flex flex-wrap gap-2.5 pt-7"><DetailAction icon="play" primary disabled={!episode.playback} onClick={() => onPlay(trackSelection)}>{progress && !progress.completed && progress.positionSeconds > 30 ? 'Resume' : 'Play'}</DetailAction><DetailAction icon="watched" onClick={onToggleWatched}>{progress?.completed ? 'Mark unwatched' : 'Mark watched'}</DetailAction></div>
        </div>
      </section>
    </div>
  )
}
