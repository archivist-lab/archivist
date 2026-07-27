import Database from 'better-sqlite3'
const db = new Database('../../data/archivist.sqlite', { readonly: true })
console.log('=== WW2 episodes ===')
console.log(db.prepare(`SELECT id, season_number, episode_number, status, info_hash, file_path, download_progress, updated_at
  FROM episodes WHERE series_id=34 ORDER BY episode_number`).all())
console.log('=== media_imports for those ===')
console.log(db.prepare(`SELECT id,item_id,status,source_path,destination_path,attempts,error,updated_at
  FROM media_imports WHERE item_id IN ('11556','11557','11558','11559','11560') ORDER BY id`).all())
