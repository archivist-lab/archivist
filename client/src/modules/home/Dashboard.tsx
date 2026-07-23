import { useState, useEffect, useMemo, useRef } from 'react'
import { toast } from '../../lib/notify.js'
import { Link, useNavigate } from 'react-router-dom'
import { sharedApi } from '../../lib/shared.api.js'
import { filmsApi } from '../../lib/films.api.js'
import { tmdbImage, formatSize } from '../../lib/api.js'
import { Modal, Spinner } from '../../components/ui.js'
import { UnifiedAddMedia } from './UnifiedAddMedia.js'
import { DownloadMonitor } from './DownloadMonitor.js'
import { ManualSearch } from './ManualSearch.js'
import { useTabs, type MediaType, type Tab } from '../../lib/tab-context.js'

const CALENDAR_MEDIA_TYPES: MediaType[] = ['films', 'series', 'music', 'books', 'comics', 'games']
const CALENDAR_MEDIA_LABELS: Record<MediaType, string> = {
  films: 'Films',
  series: 'Series',
  music: 'Music',
  books: 'Books',
  comics: 'Comics',
  games: 'Games',
}

type CalendarLibraryGroup = {
  mediaType: MediaType
  label: string
  tabs: Tab[]
}

const mediaFilterKey = (mediaType: MediaType) => `media:${mediaType}`
const tabFilterKey = (tabId: number) => `tab:${tabId}`

function selectedCalendarTabIds(groups: CalendarLibraryGroup[], selected: Set<string>): Set<number> | null {
  if (selected.has('all')) return null
  const result = new Set<number>()
  for (const group of groups) {
    if (selected.has(mediaFilterKey(group.mediaType))) {
      group.tabs.forEach(tab => result.add(tab.id))
      continue
    }
    group.tabs.forEach(tab => {
      if (selected.has(tabFilterKey(tab.id))) result.add(tab.id)
    })
  }
  return result
}

