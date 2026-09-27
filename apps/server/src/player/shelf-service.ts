import type { Database } from 'better-sqlite3'
import type { PlayerRatingProvider, PlayerShelfDetail, PlayerShelfKind } from '@archivist/contracts'
import { arcadeSystemForFile } from './arcade.js'

/**
 * Books, comics, games and albums for the Player.
 *
 * These four share a shape films and series do not: a cover rather than a
 * backdrop, an attribution rather than a cast, and children that are editions,
 * issues or tracks rather than seasons. One service serves all four so the
 * Player gets a consistent item view without four near-identical code paths.
 *
 * What none of them share with video is playback. Only an audiobook has
 * something the Player can actually play; an ebook, a .cbz, a ROM and a track
 * are files the Player cannot open, and the detail says so rather than
 * offering a Play button that fails.
 */

const parseJsonArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

const isAvailable = (status: unknown): boolean => status === 'collected' || status === 'downloaded'

function ratingsOf(value: unknown, provider: PlayerRatingProvider): PlayerShelfDetail['ratings'] {
  const numeric = Number(value)
  // IGDB scores are 0-100; the hero's stars read a 0-10 scale like every other
  // provider, so it is converted here rather than special-cased in the UI.
  return Number.isFinite(numeric) && numeric > 0
    ? [{ provider, value: numeric > 10 ? Math.round(numeric) / 10 : numeric, scale: 10 }]
    : []
}

function bookDetail(db: Database, id: number): PlayerShelfDetail | null {
  const book = db.prepare(`
    SELECT b.*, a.name AS author_name, a.library_id, a.image_url AS author_image
    FROM books b JOIN authors a ON a.id = b.author_id
    WHERE b.id = ?
  `).get(id) as any
  if (!book) return null
  const editions = db.prepare('SELECT * FROM book_editions WHERE book_id = ? ORDER BY kind').all(id) as any[]
  const children = editions.map(edition => {
    const available = isAvailable(edition.status)
    return {
      id: edition.id,
      label: edition.kind === 'audiobook' ? 'Audiobook' : 'Ebook',
      sublabel: [
        edition.container ? String(edition.container).toUpperCase() : null,
        edition.narrator ? `Read by ${edition.narrator}` : null,
        available ? null : edition.monitored ? 'Not acquired' : 'Not monitored',
      ].filter(Boolean).join(' · ') || null,
      available,
      // Only the audiobook is playable here. An ebook needs a reader the
      // Player does not have, so it never advertises a stream.
      streamUrl: available && edition.kind === 'audiobook' && edition.file_path
        ? `/api/v1/player/stream/book-editions/${edition.id}`
        : null,
    }
  })
  return {
    id: book.id,
    type: 'book',
    libraryId: Number(book.library_id),
    title: book.title,
    attribution: book.author_name ?? null,
    overview: book.overview ?? null,
    posterUrl: book.cover_url ?? null,
    backdropUrl: null,
    logoUrl: null,
    year: book.year ?? null,
    genres: parseJsonArray(book.genres),
    ratings: [],
    metadata: [
      book.published_date ?? (book.year ? String(book.year) : null),
      book.publisher,
      book.page_count ? `${book.page_count} pages` : null,
      book.series_name ? `${book.series_name}${book.series_position ? ` #${book.series_position}` : ''}` : null,
      book.isbn_13 ? `ISBN ${book.isbn_13}` : null,
    ].filter(Boolean).map(String),
    children,
    childrenLabel: 'Editions',
    status: book.status ?? 'missing',
    arcadeUrl: null,
  }
}

