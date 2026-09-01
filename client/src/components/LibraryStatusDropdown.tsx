import { DashboardMediaTypeDropdown, type DashboardMediaTypeOption } from '../modules/home/DashboardMediaTypeDropdown.js'

export type LibraryStatusFilter = 'all' | 'collected' | 'missing' | 'acquiring'
export type AiringStatusFilter = 'all' | 'continuing' | 'upcoming' | 'ended'
export type ReleaseStatusFilter = 'all' | 'upcoming' | 'in_cinemas' | 'at_home'

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

function MultiStatusDropdown<T extends string>({
  values,
  onChange,
  options,
  menuLabel,
  selectionNoun,
}: {
  values: Set<T>
  onChange: (values: Set<T>) => void
  options: DashboardMediaTypeOption[]
  menuLabel: string
  selectionNoun: string
}) {
  return (
    <DashboardMediaTypeDropdown
      options={options.filter(option => option.value !== 'all')}
      selected={values}
      onChange={next => onChange(next.size > 0 ? next as Set<T> : new Set<T>(['all' as T]))}
      multiple
      allowAll
      allLabel="All"
      menuLabel={menuLabel}
      selectionNoun={selectionNoun}
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

export function MultiLibraryStatusDropdown({
  values,
  onChange,
  accentColor,
}: {
  values: Set<LibraryStatusFilter>
  onChange: (values: Set<LibraryStatusFilter>) => void
  accentColor: string
}) {
  const options: DashboardMediaTypeOption[] = [
    { value: 'collected', label: 'Collected', icon: '✓', color: accentColor },
    { value: 'missing', label: 'Missing', icon: '○', color: accentColor },
    { value: 'acquiring', label: 'Acquiring', icon: '↓', color: accentColor },
  ]
  return <MultiStatusDropdown values={values} onChange={onChange} options={options} menuLabel="Library Status" selectionNoun="Library statuses" />
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

export function ReleaseStatusDropdown({
  value,
  onChange,
  accentColor,
}: {
  value: ReleaseStatusFilter
  onChange: (value: ReleaseStatusFilter) => void
  accentColor: string
}) {
  const options: DashboardMediaTypeOption[] = [
    { value: 'all', label: 'All', icon: '◉', color: accentColor },
    { value: 'upcoming', label: 'Upcoming', icon: '◷', color: accentColor },
    { value: 'in_cinemas', label: 'In Cinemas', icon: '▷', color: accentColor },
    { value: 'at_home', label: 'At Home', icon: '⌂', color: accentColor },
  ]
  return <StatusDropdown value={value} onChange={onChange} options={options} menuLabel="Release Status" />
}

export function MultiReleaseStatusDropdown({
  values,
  onChange,
  accentColor,
}: {
  values: Set<ReleaseStatusFilter>
  onChange: (values: Set<ReleaseStatusFilter>) => void
  accentColor: string
}) {
  const options: DashboardMediaTypeOption[] = [
    { value: 'upcoming', label: 'Upcoming', icon: '◷', color: accentColor },
    { value: 'in_cinemas', label: 'In Cinemas', icon: '▷', color: accentColor },
    { value: 'at_home', label: 'At Home', icon: '⌂', color: accentColor },
  ]
  return <MultiStatusDropdown values={values} onChange={onChange} options={options} menuLabel="Release Status" selectionNoun="Release statuses" />
}
