import { useState, useMemo, useEffect, useRef } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Icon, type IconName } from '@archivist/design-system'
import ArchivistLogo from '../icon.svg'
import { useTabs, librarySlug, Tab, type MediaType } from '../lib/tab-context.js'
import { useAuth } from './AuthGate.js'
import { APP_VERSION_LABEL } from '../version.js'

/** True below Tailwind's `lg` (1024px) — i.e. phones/tablets where the sidebar is a drawer. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)')
    const on = () => setMobile(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return mobile
}

interface NavItem {
  to: string
  icon: IconName
  label: string
  accent: string
  mediaType?: MediaType
  children?: NavItem[]
  /** Show only when at least one of these media types has a library. */
  requiresAny?: MediaType[]
}

const NAV: NavItem[] = [
  { to: '/',       icon: 'dashboard',    label: 'Dashboard',    accent: 'white'   },
  { to: '/acquisitions', icon: 'acquisitions', label: 'Acquisitions', accent: 'white' },
  { to: '/films',  icon: 'film',   label: 'Films',        accent: 'cyan',   mediaType: 'films'   },
  { to: '/series', icon: 'series', label: 'Series',       accent: 'violet', mediaType: 'series'  },
  { to: '/music',  icon: 'music',  label: 'Music',        accent: 'pink',   mediaType: 'music'   },
  { to: '/books',  icon: 'book',   label: 'Books',        accent: 'yellow', mediaType: 'books'   },
  { to: '/comics', icon: 'comics', label: 'Comics',       accent: 'orange', mediaType: 'comics'  },
  { to: '/games',  icon: 'games',  label: 'Games',        accent: 'green',  mediaType: 'games'   },
  {
    to: '/settings', icon: 'settings', label: 'Settings', accent: 'white',
    children: [
      { to: '/lists', icon: 'lists', label: 'Lists', accent: 'white', requiresAny: ['films', 'series'] },
      { to: '/settings/recommendations', icon: 'sparkle', label: 'Recommendations', accent: 'white' },
      { to: '/collections', icon: 'collections', label: 'Collections', accent: 'white' },
      { to: '/leaving-soon', icon: 'leaving-soon', label: 'Leaving Soon', accent: 'white', requiresAny: ['films', 'series'] },
      { to: '/channels', icon: 'channels', label: 'Channels', accent: 'white', requiresAny: ['films', 'series'] },
      { to: '/settings/libraries', icon: 'libraries', label: 'Libraries', accent: 'white' },
      { to: '/settings/downloads', icon: 'download', label: 'Downloads', accent: 'white' },
      { to: '/settings/definitions', icon: 'definitions', label: 'Definitions', accent: 'white' },
      { to: '/settings/processing', icon: 'processing', label: 'Processing', accent: 'white' },
      { to: '/settings/player', icon: 'play', label: 'Player', accent: 'white' },
      { to: '/settings/system', icon: 'system', label: 'System', accent: 'white' },
    ],
  },
]

const ACTIVE: Record<string, string> = {
  cyan:   'bg-cyan/10 text-cyan border border-cyan/60 shadow-[0_0_15px_rgba(0,212,255,0.1)]',
  violet: 'bg-violet/10 text-violet border border-violet/60 shadow-[0_0_15px_rgba(155,89,182,0.1)]',
  pink:   'bg-pink/10 text-pink border border-pink/60 shadow-[0_0_15px_rgba(255,45,120,0.1)]',
  yellow: 'bg-yellow-400/10 text-yellow-400 border border-yellow-400/60 shadow-[0_0_15px_rgba(250,204,21,0.1)]',
  orange: 'bg-orange-400/10 text-orange-400 border border-orange-400/60 shadow-[0_0_15px_rgba(251,146,60,0.1)]',
  green:  'bg-emerald-400/10 text-emerald-400 border border-emerald-400/60 shadow-[0_0_15px_rgba(52,211,153,0.1)]',
  white:  'bg-white/10 text-white border border-white/40 shadow-[0_0_15px_rgba(255,255,255,0.05)]',
}

