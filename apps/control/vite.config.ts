import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/ui',
  plugins: [react()],
  server: { proxy: { '/api': { target: 'http://127.0.0.1:2429', changeOrigin: true } } },
  build: { outDir: '../../dist/public', emptyOutDir: true },
})
