/** Legacy books row deserialisation — response field names are the UI contract. */
export const d = (row: any) => ({
  ...row,
  genres: typeof row.genres === 'string' ? JSON.parse(row.genres) : (row.genres ?? []),
  monitored: Boolean(row.monitored),
  upgrade_allowed: row.upgrade_allowed !== undefined ? Boolean(row.upgrade_allowed) : true,
  downloadProgress: row.download_progress as number || 0,
})
