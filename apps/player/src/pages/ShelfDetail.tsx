import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { PlayerShelfDetail, PlayerShelfKind } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { DetailHero, DetailSection, detailPrimaryActionClass } from '../components/DetailSurface.js'
import { PlayerIcon } from '../components/Icons.js'

const EYEBROW: Record<PlayerShelfKind, string> = { book: 'Book', comic: 'Comic', game: 'Game' }

/**
 * Item view for books, comics and games.
 *
 * One page for the three because they return one shape, and because the parts
 * that differ — what the children are called, whether anything is playable —
 * are data rather than layout. It uses the same hero as films and series, so
 * the library reads as one application rather than three.
 */
export function ShelfDetail({ sdk, kind }: { sdk: ArchivistSdk; kind: PlayerShelfKind }) {
  const { id } = useParams<{ id: string }>()
  const [item, setItem] = useState<PlayerShelfDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!id) return
    setItem(null)
    setError(null)
    sdk.shelf(kind, Number(id)).then(setItem).catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [kind, id])

  useEffect(() => { if (item) primaryRef.current?.focus() }, [item])

  if (error) return <div className="p-[var(--safe-x)] text-white/60">{error}</div>
  if (!item) return <div className="p-[var(--safe-x)] text-white/40">Loading…</div>

  // The audiobook is the only child with a real stream, and the endpoint
  // serving it works. Playback is not wired up: the Player's target type is
  // 'film' | 'episode' and its pipeline is video-shaped — tracks, subtitles,
  // OSD — so carrying audio through it is a change to the player, not a
  // button here. Until that lands the edition is shown as present rather
  // than offered as playable, because a control that cannot work is worse
  // than none.
  const playable = item.children.find(child => child.streamUrl)
  const meta = <>
    {item.attribution && <span>{item.attribution}</span>}
    {item.metadata.map(fact => <span key={fact}>{fact}</span>)}
  </>

  return <div data-route-scroll className="motion-fade h-full overflow-y-auto no-scrollbar pb-24">
    <DetailHero
      sdk={sdk}
      title={item.title}
      logoUrl={item.logoUrl}
      posterUrl={item.posterUrl}
      backdropUrl={item.backdropUrl}
      eyebrow={EYEBROW[item.type]}
      metadata={meta}
      overview={item.overview}
      ratings={item.ratings}
    >
      {item.arcadeUrl && <a ref={primaryRef as never} href={item.arcadeUrl} className={detailPrimaryActionClass}><PlayerIcon name="play" size={18} />Open Arcade</a>}
      <span className="text-sm text-white/42">
        {playable ? 'Audiobook in your library — playback is not available in the Player yet'
          : item.status === 'collected' || item.status === 'downloaded' ? 'In your library'
          : 'Not in your library yet'}
      </span>
    </DetailHero>

    {item.children.length > 0 && item.childrenLabel && <DetailSection title={item.childrenLabel} subtitle={`${item.children.filter(child => child.available).length} of ${item.children.length} available`}>
      <ul className="grid gap-2">
        {item.children.map(child => <li
          key={child.id}
          className={`flex items-center gap-4 rounded-xl border px-4 py-3 ${child.available ? 'border-white/8 bg-white/[.04]' : 'border-white/[.03] bg-white/[.015]'}`}
        >
          <span className={`min-w-0 flex-1 truncate text-[13px] ${child.available ? 'text-white/85' : 'text-white/40'}`}>{child.label}</span>
          {child.sublabel && <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[.1em] text-white/35">{child.sublabel}</span>}
          {child.available && <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[.1em] text-emerald-300/70">In library</span>}
        </li>)}
      </ul>
    </DetailSection>}

    {item.genres.length > 0 && <DetailSection title="Genres">
      <div className="flex flex-wrap gap-2">
        {item.genres.map(genre => <span key={genre} className="rounded-md border border-white/12 bg-black/20 px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[.08em] text-white/62">{genre}</span>)}
      </div>
    </DetailSection>}
  </div>
}
