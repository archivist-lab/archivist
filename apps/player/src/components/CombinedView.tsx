import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, LevelStatic, type IconName } from '@archivist/design-system'
import { accentParts, fanartStyle, useStage } from './stage.js'
import { useFocusable } from '../focus/FocusProvider.js'

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
  return [name, { name, w, h, lw, lh, labels: v.labels, wide: name === 'landscape', focus: Math.round(visible * (nativeFocus / nativeVisible)) }]
})) as Record<LayoutName, { name: string; w: number; h: number; lw: number; lh: number; labels: boolean; wide: boolean; focus: number }>

/**
 * How far tile geometry is scaled down for the flowing layout.
 *
 * The design canvas is 1920 wide, so a poster cell is 257px and an episode
 * cell 450px. Carried unchanged onto a phone that is a poster and a half per
 * row, and an episode tile wider than the screen it is on. The stylesheet was
 * always written for this — its compact rules read `calc(… * var(--k))` and
 * guard the result with `max()` — only the factor was never supplied.
 *
 * 560 is the width at which the full-size tiles start to look right; below it
 * everything shrinks in proportion, with a floor so a small phone does not end
 * up with thumbnails.
 */
function tileScale(compact: boolean, width: number): number {
  if (!compact) return 1
  return Math.max(0.5, Math.min(1, width / 560))
}

/**
 * The same layout at a different tile scale. Identity is carried by `name`.
 *
 * Cached, so the same scale yields the same object: tiles are memoised on their
 * props, and a fresh layout per render would re-render every one of them.
 */
const scaledLayouts = new Map<string, Layout>()
function scaleLayout(layout: Layout, k: number): Layout {
  if (k === 1) return layout
  const key = `${layout.name}:${k}`
  let scaled = scaledLayouts.get(key)
  if (!scaled) {
    scaled = { ...layout, w: layout.w * k, h: layout.h * k, lw: layout.lw * k, lh: layout.lh * k }
    if (scaledLayouts.size > 64) scaledLayouts.clear()
    scaledLayouts.set(key, scaled)
  }
  return scaled
}

/**
 * Tiles drawn beyond each edge of what a row shows. A row slides by transform,
 * so only the tiles in and near view need to exist at all; the rest are a
 * spacer of the same width. A shelf of two hundred films was two hundred
 * artwork tiles in the DOM, re-rendered on every press of an arrow.
 */
const ROW_OVERSCAN = 3

/** Grid lines drawn beyond each edge of the visible band. */
const GRID_OVERSCAN = 2

/** Space between grid lines. Must match `.cv-grid`'s row gap in combined.css. */
const GRID_GAP = 24

/**
 * How long the cursor has to rest before the backdrop and accent follow it.
 * Swapping a full-screen image and repainting the accent glows on every tile
 * passed over is most of what made walking a row feel heavy on a television;
 * the title and overview still change at once, as they are cheap.
 */
const SETTLE_MS = 220

function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (Object.is(value, settled)) return
    const timer = window.setTimeout(() => setSettled(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, settled, delay])
  return settled
}

/** A folder's children as the view draws them: empty folders dropped. */
function visibleChildren(node: CombinedNode | undefined): CombinedNode[] {
  return (node?.children ?? []).filter(child => child.type !== 'node' || (child.children?.length ?? 0) > 0)
}

const clampIndex = (index: number, length: number) => Math.max(0, Math.min(index, length - 1))

/**
 * Carries the cursor across a new tree. The rows arrive in pieces — films,
 * series, curated shelves, box sets, then each series' seasons as it is warmed
 * — and every piece is a new tree. Rebuilding the stack from scratch sent the
 * cursor back to the first tile each time, so the opening seconds of Home
 * fought the viewer. Each frame is found again by the ids it was pointing at;
 * only a path that no longer exists falls back.
 */
