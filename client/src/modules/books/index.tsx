import { useState, useEffect, useRef, useMemo } from 'react'
import { Routes, Route, Link, useNavigate, useSearchParams, useLocation, useParams } from 'react-router-dom'
import { booksApi, type Author, type Book } from '../../lib/books.api.js'
import { tmdbImage } from '../../lib/api.js'
import { SearchInput, PosterSkeleton, EmptyState, StatusBadge, DetailPage, DetailHeader, DetailPoster, DetailMain, DetailStoryline, DetailMetaItem, LibraryCard, CollectionFilterBar, SelectionBar, Modal, Spinner } from '../../components/ui.js'
import { MissingSearchModal } from '../../components/MissingSearchModal.js'
import { MetadataEditorModal } from '../../components/MetadataEditorModal.js'
import { SearchDetailModal } from '../../components/SearchDetailModal.js'
import { ItemActionsBar } from '../../components/ItemActions.js'
import { useTabs } from '../../lib/tab-context.js'

// ── Author Detail Page ───────────────────────────────────────────────────────

function AuthorDetailPage({ onDelete }: { onDelete: (id: number) => void }) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [author, setArtist] = useState<(Author & { books: Book[] }) | null>(null)
  const [expandedBook, setExpandedBook] = useState<number | null>(null)
  const [showMetadataModal, setShowMetadataModal] = useState(false)
  const [editingBook, setEditingBook] = useState<Book | null>(null)

  const loadData = async () => {
    if (!id) return
    setLoading(true)
    try {
      const data = await booksApi.authors.get(parseInt(id))
      setArtist(data)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [id])

  if (loading) return (
    <div className="animate-pulse space-y-8">
      <div className="h-[400px] bg-noir-800 rounded-3xl" />
      <div className="h-64 bg-noir-800 rounded-3xl" />
    </div>
  )

  if (!author) return <EmptyState icon="❓" title="AUTHOR NOT FOUND" />

  // Group books by series
  const grouped = (author.books || []).reduce((acc, b) => {
    const series = b.series_name || 'Standalone Works'
    if (!acc[series]) acc[series] = []
    acc[series].push(b)
    return acc
  }, {} as Record<string, Book[]>)

  // Sort series (Standalones last)
  const sortedSeries = Object.entries(grouped).sort(([a], [b]) => {
    if (a === 'Standalone Works') return 1
    if (b === 'Standalone Works') return -1
    return a.localeCompare(b)
  })

  return (
    <DetailPage>
      <DetailHeader backdrop={author.image_url} backTo="/books" backLabel="Library">
        <DetailPoster src={author.image_url} icon="📖" aspect="aspect-square" />
        
        <div className="flex-1 min-w-0 pb-4">
          <div className="flex items-center gap-4 mb-6">
            <p className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">
              Author
            </p>
          </div>

          <h1 className="font-display text-4xl lg:text-6xl tracking-tighter mb-8 text-yellow-400 uppercase leading-none drop-shadow-2xl">
            {author.name}
          </h1>

          <div className="flex flex-wrap gap-8 items-center text-xs font-bold text-white/60 uppercase tracking-[0.2em]">
            <DetailMetaItem label="WORKS" value={author.book_count || 0} />
            <DetailMetaItem label="TYPE" value="AUTHOR" />
          </div>
        </div>

      </DetailHeader>

      {showMetadataModal && (
        <MetadataEditorModal
          title={author.name}
          initial={author as any}
          fields={[
            { key: 'name', label: 'Name' },
            { key: 'genres', label: 'Genres (comma separated)', type: 'csv' },
            { key: 'overview', label: 'Biography', type: 'textarea' },
          ]}
          onSave={async data => { await booksApi.authors.updateMetadata(author.id, data) }}
          images={{
            types: ['poster'],
            search: () => booksApi.authors.searchImages(author.id),
            save: (type, url) => booksApi.authors.saveImage(author.id, type, url),
          }}
          onClose={() => { setShowMetadataModal(false); loadData() }}
        />
      )}

      {editingBook && (
        <MetadataEditorModal
          title={editingBook.title}
          initial={editingBook as any}
          fields={[
            { key: 'title', label: 'Title' },
            { key: 'subtitle', label: 'Subtitle' },
            { key: 'series_name', label: 'Series Name' },
            { key: 'series_position', label: 'Series Position', type: 'float' },
            { key: 'year', label: 'Year', type: 'number' },
            { key: 'publisher', label: 'Publisher' },
            { key: 'page_count', label: 'Pages', type: 'number' },
            { key: 'language', label: 'Language' },
            { key: 'genres', label: 'Genres (comma separated)', type: 'csv', wide: true },
            { key: 'overview', label: 'Description', type: 'textarea' },
          ]}
          onSave={async data => { await booksApi.books.updateMetadata(editingBook.id, data) }}
          images={{
            types: ['cover'],
            search: () => booksApi.books.searchImages(editingBook.id),
            save: (type, url) => booksApi.books.saveImage(editingBook.id, type, url),
          }}
          onClose={() => { setEditingBook(null); loadData() }}
        />
      )}

      <DetailMain>
        <div className="space-y-16">
          <DetailStoryline title="Biography" overview={author.overview} />

          <section className="space-y-12">
            {sortedSeries.map(([seriesName, books]) => (
              <div key={seriesName} className="space-y-6">
                <div className="flex items-center gap-4">
                  <h2 className="text-[10px] font-bold text-yellow-400 uppercase tracking-[0.3em] whitespace-nowrap">{seriesName}</h2>
                  <div className="h-px w-full bg-white/[0.03]" />
                </div>
                
                <div className="space-y-4">
                  {books.map(book => (
                    <div key={book.id} className="bg-noir-900/40 border border-white/5 rounded-2xl overflow-hidden group">
                      <button 
                        onClick={() => setExpandedBook(expandedBook === book.id ? null : book.id)}
                        className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition-colors text-left"
                      >
                        <div className="flex items-center gap-6">
                          <div className="w-12 h-18 rounded-lg overflow-hidden bg-noir-800 flex-shrink-0 border border-white/5 shadow-lg">
                            {book.cover_url ? <img src={book.cover_url} className="w-full h-full object-cover" alt="" /> : <div className="w-full h-full flex items-center justify-center text-[10px] opacity-20">📖</div>}
                          </div>
                          <div>
                            <div className="text-sm font-bold text-white group-hover:text-yellow-400 transition-colors uppercase tracking-tight">
                              {book.series_position ? <span className="text-yellow-400/40 mr-2">#{book.series_position}</span> : null}
                              {book.title}
                            </div>
                            <div className="text-[10px] font-mono text-white/30 uppercase tracking-widest mt-1">
                              {book.year || 'Unknown Year'} • {book.publisher || 'Unknown Publisher'}
                            </div>
                          </div>
                        </div>
                        <span className={`text-white/20 transition-transform duration-300 ${expandedBook === book.id ? 'rotate-180' : ''}`}>▼</span>
                      </button>

                      {expandedBook === book.id && (
                        <div className="border-t border-white/5 animate-slide-down p-6 bg-noir-950/20">
                          <div className="flex flex-col md:flex-row gap-8">
                            <div className="w-32 h-48 rounded-xl overflow-hidden shadow-2xl flex-shrink-0 border border-white/10">
                              {book.cover_url ? <img src={book.cover_url} className="w-full h-full object-cover" /> : <div className="aspect-[2/3] bg-noir-800" />}
                            </div>
                            <div className="flex-1 space-y-4">
                              <div className="flex items-center gap-3">
                                <StatusBadge status={book.status} />
                                {book.language && <span className="text-[10px] font-mono text-white/20 uppercase border border-white/10 px-2 py-0.5 rounded-full">{book.language}</span>}
                                <button onClick={() => setEditingBook(book)}
                                  className="ml-auto px-3 py-1 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white transition-all text-[9px] font-bold uppercase tracking-widest">
                                  Edit Metadata
                                </button>
                              </div>
                              <p className="text-sm text-white/60 leading-relaxed line-clamp-4 font-light italic">
                                {book.overview || 'No description available.'}
                              </p>
                              <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
                                <div>
                                  <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest mb-1">ISBN-13</p>
                                  <p className="text-xs text-white/40 font-mono">{book.isbn_13 || 'N/A'}</p>
                                </div>
                                <div>
                                  <p className="text-[9px] font-mono text-white/20 uppercase tracking-widest mb-1">Pages</p>
                                  <p className="text-xs text-white/40 font-mono">{book.page_count || 'Unknown'}</p>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        </div>

        <div className="space-y-8">
          <div className="bg-noir-900/50 border border-white/5 rounded-3xl p-6 space-y-6 sticky top-8 shadow-xl">
            <div>
              <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-[0.2em] mb-4 font-bold">Author Metadata</h3>
              <div className="space-y-3 text-xs">
                <div className="flex justify-between py-2 border-b border-white/5">
                  <span className="text-white/30">Library ID</span>
                  <span className="font-mono text-white/60">{author.id}</span>
                </div>
                <div className="flex justify-between py-2 border-b border-white/5">
                  <span className="text-white/30">Books</span>
                  <span className="text-white/60 uppercase">{author.book_count}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DetailMain>

      <ItemActionsBar
        accent="#F1C40F"
        containerClass="max-w-[1600px] mx-auto px-8 w-full"
        reacquire={{
          mode: 'select',
          title: 'Select books to reacquire',
          items: (author.books || []).map(b => ({ id: b.id, label: b.title, sublabel: b.year ? String(b.year) : undefined })),
          runSelected: async (ids) => { for (const bid of ids) await booksApi.books.repair(bid, {}); loadData() },
        }}
        loadHistory={() => booksApi.authors.acquisitionHistory(author.id)}
        onRemove={async () => { if (confirm('Remove this author from the library? Files on disk are kept.')) { await booksApi.authors.delete(author.id, false); onDelete(author.id); navigate('/books') } }}
        onDelete={async () => { if (confirm('Delete this author AND all their files from disk? This permanently removes the folder and cannot be undone.')) { await booksApi.authors.delete(author.id, true); onDelete(author.id); navigate('/books') } }}
        onEdit={() => setShowMetadataModal(true)}
      />
    </DetailPage>
  )
}

// ── Books Library ────────────────────────────────────────────────────────────

type BookCollectionFilter = 'all' | 'missing' | 'collected' | 'acquiring'

function BooksLibrary() {
  const [authors, setAuthors] = useState<Author[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [collectionFilter, setCollectionFilter] = useState<BookCollectionFilter>('all')
  const [lastRedirect, setLastRedirect] = useState(0)
  const [showMissingModal, setShowMissingModal] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { activeTabId, tabs, getActiveTabForMedia, setActiveTabForMedia } = useTabs()

  useEffect(() => {
    if (!tabs.length) return
    const booksTab = getActiveTabForMedia('books')
    if (booksTab && booksTab.id !== activeTabId) {
      setActiveTabForMedia('books', booksTab.id)
    }
  }, [tabs])

  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId])
  const activeName = activeTab ? activeTab.name.replace(/Books/i, '').trim() : ''

  const refresh = () => {
    setLoading(true)
    booksApi.authors.list()
      .then(setAuthors)
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!activeTabId) { setAuthors([]); setLoading(false); return }
    const current = tabs.find(t => t.id === activeTabId)
    if (current && current.media_type !== 'books') return
    setAuthors([])
    refresh()
    const interval = setInterval(() => refresh(), 5000)
    return () => clearInterval(interval)
  }, [activeTabId, tabs])

  const filtered = authors.filter(a => {
    const matchesSearch = !search || a.name.toLowerCase().includes(search.toLowerCase())
    if (!matchesSearch) return false

    const isCollected = a.downloaded_books && a.book_count && a.downloaded_books >= a.book_count
    const isMissing = !a.downloaded_books || a.downloaded_books === 0
    const isAcquiring = !isCollected && !isMissing

    if (collectionFilter === 'missing' && !isMissing) return false
    if (collectionFilter === 'collected' && !isCollected) return false
    if (collectionFilter === 'acquiring' && !isAcquiring) return false

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
    <div className="animate-fade-in">
      <div className="mb-6 flex justify-between items-end">
        <div>
          <h1 className="font-display text-5xl tracking-widest text-yellow-400">
            BOOKS{activeName && activeName.toLowerCase() !== 'main' ? <span className="text-white/20 ml-4">({activeName.toUpperCase()})</span> : ''}
          </h1>
          <p className="text-yellow-400 text-[12.5px] mt-1 font-mono uppercase tracking-widest">
            <span className="text-white">{authors.length}</span> {authors.length === 1 ? 'author' : 'authors'} in library
            {authors.length > 0 && (() => {
              const collected = authors.filter(a => a.downloaded_books && a.book_count && a.downloaded_books >= a.book_count).length
              const missing = authors.filter(a => !a.downloaded_books || a.downloaded_books === 0).length
              const acquiring = authors.length - collected - missing
              return <> | <span className="text-white">{collected}</span> {collected === 1 ? 'author' : 'authors'} Collected | <span className="text-white">{missing}</span> {missing === 1 ? 'author' : 'authors'} Missing{acquiring > 0 ? <> | <span className="text-white">{acquiring}</span> {acquiring === 1 ? 'author' : 'authors'} Acquiring</> : ''}</>
            })()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowMissingModal(true)}
            className="px-6 py-2 rounded-xl bg-yellow-500/10 border border-yellow-500/30 text-yellow-500 text-xs font-bold tracking-widest hover:bg-yellow-500/20 transition-all uppercase"
          >
            Search Missing
          </button>
          <Link to="add" className="px-6 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-bold tracking-widest hover:bg-white/10 transition-all uppercase">
            Add Author
          </Link>
        </div>
      </div>
      
      <div className="flex flex-col md:flex-row gap-4 mb-8">
        <SearchInput value={search} onChange={setSearch} placeholder="Search library..." className="max-w-sm" />
        <CollectionFilterBar value={collectionFilter} onChange={setCollectionFilter} accentColor="yellow-400" />
      </div>
      
      {loading ? <PosterSkeleton /> : filtered.length === 0 ? (
        <EmptyState icon="📖" title="NO AUTHORS FOUND" subtitle="Add your first author to begin" />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((a, i) => (
            <div key={a.id} className="animate-slide-up" style={{ animationDelay: `${Math.min(i * 25, 300)}ms`, animationFillMode: 'both' }}>
              <LibraryCard 
                onClick={() => navigate(`/books/${a.id}`)}
                image={a.image_url}
                title={a.name}
                subtitle={`${a.downloaded_books || 0}/${a.book_count || 0} BOOKS`}
                status={a.downloaded_books && a.book_count && a.downloaded_books >= a.book_count ? 'collected' : 'missing'}
                accentColor="#F1C40F"
                fallbackIcon="📖"
                aspect="aspect-square"
              />
            </div>
          ))}
        </div>
      )}

      {showMissingModal && (
        <MissingSearchModal
          mediaType="books"
          onClose={() => setShowMissingModal(false)}
          onStart={async (overrides) => {
            setShowMissingModal(false)
            try {
              const res = await fetch('/api/v1/release-pipeline/missing-search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tabId: activeTabId, overrides })
              })
              const data = await res.json()
              if (data.success) alert('Missing search started in background')
              else alert(data.error || 'Failed to start search')
            } catch (err) { alert(String(err)) }
          }}
        />
      )}
    </div>
  )
}

export function BooksPage() {
  return (
    <Routes>
      <Route index element={<BooksLibrary />} />
      <Route path="add" element={<AddBooksPage />} />
      <Route path=":id" element={<AuthorDetailPage onDelete={() => {}} />} />
    </Routes>
  )
}

// ── Add Books Page ────────────────────────────────────────────────────────────

function TypeModal({ author, onClose, onConfirm, isAdding }: { 
  author: any; onClose: () => void; onConfirm: (series: string[]) => void; isAdding: boolean 
}) {
  const [selectedSeries, setSelectedSeries] = useState<string[]>([])
  const [seriesList, setSeriesList] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchDetails = async () => {
      try {
        const fullAuthor = await booksApi.lookupAuthor(author.openLibraryId || author.name)
        const series = fullAuthor.series || []
        setSeriesList(series)
        setSelectedSeries(series) // Select all by default
      } catch (err) {
        console.error('Failed to fetch author series:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchDetails()
  }, [author])

  return (
    <Modal title={`Add ${author.name}`} onClose={onClose}>
      <div className="space-y-6">
        <p className="text-sm text-white/60">Which series should we monitor for this author?</p>
        
        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center gap-4">
            <Spinner className="w-8 h-8" />
            <div className="text-[10px] font-mono text-white/20 uppercase tracking-[0.2em]">Fetching Series...</div>
          </div>
        ) : seriesList.length === 0 ? (
          <div className="py-8 text-center bg-noir-900 rounded-2xl border border-white/5">
            <div className="text-[10px] font-mono text-white/30 uppercase tracking-widest">No series found</div>
            <p className="text-[9px] text-white/10 mt-1">We'll just add all available books.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar">
            {seriesList.map(s => (
              <button key={s} 
                onClick={() => setSelectedSeries(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])}
                className={`px-4 py-3 rounded-xl text-left text-xs font-bold tracking-widest uppercase transition-all border ${
                  selectedSeries.includes(s) ? 'bg-yellow-400/20 border-yellow-400/40 text-yellow-400' : 'bg-noir-900 border-white/5 text-white/30 hover:border-white/10'
                }`}>
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="flex justify-end pt-4 border-t border-white/5">
          <div className="flex gap-3">
            <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest">Cancel</button>
            <button 
              onClick={() => onConfirm(selectedSeries)}
              disabled={isAdding || (loading && seriesList.length === 0)}
              className="px-8 py-2.5 rounded-xl bg-yellow-400 text-noir-950 font-bold text-xs uppercase tracking-widest transition-all shadow-xl disabled:opacity-50"
            >
              {isAdding ? 'Adding...' : 'Confirm Add'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function AddBooksPage() {
  const [searchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState<any | null>(null)
  const [added, setAdded] = useState<Set<number>>(new Set())
  const [detailAuthor, setDetailAuthor] = useState<any | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const navigate = useNavigate()

  useEffect(() => {
    clearTimeout(timer.current)
    if (!query.trim()) { setResults([]); return }
    timer.current = setTimeout(async () => {
      setSearching(true)
      try { 
        const items = await booksApi.lookup(query)
        setResults(items)
      }
      catch {}
      finally { setSearching(false) }
    }, 400)
    return () => clearTimeout(timer.current)
  }, [query])

  const handleAdd = (series: string[]) => {
    if (!adding) return
    const author = adding
    const key = author.id || author.name
    // Optimistic: mark added and close the picker instantly; the backend fetches
    // the bibliography and artwork in the background.
    setAdded(prev => new Set(prev).add(key))
    setAdding(null)
    booksApi.authors.add(author.name, true, series).catch(err => {
      alert(String(err))
      setAdded(prev => { const next = new Set(prev); next.delete(key); return next })
    })
  }

  return (
    <div className="animate-fade-in pb-20">
      <div className="mb-8 flex items-center gap-4">
        <button onClick={() => navigate('/books')} className="text-white/30 hover:text-white transition-all text-sm font-mono uppercase tracking-widest">← Back</button>
        <div className="h-4 w-px bg-white/10" />
        <h1 className="font-display text-3xl tracking-widest text-yellow-400">ADD AUTHOR</h1>
      </div>
      
      <div className="max-w-xl mb-12">
        <input type="text" value={query} onChange={e => setQuery(e.target.value)} 
          placeholder="Search for an author..." autoFocus
          className="w-full px-4 py-3 rounded-xl bg-noir-800 border border-white/10 text-white focus:outline-none focus:border-yellow-400/40 transition-all shadow-lg" />
      </div>

      {searching ? <PosterSkeleton count={12} /> : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {results.map((item: any) => {
            const isAdded = added.has(item.id || item.name) || item.alreadyAdded
            return (
              <div key={item.id || item.name} className="animate-slide-up" style={{ animationDelay: `${Math.min(results.indexOf(item) * 25, 300)}ms`, animationFillMode: 'both' }}>
                <LibraryCard
                  onClick={() => setDetailAuthor(item)}
                  image={item.imageUrl}
                  title={item.name}
                  subtitle="Author"
                  accentColor="#F1C40F"
                  fallbackIcon="📖"
                  aspect="aspect-square"
                  badge={
                    <button onClick={e => { e.stopPropagation(); !isAdded && setAdding(item) }} disabled={isAdded}
                      className={`px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-widest border transition-all ${isAdded ? 'bg-green-500/10 border-green-500/20 text-green-500' : 'bg-noir-950/60 border-white/10 text-white hover:bg-white/10'}`}>
                      {isAdded ? '✓ In Library' : '+ Add'}
                    </button>
                  }
                />
              </div>
            )
          })}
        </div>
      )}

      {detailAuthor && (
        <SearchDetailModal
          onClose={() => setDetailAuthor(null)}
          onAdd={() => setAdding(detailAuthor)}
          isAdded={added.has(detailAuthor.id || detailAuthor.name) || detailAuthor.alreadyAdded}
          accentColor="#F1C40F"
          fallbackIcon="📖"
          image={detailAuthor.imageUrl}
          title={detailAuthor.name}
          overview={detailAuthor.overview || detailAuthor.bio}
          facts={[
            { label: 'Works', value: detailAuthor.workCount || detailAuthor.bookCount },
            { label: 'Top Work', value: detailAuthor.topWork },
          ]}
        />
      )}

      {adding && (
        <TypeModal
          author={adding}
          onClose={() => setAdding(null)}
          onConfirm={handleAdd}
          isAdding={false}
        />
      )}
    </div>
  )
}
