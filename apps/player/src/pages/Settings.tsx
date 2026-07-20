import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  PlayerAutoscrollInterval,
  PlayerBrowseContentType,
  PlayerHubLayout,
  PlayerHubPreference,
  PlayerPreferencesV1,
  PlayerSortOrder,
  PlayerView,
  PlayerDetailAction,
  PlayerDetailRow,
  PlayerRatingProvider,
  PlayerWidgetLimit,
  PlayerWidgetPreference,
  PlayerWidgetSort,
  PlayerWidgetSource,
} from '@archivist/contracts'
import { PlayerSdkError, type ArchivistSdk } from '../lib/sdk.js'
import {
  useSettings, updateSettings, DEFAULT_RAILS, RAIL_SOURCES, RAIL_STYLES,
  type RailConfig, type RailSource, type RailStyle,
} from '../lib/store.js'
import { playerStore, usePlayerSelector } from '../lib/store.js'
import { isPreferencesDirty } from '../lib/preferences.js'
import { useFocusable } from '../focus/FocusProvider.js'
import { useDialogFocus } from '../focus/useDialogFocus.js'

export function SettingsPage({ sdk, v2 = false }: { sdk: ArchivistSdk; v2?: boolean }) {
  return v2 ? <LivingRoomSettings sdk={sdk} /> : <LegacySettings sdk={sdk} />
}

function LivingRoomSettings({ sdk }: { sdk: ArchivistSdk }) {
  const saved = usePlayerSelector(state => state.preferences)
  const storeDraft = usePlayerSelector(state => state.draft)
  const telemetryEnabled = usePlayerSelector(state => !!state.bootstrap?.featureFlags.telemetryEnabled)
  const [draft, setDraft] = useState<PlayerPreferencesV1 | null>(storeDraft)
  const [section, setSection] = useState('Playback')
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
      const envelope = await sdk.updatePreferences({ profileId: saved.profileId, expectedRevision, preferences: draft })
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
      const envelope = await sdk.resetPreferences({ profileId: saved.profileId, expectedRevision: saved.revision })
      playerStore.dispatch({ type: 'PREFERENCES_SAVED', envelope }); setDraft(structuredClone(envelope.preferences)); setResetConfirm(false); setMessage('Settings reset')
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)) }
  }
  const sections = ['Profiles', 'Playback', 'Accessibility', 'About']
  return <div data-route-scroll className="h-full overflow-y-auto no-scrollbar pb-20">
    <div className="flex items-start gap-10">
      <aside className="w-52 shrink-0"><h1 className="mb-6 font-display text-5xl uppercase tracking-widest text-white">Settings</h1><nav className="space-y-2">{sections.map(name => <SettingButton key={name} id={`settings-section-${name}`} label={name} active={section === name} onPress={() => setSection(name)} />)}</nav></aside>
      <section className="min-w-0 max-w-4xl flex-1 rounded-3xl bg-black/30 p-8 ring-1 ring-white/10">
        <h2 className="mb-2 text-3xl font-semibold">{section}</h2>
        {section === 'Profiles' && <ProfileSettings sdk={sdk} activeId={saved.profileId} />}
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

function ProfileSettings({ sdk, activeId }: { sdk: ArchivistSdk; activeId: string }) {
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string; updatedAt: string }>>([])
  const [name, setName] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const load = () => sdk.profiles().then(result => setProfiles(result.profiles)).catch(reason => setMessage(reason instanceof Error ? reason.message : String(reason)))
  useEffect(() => { void load() }, [sdk])
  const activate = (id: string) => { localStorage.setItem('archivist-player-profile', id); window.location.assign('/') }
  const create = async () => {
    const id = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
    if (!id) { setMessage('Enter a profile name'); return }
    await sdk.createProfile(id); setName(''); await load(); activate(id)
  }
  const remove = async (id: string) => { await sdk.deleteProfile(id); await load() }
  return <div className="space-y-5"><p className="text-sm text-white/48">Each profile has separate Home hubs, browsing defaults, watched progress and bookmarks.</p><div className="space-y-2">{profiles.map(profile => <div key={profile.id} className={`flex items-center rounded-2xl border p-4 ${profile.id === activeId ? 'player-accent-border player-accent-soft' : 'border-white/10 bg-white/5'}`}><div><strong>{profile.name}</strong><p className="mt-1 text-xs text-white/35">{profile.id}</p></div><div className="ml-auto flex gap-2">{profile.id !== activeId && <button onClick={() => activate(profile.id)} className="player-focusable rounded-full bg-white px-4 py-2 font-bold text-black">Switch</button>}{profile.id !== 'default' && profile.id !== activeId && <button onClick={() => void remove(profile.id)} className="player-focusable rounded-full px-4 py-2 text-pink">Delete</button>}</div></div>)}</div><div className="flex gap-3 border-t border-white/10 pt-5"><input aria-label="New profile name" value={name} onChange={event => setName(event.target.value)} maxLength={32} placeholder="New profile name" className="player-focusable flex-1 rounded-xl bg-white/8 px-4 py-3" /><button onClick={() => void create()} className="player-focusable player-accent-bg rounded-full px-6 py-3 font-bold">Create profile</button></div>{message && <p role="status" className="text-sm text-pink">{message}</p>}</div>
}

