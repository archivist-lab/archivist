import { useEffect, type ReactNode } from 'react'

export interface SearchDetailFact {
  label: string
  value?: string | number | null
}

/**
 * Rich metadata popup shown when a search result on an add page is clicked.
 * Displays whatever the search result already carries (poster/backdrop, year,
 * rating, genres, overview, plus per-domain facts) and offers an Add button
 * that performs the same action as the card's "+ Add" badge.
 */
export function SearchDetailModal({
  onClose, onAdd, onView, actions, isAdded = false, accentColor = '#00D4FF',
  image, backdrop, title, year, rating, genres = [], overview, facts = [], fallbackIcon = '🎬', addLabel = 'Add to Library',
}: {
  onClose: () => void
  onAdd: () => void
  onView?: () => void
  actions?: ReactNode
  isAdded?: boolean
  accentColor?: string
  image?: string
  backdrop?: string
  title: string
  year?: number | string
  rating?: number | null
  genres?: string[]
  overview?: string
  facts?: SearchDetailFact[]
  fallbackIcon?: string
  addLabel?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shownFacts = facts.filter(f => f.value !== undefined && f.value !== null && String(f.value).trim() !== '')

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div
        className="relative w-full max-w-2xl max-h-[88vh] overflow-hidden rounded-3xl bg-noir-900 border border-white/10 shadow-2xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Backdrop header (kept behind the content, which sits above it) */}
        <div className="relative z-0 h-32 shrink-0 bg-noir-800 overflow-hidden">
          {backdrop ? (
            <img src={backdrop} alt="" className="w-full h-full object-cover opacity-40" />
          ) : (
            <div className="w-full h-full" style={{ background: `linear-gradient(135deg, ${accentColor}22, transparent)` }} />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-noir-900 via-noir-900/60 to-transparent" />
          <button
            onClick={onClose}
            className="absolute top-3 right-3 z-20 w-8 h-8 rounded-full bg-black/40 hover:bg-black/70 text-white/70 hover:text-white flex items-center justify-center transition-all"
            aria-label="Close"
          >✕</button>
        </div>

        {/* Poster + title row — non-scrolling so the poster's overhang over the
            banner isn't clipped by an overflow container. Sits above the banner. */}
        <div className="relative z-20 shrink-0 px-6 -mt-16">
          <div className="flex gap-5">
            <div className="w-28 shrink-0 rounded-xl overflow-hidden border border-white/10 shadow-2xl bg-noir-800 aspect-[2/3]">
              {image ? (
                <img src={image} alt={title} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-4xl opacity-20">{fallbackIcon}</div>
              )}
            </div>
            <div className="flex-1 min-w-0 self-end pb-1">
              <h2 className="text-xl font-bold text-white leading-tight drop-shadow-lg">{title}</h2>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] font-mono uppercase tracking-widest text-white/40">
                {year ? <span>{year}</span> : null}
                {rating ? <span className="text-yellow-400">★ {Number(rating).toFixed(1)}</span> : null}
              </div>
            </div>
          </div>

          {genres.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {genres.slice(0, 6).map(g => (
                <span key={g} className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest bg-white/5 border border-white/10 text-white/50">{g}</span>
              ))}
            </div>
          )}
        </div>

        <div className="relative z-10 flex-1 overflow-y-auto custom-scrollbar px-6 pt-4 pb-6">
          {overview && (
            <p className="text-sm leading-relaxed text-white/70 font-light">{overview}</p>
          )}

          {shownFacts.length > 0 && (
            <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3">
              {shownFacts.map(f => (
                <div key={f.label} className="flex flex-col gap-0.5 border-b border-white/5 pb-2">
                  <span className="text-[9px] font-mono text-white/30 uppercase tracking-widest">{f.label}</span>
                  <span className="text-sm text-white/70">{f.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 flex flex-wrap items-center justify-end gap-3 px-6 py-4 border-t border-white/5 bg-noir-950/40">
          {actions}
          <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest">Close</button>
          <button
            onClick={() => { if (isAdded && onView) onView(); else if (!isAdded) onAdd(); onClose() }}
            disabled={isAdded && !onView}
            className="px-8 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95 disabled:opacity-50"
            style={isAdded ? { background: 'rgba(34,197,94,0.1)', color: '#22c55e' } : { background: accentColor, color: '#0a0a0a' }}
          >
            {isAdded ? (onView ? 'View in Library' : '✓ In Library') : addLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
