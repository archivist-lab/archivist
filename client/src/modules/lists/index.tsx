import React, { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import type { FilterNode, ListCreateRequest } from '@archivist/contracts'
import { Field, Input, Select, Spinner, Toggle } from '../../components/ui.js'
import { CalendarItemModal, type CalendarModalItem } from '../../components/CalendarItemModal.js'
import { tmdbImage } from '../../lib/api.js'
import { listsApi, type ArchivistList, type ListItem, type ListLookupResult, type ListRun, type ListStatus, type PreviewMember } from '../../lib/lists.api.js'
import { confirmDialog, toast } from '../../lib/notify.js'
import { sharedApi, type QualityProfile, type RootFolder } from '../../lib/shared.api.js'
import { useTabs, type Tab } from '../../lib/tab-context.js'
import { useLiveRefresh } from '../../lib/useLiveRefresh.js'
import { filmsApi } from '../../lib/films.api.js'
import { seriesApi } from '../../lib/series.api.js'

const STATUS: ListStatus[] = ['new', 'failed', 'added', 'in_library', 'dismissed', 'departed']
const OP_LABELS: Record<string, string> = {
  genre: 'Genre', year: 'Release year', rating: 'Provider rating', runtime: 'Runtime',
  language: 'Original language', certification: 'Certification', keyword: 'TMDB keyword',
  title: 'Specific title', person: 'Person', company: 'Production company', watchProvider: 'Watch provider',
}

type ClauseDraft = {
  key: number
  op: Exclude<FilterNode['op'], 'and' | 'or' | 'not'>
  mode: 'includes' | 'excludes'
  values: string
  min: string
  max: string
  minVotes: string
  country: string
  role: 'starring' | 'cast' | 'director' | 'producer' | 'executive_producer' | 'writer' | 'creator' | 'composer' | 'cinematographer' | 'editor' | 'crew' | 'any'
  labels: Record<string, string>
}

let draftKey = 1
const newClause = (op: ClauseDraft['op'] = 'genre'): ClauseDraft => ({
  key: draftKey++, op, mode: 'includes', values: op === 'genre' ? 'Drama' : '', min: '', max: '', minVotes: '', country: 'US', role: 'any', labels: {},
})
const splitValues = (value: string) => value.split(',').map(v => v.trim()).filter(Boolean)
const maybeNumber = (value: string) => value.trim() === '' ? undefined : Number(value)

function clauseToFilter(clause: ClauseDraft): FilterNode {
  const values = splitValues(clause.values)
  switch (clause.op) {
    case 'genre': return { op: 'genre', mode: clause.mode, values }
    case 'year': return { op: 'year', min: maybeNumber(clause.min), max: maybeNumber(clause.max) }
    case 'rating': return { op: 'rating', source: 'provider', min: maybeNumber(clause.min), max: maybeNumber(clause.max), minVotes: maybeNumber(clause.minVotes) }
    case 'runtime': return { op: 'runtime', min: maybeNumber(clause.min), max: maybeNumber(clause.max) }
    case 'language': return { op: 'language', values }
    case 'certification': return { op: 'certification', country: clause.country.trim().toUpperCase(), values }
    case 'keyword': return { op: 'keyword', mode: clause.mode, values }
    case 'title': return { op: 'title', mode: clause.mode, ids: values.map(Number), labels: clause.labels }
    case 'person': return { op: 'person', role: clause.role, ids: values.map(Number), labels: clause.labels }
    case 'company': return { op: 'company', ids: values.map(Number), labels: clause.labels }
    case 'watchProvider': return { op: 'watchProvider', region: clause.country.trim().toUpperCase(), ids: values.map(Number) }
  }
}

function filterToDrafts(filter: FilterNode): { combinator: 'and' | 'or'; clauses: ClauseDraft[] } | null {
  const combinator = filter.op === 'or' ? 'or' : 'and'
  const nodes = filter.op === 'and' || filter.op === 'or' ? filter.nodes : [filter]
  if (nodes.some(node => node.op === 'and' || node.op === 'or' || node.op === 'not')) return null
  return {
    combinator,
    clauses: nodes.map(node => {
      const clause = newClause(node.op as ClauseDraft['op'])
      if ('mode' in node) clause.mode = node.mode
      if ('values' in node) clause.values = node.values.join(', ')
      if ('ids' in node) clause.values = node.ids.join(', ')
      if ('min' in node && node.min != null) clause.min = String(node.min)
      if ('max' in node && node.max != null) clause.max = String(node.max)
      if ('minVotes' in node && node.minVotes != null) clause.minVotes = String(node.minVotes)
      if ('country' in node) clause.country = node.country
      if ('region' in node) clause.country = node.region
      if ('role' in node) clause.role = node.role
      if ('labels' in node && node.labels) clause.labels = node.labels
      return clause
    }),
  }
}

function buildFilter(combinator: 'and' | 'or', clauses: ClauseDraft[]): FilterNode {
  const nodes = clauses.map(clauseToFilter)
  if (nodes.length === 1) return nodes[0]
  return { op: combinator, nodes }
}

const accentFor = (tab?: Tab | null) => tab?.media_type === 'series' ? '#9B59B6' : '#00D4FF'

function ActionButton({ children, onClick, disabled, danger = false, accent = '#00D4FF', type = 'button' }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean; accent?: string; type?: 'button' | 'submit'
}) {
  const color = danger ? '#F87171' : accent
  return <button type={type} onClick={onClick} disabled={disabled}
    className="rounded-lg border px-4 py-2 text-[10px] font-bold uppercase tracking-widest transition-all disabled:cursor-not-allowed disabled:opacity-35"
    style={{ color, borderColor: `${color}55`, backgroundColor: `${color}14` }}>{children}</button>
}

