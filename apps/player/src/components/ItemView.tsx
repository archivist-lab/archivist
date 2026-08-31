import { useEffect, useRef, type ReactNode } from 'react'
import type { PersonCredit, ResolvedRating } from '@archivist/contracts'
import { LevelStatic } from '@archivist/design-system'
import { PlayerIcon, type PlayerIconName } from './Icons.js'
import { accentParts, fanartStyle, useStage } from './stage.js'

/**
 * The item view — one film, series, book, comic or game.
 *
 * Same 1920x1080 stage and the same backdrop furniture as the Combined view,
 * so opening an item reads as a change of content rather than a change of
 * product. Where that surface binds its info panel to whatever tile is
 * focused, this one is fixed on the item: poster, title treatment, facts and
 * controls stay put while the rows underneath are walked.
 *
 * Nothing here is film-specific. What differs between media types is the rows
 * a page hands over and the controls it offers, both of which are data, so one
 * component serves every type instead of each growing its own item page.
 *
 * Focus is real DOM focus on real buttons rather than an index this component
 * tracks: the shell's spatial controller already moves between them with the
 * arrows, activates with Enter and leaves with Back, and a tile that is a
 * button is also a tile a screen reader and a pointer can use.
 */

export interface ItemAction {
  id: string
  label: string
  icon?: PlayerIconName
  /** The one control the page opens on. At most one per page. */
  primary?: boolean
  disabled?: boolean
  /** Set only for a control that shows a state rather than performing a verb. */
  pressed?: boolean
  onSelect: () => void
}

export type ItemRowView = 'poster' | 'landscape' | 'person'

export interface ItemTile {
  id: string
  label: string
  sublabel?: string | null
  imageUrl?: string | null
  /** Drawn over the artwork — an episode still says nothing about its show. */
  logoUrl?: string | null
  /** Corner number, for an episode or an issue. */
  ordinal?: string | null
  watched?: boolean
  /** 0-100. */
  progress?: number
  /**
   * Selection the row itself keeps — which season is being shown. Left unset
   * for a tile that simply opens something, which is not a toggle.
   */
  selected?: boolean
  disabled?: boolean
  onSelect: () => void
}

export interface ItemRow {
  id: string
  label: string
  /** Count or qualifier, printed beside the heading. */
  note?: string | null
  view?: ItemRowView
  tiles: ItemTile[]
  /** Stands in for the tiles when the row resolves to nothing. */
  empty?: string
}

export interface ItemChip { text: string; tone?: string }

function Tile({ tile }: { tile: ItemTile }) {
  return <button
    type="button"
    className="player-focusable iv-tile"
    aria-label={tile.sublabel ? `${tile.label} · ${tile.sublabel}` : tile.label}
    {...(tile.selected === undefined ? {} : { 'aria-pressed': tile.selected })}
    disabled={tile.disabled}
    onClick={tile.onSelect}
  >
    <span className="iv-tile-frame">
      {tile.imageUrl
        ? <img src={tile.imageUrl} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none' }} />
        : <span aria-hidden className="iv-tile-initial">{tile.label.slice(0, 1).toUpperCase()}</span>}
      {tile.ordinal && <span aria-hidden className="iv-tile-ordinal">{tile.ordinal}</span>}
      {tile.logoUrl && <img className="iv-tile-logo" src={tile.logoUrl} alt="" loading="lazy"
        onError={event => { event.currentTarget.style.display = 'none' }} />}
      {!!tile.progress && <span className="iv-tile-prog"><i style={{ width: `${tile.progress}%` }} /></span>}
      {tile.watched && <span aria-hidden className="iv-tile-check">✓</span>}
    </span>
    <span className="iv-tile-text">
      <span className="iv-tile-label">{tile.label}</span>
      {tile.sublabel && <span className="iv-tile-sub">{tile.sublabel}</span>}
    </span>
  </button>
}

