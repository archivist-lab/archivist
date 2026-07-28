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
  const isSeries = eyebrow?.toLowerCase() === 'series'
  const accent = isSeries ? 'text-violet-300' : 'player-accent'

  return <header className="relative isolate overflow-hidden border-b border-white/5 py-[clamp(2.5rem,5vw,5rem)]">
    {artwork[artworkIndex] && <img key={artwork[artworkIndex]} src={sdk.asset(artwork[artworkIndex])} alt="" className="player-artwork motion-fade absolute inset-0 -z-20 h-full w-full scale-[1.03] object-cover object-center opacity-40 blur-[1px]" />}
    <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(9,9,14,.94)_0%,rgba(9,9,14,.72)_48%,rgba(9,9,14,.88)_100%)]" />
    <div className="absolute inset-0 -z-10 bg-gradient-to-t from-[#09090e] via-transparent to-black/30" />
    <div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 gap-8 px-[var(--safe-x)] md:grid-cols-12 md:items-center lg:gap-x-16 lg:gap-y-12">
      <div className="md:col-span-4 lg:col-span-3">
        {posterUrl ? <img src={sdk.asset(posterUrl)} alt="" className="aspect-[2/3] w-full max-w-[280px] rounded-3xl object-cover opacity-90 shadow-[0_30px_80px_rgba(0,0,0,.62)] ring-1 ring-white/10" /> : <div className="grid aspect-[2/3] w-full max-w-[280px] place-items-center rounded-3xl bg-white/[.035] ring-1 ring-white/10"><span aria-hidden className="font-bebas text-7xl text-white/10">{title.slice(0, 1)}</span></div>}
      </div>
      <div className="min-w-0 md:col-span-8 lg:col-span-6">
        {eyebrow && <p className={'archivist-section-label ' + accent}>{eyebrow}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[10px] uppercase tracking-[.13em] text-white/55">{metadata}</div>
        {overview && <p className="mt-6 max-w-3xl text-[12.5px] leading-[1.75] text-white/60">{overview}</p>}
        {!!ratings?.length && <div className="mt-5 flex flex-wrap gap-2">{ratings.map(rating => <span key={rating.provider} className="inline-flex items-center gap-1.5 rounded-lg border border-white/8 bg-black/25 px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-[.1em] text-white/55"><PlayerIcon name="star" size={12} className={accent} /> {rating.value.toFixed(1)} <span className="text-white/30">{rating.provider}</span></span>)}</div>}
        <div className="mt-7 flex flex-wrap items-center gap-2.5">{children}</div>
      </div>
      <div className="min-w-0 md:col-span-12 lg:col-span-3 lg:self-center lg:text-right">
        {logoUrl ? <><h1 className="sr-only">{title}</h1><img src={sdk.asset(logoUrl)} alt="" className="max-h-28 max-w-full object-contain object-left drop-shadow-[0_3px_18px_rgba(0,0,0,.75)] lg:ml-auto lg:object-right" /></> : <h1 className="font-bebas text-[clamp(3rem,5vw,5rem)] leading-[.9] tracking-[.015em] text-white">{title}</h1>}
      </div>
    </div>
  </header>
}

export const detailPrimaryActionClass = 'player-focusable player-accent-bg inline-flex min-h-12 items-center gap-2 rounded-xl px-6 py-3 font-mono text-[10.5px] font-semibold uppercase tracking-[.12em] text-black shadow-lg shadow-black/25 transition disabled:opacity-35'

export function DetailAction({ primary = false, danger = false, disabled = false, onClick, children, label, icon }: {
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
  label?: string
  icon?: PlayerIconName
}) {
  const variant = primary ? 'player-accent-bg border-transparent text-black shadow-lg shadow-black/25' : danger ? 'border-pink/20 bg-pink/10 text-pink' : 'border-white/8 bg-white/[.055] text-white/72 hover:bg-white/10 hover:text-white'
  return <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className={'player-focusable inline-flex min-h-12 items-center gap-2 rounded-xl border px-5 py-3 font-mono text-[10.5px] font-semibold uppercase tracking-[.12em] transition disabled:opacity-35 ' + variant}>{icon && <PlayerIcon name={icon} size={16} />}{children}</button>
}

