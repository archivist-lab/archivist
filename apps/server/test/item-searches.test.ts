import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { startTestApp, type TestHarness } from './helpers.js'

let h: TestHarness

after(async () => {
  await h?.close()
})

test('discography search uses one focused artist query', async () => {
  const { discographySearchTerms } = await import('../src/services/item-searches.js')
  assert.deepEqual(discographySearchTerms('The Beatles'), ['The Beatles discography'])
})

test('item searches are durable, deduplicated, FIFO queued, cancellable, and expire', async () => {
  h = await startTestApp()
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  const libraryId = Number(
    db
      .prepare(`
    INSERT INTO libraries (name, media_type, db_path) VALUES ('Search Queue Films', 'films', 'search-queue-films')
  `)
      .run().lastInsertRowid,
  )
  const firstFilmId = Number(db.prepare("INSERT INTO films (library_id, title, year) VALUES (?, 'First Search', 2025)").run(libraryId).lastInsertRowid)
  const secondFilmId = Number(db.prepare("INSERT INTO films (library_id, title, year) VALUES (?, 'Second Search', 2026)").run(libraryId).lastInsertRowid)
  const headers = { 'x-tab-context': String(libraryId) }

  const first = await h.request('POST', '/api/v1/item-searches', {
    headers,
    body: { mediaType: 'films', subjectType: 'film', subjectId: firstFilmId, mode: 'deep' },
  })
  assert.equal(first.status, 202)
  assert.equal(first.json.search.status, 'queued')
  assert.equal(first.json.search.queuePosition, 1)

  const duplicate = await h.request('POST', '/api/v1/item-searches', {
    headers,
    body: { mediaType: 'films', subjectType: 'film', subjectId: firstFilmId, mode: 'deep' },
  })
  assert.equal(duplicate.json.search.id, first.json.search.id, 'an active subject/mode search must not be duplicated')

  const second = await h.request('POST', '/api/v1/item-searches', {
    headers,
    body: { mediaType: 'films', subjectType: 'film', subjectId: secondFilmId, mode: 'quick' },
  })
  assert.equal(second.status, 202)
  assert.equal(second.json.search.queuePosition, 2)

  const restored = await h.request('GET', `/api/v1/item-searches/latest?mediaType=films&subjectType=film&subjectId=${firstFilmId}`, { headers })
  assert.equal(restored.status, 200)
  assert.equal(restored.json.search.id, first.json.search.id, 'a later page load must recover the durable search')

  const cancelled = await h.request('DELETE', `/api/v1/item-searches/${first.json.search.id}`, { headers })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.json.search.status, 'cancelled')
  const next = await h.request('GET', `/api/v1/item-searches/${second.json.search.id}`, { headers })
  assert.equal(next.json.search.queuePosition, 1, 'cancelling the head should advance the next queued search')

  db.prepare(`
    UPDATE item_searches SET status = 'complete', completed_at = datetime('now', '-16 minutes'),
      expires_at = datetime('now', '-1 minute') WHERE id = ?
  `).run(second.json.search.id)
  const expired = await h.request('GET', `/api/v1/item-searches/${second.json.search.id}`, { headers })
  assert.equal(expired.status, 404)
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM item_searches WHERE id = ?').get(second.json.search.id) as { count: number }).count, 0)

  const musicLibraryId = Number(
    db
      .prepare(`
    INSERT INTO libraries (name, media_type, db_path) VALUES ('Search Queue Music', 'music', 'search-queue-music')
  `)
      .run().lastInsertRowid,
  )
  const artistId = Number(db.prepare("INSERT INTO artists (library_id, name) VALUES (?, 'Durable Artist')").run(musicLibraryId).lastInsertRowid)
  const albumId = Number(
    db.prepare("INSERT INTO albums (artist_id, title, album_type, track_count) VALUES (?, 'Durable Album', 'Album', 10)").run(artistId).lastInsertRowid,
  )
  const musicHeaders = { 'x-tab-context': String(musicLibraryId) }

  const music = await h.request('POST', '/api/v1/item-searches', {
    headers: musicHeaders,
    body: { mediaType: 'music', subjectType: 'album', subjectId: albumId, mode: 'deep' },
  })
  assert.equal(music.status, 202)
  assert.equal(music.json.search.mediaType, 'music')
  assert.equal(music.json.search.subjectType, 'album')
  assert.equal(music.json.search.status, 'queued')

  const restoredMusic = await h.request('GET', `/api/v1/item-searches/latest?mediaType=music&subjectType=album&subjectId=${albumId}`, { headers: musicHeaders })
  assert.equal(restoredMusic.status, 200)
  assert.equal(restoredMusic.json.search.id, music.json.search.id)

  const discography = await h.request('POST', '/api/v1/item-searches', {
    headers: musicHeaders,
    body: { mediaType: 'music', subjectType: 'artist', subjectId: artistId, mode: 'deep' },
  })
  assert.equal(discography.status, 202)
  assert.equal(discography.json.search.subjectType, 'artist')
  const selectedDiscography = {
    guid: 'durable-discography',
    title: 'Durable Artist Complete Discography 2001-2026 FLAC',
    downloadUrl: 'magnet:?xt=urn:btih:3333333333333333333333333333333333333333',
    indexerName: 'Test Music Indexer',
  }
  const discographyGrab = await h.request('POST', '/api/v1/item-searches', {
    headers: musicHeaders,
    body: {
      mediaType: 'music',
      subjectType: 'artist',
      subjectId: artistId,
      mode: 'auto',
      options: { selectedRelease: selectedDiscography },
    },
  })
  assert.equal(discographyGrab.status, 202)
  assert.deepEqual(discographyGrab.json.search.options.selectedRelease, selectedDiscography)

  const wrongLibrary = await h.request('POST', '/api/v1/item-searches', {
    headers,
    body: { mediaType: 'music', subjectType: 'album', subjectId: albumId, mode: 'quick' },
  })
  assert.equal(wrongLibrary.status, 400, 'an album search cannot cross library boundaries')

  const manualRelease = {
    downloadUrl: 'magnet:?xt=urn:btih:1111111111111111111111111111111111111111',
    albumId,
    releaseTitle: 'Durable Artist - Durable Album FLAC',
    releaseGuid: 'durable-album-release',
    indexerName: 'Test Music Indexer',
    seeders: 12,
  }
  db.prepare(`
    INSERT INTO download_clients (
      library_id, name, type, host, port, use_ssl, url_base, category, enabled, priority, tags
    ) VALUES (?, 'Unavailable test client', 'qbittorrent', '127.0.0.1', 1, 0, '', 'archivist-music', 1, 1, '[]')
  `).run(musicLibraryId)

  const invalidDiscography = {
    guid: 'manual-not-a-discography',
    title: 'Someone Else - One Album FLAC',
    downloadUrl: 'magnet:?xt=urn:btih:5555555555555555555555555555555555555555',
    indexerName: 'Test Music Indexer',
    seeders: 20,
  }
  const rejectedDiscography = await h.request('POST', `/api/v1/music/artists/${artistId}/grab-discography`, {
    headers: musicHeaders,
    body: { downloadUrl: invalidDiscography.downloadUrl, title: invalidDiscography.title, release: invalidDiscography },
  })
  assert.equal(rejectedDiscography.status, 200)
  assert.equal(rejectedDiscography.json.success, false)
  assert.match(rejectedDiscography.json.message, /not an artist discography pack/)
  assert.deepEqual(
    db
      .prepare(`SELECT subject_type, subject_id, accepted, grabbed
    FROM acquisition_decisions WHERE release_guid = ? ORDER BY id DESC LIMIT 1`)
      .get(invalidDiscography.guid),
    {
      subject_type: 'artist',
      subject_id: String(artistId),
      accepted: 0,
      grabbed: 0,
    },
    'direct discography selection must retain appraisal evidence without entering the search queue',
  )

  const manualDiscography = {
    ...selectedDiscography,
    seeders: 20,
  }
  const failedDiscographySubmission = await h.request('POST', `/api/v1/music/artists/${artistId}/grab-discography`, {
    headers: musicHeaders,
    body: { downloadUrl: manualDiscography.downloadUrl, title: manualDiscography.title, release: manualDiscography },
  })
  assert.equal(failedDiscographySubmission.status, 200)
  assert.equal(failedDiscographySubmission.json.success, false)
  assert.deepEqual(
    db
      .prepare(`SELECT subject_type, subject_id, accepted, grabbed
    FROM acquisition_decisions WHERE release_guid = ? ORDER BY id DESC LIMIT 1`)
      .get(manualDiscography.guid),
    {
      subject_type: 'artist',
      subject_id: String(artistId),
      accepted: 1,
      grabbed: 0,
    },
    'a selected discography is appraised immediately and advances only after the client accepts it',
  )
  assert.equal((db.prepare('SELECT discography_status FROM artists WHERE id = ?').get(artistId) as any).discography_status, null)

  const statusBeforeFailedGrab = (db.prepare('SELECT status FROM albums WHERE id = ?').get(albumId) as { status: string }).status
  const withoutClient = await h.request('POST', '/api/v1/music/download', {
    headers: musicHeaders,
    body: manualRelease,
  })
  assert.equal(withoutClient.status, 200)
  assert.equal(withoutClient.json.success, false)
  assert.equal(typeof withoutClient.json.message, 'string')
  assert.notEqual(withoutClient.json.message.length, 0)
  const recorded = db
    .prepare(`
    SELECT source, media_type, subject_type, subject_id, accepted, grabbed
    FROM acquisition_decisions WHERE release_guid = ? ORDER BY id DESC LIMIT 1
  `)
    .get(manualRelease.releaseGuid) as any
  assert.deepEqual(
    recorded,
    {
      source: 'manual',
      media_type: 'music',
      subject_type: 'album',
      subject_id: String(albumId),
      accepted: 1,
      grabbed: 0,
    },
    'manual Music grabs must be audited even when submission cannot start',
  )
  assert.equal((db.prepare('SELECT status FROM albums WHERE id = ?').get(albumId) as { status: string }).status, statusBeforeFailedGrab)

  const { blockRelease, findBlockedInfoHash } = await import('../src/services/acquisition-decisions.js')
  blockRelease({
    releaseGuid: manualRelease.releaseGuid,
    downloadUrl: manualRelease.downloadUrl,
    releaseTitle: manualRelease.releaseTitle,
    reason: 'test block',
    tabId: musicLibraryId,
    mediaType: 'music',
    subjectType: 'album',
    subjectId: albumId,
  })
  const blocked = await h.request('POST', '/api/v1/music/download', {
    headers: musicHeaders,
    body: manualRelease,
  })
  assert.equal(blocked.status, 200)
  assert.equal(blocked.json.success, false)
  assert.match(blocked.json.message, /release blocked: test block/)
  const blockedDecision = db
    .prepare(`
    SELECT accepted, rejection_reasons FROM acquisition_decisions
    WHERE release_guid = ? ORDER BY id DESC LIMIT 1
  `)
    .get(manualRelease.releaseGuid) as { accepted: number; rejection_reasons: string }
  assert.equal(blockedDecision.accepted, 0)
  assert.match(blockedDecision.rejection_reasons, /release blocked: test block/)
  assert.equal(
    findBlockedInfoHash('1111111111111111111111111111111111111111')?.reason,
    'test block',
    'a hash learned only after resolving an indexer details page must still hit the blocklist',
  )
  assert.equal(findBlockedInfoHash('not-an-info-hash'), null)
  const { sendToDownloadClient } = await import('../src/services/download-manager.js')
  const blockedAfterResolution = await sendToDownloadClient(
    { name: 'must not be contacted', type: 'qbittorrent', host: '127.0.0.1', port: 1 },
    manualRelease.downloadUrl,
    'archivist-music',
  )
  assert.equal(blockedAfterResolution.success, false)
  assert.match(blockedAfterResolution.message, /Release is blocklisted: test block/)

  db.prepare(`UPDATE acquisition_decisions SET grabbed = 1 WHERE id = (
    SELECT id FROM acquisition_decisions WHERE release_guid = ? ORDER BY id ASC LIMIT 1
  )`).run(manualRelease.releaseGuid)
  const { findMusicAlbumTorrentFromDecision } = await import('../src/shared/monitor.js')
  const delayedTorrent = {
    id: 'runtime-delayed',
    infoHash: '2222222222222222222222222222222222222222',
    name: 'Durable.Artist-Durable.Album.FLAC',
  }
  assert.equal(
    findMusicAlbumTorrentFromDecision(db, albumId, [delayedTorrent, { ...delayedTorrent, id: 'duplicate' }]),
    null,
    'ambiguous runtime matches must remain unlinked',
  )
  assert.equal(
    findMusicAlbumTorrentFromDecision(db, albumId, [delayedTorrent])?.id,
    delayedTorrent.id,
    'a unique exact release-title match should recover a delayed Music info hash',
  )
  const correlatedDecision = db
    .prepare(`SELECT runtime_torrent_id, info_hash, correlation_status
    FROM acquisition_decisions WHERE release_guid = ? ORDER BY id ASC LIMIT 1`)
    .get(manualRelease.releaseGuid) as any
  assert.deepEqual(correlatedDecision, {
    runtime_torrent_id: delayedTorrent.id,
    info_hash: delayedTorrent.infoHash,
    correlation_status: 'matched',
  })
  const { musicSwarmAdjustment, recordMusicSwarmOutcome } = await import('../src/services/music-swarm.js')
  const observedTarget = recordMusicSwarmOutcome(delayedTorrent.infoHash, 'metadata-succeeded', db)
  assert.deepEqual(observedTarget, {
    libraryId: musicLibraryId,
    subjectType: 'album',
    subjectId: albumId,
    failedAttempts: 0,
  })
  assert.equal(
    musicSwarmAdjustment(
      {
        title: 'Durable Artist - Durable Album FLAC',
        downloadUrl: `magnet:?xt=urn:btih:${delayedTorrent.infoHash}`,
        indexerName: 'Test Music Indexer',
      },
      db,
    ),
    5,
    'a hash with proven metadata receives the strongest local reliability signal',
  )
  recordMusicSwarmOutcome(delayedTorrent.infoHash, 'metadata-succeeded', db)
  assert.equal(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM music_swarm_observations
    WHERE info_hash = ? AND outcome = 'metadata-succeeded'`)
        .get(delayedTorrent.infoHash) as { count: number }
    ).count,
    1,
    'repeated torrent updates must not duplicate observations',
  )
  const { handleTorrentMetadataFailure } = await import('../src/services/metadata-fallback.js')
  const fallbackResult = handleTorrentMetadataFailure({
    infoHash: delayedTorrent.infoHash,
    releaseTitle: delayedTorrent.name,
    torrentId: delayedTorrent.id,
    error: 'Metadata fetch timed out after test deadline',
  })
  assert.equal(fallbackResult.fallbackQueued, true)
  assert.equal(typeof fallbackResult.itemSearchId, 'number')
  assert.deepEqual(
    db.prepare('SELECT media_type, subject_type, subject_id, mode, status FROM item_searches WHERE id = ?').get(fallbackResult.itemSearchId!),
    {
      media_type: 'music',
      subject_type: 'album',
      subject_id: albumId,
      mode: 'auto',
      status: 'queued',
    },
    'metadata timeout must durably enqueue the next normal Music automatic search',
  )
  assert.equal(
    musicSwarmAdjustment(
      {
        title: 'Durable Artist - Durable Album FLAC',
        downloadUrl: `magnet:?xt=urn:btih:${delayedTorrent.infoHash}`,
      },
      db,
    ),
    -50,
    'a metadata-failed hash must fall behind every unfailed candidate',
  )
  assert.equal(
    findMusicAlbumTorrentFromDecision(db, albumId, [{ ...delayedTorrent, name: 'metadata arrived with a different display name' }])?.id,
    delayedTorrent.id,
    'persisted runtime IDs must remain authoritative after the torrent display name changes',
  )

  const repairAlbumId = Number(
    db
      .prepare("INSERT INTO albums (artist_id, musicbrainz_id, title, album_type, status) VALUES (?, 'repair-album', 'Repair Album', 'Album', 'acquiring')")
      .run(artistId).lastInsertRowid,
  )
  db.prepare("INSERT INTO tracks (album_id, artist_id, title, track_number, status) VALUES (?, ?, 'Track One', 1, 'acquiring')").run(repairAlbumId, artistId)
  const { evaluateRelease, markDecisionGrabbed, recordReleaseDecision } = await import('../src/services/acquisition-decisions.js')
  const repairContext = {
    source: 'manual' as const,
    tabId: musicLibraryId,
    tabName: 'Search Queue Music',
    mediaType: 'music',
    subjectType: 'album',
    subjectId: repairAlbumId,
    subjectTitle: 'Durable Artist - Repair Album',
  }
  const repairRelease = { guid: 'repair-release', title: 'Durable Artist - Repair Album FLAC', downloadUrl: 'https://indexer.test/details/repair' }
  const repairDecisionId = recordReleaseDecision(repairContext, evaluateRelease(repairContext, repairRelease))
  markDecisionGrabbed(repairDecisionId, { success: true, runtimeTorrentId: 'repair-runtime' })
  const { auditMusicState, applyMusicRepairs } = await import('../src/services/music-repair.js')
  const repairTorrent = { id: 'repair-runtime', infoHash: '4444444444444444444444444444444444444444', name: repairRelease.title }
  const repairIssues = auditMusicState(db, [repairTorrent], musicLibraryId)
  const correlationIssue = repairIssues.find(issue => issue.id === `album-correlation:${repairAlbumId}`)
  assert.equal(correlationIssue?.repairable, true)
  applyMusicRepairs(db, repairIssues, [correlationIssue!.id])
  assert.equal((db.prepare('SELECT info_hash FROM albums WHERE id = ?').get(repairAlbumId) as any).info_hash, repairTorrent.infoHash)

  db.prepare("UPDATE albums SET status = 'collected' WHERE id = ?").run(repairAlbumId)
  db.prepare("UPDATE tracks SET status = 'missing', file_path = NULL WHERE album_id = ?").run(repairAlbumId)
  const incomplete = auditMusicState(db, [repairTorrent], musicLibraryId)
  const incompleteIssue = incomplete.find(issue => issue.id === `incomplete-collected-album:${repairAlbumId}`)
  assert.equal(incompleteIssue?.repairable, true)
  applyMusicRepairs(db, incomplete, [incompleteIssue!.id])
  assert.equal((db.prepare('SELECT status FROM albums WHERE id = ?').get(repairAlbumId) as any).status, 'partial')

  const legacyAlbumId = Number(
    db
      .prepare("INSERT INTO albums (artist_id, musicbrainz_id, title, album_type, status) VALUES (?, 'legacy-album', 'Legacy Album', 'Album', 'acquiring')")
      .run(artistId).lastInsertRowid,
  )
  const legacyTorrent = { id: 'legacy-runtime', infoHash: '5555555555555555555555555555555555555555', name: 'Durable.Artist-Legacy.Album.2026.FLAC' }
  const legacyIssues = auditMusicState(db, [legacyTorrent], musicLibraryId)
  const legacyCorrelation = legacyIssues.find(issue => issue.id === `album-correlation:${legacyAlbumId}`)
  assert.equal(legacyCorrelation?.repairable, true, 'legacy albums without decision rows can use one unique artist+album torrent match')

  const samplerAlbumId = Number(
    db
      .prepare(
        "INSERT INTO albums (artist_id, musicbrainz_id, title, album_type, status, info_hash) VALUES (?, 'sampler-album', 'Full Album', 'Album', 'acquiring', ?)",
      )
      .run(artistId, '6666666666666666666666666666666666666666').lastInsertRowid,
  )
  const samplerIssues = auditMusicState(
    db,
    [{ id: 'sampler', infoHash: '6666666666666666666666666666666666666666', name: 'Durable Artist Full Album Sampler FLAC' }],
    musicLibraryId,
  )
  assert.equal(
    samplerIssues.find(issue => issue.id === `suspect-release:${samplerAlbumId}`)?.repairable,
    false,
    'legacy sampler hashes are flagged for review, never auto-repaired',
  )
})

test('a manual grab is not vetoed when the release title carries extra words', async () => {
  // Reported case: "Led Zeppelin - BBC Sessions" is not a substring of
  // "Led Zeppelin - The Complete BBC Sessions (2016) [FLAC 96-24]", because the
  // subject is `${artist} - ${album}` and the match is a plain substring test.
  // The operator picked that release, so the difference is reported, not vetoed.
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  // This suite creates its own music library, so the context has to come from
  // the album's own artist rather than the first music library in the table.
  const album = db
    .prepare(`
      SELECT al.id AS id, ar.library_id AS libraryId FROM albums al
      JOIN artists ar ON ar.id = al.artist_id WHERE al.title = 'Durable Album'
    `)
    .get() as { id: number; libraryId: number }
  const headers = { 'x-tab-context': String(album.libraryId) }
  const albumId = album.id

  const interleaved = {
    downloadUrl: 'magnet:?xt=urn:btih:7777777777777777777777777777777777777777',
    albumId,
    releaseTitle: 'Durable Artist - The Complete Durable Album (2016) [FLAC 96-24]',
    releaseGuid: 'durable-album-interleaved',
    indexerName: 'Test Music Indexer',
    seeders: 7,
  }

  const res = await h.request('POST', '/api/v1/music/download', { headers, body: interleaved })
  assert.equal(res.status, 200)

  const decision = db
    .prepare(`
      SELECT source, accepted, rejection_reasons FROM acquisition_decisions
      WHERE release_guid = ? ORDER BY id DESC LIMIT 1
    `)
    .get(interleaved.releaseGuid) as { source: string; accepted: number; rejection_reasons: string | null }

  assert.ok(decision, 'the manual grab is audited')
  assert.equal(decision.source, 'manual')
  assert.equal(decision.accepted, 1, `rejected: ${decision.rejection_reasons ?? '(none recorded)'}`)
  assert.doesNotMatch(decision.rejection_reasons ?? '', /title mismatch/)
})

test('an automatic grab still refuses a title it cannot match', async () => {
  const { evaluateRelease } = await import('../src/services/acquisition-decisions.js')
  // Same title, unattended: the veto stays, because nobody is there to judge it.
  for (const source of ['auto-grab', 'rss'] as const) {
    const decision = evaluateRelease(
      { source, mediaType: 'music', subjectType: 'album', subjectTitle: 'Durable Artist - Durable Album' },
      { title: 'Durable Artist - The Complete Durable Album (2016) [FLAC 96-24]', downloadUrl: 'magnet:?xt=urn:btih:auto' },
    )
    assert.equal(decision.accepted, false, `${source} keeps the title veto`)
    assert.ok(decision.rejectionReasons.includes('title mismatch'))
  }
})
