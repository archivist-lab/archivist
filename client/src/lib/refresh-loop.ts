/** One in-flight refresh; events coalesce and hidden documents stop polling. */
export function createRefreshLoop(load: (signal: AbortSignal) => unknown, delay: () => number) {
  let stopped = false
  let running = false
  let queued = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | null = null
  const schedule = (ms = delay()) => {
    if (timer) clearTimeout(timer)
    if (!stopped && !document.hidden) timer = setTimeout(run, ms)
  }
  const run = async () => {
    if (stopped || document.hidden) return
    if (running) { queued = true; return }
    running = true; queued = false
    controller = new AbortController()
    try { await load(controller.signal) } catch { /* callers render their own errors */ }
    finally { running = false; controller = null; schedule(queued ? 100 : delay()) }
  }
  const visibility = () => {
    if (document.hidden) { if (timer) clearTimeout(timer); controller?.abort() }
    else schedule(0)
  }
  document.addEventListener('visibilitychange', visibility)
  return {
    request: () => { if (running) queued = true; else schedule(100) },
    start: (immediate = true) => schedule(immediate ? 0 : delay()),
    stop: () => { stopped = true; if (timer) clearTimeout(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility) },
  }
}
