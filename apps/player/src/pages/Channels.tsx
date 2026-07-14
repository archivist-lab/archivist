import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ArchivistSdk, ChannelSummary, GuideSlot, PlaySession, SessionMode } from '../lib/sdk.js'
import { SessionPlayer } from '../components/SessionPlayer.js'

/**
 * TV — the consumption guide (archivist-channels.md §25/§32). Channel rows
 * with now/next, a clickable day guide, and the three playback modes: Watch
 * from here (default), Join live (currently airing), Play this only.
 */

const DAY_MS = 24 * 3600 * 1000

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

const slotTitle = (s: GuideSlot) =>
  s.seriesTitle && s.seasonNumber != null
    ? `${s.seriesTitle} S${String(s.seasonNumber).padStart(2, '0')}E${String(s.episodeNumber).padStart(2, '0')}`
    : s.title

export function ChannelsPage({ sdk, v2 = false }: { sdk: ArchivistSdk; v2?: boolean }) {
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null)
  const [guides, setGuides] = useState<Record<number, GuideSlot[]>>({})
  const [dayOffset, setDayOffset] = useState(0)
  const [picked, setPicked] = useState<{ channel: ChannelSummary; slot: GuideSlot } | null>(null)
  const [session, setSession] = useState<PlaySession | null>(null)
  const [error, setError] = useState<string | null>(null)

  const dayStart = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0)
    return d.getTime() + dayOffset * DAY_MS
  }, [dayOffset])

  const reload = useCallback(() => {
    sdk.channels()
      .then(async d => {
        setChannels(d.channels)
        const entries = await Promise.all(
          d.channels.map(async c => [c.id, (await sdk.channelGuide(c.id, dayStart, dayStart + DAY_MS)).slots] as const),
        )
        setGuides(Object.fromEntries(entries))
      })
      .catch(e => setError(String(e)))
  }, [sdk, dayStart])
  useEffect(reload, [reload])

  const play = async (channel: ChannelSummary, slot: GuideSlot, mode: SessionMode) => {
    setPicked(null)
    try {
      const s = await sdk.createPlaySession(channel.id, slot.id, mode)
      setSession(s)
    } catch (e: any) { setError(e.message) }
  }

  const nowMs = Date.now()
  const dayLabel = new Date(dayStart).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })

  if (error) return <p className="p-8 text-sm text-red-400">{error}</p>
  if (!channels) return <div className="p-16 text-center text-white/25 text-[11px] font-mono uppercase tracking-[0.3em] animate-pulse">Tuning…</div>

  if (channels.length === 0) {
    return (
      <div className="p-20 text-center">
        <p className="text-4xl mb-4">📡</p>
        <p className="text-white/40 text-sm mb-1">No channels on air.</p>
        <p className="text-[11px] font-mono text-white/20 uppercase tracking-widest">Programme your network in Archivist → Channels, then tune in here.</p>
      </div>
    )
  }

  return (
    <div className={`${v2 ? 'h-full overflow-y-auto no-scrollbar player-safe' : 'px-5 pb-16'} animate-fade-in`}>
      <div className="flex items-center gap-3 py-4">
        <h1 className="text-2xl font-semibold tracking-tight text-white">TV Guide</h1>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setDayOffset(d => d - 1)} className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/60 text-xs hover:text-white">←</button>
          <span className="text-xs font-semibold text-white/80 min-w-40 text-center">{dayLabel}{dayOffset === 0 ? ' · Today' : ''}</span>
          <button onClick={() => setDayOffset(d => d + 1)} className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/60 text-xs hover:text-white">→</button>
        </div>
      </div>

      <div className="space-y-6">
        {channels.map(c => (
          <ChannelLane
            key={c.id}
            channel={c}
            slots={guides[c.id] ?? []}
            nowMs={nowMs}
            isToday={dayOffset === 0}
            onPick={slot => setPicked({ channel: c, slot })}
          />
        ))}
      </div>

      {picked && (
        <SlotSheet
          channel={picked.channel}
          slot={picked.slot}
          onClose={() => setPicked(null)}
          onPlay={mode => play(picked.channel, picked.slot, mode)}
        />
      )}

      {session && (
        <SessionPlayer
          session={session}
          sdk={sdk}
          onClose={() => { setSession(null); reload() }}
        />
      )}
    </div>
  )
}

