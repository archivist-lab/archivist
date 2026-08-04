import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { createLogger } from '@archivist/core'
import { upsertOrganisationIdentity, upsertPersonIdentity } from '@archivist/catalogue'
import { catalogueArtworkRoot, cataloguePath } from './catalogue-database.js'
import { importImdbDatasets } from './catalogue-imdb.js'

const logger = createLogger('CatalogueRunner')
type Json = Record<string, any>
type FlowOptions = { limit?: number; date?: string; allArtwork?: boolean; mediaTypes?: string[]; minYear?: number; includeAdult?: boolean }
type Progress = { step?: string; processed?: number; total?: number | null; succeeded?: number; failed?: number; message?: string }
type FlowNode = { id: string; type: string; label: string; description?: string; x: number; y: number; enabled?: boolean; config?: FlowOptions }
type FlowEdge = { id: string; source: string; target: string }
type FlowGraph = { nodes: FlowNode[]; edges: FlowEdge[] }

export const CATALOGUE_FLOW_NODE_TYPES = [
  { type: 'trigger', label: 'Trigger', description: 'Starts a catalogue flow.', tone: 'cyan' },
  { type: 'imdb-import', label: 'IMDb dataset import', description: 'Streams and filters IMDb title, credit and name datasets.', tone: 'violet' },
  { type: 'enrich-items', label: 'Provider enrichment', description: 'Matches IMDb records with OMDb, TVDB and TMDB.', tone: 'pink' },
  { type: 'fetch-artwork', label: 'Artwork downloader', description: 'Downloads selected posters, backdrops, stills and profiles.', tone: 'amber' },
  { type: 'resolve-identities', label: 'Resolve identities', description: 'Finds possible duplicate people and organisations.', tone: 'violet' },
  { type: 'integrity-check', label: 'Integrity check', description: 'Checks storage integrity and refreshes search indexes.', tone: 'green' },
  { type: 'tmdb-id-import', label: 'TMDB ID import', description: 'Imports TMDB daily identifier exports.', tone: 'cyan' },
  { type: 'changed-movies', label: 'Changed movies', description: 'Queues titles reported by the TMDB movie change list.', tone: 'pink' },
  { type: 'hydrate-movies', label: 'Hydrate movies', description: 'Fetches complete TMDB movie bundles.', tone: 'pink' },
  { type: 'changed-series', label: 'Changed series', description: 'Queues titles reported by the TMDB TV change list.', tone: 'violet' },
  { type: 'hydrate-series', label: 'Hydrate series', description: 'Fetches series, seasons and episodes.', tone: 'violet' },
] as const

const nodeTypeSet = new Set<string>(CATALOGUE_FLOW_NODE_TYPES.map(node => node.type))
const definedOptions = (value: FlowOptions): FlowOptions => Object.fromEntries(Object.entries(value).filter(([, option]) => option !== undefined)) as FlowOptions

const now = () => new Date().toISOString()
const dateOnly = (date = new Date()) => date.toISOString().slice(0, 10)
const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
const numberOrNull = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null
const textOrNull = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null
const bool = (value: unknown) => value ? 1 : 0
const array = (value: unknown): Json[] => Array.isArray(value) ? value.filter(v => v && typeof v === 'object') : []

function exportName(date: Date): string {
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}_${String(date.getUTCDate()).padStart(2, '0')}_${date.getUTCFullYear()}`
}

function tmdbToken(): string {
  return process.env.TMDB_READ_TOKEN?.trim() || process.env.TMDB_API_TOKEN?.trim() || ''
}

function tmdbApiKey(): string {
  return process.env.TMDB_API_KEY?.trim() || ''
}

function tmdbHeaders(): Record<string, string> {
  const token = tmdbToken()
  return token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : { Accept: 'application/json' }
}

function tmdbApiBase(): string {
  return (process.env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3').replace(/\/$/, '')
}

function requireTmdbToken(): void {
  if (!tmdbToken() && !tmdbApiKey()) throw new Error('TMDB_READ_TOKEN or TMDB_API_KEY is required for change lists and metadata hydration')
}

function tmdbUrl(url: string): string {
  if (tmdbToken() || !tmdbApiKey()) return url
  const parsed = new URL(url)
  parsed.searchParams.set('api_key', tmdbApiKey())
  return parsed.toString()
}

const omdbApiKey = () => process.env.OMDB_API_KEY?.trim() || ''
const omdbBase = () => (process.env.OMDB_BASE_URL ?? 'https://www.omdbapi.com').replace(/\/$/, '')
const tvdbBase = () => (process.env.TVDB_BASE_URL ?? 'https://api4.thetvdb.com/v4').replace(/\/$/, '')
let catalogueTvdbToken = ''
let catalogueTvdbTokenExpires = 0

async function tvdbHeaders(signal: AbortSignal): Promise<Record<string, string>> {
  if (catalogueTvdbToken && Date.now() < catalogueTvdbTokenExpires) return { Authorization: `Bearer ${catalogueTvdbToken}`, Accept: 'application/json' }
  const apikey = process.env.TVDB_API_KEY?.trim()
  if (!apikey) throw new Error('TVDB_API_KEY is not configured')
  const pin = process.env.TVDB_PIN?.trim()
  const response = await fetch(`${tvdbBase()}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pin ? { apikey, pin } : { apikey }), signal })
  if (!response.ok) throw new Error(`TVDB login returned HTTP ${response.status}`)
  const payload = await response.json() as Json
  catalogueTvdbToken = String(payload.data?.token ?? '')
  if (!catalogueTvdbToken) throw new Error('TVDB login did not return a token')
  catalogueTvdbTokenExpires = Date.now() + 23 * 60 * 60 * 1000
  return { Authorization: `Bearer ${catalogueTvdbToken}`, Accept: 'application/json' }
}

