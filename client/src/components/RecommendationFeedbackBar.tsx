import type { RecommendationFeedback } from '../lib/recommendations.api.js'

export function RecommendationFeedbackBar({ disabled, onFeedback }: { disabled: boolean; onFeedback: (feedback: RecommendationFeedback) => void }) {
  const actions: Array<[RecommendationFeedback, string]> = [
    ['more_like_this', 'More Like This'],
    ['less_like_this', 'Less Like This'],
    ['not_interested', 'Not Interested'],
    ['already_seen', 'Already Seen'],
  ]
  return <div className="mr-auto flex flex-wrap items-center gap-2" title={disabled ? 'Choose a profile to record personal feedback' : undefined}>
    {actions.map(([value, label]) => <button key={value} disabled={disabled} onClick={() => onFeedback(value)} className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-[9px] font-bold uppercase tracking-widest text-white/45 hover:text-white hover:bg-white/10 disabled:opacity-25 disabled:pointer-events-none transition-all">{label}</button>)}
  </div>
}
