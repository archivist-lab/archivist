// DB
export { openDb, closeDb, closeAllDbs, getSharedDb, listOpenDbs, checkpointDb, getDbStatus } from './db/index.js'
export type { DbStatus } from './db/index.js'
export { runMigrations } from './db/migrations.js'

// Indexers
export { DefinitionLoader, definitionLoader } from './indexers/engine/definition-loader.js'
export { definitionSync } from './indexers/registry/definition-sync.js'
export { IndexerStore } from './indexers/registry/indexer-store.js'
export { testIndexer } from './indexers/tester.js'
export { searchIndexer, type IndexerSearchResult } from './indexers/engine/search.js'
export { searchProwlarr } from './indexers/engine/prowlarr.js'
export type { IndexerDefinition } from './indexers/engine/definition-loader.js'
export type { IndexerInstance } from './indexers/registry/indexer-store.js'

// Download clients
export { DownloadClientStore } from './download-clients/store.js'
export { testDownloadClient, sendToDownloadClient } from './download-clients/tester.js'
export { TransmissionClient, type Torrent } from './download-clients/transmission.js'
export { registerSessionSendFn } from './download-clients/session-registry.js'
export type { DownloadClient, } from './download-clients/store.js'
export type { TestResult } from './download-clients/tester.js'

// Utils
export { sanitizeConfigValue } from './utils/config.js'
export { scoreRelease, type ScoredRelease, TIER_1_TERMS, TIER_2_TERMS, TIER_3_TERMS } from './utils/scoring.js'
export { createLogger, type Logger } from './utils/logger.js'
export * from './utils/constants.js'
