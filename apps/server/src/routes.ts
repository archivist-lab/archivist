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

  const { createDiagRouter } = await import('./shared/diag.js')
  api.use(createDiagRouter())

  // Media domains
  const { createFilmsRouter } = await import('./domains/films/routes.js')
  api.use(createFilmsRouter())
  const { createSeriesRouter } = await import('./domains/series/routes.js')
  api.use(createSeriesRouter())
  const { createMusicRouter } = await import('./domains/music/routes.js')
  api.use(createMusicRouter())
  const { createBooksRouter } = await import('./domains/books/routes.js')
  api.use(createBooksRouter())
  const { createComicsRouter } = await import('./domains/comics/routes.js')
  api.use(createComicsRouter())
  const { createGamesRouter } = await import('./domains/games/routes.js')
  api.use(createGamesRouter())
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

  registerMediaImportJobs()
  registerMaintenanceJobs()
  registerBackupJobs()
  registerIntegrityJobs()
  startDownloadMonitor()
  startReleaseOrchestrator()
  startMissingSearchScheduler()
  startMaintenanceScheduler()
  startBackupScheduler()
  startIntegrityScheduler()

  return async () => {
    stopDownloadMonitor()
    stopReleaseOrchestrator()
    stopMissingSearchScheduler()
    stopMaintenanceScheduler()
    stopBackupScheduler()
    stopIntegrityScheduler()
  }
}