export function ItemView({
  eyebrow, title, logoUrl, posterUrl, backdropUrl, accent = '#7d8590',
  rating, catalogue, meta, overview, status, actions, rows, chips = [], tags = [],
  focusKey, onBack, children,
}: {
  eyebrow?: string | null
  title: string
  logoUrl?: string | null
  posterUrl?: string | null
  backdropUrl?: string | null
  /** Hex. Drives the glows, the title, the focused tile ring and the primary control. */
  accent?: string | null
  /** The viewer's own rating. Drawn in the accent when they have set one. */
  rating?: ResolvedRating | null
  /** The catalogue's score on the same 0-5 scale, shown greyed when they have not. */
  catalogue?: number | null
  /** Bullet-separated facts. Rendered as siblings so the separators fall between them. */
  meta?: ReactNode
  overview?: string | null
  /** One line under the controls — why a control is missing, usually. */
  status?: ReactNode
  actions: ItemAction[]
  rows: ItemRow[]
  /** Technical facts, gathered at the left of the strip along the bottom. */
  chips?: ItemChip[]
  /** Editorial facts — classification, studio, genres — gathered at the right. */
  tags?: ItemChip[]
  /**
   * Identity of the thing being shown. Changing it moves focus back to the
   * primary control, which is where a newly opened item has to start.
   */
  focusKey?: string | number
  onBack?: () => void
  /** Dialogs the page owns: media, editions, information. */
  children?: ReactNode
}) {
  const { rootRef, compact, stage } = useStage()
  const primaryRef = useRef<HTMLButtonElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const [ar, ag, ab] = accentParts(accent || '#7d8590')
  const backdrop = backdropUrl || posterUrl || 'linear-gradient(112deg,#1a1d24 0%,#0d0f14 46%,#06070a 100%)'
  // A poster promoted to backdrop is cropped wide and blurred: a 2:3 cover
  // stretched across a 21:9 frame is unusable otherwise.
  const usingPoster = !backdropUrl && !!posterUrl

  // Back is the fallback: a book has no primary control, and a page that opens
  // with nothing focused strands a remote.
  useEffect(() => { requestAnimationFrame(() => (primaryRef.current ?? backRef.current)?.focus()) }, [focusKey])

  return <>
    <div ref={rootRef} className={`iv${compact ? ' compact' : ''}`} style={{ ['--ar' as string]: ar, ['--ag' as string]: ag, ['--ab' as string]: ab }}>
      <div className="cv-bg">
        <div className="cv-fanart" style={{ ...fanartStyle(backdrop), ...(usingPoster ? { filter: 'blur(26px) saturate(.9)', opacity: .5, transform: 'scale(1.1)' } : {}) }} />
        <div className="cv-glow cv-glow-a" /><div className="cv-glow cv-glow-b" />
        <div className="cv-scrim-x" /><div className="cv-scrim-y" />
        <div className="cv-vig" /><div className="cv-grain" />
      </div>

      <div className="iv-stage" style={compact ? undefined : { width: stage.width, transform: `scale(${stage.scale})` }}>
        <div className="iv-top">
          {onBack && <button ref={backRef} type="button" className="player-focusable iv-back" onClick={onBack}>
            <PlayerIcon name="chevron-left" size={20} />Back
          </button>}
          {eyebrow && <span className="iv-eyebrow">{eyebrow}</span>}
        </div>

        {/* Poster and text are one block, and the rows follow it rather than
            starting at a fixed height: eight controls wrap to a second line on
            a film, and a band pinned above that would have run under them. */}
        <div className="iv-head">
          <div className="iv-poster">
            {posterUrl
              ? <img src={posterUrl} alt="" onError={event => { event.currentTarget.style.display = 'none' }} />
              : <span aria-hidden className="iv-poster-fallback">{title.slice(0, 1).toUpperCase()}</span>}
          </div>

          <section className="iv-info">
            <h1 className="iv-title-slot">
              {logoUrl
                ? <img className="iv-title-logo" src={logoUrl} alt={title} onError={event => { event.currentTarget.style.display = 'none' }} />
                : <span className="iv-title">{title.toUpperCase()}</span>}
            </h1>
            <div className="iv-line">
              {/* The rating the rest of the app uses, read only — setting one is
                  what the Rate control is for. Absent only when neither the
                  viewer nor the catalogue has a score to show. */}
              {(rating?.value ?? 0) > 0
                ? <LevelStatic value={rating!.value!} source={rating!.source === 'inherited' ? 'inherited' : 'own'}
                    size={compact ? 'compact' : 'default'} accent={accent ?? undefined} className="iv-level" />
                : catalogue != null && catalogue > 0
                  ? <LevelStatic value={catalogue} source="catalogue" size={compact ? 'compact' : 'default'} className="iv-level" />
                  : null}
              {meta && <span className="iv-meta">{meta}</span>}
            </div>
            {overview && <p className="iv-plot">{overview}</p>}

            <div className="iv-actions">
              {actions.map(action => <button
                key={action.id}
                ref={action.primary ? primaryRef : undefined}
                type="button"
                className={`player-focusable iv-btn${action.primary ? ' iv-btn-primary' : ''}`}
                disabled={action.disabled}
                {...(action.pressed === undefined ? {} : { 'aria-pressed': action.pressed })}
                onClick={action.onSelect}
              >{action.icon && <PlayerIcon name={action.icon} size={20} />}{action.label}</button>)}
            </div>
            {status && <p className="iv-status">{status}</p>}
          </section>
        </div>

        <div className="iv-rows">
          {rows.map(row => <section className="iv-row" key={row.id} aria-label={row.label}>
            <h2 className="cv-row-heading iv-row-heading">
              {row.label}
              {row.note && <span className="cv-row-count">{row.note}</span>}
            </h2>
            {row.tiles.length
              ? <div className="iv-strip" data-view={row.view ?? 'poster'}>
                {row.tiles.map(tile => <Tile key={tile.id} tile={tile} />)}
              </div>
              : <p className="iv-empty">{row.empty ?? 'Nothing here yet.'}</p>}
          </section>)}
        </div>

        <footer className="cv-footer">
          {chips.map((chip, index) => <span key={chip.text + index} className={`cv-chip ${chip.tone ?? 'cv-chip-neutral'}`}>{chip.text}</span>)}
          <span className="cv-footer-right">
            {tags.map((tag, index) => <span key={tag.text + index} className={`cv-chip ${tag.tone ?? 'cv-chip-neutral'}`}>{tag.text}</span>)}
          </span>
        </footer>
      </div>
    </div>

    {/* Outside the stage: it cancels the app's presentation zoom to fit its own
        1920x1080 canvas, and a dialog drawn inside it would come out 18% larger
        than the same dialog anywhere else in the Player. */}
    {children}
  </>
}

