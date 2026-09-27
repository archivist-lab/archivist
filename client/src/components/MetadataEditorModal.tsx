import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ImagePage, ImageQuery } from '../lib/api.js'
import { toast } from '../lib/notify.js'
import { Modal, Field, Input, Spinner } from './ui.js'

export interface MetadataFieldSpec {
  key: string
  label: string
  /** text (default) | number | float | csv (comma-separated → array) | textarea | date | time */
  type?: 'text' | 'number' | 'float' | 'csv' | 'textarea' | 'date' | 'time'
  /** Span both columns of the grid. */
  wide?: boolean
}

export interface ImageCandidate {
  url: string
  source: string
  type?: string
  language?: string
  width?: number
  height?: number
}

export interface ImageEditorSpec {
  /** Image slots offered by this domain, e.g. ['poster','backdrop','logo']. */
  types: string[]
  /** One page of candidates: `offset` continues the previous page, `source` narrows to one provider. */
  search: (type: string, query: ImageQuery) => Promise<ImagePage<ImageCandidate>>
  save: (type: string, url: string) => Promise<unknown>
  /**
   * Overrides the shape of the candidate tiles. A domain whose "poster" is not
   * poster-shaped needs this — album art is square, not 2:3.
   */
  aspect?: React.CSSProperties['aspectRatio']
}

export interface MetadataEditorTabSpec {
  id: string
  label: string
  content: ReactNode
}

function toInputValue(value: unknown, type: MetadataFieldSpec['type']): string {
  if (value === null || value === undefined) return ''
  if (type === 'csv' && Array.isArray(value)) return value.join(', ')
  return String(value)
}

function fromInputValue(value: string, type: MetadataFieldSpec['type']): unknown {
  const trimmed = value.trim()
  if (trimmed === '') return null // COALESCE no-op on the backend
  if (type === 'number') {
    const n = parseInt(trimmed, 10)
    return Number.isFinite(n) ? n : null
  }
  if (type === 'float') {
    const n = parseFloat(trimmed)
    return Number.isFinite(n) ? n : null
  }
  if (type === 'csv')
    return trimmed
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  return value
}

function aspectFor(type: string): React.CSSProperties {
  if (['backdrop', 'logo', 'clearart', 'thumb', 'screenshot'].includes(type)) return { aspectRatio: '16/9' }
  if (type === 'banner') return { aspectRatio: '6/1' }
  if (type === 'disc') return { aspectRatio: '1/1' }
  return { aspectRatio: '2/3' }
}

/**
 * Generic metadata editor used by every media domain. Mirrors the films
 * metadata editor (text + images tabs) so the editing experience is identical
 * across item pages. The images tab also accepts a pasted custom URL.
 */
