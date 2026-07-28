import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.js'
import '@fontsource/bebas-neue/latin-400.css'
import '@fontsource-variable/dm-sans/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import './index.css'
import './styles/tokens.css'
import './styles/motion.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
