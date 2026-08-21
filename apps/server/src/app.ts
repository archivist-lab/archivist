import express, { type Express } from 'express'
import { dirname, join, resolve } from 'node:path'
import { createLogger } from '@archivist/core'
import { loadConfig, type AppConfig } from './config.js'
import { initDb, getDb } from './db.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import { apiAuthMiddleware, authenticateCredentials, completeBootstrapAccount, createBrowserSession, createDeviceCredential, destroyBrowserSession, getAuthPrincipal, hasAuthUsers, listDeviceCredentials, revokeDeviceCredential, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from './middleware/auth.js'
import { libraryContextMiddleware } from './middleware/library-context.js'
import { rateLimit } from './middleware/rate-limit.js'
import { getSseBus } from './system/sse.js'
import { recordEvent } from './system/event-store.js'
import { createSystemRuntimeRouter } from './system/routes.js'
import { createPlayerRouter } from './player/routes.js'
import { createRatingsRouter } from './ratings/routes.js'
import { createSharedRouter, ensureDefaultLibraries } from './shared/routes.js'
import { closeCatalogueDb, initCatalogueDb } from './catalogue-database.js'
import { CatalogueFlowRunner } from './catalogue-runner.js'
import { createCatalogueRouter } from './catalogue-routes.js'
import { listRuntimeProcesses } from './system/process-registry.js'
import { startEventRelay } from './system/event-relay.js'
import { startActivityMonitor, stopActivityMonitor } from './system/activity-monitor.js'
import { getBackupHealth } from './system/backups.js'
import { indexerEndpointHealth } from './indexers/endpoints/routes.js'

const logger = createLogger('App')

export interface AppOptions {
  /** Pre-loaded config; defaults to loadConfig(). */
  config?: AppConfig
  /** Path of the .env file used for API-key persistence. */
  envPath?: string
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
  const catalogueDb = initCatalogueDb(
    process.env.ARCHIVIST_CATALOGUE_DB ?? join(dirname(resolve(config.database.path)), 'catalogue', 'catalogue.sqlite'),
  )
  const catalogueRunner = new CatalogueFlowRunner(catalogueDb, {
    execute: false,
    recover: false,
  })

  // ── Optional runtimes ───────────────────────────────────────────────────────
  const { initIndexerBridge } = await import('./services/indexer-bridge.js')
  try {
    await initIndexerBridge(getDb(), config.definitions.path)
  } catch (err) {
    logger.warn('Indexer bridge init failed (non-fatal):', err instanceof Error ? err.message : String(err))
  }

  if (config.downloads.embedded_engine) {
    const { initTorrentRpcClient } = await import('./services/torrent-session.js')
    initTorrentRpcClient()
  }