function comicDetail(db: Database, id: number): PlayerShelfDetail | null {
  const series = db.prepare('SELECT * FROM comic_series WHERE id = ?').get(id) as any
  if (!series) return null
  const issues = db.prepare(`
    SELECT * FROM comic_issues WHERE series_id = ?
    ORDER BY CAST(issue_number AS REAL), issue_number
  `).all(id) as any[]
  const collected = issues.filter(issue => isAvailable(issue.status)).length
  return {
    id: series.id,
    type: 'comic',
    libraryId: Number(series.library_id),
    title: series.title,
    attribution: series.publisher ?? null,
    overview: series.overview ?? null,
    posterUrl: series.image_url ?? null,
    backdropUrl: null,
    logoUrl: null,
    year: series.start_year ?? null,
    genres: parseJsonArray(series.genres),
    ratings: [],
    metadata: [
      series.start_year ? String(series.start_year) : null,
      series.publisher,
      `${collected}/${issues.length} issues`,
      series.status,
    ].filter(Boolean).map(String),
    children: issues.map(issue => ({
      id: issue.id,
      label: `#${issue.issue_number}${issue.title ? ` — ${issue.title}` : ''}`,
      sublabel: [issue.cover_date, isAvailable(issue.status) ? 'Available' : 'Missing'].filter(Boolean).join(' · ') || null,
      available: isAvailable(issue.status),
      // A .cbz needs a reader the Player does not have.
      streamUrl: null,
    })),
    childrenLabel: 'Issues',
    status: collected === 0 ? 'missing' : collected === issues.length ? 'collected' : 'partial',
    arcadeUrl: null,
  }
}

function gameDetail(db: Database, id: number): PlayerShelfDetail | null {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(id) as any
  if (!game) return null
  const platforms = parseJsonArray(game.platforms)
  const system = isAvailable(game.status) ? arcadeSystemForFile(game.file_path) : null
  return {
    id: game.id,
    type: 'game',
    libraryId: Number(game.library_id),
    title: game.title,
    attribution: game.developer ?? game.publisher ?? null,
    overview: game.overview ?? null,
    posterUrl: game.cover_url ?? null,
    backdropUrl: game.screenshot_url ?? null,
    logoUrl: null,
    year: game.year ?? null,
    genres: parseJsonArray(game.genres),
    ratings: ratingsOf(game.rating, 'igdb'),
    metadata: [
      game.release_date ?? (game.year ? String(game.year) : null),
      game.developer,
      platforms.length ? platforms.slice(0, 3).join(', ') : null,
      system ? system.label : null,
    ].filter(Boolean).map(String),
    children: [],
    childrenLabel: null,
    status: game.status ?? 'missing',
    // The Arcade scans ROM folders and cannot be pointed at one library row,
    // so this opens the Arcade rather than claiming to boot this exact file.
    arcadeUrl: system ? '/player/emu.html' : null,
  }
}

function albumDetail(db: Database, id: number): PlayerShelfDetail | null {
  const album = db.prepare(`
    SELECT al.*, ar.name AS artist_name, ar.library_id
    FROM albums al JOIN artists ar ON ar.id = al.artist_id
    WHERE al.id = ?
  `).get(id) as any
  if (!album) return null
  const tracks = db.prepare('SELECT * FROM tracks WHERE album_id = ? ORDER BY disc_number, track_number').all(id) as any[]
  const available = tracks.filter(track => isAvailable(track.status)).length
  return {
    id: album.id,
    type: 'album',
    libraryId: Number(album.library_id),
    title: album.title,
    attribution: album.artist_name ?? null,
    overview: null,
    posterUrl: album.cover_url ?? null,
    backdropUrl: null,
    logoUrl: null,
    year: album.year ?? null,
    genres: parseJsonArray(album.genres),
    ratings: [],
    metadata: [
      album.release_date ?? (album.year ? String(album.year) : null),
      album.label,
      album.album_type,
      `${available}/${tracks.length} tracks`,
    ].filter(Boolean).map(String),
    children: tracks.map(track => ({
      id: track.id,
      label: `${track.track_number ? `${track.track_number}. ` : ''}${track.title}`,
      sublabel: isAvailable(track.status) ? 'In your library' : 'Not in your library',
      available: isAvailable(track.status),
      // Audio has no playback surface in the Player yet — see the module note.
      streamUrl: null,
    })),
    childrenLabel: 'Tracks',
    status: available === 0 ? 'missing' : available === tracks.length ? 'collected' : 'partial',
    arcadeUrl: null,
  }
}

export function getShelfDetail(db: Database, kind: PlayerShelfKind, id: number): PlayerShelfDetail | null {
  if (kind === 'book') return bookDetail(db, id)
  if (kind === 'comic') return comicDetail(db, id)
  if (kind === 'album') return albumDetail(db, id)
  return gameDetail(db, id)
}
