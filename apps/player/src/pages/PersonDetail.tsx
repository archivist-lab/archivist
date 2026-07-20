import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { PlayerPersonDetail } from '@archivist/contracts'
import type { ArchivistSdk } from '../lib/sdk.js'
import { DetailSection, RecommendationRow } from '../components/DetailSurface.js'

export function PersonDetailPage({ sdk }: { sdk: ArchivistSdk }) {
  const { id } = useParams<{ id: string }>()
  const [person, setPerson] = useState<PlayerPersonDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { sdk.person(id ?? '').then(setPerson).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))) }, [sdk, id])
  if (error) return <p role="alert" className="player-safe text-pink">{error}</p>
  if (!person) return <div className="player-safe player-skeleton">Opening person</div>
  return <div data-route-scroll className="motion-fade h-full overflow-y-auto no-scrollbar pb-20">
    <header className="player-safe flex min-h-[46vh] items-end gap-10 bg-gradient-to-br from-white/8 to-transparent">
      {person.profileUrl && <img src={sdk.asset(person.profileUrl)} alt="" className="w-[clamp(180px,16vw,300px)] rounded-3xl shadow-2xl ring-1 ring-white/15" />}
      <div className="max-w-3xl pb-5"><p className="text-xs uppercase tracking-[.24em] player-accent">Person</p><h1 className="mt-3 text-6xl font-semibold tracking-tight">{person.name}</h1>{person.biography && <p className="mt-6 leading-relaxed text-white/58">{person.biography}</p>}</div>
    </header>
    <DetailSection title="Known for" subtitle={`${person.credits.length} titles in your library`}><RecommendationRow sdk={sdk} items={person.credits} /></DetailSection>
  </div>
}
