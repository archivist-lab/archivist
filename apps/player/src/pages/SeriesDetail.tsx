import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { ArchivistSdk, SeriesDetail, EpisodeSummary } from '../lib/sdk.js'
import { useProgress } from '../lib/store.js'
import { MetaRow, WatchedCheck } from '../components/Cards.js'
import { Player, type PlayTarget } from '../components/Player.js'

export function SeriesDetailPage({ sdk }: { sdk: ArchivistSdk }) {
  const { id } = useParams<{ id: string }>()
  const [series, setSeries] = useState<SeriesDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [season, setSeason] = useState<number | null>(null)
  const [playing, setPlaying] = useState<PlayTarget | null>(null)
  const progress = useProgress()

  useEffect(() => {
    sdk.seriesDetail(Number(id)).then(d => {
      setSeries(d)
      const first = d.seasons.find(s => s.episodes.some(e => e.hasFile)) ?? d.seasons[0]
      setSeason(first?.seasonNumber ?? null)
    }).catch(e => setError(String(e)))
  }, [sdk, id])

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>
  if (!series) return <div className="p-16 text-center text-white/25 text-[11px] font-mono uppercase tracking-[0.3em] animate-pulse">Loading…</div>

  const playEpisode = (e: EpisodeSummary) => e.playback && setPlaying({
    key: `episode:${e.id}`, type: 'episode', id: e.id,
    title: e.title ?? `S${e.seasonNumber}E${e.episodeNumber}`,
    posterUrl: series.posterUrl, backdropUrl: e.stillUrl ?? series.backdropUrl,
    streamUrl: e.playback.streamUrl, seriesId: series.id, seriesTitle: series.title,
  })

  const active = series.seasons.find(s => s.seasonNumber === season)
  const next = series.nextAvailable

  return (
    <div className="animate-fade-in pb-16">
      <div className="relative h-[46vh] min-h-[300px] -mt-14">
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
              <button onClick={() => playEpisode(next)}
                className="inline-flex items-center gap-2 px-9 py-3 rounded-full bg-white text-noir-950 font-bold tracking-wide text-[12px] hover:bg-white/90 active:scale-[0.97] transition-all shadow-lg shadow-black/30">
                <span className="text-[10px]">▶</span> Play S{String(next.seasonNumber).padStart(2, '0')}E{String(next.episodeNumber).padStart(2, '0')}
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
          {series.seasons.map(s => (
            <button key={s.id} onClick={() => setSeason(s.seasonNumber)}
              className={`px-4 py-1.5 rounded-full text-[11px] font-semibold tracking-wide transition-colors ${
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
              <button key={e.id} onClick={() => e.playback && playEpisode(e)} disabled={!e.hasFile}
                className={`group w-full flex items-center gap-4 p-2.5 rounded-2xl text-left transition-all ${
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
                    <div className="absolute bottom-0 inset-x-0 h-1 bg-black/60"><div className="h-full bg-white" style={{ width: `${pct}%` }} /></div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-mono text-white/35 shrink-0">
                      {e.seasonNumber}×{String(e.episodeNumber).padStart(2, '0')}
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
            )
          })}
        </div>
      </div>

      {playing && <Player target={playing} sdk={sdk} onClose={() => setPlaying(null)} />}
    </div>
  )
}
