import { orderLibraries } from '../lib/libraries.js'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { PlayerBootstrap, PlayerLibrary } from '@archivist/contracts'
import { Icon, type IconName } from '@archivist/design-system'
import type { ArchivistSdk } from '../lib/sdk.js'
import { FocusProvider, useFocusable, useFocusController } from '../focus/FocusProvider.js'
import { playerStore, usePlayerSelector } from '../lib/store.js'
import { isPreferencesDirty } from '../lib/preferences.js'
import { FilmDetailPage } from '../pages/FilmDetail.js'
import { SeriesDetailPage } from '../pages/SeriesDetail.js'
import { ShelfDetail } from '../pages/ShelfDetail.js'
import { BrowseCombined } from '../pages/BrowseCombined.js'
import { Player } from './Player.js'
import { AndroidExitDialog } from './AndroidExitDialog.js'
import { androidShell, claimRootBack } from '../lib/android.js'

/*
 * Screens off the main browsing path load on first visit. Home, the Films and
 * Series pages, the item pages and the player stay in the entry chunk — they
 * are what a television opens on — and the rest no longer has to be parsed
 * before the first frame on a streaming stick.
 */
const ConfiguredHubPage = lazy(() => import('../pages/Home.js').then(m => ({ default: m.ConfiguredHubPage })))
const SearchPage = lazy(() => import('../pages/SearchPage.js').then(m => ({ default: m.SearchPage })))
const SettingsPage = lazy(() => import('../pages/Settings.js').then(m => ({ default: m.SettingsPage })))
const ChannelsPage = lazy(() => import('../pages/Channels.js').then(m => ({ default: m.ChannelsPage })))
const BrowsePage = lazy(() => import('../pages/Browse.js').then(m => ({ default: m.BrowsePage })))
const PersonDetailPage = lazy(() => import('../pages/PersonDetail.js').then(m => ({ default: m.PersonDetailPage })))
const LeavingSoonPage = lazy(() => import('../pages/LeavingSoon.js').then(m => ({ default: m.LeavingSoonPage })))
const BooksPage = lazy(() => import('../pages/Books.js').then(m => ({ default: m.BooksPage })))
const GamesPage = lazy(() => import('../pages/Games.js').then(m => ({ default: m.GamesPage })))
const MusicPage = lazy(() => import('../pages/Music.js').then(m => ({ default: m.MusicPage })))

const routeScrollMemory = new Map<string, { top: number; left: number }>()

/** One film, series, book, comic, game or album — the routes the item view draws. */
const ITEM_ROUTE = /^\/(film|series|book|comic|game|album)\/[^/]+$/

export function PlayerShell({ sdk, bootstrap, username = null, onSignOut }: { sdk: ArchivistSdk; bootstrap: PlayerBootstrap; username?: string | null; onSignOut?: () => void | Promise<void> }) {
  const navigate = useNavigate()
  const location = useLocation()
  const saved = usePlayerSelector(state => state.preferences)
  const draft = usePlayerSelector(state => state.draft)
  const dirty = !!saved && !!draft && isPreferencesDirty(saved.preferences, draft)
  const requestNavigation = useCallback((target: string) => {
    if (target === location.pathname) return
    if (location.pathname === '/settings' && dirty) {
      playerStore.dispatch({ type: 'NAVIGATION_REQUESTED', target })
      return
    }
    if (target === '__back__') navigate(-1)
    else navigate(target)
  }, [dirty, location.pathname, navigate])
  // Inside the Android TV app, Back at the root asks before leaving the app.
  const [exitPrompt, setExitPrompt] = useState(false)
  useEffect(() => { claimRootBack() }, [])
  const back = useCallback(() => {
    const { modalStack: stack, activePlayback, playbackMinimized } = playerStore.getState()
    if (stack.length) { playerStore.dispatch({ type: 'MODAL_CLOSED' }); return }
    // The player owns Back while it is on screen. Its own layers normally claim
    // the key first; this is the net under them, so a Back that slips past
    // never navigates the page hidden underneath a playing film.
    if (activePlayback && !playbackMinimized) { playerStore.dispatch({ type: 'PLAYBACK_STOPPED' }); return }
    if (location.pathname !== '/') requestNavigation('__back__')
    else if (androidShell()) setExitPrompt(true)
  }, [location.pathname, requestNavigation])
  return <FocusProvider onBack={back}>
    <ShellContent sdk={sdk} bootstrap={bootstrap} username={username} onSignOut={onSignOut} requestNavigation={requestNavigation} />
    {exitPrompt && <AndroidExitDialog onClose={() => setExitPrompt(false)} />}
  </FocusProvider>
}

