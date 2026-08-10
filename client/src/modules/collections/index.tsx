import { useEffect, useState } from 'react'
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { Field, Input, Select, Spinner } from '../../components/ui.js'
import { collectionsApi, type ArchivistCollection, type CollectionArtworkType, type CollectionCandidate, type CollectionInput, type CollectionMediaType, type CollectionMember } from '../../lib/collections.api.js'
import { confirmDialog, toast } from '../../lib/notify.js'
import { TabBar } from '../../components/PageHeader.js'
import { CollectionsHowItWorks } from './HowItWorks.js'

const button = 'inline-flex items-center justify-center rounded-xl border border-white/25 bg-white/10 px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-white/80 transition hover:border-white/45 hover:bg-white/15 disabled:opacity-40'
const textarea = 'w-full min-h-28 rounded-lg border border-white/10 bg-noir-900 px-3 py-2.5 text-sm text-white/90 placeholder-white/20 focus:border-white/30 focus:outline-none'
const blank: CollectionInput = { name: '', description: '', posterUrl: '', backdropUrl: '', logoUrl: '' }
type ArtworkFiles = Partial<Record<CollectionArtworkType, File>>

// The Collections tab owns the section root; only How It Works needs a segment.
const COLLECTION_TABS = [
  { id: 'collections', label: 'Collections', to: '/collections' },
  { id: 'how', label: 'How It Works', to: '/collections/how' },
]

function Header({ title, subtitle, action, tabs }: { title: string; subtitle: string; action?: React.ReactNode; tabs?: boolean }) {
  return <div className="mb-8">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="font-display text-5xl uppercase tracking-widest text-white/70">{title}</h1><p className="mt-1 font-mono text-[12.5px] uppercase tracking-widest text-white/35">{subtitle}</p></div>{action}</div>
    {tabs && <div className="mt-6"><TabBar tabs={COLLECTION_TABS} /></div>}
  </div>
}

function CollectionForm({ value, onChange, files, onFile, uploading }: { value: CollectionInput; onChange: (value: CollectionInput) => void; files?: ArtworkFiles; onFile?: (type: CollectionArtworkType, file: File) => void; uploading?: CollectionArtworkType | null }) {
  const set = (key: keyof CollectionInput, next: string) => onChange({ ...value, [key]: next })
  const artworkField = (type: CollectionArtworkType, label: string, key: 'posterUrl' | 'backdropUrl' | 'logoUrl') => <Field label={label}>
    <div className="space-y-2">
      <Input value={value[key] ?? ''} onChange={e => set(key, e.target.value)} placeholder="https://… or /media/…" />
      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-dashed border-white/15 bg-black/20 px-3 py-2 text-xs text-white/40 transition hover:border-white/30 hover:text-white/65">
        <span className="truncate">{uploading === type ? 'Uploading…' : files?.[type]?.name || `Upload ${label.toLowerCase()}`}</span>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest">JPEG · PNG · WebP · AVIF</span>
        <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,image/avif" disabled={uploading !== undefined && uploading !== null} onChange={event => { const file = event.target.files?.[0]; if (file) onFile?.(type, file); event.target.value = '' }} />
      </label>
    </div>
  </Field>
  return <div className="grid gap-5 lg:grid-cols-2">
    <div className="space-y-5"><Field label="Name"><Input value={value.name} onChange={e => set('name', e.target.value)} maxLength={120} /></Field><Field label="Description"><textarea className={textarea} value={value.description ?? ''} onChange={e => set('description', e.target.value)} maxLength={5000} /></Field></div>
    <div className="space-y-4">{artworkField('poster', 'Poster', 'posterUrl')}{artworkField('backdrop', 'Backdrop', 'backdropUrl')}{artworkField('logo', 'Logo', 'logoUrl')}</div>
  </div>
}

function CollectionsOverview() {
  const [collections, setCollections] = useState<ArchivistCollection[] | null>(null)
  useEffect(() => { collectionsApi.list().then(result => setCollections(result.collections)).catch(toast.error) }, [])
  return <div className="animate-fade-in"><Header title="Collections" subtitle="Archivist-owned cross-media collections" tabs action={<Link className={button} to="new">+ New Collection</Link>} />
    {collections === null ? <div className="flex justify-center py-24"><Spinner /></div> : collections.length === 0 ? <div className="rounded-2xl border border-dashed border-white/15 p-12 text-center"><p className="text-lg text-white/60">No collections yet</p><p className="mt-2 text-sm text-white/30">Create an editorial collection and add items from any Archivist library.</p></div> :
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{collections.map(collection => <Link key={collection.id} to={String(collection.id)} className="group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025] transition hover:border-white/35 hover:bg-white/[0.06]">
        <div className="relative h-36 bg-white/[0.03]">{collection.backdropUrl ? <img src={collection.backdropUrl} alt="" className="h-full w-full object-cover opacity-60" /> : null}<div className="absolute inset-0 bg-gradient-to-t from-noir-950 to-transparent" />{collection.logoUrl ? <img src={collection.logoUrl} alt="" className="absolute bottom-4 left-5 max-h-12 max-w-[60%] object-contain object-left" /> : null}</div>
        <div className="p-5"><h2 className="font-display text-2xl uppercase tracking-widest text-white/75 group-hover:text-white">{collection.name}</h2><p className="mt-2 line-clamp-2 min-h-10 text-sm text-white/35">{collection.description || 'No description'}</p><p className="mt-4 font-mono text-[10px] uppercase tracking-widest text-white/30">{collection.memberCount} {collection.memberCount === 1 ? 'item' : 'items'}</p></div>
      </Link>)}</div>}
  </div>
}

