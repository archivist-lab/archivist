import { useEffect, useState } from 'react'
import { Field, Input, Select, Toggle } from './ui.js'
import { confirmDialog, toast } from '../lib/notify.js'
import { sharedApi, type PlayerBoxSet, type PlayerBoxSetSettings, type PlayerBoxSetTemplate, type PlayerBoxSetValue, PLAYER_BOX_SET_FIELDS } from '../lib/shared.api.js'

/**
 * The box set type editor, shared by Settings and the library's Lists page so
 * there is one implementation of it rather than two that drift.
 *
 * A type fixes a field and everything presentational; each set under it supplies
 * only the value. A type sourced from Lists has no sets to configure here at
 * all — the published Lists are its sets.
 *
 * These settings are global. A library selector elsewhere on the page does not
 * scope them, which the copy below says out loud.
 */

const WATCH_STATES = [
  { value: 'all', label: 'Any' }, { value: 'unwatched', label: 'Unwatched' },
  { value: 'watched', label: 'Watched' }, { value: 'in-progress', label: 'Part-watched' },
]

function NumField({ label, value, min, max, suffix, onChange }: { label: string; value: number; min?: number; max?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <div className="space-y-2">
      <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">{label}</label>
      <div className="flex items-center gap-2">
        <input type="number" min={min} max={max} value={value}
          onChange={e => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) onChange(n) }}
          className="w-28 bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/70 outline-none focus:border-white/20" />
        {suffix && <span className="text-[10px] font-mono text-white/30 uppercase">{suffix}</span>}
      </div>
    </div>
  )
}

