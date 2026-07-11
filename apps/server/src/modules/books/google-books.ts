import axios from 'axios'

const GOOGLE_BASE = process.env.GOOGLE_BOOKS_BASE_URL ?? 'https://www.googleapis.com/books/v1'
const OL_BASE = process.env.OPENLIBRARY_BASE_URL ?? 'https://openlibrary.org'

export interface BookResult {
  googleBooksId?: string; openLibraryId?: string; isbn13?: string
  title: string; subtitle?: string; authors: string[]
  publishedDate?: string; year?: number; publisher?: string; pageCount?: number
  overview?: string; genres: string[]; coverUrl?: string; language?: string
  seriesName?: string; seriesPosition?: number; source: 'google' | 'openlibrary'
  allSeries?: string[]
}

export interface AuthorResult {
  name: string; 
  openLibraryId?: string; 
  overview?: string; 
  imageUrl?: string;
  bookCount?: number;
  genres?: string[];
  series?: string[]; 
}

function googleKey(): string { return process.env.GOOGLE_BOOKS_API_KEY ?? '' }

export async function searchBooks(query: string, options: { author?: string, orderBy?: 'relevance' | 'newest' } = {}): Promise<BookResult[]> {
  let q = query
  if (options.author) q += ` inauthor:${options.author}`
  try {
    const res = await axios.get(`${GOOGLE_BASE}/volumes`, {
      params: { 
        q, 
        maxResults: 40, 
        orderBy: options.orderBy || 'relevance',
        key: googleKey() || undefined 
      },
      timeout: 10000,
    })
    return (res.data.items ?? []).map(parseGoogleBook)
  } catch {
    return searchOpenLibrary(query)
  }
}

export async function searchAuthors(query: string): Promise<AuthorResult[]> {
  try {
    const olRes = await axios.get(`${OL_BASE}/search/authors.json`, { 
      params: { q: query, limit: 20 }, 
      timeout: 10000 
    })
    
    if (olRes.data.docs && olRes.data.docs.length > 0) {
      const seen = new Set<string>()
      const results: AuthorResult[] = []
      for (const a of olRes.data.docs) {
        if (!a.name || seen.has(a.name.toLowerCase())) continue
        seen.add(a.name.toLowerCase())
        results.push({
          name: a.name,
          openLibraryId: a.key,
          overview: a.top_work, 
          imageUrl: a.key ? `https://covers.openlibrary.org/a/olid/${a.key}-L.jpg` : undefined,
          bookCount: a.work_count
        })
      }
      return results
    }

    const res = await axios.get(`${GOOGLE_BASE}/volumes`, {
      params: { q: `inauthor:${query}`, maxResults: 40, key: googleKey() || undefined },
      timeout: 10000,
    })
    const authorMap = new Map<string, AuthorResult>()
    for (const item of (res.data.items ?? [])) {
      for (const author of (item.volumeInfo?.authors ?? [])) {
        if (author.toLowerCase().includes(query.toLowerCase())) {
          const existing = authorMap.get(author)
          if (existing) existing.bookCount! += 1
          else authorMap.set(author, { name: author, bookCount: 1 })
        }
      }
    }
    return Array.from(authorMap.values()).sort((a, b) => (b.bookCount ?? 0) - (a.bookCount ?? 0))
  } catch {
    return []
  }
}

export async function getAuthor(nameOrId: string): Promise<AuthorResult> {
  let author: AuthorResult = { name: '' }
  try {
    if (nameOrId.startsWith('OL')) {
      const res = await axios.get(`${OL_BASE}/authors/${nameOrId}.json`, { timeout: 10000 })
      author = {
        name: res.data.name,
        openLibraryId: nameOrId,
        overview: typeof res.data.bio === 'string' ? res.data.bio : res.data.bio?.value,
        imageUrl: `https://covers.openlibrary.org/a/olid/${nameOrId}-L.jpg`,
      }
    } else {
      const search = await searchAuthors(nameOrId)
      if (search.length > 0) {
        if (search[0].openLibraryId) return await getAuthor(search[0].openLibraryId)
        author = search[0]
      } else {
        author = { name: nameOrId }
      }
    }

    const olRes = await axios.get(`${OL_BASE}/search.json`, {
      params: { author: author.name, limit: 100, fields: 'series_name' },
      timeout: 10000,
    })
    
    const seriesSet = new Set<string>()
    if (olRes.data.docs) {
      for (const doc of olRes.data.docs) {
        if (Array.isArray(doc.series_name)) {
          doc.series_name.forEach((s: string) => seriesSet.add(s))
        }
      }
    }
    author.series = Array.from(seriesSet).sort()
    
    return author
  } catch {
    return { name: nameOrId }
  }
}

function parseAnyDate(dateStr?: string): string | undefined {
  if (!dateStr) return undefined
  // Handle YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr
  // Handle YYYY
  if (/^\d{4}$/.test(dateStr)) return `${dateStr}-01-01`
  
  try {
    const d = new Date(dateStr)
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0]
    }
  } catch {}
  return undefined
}

