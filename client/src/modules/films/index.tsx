import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react'
import { Routes, Route, Navigate, useParams, useNavigate, Link, useSearchParams, useLocation } from 'react-router-dom'
import { filmsApi, type Movie, type TmdbResult } from '../../lib/films.api.js'
import { sharedApi, type QualityProfile, type SubtitleSearchResult } from '../../lib/shared.api.js'
import { tmdbImage, formatRuntime, formatSize, requestWithTab } from '../../lib/api.js'
import { useTabs, librarySlug } from '../../lib/tab-context.js'
import {
  SearchInput, PosterSkeleton, EmptyState, StatusBadge, Modal, ReleaseList, type Release, Select,
  LibraryCard, CollectionFilterBar, SelectionBar, Spinner, TabSelect, Input, Field, QualityPolicyPanel
} from '../../components/ui.js'
import { FileMetadataEditorModal, type FileMetadataMode } from '../../components/FileMetadataEditorModal.js'
import { SearchDetailModal } from '../../components/SearchDetailModal.js'

// ── Film Detail Page ────────────────────────────────────────────────────────

function CertificationBadge({ cert }: { cert?: string }) {
  if (!cert) return null
  const c = cert.toUpperCase()
  const styles: Record<string, string> = {
    'G': 'bg-green-500/20 text-green-500 border-green-500/20',
    'PG': 'bg-blue-500/20 text-blue-500 border-blue-500/20',
    'PG-13': 'bg-yellow-500/20 text-yellow-500 border-yellow-500/20',
    'R': 'bg-red-500/20 text-red-500 border-red-500/20',
    'NC-17': 'bg-purple-500/20 text-purple-500 border-purple-500/20',
  }
  return (
    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-black tracking-tighter ${styles[c] || 'bg-white/5 text-white/40 border-white/10'}`}>
      {c}
    </span>
  )
}

function CountryFlag({ country }: { country?: string }) {
  if (!country) return null
  if (country.length > 3) return <span className="text-lg leading-none">{country}</span>
  const code = country.toLowerCase()
  return (
    <img 
      src={`https://flagcdn.com/w40/${code}.png`} 
      className="h-3 w-auto object-contain rounded-sm opacity-80" 
      alt={country}
      onError={(e) => { (e.target as any).style.display = 'none' }}
    />
  )
}

function LanguageFlag({ lang }: { lang: string }) {
  const map: Record<string, string> = {
    'en': 'gb', 'eng': 'gb',
    'ja': 'jp', 'jpn': 'jp',
    'fr': 'fr', 'fra': 'fr', 'fre': 'fr',
    'ko': 'kr', 'kor': 'kr',
    'de': 'de', 'deu': 'de', 'ger': 'de',
    'es': 'es', 'spa': 'es',
    'it': 'it', 'ita': 'it',
    'ru': 'ru', 'rus': 'ru',
    'zh': 'cn', 'zho': 'cn', 'chi': 'cn',
    'pt': 'br', 'por': 'br'
  }
  return <CountryFlag country={map[lang.toLowerCase()] || lang} />
}


// ── Edition Renamer Modal ───────────────────────────────────────────
function EditionRenamerModal({ edition, film, onClose, onSuccess }: { edition: any, film: any, onClose: () => void, onSuccess: () => void }) {
  const [newName, setNewName] = useState(edition.edition_name === 'Unknown / Custom' ? '' : edition.edition_name)
  const [saveAsRule, setSaveAsRule] = useState(true)

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    
    try {
      // 1. Update the edition name in the DB
      await fetch(`/api/v1/films/editions/${edition.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edition_name: newName.trim() })
      })

      // 2. Add rule if requested
      if (saveAsRule) {
        await filmsApi.editionRules.add({
          rule_name: newName.trim(),
          regex_pattern: `(?i)(${newName.trim()})`,
          output_label: newName.trim(),
          priority: 10,
          active: 1
        })
      }
      onSuccess()
    } catch (err) {
      alert(String(err))
    }
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={handleSave} className="w-[400px] p-6 bg-noir-900 border border-white/10 rounded-2xl space-y-6">
        <h3 className="font-display text-xl uppercase tracking-widest text-white">Rename Edition</h3>
        <div className="space-y-4">
          <p className="text-[12px] text-white/60">
            Currently named <span className="font-mono text-[#00D4FF]">"{edition.edition_name}"</span>. 
            Rename this edition for <strong>{film.title}</strong>.
          </p>
          <div>
            <label className="block text-[10px] font-mono text-white/40 mb-1">New Edition Name</label>
            <Input value={newName} onChange={(e: any) => setNewName(e.target.value)} placeholder="e.g. The Ulysses Cut" required autoFocus />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={saveAsRule} onChange={(e: any) => setSaveAsRule(e.target.checked)} className="rounded bg-white/5 border-white/10 accent-[#00D4FF]" />
            <span className="text-[12px] text-white/60">Save as global Parsing Rule</span>
          </div>
        </div>
        <div className="flex justify-end gap-3 pt-4 border-t border-white/5">
          <button type="button" onClick={onClose} className="px-4 py-2 text-[10px] uppercase font-bold tracking-widest text-white/40 hover:text-white transition-colors">Cancel</button>
          <button type="submit" className="px-6 py-2 bg-[#00D4FF] text-noir-950 rounded text-[10px] uppercase font-bold tracking-widest shadow-[0_0_20px_rgba(0,212,255,0.2)]">Save</button>
        </div>
      </form>
    </Modal>
  )
}

// ── Active Download Component ──────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b <= 0) return '0 B'
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`
  if (b >= 1e9)  return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6)  return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3)  return `${(b / 1e3).toFixed(0)} KB`
  return `${b} B`
}

function fmtSpeed(bps: number): string {
  if (bps <= 0) return '--'
  return `${fmtBytes(bps)}/s`
}

