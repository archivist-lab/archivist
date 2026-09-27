import type { ArchivistSdk } from '../lib/sdk.js'
import { ShelfBrowsePage } from './ShelfBrowse.js'

const load = (sdk: ArchivistSdk, signal: AbortSignal) => sdk.albums(signal).then(r => r.albums)

export function MusicPage({ sdk }: { sdk: ArchivistSdk }) {
  return <ShelfBrowsePage sdk={sdk} title="Music" accent="#ff2d78" load={load} routeFor={item => `/album/${item.id}`} />
}
