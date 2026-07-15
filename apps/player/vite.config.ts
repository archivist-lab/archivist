import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
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
