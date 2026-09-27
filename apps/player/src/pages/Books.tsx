import type { ArchivistSdk } from '../lib/sdk.js'
import { ShelfBrowsePage } from './ShelfBrowse.js'

const load = (sdk: ArchivistSdk, signal: AbortSignal) => sdk.books(signal).then(r => r.books)

export function BooksPage({ sdk }: { sdk: ArchivistSdk }) {
  return <ShelfBrowsePage sdk={sdk} title="Books" accent="#f1c40f" load={load} routeFor={item => `/book/${item.id}`} />
}
