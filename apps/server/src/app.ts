import express, { type Express } from 'express'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createLogger } from '@archivist/core'
import { loadConfig, type AppConfig } from './config.js'
import { initDb, getDb } from './db.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import { apiAuthMiddleware, authenticateCredentials, completeBootstrapAccount, createBrowserSession, destroyBrowserSession, getAuthPrincipal, hasAuthUsers, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from './middleware/auth.js'
import { libraryContextMiddleware } from './middleware/library-context.js'
import { rateLimit } from './middleware/rate-limit.js'
import { getSseBus } from './system/sse.js'
import { recordEvent } from './system/event-store.js'
import { startJobRunner, stopJobRunner } from './system/job-runner.js'
import { createSystemRuntimeRouter } from './system/routes.js'
import { createArcadeRouter } from './arcade/routes.js'
import { createPlayerRouter } from './player/routes.js'
import { createSharedRouter, ensureDefaultLibraries } from './shared/routes.js'

const logger = createLogger('App')

export interface AppOptions {
  /** Pre-loaded config; defaults to loadConfig(). */
  config?: AppConfig
  /** Path of the .env file used for API-key persistence. */
  envPath?: string
  /**
   * Skip background runtimes (torrent engine, schedulers, job runner).
   * Route surfaces stay fully mounted. Used by tests and by the legacy shell
   * in mixed mode where legacy background services still own those duties.
   */
  skipBackground?: boolean
  /**
   * Directory of a built SPA to serve at / (with index.html fallback for
   * client-side routes). Used by the standalone server; the legacy cutover
   * shell serves the SPA itself and leaves this unset.
   */
  spaDir?: string
}

export interface AppInstance {
  app: Express
  config: AppConfig
  stop: () => Promise<void>
}

/**
 * Builds the Archivist backend as an embeddable Express app. The standalone server
 * (server.ts) and the legacy cutover shell both mount this.
 */
