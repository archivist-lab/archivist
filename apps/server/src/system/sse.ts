import type { Response } from 'express'

/**
 * One-way server-sent-events bus for /api/v1/events. Clients receive a
 * `system:ready` event on connect and every recorded system event thereafter.
 */

/**
 * Reverse proxies (nginx, Traefik, Cloudflare) close idle upstream connections,
 * typically after 60s. An idle Archivist emits nothing for hours — activity is
 * only broadcast while work is in flight — so without traffic the stream would be
 * silently dropped and every client would fall back to polling forever. A comment
 * frame keeps it warm; SSE clients ignore lines starting with ':'.
 */
const HEARTBEAT_MS = 25_000

class SseBus {
  private clients = new Set<Response>()
  private heartbeat: NodeJS.Timeout | null = null

  addClient(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    // Disable proxy buffering, which would otherwise hold frames back.
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
    this.clients.add(res)
    this.send(res, 'system:ready', { ready: true, ts: new Date().toISOString() })
    res.on('close', () => {
      this.clients.delete(res)
      if (this.clients.size === 0) this.stopHeartbeat()
    })
    this.startHeartbeat()
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(': ping\n\n')
          ;(res as any).flush?.()
        } catch {
          this.clients.delete(res)
        }
      }
      if (this.clients.size === 0) this.stopHeartbeat()
    }, HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  emit(event: string, data: unknown): void {
    for (const res of this.clients) {
      try {
        this.send(res, event, data)
      } catch {
        this.clients.delete(res)
      }
    }
  }

  private send(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  closeAll(): void {
    this.stopHeartbeat()
    for (const res of this.clients) {
      try { res.end() } catch {}
    }
    this.clients.clear()
  }

  get clientCount(): number {
    return this.clients.size
  }
}

let _bus: SseBus | null = null

export function getSseBus(): SseBus {
  if (!_bus) _bus = new SseBus()
  return _bus
}
