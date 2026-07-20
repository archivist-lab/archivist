import { useEffect, useState } from 'react'
import type {
  PlayerBrowseFacets,
  PlayerBrowseFilter,
  PlayerFilterableContentType,
  PlayerSortOrder,
  PlayerView,
  PlayerWidgetSort,
} from '@archivist/contracts'
import { useDialogFocus } from '../focus/useDialogFocus.js'

type BrowseSort = Exclude<PlayerWidgetSort, 'source'>

export function BrowseOptionsDrawer({ mediaType, open, filters, facets, view, sort, sortOrder, onClose, onApply }: {
  mediaType: PlayerFilterableContentType
  open: boolean
  filters: PlayerBrowseFilter
  facets: PlayerBrowseFacets
  view: PlayerView
  sort: BrowseSort
  sortOrder: PlayerSortOrder
  onClose: () => void
  onApply: (filters: PlayerBrowseFilter, view: PlayerView, sort: BrowseSort, sortOrder: PlayerSortOrder) => void
}) {
  const [draft, setDraft] = useState(filters)
  const [draftSort, setDraftSort] = useState(sort)
  const [draftOrder, setDraftOrder] = useState(sortOrder)
  const panel = useDialogFocus<HTMLDivElement>(open, onClose)
  useEffect(() => {
    if (!open) return
    setDraft(filters); setDraftSort(sort); setDraftOrder(sortOrder)
  }, [open, filters, sort, sortOrder])
  if (!open) return null

  const toggle = (key: 'genres' | 'studios', value: string) => setDraft(current => ({
    ...current,
    [key]: current[key].includes(value) ? current[key].filter(entry => entry !== value) : [...current[key], value],
  }))
  const reset = () => setDraft({ query: '', genres: [], yearFrom: null, yearTo: null, studios: [], ratingMin: null, availability: 'available', watched: 'all', alphabet: null, collectionId: null })

  return <div className="fixed inset-0 z-50 bg-black/65" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <aside ref={panel} role="dialog" aria-modal="true" aria-label={`${mediaType} options`} className="absolute inset-y-0 right-0 w-[min(42rem,92vw)] overflow-y-auto bg-noir-900 p-8 shadow-2xl ring-1 ring-white/15">
      <div className="flex items-center justify-between"><div><p className="text-xs uppercase tracking-[.25em] text-white/35">{mediaType}</p><h2 className="mt-1 text-3xl font-semibold">Options</h2></div><button data-dialog-initial onClick={onClose} className="player-focusable rounded-full bg-white/8 px-4 py-2">Close</button></div>

      <div className="mt-8 grid grid-cols-2 gap-4">
        <label className="col-span-2 text-xs text-white/45">Search within this view<input value={draft.query} maxLength={120} onChange={event => setDraft({ ...draft, query: event.target.value })} className="player-focusable mt-2 w-full rounded-xl bg-black/35 px-4 py-3 text-base text-white" /></label>
        <Select label="Sort" value={draftSort} values={['title','added','year','rating']} onChange={value => setDraftSort(value as BrowseSort)} />
        <Select label="Order" value={draftOrder} values={['asc','desc']} onChange={value => setDraftOrder(value as PlayerSortOrder)} />
        <Select label="Availability" value={draft.availability} values={['all','available','unavailable']} onChange={value => setDraft({ ...draft, availability: value as PlayerBrowseFilter['availability'] })} />
        <Select label="Watched" value={draft.watched} values={['all','watched','unwatched','in-progress']} onChange={value => setDraft({ ...draft, watched: value as PlayerBrowseFilter['watched'] })} />
        <label className="text-xs text-white/45">Minimum rating<input aria-label="Minimum rating" type="number" min="0" max="10" step="0.5" value={draft.ratingMin ?? ''} onChange={event => setDraft({ ...draft, ratingMin: event.target.value ? Number(event.target.value) : null })} className="player-focusable mt-2 w-full rounded-xl bg-black/35 px-4 py-3 text-white" /></label>
        <label className="text-xs text-white/45">Year from<input aria-label="Year from" type="number" min="1870" max="2200" value={draft.yearFrom ?? ''} onChange={event => setDraft({ ...draft, yearFrom: event.target.value ? Number(event.target.value) : null })} className="player-focusable mt-2 w-full rounded-xl bg-black/35 px-4 py-3 text-white" /></label>
        <label className="text-xs text-white/45">Year to<input aria-label="Year to" type="number" min="1870" max="2200" value={draft.yearTo ?? ''} onChange={event => setDraft({ ...draft, yearTo: event.target.value ? Number(event.target.value) : null })} className="player-focusable mt-2 w-full rounded-xl bg-black/35 px-4 py-3 text-white" /></label>
      </div>

      <FilterChips title="Genres" values={facets.genres} selected={draft.genres} onToggle={value => toggle('genres', value)} />
      <FilterChips title={mediaType === 'films' || mediaType === 'collections' ? 'Studios' : 'Networks'} values={facets.studios} selected={draft.studios} onToggle={value => toggle('studios', value)} />

      <div className="mt-8 flex gap-3 border-t border-white/10 pt-6"><button onClick={reset} className="player-focusable rounded-full bg-white/8 px-5 py-3">Clear</button><button onClick={() => { onApply(draft, view, draftSort, draftOrder); onClose() }} className="player-focusable ml-auto rounded-full bg-white px-7 py-3 font-bold text-black">Apply</button></div>
    </aside>
  </div>
}

function Select({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) {
  return <label className="text-xs text-white/45">{label}<select aria-label={label} value={value} onChange={event => onChange(event.target.value)} className="player-focusable mt-2 w-full rounded-xl bg-noir-800 px-4 py-3 text-white">{values.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
}

function FilterChips({ title, values, selected, onToggle }: { title: string; values: string[]; selected: string[]; onToggle: (value: string) => void }) {
  if (!values.length) return null
  return <fieldset className="mt-7"><legend className="mb-3 text-xs uppercase tracking-[.18em] text-white/35">{title}</legend><div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">{values.map(value => <button type="button" key={value} aria-pressed={selected.includes(value)} onClick={() => onToggle(value)} className={`player-focusable rounded-full px-3 py-1.5 text-xs ${selected.includes(value) ? 'bg-white text-black' : 'bg-white/7 text-white/60'}`}>{value}</button>)}</div></fieldset>
}
