import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ArchivistLoginPage } from '@archivist/design-system'
import ArchivistIcon from '../../../client/src/icon.svg'

type Json = Record<string, any>
type View = 'overview' | 'items' | 'people' | 'flows' | 'tables'

async function api<T = Json>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1/catalogue${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body as T
}

const fmt = (value: unknown) => Number(value ?? 0).toLocaleString()
const bytes = (value: unknown) => {
  let size = Number(value ?? 0)
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (size < 1024) return `${size.toFixed(unit === 'B' ? 0 : 1)} ${unit}`
    size /= 1024
  }
  return `${size.toFixed(1)} TB`
}
const art = (assetId: unknown) => assetId ? `/api/v1/catalogue/artwork/${assetId}` : ''

function Login({ onSuccess }: { onSuccess: () => void }) {
  async function submit(credentials: { username: string; password: string }) {
    const response = await fetch('/api/v1/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) })
    if (!response.ok) throw new Error('Invalid username or password')
    onSuccess()
  }
  return <ArchivistLoginPage product="CATALOGUE" topline="Universal metadata control plane" onSubmit={submit} />
}

function Badge({ value }: { value?: string }) { return <span className={`badge ${value ?? ''}`}>{value ?? 'not run'}</span> }
function Progress({ run }: { run?: Json }) {
  const percent = run?.total ? Math.min(100, Math.round(Number(run.processed) / Number(run.total) * 100)) : run?.status === 'completed' ? 100 : 0
  return <div><div className="progress"><span style={{ width: `${percent}%` }} /></div><div className="progress-copy"><span>{run?.current_step ?? 'Waiting'}</span><span>{fmt(run?.processed)}{run?.total ? ` / ${fmt(run.total)}` : ''}</span></div></div>
}

function Overview({ data, onRefresh, onOpenFlows }: { data: Json; onRefresh: () => void; onOpenFlows: () => void }) {
  const counts = useMemo(() => Object.fromEntries((data.itemCounts ?? []).map((row: Json) => [`${row.media_type}:${row.completeness_status}`, row.count])), [data.itemCounts])
  const total = (type: string) => Object.entries(counts).filter(([key]) => key.startsWith(`${type}:`)).reduce((sum, [, value]) => sum + Number(value), 0)
  const ingest = (data.queues?.ingest ?? []) as Json[]
  const artworkQueue = (data.queues?.artwork ?? []) as Json[]
  const providers = (data.providers ?? {}) as Record<string, boolean>
  const isEmpty = Number(data.rowTotals?.items ?? 0) === 0
  return <>
    <header className="page-head"><div><span className="eyebrow">Universal source of truth</span><h2>CATALOGUE HEALTH</h2></div><button onClick={async () => { await api('/maintenance/checkpoint', { method: 'POST' }); onRefresh() }}>Checkpoint database</button></header>
    {isEmpty && <div className="notice"><strong>The catalogue is empty.</strong><span>Nothing has been imported yet. Press <b>Start</b> in the top bar to run the IMDb-led daily sync, or open Flows to run a single step.</span><button onClick={onOpenFlows}>Open flows</button></div>}
    <section className="metrics">
      <Metric label="Films" value={total('film')} tone="cyan" /><Metric label="TV series" value={total('series')} tone="violet" />
      <Metric label="Books" value={total('book')} tone="amber" /><Metric label="Music releases" value={total('music_release_group')} tone="pink" />
      <Metric label="Global people" value={data.metadata?.person_count} tone="violet" /><Metric label="Artwork" value={data.metadata?.asset_count} tone="pink" />
    </section>
    <section className="two-col">
      <div className="panel"><div className="panel-title"><strong>Latest flow</strong><Badge value={data.latestRun?.status} /></div><div className="panel-body">{data.latestRun ? <><h3>{data.latestRun.name}</h3><Progress run={data.latestRun} /><p className="muted">{data.latestRun.message}</p></> : <Empty text="No flows have run yet" />}</div></div>
      <div className="panel"><div className="panel-title"><strong>Completion status</strong></div><div className="panel-body status-list">
        {['film', 'series', 'book', 'music_release_group'].map(type => <div key={type}><span>{type.replaceAll('_', ' ')}</span><span><b className="green">{fmt(counts[`${type}:complete`])}</b> complete · {fmt(counts[`${type}:partial`])} partial</span></div>)}
      </div></div>
    </section>
    <section className="two-col">
      <div className="panel"><div className="panel-title"><strong>Pipeline queues</strong><span>{fmt(ingest.reduce((sum, row) => sum + Number(row.count), 0) + artworkQueue.reduce((sum, row) => sum + Number(row.count), 0))} entries</span></div><div className="panel-body status-list">
        {ingest.length || artworkQueue.length
          ? <>{ingest.map(row => <div key={`${row.source}:${row.status}`}><span>{row.source} · {row.status}</span><b>{fmt(row.count)}</b></div>)}
            {artworkQueue.map(row => <div key={`artwork:${row.status}`}><span>artwork · {row.status}</span><b>{fmt(row.count)}</b></div>)}</>
          : <Empty text="No queued work" />}
      </div></div>
      <div className="panel"><div className="panel-title"><strong>Metadata providers</strong></div><div className="panel-body status-list">
        {['imdb', 'omdb', 'tvdb', 'tmdb'].map(provider => <div key={provider}><span>{provider}</span><span className={`badge ${providers[provider] ? 'complete' : 'failed'}`}>{providers[provider] ? 'configured' : 'no key'}</span></div>)}
        <p className="muted">Unconfigured providers are skipped during enrichment. Add their keys in Archivist settings.</p>
      </div></div>
    </section>
    <section className="panel storage"><div className="panel-title"><strong>Storage</strong><span>{bytes(data.database?.bytes)}</span></div><div className="panel-body mono"><div>DATABASE <span>{data.database?.path}</span></div><div>ARTWORK <span>{data.artwork?.path}</span></div><div>SCHEMA <span>v{data.metadata?.schema_version ?? '—'} · multi-source</span></div></div></section>
  </>
}

function Metric({ label, value, tone }: { label: string; value: unknown; tone: string }) { return <div className="metric"><span>{label}</span><strong className={tone}>{fmt(value)}</strong></div> }
function Empty({ text, action }: { text: string; action?: JSX.Element }) { return <div className="empty"><span>{text}</span>{action}</div> }

/**
 * Start / Stop / Clear. These live in the top bar so they are reachable from
 * every view — the catalogue is a long-running importer and "is it running?"
 * is the question an operator asks most.
 */
function ControlBar({ overview, onRefresh }: { overview: Json | null; onRefresh: () => void }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [resetOpen, setResetOpen] = useState(false)
  const suspended = overview?.runner?.suspended === true
  const activeRuns = Number(overview?.runner?.activeRuns ?? 0)
  const state = suspended ? 'stopped' : activeRuns ? 'running' : 'idle'

  async function act(label: string, path: string, body: Json = {}) {
    setBusy(label); setError('')
    try { await api(path, { method: 'POST', body: JSON.stringify(body) }); onRefresh() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy('') }
  }

  return <div className="control-bar">
    <span className={`run-state ${state}`} title={suspended ? 'The catalogue runner is stopped' : activeRuns ? `${activeRuns} flow(s) in flight` : 'Idle — nothing queued'}><i />{state}</span>
    {/* With work already in flight Start only lifts the suspension — queueing a
        second daily sync would be rejected as "already running". */}
    <button className="primary" disabled={Boolean(busy)} onClick={() => void act('start', '/control/start', activeRuns ? { queue: false } : { flowKey: 'daily-sync' })}>{busy === 'start' ? 'Starting…' : activeRuns ? 'Resume' : 'Start'}</button>
    <button disabled={Boolean(busy) || suspended} onClick={() => void act('stop', '/control/stop')}>{busy === 'stop' ? 'Stopping…' : 'Stop'}</button>
    <button className="danger" disabled={Boolean(busy)} onClick={() => setResetOpen(true)}>Clear</button>
    {error && <span className="control-error" title={error}>{error}</span>}
    {resetOpen && <ResetModal onClose={() => setResetOpen(false)} onDone={onRefresh} />}
  </div>
}

/** Mirrors the server's factory-reset dialog: typed confirmation, no undo. */
function ResetModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [confirmText, setConfirmText] = useState('')
  const [deleteArtwork, setDeleteArtwork] = useState(true)
  const [resetFlows, setResetFlows] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Json | null>(null)

  async function run() {
    setRunning(true); setError('')
    try {
      setResult(await api('/maintenance/reset', { method: 'POST', body: JSON.stringify({ confirm: 'RESET', deleteArtwork, resetFlows }) }))
      onDone()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setRunning(false) }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !running) onClose() }}><article className="reset-modal">
    <button className="modal-close" onClick={onClose} disabled={running}>×</button>
    <h2>CLEAR CATALOGUE</h2>
    {result ? <>
      <p className="reset-done">Catalogue cleared. {fmt(result.rowsDeleted)} rows removed from {fmt(result.tablesCleared)} tables{result.artworkDeleted ? ', artwork storage emptied' : ''}.</p>
      <p className="muted">The runner has been left stopped — press Start when you are ready to rebuild.</p>
      <div className="modal-actions"><button className="primary" onClick={onClose}>Done</button></div>
    </> : <>
      <p className="reset-warning">This permanently deletes every catalogue item, person, organisation, credit, artwork record, queue entry and flow run. There is no undo.</p>
      <p className="muted">Flow definitions and the graphs you have designed are kept unless you tick the option below. Any running flow is cancelled first.</p>
      <label className="toggle"><input type="checkbox" checked={deleteArtwork} disabled={running} onChange={event => setDeleteArtwork(event.target.checked)} /><span>Also delete downloaded artwork files from disk<small>Leave unticked to keep the image files; their database records go either way.</small></span></label>
      <label className="toggle"><input type="checkbox" checked={resetFlows} disabled={running} onChange={event => setResetFlows(event.target.checked)} /><span>Also reset flow designs to the defaults<small>Discards every draft, published version and custom node layout.</small></span></label>
      <label className="confirm-field"><span>Type <b>RESET</b> to confirm</span><input value={confirmText} disabled={running} placeholder="RESET" onChange={event => setConfirmText(event.target.value)} /></label>
      {error && <div className="error-banner">{error}</div>}
      <div className="modal-actions">
        <button onClick={onClose} disabled={running}>Cancel</button>
        <button className="danger solid" disabled={confirmText !== 'RESET' || running} onClick={() => void run()}>{running ? 'Clearing…' : 'Clear catalogue'}</button>
      </div>
    </>}
  </article></div>
}

