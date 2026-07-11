import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
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
