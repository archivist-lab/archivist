import { useEffect, useState } from 'react'
import { toast } from '../../lib/notify.js'
import { sharedApi, type ManualImportCandidate, type ManualImportItem } from '../../lib/shared.api.js'
import { formatSize } from '../../lib/api.js'
import { Field, Input, Modal, Select, Spinner } from '../../components/ui.js'
import { TorrentsPage } from '../torrents/TorrentsPage.js'

type View = 'imports' | 'torrents'

export function AcquisitionsPage() {
  const [view, setView] = useState<View>('torrents')
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl text-white uppercase tracking-widest">Acquisitions</h1>
          <p className="text-xs text-white/30 font-mono mt-1">Review downloads, import matches, and torrent state</p>
        </div>
        <div className="flex gap-1 bg-noir-900 border border-white/5 rounded-xl p-1">
          {(['torrents', 'imports'] as View[]).map(opt => (
            <button key={opt} onClick={() => setView(opt)}
              className={`px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${
                view === opt ? 'bg-[#00D4FF] text-noir-950' : 'text-white/35 hover:text-white'
              }`}>
              {opt}
            </button>
          ))}
        </div>
      </div>
      {view === 'imports' ? <ManualImportReview /> : <TorrentsPage />}
    </div>
  )
}

function ManualImportReview() {
  const [downloadDir, setDownloadDir] = useState('')
  const [items, setItems] = useState<ManualImportItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ManualImportItem | null>(null)
  const [queued, setQueued] = useState<Set<string>>(new Set())

  const load = async () => {
    setLoading(true)
    try {
      const data = await sharedApi.system.manualImportCandidates()
      setDownloadDir(data.downloadDir)
      setItems(data.items)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load().catch(console.error) }, [])

  const queue = async (item: ManualImportItem, candidate: ManualImportCandidate, releaseTitle?: string) => {
    const result = await sharedApi.system.queueManualImport({
      tabId: candidate.tabId,
      mediaType: candidate.mediaType,
      itemId: candidate.itemId,
      sourcePath: item.sourcePath,
      releaseTitle: releaseTitle || item.name,
    })
    if (result.success) setQueued(prev => new Set([...prev, item.sourcePath]))
    setSelected(null)
    await load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-2xl bg-noir-900 border border-white/5 px-5 py-4">
        <div className="min-w-0">
          <p className="text-[9px] font-mono text-white/25 uppercase tracking-widest">Staging Folder</p>
          <p className="text-xs font-mono text-white/55 truncate">{downloadDir || './data/downloads'}</p>
        </div>
        <button onClick={() => load().catch(console.error)} disabled={loading}
          className="px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/45 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-40">
          {loading ? 'Scanning' : 'Rescan'}
        </button>
      </div>

      {loading ? (
        <div className="py-24 flex justify-center"><Spinner className="w-12 h-12" /></div>
      ) : items.length === 0 ? (
        <div className="py-24 text-center rounded-2xl bg-noir-900/50 border border-white/5">
          <p className="text-sm text-white/35 font-mono">No staged downloads found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {items.map(item => {
            const best = item.candidates[0]
            return (
              <div key={item.sourcePath} className="rounded-2xl bg-noir-900 border border-white/5 p-4 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm text-white/80 font-medium truncate">{item.name}</p>
                    <p className="mt-1 text-[10px] font-mono text-white/25">
                      {item.size ? formatSize(item.size) : 'folder'} · {new Date(item.modifiedAt).toLocaleString()}
                    </p>
                  </div>
                  {queued.has(item.sourcePath) && <span className="text-[9px] font-bold uppercase tracking-widest text-emerald-400">Queued</span>}
                </div>

                {best ? (
                  <button onClick={() => queue(item, best).catch(err => toast.error(String(err)))}
                    className="w-full text-left rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/20 px-4 py-3 hover:bg-[#00D4FF]/15 transition-all">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs text-[#00D4FF] font-bold uppercase tracking-widest truncate">{best.title}</p>
                        <p className="mt-1 text-[10px] font-mono text-white/35 truncate">{best.tabName} · {best.mediaType} · {best.subtitle ?? best.status ?? ''}</p>
                      </div>
                      <span className="text-[10px] font-mono text-[#00D4FF]">{best.score}%</span>
                    </div>
                  </button>
                ) : (
                  <div className="rounded-xl bg-white/[0.02] border border-white/5 px-4 py-3 text-xs text-white/30 font-mono">No confident match</div>
                )}

                <button onClick={() => setSelected(item)}
                  className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/45 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-all">
                  Review Match
                </button>
              </div>
            )
          })}
        </div>
      )}

      {selected && <ManualImportModal item={selected} onClose={() => setSelected(null)} onQueue={queue} />}
    </div>
  )
}

function ManualImportModal({ item, onClose, onQueue }: {
  item: ManualImportItem
  onClose: () => void
  onQueue: (item: ManualImportItem, candidate: ManualImportCandidate, releaseTitle?: string) => Promise<void>
}) {
  const [candidateId, setCandidateId] = useState(item.candidates[0] ? candidateKey(item.candidates[0]) : '')
  const [releaseTitle, setReleaseTitle] = useState(item.name)
  const [saving, setSaving] = useState(false)
  const candidate = item.candidates.find(c => candidateKey(c) === candidateId)

  const submit = async () => {
    if (!candidate) return
    setSaving(true)
    try {
      await onQueue(item, candidate, releaseTitle)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Review Import" onClose={onClose} width="max-w-3xl">
      <div className="space-y-5">
        <div className="rounded-xl bg-white/[0.02] border border-white/5 px-4 py-3">
          <p className="text-xs text-white/75 truncate">{item.name}</p>
          <p className="mt-1 text-[10px] font-mono text-white/25 truncate">{item.sourcePath}</p>
        </div>

        <Field label="Release Title">
          <Input value={releaseTitle} onChange={e => setReleaseTitle(e.target.value)} />
        </Field>

        <Field label="Library Match">
          <Select value={candidateId} onChange={e => setCandidateId(e.target.value)}>
            {item.candidates.length === 0 && <option value="">No candidates found</option>}
            {item.candidates.map(c => (
              <option key={candidateKey(c)} value={candidateKey(c)}>
                {c.score}% · {c.tabName} · {c.mediaType} · {c.title}
              </option>
            ))}
          </Select>
        </Field>

        {candidate && (
          <div className="rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/20 px-4 py-3">
            <p className="text-sm text-[#00D4FF] font-bold uppercase tracking-widest">{candidate.title}</p>
            <p className="mt-1 text-xs text-white/45">{candidate.subtitle || candidate.status}</p>
          </div>
        )}

        <button onClick={submit} disabled={!candidate || saving}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-[#00D4FF] text-noir-950 text-[10px] font-bold uppercase tracking-widest hover:bg-[#00D4FF]/80 transition-all disabled:opacity-40">
          {saving ? <Spinner className="w-4 h-4" /> : null} Queue Import
        </button>
      </div>
    </Modal>
  )
}

function candidateKey(c: ManualImportCandidate) {
  return `${c.tabId}:${c.mediaType}:${c.itemId}`
}
