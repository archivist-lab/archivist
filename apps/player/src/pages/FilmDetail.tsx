import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { ArchivistSdk, FilmDetail } from '../lib/sdk.js'
import { useProgress } from '../lib/store.js'
import { MetaRow } from '../components/Cards.js'
import { Player, type PlayTarget } from '../components/Player.js'

export function FilmDetailPage({ sdk }: { sdk: ArchivistSdk }) {
  const { id } = useParams<{ id: string }>()
  const [film, setFilm] = useState<FilmDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<PlayTarget | null>(null)
  const progress = useProgress()

  useEffect(() => {
    sdk.film(Number(id)).then(setFilm).catch(e => setError(String(e)))
  }, [sdk, id])

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>
  if (!film) return <div className="p-16 text-center text-white/25 text-[11px] font-mono uppercase tracking-[0.3em] animate-pulse">Loading…</div>

  const saved = progress[`film:${film.id}`]
  const resumable = saved && !saved.completed && saved.positionSeconds > 30

  const play = () => film.playback && setPlaying({
    key: `film:${film.id}`, type: 'film', id: film.id, title: film.title,
    posterUrl: film.posterUrl, backdropUrl: film.backdropUrl, streamUrl: film.playback.streamUrl,
  })

  return (
    <div className="animate-fade-in pb-16">
      {/* Full-bleed backdrop */}
      <div className="relative h-[52vh] min-h-[340px] -mt-14">
        {film.backdropUrl && <img src={sdk.asset(film.backdropUrl)} alt="" className="absolute inset-0 w-full h-full object-cover" />}
        <div className="absolute inset-0 scrim-b" />
        <div className="absolute inset-0 scrim-l" />
        <div className="absolute bottom-8 left-5 sm:left-8 right-8 flex items-end gap-6">
          {film.posterUrl && (
            <img src={sdk.asset(film.posterUrl)} alt="" className="hidden sm:block w-40 rounded-xl ring-1 ring-white/10 shadow-2xl shrink-0" />
          )}
          <div className="min-w-0 max-w-2xl">
            {film.logoUrl
              ? <img src={sdk.asset(film.logoUrl)} alt={film.title} className="max-h-24 max-w-sm object-contain object-left mb-4 drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]" />
              : <h1 className="text-5xl font-semibold tracking-tight text-white leading-none mb-4">{film.title}</h1>}
            <MetaRow year={film.year} runtimeSeconds={film.runtimeSeconds} rating={film.rating}
              certification={film.certification} quality={film.quality} />
            <div className="flex items-center gap-4 mt-6">
              {film.playback ? (
                <>
                  <button onClick={play}
                    className="inline-flex items-center gap-2 px-9 py-3 rounded-full bg-white text-noir-950 font-bold tracking-wide text-[12px] hover:bg-white/90 active:scale-[0.97] transition-all shadow-lg shadow-black/30">
                    <span className="text-[10px]">▶</span> {resumable ? 'Resume' : 'Play'}
                  </button>
                  {resumable && (
                    <span className="text-[11px] font-mono text-white/40">
                      {Math.round((saved.positionSeconds / Math.max(saved.durationSeconds, 1)) * 100)}% watched
                    </span>
                  )}
                </>
              ) : (
                <span className="px-4 py-2 rounded-full bg-white/5 border border-white/10 text-[10px] font-bold uppercase tracking-widest text-white/30">Not available yet</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="px-8 max-w-4xl">
        {film.overview && <p className="mt-8 text-sm text-white/60 leading-relaxed">{film.overview}</p>}
        <div className="mt-6 flex flex-wrap gap-2">
          {film.genres.map(g => (
            <span key={g} className="px-2.5 py-1 rounded-lg bg-white/5 text-[10px] font-mono uppercase tracking-widest text-white/40">{g}</span>
          ))}
        </div>
        {film.cast?.length > 0 && (
          <div className="mt-10">
            <h3 className="section-head mb-4">Cast</h3>
            <div className="flex gap-3 overflow-x-auto no-scrollbar">
              {film.cast.slice(0, 14).map((c: any, i: number) => (
                <div key={i} className="w-24 shrink-0 text-center">
                  <div className="aspect-square rounded-full overflow-hidden bg-noir-800 border border-white/5 mb-2">
                    {(c.profilePath || c.profile_path) && <img src={sdk.asset(c.profilePath || c.profile_path)} alt="" loading="lazy" className="w-full h-full object-cover" />}
                  </div>
                  <p className="text-[11px] text-white/70 truncate">{c.name}</p>
                  <p className="text-[9px] font-mono text-white/25 truncate">{c.character}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {playing && <Player target={playing} sdk={sdk} onClose={() => setPlaying(null)} />}
    </div>
  )
}
