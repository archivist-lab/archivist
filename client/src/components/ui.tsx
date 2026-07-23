import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatSize } from '../lib/api.js'
import SpinnerIcon from '../spinner.svg'

// ── Spinner ───────────────────────────────────────────────────────────────────

export function Spinner({ className = 'w-6 h-6', color = '' }: { className?: string, color?: string }) {
  return (
    <div className={`${className} ${color} flex items-center justify-center`}>
      <img src={SpinnerIcon} alt="Loading..." className="w-full h-full" />
    </div>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export function Modal({ title, onClose, children, width = 'max-w-lg' }: {
  title: string; onClose: () => void; children: ReactNode; width?: string
}) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-noir-950/90 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full ${width} max-h-[90vh] overflow-y-auto rounded-2xl bg-noir-800 border border-white/10 shadow-[0_0_60px_rgba(0,0,0,0.8)] animate-slide-up`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <h2 className="font-display text-xl tracking-widest text-white">{title}</h2>
          <button onClick={onClose} className="text-white/25 hover:text-white transition-colors text-lg leading-none">✕</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

// ── Form primitives ───────────────────────────────────────────────────────────

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-mono uppercase tracking-wider text-white/40 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-white/25 mt-1 font-mono">{hint}</p>}
    </div>
  )
}

export function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props} className={`w-full px-3 py-2.5 rounded-lg bg-noir-900 border border-white/10 text-white/90 text-sm
      placeholder-white/20 focus:outline-none focus:border-white/30 transition-all ${className}`} />
  )
}

export function Select({ children, className = '', ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`w-full px-3 py-2.5 rounded-lg bg-black border border-white/10 text-white/90 text-sm
      focus:outline-none focus:border-white/30 transition-all ${className}`}>
      {children}
    </select>
  )
}

export function TabSelect({ label, options, value, onChange, accentColor = '#00D4FF' }: {
  label?: string
  options: (string | { label: string, value: string })[]
  value: string
  onChange: (v: string) => void
  accentColor?: string
}) {
  return (
    <div className="space-y-2">
      {label && <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">{label}</label>}
      <div className="flex flex-wrap gap-1 bg-noir-950/50 p-1 rounded-xl border border-white/5">
        {options.map(opt => {
          const optLabel = typeof opt === 'string' ? opt : opt.label
          const optValue = typeof opt === 'string' ? opt : opt.value
          const isActive = value === optValue
          
          return (
            <button
              key={optValue}
              onClick={() => onChange(optValue)}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${
                isActive ? 'text-noir-950 shadow-lg' : 'text-white/30 hover:text-white/60'
              }`}
              style={isActive ? { backgroundColor: accentColor } : {}}
            >
              {optLabel.replace('Tier ', '').replace('2160p', '4K').replace('1080p', 'HD').replace('720p', 'SD')}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <div className="relative flex-shrink-0">
        <input type="checkbox" className="sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
        <div className={`w-10 h-5 rounded-full transition-all ${checked ? 'bg-[#00D4FF]/70' : 'bg-white/10'}`} />
        <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow ${checked ? 'translate-x-5' : ''}`} />
      </div>
      <span className="text-sm text-white/70">{label}</span>
    </label>
  )
}

// ── Upgrade policy ────────────────────────────────────────────────────────────

export interface QualityPolicyValue {
  upgrade_allowed?: boolean
  target_tier?: string | null
  target_resolution?: string | null
  target_source?: string | null
  target_codec?: string | null
  minimum_tier?: string | null
  minimum_resolution?: string | null
  minimum_source?: string | null
  minimum_codec?: string | null
  current_tier?: number | null
  current_resolution?: string | null
  current_source?: string | null
  current_codec?: string | null
  current_release_group?: string | null
  current_edition?: string | null
  current_size_bytes?: number | null
  current_release_title?: string | null
}

export function QualityPolicyPanel({ value, onChange, compact = false, action }: {
  value: QualityPolicyValue
  onChange: (patch: Partial<QualityPolicyValue>) => void
  compact?: boolean
  /** Optional action rendered as the right-most control (e.g. a scan button). */
  action?: ReactNode
}) {
  const [open, setOpen] = useState(false)

  // Compact envelope badge, e.g. "Tier 1 | 1080p | BluRay | x265".
  const seg = (v: string | undefined | null, fallback: string) => (v && v !== 'Any' ? v : fallback)
  const ceiling = [
    seg(value.target_tier, 'Any Tier'),
    seg(value.target_resolution, 'Any Res'),
    seg(value.target_source, 'Any Source'),
    seg(value.target_codec, 'Any Codec'),
  ].join('  |  ')
  const floor = [
    seg(value.minimum_tier ?? value.target_tier, 'Any Tier'),
    seg(value.minimum_resolution ?? value.target_resolution, 'Any Res'),
    seg(value.minimum_source ?? value.target_source, 'Any Source'),
    seg(value.minimum_codec ?? value.target_codec, 'Any Codec'),
  ].join('  |  ')
  const profile = floor === ceiling ? ceiling : `${floor}  →  ${ceiling}`

  const current = [
    value.current_tier ? `T${value.current_tier}` : null,
    value.current_resolution,
    value.current_source,
    value.current_codec,
    value.current_release_group ? `-${value.current_release_group}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <>
      <div className={`flex items-center justify-between gap-3 rounded-2xl bg-noir-900/70 border border-white/5 ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}>
        <button onClick={() => setOpen(true)} className="min-w-0 flex-1 text-left group" title="Edit quality profile">
          <div className="text-[9px] font-bold text-white/30 uppercase tracking-[0.25em] mb-0.5">Quality Profile</div>
          <div className="text-[13px] font-mono text-white/85 group-hover:text-[#00D4FF] transition-colors truncate">{profile}</div>
        </button>
        <div className="flex items-center gap-4 shrink-0">
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
              <div className="text-[13px] font-mono text-[#00D4FF] tracking-wide">{profile}</div>
            </div>
            <div>
              <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-white/35">Minimum accepted</div>
              <div className="grid grid-cols-2 gap-3">
                <TabSelect label="Tier floor" value={value.minimum_tier ?? value.target_tier ?? 'Any'} options={['Any', 'Tier 1', 'Tier 2', 'Tier 3']} onChange={v => onChange({ minimum_tier: v })} />
                <TabSelect label="Resolution floor" value={value.minimum_resolution ?? value.target_resolution ?? 'Any'} options={['Any', '2160p', '1080p', '720p']} onChange={v => onChange({ minimum_resolution: v })} />
                <TabSelect label="Source floor" value={value.minimum_source ?? value.target_source ?? 'Any'} options={['Any', 'REMUX', 'BluRay', 'WEB', 'HDTV', 'DVD']} onChange={v => onChange({ minimum_source: v })} />
                <TabSelect label="Codec floor" value={value.minimum_codec ?? value.target_codec ?? 'Any'} options={['Any', 'AV1', 'x265', 'x264']} onChange={v => onChange({ minimum_codec: v })} />
              </div>
            </div>
            <div>
              <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-white/35">Maximum accepted</div>
              <div className="grid grid-cols-2 gap-3">
                <TabSelect label="Tier ceiling" value={value.target_tier || 'Any'} options={['Any', 'Tier 1', 'Tier 2', 'Tier 3']} onChange={v => onChange({ target_tier: v })} />
                <TabSelect label="Resolution ceiling" value={value.target_resolution || 'Any'} options={['Any', '2160p', '1080p', '720p']} onChange={v => onChange({ target_resolution: v })} />
                <TabSelect label="Source ceiling" value={value.target_source || 'Any'} options={['Any', 'REMUX', 'BluRay', 'WEB', 'HDTV', 'DVD']} onChange={v => onChange({ target_source: v })} />
                <TabSelect label="Codec ceiling" value={value.target_codec || 'Any'} options={['Any', 'AV1', 'x265', 'x264']} onChange={v => onChange({ target_codec: v })} />
              </div>
            </div>
            {(current || value.current_size_bytes || value.current_edition) && (
              <div className="pt-3 border-t border-white/5 space-y-2">
                <div className="text-[9px] font-bold text-white/30 uppercase tracking-[0.25em]">Current Import</div>
                {current && <p className="text-xs font-mono text-white/50">{current}</p>}
                {value.current_release_title && <p className="text-[10px] font-mono text-white/25 truncate">{value.current_release_title}</p>}
                <div className="flex flex-wrap gap-2">
                  {value.current_size_bytes ? <span className="text-[10px] font-mono text-white/35 bg-white/5 px-2 py-1 rounded">{formatSize(value.current_size_bytes)}</span> : null}
                  {value.current_edition ? <span className="text-[10px] font-mono text-white/35 bg-white/5 px-2 py-1 rounded">{value.current_edition}</span> : null}
                </div>
              </div>
            )}
            <div className="flex justify-end pt-1">
              <button onClick={() => setOpen(false)} className="px-8 py-2.5 rounded-xl bg-[#00D4FF] text-noir-950 text-xs font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95">Done</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

// ── Release list ──────────────────────────────────────────────────────────────

export interface Release {
  guid: string; indexerName: string; title: string; downloadUrl: string
  size?: number; seeders?: number; leechers?: number; quality?: string
  customTier?: number
}

export function ReleaseList({ releases, onGrab, grabbing, grabbed, accentClass = 'text-[#00D4FF]' }: {
  releases: Release[]
  onGrab: (r: Release) => void
  grabbing: string | null
  grabbed: Set<string>
  accentClass?: string
}) {
  if (releases.length === 0) return (
    <p className="text-center py-6 text-white/20 text-sm font-mono">No releases found</p>
  )
  return (
    <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1 custom-scrollbar">
      {releases.map(r => (
        <div key={r.guid} className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-noir-900 border border-white/5 hover:border-white/10 transition-colors group">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm text-white/80 truncate group-hover:text-white transition-colors">{r.title}</p>
              {r.customTier && r.customTier > 0 && (
                <span className={`text-[9px] px-1 rounded font-bold leading-tight ${
                  r.customTier === 1 ? 'bg-amber-500/20 text-amber-500 border border-amber-500/20' :
                  r.customTier === 2 ? 'bg-slate-400/20 text-slate-400 border border-slate-400/20' :
                  'bg-orange-700/20 text-orange-700 border border-orange-700/20'
                }`}>
                  T{r.customTier}
                </span>
              )}
            </div>
            <div className="flex gap-2 mt-0.5 flex-wrap">
              <span className="text-xs text-white/25 font-mono">{r.indexerName}</span>
              {r.quality && <span className={`text-xs font-mono ${accentClass} opacity-70`}>{r.quality}</span>}
              {r.size != null && <span className="text-xs text-white/20 font-mono">{formatSize(r.size)}</span>}
            </div>
          </div>
          {r.seeders != null && (
            <span className="text-xs font-mono text-emerald-400/60 flex-shrink-0">{r.seeders}S</span>
          )}
          <button onClick={() => onGrab(r)} disabled={grabbing === r.guid || grabbed.has(r.guid)}
            className={`w-8 h-8 rounded flex items-center justify-center text-sm font-mono transition-all flex-shrink-0 border
              ${grabbed.has(r.guid)
                ? 'text-[#00D4FF] bg-[#00D4FF]/10 border-[#00D4FF]/20'
                : `${accentClass} opacity-40 hover:opacity-100 hover:bg-white/5 border-transparent`
              } disabled:opacity-30`}>
            {grabbing === r.guid ? <Spinner className="w-4 h-4" /> : grabbed.has(r.guid) ? '✓' : '↓'}
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Media Detail Layout ───────────────────────────────────────────────────────

export function DetailPage({ children }: { children: ReactNode }) {
  return <div className="space-y-8 animate-fade-in pb-20">{children}</div>
}

export function DetailHeader({ backdrop, backTo, backLabel, children }: { 
  backdrop?: string; backTo: string; backLabel: string; children: ReactNode 
}) {
  return (
    <div className="relative h-[600px] -mt-8 -mx-8 overflow-hidden">
      {backdrop && (
        <img src={backdrop} alt="" className="w-full h-full object-cover opacity-40 blur-sm" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-noir-950 via-noir-950/20 to-transparent" />
      
      <div className="absolute top-8 left-8 z-20">
        <Link to={backTo} className="px-5 py-2.5 rounded-full bg-black/40 border border-white/10 backdrop-blur-xl text-[10px] font-bold tracking-[0.2em] hover:bg-black/60 transition-all flex items-center gap-2 uppercase">
          ← {backLabel}
        </Link>
      </div>

      <div className="absolute inset-0 flex items-end p-8 lg:p-16">
        <div className="flex flex-col md:flex-row gap-12 items-end w-full max-w-[1600px] mx-auto relative z-10">
          {children}
        </div>
      </div>
    </div>
  )
}

export function DetailPoster({ src, icon, aspect = 'aspect-[2/3]' }: { src?: string; icon: string; aspect?: string }) {
  return (
    <div className={`w-56 flex-shrink-0 shadow-[0_0_50px_rgba(0,0,0,0.5)] rounded-2xl overflow-hidden border border-white/10 hidden md:block group/poster relative`}>
      {src ? (
        <img src={src} alt="" className="w-full h-full object-cover transition-transform duration-700" />
      ) : (
        <div className={`${aspect} bg-noir-800 flex items-center justify-center text-4xl opacity-20`}>{icon}</div>
      )}
    </div>
  )
}

export function DetailMain({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[1600px] mx-auto grid grid-cols-1 lg:grid-cols-3 gap-16 px-8">
      <div className="lg:col-span-2 space-y-16">
        {children}
      </div>
    </div>
  )
}

export function DetailStoryline({ title = 'Storyline', overview }: { title?: string; overview?: string }) {
  if (!overview) return null
  return (
    <section>
      <h2 className="text-[10px] font-bold text-white/20 uppercase tracking-[0.3em] mb-4">{title}</h2>
      <p className="text-base text-white/60 leading-relaxed max-w-3xl">{overview}</p>
    </section>
  )
}

export function DetailMetaItem({ label, value, color }: { label: string; value: ReactNode; color?: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-white/20">{label}</span> 
      <span className={color}>{value}</span>
    </span>
  )
}

// ── Library components ───────────────────────────────────────────────────────

// A per-item processing marker shown in the lower-right of a library card.
// `done` is the persisted "completed" state; `progress` (0..1) is live queue
// progress while the step is running. A running step shows a ring around the
// icon; a completed step shows just the icon; otherwise nothing is rendered.
export interface ProcessingMarker {
  key: string
  icon: string
  title: string
  done?: boolean
  progress?: number | null
  accent?: string
}

function ProcessingIcon({ marker }: { marker: ProcessingMarker }) {
  const processing = marker.progress != null && marker.progress < 1
  const pct = processing ? Math.max(0, Math.min(1, marker.progress as number)) : 0
  const size = 20
  const stroke = 2
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const accent = marker.accent ?? '#00D4FF'
  return (
    <span
      title={marker.title}
      className="relative inline-grid place-items-center rounded-full bg-black/45 backdrop-blur-sm"
      style={{ width: size, height: size }}
    >
      {processing && (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90">
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={accent}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - pct)}
            style={{ transition: 'stroke-dashoffset 0.4s ease' }}
          />
        </svg>
      )}
      <span className={`text-[9px] leading-none ${processing ? '' : 'opacity-85'}`} aria-hidden="true">{marker.icon}</span>
    </span>
  )
}

export function ProcessingIcons({ markers, className = '' }: { markers?: ProcessingMarker[]; className?: string }) {
  const visible = (markers ?? []).filter(marker => marker.done || (marker.progress != null && marker.progress < 1))
  if (visible.length === 0) return null
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {visible.map(marker => <ProcessingIcon key={marker.key} marker={marker} />)}
    </div>
  )
}

export function LibraryCard({ onClick, image, title, subtitle, status, badge, processing, accentColor = 'white', fallbackIcon = '🎬', aspect = 'aspect-[2/3]', selectionMode = false, selected = false, onSelect }: {
  onClick: () => void
  image?: string
  title: string
  subtitle: ReactNode
  status?: 'missing' | 'collected' | 'acquiring'
  badge?: ReactNode
  processing?: ProcessingMarker[]
  accentColor?: string
  fallbackIcon?: string
  aspect?: string
  selectionMode?: boolean
  selected?: boolean
  onSelect?: () => void
}) {
  const [isHovered, setIsHovered] = useState(false)
  const glowStyle = isHovered ? { boxShadow: `0 0 20px ${accentColor === 'white' ? 'rgba(255,255,255,0.1)' : accentColor.includes('#') ? accentColor + '26' : 'rgba(255,255,255,0.1)'}` } : {}

  const getOverlayColor = () => {
    if (status === 'missing') return 'rgba(128, 128, 128, 0.1)'
    if (status === 'acquiring') return 'rgba(191, 0, 255, 0.1)'
    if (status === 'collected') {
      // If hex, add 10% opacity (1a)
      if (accentColor.startsWith('#')) return `${accentColor}1a`
      // Fallback for named colors (simplified)
      return 'rgba(0, 255, 255, 0.1)'
    }
    return 'transparent'
  }

  const overlayColor = getOverlayColor()

  const statusLabel = status === 'missing' ? 'Missing'
                   : status === 'collected' ? 'Collected'
                   : status === 'acquiring' ? 'Acquiring'
                   : status === 'downloaded' ? 'Collected'
                   : null

  const handleClick = () => {
    if (selectionMode && onSelect) {
      onSelect()
    } else {
      onClick()
    }
  }

  return (
    <div
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={glowStyle}
      className={`group cursor-pointer rounded-xl bg-noir-800 border transition-all duration-300 overflow-hidden shadow-lg relative ${
        selected ? 'border-[#00D4FF]/50 ring-1 ring-[#00D4FF]/30' : 'border-white/5'
      }`}
    >
      <div className={`${aspect} relative overflow-hidden bg-noir-700`}>
        {image ? (
          <img src={image} alt={title} className="w-full h-full object-cover transition-transform duration-500 opacity-80 group-hover:opacity-100" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-4xl opacity-10 font-display">{fallbackIcon}</div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-noir-950/60 to-transparent" />
        {badge && (
          <div className="absolute top-2 right-2 z-10">
            {badge}
          </div>
        )}
        {/* Selection checkbox */}
        {selectionMode && (
          <div className="absolute top-2 left-2 z-10" onClick={e => { e.stopPropagation(); onSelect?.() }}>
            <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
              selected
                ? 'bg-[#00D4FF] border-[#00D4FF] text-noir-950'
                : 'border-white/30 bg-noir-950/60 hover:border-white/50'
            }`}>
              {selected && <span className="text-xs font-black">&#10003;</span>}
            </div>
          </div>
        )}
        {selected && <div className="absolute inset-0 bg-[#00D4FF]/10" />}
      </div>
      <div className="p-3 relative bg-noir-900/40 border-t border-white/5 min-h-[70px] flex flex-col justify-center">
        <div className="absolute inset-0 transition-colors duration-300" style={{ backgroundColor: overlayColor }} />
        <div className="relative z-10 pr-8">
          <h3
            className={`font-display text-[13px] tracking-wide truncate text-white transition-colors uppercase group-hover:text-white/50`}
          >
            {title}
          </h3>
          <div className="text-[10px] text-white/60 font-mono mt-0.5 truncate uppercase tracking-tight">
            {subtitle}
          </div>
          {statusLabel && (
            <div className="text-[10px] font-bold uppercase tracking-widest mt-0.5 text-white">
              {statusLabel}
            </div>
          )}
        </div>
        <ProcessingIcons markers={processing} className="absolute bottom-2 right-2 z-20" />
      </div>
    </div>
  )
}
export function CollectionFilterBar<T extends string>({ value, onChange, filters = ['all', 'missing', 'collected', 'acquiring'], accentColor = '[#00D4FF]' }: {
  value: T
  onChange: (v: T) => void
  filters?: T[]
  accentColor?: string
}) {
  const colorClass = accentColor.startsWith('[') ? `text-${accentColor}` : `text-${accentColor}`
  const bgClass = `bg-white/10`

  return (
    <div className="flex gap-1.5 p-1 bg-noir-900 border border-white/5 rounded-xl w-fit">
      {filters.map(f => (
        <button key={f} onClick={() => onChange(f)}
          className={`px-4 py-1.5 rounded-lg text-[10px] font-bold tracking-widest uppercase transition-all whitespace-nowrap ${
            value === f ? `${bgClass} ${colorClass}` : 'text-white/30 hover:text-white/60'
          }`}>
          {f}
        </button>
      ))}
    </div>
  )
}

