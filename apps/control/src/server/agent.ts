import http, { type IncomingMessage, type ServerResponse } from 'node:http'

const socketPath = process.env.ARCHIVIST_CONTROL_AGENT_SOCKET || '/run/archivist-control/agent.sock'

export class AgentError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function agentJson<T>(requestPath: string, method = 'GET', payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: requestPath, method, timeout: 8_000, headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' } }, response => {
      let contents = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        contents += chunk
        if (contents.length > 4 * 1024 * 1024) request.destroy(new Error('Agent response is too large'))
      })
      response.on('end', () => {
        try {
          const parsed = contents ? JSON.parse(contents) as T & { error?: string } : {} as T & { error?: string }
          if ((response.statusCode || 500) >= 400) reject(new AgentError(parsed.error || 'Control agent request failed', response.statusCode || 500))
          else resolve(parsed)
        } catch (error) { reject(error) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('Control agent timed out')))
    request.on('error', reject)
    request.end(payload === undefined ? undefined : JSON.stringify(payload))
  })
}

export function proxyAgentUpload(clientRequest: IncomingMessage, requestPath: string): Promise<{ status: number; value: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: requestPath, method: 'PUT', timeout: 30 * 60_000 }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const contents = Buffer.concat(chunks).toString()
        let value: unknown = {}
        try { value = contents ? JSON.parse(contents) : {} } catch { value = { error: 'Invalid agent response' } }
        resolve({ status: response.statusCode || 502, value })
      })
    })
    request.on('timeout', () => request.destroy(new Error('Control agent upload timed out')))
    request.on('error', reject)
    clientRequest.pipe(request)
  })
}

export function proxyAgentContent(clientRequest: IncomingMessage, clientResponse: ServerResponse, requestPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: requestPath, method: 'GET', timeout: 30_000 }, response => {
      const headers: Record<string, string> = { 'Cache-Control': 'no-store' }
      for (const name of ['content-type', 'content-length', 'content-disposition', 'x-content-type-options']) {
        const value = response.headers[name]
        if (typeof value === 'string') headers[name] = value
      }
      clientResponse.writeHead(response.statusCode || 502, headers)
      response.pipe(clientResponse)
      response.on('end', resolve)
      response.on('error', reject)
    })
    clientResponse.on('close', () => { if (!clientResponse.writableEnded) request.destroy() })
    request.on('timeout', () => request.destroy(new Error('Control agent timed out')))
    request.on('error', reject)
    request.end()
  })
}