function ShellContent({ sdk, bootstrap, username, onSignOut, requestNavigation }: { sdk: ArchivistSdk; bootstrap: PlayerBootstrap; username: string | null; onSignOut?: () => void | Promise<void>; requestNavigation: (target: string) => void }) {
  const focusController = useFocusController()
  const location = useLocation()
  const navigate = useNavigate()
  const prefs = usePlayerSelector(state => state.preferences)?.preferences ?? bootstrap.preferences.preferences
  const activePlayback = usePlayerSelector(state => state.activePlayback)
  const playbackMinimized = usePlayerSelector(state => state.playbackMinimized)
  useLayoutEffect(() => {
    const routeKey = `${location.pathname}${location.search}`
    const container = document.querySelector<HTMLElement>('main [data-route-scroll]')
    const remembered = routeScrollMemory.get(routeKey)
    if (container && remembered) {
      if (typeof container.scrollTo === 'function') container.scrollTo({ ...remembered, behavior: 'auto' })
      else { container.scrollTop = remembered.top; container.scrollLeft = remembered.left }
    }
    return () => {
      if (container) routeScrollMemory.set(routeKey, { top: container.scrollTop, left: container.scrollLeft })
    }
  }, [location.pathname, location.search])
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const id = (event.target as HTMLElement | null)?.dataset.focusId
      if (id) focusController.remember(location.pathname, id)
    }
    document.addEventListener('focusin', remember)
    /*
     * Where focus lands on a route with no memory of its own. An item route
     * names nothing: the item view opens on its own primary control, and
     * sending focus to the chrome instead would put the cursor on navigation
     * the viewer did not ask for. An empty id simply fails, leaving the page's
     * own choice standing.
     */
    const fallback = ITEM_ROUTE.test(location.pathname) ? ''
      // Home, Films and Series are the Combined view, which keeps its own
      // keyboard focus on one anchor of its own rather than the chrome.
      : location.pathname === '/' ? 'cv-content'
      : location.pathname.startsWith('/hub/') ? `nav-${location.pathname.slice('/hub/'.length)}`
      : location.pathname.startsWith('/films') ? 'cv-content'
      : location.pathname.startsWith('/series') ? 'cv-content'
      : location.pathname.startsWith('/leaving-soon') ? 'nav-leaving-soon'
      : location.pathname.startsWith('/browse/films') || location.pathname.startsWith('/browse/collections') ? 'nav-films'
      : location.pathname.startsWith('/browse/') ? 'nav-series'
      : location.pathname.startsWith('/music') ? 'nav-music'
      : location.pathname.startsWith('/books') ? 'nav-books'
      : location.pathname.startsWith('/games') ? 'nav-games'
      : location.pathname.startsWith('/tv') ? 'nav-tv'
      : location.pathname.startsWith('/search') ? 'nav-search'
      : 'nav-settings'
    // Arrowing along the main menu navigates as it goes (see NavItem) and
    // means to stay there, not dive into the page it just switched to — so a
    // route change that leaves real focus sitting in the menu is left alone.
    if (!document.activeElement?.closest('.player-nav, .player-subnav')) focusController.restore(location.pathname, fallback)
    return () => document.removeEventListener('focusin', remember)
  }, [focusController, location.pathname])
  /*
   * Routes that own the whole screen: the Combined view and the item view are
   * both fixed 1920x1080 stages that scale themselves, and page padding around
   * one would only crop it.
   */
  const bare = /^\/(films|series)?$/.test(location.pathname) || ITEM_ROUTE.test(location.pathname)
  /*
   * A type can hold more than one library — films and 4K films, say — and the
   * menu names the type rather than either library. Where that happens the
   * libraries get a second row directly under the menu item they belong to,
   * shown only while that item is the selected one, and only on the browse
   * screen where picking one has something to act on.
   */
  const libraries = usePlayerSelector(state => state.bootstrap)?.libraries ?? bootstrap.libraries
  const libraryRow = useMemo(() => {
    const type: LibraryType | null = location.pathname === '/films' ? 'films' : location.pathname === '/series' ? 'series' : null
    if (!type) return null
    const owned = orderLibraries(libraries, type)
    return owned.length > 1 ? { type, libraries: owned } : null
  }, [libraries, location.pathname])

  return (
    <div className="player-v2" data-text-scale={String(prefs.accessibility.textScale)} data-high-contrast={prefs.accessibility.highContrast} data-reduced-motion={prefs.accessibility.reducedMotion}>
      <div className="pointer-events-none fixed inset-0 -z-20 bg-noir-950" />
      <main className="relative h-full min-h-full overflow-hidden">
        {/* A full-bleed surface draws its own safe area; a document page keeps
            the page padding, with room at the top for the chrome.

            `main` hides its overflow, so nothing here scrolls unless something
            inside it says it does. Every page does — a `data-route-scroll`
            root, or the flowing Combined/item view — but a page that forgot
            would silently have its content cut off with no way to reach it, so
            the wrapper scrolls too. Where the page already scrolls this never
            has anything to do: the page fills the wrapper exactly. */}
        <div className={bare ? 'h-full w-full' : 'h-full w-full min-w-0 overflow-x-clip overflow-y-auto no-scrollbar p-4 pt-16 lg:p-6 lg:pt-16'}>
          <Suspense fallback={<div className="player-skeleton p-10 font-mono text-xs uppercase tracking-[.3em] text-white/30">Loading</div>}>
          <Routes>
          <Route path="/" element={<BrowseCombined sdk={sdk} kind="home" />} />
          <Route path="/hub/:hubId" element={<ConfiguredHubPage sdk={sdk} />} />
          <Route path="/films" element={<BrowseCombined sdk={sdk} kind="films" />} />
          <Route path="/series" element={<BrowseCombined sdk={sdk} kind="series" />} />
          <Route path="/leaving-soon" element={<LeavingSoonPage sdk={sdk} />} />
          <Route path="/music" element={<MusicPage sdk={sdk} />} />
          <Route path="/books" element={<BooksPage sdk={sdk} />} />
          <Route path="/games" element={<GamesPage sdk={sdk} />} />
          <Route path="/browse/:mediaType" element={<BrowseRoute sdk={sdk} />} />
          <Route path="/film/:id" element={<FilmDetailPage sdk={sdk} />} />
          <Route path="/series/:id" element={<SeriesDetailPage sdk={sdk} />} />
          <Route path="/person/:id" element={<PersonDetailPage sdk={sdk} />} />
          <Route path="/book/:id" element={<ShelfDetail sdk={sdk} kind="book" />} />
          <Route path="/comic/:id" element={<ShelfDetail sdk={sdk} kind="comic" />} />
          <Route path="/game/:id" element={<ShelfDetail sdk={sdk} kind="game" />} />
          <Route path="/album/:id" element={<ShelfDetail sdk={sdk} kind="album" />} />
          <Route path="/tv" element={<ChannelsPage sdk={sdk} v2 />} />
          <Route path="/search" element={<SearchPage sdk={sdk} v2 />} />
          <Route path="/settings" element={<SettingsPage sdk={sdk} v2 />} />
          </Routes>
          </Suspense>
        </div>
      </main>
      <PrimaryNav requestNavigation={requestNavigation} libraryRow={libraryRow} />
      {libraryRow && <LibraryNav type={libraryRow.type} libraries={libraryRow.libraries} />}
      <PlayerUtilities showClock={prefs.navigation.showClock} username={username} onSignOut={onSignOut} />
      {activePlayback && <Player key={activePlayback.target.key} target={activePlayback.target} nextTarget={activePlayback.nextTarget} sdk={sdk} minimized={playbackMinimized}
        onMinimize={() => playerStore.dispatch({ type: 'PLAYBACK_MINIMIZED', minimized: true })}
        onAdvance={target => playerStore.dispatch({ type: 'PLAYBACK_ADVANCED', target })}
        onRecommendation={item => { playerStore.dispatch({ type: 'PLAYBACK_STOPPED' }); navigate(item.route || (item.mediaType === 'film' ? `/film/${item.id}` : `/series/${item.id}`)) }}
        onClose={() => playerStore.dispatch({ type: 'PLAYBACK_STOPPED' })} />}
      {activePlayback && playbackMinimized && <NowPlayingStrip sdk={sdk} title={activePlayback.target.title} seriesTitle={activePlayback.target.seriesTitle} artwork={activePlayback.target.backdropUrl ?? activePlayback.target.posterUrl} />}
    </div>
  )
}

