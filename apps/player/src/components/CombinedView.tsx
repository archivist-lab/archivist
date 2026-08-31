import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon, LevelStatic, type IconName } from '@archivist/design-system'
import { accentParts, fanartStyle, useStage } from './stage.js'

/**
 * The Combined view — the Player's browsing surface.
 *
 * A faithful port of docs/06-design/archivist-combined-view.html, which is the
 * reference for how the Player looks. The geometry is Kodi 1080i design units
 * on a fixed 1920x1080 stage scaled to the viewport; the constants below are
 * Arctic Fuse 3's native item/itemlayout sizes and the layout maths depends on
 * them, so they are not arbitrary.
 *
 * The organising rule, and the reason this is one screen rather than a list
 * page plus a detail page: the info panel binds to the *focused node's own
 * level*. Focusing a series shows the series overview, a season shows the
 * season's, an episode shows the episode's. Text never inherits upward — only
 * certificate, resolution and star rating do.
 */

/** Tile scale. Keep in sync with --k in combined.css. */
const K = 1

const AF3 = {
  poster: { w: 217.14, h: 310, lw: 257.14, lh: 350, labels: false },
  landscape: { w: 410, h: 230.625, lw: 450, lh: 270.625, labels: true },
} as const

type LayoutName = keyof typeof AF3

/**
 * Every box scales by K. The focus park position stays proportional to how
 * many tiles now fit, so the strip still starts moving at the same point.
 */
const LAYOUT = Object.fromEntries(Object.entries(AF3).map(([name, v]) => {
  const w = v.w * K, h = v.h * K, lw = v.lw * K, lh = v.lh * K
  const nativeVisible = Math.floor((1920 - 80) / v.lw)
  const nativeFocus = name === 'poster' ? 5 : 3
  const visible = Math.floor((1920 - 80) / lw)
  return [name, { w, h, lw, lh, labels: v.labels, wide: name === 'landscape', focus: Math.round(visible * (nativeFocus / nativeVisible)) }]
})) as Record<LayoutName, { w: number; h: number; lw: number; lh: number; labels: boolean; wide: boolean; focus: number }>


/**
 * The row is bottom-anchored, and what gets anchored is the whole cell — tile
 * plus the label block beneath it — not the tile alone. Anchoring the tile
 * left poster rows short of the screen bottom by the height of a label that
 * was not there, wasting ~180px, while episode rows ran past the baseline by
 * exactly that much.
 */
const ROW_BASELINE = 984

/** Label block below a tile: the 16px gap plus its two lines, both scaled. */
const LABEL_BLOCK = 80

/** Must match --cv-bleed in combined.css. */
const VIEWPORT_BLEED = 120
const PAD = 80

export type CombinedKind = 'node' | 'series' | 'season' | 'episode' | 'film' | 'item'

/**
 * Track counts and their languages. The two differ: a track can carry no
 * language tag at all — a commentary, usually — so it is counted but named
 * nowhere. Counting tracks and listing languages separately keeps both honest.
 */
export interface TrackLanguage {
  /** ffprobe tag ('eng', 'fr'), used to pick a flag. */
  code: string | null
  label: string
}

export interface TrackSummary {
  /** From the container, which is more reliable than a release-name parse. */
  videoCodec: string | null
  /** The default audio track's codec — the one that will actually play. */
  audioCodec: string | null
  /** Its channel layout, written numerically: 5.1, 7.1, 2.0. */
  audioChannels: string | null
  /** Not displayed; decides whether the group is drawn at all. */
  audioCount: number
  audio: TrackLanguage[]
  subtitleCount: number
  subtitles: TrackLanguage[]
}

/**
 * One node of the browse tree. Every node carries its own overview because the
 * info panel binds to the focused level and must never inherit text upward.
 */
