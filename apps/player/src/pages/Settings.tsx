import { useState } from 'react'
import type { ArchivistSdk } from '../lib/sdk.js'
import {
  useSettings, updateSettings, DEFAULT_RAILS, RAIL_SOURCES, RAIL_STYLES,
  type RailConfig, type RailSource, type RailStyle,
} from '../lib/store.js'

/**
 * Player customization — Arctic Fuse-style component setup within the one
 * locked Archivist look: home rails (source × style, reorder, toggle),
 * library defaults, and the server connection.
 */
export function SettingsPage({ sdk: _sdk }: { sdk: ArchivistSdk }) {
  const settings = useSettings()
  const [rails, setRails] = useState<RailConfig[]>(settings.rails)

  const commit = (next: RailConfig[]) => { setRails(next); updateSettings({ rails: next }) }

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rails.length) return
    const next = [...rails]
    ;[next[i], next[j]] = [next[j], next[i]]
    commit(next)
  }
  const patch = (i: number, p: Partial<RailConfig>) => {
    const next = rails.map((r, idx) => idx === i ? { ...r, ...p } : r)
    // Keep the title in sync with the source unless the user has customized it.
    if (p.source && RAIL_SOURCES[rails[i].source] === rails[i].title) next[i].title = RAIL_SOURCES[p.source]
    commit(next)
  }
  const addRail = () => commit([...rails, {
    id: `r-${Date.now()}`, source: 'recent-films', style: 'poster',
    title: RAIL_SOURCES['recent-films'], limit: 12, enabled: true,
  }])
  const removeRail = (i: number) => commit(rails.filter((_, idx) => idx !== i))

  const sel = 'px-2 py-1.5 rounded-lg bg-noir-950 border border-white/10 text-xs text-white focus:border-cyan/40 focus:outline-none'

  return (
    <div className="px-5 pb-16 max-w-3xl animate-fade-in">
      <h1 className="text-2xl font-semibold tracking-tight text-white py-4">Settings</h1>

      {/* Home rails editor */}
      <section className="rounded-2xl bg-noir-900 border border-white/5 p-5 mb-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[11px] font-mono text-white/40 uppercase tracking-[0.25em]">Home Screen</h2>
          <div className="flex gap-3">
            <button onClick={() => commit(DEFAULT_RAILS)} className="text-[10px] font-bold uppercase tracking-widest text-white/30 hover:text-white">Reset</button>
            <button onClick={addRail} className="text-[10px] font-bold uppercase tracking-widest text-cyan/80 hover:text-cyan">+ Add rail</button>
          </div>
        </div>
        <p className="text-xs text-white/30 mb-4">Compose your home screen: each rail is a content source in a display style. Reorder, restyle, or switch any of them off.</p>
        <div className="space-y-2">
          {rails.map((r, i) => (
            <div key={r.id} className={`flex flex-wrap items-center gap-2 px-3 py-2.5 rounded-xl border ${r.enabled ? 'bg-noir-950 border-white/10' : 'bg-noir-950/40 border-white/5 opacity-50'}`}>
              <div className="flex flex-col gap-0.5">
                <button onClick={() => move(i, -1)} className="text-white/25 hover:text-white text-[9px] leading-none">▲</button>
                <button onClick={() => move(i, 1)} className="text-white/25 hover:text-white text-[9px] leading-none">▼</button>
              </div>
              <input value={r.title} onChange={e => patch(i, { title: e.target.value })}
                className={`${sel} w-44 font-semibold`} />
              <select value={r.source} onChange={e => patch(i, { source: e.target.value as RailSource })} className={sel}>
                {Object.entries(RAIL_SOURCES).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
              <select value={r.style} onChange={e => patch(i, { style: e.target.value as RailStyle })} className={sel}>
                {Object.entries(RAIL_STYLES).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
              <select value={r.limit} onChange={e => patch(i, { limit: Number(e.target.value) })} className={sel}>
                {[6, 12, 18, 24].map(n => <option key={n} value={n}>{n} items</option>)}
              </select>
              <div className="ml-auto flex items-center gap-3">
                <button onClick={() => patch(i, { enabled: !r.enabled })}
                  className={`text-[10px] font-bold uppercase tracking-widest ${r.enabled ? 'text-cyan' : 'text-white/25'}`}>
                  {r.enabled ? 'On' : 'Off'}
                </button>
                <button onClick={() => removeRail(i)} className="text-white/20 hover:text-pink text-xs">✕</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Library prefs */}
      <section className="rounded-2xl bg-noir-900 border border-white/5 p-5 mb-5">
        <h2 className="text-[11px] font-mono text-white/40 uppercase tracking-[0.25em] mb-4">Library</h2>
        <div className="flex items-center justify-between py-2">
          <div>
            <p className="text-sm text-white/80">Hide unavailable items</p>
            <p className="text-xs text-white/30">Only show media that is downloaded and playable.</p>
          </div>
          <button onClick={() => updateSettings({ hideUnavailable: !settings.hideUnavailable })}
            className={`w-11 h-6 rounded-full transition-colors relative ${settings.hideUnavailable ? 'bg-cyan' : 'bg-white/10'}`}>
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${settings.hideUnavailable ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </div>
      </section>

      {/* Audio */}
      <section className="rounded-2xl bg-noir-900 border border-white/5 p-5 mb-5">
        <h2 className="text-[11px] font-mono text-white/40 uppercase tracking-[0.25em] mb-4">Audio</h2>
        <div className="flex items-center justify-between py-2">
          <div>
            <p className="text-sm text-white/80">Normalize loudness</p>
            <p className="text-xs text-white/30">Even out volume across films and episodes (EBU R128), so you don't adjust between titles.</p>
          </div>
          <button onClick={() => updateSettings({ normalizeVolume: !settings.normalizeVolume })}
            className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${settings.normalizeVolume ? 'bg-cyan' : 'bg-white/10'}`}>
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${settings.normalizeVolume ? 'left-[22px]' : 'left-0.5'}`} />
          </button>
        </div>
        {settings.normalizeVolume && (
          <div className="flex items-center justify-between py-2 border-t border-white/5 mt-2">
            <div>
              <p className="text-sm text-white/80">Target level</p>
              <p className="text-xs text-white/30">Higher = louder. −16 LUFS suits most setups; −23 is broadcast reference.</p>
            </div>
            <div className="flex gap-1.5">
              {[[-14, 'Loud'], [-16, 'Standard'], [-18, 'Quiet'], [-23, 'Reference']].map(([v, label]) => (
                <button key={v} onClick={() => updateSettings({ loudnessTarget: v as number })}
                  className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider border transition-all
                    ${settings.loudnessTarget === v ? 'bg-cyan/15 border-cyan/60 text-cyan' : 'bg-white/5 border-white/10 text-white/40 hover:text-white/70'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

    </div>
  )
}
