import { DashboardMediaTypeDropdown, type DashboardMediaTypeOption } from '../modules/home/DashboardMediaTypeDropdown.js'

export type LibraryStatusFilter = 'all' | 'collected' | 'missing' | 'acquiring'
export type AiringStatusFilter = 'all' | 'continuing' | 'upcoming' | 'ended'

function StatusDropdown<T extends string>({
  value,
  onChange,
  options,
  menuLabel,
}: {
  value: T
  onChange: (value: T) => void
  options: DashboardMediaTypeOption[]
  menuLabel: string
}) {
  return (
    <DashboardMediaTypeDropdown
      options={options}
      selected={new Set([value])}
      onChange={next => {
        const selected = next.values().next().value
        if (selected) onChange(selected as T)
      }}
      multiple={false}
      menuLabel={menuLabel}
    />
  )
}

export function LibraryStatusDropdown({
  value,
  onChange,
  accentColor,
}: {
  value: LibraryStatusFilter
  onChange: (value: LibraryStatusFilter) => void
  accentColor: string
}) {
  const options: DashboardMediaTypeOption[] = [
    { value: 'all', label: 'All', icon: '◉', color: accentColor },
    { value: 'collected', label: 'Collected', icon: '✓', color: accentColor },
    { value: 'missing', label: 'Missing', icon: '○', color: accentColor },
    { value: 'acquiring', label: 'Acquiring', icon: '↓', color: accentColor },
  ]
  return <StatusDropdown value={value} onChange={onChange} options={options} menuLabel="Library Status" />
}

export function AiringStatusDropdown({
  value,
  onChange,
  accentColor,
}: {
  value: AiringStatusFilter
  onChange: (value: AiringStatusFilter) => void
  accentColor: string
}) {
  const options: DashboardMediaTypeOption[] = [
    { value: 'all', label: 'All', icon: '◉', color: accentColor },
    { value: 'continuing', label: 'Continuing', icon: '↻', color: accentColor },
    { value: 'upcoming', label: 'Upcoming', icon: '◷', color: accentColor },
    { value: 'ended', label: 'Ended', icon: '■', color: accentColor },
  ]
  return <StatusDropdown value={value} onChange={onChange} options={options} menuLabel="Airing Status" />
}
