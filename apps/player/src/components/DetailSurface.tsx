import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { PersonCredit, PlayerMediaCard, PlayerRating } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { MediaCard } from './Cards.js'
import { PlayerIcon, type PlayerIconName } from './Icons.js'
import { useDialogFocus } from '../focus/useDialogFocus.js'

export function DetailHero({ sdk, title, logoUrl, posterUrl, backdropUrl, artworkUrls = [], cycleSeconds = 0, eyebrow, metadata, overview, ratings, children }: {
  sdk: ArchivistSdk
  title: string
  logoUrl?: string | null
  posterUrl?: string | null
  backdropUrl?: string | null
  artworkUrls?: string[]
  cycleSeconds?: number
  eyebrow?: string | null
  metadata: ReactNode
  overview?: string | null
  ratings?: PlayerRating[]
  children: ReactNode
}) {
  const artwork = artworkUrls.length ? artworkUrls : backdropUrl ? [backdropUrl] : []
  const [artworkIndex, setArtworkIndex] = useState(0)
  useEffect(() => { setArtworkIndex(0); if (!cycleSeconds || artwork.length < 2) return; const timer = window.setInterval(() => setArtworkIndex(index => (index + 1) % artwork.length), cycleSeconds * 1000); return () => clearInterval(timer) }, [cycleSeconds, artwork.join('|')])
  return <header className="relative min-h-[72vh] overflow-hidden border-b border-white/5">
    {artwork[artworkIndex] && <img key={artwork[artworkIndex]} src={sdk.asset(artwork[artworkIndex])} alt="" className="player-artwork motion-fade absolute inset-0 h-full w-full object-cover object-center opacity-75" />}
    <div className="absolute inset-0 bg-gradient-to-r from-[#09090e] via-[#09090e]/82 via-48% to-[#09090e]/5" />
    <div className="absolute inset-0 bg-gradient-to-t from-[#09090e] via-[#09090e]/18 to-black/28" />
    <div className="absolute inset-y-0 left-0 w-2/3 bg-[radial-gradient(circle_at_20%_45%,color-mix(in_srgb,var(--player-accent)_10%,transparent),transparent_58%)]" />
    <div className="relative grid min-h-[72vh] grid-cols-[minmax(0,1fr)_auto] items-end gap-[clamp(2rem,5vw,7rem)] px-[var(--safe-x)] pb-[clamp(3rem,7vh,6rem)] pt-[var(--safe-y)]">
      <div className="max-w-[min(52rem,62vw)] min-w-0">
        {eyebrow && <p className="mb-3 text-xs font-semibold uppercase tracking-[.24em] player-accent">{eyebrow}</p>}
        {logoUrl ? <img src={sdk.asset(logoUrl)} alt={title} className="mb-6 max-h-32 max-w-[min(38rem,72vw)] object-contain object-left drop-shadow-[0_3px_18px_rgba(0,0,0,.75)]" /> : <h1 className="mb-5 text-[clamp(3rem,5.6vw,6.2rem)] font-semibold leading-[.92] tracking-[-.05em] text-white">{title}</h1>}
        <div className="flex flex-wrap items-center gap-3 text-sm text-white/68">{metadata}</div>
        {!!ratings?.length && <div className="mt-4 flex gap-2">{ratings.map(rating => <span key={rating.provider} className="flex items-center gap-1.5 rounded-lg bg-white/8 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider"><PlayerIcon name="star" size={13} className="player-accent" /> {rating.value.toFixed(1)} <span className="text-white/35">{rating.provider}</span></span>)}</div>}
        {overview && <p className="mt-6 line-clamp-4 max-w-3xl text-[clamp(.95rem,1.15vw,1.12rem)] leading-[1.65] text-white/64">{overview}</p>}
        <div className="mt-8 flex flex-wrap items-center gap-3">{children}</div>
      </div>
      {posterUrl && <div className="hidden self-end xl:block"><img src={sdk.asset(posterUrl)} alt="" className="aspect-[2/3] w-[clamp(210px,15vw,310px)] rounded-[1.35rem] object-cover shadow-[0_35px_100px_rgba(0,0,0,.7)] ring-1 ring-white/16" /></div>}
    </div>
  </header>
}

