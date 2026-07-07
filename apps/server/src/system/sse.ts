import type { Response } from 'express'

/**
 * One-way server-sent-events bus for /api/v1/events. Clients receive a
 * `system:ready` event on connect and every recorded system event thereafter.
 */

class SseBus {
  private clients = new Set<Response>()

  addClient(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()
    this.clients.add(res)
    this.send(res, 'system:ready', { ready: true, ts: new Date().toISOString() })
    res.on('close', () => this.clients.delete(res))
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
