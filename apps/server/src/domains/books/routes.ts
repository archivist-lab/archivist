import { Router } from 'express'
import axios from 'axios'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '@archivist/core'
import { domains } from '@archivist/contracts'
import { getDb } from '../../db.js'
import { sendToDownloadClient } from '../../services/download-manager.js'
import { getEnabledIndexerInstances, searchViaIndexers } from '../../services/indexer-bridge.js'
import { ScopedDownloadClientStore } from '../../shared/download-clients.js'
import { ensureAuthorFolder, ensureBookFolder } from '../../shared/media-organizer.js'
import { resolveLibraryRoot, safeDeleteMediaPath } from '../../shared/library-paths.js'
import { listAcquisitionHistoryForSubjectIds } from '../../services/acquisition-decisions.js'
import { requireLibrary } from '../../middleware/library-context.js'
import { validateBody } from '../../middleware/validate.js'
import { deleteExistingPath, registerAcquisitionControls } from '../../shared/acquisition-controls.js'
import { searchBooks, searchAuthors, getBooksByAuthor, getAuthor } from './google-books.js'
import { saveEntityImage } from '../../shared/image-save.js'
import { d } from './serialize.js'

const logger = createLogger('Books')

export function createBooksRouter(): Router {
  const router = Router()
  router.use('/books', requireLibrary)

  const db = getDb()
  const libId = (req: any): number => req.library.id
  const clientsFor = (req: any) => new ScopedDownloadClientStore(db, libId(req))

  registerAcquisitionControls(router, {
    basePath: '/books',
    idParam: 'id',
    mediaType: 'books',
    subjectType: 'book',
    table: 'books',
    selectSql: `
      SELECT b.*, a.name as author_name
      FROM books b JOIN authors a ON b.author_id = a.id
      WHERE b.id = ? AND a.library_id = ?`,
    title: row => `${row.author_name} - ${row.title}`,
    deserialise: d,
    repairChildren: (db, row, deleteFiles) => {
      const editions = db.prepare('SELECT id, file_path FROM book_editions WHERE book_id = ?').all(row.id) as Array<{ id: number; file_path?: string | null }>
      if (deleteFiles) editions.forEach(edition => deleteExistingPath(edition.file_path))
      db.prepare(`
        UPDATE book_editions
        SET status = 'missing',
            file_path = NULL,
            file_size = NULL
        WHERE book_id = ?
      `).run(row.id)
    },
  })

  router.get('/books/authors', (req, res) => {
    try {
      const authors = db.prepare(`
        SELECT a.*, COUNT(b.id) as book_count,
          SUM(CASE WHEN b.status='downloaded' THEN 1 ELSE 0 END) as downloaded_books
        FROM authors a LEFT JOIN books b ON b.author_id = a.id
        WHERE a.library_id = ?
        GROUP BY a.id ORDER BY a.sort_name ASC`).all(libId(req))
      res.json((authors as Record<string, unknown>[]).map(d))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/books/authors/:id', (req, res) => {
    try {
      const author = db.prepare('SELECT * FROM authors WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!author) return res.status(404).json({ error: 'Not found' })
      const books = db.prepare(`
        SELECT b.*, GROUP_CONCAT(be.format) as available_formats,
          SUM(CASE WHEN be.status='downloaded' THEN 1 ELSE 0 END) as downloaded_editions
        FROM books b LEFT JOIN book_editions be ON be.book_id = b.id
        WHERE b.author_id = ? GROUP BY b.id
        ORDER BY b.series_name, b.series_position, b.year DESC, b.title`).all(req.params.id)
      res.json({ ...d(author), books: (books as Record<string, unknown>[]).map(d) })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/books/authors', validateBody(domains.AddBookAuthor), async (req, res) => {
    try {
      const { name, monitored = true, rootFolderPath, seriesNames = [] } = req.body
      void rootFolderPath
      if (db.prepare('SELECT id FROM authors WHERE library_id = ? AND name = ?').get(libId(req), name)) {
        return res.status(409).json({ error: 'Author already in library' })
      }

      const authorInfo = await getAuthor(name)

      const { targetDir: authorDir, imageUrl: localAuthorImage } = await ensureAuthorFolder(authorInfo, resolveLibraryRoot(db, libId(req)))

      const result = db.prepare(`INSERT INTO authors (library_id, name, sort_name, overview, image_url, monitored, root_folder_path)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        libId(req),
        authorInfo.name,
        authorInfo.name.replace(/^(The|A|An)\s+/i, '').split(' ').reverse().join(', '),
        authorInfo.overview ?? null,
        localAuthorImage ?? authorInfo.imageUrl ?? null,
        monitored ? 1 : 0, authorDir)
      const authorId = result.lastInsertRowid as number

      const books = await getBooksByAuthor(authorInfo.name)
      let authorBooks = books.filter(b => b.authors.some((a: string) => a.toLowerCase().includes(authorInfo.name.toLowerCase())))

      if (seriesNames.length > 0) {
        authorBooks = authorBooks.filter(b => {
          const bookSeries = b.allSeries || (b.seriesName ? [b.seriesName] : [])
          const match = bookSeries.find(s => seriesNames.includes(s))
          if (match) {
            b.seriesName = match
            return true
          }
          return false
        })
      }

      for (const book of authorBooks.slice(0, 150)) {
        const existing = db.prepare('SELECT id, published_date FROM books WHERE author_id = ? AND title = ?').get(authorId, book.title) as any

        if (existing) {
          if (!existing.published_date && book.publishedDate) {
            db.prepare('UPDATE books SET published_date = ?, year = ?, google_books_id = COALESCE(google_books_id, ?) WHERE id = ?')
              .run(book.publishedDate, book.year ?? null, book.googleBooksId ?? null, existing.id)
          }
          continue
        }

        const { posterPath: localBookPoster } = await ensureBookFolder(authorInfo, book, resolveLibraryRoot(db, libId(req)))

        db.prepare(`INSERT INTO books (author_id, google_books_id, isbn_13, title, subtitle,
          series_name, series_position, published_date, year, publisher, page_count, overview, genres,
          cover_url, language, monitored, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'missing')`).run(
          authorId, book.googleBooksId ?? null, book.isbn13 ?? null, book.title, book.subtitle ?? null,
          book.seriesName ?? null, book.seriesPosition ?? null, book.publishedDate ?? null, book.year ?? null,
          book.publisher ?? null, book.pageCount ?? null, book.overview ?? null,
          JSON.stringify(book.genres), localBookPoster ?? book.coverUrl ?? null, book.language ?? 'en')
      }

      const author = db.prepare('SELECT * FROM authors WHERE id = ?').get(authorId)
      const insertedBooks = db.prepare('SELECT * FROM books WHERE author_id = ? ORDER BY year DESC').all(authorId)
      res.status(201).json({ ...d(author as Record<string, unknown>), books: (insertedBooks as Record<string, unknown>[]).map(d) })
    } catch (err) {
      logger.error('Failed to add author:', err)
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.put('/books/authors/:id/metadata', (req, res) => {
    try {
      const { name, overview, genres } = req.body
      const row = db.prepare('SELECT * FROM authors WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!row) return res.status(404).json({ error: 'Not found' })

      const sortName = name
        ? name.replace(/^(The|A|An)\s+/i, '').split(' ').reverse().join(', ')
        : null
      db.prepare(`
        UPDATE authors SET
          name = COALESCE(@name, name),
          sort_name = COALESCE(@sortName, sort_name),
          overview = COALESCE(@overview, overview),
          genres = COALESCE(@genres, genres),
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: row.id,
        name: name ?? null,
        sortName,
        overview: overview ?? null,
        genres: genres ? (typeof genres === 'string' ? genres : JSON.stringify(genres)) : null,
      })

      const updated = d(db.prepare('SELECT * FROM authors WHERE id = ?').get(row.id) as Record<string, unknown>) as any

      if (updated.root_folder_path && existsSync(updated.root_folder_path)) {
        try {
          const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n<author>\n  <name>${updated.name}</name>\n  <biography>${updated.overview || ''}</biography>\n</author>`
          writeFileSync(join(updated.root_folder_path, 'author.nfo'), nfo)
        } catch (nfoErr) {
          logger.warn(`Failed to write author.nfo: ${nfoErr instanceof Error ? nfoErr.message : String(nfoErr)}`)
        }
      }

      res.json(updated)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/books/:id/metadata', (req, res) => {
    try {
      const { title, subtitle, overview, publisher, year, published_date, page_count, genres, language, series_name, series_position } = req.body
      const book = db.prepare(`
        SELECT b.* FROM books b JOIN authors a ON b.author_id = a.id
        WHERE b.id = ? AND a.library_id = ?`).get(req.params.id, libId(req)) as Record<string, unknown> | undefined
      if (!book) return res.status(404).json({ error: 'Not found' })

      db.prepare(`
        UPDATE books SET
          title = COALESCE(@title, title),
          subtitle = COALESCE(@subtitle, subtitle),
          overview = COALESCE(@overview, overview),
          publisher = COALESCE(@publisher, publisher),
          year = COALESCE(@year, year),
          published_date = COALESCE(@published_date, published_date),
          page_count = COALESCE(@page_count, page_count),
          genres = COALESCE(@genres, genres),
          language = COALESCE(@language, language),
          series_name = COALESCE(@series_name, series_name),
          series_position = COALESCE(@series_position, series_position),
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: book.id,
        title: title ?? null,
        subtitle: subtitle ?? null,
        overview: overview ?? null,
        publisher: publisher ?? null,
        year: year ?? null,
        published_date: published_date ?? null,
        page_count: page_count ?? null,
        genres: genres ? (typeof genres === 'string' ? genres : JSON.stringify(genres)) : null,
        language: language ?? null,
        series_name: series_name ?? null,
        series_position: series_position ?? null,
      })

      res.json(d(db.prepare('SELECT * FROM books WHERE id = ?').get(book.id) as Record<string, unknown>))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/books/authors/:id/images', async (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM authors WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!row) return res.status(404).json({ error: 'Not found' })
      // No reliable author-photo provider — the UI offers a custom URL instead.
      const results: Array<{ url: string; source: string; type: string; language: string }> = []
      if (row.image_url) results.push({ url: row.image_url, source: 'Current', type: 'poster', language: 'null' })
      res.json(results)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/books/authors/:id/images', async (req, res) => {
    try {
      const { url, type } = req.body as { url: string; type: string }
      if (!url || !type) return res.status(400).json({ error: 'url and type required' })
      const row = db.prepare('SELECT * FROM authors WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (!row) return res.status(404).json({ error: 'Not found' })
      if (type !== 'poster') return res.status(400).json({ error: `Unknown image type: ${type}` })

      const saved = await saveEntityImage(row.root_folder_path, 'folder.jpg', url)
      db.prepare(`UPDATE authors SET image_url = ?, updated_at = datetime('now') WHERE id = ?`).run(saved.path, row.id)
      res.json({ success: true, path: saved.path })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/books/:id/images', async (req, res) => {
    try {
      const book = db.prepare(`
        SELECT b.* FROM books b JOIN authors a ON b.author_id = a.id
        WHERE b.id = ? AND a.library_id = ?`).get(req.params.id, libId(req)) as any
      if (!book) return res.status(404).json({ error: 'Not found' })
      const results: Array<{ url: string; source: string; type: string; language: string }> = []

      if (book.google_books_id) {
        try {
          const base = process.env.GOOGLE_BOOKS_BASE_URL ?? 'https://www.googleapis.com/books/v1'
          const volume = await axios.get(`${base}/volumes/${book.google_books_id}`, { timeout: 10000 })
          const links = volume.data?.volumeInfo?.imageLinks ?? {}
          for (const size of ['extraLarge', 'large', 'medium', 'thumbnail'] as const) {
            if (links[size]) {
              results.push({
                url: String(links[size]).replace('http:', 'https:'),
                source: 'Google Books',
                type: 'cover',
                language: 'null',
              })
            }
          }
        } catch (err) {
          logger.warn(`Google Books image lookup failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (book.isbn_13) {
        results.push({
          url: `https://covers.openlibrary.org/b/isbn/${book.isbn_13}-L.jpg`,
          source: 'OpenLibrary',
          type: 'cover',
          language: 'null',
        })
      }
      if (book.cover_url && !results.some(r => r.url === book.cover_url)) {
        results.push({ url: book.cover_url, source: 'Current', type: 'cover', language: 'null' })
      }

      res.json(results)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/books/:id/images', async (req, res) => {
    try {
      const { url, type } = req.body as { url: string; type: string }
      if (!url || !type) return res.status(400).json({ error: 'url and type required' })
      const book = db.prepare(`
        SELECT b.*, a.root_folder_path as author_root, a.name as author_name
        FROM books b JOIN authors a ON b.author_id = a.id
        WHERE b.id = ? AND a.library_id = ?`).get(req.params.id, libId(req)) as any
      if (!book) return res.status(404).json({ error: 'Not found' })
      if (type !== 'cover') return res.status(400).json({ error: `Unknown image type: ${type}` })

      const bookFolder = book.author_root
        ? join(book.author_root, `${book.title} (${book.year || 'TBA'})`.replace(/[:*?"<>|]/g, ''))
        : null
      const saved = await saveEntityImage(bookFolder, 'cover.jpg', url)
      db.prepare(`UPDATE books SET cover_url = ?, updated_at = datetime('now') WHERE id = ?`).run(saved.path, book.id)
      res.json({ success: true, path: saved.path })
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/books/authors/:id/acquisition-history', (req, res) => {
    try {
      const container = db.prepare('SELECT id FROM authors WHERE id = ? AND library_id = ?').get(req.params.id, libId(req))
      if (!container) return res.status(404).json({ error: 'Not found' })
      const childIds = (db.prepare('SELECT id FROM books WHERE author_id = ?').all(req.params.id) as Array<{ id: number }>).map(r => r.id)
      res.json(listAcquisitionHistoryForSubjectIds({ mediaType: 'books', subjectType: 'book', subjectIds: childIds }))
    } catch (err) { res.status(400).json({ error: String(err) }) }
  })

  router.delete('/books/authors/:id', (req, res) => {
    try {
      const deleteFiles = req.query.deleteFiles === 'true'
      const row = db.prepare('SELECT root_folder_path FROM authors WHERE id = ? AND library_id = ?').get(req.params.id, libId(req)) as any
      if (row && deleteFiles) safeDeleteMediaPath(row.root_folder_path)
      db.prepare('DELETE FROM authors WHERE id = ? AND library_id = ?').run(req.params.id, libId(req))
      res.status(204).send()
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.put('/books/:id', validateBody(domains.UpdateBook), (req, res) => {
    try {
      const { monitored, status } = req.body
      const book = db.prepare(`
        SELECT b.id FROM books b JOIN authors a ON b.author_id = a.id
        WHERE b.id = ? AND a.library_id = ?`).get(req.params.id, libId(req)) as { id: number } | undefined
      if (!book) return res.status(404).json({ error: 'Not found' })
      db.prepare(`UPDATE books SET monitored = COALESCE(@monitored, monitored), status = COALESCE(@status, status), updated_at = datetime('now') WHERE id = @id`)
        .run({ id: book.id, monitored: monitored !== undefined ? (monitored ? 1 : 0) : null, status: status ?? null })
      res.json(d(db.prepare('SELECT * FROM books WHERE id = ?').get(book.id) as Record<string, unknown>))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/books/:id/editions', validateBody(domains.AddBookEdition), (req, res) => {
    try {
      const { format } = req.body
      const result = db.prepare(`INSERT INTO book_editions (book_id, format, status) VALUES (?, ?, 'missing')`).run(req.params.id, format)
      res.status(201).json(db.prepare('SELECT * FROM book_editions WHERE id = ?').get(result.lastInsertRowid))
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.get('/books/lookup/authors', async (req, res) => {
    const { q } = req.query
    if (!q) return res.status(400).json({ error: 'q required' })
    try {
      const results = await searchAuthors(String(q))
      const authors = results.map(a => ({
        ...a,
        alreadyAdded: !!db.prepare('SELECT id FROM authors WHERE library_id = ? AND name = ?').get(libId(req), a.name),
      }))
      res.json(authors)
    } catch (err) {
      logger.warn('Author lookup failed:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: err instanceof Error ? err.message : 'Lookup failed' })
    }
  })

  router.get('/books/lookup/author/:name', async (req, res) => {
    try {
      res.json(await getAuthor(req.params.name))
    } catch (err) {
      res.status(500).json({ error: 'Author lookup failed' })
    }
  })

  router.get('/books/lookup/books', async (req, res) => {
    const { q, author } = req.query
    if (!q && !author) return res.status(400).json({ error: 'q or author required' })
    try {
      res.json(await searchBooks(String(q ?? ''), { author: author ? String(author) : undefined }))
    } catch (err) {
      logger.warn('Book lookup failed:', err instanceof Error ? err.message : String(err))
      res.status(500).json({ error: err instanceof Error ? err.message : 'Lookup failed' })
    }
  })

  router.post('/books/:id/auto-grab', async (req, res) => {
    try {
      const book = db.prepare(`
        SELECT b.*, a.name as authorName
        FROM books b JOIN authors a ON b.author_id = a.id
        WHERE b.id = ? AND a.library_id = ?`).get(req.params.id, libId(req)) as any
      if (!book) return res.status(404).json({ error: 'Book not found' })

      const query = `${book.authorName} ${book.title}`
      logger.info(`Auto-grabbing book: ${query}`)

      const enabledIndexers = getEnabledIndexerInstances()
      const results = await searchViaIndexers(enabledIndexers, query, { categories: [7000, 3030], type: 'book', module: 'books' })

      if (results.length === 0) {
        return res.json({ success: false, message: 'No releases found' })
      }

      const sorted = results.sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
      const best = sorted[0]

      const client = clientsFor(req).getEnabled()[0]
      if (!client) return res.status(400).json({ error: 'No download client enabled' })

      const result = await sendToDownloadClient(client, best.downloadUrl, 'archivist-books')
      if (result.success) {
        db.prepare("UPDATE books SET status = 'downloading', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run((result as any).infoHash ?? null, book.id)
      }

      res.json({ success: true, message: `Started downloading: ${best.title}` })
    } catch (err) {
      logger.error('Book auto-grab failed:', err)
      res.status(500).json({ error: String(err) })
    }
  })

  router.post('/books/download', validateBody(domains.DownloadBooks.passthrough()), async (req, res) => {
    try {
      const { downloadUrl, bookId } = req.body
      const clients = clientsFor(req).getEnabled()
      if (!clients.length) return res.status(400).json({ error: 'No enabled download clients' })
      const result = await sendToDownloadClient(clients[0], downloadUrl, 'archivist-books')
      if (result.success && bookId) {
        db.prepare("UPDATE books SET status = 'downloading', info_hash = ?, updated_at = datetime('now') WHERE id = ?").run((result as any).infoHash ?? null, bookId)
      }
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: String(err) })
    }
  })

  router.post('/books/refresh', (req, res) => {
    try {
      const authors = db.prepare('SELECT id, name FROM authors WHERE library_id = ?').all(libId(req)) as Array<{ id: number; name: string }>
      logger.info(`Starting refresh for ${authors.length} authors...`)
      res.json({ success: true, message: `Refresh started for ${authors.length} authors in background.` })

      ;(async () => {
        for (const author of authors) {
          try {
            const authorInfo = await getAuthor(author.name)
            await ensureAuthorFolder(authorInfo, resolveLibraryRoot(db, libId(req)))

            db.prepare(`UPDATE authors SET overview = ?, image_url = COALESCE(?, image_url), updated_at = datetime('now') WHERE id = ?`)
              .run(authorInfo.overview ?? null, authorInfo.imageUrl ?? null, author.id)

            const books = await getBooksByAuthor(author.name)
            for (const book of books) {
              const existing = db.prepare('SELECT id FROM books WHERE author_id = ? AND title = ?').get(author.id, book.title) as any
              if (existing) {
                db.prepare(`UPDATE books SET
                  google_books_id = COALESCE(google_books_id, ?),
                  isbn_13 = COALESCE(isbn_13, ?),
                  subtitle = COALESCE(subtitle, ?),
                  series_name = COALESCE(series_name, ?),
                  series_position = COALESCE(series_position, ?),
                  published_date = COALESCE(published_date, ?),
                  year = COALESCE(year, ?),
                  publisher = COALESCE(publisher, ?),
                  page_count = COALESCE(page_count, ?),
                  overview = COALESCE(overview, ?),
                  genres = COALESCE(genres, ?),
                  cover_url = COALESCE(?, cover_url),
                  updated_at = datetime('now')
                  WHERE id = ?`)
                  .run(
                    book.googleBooksId ?? null,
                    book.isbn13 ?? null,
                    book.subtitle ?? null,
                    book.seriesName ?? null,
                    book.seriesPosition ?? null,
                    book.publishedDate ?? null,
                    book.year ?? null,
                    book.publisher ?? null,
                    book.pageCount ?? null,
                    book.overview ?? null,
                    JSON.stringify(book.genres),
                    book.coverUrl ?? null,
                    existing.id,
                  )
              }
            }
          } catch (err) {
            logger.warn(`Failed to refresh author id=${author.id}:`, err)
          }
        }
        logger.info('Books refresh complete.')
      })().catch(err => logger.error('Background books refresh error:', err))
    } catch (err) {
      res.status(500).json({ error: 'Failed to start refresh' })
    }
  })

  return router
}