function PageShell({ children }: { children: ReactNode }) {
  const { tabs, activeTabId, setActiveTabId } = useTabs()
  const libraries = tabs.filter(tab => tab.media_type === 'films' || tab.media_type === 'series')
  const selected = libraries.find(tab => tab.id === activeTabId) ?? libraries[0]
  useEffect(() => { if (selected && selected.id !== activeTabId) setActiveTabId(selected.id) }, [selected?.id])
  if (!selected) return <div className="rounded-2xl border border-white/10 bg-noir-900/60 p-8 text-sm text-white/50">Create a Films or Series library before using Lists.</div>
  return <div className="space-y-6">
    <header className="flex flex-col gap-4 border-b border-white/5 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div><div className="mb-2 font-mono text-[9px] uppercase tracking-[0.35em]" style={{ color: accentFor(selected) }}>Discovery automation</div><h1 className="font-display text-4xl uppercase tracking-[0.08em] text-white">Lists</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/40">Define the collection once. Archivist finds new matches and holds them for your approval.</p></div>
      <Select value={selected.id} onChange={event => setActiveTabId(Number(event.target.value))} className="sm:w-64">{libraries.map(tab => <option key={tab.id} value={tab.id}>{tab.name} · {tab.media_type === 'films' ? 'Films' : 'Series'}</option>)}</Select>
    </header>{children}
  </div>
}

function ListsOverview() {
  const { activeTab } = useTabs()
  const tabId = activeTab?.id
  const [lists, setLists] = useState<ArchivistList[]>([])
  const [loading, setLoading] = useState(true)
  const load = async () => { if (!tabId) return; try { setLists((await listsApi.list(tabId)).lists) } catch (error) { toast.error(error) } finally { setLoading(false) } }
  useLiveRefresh(load, { enabled: Boolean(tabId), events: ['lists:new-items', 'lists:item-added'] })
  const accent = accentFor(activeTab)
  if (loading) return <div className="flex justify-center py-24"><Spinner className="h-8 w-8" /></div>
  return <div className="space-y-5">
    <div className="flex items-center justify-between"><span className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/25">{lists.length} configured</span><Link to="new"><ActionButton accent={accent}>New list</ActionButton></Link></div>
    {lists.length === 0 ? <div className="rounded-3xl border border-dashed border-white/10 bg-noir-900/35 px-6 py-20 text-center"><div className="font-display text-2xl uppercase tracking-widest text-white/65">Build your first collection</div><p className="mx-auto mt-3 max-w-lg text-sm text-white/35">Try “Highly rated science fiction since 2015” or “Drama series from the BBC”. Preview the result before anything is saved.</p><Link to="new" className="mt-6 inline-block"><ActionButton accent={accent}>Create a list</ActionButton></Link></div> :
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{lists.map(list => <Link to={String(list.id)} key={list.id} className="group rounded-2xl border border-white/5 bg-noir-900/55 p-5 transition-all hover:border-white/15 hover:bg-noir-900/80">
        <div className="flex items-start justify-between gap-4"><div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate font-display text-xl uppercase tracking-wide text-white/90">{list.name}</h2>{!list.enabled && <span className="rounded bg-white/5 px-2 py-0.5 font-mono text-[8px] uppercase text-white/30">Paused</span>}</div><p className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/35">{list.description || 'No description'}</p></div><div className="min-w-16 rounded-xl border px-3 py-2 text-center" style={{ borderColor: `${accent}33`, backgroundColor: `${accent}0c` }}><div className="font-display text-2xl" style={{ color: accent }}>{list.pendingCount ?? 0}</div><div className="font-mono text-[7px] uppercase tracking-widest text-white/30">Review</div></div></div>
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/5 pt-4 font-mono text-[9px] uppercase tracking-wider text-white/25"><span>{list.memberCount ?? 0} matches</span><span>Every {list.refreshIntervalHours}h</span><span>Approval</span><span className="ml-auto normal-case">{list.lastRefreshedAt ? `Updated ${new Date(list.lastRefreshedAt).toLocaleString()}` : 'Not run yet'}</span></div>{list.lastError && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{list.lastError}</p>}
      </Link>)}</div>}
  </div>
}

