import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Served at /catalogue/ behind the single-port gateway.
  base: '/catalogue/',
  plugins: [react()],
  server: { port: 2428, host: true, proxy: { '/api': { target: 'http://localhost:2424', changeOrigin: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
})
