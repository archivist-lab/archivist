import axios from 'axios'
import type { IndexerInstance } from './registry/indexer-store.js'
import type { IndexerDefinition } from './engine/definition-loader.js'

export interface TestResult {
  success: boolean
  message: string
  duration: number
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
]

export async function testIndexer(indexer: IndexerInstance, definition: IndexerDefinition, flareSolverrUrl?: string): Promise<TestResult> {
  const start = Date.now()
  
  // Combine all possible URLs: User provided, definition primary, and legacylinks mirrors
  const definitionUrls = [
    ...(definition.urls || []),
    ...(Array.isArray(definition.links) ? (definition.links as string[]) : []),
    ...(Array.isArray(definition.legacylinks) ? (definition.legacylinks as string[]) : [])
  ]

  const urlsToTry = [
    ...(indexer.baseUrl ? [indexer.baseUrl] : []),
    ...definitionUrls
  ].filter((v, i, a) => v && typeof v === 'string' && a.indexOf(v) === i)
  
  if (urlsToTry.length === 0) {
    return { success: false, message: 'No URLs available for this indexer', duration: Date.now() - start }
  }

  const allErrors: string[] = []
  
  const testUrl = async (url: string): Promise<TestResult> => {
    if (!url.startsWith('http')) url = `https://${url}`
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
    
    if (indexer.useFlareSolverr && flareSolverrUrl) {
      try {
        const response = await axios.post(`${flareSolverrUrl.replace(/\/$/, '')}/v1`, {
          cmd: 'request.get',
          url: url,
          maxTimeout: 60000,
        }, { timeout: 65000 })

        const data = response.data
        if (data.status === 'ok') {
          if (data.solution.status >= 400) {
            throw new Error(`HTTP ${data.solution.status}`)
          }
          return {
            success: true,
            message: `Successfully reached ${url} via FlareSolverr`,
            duration: Date.now() - start
          }
        } else {
          throw new Error(data.message || 'FlareSolverr failed')
        }
      } catch (err: any) {
        if (axios.isAxiosError(err) && err.response) {
          throw new Error(`FlareSolverr error (${err.response.status}): ${err.response.data?.message || err.message}`)
        }
        throw err
      }
    }

    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Referer': url,
    }

    if (indexer.apiKey) {
      headers['X-Api-Key'] = indexer.apiKey
      headers['Authorization'] = `Bearer ${indexer.apiKey}`
    }

    await axios.get(url, { 
      timeout: 10000,
      headers,
      maxRedirects: 5,
      validateStatus: (status) => status < 400,
    })

    return {
      success: true,
      message: `Successfully reached ${url}`,
      duration: Date.now() - start
    }
  }

  // Try in batches of 3 for efficiency
  const batchSize = 3
  for (let i = 0; i < urlsToTry.length; i += batchSize) {
    const batch = urlsToTry.slice(i, i + batchSize)
    try {
      // Promise.any returns the first one that succeeds
      return await Promise.any(batch.map(url => testUrl(url)))
    } catch (err: any) {
      if (err instanceof AggregateError) {
        err.errors.forEach((e, idx) => allErrors.push(`${batch[idx]}: ${e.message}`))
      } else {
        allErrors.push(err.message)
      }
    }
    
    // Safety break if we've been trying for too long (e.g. 45s)
    if (Date.now() - start > 45000) break
  }

  return { 
    success: false, 
    message: allErrors.length > 0 
      ? `Failed all ${urlsToTry.length} mirrors. Last errors: ${allErrors.slice(-2).join('; ')}`
      : 'Connection timed out or all mirrors unreachable.',
    duration: Date.now() - start 
  }
}
