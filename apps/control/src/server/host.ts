import { execFile } from 'node:child_process'
import { readFile, readdir, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Units Control may manage. Each one is authorised individually in
 * `deploy/polkit/50-archivist-control.rules`; adding an id here without the
 * matching polkit entry yields a service that reports state but cannot be
 * actioned.
 */
export type ServiceId = 'runtime' | 'trawl' | 'vpn' | 'vpn-proxy'
export type ServiceAction = 'start' | 'stop' | 'restart'

export interface ServiceSnapshot {
  id: ServiceId
  unit: string
  label: string
  state: string
  subState: string
  enabled: boolean
  pid: number | null
  memoryBytes: number | null
  startedAt: string | null
}

export interface VolumeSnapshot {
  id: string
  label: string
  path: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usedPercent: number
  filesystem: string
}

export interface TemperatureSnapshot {
  label: string
  celsius: number
}

export interface ControlSnapshot {
  generatedAt: string
  host: {
    hostname: string
    platform: string
    release: string
    uptimeSeconds: number
    cpuModel: string
    cpuCount: number
    load: number[]
    memoryTotalBytes: number
    memoryUsedBytes: number
  }
  services: ServiceSnapshot[]
  volumes: VolumeSnapshot[]
  temperatures: TemperatureSnapshot[]
  endpoints: Array<{ label: string; port: number; path: string; reachable: boolean; latencyMs: number | null }>
  backup: {
    status: 'healthy' | 'stale' | 'invalid' | 'missing' | 'disabled' | 'unavailable'
    enabled: boolean
    backupCount: number
    retentionCount: number
    intervalHours: number
    latest: null | { id: string; createdAt: string; ageHours: number; files: number; bytes: number }
    verifiedAt: string | null
    sqliteIntegrity: 'ok' | 'failed' | 'not-checked'
    reason: string | null
  }
  capabilities: {
    serviceControl: boolean
    journal: boolean
    smart: boolean
    sensors: boolean
    btrfs: boolean
    zfs: boolean
  }
}

const services: Record<ServiceId, { unit: string; label: string }> = {
  runtime: { unit: process.env.ARCHIVIST_CONTROL_RUNTIME_UNIT || 'archivist.service', label: 'Archivist runtime' },
  trawl: { unit: process.env.ARCHIVIST_CONTROL_TRAWL_UNIT || 'archivist-trawl.service', label: 'Trawl challenge solver' },
  vpn: { unit: process.env.ARCHIVIST_CONTROL_VPN_UNIT || 'archivist-vpn.service', label: 'Egress tunnel' },
  'vpn-proxy': { unit: process.env.ARCHIVIST_CONTROL_VPN_PROXY_UNIT || 'archivist-vpn-proxy.service', label: 'Egress proxy' },
}

const serviceIds = Object.keys(services) as ServiceId[]

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-c', `command -v ${command}`], { timeout: 1_500 })
    return true
  } catch {
    return false
  }
}

export function parseSystemdShow(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const separator = line.indexOf('=')
        return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)]
      }),
  )
}

async function serviceSnapshot(id: ServiceId): Promise<ServiceSnapshot> {
  const definition = services[id]
  try {
    const { stdout } = await execFileAsync(
      'systemctl',
      ['show', definition.unit, '--no-pager', '--property=ActiveState,SubState,UnitFileState,MainPID,MemoryCurrent,ActiveEnterTimestamp'],
      { timeout: 3_000 },
    )
    const values = parseSystemdShow(stdout)
    const pid = Number(values.MainPID)
    const memory = Number(values.MemoryCurrent)
    return {
      id,
      unit: definition.unit,
      label: definition.label,
      state: values.ActiveState || 'unknown',
      subState: values.SubState || 'unknown',
      enabled: values.UnitFileState === 'enabled',
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      memoryBytes: Number.isFinite(memory) && memory >= 0 ? memory : null,
      startedAt: values.ActiveEnterTimestamp || null,
    }
  } catch {
    return {
      id,
      unit: definition.unit,
      label: definition.label,
      state: 'unavailable',
      subState: 'unknown',
      enabled: false,
      pid: null,
      memoryBytes: null,
      startedAt: null,
    }
  }
}

async function volumeSnapshot(id: string, label: string, volumePath: string): Promise<VolumeSnapshot | null> {
  try {
    const filesystem = await statfs(volumePath)
    const totalBytes = filesystem.blocks * filesystem.bsize
    const availableBytes = filesystem.bavail * filesystem.bsize
    const usedBytes = totalBytes - filesystem.bfree * filesystem.bsize
    return {
      id,
      label,
      path: volumePath,
      totalBytes,
      usedBytes,
      availableBytes,
      usedPercent: totalBytes === 0 ? 0 : Math.round((usedBytes / totalBytes) * 1000) / 10,
      filesystem: 'host',
    }
  } catch {
    return null
  }
}

