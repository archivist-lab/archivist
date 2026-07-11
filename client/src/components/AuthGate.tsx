import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useState } from 'react'

type AuthState = 'loading' | 'authenticated' | 'login' | 'setup' | 'offline'

type AuthStatus = {
  authenticated: boolean
  bootstrapRequired: boolean
  setupRequired: boolean
  username: string | null
}

type AuthContextValue = {
  username: string | null
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used within AuthGate')
  return value
}

function messageFrom(response: Response, fallback: string): Promise<string> {
  return response.json()
    .then((body: { error?: string }) => body.error ?? fallback)
    .catch(() => fallback)
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>('loading')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [currentUsername, setCurrentUsername] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const applyStatus = (status: AuthStatus) => {
    if (status.setupRequired) {
      setState('setup')
      return
    }
    if (status.authenticated) {
      setCurrentUsername(status.username)
      setState('authenticated')
      return
    }
    if (status.bootstrapRequired) {
      setUsername('archivist')
      setPassword('archivist')
    } else {
      setUsername('')
      setPassword('')
    }
    setCurrentUsername(null)
    setState('login')
  }

  const check = async () => {
    setState('loading')
    setError('')
    try {
      const response = await fetch('/api/v1/auth/status', {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('Backend unavailable')
      applyStatus(await response.json() as AuthStatus)
    } catch {
      setState('offline')
    }
  }

  useEffect(() => { void check() }, [])

  const login = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) throw new Error(await messageFrom(response, 'Sign in failed'))
      const result = await response.json() as { setupRequired: boolean; username: string | null }
      setPassword('')
      if (result.setupRequired) {
        setNewUsername('')
        setNewPassword('')
        setConfirmPassword('')
        setState('setup')
      } else {
        setCurrentUsername(result.username)
        setState('authenticated')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setSubmitting(false)
    }
  }

  const setup = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch('/api/v1/auth/setup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername, password: newPassword }),
      })
      if (!response.ok) throw new Error(await messageFrom(response, 'Account setup failed'))
      const result = await response.json() as { username: string }
      setNewPassword('')
      setConfirmPassword('')
      setCurrentUsername(result.username)
      setState('authenticated')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Account setup failed')
    } finally {
      setSubmitting(false)
    }
  }

  const logout = async () => {
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } finally {
      setCurrentUsername(null)
      await check()
    }
  }

  if (state === 'authenticated') {
    return <AuthContext.Provider value={{ username: currentUsername, logout }}>{children}</AuthContext.Provider>
  }

  return (
    <div className="min-h-screen bg-noir-950 text-white flex items-center justify-center p-6">
      {state === 'loading' ? (
        <div className="h-8 w-8 border-2 border-white/15 border-t-white/80 rounded-full animate-spin" aria-label="Loading" />
      ) : state === 'offline' ? (
        <div className="w-full max-w-sm border border-white/10 bg-noir-900 p-6 rounded-lg">
          <h1 className="text-xl font-semibold">Archivist unavailable</h1>
          <button className="mt-5 w-full bg-white text-black px-4 py-2 rounded font-medium" onClick={() => void check()}>
            Retry
          </button>
        </div>
      ) : state === 'setup' ? (
        <form className="w-full max-w-sm border border-white/10 bg-noir-900 p-6 rounded-lg" onSubmit={setup}>
          <h1 className="text-2xl font-semibold">Create administrator account</h1>
          <label className="block mt-6 text-sm text-white/70" htmlFor="archivist-new-username">Username</label>
          <input
            id="archivist-new-username"
            type="text"
            autoComplete="username"
            autoFocus
            value={newUsername}
            onChange={event => setNewUsername(event.target.value)}
            className="mt-2 w-full bg-black/30 border border-white/15 rounded px-3 py-2 outline-none focus:border-white/50"
          />
          <label className="block mt-4 text-sm text-white/70" htmlFor="archivist-new-password">Password</label>
          <input
            id="archivist-new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={event => setNewPassword(event.target.value)}
            className="mt-2 w-full bg-black/30 border border-white/15 rounded px-3 py-2 outline-none focus:border-white/50"
          />
          <label className="block mt-4 text-sm text-white/70" htmlFor="archivist-confirm-password">Confirm password</label>
          <input
            id="archivist-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={event => setConfirmPassword(event.target.value)}
            className="mt-2 w-full bg-black/30 border border-white/15 rounded px-3 py-2 outline-none focus:border-white/50"
          />
          {error && <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>}
          <button
            type="submit"
            disabled={submitting || !newUsername || !newPassword || !confirmPassword}
            className="mt-5 w-full bg-white text-black px-4 py-2 rounded font-medium disabled:opacity-40"
          >
            {submitting ? 'Creating account...' : 'Create account'}
          </button>
        </form>
      ) : (
        <form className="w-full max-w-sm border border-white/10 bg-noir-900 p-6 rounded-lg" onSubmit={login}>
          <h1 className="text-2xl font-semibold">Archivist</h1>
          <label className="block mt-6 text-sm text-white/70" htmlFor="archivist-username">Username</label>
          <input
            id="archivist-username"
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={event => setUsername(event.target.value)}
            className="mt-2 w-full bg-black/30 border border-white/15 rounded px-3 py-2 outline-none focus:border-white/50"
          />
          <label className="block mt-4 text-sm text-white/70" htmlFor="archivist-password">Password</label>
          <input
            id="archivist-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            className="mt-2 w-full bg-black/30 border border-white/15 rounded px-3 py-2 outline-none focus:border-white/50"
          />
          {error && <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>}
          <button
            type="submit"
            disabled={submitting || !username || !password}
            className="mt-5 w-full bg-white text-black px-4 py-2 rounded font-medium disabled:opacity-40"
          >
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      )}
    </div>
  )
}
