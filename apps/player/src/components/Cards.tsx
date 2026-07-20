import { Link } from 'react-router-dom'
import type { PlayerHubLayout, PlayerMediaCard, PlayerView } from '@archivist/contracts'
import { useState } from 'react'
import type { ArchivistSdk, Quality } from '../lib/sdk.js'
import { useFocusable } from '../focus/FocusProvider.js'

export interface CardItem {
  key: string
  to: string
  title: string
  subtitle?: string | null
  posterUrl?: string | null
  backdropUrl?: string | null
  logoUrl?: string | null
  progressPct?: number
  watched?: boolean
  badge?: string | null
}

/** Green circle-check for watched items (Arctic Fuse's watched indicator). */
export function WatchedCheck({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full bg-noir-950/80 backdrop-blur-sm ring-1 ring-emerald-400/70 ${className}`}>
      <svg viewBox="0 0 24 24" className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    </span>
  )
}

function Star({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`w-3 h-3 ${className}`} fill="currentColor">
      <path d="M12 2l2.9 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 7.1-1.01z" />
    </svg>
  )
}

/** Half-star rating out of 5 (from a /10 score), Arctic Fuse style. */
export function StarRating({ score, className = '' }: { score: number; className?: string }) {
  const stars = Math.round((score / 2) * 2) / 2 // nearest half on a 0–5 scale
  return (
    <span className={`inline-flex items-center gap-px align-middle ${className}`} title={`${score.toFixed(1)} / 10`}>
      {[0, 1, 2, 3, 4].map(i => {
        const fill = Math.max(0, Math.min(1, stars - i)) // 0, 0.5, or 1
        return (
          <span key={i} className="relative inline-block w-3 h-3">
            <Star className="absolute inset-0 text-white/20" />
            {fill > 0 && (
              <span className={`absolute inset-y-0 left-0 overflow-hidden ${fill === 0.5 ? 'w-1/2' : 'w-full'}`}>
                <Star className="text-white/90" />
              </span>
            )}
          </span>
        )
      })}
    </span>
  )
}

/**
 * The signature metadata line: ★★★½ • year • cert • runtime, in muted white
 * with dot separators. Keeps detail headers clean and consistent.
 */
export function MetaRow({ year, runtimeSeconds, rating, certification, quality, className = '' }: {
  year?: number | null; runtimeSeconds?: number | null; rating?: number | null
  certification?: string | null; quality?: Quality | null; className?: string
}) {
  const bits: React.ReactNode[] = []
  if (rating) bits.push(<StarRating key="stars" score={rating} />)
  if (year) bits.push(<span key="year">{year}</span>)
  if (certification) bits.push(<span key="cert" className="px-1.5 py-px rounded border border-white/20 text-[10px] tracking-wide">{certification}</span>)
  if (runtimeSeconds) {
    const m = Math.round(runtimeSeconds / 60)
    bits.push(<span key="rt">{m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`}</span>)
  }
  if (quality?.resolution) bits.push(<span key="q" className="font-mono text-white/45">{quality.resolution}</span>)

  return (
    <div className={`flex flex-wrap items-center text-[13px] text-white/70 ${className}`}>
      {bits.map((b, i) => (
        <span key={i} className="flex items-center">
          {i > 0 && <span className="text-white/25 text-[10px] mx-2.5">•</span>}
          {b}
        </span>
      ))}
    </div>
  )
}

/** Small genre / metadata pills (secondary, subtle). */
export function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((c, i) => (
        <span key={i} className="px-2.5 py-1 rounded-md bg-white/[0.06] border border-white/10 text-[10px] font-mono uppercase tracking-widest text-white/50">{c}</span>
      ))}
    </div>
  )
}

