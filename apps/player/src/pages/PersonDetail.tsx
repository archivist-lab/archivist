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
    <header className="relative mx-auto grid min-h-[46vh] w-full max-w-[1600px] grid-cols-12 items-center gap-10 px-[var(--safe-x)] py-12">
      {person.profileUrl && <img src={sdk.asset(person.profileUrl)} alt="" className="col-span-3 aspect-square w-full max-w-[280px] rounded-3xl object-cover opacity-85 shadow-2xl ring-1 ring-white/10" />}
      <div className="col-span-9 max-w-3xl"><p className="archivist-section-label player-accent">Person</p><h1 className="archivist-page-title mt-4">{person.name}</h1>{person.biography && <p className="mt-6 text-[12.5px] leading-[1.75] text-white/58">{person.biography}</p>}</div>
    </header>
    <DetailSection title="Known for" subtitle={`${person.credits.length} titles in your library`}><RecommendationRow sdk={sdk} items={person.credits} /></DetailSection>
  </div>
}