function SmartEntityInput({ kind, mediaType, ids, labels, onChange }: {
  kind: 'person' | 'company' | 'title'; mediaType: 'film' | 'series'; ids: number[]; labels: Record<string, string>
  onChange: (ids: number[], labels: Record<string, string>) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ListLookupResult[]>([])
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    const clean = query.trim()
    if (clean.length < 2 && !/^\d+$/.test(clean)) { setResults([]); return }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setLoading(true)
      try { const response = await listsApi.lookup(kind, mediaType, clean); if (!cancelled) setResults(response.results.filter(result => !ids.includes(result.id))) }
      catch (error) { if (!cancelled) toast.error(error) }
      finally { if (!cancelled) setLoading(false) }
    }, 300)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [kind, mediaType, query, ids.join(',')])

  const add = (result: ListLookupResult) => { onChange([...ids, result.id], { ...labels, [result.id]: result.label }); setQuery(''); setResults([]) }
  const remove = (id: number) => { const nextLabels = { ...labels }; delete nextLabels[id]; onChange(ids.filter(value => value !== id), nextLabels) }
  const noun = kind === 'title' ? mediaType === 'film' ? 'film or TMDB ID' : 'series or TMDB ID' : `${kind} or TMDB ID`
  return <div className="relative sm:col-span-2">
    {ids.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{ids.map(id => <span key={id} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[10px] text-white/70"><span>{labels[id] ?? `TMDB ${id}`}</span><span className="font-mono text-[8px] text-white/25">{id}</span><button type="button" onClick={() => remove(id)} className="text-white/30 hover:text-red-300">✕</button></span>)}</div>}
    <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={`Search ${noun}…`} autoComplete="off" />
    {(loading || results.length > 0) && <div className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-white/10 bg-noir-800 p-1 shadow-2xl">
      {loading && <div className="flex justify-center p-4"><Spinner className="h-5 w-5" /></div>}
      {!loading && results.map(result => <button key={result.id} type="button" onClick={() => add(result)} className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-white/5">
        <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-white/5">{result.imagePath ? <img src={tmdbImage(result.imagePath, 'w92')} alt="" className="h-full w-full object-cover" /> : null}</div>
        <div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-white/80">{result.label}</div><div className="mt-1 truncate font-mono text-[9px] text-white/30">{result.subtitle ? `${result.subtitle} · ` : ''}TMDB {result.id}</div></div>
      </button>)}
    </div>}
  </div>
}

function ClauseEditor({ clause, onChange, onRemove, canRemove, operations, mediaType }: { clause: ClauseDraft; onChange: (next: ClauseDraft) => void; onRemove: () => void; canRemove: boolean; operations: Record<string, boolean>; mediaType: 'film' | 'series' }) {
  const patch = (value: Partial<ClauseDraft>) => onChange({ ...clause, ...value })
  const bounds = clause.op === 'year' || clause.op === 'rating' || clause.op === 'runtime'
  const smartKind = clause.op === 'person' || clause.op === 'company' || clause.op === 'title' ? clause.op : null
  const roleOptions: Array<[ClauseDraft['role'], string]> = [
    ['starring', 'Starring'], ['cast', 'Any cast'], ['director', 'Director'], ['producer', 'Producer'],
    ['executive_producer', 'Executive producer'], ['writer', 'Writer'], ['creator', 'Creator'],
    ['composer', 'Composer'], ['cinematographer', 'Cinematographer'], ['editor', 'Editor'], ['crew', 'Any crew'], ['any', 'Any credit'],
  ]
  return <div className="rounded-xl border border-white/8 bg-noir-950/45 p-4"><div className="flex gap-3"><Select value={clause.op} onChange={e => patch({ op: e.target.value as ClauseDraft['op'], values: '', labels: {}, min: '', max: '' })}>{Object.entries(OP_LABELS).map(([value, label]) => <option key={value} value={value} disabled={operations[value] === false}>{label}{operations[value] === false ? ' · unavailable' : ''}</option>)}</Select>{canRemove && <button type="button" onClick={onRemove} className="px-2 text-white/25 hover:text-red-400" aria-label="Remove filter">✕</button>}</div>
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">{bounds ? <><Input type="number" value={clause.min} onChange={e => patch({ min: e.target.value })} placeholder={clause.op === 'year' ? 'From year' : 'Minimum'} /><Input type="number" value={clause.max} onChange={e => patch({ max: e.target.value })} placeholder={clause.op === 'year' ? 'To year' : 'Maximum'} />{clause.op === 'rating' && <Input type="number" value={clause.minVotes} onChange={e => patch({ minVotes: e.target.value })} placeholder="Minimum votes" />}</> : <>
      {(clause.op === 'genre' || clause.op === 'keyword' || clause.op === 'title') && <Select value={clause.mode} onChange={e => patch({ mode: e.target.value as ClauseDraft['mode'] })}><option value="includes">Includes</option><option value="excludes">Excludes</option></Select>}
      {clause.op === 'person' && <Select value={clause.role} onChange={e => patch({ role: e.target.value as ClauseDraft['role'] })}>{roleOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>}
      {(clause.op === 'certification' || clause.op === 'watchProvider') && <Input maxLength={2} value={clause.country} onChange={e => patch({ country: e.target.value })} placeholder="US" />}
      {smartKind ? <SmartEntityInput kind={smartKind} mediaType={mediaType} ids={splitValues(clause.values).map(Number).filter(value => value > 0)} labels={clause.labels} onChange={(ids, labels) => patch({ values: ids.join(', '), labels })} /> : <Input className="sm:col-span-2" value={clause.values} onChange={e => patch({ values: e.target.value })} placeholder={clause.op === 'watchProvider' ? 'TMDB provider IDs, comma separated' : clause.op === 'language' ? 'en, fr' : 'Values, comma separated'} />}
    </>}</div>
  </div>
}

function PreviewPanel({ loading, error, matchCount, sample, warning, accent, mediaType }: { loading: boolean; error: string; matchCount: number | null; sample: PreviewMember[]; warning: string | null; accent: string; mediaType: 'film' | 'series' }) {
  const [selected, setSelected] = useState<PreviewMember | null>(null)
  return <>
    <aside className="rounded-2xl border border-white/8 bg-noir-900/60 p-5 xl:sticky xl:top-6 xl:self-start"><div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/25">Live preview</div><div className="mt-3 flex items-baseline gap-3"><span className="font-display text-5xl" style={{ color: accent }}>{loading ? '…' : matchCount ?? '—'}</span><span className="font-mono text-[9px] uppercase text-white/30">matches</span></div>{error && <p className="mt-3 rounded-lg bg-red-500/10 p-3 text-xs leading-relaxed text-red-300">{error}</p>}{warning && <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">{warning}</p>}<div className="mt-5 grid grid-cols-4 gap-2">{sample.slice(0, 12).map(item => <button type="button" key={item.tmdbId} onClick={() => setSelected(item)} title={`${item.title}${item.year ? ` (${item.year})` : ''}`} aria-label={`View ${item.title}`} className="aspect-[2/3] overflow-hidden rounded-lg bg-white/5 text-left transition-all hover:scale-[1.03] hover:ring-1 hover:ring-white/30 focus:outline-none focus:ring-2" style={{ '--tw-ring-color': accent } as React.CSSProperties}>{item.posterPath ? <img src={tmdbImage(item.posterPath)} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center px-1 text-center text-[8px] text-white/25">{item.title}</span>}</button>)}</div><p className="mt-4 text-[10px] leading-relaxed text-white/25">Click a title for details. Preview is read-only; saving a list still requires you to approve each new candidate.</p></aside>
    {selected && <CalendarItemModal item={{
      tmdbId: selected.tmdbId,
      type: mediaType,
      title: selected.title,
      displayTitle: selected.title,
      displaySub: selected.year ? String(selected.year) : 'Release',
      date: selected.releaseDate,
      overview: selected.overview,
      poster_path: selected.posterPath,
    }} onClose={() => setSelected(null)} />}
  </>
}

function ListBuilder({ editing = false }: { editing?: boolean }) {
  const { id } = useParams(); const navigate = useNavigate(); const { activeTab } = useTabs(); const tabId = activeTab?.id
  const mediaType = activeTab?.media_type === 'series' ? 'series' : 'film'; const accent = accentFor(activeTab)
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [combinator, setCombinator] = useState<'and' | 'or'>('and'); const [clauses, setClauses] = useState<ClauseDraft[]>([newClause()])
  const [enabled, setEnabled] = useState(true); const [monitored, setMonitored] = useState(true); const [memberCap, setMemberCap] = useState(500); const [refreshHours, setRefreshHours] = useState(24); const [maxAdds, setMaxAdds] = useState(10)
  const [rootFolderId, setRootFolderId] = useState<number | null>(null); const [qualityProfileId, setQualityProfileId] = useState<number | null>(null); const [folders, setFolders] = useState<RootFolder[]>([]); const [profiles, setProfiles] = useState<QualityProfile[]>([])
  const [preview, setPreview] = useState<{ matchCount: number | null; sample: PreviewMember[]; warning: string | null; error: string; loading: boolean }>({ matchCount: null, sample: [], warning: null, error: '', loading: false }); const [saving, setSaving] = useState(false)
  const [operations, setOperations] = useState<Record<string, boolean>>({})

  useEffect(() => { if (!tabId) return; sharedApi.rootFolders.list(tabId).then(setFolders).catch(() => {}); sharedApi.qualityProfiles.list().then(setProfiles).catch(() => {}); listsApi.capabilities().then(value => setOperations(value.operations)).catch(() => {}); if (editing && id) listsApi.get(tabId, Number(id)).then(({ list }) => { setName(list.name); setDescription(list.description ?? ''); setEnabled(list.enabled); setMonitored(list.monitored); setMemberCap(list.memberCap); setRefreshHours(list.refreshIntervalHours); setMaxAdds(list.maxAddsPerRun); setRootFolderId(list.rootFolderId); setQualityProfileId(list.qualityProfileId); const draft = filterToDrafts(list.filter); if (draft) { setCombinator(draft.combinator); setClauses(draft.clauses) } else toast.error('This list contains nested filter groups that this editor cannot safely flatten.') }).catch(toast.error) }, [tabId, id, editing])
  const filterSignature = useMemo(() => JSON.stringify({ combinator, clauses, memberCap }), [combinator, clauses, memberCap])
  useEffect(() => { if (!tabId) return; const timer = window.setTimeout(async () => { setPreview(current => ({ ...current, loading: true, error: '' })); try { const result = await listsApi.preview(tabId, { mediaType, filter: buildFilter(combinator, clauses), memberCap }); setPreview({ matchCount: result.matchCount, sample: result.sample, warning: result.warning, error: '', loading: false }) } catch (error) { setPreview(current => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) })) } }, 500); return () => window.clearTimeout(timer) }, [tabId, mediaType, filterSignature])
  const save = async (event: React.FormEvent) => { event.preventDefault(); if (!tabId || !name.trim()) return; setSaving(true); const input: ListCreateRequest = { name: name.trim(), description: description.trim() || null, mediaType, filter: buildFilter(combinator, clauses), mode: 'approval', enabled, monitored, rootFolderId, qualityProfileId, memberCap, refreshIntervalHours: refreshHours, maxAddsPerRun: maxAdds }; try { const result = editing && id ? await listsApi.update(tabId, Number(id), input) : await listsApi.create(tabId, input); toast.success(editing ? 'List updated' : 'List created'); navigate(`/lists/${result.list.id}`) } catch (error) { toast.error(error) } finally { setSaving(false) } }

  return <form onSubmit={save} className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]"><div className="space-y-5">
    <div className="space-y-4 rounded-2xl border border-white/8 bg-noir-900/55 p-5"><div className="flex items-center justify-between"><h2 className="font-display text-xl uppercase tracking-widest text-white/85">{editing ? 'Edit list' : 'New list'}</h2><span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: accent }}>{mediaType}</span></div><Field label="Name"><Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Modern science fiction" required /></Field><Field label="Description"><textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} className="w-full rounded-lg border border-white/10 bg-noir-900 px-3 py-2.5 text-sm text-white/90 outline-none focus:border-white/30" placeholder="What belongs in this collection?" /></Field></div>
    <div className="rounded-2xl border border-white/8 bg-noir-900/55 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-display text-xl uppercase tracking-widest text-white/85">Rules</h2><div className="flex items-center gap-2"><span className="font-mono text-[9px] uppercase text-white/25">Match</span><Select value={combinator} onChange={e => setCombinator(e.target.value as 'and' | 'or')} className="w-32"><option value="and">All rules</option><option value="or">Any rule</option></Select></div></div>{combinator === 'or' && <p className="mt-3 rounded-lg bg-amber-500/8 px-3 py-2 text-xs text-amber-200/70">The current metadata provider only supports OR groups whose rules share the same type. Preview will flag invalid combinations.</p>}<div className="mt-4 space-y-3">{clauses.map((clause, index) => <ClauseEditor key={clause.key} clause={clause} canRemove={clauses.length > 1} operations={operations} mediaType={mediaType} onChange={next => setClauses(current => current.map((value, i) => i === index ? next : value))} onRemove={() => setClauses(current => current.filter((_, i) => i !== index))} />)}</div><button type="button" onClick={() => setClauses(current => [...current, newClause('year')])} className="mt-4 text-[10px] font-bold uppercase tracking-widest text-white/35 hover:text-white">+ Add rule</button></div>
    <div className="space-y-5 rounded-2xl border border-white/8 bg-noir-900/55 p-5"><h2 className="font-display text-xl uppercase tracking-widest text-white/85">Behaviour & targets</h2><div className="grid grid-cols-1 gap-4 sm:grid-cols-3"><Field label="Refresh"><Select value={refreshHours} onChange={e => setRefreshHours(Number(e.target.value))}><option value={6}>Every 6 hours</option><option value={12}>Every 12 hours</option><option value={24}>Daily</option><option value={168}>Weekly</option></Select></Field><Field label="Member limit"><Input type="number" min={1} max={10000} value={memberCap} onChange={e => setMemberCap(Number(e.target.value))} /></Field><Field label="Run safety cap" hint="Reserved for auto-add"><Input type="number" min={1} max={100} value={maxAdds} onChange={e => setMaxAdds(Number(e.target.value))} /></Field><Field label="Root folder"><Select value={rootFolderId ?? ''} onChange={e => setRootFolderId(e.target.value ? Number(e.target.value) : null)}><option value="">Library default</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.path}</option>)}</Select></Field><Field label="Quality profile"><Select value={qualityProfileId ?? ''} onChange={e => setQualityProfileId(e.target.value ? Number(e.target.value) : null)}><option value="">Library default</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</Select></Field></div><div className="flex flex-wrap gap-6"><Toggle checked={enabled} onChange={setEnabled} label="List enabled" /><Toggle checked={monitored} onChange={setMonitored} label="Monitor approved titles" /></div><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><div className="rounded-xl border p-4" style={{ borderColor: `${accent}55`, backgroundColor: `${accent}0d` }}><div className="text-xs font-bold uppercase tracking-wider" style={{ color: accent }}>Approval queue</div><p className="mt-1 text-xs text-white/40">New matches wait for your review. This is the active mode.</p></div><div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 opacity-45"><div className="text-xs font-bold uppercase tracking-wider text-white/50">Auto-add · unavailable</div><p className="mt-1 text-xs text-white/30">Will unlock after duplicate, quota and failure guardrails are proven.</p></div></div></div>
    <div className="flex justify-end gap-3"><Link to={editing && id ? `/lists/${id}` : '/lists'}><ActionButton>Cancel</ActionButton></Link><ActionButton type="submit" accent={accent} disabled={saving || Boolean(preview.error)}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Create list'}</ActionButton></div>
  </div><PreviewPanel {...preview} accent={accent} mediaType={mediaType} /></form>
}

