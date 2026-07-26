import { useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Sidebar } from './components/Sidebar.js'
import { Dashboard } from './modules/home/Dashboard.js'
import { FilmsPage } from './modules/films/index.js'
import { SeriesPage } from './modules/series/index.js'
import { MusicPage } from './modules/music/index.js'
import { BooksPage } from './modules/books/index.js'
import { ComicsPage } from './modules/comics/index.js'
import { GamesPage } from './modules/games/index.js'
import { SettingsPage } from './modules/settings/index.js'
import { AcquisitionsPage } from './modules/acquisitions/index.js'
import { ChannelsPage } from './modules/channels/index.js'
import { Spinner } from './components/ui.js'
import Icon from './icon.svg'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { SetupWizard } from './components/SetupWizard.js'
import { NotificationHost } from './lib/notify.js'
import { Arcade } from './modules/arcade/index.js'
import { useTabs } from './lib/tab-context.js'

export default function App() {
  const { onboardingCompleted } = useTabs()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [showKonami, setShowKonami] = useState(false)
  const konamiBuffer = useRef<string[]>([])
  
  const KONAMI_CODE = [
    'ArrowUp', 'ArrowUp', 
    'ArrowDown', 'ArrowDown', 
    'ArrowLeft', 'ArrowRight', 
    'ArrowLeft', 'ArrowRight', 
    'b', 'a', 'Enter'
  ]

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      konamiBuffer.current.push(e.key)
      if (konamiBuffer.current.length > KONAMI_CODE.length) {
        konamiBuffer.current.shift()
      }

      if (konamiBuffer.current.join(',').toLowerCase() === KONAMI_CODE.join(',').toLowerCase()) {
        setShowKonami(true)
        konamiBuffer.current = []
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <BrowserRouter>
      <div className="min-h-screen text-white relative">
        {/* App-wide base background */}
        <div className="fixed inset-0 bg-noir-950 -z-20" />

        {onboardingCompleted === null ? (
          <div className="flex items-center justify-center min-h-screen">
            <Spinner className="w-8 h-8" color="text-white/20" />
          </div>
        ) : onboardingCompleted === false ? (
          <SetupWizard />
        ) : (
        <>
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}
          mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />

        {/* Mobile top bar (below lg): hamburger opens the drawer. */}
        <header className="lg:hidden fixed top-0 inset-x-0 h-14 z-40 flex items-center gap-3 px-4 bg-noir-900/95 backdrop-blur border-b border-white/5">
          <button type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open menu"
            className="-ml-2 w-10 h-10 flex items-center justify-center text-white/70 hover:text-white">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <img src={Icon} alt="" className="w-8 h-8" />
          <span className="font-display text-lg tracking-widest text-gradient-full">ARCHIVIST</span>
        </header>

        {/* Sidebar is fixed (out of flow); main offsets by its width on desktop and
            goes full-width on mobile (drawer overlays instead). */}
        <main className={`transition-all duration-300 min-h-screen ${collapsed ? 'lg:ml-16' : 'lg:ml-52'}`}>
          <div className="p-4 lg:p-6 pt-[72px] lg:pt-6 w-full min-w-0 overflow-x-hidden">
            <Routes>
              <Route path="/" element={<Dashboard />} />

              <Route path="/films/*"  element={<ErrorBoundary label="films"><FilmsPage /></ErrorBoundary>} />
              <Route path="/series/*" element={<ErrorBoundary label="series"><SeriesPage /></ErrorBoundary>} />
              <Route path="/music/*"  element={<ErrorBoundary label="music"><MusicPage /></ErrorBoundary>} />
              <Route path="/books/*"  element={<ErrorBoundary label="books"><BooksPage /></ErrorBoundary>} />
              <Route path="/comics/*" element={<ErrorBoundary label="comics"><ComicsPage /></ErrorBoundary>} />
              <Route path="/games/*"  element={<ErrorBoundary label="games"><GamesPage /></ErrorBoundary>} />

              <Route path="/channels" element={<ErrorBoundary label="channels"><ChannelsPage /></ErrorBoundary>} />
              <Route path="/acquisitions" element={<ErrorBoundary label="acquisitions"><AcquisitionsPage /></ErrorBoundary>} />
              <Route path="/settings" element={<ErrorBoundary label="settings"><SettingsPage /></ErrorBoundary>} />
              <Route path="/system"   element={<ErrorBoundary label="system"><SettingsPage /></ErrorBoundary>} />
            </Routes>
          </div>
        </main>
        </>
        )}
      </div>

      {showKonami && <Arcade onClose={() => setShowKonami(false)} />}
      <NotificationHost />
    </BrowserRouter>
  )
}
