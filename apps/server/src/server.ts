import 'dotenv/config'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@archivist/core'
import { closeAllDatabases } from '@archivist/db'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { createPlayerFrontend } from './player-frontend.js'
import { createCatalogueSpaFrontend } from './catalogue-spa-frontend.js'
import { registerRuntimeProcess } from './system/process-registry.js'

process.env.ARCHIVIST_PROCESS_ROLE ??= 'api'

const logger = createLogger('Server')

async function main() {
  const config = loadConfig()
  const { app, stop } = await createApp({
    config,
    envPath: join(process.cwd(), '.env'),
    spaDir: process.env.ARCHIVIST_SPA_DIR ?? join(process.cwd(), 'client', 'dist'),
  })
  const registration = registerRuntimeProcess('api', { ports: [config.server.port, Number(process.env.PLAYER_PORT ?? 4242), Number(process.env.CATALOGUE_PORT ?? 2428)] })

  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info(`Archivist backend running at http://${config.server.host}:${config.server.port}`)
    process.send?.({ type: 'ready', role: 'api' })
  })

  // Player consumption UI on its own port, in the same process. Serves the
  // player SPA and delegates only browser auth, /api/v1/player and /media to
  // the main app (the rest of the admin API stays off this port). Disabled if
  // the build isn't present.
  const playerPort = Number(process.env.PLAYER_PORT ?? 4242)
  const playerDir = process.env.ARCHIVIST_PLAYER_DIR ?? join(process.cwd(), 'apps', 'player', 'dist')
  let playerServer: ReturnType<typeof createPlayerFrontend> | null = null
  if (existsSync(playerDir)) {
    playerServer = createPlayerFrontend(app, { distDir: playerDir })
    playerServer.listen(playerPort, config.server.host, () => {
      logger.info(`Archivist Player running at http://${config.server.host}:${playerPort}`)
    })
  } else {
    logger.warn(`Player build not found at ${playerDir} — player port ${playerPort} disabled`)
  }

  // Catalogue operations UI on its own port. It delegates only authentication
  // and /api/v1/catalogue to the main app while serving an independent control
  // plane for the embedded universal metadata catalogue.
  const cataloguePort = Number(process.env.CATALOGUE_PORT ?? 2428)
  const catalogueDir = process.env.ARCHIVIST_CATALOGUE_DIR ?? join(process.cwd(), 'apps', 'catalogue', 'dist')
  const catalogueServer = process.env.ARCHIVIST_CATALOGUE_ENABLED === 'false'
    ? null
    : createCatalogueSpaFrontend(app, { distDir: catalogueDir })
  catalogueServer?.listen(cataloguePort, config.server.host, () => {
    logger.info(`Archivist Catalogue running at http://${config.server.host}:${cataloguePort}`)
  })

  let shuttingDown = false
  const shutdown = async (signal: string, code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`${signal} received — shutting down...`)
    server.close()
    playerServer?.close()
    catalogueServer?.close()
    try { await stop() } catch (err) { logger.error('Shutdown error:', err) }
    registration.stop()
    try { closeAllDatabases() } catch (err) { logger.error('Database close error:', err) }
    process.exit(code)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // Archivist is an always-on self-hosted service: a single stray rejection must
  // not silently kill it. Log loudly and keep serving — only a genuinely broken
  // process state (uncaughtException) drains and exits non-zero so Docker restarts.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection (continuing):', reason instanceof Error ? reason.stack ?? reason.message : String(reason))
  })
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — shutting down:', err.stack ?? err.message)
    void shutdown('uncaughtException', 1)
  })
}

main().catch(err => {
  logger.error('Fatal startup error:', err)
  process.exit(1)
})
