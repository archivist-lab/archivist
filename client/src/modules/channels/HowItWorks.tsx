import { useEffect, useState } from 'react'
import { HowItWorks, HowItWorksStats, type HowItWorksContent } from '../../components/HowItWorks.js'
import { channelsApi, type Channel } from '../../lib/channels.api.js'

const CONTENT: HowItWorksContent = {
  title: 'How Channels work',
  accent: '#00D4FF',
  lede: 'A Channel is your own broadcast network built from the library you already own. You programme blocks — a Saturday-night double bill, a weekday comedy hour — and Archivist fills them with real files, producing a guide you can join live, start from any slot, or dip into for one programme.',
  steps: [
    { title: 'Programme blocks', body: 'A channel is a set of blocks. Each block owns a window — which days of the week, and the start and end time — plus the rules for what belongs in it. Blocks are filled in priority order, highest first.' },
    { title: 'Gather candidates', body: 'A rule-filled block collects every playable film and, for series, only each show’s next episode — which is what makes a channel air a series in order rather than at random. A slot-programmed block instead walks an ordered stack of sources, falling through to the next when one runs dry.' },
    { title: 'Score and place', body: 'Candidates are scored — a genre match, never having aired, being newly added, and fitting the remaining time all help; airing again inside the no-repeat window is heavily penalised or rejected outright. Ties break on a per-channel seed, so regenerating an unchanged week produces the same schedule.' },
    { title: 'Generate and watch', body: 'Generation clears the unlocked future slots in the window and refills them around anything you locked. The result is the guide: pick a slot and join live, watch from there onward, or play just that one programme.' },
  ],
  levers: {
    note: 'Block rules live in the block editor, reached by expanding a channel on the Channels tab.',
    items: [
      { label: 'Days and times', what: 'The window a block owns — which weekdays, and from when to when.', effect: 'A block only ever schedules inside its own window. Time left at the end of a window is filled while at least ten minutes remain; shorter fragments are left empty rather than padded.' },
      { label: 'Priority', what: 'The order blocks are filled in.', effect: 'Highest priority is placed first. Give each block its own window: priority decides who goes first, it does not stop a lower-priority block from also programming time it overlaps.' },
      { label: 'Content types', what: 'Whether the block airs films, episodes or both.', effect: 'Episodes enter the pool one per series — the next one due — so a mixed block still airs shows sequentially.' },
      { label: 'Genres, runtime, years, libraries', what: 'The filters that define the block’s pool.', effect: 'These are hard filters — a title outside them is never scheduled — and matching a listed genre also scores a bonus that decides between eligible candidates. A named series inside a programmed slot is exempt: it airs its next episode whatever the block’s genre and runtime filters say.' },
      { label: 'Watched filter', what: 'Unwatched only, reruns only, or anything.', effect: 'Unwatched means each series continues from its first unwatched episode; the other modes rotate onward from whatever aired most recently. Watched means completed through a channel session.' },
      { label: 'No-repeat window & allow repeats', what: 'How long before something can air again.', effect: 'Defaults to seven days. Inside that window a title takes a heavy scoring penalty, or is rejected outright when repeats are disallowed.' },
      { label: 'Programmed slots', what: 'An ordered sequence of slots, each with its own fallback stack of series and film pools.', effect: 'The first source with a playable, fitting item wins; exhausted sources fall through — all of the first show watched, so the second takes over. A slot can air a fixed number of items, or fill whatever airtime is left.' },
      { label: 'Locked slots', what: 'Pins a specific programme to a specific time.', effect: 'Regeneration deletes unlocked slots only and schedules around the pinned ones, so a locked premiere survives every rebuild.' },
    ],
  },
  cards: {
    title: 'The three ways to watch',
    items: [
      { title: 'Join live', body: 'Starts the current programme at the point the schedule says it has reached — broadcast behaviour, mid-scene and all — and keeps going into what follows.' },
      { title: 'Watch from here', body: 'Starts the chosen slot from the beginning and queues everything after it on that channel, up to twenty-five programmes.' },
      { title: 'Play this only', body: 'One programme, from the start, with nothing queued behind it.' },
      { title: 'Guide', body: 'The day grid of what is scheduled. Slots without a playable file are shown but never queued for playback.' },
    ],
  },
  glossary: [
    { term: 'Block', body: 'A recurring window on a channel plus the rules for filling it — the unit you actually programme.' },
    { term: 'Slot', body: 'One scheduled programme: an item, a start time and an end time. Slots are what the guide displays.' },
    { term: 'Programmed slot', body: 'Inside a block, a position in the running order with its own ordered list of sources — the mechanism behind “this show, then that one when it runs out”.' },
    { term: 'Slate', body: 'The set of slots generated for a channel across a window, seven days at a time by default.' },
    { term: 'Source stack', body: 'The ordered fallbacks for a programmed slot. Each source is either a series, optionally limited to a range of seasons, or a pool of films.' },
    { term: 'Locked', body: 'A slot excluded from regeneration. Generation treats it as a fixed obstacle and fills around it.' },
    { term: 'Seed', body: 'The per-channel number behind tie-breaking. The same seed and the same library produce the same week, which is why regenerating is safe.' },
    { term: 'Horizon', body: 'How far ahead the guide is populated. Channels top themselves up in the background, regenerating a week whenever a channel has under two days left.' },
  ],
  safety: {
    items: [
      'Only items with a real file on disk are scheduled, and only playable slots are ever queued into a session.',
      'Generating a channel never modifies the library — it writes schedule slots and nothing else.',
      'Regeneration is destructive to unlocked future slots by design: lock anything you want to keep before you regenerate.',
      'Anything booked in a channel guide can be protected from Leaving Soon deletion, which is on by default.',
    ],
  },
}

export function ChannelsHowItWorks() {
  const [channels, setChannels] = useState<Channel[] | null>(null)
  useEffect(() => { channelsApi.list().then(data => setChannels(data.channels)).catch(() => setChannels([])) }, [])

  const active = (channels ?? []).filter(channel => channel.isActive).length
  const blocks = (channels ?? []).reduce((sum, channel) => sum + (channel.blockCount ?? 0), 0)
  const upcoming = (channels ?? []).reduce((sum, channel) => sum + (channel.upcomingSlots ?? 0), 0)

  return (
    <HowItWorks content={CONTENT}>
      <HowItWorksStats tiles={[
        { label: 'Channels', value: channels ? String(channels.length) : '…', hint: `${active} active` },
        { label: 'Blocks programmed', value: channels ? String(blocks) : '…', hint: 'Recurring windows across all channels' },
        { label: 'Upcoming slots', value: channels ? upcoming.toLocaleString() : '…', hint: 'Already on the guide' },
        { label: 'Top-up', value: 'Every 6h', hint: 'Regenerates a week when under 48h remain' },
      ]} />
    </HowItWorks>
  )
}
