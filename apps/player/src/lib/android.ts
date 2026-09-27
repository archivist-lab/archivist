/**
 * The Archivist Android TV app hosts this Player in a WebView and exposes a
 * small bridge as `window.ArchivistAndroid`. Everywhere else — a browser, the
 * tests — it is absent and every helper here quietly does nothing.
 *
 * The app sends the remote's Back button to the page as Escape. Below the
 * root the Player already treats that as "go back"; at the root it is the
 * Player that asks whether to leave, so it can do so in its own dialog rather
 * than the app guessing and showing a system toast. Setting
 * `__archivistHandlesRootBack` tells the app this Player makes that decision.
 */

export interface AndroidServerInfo {
  name: string
  url: string
  /** Which of the server's addresses answered: the home (LAN) or away one. */
  via: 'home' | 'away'
  appVersion: string
}

interface ArchivistAndroidBridge {
  switchServer(): void
  exitApp(): void
  serverInfo(): string
  /** Absent from app builds before 0.1.1. */
  isTelevision?(): boolean
}

declare global {
  interface Window {
    ArchivistAndroid?: ArchivistAndroidBridge
    __archivistHandlesRootBack?: boolean
  }
}

export function androidShell(): ArchivistAndroidBridge | null {
  return typeof window !== 'undefined' && window.ArchivistAndroid ? window.ArchivistAndroid : null
}

/**
 * True inside the app on a television. A TV WebView can report a coarse
 * pointer for the remote, which must not read as a touch screen.
 */
export function onAndroidTelevision(): boolean {
  try {
    return !!androidShell()?.isTelevision?.()
  } catch {
    return false
  }
}

export function androidServerInfo(): AndroidServerInfo | null {
  try {
    const raw = androidShell()?.serverInfo()
    return raw ? JSON.parse(raw) as AndroidServerInfo : null
  } catch {
    return null
  }
}

export function claimRootBack(): void {
  if (androidShell()) window.__archivistHandlesRootBack = true
}
