import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ArchivistSdk, EpisodeSummary, SeriesDetail } from '../lib/sdk.js'
import type { RatingSubjectType, ResolvedRating, SeriesRatingTree } from '@archivist/contracts'
import { catalogueRating, Level } from '@archivist/design-system'
import { playerStore, removeProgress, saveProgress, useProgress } from '../lib/store.js'
import type { PlayTarget } from '../components/Player.js'
import { ItemView, ItemFacts, certificationTone, personImage, personRole, type ItemAction, type ItemRow } from '../components/ItemView.js'
import { ItemDialog, ItemToast } from '../components/ItemDialogs.js'
import { DetailAction, MetadataPill } from '../components/DetailSurface.js'
import { MediaSelector, type DetailTrackSelection } from '../components/MediaSelector.js'
import { PlayerIcon } from '../components/Icons.js'
import { useDialogFocus } from '../focus/useDialogFocus.js'

/** Mirrors the Library's --archivist-series token, resolved for the stage's rgb split. */
const SERIES_ACCENT = '#9b59b6'

type SeriesDialog = 'media' | 'ratings' | 'information'

const episodeCode = (episode: EpisodeSummary) =>
  `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`

export function SeriesDetailPage({ sdk }: { sdk: ArchivistSdk }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [series, setSeries] = useState<SeriesDetail | null>(null)
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null)
  const [episodeInfo, setEpisodeInfo] = useState<EpisodeSummary | null>(null)
  const [showWatched, setShowWatched] = useState(false)
  const [nextTrackSelection, setNextTrackSelection] = useState<DetailTrackSelection>({})
  const [ratingTree, setRatingTree] = useState<SeriesRatingTree | null>(null)
  const [dialog, setDialog] = useState<SeriesDialog | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const progress = useProgress()

  const load = () => sdk.seriesDetail(Number(id)).then(value => { setSeries(value); setSeasonNumber(current => current ?? value.seasons.find(season => season.episodes.some(episode => episode.hasFile))?.seasonNumber ?? value.seasons[0]?.seasonNumber ?? null) }).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  useEffect(() => { void load() }, [sdk, id])
  const loadRatings = () => typeof sdk.ratingTree === 'function' ? sdk.ratingTree(Number(id)).then(setRatingTree).catch(() => {}) : Promise.resolve()
  useEffect(() => { void loadRatings() }, [sdk, id])
  useEffect(() => { setShowWatched(false); setDialog(null) }, [id])
  useEffect(() => { setNextTrackSelection({}) }, [series?.nextAvailable?.id])

  if (error) return <p role="alert" className="player-safe text-pink">{error}</p>
  if (!series) return <div className="player-safe player-skeleton text-sm uppercase tracking-[.25em] text-white/30">Opening series</div>

  const seasons = series.seasons.filter(season => season.episodes.length > 0)
  const active = seasons.find(season => season.seasonNumber === seasonNumber) ?? seasons[0]
  const watchedIn = (episodes: EpisodeSummary[]) => episodes.filter(episode => progress[`episode:${episode.id}`]?.completed).length
  const visibleEpisodes = active?.episodes.filter(episode => showWatched || !progress[`episode:${episode.id}`]?.completed) ?? []
  const allEpisodes = seasons.flatMap(season => season.episodes)
  const playable = allEpisodes.filter(episode => episode.playback)
  const next = series.nextAvailable
  const nextProgress = next ? progress[`episode:${next.id}`] : undefined
  const resumable = !!nextProgress && !nextProgress.completed && nextProgress.positionSeconds > 30

  const episodeTarget = (episode: EpisodeSummary | null | undefined, trackSelection: DetailTrackSelection = {}): PlayTarget | null => episode?.playback ? ({
    key: `episode:${episode.id}`, type: 'episode', id: episode.id, title: episode.title ?? `Episode ${episode.episodeNumber}`,
    posterUrl: series.posterUrl, backdropUrl: episode.stillUrl ?? series.backdropUrl, streamUrl: episode.playback.streamUrl,
    seriesId: series.id, seriesTitle: series.title, plot: episode.overview, cast: series.cast ?? [], recommendations: series.recommendations ?? [],
    ...(trackSelection.audioIndex === undefined ? {} : { initialAudioIndex: trackSelection.audioIndex }),
    ...(trackSelection.subtitleIndex === undefined ? {} : { initialSubtitleIndex: trackSelection.subtitleIndex }),
  }) : null
  const playEpisode = (episode: EpisodeSummary, trackSelection: DetailTrackSelection = {}) => {
    const target = episodeTarget(episode, trackSelection)
    if (!target) return
    const index = playable.findIndex(item => item.id === episode.id)
    setEpisodeInfo(null)
    playerStore.dispatch({ type: 'PLAYBACK_STARTED', target, nextTarget: episodeTarget(playable[index + 1]) })
  }
  const startEpisode = (episode: EpisodeSummary) => { removeProgress(`episode:${episode.id}`); void sdk.deleteProgress('episode', episode.id).catch(() => {}); playEpisode(episode, nextTrackSelection) }
  const setWatched = (episode: EpisodeSummary, watched: boolean) => {
    const key = `episode:${episode.id}`
    if (!watched) { removeProgress(key); void sdk.deleteProgress('episode', episode.id); return }
    const durationSeconds = episode.runtimeSeconds ?? progress[key]?.durationSeconds ?? 1
    const target = episodeTarget(episode)
    saveProgress({ key, type: 'episode', id: episode.id, title: episode.title ?? 'Episode', posterUrl: series.posterUrl, backdropUrl: episode.stillUrl ?? series.backdropUrl, streamUrl: target?.streamUrl ?? '', seriesId: series.id, seriesTitle: series.title, positionSeconds: durationSeconds, durationSeconds, completed: true })
    void sdk.saveProgress({ type: 'episode', id: episode.id, positionSeconds: durationSeconds, durationSeconds, completed: true })
  }
  const setManyWatched = (episodes: EpisodeSummary[]) => {
    const shouldWatch = !episodes.every(episode => progress[`episode:${episode.id}`]?.completed)
    episodes.forEach(episode => setWatched(episode, shouldWatch))
    setMessage(shouldWatch ? 'Marked watched' : 'Marked unwatched')
  }
  const refresh = async () => { const result = await sdk.refreshSeriesMetadata(series.id); setMessage(result.queued ? 'Metadata refresh queued' : 'Metadata refresh already queued'); setDialog(null) }
  const commitRating = async (type: RatingSubjectType, subjectId: number, value: number | null) => { if (value == null) await sdk.clearRating(type, subjectId); else await sdk.setRating(type, subjectId, value); await loadRatings() }
  const ratingFor = (type: RatingSubjectType, subjectId: number): ResolvedRating => {
    const empty: ResolvedRating = { value: null, source: 'none', inheritedFrom: null, scaleMax: 5 }
    if (type === 'series') return ratingTree?.series.rating ?? empty
    if (type === 'season') return ratingTree?.seasons.find(entry => entry.season.subject.id === subjectId)?.season.rating ?? empty
    return ratingTree?.seasons.flatMap(entry => entry.episodes).find(entry => entry.subject.id === subjectId)?.rating ?? empty
  }

  const actions: ItemAction[] = [
    { id: 'play', label: next ? `${resumable ? 'Resume' : 'Start'} ${episodeCode(next)}` : 'Play', icon: 'play',
      primary: true, disabled: !next?.playback, onSelect: () => next && playEpisode(next, nextTrackSelection) },
    ...(next && resumable ? [{ id: 'restart', label: 'Start over', icon: 'restart' as const, onSelect: () => startEpisode(next) }] : []),
    ...(series.trailerUrl ? [{ id: 'trailer', label: 'Trailer', icon: 'trailer' as const, onSelect: () => window.open(series.trailerUrl!, '_blank', 'noopener,noreferrer') }] : []),
    { id: 'media', label: 'Audio & subtitles', icon: 'media', disabled: !next?.playback, onSelect: () => setDialog('media') },
    { id: 'watched', label: 'Mark series watched', icon: 'watched', onSelect: () => setManyWatched(allEpisodes) },
    // A toggle rather than a verb: it reports what the episode row is showing.
    { id: 'show-watched', label: `Show watched: ${showWatched ? 'On' : 'Off'}`, icon: 'check', pressed: showWatched, onSelect: () => setShowWatched(value => !value) },
    { id: 'ratings', label: 'Rate', icon: 'star', onSelect: () => setDialog('ratings') },
    { id: 'information', label: 'More', icon: 'info', onSelect: () => setDialog('information') },
  ]

  const rows: ItemRow[] = [
    ...(seasons.length ? [{
      id: 'seasons', label: 'Seasons', note: `${seasons.length} season${seasons.length === 1 ? '' : 's'}`,
      tiles: seasons.map(season => ({
        id: `season-${season.id}`, label: season.title,
        sublabel: `${watchedIn(season.episodes)}/${season.episodes.length} watched`,
        imageUrl: sdk.asset(season.posterUrl ?? series.posterUrl) || null,
        watched: season.episodes.length > 0 && watchedIn(season.episodes) === season.episodes.length,
        selected: active?.id === season.id,
        onSelect: () => setSeasonNumber(season.seasonNumber),
      })),
    }] : []),
    ...(active ? [{
      id: 'episodes', label: active.title, view: 'landscape' as const,
      note: `${active.episodes.length - watchedIn(active.episodes)} unwatched · ${watchedIn(active.episodes)} watched`,
      empty: showWatched ? 'This season has no episodes.' : 'Every episode in this season is watched. Turn on Show watched to see them again.',
      tiles: visibleEpisodes.map(episode => {
        const saved = progress[`episode:${episode.id}`]
        return {
          id: `episode-${episode.id}`,
          label: `${episodeCode(episode)} · ${episode.title ?? `Episode ${episode.episodeNumber}`}`,
          sublabel: [episode.airDate, episode.runtimeSeconds ? `${Math.round(episode.runtimeSeconds / 60)} min` : null].filter(Boolean).join(' · ') || null,
          imageUrl: sdk.asset(episode.stillUrl ?? series.backdropUrl) || null,
          ordinal: String(episode.episodeNumber).padStart(2, '0'),
          watched: !!saved?.completed,
          progress: saved && !saved.completed ? saved.positionSeconds / Math.max(saved.durationSeconds, 1) * 100 : undefined,
          // Opening the episode rather than playing it: an episode carries its
          // own overview, rating and track choices, and a row of stills is not
          // where those fit.
          onSelect: () => setEpisodeInfo(episode),
        }
      }),
    }] : []),
    ...((series.cast?.length ?? 0) > 0 ? [{
      id: 'cast', label: 'Cast', note: `${series.cast.length}`, view: 'person' as const,
      tiles: series.cast.slice(0, 24).map((person, index) => ({
        id: `cast-${person.id ?? person.name}-${index}`, label: person.name, sublabel: personRole(person),
        imageUrl: sdk.asset(personImage(person)) || null,
        disabled: !person.id,
        onSelect: () => person.id && navigate(`/person/${person.id}`),
      })),
    }] : []),
    ...((series.crew?.length ?? 0) > 0 ? [{
      id: 'crew', label: 'Crew', view: 'person' as const,
      tiles: series.crew.slice(0, 24).map((person, index) => ({
        id: `crew-${person.id ?? person.name}-${index}`, label: person.name, sublabel: personRole(person),
        imageUrl: sdk.asset(personImage(person)) || null,
        disabled: !person.id,
        onSelect: () => person.id && navigate(`/person/${person.id}`),
      })),
    }] : []),
    ...((series.recommendations?.length ?? 0) > 0 ? [{
      id: 'recommendations', label: 'More like this', note: 'From your library',
      tiles: series.recommendations.map(item => ({
        id: item.key, label: item.title,
        imageUrl: sdk.asset(item.posterUrl) || null,
        onSelect: () => navigate(item.route),
      })),
    }] : []),
  ]

  // The catalogue's own score, standing in until the viewer sets one of theirs.
  const catalogue = catalogueRating(series.ratings?.find(entry => Number.isFinite(entry.value))?.value ?? series.rating)
  const chips = [next?.quality?.resolution ? { text: next.quality.resolution, tone: 'cv-chip-res' } : null,
    next?.quality?.codec ? { text: next.quality.codec.toUpperCase() } : null,
    next?.quality?.source ? { text: next.quality.source } : null].flatMap(chip => chip ? [chip] : [])
  const tags = [...(series.certification ? [{ text: series.certification, tone: certificationTone(series.certification) }] : []),
    ...(series.network ? [{ text: series.network }] : []),
    ...(series.genres ?? []).slice(0, 3).map(genre => ({ text: genre, tone: 'cv-chip-ghost' }))]

  return <ItemView
    eyebrow="Series"
    title={series.title}
    logoUrl={sdk.asset(series.logoUrl) || null}
    posterUrl={sdk.asset(series.posterUrl) || null}
    backdropUrl={sdk.asset(series.backdropUrl) || null}
    accent={SERIES_ACCENT}
    rating={ratingFor('series', series.id)}
    catalogue={catalogue}
    meta={<ItemFacts facts={[series.year, series.certification, series.network, `${series.availableEpisodeCount}/${series.episodeCount} available`, series.seriesStatus]} />}
    overview={series.overview}
    status={next?.playback ? null : 'No episode is ready to play'}
    actions={actions}
    rows={rows}
    chips={chips}
    tags={tags}
    focusKey={series.id}
    onBack={() => navigate(-1)}
  >
    {/* Track choices belong to the episode Play would start, which is Up Next. */}
    {next && <MediaSelector sdk={sdk} type="episodes" id={next.id} title={`${series.title} · ${next.title ?? `Episode ${next.episodeNumber}`}`}
      selection={nextTrackSelection} onChange={setNextTrackSelection} disabled={!next.playback}
      hideTrigger open={dialog === 'media'} onOpenChange={open => setDialog(open ? 'media' : null)} />}

    {dialog === 'ratings' && <ItemDialog title={series.title} eyebrow="Your ratings · specificity wins" onClose={() => setDialog(null)}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-5">
          <div className="min-w-40"><p className="font-bebas text-lg text-white/85">{series.title}</p><p className="archivist-section-label mt-1">Series</p></div>
          <Level title={series.title} rating={ratingFor('series', series.id)} onCommit={value => commitRating('series', series.id, value)} accent="var(--archivist-series)" catalogue={catalogue} showSource />
        </div>
        {active && <div className="flex flex-wrap items-center gap-5 border-t border-white/[.07] pt-5">
          <div className="min-w-40"><p className="font-bebas text-lg text-white/85">{active.title}</p><p className="archivist-section-label mt-1">Season {active.seasonNumber}</p></div>
          <Level title={active.title} rating={ratingFor('season', active.id)} onCommit={value => commitRating('season', active.id, value)} accent="var(--archivist-series)" showSource />
        </div>}
      </div>
    </ItemDialog>}

    {dialog === 'information' && <ItemDialog title={series.title} eyebrow="Series information" onClose={() => setDialog(null)}
      footer={<button type="button" onClick={() => void refresh()} className="player-focusable player-button">Refresh metadata</button>}>
      {active?.overview && <section className="mb-8">
        <h3 className="archivist-section-label text-white/65">Season {active.seasonNumber}</h3>
        <p className="mt-3 leading-relaxed text-white/55">{active.overview}</p>
      </section>}
      {series.overview && <section>
        <h3 className="archivist-section-label text-white/65">Synopsis</h3>
        <p className="mt-3 leading-relaxed text-white/55">{series.overview}</p>
      </section>}
      <div className="mt-8 flex flex-wrap gap-3">
        <DetailAction onClick={() => active && setManyWatched(active.episodes)}>Toggle season watched</DetailAction>
      </div>
    </ItemDialog>}

    {episodeInfo && <EpisodeDialog sdk={sdk} series={series} episode={episodeInfo} rating={ratingFor('episode', episodeInfo.id)}
      onRate={value => commitRating('episode', episodeInfo.id, value)} progress={progress[`episode:${episodeInfo.id}`]}
      onClose={() => setEpisodeInfo(null)} onPlay={selection => playEpisode(episodeInfo, selection)}
      onToggleWatched={() => setWatched(episodeInfo, !progress[`episode:${episodeInfo.id}`]?.completed)} />}

    {message && <ItemToast message={message} onDone={() => setMessage(null)} />}
  </ItemView>
}

