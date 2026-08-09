import { dirname, join, resolve } from 'node:path'
import { createLogger } from '@archivist/core'
import type { AppConfig } from './config.js'
import { initDb, getDb } from './db.js'
import { closeCatalogueDb, initCatalogueDb } from './catalogue-database.js'
import { CatalogueFlowRunner } from './catalogue-runner.js'
import { ensureDefaultLibraries } from './shared/routes.js'
import { recoverExpiredJobs, recordEvent } from './system/event-store.js'
import { startJobRunner, stopJobRunner } from './system/job-runner.js'
import { acquireRuntimeLease, registerRuntimeProcess, releaseRuntimeLease, renewRuntimeLease } from './system/process-registry.js'

const logger = createLogger('WorkerRuntime')
const WORKER_LEASE = 'background-worker'
const WORKER_LEASE_TTL_MS = 20_000

export interface WorkerRuntime {
  instanceId: string
  stop: () => Promise<void>
}

export async function createWorkerRuntime(config: AppConfig): Promise<WorkerRuntime> {
  initDb(config.database.path)
  ensureDefaultLibraries()
  const workerMetadata: Record<string, unknown> = { state: 'starting', lanes: ['system', 'catalogue', 'media', 'automation'] }
  const registration = registerRuntimeProcess('worker', workerMetadata)
  if (!acquireRuntimeLease(WORKER_LEASE, registration.instanceId, WORKER_LEASE_TTL_MS)) {
    registration.stop()
    throw new Error('Another Archivist background worker holds the active worker lease')
  }

  const leaseTimer = setInterval(() => {
    try {
      if (!renewRuntimeLease(WORKER_LEASE, registration.instanceId, WORKER_LEASE_TTL_MS)) {
        logger.error('Background worker lease was lost; terminating so the supervisor can restart safely')
        process.kill(process.pid, 'SIGTERM')
      }
    } catch (err) {
      logger.error('Background worker lease renewal failed:', err instanceof Error ? err.message : String(err))
    }
  }, 5_000)
  leaseTimer.unref?.()
  const recoveryTimer = setInterval(() => {
    try {
      const recovered = recoverExpiredJobs()
      if (recovered > 0) logger.warn(`Recovered ${recovered} system job(s) with expired worker leases`)
    } catch (err) {
      logger.warn('Expired job recovery failed:', err instanceof Error ? err.message : String(err))
    }
  }, 30_000)
  recoveryTimer.unref?.()

  const catalogueDb = initCatalogueDb(
    process.env.ARCHIVIST_CATALOGUE_DB ?? join(dirname(resolve(config.database.path)), 'catalogue', 'catalogue.sqlite'),
  )
  const catalogueRunner = new CatalogueFlowRunner(catalogueDb, { execute: true, recover: true })

  const { initIndexerBridge } = await import('./services/indexer-bridge.js')
  await initIndexerBridge(getDb(), config.definitions.path)

  let torrentSessionStarted = false
  if (config.downloads.embedded_engine) {
    const { initTorrentSession } = await import('./services/torrent-session.js')
    await initTorrentSession({
      downloadDir: config.downloads.download_dir,
      incompleteDir: config.downloads.incomplete_dir,
      resumeDir: config.downloads.resume_dir,
      torrentsDir: config.downloads.torrents_dir,
    })
    torrentSessionStarted = true
  }

  const recovered = recoverExpiredJobs()
  if (recovered > 0) logger.warn(`Recovered ${recovered} system job(s) with expired worker leases`)

  const { startBackgroundServices } = await import('./routes.js')
  const stopBackground = await startBackgroundServices()
  startJobRunner()
  catalogueRunner.startScheduler()
  workerMetadata.state = 'ready'

  setImmediate(async () => {
    try {
      const { isCreditIndexEmpty, hasLibraryMedia, reindexAllCredits } = await import('./services/credit-index.js')
      if (isCreditIndexEmpty() && hasLibraryMedia()) {
        const counts = reindexAllCredits()
        createLogger('CreditIndex').info(`Backfilled credits for ${counts.films} films, ${counts.series} series`)
      }
    } catch (err) {
      createLogger('CreditIndex').warn('Credit backfill failed:', err instanceof Error ? err.message : String(err))
    }
  })

  recordEvent({
    category: 'system',
    action: 'worker-startup',
    message: 'Archivist background worker started',
    data: { instanceId: registration.instanceId },
  })

  let stopping = false
  return {
    instanceId: registration.instanceId,
    stop: async () => {
      if (stopping) return
      stopping = true
      workerMetadata.state = 'draining'
      clearInterval(leaseTimer)
      clearInterval(recoveryTimer)
      const catalogueStopped = await catalogueRunner.stop()
      await stopJobRunner(30_000)
      await stopBackground()
      if (torrentSessionStarted) {
        try {
          const { stopTorrentSession } = await import('./services/torrent-session.js')
          await stopTorrentSession()
        } catch {}
      }
      registration.stop()
      releaseRuntimeLease(WORKER_LEASE, registration.instanceId)
      if (catalogueStopped) closeCatalogueDb()
      else logger.warn('Catalogue database left open because an active flow exceeded the shutdown grace period')
    },
  }
}
