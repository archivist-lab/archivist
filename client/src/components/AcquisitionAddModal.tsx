import { useEffect, useMemo, useState } from 'react'
import { sharedApi } from '../lib/shared.api.js'
import { useTabs } from '../lib/tab-context.js'
import { Modal, TabSelect } from './ui.js'

export type AcquisitionPreferences = {
  tier: string
  resolution: string
  source: string
  codec: string
  tabId: number
}

export function AcquisitionAddModal({ title, mediaType, accentColor, onClose, onConfirm, isAdding }: {
  title: string
  mediaType: 'films' | 'series'
  accentColor: string
  onClose: () => void
  onConfirm: (preferences: AcquisitionPreferences) => void
  isAdding: boolean
}) {
  const { tabs, activeTabId } = useTabs()
  const targetTabs = useMemo(
    () => (Array.isArray(tabs) ? tabs : []).filter(tab => tab.media_type === mediaType),
    [tabs, mediaType],
  )
  const [tier, setTier] = useState('Any')
  const [resolution, setResolution] = useState('Any')
  const [source, setSource] = useState('Any')
  const [codec, setCodec] = useState('Any')
  const [targetTabId, setTargetTabId] = useState(0)

  useEffect(() => {
    if (activeTabId && targetTabs.some(tab => tab.id === activeTabId)) setTargetTabId(activeTabId)
    else if (targetTabs.length > 0) setTargetTabId(targetTabs[0].id)
  }, [targetTabs, activeTabId])

  useEffect(() => {
    if (!targetTabId) return
    sharedApi.settings.getAcquisitionDefaults(targetTabId).then(defaults => {
      setTier(defaults?.tier || 'Any')
      setResolution(defaults?.resolution || 'Any')
      setSource(defaults?.source || 'Any')
      setCodec(defaults?.codec || 'Any')
    }).catch(() => {})
  }, [targetTabId])

  return (
    <Modal title={`Add ${title}`} onClose={onClose}>
      <div className="space-y-6">
        {targetTabs.length > 1 && (
          <div className="p-4 rounded-xl border" style={{ backgroundColor: `${accentColor}0d`, borderColor: `${accentColor}1a` }}>
            <p className="text-[10px] font-mono uppercase tracking-widest mb-3" style={{ color: accentColor }}>Target Library Tab</p>
            <div className="flex flex-wrap gap-2">
              {targetTabs.map(tab => (
                <button key={tab.id} onClick={() => setTargetTabId(tab.id)}
                  className={`px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest transition-all border ${targetTabId === tab.id ? 'text-noir-950' : 'bg-white/5 text-white/40 border-white/5 hover:border-white/10'}`}
                  style={targetTabId === tab.id ? { backgroundColor: accentColor, borderColor: accentColor } : undefined}>
                  {tab.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="text-[10px] font-mono text-white/30 uppercase tracking-widest px-1">Acquisition Quality</p>
        <div className="grid grid-cols-1 gap-6">
          <TabSelect label="Tier" value={tier} options={['Any', 'Tier 1', 'Tier 2', 'Tier 3']} onChange={setTier} />
          <TabSelect label="Resolution" value={resolution} options={['Any', '2160p', '1080p', '720p']} onChange={setResolution} />
          <TabSelect label="Source" value={source} options={['Any', 'BluRay', 'Web', 'DVD']} onChange={setSource} />
          <TabSelect label="Codec" value={codec} options={['Any', 'Remux', 'AV1', 'x265', 'x264']} onChange={setCodec} />
        </div>

        <div className="flex justify-end pt-4 border-t border-white/5">
          <div className="flex gap-3">
            <button onClick={onClose} className="px-6 py-2.5 rounded-xl text-xs font-bold text-white/40 hover:text-white transition-all uppercase tracking-widest">Cancel</button>
            <button onClick={() => onConfirm({ tier, resolution, source, codec, tabId: targetTabId })}
              disabled={isAdding || !targetTabId}
              className="px-8 py-2.5 rounded-xl text-noir-950 font-bold text-xs uppercase tracking-widest transition-all shadow-xl disabled:opacity-50"
              style={{ backgroundColor: accentColor }}>
              {isAdding ? 'Adding...' : 'Confirm Add to Tab'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
