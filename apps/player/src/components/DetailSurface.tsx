import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { PersonCredit, PlayerMediaCard, PlayerRating } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { MediaCard } from './Cards.js'
import { PlayerIcon, type PlayerIconName } from './Icons.js'
import { useDialogFocus } from '../focus/useDialogFocus.js'

/**
 * Five stars with half-star precision, from a 0-10 provider score. Stars read
 * at a distance where "7.5" does not, which is what the ten-foot layout needs.
 */
function StarRating({ value, className = '' }: { value: number; className?: string }) {
  const outOfFive = Math.max(0, Math.min(5, value / 2))
  return <span className={'inline-flex items-center gap-[3px] ' + className} aria-label={`${value.toFixed(1)} out of 10`}>
    {[0, 1, 2, 3, 4].map(index => {
      const fill = Math.max(0, Math.min(1, outOfFive - index))
      return <span key={index} className="relative inline-block h-[15px] w-[15px]">
        <PlayerIcon name="star" size={15} className="absolute inset-0 text-white/25" />
        {/* PlayerIcon is stroke-only by default; the filled layer has to say so
            explicitly or a full star is indistinguishable from an empty one. */}
        {fill > 0 && <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
          <PlayerIcon name="star" size={15} className="text-white" fill="currentColor" />
        </span>}
      </span>
    })}
  </span>
}

/**
 * Item view for every media type.
 *
 * The artwork is the page rather than a panel beside it: full-bleed and
 * anchored right, with the text sitting in a scrim over the left third. That
 * only holds while the right of the frame stays legible, so the scrim is a
 * horizontal ramp rather than a flat wash, and a second vertical ramp carries
 * the image into the rails below with no visible seam.
 *
 * Nothing here is film-specific. Books, comics and games rarely have a
 * backdrop, so a poster is promoted to fill that role — cropped wide and
 * blurred, since a 2:3 cover stretched across a 21:9 frame is unusable
 * otherwise. That keeps one component serving every type instead of each
 * growing its own hero.
 */
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
  // Falling back to the poster is what lets a book or a comic use this layout.
  const usingPoster = artwork.length === 0 && !!posterUrl
  const frames = artwork.length ? artwork : posterUrl ? [posterUrl] : []
  const [artworkIndex, setArtworkIndex] = useState(0)
  useEffect(() => { setArtworkIndex(0); if (!cycleSeconds || frames.length < 2) return; const timer = window.setInterval(() => setArtworkIndex(index => (index + 1) % frames.length), cycleSeconds * 1000); return () => clearInterval(timer) }, [cycleSeconds, frames.join('|')])

  const isSeries = eyebrow?.toLowerCase() === 'series'
  const accent = isSeries ? 'text-violet-300' : 'player-accent'
  const primaryRating = ratings?.find(rating => Number.isFinite(rating.value))

  return <header className="relative isolate flex min-h-[clamp(30rem,62vh,46rem)] flex-col justify-end overflow-hidden">
    {frames[artworkIndex] && <img
      key={frames[artworkIndex]}
      src={sdk.asset(frames[artworkIndex])}
      alt=""
      className={'motion-fade absolute inset-0 -z-20 h-full w-full object-cover ' + (usingPoster ? 'scale-110 object-center blur-xl opacity-55' : 'object-right opacity-95')}
    />}
    {/* Horizontal ramp: opaque behind the text, clear over the artwork. */}
    <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,#07070b_0%,#07070b_26%,rgba(7,7,11,.86)_44%,rgba(7,7,11,.45)_64%,rgba(7,7,11,.12)_82%,transparent_100%)]" />
    {/* Vertical ramp: hands the image off to the rails with no seam. */}
    <div className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(7,7,11,.55)_0%,transparent_26%,transparent_58%,#07070b_100%)]" />

    <div className="mx-auto w-full max-w-[1600px] px-[var(--safe-x)] pb-[clamp(1.5rem,4vh,3.5rem)] pt-[clamp(3rem,9vh,7rem)]">
      <div className="min-w-0 max-w-[min(46rem,52%)]">
        {eyebrow && <p className={'archivist-section-label mb-3 ' + accent}>{eyebrow}</p>}

        {logoUrl
          ? <><h1 className="sr-only">{title}</h1><img src={sdk.asset(logoUrl)} alt="" className="max-h-[clamp(4.5rem,11vh,8rem)] max-w-[min(100%,34rem)] object-contain object-left drop-shadow-[0_4px_22px_rgba(0,0,0,.85)]" /></>
          : <h1 className="font-bebas text-[clamp(2.75rem,6vw,5.25rem)] leading-[.88] tracking-[.015em] text-white drop-shadow-[0_4px_22px_rgba(0,0,0,.7)]">{title}</h1>}

        {/* Info badge, stars, then the caller's facts — bullet separated, as
            one line of text rather than a row of competing chips. */}
        <div className="mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[clamp(.8rem,1.05vw,1rem)] text-white/78">
          <span aria-hidden className="grid h-[22px] w-[26px] place-items-center rounded-[5px] bg-white/85 text-black"><PlayerIcon name="info" size={13} /></span>
          {primaryRating && <StarRating value={primaryRating.value} />}
          <span className="contents [&>*:not(:first-child)]:before:mx-2.5 [&>*:not(:first-child)]:before:text-white/35 [&>*:not(:first-child)]:before:content-['•']">{metadata}</span>
        </div>

        {overview && <p className="mt-5 max-w-[46rem] text-[clamp(.9rem,1.15vw,1.15rem)] leading-[1.55] text-white/82 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3] overflow-hidden">{overview}</p>}

        {!!ratings?.length && <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[clamp(.8rem,1.05vw,1rem)] text-white/72">
          {ratings.map(rating => <span key={rating.provider} className="inline-flex items-center gap-2">
            <PlayerIcon name="star" size={17} className={accent} />
            <span className="tabular-nums">{rating.value.toFixed(1)}</span>
            <span className="text-white/38">{rating.provider}</span>
          </span>)}
        </div>}

        <div className="mt-7 flex flex-wrap items-center gap-2.5">{children}</div>
      </div>
    </div>
  </header>
}

/** "1 hr 47 mins" — spelled out, because the hero is read from a sofa. */
export function formatRuntime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (!hours) return `${minutes} min${minutes === 1 ? '' : 's'}`
  if (!minutes) return `${hours} hr${hours === 1 ? '' : 's'}`
  return `${hours} hr${hours === 1 ? '' : 's'} ${minutes} min${minutes === 1 ? '' : 's'}`
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