function remapStack(stack: Frame[], roots: CombinedNode[], initialIndex: number): Frame[] {
  const out: Frame[] = []
  let parents = roots
  for (let depth = 0; depth < stack.length; depth++) {
    const frame = stack[depth]
    const find = (list: CombinedNode[], id: string | undefined) => (id == null ? -1 : list.findIndex(node => node.id === id))
    const found = find(parents, frame.parents[frame.pIdx]?.id)
    const pIdx = found >= 0 ? found : depth === 0 ? clampIndex(initialIndex, parents.length) : -1
    if (pIdx < 0 || !parents[pIdx]) break
    const oldItems = visibleChildren(frame.parents[frame.pIdx])
    const items = visibleChildren(parents[pIdx])
    const iFound = find(items, oldItems[frame.iIdx]?.id)
    const iIdx = items.length ? (iFound >= 0 ? iFound : clampIndex(frame.iIdx, items.length)) : 0
    const oldShelf = oldItems[frame.iIdx]?.children ?? []
    const shelf = items[iIdx]?.children ?? []
    const jFound = find(shelf, oldShelf[frame.jIdx]?.id)
    const jIdx = shelf.length ? (jFound >= 0 ? jFound : clampIndex(frame.jIdx, shelf.length)) : 0
    out.push({ parents, pIdx, iIdx, jIdx })
    const next = stack[depth + 1]
    if (!next) break
    // The next frame descended either from a shelf's tiles or from the row.
    const nextId = next.parents[next.pIdx]?.id
    parents = shelf.some(node => node.id === nextId) ? shelf : items
  }
  return out.length ? out : [{ parents: roots, pIdx: initialIndex, iIdx: 0, jIdx: 0 }]
}


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

/**
 * How far the row heading sits above the tiles. It is two lines now — the
 * folder picker and, under it, the count — so it starts higher than the single
 * line it replaced, and the gap down to the tiles is nearly what it was.
 */
const HEADING_LIFT = 87

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

/**
 * Kinds whose siblings the row heading will switch between. Seasons and
 * folders are a short, ordered set that reads as one strip; titles are not,
 * however few of them a particular shelf happens to hold.
 */
const PICKABLE = new Set<CombinedKind>(['season', 'node'])

/** A row's tile shape: what its first node asks for, else what its kind implies. */
function layoutFor(nodes: CombinedNode[]) {
  const first = nodes[0]
  return LAYOUT[first?.view ?? LAYOUT_FOR[first?.type ?? 'node'] ?? 'poster']
}
const NODE_ART = 'linear-gradient(112deg,#1a1d24 0%,#0d0f14 46%,#06070a 100%)'

/** How the view moves something into view: smoothly, unless motion is reduced. */
const reveal = (): ScrollBehavior => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'

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
const Cell = memo(function Cell({ node, index, row, layout, focused, fallbackLabel, onCellFocus, onCellSelect }: {
  node: CombinedNode
  index: number
  /** The shelf this tile is on, or -1 in a single row or the grid. */
  row: number
  layout: Layout
  focused: boolean
  /** Placeholder lettering for a leaf that carries no label of its own. */
  fallbackLabel: string
  onCellFocus: (row: number, index: number) => void
  onCellSelect: (row: number, index: number) => void
}) {
  const wide = layout.wide
  return <div className="cv-cell" style={{ flexBasis: layout.lw }}>
    <div
      className="cv-tile"
      tabIndex={0}
      aria-current={focused}
      style={{ width: layout.w, height: layout.h }}
      onFocus={() => onCellFocus(row, index)}
      onClick={() => onCellSelect(row, index)}
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
})

/** Stands in for the tiles a row does not draw, so the rest keep their places. */
function RowSpacer({ width }: { width: number }) {
  return width > 0 ? <div aria-hidden className="cv-spacer" style={{ flexBasis: width, width }} /> : null
}