function EpisodeDialog({ sdk, series, episode, rating, onRate, progress, onClose, onPlay, onToggleWatched }: { sdk: ArchivistSdk; series: SeriesDetail; episode: EpisodeSummary; rating: ResolvedRating; onRate: (value: number | null) => void | Promise<void>; progress?: { completed: boolean; positionSeconds: number; durationSeconds: number }; onClose: () => void; onPlay: (selection: DetailTrackSelection) => void; onToggleWatched: () => void }) {
  const [trackSelection, setTrackSelection] = useState<DetailTrackSelection>({})
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose)
  const code = episodeCode(episode)
  return (
    <div ref={dialogRef} className="fixed inset-0 z-[95] grid place-items-center bg-black/78 p-[var(--safe-x)]" role="dialog" aria-modal="true" aria-labelledby="episode-dialog-title" onClick={onClose}>
      <section className="player-dialog motion-dialog relative grid max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-2xl border-white/10 md:grid-cols-12" onClick={event => event.stopPropagation()}>
        <div className="relative min-h-64 overflow-hidden bg-white/[.025] md:col-span-5 md:min-h-[560px]">
          {(episode.stillUrl || series.backdropUrl) && <img src={sdk.asset(episode.stillUrl ?? series.backdropUrl)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" />}
          <div className="absolute inset-0 bg-gradient-to-t from-[#0d0d13] via-transparent to-black/15 md:bg-gradient-to-r md:from-transparent md:to-[#0d0d13]" />
          <div className="absolute bottom-5 left-5 rounded-lg border border-white/10 bg-black/55 px-3 py-2 font-mono text-[9.5px] uppercase tracking-[.12em] text-white/65">{code}</div>
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
          <div className="mt-7 border-t border-white/[.07] pt-6"><p className="archivist-section-label mb-4">Your rating</p><Level title={episode.title ?? code} rating={rating} onCommit={onRate} accent="var(--archivist-series)" showSource /></div>
          <div className="mt-7 border-t border-white/[.07] pt-6"><MediaSelector sdk={sdk} type="episodes" id={episode.id} title={series.title + ' · ' + (episode.title ?? 'Episode ' + episode.episodeNumber)} selection={trackSelection} onChange={setTrackSelection} disabled={!episode.playback} /></div>
          <div className="mt-auto flex flex-wrap gap-2.5 pt-7"><DetailAction icon="play" primary disabled={!episode.playback} onClick={() => onPlay(trackSelection)}>{progress && !progress.completed && progress.positionSeconds > 30 ? 'Resume' : 'Play'}</DetailAction><DetailAction icon="watched" onClick={onToggleWatched}>{progress?.completed ? 'Mark unwatched' : 'Mark watched'}</DetailAction></div>
        </div>
      </section>
    </div>
  )
}
