import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Served at /player/ behind the single-port gateway. The arcade shell in
  // public/emu.html is copied verbatim and keeps its absolute /emulatorjs/
  // references, which the gateway serves at the root.
  base: '/player/',
  plugins: [react()],
  server: { port: 4242, host: true },
  preview: { port: 4242, host: true },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
  },
})
