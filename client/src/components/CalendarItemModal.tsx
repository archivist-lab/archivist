import { useNavigate } from 'react-router-dom'
import { tmdbImage } from '../lib/api.js'
import { Modal } from './ui.js'

export interface CalendarModalItem {
  id?: number
  tmdbId: number
  type: string
  title: string
  displayTitle?: string
  displaySub?: string
  tabName?: string
  date?: string
  overview?: string
  poster_path?: string
  still_path?: string
  logoPath?: string
  logo_path?: string
  seriesTitle?: string
  season_number?: number
  episode_number?: number
  air_at?: string
  air_date?: string
  air_time?: string | null
}

function calendarDate(value: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  return dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value)
}

function storedAirTimeLabel(value?: string | null): string | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? '')
  if (!match) return null
  return new Date(2000, 0, 1, Number(match[1]), Number(match[2])).toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  })
}

function episodeAirLabel(item: CalendarModalItem): string {
  if (item.air_at) {
    return new Date(item.air_at).toLocaleString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  }
  const date = item.air_date ? calendarDate(item.air_date).toLocaleDateString() : null
  const time = storedAirTimeLabel(item.air_time)
  if (date && time) return `${date} at ${time}`
  if (date) return `${date} · Time TBA`
  if (time) return time
  return 'Date & time TBA'
}

export function CalendarItemModal({ item, onClose, onQuickSearch, searching = false, grabbed = false }: {
  item: CalendarModalItem
  onClose: () => void
  onQuickSearch?: (item: CalendarModalItem) => void | Promise<void>
  searching?: boolean
  grabbed?: boolean
}) {
  const navigate = useNavigate()
  const episode = item.type === 'series' && item.season_number != null && item.episode_number != null
  const title = episode
    ? `${item.seriesTitle}: Season ${item.season_number} Episode ${item.episode_number}`
    : item.displayTitle || item.title

  if (episode) return (
    <Modal title={title} onClose={onClose} width="max-w-4xl">
      <div className="space-y-8">
        <div className="grid grid-cols-1 items-start gap-8 md:grid-cols-12">
          <div className="md:col-span-5">
            <div className="group relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-noir-900 shadow-2xl">
              {item.still_path
                ? <img src={tmdbImage(item.still_path, 'original') || ''} alt="" className="h-full w-full object-cover transition-transform duration-700" />
                : <div className="flex h-full w-full items-center justify-center text-6xl opacity-10">📺</div>}
              <div className="absolute inset-0 bg-gradient-to-t from-noir-950/60 via-transparent to-transparent" />
              {item.logoPath || item.logo_path
                ? <img src={tmdbImage(item.logoPath || item.logo_path, 'original') || ''} alt="" className="absolute bottom-4 left-4 max-h-[50px] max-w-[120px] object-contain drop-shadow-[0_0_10px_rgba(0,0,0,0.8)]" />
                : <div className="absolute bottom-4 left-4 font-display text-[8px] uppercase tracking-widest text-white/40">{item.seriesTitle || item.title}</div>}
            </div>
          </div>
          <div className="space-y-4 md:col-span-7">
            <div>
              <h3 className="mb-1 flex items-center gap-3 font-display text-2xl tracking-tight text-white">
                {item.title}
                {item.tabName && <span className="rounded border border-white/5 bg-white/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-white/50">{item.tabName}</span>}
              </h3>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#9B59B6]">{item.seriesTitle} · S{String(item.season_number).padStart(2, '0')}E{String(item.episode_number).padStart(2, '0')}</p>
              <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-white/40">Airs: {episodeAirLabel(item)}</p>
            </div>
            <div>
              <h4 className="mb-2 font-mono text-[10px] uppercase tracking-[0.3em] text-white/20">Synopsis</h4>
              <p className="text-sm font-light leading-relaxed text-white/70">{item.overview || 'No overview available for this episode.'}</p>
            </div>
          </div>
        </div>
        <div className="flex gap-3 border-t border-white/5 pt-4">
          <button onClick={() => { navigate(`/series/${item.tmdbId}`); onClose() }} className="flex-1 rounded-xl border border-[#9B59B6]/30 bg-[#9B59B6]/10 py-3 text-xs font-bold uppercase tracking-widest text-[#9B59B6] transition-all hover:bg-[#9B59B6]/20">View Show Page</button>
          <button onClick={onClose} className="rounded-xl border border-white/10 bg-white/5 px-8 py-3 text-xs font-bold uppercase tracking-widest text-white/40 transition-all hover:bg-white/10">Close</button>
        </div>
      </div>
    </Modal>
  )

  const routeType = item.type === 'film' ? 'films' : item.type === 'series' ? 'series' : item.type === 'music' ? 'music' : `${item.type}s`
  return (
    <Modal title={title} onClose={onClose} width="max-w-md">
      <div className="space-y-6">
        <div className="flex gap-6">
          <div className="w-24 flex-shrink-0">
            {item.poster_path
              ? <img src={tmdbImage(item.poster_path, 'w185')} alt="" className="w-full rounded-lg border border-white/10 shadow-lg" />
              : <div className="flex aspect-[2/3] items-center justify-center rounded-lg bg-noir-800 text-2xl opacity-10">{item.type === 'series' ? '📺' : '🎬'}</div>}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="mb-1 flex truncate font-display text-xl uppercase tracking-wider text-white">
              {item.displayTitle || item.title}
              {item.tabName && <span className="ml-3 rounded border border-white/5 bg-white/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-widest text-white/50">{item.tabName}</span>}
            </h3>
            <p className="mb-4 font-mono text-[10px] uppercase tracking-widest text-white/40">{item.type} · {item.displaySub || 'Release'}</p>
            {item.date && <p className="font-mono text-xs italic text-white/60">
              Scheduled for {calendarDate(item.date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
              {item.date.includes('T') && ` at ${new Date(item.date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}
            </p>}
          </div>
        </div>
        {item.overview && <div className="space-y-2">
          <span className="block font-mono text-[10px] uppercase tracking-widest text-white/20">Overview</span>
          <p className="custom-scrollbar max-h-32 overflow-y-auto pr-2 text-xs leading-relaxed text-white/50">{item.overview}</p>
        </div>}
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => { navigate(`/${routeType}/${item.tmdbId}`); onClose() }} className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-bold uppercase tracking-widest transition-all hover:bg-white/10">View Page</button>
          <button disabled={searching || grabbed || item.type !== 'film' || !onQuickSearch} onClick={() => onQuickSearch?.(item)} className={`rounded-xl border px-4 py-2 text-[10px] font-bold uppercase tracking-widest transition-all ${grabbed ? 'border-green-500/30 bg-green-500/10 text-green-500' : 'border-[#00D4FF]/30 bg-[#00D4FF]/10 text-[#00D4FF] hover:bg-[#00D4FF]/20'} disabled:opacity-30`}>
            {grabbed ? 'GRABBED ✓' : searching ? 'SEARCHING...' : 'Quick Search'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
