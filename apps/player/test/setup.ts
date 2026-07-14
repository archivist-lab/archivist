import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
})
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value() { return new DOMRect(0, 0, 100, 44) },
})
if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 0)
if (!globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame = handle => clearTimeout(handle)

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.removeAttribute('data-input-modality')
})