function NewCollection() {
  const navigate = useNavigate(); const [form, setForm] = useState<CollectionInput>(blank); const [files, setFiles] = useState<ArtworkFiles>({}); const [saving, setSaving] = useState(false)
  const save = async () => { if (!form.name.trim()) return toast.error('Collection name is required'); setSaving(true); let collectionId: number | null = null; try { let result = await collectionsApi.create(form); collectionId = result.collection.id; for (const type of ['poster', 'backdrop', 'logo'] as const) { const file = files[type]; if (file) result = await collectionsApi.uploadArtwork(collectionId, type, file) } toast.success('Collection created'); navigate(`/collections/${collectionId}`) } catch (error) { toast.error(error); if (collectionId) navigate(`/collections/${collectionId}`) } finally { setSaving(false) } }
  return <div className="animate-fade-in"><Header title="New Collection" subtitle="Create an Archivist editorial collection" action={<Link className={button} to="/collections">Back</Link>} /><div className="rounded-2xl border border-white/10 bg-white/[0.025] p-6"><CollectionForm value={form} onChange={setForm} files={files} onFile={(type, file) => setFiles(current => ({ ...current, [type]: file }))} /><div className="mt-6 flex justify-end"><button className={button} onClick={save} disabled={saving}>{saving ? 'Creating…' : 'Create Collection'}</button></div></div></div>
}

const mediaOptions: Array<{ value: '' | CollectionMediaType; label: string }> = [{ value: '', label: 'All media' }, { value: 'films', label: 'Films' }, { value: 'series', label: 'Series' }, { value: 'music', label: 'Music' }, { value: 'books', label: 'Books' }, { value: 'comics', label: 'Comics' }, { value: 'games', label: 'Games' }]

function ItemRow({ item, onRemove, onMove, first, last }: { item: CollectionMember; onRemove: () => void; onMove: (delta: number) => void; first: boolean; last: boolean }) {
  return <div className="flex items-center gap-4 rounded-xl border border-white/8 bg-black/20 p-3">{item.artworkUrl ? <img src={item.artworkUrl} alt="" className="h-16 w-11 rounded object-cover" /> : <div className="flex h-16 w-11 items-center justify-center rounded bg-white/5 text-lg">◇</div>}<div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-white/80">{item.title}{item.year ? ` (${item.year})` : ''}</p><p className="truncate text-xs text-white/35">{item.subtitle || item.entityType.replace('_', ' ')} · {item.libraryName}</p></div><div className="flex gap-1"><button disabled={first} onClick={() => onMove(-1)} className="rounded border border-white/10 px-2 py-1 text-white/45 hover:text-white disabled:opacity-20">↑</button><button disabled={last} onClick={() => onMove(1)} className="rounded border border-white/10 px-2 py-1 text-white/45 hover:text-white disabled:opacity-20">↓</button><button onClick={onRemove} className="ml-2 rounded border border-red-400/20 px-2 py-1 text-red-300/60 hover:text-red-300">Remove</button></div></div>
}

