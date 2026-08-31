import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { PlayerMediaCard } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { MediaCard } from './Cards.js'
import { PlayerIcon, type PlayerIconName } from './Icons.js'

/**
 * What is left of the old detail surface: the pieces the item view does not
 * own. Films, series and the shelf types are drawn by ItemView now — this
 * carries the section heading and the recommendation strip that the person
 * page still lays out as a document, and the action button the episode dialog
 * shares with it.
 */

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

export function RecommendationRow({ sdk, items }: { sdk: ArchivistSdk; items: PlayerMediaCard[] }) {
  const navigate = useNavigate()
  return <div className="no-scrollbar flex gap-4 overflow-x-auto pb-5">{items.map(item => <MediaCard key={item.key} item={item} view="poster" zoneId="detail-recommendations" sdk={sdk} onFocused={() => {}} onActivate={() => navigate(item.route)} />)}</div>
}

export function MetadataPill({ children }: { children: ReactNode }) {
  return <span className="rounded-md border border-white/12 bg-black/20 px-2 py-1 font-mono text-[9.5px] uppercase tracking-[.08em] text-white/62">{children}</span>
}
