function safeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Legacy music row deserialisation — response field names are the UI contract. */
export const d = (row: any) => ({
  ...row,
  genres: safeJsonArray(row.genres),
  album_types: safeJsonArray(row.album_types),
  monitored: Boolean(row.monitored),
  upgrade_allowed: row.upgrade_allowed !== undefined ? Boolean(row.upgrade_allowed) : true,
  downloadProgress: row.download_progress as number || 0,
})
