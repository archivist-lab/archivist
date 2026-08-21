import 'dotenv/config'
import { join } from 'node:path'
import { createLogger } from '@archivist/core'
import { closeAllDatabases } from '@archivist/db'
import { loadConfig } from './config.js'
import { createApp } from './app.js'
import { createGateway } from './gateway.js'
import { registerRuntimeProcess } from './system/process-registry.js'

process.env.ARCHIVIST_PROCESS_ROLE ??= 'api'

const logger = createLogger('Server')

async function main() {
  const config = loadConfig()
  // The gateway owns every static surface, so the Express app serves only the
  // API, /media and /ping — no SPA mount at its root.
  const { app, stop } = await createApp({
    config,
    envPath: join(process.cwd(), '.env'),
  })
  const registration = registerRuntimeProcess('api', { ports: [config.server.port] })

  // One listener, three prefixes: /library, /player, /catalogue. See
  // gateway.ts for the routing table and what collapsing the ports gives up.
  const server = createGateway(app, {
    libraryDir: process.env.ARCHIVIST_SPA_DIR ?? join(process.cwd(), 'client', 'dist'),
    playerDir: process.env.ARCHIVIST_PLAYER_DIR ?? join(process.cwd(), 'apps', 'player', 'dist'),
    catalogueDir: process.env.ARCHIVIST_CATALOGUE_DIR ?? join(process.cwd(), 'apps', 'catalogue', 'dist'),
    emulatorDir: process.env.ARCHIVIST_EJS_DIR,
    catalogueEnabled: process.env.ARCHIVIST_CATALOGUE_ENABLED !== 'false',
  })

  server.listen(config.server.port, config.server.host, () => {
    const origin = `http://${config.server.host}:${config.server.port}`
    logger.info(`Archivist running at ${origin}`)
    logger.info(`  Library ${origin}/library/ · Player ${origin}/player/ · Catalogue ${origin}/catalogue/`)
    process.send?.({ type: 'ready', role: 'api' })
  })

  let shuttingDown = false
  const shutdown = async (signal: string, code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`${signal} received — shutting down...`)
    server.close()
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
