import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../../components/PageHeader.js'
import { EmptyState, Field, Input, Modal, Select, Spinner, Toggle } from '../../components/ui.js'
import {
  channelsApi, type Channel, type GuideSlot, type ProgrammingBlock,
  type SeriesOption, type SlotDef, type SlotSource,
} from '../../lib/channels.api.js'

/**
 * Channels tab — programme a personal TV network over the films/series
 * libraries (archivist-channels.md Part IV). Two views: Channels (channel +
 * block authoring, slate generation) and Guide (day grid with lock/remove).
 */

const DAY_MS = 24 * 3600 * 1000
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const minuteToLabel = (m: number) => {
  const mm = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`
}
const timeInputToMinute = (v: string) => {
  const [h, m] = v.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

export function ChannelsPage() {
  const [tab, setTab] = useState('channels')
  return (
    <div>
      <PageHeader
        title="CHANNELS"
        subtitle="Programme your own TV network"
        accentClass="text-[#00D4FF]"
        tabs={[{ id: 'channels', label: 'Channels' }, { id: 'guide', label: 'Guide' }]}
        activeTab={tab}
        onTabChange={setTab}
      />
      {tab === 'channels' ? <ChannelsView /> : <GuideView />}
    </div>
  )
}

// ── Channels view ─────────────────────────────────────────────────────────────

function ChannelsView() {
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [editing, setEditing] = useState<Channel | 'new' | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [generating, setGenerating] = useState<number | 'all' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(() => {
    channelsApi.list().then(d => setChannels(d.channels)).catch(() => setChannels([]))
  }, [])
  useEffect(reload, [reload])

  const generate = async (id: number | 'all') => {
    setGenerating(id)
    try {
      if (id === 'all') {
        const r = await channelsApi.generateAll(7)
        setNotice(`Generated ${r.totalSlots} slots across ${Object.keys(r.results).length} channels`)
      } else {
        const r = await channelsApi.generate(id, 7)
        setNotice(`Generated ${r.created} slots`)
      }
      reload()
    } catch (e: any) { setNotice(`Generation failed: ${e.message}`) }
    finally { setGenerating(null); setTimeout(() => setNotice(null), 4000) }
  }

  if (!channels) return <div className="flex justify-center py-20"><Spinner /></div>

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => setEditing('new')}
          className="px-4 py-2 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/50 text-[#00D4FF] text-xs font-bold uppercase tracking-widest hover:bg-[#00D4FF]/20 transition-all">
          + New Channel
        </button>
        {channels.length > 0 && (
          <button onClick={() => generate('all')} disabled={generating !== null}
            className="px-4 py-2 rounded-lg bg-white/5 border border-white/15 text-white/70 text-xs font-bold uppercase tracking-widest hover:bg-white/10 transition-all disabled:opacity-40">
            {generating === 'all' ? 'Generating…' : 'Generate all (7 days)'}
          </button>
        )}
        {notice && <span className="text-xs font-mono text-[#00D4FF]/70">{notice}</span>}
      </div>

      {channels.length === 0 ? (
        <EmptyState icon="📡" title="No channels yet"
          subtitle="Create a channel, add programming blocks, then generate a week of guide." />
      ) : (
        <div className="space-y-3">
          {channels.map(c => (
            <ChannelRow
              key={c.id}
              channel={c}
              expanded={expandedId === c.id}
              onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
              onEdit={() => setEditing(c)}
              onGenerate={() => generate(c.id)}
              generating={generating === c.id}
              onChanged={reload}
            />
          ))}
        </div>
      )}

      {editing && (
        <ChannelModal
          channel={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload() }}
        />
      )}
    </div>
  )
}

function ChannelRow({ channel, expanded, onToggle, onEdit, onGenerate, generating, onChanged }: {
  channel: Channel; expanded: boolean; onToggle: () => void; onEdit: () => void
  onGenerate: () => void; generating: boolean; onChanged: () => void
}) {
  const remove = async () => {
    if (!confirm(`Delete channel ${channel.number} "${channel.name}" and its schedule?`)) return
    await channelsApi.remove(channel.id)
    onChanged()
  }
  return (
    <div className="rounded-xl bg-noir-800/60 border border-white/5 overflow-hidden">
      <div className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-white/[0.03] transition-colors" onClick={onToggle}>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center font-display text-lg"
          style={{ backgroundColor: `${channel.brandColor}22`, color: channel.brandColor, border: `1px solid ${channel.brandColor}55` }}>
          {channel.number}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white flex items-center gap-2">
            {channel.name}
            {!channel.isActive && <span className="text-[9px] font-mono uppercase text-white/30 border border-white/15 rounded px-1.5 py-0.5">inactive</span>}
          </p>
          <p className="text-[11px] font-mono text-white/35">
            {channel.blockCount ?? 0} block{(channel.blockCount ?? 0) === 1 ? '' : 's'} · {channel.upcomingSlots ?? 0} upcoming slots
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <button onClick={onGenerate} disabled={generating}
            className="px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest bg-white/5 border border-white/15 text-white/60 hover:bg-white/10 disabled:opacity-40">
            {generating ? 'Generating…' : 'Generate'}
          </button>
          <button onClick={onEdit} className="px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest bg-white/5 border border-white/15 text-white/60 hover:bg-white/10">Edit</button>
          <button onClick={remove} className="px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20">Delete</button>
        </div>
        <span className={`text-white/30 transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
      </div>
      {expanded && <BlocksEditor channelId={channel.id} />}
    </div>
  )
}

