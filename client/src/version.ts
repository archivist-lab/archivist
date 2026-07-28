// Single source of truth for the user-facing application version.
//
// Versioning scheme (per project owner): the app is currently an ALPHA release.
// The version string is a literal counter — it starts at "0.0.01" and every
// shipped change bumps the last segment by 0.0.01 (0.0.01 → 0.0.02 → 0.0.03 …)
// unless a different version is explicitly specified. Note this is intentionally
// NOT semver (the "01" leading zero is invalid semver), so it lives here as a
// display string rather than in package.json.
export const APP_VERSION = '0.0.13'
export const APP_CHANNEL = 'alpha'

/** Formatted for display, e.g. "v0.0.01 · alpha". */
export const APP_VERSION_LABEL = `v${APP_VERSION} · ${APP_CHANNEL}`
