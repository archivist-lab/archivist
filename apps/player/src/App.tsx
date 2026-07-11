import { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Routes, Route, NavLink, useNavigate } from 'react-router-dom'
import { ArchivistSdk } from './lib/sdk.js'
import { hydrateProgress } from './lib/store.js'
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

  useEffect(() => {
    sdk.progress().then(result => hydrateProgress(result.progress)).catch(() => {})
  }, [sdk])

  return (
    <BrowserRouter>
      <div className="min-h-screen text-white">
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
    </BrowserRouter>
  )
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
