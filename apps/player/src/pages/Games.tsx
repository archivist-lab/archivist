import type { ArchivistSdk } from '../lib/sdk.js'
import { ShelfBrowsePage } from './ShelfBrowse.js'

const load = (sdk: ArchivistSdk, signal: AbortSignal) => sdk.games(signal).then(r => r.games)

export function GamesPage({ sdk }: { sdk: ArchivistSdk }) {
  return <ShelfBrowsePage sdk={sdk} title="Games" accent="#2ecc71" load={load} routeFor={item => `/game/${item.id}`} />
}
