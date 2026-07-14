import { useCallback, useEffect, useState } from 'react'
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { PlayerBootstrap } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { FocusProvider, useFocusable, useFocusController } from '../focus/FocusProvider.js'
import { playerStore, usePlayerSelector } from '../lib/store.js'
import { isPreferencesDirty } from '../lib/preferences.js'
import { Home } from '../pages/Home.js'
import { Library } from '../pages/Library.js'
import { FilmDetailPage } from '../pages/FilmDetail.js'
import { SeriesDetailPage } from '../pages/SeriesDetail.js'
import { SearchPage } from '../pages/SearchPage.js'
import { SettingsPage } from '../pages/Settings.js'
import { ChannelsPage } from '../pages/Channels.js'

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
  const context = usePlayerSelector(state => state.mediaContext)
  const prefs = usePlayerSelector(state => state.preferences)?.preferences ?? bootstrap.preferences.preferences
  const backdrop = context?.backdropUrl ? sdk.asset(context.backdropUrl) : ''
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const id = (event.target as HTMLElement | null)?.dataset.focusId
      if (id) focusController.remember(location.pathname, id)
    }
    document.addEventListener('focusin', remember)
    const fallback = location.pathname === '/' ? 'nav-home'
      : location.pathname.startsWith('/films') || location.pathname.startsWith('/film/') ? 'nav-films'
      : location.pathname.startsWith('/series') ? 'nav-series'
      : location.pathname.startsWith('/tv') ? 'nav-tv'
      : location.pathname.startsWith('/search') ? 'nav-search'
      : 'nav-settings'
    focusController.restore(location.pathname, fallback)
    return () => document.removeEventListener('focusin', remember)
  }, [focusController, location.pathname])
  return (
    <div className="player-v2" data-text-scale={String(prefs.accessibility.textScale)} data-high-contrast={prefs.accessibility.highContrast} data-reduced-motion={prefs.accessibility.reducedMotion}>
      <div className="pointer-events-none fixed inset-0 z-0 bg-noir-950">
        {backdrop && <img key={backdrop} src={backdrop} alt="" className="motion-backdrop absolute inset-0 h-full w-full object-cover opacity-55" />}
        <div className="absolute inset-0 bg-gradient-to-r from-noir-950 via-noir-950/65 to-noir-950/20" />
        <div className="absolute inset-0 bg-gradient-to-t from-noir-950 via-transparent to-black/30" />
      </div>
      <SideRail showClock={prefs.navigation.showClock} requestNavigation={requestNavigation} />
      <main className="relative z-10 ml-[var(--rail-collapsed)] h-screen overflow-hidden">
        <Routes>
          <Route path="/" element={<Home sdk={sdk} v2 initialHub={bootstrap.initialHub} />} />
          <Route path="/films" element={<Library sdk={sdk} kind="films" v2 />} />
          <Route path="/series" element={<Library sdk={sdk} kind="series" v2 />} />
          <Route path="/film/:id" element={<FilmDetailPage sdk={sdk} v2 />} />
          <Route path="/series/:id" element={<SeriesDetailPage sdk={sdk} v2 />} />
          <Route path="/tv" element={<ChannelsPage sdk={sdk} v2 />} />
          <Route path="/search" element={<SearchPage sdk={sdk} v2 />} />
          <Route path="/settings" element={<SettingsPage sdk={sdk} v2 />} />
        </Routes>
      </main>
    </div>
  )
}

const nav = [
  ['/', '⌂', 'Home'], ['/films', '▯', 'Films'], ['/series', '▤', 'Series'], ['/tv', '◉', 'TV'], ['/search', '⌕', 'Search'], ['/settings', '⚙', 'Settings'],
] as const

function SideRail({ showClock, requestNavigation }: { showClock: boolean; requestNavigation: (target: string) => void }) {
  const [expanded, setExpanded] = useState(false)
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
    <aside onFocus={() => setExpanded(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setExpanded(false) }}
      className={`motion-rail player-surface fixed inset-y-0 left-0 z-40 flex flex-col overflow-hidden border-y-0 border-l-0 ${expanded ? 'w-[var(--rail-expanded)]' : 'w-[var(--rail-collapsed)]'}`}>
      <div className="flex h-24 items-center px-5 text-lg font-bold tracking-[.18em]"><span className="text-cyan">A</span>{expanded && <span className="ml-3 whitespace-nowrap">ARCHIVIST</span>}</div>
      <nav className="flex flex-1 flex-col justify-center gap-2 px-2" aria-label="Player">
        {nav.map(([to, icon, label]) => <SideNavItem key={to} to={to} icon={icon} label={label} expanded={expanded} requestNavigation={requestNavigation} />)}
      </nav>
      {showClock && <time className="h-16 px-5 text-sm text-white/45" dateTime={clock.toISOString()}>{expanded ? clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '·'}</time>}
    </aside>
  )
}

function SideNavItem({ to, icon, label, expanded, requestNavigation }: { to: string; icon: string; label: string; expanded: boolean; requestNavigation: (target: string) => void }) {
  const focusable = useFocusable({ id: `nav-${label.toLowerCase()}`, zoneId: 'side-nav' })
  return <NavLink {...focusable} to={to} end={to === '/'} aria-label={label}
    onClick={event => { event.preventDefault(); requestNavigation(to) }}
    className={({ isActive }) => `player-focusable flex h-12 items-center rounded-xl px-3 text-lg ${isActive ? 'bg-white/12 text-white' : 'text-white/48 hover:text-white'}`}>
    <span className="w-8 shrink-0 text-center">{icon}</span>{expanded && <span className="ml-3 whitespace-nowrap text-sm font-semibold">{label}</span>}
  </NavLink>
}