function CalendarLibraryFilter({ groups, selected, onChange }: {
  groups: CalendarLibraryGroup[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<MediaType>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const selectedTabIds = useMemo(() => selectedCalendarTabIds(groups, selected), [groups, selected])

  useEffect(() => {
    if (!open) return
    const pointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', pointerDown)
    document.addEventListener('keydown', keyDown)
    return () => {
      document.removeEventListener('mousedown', pointerDown)
      document.removeEventListener('keydown', keyDown)
    }
  }, [open])

  const groupState = (group: CalendarLibraryGroup) => {
    const explicit = selected.has(mediaFilterKey(group.mediaType))
    const selectedChildren = group.tabs.filter(tab => selected.has(tabFilterKey(tab.id))).length
    return {
      checked: explicit || selectedChildren === group.tabs.length,
      partial: !explicit && selectedChildren > 0 && selectedChildren < group.tabs.length,
    }
  }

  const toggleGroup = (group: CalendarLibraryGroup) => {
    const next = new Set(selected)
    next.delete('all')
    const key = mediaFilterKey(group.mediaType)
    const state = groupState(group)
    next.delete(key)
    group.tabs.forEach(tab => next.delete(tabFilterKey(tab.id)))
    if (!state.checked) next.add(key)
    onChange(next)
  }

  const toggleTab = (group: CalendarLibraryGroup, tabId: number) => {
    const next = new Set(selected)
    next.delete('all')
    const parentKey = mediaFilterKey(group.mediaType)
    const key = tabFilterKey(tabId)
    if (next.has(parentKey)) {
      next.delete(parentKey)
      group.tabs.forEach(tab => next.add(tabFilterKey(tab.id)))
    }
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  const toggleExpanded = (mediaType: MediaType) => {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(mediaType)) next.delete(mediaType)
      else next.add(mediaType)
      return next
    })
  }

  const summary = (() => {
    if (!selectedTabIds) return 'All Libraries'
    if (selectedTabIds.size === 0) return 'No Libraries'
    const matchingGroup = groups.find(group => (
      group.tabs.length === selectedTabIds.size && group.tabs.every(tab => selectedTabIds.has(tab.id))
    ))
    if (matchingGroup) return matchingGroup.label
    if (selectedTabIds.size === 1) {
      const tabId = [...selectedTabIds][0]
      return groups.flatMap(group => group.tabs).find(tab => tab.id === tabId)?.name ?? '1 Library'
    }
    return `${selectedTabIds.size} Libraries`
  })()

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1 max-w-[320px]">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-haspopup="tree"
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-noir-950/50 px-5 py-3 text-left text-sm text-white/70 shadow-2xl outline-none transition-all hover:border-white/20 hover:bg-noir-950/65 focus:border-white/20 focus:bg-noir-950/65"
      >
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        {!selected.has('all') && selected.size > 0 && <span className="rounded-md border border-[#00D4FF]/20 bg-[#00D4FF]/10 px-2 py-0.5 font-mono text-[9px] font-bold text-[#00D4FF]">{selectedTabIds?.size ?? 0}</span>}
        <span aria-hidden="true" className={`text-[9px] text-white/20 transition-transform ${open ? 'rotate-180 text-white/40' : ''}`}>▼</span>
      </button>

      {open && (
        <div role="tree" aria-label="Calendar libraries" className="absolute left-0 top-full z-50 mt-2 w-full min-w-[300px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-white/10 bg-noir-900/95 shadow-2xl backdrop-blur-xl">
          <div className="border-b border-white/5 px-4 py-3">
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-white/25">Filter Release Calendar</p>
          </div>
          <div className="p-2">
          <button
            type="button"
            role="treeitem"
            aria-selected={selected.has('all')}
            onClick={() => onChange(new Set(['all']))}
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-widest transition-all hover:bg-white/5 ${selected.has('all') ? 'bg-[#00D4FF]/5 text-[#00D4FF]' : 'text-white/55'}`}
          >
            <SelectionMark checked={selected.has('all')} />
            <span>All Libraries</span>
          </button>

          <div className="my-1 h-px bg-white/5" />
          {groups.map(group => {
            const hasChildren = group.tabs.length > 1
            const isExpanded = expanded.has(group.mediaType)
            const state = groupState(group)
            return (
              <div key={group.mediaType} role="group">
                <div className={`flex items-center rounded-xl transition-all hover:bg-white/5 ${state.checked || state.partial ? 'bg-[#00D4FF]/5' : ''}`}>
                  {hasChildren ? (
                    <button type="button" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${group.label}`} onClick={() => toggleExpanded(group.mediaType)} className="grid h-9 w-9 shrink-0 place-items-center text-[8px] text-white/25 transition-colors hover:text-white/70">
                      <span className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                    </button>
                  ) : <span className="h-9 w-9 shrink-0" />}
                  <button
                    type="button"
                    role="treeitem"
                    aria-selected={state.checked}
                    aria-expanded={hasChildren ? isExpanded : undefined}
                    onClick={() => toggleGroup(group)}
                    className={`flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-3 text-left text-[10px] font-bold uppercase tracking-widest ${state.checked || state.partial ? 'text-[#00D4FF]' : 'text-white/60'}`}
                  >
                    <SelectionMark checked={state.checked} partial={state.partial} />
                    <span className="truncate">{group.label}</span>
                  </button>
                </div>
                {hasChildren && isExpanded && (
                  <div role="group" className="ml-8 border-l border-white/10 pl-2">
                    {group.tabs.map(tab => {
                      const checked = selected.has(mediaFilterKey(group.mediaType)) || selected.has(tabFilterKey(tab.id))
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          role="treeitem"
                          aria-selected={checked}
                          onClick={() => toggleTab(group, tab.id)}
                          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[11px] transition-all hover:bg-white/5 hover:text-white/80 ${checked ? 'bg-[#00D4FF]/5 text-[#00D4FF]/80' : 'text-white/45'}`}
                        >
                          <SelectionMark checked={checked} />
                          <span className="truncate">{tab.name}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
          </div>
        </div>
      )}
    </div>
  )
}

function SelectionMark({ checked, partial = false }: { checked: boolean; partial?: boolean }) {
  return (
    <span aria-hidden="true" className={`grid h-4 w-4 shrink-0 place-items-center rounded-md border text-[9px] shadow-inner ${checked || partial ? 'border-[#00D4FF]/50 bg-[#00D4FF]/15 text-[#00D4FF]' : 'border-white/15 bg-noir-950/50 text-transparent'}`}>
      {partial ? '−' : checked ? '✓' : ''}
    </span>
  )
}

function calendarDate(value: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value)
}

function episodeAirLabel(event: any): string {
  if (event.air_at) {
    return new Date(event.air_at).toLocaleString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  }
  const date = event.air_date ? calendarDate(event.air_date).toLocaleDateString() : null
  const time = storedAirTimeLabel(event.air_time)
  if (date && time) return `${date} at ${time}`
  if (date) return `${date} · Time TBA`
  if (time) return time
  return 'Date & time TBA'
}

function storedAirTimeLabel(value?: string | null): string | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? '')
  if (!match) return null
  return new Date(2000, 0, 1, Number(match[1]), Number(match[2])).toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  })
}

function calendarAirTimeLabel(event: any): string {
  if (event.air_at) {
    return new Date(event.air_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  return storedAirTimeLabel(event.air_time) ?? 'Time TBA'
}

export function Dashboard() {
  const { tabs } = useTabs()
  const [stats, setStats] = useState<any>(null)
  const [system, setSystem] = useState<any>(null)
  const [displayedUptimeSeconds, setDisplayedUptimeSeconds] = useState(0)
  const [calendar, setCalendar] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [calOffset, setCalOffset] = useState(0) // 0 = current week
  const [calendarFilters, setCalendarFilters] = useState<Set<string>>(new Set(['all']))
  const [selectedEvent, setSelectedEvent] = useState<any>(null)
  const [searching, setSearching] = useState(false)
  const [grabbed, setGrabbed] = useState(false)
  const navigate = useNavigate()

  const toLocalDateString = (d: Date) => {
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const handleQuickSearch = async (e: any) => {
    if (e.type !== 'film') return // Support others later
    setSearching(true)
    try {
      const res = await filmsApi.autoGrab(e.id)
      if (res.success) setGrabbed(true)
      else toast.error(res.message || 'No releases found')
    } catch (err) {
      toast.error(String(err))
    } finally {
      setSearching(false)
    }
  }

  const loadDashboard = async () => {
    try {
      const [s, sys] = await Promise.all([
        sharedApi.dashboard.stats(),
        sharedApi.dashboard.system()
      ])
      setStats(s)
      setSystem(sys)
    } catch (err) {
      console.error('Failed to load dashboard:', err)
    }
  }

  const loadCalendar = async () => {
    try {
      const today = new Date()
      // Monday of current week (local time)
      const currentMonday = new Date(today)
      currentMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
      
      // Start of 3-week block (Monday of previous week relative to offset)
      const startDate = new Date(currentMonday)
      startDate.setDate(currentMonday.getDate() - 7 + (calOffset * 21))
      
      // End of 3-week block (21 days later)
      const endDate = new Date(startDate)
      endDate.setDate(startDate.getDate() + 20)

      const data = await sharedApi.dashboard.calendar(toLocalDateString(startDate), toLocalDateString(endDate))
      setCalendar(data)
    } catch (err) {
      console.error('Failed to load calendar:', err)
    }
  }

  useEffect(() => {
    loadDashboard().finally(() => setLoading(false))
    const id = setInterval(loadDashboard, 30000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!Number.isFinite(system?.uptimeSeconds)) return

    setDisplayedUptimeSeconds(Math.max(0, Math.floor(system.uptimeSeconds)))
    const id = setInterval(() => {
      setDisplayedUptimeSeconds(current => current + 1)
    }, 1000)

    return () => clearInterval(id)
  }, [system?.uptimeSeconds])

  useEffect(() => {
    loadCalendar()
  }, [calOffset])

  useEffect(() => {
    const valid = new Set<string>()
    valid.add('all')
    for (const mediaType of CALENDAR_MEDIA_TYPES) valid.add(mediaFilterKey(mediaType))
    tabs.forEach(tab => valid.add(tabFilterKey(tab.id)))
    setCalendarFilters(current => {
      const next = new Set([...current].filter(key => valid.has(key)))
      return next.size === current.size && [...next].every(key => current.has(key)) ? current : next
    })
  }, [tabs])

  if (loading && !stats) return (
    <div className="flex items-center justify-center h-[60vh]">
      <Spinner className="w-12 h-12" />
    </div>
  )

  const libItems = [
    { label: 'FILMS',   stats: stats?.counts?.films, unit: 'films', icon: '🎬', to: '/films',  color: '#00D4FF' },
    { label: 'SERIES',  stats: stats?.counts?.series, unit: 'episodes', icon: '📺', to: '/series', color: '#9B59B6' },
    { label: 'MUSIC',   stats: stats?.counts?.music, unit: 'albums', icon: '🎵', to: '/music',  color: '#FF2D78' },
    { label: 'BOOKS',   stats: stats?.counts?.books, unit: 'books', icon: '📚', to: '/books',  color: '#F1C40F' },
    { label: 'COMICS',  stats: stats?.counts?.comics, unit: 'issues', icon: '🦸', to: '/comics', color: '#E67E22' },
    { label: 'GAMES',   stats: stats?.counts?.games, unit: 'games', icon: '🎮', to: '/games',  color: '#2ECC71' },
  ]

  const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
  const todayStr = toLocalDateString(new Date())
  const calendarTabsByMediaType = CALENDAR_MEDIA_TYPES.map(mediaType => ({
    mediaType,
    label: CALENDAR_MEDIA_LABELS[mediaType],
    tabs: tabs.filter(tab => tab.media_type === mediaType),
  })).filter(group => group.tabs.length > 0)
  const activeCalendarTabIds = selectedCalendarTabIds(calendarTabsByMediaType, calendarFilters)
  const filteredCalendar = activeCalendarTabIds === null
    ? calendar
    : calendar.filter(event => activeCalendarTabIds.has(Number(event.tabId)))

  return (
    <div className="space-y-6 animate-fade-in pb-8">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="font-display text-4xl tracking-[0.2em] text-white">DASHBOARD</h1>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {libItems.map(item => (
          <Link key={item.label} to={item.to} className="group relative bg-noir-900/40 border border-white/5 rounded-2xl p-4 min-h-[100px] overflow-hidden transition-all hover:border-white/20 hover:bg-noir-800/40 flex flex-col justify-between">
            <div className="absolute top-3 right-3 opacity-20 group-hover:opacity-40 transition-opacity text-3xl">{item.icon}</div>
            
            <div className="relative z-10">
              <span className="text-sm font-bold font-display uppercase tracking-widest block transition-colors uppercase" style={{ color: item.color }}>{item.label}</span>
            </div>

            <div className="relative z-10 flex items-end justify-between">
              <div className="text-3xl font-display tracking-wider leading-none" style={{ color: item.color }}>{item.stats?.total || 0}</div>
              <div className="text-right pb-0.5 text-white/20">
                <p className="text-[8px] font-mono uppercase tracking-tighter whitespace-nowrap leading-tight">
                  Collected: <span style={{ color: item.color }}>{item.stats?.collected ?? Math.max(0, (item.stats?.total || 0) - (item.stats?.missing || 0) - (item.stats?.acquiring || 0))} {item.unit}</span>
                </p>
                <p className="text-[8px] font-mono uppercase tracking-tighter whitespace-nowrap leading-tight">
                  Missing: <span style={{ color: item.color }}>{item.stats?.missing || 0} {item.unit}</span>
                </p>
                <p className="text-[8px] font-mono uppercase tracking-tighter whitespace-nowrap leading-tight">
                  Acquiring: <span style={{ color: item.color }}>{item.stats?.acquiring || 0} {item.unit}</span>
                </p>
              </div>
            </div>
            
            <div className="absolute bottom-0 left-0 h-1 bg-white/5 group-hover:bg-white/10 transition-all w-full">
              <div className="h-full transition-all duration-500" style={{ backgroundColor: item.color, width: '100%' }} />
            </div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Calendar */}
        <div className="lg:col-span-6 space-y-8">
          {/* Calendar Section */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-mono text-white/20 uppercase tracking-[0.3em]">Release Calendar</h2>
              <div className="h-px flex-1 bg-white/5 ml-6" />
            </div>

            <div className="flex items-center justify-between gap-3">
              <CalendarLibraryFilter groups={calendarTabsByMediaType} selected={calendarFilters} onChange={setCalendarFilters} />
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={() => setCalOffset(prev => prev - 1)} className="h-[46px] px-4 bg-noir-950/50 border border-white/10 rounded-xl hover:border-white/20 hover:bg-noir-950/65 transition-all text-[10px] font-bold tracking-tighter">PREV</button>
                <button onClick={() => setCalOffset(0)} className="h-[46px] px-4 bg-noir-950/50 border border-white/10 rounded-xl hover:border-white/20 hover:bg-noir-950/65 transition-all text-[10px] font-bold tracking-tighter">TODAY</button>
                <button onClick={() => setCalOffset(prev => prev + 1)} className="h-[46px] px-4 bg-noir-950/50 border border-white/10 rounded-xl hover:border-white/20 hover:bg-noir-950/65 transition-all text-[10px] font-bold tracking-tighter">NEXT</button>
              </div>
            </div>

            <div className="grid h-[500px] grid-cols-7 grid-rows-3 gap-px bg-white/5 border border-white/5 rounded-2xl overflow-hidden shadow-2xl backdrop-blur-sm">
              {Array.from({ length: 21 }).map((_, i) => {
                const today = new Date()
                const currentMonday = new Date(today)
                currentMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
                
                const date = new Date(currentMonday)
                date.setDate(currentMonday.getDate() - 7 + (calOffset * 21) + i)
                
                const dayName = DAYS[i % 7]
                const dStr = toLocalDateString(date)
                const isToday = dStr === todayStr
                const dayEvents = filteredCalendar.filter(e => toLocalDateString(calendarDate(e.date)) === dStr)

                return (
                  <div key={i} className={`min-h-0 p-2 flex flex-col gap-2 overflow-hidden transition-colors border-b border-white/5 relative ${isToday ? 'bg-cyan/30 z-10 shadow-[inset_0_0_20px_rgba(0,212,255,0.1)]' : 'bg-noir-950/40'}`}>
                    <div className="flex justify-between items-baseline">
                      <span className={`text-[8px] font-mono font-bold tracking-widest ${isToday ? 'text-white' : 'text-white/20'}`}>{dayName}</span>
                      <span className={`text-xs font-display ${isToday ? 'text-white' : 'text-white/10'}`}>{date.getDate()}</span>
                    </div>
                    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto custom-scrollbar">
                      {dayEvents.map((e, idx) => {
                        const isFilm = e.type === 'film'
                        const subLabel = isFilm ? e.displaySub?.replace(' Release', '') : null
                        return (
                          <div key={idx}
                            onClick={() => { console.log('Selected Event:', e); setSelectedEvent(e); setGrabbed(false); }}
                            className={`text-[9px] p-1.5 px-2 rounded-md font-bold uppercase tracking-tighter cursor-pointer hover:brightness-125 transition-all ${
                            e.type === 'series' ? 'bg-[#9B59B6]/20 text-[#9B59B6]' :
                            e.type === 'film' ? 'bg-[#00D4FF]/20 text-[#00D4FF]' :
                            e.type === 'music' ? 'bg-[#FF2D78]/20 text-[#FF2D78]' :
                            e.type === 'game' ? 'bg-[#2ECC71]/20 text-[#2ECC71]' :
                            e.type === 'book' ? 'bg-[#F1C40F]/20 text-[#F1C40F]' :
                            e.type === 'comic' ? 'bg-[#E67E22]/20 text-[#E67E22]' :
                            'bg-white/10 text-white/60'
                          }`} title={`${e.displayTitle || e.title}: ${e.displaySub || ''} · ${episodeAirLabel(e)}`}>
                            {e.type === 'series' && (
                              <div className="font-mono text-[7px] leading-tight opacity-70 mb-0.5">{calendarAirTimeLabel(e)}</div>
                            )}
                            <div className="truncate">{e.displayTitle || e.title} {subLabel && <span className="opacity-40 font-mono ml-1 text-[7px]">[{subLabel}]</span>}</div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        </div>

        {/* Right Column: Infrastructure */}
        <div className="lg:col-span-6 flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-mono text-white/20 uppercase tracking-[0.3em]">Infrastructure</h2>
            <div className="h-px flex-1 bg-white/5 ml-6" />
          </div>

          <div className="min-h-[500px] flex-1 bg-noir-900/50 border border-white/5 rounded-3xl p-5 flex flex-col gap-5 overflow-hidden backdrop-blur-sm">
            <div className="min-h-0 flex flex-1 flex-col gap-3">
              <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-[0.2em]">Library Storage</h3>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto custom-scrollbar pr-1">
                {system?.storage.map((s: any) => (
                  <div key={s.libraryId} className="space-y-1.5">
                    <div className="flex justify-between items-end">
                      <div className="min-w-0">
                        <div className="text-[10px] font-mono text-white/70 truncate max-w-[190px]">{s.name}</div>
                        <div className="text-[8px] font-mono text-white/25 truncate max-w-[220px]" title={s.path}>{s.path}</div>
                      </div>
                      <span className="text-[9px] font-mono text-white/30 whitespace-nowrap">
                        {s.available ? `${formatSize(s.free)} free / ${formatSize(s.size)}` : 'Unavailable'}
                      </span>
                    </div>
                    <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                      <div className={`h-full transition-all duration-1000 ${s.usedPercent > 90 ? 'bg-red-500' : s.usedPercent > 75 ? 'bg-orange-500' : 'bg-[#00D4FF]/60'}`}
                        style={{ width: `${s.usedPercent}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="shrink-0 pt-4 border-t border-white/5 space-y-3">
              <h3 className="text-[10px] font-mono text-white/20 uppercase tracking-[0.2em]">Application Uptime</h3>
              <div>
                <div className="bg-noir-950/50 p-2.5 rounded-xl border border-white/5">
                  <div className="text-[8px] font-mono text-white/20 uppercase mb-0.5">Uptime</div>
                  <div className="text-[10px] font-bold text-white/80 font-mono">
                    {(() => {
                      let remaining = displayedUptimeSeconds
                      const weeks = Math.floor(remaining / 604800)
                      remaining %= 604800
                      const days = Math.floor(remaining / 86400)
                      remaining %= 86400
                      const hours = Math.floor(remaining / 3600)
                      remaining %= 3600
                      const minutes = Math.floor(remaining / 60)
                      const seconds = remaining % 60
                      return `${weeks}w ${days}d ${hours}h ${minutes}m ${seconds}s`
                    })()}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <UnifiedAddMedia />
      <ManualSearch />
      <DownloadMonitor />

      {selectedEvent && (
        <Modal 
          title={selectedEvent.type === 'series' 
            ? `${selectedEvent.seriesTitle}: Season ${selectedEvent.season_number} Episode ${selectedEvent.episode_number}`
            : (selectedEvent.displayTitle || selectedEvent.title)
          } 
          onClose={() => setSelectedEvent(null)} 
          width={selectedEvent.type === 'series' ? "max-w-4xl" : "max-w-md"}
        >
          {selectedEvent.type === 'series' ? (
            <div className="space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
                {/* Left Side: Thumbnail with Logo Overlay (Smaller) */}
                <div className="md:col-span-5">
                  <div className="aspect-video relative rounded-2xl overflow-hidden border border-white/10 shadow-2xl bg-noir-900 group">
                    {selectedEvent.still_path ? (
                      <img src={tmdbImage(selectedEvent.still_path, 'original') || ''} alt="" className="w-full h-full object-cover transition-transform duration-700" />

                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-6xl opacity-10">📺</div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-noir-950/60 via-transparent to-transparent" />
                    
                    {/* Series Logo Overlay */}
                    {selectedEvent.logoPath || selectedEvent.logo_path ? (
                      <img src={tmdbImage(selectedEvent.logoPath || selectedEvent.logo_path, 'original') || ''} alt="" className="absolute bottom-4 left-4 max-w-[120px] max-h-[50px] object-contain drop-shadow-[0_0_10px_rgba(0,0,0,0.8)]" />
                    ) : (
                      <div className="absolute bottom-4 left-4 text-[8px] font-display uppercase text-white/40 tracking-widest">{selectedEvent.seriesTitle || selectedEvent.title}</div>
                    )}                  </div>
                </div>

                {/* Right Side: Title & Overview (Larger) */}
                <div className="md:col-span-7 space-y-4">
                  <div>
                    <h3 className="text-2xl font-display tracking-tight text-white mb-1 flex items-center gap-3">
                      {selectedEvent.title}
                      {selectedEvent.tabName && (
                        <span className="px-2 py-0.5 rounded bg-white/10 text-[9px] font-mono text-white/50 tracking-widest uppercase border border-white/5">
                          {selectedEvent.tabName}
                        </span>
                      )}
                    </h3>
                    <p className="text-[10px] font-mono text-[#9B59B6] uppercase tracking-[0.2em]">
                      {selectedEvent.seriesTitle} · S{String(selectedEvent.season_number).padStart(2, '0')}E{String(selectedEvent.episode_number).padStart(2, '0')}
                    </p>
                    <p className="text-[10px] font-mono text-white/40 uppercase tracking-widest mt-1">Airs: {episodeAirLabel(selectedEvent)}</p>
                  </div>
                  
                  <div>
                    <h4 className="text-[10px] font-mono text-white/20 uppercase tracking-[0.3em] mb-2">Synopsis</h4>
                    <p className="text-sm text-white/70 leading-relaxed font-light">{selectedEvent.overview || 'No overview available for this episode.'}</p>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 pt-4 border-t border-white/5">
                <button 
                  onClick={() => {
                    navigate(`/series/${selectedEvent.tmdbId}`)
                    setSelectedEvent(null)
                  }}
                  className="flex-1 py-3 rounded-xl bg-[#9B59B6]/10 border border-[#9B59B6]/30 text-[#9B59B6] font-bold tracking-widest text-xs hover:bg-[#9B59B6]/20 transition-all uppercase"
                >
                  View Show Page
                </button>
                <button 
                  onClick={() => setSelectedEvent(null)}
                  className="px-8 py-3 rounded-xl bg-white/5 border border-white/10 text-white/40 font-bold tracking-widest text-xs hover:bg-white/10 transition-all uppercase"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex gap-6">
                <div className="w-24 flex-shrink-0">
                  {selectedEvent.poster_path ? (
                    <img src={tmdbImage(selectedEvent.poster_path, 'w185')} alt="" className="w-full rounded-lg border border-white/10 shadow-lg" />
                  ) : (
                    <div className="aspect-[2/3] rounded-lg bg-noir-800 flex items-center justify-center text-2xl opacity-10">🎬</div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-display text-xl tracking-wider text-white mb-1 uppercase truncate flex items-center gap-3">
                    {selectedEvent.displayTitle || selectedEvent.title}
                    {selectedEvent.tabName && (
                      <span className="px-2 py-0.5 rounded bg-white/10 text-[9px] font-mono text-white/50 tracking-widest uppercase border border-white/5">
                        {selectedEvent.tabName}
                      </span>
                    )}
                  </h3>
                  <p className="text-[10px] font-mono text-white/40 uppercase tracking-widest mb-4">
                    {selectedEvent.type} · {selectedEvent.displaySub || 'Release'}
                  </p>
                  <p className="text-xs text-white/60 font-mono italic">
                    Scheduled for {new Date(selectedEvent.date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
                    {selectedEvent.date.includes('T') && ` at ${new Date(selectedEvent.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}
                  </p>
                </div>
              </div>

              {selectedEvent.overview && (
                <div className="space-y-2">
                  <span className="text-[10px] font-mono text-white/20 uppercase tracking-widest block">Overview</span>
                  <p className="text-xs text-white/50 leading-relaxed max-h-32 overflow-y-auto pr-2 custom-scrollbar">
                    {selectedEvent.overview}
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <button 
                  onClick={() => {
                    const routeType = selectedEvent.type === 'film' ? 'films' : 
                                     selectedEvent.type === 'series' ? 'series' : 
                                     selectedEvent.type === 'music' ? 'music' : 
                                     selectedEvent.type + 's'
                    navigate(`/${routeType}/${selectedEvent.tmdbId}`)
                    setSelectedEvent(null)
                  }}
                  className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-[10px] font-bold tracking-widest hover:bg-white/10 transition-all uppercase">
                  View Page
                </button>
                
                <button 
                  disabled={searching || grabbed || selectedEvent.type !== 'film'}
                  onClick={() => handleQuickSearch(selectedEvent)}
                  className={`px-4 py-2 rounded-xl text-[10px] font-bold tracking-widest transition-all uppercase border ${
                    grabbed ? 'bg-green-500/10 border-green-500/30 text-green-500' :
                    'bg-[#00D4FF]/10 border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/20'
                  } disabled:opacity-30`}>
                  {grabbed ? 'GRABBED ✓' : searching ? 'SEARCHING...' : 'Quick Search'}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