export function SelectionBar({ totalCount, selectedCount, onSelectAll, onSelectNone, onDelete, onDone, deleting }: {
  totalCount: number
  selectedCount: number
  onSelectAll: () => void
  onSelectNone: () => void
  onDelete: () => void
  onDone: () => void
  deleting?: boolean
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-noir-900 border border-white/5 rounded-xl w-fit animate-fade-in">
      <button onClick={onSelectAll}
        className="px-3 py-1 rounded-lg text-[10px] font-bold tracking-widest uppercase text-white/40 hover:text-white/70 hover:bg-white/5 transition-all">
        Select All
      </button>
      <button onClick={onSelectNone}
        className="px-3 py-1 rounded-lg text-[10px] font-bold tracking-widest uppercase text-white/40 hover:text-white/70 hover:bg-white/5 transition-all">
        Select None
      </button>
      <div className="h-4 w-px bg-white/10" />
      <span className="text-[10px] font-mono text-white/30">
        {selectedCount} of {totalCount} selected
      </span>
      {selectedCount > 0 && (
        <>
          <div className="h-4 w-px bg-white/10" />
          <button onClick={onDelete} disabled={deleting}
            className="px-4 py-1.5 rounded-lg text-[10px] font-bold tracking-widest uppercase bg-red-500/10 border border-red-500/20 text-red-500 hover:bg-red-500/20 transition-all disabled:opacity-40">
            {deleting ? 'Deleting...' : `Delete ${selectedCount}`}
          </button>
        </>
      )}
      <div className="h-4 w-px bg-white/10" />
      <button onClick={onDone}
        className="px-3 py-1 rounded-lg text-[10px] font-bold tracking-widest uppercase text-white/40 hover:text-white/70 hover:bg-white/5 transition-all">
        Done
      </button>
    </div>
  )
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  wanted:      'text-[#FF2D78]',
  missing:     'text-[#FF2D78]',
  downloading: 'text-[#9B59B6]',
  downloaded:  'text-[#00D4FF]',
  ignored:     'text-white/20',
  unaired:     'text-white/20',
  continuing:  'text-[#00D4FF]',
  ended:       'text-white/40',
  upcoming:    'text-[#9B59B6]',
}

