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

interface PageHeaderProps {
  title: string
  subtitle?: string
  accentClass?: string
  tabs?: Tab[]
  /** Only needed for tab sets that are not URL-driven. */
  activeTab?: string
  onTabChange?: (id: string) => void
  children?: ReactNode
}

export function PageHeader({ title, subtitle, accentClass = 'text-white/70', tabs, activeTab, onTabChange, children }: PageHeaderProps) {
  return (
    <div className="mb-8 animate-fade-in">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className={`archivist-page-title ${accentClass}`}>{title}</h1>
          {subtitle && <p className="mt-1 max-w-3xl font-mono text-[12.5px] uppercase tracking-widest text-white/35">{subtitle}</p>}
        </div>
        {children}
      </div>

      {tabs && tabs.length > 1 && <TabBar tabs={tabs} activeTab={activeTab} onTabChange={onTabChange} />}
    </div>
  )
}

/**
 * Underlined tab strip. Rendered on its own where a section already has a
 * bespoke header but still needs the shared selector.
 */
export function TabBar({ tabs, activeTab, onTabChange }: { tabs: Tab[]; activeTab?: string; onTabChange?: (id: string) => void }) {
  const location = useLocation()
  // A routed tab is active when it owns the deepest matching path, so a parent
  // tab ("/channels") does not stay lit while a child ("/channels/guide") shows.
  const routed = tabs.filter((tab): tab is Tab & { to: string } => Boolean(tab.to))
  const bestMatch = routed
    .filter(tab => location.pathname === tab.to || location.pathname.startsWith(`${tab.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0]

  return (
    <div className="flex gap-8 overflow-x-auto no-scrollbar border-b border-white/5">
      {tabs.map(tab => {
        const active = tab.to ? bestMatch?.id === tab.id : activeTab === tab.id
        const className = `whitespace-nowrap pb-3 text-sm font-medium tracking-wide transition-all border-b-2 -mb-[2px] ${
          active ? 'text-white border-[#00D4FF]' : 'text-white/30 border-transparent hover:text-white/60'
        }`
        return tab.to
          ? <Link key={tab.id} to={tab.to} aria-current={active ? 'page' : undefined} className={className}>{tab.label}</Link>
          : <button key={tab.id} type="button" onClick={() => onTabChange?.(tab.id)} className={className}>{tab.label}</button>
      })}
    </div>
  )
}
