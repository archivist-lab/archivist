import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

const managedEnv = [
  'ARCHIVIST_CONFIG', 'ARCHIVIST_HOST', 'HOST',
  'ARCHIVIST_PORT', 'PORT',
  'ARCHIVIST_API_TOKEN', 'ARCHIVIST_AUTH_TOKEN', 'ARCHIVIST_DB',
  'ARCHIVIST_MEDIA_BASE', 'ARCHIVIST_DEFINITIONS_PATH', 'DEFINITIONS_OFFLINE',
  'TORRENT_DOWNLOAD_DIR', 'TORRENT_INCOMPLETE_DIR', 'TORRENT_RESUME_DIR',
  'TORRENT_FILES_DIR', 'ARCHIVIST_EMBEDDED_TORRENTS',
  'TMDB_API_KEY', 'TMDB_BASE_URL', 'TVDB_API_KEY', 'TVDB_PIN',
  'GOOGLE_BOOKS_API_KEY', 'COMICVINE_API_KEY', 'IGDB_CLIENT_ID',
  'IGDB_CLIENT_SECRET', 'FANART_API_KEY',
]

const originalEnv = new Map(managedEnv.map(key => [key, process.env[key]]))

function resetEnv() {
  for (const key of managedEnv) {
    const original = originalEnv.get(key)
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
}

afterEach(resetEnv)

test('missing config uses sane defaults', () => {
  resetEnv()
  const dir = mkdtempSync(join(tmpdir(), 'archivist-config-'))
  try {
    const config = loadConfig(join(dir, 'missing.toml'))
    assert.equal(config.server.host, '0.0.0.0')
    assert.equal(config.server.port, 2424)
    assert.equal(config.auth.api_key, '')
    assert.equal(config.database.path, './data/archivist.sqlite')
    assert.equal(config.downloads.embedded_engine, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid config fails with readable error', () => {
  resetEnv()
  const dir = mkdtempSync(join(tmpdir(), 'archivist-config-'))
  try {
    const path = join(dir, 'bad.toml')
    writeFileSync(path, `[server]
port = "not-a-number"
`)
    assert.throws(() => loadConfig(path), err => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /Invalid configuration/)
      assert.match(err.message, /server.port/)
      return true
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('environment overrides file values and mirrors provider keys', () => {
  resetEnv()
  const dir = mkdtempSync(join(tmpdir(), 'archivist-config-'))
  try {
    const path = join(dir, 'config.toml')
    writeFileSync(path, `[server]
host = "127.0.0.1"
port = 2525

[auth]
api_key = "file-key"

[database]
path = "./from-file.sqlite"

[downloads]
embedded_engine = true

[metadata.tmdb]
api_key = "file-tmdb"
base_url = "https://file.example/3"
`)

    process.env.ARCHIVIST_HOST = 'localhost'
    process.env.ARCHIVIST_PORT = '7777'
    process.env.ARCHIVIST_API_TOKEN = 'env-key'
    process.env.ARCHIVIST_DB = join(dir, 'env.sqlite')
    process.env.ARCHIVIST_EMBEDDED_TORRENTS = 'false'
    process.env.TMDB_API_KEY = 'env-tmdb'
    process.env.TMDB_BASE_URL = 'https://env.example/3'

    const config = loadConfig(path)
    assert.equal(config.server.host, 'localhost')
    assert.equal(config.server.port, 7777)
    assert.equal(config.auth.api_key, 'env-key')
    assert.equal(config.database.path, join(dir, 'env.sqlite'))
    assert.equal(config.downloads.embedded_engine, false)
    assert.equal(config.metadata.tmdb.api_key, 'env-tmdb')
    assert.equal(config.metadata.tmdb.base_url, 'https://env.example/3')
    assert.equal(process.env.TMDB_API_KEY, 'env-tmdb')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
