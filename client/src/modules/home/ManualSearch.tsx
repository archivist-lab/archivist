import { useState } from 'react'
import { request, formatSize } from '../../lib/api.js'
import { Spinner } from '../../components/ui.js'
import { DashboardMediaTypeDropdown } from './DashboardMediaTypeDropdown.js'

interface SearchResult {
  title: string
  size: number
  indexer: string
  seeders: number
  leechers: number
  downloadUrl: string
  guid: string
  age?: string
  publishDate?: string
}

const CATEGORIES = [
  { label: 'All',    id: '',                                      icon: '🌐', color: '#ffffff', type: 'search', module: 'all' },
  { label: 'Films',  id: '2000,2040,2045,2050,2060,2070,2080',    icon: '🎬', color: '#00D4FF', type: 'movie', module: 'films' },
  { label: 'Series', id: '5000,5030,5040,5045,5050,5060,5070,5080', icon: '📺', color: '#9B59B6', type: 'tvsearch', module: 'series' },
  { label: 'Music',  id: '3000,3010,3020,3040,3050',              icon: '🎵', color: '#FF2D78', type: 'music', module: 'music' },
  { label: 'Books',  id: '7000,7010,7020,3030',                   icon: '📚', color: '#F1C40F', type: 'book', module: 'books' },
  { label: 'Comics', id: '7030',                                 icon: '🦸', color: '#E67E22', type: 'book', module: 'comics' },
  { label: 'Games',  id: '1000,4000,4050',                        icon: '🎮', color: '#2ECC71', type: 'search', module: 'games' },
]

export function ManualSearch() {
  const [query, setQuery] = useState('')
  const [categories, setCategories] = useState<Set<string>>(new Set(['all']))
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [grabbed, setGrabbed] = useState<Set<string>>(new Set())

  const doSearch = async (targetCategories?: Set<string>) => {
    if (!query.trim()) return
    setSearching(true)
    const activeCategories = targetCategories ?? categories
    const targets = activeCategories.has('all')
      ? [CATEGORIES[0]]
      : CATEGORIES.filter(category => category.id && activeCategories.has(category.id))
    try {
      const responses = await Promise.all(targets.map(async activeCategory => {
        const url = `/dashboard/search?q=${encodeURIComponent(query)}${activeCategory.id ? `&category=${activeCategory.id}` : ''}&type=${activeCategory.type}&module=${activeCategory.module}`
        return request<SearchResult[]>(url)
      }))
      const unique = new Map<string, SearchResult>()
      responses.flat().forEach(result => unique.set(result.guid || result.downloadUrl, result))
      setResults([...unique.values()])
    } catch (err) {
      console.error('Search failed:', err)
    } finally {
      setSearching(false)
    }
  }

  const selectCategories = (next: Set<string>) => {
    setCategories(next)
    setResults([])
    if (query.trim()) {
      doSearch(next)
    }
  }

  const selectedCategoryObjects = categories.has('all')
    ? []
    : CATEGORIES.filter(category => category.id && categories.has(category.id))
  const searchPlaceholder = categories.has('all')
    ? 'Manual search...'
    : selectedCategoryObjects.length === 1
      ? `Manual search for ${selectedCategoryObjects[0].label.toLowerCase()}...`
      : selectedCategoryObjects.length > 1
        ? `Manual search across ${selectedCategoryObjects.length} media types...`
        : 'Select a media type to search...'

  const handleGrab = async (res: SearchResult) => {
    try {
      await request('/dashboard/search/grab', {
        method: 'POST',
        body: JSON.stringify({ downloadUrl: res.downloadUrl, title: res.title })
      })
      setGrabbed(prev => new Set(prev).add(res.guid))
    } catch (err) {
      alert('Grab failed')
    }
  }

  return (
    <div className="space-y-4 mt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-mono text-white/20 uppercase tracking-[0.3em]">Manual Search</h2>
        <div className="h-px flex-1 bg-white/5 ml-6" />
      </div>

      <div className="bg-noir-900/50 border border-white/5 rounded-3xl overflow-hidden backdrop-blur-sm">
        <div className="p-4 border-b border-white/5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <DashboardMediaTypeDropdown
            options={CATEGORIES.filter(category => category.id).map(category => ({ value: category.id, label: category.label, icon: category.icon, color: category.color }))}
            selected={categories}
            onChange={selectCategories}
            multiple
            allowAll
            allLabel="All Media Types"
            menuLabel="Manual Search Types"
          />
          <div className="min-w-0 flex-1">
            <div className="relative group">
              <input type="text" value={query} 
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && doSearch()}
                placeholder={searchPlaceholder}
                className="w-full bg-noir-950/50 border border-white/10 rounded-xl px-5 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/20 transition-all shadow-2xl" />
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                {searching ? <Spinner className="w-4 h-4" /> : <span className="text-white/10 text-base">🔍</span>}
              </div>
            </div>
          </div>
        </div>

        {(searching || results.length > 0) && (
          <div className="divide-y divide-white/5 max-h-[500px] overflow-y-auto custom-scrollbar">
            {searching ? (
              <div className="p-8 flex items-center justify-center">
                <Spinner className="w-12 h-12" />
              </div>
            ) : (
              results.map((res, i) => {
                const isGrabbed = grabbed.has(res.guid)
                return (
                  <div key={res.guid || i} className="p-4 flex items-center gap-4 hover:bg-white/[0.02] transition-colors group">
                    <div className="flex-1 min-w-0">
                      <h3 className="text-xs font-medium text-white/80 truncate mb-1 group-hover:text-white transition-colors">{res.title}</h3>
                      <div className="flex items-center gap-4 text-[9px] font-mono uppercase tracking-tighter">
                        <span className="text-white/40">{res.indexer}</span>
                        <span className="text-white/25">{formatSize(res.size)}</span>
                        <span className="text-emerald-500/60">S: {res.seeders}</span>
                        <span className="text-cyan-500/60">L: {res.leechers}</span>
                        {res.publishDate && <span className="text-white/20">{new Date(res.publishDate).toLocaleDateString()}</span>}
                      </div>
                    </div>
                    <button 
                      onClick={() => handleGrab(res)}
                      disabled={isGrabbed}
                      className={`px-4 py-2 rounded-lg text-[9px] font-bold uppercase tracking-widest border transition-all ${
                        isGrabbed ? 'bg-green-500/10 border-green-500/20 text-green-500' : 
                        'bg-noir-950/60 border-white/10 text-white hover:bg-white/10 hover:border-white/20'
                      }`}
                    >
                      {isGrabbed ? '✓ Grabbed' : 'Grab'}
                    </button>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}
