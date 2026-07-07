/** Legacy games row deserialisation — response field names are the UI contract. */
export const d = (row: any) => ({
  ...row,
  releaseDate: row.release_date,
  genres: typeof row.genres === 'string' ? JSON.parse(row.genres) : (row.genres ?? []),
  platforms: typeof row.platforms === 'string' ? JSON.parse(row.platforms) : (row.platforms ?? []),
  monitored: Boolean(row.monitored),
  upgrade_allowed: row.upgrade_allowed !== undefined ? Boolean(row.upgrade_allowed) : true,
  downloadProgress: row.download_progress as number || 0,
})