export function DetailSection({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <section className="motion-slide mx-auto w-full max-w-[1600px] px-[var(--safe-x)] py-8"><div className="mb-5 flex items-center gap-4"><h2 className="archivist-section-label shrink-0 text-white/65">{title}</h2><span className="h-px flex-1 bg-white/[.07]" />{subtitle && <p className="shrink-0 font-mono text-[9.5px] uppercase tracking-[.1em] text-white/28">{subtitle}</p>}</div>{children}</section>
}

export function DetailDock({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1600px] px-[var(--safe-x)] pt-7"><div className="player-dialog flex flex-wrap items-center gap-5 rounded-2xl border-white/[.07] bg-black/25 px-5 py-4 shadow-xl shadow-black/20">{children}</div></div>
}

export function DetailDrawer({ title, eyebrow, onClose, children, footer }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose)
  return <div ref={dialogRef} className="fixed inset-0 z-[100] flex justify-end bg-black/72" role="dialog" aria-modal="true" aria-labelledby="detail-drawer-title" onClick={onClose}>
    <section className="player-dialog motion-dialog flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-none border-y-0 border-r-0 p-[var(--safe-x)]" onClick={event => event.stopPropagation()}>
      <header className="flex items-start gap-5 border-b border-white/8 pb-6"><div className="min-w-0 flex-1">{eyebrow && <p className="archivist-section-label player-accent">{eyebrow}</p>}<h2 id="detail-drawer-title" className="mt-3 font-bebas text-3xl tracking-[.02em] text-white">{title}</h2></div><button data-dialog-initial onClick={onClose} className="player-focusable rounded-xl border border-white/8 bg-white/[.055] px-4 py-3 font-mono text-[10px] uppercase tracking-[.12em] text-white/65">Close</button></header>
      <div className="no-scrollbar flex-1 overflow-y-auto py-7">{children}</div>
      {footer && <footer className="border-t border-white/8 pt-6">{footer}</footer>}
    </section>
  </div>
}

export function PeopleRow({ sdk, people, onOpen }: { sdk: ArchivistSdk; people: PersonCredit[]; onOpen?: (person: PersonCredit) => void }) {
  return <div className="no-scrollbar flex gap-3 overflow-x-auto pb-3">{people.slice(0, 24).map((person, index) => {
    const image = person.profileUrl ?? person.profilePath as string | undefined ?? person.profile_path as string | undefined
    return <button key={String(person.id ?? person.name) + '-' + index} onClick={() => onOpen?.(person)} className="player-focusable group w-[102px] shrink-0 rounded-2xl p-2 text-left hover:bg-white/[.045]">
      <div className="aspect-square overflow-hidden rounded-2xl bg-white/[.035] ring-1 ring-white/8">{image ? <img src={sdk.asset(image)} alt="" loading="lazy" className="h-full w-full object-cover opacity-80 transition duration-300 group-hover:scale-[1.03] group-hover:opacity-100" /> : <div className="grid h-full place-items-center font-bebas text-3xl text-white/10" aria-hidden>{person.name.slice(0, 1)}</div>}</div>
      <p className="mt-2.5 truncate font-mono text-[9.5px] font-semibold uppercase tracking-[.08em] text-white/72">{person.name}</p><p className="mt-1 truncate text-[10px] italic text-white/32">{person.character ?? person.role ?? ''}</p>
    </button>
  })}</div>
}

export function RecommendationRow({ sdk, items }: { sdk: ArchivistSdk; items: PlayerMediaCard[] }) {
  const navigate = useNavigate()
  return <div className="no-scrollbar flex gap-4 overflow-x-auto pb-5">{items.map(item => <MediaCard key={item.key} item={item} view="poster" zoneId="detail-recommendations" sdk={sdk} onFocused={() => {}} onActivate={() => navigate(item.route)} />)}</div>
}

export function MetadataPill({ children }: { children: ReactNode }) {
  return <span className="rounded-md border border-white/12 bg-black/20 px-2 py-1 font-mono text-[9.5px] uppercase tracking-[.08em] text-white/62">{children}</span>
}