function SettingButton({ id, label, active, onPress }: { id: string; label: string; active?: boolean; onPress: () => void }) {
  const focusable = useFocusable({ id, zoneId: 'settings-nav', onActivate: onPress })
  return <button {...focusable} className={`player-focusable w-full rounded-xl px-4 py-3 text-left ${active ? 'bg-white text-black' : 'text-white/55 hover:bg-white/5'}`}>{label}</button>
}

const SOURCE_GROUPS: Array<{ label: string; options: Array<[PlayerWidgetSource, string]> }> = [
  { label: 'Continue watching', options: [['continue', 'Continue Watching'], ['recently-played', 'Recently Played']] },
  { label: 'Films', options: [['recent-films', 'Recently Added Films'], ['unwatched-films', 'Unwatched Films'], ['top-rated-films', 'Top Rated Films'], ['random-films', 'Random Films'], ['films-az', 'All Films'], ['collections', 'Collections']] },
  { label: 'Series', options: [['recent-episodes', 'Recently Added Episodes'], ['unwatched-series', 'Unwatched Series'], ['unwatched-episodes', 'Unwatched Episodes'], ['top-rated-series', 'Top Rated Series'], ['random-series', 'Random Series'], ['series-az', 'All Series']] },
  { label: 'Activity', options: [['downloading', 'Downloads']] },
]

const defaultOrder = (source: PlayerWidgetSource): PlayerSortOrder =>
  ['continue', 'recently-played', 'recent-films', 'recent-episodes', 'downloading', 'top-rated-films', 'top-rated-series'].includes(source) ? 'desc' : 'asc'

function unusedId(prefix: string, ids: string[]): string {
  for (let suffix = 1; suffix < 100; suffix++) {
    const candidate = `${prefix}-${suffix}`
    if (!ids.includes(candidate)) return candidate
  }
  return `${prefix}-${Date.now().toString(36)}`
}

export function createHubPreference(hubs: PlayerHubPreference[]): PlayerHubPreference {
  const id = unusedId('hub', hubs.map(hub => hub.id))
  return {
    id, name: `Hub ${hubs.length + 1}`, icon: '◆', enabled: true, layout: 'standard', showSpotlight: true,
    spotlightWidgetId: null,
    widgets: [{ id: 'films', title: 'Films', source: 'films-az', view: 'poster', sort: 'source', sortOrder: 'asc', limit: 18, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true }],
  }
}

export function createWidgetPreference(widgets: PlayerWidgetPreference[]): PlayerWidgetPreference {
  return {
    id: unusedId('widget', widgets.map(widget => widget.id)), title: 'New Widget', source: 'films-az', view: 'poster',
    sort: 'source', sortOrder: 'asc', limit: 18, autoscrollSeconds: 0, savedFilterId: null, downloadMediaTypes: [], enabled: true,
  }
}

export function removeSavedFilterPreference(draft: PlayerPreferencesV1, savedFilterId: string): PlayerPreferencesV1 {
  const hubs = draft.home.hubs.map(hub => {
    let widgets = hub.widgets.filter(widget => widget.savedFilterId !== savedFilterId)
    if (widgets.length === 0) widgets = [createWidgetPreference([])]
    const spotlightWidgetId = widgets.some(widget => widget.id === hub.spotlightWidgetId && widget.enabled) ? hub.spotlightWidgetId : null
    return { ...hub, widgets, spotlightWidgetId }
  })
  return {
    ...draft,
    home: { hubs },
    browsing: { ...draft.browsing, savedFilters: draft.browsing.savedFilters.filter(entry => entry.id !== savedFilterId) },
  }
}

