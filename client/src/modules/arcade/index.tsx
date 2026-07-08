import { useEffect, useMemo, useState } from 'react'
import { arcadeApi, type ArcadeSystem, type ArcadeRom } from '../../lib/arcade.api.js'

const ICONS: Record<string, string> = {
  nes: '🎮', snes: '🎮', gameboy: '🕹️', mastersystem: '🎯', genesis: '🦔', n64: '🌟', psx: '💿', saturn: '🪐',
}
const ACCENTS: Record<string, string> = {
  nes: '#E74C3C', snes: '#9B59B6', gameboy: '#2ECC71', mastersystem: '#3498DB',
  genesis: '#00D4FF', n64: '#F1C40F', psx: '#95A5A6', saturn: '#E67E22',
}

export function Arcade({ onClose }: { onClose: () => void }) {
  const [systems, setSystems] = useState<ArcadeSystem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [playing, setPlaying] = useState<{ system: ArcadeSystem; rom: ArcadeRom } | null>(null)

  const load = () => {
    setSystems(null); setError(null)
    arcadeApi.library().then(d => setSystems(d.systems)).catch(e => setError(String(e)))
  }
  useEffect(load, [])

  const active = useMemo(() => systems?.find(s => s.id === activeId) ?? null, [systems, activeId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (playing) setPlaying(null)
      else if (activeId) setActiveId(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playing, activeId, onClose])

  const playSrc = playing
    ? `/emu.html?core=${encodeURIComponent(playing.system.core)}&rom=${encodeURIComponent(playing.rom.url)}&name=${encodeURIComponent(playing.rom.name)}${playing.system.biosUrl ? `&bios=${encodeURIComponent(playing.system.biosUrl)}` : ''}`
    : ''

  return (
    <div className="fixed inset-0 z-[300] bg-noir-950 flex flex-col animate-fade-in"
      style={{ backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.015) 0 1px, transparent 1px 3px)' }}>
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-white/5 shrink-0">
        <span className="font-display text-2xl tracking-[0.25em] text-[#00D4FF] uppercase" style={{ textShadow: '0 0 18px rgba(0,212,255,0.5)' }}>Arcade</span>
        <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-widest text-white/30">
          {active && <><span>/</span><button onClick={() => { setActiveId(null); setPlaying(null) }} className="hover:text-white/70">{active.label}</button></>}
          {playing && <><span>/</span><span className="text-white/50">{playing.rom.name}</span></>}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {playing && <button onClick={() => setPlaying(null)} className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white text-[10px] font-bold uppercase tracking-widest">← Exit game</button>}
          {!playing && active && <button onClick={() => setActiveId(null)} className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white text-[10px] font-bold uppercase tracking-widest">← Systems</button>}
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-white/5 hover:bg-white/10 text-white/40 hover:text-white flex items-center justify-center">✕</button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {error ? (
          <div className="p-12 text-center text-red-400 text-sm">{error}</div>
        ) : !systems ? (
          <div className="p-16 text-center text-white/30 text-[11px] font-mono uppercase tracking-[0.3em] animate-pulse">Loading…</div>
        ) : playing ? (
          <iframe key={playSrc} src={playSrc} title="Arcade" className="w-full h-full border-0" allow="fullscreen; gamepad; autoplay" />
        ) : active ? (
          <SystemGames system={active} onPlay={rom => setPlaying({ system: active, rom })} onRefresh={load} />
        ) : (
          <SystemShelf systems={systems} onPick={setActiveId} />
        )}
      </div>
    </div>
  )
}

function SystemShelf({ systems, onPick }: { systems: ArcadeSystem[]; onPick: (id: string) => void }) {
  return (
    <div className="max-w-5xl mx-auto p-8">
      <p className="text-xs text-white/30 font-mono mb-8">Pick a system. Drop your own ROMs into each system's folder under <span className="text-white/50">media/roms/</span> — nothing is bundled.</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {systems.map(s => (
          <button key={s.id} onClick={() => onPick(s.id)}
            className="group p-6 rounded-2xl bg-noir-900 border border-white/5 hover:border-white/20 transition-all text-left"
            style={{ boxShadow: s.roms.length ? `0 0 24px ${ACCENTS[s.id]}18` : undefined }}>
            <div className="text-4xl mb-3">{ICONS[s.id] ?? '🎮'}</div>
            <div className="text-sm font-bold text-white">{s.label}</div>
            <div className="text-[10px] font-mono uppercase tracking-widest mt-1" style={{ color: ACCENTS[s.id] }}>
              {s.roms.length} {s.roms.length === 1 ? 'game' : 'games'}
            </div>
            {s.bios && <div className="text-[9px] font-mono text-amber-400/60 mt-1">BIOS required</div>}
          </button>
        ))}
      </div>
    </div>
  )
}

function SystemGames({ system, onPlay, onRefresh }: { system: ArcadeSystem; onPlay: (rom: ArcadeRom) => void; onRefresh: () => void }) {
  const biosBlocked = system.bios && !system.biosReady
  return (
    <div className="max-w-5xl mx-auto p-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{ICONS[system.id] ?? '🎮'}</span>
          <div>
            <h2 className="text-xl font-bold text-white">{system.label}</h2>
            <p className="text-[10px] font-mono text-white/25">{system.folder}</p>
          </div>
        </div>
        <button onClick={onRefresh} className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/50 hover:text-white text-[10px] font-bold uppercase tracking-widest">↻ Refresh</button>
      </div>

      {biosBlocked && (
        <div className="mb-5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-xs text-amber-200/80">
          {system.label} needs a BIOS. Drop a BIOS file into <span className="font-mono text-amber-200">{system.folder}/bios/</span>, then Refresh. {system.disc && 'Disc games play best as single-file .chd images.'}
        </div>
      )}

      {system.roms.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center">
          <p className="text-sm text-white/50 mb-1">No games here yet.</p>
          <p className="text-[11px] font-mono text-white/30">Copy your ROMs into <span className="text-white/50">{system.folder}</span> and hit Refresh.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {system.roms.map(rom => (
            <button key={rom.file} onClick={() => onPlay(rom)}
              className="flex items-center gap-3 px-4 py-3 rounded-xl bg-noir-900 border border-white/5 hover:border-white/20 hover:bg-white/[0.04] transition-all text-left">
              <span className="w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0" style={{ background: `${ACCENTS[system.id]}22`, color: ACCENTS[system.id] }}>▶</span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-white/85 truncate">{rom.name}</span>
                <span className="block text-[10px] font-mono text-white/25">{(rom.size / 1048576).toFixed(1)} MB</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
