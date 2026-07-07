/**
 * Session registry — allows the app layer to register a session-based send
 * function that @archivist/core can call without a circular dependency.
 * The app registers its TorrentStack Session.addTorrent wrapper at startup.
 */

export interface SessionSendResult {
  success: boolean
  message: string
  infoHash?: string
}

type SessionSendFn = (url: string, label: string) => Promise<SessionSendResult>

let _sendFn: SessionSendFn | null = null

export function registerSessionSendFn(fn: SessionSendFn): void {
  _sendFn = fn
}

export function getSessionSendFn(): SessionSendFn | null {
  return _sendFn
}
