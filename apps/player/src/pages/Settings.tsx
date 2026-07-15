import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { PlayerPreferencesV1, PlayerPreset, PlayerView, PlayerWidgetLimit, PlayerWidgetSource } from '@archivist/contracts'
import { PlayerSdkError, type ArchivistSdk } from '../lib/sdk.js'
import {
  useSettings, updateSettings, DEFAULT_RAILS, RAIL_SOURCES, RAIL_STYLES,
  type RailConfig, type RailSource, type RailStyle,
} from '../lib/store.js'
import { playerStore, usePlayerSelector } from '../lib/store.js'
import { applyPreset, isPreferencesDirty } from '../lib/preferences.js'
import { useFocusable } from '../focus/FocusProvider.js'

export function SettingsPage({ sdk, v2 = false }: { sdk: ArchivistSdk; v2?: boolean }) {
  return v2 ? <LivingRoomSettings sdk={sdk} /> : <LegacySettings sdk={sdk} />
}

function LivingRoomSettings({ sdk }: { sdk: ArchivistSdk }) {
  const saved = usePlayerSelector(state => state.preferences)
  const storeDraft = usePlayerSelector(state => state.draft)
  const telemetryEnabled = usePlayerSelector(state => !!state.bootstrap?.featureFlags.telemetryEnabled)
  const [draft, setDraft] = useState<PlayerPreferencesV1 | null>(storeDraft)
  const [section, setSection] = useState('Interface')
  const [message, setMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState<PlayerSdkError | null>(null)
  const [resetConfirm, setResetConfirm] = useState(false)
  const pendingNavigation = usePlayerSelector(state => state.pendingNavigation)
  const navigate = useNavigate()
  useEffect(() => { if (storeDraft) setDraft(structuredClone(storeDraft)) }, [storeDraft])
  const dirty = !!saved && !!draft && isPreferencesDirty(saved.preferences, draft)
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    addEventListener('beforeunload', before)
    return () => removeEventListener('beforeunload', before)
  }, [dirty])
  if (!saved || !draft) return <div className="player-safe player-skeleton">Loading settings</div>

  const update = (next: PlayerPreferencesV1) => { setDraft(next); playerStore.dispatch({ type: 'PREFERENCES_DRAFTED', preferences: next }) }
  const save = async (expectedRevision = saved.revision): Promise<boolean> => {
    try {
      const envelope = await sdk.updatePreferences({ profileId: 'default', expectedRevision, preferences: draft })
      playerStore.dispatch({ type: 'PREFERENCES_SAVED', envelope }); setMessage('Settings saved'); setConflict(null)
      window.setTimeout(() => setMessage(null), 3000)
      return true
    } catch (reason) {
      if (reason instanceof PlayerSdkError && reason.code === 'PLAYER_PREFERENCES_CONFLICT') setConflict(reason)
      else setMessage(reason instanceof Error ? reason.message : String(reason))
      return false
    }
  }
  const leave = () => {
    if (!pendingNavigation) return
    const target = pendingNavigation
    playerStore.dispatch({ type: 'NAVIGATION_CLEARED' })
    if (target === '__back__') navigate(-1)
    else navigate(target)
  }
  const reset = async () => {
    try {
      const envelope = await sdk.resetPreferences({ profileId: 'default', expectedRevision: saved.revision })
      playerStore.dispatch({ type: 'PREFERENCES_SAVED', envelope }); setDraft(structuredClone(envelope.preferences)); setResetConfirm(false); setMessage('Settings reset')
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)) }
  }
  const sections = ['Interface', 'Home', 'Library', 'Playback', 'Accessibility', 'About']
  return <div className="h-full overflow-y-auto no-scrollbar player-safe">
    <div className="flex items-start gap-10">
      <aside className="w-52 shrink-0"><h1 className="mb-6 text-4xl font-semibold">Settings</h1><nav className="space-y-2">{sections.map(name => <SettingButton key={name} id={`settings-section-${name}`} label={name} active={section === name} onPress={() => setSection(name)} />)}</nav></aside>
      <section className="min-w-0 max-w-4xl flex-1 rounded-3xl bg-black/30 p-8 ring-1 ring-white/10">
        <h2 className="mb-2 text-3xl font-semibold">{section}</h2>
        {section === 'Interface' && <div><p className="mb-6 text-white/50">Choose a complete living-room composition. Your library, playback and accessibility preferences are preserved.</p><div className="grid grid-cols-2 gap-4">{(['classic', 'categories', 'compound', 'combined'] as PlayerPreset[]).map(preset => <button key={preset} onClick={() => update(applyPreset(draft, preset))} className={`player-focusable rounded-2xl border p-5 text-left capitalize ${draft.preset === preset ? 'border-cyan bg-cyan/10' : 'border-white/10 bg-white/5'}`}><div className="mb-4 h-24 rounded-lg bg-gradient-to-br from-white/15 to-white/3 p-3"><div className="h-full w-2/3 rounded bg-white/10" /></div><strong>{preset}</strong></button>)}</div></div>}
        {section === 'Home' && <WidgetEditor draft={draft} update={update} />}
        {section === 'Library' && <LibrarySettings draft={draft} update={update} />}
        {section === 'Playback' && <PlaybackSettings draft={draft} update={update} />}
        {section === 'Accessibility' && <AccessibilitySettings draft={draft} update={update} />}
        {section === 'About' && <div className="space-y-3 text-white/55"><p>Archivist Player Living-Room UI v2</p><p>Local performance telemetry: {telemetryEnabled ? 'On' : 'Off'}</p><p>Performance samples remain on this Archivist server until it restarts.</p></div>}
        <div className="mt-10 flex gap-3 border-t border-white/10 pt-6"><button onClick={() => void save()} disabled={!dirty} className="player-focusable rounded-full bg-white px-7 py-3 font-bold text-black disabled:opacity-30">Save</button><button onClick={() => { setDraft(structuredClone(saved.preferences)); playerStore.dispatch({ type: 'PREFERENCES_DRAFTED', preferences: saved.preferences }) }} disabled={!dirty} className="player-focusable rounded-full bg-white/8 px-7 py-3 font-bold disabled:opacity-30">Discard</button><button onClick={() => setResetConfirm(true)} className="player-focusable ml-auto rounded-full px-7 py-3 text-pink">Reset</button></div>
      </section>
    </div>
    {message && <div role="status" className="fixed bottom-8 right-8 rounded-xl bg-white px-5 py-3 text-black shadow-2xl">{message}</div>}
    {resetConfirm && <Dialog title="Reset Player settings?" text="This keeps playback progress and search history." onCancel={() => setResetConfirm(false)} onConfirm={() => void reset()} confirm="Reset" />}
    {conflict && <Dialog title="Settings changed elsewhere" text="Reload the server copy or overwrite it with this draft." onCancel={() => { if (conflict.current) { playerStore.dispatch({ type: 'PREFERENCES_SAVED', envelope: conflict.current }); setDraft(structuredClone(conflict.current.preferences)) } setConflict(null); if (pendingNavigation) leave() }} onConfirm={() => void save(conflict.current?.revision).then(ok => { if (ok && pendingNavigation) leave() })} confirm="Overwrite" cancel="Reload" />}
    {pendingNavigation && !conflict && <Dialog title="Save changes before leaving?" text="Your Player settings have unsaved changes." onCancel={() => playerStore.dispatch({ type: 'NAVIGATION_CLEARED' })} onMiddle={() => { setDraft(structuredClone(saved.preferences)); playerStore.dispatch({ type: 'PREFERENCES_DRAFTED', preferences: saved.preferences }); leave() }} middle="Discard" onConfirm={() => void save().then(ok => { if (ok) leave() })} confirm="Save" />}
  </div>
}

