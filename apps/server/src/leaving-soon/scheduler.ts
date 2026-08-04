import { createLogger } from '@archivist/core'
import { getSweepSettings, sweepLeavingSoon } from './service.js'

const logger = createLogger('LeavingSoon')
let timer: ReturnType<typeof setTimeout> | null = null

export function startLeavingSoonScheduler(intervalMs?: number): void {
  if (timer) return
  const run = () => {
    try {
      const result = sweepLeavingSoon()
      if (result.deleted || result.failed) logger.info('Leaving Soon sweep completed', result)
    } catch (error) {
      logger.error('Leaving Soon sweep failed:', error instanceof Error ? error.message : String(error))
    }
    const delay = intervalMs ?? getSweepSettings().cleanupIntervalHours * 60 * 60 * 1000
    timer = setTimeout(run, delay)
    timer.unref?.()
  }
  timer = setTimeout(run, 0)
  timer.unref?.()
}

export function stopLeavingSoonScheduler(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