export async function createApp(options: AppOptions = {}): Promise<AppInstance> {
  const config = options.config ?? loadConfig()

  initDb(config.database.path)
  ensureDefaultLibraries()

  // ── Optional runtimes ───────────────────────────────────────────────────────
  const { initIndexerBridge } = await import('./services/indexer-bridge.js')
  try {
    await initIndexerBridge(getDb(), config.definitions.path)
  } catch (err) {
    logger.warn('Indexer bridge init failed (non-fatal):', err instanceof Error ? err.message : String(err))
  }

  let torrentSessionStarted = false
  if (!options.skipBackground && config.downloads.embedded_engine) {
    try {
      const { initTorrentSession } = await import('./services/torrent-session.js')
      await initTorrentSession({
        downloadDir: config.downloads.download_dir,
        incompleteDir: config.downloads.incomplete_dir,
        resumeDir: config.downloads.resume_dir,
        torrentsDir: config.downloads.torrents_dir,
      })
      torrentSessionStarted = true
      logger.info('Built-in torrent engine started')
    } catch (err) {
      logger.error('Failed to start built-in torrent engine:', err instanceof Error ? err.message : String(err))
    }
  }

  // ── HTTP app ────────────────────────────────────────────────────────────────
  const app = express()
  app.use(requestIdMiddleware)
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    next()
  })
  app.use(express.json({ limit: process.env.ARCHIVIST_JSON_LIMIT ?? '1mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use(libraryContextMiddleware)

  const allowedOrigins = new Set([
    ...(process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(','),
    ...(process.env.PLAYER_ORIGINS || 'http://localhost:4242,http://127.0.0.1:4242').split(','),
  ].map(origin => origin.trim()).filter(origin => origin && origin !== '*'))
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key,X-Request-Id,X-Tab-Context')
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  })

  app.get('/ping', (_req, res) => {
    res.json({ status: 'ok' })
  })

  // Artwork and organized media share the media root. Protect the mount so
  // opaque Player stream routes cannot be bypassed by guessing a disk path.
  app.use('/media', apiAuthMiddleware(config.auth.api_key), express.static(resolve(config.media.base_dir)))

  // Self-hosted EmulatorJS assets (loader + WASM cores) for the arcade module.
  // Vendored into the image at build time; see Dockerfile.
  app.use('/emulatorjs', express.static(process.env.ARCHIVIST_EJS_DIR ?? join(process.cwd(), 'emulatorjs')))

  const api = express.Router()
  const sessionCookie = (token: string, req: express.Request, maxAge: number) => {
    const forwardedProto = req.header('x-forwarded-proto')?.split(',')[0]?.trim()
    const secure = req.secure || forwardedProto === 'https'
    return [
      SESSION_COOKIE + '=' + encodeURIComponent(token),
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=' + maxAge,
      ...(secure ? ['Secure'] : []),
    ].join('; ')
  }

  api.get('/auth/status', (req, res) => {
    const principal = getAuthPrincipal(req, config.auth.api_key)
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      required: true,
      authenticated: principal?.kind === 'service' || principal?.kind === 'user',
      bootstrapRequired: !hasAuthUsers(),
      setupRequired: principal?.kind === 'bootstrap',
      username: principal?.kind === 'user' ? principal.username : null,
    })
  })

  const loginLimit = rateLimit(10, 15 * 60_000)
  api.post('/auth/login', loginLimit, (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    const credential = authenticateCredentials(username, password)
    if (!credential) {
      res.status(401).json({ error: 'Invalid username or password' })
      return
    }

    const token = createBrowserSession(credential.kind, credential.kind === 'user' ? credential.userId : undefined)
    res.setHeader('Set-Cookie', sessionCookie(token, req, SESSION_MAX_AGE_SECONDS))
    res.json({
      setupRequired: credential.kind === 'bootstrap',
      username: credential.kind === 'user' ? credential.username : null,
    })
  })

  api.post('/auth/setup', loginLimit, (req, res) => {
    const principal = getAuthPrincipal(req, config.auth.api_key)
    if (principal?.kind !== 'bootstrap') {
      res.status(hasAuthUsers() ? 409 : 401).json({ error: hasAuthUsers() ? 'Administrator account already configured' : 'Bootstrap login required' })
      return
    }

    try {
      const account = completeBootstrapAccount(req.body?.username, req.body?.password)
      const token = createBrowserSession('user', account.userId)
      res.setHeader('Set-Cookie', sessionCookie(token, req, SESSION_MAX_AGE_SECONDS))
      res.status(201).json({ username: account.username })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Account setup failed'
      res.status(message === 'Administrator account already configured' ? 409 : 400).json({ error: message })
    }
  })

  api.post('/auth/logout', (req, res) => {
    destroyBrowserSession(req)
    res.setHeader('Set-Cookie', SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    res.status(204).send()
  })

  api.use(apiAuthMiddleware(config.auth.api_key))

  const writeLimit = rateLimit(60, 60_000)
  api.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return writeLimit(req, res, next)
    next()
  })

  const searchLimit = rateLimit(30, 60_000)
  for (const path of ['/films/lookup', '/series/lookup', '/music/lookup', '/books/lookup', '/comics/lookup', '/games/lookup']) {
    api.use(path, searchLimit)
  }

  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '2.0.0' })
  })

  api.get('/events', (_req, res) => {
    getSseBus().addClient(res)
  })

  api.use('/system', createSystemRuntimeRouter())
  api.use('/arcade', createArcadeRouter())
  api.use('/player', createPlayerRouter())
  api.use('/', createSharedRouter(options.envPath))

  // Domain and platform routers are registered by registerRoutes so the
  // module list stays in one place.
  const { registerRoutes } = await import('./routes.js')
  await registerRoutes(api, { config, skipBackground: options.skipBackground ?? false })

  app.use('/api/v1', api)

  app.use('/api/v1', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  if (options.spaDir && existsSync(options.spaDir)) {
    const spaDir = options.spaDir
    app.use(express.static(spaDir))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) return next()
      res.sendFile(join(spaDir, 'index.html'))
    })
    logger.info(`Serving SPA from ${spaDir}`)
  }

  let stopBackground: (() => Promise<void>) | null = null
  if (!options.skipBackground) {
    startJobRunner()
    const { startBackgroundServices } = await import('./routes.js')
    stopBackground = await startBackgroundServices()
  }

  recordEvent({ category: 'system', action: 'startup', message: 'Archivist backend started', data: { skipBackground: options.skipBackground ?? false } })

  const stop = async () => {
    stopJobRunner()
    if (stopBackground) {
      try { await stopBackground() } catch {}
    }
    getSseBus().closeAll()
    if (torrentSessionStarted) {
      try {
        const { stopTorrentSession } = await import('./services/torrent-session.js')
        await stopTorrentSession()
      } catch {}
    }
  }

  return { app, config, stop }
}
