import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { getDb } from '../db.js'

export const SESSION_COOKIE = 'archivist_session'
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
export const BOOTSTRAP_USERNAME = 'archivist'
export const BOOTSTRAP_PASSWORD = 'archivist'

const PASSWORD_MIN_LENGTH = 6
const PASSWORD_MAX_LENGTH = 128
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/

type SessionRow = {
  session_type: 'bootstrap' | 'user'
  user_id: number | null
  username: string | null
  expires_at: number
}

export type AuthPrincipal =
  | { kind: 'service' }
  | { kind: 'bootstrap' }
  | { kind: 'user'; userId: number; username: string }

export type CredentialResult =
  | { kind: 'bootstrap' }
  | { kind: 'user'; userId: number; username: string }
  | null

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function cookieValue(req: Request, name: string): string {
  const header = req.header('cookie') ?? ''
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key !== name) continue
    try { return decodeURIComponent(value.join('=')) } catch { return '' }
  }
  return ''
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('base64url')
  const derived = scryptSync(password, salt, 64).toString('base64url')
  return `scrypt$${salt}$${derived}`
}

function passwordMatches(password: string, encoded: string): boolean {
  const [algorithm, salt, expected] = encoded.split('$')
  if (algorithm !== 'scrypt' || !salt || !expected) return false
  try {
    const actual = scryptSync(password, salt, 64)
    const expectedBytes = Buffer.from(expected, 'base64url')
    return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes)
  } catch {
    return false
  }
}

export function hasAuthUsers(): boolean {
  const row = getDb().prepare('SELECT 1 AS found FROM auth_users LIMIT 1').get() as { found: number } | undefined
  return row !== undefined
}

function browserPrincipal(req: Request): AuthPrincipal | null {
  const token = cookieValue(req, SESSION_COOKIE)
  if (!token) return null

  const db = getDb()
  const hash = tokenHash(token)
  const row = db.prepare(`
    SELECT s.session_type, s.user_id, s.expires_at, u.username
    FROM auth_sessions s
    LEFT JOIN auth_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(hash) as SessionRow | undefined

  if (!row) return null
  if (row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash)
    return null
  }
  if (row.session_type === 'bootstrap') {
    if (hasAuthUsers()) {
      db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash)
      return null
    }
    return { kind: 'bootstrap' }
  }
  if (!row.user_id || !row.username) return null
  return { kind: 'user', userId: row.user_id, username: row.username }
}

export function getAuthPrincipal(req: Request, apiKey: string): AuthPrincipal | null {
  if (apiKey) {
    const auth = req.header('authorization') ?? ''
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
    const headerKey = req.header('x-api-key') ?? ''
    const queryKey = req.path.startsWith('/player/stream/') && typeof req.query.apiKey === 'string'
      ? req.query.apiKey
      : ''

    if ((bearer && safeEqual(bearer, apiKey))
      || (headerKey && safeEqual(headerKey, apiKey))
      || (queryKey && safeEqual(queryKey, apiKey))) {
      return { kind: 'service' }
    }
  }
  return browserPrincipal(req)
}

export function isApiRequestAuthenticated(req: Request, apiKey: string): boolean {
  const principal = getAuthPrincipal(req, apiKey)
  return principal?.kind === 'service' || principal?.kind === 'user'
}

export function authenticateCredentials(username: string, password: string): CredentialResult {
  const normalized = username.trim()
  if (!hasAuthUsers()) {
    return safeEqual(normalized, BOOTSTRAP_USERNAME) && safeEqual(password, BOOTSTRAP_PASSWORD)
      ? { kind: 'bootstrap' }
      : null
  }

  const row = getDb().prepare(`
    SELECT id, username, password_hash
    FROM auth_users
    WHERE username = ? COLLATE NOCASE
    LIMIT 1
  `).get(normalized) as { id: number; username: string; password_hash: string } | undefined
  if (!row || !passwordMatches(password, row.password_hash)) return null
  return { kind: 'user', userId: row.id, username: row.username }
}

export function createBrowserSession(kind: 'bootstrap' | 'user', userId?: number): string {
  const db = getDb()
  const now = Date.now()
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now)

  const token = randomBytes(32).toString('base64url')
  db.prepare(`
    INSERT INTO auth_sessions (token_hash, session_type, user_id, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(tokenHash(token), kind, kind === 'user' ? userId : null, now + SESSION_MAX_AGE_SECONDS * 1000)
  return token
}

export function destroyBrowserSession(req: Request): void {
  const token = cookieValue(req, SESSION_COOKIE)
  if (token) getDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash(token))
}

export function validateAccount(username: unknown, password: unknown): { username: string; password: string } {
  const normalized = typeof username === 'string' ? username.trim() : ''
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new Error('Username must be 3-64 characters and use only letters, numbers, dots, hyphens, or underscores')
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`)
  }
  return { username: normalized, password }
}

export function completeBootstrapAccount(username: unknown, password: unknown): { userId: number; username: string } {
  const account = validateAccount(username, password)
  const encoded = passwordHash(account.password)
  const db = getDb()

  return db.transaction(() => {
    if (hasAuthUsers()) throw new Error('Administrator account already configured')
    const result = db.prepare(`
      INSERT INTO auth_users (username, password_hash) VALUES (?, ?)
    `).run(account.username, encoded)
    db.prepare('DELETE FROM auth_sessions').run()
    return { userId: Number(result.lastInsertRowid), username: account.username }
  })()
}

export function apiAuthMiddleware(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && req.path === '/health') return next()
    const principal = getAuthPrincipal(req, apiKey)
    if (principal?.kind === 'service' || principal?.kind === 'user') return next()
    if (principal?.kind === 'bootstrap') {
      res.status(403).json({ error: 'Account setup required', code: 'SETUP_REQUIRED' })
      return
    }
    res.status(401).json({ error: 'Unauthorized' })
  }
}