/** The slice of a row worth drawing, given how far it is slid and how much shows. */
function rowWindow(compact: boolean, length: number, offset: number, visible: number): [number, number] {
  if (compact) return [0, length]
  return [Math.max(0, offset - ROW_OVERSCAN), Math.min(length, offset + visible + ROW_OVERSCAN)]
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

export function CombinedView({ roots, mode = 'shelves', initialIndex = 0, onExit, upFocusId = 'nav-home' }: {
  roots: CombinedNode[]
  /** Which root is selected on entry. Keeps the strip's order stable. */
  initialIndex?: number
  /**
   * `shelves` stacks each folder as its own row. `grid` wraps the selected
   * folder's items into a block — how a whole library reads, where one
   * horizontal row of hundreds would not.
   */
  mode?: 'shelves' | 'grid'
  /** Called by keyboard Back at the top of the tree. */
  onExit?: () => void
  /** The main menu item Up reaches from the top row, when there is no folder strip to reach instead. */
  upFocusId?: string
}) {
  const [stack, setStack] = useState<Frame[]>([{ parents: roots, pIdx: initialIndex, iIdx: 0, jIdx: 0 }])
  const [zone, setZone] = useState<'row' | 'selector'>('row')
  const [failedLogo, setFailedLogo] = useState<string | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const { rootRef, compact, stage } = useStage()
  const [tracks, setTracks] = useState<Record<string, TrackSummary | null>>({})

  // Rebuild the stack when the tree identity changes, so a route change does
  // not leave the view pointed at a node that no longer exists.
  const initialRef = useRef(initialIndex)
  const rootsRef = useRef(roots)
  useEffect(() => {
    if (rootsRef.current === roots && initialRef.current === initialIndex) return
    const reset = initialRef.current !== initialIndex
    rootsRef.current = roots
    initialRef.current = initialIndex
    if (reset) { setStack([{ parents: roots, pIdx: initialIndex, iIdx: 0, jIdx: 0 }]); setZone('row'); return }
    setStack(prev => remapStack(prev, roots, initialIndex))
  }, [roots, initialIndex])

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
  const items = useMemo(() => visibleChildren(parent), [parent])
  /*
   * Only the top of the tree stacks. There a frame's folders are the type's
   * rows, and each becomes a shelf. Deeper, a folder is something you opened —
   * a box set theme, say — and its own folders are tiles to choose between,
   * not another page of stacked rows.
   */
  const grid = mode === 'grid' && stack.length === 1
  const k = tileScale(compact, stage.width)
  const posterLayout = scaleLayout(LAYOUT.poster, k)
  // The flowing layout has no 80px design-canvas gutter; it has the 20px the
  // compact stylesheet gives it.
  const gridColumns = Math.max(1, Math.floor((stage.width - (compact ? 40 : PAD * 2)) / posterLayout.lw))
  const shelved = !grid && stack.length === 1 && items.length > 0 && items.every(node => node.type === 'node')
  /*
   * The top level's own folders are Films and Series — the Player's main menu
   * already names those, fixed at the top of every screen, so a second picker
   * repeating them here would say the same thing twice. Only a folder switcher
   * that menu does not cover — a set of sibling folders reached by descending —
   * still earns one.
   *
   * A title's siblings are every other title in the library, which is a list to
   * search rather than a strip to slide through, so a film or a show is named
   * rather than picked. Seasons and folders are what the picker is for.
   */
  const pickerVisible = stack.length > 1 && frame.parents.length > 1
    && PICKABLE.has(frame.parents[0]?.type ?? 'node')
  /** Whether Up has run out of shelves/rows to climb and would leave the view entirely. */
  const atTopRow = grid ? frame.iIdx < gridColumns : shelved ? frame.iIdx === 0 : true
  /*
   * The view keeps real keyboard/remote focus on one anchor of its own the
   * whole time it is browsed, rather than moving it tile to tile — there can
   * be hundreds of tiles, and a real focus target per tile is not worth
   * having. Left, right and down loop back to that same anchor, so the
   * generic spatial engine never wanders into the main menu on its own. Up
   * only leaves once there is nowhere higher to climb — first through the
   * shelves above, one at a time, and only from the topmost does it reach the
   * menu item for this screen (or the row heading, when it is a picker).
   */
  const anchorNeighbors = useMemo(() => ({
    up: !atTopRow ? 'cv-content' : pickerVisible ? 'cv-content' : upFocusId,
    left: 'cv-content', right: 'cv-content', down: 'cv-content',
  }), [atTopRow, pickerVisible, upFocusId])
  /*
   * Set when the anchor regains focus after actually having lost it — coming
   * back from the main menu, say — so the keydown that carried it back in,
   * still open, still bubbling to this same handler, is not also read as a
   * fresh press once it arrives here. The very first focus, on mount, is not
   * a return and must not swallow the viewer's first press.
   */
  const everFocusedRef = useRef(false)
  const justReturnedRef = useRef(false)
  const anchor = useFocusable({
    id: 'cv-content', zoneId: 'cv-content', neighbors: anchorNeighbors,
    onFocused: () => {
      if (everFocusedRef.current) justReturnedRef.current = true
      everFocusedRef.current = true
      setZone('row')
    },
  })
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
  const layout = scaleLayout(layoutFor(items), k)

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

  /*
   * The picker scrolls sideways, so the selected folder is kept in view as the
   * remote walks the strip. scrollLeft rather than scrollIntoView: the stage is
   * a scaled, absolutely positioned box, and asking the browser to reveal an
   * element inside it moves the page as readily as the strip.
   */
  const pickerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const strip = pickerRef.current
    const selected = strip?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!strip || !selected) return
    const left = selected.offsetLeft - (strip.clientWidth - selected.offsetWidth) / 2
    strip.scrollTo({ left: Math.max(0, left), behavior: reveal() })
  }, [frame.pIdx, frame.parents, pickerVisible])

  /*
   * The hero stays put and the shelves scroll beneath it, in their own region.
   * The selected shelf is brought to the top of that region, so the whole row
   * shows rather than whatever sliver "nearest" would settle for. It is the
   * region that is scrolled, never an ancestor: scrollIntoView moved the stage
   * too, sliding the spotlight away and snapping it back on the next focus.
   */
  const shelfRef = useRef<HTMLElement | null>(null)
  const shelvesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const shelf = shelfRef.current
    if (!shelf) return
    if (compact) { shelf.scrollIntoView({ block: 'nearest', behavior: reveal() }); return }
    shelvesRef.current?.scrollTo({ top: shelf.offsetTop, behavior: reveal() })
  }, [frame.iIdx, frame.pIdx, compact])

  /*
   * The grid wraps rather than scrolling sideways, so walking it runs off the
   * bottom of the screen. The cursor is view state rather than DOM focus —
   * nothing moves the page on its own — so the tile it lands on is brought
   * into view here, the way the stacked shelves bring their own row in.
   */
  const gridRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!grid) return
    const tile = gridRef.current?.querySelector<HTMLElement>('.cv-tile[aria-current="true"]')
    if (!tile) return
    if (compact) { tile.scrollIntoView({ block: 'nearest', behavior: reveal() }); return }
    // The cursor's line goes to the top of the region, below the fixed hero;
    // the region's own top padding stays above it as headroom for the lift.
    const cell = tile.closest<HTMLElement>('.cv-cell')
    const region = gridRef.current!
    if (cell) region.scrollTo({ top: Math.max(0, cell.offsetTop - parseFloat(getComputedStyle(region).paddingTop || '0')), behavior: reveal() })
  }, [grid, frame.iIdx, compact])

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

  /*
   * One focus and one select handler for every tile, stable across renders, so
   * a memoised tile only re-renders when its own props change — two tiles a
   * press, not every tile on the screen.
   */
  const latest = useRef({ frame, zone, descend })
  latest.current = { frame, zone, descend }
  const isCursor = (row: number, index: number) => {
    const { frame: f, zone: z } = latest.current
    return z === 'row' && (row < 0 ? f.iIdx === index : f.iIdx === row && f.jIdx === index)
  }
  const onCellFocus = useCallback((row: number, index: number) => {
    if (isCursor(row, index)) return
    setFrame(row < 0 ? { iIdx: index } : { iIdx: row, jIdx: index })
    setZone('row')
  }, [setFrame])
  const onCellSelect = useCallback((row: number, index: number) => {
    if (isCursor(row, index)) { latest.current.descend(); return }
    setFrame(row < 0 ? { iIdx: index } : { iIdx: row, jIdx: index })
    setZone('row')
  }, [setFrame])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Backspace', 'Escape']
      if (!keys.includes(event.key)) return
      // Focus has moved off this view's anchor — up into the main menu, most
      // likely — so these keys belong to whatever holds it now, not to us.
      if (document.activeElement !== anchorRef.current) return
      // This is the same keypress that just carried focus back to the
      // anchor — Down from the menu, say — so it has already been spent.
      if (justReturnedRef.current) { justReturnedRef.current = false; return }
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
          // Above the top line is the heading picker, when there is one to reach.
          if (frame.iIdx < gridColumns) { if (pickerVisible) setZone('selector') }
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
          // Above the top shelf is the heading picker, when there is one to reach.
          if (frame.iIdx === 0) { if (pickerVisible) setZone('selector') }
          else setFrame({ iIdx: frame.iIdx - 1, jIdx: Math.max(0, Math.min(frame.jIdx, (items[frame.iIdx - 1].children?.length ?? 0) - 1)) })
        }
        return
      }
      if (zone === 'row') {
        if (event.key === 'ArrowRight') setFrame({ iIdx: Math.min(frame.iIdx + 1, items.length - 1) })
        if (event.key === 'ArrowLeft') setFrame({ iIdx: Math.max(frame.iIdx - 1, 0) })
        if (event.key === 'ArrowUp' && pickerVisible) setZone('selector')
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
  }, [zone, frame, items, rowItems.length, descend, ascend, setFrame, shelved, grid, gridColumns, parent, pickerVisible])

  // The backdrop and accent follow the cursor once it rests (see SETTLE_MS).
  const [ar, ag, ab] = accentParts(useSettled((series?.accent ?? current?.accent ?? parent?.accent) || '#7d8590', SETTLE_MS))
  const fanart = useSettled((series?.fanart ?? current?.fanart ?? parent?.fanart) || NODE_ART, SETTLE_MS)

  /*
   * Which grid lines to draw. A whole library is a grid of hundreds, and only
   * the few lines in the band and around the cursor are drawn; the rest are
   * spacers of the same height, so the region still scrolls exactly as far.
   */
  const gridPitch = posterLayout.h + GRID_GAP
  const [gridScrollRow, setGridScrollRow] = useState(0)
  const gridScrollFrame = useRef(0)
  const onGridScroll = useCallback(() => {
    cancelAnimationFrame(gridScrollFrame.current)
    gridScrollFrame.current = requestAnimationFrame(() => {
      const region = gridRef.current
      if (region) setGridScrollRow(Math.floor(region.scrollTop / gridPitch))
    })
  }, [gridPitch])
  useEffect(() => () => cancelAnimationFrame(gridScrollFrame.current), [])

  if (!parent) return null

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
  const wide = layout.name === 'landscape'
  // 30 is the viewport's own top padding, so the tile top lands where intended.
  // VIEWPORT_BLEED is added back because the viewport's box extends that far
  // past the strip on every side to keep the clip clear of the drop shadow.
  const cellHeight = layout.h + (layout.labels ? LABEL_BLOCK * K : 0)
  const viewportTop = ROW_BASELINE - cellHeight - 30 - VIEWPORT_BLEED
  const visible = Math.floor((stage.width - PAD) / layout.lw)
  const offset = Math.min(Math.max(frame.iIdx - layout.focus, 0), Math.max(0, items.length - visible))
  const [rowStart, rowEnd] = rowWindow(compact, items.length, offset, visible)
  const gridRows = grid ? Math.ceil(items.length / gridColumns) : 0
  const focusRow = Math.floor(frame.iIdx / gridColumns)
  // The scrolled band, unless the cursor is far from it — a wheel scroll the
  // cursor has since left — in which case the band is about to follow it.
  const bandRow = Math.abs(focusRow - gridScrollRow) > 6 ? focusRow : gridScrollRow
  const gridStart = compact ? 0 : Math.max(0, Math.min(bandRow, focusRow) - GRID_OVERSCAN)
  const gridEnd = compact ? gridRows : Math.min(gridRows, Math.max(bandRow + 3, focusRow + 1) + GRID_OVERSCAN)
  // Each spacer is a line of the wrap, so the gap after it is already counted.
  const gridTop = gridStart > 0 ? gridStart * gridPitch - GRID_GAP : 0
  const gridBottom = gridEnd < gridRows ? (gridRows - gridEnd) * gridPitch - GRID_GAP : 0
  return <div ref={rootRef} className={`cv${compact ? ' compact' : ''}`} style={{ ['--ar' as string]: ar, ['--ag' as string]: ag, ['--ab' as string]: ab, ['--k' as string]: k }}>
    <div {...anchor} ref={element => { anchorRef.current = element; anchor.ref(element) }} aria-label="Library" className="cv-anchor" />
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

      {/* A frame that holds items rather than folders shows one row, and that
          row carries its own heading. Coloured by media type, matching the
          Library's section titles.

          The heading is also the folder switcher: rather than a separate strip
          at the top of the screen naming siblings the eye has to travel back up
          to, the name directly above the tiles is the one being switched, and
          the siblings scroll horizontally through that same spot. The count
          sits underneath it rather than beside it, so nothing rides along with
          a name that moves. */}
      {!shelved && !grid && <h2 className="cv-row-heading cv-heading-picker" style={compact ? undefined : { top: viewportTop + VIEWPORT_BLEED - HEADING_LIFT }}>
        {pickerVisible
          ? <div className="cv-picker" role="tablist" aria-label="Folders" data-focused={zone === 'selector'} ref={pickerRef}>
            {frame.parents.map((node, i) => <button
              key={node.id}
              className="cv-picker-item"
              role="tab"
              aria-selected={i === frame.pIdx}
              onClick={() => {
                if (i === frame.pIdx && node.onActivate) node.onActivate()
                else { setFrame({ pIdx: i, iIdx: 0, jIdx: 0 }); setZone('selector') }
              }}
            >
              <span className="cv-picker-label">
                {node.icon && <Icon name={node.icon} size={30} className="cv-tab-ident" />}
                {node.label}
              </span>
              <u />
            </button>)}
          </div>
          : <span className="cv-picker-solo">{parent.label}</span>}
        <span className="cv-row-count">{items.length ? `${items.length} ${unit}` : 'Empty'}</span>
      </h2>}

      {shelved && <div className="cv-shelves" ref={shelvesRef}>
        {items.map((row, rowIndex) => {
          const rowNodes = row.children ?? []
          const rowLayout = scaleLayout(layoutFor(rowNodes), k)
          const selected = rowIndex === frame.iIdx
          // Only the shelf holding focus scrolls; the others stay at their start
          // so the page reads as a set of rows rather than a scattered grid.
          const rowVisible = Math.floor((stage.width - PAD) / rowLayout.lw)
          const rowOffset = selected
            ? Math.min(Math.max(frame.jIdx - rowLayout.focus, 0), Math.max(0, rowNodes.length - rowVisible))
            : 0
          const [rowStart, rowEnd] = rowWindow(compact, rowNodes.length, rowOffset, rowVisible)
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
                <RowSpacer width={rowStart * rowLayout.lw} />
                {rowNodes.slice(rowStart, rowEnd).map((node, k) => <Cell
                  key={node.id} node={node} index={rowStart + k} row={rowIndex} layout={rowLayout}
                  focused={selected && rowStart + k === frame.jIdx && zone === 'row'}
                  fallbackLabel={row.label}
                  onCellFocus={onCellFocus} onCellSelect={onCellSelect} />)}
              </div>
            </div>
          </section>
        })}
      </div>}

      {grid && <div className="cv-grid-region" ref={gridRef} onScroll={compact ? undefined : onGridScroll}>
        <div className="cv-grid">
          {gridTop > 0 && <div aria-hidden className="cv-grid-spacer" style={{ height: gridTop }} />}
          {items.slice(gridStart * gridColumns, gridEnd * gridColumns).map((node, k) => <Cell
            key={node.id} node={node} index={gridStart * gridColumns + k} row={-1} layout={posterLayout}
            focused={gridStart * gridColumns + k === frame.iIdx && zone === 'row'}
            fallbackLabel={parent.label}
            onCellFocus={onCellFocus} onCellSelect={onCellSelect} />)}
          {gridBottom > 0 && <div aria-hidden className="cv-grid-spacer" style={{ height: gridBottom }} />}
          {!items.length && <p className="cv-shelf-empty">Nothing here yet.</p>}
        </div>
      </div>}

      {!shelved && !grid && <div className="cv-viewport" ref={viewportRef} style={compact ? undefined : { top: viewportTop }}>
        <div className="cv-row" style={compact ? undefined : { transform: `translateX(${-offset * layout.lw}px)` }}>
          {items.length === 0
            ? <div style={{ color: 'var(--fg40)', fontSize: 28, padding: '110px 0' }}>Nothing here yet.</div>
            : <>
              <RowSpacer width={rowStart * layout.lw} />
              {items.slice(rowStart, rowEnd).map((node, k) => <Cell
                key={node.id} node={node} index={rowStart + k} row={-1} layout={layout}
                focused={rowStart + k === frame.iIdx && zone === 'row'}
                fallbackLabel={series?.label ?? parent.label}
                onCellFocus={onCellFocus} onCellSelect={onCellSelect} />)}
            </>}
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
