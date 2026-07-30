import { useState } from 'react'
import { Modal, TabSelect } from './ui.js'

export interface BulkQualityPreferences {
  target_tier: string
  target_resolution: string
  target_source: string
  target_codec: string
  minimum_tier: string
  minimum_resolution: string
  minimum_source: string
  minimum_codec: string
}

const TIERS = ['Any', 'Tier 1', 'Tier 2', 'Tier 3']
const RESOLUTIONS = ['Any', '2160p', '1080p', '720p']
const SOURCES = ['Any', 'REMUX', 'BluRay', 'WEB', 'HDTV', 'DVD']
const CODECS = ['Any', 'AV1', 'x265', 'x264']

const defaults: BulkQualityPreferences = {
  target_tier: 'Any', target_resolution: 'Any', target_source: 'Any', target_codec: 'Any',
  minimum_tier: 'Any', minimum_resolution: 'Any', minimum_source: 'Any', minimum_codec: 'Any',
}

export function BulkQualityModal({ count, itemLabel, initial, accentColor = '#00D4FF', busy = false, confirmLabel, onClose, onConfirm }: {
  count: number
  itemLabel: string
  initial?: Partial<BulkQualityPreferences>
  accentColor?: string
  busy?: boolean
  confirmLabel?: string
  onClose: () => void
  onConfirm: (preferences: BulkQualityPreferences) => void | Promise<void>
}) {
  const [value, setValue] = useState<BulkQualityPreferences>({ ...defaults, ...initial })
  const set = (key: keyof BulkQualityPreferences, next: string) => setValue(current => ({ ...current, [key]: next }))

  return (
    <Modal title={`Quality for ${count} ${itemLabel}`} onClose={busy ? () => {} : onClose} width="max-w-2xl">
      <div className="space-y-6">
        <p className="text-sm text-white/45">
          These selections will be applied to every selected item. Set the lowest quality you will accept and the highest quality Archivist should seek.
        </p>
        <section className="space-y-4 rounded-2xl border border-white/5 bg-noir-900/60 p-4">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-widest text-white/70">Minimum accepted</h3>
            <p className="mt-1 text-xs text-white/30">Releases below this floor will be rejected.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TabSelect label="Tier" options={TIERS} value={value.minimum_tier} onChange={next => set('minimum_tier', next)} accentColor={accentColor} />
            <TabSelect label="Resolution" options={RESOLUTIONS} value={value.minimum_resolution} onChange={next => set('minimum_resolution', next)} accentColor={accentColor} />
            <TabSelect label="Source" options={SOURCES} value={value.minimum_source} onChange={next => set('minimum_source', next)} accentColor={accentColor} />
            <TabSelect label="Codec" options={CODECS} value={value.minimum_codec} onChange={next => set('minimum_codec', next)} accentColor={accentColor} />
          </div>
        </section>
        <section className="space-y-4 rounded-2xl border border-white/5 bg-noir-900/60 p-4">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-widest text-white/70">Maximum accepted</h3>
            <p className="mt-1 text-xs text-white/30">Archivist can upgrade until it reaches this ceiling.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TabSelect label="Tier" options={TIERS} value={value.target_tier} onChange={next => set('target_tier', next)} accentColor={accentColor} />
            <TabSelect label="Resolution" options={RESOLUTIONS} value={value.target_resolution} onChange={next => set('target_resolution', next)} accentColor={accentColor} />
            <TabSelect label="Source" options={SOURCES} value={value.target_source} onChange={next => set('target_source', next)} accentColor={accentColor} />
            <TabSelect label="Codec" options={CODECS} value={value.target_codec} onChange={next => set('target_codec', next)} accentColor={accentColor} />
          </div>
        </section>
        <div className="flex justify-end gap-3 border-t border-white/5 pt-4">
          <button type="button" disabled={busy} onClick={onClose} className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-white/40 hover:text-white disabled:opacity-40">Cancel</button>
          <button type="button" disabled={busy} onClick={() => void onConfirm(value)} className="rounded-lg px-5 py-2.5 text-[10px] font-bold uppercase tracking-widest text-noir-950 disabled:opacity-40" style={{ backgroundColor: accentColor }}>
            {busy ? 'Applying…' : (confirmLabel ?? `Apply to ${count}`)}
          </button>
        </div>
      </div>
    </Modal>
  )
}