function Items() {
  const [payload, setPayload] = useState<Json>({ items: [], total: 0 })
  const [type, setType] = useState('')
  const [status, setStatus] = useState('complete')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Json | null>(null)
  async function load() { setPayload(await api(`/items?limit=120&mediaType=${encodeURIComponent(type)}&status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`)) }
  useEffect(() => { void load() }, [type, status])
  return <>
    <header className="page-head"><div><span className="eyebrow">Visual data checking</span><h2>COMPLETED ITEMS</h2><p>{fmt(payload.total)} items match this view</p></div><div className="filters">
      <select value={type} onChange={e => setType(e.target.value)}><option value="">All media</option><option value="film">Films</option><option value="series">TV series</option><option value="book">Books</option><option value="music_release_group">Music</option></select>
      <select value={status} onChange={e => setStatus(e.target.value)}><option value="complete">Complete</option><option value="partial">Partial</option><option value="pending">Pending</option><option value="failed">Failed</option><option value="">Every status</option></select>
      <form onSubmit={e => { e.preventDefault(); void load() }}><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search catalogue…" /></form>
    </div></header>
    {payload.items.length ? <section className="poster-grid">{payload.items.map((item: Json) => <button className="poster-card" key={item.item_id} onClick={async () => setSelected(await api(`/items/${item.item_id}`))}>
      <div className="poster">{item.poster_asset_id ? <img src={art(item.poster_asset_id)} alt="" /> : <span>{item.media_type === 'series' ? '📺' : item.media_type === 'book' ? '📚' : item.media_type === 'music_release_group' ? '🎵' : '🎬'}</span>}<Badge value={item.completeness_status} /></div>
      <strong>{item.canonical_title}</strong><small>{item.release_year ?? '—'} · {item.media_type.replaceAll('_', ' ')}</small>
    </button>)}</section> : <Empty text="No catalogue items match these filters" />}
    {selected && <ItemModal payload={selected} onClose={() => setSelected(null)} />}
  </>
}

