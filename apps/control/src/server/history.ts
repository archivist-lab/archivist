import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ControlSnapshot } from './host.js'

export interface HistoryPoint {
  at: string
  load1: number
  memoryPercent: number
  serviceMemoryBytes: number | null
  endpointsUp: number
  endpointsTotal: number
  volumes: Record<string, number>
}

const MAX_POINTS = 10_080 // one sample/minute for seven days
const COMPACT_AT_BYTES = 4 * 1024 * 1024

export function historyPoint(snapshot: ControlSnapshot): HistoryPoint {
  const total = snapshot.host.memoryTotalBytes
  return {
    at: snapshot.generatedAt,
    load1: snapshot.host.load[0] ?? 0,
    memoryPercent: total > 0 ? Math.round((snapshot.host.memoryUsedBytes / total) * 1_000) / 10 : 0,
    serviceMemoryBytes: snapshot.services[0]?.memoryBytes ?? null,
    endpointsUp: snapshot.endpoints.filter(endpoint => endpoint.reachable).length,
    endpointsTotal: snapshot.endpoints.length,
    volumes: Object.fromEntries(snapshot.volumes.map(volume => [volume.id, volume.usedPercent])),
  }
}

function parseHistory(contents: string): HistoryPoint[] {
  return contents
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        const point = JSON.parse(line) as HistoryPoint
        return typeof point.at === 'string' && Number.isFinite(Date.parse(point.at)) ? [point] : []
      } catch {
        return []
      }
    })
}

export async function recordHistory(dataDir: string, snapshot: ControlSnapshot): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o750 })
  const historyPath = path.join(dataDir, 'telemetry.jsonl')
  await appendFile(historyPath, `${JSON.stringify(historyPoint(snapshot))}\n`, { mode: 0o640 })
  const info = await stat(historyPath)
  if (info.size <= COMPACT_AT_BYTES) return
  const points = parseHistory(await readFile(historyPath, 'utf8')).slice(-MAX_POINTS)
  const temporary = `${historyPath}.next`
  await writeFile(temporary, `${points.map(point => JSON.stringify(point)).join('\n')}\n`, { mode: 0o640 })
  await rename(temporary, historyPath)
}

export async function readHistory(dataDir: string, hours: number): Promise<HistoryPoint[]> {
  const boundedHours = Math.min(168, Math.max(1, Number.isFinite(hours) ? hours : 24))
  const cutoff = Date.now() - boundedHours * 3_600_000
  try {
    const points = parseHistory(await readFile(path.join(dataDir, 'telemetry.jsonl'), 'utf8'))
    return points.filter(point => Date.parse(point.at) >= cutoff).slice(-MAX_POINTS)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