  // ── HTTP app ────────────────────────────────────────────────────────────────
  const app = express()
  app.use(requestIdMiddleware)
  app.disable('x-powered-by')
  // Rate limiting keys on req.ip. Behind a reverse proxy every request otherwise
  // carries the proxy's address, so the whole household shares one bucket and the
  // login limiter becomes a global lockout. Opt-in, because trusting
  // X-Forwarded-For when NOT behind a proxy lets a client spoof its own key.
  // Accepts any Express value: 'loopback', a subnet, a hop count, or 'true'.
  const trustProxy = process.env.TRUST_PROXY?.trim()
  if (trustProxy) {
    const numeric = Number(trustProxy)
    app.set('trust proxy', Number.isInteger(numeric) && String(numeric) === trustProxy
      ? numeric
      : trustProxy === 'true' ? true : trustProxy)
    logger.info(`Trusting proxy headers (TRUST_PROXY=${trustProxy})`)
  }
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    next()
  })
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/v1/player/ui/preferences')) {
      const length = Number(req.headers['content-length'] ?? 0)
      if (Number.isFinite(length) && length > 32 * 1024) {
        res.status(413).json({ error: { code: 'PLAYER_INPUT_TOO_LARGE', message: 'Player preference request exceeds 32 KiB', requestId: String(res.getHeader('X-Request-Id') ?? '') } })
        return
      }
    }
    next()
  })
  app.use(express.json({ limit: process.env.ARCHIVIST_JSON_LIMIT ?? '1mb' }))
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith('/api/v1/player') && (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large')) {
      const tooLarge = err.type === 'entity.too.large'
      res.status(tooLarge ? 413 : 400).json({ error: {
        code: tooLarge ? 'PLAYER_INPUT_TOO_LARGE' : 'PLAYER_INPUT_INVALID',
        message: tooLarge ? 'Player request body is too large' : 'Player request body must be valid JSON object data',
        requestId: String(res.getHeader('X-Request-Id') ?? ''),
      } })
      return
    }
    next(err)
  })
  app.use(express.urlencoded({ extended: true }))
  app.use(libraryContextMiddleware)

  // In production every surface is same-origin behind the gateway, so this
  // allowlist exists for the Vite dev servers only. PLAYER_ORIGINS is still
  // honoured for anyone who set it before the ports were collapsed, but it no
  // longer defaults to the retired player port.
  const allowedOrigins = new Set([
    ...(process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(','),
    ...(process.env.PLAYER_ORIGINS || '').split(','),
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
      authenticated: principal?.kind === 'service' || principal?.kind === 'user' || principal?.kind === 'device',
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

  api.post('/auth/devices', (req, res) => {
    const principal = getAuthPrincipal(req, config.auth.api_key)
    if (principal?.kind !== 'user') return res.status(403).json({ error: 'A user session is required to register a device' })
    const credential = createDeviceCredential(principal.userId, typeof req.body?.name === 'string' ? req.body.name : 'Kodi device')
    res.status(201).json(credential)
  })

  api.get('/auth/devices', (req, res) => {
    const principal = getAuthPrincipal(req, config.auth.api_key)
    if (principal?.kind !== 'user') return res.status(403).json({ error: 'A user session is required to manage devices' })
    res.json({ devices: listDeviceCredentials(principal.userId) })
  })

  api.delete('/auth/devices/:id', (req, res) => {
    const principal = getAuthPrincipal(req, config.auth.api_key)
    if (principal?.kind !== 'user') return res.status(403).json({ error: 'A user session is required to manage devices' })
    if (!revokeDeviceCredential(principal.userId, req.params.id)) return res.status(404).json({ error: 'Device not found' })
    res.status(204).send()
  })

  const searchLimit = rateLimit(30, 60_000)
  for (const path of ['/films/lookup', '/series/lookup', '/music/lookup', '/books/lookup', '/comics/lookup', '/games/lookup']) {
    api.use(path, searchLimit)
  }

  api.get('/health', (_req, res) => {
    const processes = listRuntimeProcesses()
    const workerHealthy = processes.some(process => process.role === 'worker' && process.healthy && process.metadata.state === 'ready')
    res.json({ status: workerHealthy ? 'ok' : 'degraded', version: '2.0.0', workerHealthy, backup: getBackupHealth() })
  })

  // Per-indexer reachability, for the dashboard widget and external monitoring
  // (spec §10.3).
  api.get('/health/indexers', (_req, res) => {
    res.json({ indexers: indexerEndpointHealth() })
  })

  api.get('/events', (_req, res) => {
    getSseBus().addClient(res)
  })

  api.use('/system', createSystemRuntimeRouter())
  api.use('/player', createPlayerRouter())
  api.use('/ratings', createRatingsRouter())
  api.use('/catalogue', createCatalogueRouter(catalogueDb, catalogueRunner))
  api.use('/', createSharedRouter(options.envPath))

  // Domain and platform routers are registered by registerRoutes so the
  // module list stays in one place.
  const { registerRoutes } = await import('./routes.js')
  await registerRoutes(api, config.media.base_dir)

  app.use('/api/v1', api)

  app.use('/api/v1', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  // Every web surface — admin, player and catalogue — is served by the HTTP
  // gateway (gateway.ts), which routes only /api/v1, /media and /ping here.
  // This app deliberately mounts no static SPA of its own.

  // Terminal error handler. Express 4 does not catch async rejections, so route
  // handlers still own their try/catch — this is the safety net for anything
  // thrown synchronously or passed to next(err). Never leak a stack to a client.
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const requestId = String(res.getHeader('X-Request-Id') ?? '')
    logger.error(`Unhandled error on ${req.method} ${req.path} [${requestId}]:`, err?.stack ?? err?.message ?? String(err))
    if (res.headersSent) return
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 ? err.status : 500
    res.status(status).json({ error: status === 500 ? 'Internal server error' : (err?.message ?? 'Request failed'), requestId })
  })

  const stopEventRelay = startEventRelay()
  // Runs here rather than in the worker: it emits to SSE clients, and those
  // connect to the API process. Without it `activity:state` is never sent and
  // every live surface silently falls back to its idle poll — a minute between
  // refreshes on the torrent list.
  startActivityMonitor()

  recordEvent({ category: 'system', action: 'startup', message: 'Archivist API process started', data: { role: 'api' } })

  const stop = async () => {
    const catalogueStopped = await catalogueRunner.stop()
    stopEventRelay()
    stopActivityMonitor()
    getSseBus().closeAll()
    if (catalogueStopped) closeCatalogueDb()
    else logger.warn('Catalogue database left open because a flow did not finish its shutdown grace period')
  }

  return { app, config, stop }
}