export interface CombinedNode {
  id: string
  type: CombinedKind
  label: string
  overview?: string | null
  /** Artwork for the tile. Falls back to a tinted placeholder. */
  imageUrl?: string | null
  /** Full-bleed backdrop shown while this node's subtree is focused. */
  fanart?: string | null
  /** Transparent title treatment used in the hero instead of typeset text. */
  logoUrl?: string | null
  /** Drives glows, title, tab underline and the focused tile ring. */
  accent?: string | null
  tint?: string | null
  network?: string | null
  /**
   * What the caption under the tile reads, when that differs from the name the
   * hero carries. An episode in a cross-library row is a case of both: the
   * hero identifies the show, the caption identifies the episode.
   */
  tileLabel?: string
  /** Ident drawn beside the label in the folder strip. */
  icon?: IconName
  /**
   * Tile shape for the row this node sits in, when its kind does not already
   * imply one. A folder is a poster by default; a box set asks for landscape.
   */
  view?: LayoutName
  /** Inheritable: these fall back up the chain. */
  res?: string | null
  studio?: string | null
  source?: string | null
  codec?: string | null
  country?: string | null
  genres?: string[] | null
  mpaa?: string | null
  stars?: number | null
  premiered?: string | null
  rt?: string | null
  status?: string | null
  runtime?: string | null
  season?: number | null
  episode?: number | null
  watched?: boolean
  /** 0-100. */
  progress?: number
  children?: CombinedNode[]
  /**
   * Resolves audio and subtitle languages for this node, if it is a playable
   * leaf. A thunk rather than data because it costs a request per item: the
   * view calls it only for whatever focus settles on, and caches the result.
   */
  loadTracks?: () => Promise<TrackSummary | null>
  /** Called instead of descending when the node is a leaf. */
  onActivate?: () => void
}

const LAYOUT_FOR: Partial<Record<CombinedKind, LayoutName>> = { series: 'poster', season: 'poster', episode: 'landscape', film: 'poster' }

/** A row's tile shape: what its first node asks for, else what its kind implies. */
function layoutFor(nodes: CombinedNode[]) {
  const first = nodes[0]
  return LAYOUT[first?.view ?? LAYOUT_FOR[first?.type ?? 'node'] ?? 'poster']
}
const NODE_ART = 'linear-gradient(112deg,#1a1d24 0%,#0d0f14 46%,#06070a 100%)'

/*
 * Footer furniture, matching the Library's vocabulary so the two surfaces read
 * as one product: tinted certification badges, neutral spec chips, and real
 * flags for languages. Values mirror client/src/components/ui.tsx.
 */

const CERTIFICATION_TONE: Record<string, string> = {
  G: 'cv-chip-green', 'TV-G': 'cv-chip-green',
  PG: 'cv-chip-blue', 'TV-PG': 'cv-chip-blue',
  'PG-13': 'cv-chip-yellow', 'TV-14': 'cv-chip-yellow', M: 'cv-chip-yellow', 'MA15+': 'cv-chip-yellow',
  R: 'cv-chip-red', 'TV-MA': 'cv-chip-red', '18': 'cv-chip-red',
  'NC-17': 'cv-chip-purple',
}

/** Language tag to the flag of its most representative country. */
const LANGUAGE_COUNTRY: Record<string, string> = {
  en: 'gb', eng: 'gb', ja: 'jp', jpn: 'jp', fr: 'fr', fra: 'fr', fre: 'fr',
  ko: 'kr', kor: 'kr', de: 'de', deu: 'de', ger: 'de', es: 'es', spa: 'es',
  it: 'it', ita: 'it', ru: 'ru', rus: 'ru', zh: 'cn', zho: 'cn', chi: 'cn',
  pt: 'br', por: 'br', nl: 'nl', nld: 'nl', dut: 'nl', da: 'dk', dan: 'dk',
  sv: 'se', swe: 'se', no: 'no', nor: 'no', fi: 'fi', fin: 'fi', pl: 'pl', pol: 'pl',
}

