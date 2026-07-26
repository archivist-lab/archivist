// ── Byte / rate / duration formatting ────────────────────────────────────────
// Consolidated from four near-copies that had drifted apart. They are NOT all the
// same function, so the differences are preserved deliberately rather than
// unified — merging them would silently change numbers already on screen.
//
//   formatBytes        decimal (1000-based) — file and transfer sizes
//   formatBytesBinary  binary  (1024-based) — disk/storage panels in Settings
//   formatSize         binary, GB/MB only, '—' when empty — compact metadata rows
//
// Prefer `formatBytes` for new code unless you are matching a storage figure the
// OS itself reports in binary units.

/** Decimal (SI) byte size, e.g. "1.50 GB". Returns "0 B" for non-positive input. */
export function formatBytes(b: number): string {
  if (b <= 0) return '0 B'
  if (b >= 1e12) return `${(b / 1e12).toFixed(2)} TB`
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`
  return `${b} B`
}

/**
 * Binary (1024-based) byte size, e.g. "1.5 GB" — matches what operating systems
 * report for disk usage. `zero` is the placeholder for empty/zero input, which
 * differs between call sites.
 */
export function formatBytesBinary(bytes?: number, zero = '0 B'): string {
  if (!bytes || bytes <= 0) return zero
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/**
 * Binary byte size that always keeps one decimal from MB upward ("15.0 GB",
 * "500.0 MB") and returns a bare "0" when empty. Used by the storage figures in
 * the video-optimisation panels, where the fixed width keeps columns aligned.
 * Differs from {@link formatBytesBinary} in rounding and zero handling — do not
 * merge them without checking the affected screens.
 */
export function formatBytesFixed(n: number): string {
  if (!n || n <= 0) return '0'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
  return `${(n / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${u[i]}`
}

/** Transfer rate from bytes/second. `zero` is the idle placeholder. */
export function formatSpeed(bps: number, zero = '—'): string {
  if (bps <= 0) return zero
  return `${formatBytes(bps)}/s`
}

/** Remaining time from seconds; "∞" when unknown or absurdly large. */
export function formatEta(sec: number): string {
  if (sec < 0 || sec > 86400 * 365) return '∞'
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

/** Seed ratio; "∞" for negative (unknown) values. */
export function formatRatio(r: number): string {
  if (r < 0) return '∞'
  return r.toFixed(2)
}
