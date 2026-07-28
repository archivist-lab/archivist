import { useEffect, useMemo, useState } from 'react'
import type { ArchivistSdk, ArcadeRom, ArcadeSystem } from '../lib/sdk.js'

/**
 * Retro arcade — reached only by the Konami code in the Player.
 *
 * ROMs are user-supplied and live in media/roms/<system>/; nothing copyrighted
 * ships with Archivist. Emulation runs in the browser via the self-hosted
 * EmulatorJS cores served from this same origin, driven through an iframe so
 * switching games is just a new URL with no global state to unwind.
 *
 * Rendered above the focus layer: it takes over the screen and handles its own
 * keys, so the shell's spatial navigation is inert while it is open.
 */

const ICONS: Record<string, string> = {
  nes: '🎮', snes: '🎮', gameboy: '🕹️', mastersystem: '🎯', genesis: '🦔', n64: '🌟', psx: '💿', saturn: '🪐',
}
const ACCENTS: Record<string, string> = {
  nes: '#E74C3C', snes: '#9B59B6', gameboy: '#2ECC71', mastersystem: '#3498DB',
  genesis: '#00D4FF', n64: '#F1C40F', psx: '#95A5A6', saturn: '#E67E22',
}

export function Arcade({ sdk, onClose }: { sdk: ArchivistSdk; onClose: () => void }) {
  const [systems, setSystems] = useState<ArcadeSystem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [playing, setPlaying] = useState<{ system: ArcadeSystem; rom: ArcadeRom } | null>(null)

  const load = () => {
    setSystems(null); setError(null)
    sdk.arcadeLibrary().then(d => setSystems(d.systems)).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const active = useMemo(() => systems?.find(s => s.id === activeId) ?? null, [systems, activeId])

  // Back/Escape unwinds one level at a time. Capture phase and stopPropagation
  // keep the shell's own Escape handler (which navigates back) from firing too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Backspace' && e.key !== 'BrowserBack') return
      e.preventDefault()
      e.stopPropagation()
      if (playing) setPlaying(null)
      else if (activeId) setActiveId(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [playing, activeId, onClose])

  const playSrc = playing
    ? `/emu.html?core=${encodeURIComponent(playing.system.core)}&rom=${encodeURIComponent(sdk.asset(playing.rom.url, true))}&name=${encodeURIComponent(playing.rom.name)}${playing.system.biosUrl ? `&bios=${encodeURIComponent(sdk.asset(playing.system.biosUrl, true))}` : ''}`
    : ''

  return (
    <div className="player-v2 fixed inset-0 z-[300] flex flex-col bg-black"
      style={{ backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.015) 0 1px, transparent 1px 3px)' }}>
      <div className="flex shrink-0 items-center gap-4 border-b border-white/5 px-6 py-4">
        <span className="font-display text-2xl uppercase tracking-[0.25em] text-[#00D4FF]" style={{ textShadow: '0 0 18px rgba(0,212,255,0.5)' }}>Arcade</span>
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-white/30">
          {active && <><span>/</span><button onClick={() => { setActiveId(null); setPlaying(null) }} className="hover:text-white/70">{active.label}</button></>}
          {playing && <><span>/</span><span className="text-white/50">{playing.rom.name}</span></>}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {playing && <button onClick={() => setPlaying(null)} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-white/60 hover:text-white">← Exit game</button>}
          {!playing && active && <button onClick={() => setActiveId(null)} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-white/60 hover:text-white">← Systems</button>}
          <button onClick={onClose} aria-label="Close arcade" className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-white/40 hover:bg-white/10 hover:text-white">✕</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="p-12 text-center text-sm text-red-400">{error}</div>
        ) : !systems ? (
          <div className="p-16 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-white/30">Loading…</div>
        ) : playing ? (
          <iframe key={playSrc} src={playSrc} title="Arcade" className="h-full w-full border-0" allow="fullscreen; gamepad; autoplay" />
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
    <div className="mx-auto max-w-5xl p-8">
      <p className="mb-8 font-mono text-xs text-white/30">Pick a system. Drop your own ROMs into each system's folder under <span className="text-white/50">media/roms/</span> — nothing is bundled.</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {systems.map(s => (
          <button key={s.id} onClick={() => onPick(s.id)}
            className="group rounded-2xl border border-white/5 bg-white/[0.03] p-6 text-left transition-all hover:border-white/20"
            style={{ boxShadow: s.roms.length ? `0 0 24px ${ACCENTS[s.id]}18` : undefined }}>
            <div className="mb-3 text-4xl">{ICONS[s.id] ?? '🎮'}</div>
            <div className="text-sm font-bold text-white">{s.label}</div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-widest" style={{ color: ACCENTS[s.id] }}>
              {s.roms.length} {s.roms.length === 1 ? 'game' : 'games'}
            </div>
            {s.bios && <div className="mt-1 font-mono text-[9px] text-amber-400/60">BIOS required</div>}
          </button>
        ))}
      </div>
    </div>
  )
}

function SystemGames({ system, onPlay, onRefresh }: { system: ArcadeSystem; onPlay: (rom: ArcadeRom) => void; onRefresh: () => void }) {
  const biosBlocked = system.bios && !system.biosReady
  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{ICONS[system.id] ?? '🎮'}</span>
          <div>
            <h2 className="text-xl font-bold text-white">{system.label}</h2>
            <p className="font-mono text-[10px] text-white/25">{system.folder}</p>
          </div>
        </div>
        <button onClick={onRefresh} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-white/50 hover:text-white">↻ Refresh</button>
      </div>

      {biosBlocked && (
        <div className="mb-5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-xs text-amber-200/80">
          {system.label} needs a BIOS. Drop a BIOS file into <span className="font-mono text-amber-200">{system.folder}/bios/</span>, then Refresh. {system.disc && 'Disc games play best as single-file .chd images.'}
        </div>
      )}

      {system.roms.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-12 text-center">
          <p className="mb-1 text-sm text-white/50">No games here yet.</p>
          <p className="font-mono text-[11px] text-white/30">Copy your ROMs into <span className="text-white/50">{system.folder}</span> and hit Refresh.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {system.roms.map(rom => (
            <button key={rom.file} onClick={() => onPlay(rom)}
              className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-left transition-all hover:border-white/20 hover:bg-white/[0.07]">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm" style={{ background: `${ACCENTS[system.id]}22`, color: ACCENTS[system.id] }}>▶</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-white/85">{rom.name}</span>
                <span className="block font-mono text-[10px] text-white/25">{(rom.size / 1048576).toFixed(1)} MB</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