function HubEditor({ draft, update }: { draft: PlayerPreferencesV1; update: (next: PlayerPreferencesV1) => void }) {
  const [selectedId, setSelectedId] = useState(() => draft.home.hubs[0]?.id ?? 'home')
  const hubs = draft.home.hubs
  const selected = hubs.find(hub => hub.id === selectedId) ?? hubs[0]
  useEffect(() => { if (!hubs.some(hub => hub.id === selectedId)) setSelectedId(hubs[0]?.id ?? 'home') }, [hubs, selectedId])
  const writeHubs = (next: PlayerHubPreference[]) => update({ ...draft, home: { hubs: next } })
  const patchHub = (values: Partial<PlayerHubPreference>) => writeHubs(hubs.map(hub => hub.id === selected.id ? { ...hub, ...values } : hub))
  const moveHub = (offset: number) => {
    const index = hubs.findIndex(hub => hub.id === selected.id), target = index + offset
    if (index < 0 || target < 0 || target >= hubs.length) return
    const next = [...hubs]; [next[index], next[target]] = [next[target], next[index]]; writeHubs(next)
  }
  const addHub = () => {
    if (hubs.length >= 9) return
    const hub = createHubPreference(hubs); writeHubs([...hubs, hub]); setSelectedId(hub.id)
  }
  const removeHub = () => {
    if (selected.id === 'home') return
    const next = hubs.filter(hub => hub.id !== selected.id); writeHubs(next); setSelectedId(next[0]?.id ?? 'home')
  }
  const patchWidget = (index: number, values: Partial<PlayerWidgetPreference>) => {
    const widgets = selected.widgets.map((entry, widgetIndex) => widgetIndex === index ? { ...entry, ...values } : entry)
    const spotlightWidgetId = selected.spotlightWidgetId && widgets.some(entry => entry.id === selected.spotlightWidgetId && entry.enabled)
      ? selected.spotlightWidgetId : null
    patchHub({ widgets, spotlightWidgetId })
  }
  const moveWidget = (index: number, offset: number) => {
    const target = index + offset
    if (target < 0 || target >= selected.widgets.length) return
    const widgets = [...selected.widgets]; [widgets[index], widgets[target]] = [widgets[target], widgets[index]]; patchHub({ widgets })
  }
  const addWidget = () => { if (selected.widgets.length < 12) patchHub({ widgets: [...selected.widgets, createWidgetPreference(selected.widgets)] }) }
  const removeWidget = (index: number) => {
    if (selected.widgets.length === 1) return
    const removed = selected.widgets[index]
    const widgets = selected.widgets.filter((_, widgetIndex) => widgetIndex !== index)
    patchHub({ widgets, spotlightWidgetId: selected.spotlightWidgetId === removed.id ? null : selected.spotlightWidgetId })
  }
  const enabledCount = selected.widgets.filter(widget => widget.enabled).length

  return <div className="grid grid-cols-[13rem_minmax(0,1fr)] gap-6">
    <aside className="space-y-2">
      <p className="mb-3 text-xs leading-relaxed text-white/45">Hubs appear in the Player navigation and keep their own layout, spotlight and widgets.</p>
      {hubs.map(hub => <button key={hub.id} onClick={() => setSelectedId(hub.id)} className={`player-focusable flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left ${hub.id === selected.id ? 'bg-white text-black' : 'bg-white/5 text-white/65'}`}>
        <span aria-hidden="true">{hub.icon}</span><span className="min-w-0 flex-1 truncate">{hub.name}</span>{!hub.enabled && <span className="text-[10px] uppercase opacity-50">Off</span>}
      </button>)}
      <button onClick={addHub} disabled={hubs.length >= 9} className="player-focusable w-full rounded-xl border border-dashed border-white/20 px-4 py-3 text-sm text-white/60 disabled:opacity-30">+ Add hub</button>
    </aside>
    <div className="min-w-0 space-y-6">
      <section className="rounded-2xl border border-white/10 bg-white/4 p-5">
        <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
          <label className="text-xs text-white/45">Icon<input aria-label="Hub icon" value={selected.icon} maxLength={8} onChange={event => patchHub({ icon: event.target.value })} className="player-focusable mt-2 w-full rounded-lg bg-black/30 px-3 py-2 text-center text-xl" /></label>
          <label className="text-xs text-white/45">Name<input aria-label="Hub name" value={selected.name} maxLength={32} onChange={event => patchHub({ name: event.target.value })} className="player-focusable mt-2 w-full rounded-lg bg-black/30 px-3 py-2 text-white" /></label>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">{(['standard','combined','wall'] as PlayerHubLayout[]).map(layout => <button key={layout} onClick={() => patchHub({ layout })} className={`player-focusable rounded-full px-4 py-2 capitalize ${selected.layout === layout ? 'bg-white text-black' : 'bg-white/8'}`}>{layout}</button>)}</div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button onClick={() => patchHub({ showSpotlight: !selected.showSpotlight })} className="player-focusable rounded-full bg-white/8 px-4 py-2">Spotlight: {selected.showSpotlight ? 'On' : 'Off'}</button>
          {selected.showSpotlight && <label className="text-xs text-white/45">Source <select value={selected.spotlightWidgetId ?? ''} onChange={event => patchHub({ spotlightWidgetId: event.target.value || null })} className="player-focusable ml-2 rounded-lg bg-noir-800 px-3 py-2 text-white"><option value="">First widget with results</option>{selected.widgets.filter(widget => widget.enabled).map(widget => <option key={widget.id} value={widget.id}>{widget.title}</option>)}</select></label>}
          {selected.id !== 'home' && <button onClick={() => patchHub({ enabled: !selected.enabled })} className="player-focusable rounded-full bg-white/8 px-4 py-2">Navigation: {selected.enabled ? 'On' : 'Off'}</button>}
        </div>
        <div className="mt-5 flex gap-2 border-t border-white/10 pt-4"><button onClick={() => moveHub(-1)} className="player-focusable rounded-lg bg-white/8 px-3 py-2">Move up</button><button onClick={() => moveHub(1)} className="player-focusable rounded-lg bg-white/8 px-3 py-2">Move down</button>{selected.id !== 'home' && <button onClick={removeHub} className="player-focusable ml-auto rounded-lg px-3 py-2 text-pink">Delete hub</button>}</div>
      </section>

      <div className="flex items-center justify-between"><div><h3 className="text-xl font-semibold">Widgets</h3><p className="mt-1 text-xs text-white/40">Each widget is a server-backed content source with its own presentation and behavior.</p></div><button onClick={addWidget} disabled={selected.widgets.length >= 12} className="player-focusable rounded-full bg-white px-5 py-2 font-bold text-black disabled:opacity-30">+ Add widget</button></div>
      <div className="space-y-3">{selected.widgets.map((entry, index) => <section key={entry.id} className={`rounded-2xl border border-white/10 bg-white/4 p-4 ${entry.enabled ? '' : 'opacity-55'}`}>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-white/45">Title<input aria-label={`Widget ${index + 1} title`} value={entry.title} maxLength={48} onChange={event => patchWidget(index, { title: event.target.value })} className="player-focusable mt-2 w-full rounded-lg bg-black/30 px-3 py-2 text-white" /></label>
          <label className="text-xs text-white/45">Content source<select aria-label={`Widget ${index + 1} content source`} value={entry.source} onChange={event => { const source = event.target.value as PlayerWidgetSource; patchWidget(index, { source, savedFilterId: source === 'saved-filter' ? draft.browsing.savedFilters[0]?.id ?? null : null, downloadMediaTypes: source === 'downloading' ? ['films', 'series'] : [], sortOrder: entry.sort === 'source' ? defaultOrder(source) : entry.sortOrder }) }} className="player-focusable mt-2 w-full rounded-lg bg-noir-800 px-3 py-2 text-white">{SOURCE_GROUPS.map(group => <optgroup key={group.label} label={group.label}>{group.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</optgroup>)}{draft.browsing.savedFilters.length > 0 && <optgroup label="Saved views"><option value="saved-filter">Saved filtered view</option></optgroup>}</select></label>
        </div>
        {entry.source === 'saved-filter' && <label className="mt-3 block text-xs text-white/45">Saved view<select aria-label={`Widget ${index + 1} saved view`} value={entry.savedFilterId ?? ''} onChange={event => patchWidget(index, { savedFilterId: event.target.value || null })} className="player-focusable mt-2 w-full rounded-lg bg-noir-800 px-3 py-2 text-white">{draft.browsing.savedFilters.map(saved => <option key={saved.id} value={saved.id}>{saved.name}</option>)}</select></label>}
        {entry.source === 'downloading' && <div className="mt-3"><p className="mb-2 text-xs text-white/45">Download types</p><div className="flex gap-2">{(['films','series','other'] as const).map(type => { const active = entry.downloadMediaTypes.includes(type); return <button key={type} onClick={() => { const next = active ? entry.downloadMediaTypes.filter(value => value !== type) : [...entry.downloadMediaTypes, type]; if (next.length) patchWidget(index, { downloadMediaTypes: next }) }} className={`player-focusable rounded-full px-4 py-2 capitalize ${active ? 'bg-white text-black' : 'bg-white/8 text-white/55'}`}>{type}</button> })}</div></div>}
        <div className="mt-3 grid grid-cols-5 gap-3">
          <EditorSelect label="View" value={entry.view} values={['poster','landscape','wall','list']} onChange={value => patchWidget(index, { view: value as PlayerView })} />
          <EditorSelect label="Sort" value={entry.sort} values={['source','title','added','year','rating']} onChange={value => patchWidget(index, { sort: value as PlayerWidgetSort })} />
          <EditorSelect label="Order" value={entry.sortOrder} values={['asc','desc']} onChange={value => patchWidget(index, { sortOrder: value as PlayerSortOrder })} />
          <EditorSelect label="Limit" value={String(entry.limit)} values={['6','12','18','24','36','60']} onChange={value => patchWidget(index, { limit: Number(value) as PlayerWidgetLimit })} />
          <EditorSelect label="Autoscroll" value={String(entry.autoscrollSeconds)} values={['0','5','8','10','15','20','30']} optionLabel={value => value === '0' ? 'Off' : `${value}s`} onChange={value => patchWidget(index, { autoscrollSeconds: Number(value) as PlayerAutoscrollInterval })} />
        </div>
        <div className="mt-4 flex gap-2"><button onClick={() => moveWidget(index,-1)} className="player-focusable rounded-lg bg-white/8 px-3 py-2">Move up</button><button onClick={() => moveWidget(index,1)} className="player-focusable rounded-lg bg-white/8 px-3 py-2">Move down</button><button disabled={entry.enabled && enabledCount === 1} onClick={() => patchWidget(index,{ enabled: !entry.enabled })} className="player-focusable ml-auto rounded-lg bg-white/8 px-3 py-2 disabled:opacity-30">{entry.enabled ? 'Enabled' : 'Disabled'}</button><button disabled={selected.widgets.length === 1} onClick={() => removeWidget(index)} className="player-focusable rounded-lg px-3 py-2 text-pink disabled:opacity-30">Remove</button></div>
      </section>)}</div>
    </div>
  </div>
}

function EditorSelect({ label, value, values, onChange, optionLabel = value => value }: { label: string; value: string; values: string[]; onChange: (value: string) => void; optionLabel?: (value: string) => string }) {
  return <label className="text-xs text-white/45">{label}<select aria-label={label} value={value} onChange={event => onChange(event.target.value)} className="player-focusable mt-2 w-full rounded-lg bg-noir-800 px-3 py-2 text-white">{values.map(option => <option key={option} value={option}>{optionLabel(option)}</option>)}</select></label>
}

function LibrarySettings({ draft, update }: { draft: PlayerPreferencesV1; update: (next: PlayerPreferencesV1) => void }) {
  const contentTypes: PlayerBrowseContentType[] = ['films','series','seasons','episodes','collections','people']
  return <div className="space-y-5">
    <p className="text-sm text-white/45">Default views apply whenever a content type is opened without a saved view.</p>
    {contentTypes.map(kind => <div key={kind} className="flex items-center gap-4 rounded-2xl bg-white/5 p-5 capitalize"><strong className="w-28">{kind}</strong><label className="flex items-center gap-2 text-sm text-white/55">View<select aria-label={`${kind} view`} value={draft.browsing.defaultViews[kind]} onChange={event => { const view = event.target.value as PlayerView; const next = { ...draft, browsing: { ...draft.browsing, defaultViews: { ...draft.browsing.defaultViews, [kind]: view } } }; if (kind === 'films' || kind === 'series') next.libraries = { ...next.libraries, [kind]: { ...next.libraries[kind], view } }; update(next) }} className="rounded-lg bg-noir-800 px-3 py-2 text-white">{['poster','landscape','wall','list'].map(view => <option key={view}>{view}</option>)}</select></label>{(kind === 'films' || kind === 'series') && <><label className="flex items-center gap-2 text-sm text-white/55">Sort<select aria-label={`${kind} sort`} value={draft.libraries[kind].sort} onChange={event => update({ ...draft, libraries: { ...draft.libraries, [kind]: { ...draft.libraries[kind], sort: event.target.value as PlayerPreferencesV1['libraries'][typeof kind]['sort'] } } })} className="rounded-lg bg-noir-800 px-3 py-2 text-white">{['title','added','year','rating'].map(value => <option key={value}>{value}</option>)}</select></label><label className="flex items-center gap-2 text-sm text-white/55">Order<select aria-label={`${kind} order`} value={draft.libraries[kind].sortOrder} onChange={event => update({ ...draft, libraries: { ...draft.libraries, [kind]: { ...draft.libraries[kind], sortOrder: event.target.value as PlayerSortOrder } } })} className="rounded-lg bg-noir-800 px-3 py-2 text-white"><option value="asc">asc</option><option value="desc">desc</option></select></label><button onClick={() => update({ ...draft, libraries: { ...draft.libraries, [kind]: { ...draft.libraries[kind], hideUnavailable: !draft.libraries[kind].hideUnavailable } } })} className="player-focusable rounded-full bg-white/8 px-4 py-2">Hide unavailable: {draft.libraries[kind].hideUnavailable ? 'On' : 'Off'}</button></>}</div>)}
    <section className="rounded-2xl bg-white/5 p-5"><h3 className="font-semibold">Saved views</h3>{draft.browsing.savedFilters.length === 0 ? <p className="mt-2 text-sm text-white/40">Create saved views from the Options drawer in Films, Series, Episodes or Collections.</p> : <div className="mt-3 space-y-2">{draft.browsing.savedFilters.map(saved => <div key={saved.id} className="flex items-center gap-3 rounded-xl bg-black/20 px-4 py-3"><span className="flex-1">{saved.name}</span><span className="text-xs uppercase text-white/35">{saved.mediaType}</span><button onClick={() => update(removeSavedFilterPreference(draft, saved.id))} className="player-focusable rounded-lg px-3 py-2 text-pink">Delete</button></div>)}</div>}</section>
  </div>
}

function AppearanceSettings({ draft, update }: { draft: PlayerPreferencesV1; update: (next: PlayerPreferencesV1) => void }) {
  const accents = ['#00d4ff', '#ff2d78', '#a78bfa', '#34d399', '#f59e0b', '#ffffff']
  return <div className="space-y-7">
    <section><h3 className="font-semibold">Focus and accent colour</h3><div className="mt-3 flex gap-3">{accents.map(colour => <button key={colour} aria-label={`Accent ${colour}`} aria-pressed={draft.appearance.accentColor === colour} onClick={() => update({ ...draft, appearance: { ...draft.appearance, accentColor: colour } })} className="player-focusable h-11 w-11 rounded-full border-2 border-white/15" style={{ background: colour }} />)}</div></section>
    <section><h3 className="font-semibold">Artwork blur</h3><div className="mt-3 flex gap-2">{([0,8,16,24,32] as const).map(value => <button key={value} onClick={() => update({ ...draft, appearance: { ...draft.appearance, artworkBlur: value } })} className={`player-focusable rounded-full px-4 py-2 ${draft.appearance.artworkBlur === value ? 'bg-white text-black' : 'bg-white/8'}`}>{value === 0 ? 'Off' : `${value}px`}</button>)}</div></section>
    <section><h3 className="font-semibold">Dialog tint</h3><div className="mt-3 flex gap-2">{(['artwork','neutral'] as const).map(value => <button key={value} onClick={() => update({ ...draft, appearance: { ...draft.appearance, dialogTint: value } })} className={`player-focusable rounded-full px-4 py-2 capitalize ${draft.appearance.dialogTint === value ? 'bg-white text-black' : 'bg-white/8'}`}>{value}</button>)}</div></section>
    <section><h3 className="font-semibold">Backdrop cycling</h3><div className="mt-3 flex gap-2">{([0,10,20,30] as const).map(value => <button key={value} onClick={() => update({ ...draft, appearance: { ...draft.appearance, backdropCycleSeconds: value } })} className={`player-focusable rounded-full px-4 py-2 ${draft.appearance.backdropCycleSeconds === value ? 'bg-white text-black' : 'bg-white/8'}`}>{value === 0 ? 'Off' : `${value}s`}</button>)}</div></section>
  </div>
}

function DetailSettings({ draft, update }: { draft: PlayerPreferencesV1; update: (next: PlayerPreferencesV1) => void }) {
  const toggle = <T extends string>(values: T[], value: T): T[] => values.includes(value) ? values.filter(entry => entry !== value) : [...values, value]
  const rows: PlayerDetailRow[] = ['cast','crew','collection','gallery','recommendations','seasons','episodes']
  const ratings: PlayerRatingProvider[] = ['tmdb','imdb','trakt']
  const actions: PlayerDetailAction[] = ['play','trailer','mark-watched','information']
  const buttons = <T extends string>(values: T[], options: T[], write: (next: T[]) => void) => <div className="mt-3 flex flex-wrap gap-2">{options.map(value => <button key={value} onClick={() => { const next = toggle(values, value); if (next.length) write(next) }} className={`player-focusable rounded-full px-4 py-2 capitalize ${values.includes(value) ? 'bg-white text-black' : 'bg-white/8 text-white/55'}`}>{value.replace('-', ' ')}</button>)}</div>
  return <div className="space-y-7">
    <section><h3 className="font-semibold">Information rows</h3><p className="mt-1 text-sm text-white/45">Choose and order the rows shown below film and series heroes.</p>{buttons(draft.details.rows, rows, next => update({ ...draft, details: { ...draft.details, rows: next } }))}</section>
    <section><h3 className="font-semibold">Rating slots</h3>{buttons(draft.details.ratingSlots, ratings, next => update({ ...draft, details: { ...draft.details, ratingSlots: next } }))}</section>
    <section><h3 className="font-semibold">Primary actions</h3>{buttons(draft.details.primaryActions, actions, next => update({ ...draft, details: { ...draft.details, primaryActions: next } }))}</section>
  </div>
}

function PlaybackSettings({ draft, update }: { draft: PlayerPreferencesV1; update: (next: PlayerPreferencesV1) => void }) {
  const language = (value: string) => value.trim() ? value.trim().toLowerCase() : null
  return <div className="space-y-6">
    <div><button onClick={() => update({ ...draft, playback: { ...draft.playback, normalizeVolume: !draft.playback.normalizeVolume } })} className="player-focusable rounded-full bg-white/8 px-5 py-3">Normalize loudness: {draft.playback.normalizeVolume ? 'On' : 'Off'}</button><div className="mt-3 flex gap-2">{([-14,-16,-18,-23] as const).map(value => <button key={value} onClick={() => update({ ...draft, playback: { ...draft.playback, targetLufs: value } })} className={`player-focusable rounded-full px-4 py-2 ${draft.playback.targetLufs === value ? 'bg-white text-black' : 'bg-white/8'}`}>{value} LUFS</button>)}</div></div>
    <div className="grid grid-cols-2 gap-4"><label className="text-sm text-white/55">Preferred audio language<input aria-label="Preferred audio language" value={draft.playback.preferredAudioLanguage ?? ''} maxLength={16} placeholder="en" onChange={event => update({ ...draft, playback: { ...draft.playback, preferredAudioLanguage: language(event.target.value) } })} className="player-focusable mt-2 w-full rounded-lg bg-noir-800 px-4 py-3 text-white" /></label><label className="text-sm text-white/55">Preferred subtitle language<input aria-label="Preferred subtitle language" value={draft.playback.preferredSubtitleLanguage ?? ''} maxLength={16} placeholder="en" onChange={event => update({ ...draft, playback: { ...draft.playback, preferredSubtitleLanguage: language(event.target.value) } })} className="player-focusable mt-2 w-full rounded-lg bg-noir-800 px-4 py-3 text-white" /></label></div>
    <div><p className="mb-3 text-sm text-white/55">Subtitles on startup</p><div className="flex gap-2">{(['off','forced','preferred'] as const).map(value => <button key={value} onClick={() => update({ ...draft, playback: { ...draft.playback, subtitles: value } })} className={`player-focusable rounded-full px-4 py-2 capitalize ${draft.playback.subtitles === value ? 'bg-white text-black' : 'bg-white/8'}`}>{value}</button>)}</div></div>
    <div><p className="mb-3 text-sm text-white/55">OSD timeout</p><div className="flex gap-2">{([0,3,5,8,10] as const).map(value => <button key={value} onClick={() => update({ ...draft, playback: { ...draft.playback, osdTimeoutSeconds: value } })} className={`player-focusable rounded-full px-4 py-2 ${draft.playback.osdTimeoutSeconds === value ? 'bg-white text-black' : 'bg-white/8'}`}>{value === 0 ? 'Never' : `${value}s`}</button>)}</div></div>
    <div><p className="mb-3 text-sm text-white/55">Paused information</p><div className="flex gap-2">{(['minimal','after-delay','always'] as const).map(value => <button key={value} onClick={() => update({ ...draft, playback: { ...draft.playback, pauseBehavior: value } })} className={`player-focusable rounded-full px-4 py-2 capitalize ${draft.playback.pauseBehavior === value ? 'bg-white text-black' : 'bg-white/8'}`}>{value.replace('-', ' ')}</button>)}</div></div>
    <div><p className="mb-3 text-sm text-white/55">Time display</p><div className="flex gap-2">{(['elapsed-total','elapsed-remaining'] as const).map(value => <button key={value} onClick={() => update({ ...draft, playback: { ...draft.playback, timeDisplay: value } })} className={`player-focusable rounded-full px-4 py-2 capitalize ${draft.playback.timeDisplay === value ? 'bg-white text-black' : 'bg-white/8'}`}>{value.replace('-', ' + ')}</button>)}</div></div>
    <div><p className="mb-3 text-sm text-white/55">Still Watching prompt</p><div className="flex gap-2">{([0,60,90,120] as const).map(value => <button key={value} onClick={() => update({ ...draft, playback: { ...draft.playback, stillWatchingMinutes: value } })} className={`player-focusable rounded-full px-4 py-2 ${draft.playback.stillWatchingMinutes === value ? 'bg-white text-black' : 'bg-white/8'}`}>{value === 0 ? 'Off' : `${value}m`}</button>)}</div></div>
  </div>
}

function AccessibilitySettings({ draft, update }: { draft: PlayerPreferencesV1; update: (next: PlayerPreferencesV1) => void }) {
  return <div className="space-y-5"><div className="flex gap-2">{(['system','on','off'] as const).map(value => <button key={value} onClick={() => update({ ...draft, accessibility: { ...draft.accessibility, reducedMotion: value } })} className={`player-focusable rounded-full px-4 py-2 capitalize ${draft.accessibility.reducedMotion === value ? 'bg-white text-black' : 'bg-white/8'}`}>Motion {value}</button>)}</div><div className="flex gap-2">{([1,1.15,1.3] as const).map(value => <button key={value} onClick={() => update({ ...draft, accessibility: { ...draft.accessibility, textScale: value } })} className={`player-focusable rounded-full px-4 py-2 ${draft.accessibility.textScale === value ? 'bg-white text-black' : 'bg-white/8'}`}>{Math.round(value*100)}%</button>)}</div><button onClick={() => update({ ...draft, accessibility: { ...draft.accessibility, highContrast: !draft.accessibility.highContrast } })} className="player-focusable rounded-full bg-white/8 px-5 py-3">High contrast: {draft.accessibility.highContrast ? 'On' : 'Off'}</button></div>
}

function Dialog({ title, text, onCancel, onConfirm, confirm, cancel = 'Cancel', onMiddle, middle }: { title: string; text: string; onCancel: () => void; onConfirm: () => void; confirm: string; cancel?: string; onMiddle?: () => void; middle?: string }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onCancel)
  return <div ref={dialogRef} className="fixed inset-0 z-50 grid place-items-center bg-black/70" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div className="w-full max-w-lg rounded-3xl bg-noir-900 p-8 ring-1 ring-white/15"><h2 id="dialog-title" className="text-2xl font-semibold">{title}</h2><p className="mt-3 text-white/55">{text}</p><div className="mt-8 flex justify-end gap-3"><button data-dialog-initial onClick={onCancel} className="player-focusable rounded-full bg-white/8 px-5 py-3">{cancel}</button>{onMiddle && middle && <button onClick={onMiddle} className="player-focusable rounded-full bg-white/8 px-5 py-3">{middle}</button>}<button onClick={onConfirm} className="player-focusable rounded-full bg-white px-5 py-3 font-bold text-black">{confirm}</button></div></div></div>
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
