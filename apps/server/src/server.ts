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

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down...`)
    server.close()
    playerServer?.close()
    await stop()
    closeAllDatabases()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch(err => {
  logger.error('Fatal startup error:', err)
  process.exit(1)
})