export function PosterCard({ item, sdk }: { item: CardItem; sdk: ArchivistSdk }) {
  return (
    <Link to={item.to}
      className="group block w-[138px] sm:w-[152px] shrink-0 rounded-xl outline-none">
      <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-[linear-gradient(160deg,#17171f,#0d0d13)] ring-1 ring-white/10 ring-inset transition-all duration-200 group-hover:ring-2 group-hover:ring-white group-hover:-translate-y-0.5 group-focus-visible:ring-2 group-focus-visible:ring-white shadow-lg shadow-black/40">
        {item.posterUrl && (
          <img src={sdk.asset(item.posterUrl)} alt="" loading="lazy"
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.05]" />
        )}
        {item.watched && <WatchedCheck className="absolute bottom-2 right-2" />}
        {item.badge && !item.watched && (
          <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/70 backdrop-blur-sm text-[8px] font-bold uppercase tracking-widest text-white/80">{item.badge}</span>
        )}
        {item.progressPct !== undefined && item.progressPct > 0 && (
          <progress aria-label={`${Math.round(item.progressPct)}% watched`} value={Math.min(item.progressPct, 100)} max={100} className="player-progress absolute bottom-0 inset-x-0 h-1 w-full" />
        )}
      </div>
      <p className="mt-2 truncate font-display text-[13px] uppercase tracking-wide text-white/80 transition-colors group-hover:text-white">{item.title}</p>
      {item.subtitle && <p className="truncate font-mono text-[10px] uppercase tracking-tight text-white/30">{item.subtitle}</p>}
    </Link>
  )
}

export function LandscapeCard({ item, sdk }: { item: CardItem; sdk: ArchivistSdk }) {
  const img = item.backdropUrl || item.posterUrl
  return (
    <Link to={item.to}
      className="group block w-[240px] sm:w-[264px] shrink-0 rounded-xl outline-none">
      <div className="relative aspect-video rounded-xl overflow-hidden bg-[linear-gradient(160deg,#17171f,#0d0d13)] ring-1 ring-white/10 ring-inset transition-all duration-200 group-hover:ring-2 group-hover:ring-white group-hover:-translate-y-0.5 group-focus-visible:ring-2 group-focus-visible:ring-white shadow-lg shadow-black/40">
        {img && (
          <img src={sdk.asset(img)} alt="" loading="lazy"
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.05]" />
        )}
        <div className="absolute inset-0 scrim-b opacity-90" />
        {item.watched && <WatchedCheck className="absolute top-2 right-2" />}
        <div className="absolute bottom-2 left-3 right-3">
          <p className="truncate font-display text-[13px] uppercase tracking-wide text-white">{item.title}</p>
          {item.subtitle && <p className="truncate font-mono text-[10px] uppercase tracking-tight text-white/45">{item.subtitle}</p>}
        </div>
        {item.progressPct !== undefined && item.progressPct > 0 && (
          <progress aria-label={`${Math.round(item.progressPct)}% watched`} value={Math.min(item.progressPct, 100)} max={100} className="player-progress absolute bottom-0 inset-x-0 h-1 w-full" />
        )}
      </div>
    </Link>
  )
}

function safeArtwork(sdk: ArchivistSdk, path: string | null): string {
  const url = sdk.asset(path)
  if (!url) return ''
  if (url.startsWith('data:image/')) return url
  try {
    const parsed = new URL(url, window.location.origin)
    return ['http:', 'https:', 'blob:'].includes(parsed.protocol) ? url : ''
  } catch { return '' }
}