export async function getBooksByAuthor(authorName: string): Promise<BookResult[]> {
  // Fetch both relevance and newest to cover all bases (especially future releases)
  const [googleBooksRel, googleBooksNew] = await Promise.all([
    searchBooks('', { author: authorName, orderBy: 'relevance' }),
    searchBooks('', { author: authorName, orderBy: 'newest' })
  ])

  const googleBooks = [...googleBooksRel]
  for (const nb of googleBooksNew) {
    if (!googleBooks.find(b => b.googleBooksId === nb.googleBooksId)) {
      googleBooks.push(nb)
    }
  }
  
  try {
    const olRes = await axios.get(`${OL_BASE}/search.json`, {
      params: { author: authorName, limit: 100, fields: 'key,title,author_name,publish_date,first_publish_year,isbn,cover_i,subject,publisher,number_of_pages_median,series_name,series_position' },
      timeout: 10000,
    })
    
    const olBooks = await Promise.all((olRes.data.docs ?? []).map(async (doc: any): Promise<BookResult> => {
      // For detailed description, we often need to hit the specific Work API
      let overview = undefined
      try {
        const workRes = await axios.get(`${OL_BASE}${doc.key}.json`, { timeout: 5000 })
        overview = typeof workRes.data.description === 'string' ? workRes.data.description : workRes.data.description?.value
      } catch {}

      const publishedDate = parseAnyDate(doc.publish_date?.[0]) || (doc.first_publish_year ? `${doc.first_publish_year}-01-01` : undefined)

      return {
        openLibraryId: doc.key, isbn13: doc.isbn?.find((i: string) => i.length === 13),
        title: doc.title, authors: doc.author_name ?? [], year: doc.first_publish_year,
        publishedDate,
        publisher: doc.publisher?.[0], pageCount: doc.number_of_pages_median,
        genres: (doc.subject ?? []).slice(0, 5),
        coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : undefined,
        language: 'en', source: 'openlibrary',
        seriesName: Array.isArray(doc.series_name) ? doc.series_name[0] : undefined,
        allSeries: Array.isArray(doc.series_name) ? doc.series_name : [],
        seriesPosition: Array.isArray(doc.series_position) ? parseFloat(doc.series_position[0]) : undefined,
        overview
      }
    }))
    
    const combined = [...googleBooks]
    for (const ob of olBooks) {
      const existing = combined.find(b => b.title.toLowerCase() === ob.title.toLowerCase())
      if (!existing) {
        combined.push(ob)
      } else {
        // Merge missing fields
        if (!existing.publishedDate && ob.publishedDate) {
          existing.publishedDate = ob.publishedDate
        }
        if (!existing.seriesName && ob.seriesName) {
          existing.seriesName = ob.seriesName
          existing.seriesPosition = ob.seriesPosition
        }
        if (!existing.overview && ob.overview) {
          existing.overview = ob.overview
        }
        if (!existing.coverUrl && ob.coverUrl) {
          existing.coverUrl = ob.coverUrl
        }
      }
    }
    return combined
  } catch (err) {
    return googleBooks
  }
}

async function searchOpenLibrary(query: string): Promise<BookResult[]> {
  try {
    const res = await axios.get(`${OL_BASE}/search.json`, {
      params: { q: query, limit: 20, fields: 'key,title,author_name,publish_date,first_publish_year,isbn,cover_i,subject,publisher,number_of_pages_median,series_name,series_position' },
      timeout: 10000,
    })
    return (res.data.docs ?? []).map((doc: any): BookResult => ({
      openLibraryId: doc.key, isbn13: doc.isbn?.find((i: string) => i.length === 13),
      title: doc.title, authors: doc.author_name ?? [], year: doc.first_publish_year,
      publishedDate: parseAnyDate(doc.publish_date?.[0]) || (doc.first_publish_year ? `${doc.first_publish_year}-01-01` : undefined),
      publisher: doc.publisher?.[0], pageCount: doc.number_of_pages_median,
      genres: (doc.subject ?? []).slice(0, 5),
      coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : undefined,
      language: 'en', source: 'openlibrary',
      seriesName: Array.isArray(doc.series_name) ? doc.series_name[0] : undefined,
      seriesPosition: Array.isArray(doc.series_position) ? parseFloat(doc.series_position[0]) : undefined
    }))
  } catch { return [] }
}

function parseGoogleBook(item: any): BookResult {
  const info = item.volumeInfo ?? {}
  const year = info.publishedDate ? parseInt(info.publishedDate.slice(0, 4), 10) : undefined
  let seriesName: string | undefined, seriesPosition: number | undefined
  
  const seriesMatch = info.title?.match(/\((.+?),\s*#?([\d.]+)\)$/) || info.title?.match(/\((.+?)\s*#?([\d.]+)\)$/)
  if (seriesMatch) { 
    seriesName = seriesMatch[1].trim()
    seriesPosition = parseFloat(seriesMatch[2]) 
  } else {
    const subMatch = info.subtitle?.match(/Book\s+(\d+)/i)
    if (subMatch) seriesPosition = parseFloat(subMatch[1])
  }

  if (!seriesName) {
    const epicMatch = info.description?.match(/part\s+of\s+the\s+([^.]+)\s+series/i)
    if (epicMatch) seriesName = epicMatch[1].trim()
  }

  return {
    googleBooksId: item.id,
    isbn13: info.industryIdentifiers?.find((i: any) => i.type === 'ISBN_13')?.identifier,
    title: info.title ?? 'Unknown', subtitle: info.subtitle,
    authors: info.authors ?? [], publishedDate: info.publishedDate, year,
    publisher: info.publisher, pageCount: info.pageCount, overview: info.description,
    genres: info.categories ?? [],
    coverUrl: info.imageLinks?.thumbnail?.replace('http:', 'https:').replace('zoom=1', 'zoom=2'),
    language: info.language ?? 'en', seriesName, seriesPosition, source: 'google',
    allSeries: seriesName ? [seriesName] : [],
  }
}
