import { useState } from 'react'
import { useTabs, type MediaType } from '../lib/tab-context.js'
import { sharedApi, type ApiKeysConfig } from '../lib/shared.api.js'
import { Spinner } from './ui.js'

const MEDIA: { key: MediaType; label: string; icon: string; color: string; desc: string }[] = [
  { key: 'films',  label: 'Films',  icon: '🎬', color: '#00D4FF', desc: 'Movies' },
  { key: 'series', label: 'Series', icon: '📺', color: '#9B59B6', desc: 'TV shows' },
  { key: 'music',  label: 'Music',  icon: '🎵', color: '#FF2D78', desc: 'Artists & albums' },
  { key: 'books',  label: 'Books',  icon: '📚', color: '#F1C40F', desc: 'Authors & books' },
  { key: 'comics', label: 'Comics', icon: '🦸', color: '#E67E22', desc: 'Comic series' },
  { key: 'games',  label: 'Games',  icon: '🎮', color: '#2ECC71', desc: 'Video games' },
]

type KeyField = { key: keyof ApiKeysConfig; label: string; types: MediaType[]; help: string; optional?: boolean }
const KEY_FIELDS: KeyField[] = [
  { key: 'tmdbApiKey',        label: 'TMDB API Key',        types: ['films', 'series'], help: 'Film & series metadata, posters, cast' },
  { key: 'tvdbApiKey',        label: 'TVDB API Key',        types: ['series'],          help: 'Series & episode data' },
  { key: 'tvdbPin',           label: 'TVDB PIN',            types: ['series'],          help: 'Optional subscriber PIN', optional: true },
  { key: 'googleBooksApiKey', label: 'Google Books API Key',types: ['books'],           help: 'Book metadata & covers' },
  { key: 'comicvineApiKey',   label: 'ComicVine API Key',   types: ['comics'],          help: 'Comic series & issue data' },
  { key: 'igdbClientId',      label: 'IGDB Client ID',      types: ['games'],           help: 'Game metadata (Twitch dev app)' },
  { key: 'igdbClientSecret',  label: 'IGDB Client Secret',  types: ['games'],           help: 'Game metadata (Twitch dev app)' },
  { key: 'fanartApiKey',      label: 'Fanart.tv API Key',   types: ['films', 'series', 'music'], help: 'Extra artwork (optional)', optional: true },
]

const EMPTY_KEYS: ApiKeysConfig = {
  tmdbApiKey: '', tvdbApiKey: '', tvdbPin: '', googleBooksApiKey: '',
  comicvineApiKey: '', igdbClientId: '', igdbClientSecret: '', fanartApiKey: '',
}