export function MediaCard({ item, view, zoneId, sdk, onFocused, onActivate, hubLayout = 'standard' }: {
  item: PlayerMediaCard
  view: PlayerView
  zoneId: string
  sdk: ArchivistSdk
  onFocused: (item: PlayerMediaCard) => void
  onActivate: (item: PlayerMediaCard) => void
  hubLayout?: PlayerHubLayout
}) {
  const [failed, setFailed] = useState(false)
  const focusable = useFocusable({
    id: `card-${item.key}`,
    zoneId,
    disabled: false,
    onFocused: () => onFocused(item),
    onActivate: () => { if (item.route) onActivate(item) },
  })
  const cardView: PlayerView = item.acquisition
    ? item.acquisition.kind === 'episode' ? 'landscape' : 'poster'
    : view
  const source = cardView === 'poster' || cardView === 'wall' ? item.posterUrl : item.landscapeUrl || item.posterUrl
  const image = failed ? '' : safeArtwork(sdk, source)
  const fill = hubLayout === 'wall'
  const size = cardView === 'poster' ? `${fill ? 'w-full' : 'w-[clamp(150px,12.7vw,244px)]'} aspect-[2/3]`
    : cardView === 'wall' ? `${fill ? 'w-full' : 'w-[clamp(112px,9.1vw,174px)]'} aspect-[2/3]`
    : cardView === 'list' ? 'w-full h-[68px]'
    : `${fill ? 'w-full' : 'w-[clamp(248px,18.6vw,356px)]'} aspect-video`
  return (
    <button {...focusable} type="button" aria-label={`${item.title}${item.subtitle ? `, ${item.subtitle}` : ''}`}
      data-card-layout={hubLayout} className={`player-card player-focusable motion-focus group relative shrink-0 snap-start overflow-hidden rounded-xl bg-noir-800 text-left ${size}`}>
      {image ? <img src={image} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className={`absolute left-0 top-0 object-cover ${cardView === 'list' ? 'h-full w-[72px]' : 'h-full w-full'}`} />
        : <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-noir-700 via-noir-900 to-noir-950 p-4 text-center font-display uppercase tracking-wide text-white/35">{item.title}</div>}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-transparent" />
      {cardView === 'list' && <div className="absolute inset-y-0 left-[88px] right-4 flex items-center gap-4"><div className="min-w-0 flex-1"><div className="truncate font-display uppercase tracking-wide">{item.title}</div><div className="truncate font-mono text-[10px] uppercase tracking-tight text-white/55">{item.subtitle}</div></div><div className="flex shrink-0 gap-2">{item.badges.slice(0, 2).map(badge => <span key={badge.label} className="rounded border border-white/15 px-2 py-1 font-mono text-[10px] uppercase text-white/60">{badge.label}</span>)}</div>{!item.available && !item.acquisition && <span className="shrink-0 font-mono text-[10px] uppercase text-white/45">Unavailable</span>}</div>}
      {item.acquisition && cardView !== 'list' && <div className="absolute bottom-3 left-4 right-4 drop-shadow-lg">{item.acquisition.kind === 'episode' ? <><div className="mb-1 truncate font-mono text-[10px] uppercase tracking-wider text-white/60">{item.subtitle}</div><div className="truncate font-display text-lg uppercase tracking-wide text-white">{item.title}</div><div className="mt-1 font-mono text-[10px] font-medium uppercase player-accent">{Math.round(item.acquisition.percent)}%</div></> : <><div className="line-clamp-2 font-display uppercase tracking-wide text-white">{item.title}</div>{item.subtitle && <div className="mt-1 font-mono text-[10px] uppercase text-white/65">{item.subtitle}</div>}</>}</div>}
      {!item.acquisition && cardView !== 'poster' && cardView !== 'wall' && cardView !== 'list' && <div className="absolute bottom-3 left-4 right-4"><div className="truncate font-display uppercase tracking-wide">{item.title}</div><div className="truncate font-mono text-[10px] uppercase tracking-tight text-white/55">{item.subtitle}</div></div>}
      {item.progress && item.progress.percent > 0 && <progress aria-label={`${Math.round(item.progress.percent)}% watched`} value={Math.min(100, item.progress.percent)} max={100} className="player-progress absolute bottom-0 inset-x-0 h-1 w-full" />}
      {item.acquisition && <progress aria-label={`${Math.round(item.acquisition.percent)}% downloaded`} value={Math.min(100, item.acquisition.percent)} max={100} className="player-progress absolute bottom-0 inset-x-0 h-1 w-full" />}
      {!item.available && !item.acquisition && cardView !== 'list' && <span className="absolute top-2 right-2 rounded bg-black/75 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-white/65">Unavailable</span>}
    </button>
  )
}