function Flag({ code }: { code: string | null }) {
  const country = code ? LANGUAGE_COUNTRY[code.toLowerCase()] ?? (code.length === 2 ? code.toLowerCase() : null) : null
  if (!country) return null
  return <img className="cv-flag" src={`https://flagcdn.com/w40/${country}.png`} alt="" loading="lazy"
    onError={event => { event.currentTarget.style.display = 'none' }} />
}

/** ffprobe codec names, written the way a person would read them. */
const CODEC_LABEL: Record<string, string> = {
  hevc: 'HEVC', h265: 'HEVC', h264: 'H.264', avc: 'H.264', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2',
  eac3: 'E-AC3', ac3: 'AC3', aac: 'AAC', dts: 'DTS', truehd: 'TRUEHD', flac: 'FLAC', opus: 'OPUS', mp3: 'MP3',
}

function codecLabel(codec: string | null | undefined): string | null {
  if (!codec) return null
  const key = codec.trim().toLowerCase()
  return CODEC_LABEL[key] ?? codec.trim().toUpperCase()
}

/**
 * `iIdx` indexes the row when a frame holds items directly. When it holds
 * folders — the shelf screens — `iIdx` picks the shelf and `jIdx` the tile
 * inside it.
 */
interface Frame { parents: CombinedNode[]; pIdx: number; iIdx: number; jIdx: number }

/** Tinted fallback drawn under the artwork, so a missing image still reads. */
function placeholderStyle(node: CombinedNode, wide: boolean) {
  const tint = node.tint ?? '#1a1d24'
  return { background: wide ? `linear-gradient(155deg, ${tint} 0%, #05050a 118%)` : `radial-gradient(125% 92% at 50% 12%, ${tint} 0%, #05050a 100%)` }
}

type Layout = (typeof LAYOUT)[LayoutName]

/**
 * One tile. Shared by the drill-down row and the stacked shelves, so a film
 * looks the same wherever it is shown.
 */
function Cell({ node, index, layout, focused, fallbackLabel, onFocus, onSelect }: {
  node: CombinedNode
  index: number
  layout: Layout
  focused: boolean
  /** Placeholder lettering for a leaf that carries no label of its own. */
  fallbackLabel: string
  onFocus: () => void
  onSelect: () => void
}) {
  const wide = layout.wide
  return <div className="cv-cell" style={{ flexBasis: layout.lw }}>
    <div
      className="cv-tile"
      tabIndex={0}
      aria-current={focused}
      style={{ width: layout.w, height: layout.h }}
      onFocus={onFocus}
      onClick={onSelect}
    >
      <div className="cv-frame">
        {/* The tint stays as the load-and-failure backing, but its
            lettering is only drawn when there is no artwork — over a
            real still it is unreadable, and the row's own label
            already carries the same text. */}
        <div className={`cv-art${wide ? ' wide' : ''}`} style={placeholderStyle(node, wide)}>
          {!node.imageUrl && <>
            {wide && <span className="num">{String(node.episode ?? index + 1).padStart(2, '0')}</span>}
            <span className="lg" style={{ color: 'var(--accent)' }}>
              {(node.type === 'node' || node.type === 'series' || node.type === 'film' ? node.label : fallbackLabel).toUpperCase()}
            </span>
            {!wide && <span className="sm">{node.type === 'series' ? `${node.children?.length ?? 0} ${(node.children?.length ?? 0) === 1 ? 'season' : 'seasons'}` : node.label}</span>}
          </>}
        </div>
        {node.imageUrl && <img className="cv-artimg" src={node.imageUrl} alt="" loading="lazy" onError={event => { event.currentTarget.style.display = 'none' }} />}
      {/* An episode still says nothing about which show it belongs to, so the
          landscape tile carries the logo. Poster rows are already the show. */}
      {wide && node.type === 'episode' && node.logoUrl && (
        <img className="cv-tile-logo" src={node.logoUrl} alt="" loading="lazy"
          onError={event => { event.currentTarget.style.display = 'none' }} />
      )}
        {!!node.progress && <div className="cv-prog"><i style={{ width: `${node.progress}%` }} /></div>}
      </div>
      {node.watched && <div className="cv-check">✓</div>}
    </div>
    {layout.labels && <div className="cv-lbl" style={{ width: layout.w }}>{node.tileLabel ?? node.label}</div>}
  </div>
}

