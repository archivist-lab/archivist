import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ArchivistSdk, FilmSummary, SeriesSummary } from '../lib/sdk.js'
import { PosterCard } from '../components/Cards.js'

export function SearchPage({ sdk }: { sdk: ArchivistSdk }) {
  const [params] = useSearchParams()
  const q = params.get('q') ?? ''
  const [results, setResults] = useState<Array<FilmSummary | SeriesSummary> | null>(null)

  useEffect(() => {
    if (!q) { setResults([]); return }
    setResults(null)
    sdk.search(q).then(d => setResults(d.results)).catch(() => setResults([]))
  }, [sdk, q])

  return (
    <div className="px-5 pb-12 animate-fade-in">
      <h1 className="text-2xl font-semibold tracking-tight text-white py-4">
        Search {q && <span className="text-white/35 font-normal">“{q}”</span>}
      </h1>
      {!results ? (
        <div className="p-16 text-center text-white/25 text-[11px] font-mono uppercase tracking-[0.3em] animate-pulse">Searching…</div>
      ) : results.length === 0 ? (
        <p className="p-16 text-center text-white/30 text-sm">No matches in your library.</p>
      ) : (
        <div className="grid gap-x-3 gap-y-6 grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {results.map(r => (
            <div key={`${r.type}:${r.id}`} className="[&>a]:w-full">
              <PosterCard sdk={sdk} item={{
                key: `${r.type}:${r.id}`,
                to: r.type === 'film' ? `/film/${r.id}` : `/series/${r.id}`,
                title: r.title,
                subtitle: `${r.type === 'film' ? 'Film' : 'Series'}${r.year ? ` · ${r.year}` : ''}`,
                posterUrl: r.posterUrl, backdropUrl: r.backdropUrl,
              }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
