import 'dotenv/config'
import { createLogger } from '@archivist/core'
import { closeAllDatabases } from '@archivist/db'
import { loadConfig } from './config.js'
import { createWorkerRuntime } from './worker-runtime.js'

process.env.ARCHIVIST_PROCESS_ROLE ??= 'worker'

const logger = createLogger('Worker')

async function main() {
  const runtime = await createWorkerRuntime(loadConfig())
  logger.info(`Archivist background worker running as ${runtime.instanceId}`)

  let shuttingDown = false
  const shutdown = async (signal: string, code = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`${signal} received — draining background work...`)
    try { await runtime.stop() } catch (err) { logger.error('Worker shutdown error:', err) }
    try { closeAllDatabases() } catch (err) { logger.error('Database close error:', err) }
    process.exit(code)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('unhandledRejection', reason => {
    logger.error('Unhandled worker rejection:', reason instanceof Error ? reason.stack ?? reason.message : String(reason))
  })
  process.on('uncaughtException', err => {
    logger.error('Uncaught worker exception:', err.stack ?? err.message)
    void shutdown('uncaughtException', 1)
  })
}

main().catch(err => {
  logger.error('Fatal worker startup error:', err)
  process.exit(1)
})