export function SetupWizard() {
  const { enabledMediaTypes, saveEnabledMediaTypes, completeOnboarding } = useTabs()
  const [step, setStep] = useState(0)
  const [selected, setSelected] = useState<Set<MediaType>>(new Set(enabledMediaTypes))
  const [keys, setKeys] = useState<ApiKeysConfig>(EMPTY_KEYS)
  const [saving, setSaving] = useState(false)

  const steps = ['Welcome', 'Libraries', 'API Keys', 'Downloads', 'Indexers', 'Finish']
  const relevantKeys = KEY_FIELDS.filter(f => f.types.some(t => selected.has(t)))

  const toggle = (t: MediaType) => setSelected(prev => {
    const n = new Set(prev)
    n.has(t) ? n.delete(t) : n.add(t)
    return n.size === 0 ? prev : n // never allow zero
  })

  const finish = async () => {
    setSaving(true)
    try {
      await saveEnabledMediaTypes([...selected])
      if (Object.values(keys).some(v => v && v.trim())) {
        try { await sharedApi.settings.setApiKeys(keys) } catch (err) { console.error('Failed saving keys', err) }
      }
      await completeOnboarding()
    } finally {
      setSaving(false)
    }
  }

  const next = () => setStep(s => Math.min(s + 1, steps.length - 1))
  const back = () => setStep(s => Math.max(s - 1, 0))

  return (
    <div className="fixed inset-0 z-[100] overflow-y-auto bg-noir-950">
      <div className="min-h-full flex flex-col items-center px-6 py-10">
        {/* Progress */}
        <div className="w-full max-w-2xl mb-10">
          <div className="flex items-center justify-between mb-3">
            <span className="font-display text-2xl tracking-widest text-white uppercase">Archivist</span>
            <button onClick={finish} disabled={saving} className="text-[10px] font-bold uppercase tracking-widest text-white/30 hover:text-white/70 transition-all">Skip setup →</button>
          </div>
          <div className="flex gap-1.5">
            {steps.map((_, i) => (
              <div key={i} className="h-1 flex-1 rounded-full transition-all" style={{ background: i <= step ? '#00D4FF' : 'rgba(255,255,255,0.08)' }} />
            ))}
          </div>
          <p className="mt-2 text-[10px] font-mono uppercase tracking-widest text-white/30">Step {step + 1} of {steps.length} · {steps[step]}</p>
        </div>

        <div className="w-full max-w-2xl flex-1">
          {step === 0 && (
            <div className="text-center py-10 animate-fade-in">
              <div className="text-6xl mb-6">🗄️</div>
              <h1 className="font-display text-4xl tracking-tight text-white mb-4">Welcome to Archivist</h1>
              <p className="text-sm text-white/50 leading-relaxed max-w-md mx-auto mb-10">
                Let's get you set up in a minute. We'll pick what you want to manage, add your metadata keys,
                and point you at downloads. You can change everything later in Settings.
              </p>
              <button onClick={next} className="px-10 py-4 rounded-2xl bg-[#00D4FF] text-noir-950 font-bold tracking-widest text-xs uppercase shadow-[0_0_30px_rgba(0,212,255,0.4)] hover:scale-105 active:scale-95 transition-all">
                Get Started
              </button>
            </div>
          )}

          {step === 1 && (
            <div className="animate-fade-in">
              <h2 className="text-2xl font-display tracking-tight text-white mb-2">What do you want to manage?</h2>
              <p className="text-sm text-white/40 mb-8">Turn off anything you don't need — it'll be hidden from the app. You can re-enable it in Settings anytime.</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {MEDIA.map(m => {
                  const on = selected.has(m.key)
                  return (
                    <button key={m.key} onClick={() => toggle(m.key)}
                      className={`p-5 rounded-2xl border text-left transition-all ${on ? 'border-white/20 bg-white/[0.06]' : 'border-white/5 bg-noir-900 opacity-50 hover:opacity-80'}`}
                      style={on ? { boxShadow: `0 0 24px ${m.color}22`, borderColor: `${m.color}55` } : undefined}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-3xl">{m.icon}</span>
                        <span className={`w-5 h-5 rounded-md flex items-center justify-center text-[11px] ${on ? 'text-noir-950' : 'text-transparent border border-white/20'}`} style={on ? { background: m.color } : undefined}>✓</span>
                      </div>
                      <span className="block text-sm font-bold text-white">{m.label}</span>
                      <span className="block text-[11px] text-white/30">{m.desc}</span>
                    </button>
                  )
                })}
              </div>
              <NavRow onBack={back} onNext={next} />
            </div>
          )}

          {step === 2 && (
            <div className="animate-fade-in">
              <h2 className="text-2xl font-display tracking-tight text-white mb-2">Metadata API keys</h2>
              <p className="text-sm text-white/40 mb-8">Archivist uses these to fetch metadata and artwork for the libraries you chose. Paste what you have — you can add the rest later in Settings → API Keys.</p>
              <div className="space-y-4">
                {relevantKeys.map(f => (
                  <div key={f.key}>
                    <label className="flex items-baseline justify-between mb-1.5">
                      <span className="text-[11px] font-bold uppercase tracking-widest text-white/60">{f.label}{f.optional && <span className="text-white/25 font-normal normal-case tracking-normal"> — optional</span>}</span>
                      <span className="text-[10px] text-white/25">{f.help}</span>
                    </label>
                    <input
                      value={(keys[f.key] as string) || ''}
                      onChange={e => setKeys(k => ({ ...k, [f.key]: e.target.value }))}
                      placeholder={f.label}
                      className="w-full px-4 py-2.5 rounded-xl bg-noir-900 border border-white/10 text-white text-sm focus:border-[#00D4FF]/50 focus:outline-none" />
                  </div>
                ))}
                {relevantKeys.length === 0 && <p className="text-xs text-white/30 py-4">No metadata keys needed for your selection.</p>}
              </div>
              <NavRow onBack={back} onNext={next} />
            </div>
          )}

          {step === 3 && (
            <div className="animate-fade-in">
              <h2 className="text-2xl font-display tracking-tight text-white mb-2">Downloads</h2>
              <p className="text-sm text-white/40 mb-8">How Archivist fetches your media.</p>
              <div className="rounded-2xl border border-[#00D4FF]/30 bg-[#00D4FF]/[0.04] p-6 mb-4">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-2xl">⚡</span>
                  <span className="text-sm font-bold text-white">Built-in download engine</span>
                  <span className="text-[9px] px-2 py-0.5 rounded-full bg-[#00D4FF]/15 text-[#00D4FF] font-bold uppercase tracking-widest">Ready</span>
                </div>
                <p className="text-xs text-white/50 leading-relaxed">Archivist ships with an embedded torrent engine, so downloads work out of the box — nothing to configure here.</p>
              </div>
              <p className="text-xs text-white/30 leading-relaxed">Prefer your own client? You can connect qBittorrent, Transmission or others under <span className="text-white/50">Settings → Torrents</span> after setup.</p>
              <NavRow onBack={back} onNext={next} />
            </div>
          )}

          {step === 4 && (
            <div className="animate-fade-in">
              <h2 className="text-2xl font-display tracking-tight text-white mb-2">Indexers</h2>
              <p className="text-sm text-white/40 mb-8">Indexers are where Archivist searches for releases.</p>
              <div className="rounded-2xl border border-white/10 bg-noir-900 p-6 mb-4">
                <p className="text-sm text-white/70 leading-relaxed mb-3">
                  Add your Torznab/Newznab indexers (or a Prowlarr/Jackett endpoint) under <span className="text-white font-semibold">Settings → Indexers</span>. Archivist ships with hundreds of indexer definitions you can search by name.
                </p>
                <p className="text-xs text-white/30">You'll need at least one indexer before Archivist can find releases — but you can do this any time.</p>
              </div>
              <NavRow onBack={back} onNext={next} />
            </div>
          )}

          {step === 5 && (
            <div className="text-center py-10 animate-fade-in">
              <div className="text-6xl mb-6">✅</div>
              <h2 className="font-display text-3xl tracking-tight text-white mb-4">You're all set</h2>
              <div className="max-w-sm mx-auto text-left rounded-2xl border border-white/10 bg-noir-900 p-5 mb-8 space-y-2">
                <Summary label="Libraries" value={[...selected].map(t => MEDIA.find(m => m.key === t)?.label).join(', ')} />
                <Summary label="API keys entered" value={String(Object.values(keys).filter(v => v && v.trim()).length)} />
              </div>
              <button onClick={finish} disabled={saving}
                className="px-10 py-4 rounded-2xl bg-[#00D4FF] text-noir-950 font-bold tracking-widest text-xs uppercase shadow-[0_0_30px_rgba(0,212,255,0.4)] hover:scale-105 active:scale-95 transition-all disabled:opacity-50 inline-flex items-center gap-3">
                {saving && <Spinner className="w-4 h-4" color="text-noir-950" />}
                {saving ? 'Setting up…' : 'Enter Archivist'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function NavRow({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  return (
    <div className="flex items-center justify-between mt-10">
      <button onClick={onBack} className="px-6 py-3 rounded-xl text-[10px] font-bold uppercase tracking-widest text-white/40 hover:text-white transition-all">← Back</button>
      <button onClick={onNext} className="px-8 py-3 rounded-xl bg-white/10 border border-white/15 text-white font-bold tracking-widest text-[10px] uppercase hover:bg-white/15 transition-all">Continue →</button>
    </div>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 text-xs">
      <span className="text-white/30 uppercase tracking-widest text-[10px] font-mono shrink-0">{label}</span>
      <span className="text-white/70 text-right">{value || '—'}</span>
    </div>
  )
}
