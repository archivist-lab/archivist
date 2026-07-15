import type { MediaSegment, MediaTracks } from '../lib/sdk.js'

export type SegmentKind = 'intro' | 'credits'

export interface ActiveSegment { kind: SegmentKind; marker: MediaSegment }

export function activeSegmentAt(tracks: MediaTracks | null, current: number, earlySeconds = 0): ActiveSegment | null {
  for (const kind of ['intro', 'credits'] as const) {
    const marker = tracks?.segments?.[kind]
    if (!marker || !Number.isFinite(marker.start) || !Number.isFinite(marker.end) || marker.end <= marker.start + 1) continue
    if (current >= Math.max(0, marker.start - earlySeconds) && current < marker.end - 0.25) return { kind, marker }
  }
  return null
}

export function SkipSegmentButton({ segment, onSkip }: { segment: ActiveSegment | null; onSkip: () => void }) {
  if (!segment) return null
  return (
    <button
      onClick={event => { event.stopPropagation(); onSkip() }}
      aria-label={`Skip ${segment.kind}`}
      className="absolute z-20 bottom-24 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-xl bg-noir-950/90 border border-white/20 text-white text-[11px] font-bold uppercase tracking-widest hover:border-cyan/60 hover:text-cyan transition-colors animate-slide-up"
      title={`Skip ${segment.kind} (s)`}
    >
      Skip {segment.kind} <span className="ml-2 text-white/30">S</span>
    </button>
  )
}
