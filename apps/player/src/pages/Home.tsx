import { useEffect, useState } from 'react'
import type { ArchivistSdk, FilmSummary, EpisodeSummary, HomeRails } from '../lib/sdk.js'
import { useSettings, useProgress, continueWatching, type RailConfig } from '../lib/store.js'
import { Rail } from '../components/Rail.js'
import type { CardItem } from '../components/Cards.js'

const epLabel = (e: EpisodeSummary) => `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')}`

function filmCard(f: FilmSummary, watchedKeys?: Set<string>): CardItem {
  return {
    key: `film:${f.id}`, to: `/film/${f.id}`, title: f.title,
    subtitle: f.year ? String(f.year) : (f.overview ?? null),
    posterUrl: f.posterUrl, backdropUrl: f.backdropUrl, logoUrl: f.logoUrl,
    badge: f.quality?.resolution ?? null,
    watched: watchedKeys?.has(`film:${f.id}`),
  }
}

function episodeCard(e: EpisodeSummary, watchedKeys?: Set<string>): CardItem {
  return {
    key: `episode:${e.id}`, to: `/series/${e.seriesId}`,
    title: e.seriesTitle ? `${e.seriesTitle}` : (e.title ?? 'Episode'),
    subtitle: `${epLabel(e)}${e.title ? ` · ${e.title}` : ''}`,
    posterUrl: e.seriesPosterUrl ?? null, backdropUrl: e.stillUrl,
    watched: watchedKeys?.has(`episode:${e.id}`),
  }
}

/** Customizable home — resolves each configured rail to items (Arctic Fuse style). */
export function Home({ sdk }: { sdk: ArchivistSdk }) {
  const settings = useSettings()
  const progressMap = useProgress()
  const [rails, setRails] = useState<HomeRails | null>(null)
  const [films, setFilms] = useState<FilmSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const needsFilms = settings.rails.some(r => r.enabled && ['unwatched-films', 'films-az'].includes(r.source))
  const needsSeries = settings.rails.some(r => r.enabled && r.source === 'series-az')
  const [seriesList, setSeriesList] = useState<any[] | null>(null)

  useEffect(() => {
    sdk.home().then(d => setRails(d.rails)).catch(e => setError(String(e)))
    if (needsFilms) sdk.films().then(d => setFilms(d.films)).catch(() => {})
    if (needsSeries) sdk.series().then(d => setSeriesList(d.series)).catch(() => {})
  }, [sdk, needsFilms, needsSeries])

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>
  if (!rails) return <div className="p-16 text-center text-white/25 text-[11px] font-mono uppercase tracking-[0.3em] animate-pulse">Loading…</div>

  const progressEntries = continueWatching()
  const watchedKeys = new Set(Object.keys(progressMap))
  const completedKeys = new Set(Object.entries(progressMap).filter(([, p]) => p.completed).map(([k]) => k))

  const resolve = (r: RailConfig): CardItem[] => {
    switch (r.source) {
      case 'continue':
        return progressEntries.slice(0, r.limit).map(p => ({
          key: p.key,
          to: p.type === 'film' ? `/film/${p.id}` : `/series/${p.seriesId}`,
          title: p.seriesTitle ?? p.title,
          subtitle: p.seriesTitle ? p.title : undefined,
          posterUrl: p.posterUrl, backdropUrl: p.backdropUrl,
          progressPct: (p.positionSeconds / Math.max(p.durationSeconds, 1)) * 100,
        }))
      case 'recent-films': return rails.recentFilms.slice(0, r.limit).map(f => filmCard(f, completedKeys))
      case 'recent-episodes': return rails.recentEpisodes.slice(0, r.limit).map(e => episodeCard(e, completedKeys))
      case 'downloading': return rails.downloading.slice(0, r.limit).map(f => filmCard(f))
      case 'unwatched-films':
        return (films ?? []).filter(f => f.hasFile && !watchedKeys.has(`film:${f.id}`)).slice(0, r.limit).map(f => filmCard(f, completedKeys))
      case 'films-az': return (films ?? []).slice(0, r.limit).map(f => filmCard(f, completedKeys))
      case 'series-az': return (seriesList ?? []).slice(0, r.limit).map((s: any) => ({
        key: `series:${s.id}`, to: `/series/${s.id}`, title: s.title,
        subtitle: s.year ? String(s.year) : null, posterUrl: s.posterUrl, backdropUrl: s.backdropUrl,
      }))
      default: return []
    }
  }

  const visible = settings.rails.filter(r => r.enabled)
  const anyContent = visible.some(r => resolve(r).length > 0)

  return (
    <div className="animate-fade-in pb-12">
      {visible.map(r => <Rail key={r.id} title={r.title} style={r.style} items={resolve(r)} sdk={sdk} />)}
      {!anyContent && (
        <div className="p-20 text-center">
          <p className="text-white/40 text-sm mb-1">Your library is quiet.</p>
          <p className="text-[11px] font-mono text-white/20 uppercase tracking-widest">Add and download media in Archivist — it appears here.</p>
        </div>
      )}
    </div>
  )
}
