import { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'

/**
 * The single tab selector used across every section of the app. Tabs are
 * URL-addressable: each one owns a route, so a sub-page can be linked,
 * bookmarked and reached with the browser's back button.
 */
export interface Tab {
  id: string
  label: string
  /** Route this tab owns. Tabs without one fall back to `onTabChange`. */
  to?: string
}

/** Settings and every non-media section share the house cyan. */
export const DEFAULT_ACCENT = '#00D4FF'

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  accentClass?: string
  /** Tone for the subtitle line. Media sections colour it to match the library. */
  subtitleClass?: string
  /** Underline colour for the active tab. */
  accent?: string
  tabs?: Tab[]
  /** Only needed for tab sets that are not URL-driven. */
  activeTab?: string
  onTabChange?: (id: string) => void
  /** Rendered at the top right, beside the title. */
  children?: ReactNode
  /** Rendered at the far right of the tab strip, e.g. a selection bar. */
  tabsRight?: ReactNode
}

export function PageHeader({
  title, subtitle, accentClass = 'text-white/70', subtitleClass = 'text-white/35',
  accent = DEFAULT_ACCENT, tabs, activeTab, onTabChange, children, tabsRight,
}: PageHeaderProps) {
  return (
    <div className="mb-8 animate-fade-in">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className={`archivist-page-title ${accentClass}`}>{title}</h1>
          {subtitle && <p className={`mt-1 max-w-3xl font-mono text-[12.5px] uppercase tracking-widest ${subtitleClass}`}>{subtitle}</p>}
        </div>
        {children}
      </div>

      {tabs && tabs.length > 1 && <TabBar tabs={tabs} accent={accent} activeTab={activeTab} onTabChange={onTabChange} right={tabsRight} />}
    </div>
  )
}

/**
 * Underlined tab strip. Rendered on its own where a section already has a
 * bespoke header but still needs the shared selector.
 */
export function TabBar({ tabs, accent = DEFAULT_ACCENT, activeTab, onTabChange, right }: {
  tabs: Tab[]
  accent?: string
  activeTab?: string
  onTabChange?: (id: string) => void
  right?: ReactNode
}) {
  const location = useLocation()
  // A routed tab is active when it owns the deepest matching path, so a parent
  // tab ("/channels") does not stay lit while a child ("/channels/guide") shows.
  const routed = tabs.filter((tab): tab is Tab & { to: string } => Boolean(tab.to))
  const bestMatch = routed
    .filter(tab => location.pathname === tab.to || location.pathname.startsWith(`${tab.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0]

  return (
    <div className="flex items-end gap-8 border-b border-white/5">
      <div className="flex gap-8 overflow-x-auto no-scrollbar">
        {tabs.map(tab => {
          const active = tab.to ? bestMatch?.id === tab.id : activeTab === tab.id
          const className = `whitespace-nowrap pb-3 text-sm font-medium tracking-wide transition-all border-b-2 -mb-[2px] ${
            active ? 'text-white' : 'text-white/30 border-transparent hover:text-white/60'
          }`
          const style = active ? { borderBottomColor: accent } : undefined
          return tab.to
            ? <Link key={tab.id} to={tab.to} aria-current={active ? 'page' : undefined} className={className} style={style}>{tab.label}</Link>
            : <button key={tab.id} type="button" onClick={() => onTabChange?.(tab.id)} className={className} style={style}>{tab.label}</button>
        })}
      </div>
      {right && <div className="ml-auto pb-2">{right}</div>}
    </div>
  )
}

/**
 * Tab set shared by every media library section. The library tab owns the
 * section root — "/films/films" would only repeat the parent — matching how
 * Channels and the settings sections address their first tab.
 */
export function mediaSectionTabs({ base, library, add, edit, recommendations }: {
  /** Section root, including the library slug where one is in the URL. */
  base: string
  library: string
  add: string
  edit: string
  /** Label for the recommendations tab, omitted where the media type has none. */
  recommendations?: string
}): Tab[] {
  return [
    { id: 'library', label: library, to: base },
    ...(recommendations ? [{ id: 'recommendations', label: recommendations, to: `${base}/recommendations` }] : []),
    { id: 'add', label: add, to: `${base}/add` },
    { id: 'edit', label: edit, to: `${base}/edit` },
  ]
}