function CollectionDetail() {
  const { id: rawId } = useParams(); const id = Number(rawId); const navigate = useNavigate()
  const [collection, setCollection] = useState<ArchivistCollection | null>(null); const [form, setForm] = useState<CollectionInput>(blank); const [saving, setSaving] = useState(false); const [uploading, setUploading] = useState<CollectionArtworkType | null>(null)
  const [query, setQuery] = useState(''); const [mediaType, setMediaType] = useState<'' | CollectionMediaType>(''); const [results, setResults] = useState<CollectionCandidate[]>([]); const [searching, setSearching] = useState(false)
  const apply = (next: ArchivistCollection) => { setCollection(next); setForm({ name: next.name, description: next.description ?? '', posterUrl: next.posterUrl ?? '', backdropUrl: next.backdropUrl ?? '', logoUrl: next.logoUrl ?? '' }) }
  useEffect(() => { if (Number.isSafeInteger(id) && id > 0) collectionsApi.get(id).then(result => apply(result.collection)).catch(toast.error) }, [id])
  const save = async () => { setSaving(true); try { apply((await collectionsApi.update(id, form)).collection); toast.success('Collection saved') } catch (error) { toast.error(error) } finally { setSaving(false) } }
  const upload = async (type: CollectionArtworkType, file: File) => { setUploading(type); try { apply((await collectionsApi.uploadArtwork(id, type, file)).collection); toast.success(`${type[0].toUpperCase()}${type.slice(1)} uploaded`) } catch (error) { toast.error(error) } finally { setUploading(null) } }
  const removeCollection = async () => { if (!await confirmDialog({ title: 'Delete this collection?', message: 'The collection membership and uploaded collection artwork will be removed. Library items and their media files are not affected.', confirmLabel: 'Delete collection' })) return; try { await collectionsApi.delete(id); navigate('/collections'); toast.success('Collection deleted') } catch (error) { toast.error(error) } }
  const search = async () => { setSearching(true); try { setResults((await collectionsApi.candidates(query, mediaType || undefined)).results) } catch (error) { toast.error(error) } finally { setSearching(false) } }
  const add = async (candidate: CollectionCandidate) => { try { apply((await collectionsApi.addItem(id, candidate)).collection); setResults(current => current.filter(item => !(item.entityType === candidate.entityType && item.itemId === candidate.itemId && item.libraryId === candidate.libraryId))) } catch (error) { toast.error(error) } }
  const remove = async (membershipId: number) => { try { apply((await collectionsApi.removeItem(id, membershipId)).collection) } catch (error) { toast.error(error) } }
  const move = async (index: number, delta: number) => { const items = [...(collection?.items ?? [])]; const target = index + delta; if (target < 0 || target >= items.length) return; [items[index], items[target]] = [items[target], items[index]]; try { apply((await collectionsApi.reorder(id, items.map(item => item.membershipId))).collection) } catch (error) { toast.error(error) } }
  if (!collection) return <div className="flex justify-center py-24"><Spinner /></div>
  const existing = new Set((collection.items ?? []).map(item => `${item.entityType}:${item.libraryId}:${item.itemId}`))
  return <div className="animate-fade-in"><Header title={collection.name} subtitle="Cross-media collection editor" action={<Link className={button} to="/collections">All Collections</Link>} />
    <div className="space-y-6"><section className="rounded-2xl border border-white/10 bg-white/[0.025] p-6"><CollectionForm value={form} onChange={setForm} onFile={upload} uploading={uploading} /><div className="mt-6 flex justify-between gap-3"><button className="rounded-xl border border-red-400/25 px-4 py-2.5 text-[10px] font-bold uppercase tracking-widest text-red-300/70 hover:bg-red-400/10" onClick={removeCollection}>Delete</button><button className={button} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Details'}</button></div></section>
      <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-6"><h2 className="font-display text-2xl uppercase tracking-widest text-white/70">Add items</h2><p className="mt-1 text-sm text-white/35">Search every configured Archivist library.</p><div className="mt-4 grid gap-3 md:grid-cols-[1fr_180px_auto]"><Input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search() }} placeholder="Search by title or name…" /><Select value={mediaType} onChange={e => setMediaType(e.target.value as '' | CollectionMediaType)}>{mediaOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select><button className={button} onClick={search} disabled={searching || query.trim().length < 2}>{searching ? 'Searching…' : 'Search'}</button></div>
        {results.length > 0 && <div className="mt-4 grid max-h-96 gap-2 overflow-y-auto pr-1 md:grid-cols-2">{results.map(result => { const key = `${result.entityType}:${result.libraryId}:${result.itemId}`; const added = existing.has(key); return <div key={key} className="flex items-center gap-3 rounded-xl border border-white/8 bg-black/20 p-3">{result.artworkUrl ? <img src={result.artworkUrl} alt="" className="h-14 w-10 rounded object-cover" /> : <div className="h-14 w-10 rounded bg-white/5" />}<div className="min-w-0 flex-1"><p className="truncate text-sm text-white/75">{result.title}</p><p className="truncate text-[11px] text-white/30">{result.subtitle || result.entityType.replace('_', ' ')} · {result.libraryName}</p></div><button className={button} disabled={added} onClick={() => add(result)}>{added ? 'Added' : 'Add'}</button></div> })}</div>}
      </section>
      <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-6"><h2 className="font-display text-2xl uppercase tracking-widest text-white/70">Items <span className="text-white/30">{collection.items?.length ?? 0}</span></h2><div className="mt-4 space-y-2">{(collection.items ?? []).map((item, index, all) => <ItemRow key={item.membershipId} item={item} first={index === 0} last={index === all.length - 1} onRemove={() => remove(item.membershipId)} onMove={delta => move(index, delta)} />)}{!collection.items?.length && <p className="py-8 text-center text-sm text-white/30">No items have been added.</p>}</div></section>
    </div></div>
}

export function CollectionsPage() {
  return <Routes><Route index element={<CollectionsOverview />} /><Route path="how" element={<CollectionsHowItWorksPage />} /><Route path="new" element={<NewCollection />} /><Route path=":id" element={<CollectionDetail />} /></Routes>
}

function CollectionsHowItWorksPage() {
  return <div className="animate-fade-in"><Header title="Collections" subtitle="How curated collections behave" tabs /><CollectionsHowItWorks /></div>
}
