import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.js'
import { TabProvider } from './lib/tab-context.js'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TabProvider>
      <App />
    </TabProvider>
  </StrictMode>
)
