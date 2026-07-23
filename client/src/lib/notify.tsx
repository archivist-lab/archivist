import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

// ── In-app notifications ──────────────────────────────────────────────────────
// A tiny module-level store so `toast.error(msg)` / `confirmDialog(msg)` can be
// called from anywhere (event handlers, catch blocks, api helpers) without
// threading a context. Rendered once by <NotificationHost/> at the app root.
// This replaces every browser alert()/confirm() so notifications feel native to
// the app and never block the UI.

type ToastKind = 'success' | 'error' | 'info'
interface ToastEntry { id: number; kind: ToastKind; message: string }

let nextId = 1
let toasts: ToastEntry[] = []
const toastListeners = new Set<() => void>()
const emitToasts = () => { for (const listener of toastListeners) listener() }

function dismissToast(id: number) {
  toasts = toasts.filter(entry => entry.id !== id)
  emitToasts()
}

function pushToast(kind: ToastKind, message: unknown, duration?: number): number {
  const id = nextId++
  const text = message instanceof Error ? message.message : String(message ?? '')
  toasts = [...toasts, { id, kind, message: text }]
  emitToasts()
  const ttl = duration ?? (kind === 'error' ? 6500 : 3500)
  if (ttl > 0) setTimeout(() => dismissToast(id), ttl)
  return id
}

export const toast = {
  success: (message: unknown, opts?: { duration?: number }) => pushToast('success', message, opts?.duration),
  error: (message: unknown, opts?: { duration?: number }) => pushToast('error', message, opts?.duration),
  info: (message: unknown, opts?: { duration?: number }) => pushToast('info', message, opts?.duration),
  dismiss: dismissToast,
}

// ── Confirm dialog ────────────────────────────────────────────────────────────

interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}
interface ConfirmState extends Required<Omit<ConfirmOptions, 'message'>> {
  id: number
  message?: string
  resolve: (value: boolean) => void
}

let confirmState: ConfirmState | null = null
const confirmListeners = new Set<() => void>()
const emitConfirm = () => { for (const listener of confirmListeners) listener() }

/**
 * Styled replacement for window.confirm — returns a promise that resolves true
 * when confirmed, false when cancelled/dismissed. Accepts a plain string (drop
 * in for the old confirm text) or a richer options object.
 */
export function confirmDialog(options: string | ConfirmOptions): Promise<boolean> {
  const opts = typeof options === 'string' ? { title: options } : options
  return new Promise<boolean>(resolve => {
    if (confirmState) confirmState.resolve(false) // supersede any open dialog
    confirmState = {
      id: nextId++,
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? 'Confirm',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
      danger: opts.danger ?? true,
      resolve,
    }
    emitConfirm()
  })
}

function resolveConfirm(result: boolean) {
  if (!confirmState) return
  confirmState.resolve(result)
  confirmState = null
  emitConfirm()
}

// ── Rendering ────────────────────────────────────────────────────────────────

const TOAST_STYLES: Record<ToastKind, { accent: string; icon: string; tint: string }> = {
  success: { accent: '#10B981', icon: '✓', tint: 'rgba(16,185,129,0.12)' },
  error: { accent: '#F87171', icon: '!', tint: 'rgba(248,113,113,0.12)' },
  info: { accent: '#00D4FF', icon: 'ℹ', tint: 'rgba(0,212,255,0.12)' },
}

function ToastCard({ entry }: { entry: ToastEntry }) {
  const style = TOAST_STYLES[entry.kind]
  return (
    <div
      role="status"
      className="pointer-events-auto flex w-80 items-start gap-3 rounded-xl border border-white/10 bg-noir-900/95 px-4 py-3 shadow-2xl backdrop-blur-xl animate-toast-in"
      style={{ borderLeft: `3px solid ${style.accent}` }}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold"
        style={{ backgroundColor: style.tint, color: style.accent }}
      >
        {style.icon}
      </span>
      <p className="min-w-0 flex-1 whitespace-pre-line break-words text-[13px] leading-snug text-white/85">{entry.message}</p>
      <button
        onClick={() => dismissToast(entry.id)}
        aria-label="Dismiss"
        className="-mr-1 shrink-0 text-white/25 transition-colors hover:text-white/70"
      >
        ✕
      </button>
    </div>
  )
}

function ConfirmDialog({ state }: { state: ConfirmState }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resolveConfirm(false)
      if (event.key === 'Enter') resolveConfirm(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.id])

  const accent = state.danger ? '#F87171' : '#00D4FF'
  return (
    <div className="fixed inset-0 z-[320] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-noir-950/90 backdrop-blur-sm" onClick={() => resolveConfirm(false)} />
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-noir-800 shadow-[0_0_60px_rgba(0,0,0,0.8)] animate-slide-up">
        <div className="px-6 py-5">
          <h2 className="font-display text-lg tracking-wide text-white">{state.title}</h2>
          {state.message && <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-white/55">{state.message}</p>}
        </div>
        <div className="flex justify-end gap-3 border-t border-white/5 px-6 py-4">
          <button
            onClick={() => resolveConfirm(false)}
            className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-white/60 transition-all hover:bg-white/10 hover:text-white"
          >
            {state.cancelLabel}
          </button>
          <button
            onClick={() => resolveConfirm(true)}
            autoFocus
            className="rounded-lg border px-4 py-2 text-[11px] font-bold uppercase tracking-widest transition-all"
            style={{ borderColor: `${accent}55`, backgroundColor: `${accent}1f`, color: accent }}
          >
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function NotificationHost() {
  const currentToasts = useSyncExternalStore(
    listener => { toastListeners.add(listener); return () => toastListeners.delete(listener) },
    () => toasts,
    () => toasts,
  )
  const currentConfirm = useSyncExternalStore(
    listener => { confirmListeners.add(listener); return () => confirmListeners.delete(listener) },
    () => confirmState,
    () => confirmState,
  )

  if (typeof document === 'undefined') return null
  return createPortal(
    <>
      <div className="pointer-events-none fixed top-4 right-4 z-[300] flex flex-col gap-2">
        {currentToasts.map(entry => <ToastCard key={entry.id} entry={entry} />)}
      </div>
      {currentConfirm && <ConfirmDialog state={currentConfirm} />}
    </>,
    document.body,
  )
}
