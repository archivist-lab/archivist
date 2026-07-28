import { useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, } from 'react-router-dom'
import { Sidebar } from './components/Sidebar.js'
import { Dashboard } from './modules/home/Dashboard.js'
import { Spinner } from './components/ui.js'
import Icon from './icon.svg'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { SetupWizard } from './components/SetupWizard.js'
import { NotificationHost } from './lib/notify.js'
import { useTabs } from './lib/tab-context.js'

// Route-level code splitting. Only the shell + Dashboard are in the entry chunk;
// every section is fetched on first visit. Named exports are re-mapped to
// `default` for React.lazy.
const FilmsPage        = lazy(() => import('./modules/films/index.js').then(m => ({ default: m.FilmsPage })))
const SeriesPage       = lazy(() => import('./modules/series/index.js').then(m => ({ default: m.SeriesPage })))
const MusicPage        = lazy(() => import('./modules/music/index.js').then(m => ({ default: m.MusicPage })))
const BooksPage        = lazy(() => import('./modules/books/index.js').then(m => ({ default: m.BooksPage })))
const ComicsPage       = lazy(() => import('./modules/comics/index.js').then(m => ({ default: m.ComicsPage })))
const GamesPage        = lazy(() => import('./modules/games/index.js').then(m => ({ default: m.GamesPage })))
const SettingsPage     = lazy(() => import('./modules/settings/index.js').then(m => ({ default: m.SettingsPage })))
const AcquisitionsPage = lazy(() => import('./modules/acquisitions/index.js').then(m => ({ default: m.AcquisitionsPage })))
const ChannelsPage     = lazy(() => import('./modules/channels/index.js').then(m => ({ default: m.ChannelsPage })))

function RouteFallback() {
  return (
    <div className="flex items-center justify-center py-24">
      <Spinner className="w-8 h-8" color="text-white/20" />
    </div>
  )
}

export default function App() {
  const { onboardingCompleted } = useTabs()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
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
            <Suspense fallback={<RouteFallback />}>
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
            </Suspense>
          </div>
        </main>
        </>
        )}
      </div>

      <NotificationHost />
    </BrowserRouter>
  )
}