function ChannelLane({ channel, slots, nowMs, isToday, onPick }: {
  channel: ChannelSummary; slots: GuideSlot[]; nowMs: number; isToday: boolean
  onPick: (slot: GuideSlot) => void
}) {
  return (
    <section>
      <div className="flex items-center gap-3 mb-2">
        <span className="w-8 h-8 rounded-lg flex items-center justify-center font-display text-sm shrink-0 bg-cyan/10 text-cyan border border-cyan/30">
          {channel.number}
        </span>
        <h2 className="text-sm font-bold text-white tracking-wide">{channel.name}</h2>
        {isToday && channel.now && (
          <span className="text-[10px] font-mono text-white/40 truncate">
            <span className="text-[#FF2D78] font-bold uppercase mr-1.5">● On now</span>
            {slotTitle(channel.now)}
            {channel.next && <span className="text-white/25"> · next {fmtTime(channel.next.startsAt)} {slotTitle(channel.next)}</span>}
          </span>
        )}
      </div>

      {slots.length === 0 ? (
        <p className="text-[10px] font-mono text-white/20 uppercase tracking-widest py-4 pl-11">off air</p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-2 pl-11 -ml-0.5">
          {slots.map(s => {
            const airing = isToday && nowMs >= s.startsAt && nowMs < s.endsAt
            const past = s.endsAt <= nowMs && isToday
            const pct = airing ? ((nowMs - s.startsAt) / (s.endsAt - s.startsAt)) * 100 : 0
            return (
              <button key={s.id} onClick={() => onPick(s)}
                className={`relative shrink-0 w-52 text-left rounded-xl border overflow-hidden transition-all hover:scale-[1.02]
                  ${airing ? 'border-[#FF2D78]/60' : 'border-white/10 hover:border-white/25'} ${past && !airing ? 'opacity-50' : ''}`}>
                <div className="h-24 bg-noir-900 relative">
                  {(s.backdropUrl || s.posterUrl) && (
                    <img src={s.backdropUrl || s.posterUrl || ''} alt="" className="w-full h-full object-cover" loading="lazy" />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
                  {airing && (
                    <span className="absolute top-1.5 right-1.5 text-[8px] font-mono font-bold uppercase tracking-widest bg-[#FF2D78] text-white rounded px-1.5 py-0.5">Live</span>
                  )}
                  {s.status === 'watched' && (
                    <span className="absolute top-1.5 right-1.5 text-[10px]">✓</span>
                  )}
                  <div className="absolute bottom-0 inset-x-0 p-2">
                    <p className="text-[11px] font-semibold text-white leading-tight truncate">{slotTitle(s)}</p>
                    <p className="text-[9px] font-mono text-white/45">{fmtTime(s.startsAt)}–{fmtTime(s.endsAt)}{s.blockName ? ` · ${s.blockName}` : ''}</p>
                  </div>
                  {airing && (
                    <progress aria-label={`${Math.round(pct)}% aired`} value={pct} max={100} className="player-progress player-progress-pink absolute bottom-0 inset-x-0 h-0.5 w-full" />
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function SlotSheet({ channel, slot, onClose, onPlay }: {
  channel: ChannelSummary; slot: GuideSlot; onClose: () => void; onPlay: (mode: SessionMode) => void
}) {
  const airing = Date.now() >= slot.startsAt && Date.now() < slot.endsAt
  const playable = slot.hasFile

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-noir-900 border border-white/10 overflow-hidden animate-slide-up">
        <div className="h-36 relative bg-noir-950">
          {(slot.backdropUrl || slot.posterUrl) && (
            <img src={slot.backdropUrl || slot.posterUrl || ''} alt="" className="w-full h-full object-cover" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-noir-900 via-noir-900/40 to-transparent" />
          <div className="absolute bottom-3 left-4 right-4">
            <p className="text-[9px] font-mono uppercase tracking-[0.25em] mb-1 text-cyan">
              {channel.number} · {channel.name}{slot.blockName ? ` · ${slot.blockName}` : ''}
            </p>
            <h3 className="font-display text-2xl text-white tracking-wide leading-none">{slotTitle(slot)}</h3>
            <p className="text-[10px] font-mono text-white/40 mt-1">
              {fmtTime(slot.startsAt)}–{fmtTime(slot.endsAt)} · {Math.round(slot.runtimeSeconds / 60)} min{slot.year ? ` · ${slot.year}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="absolute top-3 right-3 text-white/50 hover:text-white">✕</button>
        </div>
        <div className="p-4 space-y-2">
          {!playable && <p className="text-xs text-red-400/80 text-center py-2">This item has no playable file.</p>}
          {playable && (
            <>
              {airing && (
                <button onClick={() => onPlay('JOIN_LIVE')}
                  className="w-full py-3 rounded-xl bg-[#FF2D78] text-white font-bold tracking-widest text-[11px] uppercase hover:brightness-110 transition-all">
                  ● Join live
                </button>
              )}
              <button onClick={() => onPlay('WATCH_FROM_HERE')}
                className="w-full py-3 rounded-xl bg-cyan text-noir-950 font-bold tracking-widest text-[11px] uppercase hover:brightness-110 transition-all">
                ▶ Watch from here
              </button>
              <button onClick={() => onPlay('PLAY_THIS_ONLY')}
                className="w-full py-3 rounded-xl bg-white/8 border border-white/15 text-white/80 font-bold tracking-widest text-[11px] uppercase hover:bg-white/15 transition-all">
                Play this only
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
