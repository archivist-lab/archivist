import { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Routes, Route, NavLink, useNavigate } from 'react-router-dom'
import type { PlayerBootstrap } from '@archivist/contracts'
import { ArchivistSdk } from './lib/sdk.js'
import { hydrateProgress, playerStore } from './lib/store.js'
import { clearLegacySettingsAfterImport, migrateLegacySettings, readLegacySettings } from './lib/preferences.js'
import { PlayerShell } from './components/Shell.js'
import { Home } from './pages/Home.js'
import { Library } from './pages/Library.js'
import { FilmDetailPage } from './pages/FilmDetail.js'
import { SeriesDetailPage } from './pages/SeriesDetail.js'
import { SearchPage } from './pages/SearchPage.js'
import { SettingsPage } from './pages/Settings.js'
import { ChannelsPage } from './pages/Channels.js'

/** One SDK instance per connection — pages get it via props. */
export default function App() {
  const sdk = useMemo(() => new ArchivistSdk({ url: '', apiKey: '' }), [])
  const [bootstrap, setBootstrap] = useState<PlayerBootstrap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const started = performance.now()
    const profileId = localStorage.getItem('archivist-player-profile') || 'default'
    sdk.setProfile(profileId)
    void sdk.bootstrap(profileId, controller.signal).then(async initial => {
      let resolved = initial
      if (initial.featureFlags.uiV2Enabled && !initial.preferences.preferences.migration.legacyLocalStorageImported) {
        const migrated = migrateLegacySettings(readLegacySettings(), initial.preferences.preferences)
        if (migrated) {
          try {
            const envelope = await sdk.updatePreferences({ profileId, expectedRevision: initial.preferences.revision, preferences: migrated }, controller.signal)
            resolved = { ...initial, preferences: envelope }
            clearLegacySettingsAfterImport()
          } catch { /* preserve the legacy key and retry on a later start */ }
        }
      }
      if (controller.signal.aborted) return
      hydrateProgress(resolved.progress)
      playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap: resolved })
      setBootstrap(resolved)
      setError(null)
      if (resolved.featureFlags.telemetryEnabled) void sdk.telemetry({ sessionId: crypto.randomUUID(), samples: [{ name: 'player_bootstrap_ms', valueMs: performance.now() - started, at: Date.now() }] })
    }).catch(reason => {
      if (controller.signal.aborted) return
      const message = reason instanceof Error ? reason.message : String(reason)
      playerStore.dispatch({ type: 'BOOTSTRAP_FAILED', message })
      setError(message)
    })
    return () => controller.abort()
  }, [sdk, attempt])

  return (
    <BrowserRouter>
      {!bootstrap && !error && <div className="player-v2 grid min-h-screen place-items-center"><div className="text-sm font-mono uppercase tracking-[.3em] text-white/35 player-skeleton">Opening the archive</div></div>}
      {!bootstrap && error && <div className="player-v2 grid min-h-screen place-items-center text-center"><div><h1 className="text-2xl font-semibold">Player unavailable</h1><p className="mt-2 max-w-md text-white/45">{error}</p><button onClick={() => setAttempt(value => value + 1)} className="mt-6 rounded-full bg-white px-6 py-3 font-bold text-black">Retry</button></div></div>}
      {bootstrap?.featureFlags.uiV2Enabled ? <PlayerShell sdk={sdk} bootstrap={bootstrap} /> : bootstrap ? <LegacyApp sdk={sdk} /> : null}
    </BrowserRouter>
  )
}

function LegacyApp({ sdk }: { sdk: ArchivistSdk }) {
  return <div className="legacy-player min-h-screen text-white">
    <TopNav />
    <main className="pt-14">
      <Routes>
        <Route path="/" element={<Home sdk={sdk} />} />
        <Route path="/films" element={<Library sdk={sdk} kind="films" />} />
        <Route path="/series" element={<Library sdk={sdk} kind="series" />} />
        <Route path="/film/:id" element={<FilmDetailPage sdk={sdk} />} />
        <Route path="/series/:id" element={<SeriesDetailPage sdk={sdk} />} />
        <Route path="/tv" element={<ChannelsPage sdk={sdk} />} />
        <Route path="/search" element={<SearchPage sdk={sdk} />} />
        <Route path="/settings" element={<SettingsPage sdk={sdk} />} />
      </Routes>
    </main>
  </div>
}

function TopNav() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const link = 'px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-widest transition-colors'

  return (
    <header className="fixed top-0 inset-x-0 z-40 h-14 flex items-center gap-4 px-5 bg-gradient-to-b from-noir-950 via-noir-950/85 to-transparent">
      <NavLink to="/" className="font-display text-xl tracking-[0.3em] text-white uppercase select-none">
        Archivist <span className="text-cyan">Player</span>
      </NavLink>
      <nav className="flex items-center gap-1 ml-4">
        {[['/', 'Home'], ['/films', 'Films'], ['/series', 'Series'], ['/tv', 'TV']].map(([to, label]) => (
          <NavLink key={to} to={to} end={to === '/'}
            className={({ isActive }) => `${link} relative ${isActive ? 'text-white' : 'text-white/40 hover:text-white'}`}>
            {({ isActive }) => (
              <>
                {label}
                {isActive && <span className="absolute -bottom-1 left-3 right-3 h-0.5 rounded-full bg-white" />}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <form
        className="ml-auto"
        onSubmit={e => { e.preventDefault(); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`) }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search…"
          className="w-40 focus:w-64 transition-all px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder-white/25 focus:outline-none focus:border-cyan/40"
        />
      </form>
      <NavLink to="/settings" className={({ isActive }) => `text-lg ${isActive ? 'text-cyan' : 'text-white/40 hover:text-white'}`} title="Settings">⚙</NavLink>
    </header>
  )
}
