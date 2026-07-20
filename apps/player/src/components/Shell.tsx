import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { PlayerBootstrap } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { FocusProvider, useFocusable, useFocusController } from '../focus/FocusProvider.js'
import { playerStore, usePlayerSelector } from '../lib/store.js'
import { isPreferencesDirty } from '../lib/preferences.js'
import { ConfiguredHubPage, Home } from '../pages/Home.js'
import { Library } from '../pages/Library.js'
import { FilmDetailPage } from '../pages/FilmDetail.js'
import { SeriesDetailPage } from '../pages/SeriesDetail.js'
import { SearchPage } from '../pages/SearchPage.js'
import { SettingsPage } from '../pages/Settings.js'
import { ChannelsPage } from '../pages/Channels.js'
import { BrowsePage } from '../pages/Browse.js'
import { PersonDetailPage } from '../pages/PersonDetail.js'
import { Player } from './Player.js'
import ArchivistIcon from '../../../../client/src/icon.svg'

const routeScrollMemory = new Map<string, { top: number; left: number }>()

export function PlayerShell({ sdk, bootstrap }: { sdk: ArchivistSdk; bootstrap: PlayerBootstrap }) {
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
  return <FocusProvider onBack={back}><ShellContent sdk={sdk} bootstrap={bootstrap} requestNavigation={requestNavigation} /></FocusProvider>
}

function ShellContent({ sdk, bootstrap, requestNavigation }: { sdk: ArchivistSdk; bootstrap: PlayerBootstrap; requestNavigation: (target: string) => void }) {
  const focusController = useFocusController()
  const location = useLocation()
  const navigate = useNavigate()
  const prefs = usePlayerSelector(state => state.preferences)?.preferences ?? bootstrap.preferences.preferences
  const activePlayback = usePlayerSelector(state => state.activePlayback)
  const playbackMinimized = usePlayerSelector(state => state.playbackMinimized)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
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
    const fallback = location.pathname === '/' ? 'nav-home'
      : location.pathname.startsWith('/hub/') ? `nav-${location.pathname.slice('/hub/'.length)}`
      : location.pathname.startsWith('/films') || location.pathname.startsWith('/film/') ? 'nav-films'
      : location.pathname.startsWith('/series') ? 'nav-series'
      : location.pathname.startsWith('/browse/films') || location.pathname.startsWith('/browse/collections') ? 'nav-films'
      : location.pathname.startsWith('/browse/') ? 'nav-series'
      : location.pathname.startsWith('/tv') ? 'nav-tv'
      : location.pathname.startsWith('/search') ? 'nav-search'
      : 'nav-settings'
    focusController.restore(location.pathname, fallback)
    return () => document.removeEventListener('focusin', remember)
  }, [focusController, location.pathname])
  return (
    <div className="player-v2" data-sidebar-collapsed={sidebarCollapsed} data-text-scale={String(prefs.accessibility.textScale)} data-high-contrast={prefs.accessibility.highContrast} data-reduced-motion={prefs.accessibility.reducedMotion}>
      <div className="pointer-events-none fixed inset-0 -z-20 bg-noir-950" />
      <SideRail collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(value => !value)} showClock={prefs.navigation.showClock} hubs={prefs.home.hubs} requestNavigation={requestNavigation} />
      <main className={`relative h-screen overflow-hidden transition-all duration-300 ${sidebarCollapsed ? 'ml-16' : 'ml-14 lg:ml-52'}`}>
        <div className="h-full w-full min-w-0 overflow-x-clip p-4 lg:p-6">
          <Routes>
          <Route path="/" element={<Home sdk={sdk} v2 initialHub={bootstrap.initialHub} />} />
          <Route path="/hub/:hubId" element={<ConfiguredHubPage sdk={sdk} />} />
          <Route path="/films" element={<Library sdk={sdk} kind="films" v2 />} />
          <Route path="/series" element={<Library sdk={sdk} kind="series" v2 />} />
          <Route path="/browse/:mediaType" element={<BrowseRoute sdk={sdk} />} />
          <Route path="/film/:id" element={<FilmDetailPage sdk={sdk} v2 />} />
          <Route path="/series/:id" element={<SeriesDetailPage sdk={sdk} v2 />} />
          <Route path="/person/:id" element={<PersonDetailPage sdk={sdk} />} />
          <Route path="/tv" element={<ChannelsPage sdk={sdk} v2 />} />
          <Route path="/search" element={<SearchPage sdk={sdk} v2 />} />
          <Route path="/settings" element={<SettingsPage sdk={sdk} v2 />} />
          </Routes>
        </div>
      </main>
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
  return <aside aria-label="Now playing" className="player-dialog motion-slide fixed bottom-5 left-[calc(var(--rail-content-offset)+var(--safe-x))] right-[var(--safe-x)] z-50 flex h-20 items-center overflow-hidden rounded-2xl px-4 shadow-2xl">
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