export function DetailAction({ primary = false, danger = false, disabled = false, onClick, children, label, icon }: {
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  label?: string
  icon?: PlayerIconName
}) {
  return <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className={`player-focusable inline-flex min-h-12 items-center gap-2 rounded-full px-6 py-3 text-sm font-bold transition disabled:opacity-35 ${primary ? 'player-accent-bg shadow-lg shadow-black/35' : danger ? 'bg-pink/12 text-pink' : 'bg-white/10 text-white hover:bg-white/16'}`}>{icon && <PlayerIcon name={icon} size={18} />}{children}</button>
}

export function DetailSection({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <section className="motion-slide px-[var(--safe-x)] py-8"><div className="mb-6 flex items-end gap-4"><span className="mb-1 h-5 w-0.5 rounded-full player-accent-bg" /><h2 className="text-[clamp(1.45rem,2vw,2rem)] font-semibold tracking-tight text-white">{title}</h2>{subtitle && <p className="pb-1 text-sm text-white/38">{subtitle}</p>}</div>{children}</section>
}

export function DetailDock({ children }: { children: ReactNode }) {
  return <div className="relative z-10 -mt-7 px-[var(--safe-x)]"><div className="player-dialog flex flex-wrap items-center gap-4 rounded-3xl px-6 py-5 shadow-2xl shadow-black/35">{children}</div></div>
}

export function DetailDrawer({ title, eyebrow, onClose, children, footer }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose)
  return <div ref={dialogRef} className="fixed inset-0 z-[100] flex justify-end bg-black/72" role="dialog" aria-modal="true" aria-labelledby="detail-drawer-title" onClick={onClose}>
    <section className="player-dialog motion-dialog flex h-full w-full max-w-2xl flex-col overflow-hidden border-y-0 border-r-0 p-[var(--safe-x)]" onClick={event => event.stopPropagation()}>
      <header className="flex items-start gap-5 border-b border-white/10 pb-7"><div className="min-w-0 flex-1">{eyebrow && <p className="text-xs font-semibold uppercase tracking-[.22em] player-accent">{eyebrow}</p>}<h2 id="detail-drawer-title" className="mt-2 text-4xl font-semibold tracking-tight">{title}</h2></div><button data-dialog-initial onClick={onClose} className="player-focusable rounded-full bg-white/8 px-5 py-3 font-semibold">Close</button></header>
      <div className="no-scrollbar flex-1 overflow-y-auto py-8">{children}</div>
      {footer && <footer className="border-t border-white/10 pt-6">{footer}</footer>}
    </section>
  </div>
}

export function PeopleRow({ sdk, people, onOpen }: { sdk: ArchivistSdk; people: PersonCredit[]; onOpen?: (person: PersonCredit) => void }) {
  return <div className="no-scrollbar flex gap-4 overflow-x-auto pb-3">{people.slice(0, 24).map((person, index) => { const image = person.profileUrl ?? person.profilePath as string | undefined ?? person.profile_path as string | undefined; return <button key={`${person.id ?? person.name}-${index}`} onClick={() => onOpen?.(person)} className="player-focusable group w-32 shrink-0 rounded-2xl p-2 text-left hover:bg-white/5">
    <div className="aspect-[3/4] overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10">{image && <img src={sdk.asset(image)} alt="" loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />}</div>
    <p className="mt-3 truncate text-sm font-semibold text-white/85">{person.name}</p><p className="mt-0.5 truncate text-xs text-white/38">{person.character ?? person.role ?? ''}</p>
  </button>})}</div>
}

export function RecommendationRow({ sdk, items }: { sdk: ArchivistSdk; items: PlayerMediaCard[] }) {
  const navigate = useNavigate()
  return <div className="no-scrollbar flex gap-4 overflow-x-auto pb-5">{items.map(item => <MediaCard key={item.key} item={item} view="poster" zoneId="detail-recommendations" sdk={sdk} onFocused={() => {}} onActivate={() => navigate(item.route)} />)}</div>
}

export function MetadataPill({ children }: { children: ReactNode }) {
  return <span className="rounded-md border border-white/16 px-2.5 py-1 text-xs text-white/72">{children}</span>
}
