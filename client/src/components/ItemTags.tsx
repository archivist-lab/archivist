import { useEffect, useState } from 'react'
import { sharedApi, type AppliedTag, type Tag } from '../lib/shared.api.js'
import { toast } from '../lib/notify.js'

/**
 * The tags on one film or series.
 *
 * A tag placed by a rule is shown alongside one placed by hand, marked so the
 * difference is visible — a rule's tag comes and goes with the rule, and one
 * set here stays until it is taken off. Adding a rule-applied tag by hand
 * claims it: the sweep then leaves it alone.
 */
export function ItemTags({ type, id, accent }: { type: 'film' | 'series'; id: number; accent: string }) {
  const [applied, setApplied] = useState<AppliedTag[]>([])
  const [available, setAvailable] = useState<Tag[]>([])
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    sharedApi.settings.tagsFor(type, id).then(result => setApplied(result.tags)).catch(() => {})
  }, [type, id])

  useEffect(() => {
    if (adding) sharedApi.settings.getTags().then(result => setAvailable(result.tags)).catch(() => {})
  }, [adding])

  const add = async (tagId: number) => {
    setAdding(false)
    try { setApplied((await sharedApi.settings.addTagTo(type, id, tagId)).tags) }
    catch (err) { toast.error(String(err)) }
  }

  const remove = async (tagId: number) => {
    try { setApplied((await sharedApi.settings.removeTagFrom(type, id, tagId)).tags) }
    catch (err) { toast.error(String(err)) }
  }

  const unapplied = available.filter(tag => !applied.some(entry => entry.id === tag.id))

  return (
    <div className="flex flex-col gap-2">
      <span className="archivist-section-label">Tags</span>
      <div className="flex flex-wrap items-center gap-2">
        {applied.map(tag => (
          <span
            key={tag.id}
            title={tag.source === 'rule' ? 'Applied by a rule — it comes off if the item stops matching' : 'Applied by hand'}
            className="group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-mono uppercase tracking-widest"
            style={{ borderColor: `${tag.colour}55`, color: tag.colour, background: `${tag.colour}12` }}
          >
            {tag.source === 'rule' && <span className="opacity-50" aria-hidden>◆</span>}
            {tag.name}
            <button
              type="button"
              onClick={() => remove(tag.id)}
              aria-label={`Remove tag ${tag.name}`}
              className="opacity-0 transition-opacity group-hover:opacity-70 hover:!opacity-100"
            >×</button>
          </span>
        ))}

        {adding ? (
          <select
            ref={element => element?.focus()}
            defaultValue=""
            onBlur={() => setAdding(false)}
            onChange={event => { if (event.target.value) void add(Number(event.target.value)) }}
            className="rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[10px] font-mono uppercase tracking-widest text-white/70 outline-none"
          >
            <option value="" disabled>Choose a tag…</option>
            {unapplied.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-full border border-dashed border-white/15 px-2.5 py-1 text-[10px] font-mono uppercase tracking-widest text-white/30 transition-colors hover:text-white/70"
            style={{ borderColor: `${accent}33` }}
          >+ Tag</button>
        )}
      </div>
    </div>
  )
}
