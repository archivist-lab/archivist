import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { PlayerShelfDetail, PlayerShelfKind } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { catalogueRating } from '@archivist/design-system'
import { ItemView, ItemFacts, type ItemAction, type ItemRow } from '../components/ItemView.js'

const EYEBROW: Record<PlayerShelfKind, string> = { book: 'Book', comic: 'Comic', game: 'Game' }

/** Mirrors the Library's per-type tokens, resolved for the stage's rgb split. */
const ACCENT: Record<PlayerShelfKind, string> = { book: '#f1c40f', comic: '#e67e22', game: '#2ecc71' }

/**
 * Item view for books, comics and games.
 *
 * One page for the three because they return one shape, and because the parts
 * that differ — what the children are called, whether anything is playable —
 * are data rather than layout. It uses the same surface as films and series, so
 * the library reads as one application rather than three.
 */
export function ShelfDetail({ sdk, kind }: { sdk: ArchivistSdk; kind: PlayerShelfKind }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [item, setItem] = useState<PlayerShelfDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    setItem(null)
    setError(null)
    sdk.shelf(kind, Number(id)).then(setItem).catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [kind, id])

  if (error) return <div className="player-safe text-white/60">{error}</div>
  if (!item) return <div className="player-safe player-skeleton text-sm uppercase tracking-[.25em] text-white/30">Opening item</div>

  // The audiobook is the only child with a real stream, and the endpoint
  // serving it works. Playback is not wired up: the Player's target type is
  // 'film' | 'episode' and its pipeline is video-shaped — tracks, subtitles,
  // OSD — so carrying audio through it is a change to the player, not a
  // button here. Until that lands the edition is shown as present rather
  // than offered as playable, because a control that cannot work is worse
  // than none.
  const playable = item.children.find(child => child.streamUrl)
  const actions: ItemAction[] = item.arcadeUrl
    ? [{ id: 'arcade', label: 'Open Arcade', icon: 'play', primary: true, onSelect: () => { window.location.href = item.arcadeUrl! } }]
    : []

  const rows: ItemRow[] = item.childrenLabel && item.children.length ? [{
    id: 'children',
    label: item.childrenLabel,
    note: `${item.children.filter(child => child.available).length} of ${item.children.length} in your library`,
    view: 'poster',
    tiles: item.children.map(child => ({
      id: `child-${child.id}`,
      label: child.label,
      sublabel: child.available ? child.sublabel ?? 'In your library' : 'Not in your library',
      imageUrl: sdk.asset(item.posterUrl) || null,
      disabled: true,
      onSelect: () => {},
    })),
  }] : []

  // No personal ratings on these types yet, so the catalogue's score stands
  // alone rather than standing in.
  const catalogue = catalogueRating(item.ratings.find(entry => Number.isFinite(entry.value))?.value)

  return <ItemView
    eyebrow={EYEBROW[item.type]}
    title={item.title}
    logoUrl={sdk.asset(item.logoUrl) || null}
    posterUrl={sdk.asset(item.posterUrl) || null}
    backdropUrl={sdk.asset(item.backdropUrl) || null}
    accent={ACCENT[item.type]}
    catalogue={catalogue}
    meta={<ItemFacts facts={[item.attribution, ...item.metadata]} />}
    overview={item.overview}
    status={playable
      ? 'Audiobook in your library — playback is not available in the Player yet'
      : item.status === 'collected' || item.status === 'downloaded' ? 'In your library'
        : 'Not in your library yet'}
    actions={actions}
    rows={rows}
    tags={item.genres.slice(0, 4).map(genre => ({ text: genre, tone: 'cv-chip-ghost' }))}
    focusKey={`${item.type}-${item.id}`}
    onBack={() => navigate(-1)}
  />
}