function SettingButton({ id, label, active, onPress }: { id: string; label: string; active?: boolean; onPress: () => void }) {
  const focusable = useFocusable({ id, zoneId: 'settings-nav', onActivate: onPress })
  return <button {...focusable} className={`player-focusable w-full rounded-xl px-4 py-3 text-left ${active ? 'bg-white text-black' : 'text-white/55 hover:bg-white/5'}`}>{label}</button>
}

function WidgetEditor({ draft, update }: { draft: PlayerPreferencesV1; update: (next: PlayerPreferencesV1) => void }) {
  const patch = (index: number, values: Partial<PlayerPreferencesV1['home']['widgets'][number]>) => update({ ...draft, home: { ...draft.home, widgets: draft.home.widgets.map((widget, i) => i === index ? { ...widget, ...values } : widget) } })
  const move = (index: number, offset: number) => { const target = index + offset; if (target < 0 || target >= draft.home.widgets.length) return; const widgets = [...draft.home.widgets]; [widgets[index], widgets[target]] = [widgets[target], widgets[index]]; update({ ...draft, home: { ...draft.home, widgets } }) }
  return <div className="space-y-3">{draft.home.widgets.map((widget, index) => <div key={widget.id} className="rounded-2xl border border-white/10 bg-white/4 p-4"><div className="flex items-center gap-3"><input value={widget.title} maxLength={48} onChange={event => patch(index, { title: event.target.value })} className="min-w-0 flex-1 rounded-lg bg-black/30 px-3 py-2" /><select value={widget.source} onChange={event => patch(index, { source: event.target.value as PlayerWidgetSource })} className="rounded-lg bg-noir-800 px-3 py-2">{['continue','recent-films','recent-episodes','downloading','unwatched-films','films-az','series-az'].map(source => <option key={source}>{source}</option>)}</select><select value={widget.view} onChange={event => patch(index, { view: event.target.value as PlayerView })} className="rounded-lg bg-noir-800 px-3 py-2">{['poster','landscape','wall','list'].map(view => <option key={view}>{view}</option>)}</select><select value={widget.limit} onChange={event => patch(index, { limit: Number(event.target.value) as PlayerWidgetLimit })} className="rounded-lg bg-noir-800 px-3 py-2">{[6,12,18,24,36,60].map(value => <option key={value}>{value}</option>)}</select></div><div className="mt-3 flex gap-2"><button onClick={() => move(index,-1)} className="player-focusable rounded-lg bg-white/8 px-3 py-2">Move up</button><button onClick={() => move(index,1)} className="player-focusable rounded-lg bg-white/8 px-3 py-2">Move down</button><button onClick={() => patch(index,{enabled:!widget.enabled})} className="player-focusable ml-auto rounded-lg bg-white/8 px-3 py-2">{widget.enabled ? 'Enabled' : 'Disabled'}</button></div></div>)}</div>
}

