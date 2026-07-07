import 'dotenv/config'
import { join } from 'node:path'
import { createLogger } from '@archivist/core'
import { closeAllDatabases } from '@archivist/db'
import { loadConfig } from './config.js'
import { createApp } from './app.js'

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

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down...`)
    server.close()
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
