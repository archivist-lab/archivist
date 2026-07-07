import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { simpleGit } from 'simple-git'
import { definitionLoader } from '../engine/definition-loader.js'

const PROWLARR_REPO = 'https://github.com/Prowlarr/Indexers'

interface SyncOptions {
  repoPath?: string
  offlineMode?: boolean
}

interface SyncStatus {
  lastSync: Date | null
  loaded: number
  errors: number
  repoPath: string
  syncing: boolean
}

class DefinitionSync {
  private status: SyncStatus = {
    lastSync: null,
    loaded: 0,
    errors: 0,
    repoPath: '',
    syncing: false,
  }

  async sync(options: SyncOptions = {}): Promise<{ loaded: number; errors: number }> {
    const repoPath = options.repoPath
      ?? process.env.ARCHIVIST_DEFINITIONS_PATH
      ?? join(process.cwd(), 'data', 'indexer-definitions')

    this.status.repoPath = repoPath
    this.status.syncing = true

    definitionLoader.clear()

    try {
      if (!options.offlineMode) {
        if (!existsSync(repoPath)) {
          console.log(`[DefinitionSync] Cloning to ${repoPath}`)
          mkdirSync(repoPath, { recursive: true })
          await simpleGit().clone(PROWLARR_REPO, repoPath, ['--depth', '1', '--filter', 'blob:none'])
        } else {
          console.log('[DefinitionSync] Pulling latest definitions')
          try {
            await simpleGit(repoPath).pull()
          } catch {
            // Not fatal — use cached
          }
        }
      }

      // Load from definitions/ subdirectory
      const definitionsPath = join(repoPath, 'definitions')
      if (existsSync(definitionsPath)) {
        definitionLoader.loadFromDirectory(definitionsPath)
      } else {
        definitionLoader.loadFromDirectory(repoPath)
      }

      this.status.loaded = definitionLoader.count()
      this.status.errors = definitionLoader.getErrors().length
      this.status.lastSync = new Date()

      console.log(`[DefinitionSync] Sync complete: ${this.status.loaded} loaded, ${this.status.errors} errors`)
      return { loaded: this.status.loaded, errors: this.status.errors }
    } finally {
      this.status.syncing = false
    }
  }

  getStatus() {
    return {
      lastSync: this.status.lastSync,
      loaded: this.status.loaded,
      errors: this.status.errors,
      repoPath: this.status.repoPath,
      syncing: this.status.syncing,
    }
  }
}

export const definitionSync = new DefinitionSync()
