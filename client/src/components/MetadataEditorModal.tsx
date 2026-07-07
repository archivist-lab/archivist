import { useEffect, useState } from 'react'
import { Modal, Field, Input, Spinner } from './ui.js'

export interface MetadataFieldSpec {
  key: string
  label: string
  /** text (default) | number | float | csv (comma-separated → array) | textarea */
  type?: 'text' | 'number' | 'float' | 'csv' | 'textarea'
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
  search: (type: string) => Promise<ImageCandidate[]>
  save: (type: string, url: string) => Promise<unknown>
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
  if (type === 'csv') return trimmed.split(',').map(s => s.trim()).filter(Boolean)
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
export function MetadataEditorModal({ title, fields, initial, onSave, onClose, images }: {
  title: string
  fields: MetadataFieldSpec[]
  initial: Record<string, unknown>
  onSave: (data: Record<string, unknown>) => Promise<void>
  onClose: () => void
  images?: ImageEditorSpec
}) {
  const [tab, setTab] = useState<'text' | 'images'>('text')
  const [formData, setFormData] = useState<Record<string, string>>(() => {
    const state: Record<string, string> = {}
    for (const f of fields) state[f.key] = toInputValue(initial[f.key], f.type)
    return state
  })
  const [saving, setSaving] = useState(false)

  // Images tab state
  const [imageType, setImageType] = useState(images?.types[0] ?? 'poster')
  const [imageResults, setImageResults] = useState<ImageCandidate[]>([])
  const [searchingImages, setSearchingImages] = useState(false)
  const [savingImage, setSavingImage] = useState<string | null>(null)
  const [customUrl, setCustomUrl] = useState('')

  useEffect(() => {
    if (tab === 'images' && images) {
      setSearchingImages(true)
      images.search(imageType)
        .then(setImageResults)
        .catch(err => { console.error(err); setImageResults([]) })
        .finally(() => setSearchingImages(false))
    }
  }, [tab, imageType])

  const handleSave = async () => {
    setSaving(true)
    try {
      const data: Record<string, unknown> = {}
      for (const f of fields) data[f.key] = fromInputValue(formData[f.key] ?? '', f.type)
      await onSave(data)
      onClose()
    } catch (err) {
      alert(String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleSaveImage = async (url: string) => {
    if (!images) return
    setSavingImage(url)
    try {
      await images.save(imageType, url)
      alert(`${imageType.toUpperCase()} updated successfully`)
    } catch (err) {
      alert(String(err))
    } finally {
      setSavingImage(null)
    }
  }

  const narrow = fields.filter(f => !f.wide && f.type !== 'textarea')
  const wide = fields.filter(f => f.wide || f.type === 'textarea')

  return (
    <Modal title={`Edit Metadata: ${title}`} onClose={onClose} width="max-w-4xl">
      <div className="flex flex-col max-h-[70vh]">
        {images && (
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
        )}

        <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
          {tab === 'text' ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {narrow.map(f => (
                  <Field key={f.key} label={f.label}>
                    <Input
                      type={f.type === 'number' || f.type === 'float' ? 'number' : 'text'}
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
                    <Input
                      value={formData[f.key] ?? ''}
                      onChange={e => setFormData({ ...formData, [f.key]: e.target.value })}
                    />
                  )}
                </div>
              ))}
            </>
          ) : images && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center gap-6">
                <div className="flex items-center gap-3">
                  <span className="text-[9px] font-mono text-white/20 uppercase tracking-widest">Type</span>
                  <div className="flex gap-1 bg-noir-900 p-1 rounded-xl border border-white/5">
                    {images.types.map(opt => (
                      <button key={opt} onClick={() => setImageType(opt)}
                        className={`px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-widest transition-all ${
                          imageType === opt ? 'bg-[#00D4FF] text-noir-950 shadow-lg' : 'text-white/30 hover:text-white/60'
                        }`}>
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <Input placeholder="Paste a custom image URL..." value={customUrl} onChange={e => setCustomUrl(e.target.value)} />
                </div>
                <button
                  onClick={() => customUrl.trim() && handleSaveImage(customUrl.trim())}
                  disabled={!customUrl.trim() || !!savingImage}
                  className="px-4 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/60 hover:text-white text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-30 whitespace-nowrap">
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
                    <div key={i} className={`relative bg-noir-900 rounded-xl border border-white/10 overflow-hidden group hover:border-[#00D4FF]/40 transition-all ${imageType === 'banner' ? 'col-span-2' : ''}`}
                      style={aspectFor(imageType)}>
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
          <div className="flex justify-end gap-3 pt-6 border-t border-white/5 mt-6">
            <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest">Cancel</button>
            <button onClick={handleSave} disabled={saving}
              className="px-8 py-2.5 rounded-xl bg-[#00D4FF] text-noir-950 text-xs font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95 disabled:opacity-50">
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