function fmtEta(sec: number): string {
  if (sec < 0 || sec > 86400 * 365) return '∞'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

const TORRENT_STATUS: Record<string, { label: string; pill: string; bar: string }> = {
  'stopped':           { label: 'Paused',      pill: 'bg-white/10 text-white/40 border border-white/10',                bar: 'bg-white/20' },
  'queued-check':      { label: 'Queued Check', pill: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20',         bar: 'bg-cyan-500' },
  'checking':          { label: 'Checking',     pill: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20',   bar: 'bg-yellow-500' },
  'fetching-metadata': { label: 'Metadata',     pill: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20',         bar: 'bg-cyan-500' },
  'queued-download':   { label: 'Queued',       pill: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20',         bar: 'bg-cyan-500' },
  'downloading':       { label: 'Downloading',  pill: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20', bar: 'bg-[#00D4FF]' },
  'queued-seed':       { label: 'Queued Seed',  pill: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20', bar: 'bg-emerald-400' },
  'seeding':           { label: 'Seeding',      pill: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20', bar: 'bg-emerald-400' },
  'error':             { label: 'Error',        pill: 'bg-red-500/10 text-red-400 border border-red-500/20',             bar: 'bg-red-500' },
}

interface TorrentFile {
  index: number; name: string; sizeBytes: number; downloadedBytes: number; wanted: boolean; priority: string
}

type FileNode =
  | { type: 'file'; name: string; sizeBytes: number; downloadedBytes: number; index: number; wanted: boolean; priority: string }
  | { type: 'dir';  name: string; children: FileNode[] }

function buildFileTree(files: TorrentFile[]): FileNode[] {
  const root: FileNode[] = []
  for (const file of files) {
    const parts = file.name.split('/')
    let nodes = root
    for (let i = 0; i < parts.length - 1; i++) {
      let dir = nodes.find((n): n is Extract<FileNode, { type: 'dir' }> => n.type === 'dir' && n.name === parts[i])
      if (!dir) { dir = { type: 'dir', name: parts[i], children: [] }; nodes.push(dir) }
      nodes = dir.children
    }
    nodes.push({ type: 'file', name: parts[parts.length - 1]!, sizeBytes: file.sizeBytes, downloadedBytes: file.downloadedBytes, index: file.index, wanted: file.wanted, priority: file.priority })
  }
  return root
}

function nodeBytes(n: FileNode): [number, number] {
  if (n.type === 'file') return [n.sizeBytes, n.downloadedBytes]
  return n.children.reduce(([s, d], c) => { const [cs, cd] = nodeBytes(c); return [s + cs, d + cd] }, [0, 0])
}

function collectIndices(n: FileNode): number[] {
  if (n.type === 'file') return [n.index]
  return n.children.flatMap(collectIndices)
}

function dirWanted(n: Extract<FileNode, { type: 'dir' }>): boolean | null {
  const leaves: boolean[] = []
  const walk = (node: FileNode) => { if (node.type === 'file') leaves.push(node.wanted); else node.children.forEach(walk) }
  walk(n)
  if (leaves.every(Boolean)) return true
  if (leaves.every(v => !v)) return false
  return null
}

const FILE_PRIORITIES = [
  { value: 'high',   label: 'High',   color: 'text-[#FF2D78]' },
  { value: 'normal', label: 'Normal', color: 'text-white/40'  },
  { value: 'low',    label: 'Low',    color: 'text-white/20'  },
]

function ActiveFileNodeRow({ node, depth, onToggle, onPriority }: { node: FileNode; depth: number; onToggle: (indices: number[], wanted: boolean) => void; onPriority: (index: number, priority: string) => void }) {
  const [open, setOpen] = useState(depth === 0)
  const [total, done] = nodeBytes(node)
  const isUnwantedFile = node.type === 'file' && !node.wanted
  const pct = (total > 0 && !isUnwantedFile) ? done / total : 0

  const gridStyle = { display: 'grid', gridTemplateColumns: '1fr 100px 140px 120px', gap: '12px', alignItems: 'center' }

  if (node.type === 'file') {
    const priColor = FILE_PRIORITIES.find(o => o.value === node.priority)?.color ?? 'text-white/30'
    return (
      <div className="py-1 hover:bg-white/[0.02] rounded px-1 group" style={{ ...gridStyle, paddingLeft: `${depth * 12 + 4}px` }}>
        <div className="flex items-center gap-1.5 min-w-0">
          <input type="checkbox" checked={node.wanted} onChange={e => { e.stopPropagation(); onToggle([node.index], e.target.checked) }} onClick={e => e.stopPropagation()}
            className="flex-shrink-0 w-3.5 h-3.5 rounded accent-[#00D4FF] cursor-pointer opacity-50 group-hover:opacity-100 transition-opacity" />
          <span className={`text-[11px] truncate transition-colors min-w-0 ${node.wanted ? 'text-white/60' : 'text-white/20 line-through'}`}>{node.name}</span>
        </div>
        <div className="flex items-center gap-1 justify-center" onClick={e => e.stopPropagation()}>
          <button onClick={() => { const p = ['low', 'normal', 'high']; const i = p.indexOf(node.priority || 'normal'); if (i > 0) onPriority(node.index, p[i - 1]!) }}
            disabled={!node.wanted} className={`text-white/20 hover:text-white transition-colors p-0.5 ${!node.wanted ? 'opacity-0' : ''}`}><span className="text-[7px]">▼</span></button>
          <span className={`text-[9px] font-mono min-w-[35px] text-center ${priColor} ${!node.wanted ? 'opacity-30' : ''}`}>{(node.priority || 'normal').toUpperCase()}</span>
          <button onClick={() => { const p = ['low', 'normal', 'high']; const i = p.indexOf(node.priority || 'normal'); if (i < 2) onPriority(node.index, p[i + 1]!) }}
            disabled={!node.wanted} className={`text-white/20 hover:text-white transition-colors p-0.5 ${!node.wanted ? 'opacity-0' : ''}`}><span className="text-[7px]">▲</span></button>
        </div>
        <span className="text-[9px] font-mono text-white/20 text-right whitespace-nowrap">{fmtBytes(done)} / {fmtBytes(total)}</span>
        <div className="flex items-center gap-2 pr-2">
          <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden"><div className="h-full bg-[#00D4FF]" style={{ width: `${pct * 100}%` }} /></div>
          <span className="text-[9px] font-mono text-white/20 w-6 text-right">{Math.round(pct * 100)}%</span>
        </div>
      </div>
    )
  }

  const wantedState = dirWanted(node)
  const allIndices = collectIndices(node)

  return (
    <div>
      <div className="py-1 hover:bg-white/[0.02] rounded px-1 group" style={{ ...gridStyle, paddingLeft: `${depth * 12 + 4}px` }}>
        <div className="flex items-center gap-1.5 min-w-0">
          <input type="checkbox" checked={wantedState === true}
            ref={el => { if (el) el.indeterminate = wantedState === null }}
            onChange={e => { e.stopPropagation(); onToggle(allIndices, e.target.checked) }} onClick={e => e.stopPropagation()}
            className="flex-shrink-0 w-3.5 h-3.5 rounded accent-[#00D4FF] cursor-pointer opacity-50 group-hover:opacity-100 transition-opacity" />
          <span className="text-white/20 text-[9px] cursor-pointer select-none flex-shrink-0" onClick={() => setOpen(o => !o)}>{open ? '▼' : '▶'}</span>
          <span className="text-[11px] text-white/60 font-medium truncate cursor-pointer" onClick={() => setOpen(o => !o)}>{node.name}/</span>
        </div>
        <div />
        <span className="text-[9px] font-mono text-white/20 text-right">{fmtBytes(done)} / {fmtBytes(total)}</span>
        <div className="flex items-center gap-2 pr-2">
          <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden"><div className="h-full bg-white/10" style={{ width: `${pct * 100}%` }} /></div>
          <span className="text-[9px] font-mono text-white/20 w-6 text-right">{Math.round(pct * 100)}%</span>
        </div>
      </div>
      {open && node.children.map((child, i) => (
        <ActiveFileNodeRow key={i} node={child} depth={depth + 1} onToggle={onToggle} onPriority={onPriority} />
      ))}
    </div>
  )
}

function ActiveFileTree({ torrentId, files }: { torrentId: string; files: TorrentFile[] }) {
  const [localFiles, setLocalFiles] = useState<TorrentFile[]>(files)
  useEffect(() => { setLocalFiles(files) }, [files])

  const patch = async (updates: Array<{ index: number; wanted?: boolean; priority?: string }>) => {
    await fetch(`/api/v1/torrents/${torrentId}/files`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates }),
    })
  }

  const handleToggle = async (indices: number[], wanted: boolean) => {
    setLocalFiles(prev => prev.map(f => indices.includes(f.index) ? { ...f, wanted } : f))
    try { await patch(indices.map(index => ({ index, wanted }))) } catch { setLocalFiles(files) }
  }

  const handlePriority = async (index: number, priority: string) => {
    setLocalFiles(prev => prev.map(f => f.index === index ? { ...f, priority } : f))
    try { await patch([{ index, priority }]) } catch { setLocalFiles(files) }
  }

  if (localFiles.length === 0) return <div className="p-4 text-xs text-white/20 font-mono text-center">No file info yet</div>

  const wantedCount = localFiles.filter(f => f.wanted).length
  const unwantedCount = localFiles.length - wantedCount
  const tree = buildFileTree(localFiles)

  return (
    <div className="text-xs">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 sticky top-0 bg-noir-900/80 backdrop-blur-md z-10">
        <span className="text-[9px] font-mono text-white/20">
          {wantedCount}/{localFiles.length} selected
          {unwantedCount > 0 && <span className="text-white/10"> · {fmtBytes(localFiles.filter(f => !f.wanted).reduce((s, f) => s + f.sizeBytes, 0))} skipped</span>}
        </span>
        <div className="flex gap-2">
          <button onClick={() => handleToggle(localFiles.map(f => f.index), true)} className="text-[9px] font-mono text-[#00D4FF]/60 hover:text-[#00D4FF] transition-colors">All</button>
          <span className="text-white/10">·</span>
          <button onClick={() => handleToggle(localFiles.map(f => f.index), false)} className="text-[9px] font-mono text-white/30 hover:text-white/60 transition-colors">None</button>
        </div>
      </div>
      <div className="px-3 py-2 border-b border-white/5 text-[9px] font-mono text-white/20 uppercase tracking-widest grid"
        style={{ gridTemplateColumns: '1fr 100px 140px 120px', gap: '12px' }}>
        <span>File</span>
        <span className="text-center">Priority</span>
        <span className="text-right">Size</span>
        <span className="pl-2">Progress</span>
      </div>
      <div className="p-2">
        {tree.map((node, i) => <ActiveFileNodeRow key={i} node={node} depth={0} onToggle={handleToggle} onPriority={handlePriority} />)}
      </div>
    </div>
  )
}

function ActiveDownload({ torrent: t, onAction, onDelete }: { torrent: any; onAction: () => void; onDelete: () => void }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'info' | 'files'>('info')
  const [detail, setDetail] = useState<any>(null)
  const [actioning, setActioning] = useState<string | null>(null)
  const cfg = TORRENT_STATUS[t.status] ?? TORRENT_STATUS.error
  const pct = Math.round(t.progress * 100)

  const handleAction = async (action: 'pause' | 'resume' | 'remove', deleteData = false) => {
    if (action === 'remove' && !confirm(`Are you sure you want to ${deleteData ? 'DELETE DATA AND ' : ''}REMOVE this torrent?`)) return
    
    setActioning(action)
    try {
      const res = await fetch(`/api/v1/dashboard/downloads/${t.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, deleteData })
      })
      if (res.ok) {
        if (action === 'remove') onDelete()
        else onAction()
      }
    } catch (err) {
      console.error('Failed to perform action:', err)
    } finally {
      setActioning(null)
    }
  }

  useEffect(() => {
    const fetchDetail = () => fetch(`/api/v1/torrents/${t.id}`).then(r => r.json()).then(setDetail).catch(() => {})
    fetchDetail()
    const interval = setInterval(fetchDetail, 3000)
    return () => clearInterval(interval)
  }, [t.id])

  const data = detail ?? t

  const stats = [
    ['Status',     <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest ${cfg.pill}`}>{cfg.label}</span>],
    ['Downloaded', `${fmtBytes(data.downloadedBytes)} / ${fmtBytes(data.sizeBytes)}`],
    ['Down Speed', fmtSpeed(data.downloadSpeed)],
    ['Up Speed',   fmtSpeed(data.uploadSpeed)],
    ['Peers',      `${data.peersConnected} connected / ${data.peersSeen} seen`],
    ['ETA',        data.status === 'downloading' ? fmtEta(data.eta) : '--'],
    ['Ratio',      data.uploadRatio >= 0 ? data.uploadRatio.toFixed(2) : '∞'],
    ['Uploaded',   fmtBytes(data.uploadedBytes)],
  ]

  const isPaused = t.status === 'stopped'

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-6 flex-1">
          <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest whitespace-nowrap">Active Download</h3>
          <div className="h-px flex-1 bg-white/5" />
        </div>
        <div className="flex items-center gap-2 ml-6">
          <button 
            onClick={() => handleAction(isPaused ? 'resume' : 'pause')}
            disabled={!!actioning}
            className={`px-4 py-2 rounded-xl text-[9px] font-bold uppercase tracking-widest transition-all border ${
              isPaused 
                ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20' 
                : 'bg-amber-500/10 text-amber-500 border-amber-500/20 hover:bg-amber-500/20'
            } disabled:opacity-30`}
          >
            {actioning === (isPaused ? 'resume' : 'pause') ? <Spinner className="w-3 h-3" /> : (isPaused ? 'Resume' : 'Pause')}
          </button>
          <button 
            onClick={() => handleAction('remove', false)}
            disabled={!!actioning}
            className="px-4 py-2 rounded-xl bg-white/5 text-white/40 border border-white/10 hover:bg-white/10 hover:text-white text-[9px] font-bold uppercase tracking-widest transition-all disabled:opacity-30"
          >
            {actioning === 'remove' ? <Spinner className="w-3 h-3" /> : 'Remove'}
          </button>
          <button 
            onClick={() => handleAction('remove', true)}
            disabled={!!actioning}
            className="px-4 py-2 rounded-xl bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500/20 text-[9px] font-bold uppercase tracking-widest transition-all disabled:opacity-30"
          >
            {actioning === 'remove' ? <Spinner className="w-3 h-3" /> : 'Delete'}
          </button>
        </div>
      </div>

      <div className="bg-noir-900/50 border border-white/5 rounded-2xl overflow-hidden shadow-2xl">
        {/* Torrent name + progress bar */}
        <div 
          onClick={() => navigate('/acquisitions')}
          className="px-8 py-6 border-b border-white/5 cursor-pointer hover:bg-white/[0.02] transition-all group/info"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex-1 min-w-0 mr-6">
              <p className="text-sm text-white/80 font-medium truncate group-hover/info:text-[#00D4FF] transition-colors">{t.name}</p>
              <p className="text-[9px] font-mono text-white/20 mt-1 uppercase tracking-widest">Click to view full acquisition details</p>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest ${cfg.pill}`}>{cfg.label}</span>
              {t.downloadSpeed > 0 && (
                <span className="text-[10px] font-mono text-emerald-400">↓ {fmtSpeed(t.downloadSpeed)}</span>
              )}
              {t.uploadSpeed > 0 && (
                <span className="text-[10px] font-mono text-cyan-400">↑ {fmtSpeed(t.uploadSpeed)}</span>
              )}
            </div>
          </div>

          {/* Large progress bar */}
          <div className="space-y-2">
            <div className="h-2 bg-white/5 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${cfg.bar}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-white/30">
                {fmtBytes(t.downloadedBytes)} of {fmtBytes(t.sizeBytes)}
              </span>
              <span className="text-[14px] font-bold text-[#00D4FF] font-mono">{pct}%</span>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex px-8 border-b border-white/5">
          {(['info', 'files'] as const).map(id => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-8 py-3 text-[10px] font-mono uppercase tracking-widest transition-colors relative
                ${tab === id ? 'text-[#00D4FF]' : 'text-white/20 hover:text-white/40'}`}>
              {id === 'info' ? 'Overview' : `Files (${data.files?.length || 0})`}
              {tab === id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#00D4FF]" />}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'info' ? (
          <div className="px-8 py-6">
            <div className="grid grid-cols-4 gap-x-12 gap-y-6">
              {stats.map(([label, value], i) => (
                <div key={i} className="space-y-1">
                  <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest">{label as string}</p>
                  <div className="text-[11px] text-white/60 font-medium">{value as any}</div>
                </div>
              ))}
            </div>
            <div className="mt-6 pt-4 border-t border-white/5">
              <p className="text-[9px] font-mono text-white/10 break-all">{data.infoHash}</p>
            </div>
          </div>
        ) : (
          <div className="max-h-[400px] overflow-y-auto custom-scrollbar">
            <ActiveFileTree torrentId={t.id} files={data.files ?? []} />
          </div>
        )}
      </div>
    </div>
  )
}

function FilmDetailPage({ onDelete, filmsContextReady }: { onDelete: (id: number) => void; filmsContextReady: boolean }) {
  const params = useParams<{ id?: string; param?: string; slug?: string }>()
  const id = params.id ?? params.param
  const libSlug = params.slug
  const navigate = useNavigate()
  const { tabs, activeTabId, setActiveTabForMedia } = useTabs()
  // When the URL carries a library slug (types with multiple libraries), switch
  // the tab context to that library before loading the item, and hold the fetch
  // until it's active so we don't 404 against the wrong library.
  const targetLibTab = libSlug ? tabs.find(t => t.media_type === 'films' && librarySlug(t.name) === libSlug) : null
  const libReady = !libSlug ? true : (tabs.length === 0 ? false : (targetLibTab ? activeTabId === targetLibTab.id : true))
  useEffect(() => {
    if (targetLibTab && activeTabId !== targetLibTab.id) setActiveTabForMedia('films', targetLibTab.id)
  }, [targetLibTab?.id, activeTabId])
  const [film, setFilm] = useState<Movie | null>(null)
  const [loading, setLoading] = useState(true)
  const [releases, setReleases] = useState<Release[]>([])
  const [searching, setSearching] = useState(false)
  const [profiles, setProfiles] = useState<QualityProfile[]>([])
  const [grabbing, setGrabbing] = useState<string | null>(null)
  const [grabbed, setGrabbed] = useState<Set<string>>(new Set())
  const [showTrailer, setShowTrailer] = useState(false)

  const [selectedTier, setSelectedTier] = useState('Any')
  const [selectedResolution, setSelectedResolution] = useState('Any')
  const [selectedSource, setSelectedSource] = useState('Any')
  const [selectedCodec, setSelectedCodec] = useState('Any')
  const [cleaning, setCleaning] = useState(false)
  const [showSubtitleModal, setShowSubtitleModal] = useState(false)
  const [subtitleResults, setSubtitleResults] = useState<SubtitleSearchResult[]>([])
  const [searchingSubs, setSearchingSubs] = useState(false)
  const [downloadingSub, setDownloadingSub] = useState<string | null>(null)
  const [externalSubs, setExternalSubs] = useState<string[]>([])
  const [showMetadataModal, setShowMetadataModal] = useState(false)
  const [activeTorrent, setActiveTorrent] = useState<any>(null)
  const [acquisitionHistory, setAcquisitionHistory] = useState<{ decisions: any[]; blocks: any[] } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const initializedFilters = useRef(false)

  const [activeEditionId, setActiveEditionId] = useState<number | null>(null)
  const [renamingEdition, setRenamingEdition] = useState<any>(null)
  const [fileMetadataMode, setFileMetadataMode] = useState<FileMetadataMode | null>(null)
  const actionsRef = useRef<HTMLDivElement>(null)

  const [loadError, setLoadError] = useState<string | null>(null)

  const fetchFilm = () => {
    if (!id) return
    filmsApi.get(parseInt(id))
      .then(data => {
        if (data && typeof data === 'object' && 'id' in data) {
          setFilm(data)
          setLoadError(null)
          if (activeEditionId === null && data.editions?.length > 0) {
            const defaultEd = data.editions.find((e: any) => e.id === data.default_edition_id) || data.editions.find((e: any) => e.edition_name === 'Theatrical') || data.editions[0]
            if (defaultEd) setActiveEditionId(defaultEd.id)
          }
          if (!initializedFilters.current) {
            if (data.target_tier) setSelectedTier(data.target_tier)
            if (data.target_resolution) setSelectedResolution(data.target_resolution)
            if (data.target_source) setSelectedSource(data.target_source)
            if (data.target_codec) setSelectedCodec(data.target_codec)
            initializedFilters.current = true
          }
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        // Only redirect on a genuine 404. Other errors (server bugs, network
        // blips) stay on the page so the user can retry — silently bouncing
        // back to the library hides real problems.
        if (/HTTP 404|Not found/i.test(msg)) {
          navigate('/films')
        } else {
          setLoadError(msg)
        }
      })
      .finally(() => { if (loading) setLoading(false) })
  }

  useEffect(() => {
    if (!filmsContextReady) return
    if (!libReady) return
    fetchFilm()
    sharedApi.qualityProfiles.list().then(setProfiles)

    const interval = setInterval(fetchFilm, 5000)
    return () => clearInterval(interval)
  }, [id, navigate, filmsContextReady, libReady, activeTabId])

  // Fetch matching torrent when film is acquiring
  useEffect(() => {
    if (film?.status !== 'acquiring' || !film?.info_hash) {
      setActiveTorrent(null)
      return
    }
    const fetchTorrent = async () => {
      try {
        const torrents = await fetch('/api/v1/torrents').then(r => r.json())
        const match = torrents.find((t: any) => t.infoHash === film.info_hash)
        setActiveTorrent(match || null)
      } catch { setActiveTorrent(null) }
    }
    fetchTorrent()
    const interval = setInterval(fetchTorrent, 3000)
    return () => clearInterval(interval)
  }, [film?.status, film?.info_hash])

  const setDefaultEdition = async (editionId: number) => {
    try {
      await filmsApi.update(film!.id, { default_edition_id: editionId })
      setFilm({ ...film!, default_edition_id: editionId })
    } catch (err) {
      alert(String(err))
    }
  }

  const handleSearch = async () => {
    if (!film) return
    setSearching(true)
    setReleases([])
    try {
      await filmsApi.releases.search(film.title, film.year, {
        tier: selectedTier,
        resolution: selectedResolution,
        source: selectedSource,
        codec: selectedCodec,
        filmId: film.id,
      }, (batch) => {
        setReleases(prev => [...prev, ...batch])
      })
    } catch (err) {
      alert(String(err))
    } finally {
      setSearching(false)
    }
  }

  const handleDownload = async (release: Release) => {
    if (!film) return
    setGrabbing(release.guid)
    try {
      const res = await filmsApi.download(release.downloadUrl, film.id, (release as any).tier)
      if (res.success) {
        setFilm({ ...film, status: 'acquiring' })
        setGrabbed(prev => new Set([...prev, release.guid]))
      } else {
        alert(`Failed to send to client: ${res.message}`)
      }
    } catch (err) {
      alert(String(err))
    } finally {
      setGrabbing(null)
    }
  }

  const handleCleanTracks = async () => {
    if (!film?.file_path) return
    setCleaning(true)
    try {
      const result = await sharedApi.media.cleanTracks(film.file_path, { tmdbId: film.tmdb_id })
      if (result.success) {
        const savedMB = ((result.originalSize - result.newSize) / 1024 / 1024).toFixed(1)
        alert(result.removedAudio > 0 || result.removedSubs > 0
          ? `Cleaned: removed ${result.removedAudio} audio, ${result.removedSubs} subtitle tracks. Saved ${savedMB} MB.`
          : result.message)
      } else {
        alert(`Clean failed: ${result.message}`)
      }
    } catch (err) {
      alert(String(err))
    } finally {
      setCleaning(false)
    }
  }

  const loadAcquisitionHistory = async () => {
    if (!film) return
    const history = await filmsApi.acquisitionHistory(film.id)
    setAcquisitionHistory(history)
    setHistoryOpen(true)
  }

  const handleRejectCurrent = async () => {
    if (!film) return
    if (!confirm('Reject this current release and stop Archivist from grabbing it again?')) return
    await filmsApi.rejectCurrentRelease(film.id)
    await fetchFilm()
    await loadAcquisitionHistory()
  }

  const handleRepairForReacquisition = async () => {
    if (!film) return
    const deleteFile = confirm('Delete the current media file from disk as part of repair? Choose OK for broken files, Cancel to only clear Archivist state.')
    const repaired = await filmsApi.repair(film.id, { deleteFile, rejectCurrent: true })
    setFilm(repaired)
    setActiveTorrent(null)
    await loadAcquisitionHistory()
  }

  const handleSearchSubtitles = async () => {
    if (!film) return
    setShowSubtitleModal(true)
    setSearchingSubs(true)
    setSubtitleResults([])
    try {
      const results = await sharedApi.subtitles.search({
        imdbId: film.imdb_id,
        tmdbId: film.tmdb_id,
        query: film.title,
      })
      setSubtitleResults(results)
    } catch (err) {
      alert(String(err))
    } finally {
      setSearchingSubs(false)
    }
  }

  const handleDownloadSubtitle = async (sub: SubtitleSearchResult) => {
    if (!film?.file_path) return
    setDownloadingSub(sub.id)
    try {
      const result = await sharedApi.subtitles.download(sub.fileId, film.file_path, sub.language)
      if (result.success) {
        setExternalSubs(prev => prev.includes(sub.language) ? prev : [...prev, sub.language])
        setShowSubtitleModal(false)
      } else {
        alert(`Failed: ${result.message}`)
      }
    } catch (err) {
      alert(String(err))
    } finally {
      setDownloadingSub(null)
    }
  }

  const handleUpdate = async (updates: Partial<Movie>) => {
    if (!film) return
    try {
      const updated = await filmsApi.update(film.id, updates)
      if (updated) setFilm(updated)
    } catch (err) {
      alert(String(err))
    }
  }

  const handlePolicyUpdate = async (updates: Partial<Movie>) => {
    await handleUpdate(updates)
    if (updates.target_tier !== undefined) setSelectedTier(updates.target_tier || 'Any')
    if (updates.target_resolution !== undefined) setSelectedResolution(updates.target_resolution || 'Any')
    if (updates.target_source !== undefined) setSelectedSource(updates.target_source || 'Any')
    if (updates.target_codec !== undefined) setSelectedCodec(updates.target_codec || 'Any')
  }

  // Make every Action button as wide as the widest one, recomputed whenever the
  // set of buttons changes (some render conditionally).
  useLayoutEffect(() => {
    const el = actionsRef.current
    if (!el) return
    const btns = Array.from(el.querySelectorAll('button')) as HTMLButtonElement[]
    btns.forEach(b => { b.style.width = 'auto' })
    const max = btns.reduce((m, b) => Math.max(m, b.offsetWidth), 0)
    if (max > 0) btns.forEach(b => { b.style.width = `${max}px` })
  }, [film?.status, (film as any)?.file_path, (film as any)?.info_hash, (film as any)?.current_release_title])

  if (loading && !film) return <PosterSkeleton />
  if (loadError && !film) return (
    <div className="p-12 text-center">
      <EmptyState icon="⚠️" title="COULDN'T LOAD FILM" subtitle={loadError} />
      <button onClick={() => navigate('/films')} className="mt-6 px-6 py-2 text-[10px] uppercase font-bold tracking-widest text-white/40 hover:text-white border border-white/10 rounded">← Back to library</button>
    </div>
  )
  if (!film) return <EmptyState icon="🎬" title="FILM NOT FOUND" />

  const editions = (film as any).editions || []
  const activeEdition = editions.find((e: any) => e.id === activeEditionId) || editions[0] || {}
  const currentFileInfo = activeEdition.fileInfo || film.fileInfo

  const trailer = (film as any).videos?.find((v: any) => v.type === 'Trailer' && v.site === 'YouTube') || (film as any).videos?.[0]

  const formatResolution = (res?: string) => {
    if (!res) return '1080P'
    const low = res.toLowerCase()
    if (low.includes('4k') || low.includes('2160p')) return '4K'
    if (low.includes('1080p')) return '1080P'
    if (low.includes('720p')) return '720P'
    return res.toUpperCase()
  }

  return (
    <div className="animate-fade-in pb-20 relative min-h-screen">
      {/* Immersive Backdrop Fix */}
      <div className="fixed inset-0 pointer-events-none" style={{ zIndex: -5 }}>
        <img 
          src={film.backdrop_path} 
          className="w-full h-full object-cover opacity-50 blur-[10px] scale-110" 
          alt="" 
        />
        <div className="absolute inset-0 bg-noir-950/40" />
        </div>

        <div className="relative z-10 max-w-[1600px] mx-auto px-8 pt-4">
          {/* Main Grid: 12 Columns */}
          <div className="grid grid-cols-12 gap-x-16 gap-y-16 items-stretch">

            {/* Top Left: Poster (col-span-3) */}
            <div className="col-span-12 lg:col-span-3 flex flex-col items-stretch gap-4">
              <div 
                onClick={() => setShowMetadataModal(true)}
                className="aspect-[2/3] w-full rounded-3xl overflow-hidden border border-white/10 shadow-[0_0_60px_rgba(0,0,0,0.6)] group/poster relative cursor-pointer hover:border-[#00D4FF]/40 transition-all active:scale-[0.98]"
              >
                <img src={film.poster_path} className="w-full h-full object-cover" alt="" />
                <div className="absolute inset-0 bg-[#00D4FF]/20 opacity-0 group-hover/poster:opacity-100 transition-opacity flex items-center justify-center">
                  <div className="bg-black/60 backdrop-blur-md px-4 py-2 rounded-full border border-white/20 transform translate-y-4 group-hover/poster:translate-y-0 transition-transform">
                    <p className="text-[10px] font-bold text-white uppercase tracking-[0.2em]">Edit Metadata</p>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between px-1">
                <StatusBadge status={film.status} progress={film.downloadProgress} className="!text-[14px]" />
                <div className="flex items-center gap-3">
                  <CountryFlag country={film.country} />
                  <CertificationBadge cert={film.certification} />
                </div>
              </div>
            </div>

            {/* Top Center: Overview & Metadata (col-span-6) */}
            <div className="col-span-12 lg:col-span-6 flex flex-col pt-4">
              <div className="space-y-4">
                <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Overview</h3>
                <p className="text-[12.5px] text-white leading-relaxed font-medium">{film.overview}</p>
              </div>

              <div className="mt-auto space-y-8 pb-2">
                <div className="flex flex-wrap gap-x-12 gap-y-6">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Released</span>
                    <span className="text-[12.5px] text-white font-medium">{film.year}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Runtime</span>
                    <span className="text-[12.5px] text-white font-medium">{formatRuntime(film.runtime || 0)}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Rating</span>
                    <span className="text-[12.5px] text-white font-medium">{(film.rating || 0).toFixed(1)} / 10</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Studio</span>
                    <span className="text-[12.5px] text-white font-medium truncate max-w-[200px]">{film.studio || 'N/A'}</span>
                  </div>
                </div>

                <div className="flex flex-col gap-1 pt-2 border-t border-white/5">
                  <span className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Genres</span>
                  <span className="text-[12.5px] text-white font-medium">{film.genres?.join(' / ')}</span>
                </div>
              </div>
            </div>
            {/* Top Right: Logo, Profile (col-span-3) */}
            <div className="col-span-12 lg:col-span-3 flex flex-col items-end text-right">
              {/* Logo at the very top right */}
              <div className="min-h-[140px] flex items-start justify-end w-full mb-8">
                {(film as any).logo_path ? (
                  <div className="flex flex-col items-end gap-6">
                    <img src={(film as any).logo_path} className="max-h-32 object-contain filter drop-shadow-2xl" alt={film.title} />
                  </div>
                ) : (
                  <div className="flex flex-col items-end gap-6">
                    <h1 className="font-display text-5xl tracking-tighter text-[#00D4FF] uppercase text-right leading-none">{film.title}</h1>
                  </div>
                )}
              </div>

              {/* Awards Stack at the bottom right */}
              <div className="w-full pb-2">
                <div className="space-y-6 pt-2 border-t border-white/5">
                  <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Awards & Recognition</h3>
                  <div className="space-y-6 mt-4 max-h-[230px] overflow-y-auto custom-scrollbar pr-4">
                    <div className="flex items-center gap-4 justify-end">
                      <div className="text-right">
                        <p className="text-[12.5px] text-white font-medium">Academy Awards</p>
                        <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest mt-1">3 Wins, 6 Nominations</p>
                      </div>
                      <span className="text-2xl filter drop-shadow-[0_0_8px_rgba(255,215,0,0.3)]">🏆</span>
                    </div>
                    <div className="flex items-center gap-4 justify-end">
                      <div className="text-right">
                        <p className="text-[12.5px] text-white font-medium">Cannes Film Festival</p>
                        <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest mt-1">Palme d'Or Winner</p>
                      </div>
                      <span className="text-2xl filter drop-shadow-[0_0_8px_rgba(255,255,255,0.15)]">🌿</span>
                    </div>
                    <div className="flex items-center gap-4 justify-end">
                      <div className="text-right">
                        <p className="text-[12.5px] text-white font-medium">Golden Globes</p>
                        <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest mt-1">Best Picture Winner</p>
                      </div>
                      <span className="text-2xl filter drop-shadow-[0_0_8px_rgba(255,255,255,0.15)]">✨</span>
                    </div>
                    <div className="flex items-center gap-4 justify-end">
                      <div className="text-right">
                        <p className="text-[12.5px] text-white font-medium">BAFTA Awards</p>
                        <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest mt-1">5 Nominations</p>
                      </div>
                      <span className="text-2xl filter drop-shadow-[0_0_8px_rgba(255,255,255,0.15)]">🎭</span>
                    </div>
                    <div className="flex items-center gap-4 justify-end">
                      <div className="text-right">
                        <p className="text-[12.5px] text-white font-medium">Venice Film Festival</p>
                        <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest mt-1">Golden Lion Nominee</p>
                      </div>
                      <span className="text-2xl filter drop-shadow-[0_0_8px_rgba(255,255,255,0.15)]">🦁</span>
                    </div>
                    <div className="flex items-center gap-4 justify-end">
                      <div className="text-right">
                        <p className="text-[12.5px] text-white font-medium">Berlin International</p>
                        <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest mt-1">Silver Bear for Best Director</p>
                      </div>
                      <span className="text-2xl filter drop-shadow-[0_0_8px_rgba(255,255,255,0.15)]">🐻</span>
                    </div>
                    <div className="flex items-center gap-4 justify-end">
                      <div className="text-right">
                        <p className="text-[12.5px] text-white font-medium">Sundance Festival</p>
                        <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest mt-1">Grand Jury Prize</p>
                      </div>
                      <span className="text-2xl filter drop-shadow-[0_0_8px_rgba(255,255,255,0.15)]">☀️</span>
                    </div>
                    <div className="flex items-center gap-4 justify-end">
                      <div className="text-right">
                        <p className="text-[12.5px] text-white font-medium">TIFF (Toronto)</p>
                        <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest mt-1">People's Choice Award</p>
                      </div>
                      <span className="text-2xl filter drop-shadow-[0_0_8px_rgba(255,255,255,0.15)]">🍁</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
        {/* Row 2: Cast (col-span-6) & Trailer (col-span-6) */}
        <div className="col-span-12 lg:col-span-6 space-y-1">
          {film.cast && film.cast.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Cast</h3>
              </div>
              <div className="flex gap-6 overflow-x-auto pb-2 custom-scrollbar snap-x">
                {film.cast.map(person => (
                  <div key={person.id} className="flex-shrink-0 w-[87px] space-y-4 snap-start">
                    <div className="aspect-square rounded-2xl overflow-hidden border border-white/5 bg-noir-800 shadow-xl">
                      <img src={person.profilePath} className="w-full h-full object-cover" alt={person.name} />
                    </div>
                    <div className="space-y-1 px-1">
                      <p className="text-[9.5px] font-bold text-white truncate uppercase leading-tight">{person.name}</p>
                      <p className="text-[9.5px] text-white/40 truncate leading-tight italic">{person.character}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {film.crew && film.crew.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Crew</h3>
              </div>
              <div className="flex gap-6 overflow-x-auto pb-2 custom-scrollbar snap-x">
                {[...film.crew].sort((a, b) => {
                  const order: Record<string, number> = { 
                    'Director': 1, 
                    'Screenplay': 2, 
                    'Writer': 3, 
                    'Producer': 4,
                    'Executive Producer': 5,
                    'Director of Photography': 6,
                    'Editor': 7,
                    'Original Music Composer': 8,
                    'Casting': 9,
                    'Production Design': 10,
                    'Costume Design': 11
                  };
                  const orderA = order[a.job] || 999;
                  const orderB = order[b.job] || 999;
                  if (orderA !== orderB) return orderA - orderB;
                  return a.job.localeCompare(b.job);
                }).map(person => (
                  <div key={person.id + person.job} className="flex-shrink-0 w-[87px] space-y-4 snap-start">
                    <div className="aspect-square rounded-2xl overflow-hidden border border-white/5 bg-noir-800 shadow-xl">
                      <img src={person.profilePath} className="w-full h-full object-cover" alt={person.name} />
                    </div>
                    <div className="space-y-1 px-1">
                      <p className="text-[9.5px] font-bold text-white truncate uppercase leading-tight">{person.name}</p>
                      <p className="text-[9.5px] text-white/40 truncate leading-tight italic">{person.job}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>        <div className="col-span-12 lg:col-span-6 space-y-4">
          <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Official Trailer</h3>
          <div className="aspect-video relative group/trailer overflow-hidden rounded-3xl border border-white/10 shadow-2xl bg-black">
            {film.trailerPath ? (
              <video 
                src={film.trailerPath} 
                controls 
                className="w-full h-full object-contain"
                poster={film.backdrop_path}
              />
            ) : trailer ? (
              <div className="w-full h-full cursor-pointer relative" onClick={() => setShowTrailer(true)}>
                <img src={`https://img.youtube.com/vi/${trailer.key}/maxresdefault.jpg`} className="w-full h-full object-cover opacity-60 group-hover:opacity-80 transition-opacity" alt="" />
                <div className="absolute inset-0 flex flex-col items-center justify-center space-y-4 bg-black/20">
                  <div className="w-16 h-16 rounded-full bg-[#00D4FF] flex items-center justify-center text-noir-950 pl-1 shadow-2xl group-hover:scale-110 transition-transform">▶</div>
                  <span className="text-[10.5px] font-bold text-white uppercase tracking-[0.4em] drop-shadow-lg">Play High-Def Trailer</span>
                </div>
              </div>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-white/10 text-[10.5px] font-bold uppercase tracking-widest border border-dashed border-white/10 rounded-3xl bg-black/5">No Trailer Available</div>
            )}
          </div>
        </div>

        {/* Row 3: File Details + Chapters (2 columns) */}
        {currentFileInfo && (
          <div className="col-span-12">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-stretch text-center md:text-left">
              {/* Left Column: File Info */}
              <div className="grid grid-cols-2 gap-y-10 gap-x-12 content-start">
                {editions.length > 0 && (
                  <div className="col-span-2 space-y-4">
                    <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Select Edition</h3>
                    <div className="flex flex-wrap gap-2">
                      {editions.map((ed: any) => (
                        <div key={ed.id} className="flex items-center gap-1">
                          <div className="relative group/ed flex items-center">
                            <button
                              onClick={() => setActiveEditionId(ed.id)}
                              className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all border ${
                                activeEditionId === ed.id
                                  ? 'bg-[#00D4FF] text-noir-950 border-[#00D4FF] shadow-[0_0_20px_rgba(0,212,255,0.3)]'
                                  : ed.edition_name === 'Unknown / Custom'
                                    ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
                                    : ed.status !== 'collected'
                                      ? 'bg-transparent text-white/30 border-white/10 border-dashed hover:border-white/30 hover:text-white'
                                      : 'bg-white/5 text-white/40 border-white/5 hover:border-white/10 hover:text-white'
                              }`}
                            >
                              {ed.edition_name}
                            </button>
                            <button 
                              onClick={() => setRenamingEdition(ed)}
                              className="absolute -top-2 -right-2 bg-noir-900 border border-white/10 rounded-full w-5 h-5 flex items-center justify-center opacity-0 group-hover/ed:opacity-100 transition-opacity hover:bg-white/10 hover:text-white text-white/40 text-[10px]"
                              title="Rename Edition"
                            >
                              ✎
                            </button>
                          </div>
                          {film.default_edition_id === ed.id ? (
                            <span className="text-[#00D4FF] text-[12px] ml-1 cursor-default" title="Default Edition">★</span>
                          ) : (
                            <button 
                              onClick={() => setDefaultEdition(ed.id)}
                              className="text-white/20 hover:text-[#00D4FF] text-[12px] ml-1 transition-colors" 
                              title="Set as Default Edition">
                              ☆
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Row 1: Video Codec | Resolution */}
                <div className="space-y-2">
                  <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Video Codec</p>
                  <p className="text-[12.5px] font-bold text-white uppercase">{currentFileInfo.codec || 'x265 HEVC'}</p>
                </div>
                <div className="space-y-2">
                  <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Resolution</p>
                  <p className="text-[12.5px] font-bold text-white uppercase">{formatResolution(currentFileInfo.resolution)}</p>
                </div>

                {/* Row 2: Audio Codec | Audio Streams (3 visible, scrollable) */}
                <div className="space-y-2">
                  <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Audio Codec</p>
                  <p className="text-[12.5px] font-bold text-white uppercase">
                    {(() => {
                      const codecs = Array.from(new Set((currentFileInfo.audio ?? []).map((s: any) => s.codec).filter(Boolean)))
                      return codecs.length ? codecs.join(' / ') : 'Unknown'
                    })()}
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Audio Streams</p>
                    {currentFileInfo.path && (
                      <button onClick={() => setFileMetadataMode('audio')}
                        className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-white/40 hover:text-white transition-all text-[9px] font-bold uppercase tracking-widest"
                        title="Rename or remove audio tracks">✎ Edit</button>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 max-h-[124px] overflow-y-auto custom-scrollbar pr-2">
                    {currentFileInfo.audio?.length > 0 ? (
                      currentFileInfo.audio.map((stream: any, i: number) => {
                        const chMap: Record<number, string> = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' }
                        const chLabel = chMap[stream.channels] || `${stream.channels}ch`
                        return (
                          <div key={i} className="flex items-center gap-1.5 bg-white/5 px-2 py-1 rounded w-fit shrink-0">
                            <LanguageFlag lang={stream.language} />
                            <span className="text-[12.5px] font-bold text-white uppercase">{stream.language}</span>
                            <span className="text-[10px] font-black text-[#00D4FF] bg-[#00D4FF]/10 px-1.5 py-0.5 rounded-sm">{chLabel}</span>
                            {stream.title && (
                              <span className="text-[10px] text-white/40 italic truncate max-w-[150px] border-l border-white/10 pl-1.5 ml-0.5">{stream.title}</span>
                            )}
                          </div>
                        )
                      })
                    ) : <p className="text-[12.5px] font-bold text-white uppercase">Unknown</p>}
                  </div>
                </div>

                {/* Row 3: Subtitles (3 visible, scrollable) | File Size */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Subtitles</p>
                    {currentFileInfo.path && (
                      <button onClick={() => setFileMetadataMode('subtitles')}
                        className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-white/40 hover:text-white transition-all text-[9px] font-bold uppercase tracking-widest"
                        title="Rename or remove subtitle tracks">✎ Edit</button>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 max-h-[124px] overflow-y-auto custom-scrollbar pr-2">
                    {currentFileInfo.subtitles?.length > 0 ? currentFileInfo.subtitles.map((lang: string) => (
                      <div key={lang} className="flex items-center gap-1.5 bg-white/5 px-2 py-1 rounded w-fit shrink-0">
                        <LanguageFlag lang={lang} />
                        <span className="text-[12.5px] font-bold text-white uppercase">{lang}</span>
                      </div>
                    )) : null}
                    {(currentFileInfo.externalSubtitles || externalSubs).filter((lang: string) => !currentFileInfo.subtitles?.includes(lang)).map((lang: string) => (
                      <div key={`ext-${lang}`} className="flex items-center gap-1.5 bg-white/5 px-2 py-1 rounded w-fit shrink-0">
                        <LanguageFlag lang={lang} />
                        <span className="text-[12.5px] font-bold text-white uppercase">{lang}</span>
                        <span className="text-[9px] font-bold text-[#A78BFA] bg-[#A78BFA]/10 px-1.5 py-0.5 rounded-sm">External</span>
                      </div>
                    ))}
                    {!(currentFileInfo.subtitles?.length > 0) && !(currentFileInfo.externalSubtitles?.length > 0) && externalSubs.length === 0 && (
                      <p className="text-[12.5px] font-bold text-white uppercase">None</p>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">File Size</p>
                  <p className="text-[12.5px] font-bold text-white uppercase">{formatSize(currentFileInfo.size)}</p>
                </div>
              </div>

              {/* Right Column: Chapters — matched to the File Info column height */}
              <div className="flex flex-col h-full min-h-0">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest">Chapters</p>
                  <div className="flex items-center gap-3">
                    <p className={`text-[9px] font-mono uppercase tracking-widest ${(currentFileInfo.chapters?.length ?? 0) <= 1 ? 'text-yellow-400' : 'text-white/30'}`}>
                      {currentFileInfo.chapters?.length ?? 0} embedded
                    </p>
                    {currentFileInfo.path && (
                      <button onClick={() => setFileMetadataMode('chapters')}
                        className="px-3 py-1 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white transition-all text-[9px] font-bold uppercase tracking-widest"
                        title="Edit chapter titles and timestamps">
                        ✎ Edit
                      </button>
                    )}
                  </div>
                </div>
                {(currentFileInfo.chapters?.length ?? 0) <= 1 && (
                  <p className="mt-2 text-[10px] font-mono text-yellow-400/70">
                    This file exposes {currentFileInfo.chapters?.length === 1 ? 'only one embedded chapter' : 'no embedded chapters'} in the container.
                  </p>
                )}
                {currentFileInfo.chapters?.length > 0 && (
                  <div className="mt-2 relative flex-1 min-h-[192px] rounded-xl border border-white/5 overflow-hidden">
                    {/* Absolute so a long chapter list fills — and scrolls within —
                        the File Info column's height rather than growing the row. */}
                    <div className="absolute inset-0 overflow-y-auto custom-scrollbar">
                      <table className="w-full text-[10.5px]">
                        <tbody>
                          {currentFileInfo.chapters.map((ch: { number: number; title: string; start: string }) => (
                            <tr key={ch.number} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                              <td className="py-2 px-4 text-white/30 font-mono w-12">{ch.number}</td>
                              <td className="py-2 px-4 text-white/80 font-medium">{ch.title}</td>
                              <td className="py-2 px-4 text-right text-[#00D4FF]/70 font-mono w-24">{ch.start}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              {fileMetadataMode && currentFileInfo.path && (
                <FileMetadataEditorModal
                  filePath={currentFileInfo.path}
                  mode={fileMetadataMode}
                  onClose={() => setFileMetadataMode(null)}
                  onSaved={() => fetchFilm()}
                />
              )}
            </div>
          </div>
        )}

        {/* Row 4: Acquisition Console / Active Download */}
        <div className="col-span-12 pt-8" id="acquisition-console">
          {film.status === 'acquiring' && activeTorrent ? (
            <ActiveDownload 
              torrent={activeTorrent} 
              onAction={fetchFilm}
              onDelete={() => {
                setFilm(prev => prev ? { ...prev, status: 'missing', info_hash: null } : null)
                setActiveTorrent(null)
              }}
            />
          ) : (
            <>
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-6 flex-1">
                  <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest whitespace-nowrap">Acquisition Console</h3>
                  <div className="h-px flex-1 bg-white/5" />
                </div>
              </div>

              <div className="mb-10">
                <QualityPolicyPanel
                  value={film as any}
                  onChange={patch => handlePolicyUpdate(patch as Partial<Movie>)}
                  action={
                    <button onClick={handleSearch} disabled={searching || film.scanMode === 'satisfied'}
                      title={film.scanMode === 'satisfied' ? 'Already at target quality' : undefined}
                      className="px-8 py-2.5 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20 transition-all font-bold tracking-widest text-[10.5px] uppercase disabled:opacity-30 whitespace-nowrap">
                      {searching
                        ? (film.scanMode === 'upgrade' ? 'Finding Upgrades...' : 'Querying Indexers...')
                        : (film.scanMode === 'upgrade' ? 'Scan for Upgrades' : 'Scan for Releases')}
                    </button>
                  }
                />
              </div>

              {/* Results Grid */}
              <div className="">
                {releases.length > 0 ? (
                  <div className="animate-slide-up">
                    <ReleaseList
                      releases={releases}
                      onGrab={handleDownload}
                      grabbing={grabbing}
                      grabbed={grabbed}
                    />
                  </div>
                ) : searching ? (
                  <div className="flex flex-col items-center justify-center py-32 space-y-6">
                    <Spinner className="w-16 h-16" />
                    <p className="text-[10px] font-mono text-white/20 uppercase tracking-[0.5em] animate-pulse">Scanning global p2p networks</p>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>

        {/* Row 5: Actions (Full Width) */}
        <div className="col-span-12 pt-8">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-6 flex-1">
              <h3 className="text-[10.5px] font-mono text-white/40 uppercase tracking-widest whitespace-nowrap">Actions</h3>
              <div className="h-px flex-1 bg-white/5" />
            </div>
          </div>
          <div className="rounded-2xl bg-noir-900/70 border border-white/5 px-4 py-4">
          <div ref={actionsRef} className="flex flex-wrap items-center gap-4">
            {film.status === 'collected' && film.file_path && (
              <>
                <button onClick={handleSearchSubtitles}
                  className="px-8 py-3 rounded-2xl bg-[#A78BFA]/10 border border-[#A78BFA]/20 text-[#A78BFA] hover:bg-[#A78BFA]/20 transition-all font-bold tracking-widest text-[10px] uppercase shadow-xl">
                  Fetch Subtitles
                </button>
                <button onClick={handleCleanTracks} disabled={cleaning}
                  className="px-8 py-3 rounded-2xl bg-[#00D4FF]/10 border border-[#00D4FF]/20 text-[#00D4FF] hover:bg-[#00D4FF]/20 transition-all font-bold tracking-widest text-[10px] uppercase disabled:opacity-40 shadow-xl">
                  {cleaning ? 'Cleaning...' : 'Clean Tracks'}
                </button>
              </>
            )}
            {(film.info_hash || film.current_release_title) && (
              <button onClick={handleRejectCurrent}
                className="px-8 py-3 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-all font-bold tracking-widest text-[10px] uppercase shadow-xl">
                Reject Current Release
              </button>
            )}
            <button onClick={handleRepairForReacquisition}
              className="px-8 py-3 rounded-2xl bg-white/5 border border-white/10 text-white/60 hover:text-white transition-all font-bold tracking-widest text-[10px] uppercase shadow-xl">
              Reacquire
            </button>
            <button onClick={loadAcquisitionHistory}
              className="px-8 py-3 rounded-2xl bg-white/5 border border-white/10 text-white/60 hover:text-white transition-all font-bold tracking-widest text-[10px] uppercase shadow-xl">
              Acquisitions
            </button>
            <button onClick={async () => { if (confirm('Remove this film from the library? Files on disk are kept.')) { await filmsApi.delete(film.id, false); onDelete(film.id); navigate('/films') } }}
              className="px-8 py-3 rounded-2xl bg-white/5 border border-white/10 text-white/60 hover:text-white transition-all font-bold tracking-widest text-[10px] uppercase shadow-xl">
              Remove
            </button>
            <button onClick={async () => { if (confirm('Delete this film AND its files from disk? This permanently removes the folder and cannot be undone.')) { await filmsApi.delete(film.id, true); onDelete(film.id); navigate('/films') } }}
              className="px-8 py-3 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-500 hover:bg-red-500/20 transition-all font-bold tracking-widest text-[10px] uppercase shadow-xl">
              Delete
            </button>
            <button onClick={() => setShowMetadataModal(true)}
              className="px-8 py-3 rounded-2xl bg-white/5 border border-white/10 text-white/60 hover:text-white transition-all font-bold tracking-widest text-[10px] uppercase shadow-xl ml-auto">
              Edit
            </button>
          </div>
          </div>
          {renamingEdition && (
        <EditionRenamerModal 
          edition={renamingEdition} 
          film={film} 
          onClose={() => setRenamingEdition(null)} 
          onSuccess={() => { setRenamingEdition(null); fetchFilm(); }} 
        />
      )}
      {historyOpen && acquisitionHistory && (
            <div className="mt-6 rounded-2xl bg-noir-950/70 border border-white/10 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
                <h4 className="text-[10px] font-mono uppercase tracking-widest text-white/40">Acquisition History</h4>
                <button onClick={() => setHistoryOpen(false)} className="text-[10px] font-mono text-white/30 hover:text-white">Close</button>
              </div>
              <div className="grid md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-white/5">
                <div className="p-5 space-y-3">
                  <p className="text-[9px] font-mono uppercase tracking-widest text-white/25">Release Blocks</p>
                  {acquisitionHistory.blocks.length ? acquisitionHistory.blocks.slice(0, 8).map(block => (
                    <div key={block.id} className="rounded-xl bg-amber-500/5 border border-amber-500/10 p-3">
                      <p className="text-xs text-white/70 truncate">{block.release_title}</p>
                      <p className="mt-1 text-[10px] font-mono text-amber-300/70">{block.reason}</p>
                    </div>
                  )) : <p className="text-xs text-white/25">No blocked releases for this item.</p>}
                </div>
                <div className="p-5 space-y-3">
                  <p className="text-[9px] font-mono uppercase tracking-widest text-white/25">Recent Decisions</p>
                  {acquisitionHistory.decisions.length ? acquisitionHistory.decisions.slice(0, 8).map(decision => (
                    <div key={decision.id} className="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                      <div className="flex items-center gap-2">
                        <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest ${decision.accepted ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                          {decision.accepted ? 'Accepted' : 'Rejected'}
                        </span>
                        {decision.grabbed ? <span className="text-[8px] px-1.5 py-0.5 rounded bg-[#00D4FF]/10 text-[#00D4FF] font-bold uppercase tracking-widest">Grabbed</span> : null}
                      </div>
                      <p className="mt-2 text-xs text-white/70 truncate">{decision.release_title}</p>
                      <p className="mt-1 text-[10px] font-mono text-white/25 truncate">{decision.rejection_reasons || decision.reasons}</p>
                    </div>
                  )) : <p className="text-xs text-white/25">No acquisition decisions recorded yet.</p>}
                </div>
              </div>
            </div>
          )}
        </div>

        </div>
      </div>

      {showMetadataModal && film && (
        <MetadataEditorModal film={film} onClose={() => { setShowMetadataModal(false); fetchFilm() }} />
      )}

      {/* Subtitle Search Modal */}
      {showSubtitleModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/90 animate-fade-in backdrop-blur-md" onClick={() => setShowSubtitleModal(false)}>
          <div className="relative w-full max-w-3xl bg-noir-950 rounded-3xl border border-white/10 shadow-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-8 py-6 border-b border-white/5">
              <div>
                <h2 className="text-sm font-bold text-white uppercase tracking-widest">Subtitle Search</h2>
                <p className="text-[10px] font-mono text-white/30 mt-1">{film?.title} ({film?.year})</p>
              </div>
              <button onClick={() => setShowSubtitleModal(false)}
                className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 text-white/40 hover:text-white flex items-center justify-center transition-all">
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-8 py-6 custom-scrollbar">
              {searchingSubs ? (
                <div className="flex flex-col items-center justify-center py-16 space-y-4">
                  <Spinner className="w-12 h-12" />
                  <p className="text-[10px] font-mono text-white/20 uppercase tracking-widest animate-pulse">Searching OpenSubtitles...</p>
                </div>
              ) : subtitleResults.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 space-y-4">
                  <div className="text-3xl opacity-10">CC</div>
                  <p className="text-[10px] font-mono text-white/20 uppercase tracking-widest">No subtitles found</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {subtitleResults.map(sub => (
                    <div key={sub.id} className="flex items-center gap-4 px-4 py-3 rounded-xl bg-white/[0.02] border border-white/5 hover:border-white/10 transition-all group">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white font-medium truncate">{sub.fileName}</p>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-[10px] font-mono text-white/30 uppercase">{sub.language}</span>
                          <span className="text-[10px] font-mono text-white">{sub.downloadCount.toLocaleString()} downloads</span>
                          {sub.hearingImpaired && <span className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-500/60 font-mono">HI</span>}
                          {sub.foreignPartsOnly && <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-500/60 font-mono">FORCED</span>}
                          {sub.rating > 0 && <span className="text-[10px] font-mono text-white">{sub.rating.toFixed(1)} rating</span>}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDownloadSubtitle(sub)}
                        disabled={downloadingSub === sub.id}
                        className="px-4 py-2 rounded-lg bg-[#A78BFA]/10 border border-[#A78BFA]/20 text-[#A78BFA] hover:bg-[#A78BFA]/20 transition-all text-[9px] font-bold uppercase tracking-widest disabled:opacity-40 flex-shrink-0">
                        {downloadingSub === sub.id ? 'Downloading...' : 'Download'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Trailer Modal */}
      {showTrailer && trailer && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/95 animate-fade-in backdrop-blur-md" onClick={() => setShowTrailer(false)}>
          <div className="relative w-full max-w-7xl aspect-video bg-black rounded-[40px] overflow-hidden shadow-[0_0_200px_rgba(0,212,255,0.2)] border border-white/10" onClick={e => e.stopPropagation()}>
            <iframe 
              src={`https://www.youtube.com/embed/${trailer.key}?autoplay=1&rel=0&modestbranding=1&iv_load_policy=3`}
              className="w-full h-full border-none"
              allow="autoplay; encrypted-media"
              allowFullScreen
            />
            <button 
              onClick={() => setShowTrailer(false)}
              className="absolute top-8 right-8 w-14 h-14 rounded-full bg-black/60 hover:bg-white/10 text-white flex items-center justify-center transition-all border border-white/10 backdrop-blur-xl group"
            >
              <span className="text-2xl group-hover:rotate-90 transition-transform">✕</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type CollectionFilter = 'all' | 'missing' | 'collected' | 'acquiring'

export function FilmsLibrary({ filmsContextReady }: { filmsContextReady: boolean }) {
  const [films, setFilms] = useState<Movie[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [collectionFilter, setCollectionFilter] = useState<CollectionFilter>('all')
  const [lastRedirect, setLastRedirect] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { param: routeSlug } = useParams<{ param?: string }>()
  const { activeTabId, tabs, setActiveTabForMedia } = useTabs()

  // When the URL is /films/<library-slug>, make that library the active one.
  useEffect(() => {
    if (!routeSlug || !tabs.length) return
    const lib = tabs.find(t => t.media_type === 'films' && librarySlug(t.name) === routeSlug)
    if (lib && lib.id !== activeTabId) setActiveTabForMedia('films', lib.id)
  }, [routeSlug, tabs, activeTabId])

  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId])
  const activeName = activeTab ? activeTab.name.replace(/Films/i, '').trim() : ''

  const refresh = (showLoading = true) => {
    if (showLoading) setLoading(true)
    filmsApi.list()
      .then(data => {
        const list = (Array.isArray(data) ? data : []).map(f => ({
          ...f,
          tmdbId: f.tmdbId ?? f.tmdb_id
        }))
        setFilms(list)
      })
      .catch(err => {
        console.error('Failed to load films:', err)
        setFilms([])
      })
      .finally(() => { if (showLoading) setLoading(false) })
  }

  useEffect(() => {
    if (!activeTabId) { setFilms([]); setLoading(false); return }
    if (!filmsContextReady) { setFilms([]); setLoading(true); return }
    const current = tabs.find(t => t.id === activeTabId)
    if (!current || current.media_type !== 'films') { setFilms([]); setLoading(true); return }
    setFilms([])
    refresh(true)
    const interval = setInterval(() => refresh(false), 5000)
    return () => clearInterval(interval)
  }, [activeTabId, tabs, filmsContextReady])

  const filmLibCount = useMemo(() => (Array.isArray(tabs) ? tabs.filter(t => t.media_type === 'films').length : 0), [tabs])
  const itemPath = (id: number) => (filmLibCount > 1 && activeTab ? `/films/${librarySlug(activeTab.name)}/${id}` : `/films/${id}`)

  const filtered = (Array.isArray(films) ? films : []).filter(film => {
    const title = film.title || ''
    if (search && !title.toLowerCase().includes(search.toLowerCase())) return false
    if (collectionFilter === 'missing' && film.status !== 'missing' && film.status !== 'wanted' && film.status !== 'uncollected') return false
    if (collectionFilter === 'collected' && film.status !== 'collected') return false
    if (collectionFilter === 'acquiring' && film.status !== 'acquiring') return false
    return true
  })

  // Auto-redirect to Add page if no local matches
  useEffect(() => {
    const cooldown = Date.now() - lastRedirect
    if (!loading && search.trim().length > 2 && filtered.length === 0 && !location.pathname.endsWith('/add') && cooldown > 5000) {
      const timer = setTimeout(() => {
        setLastRedirect(Date.now())
        const term = search
        setSearch('')
        navigate(`add?q=${encodeURIComponent(term)}`)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [search, filtered.length, loading, navigate, location.pathname, lastRedirect])

  return (
    <>
      <div className="mb-8 flex justify-between items-end">
        <div>
          <h1 className="font-display text-5xl tracking-widest text-[#00D4FF]">
            FILMS{activeName && activeName.toLowerCase() !== 'main' ? <span className="text-white/20 ml-4">({activeName.toUpperCase()})</span> : ''}
          </h1>
          <p className="text-[#00D4FF] text-[12.5px] mt-1 font-mono uppercase tracking-widest">
            <span className="text-white">{films.length}</span> {films.length === 1 ? 'film' : 'films'} in library
            {films.length > 0 && (() => {
              const collected = films.filter(f => f.status === 'collected').length
              const missing = films.filter(f => f.status === 'missing' || f.status === 'wanted' || f.status === 'uncollected').length
              const acquiring = films.filter(f => f.status === 'acquiring').length
              return <> | <span className="text-white">{collected}</span> {collected === 1 ? 'film' : 'films'} Collected | <span className="text-white">{missing}</span> {missing === 1 ? 'film' : 'films'} Missing{acquiring > 0 ? <> | <span className="text-white">{acquiring}</span> {acquiring === 1 ? 'film' : 'films'} Acquiring</> : ''}</>
            })()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {!editMode && (
            <button onClick={() => setEditMode(true)}
              className="px-6 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold tracking-widest hover:bg-white/10 transition-all uppercase">
              Edit Films
            </button>
          )}
          <Link to="add" className="px-6 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold tracking-widest hover:bg-white/10 transition-all uppercase">
            Add Film
          </Link>
        </div>
      </div>

      <div className="flex flex-col gap-4 mb-8">
        <div className="flex flex-col md:flex-row gap-4">
          <SearchInput value={search} onChange={setSearch} placeholder="Search library..." className="max-w-sm" />
          <CollectionFilterBar value={collectionFilter} onChange={setCollectionFilter} accentColor="[#00D4FF]" />
        </div>
        {editMode && (
          <SelectionBar
            totalCount={filtered.length}
            selectedCount={selected.size}
            onSelectAll={() => setSelected(new Set(filtered.map(f => f.id)))}
            onSelectNone={() => setSelected(new Set())}
            deleting={deleting}
            onDone={() => { setEditMode(false); setSelected(new Set()) }}
            onDelete={async () => {
              if (!confirm(`Delete ${selected.size} film(s) and all associated files?`)) return
              setDeleting(true)
              try {
                await Promise.all([...selected].map(id => filmsApi.delete(id)))
                setFilms(prev => prev.filter(f => !selected.has(f.id)))
                setSelected(new Set())
              } catch (err) { alert(String(err)) }
              finally { setDeleting(false) }
            }}
          />
        )}
      </div>

      {loading && films.length === 0 ? <PosterSkeleton /> : filtered.length === 0 ? (
        <EmptyState icon="🎬" title="NO FILMS FOUND" subtitle={search ? `No matches for "${search}"` : "Your library is empty"} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((f, i) => (
            <div key={f.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i * 30, 400)}ms`, animationFillMode: 'both' }}>
              <LibraryCard
                onClick={() => navigate(itemPath(f.id))}
                image={f.poster_path}
                title={`${f.title || 'Unknown'}${f.year ? ` (${f.year})` : ''}`}
                subtitle={f.studio || 'Studio'}
                status={f.status as any}
                badge={(f as any).loudnessMeasured
                  ? <span title="Loudness normalized" className="px-1 py-0.5 rounded bg-black/60 backdrop-blur-sm text-[10px] leading-none opacity-80">📶</span>
                  : undefined}
                accentColor="#00D4FF"
                fallbackIcon="🎬"
                selectionMode={editMode}
                selected={selected.has(f.id)}
                onSelect={() => setSelected(prev => {
                  const next = new Set(prev)
                  if (next.has(f.id)) next.delete(f.id)
                  else next.add(f.id)
                  return next
                })}
              />
            </div>
          ))}
        </div>
      )}

    </>
  )
}

function useEnsureFilmsTabContext(): boolean {
  const { tabs, activeTabId, getActiveTabForMedia, setActiveTabForMedia } = useTabs()
  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId])

  useEffect(() => {
    if (!tabs.length) return
    if (activeTab?.media_type === 'films') return

    const filmsTab = getActiveTabForMedia('films')
    if (filmsTab && filmsTab.id !== activeTabId) {
      setActiveTabForMedia('films', filmsTab.id)
    }
  }, [tabs, activeTabId, getActiveTabForMedia, setActiveTabForMedia])

  return activeTab?.media_type === 'films'
}

function FilmsHome({ filmsContextReady }: { filmsContextReady: boolean }) {
  const { tabs, getActiveTabForMedia } = useTabs()
  const filmLibs = (Array.isArray(tabs) ? tabs : []).filter(t => t.media_type === 'films')
  // With more than one library, /films redirects to the active library's slug URL.
  if (filmLibs.length > 1) {
    const active = getActiveTabForMedia('films') || filmLibs[0]
    return <Navigate to={`/films/${librarySlug(active.name)}`} replace />
  }
  return <FilmsLibrary filmsContextReady={filmsContextReady} />
}

// A single dynamic segment after /films: a numeric value is an item page,
// anything else is a library-slug page.
function FilmsParamDispatch({ filmsContextReady }: { filmsContextReady: boolean }) {
  const { param } = useParams<{ param?: string }>()
  if (/^\d+$/.test(param || '')) return <FilmDetailPage onDelete={() => {}} filmsContextReady={filmsContextReady} />
  return <FilmsLibrary filmsContextReady={filmsContextReady} />
}

export function FilmsPage() {
  const filmsContextReady = useEnsureFilmsTabContext()

  return (
    <Routes>
      <Route index element={<FilmsHome filmsContextReady={filmsContextReady} />} />
      <Route path="add" element={<AddFilmSection filmsContextReady={filmsContextReady} />} />
      <Route path=":slug/add" element={<AddFilmSection filmsContextReady={filmsContextReady} />} />
      <Route path=":slug/:id" element={<FilmDetailPage onDelete={() => {}} filmsContextReady={filmsContextReady} />} />
      <Route path=":param" element={<FilmsParamDispatch filmsContextReady={filmsContextReady} />} />
    </Routes>
  )
}

function FilmModal({ film, onClose, onConfirm, isAdding }: {
  film: any; onClose: () => void; onConfirm: (prefs: { tier: string, resolution: string, source: string, codec: string, tabId: number }) => void; isAdding: boolean
}) {
  const { tabs, activeTabId } = useTabs()
  const filmTabs = useMemo(() => (Array.isArray(tabs) ? tabs : []).filter(t => t.media_type === 'films'), [tabs])
  
  const [tier, setTier] = useState('Any')
  const [resolution, setResolution] = useState('Any')
  const [source, setSource] = useState('Any')
  const [codec, setCodec] = useState('Any')
  const [targetTabId, setTargetTabId] = useState<number>(0)

  // Sync targetTabId when filmTabs or activeTabId changes
  useEffect(() => {
    if (activeTabId && filmTabs.some(t => t.id === activeTabId)) {
      setTargetTabId(activeTabId)
    } else if (filmTabs.length > 0) {
      setTargetTabId(filmTabs[0].id)
    }
  }, [filmTabs, activeTabId])

  useEffect(() => {
    if (!targetTabId) return
    sharedApi.settings.getAcquisitionDefaults(targetTabId).then(defaults => {
      if (!defaults) return
      if (defaults.tier) setTier(defaults.tier)
      if (defaults.resolution) setResolution(defaults.resolution)
      if (defaults.source) setSource(defaults.source)
      if (defaults.codec) setCodec(defaults.codec)
    }).catch(() => {})
  }, [targetTabId])

  if (!film) return null

  return (
    <Modal title={`Add ${film.title || 'Film'}`} onClose={onClose}>
      <div className="space-y-6">
        {filmTabs.length > 1 && (
          <div className="p-4 rounded-xl bg-[#00D4FF]/5 border border-[#00D4FF]/10">
            <p className="text-[10px] font-mono text-[#00D4FF] uppercase tracking-widest mb-3">Target Library Tab</p>
            <div className="flex flex-wrap gap-2">
              {filmTabs.map(t => (
                <button key={t.id} onClick={() => setTargetTabId(t.id)}
                  className={`px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all border ${
                    targetTabId === t.id ? 'bg-[#00D4FF] text-noir-950 border-[#00D4FF]' : 'bg-white/5 text-white/40 border-white/5 hover:border-white/10'
                  }`}>
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest px-1">Acquisition Defaults</p>
        
        <div className="grid grid-cols-1 gap-6">
          <TabSelect label="Tier" value={tier} options={['Any', 'Tier 1', 'Tier 2', 'Tier 3']} onChange={setTier} />
          <TabSelect label="Resolution" value={resolution} options={['Any', '2160p', '1080p', '720p']} onChange={setResolution} />
          <TabSelect label="Source" value={source} options={['Any', 'BluRay', 'Web', 'DVD']} onChange={setSource} />
          <TabSelect label="Codec" value={codec} options={['Any', 'Remux', 'AV1', 'x265', 'x264']} onChange={setCodec} />
        </div>

        <div className="flex justify-end pt-4 border-t border-white/5">
          <div className="flex gap-3">
            <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest">Cancel</button>
            <button 
              onClick={() => onConfirm({ tier, resolution, source, codec, tabId: targetTabId })}
              disabled={isAdding || !targetTabId}
              className="px-8 py-2.5 rounded-xl bg-[#00D4FF] text-noir-950 font-bold text-xs uppercase tracking-widest transition-all shadow-xl disabled:opacity-50"
            >
              {isAdding ? 'Adding...' : 'Confirm Add to Tab'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function AddFilmSection({ filmsContextReady }: { filmsContextReady: boolean }) {
  const { activeTabId } = useTabs()
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [results, setResults] = useState<TmdbResult[]>([])
  const [searching, setSearching] = useState(false)
  const [added, setAdded] = useState<Set<number>>(new Set())
  const [addingFilm, setAddingFilm] = useState<any | null>(null)
  const [detailFilm, setDetailFilm] = useState<any | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const timer = useRef<any>()
  const navigate = useNavigate()

  useEffect(() => {
    if (!filmsContextReady) { setResults([]); setSearching(false); return }
    if (!query.trim()) { setResults([]); return }
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setSearching(true)
      try { 
        const data = await filmsApi.lookup(query)
        setResults(Array.isArray(data) ? data : [])
      }
      catch (err) { console.error(err) }
      finally { setSearching(false) }
    }, 500)
    return () => clearTimeout(timer.current)
  }, [query, filmsContextReady])

  const handleConfirmAddFilm = (prefs: { tier: string, resolution: string, source: string, codec: string, tabId: number }) => {
    if (!addingFilm) return
    const tmdbId = addingFilm.tmdbId
    // Optimistic: mark added and close the picker instantly; the backend creates
    // the folder and downloads artwork in the background.
    setAdded(prev => new Set(prev).add(tmdbId))
    setAddingFilm(null)
    // Use requestWithTab to send the request with the correct tab context
    // without mutating the global tab state
    requestWithTab<Movie>(prefs.tabId, '/films', {
      method: 'POST',
      body: JSON.stringify({
        tmdbId,
        target_tier: prefs.tier,
        target_resolution: prefs.resolution,
        target_source: prefs.source,
        target_codec: prefs.codec
      })
    }).catch(err => {
      alert(String(err))
      setAdded(prev => { const next = new Set(prev); next.delete(tmdbId); return next })
    })
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-8 flex items-center gap-4">
        <button onClick={() => navigate('/films')} className="text-white/30 hover:text-white transition-all text-sm font-mono uppercase tracking-widest">← Back</button>
        <div className="h-4 w-px bg-white/10" />
        <h1 className="font-display text-3xl tracking-widest text-[#00D4FF]">ADD FILM</h1>
      </div>

      <div className="max-w-xl mb-12">
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} 
          placeholder="Search metadata for a film..." autoFocus
          className="w-full px-4 py-3 rounded-xl bg-noir-800 border border-white/10 text-white focus:outline-none focus:border-[#00D4FF]/40 transition-all shadow-lg" />
      </div>

      {searching ? <PosterSkeleton /> : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {(Array.isArray(results) ? results : []).map((f, i) => {
            const isAdded = added.has(f.tmdbId) || f.alreadyAdded
            return (
              <div key={f.tmdbId} className="animate-slide-up" style={{ animationDelay: `${Math.min(i * 30, 400)}ms`, animationFillMode: 'both' }}>
                <LibraryCard
                  onClick={() => setDetailFilm(f)}
                  image={tmdbImage(f.posterPath)}
                  title={`${f.title || 'Unknown'}${f.year ? ` (${f.year})` : ''}`}
                  subtitle={f.studio || 'Studio'}
                  accentColor="#00D4FF"
                  fallbackIcon="🎬"
                  badge={
                  <button onClick={e => { e.stopPropagation(); !isAdded && setAddingFilm(f) }} disabled={isAdded || (isAdding && addingFilm?.tmdbId !== f.tmdbId)}
                    className={`px-3 py-1 rounded-lg text-[10.5px] font-bold uppercase tracking-widest border transition-all ${isAdded ? 'bg-green-500/10 border-green-500/20 text-green-500' : 'bg-noir-950/60 border-white/10 text-white hover:bg-white/10'}`}>
                    {isAdded ? '✓ In Library' : '+ Add'}
                  </button>
                  }                />
              </div>
            )
          })}
        </div>
      )}

      {detailFilm && (
        <SearchDetailModal
          onClose={() => setDetailFilm(null)}
          onAdd={() => setAddingFilm(detailFilm)}
          isAdded={added.has(detailFilm.tmdbId) || detailFilm.alreadyAdded}
          accentColor="#00D4FF"
          fallbackIcon="🎬"
          image={tmdbImage(detailFilm.posterPath)}
          backdrop={tmdbImage(detailFilm.backdropPath, 'w1280')}
          title={detailFilm.title || 'Unknown'}
          year={detailFilm.year}
          rating={detailFilm.rating}
          genres={detailFilm.genres || []}
          overview={detailFilm.overview}
          addLabel="Add to Library"
          facts={[
            { label: 'Studio', value: detailFilm.studio },
            { label: 'Runtime', value: detailFilm.runtime ? `${detailFilm.runtime} min` : null },
            { label: 'Original Title', value: detailFilm.original_title && detailFilm.original_title !== detailFilm.title ? detailFilm.original_title : null },
          ]}
        />
      )}

      {addingFilm && (
        <FilmModal
          film={addingFilm}
          onClose={() => setAddingFilm(null)}
          onConfirm={handleConfirmAddFilm}
          isAdding={isAdding}
        />
      )}
    </div>
  )
}

function MetadataEditorModal({ film, onClose }: { film: Movie, onClose: () => void }) {
  const [tab, setTab] = useState<'text' | 'images'>('text')
  const [formData, setFormData] = useState({
    title: film.title,
    original_title: film.original_title || '',
    year: film.year || '',
    overview: film.overview || '',
    genres: (film.genres || []).join(', '),
    certification: film.certification || '',
    studio: film.studio || '',
    runtime: film.runtime || '',
    country: film.country || '',
    rating: film.rating || '',
  })
  const [saving, setSaving] = useState(false)

  // Image tab state
  const [imageType, setImageType] = useState('poster')
  const [language, setImageLanguage] = useState('en')
  const [imageResults, setImageResults] = useState<any[]>([])
  const [searchingImages, setSearchingImages] = useState(false)
  const [savingImage, setSavingImage] = useState<string | null>(null)

  useEffect(() => {
    if (tab === 'images') {
      searchImages()
    }
  }, [tab, imageType, language])

  const searchImages = async () => {
    setSearchingImages(true)
    try {
      const results = await filmsApi.searchImages(film.id, imageType, language)
      setImageResults(results)
    } catch (err) {
      console.error(err)
    } finally {
      setSearchingImages(false)
    }
  }

  const handleSaveText = async () => {
    setSaving(true)
    try {
      const data = {
        ...formData,
        year: formData.year ? parseInt(String(formData.year)) : null,
        runtime: formData.runtime ? parseInt(String(formData.runtime)) : null,
        rating: formData.rating ? parseFloat(String(formData.rating)) : null,
        genres: formData.genres.split(',').map(s => s.trim()).filter(Boolean)
      }
      await filmsApi.updateMetadata(film.id, data)
      onClose()
    } catch (err) {
      alert(String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleSaveImage = async (url: string) => {
    setSavingImage(url)
    try {
      await filmsApi.saveImage(film.id, imageType, url)
      // Refresh results or show success
      alert(`${imageType.toUpperCase()} updated successfully`)
    } catch (err) {
      alert(String(err))
    } finally {
      setSavingImage(null)
    }
  }

  return (
    <Modal title={`Edit Metadata: ${film.title}`} onClose={onClose} width="max-w-4xl">
      <div className="flex flex-col h-[70vh]">
        {/* Tabs */}
        <div className="flex gap-1.5 p-1 bg-noir-900 border border-white/5 rounded-xl w-fit mb-6">
          {(['text', 'images'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-6 py-2 rounded-lg text-[10px] font-bold tracking-widest uppercase transition-all ${
                tab === t ? 'bg-white/10 text-[#00D4FF]' : 'text-white/30 hover:text-white/60'
              }`}>
              {t}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
          {tab === 'text' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <Field label="Title">
                  <Input value={formData.title} onChange={e => setFormData({ ...formData, title: e.target.value })} />
                </Field>
                <Field label="Original Title">
                  <Input value={formData.original_title} onChange={e => setFormData({ ...formData, original_title: e.target.value })} />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Year">
                    <Input type="number" value={formData.year} onChange={e => setFormData({ ...formData, year: e.target.value })} />
                  </Field>
                  <Field label="Runtime (mins)">
                    <Input type="number" value={formData.runtime} onChange={e => setFormData({ ...formData, runtime: e.target.value })} />
                  </Field>
                </div>
                <Field label="Genres (comma separated)">
                  <Input value={formData.genres} onChange={e => setFormData({ ...formData, genres: e.target.value })} />
                </Field>
              </div>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Certification">
                    <Input value={formData.certification} onChange={e => setFormData({ ...formData, certification: e.target.value })} />
                  </Field>
                  <Field label="Rating">
                    <Input type="number" step="0.1" value={formData.rating} onChange={e => setFormData({ ...formData, rating: e.target.value })} />
                  </Field>
                </div>
                <Field label="Studio">
                  <Input value={formData.studio} onChange={e => setFormData({ ...formData, studio: e.target.value })} />
                </Field>
                <Field label="Country (ISO Code)">
                  <Input value={formData.country} onChange={e => setFormData({ ...formData, country: e.target.value })} />
                </Field>
                <div className="space-y-1.5">
                  <label className="block text-[10px] font-mono uppercase tracking-wider text-white/40">Overview</label>
                  <textarea 
                    value={formData.overview} 
                    onChange={e => setFormData({ ...formData, overview: e.target.value })}
                    className="w-full h-32 px-4 py-3 rounded-xl bg-black border border-white/10 text-white/90 text-sm focus:outline-none focus:border-white/30 transition-all custom-scrollbar resize-none"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-6">
                <div className="flex items-center gap-3">
                  <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Type</span>
                  <div className="flex gap-1 bg-noir-900 p-1 rounded-xl border border-white/5">
                    {['poster', 'backdrop', 'logo', 'banner', 'clearart', 'thumb', 'disc'].map(opt => (
                      <button key={opt} onClick={() => setImageType(opt)}
                        className={`px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-widest transition-all ${
                          imageType === opt ? 'bg-[#00D4FF] text-noir-950 shadow-lg' : 'text-white/30 hover:text-white/60'
                        }`}>
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Lang</span>
                  <select value={language} onChange={e => setImageLanguage(e.target.value)}
                    className="bg-noir-900 border border-white/10 rounded-lg px-2 py-1 text-[10px] font-bold text-white uppercase tracking-widest outline-none focus:border-[#00D4FF]/50 transition-all">
                    <option value="en">English</option>
                    <option value="ja">Japanese</option>
                    <option value="ko">Korean</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="es">Spanish</option>
                    <option value="it">Italian</option>
                    <option value="pt">Portuguese</option>
                    <option value="ru">Russian</option>
                    <option value="zh">Chinese</option>
                    <option value="null">No Language</option>
                  </select>
                </div>
              </div>

              {searchingImages ? (
                <div className="flex flex-col items-center justify-center py-20 space-y-4">
                  <Spinner className="w-12 h-12" />
                  <p className="text-[10px] font-mono text-white/20 uppercase tracking-widest animate-pulse">Fetching global assets...</p>
                </div>
              ) : imageResults.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 opacity-20">
                  <span className="text-4xl mb-4">🖼️</span>
                  <p className="text-[10px] font-mono uppercase tracking-widest">No images found for this criteria</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {imageResults.map((img, i) => (
                    <div key={i} className={`relative bg-noir-900 rounded-xl border border-white/10 overflow-hidden group hover:border-[#00D4FF]/40 transition-all ${imageType === 'banner' ? 'col-span-2' : ''}`}
                      style={
                        ['backdrop', 'logo', 'clearart', 'thumb'].includes(imageType) ? { aspectRatio: '16/9' } : 
                        imageType === 'banner' ? { aspectRatio: '6/1' } :
                        imageType === 'disc' ? { aspectRatio: '1/1' } : { aspectRatio: '2/3' }
                      }>
                      <img src={img.url} className={`w-full h-full ${['logo', 'clearart', 'disc'].includes(imageType) ? 'object-contain p-4' : 'object-cover'}`} alt="" />
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center p-4 text-center">
                        <p className="text-[10px] font-mono text-white/40 uppercase mb-1">{img.source}</p>
                        {img.width && <p className="text-[10px] font-mono text-white/60 mb-4">{img.width} x {img.height}</p>}
                        <button 
                          onClick={() => handleSaveImage(img.url)}
                          disabled={!!savingImage}
                          className="px-4 py-2 rounded-lg bg-[#00D4FF] text-noir-950 text-[10px] font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95 disabled:opacity-50">
                          {savingImage === img.url ? 'Saving...' : 'Set as Current'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {tab === 'text' && (
          <div className="flex justify-end gap-3 pt-6 border-t border-white/5 mt-auto">
            <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest">Cancel</button>
            <button onClick={handleSaveText} disabled={saving}
              className="px-8 py-2.5 rounded-xl bg-[#00D4FF] text-noir-950 font-bold text-xs uppercase tracking-widest transition-all shadow-xl disabled:opacity-50">
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