function linearGraph(types: string[]): FlowGraph {
  const nodes = types.map((type, index) => {
    const definition = CATALOGUE_FLOW_NODE_TYPES.find(candidate => candidate.type === type)
    return {
      id: `${type}-${index + 1}`,
      type,
      label: definition?.label ?? type,
      description: definition?.description ?? '',
      x: 70 + index * 260,
      y: 220,
      enabled: true,
      config: {},
    }
  })
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index + 1}`, source: nodes[index].id, target: node.id })) }
}

function defaultGraph(flowKey: string): FlowGraph {
  const pipelines: Record<string, string[]> = {
    'daily-sync': ['trigger', 'imdb-import', 'enrich-items', 'fetch-artwork', 'integrity-check'],
    'imdb-seed': ['trigger', 'imdb-import'],
    'enrich-items': ['trigger', 'enrich-items'],
    'fetch-artwork': ['trigger', 'fetch-artwork'],
    'resolve-identities': ['trigger', 'resolve-identities'],
    'integrity-check': ['trigger', 'integrity-check'],
    'daily-id-import': ['trigger', 'tmdb-id-import'],
    'changed-movies': ['trigger', 'changed-movies'],
    'hydrate-movies': ['trigger', 'hydrate-movies'],
    'changed-series': ['trigger', 'changed-series'],
    'hydrate-series': ['trigger', 'hydrate-series'],
  }
  const graph = linearGraph(pipelines[flowKey] ?? ['trigger'])
  const imdb = graph.nodes.find(node => node.type === 'imdb-import')
  if (imdb) imdb.config = { minYear: 1930 }
  if (flowKey === 'daily-sync') {
    const enrich = graph.nodes.find(node => node.type === 'enrich-items')
    const artwork = graph.nodes.find(node => node.type === 'fetch-artwork')
    if (enrich) enrich.config = { limit: 250 }
    if (artwork) artwork.config = { limit: 100 }
  }
  return graph
}

function parseGraph(value: unknown): FlowGraph {
  const graph = typeof value === 'string' ? JSON.parse(value) : value
  if (!graph || typeof graph !== 'object' || !Array.isArray((graph as FlowGraph).nodes) || !Array.isArray((graph as FlowGraph).edges)) throw new Error('Flow graph must contain nodes and edges')
  const input = graph as FlowGraph
  const ids = new Set<string>()
  const nodes = input.nodes.map((node, index) => {
    if (!node || typeof node !== 'object') throw new Error(`Node ${index + 1} is invalid`)
    const id = String(node.id ?? '').trim()
    const type = String(node.type ?? '').trim()
    if (!id || ids.has(id)) throw new Error(`Node ${index + 1} needs a unique ID`)
    if (!nodeTypeSet.has(type)) throw new Error(`Unsupported node type: ${type || 'empty'}`)
    ids.add(id)
    return {
      id,
      type,
      label: String(node.label ?? CATALOGUE_FLOW_NODE_TYPES.find(candidate => candidate.type === type)?.label ?? type).slice(0, 120),
      description: String(node.description ?? '').slice(0, 500),
      x: Number.isFinite(Number(node.x)) ? Number(node.x) : index * 260,
      y: Number.isFinite(Number(node.y)) ? Number(node.y) : 200,
      enabled: node.enabled !== false,
      config: node.config && typeof node.config === 'object' ? node.config : {},
    }
  })
  const edges = input.edges.map((edge, index) => {
    const source = String(edge?.source ?? '')
    const target = String(edge?.target ?? '')
    if (!ids.has(source) || !ids.has(target) || source === target) throw new Error(`Edge ${index + 1} has invalid endpoints`)
    return { id: String(edge.id || `edge-${index + 1}`), source, target }
  })
  const incoming = new Map(nodes.map(node => [node.id, 0]))
  for (const edge of edges) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
  const queue = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id)
  let visited = 0
  while (queue.length) {
    const id = queue.shift()!
    visited++
    for (const edge of edges.filter(candidate => candidate.source === id)) {
      const count = (incoming.get(edge.target) ?? 1) - 1
      incoming.set(edge.target, count)
      if (count === 0) queue.push(edge.target)
    }
  }
  if (visited !== nodes.length) throw new Error('Flow graph cannot contain a cycle')
  return { nodes, edges }
}

export class CatalogueFlowRunner {
  private readonly active = new Map<number, AbortController>()
  private readonly activeNodes = new Map<number, string>()
  private scheduler: NodeJS.Timeout | null = null

  constructor(private readonly db: Database.Database) {
    this.recoverInterruptedRuns()
    this.ensureFlowGraphs()
  }

  private recoverInterruptedRuns(): void {
    const interrupted = this.db.prepare(`SELECT run_id FROM catalog_flow_runs WHERE status IN ('queued','running','cancelling')`).all() as Array<{ run_id: number }>
    if (!interrupted.length) return
    const message = 'Interrupted by a Catalogue restart. The flow is safe to run again.'
    this.db.transaction(() => {
      for (const run of interrupted) {
        this.db.prepare(`UPDATE catalog_flow_runs SET status='failed',finished_at=CURRENT_TIMESTAMP,message=? WHERE run_id=?`).run(message, run.run_id)
        this.db.prepare(`UPDATE catalog_flow_node_runs SET status=CASE WHEN status='running' THEN 'failed' ELSE 'skipped' END,finished_at=CURRENT_TIMESTAMP,message=CASE WHEN status='running' THEN ? ELSE 'Not reached before restart' END WHERE run_id=? AND status IN ('pending','running')`).run(message, run.run_id)
        this.db.prepare(`INSERT INTO catalog_flow_logs(run_id,level,message,context_json) VALUES(?,'error',?,?)`).run(run.run_id, message, JSON.stringify({ recoveredAt: now(), reason: 'process-restart' }))
      }
    })()
  }

  private ensureFlowGraphs(): void {
    const flows = this.db.prepare('SELECT flow_key FROM catalog_flow_definitions').all() as Array<{ flow_key: string }>
    const insert = this.db.prepare(`INSERT INTO catalog_flow_versions(flow_key,version_number,status,graph_json,published_at) VALUES(?,1,'published',?,CURRENT_TIMESTAMP)`)
    this.db.transaction(() => {
      for (const flow of flows) {
        const exists = this.db.prepare('SELECT 1 FROM catalog_flow_versions WHERE flow_key=?').get(flow.flow_key)
        if (!exists) insert.run(flow.flow_key, JSON.stringify(defaultGraph(flow.flow_key)))
      }
    })()
  }

  flowGraph(flowKey: string): Json {
    const flow = this.db.prepare('SELECT * FROM catalog_flow_definitions WHERE flow_key=?').get(flowKey) as Json | undefined
    if (!flow) throw new Error('Unknown catalogue flow')
    const published = this.db.prepare(`SELECT * FROM catalog_flow_versions WHERE flow_key=? AND status='published'`).get(flowKey) as Json | undefined
    const draft = this.db.prepare(`SELECT * FROM catalog_flow_versions WHERE flow_key=? AND status='draft'`).get(flowKey) as Json | undefined
    const mapVersion = (version: Json | undefined) => version ? { ...version, graph: parseGraph(version.graph_json), graph_json: undefined } : null
    return { flow, published: mapVersion(published), draft: mapVersion(draft), nodeTypes: CATALOGUE_FLOW_NODE_TYPES }
  }

  saveDraft(flowKey: string, input: unknown): Json {
    const flow = this.db.prepare('SELECT 1 FROM catalog_flow_definitions WHERE flow_key=?').get(flowKey)
    if (!flow) throw new Error('Unknown catalogue flow')
    const graph = parseGraph(input)
    const existing = this.db.prepare(`SELECT version_id,version_number FROM catalog_flow_versions WHERE flow_key=? AND status='draft'`).get(flowKey) as Json | undefined
    if (existing) this.db.prepare(`UPDATE catalog_flow_versions SET graph_json=?,updated_at=CURRENT_TIMESTAMP WHERE version_id=?`).run(JSON.stringify(graph), existing.version_id)
    else {
      const next = Number((this.db.prepare('SELECT COALESCE(max(version_number),0)+1 value FROM catalog_flow_versions WHERE flow_key=?').get(flowKey) as Json).value)
      this.db.prepare(`INSERT INTO catalog_flow_versions(flow_key,version_number,status,graph_json) VALUES(?,?,'draft',?)`).run(flowKey, next, JSON.stringify(graph))
    }
    return this.flowGraph(flowKey)
  }

  publishDraft(flowKey: string): Json {
    const draft = this.db.prepare(`SELECT version_id,graph_json FROM catalog_flow_versions WHERE flow_key=? AND status='draft'`).get(flowKey) as Json | undefined
    if (!draft) throw new Error('Save a draft before publishing')
    parseGraph(draft.graph_json)
    this.db.transaction(() => {
      this.db.prepare(`UPDATE catalog_flow_versions SET status='archived',updated_at=CURRENT_TIMESTAMP WHERE flow_key=? AND status='published'`).run(flowKey)
      this.db.prepare(`UPDATE catalog_flow_versions SET status='published',published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE version_id=?`).run(draft.version_id)
    })()
    return this.flowGraph(flowKey)
  }

  nodeRuns(runId: number): Json[] {
    const rows = this.db.prepare('SELECT * FROM catalog_flow_node_runs WHERE run_id=? ORDER BY node_run_id').all(runId) as Json[]
    if (rows.length) return rows
    const run = this.db.prepare('SELECT * FROM catalog_flow_runs WHERE run_id=?').get(runId) as Json | undefined
    if (!run) return []
    const version = this.db.prepare(`SELECT version_id,graph_json FROM catalog_flow_versions WHERE flow_key=? AND status='published'`).get(run.flow_key) as Json | undefined
    if (!version) return []
    const nodes = this.orderedNodes(parseGraph(version.graph_json))
    const step = String(run.current_step ?? '').toLowerCase()
    const expectedType = step.includes('imdb') ? 'imdb-import'
      : step.includes('enrich') || step.includes('provider') ? 'enrich-items'
      : step.includes('artwork') || step.includes('download') ? 'fetch-artwork'
      : step.includes('identit') || step.includes('duplicate') ? 'resolve-identities'
      : step.includes('integrity') || step.includes('search index') || step.includes('sqlite') ? 'integrity-check'
      : step.includes('change list') && String(run.flow_key).includes('series') ? 'changed-series'
      : step.includes('change list') ? 'changed-movies'
      : step.includes('hydrat') && String(run.flow_key).includes('series') ? 'hydrate-series'
      : step.includes('hydrat') ? 'hydrate-movies'
      : step.includes('importing') && step.includes('id') ? 'tmdb-id-import'
      : String(run.flow_key)
    let activeIndex = nodes.findIndex(node => node.type === expectedType)
    if (activeIndex < 0) activeIndex = Math.max(0, nodes.findIndex(node => node.type !== 'trigger'))
    return nodes.map((node, index) => {
      let status = index < activeIndex ? 'completed' : index > activeIndex ? 'pending' : run.status
      if (run.status === 'completed') status = 'completed'
      if (run.status === 'failed' && index > activeIndex) status = 'skipped'
      const current = index === activeIndex
      return {
        node_run_id: null,
        run_id: runId,
        version_id: version.version_id,
        node_key: node.id,
        node_type: node.type,
        node_label: node.label,
        status,
        started_at: current ? run.started_at : null,
        finished_at: status === 'completed' ? run.finished_at : null,
        processed: current ? run.processed : status === 'completed' ? 1 : 0,
        total: current ? run.total : status === 'completed' ? 1 : null,
        succeeded: current ? run.succeeded : status === 'completed' ? 1 : 0,
        failed: current ? run.failed : 0,
        message: current ? run.message : status === 'completed' ? 'Completed before node-level tracking was enabled' : null,
        legacy_progress: true,
      }
    })
  }

  mappingIssues(limit = 200): Json[] {
    const explicit = this.db.prepare(`SELECT issue_id,node_key,issue_type,severity,source,source_id,title,description,context_json,status,created_at FROM catalog_mapping_issues WHERE status='open' ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END,created_at DESC LIMIT ?`).all(limit) as Json[]
    const remaining = Math.max(0, limit - explicit.length)
    if (!remaining) return explicit
    const provider = this.db.prepare(`SELECT NULL issue_id,'enrich-items-2' node_key,'provider_failure' issue_type,'error' severity,p.provider source,e.external_id source_id,i.canonical_title title,p.last_error description,'{}' context_json,'open' status,p.last_attempt_at created_at FROM catalog_provider_enrichment p JOIN catalog_items i USING(item_id) LEFT JOIN catalog_item_external_ids e ON e.item_id=i.item_id AND e.source='imdb' WHERE p.status='failed' ORDER BY p.last_attempt_at DESC LIMIT ?`).all(remaining) as Json[]
    return [...explicit, ...provider]
  }

  listFlows(): Json[] {
    return this.db.prepare(`
      SELECT d.*,
        r.run_id,r.trigger_type,r.status,r.started_at,r.finished_at,r.current_step,
        r.processed,r.total,r.succeeded,r.failed,r.message,
        (SELECT version_number FROM catalog_flow_versions v WHERE v.flow_key=d.flow_key AND v.status='published') version_number,
        (SELECT count(*) FROM catalog_flow_versions v WHERE v.flow_key=d.flow_key AND v.status='draft') has_draft
      FROM catalog_flow_definitions d
      LEFT JOIN catalog_flow_runs r ON r.run_id=(
        SELECT run_id FROM catalog_flow_runs WHERE flow_key=d.flow_key ORDER BY run_id DESC LIMIT 1
      )
      WHERE d.enabled=1 ORDER BY d.sort_order
    `).all() as Json[]
  }

  listRuns(limit = 100): Json[] {
    return this.db.prepare(`
      SELECT r.*,d.name FROM catalog_flow_runs r
      JOIN catalog_flow_definitions d USING(flow_key)
      ORDER BY r.run_id DESC LIMIT ?
    `).all(Math.max(1, Math.min(limit, 500))) as Json[]
  }

  logs(runId: number, limit = 500): Json[] {
    return this.db.prepare(`SELECT * FROM catalog_flow_logs WHERE run_id=? ORDER BY log_id DESC LIMIT ?`)
      .all(runId, Math.max(1, Math.min(limit, 2000))) as Json[]
  }

  run(flowKey: string, triggerType = 'manual', options: FlowOptions = {}): number {
    const definition = this.db.prepare('SELECT flow_key FROM catalog_flow_definitions WHERE flow_key=? AND enabled=1').get(flowKey)
    if (!definition) throw new Error(`Unknown or disabled flow: ${flowKey}`)
    const existing = this.db.prepare(`SELECT run_id FROM catalog_flow_runs WHERE flow_key=? AND status IN ('queued','running','cancelling') ORDER BY run_id DESC LIMIT 1`).get(flowKey) as { run_id: number } | undefined
    if (existing) throw new Error(`Flow is already running (run ${existing.run_id})`)
    const result = this.db.prepare(`INSERT INTO catalog_flow_runs(flow_key,trigger_type,status,options_json) VALUES(?,?,'queued',?)`)
      .run(flowKey, triggerType, JSON.stringify(options))
    const runId = Number(result.lastInsertRowid)
    setImmediate(() => void this.execute(runId, flowKey, options))
    return runId
  }

  cancel(runId: number): boolean {
    const controller = this.active.get(runId)
    if (!controller) return false
    this.db.prepare(`UPDATE catalog_flow_runs SET status='cancelling',message='Cancellation requested' WHERE run_id=?`).run(runId)
    controller.abort(new Error('Cancelled by user'))
    return true
  }

  startScheduler(): void {
    if (this.scheduler) return
    const tick = () => {
      try {
        const current = new Date()
        const hour = Number(process.env.ARCHIVIST_CATALOGUE_SYNC_HOUR_UTC ?? 9)
        const minute = Number(process.env.ARCHIVIST_CATALOGUE_SYNC_MINUTE_UTC ?? 15)
        if (current.getUTCHours() !== hour || current.getUTCMinutes() !== minute) return
        const today = dateOnly(current)
        const done = this.db.prepare(`SELECT 1 FROM catalog_flow_runs WHERE flow_key='daily-sync' AND trigger_type='schedule' AND substr(started_at,1,10)=? LIMIT 1`).get(today)
        if (!done) this.run('daily-sync', 'schedule', {})
      } catch (error) {
        logger.warn('Catalogue scheduler tick failed:', error instanceof Error ? error.message : String(error))
      }
    }
    this.scheduler = setInterval(tick, 60_000)
    this.scheduler.unref()
    tick()
  }

  stop(): void {
    if (this.scheduler) clearInterval(this.scheduler)
    this.scheduler = null
    for (const controller of this.active.values()) controller.abort(new Error('Archivist shutting down'))
    this.active.clear()
  }

  private async execute(runId: number, flowKey: string, options: FlowOptions): Promise<void> {
    const controller = new AbortController()
    this.active.set(runId, controller)
    this.db.prepare(`UPDATE catalog_flow_runs SET status='running',started_at=?,current_step='Starting' WHERE run_id=?`).run(now(), runId)
    this.log(runId, 'info', `Started ${flowKey}`, options)
    try {
      const version = this.db.prepare(`SELECT version_id,graph_json FROM catalog_flow_versions WHERE flow_key=? AND status='published'`).get(flowKey) as Json | undefined
      if (!version) throw new Error(`No published graph for ${flowKey}`)
      const graph = parseGraph(version.graph_json)
      const ordered = this.orderedNodes(graph)
      const createNodeRun = this.db.prepare(`INSERT INTO catalog_flow_node_runs(run_id,version_id,node_key,node_type,node_label,status) VALUES(?,?,?,?,?,'pending')`)
      this.db.transaction(() => { for (const node of ordered) createNodeRun.run(runId, version.version_id, node.id, node.type, node.label) })()
      for (const node of ordered) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (node.enabled === false) {
          this.db.prepare(`UPDATE catalog_flow_node_runs SET status='skipped',finished_at=CURRENT_TIMESTAMP,message='Disabled in flow version' WHERE run_id=? AND node_key=?`).run(runId, node.id)
          continue
        }
        await this.executeNode(runId, node, { ...definedOptions(node.config ?? {}), ...definedOptions(options) }, controller.signal)
      }
      this.db.prepare(`UPDATE catalog_flow_runs SET status='completed',finished_at=?,current_step='Complete',message=COALESCE(message,'Completed') WHERE run_id=?`).run(now(), runId)
      this.log(runId, 'info', 'Flow completed')
    } catch (error) {
      const cancelled = controller.signal.aborted
      const message = error instanceof Error ? error.message : String(error)
      this.db.prepare(`UPDATE catalog_flow_runs SET status=?,finished_at=?,message=? WHERE run_id=?`)
        .run(cancelled ? 'cancelled' : 'failed', now(), message, runId)
      this.db.prepare(`UPDATE catalog_flow_node_runs SET status='skipped',finished_at=CURRENT_TIMESTAMP,message='Not reached' WHERE run_id=? AND status='pending'`).run(runId)
      this.log(runId, cancelled ? 'warn' : 'error', message)
      if (!cancelled) logger.error(`Catalogue flow ${flowKey} failed:`, message)
    } finally {
      this.active.delete(runId)
      this.activeNodes.delete(runId)
    }
  }

  private orderedNodes(graph: FlowGraph): FlowNode[] {
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    const incoming = new Map(graph.nodes.map(node => [node.id, 0]))
    const outgoing = new Map(graph.nodes.map(node => [node.id, [] as string[]]))
    for (const edge of graph.edges) {
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
      outgoing.get(edge.source)?.push(edge.target)
    }
    const ready = graph.nodes.filter(node => incoming.get(node.id) === 0).sort((a, b) => a.x - b.x || a.y - b.y)
    const result: FlowNode[] = []
    while (ready.length) {
      const node = ready.shift()!
      result.push(node)
      for (const target of outgoing.get(node.id) ?? []) {
        const count = (incoming.get(target) ?? 1) - 1
        incoming.set(target, count)
        if (count === 0) ready.push(byId.get(target)!)
      }
      ready.sort((a, b) => a.x - b.x || a.y - b.y)
    }
    return result
  }

  private async executeNode(runId: number, node: FlowNode, options: FlowOptions, signal: AbortSignal): Promise<void> {
    this.activeNodes.set(runId, node.id)
    this.db.prepare(`UPDATE catalog_flow_node_runs SET status='running',started_at=CURRENT_TIMESTAMP,message=? WHERE run_id=? AND node_key=?`).run(node.description || node.label, runId, node.id)
    this.db.prepare(`UPDATE catalog_flow_runs SET current_step=? WHERE run_id=?`).run(node.label, runId)
    this.log(runId, 'info', `Node started: ${node.label}`, { nodeKey: node.id, nodeType: node.type })
    const progress = (value: Progress) => this.progress(runId, value)
    try {
      if (node.type === 'trigger') progress({ step: node.label, processed: 1, total: 1, succeeded: 1, failed: 0, message: 'Triggered' })
      else if (node.type === 'imdb-import') await this.importImdb(runId, options, signal, progress)
      else if (node.type === 'enrich-items') await this.enrichItems(runId, options, signal, progress)
      else if (node.type === 'fetch-artwork') await this.fetchArtwork(runId, options, signal, progress)
      else if (node.type === 'resolve-identities') await this.resolveIdentities(runId, progress)
      else if (node.type === 'integrity-check') await this.integrityCheck(runId, progress)
      else if (node.type === 'tmdb-id-import') await this.importDailyIds(runId, options, signal, progress)
      else if (node.type === 'changed-movies') await this.queueChangedMovies(runId, options, signal, progress)
      else if (node.type === 'hydrate-movies') await this.hydrateMovies(runId, options, signal, progress)
      else if (node.type === 'changed-series') await this.queueChangedSeries(runId, options, signal, progress)
      else if (node.type === 'hydrate-series') await this.hydrateSeries(runId, options, signal, progress)
      else throw new Error(`No executor registered for node type ${node.type}`)
      this.db.prepare(`UPDATE catalog_flow_node_runs SET status='completed',finished_at=CURRENT_TIMESTAMP,message=COALESCE(message,'Completed') WHERE run_id=? AND node_key=?`).run(runId, node.id)
      this.log(runId, 'info', `Node completed: ${node.label}`, { nodeKey: node.id })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.prepare(`UPDATE catalog_flow_node_runs SET status=?,finished_at=CURRENT_TIMESTAMP,message=?,error_json=? WHERE run_id=? AND node_key=?`).run(signal.aborted ? 'cancelled' : 'failed', message, JSON.stringify({ message }), runId, node.id)
      throw error
    }
  }

  private progress(runId: number, value: Progress): void {
    const current = this.db.prepare('SELECT processed,total,succeeded,failed,current_step,message FROM catalog_flow_runs WHERE run_id=?').get(runId) as Json
    this.db.prepare(`UPDATE catalog_flow_runs SET current_step=?,processed=?,total=?,succeeded=?,failed=?,message=? WHERE run_id=?`).run(
      value.step ?? current.current_step,
      value.processed ?? current.processed,
      value.total === undefined ? current.total : value.total,
      value.succeeded ?? current.succeeded,
      value.failed ?? current.failed,
      value.message ?? current.message,
      runId,
    )
    const nodeKey = this.activeNodes.get(runId)
    if (nodeKey) {
      const node = this.db.prepare(`SELECT processed,total,succeeded,failed,message FROM catalog_flow_node_runs WHERE run_id=? AND node_key=?`).get(runId, nodeKey) as Json
      this.db.prepare(`UPDATE catalog_flow_node_runs SET processed=?,total=?,succeeded=?,failed=?,message=? WHERE run_id=? AND node_key=?`).run(
        value.processed ?? node.processed,
        value.total === undefined ? node.total : value.total,
        value.succeeded ?? node.succeeded,
        value.failed ?? node.failed,
        value.message ?? value.step ?? node.message,
        runId,
        nodeKey,
      )
    }
  }

  private log(runId: number, level: string, message: string, context?: unknown): void {
    this.db.prepare(`INSERT INTO catalog_flow_logs(run_id,level,message,context_json) VALUES(?,?,?,?)`)
      .run(runId, level, message, context === undefined ? null : JSON.stringify(context))
  }

  private async importImdb(runId: number, options: FlowOptions, signal: AbortSignal, progress: (value: Progress) => void): Promise<void> {
    const result = await importImdbDatasets(this.db, options, signal, {
      progress,
      log: (message, context) => this.log(runId, 'info', message, context),
    })
    progress({ step: 'IMDb import complete', processed: result.rows, total: result.rows, succeeded: result.accepted, message: `${result.accepted.toLocaleString()} accepted records and relationships` })
  }

  private async enrichItems(runId: number, options: FlowOptions, signal: AbortSignal, progress: (value: Progress) => void): Promise<void> {
    const limit = Math.max(1, Math.min(Number(options.limit ?? 100), 5_000))
    const rows = this.db.prepare(`SELECT q.queue_id,q.entity_type,q.source_id,i.item_id FROM catalog_ingest_queue q JOIN catalog_item_external_ids e ON e.source='imdb' AND e.external_id=q.source_id JOIN catalog_items i ON i.item_id=e.item_id WHERE q.source='enrichment' AND q.status IN ('pending','failed') AND q.available_at<=CURRENT_TIMESTAMP ORDER BY q.priority DESC,q.available_at,q.queue_id LIMIT ?`).all(limit) as Array<{ queue_id: number; entity_type: string; source_id: string; item_id: number }>
    progress({ step: 'Enriching IMDb records', processed: 0, total: rows.length, succeeded: 0, failed: 0 })
    let succeeded = 0
    let failed = 0
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      if (signal.aborted) throw signal.reason
      this.db.prepare(`UPDATE catalog_ingest_queue SET status='processing',locked_at=CURRENT_TIMESTAMP,attempts=attempts+1 WHERE queue_id=?`).run(row.queue_id)
      const providerErrors: string[] = []
      let providerSuccesses = 0
      for (const provider of ['omdb', 'tvdb', 'tmdb'] as const) {
        if (provider === 'omdb' && !omdbApiKey()) continue
        if (provider === 'tvdb' && (!process.env.TVDB_API_KEY?.trim() || row.entity_type !== 'series')) continue
        if (provider === 'tmdb' && ((!tmdbToken() && !tmdbApiKey()) || !['film', 'series'].includes(row.entity_type))) continue
        this.db.prepare(`INSERT INTO catalog_provider_enrichment(item_id,provider,status,attempts,last_attempt_at) VALUES(?,?,'processing',1,CURRENT_TIMESTAMP) ON CONFLICT(item_id,provider) DO UPDATE SET status='processing',attempts=attempts+1,last_attempt_at=CURRENT_TIMESTAMP,last_error=NULL`).run(row.item_id, provider)
        try {
          if (provider === 'omdb') await this.enrichFromOmdb(row.item_id, row.source_id, signal)
          if (provider === 'tvdb') await this.enrichFromTvdb(row.item_id, row.source_id, signal)
          if (provider === 'tmdb') await this.enrichFromTmdb(row.entity_type, row.source_id, signal)
          this.db.prepare(`UPDATE catalog_provider_enrichment SET status='complete',last_success_at=CURRENT_TIMESTAMP,last_error=NULL WHERE item_id=? AND provider=?`).run(row.item_id, provider)
          providerSuccesses++
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          providerErrors.push(`${provider}: ${message}`)
          this.db.prepare(`UPDATE catalog_provider_enrichment SET status='failed',last_error=? WHERE item_id=? AND provider=?`).run(message, row.item_id, provider)
          this.log(runId, 'warn', `${provider.toUpperCase()} enrichment failed`, { imdbId: row.source_id, message })
        }
      }
      const attemptedProviders = providerSuccesses + providerErrors.length
      if (attemptedProviders === 0) {
        failed++
        this.db.prepare(`UPDATE catalog_ingest_queue SET status='pending',locked_at=NULL,last_error='No compatible enrichment provider is configured',available_at=datetime('now','+1 day') WHERE queue_id=?`).run(row.queue_id)
      } else if (providerErrors.length && providerSuccesses === 0) {
        failed++
        this.db.prepare(`UPDATE catalog_ingest_queue SET status='failed',locked_at=NULL,last_error=?,available_at=datetime('now','+30 minutes') WHERE queue_id=?`).run(providerErrors.join('; '), row.queue_id)
      } else {
        succeeded++
        this.db.prepare(`UPDATE catalog_ingest_queue SET status='done',done_at=CURRENT_TIMESTAMP,locked_at=NULL,last_error=? WHERE queue_id=?`).run(providerErrors.length ? providerErrors.join('; ') : null, row.queue_id)
      }
      progress({ processed: index + 1, total: rows.length, succeeded, failed, message: `${row.source_id} · ${providerSuccesses} providers` })
      if (index + 1 < rows.length) await new Promise(resolve => setTimeout(resolve, 220))
    }
  }

  private async enrichFromOmdb(itemId: number, imdbId: string, signal: AbortSignal): Promise<void> {
    const params = new URLSearchParams({ apikey: omdbApiKey(), i: imdbId, plot: 'full', r: 'json' })
    const response = await fetch(`${omdbBase()}/?${params}`, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json() as Json
    if (payload.Response === 'False') throw new Error(String(payload.Error ?? 'No result'))
    const released = payload.Released && payload.Released !== 'N/A' ? new Date(payload.Released) : null
    const releaseDate = released && !Number.isNaN(released.valueOf()) ? released.toISOString().slice(0, 10) : null
    const rating = payload.imdbRating !== 'N/A' ? numberOrNull(payload.imdbRating) : null
    const votes = payload.imdbVotes !== 'N/A' ? numberOrNull(String(payload.imdbVotes).replace(/,/g, '')) : null
    this.db.prepare(`UPDATE catalog_items SET canonical_title=COALESCE(NULLIF(?,''),canonical_title),description=COALESCE(NULLIF(?,''),description),first_release_date=COALESCE(?,first_release_date),rating=COALESCE(?,rating),rating_count=COALESCE(?,rating_count),metadata_updated_at=CURRENT_TIMESTAMP WHERE item_id=?`).run(textOrNull(payload.Title), payload.Plot === 'N/A' ? null : textOrNull(payload.Plot), releaseDate, rating, votes, itemId)
    const runtime = numberOrNull(String(payload.Runtime ?? '').match(/\d+/)?.[0])
    this.db.prepare(`UPDATE catalog_film_details SET runtime_minutes=COALESCE(?,runtime_minutes) WHERE item_id=?`).run(runtime, itemId)
    if (payload.Poster && payload.Poster !== 'N/A') {
      const select = !this.db.prepare(`SELECT 1 FROM catalog_artwork_assets WHERE owner_type='item' AND owner_id=? AND artwork_type='poster' AND is_selected=1 AND deleted_at IS NULL`).get(itemId)
      this.upsertArtwork('item', itemId, 'poster', payload.Poster, {}, 0, select, 'omdb')
    }
    this.savePayload('omdb', 'item', imdbId, payload)
    this.refreshItemFts(itemId)
  }

  private async enrichFromTvdb(itemId: number, imdbId: string, signal: AbortSignal): Promise<void> {
    const headers = await tvdbHeaders(signal)
    const matchResponse = await fetch(`${tvdbBase()}/search/remoteid/${encodeURIComponent(imdbId)}`, { headers, signal })
    if (!matchResponse.ok) throw new Error(`remote-ID lookup HTTP ${matchResponse.status}`)
    const matches = array((await matchResponse.json() as Json).data)
    const match = matches.find(candidate => String(candidate.type ?? candidate.entityType ?? '').toLowerCase().includes('series')) ?? matches[0]
    const tvdbId = numberOrNull(match?.tvdb_id ?? match?.id ?? match?.series?.id)
    if (!tvdbId) throw new Error('No TVDB series match')
    const response = await fetch(`${tvdbBase()}/series/${tvdbId}/extended?meta=translations`, { headers, signal })
    if (!response.ok) throw new Error(`series HTTP ${response.status}`)
    const payload = (await response.json() as Json).data as Json
    this.db.prepare(`INSERT INTO catalog_item_external_ids(item_id,source,external_id,is_primary,verified_at) VALUES(?,'tvdb',?,0,CURRENT_TIMESTAMP) ON CONFLICT(source,external_id) DO NOTHING`).run(itemId, String(tvdbId))
    this.db.prepare(`UPDATE catalog_items SET description=COALESCE(NULLIF(?,''),description),status=COALESCE(NULLIF(?,''),status),original_language=COALESCE(NULLIF(?,''),original_language),metadata_updated_at=CURRENT_TIMESTAMP WHERE item_id=?`).run(textOrNull(payload.overview), textOrNull(payload.status?.name ?? payload.status), textOrNull(payload.originalLanguage), itemId)
    const runtime = numberOrNull(payload.averageRuntime)
    this.db.prepare(`UPDATE catalog_series_details SET episode_runtime_minutes=COALESCE(?,episode_runtime_minutes),number_of_seasons=COALESCE(?,number_of_seasons),number_of_episodes=COALESCE(?,number_of_episodes) WHERE item_id=?`).run(runtime, numberOrNull(array(payload.seasons).length), numberOrNull(payload.episodes?.length), itemId)
    if (payload.image) {
      const select = !this.db.prepare(`SELECT 1 FROM catalog_artwork_assets WHERE owner_type='item' AND owner_id=? AND artwork_type='poster' AND is_selected=1 AND deleted_at IS NULL`).get(itemId)
      this.upsertArtwork('item', itemId, 'poster', payload.image, {}, 0, select, 'tvdb')
    }
    array(payload.artworks).forEach((artwork, order) => this.upsertArtwork('item', itemId, Number(artwork.type) === 3 ? 'backdrop' : 'poster', artwork.image, artwork, order, false, 'tvdb'))
    this.savePayload('tvdb', 'series', String(tvdbId), payload)
  }

  private async enrichFromTmdb(entityType: string, imdbId: string, signal: AbortSignal): Promise<void> {
    const response = await fetch(tmdbUrl(`${tmdbApiBase()}/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&language=${encodeURIComponent(process.env.ARCHIVIST_CATALOGUE_LANGUAGE ?? 'en-US')}`), { headers: tmdbHeaders(), signal })
    if (!response.ok) throw new Error(`find HTTP ${response.status}`)
    const found = await response.json() as Json
    if (entityType === 'film') {
      const match = array(found.movie_results)[0]
      if (!match?.id) throw new Error('No TMDB movie match')
      const params = new URLSearchParams({ language: process.env.ARCHIVIST_CATALOGUE_LANGUAGE ?? 'en-US', include_image_language: 'en,null', append_to_response: 'release_dates,images,credits,videos,alternative_titles,external_ids,keywords,watch/providers,recommendations' })
      const detail = await fetch(tmdbUrl(`${tmdbApiBase()}/movie/${match.id}?${params}`), { headers: tmdbHeaders(), signal })
      if (!detail.ok) throw new Error(`movie HTTP ${detail.status}`)
      this.ingestMovie(await detail.json() as Json)
      return
    }
    if (entityType === 'series') {
      const match = array(found.tv_results)[0]
      if (!match?.id) throw new Error('No TMDB series match')
      const params = new URLSearchParams({ language: process.env.ARCHIVIST_CATALOGUE_LANGUAGE ?? 'en-US', include_image_language: 'en,null', append_to_response: 'aggregate_credits,images,external_ids,content_ratings,alternative_titles,videos,keywords,watch/providers' })
      const detail = await fetch(tmdbUrl(`${tmdbApiBase()}/tv/${match.id}?${params}`), { headers: tmdbHeaders(), signal })
      if (!detail.ok) throw new Error(`series HTTP ${detail.status}`)
      const series = await detail.json() as Json
      series._seasonDetails = []
      this.ingestSeries(series)
      return
    }
    throw new Error(`TMDB enrichment is not enabled for ${entityType}`)
  }

  private savePayload(source: string, entityType: string, sourceId: string, payload: Json): void {
    const json = JSON.stringify(payload)
    this.db.prepare(`INSERT INTO catalog_source_payloads(source,entity_type,source_id,payload_json,content_hash,fetched_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(source,entity_type,source_id) DO UPDATE SET payload_json=excluded.payload_json,content_hash=excluded.content_hash,fetched_at=CURRENT_TIMESTAMP`).run(source, entityType, sourceId, json, createHash('sha256').update(json).digest('hex'))
  }

  private async importDailyIds(runId: number, options: FlowOptions, signal: AbortSignal, progress: (value: Progress) => void): Promise<void> {
    const requested = options.date ? new Date(`${options.date}T12:00:00Z`) : new Date()
    const candidates = [requested, new Date(requested.getTime() - 86_400_000), new Date(requested.getTime() - 172_800_000)]
    const specs = [
      ['movie', 'movie_ids'], ['series', 'tv_series_ids'], ['person', 'person_ids'], ['collection', 'collection_ids'],
      ['company', 'production_company_ids'], ['keyword', 'keyword_ids'],
    ] as const
    let allProcessed = 0
    for (const [entityType, prefix] of specs) {
      if (signal.aborted) throw signal.reason
      let response: Response | null = null
      let usedDate: Date | null = null
      for (const candidate of candidates) {
        const url = `https://files.tmdb.org/p/exports/${prefix}_${exportName(candidate)}.json.gz`
        const attempt = await fetch(url, { signal })
        if (attempt.ok) { response = attempt; usedDate = candidate; break }
      }
      if (!response?.body || !usedDate) throw new Error(`No available daily export found for ${entityType}`)
      const snapshot = dateOnly(usedDate)
      progress({ step: `Importing ${entityType} IDs`, processed: allProcessed, total: null })
      this.log(runId, 'info', `Streaming ${entityType} export for ${snapshot}`)
      const input = Readable.fromWeb(response.body as any).pipe(createGunzip())
      const lines = createInterface({ input, crlfDelay: Infinity })
      const upsert = this.db.prepare(`
        INSERT INTO catalog_source_ids(entity_type,tmdb_id,adult,video,popularity,first_seen_date,last_seen_date,active)
        VALUES(?,?,?,?,?,?,?,1)
        ON CONFLICT(entity_type,tmdb_id) DO UPDATE SET adult=excluded.adult,video=excluded.video,
          popularity=excluded.popularity,last_seen_date=excluded.last_seen_date,active=1
      `)
      const queue = this.db.prepare(`
        INSERT INTO catalog_movie_queue(tmdb_id,reason,priority,status) VALUES(?,'new-daily-export',50,'pending')
        ON CONFLICT(tmdb_id) DO NOTHING
      `)
      const universalQueue = this.db.prepare(`INSERT INTO catalog_ingest_queue(source,entity_type,source_id,reason,priority,status)
        VALUES('tmdb',?,?,'new-daily-export',50,'pending') ON CONFLICT(source,entity_type,source_id) DO NOTHING`)
      const batch: Json[] = []
      let entityProcessed = 0
      const flush = this.db.transaction((rows: Json[]) => {
        for (const row of rows) {
          upsert.run(entityType, row.id, bool(row.adult), bool(row.video), numberOrNull(row.popularity), snapshot, snapshot)
          if (entityType === 'movie') queue.run(row.id)
          if (entityType === 'movie' || entityType === 'series') universalQueue.run(entityType, String(row.id))
        }
      })
      for await (const line of lines) {
        if (signal.aborted) throw signal.reason
        if (!line.trim()) continue
        try { batch.push(JSON.parse(line)) } catch { continue }
        if (batch.length >= 2000) {
          flush(batch.splice(0))
          entityProcessed += 2000
          allProcessed += 2000
          progress({ processed: allProcessed, succeeded: allProcessed, message: `${entityProcessed.toLocaleString()} ${entityType} IDs` })
        }
      }
      if (batch.length) {
        const remaining = batch.length
        flush(batch.splice(0))
        entityProcessed += remaining
        allProcessed += remaining
      }
      this.db.prepare(`UPDATE catalog_source_ids SET active=0 WHERE entity_type=? AND last_seen_date<?`).run(entityType, snapshot)
      this.log(runId, 'info', `Imported ${entityProcessed.toLocaleString()} ${entityType} IDs`)
    }
    this.db.prepare(`UPDATE catalog_metadata SET dataset_version=?,generated_at=?,imported_at=? WHERE dataset_id='archivist-catalogue'`)
      .run(dateOnly(candidates[0]), now(), now())
    progress({ processed: allProcessed, succeeded: allProcessed, message: `Imported ${allProcessed.toLocaleString()} source IDs` })
  }

  private async queueChangedMovies(runId: number, options: FlowOptions, signal: AbortSignal, progress: (value: Progress) => void): Promise<void> {
    requireTmdbToken()
    const end = options.date ?? dateOnly()
    const startDate = new Date(`${end}T12:00:00Z`)
    startDate.setUTCDate(startDate.getUTCDate() - 1)
    const start = dateOnly(startDate)
    let page = 1
    let totalPages = 1
    let processed = 0
    const queue = this.db.prepare(`
      INSERT INTO catalog_movie_queue(tmdb_id,reason,priority,status,available_at,done_at,last_error)
      VALUES(?,'tmdb-change-list',100,'pending',CURRENT_TIMESTAMP,NULL,NULL)
      ON CONFLICT(tmdb_id) DO UPDATE SET reason='tmdb-change-list',priority=100,status='pending',
        available_at=CURRENT_TIMESTAMP,done_at=NULL,last_error=NULL
    `)
    do {
      const url = `${tmdbApiBase()}/movie/changes?start_date=${start}&end_date=${end}&page=${page}`
      const response = await fetch(tmdbUrl(url), { headers: tmdbHeaders(), signal })
      if (!response.ok) throw new Error(`TMDB change list returned HTTP ${response.status}`)
      const payload = await response.json() as Json
      totalPages = Number(payload.total_pages ?? 1)
      const rows = array(payload.results)
      this.db.transaction(() => { for (const row of rows) queue.run(row.id) })()
      processed += rows.length
      progress({ step: `Change list page ${page}/${totalPages}`, processed, total: Number(payload.total_results ?? processed), succeeded: processed })
      page++
    } while (page <= totalPages)
    this.log(runId, 'info', `Queued ${processed} changed movies`, { start, end })
  }

  private async queueChangedSeries(runId: number, options: FlowOptions, signal: AbortSignal, progress: (value: Progress) => void): Promise<void> {
    requireTmdbToken()
    const end = options.date ?? dateOnly()
    const startDate = new Date(`${end}T12:00:00Z`)
    startDate.setUTCDate(startDate.getUTCDate() - 1)
    const start = dateOnly(startDate)
    let page = 1
    let totalPages = 1
    let processed = 0
    const queue = this.db.prepare(`INSERT INTO catalog_ingest_queue(source,entity_type,source_id,reason,priority,status,available_at,done_at,last_error)
      VALUES('tmdb','series',?,'tmdb-change-list',100,'pending',CURRENT_TIMESTAMP,NULL,NULL)
      ON CONFLICT(source,entity_type,source_id) DO UPDATE SET reason='tmdb-change-list',priority=100,status='pending',available_at=CURRENT_TIMESTAMP,done_at=NULL,last_error=NULL`)
    do {
      const response = await fetch(tmdbUrl(`${tmdbApiBase()}/tv/changes?start_date=${start}&end_date=${end}&page=${page}`), { headers: tmdbHeaders(), signal })
      if (!response.ok) throw new Error(`TMDB TV change list returned HTTP ${response.status}`)
      const payload = await response.json() as Json
      totalPages = Number(payload.total_pages ?? 1)
      const rows = array(payload.results)
      this.db.transaction(() => { for (const row of rows) queue.run(String(row.id)) })()
      processed += rows.length
      progress({ step: `TV change list page ${page}/${totalPages}`, processed, total: Number(payload.total_results ?? processed), succeeded: processed })
      page++
    } while (page <= totalPages)
    this.log(runId, 'info', `Queued ${processed} changed TV series`, { start, end })
  }

  private async hydrateSeries(runId: number, options: FlowOptions, signal: AbortSignal, progress: (value: Progress) => void): Promise<void> {
    requireTmdbToken()
    const limit = Math.max(1, Math.min(Number(options.limit ?? 25), 500))
    const rows = this.db.prepare(`SELECT queue_id,source_id FROM catalog_ingest_queue WHERE source='tmdb' AND entity_type='series' AND status IN ('pending','failed') AND available_at<=CURRENT_TIMESTAMP ORDER BY priority DESC,available_at,queue_id LIMIT ?`).all(limit) as Array<{ queue_id: number; source_id: string }>
    progress({ step: 'Hydrating TV series', processed: 0, total: rows.length, succeeded: 0, failed: 0 })
    let succeeded = 0
    let failed = 0
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      if (signal.aborted) throw signal.reason
      this.db.prepare(`UPDATE catalog_ingest_queue SET status='processing',locked_at=CURRENT_TIMESTAMP,attempts=attempts+1 WHERE queue_id=?`).run(row.queue_id)
      try {
        const params = new URLSearchParams({ language: process.env.ARCHIVIST_CATALOGUE_LANGUAGE ?? 'en-US', include_image_language: 'en,null', append_to_response: 'aggregate_credits,images,external_ids,content_ratings,alternative_titles,videos,keywords,watch/providers' })
        const response = await fetch(tmdbUrl(`${tmdbApiBase()}/tv/${row.source_id}?${params}`), { headers: tmdbHeaders(), signal })
        if (response.status === 404) {
          this.db.prepare(`UPDATE catalog_items SET deleted_at=CURRENT_TIMESTAMP,completeness_status='failed' WHERE source='tmdb' AND media_type='series' AND source_id=?`).run(row.source_id)
        } else {
          if (!response.ok) throw new Error(`TMDB TV series ${row.source_id} returned HTTP ${response.status}`)
          const series = await response.json() as Json
          const seasonDetails: Json[] = []
          for (const season of array(series.seasons)) {
            if (signal.aborted) throw signal.reason
            const seasonResponse = await fetch(tmdbUrl(`${tmdbApiBase()}/tv/${row.source_id}/season/${season.season_number}?language=${encodeURIComponent(process.env.ARCHIVIST_CATALOGUE_LANGUAGE ?? 'en-US')}`), { headers: tmdbHeaders(), signal })
            if (seasonResponse.ok) seasonDetails.push(await seasonResponse.json() as Json)
            await new Promise(resolve => setTimeout(resolve, 120))
          }
          series._seasonDetails = seasonDetails
          this.ingestSeries(series)
        }
        this.db.prepare(`UPDATE catalog_ingest_queue SET status='done',done_at=CURRENT_TIMESTAMP,locked_at=NULL,last_error=NULL WHERE queue_id=?`).run(row.queue_id)
        succeeded++
      } catch (error) {
        if (signal.aborted) throw signal.reason
        failed++
        const message = error instanceof Error ? error.message : String(error)
        this.db.prepare(`UPDATE catalog_ingest_queue SET status='failed',locked_at=NULL,last_error=?,available_at=datetime('now','+30 minutes') WHERE queue_id=?`).run(message, row.queue_id)
        this.log(runId, 'error', message, { tmdbId: row.source_id, entityType: 'series' })
      }
      progress({ processed: index + 1, total: rows.length, succeeded, failed, message: `Series ${row.source_id}` })
      if (index + 1 < rows.length) await new Promise(resolve => setTimeout(resolve, 260))
    }
  }

  private async hydrateMovies(runId: number, options: FlowOptions, signal: AbortSignal, progress: (value: Progress) => void): Promise<void> {
    requireTmdbToken()
    const limit = Math.max(1, Math.min(Number(options.limit ?? 100), 5000))
    const rows = this.db.prepare(`SELECT tmdb_id FROM catalog_movie_queue WHERE status IN ('pending','failed') AND available_at<=CURRENT_TIMESTAMP ORDER BY priority DESC,available_at,tmdb_id LIMIT ?`).all(limit) as Array<{ tmdb_id: number }>
    progress({ step: 'Hydrating movies', processed: 0, total: rows.length, succeeded: 0, failed: 0 })
    let succeeded = 0
    let failed = 0
    for (let index = 0; index < rows.length; index++) {
      if (signal.aborted) throw signal.reason
      const tmdbId = rows[index].tmdb_id
      this.db.prepare(`UPDATE catalog_movie_queue SET status='processing',locked_at=CURRENT_TIMESTAMP,attempts=attempts+1 WHERE tmdb_id=?`).run(tmdbId)
      try {
        const params = new URLSearchParams({
          language: process.env.ARCHIVIST_CATALOGUE_LANGUAGE ?? 'en-US',
          include_image_language: 'en,null',
          append_to_response: 'release_dates,images,credits,videos,alternative_titles,external_ids,keywords,watch/providers,recommendations',
        })
        const response = await fetch(tmdbUrl(`${tmdbApiBase()}/movie/${tmdbId}?${params}`), { headers: tmdbHeaders(), signal })
        if (response.status === 404) {
          this.db.prepare(`UPDATE catalog_movie_queue SET status='done',done_at=CURRENT_TIMESTAMP,last_error='TMDB 404' WHERE tmdb_id=?`).run(tmdbId)
          this.db.prepare(`UPDATE catalog_films SET deleted_at=CURRENT_TIMESTAMP WHERE legacy_tmdb_id=?`).run(tmdbId)
          succeeded++
        } else {
          if (!response.ok) throw new Error(`TMDB movie ${tmdbId} returned HTTP ${response.status}`)
          const movie = await response.json() as Json
          this.ingestMovie(movie)
          this.db.prepare(`UPDATE catalog_movie_queue SET status='done',done_at=CURRENT_TIMESTAMP,locked_at=NULL,last_error=NULL WHERE tmdb_id=?`).run(tmdbId)
          succeeded++
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason
        failed++
        const message = error instanceof Error ? error.message : String(error)
        this.db.prepare(`UPDATE catalog_movie_queue SET status='failed',locked_at=NULL,last_error=?,available_at=datetime('now','+30 minutes') WHERE tmdb_id=?`).run(message, tmdbId)
        this.log(runId, 'error', message, { tmdbId })
      }
      progress({ processed: index + 1, total: rows.length, succeeded, failed, message: `Movie ${tmdbId}` })
      if (index + 1 < rows.length) await new Promise(resolve => setTimeout(resolve, 260))
    }
  }

  private ingestMovie(movie: Json): void {
    this.db.transaction(() => {
      let collectionId: number | null = null
      if (movie.belongs_to_collection?.id) {
        this.db.prepare(`INSERT INTO catalog_collections(legacy_tmdb_id,name,overview,metadata_updated_at,deleted_at) VALUES(?,?,?,CURRENT_TIMESTAMP,NULL)
          ON CONFLICT(legacy_tmdb_id) DO UPDATE SET name=excluded.name,overview=COALESCE(excluded.overview,catalog_collections.overview),metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL`)
          .run(movie.belongs_to_collection.id, movie.belongs_to_collection.name, textOrNull(movie.belongs_to_collection.overview))
        collectionId = (this.db.prepare('SELECT collection_id FROM catalog_collections WHERE legacy_tmdb_id=?').get(movie.belongs_to_collection.id) as Json).collection_id
      }
      const companies = array(movie.production_companies)
      for (const company of companies) {
        this.db.prepare(`INSERT INTO catalog_companies(legacy_tmdb_id,name,normalized_name,origin_country,metadata_updated_at,deleted_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP,NULL)
          ON CONFLICT(legacy_tmdb_id) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name,origin_country=excluded.origin_country,metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL`)
          .run(company.id, company.name, normalize(company.name), textOrNull(company.origin_country))
      }
      const primaryCompanyId = companies[0]?.id
        ? (this.db.prepare('SELECT company_id FROM catalog_companies WHERE legacy_tmdb_id=?').get(companies[0].id) as Json)?.company_id ?? null
        : null
      const releaseDate = textOrNull(movie.release_date)
      this.db.prepare(`
        INSERT INTO catalog_films(legacy_tmdb_id,imdb_id,title,original_title,sort_title,original_language,overview,tagline,
          runtime_minutes,primary_release_date,release_year,adult,video,release_status,popularity,vote_average,vote_count,
          budget,revenue,homepage,collection_id,primary_studio_company_id,primary_country_code,metadata_updated_at,deleted_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,NULL)
        ON CONFLICT(legacy_tmdb_id) DO UPDATE SET imdb_id=excluded.imdb_id,title=excluded.title,original_title=excluded.original_title,
          sort_title=excluded.sort_title,original_language=excluded.original_language,overview=excluded.overview,tagline=excluded.tagline,
          runtime_minutes=excluded.runtime_minutes,primary_release_date=excluded.primary_release_date,release_year=excluded.release_year,
          adult=excluded.adult,video=excluded.video,release_status=excluded.release_status,popularity=excluded.popularity,
          vote_average=excluded.vote_average,vote_count=excluded.vote_count,budget=excluded.budget,revenue=excluded.revenue,
          homepage=excluded.homepage,collection_id=excluded.collection_id,primary_studio_company_id=excluded.primary_studio_company_id,
          primary_country_code=excluded.primary_country_code,metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL
      `).run(
        movie.id, textOrNull(movie.imdb_id ?? movie.external_ids?.imdb_id), movie.title, textOrNull(movie.original_title), movie.title,
        textOrNull(movie.original_language), textOrNull(movie.overview), textOrNull(movie.tagline), numberOrNull(movie.runtime),
        releaseDate, releaseDate ? Number(releaseDate.slice(0, 4)) : null, bool(movie.adult), bool(movie.video), textOrNull(movie.status),
        numberOrNull(movie.popularity), numberOrNull(movie.vote_average), numberOrNull(movie.vote_count), numberOrNull(movie.budget),
        numberOrNull(movie.revenue), textOrNull(movie.homepage), collectionId, primaryCompanyId,
        textOrNull(array(movie.production_countries)[0]?.iso_3166_1),
      )
      const filmId = (this.db.prepare('SELECT film_id FROM catalog_films WHERE legacy_tmdb_id=?').get(movie.id) as Json).film_id as number

      const replace = (table: string) => this.db.prepare(`DELETE FROM ${table} WHERE film_id=?`).run(filmId)
      for (const table of ['catalog_external_ids','catalog_film_genres','catalog_film_countries','catalog_film_companies','catalog_film_cast','catalog_film_crew','catalog_release_events','catalog_alternative_titles','catalog_videos','catalog_film_keywords','catalog_film_watch_availability','catalog_film_recommendations']) replace(table)

      const externalIds = { imdb: movie.imdb_id ?? movie.external_ids?.imdb_id, wikidata: movie.external_ids?.wikidata_id, facebook: movie.external_ids?.facebook_id, instagram: movie.external_ids?.instagram_id, twitter: movie.external_ids?.twitter_id }
      for (const [type, id] of Object.entries(externalIds)) if (textOrNull(id)) this.db.prepare(`INSERT OR IGNORE INTO catalog_external_ids(film_id,id_type,external_id,is_primary,verified_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)`).run(filmId, type, id, type === 'imdb' ? 1 : 0)

      array(movie.genres).forEach((genre, order) => {
        this.db.prepare(`INSERT INTO catalog_genres(genre_id,name,normalized_name,sort_order,active) VALUES(?,?,?,?,1) ON CONFLICT(genre_id) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name,active=1`).run(genre.id, genre.name, normalize(genre.name), order)
        this.db.prepare(`INSERT INTO catalog_film_genres(film_id,genre_id,billing_order) VALUES(?,?,?)`).run(filmId, genre.id, order)
      })
      array(movie.production_countries).forEach((country, order) => {
        this.db.prepare(`INSERT INTO catalog_countries(country_code,name) VALUES(?,?) ON CONFLICT(country_code) DO UPDATE SET name=excluded.name`).run(country.iso_3166_1, country.name || country.iso_3166_1)
        this.db.prepare(`INSERT INTO catalog_film_countries(film_id,country_code,billing_order,is_primary) VALUES(?,?,?,?)`).run(filmId, country.iso_3166_1, order, order === 0 ? 1 : 0)
      })
      companies.forEach((company, order) => {
        const companyId = (this.db.prepare('SELECT company_id FROM catalog_companies WHERE legacy_tmdb_id=?').get(company.id) as Json).company_id
        this.db.prepare(`INSERT INTO catalog_film_companies(film_id,company_id,company_role,billing_order,is_primary_studio) VALUES(?,?,'production',?,?)`).run(filmId, companyId, order, order === 0 ? 1 : 0)
      })

      const upsertPerson = (person: Json): number => {
        const personId = upsertPersonIdentity(this.db, { source: 'tmdb', externalId: String(person.id), name: person.name, originalName: textOrNull(person.original_name) })
        this.db.prepare(`UPDATE catalog_people SET legacy_tmdb_id=?,known_for_department=COALESCE(?,known_for_department),adult=?,popularity=COALESCE(?,popularity),metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL WHERE person_id=?`)
          .run(person.id, textOrNull(person.known_for_department), bool(person.adult), numberOrNull(person.popularity), personId)
        if (person.profile_path) this.upsertArtwork('person', personId, 'profile', person.profile_path, {}, 0, true)
        return personId
      }
      array(movie.credits?.cast).forEach((credit, order) => {
        const personId = upsertPerson(credit)
        this.db.prepare(`INSERT INTO catalog_film_cast(film_id,person_id,credit_id,character_name,billing_order,cast_id,department) VALUES(?,?,?,?,?,?,?)`)
          .run(filmId, personId, textOrNull(credit.credit_id), textOrNull(credit.character), Number(credit.order ?? order), numberOrNull(credit.cast_id), textOrNull(credit.known_for_department))
      })
      array(movie.credits?.crew).forEach((credit, order) => {
        const personId = upsertPerson(credit)
        const role = (this.db.prepare('SELECT normalized_job FROM catalog_role_aliases WHERE raw_job=?').get(credit.job) as Json | undefined)?.normalized_job ?? normalize(credit.job)
        this.db.prepare(`INSERT INTO catalog_film_crew(film_id,person_id,credit_id,department,job,normalized_role,billing_order) VALUES(?,?,?,?,?,?,?)`)
          .run(filmId, personId, textOrNull(credit.credit_id), textOrNull(credit.department), credit.job || 'Unknown', role, order)
      })

      array(movie.release_dates?.results).forEach(result => array(result.release_dates).forEach((event, order) => {
        this.db.prepare(`INSERT OR IGNORE INTO catalog_release_events(film_id,country_code,release_date,release_type,certification,note,language_code,is_primary) VALUES(?,?,?,?,?,?,?,?)`)
          .run(filmId, result.iso_3166_1, event.release_date, event.type, textOrNull(event.certification), textOrNull(event.note), textOrNull(event.iso_639_1), order === 0 ? 1 : 0)
      }))
      array(movie.alternative_titles?.titles).forEach((title, order) => this.db.prepare(`INSERT OR IGNORE INTO catalog_alternative_titles(film_id,country_code,title,title_type,billing_order) VALUES(?,?,?,?,?)`).run(filmId, textOrNull(title.iso_3166_1), title.title, textOrNull(title.type), order))
      array(movie.videos?.results).forEach((video, order) => this.db.prepare(`INSERT OR IGNORE INTO catalog_videos(film_id,legacy_tmdb_key,site,video_key,name,video_type,official,published_at,language_code,country_code,size,billing_order,is_selected) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(filmId, textOrNull(video.id), video.site, video.key, textOrNull(video.name), textOrNull(video.type), bool(video.official), textOrNull(video.published_at), textOrNull(video.iso_639_1), textOrNull(video.iso_3166_1), numberOrNull(video.size), order, video.site === 'YouTube' && video.type === 'Trailer' && order === 0 ? 1 : 0))
      const keywords = array(movie.keywords?.keywords ?? movie.keywords?.results)
      keywords.forEach((keyword, order) => {
        this.db.prepare(`INSERT INTO catalog_keywords(keyword_id,name,normalized_name) VALUES(?,?,?) ON CONFLICT(keyword_id) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name`).run(keyword.id, keyword.name, normalize(keyword.name))
        this.db.prepare(`INSERT INTO catalog_film_keywords(film_id,keyword_id,billing_order) VALUES(?,?,?)`).run(filmId, keyword.id, order)
      })

      const images = movie.images ?? {}
      for (const [type, sourceRows] of Object.entries({ poster: images.posters, backdrop: images.backdrops, logo: images.logos })) {
        array(sourceRows).forEach((image, order) => this.upsertArtwork('film', filmId, type, image.file_path, image, order, order === 0))
      }
      if (!array(images.posters).length && movie.poster_path) this.upsertArtwork('film', filmId, 'poster', movie.poster_path, {}, 0, true)
      if (!array(images.backdrops).length && movie.backdrop_path) this.upsertArtwork('film', filmId, 'backdrop', movie.backdrop_path, {}, 0, true)

      const providerResults = movie['watch/providers']?.results ?? {}
      for (const [countryCode, availability] of Object.entries(providerResults as Json)) {
        for (const monetization of ['flatrate','rent','buy','free','ads']) {
          array((availability as Json)[monetization]).forEach(provider => {
            this.db.prepare(`INSERT INTO catalog_watch_providers(legacy_tmdb_id,name,normalized_name,global_display_priority,active,metadata_updated_at) VALUES(?,?,?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(legacy_tmdb_id) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name,global_display_priority=excluded.global_display_priority,active=1,metadata_updated_at=CURRENT_TIMESTAMP`).run(provider.provider_id, provider.provider_name, normalize(provider.provider_name), numberOrNull(provider.display_priority))
            const providerId = (this.db.prepare('SELECT provider_id FROM catalog_watch_providers WHERE legacy_tmdb_id=?').get(provider.provider_id) as Json).provider_id
            this.db.prepare(`INSERT INTO catalog_film_watch_availability(film_id,provider_id,country_code,monetization_type,display_priority,link,observed_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)`).run(filmId, providerId, countryCode, monetization, numberOrNull(provider.display_priority), textOrNull((availability as Json).link))
          })
        }
      }
      array(movie.recommendations?.results).forEach((recommended, order) => {
        const known = this.db.prepare('SELECT film_id FROM catalog_films WHERE legacy_tmdb_id=?').get(recommended.id) as Json | undefined
        if (known) this.db.prepare(`INSERT INTO catalog_film_recommendations(film_id,recommended_film_id,source,score,billing_order) VALUES(?,?,'tmdb',?,?)`).run(filmId, known.film_id, numberOrNull(recommended.popularity), order)
        else this.db.prepare(`INSERT INTO catalog_movie_queue(tmdb_id,reason,priority,status) VALUES(?,'recommendation',10,'pending') ON CONFLICT(tmdb_id) DO NOTHING`).run(recommended.id)
      })

      this.syncUniversalMovie(movie, filmId)
      this.db.prepare(`INSERT INTO catalog_sync_state(entity_type,entity_id,source,last_checked_at,last_success_at,content_hash,status,error_count,last_error) VALUES('movie',?,'tmdb',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,'current',0,NULL) ON CONFLICT(entity_type,entity_id,source) DO UPDATE SET last_checked_at=CURRENT_TIMESTAMP,last_success_at=CURRENT_TIMESTAMP,content_hash=excluded.content_hash,status='current',error_count=0,last_error=NULL`).run(String(movie.id), createHash('sha256').update(JSON.stringify(movie)).digest('hex'))
      this.refreshFilmFts(filmId)
    })()
  }

  private syncUniversalMovie(movie: Json, legacyFilmId: number): number {
    const releaseDate = textOrNull(movie.release_date)
    const hasArtwork = Boolean(movie.poster_path || array(movie.images?.posters).length)
    const imdbId = textOrNull(movie.imdb_id ?? movie.external_ids?.imdb_id)
    const imdbItem = imdbId ? this.db.prepare(`SELECT item_id FROM catalog_item_external_ids WHERE source='imdb' AND external_id=?`).get(imdbId) as Json | undefined : undefined
    let itemId: number
    if (imdbItem) {
      itemId = Number(imdbItem.item_id)
      this.db.prepare(`UPDATE catalog_items SET canonical_title=?,original_title=?,sort_title=?,description=COALESCE(NULLIF(?,''),description),original_language=COALESCE(?,original_language),first_release_date=COALESCE(?,first_release_date),release_year=COALESCE(?,release_year),status=COALESCE(?,status),adult=?,popularity=COALESCE(?,popularity),rating=COALESCE(?,rating),rating_count=COALESCE(?,rating_count),completeness_status='partial',completeness_score=?,metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL WHERE item_id=?`).run(movie.title, textOrNull(movie.original_title), movie.title, textOrNull(movie.overview), textOrNull(movie.original_language), releaseDate, releaseDate ? Number(releaseDate.slice(0, 4)) : null, textOrNull(movie.status), bool(movie.adult), numberOrNull(movie.popularity), numberOrNull(movie.vote_average), numberOrNull(movie.vote_count), movie.overview && hasArtwork ? 0.75 : 0.65, itemId)
    } else {
      this.db.prepare(`INSERT INTO catalog_items(media_type,source,source_id,canonical_title,original_title,sort_title,description,original_language,first_release_date,release_year,status,adult,popularity,rating,rating_count,completeness_status,completeness_score,metadata_updated_at,deleted_at)
        VALUES('film','tmdb',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,NULL)
        ON CONFLICT(source,source_id,media_type) DO UPDATE SET canonical_title=excluded.canonical_title,original_title=excluded.original_title,sort_title=excluded.sort_title,description=excluded.description,original_language=excluded.original_language,first_release_date=excluded.first_release_date,release_year=excluded.release_year,status=excluded.status,adult=excluded.adult,popularity=excluded.popularity,rating=excluded.rating,rating_count=excluded.rating_count,completeness_status=excluded.completeness_status,completeness_score=excluded.completeness_score,metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL`)
        .run(String(movie.id), movie.title, textOrNull(movie.original_title), movie.title, textOrNull(movie.overview), textOrNull(movie.original_language), releaseDate, releaseDate ? Number(releaseDate.slice(0, 4)) : null, textOrNull(movie.status), bool(movie.adult), numberOrNull(movie.popularity), numberOrNull(movie.vote_average), numberOrNull(movie.vote_count), 'partial', movie.overview && hasArtwork ? 0.75 : 0.65)
      itemId = Number((this.db.prepare(`SELECT item_id FROM catalog_items WHERE source='tmdb' AND source_id=? AND media_type='film'`).get(String(movie.id)) as Json).item_id)
    }
    this.db.prepare(`INSERT INTO catalog_film_details(item_id,legacy_film_id,runtime_minutes,tagline,budget,revenue,collection_source_id,homepage,video) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET legacy_film_id=excluded.legacy_film_id,runtime_minutes=excluded.runtime_minutes,tagline=excluded.tagline,budget=excluded.budget,revenue=excluded.revenue,collection_source_id=excluded.collection_source_id,homepage=excluded.homepage,video=excluded.video`)
      .run(itemId, legacyFilmId, numberOrNull(movie.runtime), textOrNull(movie.tagline), numberOrNull(movie.budget), numberOrNull(movie.revenue), movie.belongs_to_collection?.id ? String(movie.belongs_to_collection.id) : null, textOrNull(movie.homepage), bool(movie.video))

    this.db.prepare(`DELETE FROM catalog_item_external_ids WHERE item_id=? AND source='tmdb'`).run(itemId)
    this.db.prepare(`DELETE FROM catalog_item_titles WHERE item_id=? AND source='tmdb'`).run(itemId)
    this.db.prepare(`DELETE FROM catalog_item_genres WHERE item_id=?`).run(itemId)
    this.db.prepare(`DELETE FROM catalog_item_organisations WHERE item_id=?`).run(itemId)
    this.db.prepare(`DELETE FROM catalog_credits WHERE item_id=? AND source='tmdb'`).run(itemId)
    const externalIds = { tmdb: movie.id, imdb: movie.imdb_id ?? movie.external_ids?.imdb_id, wikidata: movie.external_ids?.wikidata_id }
    for (const [source, id] of Object.entries(externalIds)) if (id != null && String(id).trim()) this.db.prepare(`INSERT OR IGNORE INTO catalog_item_external_ids(item_id,source,external_id,is_primary,verified_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)`).run(itemId, source, String(id), source === (imdbId ? 'imdb' : 'tmdb') ? 1 : 0)
    array(movie.alternative_titles?.titles).forEach((title, order) => this.db.prepare(`INSERT OR IGNORE INTO catalog_item_titles(item_id,title,normalized_title,title_type,country_code,source,billing_order) VALUES(?,?,?,'alternative',?,'tmdb',?)`).run(itemId, title.title, normalize(title.title), textOrNull(title.iso_3166_1), order))
    array(movie.genres).forEach((genre, order) => this.db.prepare(`INSERT OR IGNORE INTO catalog_item_genres(item_id,genre_id,billing_order) VALUES(?,?,?)`).run(itemId, genre.id, order))

    array(movie.production_companies).forEach((company, order) => {
      const organisationId = upsertOrganisationIdentity(this.db, { source: 'tmdb', externalId: String(company.id), name: company.name, organisationType: 'production_company', countryCode: textOrNull(company.origin_country) })
      this.db.prepare(`INSERT OR IGNORE INTO catalog_item_organisations(item_id,organisation_id,role,billing_order,is_primary) VALUES(?,?,'production',?,?)`).run(itemId, organisationId, order, order === 0 ? 1 : 0)
    })
    const addCredit = (credit: Json, order: number, creditType: 'cast' | 'crew') => {
      const personId = upsertPersonIdentity(this.db, { source: 'tmdb', externalId: String(credit.id), name: credit.name, originalName: textOrNull(credit.original_name) })
      this.db.prepare(`UPDATE catalog_people SET legacy_tmdb_id=COALESCE(legacy_tmdb_id,?),known_for_department=COALESCE(?,known_for_department),adult=?,popularity=COALESCE(?,popularity) WHERE person_id=?`).run(credit.id, textOrNull(credit.known_for_department), bool(credit.adult), numberOrNull(credit.popularity), personId)
      const role = creditType === 'cast' ? 'actor' : ((this.db.prepare('SELECT normalized_job FROM catalog_role_aliases WHERE raw_job=?').get(credit.job) as Json | undefined)?.normalized_job ?? normalize(credit.job))
      this.db.prepare(`INSERT OR IGNORE INTO catalog_credits(item_id,person_id,credit_type,role,raw_role,character_name,credited_as,department,billing_order,source,source_credit_id,is_primary) VALUES(?,?,?,?,?,?,?,?,?,'tmdb',?,?)`)
        .run(itemId, personId, creditType, role, creditType === 'cast' ? 'actor' : textOrNull(credit.job), textOrNull(credit.character), textOrNull(credit.name), textOrNull(credit.department ?? credit.known_for_department), Number(credit.order ?? order), textOrNull(credit.credit_id), creditType === 'cast' ? bool(Number(credit.order ?? order) < 5) : bool(role === 'director'))
      if (credit.profile_path) this.upsertArtwork('person', personId, 'profile', credit.profile_path, {}, 0, true)
    }
    array(movie.credits?.cast).forEach((credit, order) => addCredit(credit, order, 'cast'))
    array(movie.credits?.crew).forEach((credit, order) => addCredit(credit, order, 'crew'))

    const images = movie.images ?? {}
    for (const [type, rows] of Object.entries({ poster: images.posters, backdrop: images.backdrops, logo: images.logos })) array(rows).forEach((image, order) => this.upsertArtwork('item', itemId, type, image.file_path, image, order, order === 0))
    if (!array(images.posters).length && movie.poster_path) this.upsertArtwork('item', itemId, 'poster', movie.poster_path, {}, 0, true)
    if (!array(images.backdrops).length && movie.backdrop_path) this.upsertArtwork('item', itemId, 'backdrop', movie.backdrop_path, {}, 0, true)
    this.db.prepare(`INSERT INTO catalog_source_payloads(source,entity_type,source_id,payload_json,content_hash,fetched_at) VALUES('tmdb','film',?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(source,entity_type,source_id) DO UPDATE SET payload_json=excluded.payload_json,content_hash=excluded.content_hash,fetched_at=CURRENT_TIMESTAMP`)
      .run(String(movie.id), JSON.stringify(movie), createHash('sha256').update(JSON.stringify(movie)).digest('hex'))
    this.refreshItemFts(itemId)
    return itemId
  }

  private ingestSeries(series: Json): void {
    this.db.transaction(() => {
      const releaseDate = textOrNull(series.first_air_date)
      const hasArtwork = Boolean(series.poster_path || array(series.images?.posters).length)
      const imdbId = textOrNull(series.external_ids?.imdb_id)
      const imdbItem = imdbId ? this.db.prepare(`SELECT item_id FROM catalog_item_external_ids WHERE source='imdb' AND external_id=?`).get(imdbId) as Json | undefined : undefined
      let itemId: number
      if (imdbItem) {
        itemId = Number(imdbItem.item_id)
        this.db.prepare(`UPDATE catalog_items SET canonical_title=?,original_title=?,sort_title=?,description=COALESCE(NULLIF(?,''),description),original_language=COALESCE(?,original_language),first_release_date=COALESCE(?,first_release_date),release_year=COALESCE(?,release_year),status=COALESCE(?,status),adult=?,popularity=COALESCE(?,popularity),rating=COALESCE(?,rating),rating_count=COALESCE(?,rating_count),completeness_status='partial',completeness_score=?,metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL WHERE item_id=?`).run(series.name, textOrNull(series.original_name), series.name, textOrNull(series.overview), textOrNull(series.original_language), releaseDate, releaseDate ? Number(releaseDate.slice(0, 4)) : null, textOrNull(series.status), bool(series.adult), numberOrNull(series.popularity), numberOrNull(series.vote_average), numberOrNull(series.vote_count), series.overview && hasArtwork ? 0.75 : 0.7, itemId)
      } else {
        this.db.prepare(`INSERT INTO catalog_items(media_type,source,source_id,canonical_title,original_title,sort_title,description,original_language,first_release_date,release_year,status,adult,popularity,rating,rating_count,completeness_status,completeness_score,metadata_updated_at,deleted_at)
          VALUES('series','tmdb',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,NULL)
          ON CONFLICT(source,source_id,media_type) DO UPDATE SET canonical_title=excluded.canonical_title,original_title=excluded.original_title,sort_title=excluded.sort_title,description=excluded.description,original_language=excluded.original_language,first_release_date=excluded.first_release_date,release_year=excluded.release_year,status=excluded.status,adult=excluded.adult,popularity=excluded.popularity,rating=excluded.rating,rating_count=excluded.rating_count,completeness_status=excluded.completeness_status,completeness_score=excluded.completeness_score,metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL`)
          .run(String(series.id), series.name, textOrNull(series.original_name), series.name, textOrNull(series.overview), textOrNull(series.original_language), releaseDate, releaseDate ? Number(releaseDate.slice(0, 4)) : null, textOrNull(series.status), bool(series.adult), numberOrNull(series.popularity), numberOrNull(series.vote_average), numberOrNull(series.vote_count), 'partial', series.overview && hasArtwork ? 0.75 : 0.7)
        itemId = Number((this.db.prepare(`SELECT item_id FROM catalog_items WHERE source='tmdb' AND source_id=? AND media_type='series'`).get(String(series.id)) as Json).item_id)
      }
      this.db.prepare(`INSERT INTO catalog_series_details(item_id,series_type,tagline,homepage,episode_runtime_minutes,number_of_seasons,number_of_episodes,in_production,last_air_date,next_air_date) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET series_type=excluded.series_type,tagline=excluded.tagline,homepage=excluded.homepage,episode_runtime_minutes=excluded.episode_runtime_minutes,number_of_seasons=excluded.number_of_seasons,number_of_episodes=excluded.number_of_episodes,in_production=excluded.in_production,last_air_date=excluded.last_air_date,next_air_date=excluded.next_air_date`)
        .run(itemId, textOrNull(series.type), textOrNull(series.tagline), textOrNull(series.homepage), numberOrNull(array(series.episode_run_time)[0]), numberOrNull(series.number_of_seasons), numberOrNull(series.number_of_episodes), bool(series.in_production), textOrNull(series.last_air_date), textOrNull(series.next_episode_to_air?.air_date))
      this.db.prepare(`DELETE FROM catalog_item_external_ids WHERE item_id=? AND source='tmdb'`).run(itemId)
      this.db.prepare(`DELETE FROM catalog_item_titles WHERE item_id=? AND source='tmdb'`).run(itemId)
      this.db.prepare(`DELETE FROM catalog_item_genres WHERE item_id=?`).run(itemId)
      this.db.prepare(`DELETE FROM catalog_item_organisations WHERE item_id=?`).run(itemId)
      this.db.prepare(`DELETE FROM catalog_credits WHERE item_id=? AND source='tmdb'`).run(itemId)
      const ids = { tmdb: series.id, imdb: series.external_ids?.imdb_id, tvdb: series.external_ids?.tvdb_id, wikidata: series.external_ids?.wikidata_id }
      for (const [source, id] of Object.entries(ids)) if (id != null && String(id).trim()) this.db.prepare(`INSERT OR IGNORE INTO catalog_item_external_ids(item_id,source,external_id,is_primary,verified_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)`).run(itemId, source, String(id), source === (imdbId ? 'imdb' : 'tmdb') ? 1 : 0)
      array(series.alternative_titles?.results).forEach((title, order) => this.db.prepare(`INSERT OR IGNORE INTO catalog_item_titles(item_id,title,normalized_title,title_type,country_code,source,billing_order) VALUES(?,?,?,'alternative',?,'tmdb',?)`).run(itemId, title.title, normalize(title.title), textOrNull(title.iso_3166_1), order))
      array(series.genres).forEach((genre, order) => {
        this.db.prepare(`INSERT INTO catalog_genres(genre_id,name,normalized_name,sort_order,active) VALUES(?,?,?,?,1) ON CONFLICT(genre_id) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name,active=1`).run(genre.id, genre.name, normalize(genre.name), order)
        this.db.prepare(`INSERT OR IGNORE INTO catalog_item_genres(item_id,genre_id,billing_order) VALUES(?,?,?)`).run(itemId, genre.id, order)
      })
      for (const [role, organisations] of [['production', array(series.production_companies)], ['network', array(series.networks)]] as const) organisations.forEach((organisation, order) => {
        const organisationId = upsertOrganisationIdentity(this.db, { source: 'tmdb', externalId: String(organisation.id), name: organisation.name, organisationType: role, countryCode: textOrNull(organisation.origin_country) })
        this.db.prepare(`INSERT OR IGNORE INTO catalog_item_organisations(item_id,organisation_id,role,billing_order,is_primary) VALUES(?,?,?,?,?)`).run(itemId, organisationId, role, order, order === 0 ? 1 : 0)
      })
      const addCredit = (credit: Json, order: number, type: 'cast' | 'crew', role: string, character?: string) => {
        const personId = upsertPersonIdentity(this.db, { source: 'tmdb', externalId: String(credit.id), name: credit.name, originalName: textOrNull(credit.original_name) })
        this.db.prepare(`UPDATE catalog_people SET legacy_tmdb_id=COALESCE(legacy_tmdb_id,?),known_for_department=COALESCE(?,known_for_department),popularity=COALESCE(?,popularity) WHERE person_id=?`).run(credit.id, textOrNull(credit.known_for_department), numberOrNull(credit.popularity), personId)
        this.db.prepare(`INSERT OR IGNORE INTO catalog_credits(item_id,person_id,credit_type,role,raw_role,character_name,credited_as,department,billing_order,source,source_credit_id,is_primary) VALUES(?,?,?,?,?,?,?,?,?,'tmdb',?,?)`).run(itemId, personId, type, role, role, textOrNull(character), credit.name, textOrNull(credit.department ?? credit.known_for_department), order, textOrNull(credit.credit_id), type === 'cast' ? bool(order < 5) : bool(role === 'director' || role === 'creator'))
        if (credit.profile_path) this.upsertArtwork('person', personId, 'profile', credit.profile_path, {}, 0, true)
      }
      array(series.created_by).forEach((credit, order) => addCredit(credit, order, 'crew', 'creator'))
      array(series.aggregate_credits?.cast).forEach((credit, order) => addCredit(credit, order, 'cast', 'actor', array(credit.roles)[0]?.character))
      array(series.aggregate_credits?.crew).forEach((credit, order) => {
        const job = array(credit.jobs)[0]
        addCredit({ ...credit, department: credit.department, credit_id: job?.credit_id }, order, 'crew', normalize(job?.job ?? credit.department ?? 'crew'))
      })
      const images = series.images ?? {}
      for (const [type, rows] of Object.entries({ poster: images.posters, backdrop: images.backdrops, logo: images.logos })) array(rows).forEach((image, order) => this.upsertArtwork('item', itemId, type, image.file_path, image, order, order === 0))
      if (!array(images.posters).length && series.poster_path) this.upsertArtwork('item', itemId, 'poster', series.poster_path, {}, 0, true)
      if (!array(images.backdrops).length && series.backdrop_path) this.upsertArtwork('item', itemId, 'backdrop', series.backdrop_path, {}, 0, true)

      for (const season of array(series._seasonDetails).length ? array(series._seasonDetails) : array(series.seasons)) {
        const seasonSourceId = `${series.id}:season:${season.season_number}`
        this.upsertChildItem('season', seasonSourceId, season.name || `Season ${season.season_number}`, season.overview, season.air_date, season.poster_path, itemId, season)
      }
      this.db.prepare(`INSERT INTO catalog_source_payloads(source,entity_type,source_id,payload_json,content_hash,fetched_at) VALUES('tmdb','series',?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(source,entity_type,source_id) DO UPDATE SET payload_json=excluded.payload_json,content_hash=excluded.content_hash,fetched_at=CURRENT_TIMESTAMP`).run(String(series.id), JSON.stringify(series), createHash('sha256').update(JSON.stringify(series)).digest('hex'))
      this.refreshItemFts(itemId)
    })()
  }

  private upsertChildItem(type: 'season' | 'episode', sourceId: string, title: string, overview: unknown, releaseDateValue: unknown, posterPath: unknown, seriesItemId: number, data: Json, seasonItemId?: number): number {
    const releaseDate = textOrNull(releaseDateValue)
    this.db.prepare(`INSERT INTO catalog_items(media_type,source,source_id,canonical_title,sort_title,description,first_release_date,release_year,completeness_status,completeness_score,metadata_updated_at,deleted_at) VALUES(?,'tmdb',?,?,?,?,?,?,'complete',1,CURRENT_TIMESTAMP,NULL) ON CONFLICT(source,source_id,media_type) DO UPDATE SET canonical_title=excluded.canonical_title,sort_title=excluded.sort_title,description=excluded.description,first_release_date=excluded.first_release_date,release_year=excluded.release_year,completeness_status='complete',completeness_score=1,metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL`)
      .run(type, sourceId, title, title, textOrNull(overview), releaseDate, releaseDate ? Number(releaseDate.slice(0, 4)) : null)
    const itemId = (this.db.prepare(`SELECT item_id FROM catalog_items WHERE source='tmdb' AND source_id=? AND media_type=?`).get(sourceId, type) as Json).item_id as number
    if (type === 'season') {
      this.db.prepare(`INSERT INTO catalog_seasons(item_id,series_item_id,season_number,episode_count,air_date) VALUES(?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET episode_count=excluded.episode_count,air_date=excluded.air_date`).run(itemId, seriesItemId, data.season_number, numberOrNull(data.episode_count ?? array(data.episodes).length), releaseDate)
      array(data.episodes).forEach(episode => this.upsertChildItem('episode', `${String(data.show_id ?? '').trim() || sourceId.split(':')[0]}:season:${data.season_number}:episode:${episode.episode_number}`, episode.name || `Episode ${episode.episode_number}`, episode.overview, episode.air_date, episode.still_path, seriesItemId, episode, itemId))
    } else this.db.prepare(`INSERT INTO catalog_episodes(item_id,series_item_id,season_item_id,season_number,episode_number,runtime_minutes,air_date,production_code) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET runtime_minutes=excluded.runtime_minutes,air_date=excluded.air_date,production_code=excluded.production_code`).run(itemId, seriesItemId, seasonItemId ?? null, data.season_number, data.episode_number, numberOrNull(data.runtime), releaseDate, textOrNull(data.production_code))
    if (typeof posterPath === 'string' && posterPath) this.upsertArtwork('item', itemId, type === 'episode' ? 'still' : 'poster', posterPath, {}, 0, true)
    this.refreshItemFts(itemId)
    return itemId
  }

  private async resolveIdentities(runId: number, progress: (value: Progress) => void): Promise<void> {
    progress({ step: 'Scoring duplicate identity candidates', processed: 0, total: 2 })
    this.db.prepare(`INSERT OR IGNORE INTO catalog_person_matches(person_id,candidate_person_id,match_score,match_reason,status)
      SELECT a.person_id,b.person_id,
        CASE WHEN a.birthday IS NOT NULL AND a.birthday=b.birthday THEN 0.95 WHEN a.birthday IS NOT NULL AND b.birthday IS NOT NULL AND a.birthday<>b.birthday THEN 0.1 ELSE 0.65 END,
        CASE WHEN a.birthday IS NOT NULL AND a.birthday=b.birthday THEN 'Same normalized name and birth date' ELSE 'Same normalized name; requires review' END,'suggested'
      FROM catalog_people a JOIN catalog_people b ON a.normalized_name=b.normalized_name AND a.person_id<b.person_id
      WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM catalog_person_external_ids x JOIN catalog_person_external_ids y ON x.source=y.source AND x.external_id=y.external_id WHERE x.person_id=a.person_id AND y.person_id=b.person_id)`).run()
    progress({ step: 'Identity candidates ready for review', processed: 1, total: 2 })
    const count = Number((this.db.prepare(`SELECT count(*) count FROM catalog_person_matches WHERE status='suggested'`).get() as Json).count)
    this.log(runId, 'info', `${count} identity matches await review`)
    progress({ step: 'Identity resolution complete', processed: 2, total: 2, succeeded: 2, message: `${count} suggestions` })
  }

  private refreshItemFts(itemId: number): void {
    const item = this.db.prepare('SELECT canonical_title,original_title,description FROM catalog_items WHERE item_id=?').get(itemId) as Json
    this.db.prepare('DELETE FROM catalog_items_fts WHERE rowid=?').run(itemId)
    this.db.prepare('INSERT INTO catalog_items_fts(rowid,canonical_title,original_title,description) VALUES(?,?,?,?)').run(itemId, item.canonical_title, item.original_title, item.description)
  }

  private upsertArtwork(ownerType: string, ownerId: number, artworkType: string, sourceAssetId: string, metadata: Json, order: number, selected: boolean, source = 'tmdb'): number {
    const extension = extname(sourceAssetId).replace('.', '') || 'jpg'
    const sourceUrl = source === 'tmdb' && !sourceAssetId.startsWith('http') ? `https://image.tmdb.org/t/p/original${sourceAssetId}` : sourceAssetId
    this.db.prepare(`INSERT INTO catalog_artwork_assets(owner_type,owner_id,artwork_type,source,source_asset_id,source_url,language_code,width,height,aspect_ratio,vote_average,vote_count,billing_order,is_selected,selection_reason,file_extension,mime_type,metadata_updated_at,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,NULL)
      ON CONFLICT(owner_type,owner_id,artwork_type,source,source_asset_id) DO UPDATE SET language_code=excluded.language_code,width=excluded.width,height=excluded.height,aspect_ratio=excluded.aspect_ratio,vote_average=excluded.vote_average,vote_count=excluded.vote_count,billing_order=excluded.billing_order,is_selected=excluded.is_selected,selection_reason=excluded.selection_reason,metadata_updated_at=CURRENT_TIMESTAMP,deleted_at=NULL`)
      .run(ownerType, ownerId, artworkType, source, sourceAssetId, sourceUrl, textOrNull(metadata.iso_639_1), numberOrNull(metadata.width), numberOrNull(metadata.height), numberOrNull(metadata.aspect_ratio), numberOrNull(metadata.vote_average), numberOrNull(metadata.vote_count), order, bool(selected), selected ? 'highest-ranked source image' : null, extension, extension === 'png' ? 'image/png' : 'image/jpeg')
    const assetId = (this.db.prepare(`SELECT asset_id FROM catalog_artwork_assets WHERE owner_type=? AND owner_id=? AND artwork_type=? AND source=? AND source_asset_id=?`).get(ownerType, ownerId, artworkType, source, sourceAssetId) as Json).asset_id as number
    if (selected) this.db.prepare(`INSERT INTO catalog_artwork_queue(asset_id,status) VALUES(?,'pending') ON CONFLICT(asset_id) DO UPDATE SET status=CASE WHEN catalog_artwork_queue.status='done' THEN 'done' ELSE 'pending' END`).run(assetId)
    return assetId
  }

  private refreshFilmFts(filmId: number): void {
    const film = this.db.prepare('SELECT title,original_title FROM catalog_films WHERE film_id=?').get(filmId) as Json
    const alternatives = (this.db.prepare('SELECT title FROM catalog_alternative_titles WHERE film_id=? ORDER BY billing_order').all(filmId) as Json[]).map(row => row.title).join(' ')
    this.db.prepare('DELETE FROM catalog_films_fts WHERE rowid=?').run(filmId)
    this.db.prepare('INSERT INTO catalog_films_fts(rowid,title,original_title,alternative_titles) VALUES(?,?,?,?)').run(filmId, film.title, film.original_title, alternatives)
  }

  private async fetchArtwork(runId: number, options: FlowOptions, signal: AbortSignal, progress: (value: Progress) => void): Promise<void> {
    const limit = Math.max(1, Math.min(Number(options.limit ?? 50), 2000))
    const selectedClause = options.allArtwork ? '' : 'AND a.is_selected=1'
    const rows = this.db.prepare(`SELECT q.asset_id,a.owner_type,a.owner_id,a.artwork_type,a.source_url,a.file_extension FROM catalog_artwork_queue q JOIN catalog_artwork_assets a USING(asset_id) WHERE q.status IN ('pending','failed') ${selectedClause} ORDER BY a.is_selected DESC,q.available_at LIMIT ?`).all(limit) as Json[]
    progress({ step: 'Downloading artwork', processed: 0, total: rows.length, succeeded: 0, failed: 0 })
    let succeeded = 0
    let failed = 0
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]
      if (signal.aborted) throw signal.reason
      try {
        const response = await fetch(row.source_url, { signal })
        if (!response.ok || !response.body) throw new Error(`Artwork HTTP ${response.status}`)
        const path = join(catalogueArtworkRoot(), row.owner_type, String(row.owner_id), row.artwork_type, `${row.asset_id}.${row.file_extension || 'jpg'}`)
        mkdirSync(dirname(path), { recursive: true })
        await pipeline(Readable.fromWeb(response.body as any), createWriteStream(path))
        const details = await stat(path)
        this.db.prepare(`UPDATE catalog_artwork_assets SET local_path=?,byte_size=?,fetched_at=CURRENT_TIMESTAMP WHERE asset_id=?`).run(path, details.size, row.asset_id)
        if (row.owner_type === 'item') this.db.prepare(`UPDATE catalog_items SET
          default_poster_asset_id=CASE WHEN ?='poster' THEN ? ELSE default_poster_asset_id END,
          default_backdrop_asset_id=CASE WHEN ?='backdrop' THEN ? ELSE default_backdrop_asset_id END,
          completeness_status=CASE WHEN description IS NOT NULL AND trim(description)<>'' AND (?='poster' OR default_poster_asset_id IS NOT NULL) THEN 'complete' ELSE completeness_status END,
          completeness_score=CASE WHEN description IS NOT NULL AND trim(description)<>'' AND (?='poster' OR default_poster_asset_id IS NOT NULL) THEN 1 ELSE completeness_score END,
          metadata_updated_at=CURRENT_TIMESTAMP WHERE item_id=?`).run(row.artwork_type, row.asset_id, row.artwork_type, row.asset_id, row.artwork_type, row.artwork_type, row.owner_id)
        this.db.prepare(`INSERT INTO catalog_artwork_variants(asset_id,variant_name,mime_type,file_extension,byte_size,local_path) VALUES(?,'original',?,?,?,?) ON CONFLICT(asset_id,variant_name) DO UPDATE SET mime_type=excluded.mime_type,file_extension=excluded.file_extension,byte_size=excluded.byte_size,local_path=excluded.local_path`).run(row.asset_id, row.file_extension === 'png' ? 'image/png' : 'image/jpeg', row.file_extension || 'jpg', details.size, path)
        this.db.prepare(`UPDATE catalog_artwork_queue SET status='done',done_at=CURRENT_TIMESTAMP,locked_at=NULL,last_error=NULL WHERE asset_id=?`).run(row.asset_id)
        succeeded++
      } catch (error) {
        if (signal.aborted) throw signal.reason
        failed++
        const message = error instanceof Error ? error.message : String(error)
        this.db.prepare(`UPDATE catalog_artwork_queue SET status='failed',last_error=?,available_at=datetime('now','+30 minutes') WHERE asset_id=?`).run(message, row.asset_id)
        this.log(runId, 'error', message, { assetId: row.asset_id })
      }
      progress({ processed: index + 1, total: rows.length, succeeded, failed, message: basename(row.source_url) })
    }
  }

  private async integrityCheck(runId: number, progress: (value: Progress) => void): Promise<void> {
    progress({ step: 'Running SQLite integrity check', processed: 0, total: 4 })
    const integrity = this.db.pragma('integrity_check') as Json[]
    if (integrity[0]?.integrity_check !== 'ok') throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`)
    progress({ step: 'Refreshing search indexes', processed: 1, total: 4 })
    this.db.exec(`DELETE FROM catalog_people_fts; INSERT INTO catalog_people_fts(rowid,name,original_name) SELECT person_id,name,original_name FROM catalog_people WHERE deleted_at IS NULL; DELETE FROM catalog_companies_fts; INSERT INTO catalog_companies_fts(rowid,name) SELECT company_id,name FROM catalog_companies WHERE deleted_at IS NULL; DELETE FROM catalog_items_fts; INSERT INTO catalog_items_fts(rowid,canonical_title,original_title,description) SELECT item_id,canonical_title,original_title,description FROM catalog_items WHERE deleted_at IS NULL;`)
    progress({ step: 'Refreshing catalogue counts', processed: 2, total: 4 })
    this.db.prepare(`UPDATE catalog_metadata SET film_count=(SELECT count(*) FROM catalog_items WHERE media_type='film' AND deleted_at IS NULL),person_count=(SELECT count(*) FROM catalog_people WHERE deleted_at IS NULL),asset_count=(SELECT count(*) FROM catalog_artwork_assets WHERE deleted_at IS NULL),imported_at=CURRENT_TIMESTAMP WHERE dataset_id='archivist-catalogue'`).run()
    progress({ step: 'Optimizing database', processed: 3, total: 4 })
    this.db.pragma('optimize')
    this.log(runId, 'info', 'Database integrity check passed', { database: cataloguePath() })
    progress({ step: 'Integrity check complete', processed: 4, total: 4, succeeded: 4, message: 'SQLite integrity check passed' })
  }
}