function NowPlayingStrip({ sdk, title, seriesTitle, artwork }: { sdk: ArchivistSdk; title: string; seriesTitle?: string; artwork?: string | null }) {
  return <aside aria-label="Now playing" className="player-dialog motion-slide fixed bottom-5 left-[var(--safe-x)] right-[var(--safe-x)] z-50 flex h-20 items-center overflow-hidden rounded-2xl px-4 shadow-2xl">
    {artwork && <img src={sdk.asset(artwork)} alt="" className="mr-4 h-14 w-24 rounded-lg object-cover" />}
    <div className="min-w-0"><p className="font-mono text-[10px] font-semibold uppercase tracking-[.2em] player-accent">Now playing</p><p className="truncate font-display uppercase tracking-wide">{seriesTitle ?? title}</p>{seriesTitle && <p className="truncate font-mono text-[10px] uppercase text-white/45">{title}</p>}</div>
    <div className="ml-auto flex gap-2"><button onClick={() => playerStore.dispatch({ type: 'PLAYBACK_MINIMIZED', minimized: false })} className="player-focusable player-accent-bg rounded-lg px-5 py-2 text-[10px] font-bold uppercase tracking-widest">Open player</button><button onClick={() => playerStore.dispatch({ type: 'PLAYBACK_STOPPED' })} className="player-focusable rounded-lg bg-white/8 px-5 py-2 text-[10px] font-bold uppercase tracking-widest">Stop</button></div>
  </aside>
}

