import { useEffect, useState } from 'react'
import type { EpisodeNumbering } from '../lib/shared.api.js'

/**
 * How a series pack's file names are read into library episodes. By season is
 * `S02E05`. Absolute reads the one number a file carries as its place in the
 * whole run — Dragon Ball Z Kai's `101` is the 101st episode — and the start
 * lines a pack cut into seasons differently up with the library: a Dragon Ball
 * Super pack's `S03E01` as library episode 47. The import plan below shows
 * where every file lands, so a wrong start is seen before anything moves.
 */
export function EpisodeNumberingPicker({ value, onChange }: { value: EpisodeNumbering | null | undefined; onChange: (next: EpisodeNumbering | null) => void }) {
  const absolute = value?.mode === 'absolute'
  const start = value?.mode === 'absolute' ? value.start : 1
  // Typed as a draft and committed on blur or Enter: every commit replans the import.
  const [draft, setDraft] = useState(String(start))
  useEffect(() => { setDraft(String(start)) }, [start])

  const commit = () => {
    const next = Math.max(1, Math.trunc(Number(draft)) || 1)
    setDraft(String(next))
    if (next !== start) onChange({ mode: 'absolute', start: next })
  }

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Episode Numbering</span>
        <div className="flex gap-1 bg-noir-950 p-1 rounded-lg border border-white/5">
          {([['season', 'By Season · S01E05'], ['absolute', 'Absolute · 101 = 101st']] as const).map(([mode, label]) => {
            const active = mode === 'absolute' ? absolute : !absolute
            return (
              <button key={mode} type="button"
                onClick={() => { if (!active) onChange(mode === 'absolute' ? { mode: 'absolute', start: 1 } : null) }}
                className={`px-3 py-1 rounded-md text-[9px] font-bold uppercase tracking-widest transition-all ${active ? 'bg-[#00D4FF] text-noir-950' : 'text-white/35 hover:text-white/70'}`}>
                {label}
              </button>
            )
          })}
        </div>
      </div>
      {absolute && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[11px] font-mono text-white/45">
            Pack episode 1 is library episode
            <input type="number" min={1} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit}
              onKeyDown={e => { if (e.key === 'Enter') commit() }}
              className="w-20 bg-white/[0.03] border border-white/10 rounded-md px-2 py-1 text-sm text-white/80 outline-none focus:border-[#00D4FF]/40" />
          </label>
          <p className="text-[10px] font-mono text-white/25">
            Counted through every season, specials left out. A pack whose S03E01 is the 47th episode starts at 47.
          </p>
        </div>
      )}
    </div>
  )
}
