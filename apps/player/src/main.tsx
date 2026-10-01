import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.js'
import './index.css'
import './styles/tokens.css'
import './styles/fonts.css'
import './styles/motion.css'
import { onAndroidTelevision } from './lib/android.js'

// Marks the television app, whose WebView may call its remote a touch
// pointer: the menu keeps its television scale there (tokens.css).
if (onAndroidTelevision()) document.documentElement.dataset.tv = 'true'

// A streaming stick's GPU gets the flat equivalents of the heaviest effects
// (see "lite paint" in combined.css). `?perf=full` or `?perf=lite` overrides it,
// and is remembered, for comparing the two on the same screen.
try {
  const requested = new URLSearchParams(location.search).get('perf')
  if (requested === 'lite' || requested === 'full') localStorage.setItem('archivist-player-perf', requested)
  const chosen = localStorage.getItem('archivist-player-perf')
  if (chosen === 'lite' || (chosen !== 'full' && onAndroidTelevision())) document.documentElement.dataset.perf = 'lite'
} catch { if (onAndroidTelevision()) document.documentElement.dataset.perf = 'lite' }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