function ItemCard({ item, selected, onSelect, onAction, onOpen, busy, accent }: { item: ListItem; selected: boolean; onSelect: () => void; onAction: (action: 'add' | 'dismiss') => void; onOpen: () => void; busy: boolean; accent: string }) {
  const actionable = item.status === 'new' || item.status === 'failed' || item.status === 'departed'
  return <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } }} aria-label={`View ${item.title}`} className="cursor-pointer overflow-hidden rounded-xl border border-white/8 bg-noir-900/55 transition-all hover:border-white/20 hover:bg-noir-900/80 focus:outline-none focus:ring-2" style={{ '--tw-ring-color': accent } as React.CSSProperties}><div className="relative aspect-[2/3] bg-white/5">{item.poster_path ? <img src={tmdbImage(item.poster_path)} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center p-4 text-center text-xs text-white/25">{item.title}</div>}{actionable && <label onClick={event => event.stopPropagation()} className="absolute left-2 top-2 grid h-7 w-7 place-items-center rounded-lg bg-noir-950/85"><input type="checkbox" checked={selected} onChange={onSelect} className="accent-[#00D4FF]" /></label>}<span className="absolute bottom-2 left-2 rounded bg-noir-950/90 px-2 py-1 font-mono text-[8px] uppercase text-white/65">{item.status.replace('_', ' ')}</span></div><div className="p-3"><div className="truncate text-sm font-semibold text-white/85">{item.title}</div><div className="mt-1 font-mono text-[9px] text-white/30">{item.year ?? '—'} · TMDB {item.tmdb_id}</div>{item.status_reason && <p className="mt-2 line-clamp-2 text-[10px] text-red-300/65">{item.status_reason}</p>}{actionable && <div className="mt-3 grid grid-cols-2 gap-2"><button disabled={busy} onClick={event => { event.stopPropagation(); onAction('dismiss') }} className="rounded-lg border border-white/8 py-2 text-[9px] font-bold uppercase text-white/35 hover:text-red-300">Dismiss</button><button disabled={busy} onClick={event => { event.stopPropagation(); onAction('add') }} className="rounded-lg border py-2 text-[9px] font-bold uppercase" style={{ color: accent, borderColor: `${accent}44`, backgroundColor: `${accent}10` }}>Add</button></div>}</div></div>
}

function RunHistory({ runs }: { runs: ListRun[] }) {
  return <section className="rounded-2xl border border-white/8 bg-noir-900/55 p-5"><h2 className="font-display text-xl uppercase tracking-widest text-white/85">Run history</h2>{runs.length === 0 ? <p className="mt-4 text-sm text-white/30">No refreshes yet.</p> : <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[680px] text-left font-mono text-[10px]"><thead className="uppercase tracking-wider text-white/25"><tr><th className="pb-3">Started</th><th>Status</th><th>Found</th><th>New</th><th>Departed</th><th>Auto-added</th><th>Capped</th></tr></thead><tbody>{runs.map(run => <tr key={run.id} className="border-t border-white/5 text-white/55"><td className="py-3">{new Date(run.started_at).toLocaleString()}</td><td>{run.error ? 'Failed' : run.finished_at ? 'Complete' : 'Running'}</td><td>{run.fetched}</td><td>{run.new_items}</td><td>{run.departed}</td><td>{run.auto_added}</td><td>{run.capped}</td></tr>)}</tbody></table></div>}</section>
}

function Metric({ label, value, accent }: { label: string; value: number; accent?: string }) { return <div className="rounded-xl bg-noir-950/45 p-3"><div className="font-display text-2xl" style={{ color: accent ?? 'rgba(255,255,255,.75)' }}>{value}</div><div className="font-mono text-[8px] uppercase tracking-widest text-white/25">{label}</div></div> }

function ListDetail() {
  const { id } = useParams(); const listId = Number(id); const navigate = useNavigate(); const { activeTab } = useTabs(); const tabId = activeTab?.id; const accent = accentFor(activeTab)
  const [list, setList] = useState<ArchivistList | null>(null); const [items, setItems] = useState<ListItem[]>([]); const [runs, setRuns] = useState<ListRun[]>([]); const [status, setStatus] = useState<ListStatus>('new'); const [selected, setSelected] = useState<number[]>([]); const [busy, setBusy] = useState(false); const [openedItem, setOpenedItem] = useState<CalendarModalItem | null>(null)
  const load = async () => { if (!tabId || !listId) return; try { const [detail, queue, history] = await Promise.all([listsApi.get(tabId, listId), listsApi.items(tabId, listId, status), listsApi.runs(tabId, listId)]); setList(detail.list); setItems(queue.items); setRuns(history.runs) } catch (error) { toast.error(error) } }
  useLiveRefresh(load, { enabled: Boolean(tabId && listId), events: ['lists:new-items', 'lists:item-added'] }); useEffect(() => { setSelected([]) }, [status])
  const act = async (action: 'add' | 'dismiss', itemIds: number[]) => { if (!tabId || itemIds.length === 0) return; setBusy(true); try { if (itemIds.length === 1) await listsApi[action](tabId, listId, itemIds[0]); else await listsApi.bulk(tabId, listId, action, itemIds); toast.success(action === 'add' ? `${itemIds.length} item${itemIds.length === 1 ? '' : 's'} added to the library` : `${itemIds.length} item${itemIds.length === 1 ? '' : 's'} dismissed`); setSelected([]); await load() } catch (error) { toast.error(error); await load() } finally { setBusy(false) } }
  const openItem = async (item: ListItem) => {
    const initial: CalendarModalItem = { tmdbId: item.tmdb_id, type: item.media_type, title: item.title, displayTitle: item.title, displaySub: item.year ? String(item.year) : 'Release', poster_path: item.poster_path ?? undefined }
    setOpenedItem(initial)
    try {
      const detail = item.media_type === 'film' ? await filmsApi.getByTmdbId(item.tmdb_id) : await seriesApi.getTmdb(item.tmdb_id)
      setOpenedItem(current => current?.tmdbId === item.tmdb_id ? {
        ...current,
        title: detail.title ?? current.title,
        displayTitle: detail.title ?? current.displayTitle,
        displaySub: detail.year ? String(detail.year) : current.displaySub,
        date: detail.releaseDate,
        overview: detail.overview,
        poster_path: detail.posterPath ?? detail.poster_path ?? current.poster_path,
      } : current)
    } catch (error) {
      console.error(`Failed to load details for ${item.title}:`, error)
    }
  }
  if (!list) return <div className="flex justify-center py-24"><Spinner className="h-8 w-8" /></div>
  return <div className="space-y-6"><div className="rounded-2xl border border-white/8 bg-noir-900/55 p-5"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><Link to="/lists" className="font-mono text-[9px] uppercase tracking-widest text-white/25 hover:text-white">← All lists</Link><h2 className="mt-3 font-display text-3xl uppercase tracking-wide text-white">{list.name}</h2><p className="mt-2 max-w-2xl text-sm text-white/40">{list.description || 'No description'}</p></div><div className="flex flex-wrap gap-2"><ActionButton onClick={() => navigate('edit')}>Edit</ActionButton><ActionButton accent={accent} onClick={async () => { if (!tabId) return; await listsApi.refresh(tabId, listId); toast.success('Refresh queued') }}>Refresh now</ActionButton><ActionButton danger onClick={async () => { if (!tabId || !await confirmDialog({ title: `Delete ${list.name}?`, message: 'Its discovery history and review queue will also be removed.', confirmLabel: 'Delete list' })) return; await listsApi.delete(tabId, listId); navigate('/lists') }}>Delete</ActionButton></div></div><div className="mt-5 grid grid-cols-2 gap-3 border-t border-white/5 pt-5 sm:grid-cols-4"><Metric label="Pending" value={list.counts?.new ?? 0} accent={accent} /><Metric label="In library" value={list.counts?.in_library ?? 0} /><Metric label="Added" value={list.counts?.added ?? 0} /><Metric label="Dismissed" value={list.counts?.dismissed ?? 0} /></div>{list.lastError && <p className="mt-4 rounded-lg bg-red-500/10 p-3 text-xs text-red-300">{list.lastError}</p>}</div>
    <section>
      <div className="flex flex-wrap items-center gap-2 border-b border-white/5 pb-4">
        {STATUS.map(value => <button key={value} onClick={() => setStatus(value)} className="rounded-lg px-3 py-2 font-mono text-[9px] uppercase tracking-wider" style={status === value ? { color: accent, backgroundColor: `${accent}12`, border: `1px solid ${accent}44` } : { color: 'rgba(255,255,255,.3)', border: '1px solid transparent' }}>{value.replace('_', ' ')} <span className="ml-1 opacity-60">{list.counts?.[value] ?? 0}</span></button>)}
        {items.some(item => item.status === 'new' || item.status === 'failed' || item.status === 'departed') && <button type="button" onClick={() => {
          const selectable = items.filter(item => item.status === 'new' || item.status === 'failed' || item.status === 'departed').map(item => item.id)
          setSelected(selectable.every(id => selected.includes(id)) ? [] : selectable)
        }} className="ml-auto rounded-lg border border-white/10 px-3 py-2 font-mono text-[9px] uppercase tracking-wider text-white/45 hover:border-white/20 hover:text-white">
          {items.filter(item => item.status === 'new' || item.status === 'failed' || item.status === 'departed').every(item => selected.includes(item.id)) ? 'Clear selection' : 'Select all'}
        </button>}
      </div>
      {selected.length > 0 && <div className="sticky top-3 z-20 mt-3 flex items-center justify-between rounded-xl border border-white/10 bg-noir-800/95 p-3 shadow-2xl backdrop-blur"><span className="font-mono text-[10px] text-white/60">{selected.length} selected</span><div className="flex gap-2"><ActionButton danger disabled={busy} onClick={() => act('dismiss', selected)}>Dismiss</ActionButton><ActionButton accent={accent} disabled={busy} onClick={() => act('add', selected)}>Add to library</ActionButton></div></div>}
      {items.length === 0 ? <div className="py-16 text-center text-sm text-white/30">No {status.replace('_', ' ')} items.</div> : <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">{items.map(item => <ItemCard key={item.id} item={item} busy={busy} accent={accent} selected={selected.includes(item.id)} onSelect={() => setSelected(current => current.includes(item.id) ? current.filter(value => value !== item.id) : [...current, item.id])} onAction={action => act(action, [item.id])} onOpen={() => void openItem(item)} />)}</div>}
    </section>
    <RunHistory runs={runs} />
    {openedItem && <CalendarItemModal item={openedItem} onClose={() => setOpenedItem(null)} />}
  </div>
}

export function ListsPage() { return <PageShell><Routes><Route index element={<ListsOverview />} /><Route path="new" element={<ListBuilder />} /><Route path=":id" element={<ListDetail />} /><Route path=":id/edit" element={<ListBuilder editing />} /><Route path="*" element={<Navigate to="/lists" replace />} /></Routes></PageShell> }
