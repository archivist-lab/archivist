import { ReactNode, useState } from 'react'

// ... existing code ...

export function MissingSearchModal({ 
  onClose, 
  onStart, 
  mediaType 
}: { 
  onClose: () => void; 
  onStart: (overrides: any) => void;
  mediaType: string;
}) {
  const [tier, setTier] = useState<string>('any')
  const [resolution, setResolution] = useState<string>('any')
  const [source, setSource] = useState<string>('any')
  const [codec, setCodec] = useState<string>('any')
  const [manualFilters, setManualFilters] = useState(true)

  const isVideo = mediaType === 'films' || mediaType === 'series'

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 animate-fade-in backdrop-blur-sm">
      <div className="bg-noir-900 border border-white/10 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-slide-up">
        <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
          <div>
            <h2 className="font-display text-xl tracking-widest text-white uppercase">Missing Search</h2>
            <p className="text-[10px] font-mono text-white/30 uppercase mt-0.5 tracking-tighter">Targeted Library Search (batch size set in Acquisition settings)</p>
          </div>
          <button onClick={onClose} className="text-white/20 hover:text-white transition-colors">✕</button>
        </div>
        
        <div className="p-6 space-y-5">
          <div className="space-y-2">
            <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Indexer Tier</label>
            <div className="flex gap-1.5 p-1 bg-black/40 rounded-xl border border-white/5">
              {['any', '1', '2', '3'].map(t => (
                <button 
                  key={t}
                  onClick={() => setTier(t)}
                  className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all ${
                    tier === t ? 'bg-white/10 text-[#00D4FF]' : 'text-white/20 hover:text-white/40'
                  }`}
                >
                  {t === 'any' ? 'Any' : `Tier ${t}`}
                </button>
              ))}
            </div>
          </div>

          {isVideo && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Resolution</label>
                  <select 
                    value={resolution} 
                    onChange={e => setResolution(e.target.value)}
                    className="w-full bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/60 outline-none focus:border-white/20 transition-all"
                  >
                    <option value="any">Any Resolution</option>
                    <option value="2160p">2160p (4K)</option>
                    <option value="1080p">1080p</option>
                    <option value="720p">720p</option>
                    <option value="SD">SD</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Source</label>
                  <select 
                    value={source} 
                    onChange={e => setSource(e.target.value)}
                    className="w-full bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/60 outline-none focus:border-white/20 transition-all"
                  >
                    <option value="any">Any Source</option>
                    <option value="REMUX">REMUX</option>
                    <option value="BluRay">BluRay</option>
                    <option value="WEB">WEB-DL / WebRip</option>
                    <option value="HDTV">HDTV</option>
                    <option value="DVD">DVD</option>
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-mono text-white/40 uppercase tracking-widest block">Codec</label>
                <select 
                  value={codec} 
                  onChange={e => setCodec(e.target.value)}
                  className="w-full bg-black/40 border border-white/5 rounded-xl px-3 py-2 text-xs text-white/60 outline-none focus:border-white/20 transition-all"
                >
                  <option value="any">Any Codec</option>
                  <option value="AV1">AV1</option>
                  <option value="x265">x265 / HEVC</option>
                  <option value="x264">x264 / AVC</option>
                </select>
              </div>

              <label className="flex items-center gap-3 cursor-pointer group py-1">
                <input 
                  type="checkbox" 
                  checked={manualFilters} 
                  onChange={e => setManualFilters(e.target.checked)}
                  className="w-4 h-4 rounded accent-[#00D4FF] bg-black/40 border-white/10"
                />
                <span className="text-[11px] font-mono text-white/40 group-hover:text-white/60 transition-colors uppercase tracking-tight">
                  Enforce strictly (reject non-matches)
                </span>
              </label>
            </>
          )}
        </div>

        <div className="px-6 pb-6 pt-2 flex gap-3">
          <button 
            onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-white/5 text-white/40 text-[10px] font-bold uppercase tracking-widest hover:bg-white/10 transition-all"
          >
            Cancel
          </button>
          <button 
            onClick={() => onStart({
              targetTier: tier === 'any' ? null : parseInt(tier, 10),
              targetResolution: resolution === 'any' ? null : resolution,
              targetSource: source === 'any' ? null : source,
              targetCodec: codec === 'any' ? null : codec,
              manualFilters: isVideo ? manualFilters : false
            })}
            className="flex-[2] py-3 rounded-xl bg-[#00D4FF]/10 border border-[#00D4FF]/30 text-[#00D4FF] text-[10px] font-bold uppercase tracking-widest hover:bg-[#00D4FF]/20 transition-all shadow-lg shadow-[#00D4FF]/5"
          >
            Start Search
          </button>
        </div>
      </div>
    </div>
  )
}