function BrowseRoute({ sdk }: { sdk: ArchivistSdk }) {
  const location = useLocation()
  const mediaType = location.pathname.split('/')[2]
  const requested = ['films', 'series', 'episodes', 'collections', 'saved'].includes(mediaType) ? mediaType as 'films' | 'series' | 'episodes' | 'collections' | 'saved' : 'films'
  return <BrowsePage sdk={sdk} requestedType={requested} />
}

/**
 * The Player's main menu.
 *
 * The same text-header look as the Combined view's own folder strip — the
 * same font, the same underline on the active item — but fixed at the top
 * left of every screen rather than drawn fresh inside the Combined view
 * alone, so every destination is reachable the same way from anywhere.
 */
const NAV_ENTRIES: readonly NavEntry[] = [
  { to: '/', icon: 'home', label: 'Home', focusId: 'nav-home', accent: 'white' },
  { to: '/films', icon: 'film', label: 'Films', focusId: 'nav-films', accent: 'cyan' },
  { to: '/series', icon: 'series', label: 'Series', focusId: 'nav-series', accent: 'violet' },
  { to: '/music', icon: 'music', label: 'Music', focusId: 'nav-music', accent: 'pink' },
  { to: '/books', icon: 'book', label: 'Books', focusId: 'nav-books', accent: 'yellow' },
  { to: '/games', icon: 'games', label: 'Games', focusId: 'nav-games', accent: 'green' },
  { to: '/leaving-soon', icon: 'leaving-soon', label: 'Leaving Soon', focusId: 'nav-leaving-soon', accent: 'pink' },
  { to: '/settings', icon: 'settings', label: 'Settings', focusId: 'nav-settings', accent: 'white' },
]

function PrimaryNav({ requestNavigation, libraryRow }: { requestNavigation: (target: string) => void; libraryRow: LibraryRow | null }) {
  return (
    <nav className="player-nav" aria-label="Player">
      {NAV_ENTRIES.map(item => <NavItem key={item.to} {...item} requestNavigation={requestNavigation}
        libraryRowId={libraryRow && item.to === `/${libraryRow.type}` ? libraryId(libraryRow.libraries[0]) : null} />)}
    </nav>
  )
}

