import { useState, type FormEvent } from 'react'

export interface ArchivistLoginPageProps {
  product: 'CATALOGUE' | 'SERVER' | 'PLAYER'
  topline: string
  onSubmit: (credentials: { username: string; password: string }) => void | Promise<void>
  initialUsername?: string
  initialPassword?: string
  description?: string
}

export function ArchivistLoginPage({
  product,
  topline,
  onSubmit,
  initialUsername = '',
  initialPassword = '',
  description = 'Sign in with your Archivist administrator account.',
}: ArchivistLoginPageProps) {
  const [username, setUsername] = useState(initialUsername)
  const [password, setPassword] = useState(initialPassword)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await onSubmit({ username, password })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign in failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="archivist-login-page">
      <form className="archivist-login-card" onSubmit={submit}>
        <span className="archivist-login-topline">{topline}</span>
        <h1>ARCHIVIST</h1>
        <h2>{product}</h2>
        <p>{description}</p>
        <input
          name="username"
          aria-label="Username"
          placeholder="Username"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={event => setUsername(event.target.value)}
        />
        <input
          name="password"
          aria-label="Password"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={event => setPassword(event.target.value)}
        />
        <button type="submit" disabled={submitting || !username || !password}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <div className="archivist-login-error" role="alert">{error}</div>}
      </form>
    </main>
  )
}
