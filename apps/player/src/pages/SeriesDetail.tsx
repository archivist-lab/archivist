import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { ArchivistSdk, SeriesDetail, EpisodeSummary } from '../lib/sdk.js'
import { useProgress } from '../lib/store.js'
import { MetaRow, WatchedCheck } from '../components/Cards.js'
import { Player, type PlayTarget } from '../components/Player.js'

export function SeriesDetailPage({ sdk, v2 = false }: { sdk: ArchivistSdk; v2?: boolean }) {
  const { id } = useParams<{ id: string }>()
  const [series, setSeries] = useState<SeriesDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [season, setSeason] = useState<number | null>(null)
  const [playing, setPlaying] = useState<PlayTarget | null>(null)
  const [infoEpisode, setInfoEpisode] = useState<EpisodeSummary | null>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const firstSeasonRef = useRef<HTMLButtonElement>(null)
  const infoOriginRef = useRef<HTMLElement | null>(null)
  const infoDialogRef = useRef<HTMLDivElement>(null)
  const progress = useProgress()

  useEffect(() => {
    sdk.seriesDetail(Number(id)).then(d => {
      setSeries(d)
      const seasons = d.seasons.filter(s => s.episodes.length > 0)
      const first = seasons.find(s => s.episodes.some(e => e.hasFile)) ?? seasons[0]
      setSeason(first?.seasonNumber ?? null)
    }).catch(e => setError(String(e)))
  }, [sdk, id])
  useEffect(() => {
    if (!series || !v2) return
    requestAnimationFrame(() => (primaryRef.current ?? firstSeasonRef.current)?.focus())
  }, [series?.id, v2])
  const closeEpisodeInfo = () => {
    setInfoEpisode(null)
    requestAnimationFrame(() => infoOriginRef.current?.focus())
  }
  useEffect(() => {
    if (!infoEpisode) return
    const dialog = infoDialogRef.current
    const buttons = () => Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    requestAnimationFrame(() => buttons()[0]?.focus())
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'BrowserBack' || event.key === 'Backspace') {
        event.preventDefault(); event.stopPropagation(); closeEpisodeInfo(); return
      }
      if (event.key !== 'Tab') return
      const items = buttons()
      if (!items.length) { event.preventDefault(); return }
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [infoEpisode])
  const openEpisodeInfo = (episode: EpisodeSummary, origin: HTMLElement) => {
    infoOriginRef.current = origin
    setInfoEpisode(episode)
  }

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>
  if (!series) return <div className="p-16 text-center text-white/25 text-[11px] font-mono uppercase tracking-[0.3em] animate-pulse">Loading…</div>

  const episodeTarget = (episode: EpisodeSummary): PlayTarget | null => episode.playback ? ({
    key: `episode:${episode.id}`, type: 'episode', id: episode.id,
    title: episode.title ?? `S${episode.seasonNumber}E${episode.episodeNumber}`,
    posterUrl: series.posterUrl, backdropUrl: episode.stillUrl ?? series.backdropUrl,
    streamUrl: episode.playback.streamUrl, seriesId: series.id, seriesTitle: series.title,
    plot: episode.overview,
  }) : null
  const playEpisode = (episode: EpisodeSummary) => {
    const target = episodeTarget(episode)
    if (target) setPlaying(target)
  }

  const active = series.seasons.find(s => s.seasonNumber === season)
  const visibleSeasons = series.seasons.filter(item => item.episodes.length > 0)
  const next = series.nextAvailable
  const playableEpisodes = series.seasons.flatMap(item => item.episodes).filter(episode => episode.playback)
  const playingIndex = playing ? playableEpisodes.findIndex(episode => episode.id === playing.id) : -1
  const upNextTarget = playingIndex >= 0 ? episodeTarget(playableEpisodes[playingIndex + 1]) : null

  return (
    <div className={`animate-fade-in pb-16 ${v2 ? 'h-full overflow-y-auto no-scrollbar' : ''}`}>
      <div className={`relative h-[46vh] min-h-[300px] ${v2 ? '' : '-mt-14'}`}>
        {series.backdropUrl && <img src={sdk.asset(series.backdropUrl)} alt="" className="absolute inset-0 w-full h-full object-cover" />}
        <div className="absolute inset-0 scrim-b" />
        <div className="absolute inset-0 scrim-l" />
        <div className="absolute bottom-8 left-5 sm:left-8 right-8 max-w-2xl">
          {series.logoUrl
            ? <img src={sdk.asset(series.logoUrl)} alt={series.title} className="max-h-24 max-w-sm object-contain object-left mb-4 drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]" />
            : <h1 className="text-5xl font-semibold tracking-tight text-white leading-none mb-4">{series.title}</h1>}
          <MetaRow year={series.year} rating={series.rating} certification={series.certification} />
          <div className="flex items-center gap-4 mt-6">
            {next?.playback ? (
              <button ref={primaryRef} onClick={() => playEpisode(next)}
                className="player-focusable inline-flex items-center gap-2 px-9 py-3 rounded-full bg-white text-noir-950 font-bold tracking-wide text-[12px] hover:bg-white/90 active:scale-[0.97] transition-all shadow-lg shadow-black/30">
                <span className="text-[10px]">▶</span> Resume Next · S{String(next.seasonNumber).padStart(2, '0')}E{String(next.episodeNumber).padStart(2, '0')}
              </button>
            ) : (
              <span className="px-4 py-2 rounded-full bg-white/5 border border-white/10 text-[10px] font-bold uppercase tracking-widest text-white/30">No episodes available yet</span>
            )}
            <span className="text-[11px] font-mono text-white/40">{series.availableEpisodeCount}/{series.episodeCount} episodes</span>
          </div>
        </div>
      </div>

      <div className="px-8 max-w-5xl">
        {series.overview && <p className="mt-8 text-sm text-white/60 leading-relaxed max-w-3xl">{series.overview}</p>}

        {/* Season picker */}
        <div className="flex gap-1.5 mt-8 flex-wrap">
          {visibleSeasons.map((s, index) => (
            <button key={s.id} ref={index === 0 ? firstSeasonRef : undefined} onClick={() => setSeason(s.seasonNumber)}
              className={`player-focusable px-4 py-1.5 rounded-full text-[11px] font-semibold tracking-wide transition-colors ${
                season === s.seasonNumber ? 'bg-white text-noir-950' : 'bg-white/[0.06] text-white/50 hover:text-white hover:bg-white/10'}`}>
              {s.title}
            </button>
          ))}
        </div>

        {/* Episode list */}
        <div className="mt-6 space-y-2">
          {(active?.episodes ?? []).map(e => {
            const p = progress[`episode:${e.id}`]
            const pct = p ? (p.completed ? 100 : (p.positionSeconds / Math.max(p.durationSeconds, 1)) * 100) : 0
            const runtime = e.runtimeSeconds ? `${Math.round(e.runtimeSeconds / 60)}m` : null
            return (
              <div key={e.id} className="flex items-stretch gap-2">
              <button onClick={() => e.playback && playEpisode(e)} disabled={!e.hasFile}
                onKeyDown={event => { if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); openEpisodeInfo(e, event.currentTarget) } }}
                className={`player-focusable group min-w-0 flex-1 flex items-center gap-4 p-2.5 rounded-2xl text-left transition-all ${
                  e.hasFile ? 'hover:bg-white/[0.06] cursor-pointer' : 'opacity-40 cursor-default'}`}>
                {/* Still thumbnail */}
                <div className="relative w-28 sm:w-32 aspect-video rounded-lg overflow-hidden bg-noir-800 ring-1 ring-white/10 shrink-0">
                  {(e.stillUrl || series.posterUrl) && (
                    <img src={sdk.asset(e.stillUrl || series.posterUrl)} alt="" loading="lazy" className="w-full h-full object-cover" />
                  )}
                  {e.hasFile && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity text-white text-lg">▶</span>
                  )}
                  {pct > 0 && pct < 100 && (
                    <progress aria-label={`${Math.round(pct)}% watched`} value={pct} max={100} className="player-progress absolute bottom-0 inset-x-0 h-1 w-full" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono text-white/35 shrink-0">
                      S{String(e.seasonNumber).padStart(2, '0')}E{String(e.episodeNumber).padStart(2, '0')}
                    </span>
                    <p className="text-sm font-medium text-white/90 truncate">{e.title ?? 'Episode'}</p>
                    {pct >= 100 && <WatchedCheck className="!w-4 !h-4 shrink-0" />}
                  </div>
                  {e.overview && <p className="mt-1 text-[12px] text-white/40 line-clamp-2 leading-snug">{e.overview}</p>}
                  <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-white/25">
                    {e.airDate && <span>{e.airDate}</span>}
                    {runtime && <><span>·</span><span>{runtime}</span></>}
                    {e.quality?.resolution && <><span>·</span><span className="uppercase">{e.quality.resolution}</span></>}
                  </div>
                </div>
              </button>
              <button type="button" aria-label={`Information for S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`}
                onClick={event => openEpisodeInfo(e, event.currentTarget)}
                className="player-focusable w-12 shrink-0 rounded-2xl bg-white/[0.04] text-lg text-white/55 hover:bg-white/10 hover:text-white">i</button>
              </div>
            )
          })}
        </div>
      </div>

      {playing && <Player key={playing.key} target={playing} nextTarget={upNextTarget} sdk={sdk}
        onAdvance={setPlaying} onClose={() => setPlaying(null)} />}
      {infoEpisode && <div ref={infoDialogRef} role="dialog" aria-modal="true" aria-labelledby="episode-information-title"
        className="fixed inset-0 z-[110] grid place-items-center bg-black/75 p-8">
        <section className="w-full max-w-2xl rounded-3xl bg-noir-900 p-8 shadow-2xl ring-1 ring-white/15">
          <div className="flex items-start justify-between gap-6">
            <div><p className="font-mono text-sm text-cyan">S{String(infoEpisode.seasonNumber).padStart(2, '0')}E{String(infoEpisode.episodeNumber).padStart(2, '0')}</p><h2 id="episode-information-title" className="mt-2 text-3xl font-semibold">{infoEpisode.title ?? 'Episode Information'}</h2></div>
            <button type="button" aria-label="Close episode information" onClick={closeEpisodeInfo} className="player-focusable rounded-full bg-white/10 px-4 py-2">Close</button>
          </div>
          <div className="mt-5 flex flex-wrap gap-3 text-sm text-white/55">
            {infoEpisode.airDate && <span>{infoEpisode.airDate}</span>}
            {infoEpisode.runtimeSeconds && <span>{Math.round(infoEpisode.runtimeSeconds / 60)} min</span>}
            {infoEpisode.quality?.resolution && <span>{infoEpisode.quality.resolution}</span>}
            <span>{infoEpisode.hasFile ? 'Available' : 'Not available'}</span>
            {infoEpisode.progress && <span>{infoEpisode.progress.completed ? 'Watched' : `${Math.round(infoEpisode.progress.percent)}% watched`}</span>}
          </div>
          <p className="mt-6 leading-relaxed text-white/65">{infoEpisode.overview || 'No episode overview is available.'}</p>
        </section>
      </div>}
    </div>
  )
}
