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
import { Modal } from './components/ui.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'

export default function App() {
  const [collapsed, setCollapsed] = useState(false)
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

        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
        {/* Sidebar is fixed (out of flow), so main just offsets by its width via
            margin — no flex-1, which would force full-viewport width and overflow. */}
        <main className={`transition-all duration-300 min-h-screen ${collapsed ? 'ml-16' : 'ml-14 lg:ml-52'}`}>
          <div className="p-4 lg:p-6 w-full min-w-0 overflow-x-clip">
            <Routes>
              <Route path="/" element={<Dashboard />} />

              <Route path="/films/*"  element={<ErrorBoundary label="films"><FilmsPage /></ErrorBoundary>} />
              <Route path="/series/*" element={<ErrorBoundary label="series"><SeriesPage /></ErrorBoundary>} />
              <Route path="/music/*"  element={<ErrorBoundary label="music"><MusicPage /></ErrorBoundary>} />
              <Route path="/books/*"  element={<ErrorBoundary label="books"><BooksPage /></ErrorBoundary>} />
              <Route path="/comics/*" element={<ErrorBoundary label="comics"><ComicsPage /></ErrorBoundary>} />
              <Route path="/games/*"  element={<ErrorBoundary label="games"><GamesPage /></ErrorBoundary>} />

              <Route path="/acquisitions" element={<ErrorBoundary label="acquisitions"><AcquisitionsPage /></ErrorBoundary>} />
              <Route path="/settings" element={<ErrorBoundary label="settings"><SettingsPage /></ErrorBoundary>} />
              <Route path="/system"   element={<ErrorBoundary label="system"><SettingsPage /></ErrorBoundary>} />
            </Routes>
          </div>
        </main>
      </div>

      {showKonami && (
        <Modal title="SECRET DETECTED" onClose={() => setShowKonami(false)}>
          <div className="flex flex-col items-center justify-center py-8 text-center space-y-6">
            <div className="text-5xl animate-bounce">🕹️</div>
            <div className="space-y-2">
              <p className="text-xl font-display tracking-tight text-white">you retro nerd...</p>
              <p className="text-sm text-white/40 font-mono">this feature is coming soon</p>
            </div>
            <button 
              onClick={() => setShowKonami(false)}
              className="px-8 py-3 rounded-2xl bg-[#00D4FF] text-noir-950 font-bold tracking-widest text-[10px] uppercase shadow-[0_0_30px_rgba(0,212,255,0.4)] hover:scale-105 active:scale-95 transition-all"
            >
              Back to Reality
            </button>
          </div>
        </Modal>
      )}
    </BrowserRouter>
  )
}
