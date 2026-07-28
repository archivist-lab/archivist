import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/bebas-neue/latin-400.css'
import '@fontsource-variable/dm-sans/wght.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import './index.css'
import App from './App.js'
import { TabProvider } from './lib/tab-context.js'
import { AuthGate } from './components/AuthGate.js'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <TabProvider>
        <App />
      </TabProvider>
    </AuthGate>
  </StrictMode>
)
