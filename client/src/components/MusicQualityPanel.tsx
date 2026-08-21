import { useState, type ReactNode } from 'react'
import { MUSIC_QUALITY_LADDER, codecsForQuality, musicQualityRung } from '@archivist/contracts'
import { Modal, TabSelect, Toggle } from './ui.js'

/**
 * The music counterpart of QualityPolicyPanel, deliberately identical in shape:
 * a summary bar that opens the same modal of TabSelect grids.
 *
 * Only the axes differ. Music has no resolution, so the primary axis is a
 * quality class; codec is scoped to that class so an impossible pairing such as
 * "FLAC at 192kbps" cannot be expressed; and there is no source, because music
 * releases state it inconsistently and it rarely decides a grab.
 */

export interface MusicPolicyValue {
  upgrade_allowed?: boolean
  /** Quality class, stored in target_resolution. */
  target_resolution?: string | null
  target_codec?: string | null
  minimum_resolution?: string | null
  minimum_codec?: string | null
  current_quality?: string | null
  current_codec?: string | null
  current_release_group?: string | null
  current_release_title?: string | null
}

const QUALITY_LABELS = ['Any', ...MUSIC_QUALITY_LADDER.map(rung => rung.label)]

/** The picker speaks labels; storage speaks ids. */
function idForLabel(label: string): string | null {
  if (label === 'Any') return null
  return MUSIC_QUALITY_LADDER.find(rung => rung.label === label)?.id ?? null
}

function labelForId(id: string | null | undefined): string {
  return musicQualityRung(id)?.label ?? 'Any'
}

function codecOptions(quality: string | null | undefined): string[] {
  return ['Any', ...codecsForQuality(quality)]
}

export function MusicQualityPanel({ value, onChange, compact = false, action }: {
  value: MusicPolicyValue
  onChange: (patch: Partial<MusicPolicyValue>) => void
  compact?: boolean
  /** Optional action rendered as the right-most control. */
  action?: ReactNode
}) {
  const [open, setOpen] = useState(false)

  const seg = (v: string | undefined | null, fallback: string) => (v && v !== 'Any' ? v : fallback)
  const ceiling = [
    seg(labelForId(value.target_resolution), 'Any Quality'),
    seg(value.target_codec, 'Any Codec'),
  ].join('  |  ')
  const floor = [
    seg(labelForId(value.minimum_resolution ?? value.target_resolution), 'Any Quality'),
    seg(value.minimum_codec ?? value.target_codec, 'Any Codec'),
  ].join('  |  ')
  const profile = floor === ceiling ? ceiling : `${floor}  →  ${ceiling}`

  const current = [
    labelForId(value.current_quality) === 'Any' ? null : labelForId(value.current_quality),
    value.current_codec,
    value.current_release_group ? `-${value.current_release_group}` : null,
  ].filter(Boolean).join(' · ')

  // Codec choices follow the class, so changing class clears a codec the new
  // class cannot produce rather than leaving a contradiction behind.
  const setQuality = (key: 'target_resolution' | 'minimum_resolution', label: string) => {
    const id = idForLabel(label)
    const codecKey = key === 'target_resolution' ? 'target_codec' : 'minimum_codec'
    const stillValid = !value[codecKey] || codecsForQuality(id).includes(value[codecKey] as string)
    onChange({ [key]: id, ...(stillValid ? {} : { [codecKey]: null }) } as Partial<MusicPolicyValue>)
  }

  return (
    <>
      <div className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl bg-noir-900/70 border border-white/5 ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}>
        <button onClick={() => setOpen(true)} className="min-w-0 flex-1 text-left group" title="Edit quality profile">
          <div className="text-[9px] font-bold text-white/30 uppercase tracking-[0.25em] mb-0.5">Quality Profile</div>
          <div className="text-[13px] font-mono text-white/85 group-hover:text-[#FF2D78] transition-colors truncate">{profile}</div>
        </button>
        <div className="flex flex-wrap items-center gap-3 sm:gap-4 shrink-0 w-full sm:w-auto">
          <Toggle
            checked={value.upgrade_allowed !== false}
            onChange={v => onChange({ upgrade_allowed: v })}
            label="Allow upgrades"
          />
          {action}
        </div>
      </div>

      {open && (
        <Modal title="Quality Profile" onClose={() => setOpen(false)} width="max-w-lg">
          <div className="space-y-5">
            <div className="rounded-xl bg-noir-950/50 border border-white/5 px-4 py-3 text-center">
              <div className="text-[13px] font-mono text-[#FF2D78] tracking-wide">{profile}</div>
            </div>

            <div>
              <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-white/35">Minimum accepted</div>
              <div className="grid grid-cols-2 gap-3">
                <TabSelect label="Quality floor" accentColor="#FF2D78"
                  value={labelForId(value.minimum_resolution ?? value.target_resolution)} options={QUALITY_LABELS}
                  onChange={v => setQuality('minimum_resolution', v)} />
                <TabSelect label="Codec floor" accentColor="#FF2D78"
                  value={value.minimum_codec ?? value.target_codec ?? 'Any'}
                  options={codecOptions(value.minimum_resolution ?? value.target_resolution)}
                  onChange={v => onChange({ minimum_codec: v === 'Any' ? null : v })} />
              </div>
            </div>

            <div>
              <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-white/35">Maximum accepted</div>
              <div className="grid grid-cols-2 gap-3">
                <TabSelect label="Quality ceiling" accentColor="#FF2D78"
                  value={labelForId(value.target_resolution)} options={QUALITY_LABELS}
                  onChange={v => setQuality('target_resolution', v)} />
                <TabSelect label="Codec ceiling" accentColor="#FF2D78"
                  value={value.target_codec || 'Any'}
                  options={codecOptions(value.target_resolution)}
                  onChange={v => onChange({ target_codec: v === 'Any' ? null : v })} />
              </div>
            </div>

            {musicQualityRung(value.target_resolution) && (
              <p className="text-[10px] font-mono text-white/25">
                {musicQualityRung(value.target_resolution)!.hint}
              </p>
            )}

            {(current || value.current_release_title) && (
              <div className="pt-3 border-t border-white/5 space-y-2">
                <div className="text-[9px] font-bold text-white/30 uppercase tracking-[0.25em]">Current Import</div>
                {current && <p className="text-xs font-mono text-white/50">{current}</p>}
                {value.current_release_title && <p className="text-[10px] font-mono text-white/25 truncate">{value.current_release_title}</p>}
              </div>
            )}

            <div className="flex justify-end pt-1">
              <button onClick={() => setOpen(false)} className="px-8 py-2.5 rounded-xl bg-[#FF2D78] text-noir-950 text-xs font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95">Done</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