function LibrarySettings({ draft, update }: { draft: PlayerPreferencesV1; update: (next: PlayerPreferencesV1) => void }) {
  return <div className="space-y-5">{(['films','series'] as const).map(kind => <div key={kind} className="flex items-center gap-4 rounded-2xl bg-white/5 p-5 capitalize"><strong className="w-24">{kind}</strong><label className="flex items-center gap-2 text-sm text-white/55">View<select aria-label={`${kind} view`} value={draft.libraries[kind].view} onChange={event => update({ ...draft, libraries: { ...draft.libraries, [kind]: { ...draft.libraries[kind], view: event.target.value as PlayerView } } })} className="rounded-lg bg-noir-800 px-3 py-2 text-white">{['poster','landscape','wall','list'].map(view => <option key={view}>{view}</option>)}</select></label><label className="flex items-center gap-2 text-sm text-white/55">Sort<select aria-label={`${kind} sort`} value={draft.libraries[kind].sort} onChange={event => update({ ...draft, libraries: { ...draft.libraries, [kind]: { ...draft.libraries[kind], sort: event.target.value as PlayerPreferencesV1['libraries'][typeof kind]['sort'] } } })} className="rounded-lg bg-noir-800 px-3 py-2 text-white">{['title','added','year','rating'].map(sort => <option key={sort}>{sort}</option>)}</select></label><button onClick={() => update({ ...draft, libraries: { ...draft.libraries, [kind]: { ...draft.libraries[kind], hideUnavailable: !draft.libraries[kind].hideUnavailable } } })} className="player-focusable rounded-full bg-white/8 px-4 py-2">Hide unavailable: {draft.libraries[kind].hideUnavailable ? 'On' : 'Off'}</button></div>)}</div>
}

function PlaybackSettings({ draft, update }: { draft: PlayerPreferencesV1; update: (next: PlayerPreferencesV1) => void }) {
  const language = (value: string) => value.trim() ? value.trim().toLowerCase() : null
  return <div className="space-y-6">
    <div><button onClick={() => update({ ...draft, playback: { ...draft.playback, normalizeVolume: !draft.playback.normalizeVolume } })} className="player-focusable rounded-full bg-white/8 px-5 py-3">Normalize loudness: {draft.playback.normalizeVolume ? 'On' : 'Off'}</button><div className="mt-3 flex gap-2">{([-14,-16,-18,-23] as const).map(value => <button key={value} onClick={() => update({ ...draft, playback: { ...draft.playback, targetLufs: value } })} className={`player-focusable rounded-full px-4 py-2 ${draft.playback.targetLufs === value ? 'bg-white text-black' : 'bg-white/8'}`}>{value} LUFS</button>)}</div></div>
    <div className="grid grid-cols-2 gap-4"><label className="text-sm text-white/55">Preferred audio language<input aria-label="Preferred audio language" value={draft.playback.preferredAudioLanguage ?? ''} maxLength={16} placeholder="en" onChange={event => update({ ...draft, playback: { ...draft.playback, preferredAudioLanguage: language(event.target.value) } })} className="player-focusable mt-2 w-full rounded-lg bg-noir-800 px-4 py-3 text-white" /></label><label className="text-sm text-white/55">Preferred subtitle language<input aria-label="Preferred subtitle language" value={draft.playback.preferredSubtitleLanguage ?? ''} maxLength={16} placeholder="en" onChange={event => update({ ...draft, playback: { ...draft.playback, preferredSubtitleLanguage: language(event.target.value) } })} className="player-focusable mt-2 w-full rounded-lg bg-noir-800 px-4 py-3 text-white" /></label></div>
    <div><p className="mb-3 text-sm text-white/55">Subtitles on startup</p><div className="flex gap-2">{(['off','forced','preferred'] as const).map(value => <button key={value} onClick={() => update({ ...draft, playback: { ...draft.playback, subtitles: value } })} className={`player-focusable rounded-full px-4 py-2 capitalize ${draft.playback.subtitles === value ? 'bg-white text-black' : 'bg-white/8'}`}>{value}</button>)}</div></div>
  </div>
}