type LibraryType = 'films' | 'series'
interface LibraryRow { type: LibraryType; libraries: PlayerLibrary[] }

/** The focus id, and the row's identity, for one library. */
const libraryId = (library: PlayerLibrary) => `library-${library.id}`

/** Where the library row sends Up and Down, either side of its own row. */
const LIBRARY_NEIGHBORS: Record<LibraryType, { up: string; down: string }> = {
  films: { up: 'nav-films', down: 'cv-content' },
  series: { up: 'nav-series', down: 'cv-content' },
}

/**
 * The libraries of the selected type, under the menu item that names it.
 *
 * One of them is always showing — the first until the viewer picks another —
 * so the menu item names the type and this row says which of its libraries is
 * open. Which one rides in the URL, so it survives a reload and a Back, and
 * the browse page reads it as an ordinary filter.
 */
function LibraryNav({ type, libraries }: { type: LibraryType; libraries: PlayerLibrary[] }) {
  const location = useLocation()
  const requested = Number(new URLSearchParams(location.search).get('library'))
  const active = libraries.find(library => library.id === requested) ?? libraries[0]
  const indent = useMenuIndent(type)
  return (
    <nav className="player-subnav" aria-label={`${type === 'films' ? 'Film' : 'Series'} libraries`}
      style={{ ['--nav-accent' as string]: NAV_ACCENT[type === 'films' ? 'cyan' : 'violet'], paddingLeft: indent }}>
      {libraries.map(library => <LibraryItem key={library.id} type={type} library={library}
        active={library.id === active.id} />)}
    </nav>
  )
}

/**
 * Where the row starts: under the name of the menu item it belongs to, rather
 * than at the screen's own margin. The menu is a flex row of labels, so the
 * offset is whatever the text ahead of that item happens to measure, and it is
 * read off the laid-out menu rather than guessed at. Undefined until it is
 * measured, which leaves the stylesheet's own margin standing for that frame.
 */
function useMenuIndent(type: LibraryType): number | undefined {
  const [indent, setIndent] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const menu = document.querySelector<HTMLElement>('.player-nav')
    const align = () => {
      const item = document.querySelector<HTMLElement>(`[data-focus-id="nav-${type}"]`)
      if (!item) { setIndent(undefined); return }
      /*
       * The menu item's own left edge is where its ident starts, and a row
       * lined up on that reads as hanging off to the left of the word it
       * belongs to. What has to line up is the lettering, so the measurement
       * runs to the far side of the ident and across the gap after it.
       */
      const label = item.querySelector<HTMLElement>('.player-nav-item-label')
      const ident = item.querySelector<HTMLElement>('.player-nav-item-icon')
      const gap = label ? parseFloat(getComputedStyle(label).columnGap) || 0 : 0
      setIndent(ident ? ident.getBoundingClientRect().right + gap : item.getBoundingClientRect().left)
    }
    align()
    window.addEventListener('resize', align)
    // A narrow window scrolls the menu sideways, and the row follows it.
    menu?.addEventListener('scroll', align, { passive: true })
    // Guarded the way the stage's own fit is: jsdom has no ResizeObserver, and
    // the resize listener alone covers everything but a menu that reflows.
    const observer = menu && typeof ResizeObserver === 'function' ? new ResizeObserver(align) : null
    observer?.observe(menu!)
    return () => {
      window.removeEventListener('resize', align)
      menu?.removeEventListener('scroll', align)
      observer?.disconnect()
    }
  }, [type])
  return indent
}

function LibraryItem({ type, library, active }: { type: LibraryType; library: PlayerLibrary; active: boolean }) {
  const navigate = useNavigate()
  const to = `/${type}?library=${library.id}`
  /*
   * Arriving narrows the type's rows to this library, the way arriving at a
   * menu item goes to it. Pressing it opens the library itself: everything in
   * it, A-Z, in one grid. So a remote walks the row to look and presses to
   * open, and the row is a switch rather than a set of links that all lead
   * somewhere else.
   *
   * Replacing rather than pushing: walking the row is one decision being made,
   * not a trail of pages to press Back through.
   */
  const narrow = useCallback(() => { if (!active) navigate(to, { replace: true }) }, [active, navigate, to])
  const open = useCallback(() => navigate(`${to}&all=1`, { replace: true }), [navigate, to])
  const focusable = useFocusable({ id: libraryId(library), zoneId: 'chrome-libraries', neighbors: LIBRARY_NEIGHBORS[type], onFocused: narrow })
  return <button type="button" {...focusable} aria-current={active ? 'true' : undefined}
    onClick={active ? open : narrow} className="player-focusable player-subnav-item">
    {library.name}
    <u />
  </button>
}

