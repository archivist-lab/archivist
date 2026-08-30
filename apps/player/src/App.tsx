import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserRouter } from 'react-router-dom'
import type { PlayerBootstrap } from '@archivist/contracts'
import { ArchivistLoginPage } from '@archivist/design-system'
import { ArchivistSdk } from './lib/sdk.js'
import { hydrateProgress, playerStore } from './lib/store.js'
import { clearLegacySettingsAfterImport, migrateLegacySettings, readLegacySettings } from './lib/preferences.js'
import { PlayerShell } from './components/Shell.js'

/** Hidden retro arcade. Lazy so EmulatorJS never lands in the Player's entry chunk. */
const Arcade = lazy(() => import('./components/Arcade.js').then(m => ({ default: m.Arcade })))

/**
 * The Konami code, unchanged from the admin client it moved from.
 *
 * Note the Player binds these keys for navigation: arrows move focus and Enter
 * activates the focused element. The listener therefore only *observes* — it
 * never calls preventDefault — so completing the sequence opens the Arcade while
 * the underlying keypresses behave exactly as they normally would.
 */
const KONAMI_CODE = [
  'ArrowUp', 'ArrowUp',
  'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight',
  'ArrowLeft', 'ArrowRight',
  'b', 'a', 'Enter',
]

function useKonami(onUnlock: () => void): void {
  const buffer = useRef<string[]>([])
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      buffer.current.push(e.key)
      if (buffer.current.length > KONAMI_CODE.length) buffer.current.shift()
      if (buffer.current.join(',').toLowerCase() === KONAMI_CODE.join(',').toLowerCase()) {
        buffer.current = []
        onUnlock()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onUnlock])
}

/** One SDK instance per connection — pages get it via props. */
export default function App() {
  const sdk = useMemo(() => new ArchivistSdk({ url: '', apiKey: '' }), [])
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [bootstrap, setBootstrap] = useState<PlayerBootstrap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [arcadeOpen, setArcadeOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/v1/auth/status', { credentials: 'include', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Authentication service unavailable')
        const status = await response.json() as { authenticated: boolean; username: string | null }
        if (!controller.signal.aborted) {
          setAuthenticated(status.authenticated)
          setUsername(status.username)
        }
      })
      .catch(() => { if (!controller.signal.aborted) setAuthenticated(false) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!authenticated) return
    const controller = new AbortController()
    const started = performance.now()
    const profileId = localStorage.getItem('archivist-player-profile') || 'default'
    sdk.setProfile(profileId)
    void sdk.bootstrap(profileId, controller.signal).then(async initial => {
      let resolved = initial
      if (initial.featureFlags.uiV2Enabled && !initial.preferences.preferences.migration.legacyLocalStorageImported) {
        const migrated = migrateLegacySettings(readLegacySettings(), initial.preferences.preferences)
        if (migrated) {
          try {
            const envelope = await sdk.updatePreferences({ profileId, expectedRevision: initial.preferences.revision, preferences: migrated }, controller.signal)
            resolved = { ...initial, preferences: envelope }
            clearLegacySettingsAfterImport()
          } catch { /* preserve the legacy key and retry on a later start */ }
        }
      }
      if (controller.signal.aborted) return
      hydrateProgress(resolved.progress)
      playerStore.dispatch({ type: 'BOOTSTRAP_SUCCEEDED', bootstrap: resolved })
      setBootstrap(resolved)
      setError(null)
      if (resolved.featureFlags.telemetryEnabled) void sdk.telemetry({ sessionId: crypto.randomUUID(), samples: [{ name: 'player_bootstrap_ms', valueMs: performance.now() - started, at: Date.now() }] })
    }).catch(reason => {
      if (controller.signal.aborted) return
      const message = reason instanceof Error ? reason.message : String(reason)
      if (typeof reason === 'object' && reason !== null && 'status' in reason && reason.status === 401) {
        setAuthenticated(false)
        setBootstrap(null)
        return
      }
      playerStore.dispatch({ type: 'BOOTSTRAP_FAILED', message })
      setError(message)
    })
    return () => controller.abort()
  }, [sdk, attempt, authenticated])

  useKonami(() => setArcadeOpen(true))

  const login = async (credentials: { username: string; password: string }) => {
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(body.error ?? 'Sign in failed')
    }
    const result = await response.json() as { setupRequired?: boolean; username?: string | null }
    if (result.setupRequired) throw new Error('Complete administrator setup in Archivist Server before using Player')
    setError(null)
    setUsername(result.username ?? credentials.username)
    setAuthenticated(true)
  }

  const logout = async () => {
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } finally {
      setBootstrap(null)
      setUsername(null)
      setAuthenticated(false)
    }
  }

  // Served under /player/ by the gateway; Vite's base supplies the prefix.
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      {authenticated === false ? (
        <ArchivistLoginPage product="PLAYER" topline="Immersive playback for your personal archive" onSubmit={login} />
      ) : authenticated === null || (!bootstrap && !error) ? (
        <div className="player-v2 grid min-h-screen place-items-center"><div className="text-sm font-mono uppercase tracking-[.3em] text-white/35 player-skeleton">Opening the archive</div></div>
      ) : !bootstrap && error ? (
        <div className="player-v2 grid min-h-screen place-items-center text-center"><div><h1 className="text-2xl font-semibold">Player unavailable</h1><p className="mt-2 max-w-md text-white/45">{error}</p><button onClick={() => setAttempt(value => value + 1)} className="mt-6 rounded-full bg-white px-6 py-3 font-bold text-black">Retry</button></div></div>
      ) : bootstrap ? <PlayerShell sdk={sdk} bootstrap={bootstrap} username={username} onSignOut={logout} /> : null}
      {arcadeOpen && (
        <Suspense fallback={null}>
          <Arcade sdk={sdk} onClose={() => setArcadeOpen(false)} />
        </Suspense>
      )}
    </BrowserRouter>
  )
}
