import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: here,
  // Served by WebViewAssetLoader at https://appassets.androidplatform.net/assets/setup/.
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../app/src/main/assets/setup', import.meta.url)),
    emptyOutDir: true,
    // Old Fire TV sticks ship an old WebView; module scripts need Chrome 61.
    target: 'chrome61',
    cssTarget: 'chrome61',
  },
  server: { port: 4343, host: true },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
