import { useState } from 'react'
import { ArchivistSdk } from '../lib/sdk.js'
import { updateSettings } from '../lib/store.js'

/** First-run pairing: point the player at an Archivist server. */
export function Connect() {
  const [url, setUrl] = useState('http://localhost:2424')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    setBusy(true); setError(null)
    try {
      const clean = url.trim().replace(/\/$/, '')
      const sdk = new ArchivistSdk({ url: clean, apiKey: apiKey.trim() })
      const health = await sdk.health()
      if (health.status !== 'ok') throw new Error('Server did not report ok')
      updateSettings({ connection: { url: clean, apiKey: apiKey.trim() } })
    } catch (err) {
      setError('Could not reach Archivist there. Check the URL (and API key if one is set).')
      console.error(err)
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md animate-slide-up">
        <h1 className="font-display text-5xl tracking-[0.2em] text-white uppercase text-center mb-2">
          Archivist <span className="text-cyan">Player</span>
        </h1>
        <p className="text-center text-white/35 text-sm mb-10">The front door to everything Archivist maintains.</p>

        <div className="rounded-2xl bg-noir-900 border border-white/5 p-6 space-y-5">
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-widest text-white/40 mb-2">Archivist server URL</label>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://192.168.1.10:2424"
              className="w-full px-4 py-2.5 rounded-xl bg-noir-950 border border-white/10 text-white text-sm focus:border-cyan/50 focus:outline-none" />
          </div>
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-widest text-white/40 mb-2">API key <span className="text-white/20 normal-case">(only if configured)</span></label>
            <input value={apiKey} onChange={e => setApiKey(e.target.value)} type="password" placeholder="••••••••"
              className="w-full px-4 py-2.5 rounded-xl bg-noir-950 border border-white/10 text-white text-sm focus:border-cyan/50 focus:outline-none" />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button onClick={connect} disabled={busy || !url.trim()}
            className="w-full py-3 rounded-xl bg-cyan text-noir-950 font-bold tracking-widest text-xs uppercase shadow-[0_0_30px_rgba(0,212,255,0.35)] hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-40">
            {busy ? 'Connecting…' : 'Connect to Archivist'}
          </button>
        </div>
        <p className="text-center text-[10px] font-mono text-white/20 mt-6 uppercase tracking-widest">Archivist manages the archive. Player experiences it.</p>
      </div>
    </div>
  )
}