function ItemModal({ payload, onClose }: { payload: Json; onClose: () => void }) {
  const item = payload.item
  const poster = payload.artwork?.find((row: Json) => row.artwork_type === 'poster' && row.local_path)
  const backdrop = payload.artwork?.find((row: Json) => row.artwork_type === 'backdrop' && row.local_path)
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><article className="item-modal">
    {backdrop && <img className="hero-art" src={art(backdrop.asset_id)} alt="" />}<div className="hero-fade" />
    <button className="modal-close" onClick={onClose}>×</button><div className="item-content">
      <div className="item-poster">{poster ? <img src={art(poster.asset_id)} alt="" /> : <span>NO ARTWORK</span>}</div>
      <div className="item-copy"><span className="eyebrow">{item.media_type.replaceAll('_', ' ')} · {item.completeness_status}</span><h2>{item.canonical_title}</h2><p className="facts">{item.release_year ?? 'Date unknown'} · {item.original_language ?? 'Language unknown'} · {item.rating ? `${Number(item.rating).toFixed(1)} rating` : 'Unrated'}</p><p className="overview">{item.description || 'No description has been ingested.'}</p>
        <div className="quality"><span>Completeness</span><div className="progress"><span style={{ width: `${Number(item.completeness_score ?? 0) * 100}%` }} /></div><b>{Math.round(Number(item.completeness_score ?? 0) * 100)}%</b></div>
      </div>
    </div>
    <div className="detail-columns"><section><h3>Credits</h3>{payload.credits?.slice(0, 24).map((credit: Json) => <div className="detail-row" key={credit.credit_id}><span>{credit.person_name ?? credit.organisation_name}</span><small>{credit.role}{credit.character_name ? ` · ${credit.character_name}` : ''}</small></div>) || <Empty text="No credits" />}</section>
      <section><h3>Sources & organisations</h3>{payload.externalIds?.map((id: Json) => <div className="detail-row" key={`${id.source}:${id.external_id}`}><span>{id.source}</span><small>{id.external_id}</small></div>)}{payload.organisations?.map((org: Json) => <div className="detail-row" key={`${org.organisation_id}:${org.role}`}><span>{org.name}</span><small>{org.role}</small></div>)}</section></div>
  </article></div>
}