const STATUS_LABELS: Record<string, string> = {
  wanted:      'Missing',
  missing:     'Missing',
  downloading: 'Acquiring',
  downloaded:  'In Library',
  ignored:     'Ignored',
  unaired:     'Unaired',
  continuing:  'Continuing',
  ended:       'Ended',
  upcoming:    'Upcoming',
}

export function StatusBadge({ status, progress, className = '' }: { status: string; progress?: number; className?: string }) {
  const label = STATUS_LABELS[status] ?? status
  const displayLabel = (status === 'downloading' && progress != null)
    ? `${label} - ${Math.round(progress * 100)}%`
    : label

  return (
    <span className={`text-[10px] font-display uppercase tracking-widest font-medium ${STATUS_STYLES[status] || 'text-white/20'} ${className}`}>
      {displayLabel}
    </span>
  )
}

// ── Search input ──────────────────────────────────────────────────────────────

export function SearchInput({ value, onChange, placeholder, className = '' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string
}) {
  return (
    <div className={`relative ${className}`}>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20 text-sm">◈</span>
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder ?? 'Search...'}
        className="w-full pl-9 pr-4 py-2.5 rounded-lg bg-noir-800 border border-white/10 text-white/80
          placeholder-white/20 text-sm focus:outline-none focus:border-white/25 transition-all" />
    </div>
  )
}

// ── Skeleton loader ───────────────────────────────────────────────────────────

export function PosterSkeleton({ count = 12, cols = 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6' }: {
  count?: number; cols?: string
}) {
  return (
    <div className={`grid ${cols} gap-3`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="aspect-[2/3] rounded-xl bg-noir-800 poster-shimmer" />
      ))}
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

export function EmptyState({ icon, title, subtitle, action }: {
  icon: string; title: string; subtitle?: string; action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="text-6xl mb-4 opacity-10">{icon}</div>
      <p className="font-display text-2xl tracking-widest text-white/20">{title}</p>
      {subtitle && <p className="text-white/20 text-sm mt-2 font-mono">{subtitle}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
