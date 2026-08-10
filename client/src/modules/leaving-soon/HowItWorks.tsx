import { useEffect, useState } from 'react'
import { HowItWorks, HowItWorksStats, type HowItWorksContent } from '../../components/HowItWorks.js'
import { leavingSoonApi, type SweepSettings } from '../../lib/leaving-soon.api.js'

const POLICY_ROUTE = '/leaving-soon/policy'

const content = (settings: SweepSettings | null): HowItWorksContent => {
  const grace = settings?.graceDays ?? 30
  const warnings = settings?.warningDays?.length ? settings.warningDays.join(', ') : '14, 7, 3, 1'
  const interval = settings?.cleanupIntervalHours ?? 1
  const thresholds = settings?.diskUsageThresholds?.length
    ? settings.diskUsageThresholds.map(row => `${row.usagePercent}% → ${row.maxGraceDays}d`).join(' · ')
    : '75% → 14d · 85% → 7d · 90% → 3d'
  const tv = settings?.tvCleanupMode === 'keep_episodes' ? `keeping the first ${settings.keepCount} episode${settings.keepCount === 1 ? '' : 's'}`
    : settings?.tvCleanupMode === 'keep_seasons' ? `keeping the first ${settings.keepCount} season${settings.keepCount === 1 ? '' : 's'}`
    : 'removing every episode'

  return {
    title: 'How Leaving Soon works',
    accent: '#F472B6',
    lede: 'Leaving Soon is a retention queue with a countdown. An item joins it, waits until it has actually been watched, then gets a deletion date a set number of days later. Between those two moments you are warned repeatedly, and one click keeps it forever.',
    steps: [
      { title: 'Select', body: 'An item joins the queue either because you added it — a film edition, a whole series, a season or a single episode — or because automatic selection is on and the item cleared every age, size and recency threshold.' },
      { title: 'Arm', body: 'A selected item sits “armed” and nothing happens. It is only watching it to completion that starts the clock: a film edition when it is finished, a series or season when every available episode is complete for one profile.' },
      { title: 'Schedule', body: `Once watched, a deletion date is set — the completion time plus the grace period, currently ${grace} days. Warnings go out at ${warnings} days remaining, and while tagging is on the item is also marked in its NFO so other tools can see what is leaving.` },
      { title: 'Sweep', body: `A sweep runs about every ${interval} hour${interval === 1 ? '' : 's'}, deletes what is due, and reclaims the space. Protections are re-checked at the moment of deletion, not when the item was scheduled — so a late Keep, a new tag or a channel booking still saves it.` },
    ],
    levers: {
      note: 'These live on the Retention Policy tab, and every one of them can be overridden per library.',
      items: [
        { label: 'Leaving Soon enabled', what: 'The master switch for selection, scheduling and deletion.', effect: settings?.enabled ? 'On — the queue advances and due items are deleted on schedule.' : 'Off — nothing is scheduled and nothing is deleted, whatever the queue shows.', where: 'Retention Policy', to: POLICY_ROUTE },
        { label: 'Dry run', what: 'Runs the whole pipeline but never touches a file.', effect: settings?.dryRun ? 'On — sweeps report what they would delete and how much space it would reclaim, then stop.' : 'Off — sweeps delete for real. Turn dry run on for a cycle if you are changing thresholds.', where: 'Retention Policy', to: POLICY_ROUTE },
        { label: 'Grace period', what: 'How long a watched item survives before deletion.', effect: `Currently ${grace} days from the moment it was finished. The queue shows the exact date for every scheduled item.`, where: 'Retention Policy', to: POLICY_ROUTE },
        { label: 'Disk-usage thresholds', what: 'Shortens the grace period as the disk fills up, measured on the library’s own root folders.', effect: `Currently ${thresholds}. The tighter of the two — your grace period or the threshold — always wins.`, where: 'Retention Policy', to: POLICY_ROUTE },
        { label: 'Automatic selection', what: 'Lets Archivist put items into the queue for you instead of you arming each one.', effect: settings?.autoEligibilityEnabled
            ? `On — a title must be at least ${settings.contentAgeDays} days past release, in the library ${settings.protectionPeriodDays} days, unwatched for ${settings.lastWatchedDays} days and over ${settings.minimumSizeGb} GB before it is eligible.`
            : 'Off — only items you arm yourself enter the queue.', where: 'Retention Policy', to: POLICY_ROUTE },
        { label: 'Exclusion tags', what: 'Tags that make an item untouchable.', effect: `Any item whose NFO carries one of these tags is skipped at deletion time. Currently: ${settings?.excludeTags?.length ? settings.excludeTags.join(', ') : 'Keep, Favourite, Ongoing'}.`, where: 'Retention Policy', to: POLICY_ROUTE },
        { label: 'Protect channel items', what: 'Shields anything currently booked into an Archivist Channel guide.', effect: settings?.protectChannelItems ? 'On — a scheduled slot in any channel blocks deletion until the booking has passed.' : 'Off — channel bookings do not protect an item.', where: 'Retention Policy', to: POLICY_ROUTE },
        { label: 'TV retention', what: 'How much of a series is removed when a series-level item sweeps.', effect: `Currently ${tv}${settings?.protectSpecials === false ? '' : ', with specials protected'}. If the policy ends up protecting every remaining file, the sweep is skipped rather than half-done.`, where: 'Retention Policy', to: POLICY_ROUTE },
        { label: 'Keep approval / manual review', what: 'Adds a human gate — either to a viewer’s Keep request, or before any deletion.', effect: `${settings?.requireKeepApproval ? 'Keep requests need approval' : 'Keep is immediate for anyone who asks'}; ${settings?.manualReviewRequired ? 'every due item also waits for a final review before it is deleted.' : 'due items delete without a final review.'}`, where: 'Retention Policy', to: POLICY_ROUTE },
        { label: 'Warnings & notifications', what: 'When and where you are told an item is about to go.', effect: `In-app notices at ${warnings} days remaining, plus optional ntfy, email-webhook and web-push delivery. Each warning is sent once per item.`, where: 'Retention Policy', to: POLICY_ROUTE },
      ],
    },
    cards: {
      title: 'What each status means',
      items: [
        { title: 'Armed', body: 'In the queue, waiting to be watched. No deletion date exists yet and nothing will happen if you never watch it.' },
        { title: 'Scheduled', body: 'Watched, with a date on the calendar. This is the state where the countdown and warnings run.' },
        { title: 'Deleting', body: 'A sweep is working on it right now — files first, then the database entry.' },
        { title: 'Deleted', body: 'The media files are gone and the entry is marked uncollected. The catalogue record and its metadata stay.' },
        { title: 'Failed', body: 'Something went wrong — a missing file, a permissions problem. The reason is shown on the row and nothing further is attempted until you look.' },
        { title: 'Cancelled', body: 'You chose Keep. The item leaves the queue and is excluded from automatic selection from then on.' },
      ],
    },
    glossary: [
      { term: 'Sweep', body: 'One pass of the deletion job: evaluate candidates, refresh the queue, send warnings, delete what is due.' },
      { term: 'Grace period', body: 'The gap between finishing something and losing it. Measured from completion, not from when it was added to the queue.' },
      { term: 'Keep', body: 'Cancels the countdown permanently and excludes the item from future automatic selection. You can always re-arm it by hand.' },
      { term: 'Keep request', body: 'When approval is required, a viewer asks rather than decides, and the request waits on the admin queue.' },
      { term: 'Protected', body: 'Due for deletion but skipped this pass — an exclusion tag, a channel booking, or a TV retention rule got in the way. It is re-checked next sweep.' },
      { term: 'Ineligible', body: 'Deliberately out of scope. Choosing Keep marks an item ineligible so automatic selection does not pick it up again.' },
      { term: 'Reclaimed', body: 'Bytes actually freed by completed sweeps. Pending bytes are what the currently scheduled queue would free.' },
      { term: 'Dry run', body: 'A rehearsal. Everything is evaluated and reported; no file is touched and no database row is cleared.' },
    ],
    safety: {
      items: [
        'Nothing is ever deleted before it has been watched to completion — an unwatched item can sit armed indefinitely.',
        'Protections are evaluated at deletion time, so a Keep or a new exclusion tag applied on the final day still works.',
        'Deleting media does not delete the catalogue entry: the film or episode remains, marked uncollected, and can be re-acquired.',
        'Only files inside a known library root are removed, and an emptied folder is only cleaned up when it is safely inside that root.',
        'Sweep now on a row bypasses the countdown but still honours every protection and the dry-run setting.',
      ],
    },
  }
}

