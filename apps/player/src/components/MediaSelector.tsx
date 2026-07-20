import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { MediaTracks } from '../lib/sdk.js'
import type { ArchivistSdk } from '../lib/sdk.js'
import { PlayerIcon } from './Icons.js'
import { useDialogFocus } from '../focus/useDialogFocus.js'

export interface DetailTrackSelection {
  /** Undefined means the tracks have not yet been inspected. */
  audioIndex?: number
  /** Undefined means uninspected; null explicitly disables subtitles. */
  subtitleIndex?: number | null
}

const LANGUAGE_COUNTRIES: Record<string, string> = {
  ar: 'SA', ara: 'SA', bg: 'BG', bul: 'BG', bn: 'BD', ben: 'BD', cs: 'CZ', ces: 'CZ', cze: 'CZ',
  da: 'DK', dan: 'DK', de: 'DE', deu: 'DE', ger: 'DE', el: 'GR', ell: 'GR', gre: 'GR', en: 'GB', eng: 'GB',
  es: 'ES', spa: 'ES', et: 'EE', est: 'EE', fa: 'IR', fas: 'IR', per: 'IR', fi: 'FI', fin: 'FI', fil: 'PH',
  fr: 'FR', fra: 'FR', fre: 'FR', he: 'IL', heb: 'IL', hi: 'IN', hin: 'IN', hr: 'HR', hrv: 'HR',
  hu: 'HU', hun: 'HU', id: 'ID', ind: 'ID', it: 'IT', ita: 'IT', ja: 'JP', jpn: 'JP', ko: 'KR', kor: 'KR',
  lt: 'LT', lit: 'LT', lv: 'LV', lav: 'LV', ml: 'IN', mal: 'IN', ms: 'MY', msa: 'MY', may: 'MY',
  nl: 'NL', nld: 'NL', dut: 'NL', no: 'NO', nor: 'NO', pl: 'PL', pol: 'PL', pt: 'BR', por: 'BR',
  ro: 'RO', ron: 'RO', rum: 'RO', ru: 'RU', rus: 'RU', sk: 'SK', slk: 'SK', slo: 'SK', sl: 'SI', slv: 'SI',
  sr: 'RS', srp: 'RS', sv: 'SE', swe: 'SE', ta: 'IN', tam: 'IN', te: 'IN', tel: 'IN', th: 'TH', tha: 'TH',
  tr: 'TR', tur: 'TR', uk: 'UA', ukr: 'UA', ur: 'PK', urd: 'PK', vi: 'VN', vie: 'VN', zh: 'CN', zho: 'CN', chi: 'CN',
}

function normalizedLanguage(language: string | null | undefined): string | null {
  if (!language || language.toLowerCase() === 'und') return null
  return language.replace('_', '-').toLowerCase()
}

export function languageFlag(language: string | null | undefined): string {
  const normalized = normalizedLanguage(language)
  if (!normalized) return '🌐'
  const [, embeddedRegion] = normalized.match(/^[a-z]{2,3}-([a-z]{2})\b/i) ?? []
  const country = embeddedRegion?.toUpperCase() ?? LANGUAGE_COUNTRIES[normalized.split('-')[0]]
  if (!country) return '🌐'
  return [...country].map(letter => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('')
}

function languageName(language: string | null | undefined): string | null {
  const normalized = normalizedLanguage(language)
  if (!normalized) return null
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(normalized.split('-')[0]) ?? null
  } catch {
    return normalized.toUpperCase()
  }
}