function SideRail({ collapsed, onToggle, showClock, hubs, requestNavigation }: { collapsed: boolean; onToggle: () => void; showClock: boolean; hubs: PlayerBootstrap['preferences']['preferences']['home']['hubs']; requestNavigation: (target: string) => void }) {
  const [clock, setClock] = useState(() => new Date())
  const enabledHubs = hubs.filter(hub => hub.enabled)
  const nav = [
    ...enabledHubs.map(hub => ({ to: hub.id === 'home' ? '/' : `/hub/${hub.id}`, icon: hub.id === 'home' ? '🏠' : hub.icon, label: hub.name, focusId: `nav-${hub.id}`, accent: 'cyan' })),
    { to: '/films', icon: '🎬', label: 'Films', focusId: 'nav-films', accent: 'cyan' },
    { to: '/series', icon: '📺', label: 'Series', focusId: 'nav-series', accent: 'violet' },
    { to: '/tv', icon: '📡', label: 'TV', focusId: 'nav-tv', accent: 'cyan' },
    { to: '/search', icon: '🔎', label: 'Search', focusId: 'nav-search', accent: 'white' },
    { to: '/settings', icon: '⚙️', label: 'Settings', focusId: 'nav-settings', accent: 'white' },
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
    <aside data-expanded={!collapsed} className={`fixed left-0 top-0 z-50 flex h-full flex-col overflow-hidden border-r border-white/5 bg-noir-900 transition-all duration-500 ease-in-out ${collapsed ? 'w-16' : 'w-14 lg:w-52'}`}>
      <button type="button" aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} onClick={onToggle}
        className="flex flex-shrink-0 items-center overflow-hidden border-b border-white/5 px-2 py-4 text-left transition-colors hover:bg-white/5">
        <img src={ArchivistIcon} alt="" className="h-12 w-12 flex-shrink-0" />
        <span className={`ml-3 whitespace-nowrap font-display text-2xl tracking-widest text-gradient-full transition-all duration-500 ${collapsed ? 'pointer-events-none translate-x-4 opacity-0' : 'translate-x-0 opacity-100'}`}>ARCHIVIST</span>
      </button>
      <nav className="custom-scrollbar flex-1 space-y-1 overflow-x-hidden overflow-y-auto px-2 py-6" aria-label="Player">
        {nav.map(item => <SideNavItem key={item.to} {...item} collapsed={collapsed} requestNavigation={requestNavigation} />)}
      </nav>
      {showClock && <time className={`flex h-12 flex-shrink-0 items-center border-t border-white/5 px-4 font-mono text-[10px] uppercase tracking-widest text-white/35 ${collapsed ? 'justify-center px-0' : ''}`} dateTime={clock.toISOString()}>{collapsed ? '·' : clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
    </aside>
  )
}

const NAV_ACTIVE: Record<string, string> = {
  cyan: 'border border-cyan/60 bg-cyan/10 text-cyan shadow-[0_0_15px_rgba(0,212,255,0.1)]',
  violet: 'border border-violet/60 bg-violet/10 text-violet shadow-[0_0_15px_rgba(155,89,182,0.1)]',
  white: 'border border-white/40 bg-white/10 text-white shadow-[0_0_15px_rgba(255,255,255,0.05)]',
}

function SideNavItem({ to, icon, label, focusId, collapsed, accent, requestNavigation }: { to: string; icon: string; label: string; focusId: string; collapsed: boolean; accent: string; requestNavigation: (target: string) => void }) {
  const focusable = useFocusable({ id: focusId, zoneId: 'side-nav' })
  return <NavLink {...focusable} to={to} end={to === '/'} aria-label={label}
    onClick={event => { event.preventDefault(); requestNavigation(to) }}
    className={({ isActive }) => `player-focusable flex h-11 items-center overflow-hidden rounded-lg border border-transparent text-sm transition-all duration-300 ${isActive ? NAV_ACTIVE[accent] : 'text-white/30 hover:bg-white/5 hover:text-white/65'}`}>
    <span className="flex w-12 flex-shrink-0 items-center justify-center text-lg">{icon}</span>
    <span className={`ml-1 whitespace-nowrap font-medium tracking-wide transition-all duration-500 ${collapsed ? 'pointer-events-none translate-x-4 opacity-0' : 'translate-x-0 opacity-100'}`}>{label}</span>
  </NavLink>
}
