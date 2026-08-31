import { useEffect, type ReactNode } from 'react'
import type { PlayerEdition } from '@archivist/contracts'
import { PlayerIcon } from './Icons.js'
import { useDialogFocus } from './../focus/useDialogFocus.js'

/**
 * The item view's dialogs.
 *
 * The item page is one screen, so everything that would once have been another
 * section down the page — the editions, the ratings, the full spec sheet — is a
 * control on that screen that opens over it. They share one shell so a remote
 * meets the same shape each time: a heading, a scrolling body, Close in a fixed
 * place, and Back closing whatever is topmost.
 */
export function ItemDialog({ title, eyebrow, onClose, children, footer, width = '48rem' }: {
  title: string
  eyebrow?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: string
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose)
  return <div ref={dialogRef} className="fixed inset-0 z-[100] grid place-items-center bg-black/75 p-[var(--safe-x)]" role="dialog" aria-modal="true" aria-labelledby="item-dialog-title" onClick={onClose}>
    <section className="player-dialog motion-dialog flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl p-[clamp(1.5rem,3vw,2.5rem)] shadow-[var(--archivist-shadow-dialog)]" style={{ maxWidth: width }} onClick={event => event.stopPropagation()}>
      <header className="flex items-start gap-5 border-b border-white/10 pb-6">
        <div className="min-w-0 flex-1">
          {eyebrow && <p className="archivist-section-label player-accent">{eyebrow}</p>}
          <h2 id="item-dialog-title" className="player-secondary-title mt-3 truncate">{title}</h2>
        </div>
        <button data-dialog-initial onClick={onClose} className="player-focusable player-button"><PlayerIcon name="close" size={15} />Close</button>
      </header>
      <div className="no-scrollbar flex-1 overflow-y-auto py-7">{children}</div>
      {footer && <footer className="border-t border-white/10 pt-6">{footer}</footer>}
    </section>
  </div>
}

/**
 * Which cut of a film Play uses. Every edition is listed, including the ones
 * that are not on disk: knowing an extended cut exists and is missing is worth
 * as much as knowing which one will play, and hiding it says neither.
 */
export function EditionDialog({ title, editions, onSelect, onClose }: {
  title: string
  editions: PlayerEdition[]
  onSelect: (editionId: number) => void
  onClose: () => void
}) {
  return <ItemDialog title={title} eyebrow="Editions" onClose={onClose}>
    <div className="grid gap-2">
      {editions.map(edition => <button
        key={edition.id}
        type="button"
        aria-pressed={edition.isDefault}
        disabled={!edition.available}
        onClick={() => onSelect(edition.id)}
        className={`player-focusable flex min-h-16 w-full items-center gap-4 rounded-xl border px-4 py-3 text-left disabled:opacity-35 ${edition.isDefault ? 'player-accent-border player-accent-soft' : 'border-white/[.07] bg-white/[.035] hover:bg-white/[.065]'}`}
      >
        <span className="min-w-0 flex-1">
          <strong className="block truncate font-mono text-[10px] font-semibold uppercase tracking-[.08em] text-white/80">{edition.name}</strong>
          <span className="mt-1.5 block truncate font-mono text-[9px] uppercase tracking-[.06em] text-white/35">
            {edition.available
              ? [edition.quality?.resolution, edition.runtimeSeconds ? `${Math.round(edition.runtimeSeconds / 60)} min` : null].filter(Boolean).join(' · ') || 'Available'
              : 'Not in your library'}
          </span>
        </span>
        <span aria-hidden className="grid w-5 shrink-0 place-items-center">{edition.isDefault && <PlayerIcon name="check" size={17} />}</span>
      </button>)}
      {!editions.length && <p className="player-empty-state">This film has one edition.</p>}
    </div>
  </ItemDialog>
}

/** A labelled row inside the information dialog. */
export function ItemFact({ label, value }: { label: string; value?: string | number | null }) {
  return <div><dt className="text-white/35">{label}</dt><dd className="mt-1 text-white/80">{value ?? 'Not available'}</dd></div>
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`
}

/**
 * Confirmation for something that has already happened — an edition chosen, a
 * refresh queued. It clears itself: an acknowledgement that stays on screen
 * stops being an acknowledgement and becomes furniture.
 */
export function ItemToast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 2600)
    return () => window.clearTimeout(timer)
  }, [message, onDone])
  return <div role="status" className="fixed bottom-8 right-8 z-[120] rounded-xl bg-white px-5 py-3 text-black shadow-2xl">{message}</div>
}