export function Sidebar({ collapsed, onToggle, mobileOpen = false, onMobileClose }: {
  collapsed: boolean
  onToggle: () => void
  mobileOpen?: boolean
  onMobileClose?: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const { tabs, getActiveTabForMedia, setActiveTabForMedia, enabledMediaTypes } = useTabs()
  const { username, logout } = useAuth()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const isMobile = useIsMobile()
  // Desktop can collapse to an icon rail; on mobile the drawer is always full-width
  // (labels shown), so ignore `collapsed` there.
  const rail = collapsed && !isMobile
  const closeMobile = () => onMobileClose?.()

  // Swipe-left-to-close for the mobile drawer.
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const touchStartX = useRef(0)
  const onTouchStart = (e: React.TouchEvent) => {
    if (!mobileOpen) return
    touchStartX.current = e.touches[0].clientX
    setDragging(true)
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (!dragging) return
    setDragX(Math.min(0, e.touches[0].clientX - touchStartX.current))
  }
  const onTouchEnd = () => {
    setDragging(false)
    if (dragX < -70) closeMobile()
    setDragX(0)
  }

  const tabsByMediaType = useMemo(() => {
    const groups: Record<string, Tab[]> = {}
    tabs.forEach(tab => {
      if (!groups[tab.media_type]) groups[tab.media_type] = []
      groups[tab.media_type].push(tab)
    })
    // Sort: "Main" first, then alphabetical by name
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => {
        const aMain = a.name.toLowerCase().includes('main') ? 0 : 1
        const bMain = b.name.toLowerCase().includes('main') ? 0 : 1
        if (aMain !== bMain) return aMain - bMain
        return a.name.localeCompare(b.name)
      })
    }
    return groups
  }, [tabs])

  const toggleExpanded = (label: string, current: boolean) => {
    setExpanded(prev => ({ ...prev, [label]: !current }))
  }

  const isVisible = (item: NavItem) => {
    if (item.requiresAny) return item.requiresAny.some(type => enabledMediaTypes.includes(type))
    return !item.mediaType || enabledMediaTypes.includes(item.mediaType)
  }

  return (
    <>
    {/* Mobile drawer scrim */}
    {mobileOpen && <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={closeMobile} />}
    <aside
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
      className={`fixed left-0 top-0 h-full bg-noir-900 border-r border-white/5 flex flex-col z-50 ease-in-out
      ${dragging ? '' : 'transition-all duration-300'}
      w-64 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
      lg:translate-x-0 ${rail ? 'lg:w-16' : 'lg:w-52'}`}>
      {/* Logo */}
      <div className="py-4 px-2 border-b border-white/5 flex-shrink-0 cursor-pointer hover:bg-white/5 transition-colors flex items-center overflow-hidden"
        onClick={() => (isMobile ? closeMobile() : onToggle())}>
        <img src={ArchivistLogo} alt="Archivist Logo" className="w-12 h-12 flex-shrink-0" />
        <span className={`ml-3 font-display text-2xl tracking-widest text-gradient-full transition-all duration-500 whitespace-nowrap ${rail ? 'opacity-0 translate-x-4 pointer-events-none' : 'opacity-100 translate-x-0'}`}>
          ARCHIVIST
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-6 space-y-1 overflow-y-auto overflow-x-hidden custom-scrollbar">
        {NAV.filter(isVisible).map((item) => {
          const { to, icon, label, accent, mediaType } = item
          const visibleChildren = (item.children ?? []).filter(isVisible)
          const isDirectlyActive = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)
          const hasActiveChild = visibleChildren.some(child => location.pathname.startsWith(child.to))
          const isActive = isDirectlyActive || hasActiveChild

          const groupTabs = mediaType ? tabsByMediaType[mediaType] || [] : []
          const hasMultiple = groupTabs.length > 1
          const hasChildren = visibleChildren.length > 0
          const canExpand = hasMultiple || hasChildren
          // Auto-expand the section you're currently in so its libraries are
          // visible without hunting for the chevron; a manual toggle overrides.
          const isExpanded = expanded[label] !== undefined ? expanded[label] : isActive

          // The remembered tab for this media type
          const selectedTab = mediaType ? getActiveTabForMedia(mediaType) : null

          return (
            <div key={label} className="flex flex-col">
              <div className="relative flex items-center group">
                <NavLink
                  to={to}
                  data-accent={accent}
                  onClick={() => {
                    // When clicking a nav item, switch to its remembered tab
                    if (selectedTab) {
                      setActiveTabForMedia(mediaType!, selectedTab.id)
                    }
                    closeMobile()
                  }}
                  className={`archivist-sidebar-item flex-1 flex items-center h-11 rounded-lg transition-all duration-300 text-sm overflow-hidden
                    ${isActive ? ACTIVE[accent] : 'text-white/30 hover:text-white/65 hover:bg-white/5'}`}
                >
                  <span className="w-12 flex-shrink-0 flex items-center justify-center">
                    <Icon name={icon} size={20} />
                  </span>
                  <span className={`ml-1 font-medium tracking-wide transition-all duration-500 whitespace-nowrap ${rail ? 'opacity-0 translate-x-4 pointer-events-none' : 'opacity-100 translate-x-0'}`}>
                    {label}
                  </span>
                  {hasMultiple && (
                    <span className={`ml-2 px-1.5 py-0.5 rounded-full text-[9px] font-bold leading-none bg-white/10 text-white/60 transition-all duration-500 ${rail ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
                      title={`${groupTabs.length} libraries`}>
                      {groupTabs.length}
                    </span>
                  )}
                </NavLink>

                {canExpand && !rail && (
                  <button
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      toggleExpanded(label, isExpanded)
                    }}
                    className={`absolute right-1 w-8 h-8 flex items-center justify-center transition-all duration-300 ${isExpanded ? 'rotate-180' : ''} text-white/45 hover:text-white`}
                  >
                    <Icon name="chevron-down" size={16} />
                  </button>
                )}
              </div>

              {hasChildren && isExpanded && !rail && (
                <div className="mt-1 ml-6 pl-4 border-l border-white/5 space-y-1">
                  {visibleChildren.map(child => {
                    const childActive = location.pathname.startsWith(child.to)
                    return (
                      <NavLink
                        key={child.to}
                        to={child.to}
                        data-accent={child.accent}
                        onClick={closeMobile}
                        className={`archivist-sidebar-item flex h-9 items-center rounded-lg text-xs font-medium transition-all duration-200 ${
                          childActive ? ACTIVE[child.accent] : 'text-white/40 hover:text-white/70 hover:bg-white/5 border border-transparent'
                        }`}
                      >
                        <span className="w-9 flex-shrink-0 flex items-center justify-center">
                          <Icon name={child.icon} size={16} />
                        </span>
                        <span className="truncate">{child.label}</span>
                      </NavLink>
                    )
                  })}
                </div>
              )}

              {hasMultiple && isExpanded && !rail && (
                <div className="mt-1 ml-6 pl-4 border-l border-white/5 space-y-1">
                  {groupTabs.map(tab => {
                    const isSelected = selectedTab?.id === tab.id
                    return (
                      <button
                        key={tab.id}
                        onClick={() => {
                          setActiveTabForMedia(mediaType!, tab.id)
                          // Films library pages have slug URLs (/films/<slug>);
                          // other types still use the flat section path for now.
                          navigate(mediaType === 'films' ? `${to}/${librarySlug(tab.name)}` : to)
                          closeMobile()
                        }}
                        className={`w-full flex items-center h-9 px-3 rounded-lg text-xs font-medium transition-all duration-200
                          ${isSelected
                            ? 'bg-white/10 text-white border border-white/10 shadow-sm'
                            : 'text-white/40 hover:text-white/70 hover:bg-white/5'}`}
                      >
                        <span className="truncate">
                          {tab.name.replace(/Films|Series|Music|Books|Comics|Games/i, '').trim() || tab.name}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

      </nav>

      <div className="flex-shrink-0 border-t border-white/5 p-2">
        {!rail && username && (
          <div className="truncate px-3 pb-2 text-[10px] font-medium uppercase text-white/35" title={username}>
            {username}
          </div>
        )}
        <button
          type="button"
          title="Sign out"
          onClick={() => void logout()}
          className="w-full h-9 rounded text-xs font-medium text-white/45 hover:text-white hover:bg-white/5 transition-colors"
        >
          {rail ? 'Out' : 'Sign out'}
        </button>
        {!rail && (
          <div className="px-3 pt-2 text-[9px] font-mono uppercase tracking-widest text-white/20"
            title={`Archivist ${APP_VERSION_LABEL}`}>
            {APP_VERSION_LABEL}
          </div>
        )}
      </div>
    </aside>
    </>
  )
}
