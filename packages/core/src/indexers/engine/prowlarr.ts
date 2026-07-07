import axios from 'axios'
import { createLogger } from '../../utils/logger.js'
import { TIMEOUT_LONG } from '../../utils/constants.js'
import type { IndexerSearchResult } from './search.js'

const logger = createLogger('Prowlarr')

export async function searchProwlarr(
  url: string,
  apiKey: string,
  query: string,
  categories: number[] = [] // Empty array means "All"
): Promise<IndexerSearchResult[]> {
  const prowlarrUrl = url.replace(/\/$/, '')
  
  // Construct params manually to ensure correct array serialization (repeated keys)
  const searchParams = new URLSearchParams()
  searchParams.append('apikey', apiKey)
  searchParams.append('query', query)
  
  if (categories && categories.length > 0) {
    categories.forEach(cat => searchParams.append('categories', cat.toString()))
  }

  try {
    logger.info(`Searching Prowlarr for: "${query}" (Categories: ${categories.length > 0 ? categories.join(',') : 'All'})`)
    const res = await axios.get(`${prowlarrUrl}/api/v1/search?${searchParams.toString()}`, { 
      timeout: TIMEOUT_LONG 
    })
    
    const results = (res.data ?? []) as any[]
    logger.info(`Prowlarr found ${results.length} results`)

    return results.map(r => {
      // Prioritize magnet links (either direct or via infoHash) over download URLs
      // to avoid redirect issues and unnecessary .torrent fetching.
      let downloadUrl = r.magnetUri
      
      if (!downloadUrl && r.infoHash) {
        downloadUrl = `magnet:?xt=urn:btih:${r.infoHash}&dn=${encodeURIComponent(r.title)}`
      }
      
      if (!downloadUrl) {
        downloadUrl = r.downloadUrl
      }
      
      if (downloadUrl && downloadUrl.startsWith('/') && !downloadUrl.startsWith('//')) {
        downloadUrl = `${prowlarrUrl}${downloadUrl}`
      }

      return {
        guid: r.infoHash || r.guid || r.downloadUrl,
        title: r.title,
        downloadUrl: downloadUrl,
        size: r.size,
        seeders: r.seeders,
        leechers: r.leechers,
        publishDate: r.publishDate,
        indexerName: r.indexer,
      }
    }).filter(r => !!r.downloadUrl)
  } catch (err) {
    logger.error('Prowlarr search failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}
