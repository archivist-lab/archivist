import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { ArchivistSdk, FilmDetail } from '../lib/sdk.js'
import type { ResolvedRating } from '@archivist/contracts'
import { catalogueRating, Level } from '@archivist/design-system'
import { playerStore, removeProgress, saveProgress, useProgress } from '../lib/store.js'
import type { PlayTarget } from '../components/Player.js'
import { ItemView, ItemFacts, certificationTone, formatRuntime, personImage, personRole, type ItemAction, type ItemRow } from '../components/ItemView.js'
import { EditionDialog, ItemDialog, ItemFact, ItemToast, formatBytes } from '../components/ItemDialogs.js'
import { MediaSelector, type DetailTrackSelection } from '../components/MediaSelector.js'

/** Mirrors the Library's --archivist-film token, resolved for the stage's rgb split. */
const FILM_ACCENT = '#00d4ff'

/** Which dialog, if any, is over the page. Only one is ever open. */
type FilmDialog = 'media' | 'editions' | 'rating' | 'information'

export function FilmDetailPage({ sdk }: { sdk: ArchivistSdk }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [film, setFilm] = useState<FilmDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<FilmDialog | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [trackSelection, setTrackSelection] = useState<DetailTrackSelection>({})
  const [personalRating, setPersonalRating] = useState<ResolvedRating>({ value: null, source: 'none', inheritedFrom: null, scaleMax: 5 })
  const progress = useProgress()

  const load = () => sdk.film(Number(id)).then(setFilm).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  useEffect(() => { void load() }, [sdk, id])
  useEffect(() => { if (typeof sdk.rating === 'function') void sdk.rating('film', Number(id)).then(setPersonalRating).catch(() => {}) }, [sdk, id])
  useEffect(() => { setTrackSelection({}); setDialog(null) }, [id])

  if (error) return <p role="alert" className="player-safe text-sm text-pink">{error}</p>
  if (!film) return <div className="player-safe player-skeleton text-sm uppercase tracking-[.25em] text-white/30">Opening film</div>

  const saved = progress[`film:${film.id}`]
  const resumable = !!saved && !saved.completed && saved.positionSeconds > 30 && saved.positionSeconds / Math.max(saved.durationSeconds, 1) < .95
  const target: PlayTarget | null = film.playback ? {
    key: `film:${film.id}`, type: 'film', id: film.id, title: film.title,
    editionId: film.editions?.find(edition => edition.isDefault)?.id ?? null,
    posterUrl: film.posterUrl, backdropUrl: film.backdropUrl, streamUrl: film.playback.streamUrl, plot: film.overview, cast: film.cast ?? [], recommendations: film.recommendations ?? [],
    ...(trackSelection.audioIndex === undefined ? {} : { initialAudioIndex: trackSelection.audioIndex }),
    ...(trackSelection.subtitleIndex === undefined ? {} : { initialSubtitleIndex: trackSelection.subtitleIndex }),
  } : null
  const play = () => target && playerStore.dispatch({ type: 'PLAYBACK_STARTED', target })
  const start = () => { removeProgress(`film:${film.id}`); void sdk.deleteProgress('film', film.id).catch(() => {}); play() }
  const toggleWatched = () => {
    if (saved?.completed) { removeProgress(`film:${film.id}`); void sdk.deleteProgress('film', film.id); setMessage('Marked unwatched'); return }
    const durationSeconds = film.runtimeSeconds ?? saved?.durationSeconds ?? 1
    saveProgress({ key: `film:${film.id}`, type: 'film', id: film.id, title: film.title, posterUrl: film.posterUrl, backdropUrl: film.backdropUrl, streamUrl: target?.streamUrl ?? '', positionSeconds: durationSeconds, durationSeconds, completed: true })
    void sdk.saveProgress({ type: 'film', id: film.id, editionId: target?.editionId, positionSeconds: durationSeconds, durationSeconds, completed: true })
    setMessage('Marked watched')
  }
  const selectEdition = async (editionId: number) => {
    await sdk.selectFilmEdition(film.id, editionId)
    setDialog(null)
    setMessage('Edition selected')
    await load()
  }
  const refresh = async () => {
    const result = await sdk.refreshFilmMetadata(film.id)
    setMessage(result.queued ? 'Metadata refresh queued' : 'Metadata refresh already queued')
    setDialog(null)
  }
  const commitRating = async (value: number | null) => setPersonalRating(value == null ? await sdk.clearRating('film', film.id) : await sdk.setRating('film', film.id, value))

  /*
   * Resume and Start are separate controls rather than one that changes its
   * mind: a part-watched film is the case where a viewer most needs to say
   * which of the two they meant, and Play alone forces them to guess.
   */
  const actions: ItemAction[] = [
    ...(resumable
      ? [{ id: 'resume', label: 'Resume', icon: 'play' as const, primary: true, disabled: !target, onSelect: play },
         { id: 'start', label: 'Start over', icon: 'restart' as const, disabled: !target, onSelect: start }]
      : [{ id: 'start', label: 'Start', icon: 'play' as const, primary: true, disabled: !target, onSelect: play }]),
    ...(film.trailerUrl ? [{ id: 'trailer', label: 'Trailer', icon: 'trailer' as const, onSelect: () => window.open(film.trailerUrl!, '_blank', 'noopener,noreferrer') }] : []),
    { id: 'media', label: 'Audio & subtitles', icon: 'media', disabled: !film.playback, onSelect: () => setDialog('media') },
    ...((film.editions?.length ?? 0) > 1 ? [{ id: 'editions', label: 'Editions', icon: 'editions' as const, onSelect: () => setDialog('editions') }] : []),
    { id: 'watched', label: saved?.completed ? 'Mark unwatched' : 'Mark watched', icon: 'watched', onSelect: toggleWatched },
    { id: 'rating', label: 'Rate', icon: 'star', onSelect: () => setDialog('rating') },
    { id: 'information', label: 'More', icon: 'info', onSelect: () => setDialog('information') },
  ]

  const rows: ItemRow[] = [
    ...(film.collection ? [{
      id: 'collection', label: 'Collection', note: film.collection.name, view: 'landscape' as const,
      tiles: [{
        id: `collection-${film.collection.id}`, label: film.collection.name, sublabel: 'Browse every film in it',
        imageUrl: sdk.asset(film.collection.backdropUrl ?? film.collection.posterUrl) || null,
        onSelect: () => navigate(`/browse/films?collectionId=${film.collection!.id}`),
      }],
    }] : []),
    ...((film.cast?.length ?? 0) > 0 ? [{
      id: 'cast', label: 'Cast', note: `${film.cast.length}`, view: 'person' as const,
      tiles: film.cast.slice(0, 24).map((person, index) => ({
        id: `cast-${person.id ?? person.name}-${index}`, label: person.name, sublabel: personRole(person),
        imageUrl: sdk.asset(personImage(person)) || null,
        disabled: !person.id,
        onSelect: () => person.id && navigate(`/person/${person.id}`),
      })),
    }] : []),
    ...((film.crew?.length ?? 0) > 0 ? [{
      id: 'crew', label: 'Crew', view: 'person' as const,
      tiles: film.crew.slice(0, 24).map((person, index) => ({
        id: `crew-${person.id ?? person.name}-${index}`, label: person.name, sublabel: personRole(person),
        imageUrl: sdk.asset(personImage(person)) || null,
        disabled: !person.id,
        onSelect: () => person.id && navigate(`/person/${person.id}`),
      })),
    }] : []),
    ...((film.recommendations?.length ?? 0) > 0 ? [{
      id: 'recommendations', label: 'You may also like', note: 'From your library',
      tiles: film.recommendations.map(item => ({
        id: item.key, label: item.title,
        imageUrl: sdk.asset(item.posterUrl) || null,
        onSelect: () => navigate(item.route),
      })),
    }] : []),
  ]

  // The catalogue's own score, standing in until the viewer sets one of theirs.
  const catalogue = catalogueRating(film.ratings?.find(entry => Number.isFinite(entry.value))?.value ?? film.rating)
  const chips = [film.quality?.resolution ? { text: film.quality.resolution, tone: 'cv-chip-res' } : null,
    film.file?.videoCodec ? { text: film.file.videoCodec.toUpperCase() } : null,
    film.file?.audioCodec ? { text: film.file.audioCodec.toUpperCase() } : null,
    film.quality?.source ? { text: film.quality.source } : null,
    film.file?.edition ? { text: film.file.edition } : null].flatMap(chip => chip ? [chip] : [])
  const tags = [...(film.certification ? [{ text: film.certification, tone: certificationTone(film.certification) }] : []),
    ...(film.studio ? [{ text: film.studio }] : []),
    ...(film.genres ?? []).slice(0, 3).map(genre => ({ text: genre, tone: 'cv-chip-ghost' }))]

  return <ItemView
    eyebrow={film.originalTitle && film.originalTitle !== film.title ? film.originalTitle : 'Film'}
    title={film.title}
    logoUrl={sdk.asset(film.logoUrl) || null}
    posterUrl={sdk.asset(film.posterUrl) || null}
    backdropUrl={sdk.asset(film.backdropUrl) || null}
    accent={FILM_ACCENT}
    rating={personalRating}
    catalogue={catalogue}
    meta={<ItemFacts facts={[film.releaseDate ?? film.year, film.certification, film.runtimeSeconds ? formatRuntime(film.runtimeSeconds) : null, film.studio]} />}
    overview={film.overview}
    status={target ? null : 'No playable file in your library yet'}
    actions={actions}
    rows={rows}
    chips={chips}
    tags={tags}
    focusKey={film.id}
    onBack={() => navigate(-1)}
  >
    {/* The media dialog stays mounted so the chosen tracks survive closing it,
        which is what Play then hands to the pipeline. */}
    <MediaSelector sdk={sdk} type="films" id={film.id} title={film.title} selection={trackSelection} onChange={setTrackSelection}
      disabled={!film.playback} hideTrigger open={dialog === 'media'} onOpenChange={open => setDialog(open ? 'media' : null)} />

    {dialog === 'editions' && <EditionDialog title={film.title} editions={film.editions ?? []} onSelect={editionId => void selectEdition(editionId)} onClose={() => setDialog(null)} />}

    {dialog === 'rating' && <ItemDialog title={film.title} eyebrow="Your rating · private" onClose={() => setDialog(null)} width="34rem">
      <Level title={film.title} rating={personalRating} onCommit={commitRating} accent="var(--archivist-film)" catalogue={catalogue} showSource />
    </ItemDialog>}

    {dialog === 'information' && <ItemDialog title={film.title} eyebrow="Film information" onClose={() => setDialog(null)}
      footer={<button type="button" onClick={() => void refresh()} className="player-focusable player-button">Refresh metadata</button>}>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-7 text-[12.5px]">
        <ItemFact label="Release" value={film.releaseDate} />
        <ItemFact label="Country" value={film.country} />
        <ItemFact label="Studio" value={film.studio} />
        <ItemFact label="Edition" value={film.file?.edition} />
        <ItemFact label="Resolution" value={film.file?.resolution} />
        <ItemFact label="Video codec" value={film.file?.videoCodec} />
        <ItemFact label="File size" value={film.file?.sizeBytes ? formatBytes(film.file.sizeBytes) : null} />
      </dl>
      {film.overview && <section className="mt-9 border-t border-white/10 pt-7">
        <h3 className="archivist-section-label text-white/65">Synopsis</h3>
        <p className="mt-3 leading-relaxed text-white/55">{film.overview}</p>
      </section>}
    </ItemDialog>}

    {message && <ItemToast message={message} onDone={() => setMessage(null)} />}
  </ItemView>
}
