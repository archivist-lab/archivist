import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { PlayerBootstrap } from '@archivist/contracts'
import { Icon, isIconName, type IconName } from '@archivist/design-system'
import type { ArchivistSdk } from '../lib/sdk.js'
import { FocusProvider, useFocusable, useFocusController } from '../focus/FocusProvider.js'
import { playerStore, usePlayerSelector } from '../lib/store.js'
import { isPreferencesDirty } from '../lib/preferences.js'
import { ConfiguredHubPage } from '../pages/Home.js'
import { FilmDetailPage } from '../pages/FilmDetail.js'
import { SeriesDetailPage } from '../pages/SeriesDetail.js'
import { SearchPage } from '../pages/SearchPage.js'
import { SettingsPage } from '../pages/Settings.js'
import { ChannelsPage } from '../pages/Channels.js'
import { BrowsePage } from '../pages/Browse.js'
import { PersonDetailPage } from '../pages/PersonDetail.js'
import { ShelfDetail } from '../pages/ShelfDetail.js'
import { BrowseCombined } from '../pages/BrowseCombined.js'
import { LeavingSoonPage } from '../pages/LeavingSoon.js'
import { Player } from './Player.js'

const routeScrollMemory = new Map<string, { top: number; left: number }>()

/** One film, series, book, comic or game — the routes the item view draws. */
const ITEM_ROUTE = /^\/(film|series|book|comic|game)\/[^/]+$/

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
  const back = useCallback(() => {
    const stack = playerStore.getState().modalStack
    if (stack.length) { playerStore.dispatch({ type: 'MODAL_CLOSED' }); return }
    if (location.pathname !== '/') requestNavigation('__back__')
  }, [location.pathname, requestNavigation])
  return <FocusProvider onBack={back}><ShellContent sdk={sdk} bootstrap={bootstrap} username={username} onSignOut={onSignOut} requestNavigation={requestNavigation} /></FocusProvider>
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
      : location.pathname === '/' ? 'nav-home'
      : location.pathname.startsWith('/hub/') ? `nav-${location.pathname.slice('/hub/'.length)}`
      : location.pathname.startsWith('/films') ? 'nav-films'
      : location.pathname.startsWith('/series') ? 'nav-series'
      : location.pathname.startsWith('/leaving-soon') ? 'nav-leaving-soon'
      : location.pathname.startsWith('/browse/films') || location.pathname.startsWith('/browse/collections') ? 'nav-films'
      : location.pathname.startsWith('/browse/') ? 'nav-series'
      : location.pathname.startsWith('/tv') ? 'nav-tv'
      : location.pathname.startsWith('/search') ? 'nav-search'
      : 'nav-settings'
    focusController.restore(location.pathname, fallback)
    return () => document.removeEventListener('focusin', remember)
  }, [focusController, location.pathname])
  /*
   * Routes that own the whole screen: the Combined view and the item view are
   * both fixed 1920x1080 stages that scale themselves, and page padding around
   * one would only crop it.
   */
  const bare = /^\/(films|series)?$/.test(location.pathname) || ITEM_ROUTE.test(location.pathname)

  return (
    <div className="player-v2" data-text-scale={String(prefs.accessibility.textScale)} data-high-contrast={prefs.accessibility.highContrast} data-reduced-motion={prefs.accessibility.reducedMotion}>
      <div className="pointer-events-none fixed inset-0 -z-20 bg-noir-950" />
      <main className="relative h-full min-h-full overflow-hidden">
        {/* A full-bleed surface draws its own safe area; a document page keeps
            the page padding, with room at the top for the chrome. */}
        <div className={bare ? 'h-full w-full' : 'h-full w-full min-w-0 overflow-x-clip p-4 pt-16 lg:p-6 lg:pt-16'}>
          <Routes>
          <Route path="/" element={<BrowseCombined sdk={sdk} kind="home" />} />
          <Route path="/hub/:hubId" element={<ConfiguredHubPage sdk={sdk} />} />
          <Route path="/films" element={<BrowseCombined sdk={sdk} kind="films" />} />
          <Route path="/series" element={<BrowseCombined sdk={sdk} kind="series" />} />
          <Route path="/leaving-soon" element={<LeavingSoonPage sdk={sdk} />} />
          <Route path="/browse/:mediaType" element={<BrowseRoute sdk={sdk} />} />
          <Route path="/film/:id" element={<FilmDetailPage sdk={sdk} />} />
          <Route path="/series/:id" element={<SeriesDetailPage sdk={sdk} />} />
          <Route path="/person/:id" element={<PersonDetailPage sdk={sdk} />} />
          <Route path="/book/:id" element={<ShelfDetail sdk={sdk} kind="book" />} />
          <Route path="/comic/:id" element={<ShelfDetail sdk={sdk} kind="comic" />} />
          <Route path="/game/:id" element={<ShelfDetail sdk={sdk} kind="game" />} />
          <Route path="/tv" element={<ChannelsPage sdk={sdk} v2 />} />
          <Route path="/search" element={<SearchPage sdk={sdk} v2 />} />
          <Route path="/settings" element={<SettingsPage sdk={sdk} v2 />} />
          </Routes>
        </div>
      </main>
      <PlayerChrome showClock={prefs.navigation.showClock} hubs={prefs.home.hubs} username={username} onSignOut={onSignOut} requestNavigation={requestNavigation} />
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

/** A hub icon is either a pack icon name or, until the picker lands, free text. */
type HubGlyph = IconName | { char: string }

/** Hub icons the server used to seed before the pack existed. */
const LEGACY_HUB_GLYPHS: Record<string, IconName> = {
  '⌂': 'home',
  '🏠': 'home',
  '▯': 'film',
  '🎬': 'film',
  '▤': 'series',
  '📺': 'series',
  '◉': 'channels',
  '📡': 'channels',
  '◆': 'custom-hub',
  '★': 'rating-star',
  '☆': 'rating-star-empty',
}

/**
 * Hub icons are still user-editable free text, so a value can be a pack name, a
 * glyph we used to seed, or something the user typed. Only the last of those is
 * rendered as a character — everything else resolves to a drawing.
 */
function hubIcon(value: string): HubGlyph {
  const trimmed = value.trim()
  if (isIconName(trimmed)) return trimmed
  const legacy = LEGACY_HUB_GLYPHS[trimmed]
  if (legacy) return legacy
  return trimmed ? { char: trimmed } : 'custom-hub'
}

/**
 * The Player's navigation.
 *
 * The side rail this replaces was the Library's sidebar carried across, and it
 * cost a column of a ten-foot screen to say what the Combined view's own type
 * strip already says. What is left is what nothing else offers a way to: the
 * configured hubs, the two libraries, and the utilities. It sits out of the
 * way at the top right, dimmed until it is hovered or holds focus, so the
 * artwork underneath keeps the screen.
 */
function PlayerChrome({ showClock, hubs, username, onSignOut, requestNavigation }: { showClock: boolean; hubs: PlayerBootstrap['preferences']['preferences']['home']['hubs']; username: string | null; onSignOut?: () => void | Promise<void>; requestNavigation: (target: string) => void }) {
  const [clock, setClock] = useState(() => new Date())
  const enabledHubs = hubs.filter(hub => hub.enabled)
  const nav: ChromeEntry[] = [
    ...enabledHubs.map(hub => ({
      to: hub.id === 'home' ? '/' : `/hub/${hub.id}`,
      icon: hub.id === 'home' ? 'home' : hubIcon(hub.icon),
      label: hub.name,
      focusId: `nav-${hub.id}`,
      accent: 'cyan',
    })),
    { to: '/films', icon: 'film', label: 'Films', focusId: 'nav-films', accent: 'cyan' },
    { to: '/series', icon: 'series', label: 'Series', focusId: 'nav-series', accent: 'violet' },
    { to: '/leaving-soon', icon: 'leaving-soon', label: 'Leaving Soon', focusId: 'nav-leaving-soon', accent: 'pink' },
    { to: '/tv', icon: 'channels', label: 'TV', focusId: 'nav-tv', accent: 'cyan' },
    { to: '/search', icon: 'search', label: 'Search', focusId: 'nav-search', accent: 'white' },
    { to: '/settings', icon: 'settings', label: 'Settings', focusId: 'nav-settings', accent: 'white' },
  ]
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
      <nav className="player-chrome-nav" aria-label="Player">
        {nav.map(item => <ChromeItem key={item.to} {...item} requestNavigation={requestNavigation} />)}
      </nav>
      {showClock && <span className="player-chrome-clock">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
      <button type="button" title={username ? `Sign out ${username}` : 'Sign out'} aria-label="Sign out" onClick={() => void onSignOut?.()}
        className="player-focusable player-chrome-item">
        <Icon name="logout" size={20} />
      </button>
    </div>
  )
}

const NAV_ACTIVE: Record<string, string> = {
  cyan: 'border-cyan/60 bg-cyan/10 text-cyan',
  violet: 'border-violet/60 bg-violet/10 text-violet',
  white: 'border-white/40 bg-white/10 text-white',
  pink: 'border-pink/60 bg-pink/10 text-pink',
}

interface ChromeEntry {
  to: string
  icon: HubGlyph
  label: string
  focusId: string
  accent: string
}

function ChromeItem({ to, icon, label, focusId, accent, requestNavigation }: ChromeEntry & { requestNavigation: (target: string) => void }) {
  const focusable = useFocusable({ id: focusId, zoneId: 'chrome-nav' })
  const location = useLocation()
  const active = to === '/films'
    ? location.pathname === '/films' || location.pathname.startsWith('/film/') || location.pathname.startsWith('/browse/films')
    : to === '/series'
      ? location.pathname === '/series' || location.pathname.startsWith('/series/') || location.pathname.startsWith('/browse/series')
      : to === '/'
        ? location.pathname === '/'
        : location.pathname === to || location.pathname.startsWith(`${to}/`)
  return <NavLink {...focusable} to={to} end={to === '/'} aria-label={label} title={label} aria-current={active ? 'page' : undefined} data-accent={accent}
    onClick={event => { event.preventDefault(); requestNavigation(to) }}
    className={`player-focusable player-chrome-item ${active ? NAV_ACTIVE[accent] : ''}`}>
    {typeof icon === 'string' ? <Icon name={icon} size={20} /> : <span className="text-base leading-none">{icon.char}</span>}
  </NavLink>
}
