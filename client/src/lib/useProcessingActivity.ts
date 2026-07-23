import { useEffect, useState } from 'react'
import { sharedApi, type ProcessingActivityNode } from './shared.api.js'

export type NodeProgress = Partial<Record<ProcessingActivityNode, number>>

export interface ProcessingActivityLookup {
  /** film id → live per-node progress (0..1) */
  film: Map<number, NodeProgress>
  /** series id → live per-node progress (0..1), rolled up from its episodes */
  series: Map<number, NodeProgress>
}

const EMPTY: ProcessingActivityLookup = { film: new Map(), series: new Map() }

/**
 * Polls the per-item processing feed so a library grid can draw live completion
 * rings on the cards whose files are being processed. Series progress is the
 * average across that series' currently-active episode/season jobs. Returns
 * empty maps while disabled or before the first response.
 */
export function useProcessingActivity(enabled = true, intervalMs = 1500): ProcessingActivityLookup {
  const [lookup, setLookup] = useState<ProcessingActivityLookup>(EMPTY)

  useEffect(() => {
    if (!enabled) { setLookup(EMPTY); return }
    let alive = true
    // Only re-render when the activity actually changes, so a mostly-idle grid
    // isn't re-rendered on every poll.
    let lastSignature = ''

    const tick = async () => {
      try {
        const { items } = await sharedApi.system.processingActivity()
        if (!alive) return
        const signature = items
          .map(item => `${item.mediaType}:${item.mediaId}:${item.node}:${item.progress.toFixed(3)}`)
          .sort()
          .join('|')
        if (signature === lastSignature) return
        lastSignature = signature
        // Accumulate per (scope,id,node) so multiple concurrent episode jobs of a
        // series average into a single ring rather than fighting over it.
        const filmAcc = new Map<number, Partial<Record<ProcessingActivityNode, number[]>>>()
        const seriesAcc = new Map<number, Partial<Record<ProcessingActivityNode, number[]>>>()
        const push = (acc: Map<number, Partial<Record<ProcessingActivityNode, number[]>>>, id: number, node: ProcessingActivityNode, progress: number) => {
          const entry = acc.get(id) ?? {}
          ;(entry[node] ??= []).push(progress)
          acc.set(id, entry)
        }
        for (const item of items) {
          if (item.mediaType === 'film') push(filmAcc, item.mediaId, item.node, item.progress)
          else if (item.mediaType === 'series') push(seriesAcc, item.mediaId, item.node, item.progress)
          else if (item.mediaType === 'episode' && item.seriesId != null) push(seriesAcc, item.seriesId, item.node, item.progress)
        }
        const average = (acc: Map<number, Partial<Record<ProcessingActivityNode, number[]>>>): Map<number, NodeProgress> => {
          const out = new Map<number, NodeProgress>()
          for (const [id, nodes] of acc) {
            const progress: NodeProgress = {}
            for (const key of Object.keys(nodes) as ProcessingActivityNode[]) {
              const values = nodes[key]!
              progress[key] = values.reduce((sum, value) => sum + value, 0) / values.length
            }
            out.set(id, progress)
          }
          return out
        }
        setLookup({ film: average(filmAcc), series: average(seriesAcc) })
      } catch {
        /* transient — keep the last good lookup */
      }
    }

    tick()
    const id = setInterval(tick, intervalMs)
    return () => { alive = false; clearInterval(id) }
  }, [enabled, intervalMs])

  return lookup
}
