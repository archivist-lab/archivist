import type { Router } from 'express'
import type { AppConfig } from './config.js'

export interface RouteContext {
  config: AppConfig
  skipBackground: boolean
}

/**
 * Central registry for domain and platform routers. Modules are appended here
 * as their vertical slices land, keeping app.ts stable.
 */
export async function registerRoutes(api: Router, ctx: RouteContext): Promise<void> {
  void ctx

  // Platform surfaces
  const { createIndexersRouter } = await import('./indexers/routes.js')
  api.use('/indexers', createIndexersRouter())

  const { createSystemAdminRouter } = await import('./system/admin-routes.js')
  api.use('/system', createSystemAdminRouter())

  const { createReleasePipelineRouter } = await import('./release-pipeline/routes.js')
  api.use('/release-pipeline', createReleasePipelineRouter())

  const { createTorrentsRouter } = await import('./torrents/routes.js')
  api.use(createTorrentsRouter())

  const { createDashboardRouter } = await import('./dashboard/routes.js')
  api.use(createDashboardRouter())

  const { createChannelsRouter } = await import('./channels/routes.js')
  api.use('/channels', createChannelsRouter())

  const { createDiagRouter } = await import('./shared/diag.js')
  api.use(createDiagRouter())

  const { createListImportsRouter } = await import('./list-imports/routes.js')
  api.use('/list-imports', createListImportsRouter())

  // Media domains
  const { createFilmsRouter } = await import('./modules/films/routes.js')
  api.use(createFilmsRouter())
  const { createSeriesRouter } = await import('./modules/series/routes.js')
  api.use(createSeriesRouter())
  const { createMusicRouter } = await import('./modules/music/routes.js')
  api.use(createMusicRouter())
  const { createBooksRouter } = await import('./modules/books/routes.js')
  api.use(createBooksRouter())
  const { createComicsRouter } = await import('./modules/comics/routes.js')
  api.use(createComicsRouter())
  const { createGamesRouter } = await import('./modules/games/routes.js')
  api.use(createGamesRouter())

  // Tools — Video Optimisation Engine (analysis + recommendations, Phase 1)
  const { createProcessingRouter } = await import('./tools/video-engine/routes.js')
  api.use(createProcessingRouter())
}

/** Registers job handlers and starts background schedulers/monitors. */
export async function startBackgroundServices(): Promise<() => Promise<void>> {
  const { registerMediaImportJobs } = await import('./services/media-imports.js')
  const { registerMaintenanceJobs, startMaintenanceScheduler, stopMaintenanceScheduler } = await import('./system/maintenance.js')
  const { registerBackupJobs, startBackupScheduler, stopBackupScheduler } = await import('./system/backups.js')
  const { registerIntegrityJobs, startIntegrityScheduler, stopIntegrityScheduler } = await import('./system/data-integrity.js')
  const { startDownloadMonitor, stopDownloadMonitor } = await import('./shared/monitor.js')
  const { startReleaseOrchestrator, stopReleaseOrchestrator } = await import('./release-pipeline/orchestrator.js')
  const { startMissingSearchScheduler, stopMissingSearchScheduler } = await import('./release-pipeline/missing-search.js')
  const { startNewReleaseSearchScheduler, stopNewReleaseSearchScheduler } = await import('./release-pipeline/new-release-search.js')
  const { registerSeriesMetadataJobs, startSeriesMetadataScheduler, stopSeriesMetadataScheduler } = await import('./modules/series/metadata-refresh.js')
  const { startChannelScheduler, stopChannelScheduler } = await import('./channels/automation.js')
  const { startExecutionEngine, stopExecutionEngine } = await import('./tools/video-engine/queue.js')
  const { sweepUnanalysedSeasons, shutdownSegments } = await import('./segments/queue.js')
  const { getSegmentSettings } = await import('./segments/settings.js')

  registerMediaImportJobs()
  registerSeriesMetadataJobs()
  registerMaintenanceJobs()
  registerBackupJobs()
  registerIntegrityJobs()
  startDownloadMonitor()
  startReleaseOrchestrator()
  startMissingSearchScheduler()
  startNewReleaseSearchScheduler()
  startSeriesMetadataScheduler()
  startChannelScheduler()
  startMaintenanceScheduler()
  startBackupScheduler()
  startIntegrityScheduler()
  startExecutionEngine()

  // Backfill loudness measurements for the existing library, once things have
  // settled. The queue self-throttles, and each item is skipped if measured.
  const { sweepUnmeasured } = await import('./player/loudness.js')
  const loudnessSweep = setTimeout(() => {
    try { sweepUnmeasured() } catch { /* best effort */ }
  }, 30_000)
  loudnessSweep.unref?.()

  // Segment detection is opt-in and separately throttled. It starts only
  // after normal boot activity has settled.
  const segmentSweep = setTimeout(() => {
    if (!getSegmentSettings().enabled) return
    try { sweepUnanalysedSeasons() } catch { /* best effort */ }
  }, 60_000)
  segmentSweep.unref?.()

  return async () => {
    clearTimeout(loudnessSweep)
    clearTimeout(segmentSweep)
    await shutdownSegments()
    stopDownloadMonitor()
    stopReleaseOrchestrator()
    stopMissingSearchScheduler()
    stopNewReleaseSearchScheduler()
    stopSeriesMetadataScheduler()
    stopChannelScheduler()
    stopMaintenanceScheduler()
    stopBackupScheduler()
    stopIntegrityScheduler()
    stopExecutionEngine()
  }
}
