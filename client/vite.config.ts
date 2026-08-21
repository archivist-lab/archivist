import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // The Library app is served at /library/ behind the single-port gateway. API
  // calls stay absolute (/api/v1), so only static assets carry the prefix.
  base: '/library/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:7878',
        changeOrigin: true,
      },
      '/media': {
        target: 'http://localhost:7878',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  }
})