/** The clock and sign-out, opposite the main menu. */
function PlayerUtilities({ showClock, username, onSignOut }: { showClock: boolean; username: string | null; onSignOut?: () => void | Promise<void> }) {
  const [clock, setClock] = useState(() => new Date())
  useEffect(() => {
    const delay = 60_000 - Date.now() % 60_000
    let interval: number | undefined
    const timeout = window.setTimeout(() => {
      setClock(new Date())
      interval = window.setInterval(() => setClock(new Date()), 60_000)
    }, delay)
    return () => { clearTimeout(timeout); if (interval !== undefined) clearInterval(interval) }
  }, [])
  return (
    <div className="player-chrome">
      {showClock && <span className="player-chrome-clock">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
      <button type="button" title={username ? `Sign out ${username}` : 'Sign out'} aria-label="Sign out" onClick={() => void onSignOut?.()}
        className="player-focusable player-chrome-item">
        <Icon name="logout" size={20} />
      </button>
    </div>
  )
}

/** Matches the accent each destination carries elsewhere in the app. */
const NAV_ACCENT: Record<string, string> = {
  cyan: '#00D4FF',
  violet: '#9B59B6',
  pink: '#FF2D78',
  yellow: '#F1C40F',
  green: '#2ECC71',
  white: '#ffffff',
}

interface NavEntry {
  to: string
  icon: IconName
  label: string
  focusId: string
  accent: string
}

/**
 * Down from any menu item lands in the current screen's own browsing anchor,
 * when it has one — the Combined view keeps its own keyboard focus on a
 * single anchor rather than the chrome. Elsewhere, an id that resolves to
 * nothing simply falls through to ordinary spatial navigation.
 */
const NAV_NEIGHBORS = { down: 'cv-content' }

function NavItem({ to, icon, label, focusId, accent, requestNavigation, libraryRowId = null }: NavEntry & { requestNavigation: (target: string) => void; libraryRowId?: string | null }) {
  // Down from the item a library row belongs to lands in that row first.
  const neighbors = useMemo(() => (libraryRowId ? { down: libraryRowId } : NAV_NEIGHBORS), [libraryRowId])
  // Arrowing to a menu item goes there immediately, the way the folder strip
  // it replaces always did — the menu is how you browse destinations, not
  // just a bookmark you have to press Enter on to actually use.
  const focusable = useFocusable({ id: focusId, zoneId: 'chrome-nav', neighbors, onFocused: () => requestNavigation(to) })
  const location = useLocation()
  const active = to === '/films'
    ? location.pathname === '/films' || location.pathname.startsWith('/film/') || location.pathname.startsWith('/browse/films')
    : to === '/series'
      ? location.pathname === '/series' || location.pathname.startsWith('/series/') || location.pathname.startsWith('/browse/series')
      : to === '/music'
        ? location.pathname === '/music' || location.pathname.startsWith('/album/')
        : to === '/books'
          ? location.pathname === '/books' || location.pathname.startsWith('/book/')
          : to === '/games'
            ? location.pathname === '/games' || location.pathname.startsWith('/game/')
            : to === '/'
              ? location.pathname === '/'
              : location.pathname === to || location.pathname.startsWith(`${to}/`)
  return <NavLink {...focusable} to={to} end={to === '/'} aria-label={label} aria-current={active ? 'page' : undefined}
    style={{ ['--nav-accent' as string]: NAV_ACCENT[accent] }}
    onClick={event => { event.preventDefault(); requestNavigation(to) }}
    className="player-focusable player-nav-item">
    <span className="player-nav-item-label"><Icon name={icon} size={18} className="player-nav-item-icon" />{label}</span>
    <u />
  </NavLink>
}