function AccessibilitySettings({ draft, update }: { draft: PlayerPreferencesV1; update: (next: PlayerPreferencesV1) => void }) {
  return <div className="space-y-5"><div className="flex gap-2">{(['system','on','off'] as const).map(value => <button key={value} onClick={() => update({ ...draft, accessibility: { ...draft.accessibility, reducedMotion: value } })} className={`player-focusable rounded-full px-4 py-2 capitalize ${draft.accessibility.reducedMotion === value ? 'bg-white text-black' : 'bg-white/8'}`}>Motion {value}</button>)}</div><div className="flex gap-2">{([1,1.15,1.3] as const).map(value => <button key={value} onClick={() => update({ ...draft, accessibility: { ...draft.accessibility, textScale: value } })} className={`player-focusable rounded-full px-4 py-2 ${draft.accessibility.textScale === value ? 'bg-white text-black' : 'bg-white/8'}`}>{Math.round(value*100)}%</button>)}</div><button onClick={() => update({ ...draft, accessibility: { ...draft.accessibility, highContrast: !draft.accessibility.highContrast } })} className="player-focusable rounded-full bg-white/8 px-5 py-3">High contrast: {draft.accessibility.highContrast ? 'On' : 'Off'}</button></div>
}

function Dialog({ title, text, onCancel, onConfirm, confirm, cancel = 'Cancel', onMiddle, middle }: { title: string; text: string; onCancel: () => void; onConfirm: () => void; confirm: string; cancel?: string; onMiddle?: () => void; middle?: string }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const origin = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    const buttons = () => Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    buttons()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); requestAnimationFrame(() => origin.current?.focus()); return }
      if (event.key !== 'Tab') return
      const items = buttons(); if (!items.length) { event.preventDefault(); return }
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [onCancel])
  return <div ref={dialogRef} className="fixed inset-0 z-50 grid place-items-center bg-black/70" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div className="w-full max-w-lg rounded-3xl bg-noir-900 p-8 ring-1 ring-white/15"><h2 id="dialog-title" className="text-2xl font-semibold">{title}</h2><p className="mt-3 text-white/55">{text}</p><div className="mt-8 flex justify-end gap-3"><button onClick={onCancel} className="player-focusable rounded-full bg-white/8 px-5 py-3">{cancel}</button>{onMiddle && middle && <button onClick={onMiddle} className="player-focusable rounded-full bg-white/8 px-5 py-3">{middle}</button>}<button onClick={onConfirm} className="player-focusable rounded-full bg-white px-5 py-3 font-bold text-black">{confirm}</button></div></div></div>
}

/**
 * Player customization — Arctic Fuse-style component setup within the one
 * locked Archivist look: home rails (source × style, reorder, toggle),
 * library defaults, and the server connection.
 */
function LegacySettings({ sdk: _sdk }: { sdk: ArchivistSdk }) {
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

      {/* Playback */}
      <section className="rounded-2xl bg-noir-900 border border-white/5 p-5 mb-5">
        <h2 className="text-[11px] font-mono text-white/40 uppercase tracking-[0.25em] mb-4">Playback</h2>
        {([
          ['autoSkipIntro', 'Automatically skip intros', 'Seek past a detected recurring intro without showing the button first.'],
          ['autoSkipCredits', 'Automatically skip credits', 'Skip detected credits; channel sessions advance only when another playable item exists.'],
        ] as const).map(([key, title, description]) => (
          <div key={key} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
            <div>
              <p className="text-sm text-white/80">{title}</p>
              <p className="text-xs text-white/30">{description}</p>
            </div>
            <button onClick={() => updateSettings({ [key]: !settings[key] })}
              className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${settings[key] ? 'bg-cyan' : 'bg-white/10'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${settings[key] ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>
        ))}
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
