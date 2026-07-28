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
  return <Link to={item.to} className="group block w-[138px] shrink-0 overflow-hidden rounded-xl border border-white/5 bg-noir-800 text-left shadow-lg shadow-black/40 outline-none transition-all hover:border-white/20 focus-visible:border-cyan/60 sm:w-[152px]">
    <CardArtwork src={item.posterUrl ? sdk.asset(item.posterUrl) : ''} title={item.title} aspect="aspect-[2/3]" watched={item.watched} badge={item.badge} progress={item.progressPct} progressLabel="watched" />
    <CardFooter title={item.title} subtitle={item.subtitle} status={item.watched ? 'Watched' : null} />
  </Link>
}

export function LandscapeCard({ item, sdk }: { item: CardItem; sdk: ArchivistSdk }) {
  const image = item.backdropUrl || item.posterUrl
  return <Link to={item.to} className="group block w-[240px] shrink-0 overflow-hidden rounded-xl border border-white/5 bg-noir-800 text-left shadow-lg shadow-black/40 outline-none transition-all hover:border-white/20 focus-visible:border-cyan/60 sm:w-[264px]">
    <CardArtwork src={image ? sdk.asset(image) : ''} title={item.title} aspect="aspect-video" watched={item.watched} badge={item.badge} progress={item.progressPct} progressLabel="watched" />
    <CardFooter title={item.title} subtitle={item.subtitle} status={item.watched ? 'Watched' : null} />
  </Link>
}