export function MetadataEditorModal({
  title,
  fields,
  initial,
  onSave,
  onClose,
  images,
  extraTabs = [],
}: {
  title: string
  fields: MetadataFieldSpec[]
  initial: Record<string, unknown>
  onSave: (data: Record<string, unknown>) => Promise<void>
  onClose: () => void
  images?: ImageEditorSpec
  extraTabs?: MetadataEditorTabSpec[]
}) {
  const [tab, setTab] = useState('text')
  const [formData, setFormData] = useState<Record<string, string>>(() => {
    const state: Record<string, string> = {}
    for (const f of fields) state[f.key] = toInputValue(initial[f.key], f.type)
    return state
  })
  const [saving, setSaving] = useState(false)

  // Images tab state
  const [imageType, setImageType] = useState(images?.types[0] ?? 'poster')
  const [imageResults, setImageResults] = useState<ImageCandidate[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [totalImages, setTotalImages] = useState(0)
  const [imageSources, setImageSources] = useState<Array<{ source: string; count: number }>>([])
  const [imageWarnings, setImageWarnings] = useState<string[]>([])
  const [source, setSource] = useState<string | null>(null)
  const [searchingImages, setSearchingImages] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [savingImage, setSavingImage] = useState<string | null>(null)
  const [customUrl, setCustomUrl] = useState('')
  // Bumped on every new search so a slow first page can't land on a later type.
  const searchGeneration = useRef(0)
  // Callers build the spec inline, so a fresh object arrives on every render —
  // read it through a ref rather than making the search effect depend on it.
  const imagesRef = useRef(images)
  imagesRef.current = images

  useEffect(() => {
    const spec = imagesRef.current
    if (tab !== 'images' || !spec) return
    const generation = ++searchGeneration.current
    setSearchingImages(true)
    setImageResults([])
    setNextOffset(null)
    setTotalImages(0)
    spec
      .search(imageType, { offset: 0, ...(source ? { source } : {}) })
      .then(page => {
        if (generation !== searchGeneration.current) return
        setImageResults(page.items)
        setNextOffset(page.nextOffset)
        setTotalImages(page.total ?? page.items.length)
        setImageSources(page.sources ?? [])
        setImageWarnings(page.warnings ?? [])
      })
      .catch(err => {
        if (generation !== searchGeneration.current) return
        console.error(err)
      })
      .finally(() => { if (generation === searchGeneration.current) setSearchingImages(false) })
  }, [tab, imageType, source])

  const loadMoreImages = async () => {
    if (!images || nextOffset === null || loadingMore) return
    const generation = searchGeneration.current
    setLoadingMore(true)
    try {
      const page = await images.search(imageType, { offset: nextOffset, ...(source ? { source } : {}) })
      if (generation !== searchGeneration.current) return
      setImageResults(current => [...current, ...page.items.filter(item => !current.some(seen => seen.url === item.url))])
      setNextOffset(page.nextOffset)
      setTotalImages(page.total ?? 0)
    } catch (err) {
      toast.error(String(err))
    } finally {
      if (generation === searchGeneration.current) setLoadingMore(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const data: Record<string, unknown> = {}
      for (const f of fields) data[f.key] = fromInputValue(formData[f.key] ?? '', f.type)
      await onSave(data)
      onClose()
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleSaveImage = async (url: string) => {
    if (!images) return
    setSavingImage(url)
    try {
      await images.save(imageType, url)
      toast.success(`${imageType.toUpperCase()} updated successfully`)
      if (url === customUrl.trim()) setCustomUrl('')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSavingImage(null)
    }
  }

  const narrow = fields.filter(f => !f.wide && f.type !== 'textarea')
  const wide = fields.filter(f => f.wide || f.type === 'textarea')
  const tabs = [
    { id: 'text', label: 'Metadata' },
    ...(images ? [{ id: 'images', label: 'Images' }] : []),
    ...extraTabs.map(extra => ({ id: extra.id, label: extra.label })),
  ]
  const extraTab = extraTabs.find(extra => extra.id === tab)

  return (
    <Modal title={`Edit Metadata: ${title}`} onClose={onClose} width="max-w-4xl">
      <div className="flex flex-col max-h-[70vh]">
        {tabs.length > 1 && (
          <div className="flex gap-1.5 p-1 bg-noir-900 border border-white/5 rounded-xl w-fit mb-6">
            {tabs.map(option => (
              <button
                key={option.id}
                onClick={() => setTab(option.id)}
                className={`px-6 py-2 rounded-lg text-[10px] font-bold tracking-widest uppercase transition-all ${
                  tab === option.id ? 'bg-white/10 text-[#00D4FF]' : 'text-white/30 hover:text-white/60'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
          {tab === 'text' ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {narrow.map(f => (
                  <Field key={f.key} label={f.label}>
                    <Input
                      type={f.type === 'number' || f.type === 'float' ? 'number' : f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : 'text'}
                      step={f.type === 'float' ? '0.1' : undefined}
                      value={formData[f.key] ?? ''}
                      onChange={e => setFormData({ ...formData, [f.key]: e.target.value })}
                    />
                  </Field>
                ))}
              </div>
              {wide.map(f => (
                <div key={f.key} className="space-y-1.5 mt-4">
                  <label className="block text-[10px] font-mono uppercase tracking-wider text-white/40">{f.label}</label>
                  {f.type === 'textarea' ? (
                    <textarea
                      value={formData[f.key] ?? ''}
                      onChange={e => setFormData({ ...formData, [f.key]: e.target.value })}
                      className="w-full h-32 px-4 py-3 rounded-xl bg-black border border-white/10 text-white/90 text-sm focus:outline-none focus:border-white/30 transition-all custom-scrollbar resize-none"
                    />
                  ) : (
                    <Input value={formData[f.key] ?? ''} onChange={e => setFormData({ ...formData, [f.key]: e.target.value })} />
                  )}
                </div>
              ))}
            </>
          ) : tab === 'images' && images ? (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-6">
                <div className="flex items-center gap-3">
                  <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Type</span>
                  <div className="flex gap-1 bg-noir-900 p-1 rounded-xl border border-white/5">
                    {images.types.map(opt => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => { setImageType(opt); setSource(null) }}
                        className={`px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-widest transition-all ${
                          imageType === opt ? 'bg-[#00D4FF] text-noir-950 shadow-lg' : 'text-white/30 hover:text-white/60'
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>

                {imageSources.length > 0 && (
                  <div className="flex items-center gap-3">
                    <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Source</span>
                    <div className="flex flex-wrap gap-1 bg-noir-900 p-1 rounded-xl border border-white/5">
                      {[{ source: 'all', count: imageSources.reduce((sum, entry) => sum + entry.count, 0) }, ...imageSources].map(entry => {
                        const active = entry.source === 'all' ? source === null : source === entry.source
                        return (
                          <button
                            key={entry.source}
                            type="button"
                            onClick={() => setSource(entry.source === 'all' ? null : entry.source)}
                            className={`px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-widest transition-all ${
                              active ? 'bg-[#00D4FF] text-noir-950 shadow-lg' : 'text-white/30 hover:text-white/60'
                            }`}
                          >
                            {entry.source} <span className="opacity-60">{entry.count}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>

              {imageWarnings.length > 0 && (
                <ul className="space-y-1">
                  {imageWarnings.map(warning => (
                    <li key={warning} className="text-[10px] font-mono text-amber-300/60">— {warning}</li>
                  ))}
                </ul>
              )}

              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <Input placeholder="Paste a custom image URL..." value={customUrl} onChange={e => setCustomUrl(e.target.value)} />
                </div>
                <button
                  onClick={() => customUrl.trim() && handleSaveImage(customUrl.trim())}
                  disabled={!customUrl.trim() || !!savingImage}
                  className="px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/60 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-30 whitespace-nowrap"
                >
                  {savingImage === customUrl.trim() ? 'Saving...' : `Set ${imageType}`}
                </button>
              </div>

              {searchingImages ? (
                <div className="flex flex-col items-center justify-center py-20 space-y-4">
                  <Spinner className="w-12 h-12" />
                  <p className="text-[10px] font-mono text-white/20 uppercase tracking-widest animate-pulse">Fetching global assets...</p>
                </div>
              ) : imageResults.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 opacity-20">
                  <span className="text-4xl mb-4">🖼️</span>
                  <p className="text-[10px] font-mono uppercase tracking-widest">No provider images — paste a custom URL above</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {imageResults.map((img, i) => (
                    <div
                      key={i}
                      className={`relative bg-noir-900 rounded-xl border border-white/10 overflow-hidden group hover:border-[#00D4FF]/40 transition-all ${imageType === 'banner' ? 'col-span-2' : ''}`}
                      style={images.aspect ? { aspectRatio: images.aspect } : aspectFor(imageType)}
                    >
                      <img
                        src={img.url}
                        className={`w-full h-full ${['logo', 'clearart', 'disc'].includes(imageType) ? 'object-contain p-4' : 'object-cover'}`}
                        alt=""
                      />
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center p-4 text-center">
                        <p className="text-[10px] font-mono text-white/40 uppercase mb-1">{img.source}</p>
                        {img.width && (
                          <p className="text-[10px] font-mono text-white/60 mb-4">
                            {img.width} x {img.height}
                          </p>
                        )}
                        <button
                          onClick={() => handleSaveImage(img.url)}
                          disabled={!!savingImage}
                          className="px-4 py-2 rounded-lg bg-[#00D4FF] text-noir-950 text-[10px] font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95 disabled:opacity-50"
                        >
                          {savingImage === img.url ? 'Saving...' : 'Set as Current'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {imageResults.length > 0 && (
                <div className="flex items-center justify-center gap-4 pt-2 pb-1">
                  <span className="text-[9px] font-mono uppercase tracking-widest text-white/25">
                    {imageResults.length} of {Math.max(totalImages, imageResults.length)}
                  </span>
                  {nextOffset !== null && (
                    <button
                      type="button"
                      onClick={loadMoreImages}
                      disabled={loadingMore}
                      className="px-5 py-2 rounded-xl bg-white/5 border border-white/10 text-white/60 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-30"
                    >
                      {loadingMore ? 'Loading...' : 'Load more'}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            extraTab?.content
          )}
        </div>

        {tab === 'text' && (
          <div className="flex justify-end gap-3 pt-6 border-t border-white/5 mt-6">
            <button
              onClick={onClose}
              className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-8 py-2.5 rounded-xl bg-[#00D4FF] text-noir-950 text-xs font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
