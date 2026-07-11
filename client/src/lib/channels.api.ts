import { request } from './api.js'

// Channels (personal TV network) admin API — global scope, no tab context.

export interface Channel {
  id: number
  number: number
  name: string
  description: string | null
  brandColor: string
  logoUrl: string | null
  isActive: boolean
  blockCount?: number
  upcomingSlots?: number
}

export interface SeriesPriorityEntry {
  series_id: number
  season_from?: number
  season_to?: number
}

/** One entry in a slot's fallback stack: a series, or a film pool. */
export interface SlotSource {
  type: 'series' | 'films'
  series_id?: number
  season_from?: number
  season_to?: number
  genres_any?: string[]
  year_from?: number
  year_to?: number
}

/** A programmed slot: ordered fallbacks + how many items it airs per night. */
export interface SlotDef {
  name?: string
  sources: SlotSource[]
  count?: number
  fill?: boolean
}

export interface BlockRules {
  content_types?: Array<'film' | 'episode'>
  genres_any?: string[]
  max_runtime_minutes?: number
  exclude_aired_within_days?: number
  allow_repeats?: boolean
  year_from?: number
  year_to?: number
  watched_filter?: 'unwatched' | 'any' | 'watched'
  slots?: SlotDef[]
  /** Legacy single-stack form (still honoured by the scheduler). */
  series_priority?: SeriesPriorityEntry[]
  episodes_per_slot?: number
  fill_block?: boolean
}

/** Series option for the stack picker (from the player contract). */
export interface SeriesOption { id: number; title: string; year: number | null; availableEpisodeCount: number }

export interface ProgrammingBlock {
  id: number
  channelId: number
  name: string
  daysOfWeek: number[]
  startMinute: number
  endMinute: number
  rules: BlockRules
  priority: number
}

export interface GuideSlot {
  id: number
  channelId: number
  blockId: number | null
  blockName: string | null
  itemType: 'film' | 'episode'
  itemId: number
  startsAt: number
  endsAt: number
  status: string
  locked: boolean
  title: string
  seriesTitle: string | null
  seasonNumber: number | null
  episodeNumber: number | null
  year: number | null
  posterUrl: string | null
  runtimeSeconds: number
  hasFile: boolean
}

export const channelsApi = {
  list: () => request<{ channels: Channel[] }>('/channels'),
  create: (data: Partial<Channel>) => request<Channel>('/channels', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<Channel>) => request<Channel>(`/channels/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: number) => request<void>(`/channels/${id}`, { method: 'DELETE' }),

  blocks: (channelId: number) => request<{ blocks: ProgrammingBlock[] }>(`/channels/${channelId}/blocks`),
  createBlock: (channelId: number, data: Partial<ProgrammingBlock>) =>
    request<ProgrammingBlock>(`/channels/${channelId}/blocks`, { method: 'POST', body: JSON.stringify(data) }),
  updateBlock: (channelId: number, blockId: number, data: Partial<ProgrammingBlock>) =>
    request<ProgrammingBlock>(`/channels/${channelId}/blocks/${blockId}`, { method: 'PUT', body: JSON.stringify(data) }),
  removeBlock: (channelId: number, blockId: number) =>
    request<void>(`/channels/${channelId}/blocks/${blockId}`, { method: 'DELETE' }),

  generate: (channelId: number, days = 7) =>
    request<{ created: number }>(`/channels/${channelId}/generate`, { method: 'POST', body: JSON.stringify({ days }) }),
  generateAll: (days = 7) =>
    request<{ results: Record<number, number>; totalSlots: number }>('/channels/generate', { method: 'POST', body: JSON.stringify({ days }) }),

  guide: (from: number, to: number) => request<{ slots: GuideSlot[] }>(`/channels/guide?from=${from}&to=${to}`),
  seriesOptions: () => request<{ series: SeriesOption[] }>('/player/series'),
  toggleLock: (slotId: number) => request<{ id: number; locked: boolean }>(`/channels/slots/${slotId}/lock`, { method: 'POST' }),
  removeSlot: (slotId: number) => request<void>(`/channels/slots/${slotId}`, { method: 'DELETE' }),
}
