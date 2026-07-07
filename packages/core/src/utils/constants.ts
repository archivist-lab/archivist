// HTTP timeouts (ms)
export const TIMEOUT_SHORT = 5_000
export const TIMEOUT_DEFAULT = 10_000
export const TIMEOUT_LONG = 15_000

// FlareSolverr
export const FLARE_MAX_TIMEOUT = 90_000
export const FLARE_AXIOS_TIMEOUT = 100_000
export const FLARE_SESSION_TTL_MS = 30 * 60 * 1_000 // 30 minutes

// Download monitor
export const MONITOR_INTERVAL_MS = 5_000

// Search
export const MAX_BASE_URLS_TO_TRY = 3

// Release scoring bonuses/penalties
export const SCORE_TITLE_MATCH = 1_000
export const SCORE_YEAR_EXACT = 5_000
export const SCORE_YEAR_ADJACENT = 500
export const SCORE_NO_TITLE = -5_000
export const SCORE_NO_YEAR = -3_000