/** Plural noun for a row of nodes, used by the row and shelf headings. */
function unitFor(nodes: CombinedNode[]): string {
  switch (nodes[0]?.type) {
    case 'episode': return 'episodes'
    case 'season': return 'seasons'
    case 'film': return 'films'
    case 'series': return 'series'
    default: return 'items'
  }
}

export function CombinedView({ roots, mode = 'shelves', initialIndex = 0, controls, onExit }: {
  roots: CombinedNode[]
  /** Which root is selected on entry. Keeps the strip's order stable. */
  initialIndex?: number
  /**
   * `shelves` stacks each folder as its own row. `grid` wraps the selected
   * folder's items into a block — how a whole library reads, where one
   * horizontal row of hundreds would not.
   */
  mode?: 'shelves' | 'grid'
  /** Sort and filter controls, shown above a grid. */
  controls?: ReactNode
  /** Called by keyboard Back at the top of the tree. */
  onExit?: () => void
}) {
  const [stack, setStack] = useState<Frame[]>([{ parents: roots, pIdx: initialIndex, iIdx: 0, jIdx: 0 }])
  const [zone, setZone] = useState<'row' | 'selector'>('row')
  const [failedLogo, setFailedLogo] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const { rootRef, compact, stage } = useStage()
  const [tracks, setTracks] = useState<Record<string, TrackSummary | null>>({})

  // Rebuild the stack when the tree identity changes, so a route change does
  // not leave the view pointed at a node that no longer exists.
  useEffect(() => { setStack([{ parents: roots, pIdx: initialIndex, iIdx: 0, jIdx: 0 }]); setZone('row') }, [roots, initialIndex])

  const frame = stack[stack.length - 1]
  const parent = frame.parents[frame.pIdx] as CombinedNode | undefined
  /*
   * A folder with nothing in it is a heading onto nothing, so it is dropped
   * rather than shown empty. Applied here rather than at each render site so
   * it holds at every level — a curated row, a box set theme, a set — and so
   * the indices the keyboard walks never point at a row that is not drawn.
   * Only folders are filtered: a series whose seasons have not loaded yet is
   * still a real tile.
   */
  const items = useMemo(
    () => (parent?.children ?? []).filter(node => node.type !== 'node' || (node.children?.length ?? 0) > 0),
    [parent],
  )
  /*
   * Only the top of the tree stacks. There a frame's folders are the type's
   * rows, and each becomes a shelf. Deeper, a folder is something you opened —
   * a box set theme, say — and its own folders are tiles to choose between,
   * not another page of stacked rows.
   */
  const grid = mode === 'grid' && stack.length === 1
  const gridColumns = Math.max(1, Math.floor((stage.width - PAD * 2) / LAYOUT.poster.lw))
  const shelved = !grid && stack.length === 1 && items.length > 0 && items.every(node => node.type === 'node')
  const shelf = shelved ? items[frame.iIdx] ?? null : null
  const rowItems = useMemo(() => (shelved ? shelf?.children ?? [] : items), [shelved, shelf, items])
  const current = (shelved ? rowItems[frame.jIdx] : items[frame.iIdx]) ?? null

  /** Focused node first, then its ancestors — the inheritance chain. */
  const chain = useMemo(() => [current, ...(shelved ? [shelf] : []), parent, ...stack.slice(0, -1).reverse().map(f => f.parents[f.pIdx])].filter(Boolean) as CombinedNode[], [current, shelf, shelved, parent, stack])
  const inherit = useCallback(<K extends keyof CombinedNode>(key: K): CombinedNode[K] | null => {
    for (const node of chain) { const value = node[key]; if (value != null && value !== '') return value }
    return null
  }, [chain])
  const series = chain.find(node => node.type === 'series') ?? null
  const layout = layoutFor(items)

  /**
   * Track languages for the focused node. Debounced: arrowing along a row must
   * not fire a request per tile, only for whatever focus comes to rest on. The
   * result is cached by node id, including a null, so a leaf without tracks is
   * asked once and not again.
   */
  useEffect(() => {
    const node = current
    if (!node?.loadTracks || node.id in tracks) return
    const timer = window.setTimeout(() => {
      node.loadTracks!()
        .then(result => setTracks(prev => ({ ...prev, [node.id]: result })))
        .catch(() => setTracks(prev => ({ ...prev, [node.id]: null })))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [current, tracks])

  const shelfRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    shelfRef.current?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [frame.iIdx, frame.pIdx])

  const descend = useCallback(() => {
    const node = shelved ? rowItems[frame.jIdx] : items[frame.iIdx]
    if (!node) return
    if (!node.children?.length) { node.onActivate?.(); return }
    setStack(prev => [...prev, {
      parents: shelved ? rowItems : items,
      pIdx: shelved ? frame.jIdx : prev[prev.length - 1].iIdx,
      iIdx: 0, jIdx: 0,
    }])
    setZone('row')
  }, [items, rowItems, shelved, frame.iIdx, frame.jIdx])

  const ascend = useCallback(() => {
    if (stack.length > 1) setStack(prev => prev.slice(0, -1))
    else onExit?.()
    setZone('row')
  }, [onExit, stack.length])

  const setFrame = useCallback((patch: Partial<Frame>) => {
    setStack(prev => prev.map((f, i) => (i === prev.length - 1 ? { ...f, ...patch } : f)))
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Backspace', 'Escape']
      if (!keys.includes(event.key)) return
      event.preventDefault()
      if (event.key === 'Backspace' || event.key === 'Escape') return ascend()
      if (event.key === 'Enter') {
        if (zone === 'row') descend()
        // A type header that names a destination opens it; one that does not
        // simply drops focus into its rows.
        else if (parent?.onActivate) parent.onActivate()
        else setZone('row')
        return
      }
      if (grid && zone === 'row') {
        if (event.key === 'ArrowRight') setFrame({ iIdx: Math.min(frame.iIdx + 1, items.length - 1) })
        if (event.key === 'ArrowLeft') setFrame({ iIdx: Math.max(frame.iIdx - 1, 0) })
        if (event.key === 'ArrowDown') setFrame({ iIdx: Math.min(frame.iIdx + gridColumns, items.length - 1) })
        if (event.key === 'ArrowUp') {
          // Above the top line is the type strip, when there is one to reach.
          if (frame.iIdx < gridColumns) { if (frame.parents.length > 1) setZone('selector') }
          else setFrame({ iIdx: Math.max(frame.iIdx - gridColumns, 0) })
        }
        return
      }
      if (shelved && zone === 'row') {
        // Left/right walk a shelf; up/down change shelf, holding the column so
        // the eye stays where it was rather than snapping back to the start.
        if (event.key === 'ArrowRight') setFrame({ jIdx: Math.min(frame.jIdx + 1, rowItems.length - 1) })
        if (event.key === 'ArrowLeft') setFrame({ jIdx: Math.max(frame.jIdx - 1, 0) })
        if (event.key === 'ArrowDown') {
          const next = Math.min(frame.iIdx + 1, items.length - 1)
          if (next !== frame.iIdx) setFrame({ iIdx: next, jIdx: Math.max(0, Math.min(frame.jIdx, (items[next].children?.length ?? 0) - 1)) })
        }
        if (event.key === 'ArrowUp') {
          // Above the top shelf is the type strip, when there is one to reach.
          if (frame.iIdx === 0) { if (frame.parents.length > 1) setZone('selector') }
          else setFrame({ iIdx: frame.iIdx - 1, jIdx: Math.max(0, Math.min(frame.jIdx, (items[frame.iIdx - 1].children?.length ?? 0) - 1)) })
        }
        return
      }
      if (zone === 'row') {
        if (event.key === 'ArrowRight') setFrame({ iIdx: Math.min(frame.iIdx + 1, items.length - 1) })
        if (event.key === 'ArrowLeft') setFrame({ iIdx: Math.max(frame.iIdx - 1, 0) })
        if (event.key === 'ArrowUp') setZone('selector')
      } else {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          const next = Math.min(Math.max(frame.pIdx + (event.key === 'ArrowRight' ? 1 : -1), 0), frame.parents.length - 1)
          if (next !== frame.pIdx) setFrame({ pIdx: next, iIdx: 0, jIdx: 0 })
        }
        if (event.key === 'ArrowDown') setZone('row')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zone, frame, items, rowItems.length, descend, ascend, setFrame, shelved, grid, gridColumns, parent])

  if (!parent) return null

  const [ar, ag, ab] = accentParts((series?.accent ?? current?.accent ?? parent.accent) || '#7d8590')
  const fanart = (series?.fanart ?? current?.fanart ?? parent.fanart) || NODE_ART
  const logo = series?.logoUrl ?? current?.logoUrl ?? parent.logoUrl ?? null
  /*
   * The folder strip named the folder, so the hero named it too. A shelf
   * carries its own heading, and poster tiles have no labels, so on the shelf
   * screen the hero is the only thing that can name what is focused — and it
   * names that rather than repeating the heading directly above it.
   */
  /*
   * The hero names whatever is focused. A series ancestor still wins, so
   * arrowing through episodes keeps the show's name in the title while the
   * text beneath changes — but everywhere else the tile under the cursor is
   * what the hero is describing, so it is what the hero is called.
   */
  const title = series?.label ?? current?.label ?? shelf?.label ?? parent.label

  const stars = Number(inherit('stars') ?? 0)
  const mpaa = inherit('mpaa')
  const trackInfo = current ? tracks[current.id] : null
  // Spec chips, in the order they read: what it is, where it came from, how it
  // was encoded, where it aired. Absent values drop out rather than show a dash.
  const specs = [
    { value: inherit('res'), tone: 'cv-chip-res' },
    { value: codecLabel(trackInfo?.videoCodec) ?? inherit('codec'), tone: 'cv-chip-neutral' },
    { value: [codecLabel(trackInfo?.audioCodec), trackInfo?.audioChannels].filter(Boolean).join(' ') || null, tone: 'cv-chip-neutral' },
    { value: inherit('source'), tone: 'cv-chip-neutral' },
  ].flatMap(spec => typeof spec.value === 'string' && spec.value ? [{ text: spec.value, tone: spec.tone }] : [])
  // Where the work came from: a film's studio, a series' network.
  const studio = inherit('studio') ?? series?.network ?? null
  const genres = (inherit('genres') as string[] | null) ?? []
  /**
   * A track group: the label, the codec that will play, then a flag per
   * language. No track count — the flags already say what is on offer, and the
   * number said nothing a viewer acts on.
   */
  /** Flags for one track kind, unlabelled. */
  const trackGroup = (languages: TrackLanguage[]) => <span className="cv-track">
    {languages.slice(0, 6).map(language => <Flag key={language.code ?? language.label} code={language.code} />)}
  </span>
  // Runtime only. The series status ("Continuing", "Ended") used to sit here
  // when the focus was above episode level; it said nothing the row did not.
  const runtime = current?.type === 'episode' ? current.runtime : null
  const rowType = items[0]?.type
  const unit = rowType === 'episode' ? 'episodes' : rowType === 'season' ? 'seasons'
    : rowType === 'film' ? 'films' : rowType === 'series' ? 'series' : 'items'
  const wide = layout === LAYOUT.landscape
  // 30 is the viewport's own top padding, so the tile top lands where intended.
  // VIEWPORT_BLEED is added back because the viewport's box extends that far
  // past the strip on every side to keep the clip clear of the drop shadow.
  const cellHeight = layout.h + (layout.labels ? LABEL_BLOCK * K : 0)
  const viewportTop = ROW_BASELINE - cellHeight - 30 - VIEWPORT_BLEED
  const visible = Math.floor((stage.width - PAD) / layout.lw)
  const offset = Math.min(Math.max(frame.iIdx - layout.focus, 0), Math.max(0, items.length - visible))
  return <div ref={rootRef} className={`cv${compact ? ' compact' : ''}`} style={{ ['--ar' as string]: ar, ['--ag' as string]: ag, ['--ab' as string]: ab }}>
    <div className="cv-bg">
      <div className="cv-fanart" style={fanartStyle(fanart)} />
      <div className="cv-glow cv-glow-a" /><div className="cv-glow cv-glow-b" />
      <div className="cv-scrim-x" /><div className="cv-scrim-y" />
      <div className="cv-vig" /><div className="cv-grain" />
    </div>

    <div className="cv-stage" style={compact ? undefined : { width: stage.width, transform: `scale(${stage.scale})` }}>
      <section className="cv-info">
        <h1 className="cv-title-slot">
          {logo && failedLogo !== logo
            ? <img className="cv-title-logo" src={logo} alt={title} onError={() => setFailedLogo(logo)} />
            : <span className="cv-title">{title.toUpperCase()}</span>}
        </h1>
        <div className="cv-line">
          {/* The Library's rating treatment, the component itself rather than a
              copy of its markup. This is the catalogue's score and not one the
              viewer set, which is what colours it apart from their own. */}
          {stars > 0 && <LevelStatic value={stars} source="catalogue" size="compact" className="cv-level" />}
          <span className="cv-dot">•</span>
          <span>{current?.premiered ?? series?.premiered ?? ''}</span>
          {/* Runtime rides the meta line rather than a block of its own: the
              info panel has to finish above the rows, and one short fact does
              not earn another line. */}
          {runtime && <><span className="cv-dot">•</span><span>{runtime}</span></>}
        </div>
        {/* The whole point of the layout: the overview is the focused node's own. */}
        <p className="cv-plot">{current?.overview ?? parent.overview ?? ''}</p>
      </section>

      {frame.parents.length > 1 && <>
        <nav className="cv-tabs" role="tablist" aria-label={stack.length === 1 ? 'Library' : 'Folders'} data-focused={zone === 'selector'}>
          {frame.parents.map((node, i) => <button
            key={node.id}
            className="cv-tab"
            role="tab"
            aria-selected={i === frame.pIdx}
            onClick={() => {
              if (i === frame.pIdx && node.onActivate) node.onActivate()
              else { setFrame({ pIdx: i, iIdx: 0, jIdx: 0 }); setZone('selector') }
            }}
          >
            <span className="cv-tab-label">
              {node.icon && <Icon name={node.icon} size={30} className="cv-tab-ident" />}
              {node.label}
            </span>
            <u />
          </button>)}
        </nav>
        <div className="cv-rule" />
      </>}

      {/* A frame that holds items rather than folders shows one row, and that
          row carries its own heading. Coloured by media type, matching the
          Library's section titles. */}
      {!shelved && !grid && <h2 className="cv-row-heading" style={compact ? undefined : { top: viewportTop + VIEWPORT_BLEED - 52 }}>
        {parent.label}
        <span className="cv-row-count">{items.length ? `${items.length} ${unit}` : 'Empty'}</span>
      </h2>}

      {shelved && <div className="cv-shelves">
        {items.map((row, rowIndex) => {
          const rowNodes = row.children ?? []
          const rowLayout = layoutFor(rowNodes)
          const selected = rowIndex === frame.iIdx
          // Only the shelf holding focus scrolls; the others stay at their start
          // so the page reads as a set of rows rather than a scattered grid.
          const rowOffset = selected
            ? Math.min(Math.max(frame.jIdx - rowLayout.focus, 0), Math.max(0, rowNodes.length - Math.floor((stage.width - PAD) / rowLayout.lw)))
            : 0
          return <section
            className="cv-shelf"
            key={row.id}
            aria-label={row.label}
            ref={selected ? shelfRef : undefined}
          >
            <h2 className="cv-row-heading cv-shelf-heading">
              {row.icon && <Icon name={row.icon} size={30} className="cv-tab-ident" />}
              {row.label}
              <span className="cv-row-count">{rowNodes.length ? `${rowNodes.length} ${unitFor(rowNodes)}` : 'Empty'}</span>
            </h2>
            <div className="cv-viewport cv-shelf-viewport">
              <div className="cv-row" style={compact ? undefined : { transform: `translateX(${-rowOffset * rowLayout.lw}px)` }}>
                {rowNodes.map((node, i) => <Cell
                  key={node.id} node={node} index={i} layout={rowLayout}
                  focused={selected && i === frame.jIdx && zone === 'row'}
                  fallbackLabel={row.label}
                  onFocus={() => { if (!selected || i !== frame.jIdx || zone !== 'row') { setFrame({ iIdx: rowIndex, jIdx: i }); setZone('row') } }}
                  onSelect={() => { if (selected && i === frame.jIdx && zone === 'row') descend(); else { setFrame({ iIdx: rowIndex, jIdx: i }); setZone('row') } }} />)}
              </div>
            </div>
          </section>
        })}
      </div>}

      {grid && <div className="cv-grid-region">
        {controls && <div className="cv-grid-controls">{controls}</div>}
        <div className="cv-grid">
          {items.map((node, i) => <Cell
            key={node.id} node={node} index={i} layout={LAYOUT.poster}
            focused={i === frame.iIdx && zone === 'row'}
            fallbackLabel={parent.label}
            onFocus={() => { if (i !== frame.iIdx || zone !== 'row') { setFrame({ iIdx: i }); setZone('row') } }}
            onSelect={() => { if (i === frame.iIdx && zone === 'row') descend(); else { setFrame({ iIdx: i }); setZone('row') } }} />)}
          {!items.length && <p className="cv-shelf-empty">Nothing here yet.</p>}
        </div>
      </div>}

      {!shelved && !grid && <div className="cv-viewport" ref={viewportRef} style={compact ? undefined : { top: viewportTop }}>
        <div className="cv-row" style={compact ? undefined : { transform: `translateX(${-offset * layout.lw}px)` }}>
          {items.length === 0
            ? <div style={{ color: 'var(--fg40)', fontSize: 28, padding: '110px 0' }}>Nothing here yet.</div>
            : items.map((node, i) => <Cell
              key={node.id} node={node} index={i} layout={layout}
              focused={i === frame.iIdx && zone === 'row'}
              fallbackLabel={series?.label ?? parent.label}
              onFocus={() => { if (i !== frame.iIdx || zone !== 'row') { setFrame({ iIdx: i }); setZone('row') } }}
              onSelect={() => { if (i === frame.iIdx && zone === 'row') descend(); else { setFrame({ iIdx: i }); setZone('row') } }} />)}
        </div>
      </div>}

      <footer className="cv-footer">
        {specs.map((spec, index) => <span key={spec.text + index} className={`cv-chip ${spec.tone}`}>{spec.text}</span>)}
        {!!trackInfo?.audioCount && trackGroup(trackInfo.audio)}
        {!!trackInfo?.subtitleCount && trackGroup(trackInfo.subtitles)}

        <span className="cv-footer-right">
          {mpaa && <span className={`cv-chip ${CERTIFICATION_TONE[mpaa.toUpperCase()] ?? 'cv-chip-neutral'}`}>{mpaa}</span>}
          {studio && <span className="cv-chip cv-chip-neutral">{studio}</span>}
          {genres.slice(0, 3).map(genre => <span key={genre} className="cv-chip cv-chip-ghost">{genre}</span>)}
        </span>
      </footer>
    </div>
  </div>
}