async function temperatures(): Promise<TemperatureSnapshot[]> {
  const thermalRoot = '/sys/class/thermal'
  try {
    const entries = await readdir(thermalRoot, { withFileTypes: true })
    const values = await Promise.all(
      entries
        .filter(entry => entry.isDirectory() && entry.name.startsWith('thermal_zone'))
        .map(async entry => {
          const root = path.join(thermalRoot, entry.name)
          const [rawTemp, rawType] = await Promise.all([readFile(path.join(root, 'temp'), 'utf8'), readFile(path.join(root, 'type'), 'utf8')])
          const celsius = Number(rawTemp.trim()) / 1_000
          return Number.isFinite(celsius) && celsius > -30 && celsius < 180
            ? { label: rawType.trim() || entry.name, celsius: Math.round(celsius * 10) / 10 }
            : null
        }),
    )
    return values.filter((value): value is TemperatureSnapshot => value != null)
  } catch {
    return []
  }
}

// Every Archivist surface now lives on one port, separated by path prefix, so
// a probe needs both to tell them apart.
async function endpoint(label: string, port: number, probePath: string): Promise<{ label: string; port: number; path: string; reachable: boolean; latencyMs: number | null }> {
  const started = Date.now()
  try {
    const response = await fetch(`http://127.0.0.1:${port}${probePath}`, { signal: AbortSignal.timeout(1_500), redirect: 'manual' })
    return { label, port, path: probePath, reachable: response.status < 500, latencyMs: Date.now() - started }
  } catch {
    return { label, port, path: probePath, reachable: false, latencyMs: null }
  }
}

async function backupHealth(): Promise<ControlSnapshot['backup']> {
  try {
    const response = await fetch('http://127.0.0.1:2424/api/v1/health', { signal: AbortSignal.timeout(2_500) })
    if (!response.ok) throw new Error('Runtime health unavailable')
    const result = await response.json() as { backup?: ControlSnapshot['backup'] }
    if (!result.backup) throw new Error('Backup health unavailable')
    return result.backup
  } catch {
    return { status: 'unavailable', enabled: false, backupCount: 0, retentionCount: 0, intervalHours: 0, latest: null, verifiedAt: null, sqliteIntegrity: 'not-checked', reason: 'Runtime backup health is unavailable' }
  }
}

export async function getSnapshot(): Promise<ControlSnapshot> {
  const cwd = process.env.ARCHIVIST_HOME || process.cwd()
  const volumeDefinitions = [
    ['system', 'System', '/'],
    ['data', 'Data', process.env.ARCHIVIST_DATA_DIR || path.join(cwd, 'data')],
    ['media', 'Media', process.env.ARCHIVIST_MEDIA_DIR || path.join(cwd, 'media')],
    ['downloads', 'Downloads', process.env.ARCHIVIST_DOWNLOADS_DIR || path.join(cwd, 'downloads')],
  ] as const
  const [serviceValues, volumeValues, temperatureValues, endpointValues, backup, serviceControl, journal, smart, sensors, btrfs, zfs] = await Promise.all([
    Promise.all(serviceIds.map(id => serviceSnapshot(id))),
    Promise.all(volumeDefinitions.map(([id, label, volumePath]) => volumeSnapshot(id, label, volumePath))),
    temperatures(),
    Promise.all([endpoint('Library', 2424, '/library/'), endpoint('Player', 2424, '/player/'), endpoint('Catalogue', 2424, '/catalogue/'), endpoint('API', 2424, '/ping')]),
    backupHealth(),
    commandExists('systemctl'),
    commandExists('journalctl'),
    commandExists('smartctl'),
    commandExists('sensors'),
    commandExists('btrfs'),
    commandExists('zpool'),
  ])
  const cpus = os.cpus()
  return {
    generatedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      uptimeSeconds: os.uptime(),
      cpuModel: cpus[0]?.model || 'Unknown processor',
      cpuCount: cpus.length,
      load: os.loadavg().map(value => Math.round(value * 100) / 100),
      memoryTotalBytes: os.totalmem(),
      memoryUsedBytes: os.totalmem() - os.freemem(),
    },
    services: serviceValues,
    volumes: volumeValues.filter((value): value is VolumeSnapshot => value != null),
    temperatures: temperatureValues,
    endpoints: endpointValues,
    backup,
    capabilities: { serviceControl, journal, smart, sensors, btrfs, zfs },
  }
}

export function resolveService(id: string): { id: ServiceId; unit: string; label: string } | null {
  if (!Object.hasOwn(services, id)) return null
  const serviceId = id as ServiceId
  return { id: serviceId, ...services[serviceId] }
}

export async function controlService(id: string, action: ServiceAction): Promise<void> {
  const service = resolveService(id)
  if (!service) throw new Error('Unknown service')
  await execFileAsync('systemctl', ['--no-ask-password', action, service.unit], { timeout: 45_000 })
}

export async function serviceLogs(id: string, lines: number): Promise<string[]> {
  const service = resolveService(id)
  if (!service) throw new Error('Unknown service')
  const { stdout } = await execFileAsync(
    'journalctl',
    ['--unit', service.unit, '--no-pager', '--output=short-iso', '--lines', String(Math.min(500, Math.max(20, lines)))],
    {
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  )
  return stdout.split('\n').filter(Boolean)
}
