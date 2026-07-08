import { request } from './api.js'

export interface ArcadeRom { name: string; file: string; url: string; size: number }
export interface ArcadeSystem {
  id: string
  label: string
  core: string
  bios: boolean
  disc: boolean
  folder: string
  biosUrl?: string
  biosReady: boolean
  roms: ArcadeRom[]
}

export const arcadeApi = {
  library: () => request<{ systems: ArcadeSystem[] }>('/arcade/library'),
}
