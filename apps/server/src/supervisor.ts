import 'dotenv/config'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createLogger } from '@archivist/core'

const logger = createLogger('Supervisor')
const serverPath = fileURLToPath(new URL('./server.js', import.meta.url))
const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url))

let api: ChildProcess | null = null
let worker: ChildProcess | null = null
let stopping = false
let workerFailures = 0
let workerRestartTimer: ReturnType<typeof setTimeout> | null = null

function startApi(): void {
  api = spawn(process.execPath, [serverPath], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, ARCHIVIST_PROCESS_ROLE: 'api' },
  })
  api.once('message', message => {
    if (!stopping && worker == null && typeof message === 'object' && message != null && (message as { type?: string }).type === 'ready') {
      startWorker()
    }
  })
  api.once('exit', (code, signal) => {
    api = null
    if (stopping) return
    logger.error(`API process exited unexpectedly (${signal ?? code ?? 'unknown'}); stopping the runtime`)
    void shutdown('API exit', code ?? 1)
  })
}

function startWorker(): void {
  worker = spawn(process.execPath, [workerPath], { stdio: 'inherit', env: { ...process.env, ARCHIVIST_PROCESS_ROLE: 'worker' } })
  const startedAt = Date.now()
  worker.once('exit', (code, signal) => {
    worker = null
    if (stopping) return
    if (Date.now() - startedAt > 60_000) workerFailures = 0
    workerFailures += 1
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(workerFailures - 1, 5))
    logger.error(`Worker process exited (${signal ?? code ?? 'unknown'}); restarting in ${delayMs}ms`)
    workerRestartTimer = setTimeout(() => {
      workerRestartTimer = null
      if (!stopping) startWorker()
    }, delayMs)
  })
}

async function stopChild(child: ChildProcess | null, signal: NodeJS.Signals): Promise<void> {
  if (!child || child.exitCode != null || child.signalCode != null) return
  await new Promise<void>(resolve => {
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      resolve()
    }, 35_000)
    child.once('exit', () => { clearTimeout(timeout); resolve() })
    try { child.kill(signal) } catch { clearTimeout(timeout); resolve() }
  })
}

async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return
  stopping = true
  if (workerRestartTimer) clearTimeout(workerRestartTimer)
  logger.info(`${reason} — stopping API and worker processes`)
  await Promise.all([stopChild(api, 'SIGTERM'), stopChild(worker, 'SIGTERM')])
  process.exit(code)
}

startApi()
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
