import { useEffect, useState } from 'react'
import { HowItWorks, HowItWorksStats, type HowItWorksContent } from '../../components/HowItWorks.js'
import { collectionsApi, type ArchivistCollection } from '../../lib/collections.api.js'

const CONTENT: HowItWorksContent = {
  title: 'How Collections work',
  accent: '#9B59B6',
  lede: 'A Collection is an editorial shelf you curate by hand. Unlike a List, nothing is matched, fetched or filtered — you choose the items, you choose their order, and the collection can mix media types that live in completely different libraries.',
  steps: [
    { title: 'Create', body: 'Give the collection a name and, optionally, a description and artwork: poster, backdrop and logo. Each can be a URL you already have, or an image you upload — JPEG, PNG, WebP or AVIF.' },
    { title: 'Add items', body: 'Search across every configured library at once — films, series, artists, albums, authors, books, comic series, comic issues and games. Filter by media type to narrow it. An item can belong to any number of collections.' },
    { title: 'Order', body: 'Collections are ordered lists, not sets. Move items up and down to set the running order; the position is stored, so the player and the editor always show the same sequence.' },
    { title: 'Use', body: 'Collections surface as their own results in player search and give film detail pages their collection banner, so a curated shelf is reachable from the sofa, not just the admin UI.' },
  ],
  levers: {
    title: 'What you control',
    items: [
      { label: 'Membership', what: 'Which library items belong to the collection.', effect: 'Membership is a reference — entity type, library and item id — so adding to a collection never copies, moves or re-encodes anything.' },
      { label: 'Order', what: 'The running order of the shelf.', effect: 'Positions are renumbered automatically when you remove an item, so there are never gaps in the sequence.' },
      { label: 'Artwork', what: 'Poster, backdrop and logo, by URL or upload.', effect: 'Uploads are validated by file signature — not just the extension — and stored under the collection’s own media folder. Replacing artwork removes the file it replaced.' },
      { label: 'Media-type filter', what: 'Narrows the candidate search when you are adding items.', effect: 'Search needs at least two characters and returns up to 100 matches, sorted by title.' },
    ],
  },
  cards: {
    title: 'Collections vs Lists',
    items: [
      { title: 'A Collection is manual', body: 'You put things in it. It never changes on its own, never refreshes, and never asks for approval.' },
      { title: 'A List is automatic', body: 'Rules describe what belongs, and Archivist keeps finding new matches on a schedule.' },
      { title: 'A Collection is cross-media', body: 'One shelf can hold a film, its soundtrack album, the novel and the tie-in game. Lists are scoped to a single film or series library.' },
      { title: 'A Collection is ordered', body: 'Sequence is part of the content — a viewing order, a chronology, a ranked list. List membership has no meaningful order.' },
    ],
  },
  glossary: [
    { term: 'Member', body: 'One library item inside the collection, held as a reference rather than a copy.' },
    { term: 'Entity type', body: 'What kind of thing a member is: film, series, artist, album, author, book, comic series, comic issue or game.' },
    { term: 'Position', body: 'Where a member sits in the running order, starting at zero and always contiguous.' },
    { term: 'Missing item', body: 'A member whose underlying library item has since been deleted. It is shown as unavailable rather than silently dropped, so you can see what changed and remove it deliberately.' },
    { term: 'Managed artwork', body: 'An image you uploaded, stored under the collection’s media folder. Artwork you supply by URL is left alone.' },
  ],
  safety: {
    items: [
      'Deleting a collection removes only the shelf and its uploaded artwork. Library items and media files are untouched.',
      'Removing an item from a collection does not remove it from its library.',
      'Collections are global, not per-library, which is what lets them span media types.',
      'Adding the same item twice is a no-op rather than an error, so re-adding after a search is safe.',
    ],
  },
}

export function CollectionsHowItWorks() {
  const [collections, setCollections] = useState<ArchivistCollection[] | null>(null)
  useEffect(() => { collectionsApi.list().then(result => setCollections(result.collections)).catch(() => setCollections([])) }, [])

  const items = (collections ?? []).reduce((sum, collection) => sum + (collection.memberCount ?? 0), 0)
  const withArtwork = (collections ?? []).filter(collection => collection.posterUrl || collection.backdropUrl || collection.logoUrl).length

  return (
    <HowItWorks content={CONTENT}>
      <HowItWorksStats tiles={[
        { label: 'Collections', value: collections ? String(collections.length) : '…', hint: 'Curated by hand' },
        { label: 'Items shelved', value: collections ? items.toLocaleString() : '…', hint: 'References, never copies' },
        { label: 'With artwork', value: collections ? String(withArtwork) : '…', hint: 'Poster, backdrop or logo set' },
        { label: 'Scope', value: 'All libraries', hint: 'Films, series, music, books, comics, games' },
      ]} />
    </HowItWorks>
  )
}