function CardArtwork({ src, title, aspect, watched, badge, progress, progressLabel, onError }: {
  src: string; title: string; aspect: string; watched?: boolean; badge?: string | null
  progress?: number; progressLabel: 'watched' | 'downloaded'; onError?: () => void
}) {
  return <div className={`relative ${aspect} overflow-hidden bg-noir-700`}>
    {src ? <img src={src} alt="" loading="lazy" decoding="async" onError={onError} className="absolute inset-0 h-full w-full object-cover opacity-80 transition duration-300 group-hover:scale-[1.02] group-hover:opacity-100" />
      : <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-noir-700 via-noir-900 to-noir-950 p-4 text-center font-display uppercase tracking-wide text-white/20" aria-hidden="true">{title.slice(0, 1)}</div>}
    <div className="absolute inset-0 bg-gradient-to-t from-noir-950/60 to-transparent" />
    {watched && <WatchedCheck className="absolute right-2 top-2" />}
    {badge && !watched && <span className="absolute right-2 top-2 rounded bg-noir-950/80 px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-white/70">{badge}</span>}
    {progress !== undefined && progress > 0 && <progress aria-label={`${Math.round(progress)}% ${progressLabel}`} value={Math.min(progress, 100)} max={100} className="player-progress absolute inset-x-0 bottom-0 h-1 w-full" />}
  </div>
}

function CardFooter({ title, subtitle, status }: { title: string; subtitle?: string | null; status?: string | null }) {
  return <div className="relative flex min-h-[70px] flex-col justify-center border-t border-white/5 bg-noir-900/40 p-3">
    <p className="truncate font-display text-[13px] uppercase tracking-wide text-white transition-colors group-hover:text-white/70">{title}</p>
    {subtitle && <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-tight text-white/60">{subtitle}</p>}
    {status && <p className="mt-0.5 truncate text-[10px] font-bold uppercase tracking-widest text-white">{status}</p>}
  </div>
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
  item: PlayerMediaCard; view: PlayerView; zoneId: string; sdk: ArchivistSdk
  onFocused: (item: PlayerMediaCard) => void; onActivate: (item: PlayerMediaCard) => void; hubLayout?: PlayerHubLayout
}) {
  const [failed, setFailed] = useState(false)
  const focusable = useFocusable({ id: `card-${item.key}`, zoneId, disabled: false, onFocused: () => onFocused(item), onActivate: () => { if (item.route) onActivate(item) } })
  const cardView: PlayerView = item.acquisition ? item.acquisition.kind === 'episode' ? 'landscape' : 'poster' : view
  const source = cardView === 'poster' || cardView === 'wall' ? item.posterUrl : item.landscapeUrl || item.posterUrl
  const image = failed ? '' : safeArtwork(sdk, source)
  const fill = hubLayout === 'wall'
  const width = cardView === 'poster' ? (fill ? 'w-full' : 'w-[clamp(150px,12.7vw,244px)]')
    : cardView === 'wall' ? (fill ? 'w-full' : 'w-[clamp(112px,9.1vw,174px)]')
    : cardView === 'list' ? 'w-full' : (fill ? 'w-full' : 'w-[clamp(248px,18.6vw,356px)]')

  if (cardView === 'list') return <button {...focusable} type="button" aria-label={`${item.title}${item.subtitle ? `, ${item.subtitle}` : ''}`} data-card-layout={hubLayout}
    className="player-card player-focusable motion-focus group relative h-[68px] w-full shrink-0 snap-start overflow-hidden rounded-xl border border-white/5 bg-noir-800 text-left shadow-lg">
    {image ? <img src={image} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="absolute inset-y-0 left-0 h-full w-[72px] object-cover opacity-80" />
      : <div className="absolute inset-y-0 left-0 grid w-[72px] place-items-center bg-noir-700 font-display text-white/20">{item.title.slice(0, 1)}</div>}
    <div className="absolute inset-y-0 left-[88px] right-4 flex items-center gap-4"><div className="min-w-0 flex-1"><div className="truncate font-display uppercase tracking-wide text-white">{item.title}</div>{item.subtitle && <div className="truncate font-mono text-[10px] uppercase tracking-tight text-white/60">{item.subtitle}</div>}</div><div className="flex shrink-0 gap-2">{item.badges.slice(0, 2).map(badge => <span key={badge.label} className="rounded border border-white/15 px-2 py-1 font-mono text-[10px] uppercase text-white/60">{badge.label}</span>)}</div>{!item.available && !item.acquisition && <span className="shrink-0 font-mono text-[10px] uppercase text-white/60">Unavailable</span>}</div>
    {item.progress && item.progress.percent > 0 && <progress aria-label={`${Math.round(item.progress.percent)}% watched`} value={Math.min(100, item.progress.percent)} max={100} className="player-progress absolute inset-x-0 bottom-0 h-1 w-full" />}
    {item.acquisition && <progress aria-label={`${Math.round(item.acquisition.percent)}% downloaded`} value={Math.min(100, item.acquisition.percent)} max={100} className="player-progress absolute inset-x-0 bottom-0 h-1 w-full" />}
  </button>

  const aspect = cardView === 'landscape' ? 'aspect-video' : 'aspect-[2/3]'
  const metadata = [item.subtitle, ...item.badges.slice(0, 2).map(badge => badge.label)].filter(Boolean).join(' / ')
  const watched = !item.acquisition && (item.progress?.percent ?? 0) >= 99.5
  const status = item.acquisition ? `${Math.round(item.acquisition.percent)}% downloading` : !item.available ? 'Unavailable' : watched ? 'Watched' : null
  return <button {...focusable} type="button" aria-label={`${item.title}${item.subtitle ? `, ${item.subtitle}` : ''}`} data-card-layout={hubLayout}
    className={`player-card player-focusable motion-focus group shrink-0 snap-start overflow-hidden rounded-xl border border-white/5 bg-noir-800 text-left shadow-lg shadow-black/40 transition-colors hover:border-white/20 ${width}`}>
    <CardArtwork src={image} title={item.title} aspect={aspect} watched={watched} progress={item.acquisition?.percent ?? item.progress?.percent} progressLabel={item.acquisition ? 'downloaded' : 'watched'} onError={() => setFailed(true)} />
    <CardFooter title={item.title} subtitle={metadata || null} status={status} />
  </button>
}
