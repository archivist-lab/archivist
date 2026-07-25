import { useNavigate } from 'react-router-dom'
import { DashboardMediaTypeDropdown } from '../modules/home/DashboardMediaTypeDropdown.js'
import { useTabs, librarySlug, type MediaType } from '../lib/tab-context.js'

/**
 * Library switcher for an item page, rendered only when the media type has more
 * than one library. Styled like the filter dropdowns / search bar. Films use
 * slug-based routing, so switching navigates to the new library's URL; other
 * media types just switch the active tab (their grid re-fetches on change).
 */
export function LibrarySelector({ mediaType, accentColor }: { mediaType: MediaType; accentColor: string }) {
  const { tabs, activeTabId, setActiveTabForMedia } = useTabs()
  const navigate = useNavigate()

  const libraries = (Array.isArray(tabs) ? tabs : []).filter(tab => tab.media_type === mediaType)
  if (libraries.length <= 1) return null

  const active = libraries.find(tab => tab.id === activeTabId) ?? libraries[0]
  const options = libraries.map(tab => ({ value: String(tab.id), label: tab.name, icon: '◈', color: accentColor }))

  return (
    <div className="w-52 shrink-0">
      <DashboardMediaTypeDropdown
        options={options}
        selected={new Set([String(active.id)])}
        onChange={next => {
          const id = Number([...next.values()][0])
          const library = libraries.find(tab => tab.id === id)
          if (!library || id === active.id) return
          setActiveTabForMedia(mediaType, id)
          if (mediaType === 'films') navigate(`/films/${librarySlug(library.name)}`)
        }}
        multiple={false}
        menuLabel="Library"
      />
    </div>
  )
}