export function LeavingSoonHowItWorks() {
  const [settings, setSettings] = useState<SweepSettings | null>(null)
  const [report, setReport] = useState<any>(null)

  useEffect(() => {
    leavingSoonApi.getSettings().then(setSettings).catch(() => {})
    leavingSoonApi.report().then(setReport).catch(() => {})
  }, [])

  const gb = (bytes: number) => `${(Number(bytes || 0) / 1024 ** 3).toFixed(1)} GB`

  return (
    <HowItWorks content={content(settings)}>
      <HowItWorksStats tiles={[
        { label: 'Engine', value: !settings ? '…' : settings.enabled ? (settings.dryRun ? 'Dry run' : 'Running') : 'Off', hint: settings ? `Sweeps every ${settings.cleanupIntervalHours}h · ${settings.graceDays}-day grace` : undefined },
        { label: 'Scheduled', value: report ? String(report.counts?.scheduled ?? 0) : '…', hint: report ? `${report.counts?.armed ?? 0} armed, waiting to be watched` : undefined },
        { label: 'Space pending', value: report ? gb(report.pendingBytes) : '…', hint: 'What the current queue would free' },
        { label: 'Reclaimed', value: report ? gb(report.bytesReclaimed) : '…', hint: report ? `${report.deleted ?? 0} swept · ${report.failed ?? 0} failed` : undefined },
      ]} />
    </HowItWorks>
  )
}
