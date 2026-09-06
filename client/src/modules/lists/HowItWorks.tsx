import { useEffect, useState } from 'react'
import { HowItWorks, HowItWorksStats, type HowItWorksContent } from '../../components/HowItWorks.js'
import { listsApi, type ArchivistList } from '../../lib/lists.api.js'
import { useTabs } from '../../lib/tab-context.js'

const CONTENT: HowItWorksContent = {
  title: 'How Lists work',
  accent: '#00D4FF',
  lede: 'A List is a standing search. You describe the collection once in rules; Archivist turns those rules into a provider query, re-runs it on a schedule, and holds anything new for your approval. Nothing is downloaded without you saying yes.',
  steps: [
    { title: 'Rules', body: 'You describe the collection — genre, year, rating, runtime, language, certification, keyword, a specific person, a studio, a Series network, a streaming service, or named titles. Genre, studio and network values are selected from provider-backed autocomplete results rather than guessed text. Each rule combines its own values with And / Or; the list combinator then joins the rules together.' },
    { title: 'Compile', body: 'The rules are stored provider-neutrally, then compiled into a single TMDB Discover query. Anything the provider cannot express is rejected up front with a reason, rather than quietly ignored — so a saved List always means what it says.' },
    { title: 'Preview', body: 'While you edit, the query runs against TMDB and returns a live match count and poster sample. Results are cached briefly, so tweaking a rule does not hammer the provider.' },
    { title: 'Refresh & review', body: 'Once saved, the List re-runs on its own schedule. Titles it has never seen arrive as “new” in the review queue; titles that no longer match are marked “departed” instead of vanishing. Approving one adds it to the library with the quality you choose.' },
  ],
  levers: {
    note: 'Everything here lives in the List builder, on the New List or Edit screen.',
    items: [
      { label: 'Between rules — All rules / Any rule', what: 'How separate rules combine. “All rules” means a title must satisfy every rule; “Any rule” means one is enough.', effect: 'The provider only supports Any between rules of the same type, so a mixed “Any” set is rejected in preview rather than silently narrowed.' },
      { label: 'And / Or inside a rule', what: 'How the several values of one rule combine — three studios, two genres, a pair of actors.', effect: 'Or matches a title carrying just one of the values; And requires all of them. This is the right tool for “any of these studios” while the rest of the List still uses All rules.' },
      { label: 'Person role', what: 'Which credit counts: starring, any cast, director, writer, composer and so on.', effect: 'Exact roles are verified against the credits, so a director rule will not match a title where that person only produced.' },
      { label: 'Genre, studio & network pickers', what: 'Stable provider values selected from autocomplete results.', effect: 'Film and Series genres use their own TMDB vocabularies. Network is Series-only and stores the TMDB network ID; entering an exact network ID is also supported when the provider directory cannot discover a niche network by name.' },
      { label: 'Member limit', what: 'The most titles this List is allowed to hold.', effect: 'Defaults to 500 and caps at 10,000. When the filter matches more, preview warns you and the List keeps the earliest releases up to the cap.' },
      { label: 'Refresh', what: 'How often the List re-runs against the provider.', effect: 'Every 6 or 12 hours, daily, or weekly. Refresh Now on the List page runs it immediately without changing the schedule.' },
      { label: 'Root folder & quality profile', what: 'Where approved titles are filed and at what quality.', effect: 'Left blank, each approval falls back to the library default. Approving from the queue also lets you set quality for that batch.' },
      { label: 'Monitor approved titles', what: 'Whether titles added from this List are monitored for acquisition afterwards.', effect: 'Off means the title is catalogued but Archivist will not chase releases for it.' },
      { label: 'Run safety cap', what: 'The most titles a single automated run may add on its own.', effect: 'Reserved for auto-add, which is not enabled yet — every List runs in approval mode today, so nothing is added without a click.' },
      { label: 'Show in Player', what: 'Publishes the List to the Player as a box set, with its own artwork and overview.', effect: 'The set holds only the titles this List matched that you already hold — pending matches are not playable, so they are left out. Pausing the List, or turning this off, withdraws the set without touching its history.' },
    ],
  },
  cards: {
    title: 'What each queue status means',
    items: [
      { title: 'New', body: 'Matched by the filter and waiting for you. This is the review queue.' },
      { title: 'Added', body: 'You approved it and Archivist created the library entry.' },
      { title: 'In library', body: 'Already in this library when the List found it, so there was nothing to add.' },
      { title: 'Dismissed', body: 'You said no. It stays on record so the same title is not offered again.' },
      { title: 'Departed', body: 'It used to match and no longer does — a rating slipped, a provider dropped it, or the rules changed. Nothing is deleted.' },
      { title: 'Failed', body: 'The add attempt errored. The reason is shown on the card and you can retry it.' },
    ],
  },
  glossary: [
    { term: 'Rule', body: 'One condition — a genre, a year range, a studio. Rules are the building blocks; a List is the set of them plus the combinator.' },
    { term: 'Combinator', body: 'And / Or. There are now two: one between rules, and one inside each rule for its own values.' },
    { term: 'Preview', body: 'A read-only dry run of the current rules. It never adds anything and never writes to the review queue.' },
    { term: 'Member', body: 'A title the List currently matches. Member count is what the filter finds; the review queue is what still needs a decision.' },
    { term: 'Member cap', body: 'Your ceiling on member count. The provider also has a hard ceiling of 10,000 titles per query — past that you are asked to narrow the filter.' },
    { term: 'Run', body: 'One execution of the List. Run history records how many titles were fetched, how many were new, how many departed and whether the cap was hit.' },
    { term: 'Approval mode', body: 'The only mode today: matches wait for you. Auto-add stays locked until the duplicate, quota and failure guardrails are proven.' },
  ],
  safety: {
    items: [
      'A List never deletes anything. Departed only means the filter stopped matching.',
      'Specific-title inclusion has to be used on its own — mixing named titles with broad discovery rules is rejected, though title exclusions work alongside anything.',
      'Editing rules does not re-litigate past decisions: titles you already dismissed stay dismissed.',
      'Lists are scoped to one library. The selector at the top of the page decides which library you are working in.',
    ],
  },
}

export function ListsHowItWorks() {
  const { activeTab } = useTabs()
  const tabId = activeTab?.id
  const [lists, setLists] = useState<ArchivistList[] | null>(null)
  const [compiler, setCompiler] = useState<string>('—')

  useEffect(() => {
    if (tabId) listsApi.list(tabId).then(result => setLists(result.lists)).catch(() => setLists([]))
    listsApi.capabilities().then(value => setCompiler(value.compiler)).catch(() => {})
  }, [tabId])

  const pending = (lists ?? []).reduce((sum, list) => sum + (list.pendingCount ?? 0), 0)
  const members = (lists ?? []).reduce((sum, list) => sum + (list.memberCount ?? 0), 0)
  const paused = (lists ?? []).filter(list => !list.enabled).length

  return (
    <HowItWorks content={CONTENT}>
      <HowItWorksStats tiles={[
        { label: 'Lists here', value: lists ? String(lists.length) : '…', hint: paused ? `${paused} paused` : 'All running' },
        { label: 'Awaiting review', value: lists ? String(pending) : '…', hint: 'Nothing is added without approval' },
        { label: 'Titles matched', value: lists ? members.toLocaleString() : '…', hint: 'Across every List in this library' },
        { label: 'Query compiler', value: compiler, hint: 'Rules are stored provider-neutrally' },
      ]} />
    </HowItWorks>
  )
}