function People() {
  const [payload, setPayload] = useState<Json>({ people: [], total: 0 })
  const [search, setSearch] = useState('')
  useEffect(() => { void api(`/people?limit=200&search=${encodeURIComponent(search)}`).then(setPayload) }, [search])
  return <><header className="page-head"><div><span className="eyebrow">Cross-media identity</span><h2>GLOBAL PEOPLE</h2><p>{fmt(payload.total)} canonical identities</p></div><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search people…" /></header>
    <section className="people-grid">{payload.people.map((person: Json) => <article className="person-card" key={person.person_id}><div className="avatar">{person.profile_asset_id_resolved ? <img src={art(person.profile_asset_id_resolved)} alt="" /> : person.name.slice(0, 1)}</div><div><strong>{person.name}</strong><small>{fmt(person.credit_count)} items · {fmt(person.identity_sources)} sources</small><span>{person.known_for_department ?? 'Contributor'}</span></div></article>)}</section></>
}

type FlowNode = { id: string; type: string; label: string; description?: string; x: number; y: number; enabled?: boolean; config?: Json }
type FlowEdge = { id: string; source: string; target: string }
type FlowGraph = { nodes: FlowNode[]; edges: FlowEdge[] }

function Flows() {
  const [flows, setFlows] = useState<Json[]>([])
  const [runs, setRuns] = useState<Json[]>([])
  const [flowKey, setFlowKey] = useState('daily-sync')
  const [payload, setPayload] = useState<Json | null>(null)
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [], edges: [] })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [nodeRuns, setNodeRuns] = useState<Json[]>([])
  const [issues, setIssues] = useState<Json[]>([])
  const [logs, setLogs] = useState<Json[] | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [addType, setAddType] = useState('enrich-items')
  const [error, setError] = useState('')
  const canvas = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const selected = graph.nodes.find(node => node.id === selectedId) ?? null
  const currentFlow = flows.find(flow => flow.flow_key === flowKey)
  const runByNode = useMemo(() => Object.fromEntries(nodeRuns.map(node => [node.node_key, node])), [nodeRuns])
  const flowRuns = useMemo(() => runs.filter(run => run.flow_key === flowKey), [runs, flowKey])

  async function loadLists() {
    const [flowResult, runResult, issueResult] = await Promise.all([api<Json>('/flows'), api<Json>('/runs?limit=100'), api<Json>('/mapping-issues?limit=100')])
    setFlows(flowResult.flows); setRuns(runResult.runs); setIssues(issueResult.issues)
    const active = flowResult.flows.find((flow: Json) => flow.flow_key === flowKey)
    if (active?.run_id) setNodeRuns((await api<Json>(`/runs/${active.run_id}/nodes`)).nodes)
    else setNodeRuns([])
  }

  async function loadGraph(key: string) {
    const result = await api<Json>(`/flows/${key}/graph`)
    setPayload(result)
    setGraph(structuredClone((result.draft ?? result.published).graph))
    setSelectedId(null); setConnecting(null); setDirty(false)
  }

  useEffect(() => { void loadLists().catch(err => setError(String(err))); const timer = setInterval(() => void loadLists().catch(() => {}), 3000); return () => clearInterval(timer) }, [flowKey])
  useEffect(() => { void loadGraph(flowKey).catch(err => setError(String(err))) }, [flowKey])
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current || !canvas.current) return
      const bounds = canvas.current.getBoundingClientRect()
      const x = Math.max(20, event.clientX - bounds.left + canvas.current.scrollLeft - drag.current.dx)
      const y = Math.max(20, event.clientY - bounds.top + canvas.current.scrollTop - drag.current.dy)
      setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === drag.current?.id ? { ...node, x, y } : node) })); setDirty(true)
    }
    const up = () => { drag.current = null }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [])

  function selectNode(id: string) {
    if (connecting && connecting !== id) {
      if (!graph.edges.some(edge => edge.source === connecting && edge.target === id)) setGraph(current => ({ ...current, edges: [...current.edges, { id: `edge-${Date.now()}`, source: connecting, target: id }] }))
      setConnecting(null); setDirty(true)
    }
    setSelectedId(id)
  }

  function beginDrag(event: ReactPointerEvent, node: FlowNode) {
    if (!canvas.current) return
    const bounds = canvas.current.getBoundingClientRect()
    drag.current = { id: node.id, dx: event.clientX - bounds.left + canvas.current.scrollLeft - node.x, dy: event.clientY - bounds.top + canvas.current.scrollTop - node.y }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function updateNode(changes: Partial<FlowNode>) {
    if (!selectedId) return
    setGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === selectedId ? { ...node, ...changes } : node) })); setDirty(true)
  }

  function updateConfig(key: string, value: unknown) { updateNode({ config: { ...(selected?.config ?? {}), [key]: value } }) }

  function addNode() {
    const definition = payload?.nodeTypes?.find((node: Json) => node.type === addType)
    const id = `${addType}-${Date.now()}`
    const node = { id, type: addType, label: definition?.label ?? addType, description: definition?.description ?? '', x: 120 + graph.nodes.length * 35, y: 120 + graph.nodes.length * 28, enabled: true, config: {} }
    setGraph(current => ({ ...current, nodes: [...current.nodes, node] })); setSelectedId(id); setDirty(true)
  }

  function deleteNode() {
    if (!selectedId) return
    setGraph(current => ({ nodes: current.nodes.filter(node => node.id !== selectedId), edges: current.edges.filter(edge => edge.source !== selectedId && edge.target !== selectedId) }))
    setSelectedId(null); setConnecting(null); setDirty(true)
  }

  async function saveDraft() {
    setSaving(true); setError('')
    try { const result = await api<Json>(`/flows/${flowKey}/graph`, { method: 'PUT', body: JSON.stringify({ graph }) }); setPayload(result); setDirty(false); await loadLists() }
    catch (err) { setError(String(err)) } finally { setSaving(false) }
  }

  async function publish() {
    setSaving(true); setError('')
    try {
      if (dirty || !payload?.draft) await api<Json>(`/flows/${flowKey}/graph`, { method: 'PUT', body: JSON.stringify({ graph }) })
      const result = await api<Json>(`/flows/${flowKey}/publish`, { method: 'POST', body: '{}' }); setPayload(result); setGraph(structuredClone(result.published.graph)); setDirty(false); await loadLists()
    }
    catch (err) { setError(String(err)) } finally { setSaving(false) }
  }

  async function runFlow() { setError(''); try { await api(`/flows/${flowKey}/run`, { method: 'POST', body: '{}' }); await loadLists() } catch (err) { setError(String(err)) } }

  return <div className="flow-studio">
    <header className="flow-studio-head"><div><span className="eyebrow">Visual catalogue orchestration</span><h2>FLOW STUDIO</h2></div><div className="flow-actions">
      <select value={flowKey} onChange={event => setFlowKey(event.target.value)}>{flows.map(flow => <option key={flow.flow_key} value={flow.flow_key}>{flow.name}</option>)}</select>
      <span className="version-chip">v{payload?.published?.version_number ?? '—'}{payload?.draft ? ' · draft' : ''}</span>
      <button disabled={!dirty || saving} onClick={() => void saveDraft()}>{saving ? 'Saving…' : 'Save draft'}</button>
      <button disabled={saving || (!dirty && !payload?.draft)} onClick={() => void publish()}>Publish</button>
      {['running', 'queued', 'cancelling'].includes(currentFlow?.status) ? <button className="danger" onClick={() => currentFlow?.run_id && void api(`/runs/${currentFlow.run_id}/cancel`, { method: 'POST' })}>Cancel run</button> : <button className="primary" onClick={() => void runFlow()}>Run flow</button>}
    </div></header>
    {error && <div className="error-banner">{error}</div>}
    <div className="flow-workspace">
      <section className="flow-canvas-shell">
        <div className="canvas-toolbar"><select value={addType} onChange={event => setAddType(event.target.value)}>{payload?.nodeTypes?.map((node: Json) => <option key={node.type} value={node.type}>{node.label}</option>)}</select><button onClick={addNode}>+ Add node</button><button disabled={!selected} className={connecting ? 'connect-active' : ''} onClick={() => setConnecting(connecting ? null : selectedId)}>{connecting ? 'Choose target…' : 'Connect'}</button><button disabled={!selected} onClick={deleteNode}>Delete</button><span>{graph.nodes.length} nodes · {graph.edges.length} connections</span></div>
        <div className="flow-canvas" ref={canvas} onClick={event => { if (event.target === event.currentTarget) setSelectedId(null) }}>
          <div className="flow-surface">
            <svg className="flow-edges" width="1800" height="900">{graph.edges.map(edge => { const source = graph.nodes.find(node => node.id === edge.source); const target = graph.nodes.find(node => node.id === edge.target); if (!source || !target) return null; const sx = source.x + 210; const sy = source.y + 48; const tx = target.x; const ty = target.y + 48; const bend = Math.max(70, Math.abs(tx - sx) / 2); return <path key={edge.id} d={`M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`} /> })}</svg>
            {graph.nodes.map(node => { const run = runByNode[node.id]; const definition = payload?.nodeTypes?.find((value: Json) => value.type === node.type); return <article key={node.id} className={`flow-node tone-${definition?.tone ?? 'cyan'} ${selectedId === node.id ? 'selected' : ''} ${run?.status ?? ''} ${node.enabled === false ? 'disabled' : ''}`} style={{ left: node.x, top: node.y }} onClick={event => { event.stopPropagation(); selectNode(node.id) }}>
              <div className="node-head" onPointerDown={event => beginDrag(event, node)}><i /><span>{node.type}</span><Badge value={run?.status ?? (node.enabled === false ? 'disabled' : 'ready')} /></div>
              <strong>{node.label}</strong><p>{node.description || definition?.description}</p>
              {run && <><div className="node-progress"><span style={{ width: `${run.total ? Math.min(100, Number(run.processed) / Number(run.total) * 100) : run.status === 'completed' ? 100 : 0}%` }} /></div><small>{fmt(run.processed)}{run.total ? ` / ${fmt(run.total)}` : ''} · {run.message ?? run.status}</small></>}
              <button className="node-port input" aria-label="Input" /><button className="node-port output" aria-label="Output" />
            </article> })}
          </div>
        </div>
      </section>
      <aside className="node-inspector">
        {selected ? <><div className="inspector-title"><div><span className="eyebrow">Node inspector</span><h3>{selected.label}</h3></div><Badge value={runByNode[selected.id]?.status ?? 'ready'} /></div>
          <label><span>Name</span><input value={selected.label} onChange={event => updateNode({ label: event.target.value })} /></label>
          <label><span>Description</span><textarea value={selected.description ?? ''} onChange={event => updateNode({ description: event.target.value })} /></label>
          <label className="toggle"><input type="checkbox" checked={selected.enabled !== false} onChange={event => updateNode({ enabled: event.target.checked })} /><span>Node enabled</span></label>
          {['enrich-items', 'fetch-artwork', 'hydrate-movies', 'hydrate-series'].includes(selected.type) && <label><span>Batch limit</span><input type="number" min="1" max="5000" value={selected.config?.limit ?? ''} placeholder="Default" onChange={event => updateConfig('limit', event.target.value ? Number(event.target.value) : undefined)} /></label>}
          {selected.type === 'imdb-import' && <><label><span>IMDb title types</span><input value={(selected.config?.mediaTypes ?? []).join(', ')} placeholder="movie, tvMovie, tvSeries, tvMiniSeries" onChange={event => updateConfig('mediaTypes', event.target.value.split(',').map(value => value.trim()).filter(Boolean))} /></label><label><span>Earliest year</span><input type="number" min="1930" max="2100" value={selected.config?.minYear ?? 1930} onChange={event => updateConfig('minYear', Math.max(1930, Number(event.target.value) || 1930))} /></label><p className="muted">Shorts and television titles tagged Talk-Show are always excluded.</p></>}
          {selected.type === 'fetch-artwork' && <label className="toggle"><input type="checkbox" checked={selected.config?.allArtwork === true} onChange={event => updateConfig('allArtwork', event.target.checked)} /><span>Download all artwork</span></label>}
          <div className="inspector-meta"><span>NODE KEY</span><code>{selected.id}</code><span>NODE TYPE</span><code>{selected.type}</code></div>
          {runByNode[selected.id] && <div className="node-run-detail"><strong>Latest execution</strong><Progress run={runByNode[selected.id]} /><p>{runByNode[selected.id].message}</p></div>}
        </> : <div className="inspector-empty"><span className="eyebrow">Node inspector</span><h3>Select a node</h3><p>Edit its configuration, inspect progress or connect it to another step.</p></div>}
        <div className="mapping-issues"><div><strong>Mapping issues</strong><Badge value={issues.length ? String(issues.length) : 'clear'} /></div>{issues.length ? issues.slice(0, 12).map((issue, index) => <button key={`${issue.issue_id ?? issue.source_id}-${index}`} onClick={() => issue.node_key && setSelectedId(issue.node_key)}><span>{issue.title}</span><small>{issue.source} · {issue.issue_type}</small><p>{issue.description}</p></button>) : <p>No open provider or remapping issues.</p>}</div>
      </aside>
    </div>
    <section className="panel run-table flow-run-history"><div className="panel-title"><strong>Run history</strong><span>{currentFlow?.description}</span></div>
      {flowRuns.length ? <table><thead><tr><th>Run</th><th>Flow</th><th>Status</th><th>Started</th><th>Processed</th><th>Message</th></tr></thead><tbody>{flowRuns.map(run => <tr key={run.run_id} onClick={async () => setLogs((await api<Json>(`/runs/${run.run_id}/logs`)).logs)}><td>{run.run_id}</td><td>{run.name}</td><td><Badge value={run.status} /></td><td>{run.started_at ?? '—'}</td><td>{fmt(run.processed)}</td><td>{run.message}</td></tr>)}</tbody></table>
        : <Empty text="This flow has never run — press Run flow above, or Start in the top bar" />}
    </section>
    {logs && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setLogs(null) }}><article className="log-modal"><button className="modal-close" onClick={() => setLogs(null)}>×</button><h2>FLOW LOG</h2>{logs.map(log => <div className={`log-line ${log.level}`} key={log.log_id}><time>{log.created_at}</time><b>{log.level}</b><span>{log.message}</span></div>)}</article></div>}
  </div>
}

