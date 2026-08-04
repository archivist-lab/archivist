import { useEffect, useState } from 'react'
import { toast } from '../lib/notify.js'
import { leavingSoonApi, type LeavingSoonItem, type LeavingSoonTargetType } from '../lib/leaving-soon.api.js'

export function DeleteWhenWatchedToggle({ type, id, compact = false }: { type: LeavingSoonTargetType; id: number; compact?: boolean }) {
  const [item, setItem] = useState<LeavingSoonItem | null>(null)
  const [graceDays, setGraceDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  useEffect(() => { let active = true; leavingSoonApi.get(type, id).then(result => { if (active) { setItem(result.item); setGraceDays(result.settings.graceDays) } }).catch(() => {}).finally(() => { if (active) setLoading(false) }); return () => { active = false } }, [type, id])
  const enabled = !!item?.enabled
  const toggle = async (event: React.MouseEvent) => {
    event.stopPropagation()
    setSaving(true)
    try {
      const result = await leavingSoonApi.set(type, id, !enabled)
      setItem(result.item)
      setGraceDays(result.settings.graceDays)
      toast.success(!enabled ? `Sweep enabled · ${result.settings.graceDays}-day grace after watching` : 'Keep enabled · scheduled deletion cancelled')
    } catch (error) { toast.error(error) }
    finally { setSaving(false) }
  }
  const title = enabled
    ? item?.status === 'scheduled' && item.daysRemaining !== null ? `Sweep scheduled in ${item.daysRemaining} days. Click to keep.` : `Sweep after watching with a ${graceDays}-day grace period. Click to keep.`
    : 'Keep this media after watching. Click to enable Sweep.'
  return <button type="button" onClick={toggle} disabled={loading || saving} aria-pressed={enabled} title={title}
    className={`${compact ? 'w-[76px] px-3 py-2 text-[8px]' : 'w-[92px] px-4 py-2.5 text-[9px]'} inline-flex items-center justify-center gap-2 rounded-lg border font-bold uppercase tracking-[0.12em] transition-colors disabled:cursor-wait ${enabled ? 'border-red-500/25 bg-red-500/[0.07] text-red-300 hover:bg-red-500/15' : 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-300 hover:bg-emerald-500/15'}`}>
    <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${enabled ? 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,.8)]' : 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,.8)]'}`} />{enabled ? 'Sweep' : 'Keep'}
  </button>
}
