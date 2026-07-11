import type { MediaTracks } from '../lib/sdk.js'

/**
 * Gear popover for playback tracks (audio, subtitles) and playback mode.
 *
 * Direct play streams the original file — fast, but only works when the browser
 * can decode the container/codecs (H.264 + AAC in MP4/MKV). Library files are
 * often HEVC + E-AC3/DTS, which browsers can't decode (you get no audio, or
 * nothing). Compatibility mode transcodes to H.264 + stereo AAC on the server
 * so it plays anywhere — at the cost of CPU and exact seeking.
 */

const audioLabel = (t: NonNullable<MediaTracks['audio']>[number]) => {
  const bits = [t.language ?? 'Audio', t.title, t.channelLayout ?? (t.channels ? `${t.channels}ch` : null)].filter(Boolean)
  return `${bits.join(' · ')}${t.browserFriendly ? '' : ` · ${t.codec.toUpperCase()}`}`
}
const subLabel = (t: NonNullable<MediaTracks['subtitles']>[number]) => {
  const bits = [t.language ?? 'Subtitle', t.title, t.forced ? 'Forced' : null].filter(Boolean)
  return bits.join(' · ')
}

export function TrackMenu({ tracks, mode, audioIndex, subIndex, normalizeVolume, onMode, onAudio, onSub, onNormalize, onClose }: {
  tracks: MediaTracks | null
  mode: 'direct' | 'compat'
  audioIndex: number | null
  subIndex: number | null
  normalizeVolume: boolean
  onMode: (m: 'direct' | 'compat') => void
  onAudio: (index: number | null) => void
  onSub: (index: number | null) => void
  onNormalize: (on: boolean) => void
  onClose: () => void
}) {
  const audio = tracks?.audio ?? []
  const subs = tracks?.subtitles ?? []
  // In direct mode only text subtitles are selectable (loaded as WebVTT).
  // In compatibility mode any subtitle (incl. bitmap) can be burned in.
  const usableSubs = mode === 'compat' ? subs : subs.filter(s => s.textBased)

  const Row = ({ active, label, sub, onClick }: { active: boolean; label: string; sub?: string; onClick: () => void }) => (
    <button onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition-colors ${active ? 'bg-cyan/15 text-cyan' : 'text-white/70 hover:bg-white/5'}`}>
      <span className="w-3 shrink-0">{active ? '✓' : ''}</span>
      <span className="min-w-0">
        <span className="block truncate">{label}</span>
        {sub && <span className="block text-[10px] font-mono text-white/30 truncate">{sub}</span>}
      </span>
    </button>
  )

  return (
    <div className="absolute right-0 bottom-14 w-72 max-h-[70vh] overflow-y-auto rounded-xl bg-noir-950/95 border border-white/10 shadow-2xl p-2 space-y-3 backdrop-blur-sm"
      onClick={e => e.stopPropagation()}>
      <div>
        <p className="px-3 pt-1 pb-1.5 text-[10px] font-mono uppercase tracking-[0.25em] text-white/35">Playback</p>
        <Row active={mode === 'direct'} label="Direct play" sub="Original file, fastest" onClick={() => onMode('direct')} />
        <Row active={mode === 'compat'} label="Compatibility mode" sub="Transcode — fixes audio/codec issues" onClick={() => onMode('compat')} />
        {tracks && !tracks.directPlayable && mode === 'direct' && (
          <p className="px-3 pt-1 text-[10px] text-amber-400/80 leading-tight">
            This file{tracks.video && !tracks.video.browserFriendly ? ` (${(tracks.video.codec ?? '').toUpperCase()} video)` : ''}
            {' '}may not play directly. Switch to Compatibility mode if you have no audio or picture.
          </p>
        )}
      </div>

      {audio.length > 0 && (
        <div>
          <p className="px-3 pb-1.5 text-[10px] font-mono uppercase tracking-[0.25em] text-white/35">Audio</p>
          {audio.map(a => (
            <Row key={a.index}
              active={audioIndex != null ? audioIndex === a.index : !!a.default || (audioIndex === null && a === (audio.find(x => x.default) ?? audio[0]))}
              label={audioLabel(a)}
              sub={!a.browserFriendly && mode === 'direct' ? 'Needs compatibility mode' : undefined}
              onClick={() => onAudio(a.index)} />
          ))}
        </div>
      )}

      <div>
        <p className="px-3 pb-1.5 text-[10px] font-mono uppercase tracking-[0.25em] text-white/35">Subtitles</p>
        <Row active={subIndex === null} label="Off" onClick={() => onSub(null)} />
        {usableSubs.map(s => (
          <Row key={s.index} active={subIndex === s.index} label={subLabel(s)}
            sub={mode === 'direct' && !s.textBased ? 'Image subs — compatibility mode only' : undefined}
            onClick={() => onSub(s.index)} />
        ))}
        {mode === 'direct' && subs.some(s => !s.textBased) && (
          <p className="px-3 pt-1 text-[10px] text-white/30 leading-tight">Image-based subtitles need compatibility mode (burned in).</p>
        )}
      </div>

      <div>
        <p className="px-3 pb-1.5 text-[10px] font-mono uppercase tracking-[0.25em] text-white/35">Volume</p>
        <button onClick={() => onNormalize(!normalizeVolume)}
          className="w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 text-white/70 hover:bg-white/5">
          <span className="w-3 shrink-0">{normalizeVolume ? '✓' : ''}</span>
          <span className="min-w-0">
            <span className="block">Normalize loudness</span>
            <span className="block text-[10px] font-mono text-white/30">
              {tracks?.loudness
                ? `${tracks.loudness.integratedLufs.toFixed(1)} → ${tracks.targetLufs} LUFS`
                : 'Consistent level across titles'}
            </span>
          </span>
        </button>
      </div>

      <button onClick={onClose} className="w-full py-1.5 text-[10px] font-mono uppercase tracking-widest text-white/40 hover:text-white">Close</button>
    </div>
  )
}
