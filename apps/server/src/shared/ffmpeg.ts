import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Resolve an ffmpeg/ffprobe binary path, in priority order:
 *   1. an explicit env override (system binary — the Docker image sets these to
 *      a VAAPI/QSV/VMAF-enabled build),
 *   2. the bundled static binary *if it was actually downloaded/present*
 *      (`require(pkg)` returns a path even when the download was skipped, so we
 *      must check it exists),
 *   3. the binary on PATH.
 *
 * This lets `ffmpeg-static` be excluded from `onlyBuiltDependencies` (its
 * postinstall download is flaky — GitHub 504s) without breaking anything:
 * production uses the system binary via the env var, dev uses the static binary
 * when present, and otherwise we fall back to PATH.
 */
function resolveBinary(pkg: string, envVar: string, fallback: string): string {
  const override = process.env[envVar]
  if (override) return override
  try {
    const mod = require(pkg) as string | { path?: string }
    const path = typeof mod === 'string' ? mod : mod?.path
    if (typeof path === 'string' && path && existsSync(path)) return path
  } catch { /* not installed / no binary — fall through */ }
  return fallback
}

export const ffmpegPath = resolveBinary('ffmpeg-static', 'ARCHIVIST_FFMPEG_PATH', 'ffmpeg')
export const ffprobePath = resolveBinary('ffprobe-static', 'ARCHIVIST_FFPROBE_PATH', 'ffprobe')
