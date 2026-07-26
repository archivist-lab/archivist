import 'dotenv/config'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@archivist/core'
import { closeAllDatabases } from '@archivist/db'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { createPlayerFrontend } from './player-frontend.js'

const logger = createLogger('Server')

async function main() {
  const config = loadConfig()
  const { app, stop } = await createApp({
    config,
    envPath: join(process.cwd(), '.env'),
    spaDir: process.env.ARCHIVIST_SPA_DIR ?? join(process.cwd(), 'client', 'dist'),
  })

  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info(`Archivist backend running at http://${config.server.host}:${config.server.port}`)
  })

  // Player consumption UI on its own port, in the same process. Serves the
  // player SPA and delegates only /api/v1/player + /media to the main app
  // (the admin API stays off this port). Disabled if the build isn't present.
  const playerPort = Number(process.env.PLAYER_PORT ?? 4242)
  const playerDir = process.env.ARCHIVIST_PLAYER_DIR ?? join(process.cwd(), 'apps', 'player', 'dist')
  let playerServer: ReturnType<typeof createPlayerFrontend> | null = null
  if (existsSync(playerDir)) {
    playerServer = createPlayerFrontend(app, { distDir: playerDir, serviceToken: config.auth.api_key })
    playerServer.listen(playerPort, config.server.host, () => {
      logger.info(`Archivist Player running at http://${config.server.host}:${playerPort}`)
    })
  } else {
    logger.warn(`Player build not found at ${playerDir} — player port ${playerPort} disabled`)
  }

  let shuttingDown = false
  const shutdown = async (signal: string, code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`${signal} received — shutting down...`)
    server.close()
    playerServer?.close()
    try { await stop() } catch (err) { logger.error('Shutdown error:', err) }
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
