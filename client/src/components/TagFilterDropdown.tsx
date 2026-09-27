import { useEffect, useState } from 'react'
import { sharedApi, type Tag } from '../lib/shared.api.js'
import { DashboardMediaTypeDropdown } from '../modules/home/DashboardMediaTypeDropdown.js'

/**
 * Narrows a library page to one tag.
 *
 * The options are whatever tags exist, read fresh rather than configured, so a
 * tag created in Settings is filterable straight away. Filtering happens on the
 * server — a tag holding forty of four thousand films should fetch forty.
 *
 * Renders nothing when no tags exist: an empty dropdown is a control that
 * cannot do anything, and the toolbar is better without it.
 */
export function TagFilterDropdown({ value, onChange, accentColor }: {
  value: number | null
  onChange: (tagId: number | null) => void
  accentColor: string
}) {
  const [tags, setTags] = useState<Tag[]>([])

  useEffect(() => {
    sharedApi.settings.getTags().then(result => setTags(result.tags)).catch(() => {})
  }, [])

  // A tag deleted elsewhere must not leave the page filtered by something that
  // no longer exists, with no way to see why it is empty.
  useEffect(() => {
    if (value !== null && tags.length > 0 && !tags.some(tag => tag.id === value)) onChange(null)
  }, [tags, value, onChange])

  if (tags.length === 0) return null

  const options = [
    { value: 'all', label: 'All tags', icon: 'tag', color: accentColor },
    ...tags.map(tag => ({ value: String(tag.id), label: `${tag.name} (${tag.items})`, icon: 'tag', color: tag.colour })),
  ]

  return (
    <DashboardMediaTypeDropdown
      options={options}
      selected={new Set([value === null ? 'all' : String(value)])}
      onChange={next => {
        const chosen = [...next][0]
        onChange(!chosen || chosen === 'all' ? null : Number(chosen))
      }}
      multiple={false}
      menuLabel="Filter by tag"
      selectionNoun="Tags"
    />
  )
}