const FIELD_LABEL: Record<string, string> = {
  director: 'Director', writer: 'Writer', producer: 'Producer', composer: 'Composer',
  cinematographer: 'Cinematographer', editor: 'Editor', creator: 'Creator',
  starring: 'Starring', any_cast: 'Any cast member', genre: 'Genre', studio: 'Studio',
  network: 'Network', collection: 'Collection', country: 'Country', decade: 'Decade',
  certification: 'Certification',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthDayLabel = (value: string) => {
  const [month, day] = value.split('-').map(Number)
  return `${day} ${MONTHS[month - 1] ?? '?'}`
}

/** Picks a value that exists in the library, so a set is never empty by typo. */
function ValuePicker({ mediaType, field, value, onChange }: {
  mediaType: 'films' | 'series'
  field: string
  value: string
  onChange: (next: string) => void
}) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<PlayerBoxSetValue[] | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const timer = setTimeout(() => {
      sharedApi.system.playerBoxSetValues(mediaType, field, query)
        .then(response => { if (!cancelled) setOptions(response.values) })
        .catch(() => { if (!cancelled) setOptions([]) })
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, mediaType, field, query])

  return (
    <div className="relative">
      <Input value={open ? query : value} placeholder="Search the library…" className="w-56"
        onFocus={() => { setOpen(true); setQuery('') }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={event => setQuery(event.target.value)} />
      {open && (
        <div className="absolute z-20 mt-1 max-h-64 w-72 overflow-y-auto rounded-xl border border-white/10 bg-noir-900 p-1 shadow-xl">
          {options === null && <p className="px-3 py-2 text-xs text-white/30">Searching…</p>}
          {options?.length === 0 && <p className="px-3 py-2 text-xs text-white/30">Nothing in the library matches.</p>}
          {options?.map(option => (
            <button key={option.value} type="button"
              onMouseDown={event => { event.preventDefault(); onChange(option.value); setOpen(false) }}
              className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-left text-sm text-white/70 hover:bg-white/10 hover:text-white">
              <span className="truncate">{option.value}</span>
              <span className="font-mono text-[10px] text-white/30">{option.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Artwork and description for a theme or a set. Both are optional: artwork
 * falls back to the person's own portrait and then to the set's first item, so
 * this is for overriding a poor automatic choice rather than a required step.
 */
function MetadataModal({ title, imageUrl, overview, hint, onChange, onClose }: {
  title: string
  imageUrl: string | null
  overview: string | null
  hint: string
  onChange: (patch: { imageUrl?: string | null; overview?: string | null }) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-noir-900 p-6" onClick={event => event.stopPropagation()}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-display text-xl uppercase tracking-widest text-white/80">{title}</h3>
            <p className="mt-1 text-xs text-white/35">{hint}</p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="rounded-lg border border-white/10 px-3 py-1 text-white/40 hover:text-white">×</button>
        </div>
        <div className="space-y-4">
          <Field label="Artwork URL" hint="Landscape reads best on the tile. Leave empty to use the automatic choice.">
            <Input value={imageUrl ?? ''} placeholder="https://… or /media/…"
              onChange={event => onChange({ imageUrl: event.target.value || null })} />
          </Field>
          {imageUrl && (
            <img src={imageUrl} alt="" className="h-32 w-full rounded-xl object-cover"
              onError={event => { event.currentTarget.style.display = 'none' }} />
          )}
          <Field label="Description" hint="Shown beside the tile in the Player.">
            <textarea value={overview ?? ''} rows={4}
              onChange={event => onChange({ overview: event.target.value || null })}
              className="w-full rounded-lg border border-white/10 bg-noir-900 px-3 py-2.5 text-sm text-white/90 placeholder-white/20 focus:border-white/30 focus:outline-none" />
          </Field>
        </div>
        <div className="mt-6 flex justify-end">
          <button onClick={onClose}
            className="rounded-lg border border-white/15 px-5 py-2 font-mono text-[11px] uppercase tracking-widest text-white/60 hover:text-white">Done</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Box sets: families of Player rows that differ in exactly one value.
 *
 * The template fixes the field and the presentation — "Directed by {value}",
 * posters, by release date — and each set under it supplies only the name. A
 * season limits a set to a recurring date range, which is how a horror shelf
 * shows up for October and nowhere else.
 */
export function PlayerBoxSetsEditor() {
  const [settings, setSettings] = useState<PlayerBoxSetSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [editing, setEditing] = useState<{ templateId: string; setId?: string } | null>(null)

  const load = () => sharedApi.system.playerBoxSets().then(response => { setSettings(response.settings); setDirty(false) }).catch(error => toast.error(String(error)))
  useEffect(() => { void load() }, [])

  const edit = (next: (templates: PlayerBoxSetTemplate[]) => PlayerBoxSetTemplate[]) => {
    setSettings(current => current && ({ ...current, templates: next(current.templates) }))
    setDirty(true)
  }
  const editTemplate = (id: string, patch: Partial<PlayerBoxSetTemplate>) =>
    edit(templates => templates.map(entry => entry.id === id ? { ...entry, ...patch } : entry))
  const editSet = (templateId: string, setId: string, patch: Partial<PlayerBoxSet>) =>
    edit(templates => templates.map(entry => entry.id !== templateId ? entry
      : { ...entry, sets: entry.sets.map(set => set.id === setId ? { ...set, ...patch } : set) }))
  const addSet = (templateId: string) =>
    edit(templates => templates.map(entry => entry.id !== templateId ? entry : {
      ...entry,
      sets: [...entry.sets, { id: `set-${Date.now().toString(36)}`, value: '', label: null, enabled: true, season: null, imageUrl: null, overview: null }],
    }))
  const removeSet = (templateId: string, setId: string) =>
    edit(templates => templates.map(entry => entry.id !== templateId ? entry
      : { ...entry, sets: entry.sets.filter(set => set.id !== setId) }))
  const addTemplate = () =>
    edit(templates => [...templates, {
      id: `template-${Date.now().toString(36)}`, name: 'New type', source: 'field', field: 'director',
      labelPattern: '{value}', mediaType: 'films', enabled: true, sort: 'released', sortOrder: 'desc',
      limit: 18, view: 'landscape', watchState: 'all', season: null, imageUrl: null, overview: null, sets: [],
    }])
  const removeTemplate = (id: string) => edit(templates => templates.filter(entry => entry.id !== id))

  const save = async () => {
    if (!settings) return
    setBusy(true)
    try {
      const response = await sharedApi.system.setPlayerBoxSets(settings)
      setSettings(response.settings)
      setDirty(false)
      toast.error('Box set types saved.')
    } catch (error) { toast.error(String(error)) }
    finally { setBusy(false) }
  }
  const reset = async () => {
    if (!await confirmDialog({ title: 'Reset box set types?', message: 'Every type returns to its shipped form and the sets you added are removed.', confirmLabel: 'Reset' })) return
    setBusy(true)
    try {
      const response = await sharedApi.system.resetPlayerBoxSets()
      setSettings(response.settings)
      setDirty(false)
    } catch (error) { toast.error(String(error)) }
    finally { setBusy(false) }
  }

  if (!settings) return <div className="text-xs font-mono text-white/35">Loading box set types…</div>

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <p className="max-w-2xl text-xs text-white/35">
          A type fixes the shape — "Directed by {'{value}'}" — and each set under it supplies only the name.
          Types appear as tiles in the Player's Box Sets row, with their sets behind them; a set with a season shows only inside that date range.
          A type can instead draw its sets from the library Lists published to the Player, which then carry their own artwork and description.
          Types are shared by every library.
        </p>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={reset} disabled={busy}
            className="rounded-lg border border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-white/40 transition-colors hover:text-white disabled:opacity-40">Reset</button>
          <button onClick={save} disabled={busy || !dirty}
            className="rounded-lg border border-[#00D4FF]/30 bg-[#00D4FF]/15 px-5 py-2 font-mono text-[11px] uppercase tracking-widest text-[#00D4FF] transition-colors hover:bg-[#00D4FF]/25 disabled:opacity-40">
            {dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </div>

      <Field label="Row heading" hint="The heading above the row of theme tiles in the Player.">
        <Input value={settings.rowLabel} className="w-64"
          onChange={event => { setSettings(current => current && ({ ...current, rowLabel: event.target.value })); setDirty(true) }} />
      </Field>

      {settings.templates.map(template => (
        <section key={template.id} className="space-y-4 rounded-2xl border border-white/8 bg-white/[0.02] p-6">
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Type">
              <Input value={template.name} className="w-48"
                onChange={event => editTemplate(template.id, { name: event.target.value })} />
            </Field>
            <Field label="Media">
              <Select value={template.mediaType} className="w-32"
                onChange={event => {
                  const mediaType = event.target.value as 'films' | 'series'
                  const fields = PLAYER_BOX_SET_FIELDS[mediaType]
                  // A field the new type has no notion of would match nothing.
                  editTemplate(template.id, { mediaType, field: fields.includes(template.field) ? template.field : fields[0] })
                }}>
                <option value="films">Films</option>
                <option value="series">Series</option>
              </Select>
            </Field>
            <Field label="Sets from">
              <Select value={template.source} className="w-40"
                onChange={event => editTemplate(template.id, { source: event.target.value as PlayerBoxSetTemplate['source'] })}>
                <option value="field">A metadata field</option>
                <option value="lists">Library lists</option>
              </Select>
            </Field>
            {template.source === 'field' && (
              <Field label="Varies by">
                <Select value={template.field} className="w-44"
                  onChange={event => editTemplate(template.id, { field: event.target.value as PlayerBoxSetTemplate['field'] })}>
                  {PLAYER_BOX_SET_FIELDS[template.mediaType].map(field => (
                    <option key={field} value={field}>{FIELD_LABEL[field] ?? field}</option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Heading" hint={template.source === 'lists' ? '{value} is the list\u2019s name.' : '{value} is replaced per set.'}>
              <Input value={template.labelPattern} className="w-56"
                onChange={event => editTemplate(template.id, { labelPattern: event.target.value })} />
            </Field>
            <Field label="Sort by">
              <Select value={template.sort} className="w-36"
                onChange={event => editTemplate(template.id, { sort: event.target.value as PlayerBoxSetTemplate['sort'] })}>
                <option value="released">Release date</option>
                <option value="added">Date added</option>
                <option value="title">Title</option>
                <option value="rating">Rating</option>
                <option value="year">Year</option>
                <option value="random">Random</option>
              </Select>
            </Field>
            <Field label="Order">
              <Select value={template.sortOrder} className="w-32"
                onChange={event => editTemplate(template.id, { sortOrder: event.target.value as 'asc' | 'desc' })}>
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </Select>
            </Field>
            <NumField label="Max items" value={template.limit} min={1} max={100}
              onChange={value => editTemplate(template.id, { limit: value })} />
            <Field label="Tiles" hint="Shape of this type's tile and its sets'.">
              <Select value={template.view} className="w-36"
                onChange={event => editTemplate(template.id, { view: event.target.value as PlayerBoxSetTemplate['view'] })}>
                <option value="landscape">Landscape</option>
                <option value="poster">Poster</option>
              </Select>
            </Field>
            <Field label="Watched">
              <Select value={template.watchState} className="w-36"
                onChange={event => editTemplate(template.id, { watchState: event.target.value as PlayerBoxSetTemplate['watchState'] })}>
                {WATCH_STATES.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </Select>
            </Field>
            <div className="pb-1">
              <Toggle checked={template.enabled} onChange={value => editTemplate(template.id, { enabled: value })} label="Shown" />
            </div>
            <button onClick={() => setEditing({ templateId: template.id })}
              className="mb-1 rounded-lg border border-white/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-white/40 hover:text-white">
              Artwork &amp; text{template.imageUrl || template.overview ? ' ✓' : ''}
            </button>
            <button onClick={() => removeTemplate(template.id)}
              className="mb-1 ml-auto rounded-lg border border-[#FF2D78]/25 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-[#FF2D78]/70 hover:text-[#FF2D78]">Remove type</button>
          </div>

          {template.source === 'lists' ? (
            <p className="border-t border-white/5 pt-4 text-xs text-white/35">
              One set per list published to the Player, in the {template.mediaType === 'films' ? 'Films' : 'Series'} library.
              Its artwork, description and heading are edited on the list itself, under Lists → Edit → Player box set.
            </p>
          ) : (
          <div className="space-y-2 border-t border-white/5 pt-4">
            {template.sets.map(set => (
              <div key={set.id} className="flex flex-wrap items-end gap-4 rounded-xl border border-white/8 bg-black/25 p-3">
                <Field label={FIELD_LABEL[template.field] ?? 'Value'}>
                  <ValuePicker mediaType={template.mediaType} field={template.field} value={set.value}
                    onChange={value => editSet(template.id, set.id, { value })} />
                </Field>
                <Field label="Heading override" hint={set.value ? template.labelPattern.replace('{value}', set.value) : 'Uses the template heading.'}>
                  <Input value={set.label ?? ''} placeholder="—" className="w-52"
                    onChange={event => editSet(template.id, set.id, { label: event.target.value || null })} />
                </Field>
                <Field label="In season" hint={set.season ? `${monthDayLabel(set.season.from)} – ${monthDayLabel(set.season.to)}, every year` : 'All year.'}>
                  <div className="flex items-center gap-2">
                    <Input type="text" placeholder="MM-DD" value={set.season?.from ?? ''} className="w-24"
                      onChange={event => editSet(template.id, set.id, {
                        season: event.target.value ? { from: event.target.value, to: set.season?.to ?? event.target.value } : null,
                      })} />
                    <span className="text-white/25">–</span>
                    <Input type="text" placeholder="MM-DD" value={set.season?.to ?? ''} className="w-24"
                      onChange={event => editSet(template.id, set.id, {
                        season: event.target.value ? { from: set.season?.from ?? event.target.value, to: event.target.value } : null,
                      })} />
                  </div>
                </Field>
                <div className="pb-1">
                  <Toggle checked={set.enabled} onChange={value => editSet(template.id, set.id, { enabled: value })} label="Shown" />
                </div>
                <button onClick={() => setEditing({ templateId: template.id, setId: set.id })}
                  className="mb-1 ml-auto rounded-lg border border-white/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-white/40 hover:text-white">
                  Artwork &amp; text{set.imageUrl || set.overview ? ' ✓' : ''}
                </button>
                <button onClick={() => removeSet(template.id, set.id)}
                  className="mb-1 rounded-lg border border-white/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-white/40 hover:text-white">Remove</button>
              </div>
            ))}
            <button onClick={() => addSet(template.id)}
              className="rounded-lg border border-white/15 px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-white/50 transition-colors hover:text-white">
              + Add {FIELD_LABEL[template.field]?.toLowerCase() ?? 'set'}
            </button>
          </div>
          )}
        </section>
      ))}

      <button onClick={addTemplate}
        className="rounded-lg border border-white/15 px-5 py-2.5 font-mono text-[11px] uppercase tracking-widest text-white/50 transition-colors hover:text-white">+ Add type</button>

      {(() => {
        if (!editing) return null
        const template = settings.templates.find(entry => entry.id === editing.templateId)
        if (!template) return null
        const set = editing.setId ? template.sets.find(entry => entry.id === editing.setId) : undefined
        if (editing.setId && !set) return null
        return set
          ? <MetadataModal
              title={set.label ?? template.labelPattern.replace('{value}', set.value || '…')}
              hint="Shown on this set's tile, after you drill into the type."
              imageUrl={set.imageUrl} overview={set.overview}
              onChange={patch => editSet(template.id, set.id, patch)}
              onClose={() => setEditing(null)} />
          : <MetadataModal
              title={template.name}
              hint="Shown on this type's own tile, in the row on the browsing surface."
              imageUrl={template.imageUrl} overview={template.overview}
              onChange={patch => editTemplate(template.id, patch)}
              onClose={() => setEditing(null)} />
      })()}
    </div>
  )
}