/**
 * Bullet-separated facts for the meta line, as one line of text rather than a
 * row of competing chips. Empty values drop out so no separator is left loose.
 */
export function ItemFacts({ facts }: { facts: Array<string | number | null | undefined> }) {
  const written = facts.filter((fact): fact is string | number => fact != null && fact !== '')
  return <>{written.map((fact, index) => <span key={String(fact) + index}>
    {index > 0 && <span className="cv-dot"> • </span>}{fact}
  </span>)}</>
}

/** "1 hr 47 mins" — spelled out, because this is read from a sofa. */
export function formatRuntime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (!hours) return `${minutes} min${minutes === 1 ? '' : 's'}`
  if (!minutes) return `${hours} hr${hours === 1 ? '' : 's'}`
  return `${hours} hr${hours === 1 ? '' : 's'} ${minutes} min${minutes === 1 ? '' : 's'}`
}

/**
 * Classification tones, mirroring the Library's badge colours so a rating is
 * the same colour wherever it appears. Values match client/src/components/ui.tsx.
 */
const CERTIFICATION_TONE: Record<string, string> = {
  G: 'cv-chip-green', 'TV-G': 'cv-chip-green',
  PG: 'cv-chip-blue', 'TV-PG': 'cv-chip-blue',
  'PG-13': 'cv-chip-yellow', 'TV-14': 'cv-chip-yellow', M: 'cv-chip-yellow', 'MA15+': 'cv-chip-yellow',
  R: 'cv-chip-red', 'TV-MA': 'cv-chip-red', '18': 'cv-chip-red',
  'NC-17': 'cv-chip-purple',
}

export function certificationTone(certification: string): string {
  return CERTIFICATION_TONE[certification.toUpperCase()] ?? 'cv-chip-neutral'
}

/**
 * A credit's portrait. The field has been spelled three ways by the providers
 * this data has passed through, and a cast row with holes in it looks broken.
 */
export function personImage(person: PersonCredit): string | null {
  return (person.profileUrl ?? person.profilePath as string | null | undefined ?? person.profile_path as string | null | undefined) ?? null
}

/**
 * What the credit says under the name. Cast carry a character and crew a job,
 * and the stored blobs spell the latter `job` — reading only `role` left every
 * crew tile captioned with a name and a blank line.
 */
export function personRole(person: PersonCredit): string | null {
  return (person.character ?? person.role ?? person.job as string | null | undefined) ?? null
}
