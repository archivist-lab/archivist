import { DashboardMediaTypeDropdown } from '../modules/home/DashboardMediaTypeDropdown.js'

export type TierFilter = 'all' | '1' | '2' | '3' | '0'

/**
 * Narrows a library page to the quality tiers its items have reached.
 *
 * Tier 1 is the best; 0 is a file whose release group matched none of the
 * configured tiers. Multi-select, because "Tier 1 or 2" is the question people
 * actually ask, and filtered on the server so paging stays correct.
 */
export function TierFilterDropdown({ values, onChange, accentColor, mediaLabel }: {
  values: Set<TierFilter>
  onChange: (next: Set<TierFilter>) => void
  accentColor: string
  /** Names what a tier belongs to, since a series takes its episodes'. */
  mediaLabel?: string
}) {
  const options = [
    { value: 'all', label: 'All tiers', icon: 'quality-bars', color: accentColor },
    { value: '1', label: 'Tier 1', icon: 'quality-bars', color: accentColor },
    { value: '2', label: 'Tier 2', icon: 'quality-bars', color: accentColor },
    { value: '3', label: 'Tier 3', icon: 'quality-bars', color: accentColor },
    { value: '0', label: 'Untiered', icon: 'quality-bars', color: accentColor },
  ]

  return (
    <DashboardMediaTypeDropdown
      options={options}
      selected={values as Set<string>}
      onChange={next => {
        const chosen = [...next] as TierFilter[]
        // Choosing a tier drops "all", and clearing the last one brings it back
        // — an empty selection would otherwise read as "show nothing".
        const withoutAll = chosen.filter(value => value !== 'all')
        const wasAll = values.has('all')
        onChange(new Set<TierFilter>(
          chosen.includes('all') && !wasAll ? ['all']
          : withoutAll.length === 0 ? ['all']
          : withoutAll,
        ))
      }}
      multiple
      menuLabel={mediaLabel ? `Filter by tier (${mediaLabel})` : 'Filter by tier'}
      selectionNoun="Tiers"
    />
  )
}