function ChannelModal({ channel, onClose, onSaved }: { channel: Channel | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(channel?.name ?? '')
  const [number, setNumber] = useState(channel?.number?.toString() ?? '')
  const [description, setDescription] = useState(channel?.description ?? '')
  const [brandColor, setBrandColor] = useState(channel?.brandColor ?? '#00D4FF')
  const [isActive, setIsActive] = useState(channel?.isActive ?? true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true); setError(null)
    try {
      const body = { name, number: number ? Number(number) : undefined, description, brandColor, isActive }
      if (channel) await channelsApi.update(channel.id, body)
      else await channelsApi.create(body)
      onSaved()
    } catch (e: any) { setError(e.message); setSaving(false) }
  }

  return (
    <Modal title={channel ? 'Edit Channel' : 'New Channel'} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name"><Input value={name} onChange={e => setName(e.target.value)} placeholder="Friday Night Classics" autoFocus /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Number" hint="Blank = next free">
            <Input type="number" min={1} value={number} onChange={e => setNumber(e.target.value)} placeholder="auto" />
          </Field>
          <Field label="Brand colour">
            <div className="flex items-center gap-2">
              <input type="color" value={brandColor} onChange={e => setBrandColor(e.target.value)}
                className="w-10 h-10 rounded-lg bg-transparent border border-white/10 cursor-pointer" />
              <Input value={brandColor} onChange={e => setBrandColor(e.target.value)} />
            </div>
          </Field>
        </div>
        <Field label="Description"><Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional" /></Field>
        {channel && <Toggle checked={isActive} onChange={setIsActive} label="Active" />}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-white/5 text-white/60 text-xs font-bold uppercase tracking-widest">Cancel</button>
          <button onClick={save} disabled={!name.trim() || saving}
            className="px-4 py-2 rounded-lg bg-[#00D4FF] text-noir-950 text-xs font-bold uppercase tracking-widest disabled:opacity-40">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Blocks editor ─────────────────────────────────────────────────────────────

function BlocksEditor({ channelId }: { channelId: number }) {
  const [blocks, setBlocks] = useState<ProgrammingBlock[] | null>(null)
  const [editing, setEditing] = useState<ProgrammingBlock | 'new' | null>(null)

  const reload = useCallback(() => {
    channelsApi.blocks(channelId).then(d => setBlocks(d.blocks)).catch(() => setBlocks([]))
  }, [channelId])
  useEffect(reload, [reload])

  const remove = async (b: ProgrammingBlock) => {
    if (!confirm(`Delete block "${b.name}"?`)) return
    await channelsApi.removeBlock(channelId, b.id)
    reload()
  }

  return (
    <div className="px-4 pb-4 border-t border-white/5 pt-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-mono uppercase tracking-widest text-white/40">Programming blocks</p>
        <button onClick={() => setEditing('new')}
          className="px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-widest bg-white/5 border border-white/15 text-white/60 hover:bg-white/10">
          + Block
        </button>
      </div>
      {!blocks ? <Spinner className="w-4 h-4" /> : blocks.length === 0 ? (
        <p className="text-xs text-white/30 py-2">No blocks — add one (e.g. Fridays 20:00–00:00, films only) and generate.</p>
      ) : (
        <div className="space-y-1.5">
          {blocks.map(b => (
            <div key={b.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-noir-900/60 border border-white/5 text-xs">
              <span className="font-semibold text-white/85">{b.name}</span>
              <span className="font-mono text-white/40">
                {b.daysOfWeek.map(d => DAY_NAMES[d]).join(' ')} · {minuteToLabel(b.startMinute)}–{minuteToLabel(b.endMinute)}
              </span>
              <span className="font-mono text-white/30">
                {b.rules.slots?.length
                  ? `${b.rules.slots.length} programmed slot${b.rules.slots.length === 1 ? '' : 's'}`
                  : b.rules.series_priority?.length
                    ? `${b.rules.series_priority.length}-series stack · ${b.rules.fill_block ? 'fill block' : `${b.rules.episodes_per_slot ?? 1} ep/night`}`
                    : (b.rules.content_types ?? ['film', 'episode']).join('+')}
                {b.rules.genres_any?.length ? ` · ${b.rules.genres_any.join(', ')}` : ''}
                {b.rules.year_from || b.rules.year_to ? ` · ${b.rules.year_from ?? ''}–${b.rules.year_to ?? ''}` : ''}
                {b.rules.watched_filter && b.rules.watched_filter !== 'any' ? ` · ${b.rules.watched_filter}` : ''}
              </span>
              <div className="ml-auto flex gap-1.5">
                <button onClick={() => setEditing(b)} className="px-2 py-1 rounded text-[9px] font-bold uppercase bg-white/5 text-white/50 hover:text-white">Edit</button>
                <button onClick={() => remove(b)} className="px-2 py-1 rounded text-[9px] font-bold uppercase bg-red-500/10 text-red-400/80 hover:text-red-300">Del</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <BlockModal
          channelId={channelId}
          block={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload() }}
        />
      )}
    </div>
  )
}

const DECADES = [1960, 1970, 1980, 1990, 2000, 2010, 2020]

function BlockModal({ channelId, block, onClose, onSaved }: {
  channelId: number; block: ProgrammingBlock | null; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(block?.name ?? '')
  const [days, setDays] = useState<number[]>(block?.daysOfWeek ?? [5])
  const [start, setStart] = useState(minuteToLabel(block?.startMinute ?? 20 * 60))
  const [end, setEnd] = useState(minuteToLabel((block?.endMinute ?? 24 * 60) % 1440))
  const [overnight, setOvernight] = useState((block?.endMinute ?? 0) > 1440 || (block ? block.endMinute <= block.startMinute : false))
  const [contentTypes, setContentTypes] = useState<string>(
    block?.rules.content_types?.length === 1 ? block.rules.content_types[0] : 'both',
  )
  const [genres, setGenres] = useState((block?.rules.genres_any ?? []).join(', '))
  const [maxRuntime, setMaxRuntime] = useState(block?.rules.max_runtime_minutes?.toString() ?? '')
  const [noRepeatDays, setNoRepeatDays] = useState(block?.rules.exclude_aired_within_days?.toString() ?? '7')

  // Films: year window (a decade quick-pick just fills the range).
  const [yearFrom, setYearFrom] = useState(block?.rules.year_from?.toString() ?? '')
  const [yearTo, setYearTo] = useState(block?.rules.year_to?.toString() ?? '')

  // Programmed slots (each with its own fallback stack). Legacy single-stack
  // blocks are converted to one slot on load.
  const initialSlots: SlotDef[] = block?.rules.slots?.length
    ? block.rules.slots
    : block?.rules.series_priority?.length
      ? [{
          sources: block.rules.series_priority.map(e => ({ type: 'series' as const, ...e })),
          count: block.rules.episodes_per_slot,
          fill: block.rules.fill_block,
        }]
      : []
  const [slots, setSlots] = useState<SlotDef[]>(initialSlots)
  const [watchedFilter, setWatchedFilter] = useState<string>(block?.rules.watched_filter ?? (initialSlots.length ? 'unwatched' : 'any'))
  const [seriesOptions, setSeriesOptions] = useState<SeriesOption[]>([])

  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const showFilms = contentTypes !== 'episode'
  const usingSlots = slots.length > 0

  useEffect(() => {
    channelsApi.seriesOptions()
      .then(d => setSeriesOptions(d.series.filter(s => s.availableEpisodeCount > 0)))
      .catch(() => setSeriesOptions([]))
  }, [])

  const toggleDay = (d: number) =>
    setDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort())

  const patchSlot = (i: number, patch: Partial<SlotDef>) =>
    setSlots(slots.map((s, idx) => idx === i ? { ...s, ...patch } : s))
  const moveSlot = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= slots.length) return
    const next = [...slots]
    ;[next[i], next[j]] = [next[j], next[i]]
    setSlots(next)
  }

  const save = async () => {
    setSaving(true); setError(null)
    try {
      const startMinute = timeInputToMinute(start)
      let endMinute = timeInputToMinute(end)
      if (overnight || endMinute <= startMinute) endMinute += 1440
      const cleanSlots = slots
        .map(s => ({ ...s, sources: s.sources.filter(src => src.type === 'films' || src.series_id) }))
        .filter(s => s.sources.length)
      const rules = {
        content_types: contentTypes === 'both' ? undefined : [contentTypes],
        genres_any: genres.split(',').map(g => g.trim()).filter(Boolean),
        max_runtime_minutes: maxRuntime ? Number(maxRuntime) : undefined,
        exclude_aired_within_days: noRepeatDays ? Number(noRepeatDays) : undefined,
        allow_repeats: true,
        year_from: showFilms && yearFrom ? Number(yearFrom) : undefined,
        year_to: showFilms && yearTo ? Number(yearTo) : undefined,
        watched_filter: watchedFilter === 'any' ? undefined : watchedFilter,
        slots: cleanSlots.length ? cleanSlots : undefined,
      }
      const body = { name, daysOfWeek: days, startMinute, endMinute, rules }
      if (block) await channelsApi.updateBlock(channelId, block.id, body)
      else await channelsApi.createBlock(channelId, body)
      onSaved()
    } catch (e: any) { setError(e.message); setSaving(false) }
  }

  const sectionLabel = (text: string) => (
    <p className="text-[10px] font-mono uppercase tracking-[0.25em] text-[#00D4FF]/60 pt-2 border-t border-white/5">{text}</p>
  )

  return (
    <Modal title={block ? 'Edit Block' : 'New Programming Block'} onClose={onClose} width="max-w-2xl">
      <div className="space-y-4">
        <Field label="Name"><Input value={name} onChange={e => setName(e.target.value)} placeholder="Friday Night Classics" autoFocus /></Field>
        <Field label="Days">
          <div className="flex gap-1.5">
            {DAY_NAMES.map((label, d) => (
              <button key={d} onClick={() => toggleDay(d)}
                className={`w-11 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider border transition-all
                  ${days.includes(d) ? 'bg-[#00D4FF]/15 border-[#00D4FF]/60 text-[#00D4FF]' : 'bg-white/5 border-white/10 text-white/35 hover:text-white/60'}`}>
                {label}
              </button>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Start"><Input type="time" value={start} onChange={e => setStart(e.target.value)} /></Field>
          <Field label="End"><Input type="time" value={end} onChange={e => setEnd(e.target.value)} /></Field>
          <Field label="Overnight" hint="End is next day">
            <div className="pt-2"><Toggle checked={overnight} onChange={setOvernight} label="" /></div>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Content">
            <Select value={contentTypes} onChange={e => setContentTypes(e.target.value)}>
              <option value="both">Films + Episodes</option>
              <option value="film">Films only</option>
              <option value="episode">Episodes only</option>
            </Select>
          </Field>
          <Field label="Watched">
            <Select value={watchedFilter} onChange={e => setWatchedFilter(e.target.value)}>
              <option value="any">Any</option>
              <option value="unwatched">Unwatched only</option>
              <option value="watched">Watched only (reruns)</option>
            </Select>
          </Field>
          <Field label="No repeats within (days)"><Input type="number" min={0} value={noRepeatDays} onChange={e => setNoRepeatDays(e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Genres (any of)" hint="Comma-separated; blank = all">
            <Input value={genres} onChange={e => setGenres(e.target.value)} placeholder="Action, Science Fiction" />
          </Field>
          <Field label="Max runtime (min)"><Input type="number" min={1} value={maxRuntime} onChange={e => setMaxRuntime(e.target.value)} placeholder="any" /></Field>
        </div>

        {showFilms && (
          <>
            {sectionLabel('Films — release window')}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Year from"><Input type="number" value={yearFrom} onChange={e => setYearFrom(e.target.value)} placeholder="any" /></Field>
              <Field label="Year to"><Input type="number" value={yearTo} onChange={e => setYearTo(e.target.value)} placeholder="any" /></Field>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {DECADES.map(d => {
                const active = yearFrom === String(d) && yearTo === String(d + 9)
                return (
                  <button key={d}
                    onClick={() => { if (active) { setYearFrom(''); setYearTo('') } else { setYearFrom(String(d)); setYearTo(String(d + 9)) } }}
                    className={`px-2.5 py-1 rounded text-[10px] font-bold border transition-all
                      ${active ? 'bg-[#00D4FF]/15 border-[#00D4FF]/60 text-[#00D4FF]' : 'bg-white/5 border-white/10 text-white/40 hover:text-white/70'}`}>
                    {d}s
                  </button>
                )
              })}
            </div>
          </>
        )}

        {sectionLabel('Programmed slots')}
        <p className="text-[11px] text-white/35 -mt-2">
          Programme the block as a sequence of slots. Each slot has its own ordered fallbacks —
          the first source with matching content airs; when it's fully watched or unavailable it
          falls through to the next (e.g. Slot 1: Sopranos → Breaking Bad → Mad Men, Slot 2:
          The Wire → The Shield). Leave empty to auto-fill the block from the filters above.
        </p>
        {slots.map((slot, i) => (
          <SlotEditor
            key={i}
            index={i}
            slot={slot}
            total={slots.length}
            seriesOptions={seriesOptions}
            onChange={patch => patchSlot(i, patch)}
            onMove={dir => moveSlot(i, dir)}
            onRemove={() => setSlots(slots.filter((_, idx) => idx !== i))}
          />
        ))}
        <button onClick={() => setSlots([...slots, { sources: [], count: 1 }])}
          className="w-full py-2.5 rounded-lg border border-dashed border-white/15 text-white/40 text-[10px] font-bold uppercase tracking-widest hover:border-[#00D4FF]/40 hover:text-[#00D4FF] transition-all">
          + Add slot
        </button>
        {usingSlots && (
          <p className="text-[10px] font-mono text-white/25">
            Slots air in order each occurrence. Auto-fill filters above are ignored except as
            defaults for film-pool fallbacks. Watched = completed via channel playback.
          </p>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-white/5 text-white/60 text-xs font-bold uppercase tracking-widest">Cancel</button>
          <button onClick={save} disabled={!name.trim() || !days.length || saving}
            className="px-4 py-2 rounded-lg bg-[#00D4FF] text-noir-950 text-xs font-bold uppercase tracking-widest disabled:opacity-40">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Slot editor (one programmed slot with its fallback stack) ────────────────

function SlotEditor({ index, slot, total, seriesOptions, onChange, onMove, onRemove }: {
  index: number
  slot: SlotDef
  total: number
  seriesOptions: SeriesOption[]
  onChange: (patch: Partial<SlotDef>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}) {
  const [pick, setPick] = useState('')

  const patchSource = (i: number, patch: Partial<SlotSource>) =>
    onChange({ sources: slot.sources.map((s, idx) => idx === i ? { ...s, ...patch } : s) })
  const moveSource = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= slot.sources.length) return
    const next = [...slot.sources]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange({ sources: next })
  }
  const removeSource = (i: number) =>
    onChange({ sources: slot.sources.filter((_, idx) => idx !== i) })

  const addPick = () => {
    if (!pick) return
    if (pick === 'films') {
      onChange({ sources: [...slot.sources, { type: 'films' }] })
    } else {
      const id = Number(pick)
      if (!slot.sources.some(s => s.type === 'series' && s.series_id === id)) {
        onChange({ sources: [...slot.sources, { type: 'series', series_id: id }] })
      }
    }
    setPick('')
  }

  const seriesTitle = (id?: number) => seriesOptions.find(s => s.id === id)?.title ?? `Series #${id}`
  const roleLabel = (i: number) => i === 0 ? 'Primary' : `Fallback ${i}`

  return (
    <div className="rounded-xl bg-noir-900/70 border border-white/10 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/40 text-[#00D4FF] flex items-center justify-center text-xs font-display shrink-0">{index + 1}</span>
        <Input className="!py-1.5 flex-1" placeholder={`Slot ${index + 1} name (optional)`}
          value={slot.name ?? ''} onChange={e => onChange({ name: e.target.value || undefined })} />
        <span className="text-[9px] font-mono text-white/30 uppercase whitespace-nowrap">Items</span>
        <Input type="number" min={1} className="!w-14 !py-1.5 !px-2 text-center" disabled={slot.fill}
          value={slot.count?.toString() ?? '1'}
          onChange={e => onChange({ count: Math.max(1, Number(e.target.value) || 1) })} />
        <label className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap" title="Keep airing from this slot until the block ends">
          <input type="checkbox" checked={!!slot.fill} onChange={e => onChange({ fill: e.target.checked || undefined })}
            className="accent-[#00D4FF]" />
          <span className="text-[9px] font-mono text-white/40 uppercase">Until end</span>
        </label>
        <button onClick={() => onMove(-1)} disabled={index === 0} className="text-white/40 hover:text-white disabled:opacity-20 px-1">↑</button>
        <button onClick={() => onMove(1)} disabled={index === total - 1} className="text-white/40 hover:text-white disabled:opacity-20 px-1">↓</button>
        <button onClick={onRemove} className="text-red-400/70 hover:text-red-300 px-1">✕</button>
      </div>

      {slot.sources.length === 0 && (
        <p className="text-[10px] font-mono text-amber-400/70 uppercase tracking-wider pl-9">Empty slot — add a series or film pool below</p>
      )}
      {slot.sources.map((src, i) => (
        <div key={i} className="flex items-center gap-2 pl-9">
          <span className={`w-20 shrink-0 text-[9px] font-mono uppercase tracking-wider ${i === 0 ? 'text-[#00D4FF]/80' : 'text-white/35'}`}>{roleLabel(i)}</span>
          {src.type === 'series' ? (
            <>
              <span className="text-xs font-semibold text-white/85 truncate min-w-0 flex-1">{seriesTitle(src.series_id)}</span>
              <span className="text-[9px] font-mono text-white/30 uppercase">Seasons</span>
              <Input type="number" min={0} className="!w-14 !py-1 !px-2 text-center" placeholder="all"
                value={src.season_from?.toString() ?? ''}
                onChange={e => patchSource(i, { season_from: e.target.value ? Number(e.target.value) : undefined })} />
              <span className="text-white/25 text-xs">–</span>
              <Input type="number" min={0} className="!w-14 !py-1 !px-2 text-center" placeholder="all"
                value={src.season_to?.toString() ?? ''}
                onChange={e => patchSource(i, { season_to: e.target.value ? Number(e.target.value) : undefined })} />
            </>
          ) : (
            <>
              <span className="text-xs font-semibold text-white/85 shrink-0">🎬 Film pool</span>
              <Input className="!py-1 !px-2 flex-1 min-w-0" placeholder="genres (any, comma-sep)"
                value={(src.genres_any ?? []).join(', ')}
                onChange={e => patchSource(i, { genres_any: e.target.value.split(',').map(g => g.trim()).filter(Boolean) })} />
              <Input type="number" className="!w-16 !py-1 !px-2 text-center" placeholder="year≥"
                value={src.year_from?.toString() ?? ''}
                onChange={e => patchSource(i, { year_from: e.target.value ? Number(e.target.value) : undefined })} />
              <Input type="number" className="!w-16 !py-1 !px-2 text-center" placeholder="year≤"
                value={src.year_to?.toString() ?? ''}
                onChange={e => patchSource(i, { year_to: e.target.value ? Number(e.target.value) : undefined })} />
            </>
          )}
          <button onClick={() => moveSource(i, -1)} disabled={i === 0} className="text-white/40 hover:text-white disabled:opacity-20 px-1">↑</button>
          <button onClick={() => moveSource(i, 1)} disabled={i === slot.sources.length - 1} className="text-white/40 hover:text-white disabled:opacity-20 px-1">↓</button>
          <button onClick={() => removeSource(i)} className="text-red-400/70 hover:text-red-300 px-1">✕</button>
        </div>
      ))}

      <div className="flex gap-2 pl-9">
        <Select value={pick} onChange={e => setPick(e.target.value)} className="flex-1 !py-1.5">
          <option value="">Add {slot.sources.length ? 'fallback' : 'primary'}…</option>
          <option value="films">🎬 Film pool (by genre / year)</option>
          {seriesOptions.filter(s => !slot.sources.some(src => src.type === 'series' && src.series_id === s.id)).map(s => (
            <option key={s.id} value={s.id}>{s.title}{s.year ? ` (${s.year})` : ''} — {s.availableEpisodeCount} eps</option>
          ))}
        </Select>
        <button onClick={addPick} disabled={!pick}
          className="px-4 rounded-lg bg-white/5 border border-white/15 text-white/70 text-[10px] font-bold uppercase tracking-widest disabled:opacity-30 hover:bg-white/10">
          Add
        </button>
      </div>
    </div>
  )
}

// ── Guide view ────────────────────────────────────────────────────────────────

const PX_PER_MIN = 3

function GuideView() {
  const [dayOffset, setDayOffset] = useState(0)
  const [channels, setChannels] = useState<Channel[]>([])
  const [slots, setSlots] = useState<GuideSlot[] | null>(null)
  const [busySlot, setBusySlot] = useState<number | null>(null)

  const dayStart = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0)
    return d.getTime() + dayOffset * DAY_MS
  }, [dayOffset])

  const reload = useCallback(() => {
    Promise.all([channelsApi.list(), channelsApi.guide(dayStart, dayStart + DAY_MS)])
      .then(([c, g]) => { setChannels(c.channels); setSlots(g.slots) })
      .catch(() => { setChannels([]); setSlots([]) })
  }, [dayStart])
  useEffect(reload, [reload])

  const toggleLock = async (slot: GuideSlot) => {
    setBusySlot(slot.id)
    try { await channelsApi.toggleLock(slot.id); reload() } finally { setBusySlot(null) }
  }
  const removeSlot = async (slot: GuideSlot) => {
    setBusySlot(slot.id)
    try { await channelsApi.removeSlot(slot.id); reload() } finally { setBusySlot(null) }
  }

  const nowMs = Date.now()
  const dayLabel = new Date(dayStart).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })

  if (!slots) return <div className="flex justify-center py-20"><Spinner /></div>

  return (
    <div className="animate-fade-in">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => setDayOffset(d => d - 1)} className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/15 text-white/60 text-xs">←</button>
        <span className="text-sm font-semibold text-white min-w-48 text-center">{dayLabel}{dayOffset === 0 ? ' · Today' : ''}</span>
        <button onClick={() => setDayOffset(d => d + 1)} className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/15 text-white/60 text-xs">→</button>
        {dayOffset !== 0 && <button onClick={() => setDayOffset(0)} className="text-xs font-mono text-[#00D4FF]/70 hover:text-[#00D4FF]">today</button>}
        <p className="ml-auto text-[10px] font-mono text-white/30 uppercase tracking-widest">🔒 lock keeps a slot through regeneration</p>
      </div>

      {channels.length === 0 ? (
        <EmptyState icon="📺" title="No channels" subtitle="Create a channel on the Channels tab first." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/5 bg-noir-900/40">
          <div style={{ width: 24 * 60 * PX_PER_MIN + 160 }}>
            {/* Time scale */}
            <div className="flex sticky top-0 z-10 bg-noir-900/95 border-b border-white/5">
              <div className="w-40 shrink-0" />
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} style={{ width: 60 * PX_PER_MIN }} className="text-[10px] font-mono text-white/30 py-2 pl-1 border-l border-white/5">
                  {String(h).padStart(2, '0')}:00
                </div>
              ))}
            </div>

            {channels.map(c => {
              const channelSlots = slots.filter(s => s.channelId === c.id)
              return (
                <div key={c.id} className="flex border-b border-white/5 last:border-b-0">
                  <div className="w-40 shrink-0 px-3 py-3 flex items-center gap-2">
                    <span className="w-7 h-7 rounded flex items-center justify-center text-xs font-display shrink-0"
                      style={{ backgroundColor: `${c.brandColor}22`, color: c.brandColor }}>{c.number}</span>
                    <span className="text-xs font-semibold text-white/80 truncate">{c.name}</span>
                  </div>
                  <div className="relative h-16 grow">
                    {dayOffset === 0 && nowMs >= dayStart && nowMs < dayStart + DAY_MS && (
                      <div className="absolute top-0 bottom-0 w-px bg-[#FF2D78] z-10"
                        style={{ left: ((nowMs - dayStart) / 60000) * PX_PER_MIN }} />
                    )}
                    {channelSlots.map(s => {
                      const left = Math.max(0, ((s.startsAt - dayStart) / 60000) * PX_PER_MIN)
                      const width = Math.max(24, ((Math.min(s.endsAt, dayStart + DAY_MS) - Math.max(s.startsAt, dayStart)) / 60000) * PX_PER_MIN - 2)
                      const airing = nowMs >= s.startsAt && nowMs < s.endsAt
                      return (
                        <div key={s.id} title={`${s.title} · ${fmtTime(s.startsAt)}–${fmtTime(s.endsAt)}${s.blockName ? ` · ${s.blockName}` : ''}`}
                          className={`group absolute top-1.5 bottom-1.5 rounded-lg border px-2 py-1 overflow-hidden transition-all
                            ${airing ? 'border-[#FF2D78]/70 bg-[#FF2D78]/10' : s.status === 'watched' ? 'border-white/10 bg-white/[0.02] opacity-50' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'}`}
                          style={{ left, width, borderLeftColor: c.brandColor, borderLeftWidth: 2 }}>
                          <p className="text-[11px] font-semibold text-white/85 truncate leading-tight">
                            {s.locked && '🔒 '}{s.seriesTitle ? `${s.seriesTitle} ` : ''}{s.seriesTitle && s.seasonNumber != null ? `S${s.seasonNumber}E${s.episodeNumber}` : s.title}
                          </p>
                          <p className="text-[9px] font-mono text-white/35">{fmtTime(s.startsAt)}</p>
                          <div className="absolute right-1 top-1 hidden group-hover:flex gap-1">
                            <button disabled={busySlot === s.id} onClick={() => toggleLock(s)}
                              className="w-5 h-5 rounded bg-noir-950/90 text-[10px] hover:scale-110 transition-transform" title={s.locked ? 'Unlock' : 'Lock'}>
                              {s.locked ? '🔓' : '🔒'}
                            </button>
                            <button disabled={busySlot === s.id} onClick={() => removeSlot(s)}
                              className="w-5 h-5 rounded bg-noir-950/90 text-[10px] text-red-400 hover:scale-110 transition-transform" title="Remove">✕</button>
                          </div>
                        </div>
                      )
                    })}
                    {channelSlots.length === 0 && (
                      <p className="absolute inset-0 flex items-center pl-4 text-[10px] font-mono text-white/20 uppercase tracking-widest">off air — generate a slate</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