export function titleCase(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/(^|[\s·/([{_-])([\p{L}\p{N}])/gu, (_, boundary: string, letter: string) => `${boundary}${letter.toLocaleUpperCase()}`)
}

function trackTitle(track: { language?: string | null; title?: string | null }, fallback: string): string {
  return titleCase(track.title?.trim() || languageName(track.language) || fallback)
}

export function audioTrackLabel(track: MediaTracks['audio'][number]): string {
  return `${languageFlag(track.languageCode ?? track.language)} ${trackTitle(track, 'Audio')}`
}

export function subtitleTrackLabel(track: MediaTracks['subtitles'][number]): string {
  return `${languageFlag(track.languageCode ?? track.language)} ${trackTitle(track, 'Subtitle')}`
}

function audioTrackDetail(track: MediaTracks['audio'][number]): string {
  return [titleCase(track.channelLayout || (track.channels ? `${track.channels} channels` : 'Channels unknown')), track.codec.toUpperCase()].join(' ㆍ ')
}

export function MediaSelector({ sdk, type, id, title, selection, onChange, disabled = false }: {
  sdk: ArchivistSdk
  type: 'films' | 'episodes'
  id: number
  title: string
  selection: DetailTrackSelection
  onChange: (selection: DetailTrackSelection) => void
  disabled?: boolean
}) {
  const [tracks, setTracks] = useState<MediaTracks | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useDialogFocus<HTMLDivElement>(open, () => setOpen(false))
  useEffect(() => { setTracks(null); setError(null) }, [type, id])
  useEffect(() => {
    let cancelled = false
    if (disabled || !open) return
    setError(null)
    sdk.mediaTracks(type, id).then(value => { if (!cancelled) setTracks(value) }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [sdk, type, id, disabled, open])
  const defaultAudio = tracks?.audio.find(track => track.default) ?? tracks?.audio[0]
  const defaultSubtitle = tracks?.subtitles.find(track => track.default)
  const selectedAudioIndex = selection.audioIndex !== undefined && tracks?.audio.some(track => track.index === selection.audioIndex) ? selection.audioIndex : defaultAudio?.index
  const selectedSubtitleIndex = selection.subtitleIndex === null ? null : selection.subtitleIndex !== undefined && tracks?.subtitles.some(track => track.index === selection.subtitleIndex) ? selection.subtitleIndex : defaultSubtitle?.index ?? null
  const audio = tracks?.audio.find(track => track.index === selectedAudioIndex)
  const subtitle = selectedSubtitleIndex === null ? null : tracks?.subtitles.find(track => track.index === selectedSubtitleIndex)
  useEffect(() => {
    if (!tracks) return
    if (selection.audioIndex === selectedAudioIndex && selection.subtitleIndex === selectedSubtitleIndex) return
    onChange({ ...selection, audioIndex: selectedAudioIndex, subtitleIndex: selectedSubtitleIndex })
  }, [tracks, selection.audioIndex, selection.subtitleIndex, selectedAudioIndex, selectedSubtitleIndex, onChange])
  const summary = useMemo(() => {
    if (disabled) return 'No playable media'
    if (!tracks && !error) return 'Audio and subtitle options'
    if (error) return 'Media information unavailable'
    const audioSummary = audio ? audioTrackLabel(audio) : 'No audio tracks'
    const subtitleSummary = subtitle ? subtitleTrackLabel(subtitle) : 'Subtitles off'
    return `${audioSummary} · ${subtitleSummary}`
  }, [audio, disabled, error, subtitle, tracks])
  const close = () => setOpen(false)
  return <>
    <button type="button" disabled={disabled} onClick={() => setOpen(true)} className="player-focusable group flex min-h-14 max-w-3xl items-center gap-4 rounded-2xl border border-white/10 bg-black/28 px-5 py-3 text-left transition hover:bg-white/8 disabled:opacity-35">
      <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full player-accent-soft"><PlayerIcon name="media" size={19} /></span>
      <span className="min-w-0"><span className="block text-xs font-semibold uppercase tracking-[.18em] text-white/42">Media</span><span className="mt-1 block truncate text-sm text-white/78">{summary}</span></span>
      <PlayerIcon name="chevron-right" size={19} className="ml-auto text-white/30 transition group-hover:translate-x-1" />
    </button>
    {open && <div ref={dialogRef} className="fixed inset-0 z-[110] flex items-end justify-end bg-black/72 p-[var(--safe-x)]" role="dialog" aria-modal="true" aria-labelledby="media-selector-title" onClick={close}>
      <section className="player-dialog motion-dialog max-h-[86vh] w-full max-w-2xl overflow-y-auto rounded-3xl p-8" onClick={event => event.stopPropagation()}>
        <header className="flex items-start gap-5 border-b border-white/10 pb-6"><div className="min-w-0 flex-1"><p className="text-xs font-semibold uppercase tracking-[.22em] player-accent">Playback media</p><h2 id="media-selector-title" className="mt-2 truncate text-3xl font-semibold">{title}</h2>{tracks && <p className="mt-2 text-sm text-white/42">{[tracks.container?.toUpperCase(), tracks.video?.codec?.toUpperCase(), tracks.video?.profile, tracks.durationSec ? `${Math.round(tracks.durationSec / 60)} min` : null].filter(Boolean).join(' · ')}</p>}</div><button data-dialog-initial onClick={close} className="player-focusable rounded-full bg-white/8 px-5 py-3 font-semibold">Close</button></header>
        {error && <p role="alert" className="mt-6 text-pink">{error}</p>}
        {!tracks && !error && <p className="player-skeleton py-10 text-center text-white/38">Inspecting tracks</p>}
        {tracks && <div className="grid gap-8 pt-7 md:grid-cols-2">
          <TrackGroup title="Audio" subtitle={`${tracks.audio.length} track${tracks.audio.length === 1 ? '' : 's'}`}>
            {tracks.audio.map(track => <Choice key={track.index} active={selectedAudioIndex === track.index} onClick={() => onChange({ ...selection, audioIndex: track.index, subtitleIndex: selectedSubtitleIndex })} flag={languageFlag(track.languageCode ?? track.language)} title={trackTitle(track, 'Audio')} detail={audioTrackDetail(track)} />)}
            {!tracks.audio.length && <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-white/38">No audio tracks reported.</p>}
          </TrackGroup>
          <TrackGroup title="Subtitles" subtitle={`${tracks.subtitles.length} track${tracks.subtitles.length === 1 ? '' : 's'}`}>
            <Choice active={selectedSubtitleIndex === null} onClick={() => onChange({ ...selection, audioIndex: selectedAudioIndex, subtitleIndex: null })} title="Off" />
            {tracks.subtitles.map(track => <Choice key={track.index} active={selectedSubtitleIndex === track.index} onClick={() => onChange({ ...selection, audioIndex: selectedAudioIndex, subtitleIndex: track.index })} flag={languageFlag(track.languageCode ?? track.language)} title={trackTitle(track, 'Subtitle')} />)}
          </TrackGroup>
        </div>}
      </section>
    </div>}
  </>
}

function TrackGroup({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <section><div className="mb-3 flex items-baseline justify-between"><h3 className="text-xl font-semibold">{title}</h3><span className="text-xs text-white/35">{subtitle}</span></div><div className="space-y-2">{children}</div></section>
}

function Choice({ active, flag, title, detail, onClick }: { active: boolean; flag?: string; title: string; detail?: string; onClick: () => void }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`player-focusable flex min-h-16 w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left ${active ? 'player-accent-border player-accent-soft' : 'border-white/8 bg-white/4 hover:bg-white/8'}`}>
    {flag && <span aria-hidden="true" className="shrink-0 text-2xl leading-none">{flag}</span>}
    <span className="min-w-0 flex-1"><strong className="block truncate text-base">{title}</strong>{detail && <span className="mt-1 block truncate text-xs text-white/38">{detail}</span>}</span>
    <span aria-hidden="true" className="grid w-5 shrink-0 place-items-center">{active && <PlayerIcon name="check" size={17} />}</span>
  </button>
}