const PAGE_SIZE = 100

function Tables() {
  const [tables, setTables] = useState<Json[]>([])
  const [selected, setSelected] = useState('catalog_items')
  const [data, setData] = useState<Json | null>(null)
  const [filter, setFilter] = useState('')
  const [hideEmpty, setHideEmpty] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' }>({ column: '', direction: 'desc' })
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<Json | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function loadTables() {
    try { setTables((await api<Json>('/tables')).tables) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  async function loadTable() {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), search: query })
      if (sort.column) { params.set('orderBy', sort.column); params.set('direction', sort.direction) }
      setData(await api(`/tables/${encodeURIComponent(selected)}?${params}`))
    } catch (err) { setData(null); setError(err instanceof Error ? err.message : String(err)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void loadTables() }, [])
  useEffect(() => { void loadTable() }, [selected, page, query, sort.column, sort.direction])

  function selectTable(name: string) { setSelected(name); setPage(0); setSearch(''); setQuery(''); setSort({ column: '', direction: 'desc' }) }
  function toggleSort(column: string) {
    setPage(0)
    setSort(current => current.column === column ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { column, direction: 'asc' })
  }
  async function refresh() { await Promise.all([loadTable(), loadTables()]) }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!data || !editing) return
    const form = new FormData(event.currentTarget)
    const values = Object.fromEntries(data.columns.filter((column: Json) => !(column.pk && !isNew)).map((column: Json) => [column.name, form.get(column.name) === '' ? null : form.get(column.name)]))
    try {
      if (isNew) await api(`/tables/${data.table}/rows`, { method: 'POST', body: JSON.stringify({ values }) })
      else await api(`/tables/${data.table}/rows`, { method: 'PATCH', body: JSON.stringify({ keys: Object.fromEntries(data.primaryKey.map((key: string) => [key, editing[key]])), changes: values }) })
      setEditing(null); await refresh()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  const visible = tables.filter(table => table.name.includes(filter) && (!hideEmpty || Number(table.count) > 0))
  const populated = tables.filter(table => Number(table.count) > 0).length
  const pages = data ? Math.max(1, Math.ceil(Number(data.total) / PAGE_SIZE)) : 1

  return <section className="table-shell">
    <aside>
      <div className="table-picker-head">
        <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter tables…" />
        <label className="toggle"><input type="checkbox" checked={hideEmpty} onChange={e => setHideEmpty(e.target.checked)} /><span>Only tables with rows</span></label>
        <small>{fmt(visible.length)} shown · {fmt(populated)} of {fmt(tables.length)} populated</small>
      </div>
      {visible.length ? visible.map(table => <button className={selected === table.name ? 'active' : ''} key={table.name} onClick={() => selectTable(table.name)}><span>{table.name.replace('catalog_', '')}</span><small className={Number(table.count) ? 'green' : ''}>{fmt(table.count)}</small></button>)
        : <Empty text={tables.length ? 'No table matches this filter' : 'Loading tables…'} />}
    </aside>
    <main>
      <header>
        <div><strong>{selected}</strong><small>{data ? `${fmt(data.total)} rows · ${fmt(data.columns.length)} columns` : loading ? 'Loading…' : 'Unavailable'}</small></div>
        <form onSubmit={e => { e.preventDefault(); setPage(0); setQuery(search) }}><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search fields…" />{query && <button type="button" onClick={() => { setSearch(''); setQuery(''); setPage(0) }}>Clear</button>}</form>
        <button onClick={() => void refresh()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        <button className="primary" disabled={!data} onClick={() => { setEditing({}); setIsNew(true) }}>Add row</button>
      </header>
      {error && <div className="error-banner">{error}</div>}
      <div className="table-scroll">
        {data && data.rows.length
          ? <table><thead><tr>{data.columns.map((column: Json) => <th key={column.name} className={`sortable ${sort.column === column.name ? `sorted ${sort.direction}` : ''}`} onClick={() => toggleSort(column.name)}>{column.name}{column.pk ? ' 🔑' : ''}{sort.column === column.name ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</th>)}</tr></thead>
            <tbody>{data.rows.map((row: Json, index: number) => <tr key={index} onDoubleClick={() => { if (!data.primaryKey.length) return; setEditing(row); setIsNew(false) }}>{data.columns.map((column: Json) => <td key={column.name} title={String(row[column.name] ?? '')}>{String(row[column.name] ?? '—')}</td>)}</tr>)}</tbody></table>
          : !loading && <Empty text={query ? `No rows in ${selected} match “${query}”` : `${selected} is empty — run a flow to populate it`} />}
      </div>
      {data && <footer className="table-footer">
        <span>{data.primaryKey.length ? 'Double-click a row to edit it' : 'This table has no primary key — rows can be added but not edited'}</span>
        <div><button disabled={page === 0 || loading} onClick={() => setPage(value => Math.max(0, value - 1))}>Prev</button><span>Page {fmt(page + 1)} / {fmt(pages)}</span><button disabled={page + 1 >= pages || loading} onClick={() => setPage(value => value + 1)}>Next</button></div>
      </footer>}
    </main>
    {editing && data && <div className="modal-backdrop"><form className="edit-modal" onSubmit={save}><button type="button" className="modal-close" onClick={() => setEditing(null)}>×</button><h2>{isNew ? 'ADD ROW' : 'EDIT ROW'}</h2><div className="field-grid">{data.columns.map((column: Json) => <label key={column.name}><span>{column.name}</span><textarea name={column.name} defaultValue={editing[column.name] ?? ''} disabled={column.pk && !isNew} /></label>)}</div><div className="modal-actions">{!isNew && <button type="button" className="danger" onClick={async () => { if (!confirm('Delete this row permanently?')) return; await api(`/tables/${data.table}/rows`, { method: 'DELETE', body: JSON.stringify({ keys: Object.fromEntries(data.primaryKey.map((key: string) => [key, editing[key]])) }) }); setEditing(null); await refresh() }}>Delete</button>}<button type="button" onClick={() => setEditing(null)}>Cancel</button><button className="primary">Save</button></div></form></div>}</section>
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [view, setView] = useState<View>('overview')
  const [overview, setOverview] = useState<Json | null>(null)
  const [error, setError] = useState('')
  async function bootstrap() {
    const status = await fetch('/api/v1/auth/status', { credentials: 'include' }).then(response => response.json())
    setAuthenticated(Boolean(status.authenticated))
    setUsername(status.username ?? null)
    if (status.authenticated) setOverview(await api('/overview'))
  }
  async function logout() {
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } finally {
      setAuthenticated(false)
      setUsername(null)
      setOverview(null)
    }
  }
  const refreshOverview = () => void api('/overview').then(setOverview).catch(() => {})
  useEffect(() => { void bootstrap().catch(err => setError(String(err))) }, [])
  // The control bar reports live runner state, so keep the overview warm while
  // the operator is signed in regardless of which view they are looking at.
  useEffect(() => {
    if (!authenticated) return
    const timer = setInterval(refreshOverview, 5000)
    return () => clearInterval(timer)
  }, [authenticated])
  if (authenticated === null) return <main className="splash">ARCHIVIST CATALOGUE</main>
  if (!authenticated) return <Login onSuccess={() => void bootstrap()} />
  const nav: Array<[View, string, string, string]> = [['overview', '🏠', 'Overview', 'cyan'], ['items', '🎞️', 'Items', 'cyan'], ['people', '👥', 'People', 'violet'], ['flows', '🔄', 'Flows', 'pink'], ['tables', '🗄️', 'Tables', 'white']]
  return <div className={`app ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}><aside className="sidebar">
    <button type="button" className="sidebar-brand" aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} onClick={() => setSidebarCollapsed(value => !value)}>
      <img src={ArchivistIcon} alt="" /><span>ARCHIVIST</span>
    </button>
    <nav aria-label="Catalogue">{nav.map(([key, icon, label, accent]) => <button className={`archivist-sidebar-item side-nav-button nav-${accent} ${view === key ? 'active' : ''}`} data-accent={accent} aria-current={view === key ? 'page' : undefined} aria-label={label} title={sidebarCollapsed ? label : undefined} key={key} onClick={() => setView(key)}><i>{icon}</i><span>{label}</span></button>)}</nav>
    <footer>{!sidebarCollapsed && username && <div className="sidebar-username" title={username}>{username}</div>}<button type="button" title="Sign out" onClick={() => void logout()}>{sidebarCollapsed ? 'Out' : 'Sign out'}</button>{!sidebarCollapsed && <small>CATALOGUE</small>}</footer>
  </aside><main className="main">
    <div className="topbar">
      <h1>{view.toUpperCase()}</h1>
      <ControlBar overview={overview} onRefresh={refreshOverview} />
      <div className="topbar-meta"><span>MULTI-SOURCE</span><span>DB {bytes(overview?.database?.bytes)}</span></div>
    </div>
    <div className={view === 'tables' ? 'content wide' : 'content'}>{error && <div className="error-banner">{error}</div>}{view === 'overview' && overview && <Overview data={overview} onRefresh={refreshOverview} onOpenFlows={() => setView('flows')} />}{view === 'items' && <Items />}{view === 'people' && <People />}{view === 'flows' && <Flows />}{view === 'tables' && <Tables />}</div>
  </main></div>
}
